import sqlite3
import uuid

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api import barcode_routes
from api.barcode_routes import build_barcode_router
from services import defect_tab


def _make_client(monkeypatch, tmp_path, vendors):
    """vendors: {상품코드: 거래처}. 탭(X-Defect-Tab)별 불량/김승일 저장소를 흉내낸다."""
    wonbe_path = tmp_path / f"wonbe_{uuid.uuid4().hex}.db"
    conn = sqlite3.connect(str(wonbe_path))
    conn.execute(
        "CREATE TABLE wonbe (상품코드 TEXT, 상품명 TEXT, 거래처 TEXT, 거래처상품명 TEXT, 색상 TEXT, 사이즈 TEXT, 거래처주소 TEXT, 상품명합 TEXT, 원가 TEXT)"
    )
    conn.executemany(
        "INSERT INTO wonbe VALUES (?, '상품', ?, '', '', '', '', '', '1000')", list(vendors.items())
    )
    conn.commit()
    conn.close()

    def get_wonbe_db():
        c = sqlite3.connect(str(wonbe_path))
        c.row_factory = sqlite3.Row
        return c

    monkeypatch.setattr(barcode_routes, "_get_wonbe_db", get_wonbe_db)
    monkeypatch.setattr(barcode_routes, "WONBE_DB_PATH", wonbe_path)
    monkeypatch.setattr(defect_tab, "DEFECT_TABS", ["A", "B", "C"])

    uri = f"file:test_kdg_{uuid.uuid4().hex}?mode=memory&cache=shared"
    keep_alive = sqlite3.connect(uri, uri=True)

    def get_shared_db():
        c = sqlite3.connect(uri, uri=True)
        c.row_factory = sqlite3.Row
        return c

    keep_alive.execute(
        "CREATE TABLE kimsungil_log (created_at TEXT, code TEXT, name TEXT, action TEXT, method TEXT, count_after INTEGER, username TEXT, display_name TEXT)"
    )
    keep_alive.commit()

    store = {k: {} for k in ("defect", "summon", "kimsungil")}
    saved_settings = {}

    def tab_store(kind):
        return store[kind].setdefault(defect_tab.current_tab(), {})

    def set_store(kind):
        def setter(counts):
            target = store[kind].setdefault(defect_tab.current_tab(), {})
            target.clear()
            target.update(counts or {})
        return setter

    app = FastAPI()
    app.include_router(
        build_barcode_router(
            get_current_user=lambda: "tester",
            get_barcode_state=lambda *a, **k: {"loaded": True},
            to_int=lambda v: int(v or 0),
            process_and_load_any=lambda *a, **k: None,
            load_excel_any=lambda *a, **k: None,
            normalize_code=lambda v: v,
            process_easyadmin_product_upload=lambda *a, **k: None,
            content_disposition=lambda *a, **k: "",
            get_shared_incoming_counts=lambda: {"S1": 1, "S2": 1, "S3": 1},
            set_shared_incoming_counts=lambda *a, **k: None,
            get_shared_defect_counts=lambda: tab_store("defect"),
            set_shared_defect_counts=set_store("defect"),
            get_shared_defect_summon_counts=lambda: tab_store("summon"),
            set_shared_defect_summon_counts=set_store("summon"),
            get_shared_kimsungil_counts=lambda: tab_store("kimsungil"),
            set_shared_kimsungil_counts=set_store("kimsungil"),
            set_shared_barcode_data=lambda *a, **k: None,
            get_setting=lambda key: saved_settings.get(key),
            set_setting=lambda key, value: saved_settings.__setitem__(key, value),
            get_user_display=lambda u: u,
            get_shared_db=get_shared_db,
            get_db=get_shared_db,
        )
    )
    return TestClient(app), store, saved_settings, keep_alive


def test_kdg_vendor_items_go_to_kdg_tab_and_others_stay(monkeypatch, tmp_path):
    client, store, saved, _keep = _make_client(monkeypatch, tmp_path, {"S1": "케이디지", "S2": "다른거래처", "S3": "케이디지"})
    store["kimsungil"]["B"] = {"S1": 2, "S2": 3}
    store["kimsungil"]["C"] = {"S3": 1}

    res = client.post("/barcode/kimsungil/summon-to-defect", headers={"X-Defect-Tab": "B"})

    body = res.json()
    assert body["ok"] is True and body["moved_count"] == 2 and body["kdg_moved_count"] == 1
    assert "KDG" in body["tabs"]["tabs"]
    assert store["defect"]["KDG"] == {"S1": 2}  # 케이디지는 B탭에서 불러왔어도 KDG 탭으로
    assert store["summon"]["KDG"] == {"S1": 2}
    assert store["defect"]["B"] == {"S2": 3}  # 나머지는 고른 탭 그대로
    assert store["kimsungil"]["B"] == {}
    assert "KDG" in saved["defect_tabs_config"]  # 새로 만든 KDG 탭이 저장된다

    # 다른 탭(C)에서 불러와도 케이디지는 KDG 탭에 합쳐진다.
    client.post("/barcode/kimsungil/summon-to-defect", headers={"X-Defect-Tab": "C"})
    assert store["defect"]["KDG"] == {"S1": 2, "S3": 1}
    assert store["defect"].get("C", {}) == {}


def test_summon_from_kdg_tab_stays_in_kdg_tab(monkeypatch, tmp_path):
    client, store, _saved, _keep = _make_client(monkeypatch, tmp_path, {"S1": "케이디지", "S2": "다른거래처"})
    monkeypatch.setattr(defect_tab, "DEFECT_TABS", ["A", "B", "C", "KDG"])
    store["kimsungil"]["KDG"] = {"S1": 1, "S2": 4}

    client.post("/barcode/kimsungil/summon-to-defect", headers={"X-Defect-Tab": "KDG"})

    assert store["defect"]["KDG"] == {"S1": 1, "S2": 4}
    assert store["kimsungil"]["KDG"] == {}


def test_kdg_tab_summons_everything_even_without_incoming(monkeypatch, tmp_path):
    # S9는 입고 파일에 없는(incoming 0) 상품 - 일반 탭에서는 안 옮겨지지만 KDG 탭에서는 옮겨진다.
    client, store, _saved, _keep = _make_client(monkeypatch, tmp_path, {"S1": "케이디지", "S9": "케이디지"})
    monkeypatch.setattr(defect_tab, "DEFECT_TABS", ["A", "B", "C", "KDG"])
    store["kimsungil"]["KDG"] = {"S1": 1, "S9": 2}
    store["kimsungil"]["B"] = {"S9": 5}

    res = client.post("/barcode/kimsungil/summon-to-defect", headers={"X-Defect-Tab": "KDG"})
    assert res.json()["moved_count"] == 2
    assert store["defect"]["KDG"] == {"S1": 1, "S9": 2}
    assert store["kimsungil"]["KDG"] == {}

    res = client.post("/barcode/kimsungil/summon-to-defect", headers={"X-Defect-Tab": "B"})
    assert res.json()["moved_count"] == 0  # 일반 탭은 여전히 입고된 것만
    assert store["kimsungil"]["B"] == {"S9": 5}
