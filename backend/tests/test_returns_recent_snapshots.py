import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.returns_routes import build_returns_router
from services.returns_utils import (
    ReturnState,
    _clean_invoice,
    _clean_product_name,
    _clean_qty,
    _load_return_state_from_payload,
    _lowercase_size_words,
    _normalize_key,
    _normalize_spaces,
    _option_slash_to_space,
    _read_return_excel,
    _reason_type,
    _return_queue_payload,
    _return_rows,
    _return_state_to_payload,
    _return_status,
)


class _NoCloseConn:
    """Wraps a real sqlite3 connection but swallows .close() calls.

    The router opens/closes a connection per call via get_db(); for an
    in-memory test double we reuse one connection so a real .close()
    wouldn't wipe data between calls within a test.
    """

    def __init__(self, conn):
        self._conn = conn

    def __getattr__(self, name):
        return getattr(self._conn, name)

    def close(self):
        pass


def _make_shared_db():
    db_holder = {"conn": None}

    def _get_shared_db():
        if db_holder["conn"] is None:
            conn = sqlite3.connect(":memory:", check_same_thread=False)
            conn.row_factory = sqlite3.Row
            conn.execute(
                """CREATE TABLE return_saved_snapshots (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    username TEXT NOT NULL,
                    payload TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )"""
            )
            db_holder["conn"] = conn
        return _NoCloseConn(db_holder["conn"])

    _get_shared_db()
    return _get_shared_db


def _make_client(get_shared_db, *, username="tester"):
    state = ReturnState(cost_base_path=Path("nonexistent.xlsx"))

    def _get_return_state(user):
        return state

    app = FastAPI()
    app.include_router(
        build_returns_router(
            get_current_user=lambda: username,
            require_admin=lambda: username,
            get_return_state=_get_return_state,
            get_db=get_shared_db,
            get_setting=lambda key: None,
            return_status=_return_status,
            return_queue_payload=_return_queue_payload,
            return_rows=_return_rows,
            return_state_to_payload=_return_state_to_payload,
            load_return_state_from_payload=_load_return_state_from_payload,
            load_return_cost_base=lambda *a, **k: None,
            load_cost_base_df=lambda *a, **k: None,
            save_cost_base_df=lambda *a, **k: None,
            read_return_excel=_read_return_excel,
            clean_invoice=_clean_invoice,
            clean_product_name=_clean_product_name,
            lowercase_size_words=_lowercase_size_words,
            option_slash_to_space=_option_slash_to_space,
            clean_qty=_clean_qty,
            normalize_spaces=_normalize_spaces,
            reason_type=_reason_type,
            normalize_key=_normalize_key,
            content_disposition=lambda filename: f'attachment; filename="{filename}"',
            return_allowed_exts={".xlsx", ".xls"},
        )
    )
    return TestClient(app), state


def test_save_keeps_only_latest_three_snapshots():
    client, state = _make_client(_make_shared_db())
    for i in range(4):
        state.queue_seller = [{"id": i, "goods_name": f"item-{i}"}]
        res = client.post("/returns/save")
        assert res.status_code == 200

    res = client.get("/returns/saves")
    assert res.status_code == 200
    items = res.json()["items"]
    assert len(items) == 3


def test_load_by_id_returns_that_snapshots_queue_seller():
    client, state = _make_client(_make_shared_db())
    for i in range(3):
        state.queue_seller = [{"id": i, "goods_name": f"item-{i}"}]
        client.post("/returns/save")

    items = client.get("/returns/saves").json()["items"]
    oldest_id = items[-1]["id"]

    state.queue_seller = []
    res = client.post("/returns/load", json={"id": oldest_id})
    assert res.status_code == 200
    assert state.queue_seller == [{"id": 0, "goods_name": "item-0"}]


def test_load_without_id_returns_latest_snapshot():
    client, state = _make_client(_make_shared_db())
    for i in range(2):
        state.queue_seller = [{"id": i, "goods_name": f"item-{i}"}]
        client.post("/returns/save")

    state.queue_seller = []
    res = client.post("/returns/load", json={})
    assert res.status_code == 200
    assert state.queue_seller == [{"id": 1, "goods_name": "item-1"}]


def test_load_by_id_from_another_user_is_not_found():
    shared_db = _make_shared_db()
    client_a, state_a = _make_client(shared_db, username="alice")
    client_b, _state_b = _make_client(shared_db, username="bob")

    state_a.queue_seller = [{"id": 1, "goods_name": "alice-item"}]
    client_a.post("/returns/save")
    saved_id = client_a.get("/returns/saves").json()["items"][0]["id"]

    res = client_b.post("/returns/load", json={"id": saved_id})
    assert res.status_code == 404


def test_state_endpoint_reports_latest_saved_at():
    client, state = _make_client(_make_shared_db())
    res0 = client.get("/returns/state")
    assert res0.json()["saved_at"] is None

    save_res = client.post("/returns/save")
    saved_at = save_res.json()["saved_at"]

    res1 = client.get("/returns/state")
    assert res1.json()["saved_at"] == saved_at
