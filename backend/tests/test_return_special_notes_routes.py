import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import sqlite3

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.return_special_notes_routes import build_return_special_notes_router
from services.returns_utils import _clean_invoice


class _NoCloseConn:
    """실제 sqlite3 커넥션을 감싸되 .close() 호출을 무시한다.

    라우터는 매 호출마다 get_db()로 커넥션을 새로 열고 닫는 프로덕션 방식을
    흉내내지만, 인메모리 DB 테스트 더블에서 진짜 close()를 하면 같은 테스트
    안에서 다음 호출 때 데이터가 사라진다.
    """

    def __init__(self, conn):
        self._conn = conn

    def __getattr__(self, name):
        return getattr(self._conn, name)

    def close(self):
        pass


def _make_client():
    db_holder = {"conn": None}

    def _get_db():
        if db_holder["conn"] is None:
            conn = sqlite3.connect(":memory:", check_same_thread=False)
            conn.row_factory = sqlite3.Row
            conn.execute(
                """CREATE TABLE return_special_notes (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    invoice_no TEXT NOT NULL UNIQUE,
                    note TEXT NOT NULL DEFAULT '',
                    created_by TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL
                )"""
            )
            db_holder["conn"] = conn
        return _NoCloseConn(db_holder["conn"])

    _get_db()  # 요청 전에 데이터를 미리 심을 수 있도록 미리 생성

    app = FastAPI()
    app.include_router(
        build_return_special_notes_router(
            get_current_user=lambda: "tester",
            get_db=_get_db,
            clean_invoice=_clean_invoice,
        )
    )
    return TestClient(app), db_holder


def test_add_creates_note_and_appears_in_list():
    client, db_holder = _make_client()

    res = client.post(
        "/return-special-notes/add",
        json={"invoice_no": "1234-567890abc", "note": "파손 이력 있음"},
    )

    assert res.status_code == 200
    items = res.json()["items"]
    assert len(items) == 1
    assert items[0]["invoiceNo"] == "1234567890"  # clean_invoice로 숫자만 남음
    assert items[0]["note"] == "파손 이력 있음"
    assert items[0]["createdBy"] == "tester"

    list_res = client.get("/return-special-notes/list")
    assert list_res.status_code == 200
    assert list_res.json()["items"][0]["invoiceNo"] == "1234567890"


def test_add_same_invoice_overwrites_existing_note():
    client, db_holder = _make_client()
    client.post("/return-special-notes/add", json={"invoice_no": "111", "note": "A"})

    res = client.post("/return-special-notes/add", json={"invoice_no": "111", "note": "B"})

    items = res.json()["items"]
    assert len(items) == 1
    assert items[0]["note"] == "B"


def test_add_rejects_empty_invoice_no():
    client, db_holder = _make_client()
    res = client.post("/return-special-notes/add", json={"invoice_no": "", "note": "메모"})
    assert res.status_code == 400


def test_add_rejects_empty_note():
    client, db_holder = _make_client()
    res = client.post("/return-special-notes/add", json={"invoice_no": "111", "note": "   "})
    assert res.status_code == 400


def test_delete_removes_note():
    client, db_holder = _make_client()
    client.post("/return-special-notes/add", json={"invoice_no": "111", "note": "메모"})
    note_id = client.get("/return-special-notes/list").json()["items"][0]["id"]

    res = client.delete(f"/return-special-notes/{note_id}")

    assert res.status_code == 200
    assert res.json()["ok"] is True
    assert client.get("/return-special-notes/list").json()["items"] == []
