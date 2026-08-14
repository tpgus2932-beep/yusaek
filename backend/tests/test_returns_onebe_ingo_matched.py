import sys
from pathlib import Path

import pandas as pd

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
            get_setting=lambda key: "fake-phpsessid",
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


def test_ingo_daegi_blocked_when_unmatched_product_code_exists():
    client, state = _make_client()
    state.customer_export_df = pd.DataFrame(
        [
            {"상품코드": "P001", "입고수량": 2, "요청메모": ""},
            {"상품코드": "", "입고수량": 1, "요청메모": ""},
            {"상품코드": "nan", "입고수량": 1, "요청메모": ""},
        ]
    )

    res = client.post("/returns/onebe/ingo-daegi")
    assert res.status_code == 400
    assert "2건" in res.json()["detail"]


def test_real_ingo_blocked_when_unmatched_product_code_exists():
    client, state = _make_client()
    state.customer_export_df = pd.DataFrame(
        [
            {"상품코드": "P001", "입고수량": 2, "요청메모": ""},
            {"상품코드": "", "입고수량": 1, "요청메모": ""},
        ]
    )

    res = client.post("/returns/onebe/real-ingo")
    assert res.status_code == 400
    assert "1건" in res.json()["detail"]
