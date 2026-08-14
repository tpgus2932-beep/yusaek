import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.returns_routes import _remove_return_queue_ids, build_returns_router
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


def test_remove_return_queue_ids_removes_across_all_queues():
    state = ReturnState(cost_base_path=Path("nonexistent.xlsx"))
    item_a = {"id": 1, "scan": "111"}
    item_b = {"id": 2, "scan": "222"}
    item_c = {"id": 3, "scan": "333"}
    state.queue_seller = [item_a]
    state.queue_customer = [item_b]
    state.queue_unmatched = [item_c]
    state.all_items = [item_a, item_b, item_c]

    _remove_return_queue_ids(state, {1, 3})

    assert state.queue_seller == []
    assert state.queue_customer == [item_b]
    assert state.queue_unmatched == []
    assert state.all_items == [item_b]


def test_remove_return_queue_ids_ignores_unknown_ids():
    state = ReturnState(cost_base_path=Path("nonexistent.xlsx"))
    item_a = {"id": 1, "scan": "111"}
    state.queue_seller = [item_a]
    state.all_items = [item_a]

    _remove_return_queue_ids(state, {999})

    assert state.queue_seller == [item_a]
    assert state.all_items == [item_a]


def _make_client():
    state = ReturnState(cost_base_path=Path("nonexistent.xlsx"))

    def _get_return_state(user):
        return state

    app = FastAPI()
    app.include_router(
        build_returns_router(
            get_current_user=lambda: "tester",
            require_admin=lambda: "tester",
            get_return_state=_get_return_state,
            get_db=lambda: None,
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


def test_delete_items_endpoint_removes_from_all_queues():
    client, state = _make_client()
    item_a = {"id": 1, "scan": "111", "match": "m1", "item_text": "t1", "qty": "1", "type": "판매자"}
    item_b = {"id": 2, "scan": "222", "match": "m2", "item_text": "t2", "qty": "1", "type": "고객"}
    state.queue_seller = [item_a]
    state.queue_customer = [item_b]
    state.all_items = [item_a, item_b]

    res = client.post("/returns/delete-items", json={"ids": [1]})

    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is True
    assert data["queues"]["seller"] == []
    assert data["queues"]["customer"] == [item_b]
    assert data["queues"]["all"] == [item_b]


def test_delete_items_endpoint_requires_ids():
    client, state = _make_client()
    res = client.post("/returns/delete-items", json={"ids": []})
    assert res.status_code == 400
