import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import httpx
import respx
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


@respx.mock
def test_change_reason_submit_calls_three_apis_in_order():
    respx.post("https://api.a-bly.com/seller/login/").mock(
        return_value=httpx.Response(200, json={"token": "tok"})
    )
    reason_route = respx.put("https://api.a-bly.com/seller/order_cancels/update_fields/").mock(
        side_effect=[httpx.Response(200, json={}), httpx.Response(200, json={})]
    )
    confirm_route = respx.put("https://api.a-bly.com/seller/order_items/request_confirm/").mock(
        return_value=httpx.Response(200, json={})
    )

    client, state = _make_client()
    item = {
        "id": 1, "scan": "111", "request_no": "64262485", "item_sno": 635340410,
        "refund_holder": "이영희", "refund_account": "1002955046694", "refund_bank_sno": 15,
    }
    state.queue_seller = [item]

    res = client.post("/returns/ably-change-reason-submit", json={"items": [item]})

    assert res.status_code == 200
    data = res.json()
    assert data["results"][0]["ok"] is True
    assert state.queue_seller[0]["ably_reason_changed"] is True

    assert reason_route.call_count == 2
    first_call_body = json.loads(reason_route.calls[0].request.content)
    assert first_call_body["data_list"][0]["update_list"] == [{"field": "cancel_reason", "value": 31}]
    assert first_call_body["data_list"][0]["sno_list"] == [64262485]

    second_call_body = json.loads(reason_route.calls[1].request.content)
    assert second_call_body["data_list"][0]["update_list"][0] == {
        "field": "refund_bank_account_holder", "value": "이영희",
    }

    assert confirm_route.call_count == 1
    confirm_body = json.loads(confirm_route.calls[0].request.content)
    assert confirm_body["sno_list"] == [635340410]


def test_change_reason_submit_requires_items():
    client, state = _make_client()
    res = client.post("/returns/ably-change-reason-submit", json={"items": []})
    assert res.status_code == 400
