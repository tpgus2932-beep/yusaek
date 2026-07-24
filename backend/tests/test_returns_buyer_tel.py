import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import httpx
import pandas as pd
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
def test_load_ably_api_captures_buyer_tel_into_df2():
    respx.post("https://api.a-bly.com/seller/login/").mock(
        return_value=httpx.Response(200, json={"token": "tok"})
    )
    respx.get("https://api.a-bly.com/seller/order_cancels/").mock(
        return_value=httpx.Response(
            200,
            json={
                "max_page_number": 1,
                "order_cancels": [
                    {
                        "sno": 999,
                        "refund_bank_account_holder": "홍길동",
                        "refund_bank_account_number": "1234567890",
                        "refund_bank_sno": 5,
                        "order_items": [
                            {
                                "sno": 111,
                                "cancel_reason": 30,
                                "goods_name": "테스트 상품",
                                "option_info": "블랙/M",
                                "ea": 1,
                                "invoice": "1111111111",
                                "return_delivery_fee": -3000,
                                "user_comment": "",
                                "cancel_images": [],
                                "order_sno": 555,
                                "buyer_tel": "010-1234-5678",
                            }
                        ],
                    }
                ],
            },
        )
    )

    client, state = _make_client()
    res = client.post("/returns/load-ably-api")

    assert res.status_code == 200
    assert state.df2 is not None
    assert not state.df2.empty
    assert state.df2.iloc[0]["BUYER_TEL"] == "010-1234-5678"


def test_scan_populates_buyer_tel_on_seller_queue_item():
    client, state = _make_client()
    state.map_d_to_e = {"999000111": "999000111"}
    state.df2 = pd.DataFrame([{
        "F_name": "테스트 상품", "G_opt": "블랙 m", "QTY": "1",
        "ITEM_TEXT": "테스트 상품 블랙 m", "REASON_TYPE": "판매자",
        "M_clean": "999000111", "DETAIL_REASON": "단순변심", "USER_COMMENT": "",
        "REQUEST_NO": "999", "ITEM_SNO": 111,
        "REFUND_HOLDER": "홍길동", "REFUND_ACCOUNT": "1234567890", "REFUND_BANK_SNO": 5,
        "BUYER_TEL": "010-1234-5678",
        "ORDER_NO": "555", "CANCEL_IMAGES": [], "OPTION_CODE": "", "GOODS_NAME": "테스트 상품", "OPTION_RAW": "블랙/m",
    }])
    state.df2_index = {"999000111": [0]}

    res = client.post("/returns/scan", json={"barcode": "999000111"})

    assert res.status_code == 200
    assert len(state.queue_seller) == 1
    assert state.queue_seller[0]["buyer_tel"] == "010-1234-5678"
