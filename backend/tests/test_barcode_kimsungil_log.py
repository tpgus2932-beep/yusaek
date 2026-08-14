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
    uri = f"file:test_kimsungil_log_{uuid.uuid4().hex}?mode=memory&cache=shared"
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


def _make_client(monkeypatch, user="tester"):
    monkeypatch.setattr("api.barcode_routes._get_wonbe_db", lambda: _FakeWonbeConn())
    get_shared_db, keep_alive = _make_db_factory()
    _init_kimsungil_log_table(keep_alive)

    kimsungil_store = {"counts": {}}
    defect_store = {"counts": {}}

    app = FastAPI()
    app.include_router(
        build_barcode_router(
            get_current_user=lambda: user,
            get_barcode_state=lambda *a, **k: {},
            to_int=lambda v: int(v or 0),
            process_and_load_any=lambda *a, **k: None,
            load_excel_any=lambda *a, **k: None,
            normalize_to_yusas=lambda v: v,
            process_easyadmin_product_upload=lambda *a, **k: None,
            content_disposition=lambda *a, **k: "",
            get_shared_incoming_counts=lambda: {},
            set_shared_incoming_counts=lambda *a, **k: None,
            get_shared_defect_counts=lambda: defect_store["counts"],
            set_shared_defect_counts=lambda c: defect_store.__setitem__("counts", dict(c or {})),
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


def test_add_kimsungil_records_when_who_and_how(monkeypatch):
    client, _keep_alive = _make_client(monkeypatch, user="alice")

    res = client.post("/barcode/kimsungil/add", json={"code": "S1"})
    assert res.status_code == 200
    assert res.json()["ok"] is True

    log = client.get("/barcode/kimsungil/log").json()["items"]
    assert len(log) == 1
    entry = log[0]
    assert entry["code"] == "S1"
    assert entry["action"] == "add"
    assert entry["method"] == "검색 추가"
    assert entry["count_after"] == 1
    assert entry["username"] == "alice"
    assert entry["display_name"] == "표시:alice"
    assert entry["created_at"]


def test_repeated_add_increments_count_after_in_log(monkeypatch):
    client, _keep_alive = _make_client(monkeypatch)

    client.post("/barcode/kimsungil/add", json={"code": "S1"})
    client.post("/barcode/kimsungil/add", json={"code": "S1"})

    log = client.get("/barcode/kimsungil/log").json()["items"]
    assert [e["count_after"] for e in log] == [2, 1]  # 최신순


def test_dec_and_remove_are_logged_with_distinct_methods(monkeypatch):
    client, _keep_alive = _make_client(monkeypatch)
    client.post("/barcode/kimsungil/add", json={"code": "S1"})

    client.post("/barcode/kimsungil/dec", json={"code": "S1"})
    client.post("/barcode/kimsungil/add", json={"code": "S1"})
    client.post("/barcode/kimsungil/remove", json={"code": "S1"})

    log = client.get("/barcode/kimsungil/log").json()["items"]
    methods = [e["method"] for e in log]
    assert methods == ["삭제", "검색 추가", "수량 차감", "검색 추가"]


def test_log_endpoint_filters_by_code(monkeypatch):
    client, _keep_alive = _make_client(monkeypatch)
    client.post("/barcode/kimsungil/add", json={"code": "S1"})
    client.post("/barcode/kimsungil/add", json={"code": "S2"})

    log = client.get("/barcode/kimsungil/log", params={"code": "S2"}).json()["items"]
    assert [e["code"] for e in log] == ["S2"]


def test_log_is_independent_per_kimsungil_code_history(monkeypatch):
    """로그는 리스트에서 항목이 삭제된 뒤에도 남아있어야 "언제 어떤 방식으로" 기록이 보존된다."""
    client, _keep_alive = _make_client(monkeypatch)
    client.post("/barcode/kimsungil/add", json={"code": "S1"})
    client.post("/barcode/kimsungil/remove", json={"code": "S1"})

    kimsungil_list = client.get("/barcode/kimsungil/list").json()["kimsungil"]
    assert kimsungil_list == []

    log = client.get("/barcode/kimsungil/log").json()["items"]
    assert len(log) == 2
