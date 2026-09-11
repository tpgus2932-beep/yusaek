import sqlite3
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.barcode_routes import build_barcode_router


class _FakeWonbeConn:
    """wonbe DB(상품 마스터)는 이 테스트의 관심사가 아니므로 항상 빈 결과를 준다."""

    def execute(self, *a, **k):
        return self

    def fetchall(self):
        return []

    def close(self):
        pass


def _make_db_factory():
    uri = f"file:test_defect_kimsungil_summon_{uuid.uuid4().hex}?mode=memory&cache=shared"
    keep_alive = sqlite3.connect(uri, uri=True)
    keep_alive.row_factory = sqlite3.Row

    def factory():
        conn = sqlite3.connect(uri, uri=True)
        conn.row_factory = sqlite3.Row
        return conn

    return factory, keep_alive


def _init_kimsungil_log_table(conn):
    conn.execute(
        """
        CREATE TABLE kimsungil_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at TEXT NOT NULL,
            code TEXT NOT NULL,
            name TEXT NOT NULL DEFAULT '',
            action TEXT NOT NULL,
            method TEXT NOT NULL DEFAULT '',
            count_after INTEGER NOT NULL DEFAULT 0,
            username TEXT NOT NULL DEFAULT '',
            display_name TEXT NOT NULL DEFAULT ''
        )
        """
    )
    conn.commit()


def _make_client(monkeypatch, *, incoming=None, user="tester"):
    monkeypatch.setattr("api.barcode_routes._get_wonbe_db", lambda: _FakeWonbeConn())
    get_shared_db, keep_alive = _make_db_factory()
    _init_kimsungil_log_table(keep_alive)

    kimsungil_store = {"counts": {}}
    defect_store = {"counts": {}}
    defect_summon_store = {"counts": {}}
    incoming_counts = dict(incoming or {})
    barcode_state = {"loaded": True}

    app = FastAPI()
    app.include_router(
        build_barcode_router(
            get_current_user=lambda: user,
            get_barcode_state=lambda *a, **k: barcode_state,
            to_int=lambda v: int(v or 0),
            process_and_load_any=lambda *a, **k: None,
            load_excel_any=lambda *a, **k: None,
            normalize_to_yusas=lambda v: v,
            process_easyadmin_product_upload=lambda *a, **k: None,
            content_disposition=lambda *a, **k: "",
            get_shared_incoming_counts=lambda: incoming_counts,
            set_shared_incoming_counts=lambda *a, **k: None,
            get_shared_defect_counts=lambda: defect_store["counts"],
            set_shared_defect_counts=lambda c: defect_store.__setitem__("counts", dict(c or {})),
            get_shared_defect_summon_counts=lambda: defect_summon_store["counts"],
            set_shared_defect_summon_counts=lambda c: defect_summon_store.__setitem__("counts", dict(c or {})),
            get_shared_kimsungil_counts=lambda: kimsungil_store["counts"],
            set_shared_kimsungil_counts=lambda c: kimsungil_store.__setitem__("counts", dict(c or {})),
            set_shared_barcode_data=lambda *a, **k: None,
            get_setting=lambda key: None,
            set_setting=lambda key, value: None,
            get_user_display=lambda u: f"표시:{u}",
            get_shared_db=get_shared_db,
            get_db=get_shared_db,
        )
    )
    return TestClient(app), keep_alive


def test_summon_to_defect_tags_moved_codes_with_summon_qty(monkeypatch):
    client, _keep_alive = _make_client(monkeypatch, incoming={"S1": 3})
    client.post("/barcode/kimsungil/add", json={"code": "S1"})
    client.post("/barcode/kimsungil/add", json={"code": "S1"})

    res = client.post("/barcode/kimsungil/summon-to-defect")
    assert res.status_code == 200
    data = res.json()
    assert data["moved_codes"] == ["S1"]
    assert data["moved_total"] == 2

    defects = client.get("/barcode/defect/list").json()["defects"]
    assert len(defects) == 1
    assert defects[0]["code"] == "S1"
    assert defects[0]["count"] == 2
    assert defects[0]["kimsungil_summon_qty"] == 2


def test_summon_leaves_non_incoming_codes_untouched(monkeypatch):
    client, _keep_alive = _make_client(monkeypatch, incoming={"S1": 0})
    client.post("/barcode/kimsungil/add", json={"code": "S1"})

    res = client.post("/barcode/kimsungil/summon-to-defect")
    assert res.status_code == 200
    assert res.json()["moved_codes"] == []
    assert client.get("/barcode/defect/list").json()["defects"] == []


def test_manual_defect_add_does_not_count_as_summon(monkeypatch):
    client, _keep_alive = _make_client(monkeypatch)
    client.post("/barcode/defect/add", json={"code": "S9"})

    defects = client.get("/barcode/defect/list").json()["defects"]
    assert defects[0]["kimsungil_summon_qty"] == 0


def test_decrement_shrinks_summon_qty_and_clears_at_zero(monkeypatch):
    client, _keep_alive = _make_client(monkeypatch, incoming={"S1": 2})
    client.post("/barcode/kimsungil/add", json={"code": "S1"})
    client.post("/barcode/kimsungil/add", json={"code": "S1"})
    client.post("/barcode/kimsungil/summon-to-defect")

    res = client.post("/barcode/defect/dec", json={"code": "S1"})
    defects = res.json()["defects"]
    assert defects[0]["count"] == 1
    assert defects[0]["kimsungil_summon_qty"] == 1

    res = client.post("/barcode/defect/dec", json={"code": "S1"})
    assert res.json()["defects"] == []


def test_remove_clears_summon_tracking(monkeypatch):
    client, _keep_alive = _make_client(monkeypatch, incoming={"S1": 1})
    client.post("/barcode/kimsungil/add", json={"code": "S1"})
    client.post("/barcode/kimsungil/summon-to-defect")
    client.post("/barcode/defect/add", json={"code": "S1"})  # 별도 수동 추가로 count=2, summon=1 로 만들어둠

    res = client.post("/barcode/defect/remove", json={"code": "S1"})
    assert res.json()["defects"] == []

    # 다시 수동으로 추가하면 summon 흔적 없이 0으로 시작해야 한다
    client.post("/barcode/defect/add", json={"code": "S1"})
    defects = client.get("/barcode/defect/list").json()["defects"]
    assert defects[0]["kimsungil_summon_qty"] == 0


def test_purchase_manager_handoff_can_exclude_summoned_codes(monkeypatch):
    client, _keep_alive = _make_client(monkeypatch, incoming={"S1": 1})
    client.post("/barcode/defect/add", json={"code": "S2"})
    client.post("/barcode/kimsungil/add", json={"code": "S1"})
    client.post("/barcode/kimsungil/summon-to-defect")

    res = client.post("/barcode/defect/purchase-manager-handoff", json={"exclude_kimsungil_summon": True})
    assert res.status_code == 200
    # wonbe 조회가 항상 빈 결과라 실제 매칭은 없지만, unmatched_codes에 S1이 없어야
    # (제외됐다는 뜻) 대상에서 빠졌음을 확인할 수 있다.
    assert "S1" not in res.json()["unmatched_codes"]
    assert "S2" in res.json()["unmatched_codes"]


def test_purchase_manager_handoff_includes_summoned_codes_by_default(monkeypatch):
    client, _keep_alive = _make_client(monkeypatch, incoming={"S1": 1})
    client.post("/barcode/kimsungil/add", json={"code": "S1"})
    client.post("/barcode/kimsungil/summon-to-defect")

    res = client.post("/barcode/defect/purchase-manager-handoff", json={})
    assert res.status_code == 200
    assert "S1" in res.json()["unmatched_codes"]
