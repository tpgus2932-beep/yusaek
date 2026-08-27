import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import sqlite3

import pandas as pd
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
    def __init__(self, conn):
        self._conn = conn

    def __getattr__(self, name):
        return getattr(self._conn, name)

    def close(self):
        pass


def _make_shared_db_with_note(invoice_no=None, note=None):
    db_holder = {"conn": None}

    def _get_shared_db():
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
            if invoice_no:
                conn.execute(
                    "INSERT INTO return_special_notes (invoice_no, note, created_by, created_at) VALUES (?, ?, 'tester', '2026-07-30T00:00:00')",
                    (invoice_no, note),
                )
            conn.commit()
            db_holder["conn"] = conn
        return _NoCloseConn(db_holder["conn"])

    _get_shared_db()
    return _get_shared_db


def _make_client(get_shared_db):
    state = ReturnState(cost_base_path=Path("nonexistent.xlsx"))

    def _get_return_state(user):
        return state

    app = FastAPI()
    app.include_router(
        build_returns_router(
            get_current_user=lambda: "tester",
            require_admin=lambda: "tester",
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


def _seed_scan_data(state, *, scanned_barcode, origin_invoice):
    state.map_d_to_e = {scanned_barcode: origin_invoice}
    state.df2 = pd.DataFrame([{
        "QTY": "1", "ITEM_TEXT": "테스트 상품", "REASON_TYPE": "판매자",
        "M_clean": origin_invoice, "DETAIL_REASON": "단순변심", "USER_COMMENT": "",
        "REQUEST_NO": "999", "ITEM_SNO": 111,
        "REFUND_HOLDER": "홍길동", "REFUND_ACCOUNT": "1234567890", "REFUND_BANK_SNO": 5,
        "BUYER_TEL": "010-1234-5678",
        "ORDER_NO": "555", "CANCEL_IMAGES": [], "OPTION_CODE": "", "GOODS_NAME": "테스트 상품", "OPTION_RAW": "블랙/m",
    }])
    state.df2_index = {origin_invoice: [0]}


def test_scan_matches_special_note_by_origin_invoice_not_scanned_barcode():
    get_shared_db = _make_shared_db_with_note("999000111", "파손 이력 있음")
    client, state = _make_client(get_shared_db)
    _seed_scan_data(state, scanned_barcode="111", origin_invoice="999000111")

    res = client.post("/returns/scan", json={"barcode": "111"})

    assert res.status_code == 200
    data = res.json()
    assert data["special_note"] == "파손 이력 있음"
    assert state.queue_seller[0]["special_note"] == "파손 이력 있음"


def test_scan_without_registered_note_returns_empty_special_note():
    get_shared_db = _make_shared_db_with_note()
    client, state = _make_client(get_shared_db)
    _seed_scan_data(state, scanned_barcode="111", origin_invoice="999000111")

    res = client.post("/returns/scan", json={"barcode": "111"})

    assert res.status_code == 200
    data = res.json()
    assert data["special_note"] == ""
    assert state.queue_seller[0]["special_note"] == ""


def test_scan_matches_special_note_even_when_unmatched_in_excel2():
    """원송장번호(e_val)는 CJ/롯데 매핑으로 찾았지만 2번 엑셀(반품접수 데이터)에
    아직 매칭되는 행이 없어 미매칭 큐로 빠지는 경우에도, 이미 조회한
    special_note는 응답과 큐 아이템에 실려야 한다."""
    get_shared_db = _make_shared_db_with_note("999000111", "파손 이력 있음")
    client, state = _make_client(get_shared_db)
    state.map_d_to_e = {"111": "999000111"}
    state.df2 = pd.DataFrame([])
    state.df2_index = {}

    res = client.post("/returns/scan", json={"barcode": "111"})

    assert res.status_code == 200
    data = res.json()
    assert data["special_note"] == "파손 이력 있음"
    assert state.queue_unmatched[0]["special_note"] == "파손 이력 있음"


def test_scan_with_no_db_configured_does_not_crash():
    """get_db()가 None을 주는 기존 테스트들(get_db=lambda: None)이 계속 통과하는지 보장하는 회귀 테스트."""
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
    client = TestClient(app)
    _seed_scan_data(state, scanned_barcode="111", origin_invoice="999000111")

    res = client.post("/returns/scan", json={"barcode": "111"})

    assert res.status_code == 200
    assert res.json()["special_note"] == ""
