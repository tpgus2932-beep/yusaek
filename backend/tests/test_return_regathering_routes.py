import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import httpx
import respx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.return_regathering_routes import build_return_regathering_router
from services.returns_utils import ReturnState, _return_queue_payload


class _NoCloseConn:
    """Wraps a real sqlite3 connection but swallows .close() calls.

    The router opportunistically closes the connection it gets from
    get_shared_db() after every use (matching production, where each call
    opens a fresh connection to a DB file). For an in-memory test double we
    reuse a single cached connection across calls, so a real .close() would
    wipe the in-memory database between the router's own calls within one
    request.
    """

    def __init__(self, conn):
        self._conn = conn

    def __getattr__(self, name):
        return getattr(self._conn, name)

    def close(self):
        pass


def _make_client(*, settings=None):
    settings = settings or {}
    state = ReturnState(cost_base_path=Path("nonexistent.xlsx"))
    db_holder = {"conn": None}

    def _get_return_state(user):
        return state

    def _get_shared_db():
        import sqlite3
        if db_holder["conn"] is None:
            conn = sqlite3.connect(":memory:", check_same_thread=False)
            conn.row_factory = sqlite3.Row
            conn.execute(
                "CREATE TABLE sms_templates (id TEXT, name TEXT, msg TEXT, title TEXT, msg_type TEXT, sort_order INTEGER)"
            )
            conn.execute(
                """CREATE TABLE return_regathering (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    invoice TEXT NOT NULL, order_no TEXT NOT NULL DEFAULT '',
                    item_sno TEXT NOT NULL DEFAULT '', request_no TEXT NOT NULL DEFAULT '',
                    buyer_tel TEXT NOT NULL DEFAULT '', goods_name TEXT NOT NULL DEFAULT '',
                    option_raw TEXT NOT NULL DEFAULT '', requested_by TEXT NOT NULL DEFAULT '',
                    requested_at TEXT NOT NULL
                )"""
            )
            db_holder["conn"] = conn
        return _NoCloseConn(db_holder["conn"])

    _get_shared_db()  # force eager creation so callers can seed data before any request

    app = FastAPI()
    app.include_router(
        build_return_regathering_router(
            get_current_user=lambda: "tester",
            get_return_state=_get_return_state,
            get_shared_db=_get_shared_db,
            get_setting=lambda key: settings.get(key),
            return_queue_payload=_return_queue_payload,
        )
    )
    return TestClient(app), state, db_holder


def _seed_template(db_holder, msg="오회수 안내: {상품명}"):
    db_holder["conn"].execute(
        "INSERT INTO sms_templates (id, name, msg, title, msg_type, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
        ("t1", "반품 오회수", msg, "", "SMS", 0),
    )
    db_holder["conn"].commit()


def _customer_item(item_id):
    return {
        "id": item_id, "scan": f"scan{item_id}", "match": f"inv{item_id}",
        "item_sno": 100 + item_id, "request_no": str(200 + item_id),
        "buyer_tel": "010-1234-5678", "goods_name": "테스트 상품", "option_raw": "블랙/M",
        "order_no": str(300 + item_id),
    }


@respx.mock
def test_execute_moves_item_to_regathering_on_full_success():
    respx.post("https://ga80.ezadmin.co.kr/popup35.htm").mock(
        return_value=httpx.Response(200, text="batch_cs_abc123")
    )
    respx.post("https://ga80.ezadmin.co.kr/function.htm").mock(
        return_value=httpx.Response(200, json={"error": 0})
    )
    # EzDesk's send_sms response has no reliable "error" field (unlike EzAdmin's
    # DS00 actions) - this shape (no "error" key at all) previously made the
    # route wrongly treat a successful send as a failure. Regression check.
    respx.post("https://ezdesk.ezadmin.co.kr/function.php").mock(
        return_value=httpx.Response(200, json={"result": "sent"})
    )

    client, state, db_holder = _make_client(
        settings={"ezadmin_phpsessid": "sess", "ezdesk_phpsessid": "esess"}
    )
    _seed_template(db_holder)
    item = _customer_item(1)
    state.queue_customer = [item]
    state.all_items = [item]

    res = client.post("/return-regathering/execute", json={"items": [item]})

    assert res.status_code == 200
    data = res.json()
    assert data["results"][0]["ok"] is True
    assert state.queue_customer == []

    rows = db_holder["conn"].execute("SELECT * FROM return_regathering").fetchall()
    assert len(rows) == 1
    assert rows[0]["invoice"] == "inv1"
    assert rows[0]["buyer_tel"] == "01012345678"


def test_execute_needs_ezadmin_session():
    client, state, db_holder = _make_client(settings={})
    item = _customer_item(1)
    res = client.post("/return-regathering/execute", json={"items": [item]})
    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is False
    assert data["need_session"] is True


def test_execute_requires_template():
    client, state, db_holder = _make_client(settings={"ezadmin_phpsessid": "sess"})
    item = _customer_item(1)
    res = client.post("/return-regathering/execute", json={"items": [item]})
    assert res.status_code == 400
    assert "템플릿" in res.json()["detail"]


def test_complete_deletes_row():
    client, state, db_holder = _make_client(settings={"ezadmin_phpsessid": "sess"})
    _seed_template(db_holder)
    db_holder["conn"].execute(
        """INSERT INTO return_regathering
           (invoice, order_no, item_sno, request_no, buyer_tel, goods_name, option_raw, requested_by, requested_at)
           VALUES ('inv1','300','101','201','01012345678','상품','블랙/M','tester','2026-07-24T00:00:00')"""
    )
    db_holder["conn"].commit()
    row_id = db_holder["conn"].execute("SELECT id FROM return_regathering").fetchone()["id"]

    res = client.post(f"/return-regathering/{row_id}/complete")

    assert res.status_code == 200
    assert res.json()["ok"] is True
    remaining = db_holder["conn"].execute("SELECT * FROM return_regathering").fetchall()
    assert remaining == []
