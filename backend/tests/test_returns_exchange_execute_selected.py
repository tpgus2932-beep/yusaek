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


def _make_client(*, settings=None):
    settings = settings or {}
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
            get_setting=lambda key: settings.get(key),
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


def _ready_item(item_id):
    return {
        "id": item_id,
        "scan": str(item_id),
        "qty": "1",
        "ezadmin_seq": "seq1",
        "ezadmin_prd_seq": "prd1",
        "old_product_id": "OLD1",
        "new_product_id": "NEW1",
        "exchange_sno": 900 + item_id,
    }


@respx.mock
def test_execute_only_processes_selected_ids():
    respx.post("https://api.a-bly.com/seller/login/").mock(
        return_value=httpx.Response(200, json={"token": "tok"})
    )
    respx.post("https://api.a-bly.com/seller/exchanges/receive/").mock(
        return_value=httpx.Response(200, json={"success_count": 1})
    )
    respx.post("https://api.a-bly.com/seller/exchanges/prepare/").mock(
        return_value=httpx.Response(200, json={"success_count": 1})
    )
    respx.post("https://ga80.ezadmin.co.kr/function.htm").mock(
        return_value=httpx.Response(200, json={"error": 0})
    )

    client, state = _make_client(settings={"ezadmin_phpsessid": "sess"})
    item1 = _ready_item(1)
    item2 = _ready_item(2)
    state.queue_exchange_customer = [item1, item2]

    res = client.post(
        "/returns/exchange-customer/execute-change-product?queue=customer",
        json={"ids": [1]},
    )

    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is True
    assert data["executed"] == 1
    assert item1["change_product_done"] is True
    assert item2.get("change_product_done") is not True


def test_execute_requires_ids():
    client, state = _make_client(settings={"ezadmin_phpsessid": "sess"})
    state.queue_exchange_customer = [_ready_item(1)]

    res = client.post(
        "/returns/exchange-customer/execute-change-product?queue=customer",
        json={"ids": []},
    )

    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is False
