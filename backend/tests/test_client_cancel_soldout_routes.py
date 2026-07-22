import sqlite3
import sys
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import openpyxl
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.client_cancel_soldout_routes import build_client_cancel_soldout_router
from sdk.ezadmin import EzDeskSessionExpired


def _make_db_factory():
    uri = f"file:test_client_cancel_soldout_{uuid.uuid4().hex}?mode=memory&cache=shared"
    keep_alive = sqlite3.connect(uri, uri=True)
    keep_alive.row_factory = sqlite3.Row
    keep_alive.execute(
        "CREATE TABLE sms_templates (id TEXT PRIMARY KEY, name TEXT, msg TEXT, title TEXT, msg_type TEXT, sort_order INTEGER)"
    )
    keep_alive.commit()

    def factory():
        conn = sqlite3.connect(uri, uri=True)
        conn.row_factory = sqlite3.Row
        return conn

    return factory, keep_alive


def _make_client(cost_base_path: Path):
    get_db, keep_alive = _make_db_factory()
    keep_alive.execute(
        "INSERT INTO sms_templates (id, name, msg, title, msg_type, sort_order) VALUES (?, ?, ?, '', '', 0)",
        ("1", "품절 문자", "주문해주신 '{상품}' 이 품절되었습니다."),
    )
    keep_alive.commit()

    app = FastAPI()
    app.include_router(
        build_client_cancel_soldout_router(
            get_current_user=lambda: "tester",
            get_setting=lambda key: None,
            get_db=get_db,
            cost_base_path=cost_base_path,
        )
    )
    return TestClient(app), get_db, keep_alive


def _write_cost_base(path: Path):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(["상품코드", "상품명", "색상", "사이즈", "원가", "거래처", "거래처상품명",
               "거래처합", "상품명합", "거래처주소", "옵션번호"])
    ws.append(["S10456", "빈티지 흑청 스커트", "흑청", "S", "10000", "오즈브릿지",
               "273빈티지흑청스커트", "273빈티지흑청스커트 흑청 S",
               "빈티지 흑청 스커트 흑청 S", "디오트 1층 C 9호", "175252569"])
    wb.save(path)


def test_cost_base_search_returns_grouped_items(tmp_path):
    cost_base_path = tmp_path / "cost_base.xlsx"
    _write_cost_base(cost_base_path)
    client, _get_db, _keep_alive = _make_client(cost_base_path)

    res = client.get("/client-cancel-soldout/cost-base/search", params={"q": "빈티지"})

    assert res.status_code == 200
    assert res.json() == {
        "ok": True,
        "items": [{
            "name": "빈티지 흑청 스커트",
            "options": [{"code": "175252569", "label": "흑청/S"}],
        }],
    }


def test_run_without_products_returns_400(tmp_path):
    client, _get_db, _keep_alive = _make_client(tmp_path / "missing.xlsx")

    res = client.post("/client-cancel-soldout/run", json={"products": []})

    assert res.status_code == 400


def test_run_missing_template_returns_400(tmp_path):
    get_db, keep_alive = _make_db_factory()  # sms_templates 비어있음
    app = FastAPI()
    app.include_router(
        build_client_cancel_soldout_router(
            get_current_user=lambda: "tester",
            get_setting=lambda key: None,
            get_db=get_db,
            cost_base_path=tmp_path / "missing.xlsx",
        )
    )
    client = TestClient(app)

    res = client.post("/client-cancel-soldout/run", json={
        "products": [{"name": "빈티지 흑청 스커트", "option_codes": ["175252569"]}]
    })

    assert res.status_code == 400
    assert "품절 문자" in res.json()["detail"]


def test_run_cancels_matching_order_and_sends_sms(tmp_path):
    client, _get_db, _keep_alive = _make_client(tmp_path / "missing.xlsx")

    search_result = [{
        "sno": 636699893, "order_sno": 1784397062398,
        "option_stock_sync_code": "175252569", "goods_name": "빈티지 흑청 스커트",
    }]
    refund_info = {
        "refund_bank_sno": 23, "refund_bank_account_holder": "김도희",
        "refund_bank_account_number": "190869094396", "buyer_tel": "010-9895-3722",
    }
    cancel_result = {
        "need_to_be_soldout_goods_list": [],
        "need_to_be_non_display_option_list": [
            {"sno": 636699893, "goods_sno": 48480185, "goods_option_sno": 374652350,
             "order_sno": 1784397062398, "goods_name": "빈티지 흑청 스커트", "option_info": "흑청/S"}
        ],
    }

    with patch(
        "api.client_cancel_soldout_routes.AblyClient.search_order_items_by_goods_name",
        new=AsyncMock(return_value=search_result),
    ), patch(
        "api.client_cancel_soldout_routes.AblyClient.get_order_refund_info",
        new=AsyncMock(return_value=refund_info),
    ), patch(
        "api.client_cancel_soldout_routes.AblyClient.cancel_order_items",
        new=AsyncMock(return_value=cancel_result),
    ), patch(
        "api.client_cancel_soldout_routes.AblyClient.stop_selling",
        new=AsyncMock(return_value=None),
    ) as mock_stop_selling, patch(
        "api.client_cancel_soldout_routes.EzAdminClient.send_sms",
        new=AsyncMock(return_value={"ok": True}),
    ) as mock_send_sms:
        res = client.post("/client-cancel-soldout/run", json={
            "products": [{"name": "빈티지 흑청 스커트", "option_codes": ["175252569"]}]
        })

    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is True
    assert data["cancelled_orders"] == [{
        "order_sno": 1784397062398, "buyer_tel": "010-9895-3722",
        "product_names": ["빈티지 흑청 스커트"], "sms_sent": True,
    }]
    assert data["failed_orders"] == []
    assert data["non_display_option_count"] == 1
    assert data["soldout_goods_count"] == 0
    assert data["need_ezdesk_session"] is False

    mock_stop_selling.assert_awaited_once_with(
        non_display_option_snos=[374652350], soldout_goods_snos=[]
    )
    mock_send_sms.assert_awaited_once_with(
        "010-9895-3722", "15339827", "주문해주신 '빈티지 흑청 스커트' 이 품절되었습니다."
    )


def test_run_records_ezdesk_session_expired_but_keeps_cancel_result(tmp_path):
    client, _get_db, _keep_alive = _make_client(tmp_path / "missing.xlsx")

    search_result = [{
        "sno": 636699893, "order_sno": 1784397062398,
        "option_stock_sync_code": "175252569", "goods_name": "빈티지 흑청 스커트",
    }]
    refund_info = {
        "refund_bank_sno": 23, "refund_bank_account_holder": "김도희",
        "refund_bank_account_number": "190869094396", "buyer_tel": "010-9895-3722",
    }
    cancel_result = {"need_to_be_soldout_goods_list": [], "need_to_be_non_display_option_list": []}

    with patch(
        "api.client_cancel_soldout_routes.AblyClient.search_order_items_by_goods_name",
        new=AsyncMock(return_value=search_result),
    ), patch(
        "api.client_cancel_soldout_routes.AblyClient.get_order_refund_info",
        new=AsyncMock(return_value=refund_info),
    ), patch(
        "api.client_cancel_soldout_routes.AblyClient.cancel_order_items",
        new=AsyncMock(return_value=cancel_result),
    ), patch(
        "api.client_cancel_soldout_routes.EzAdminClient.send_sms",
        new=AsyncMock(side_effect=EzDeskSessionExpired()),
    ):
        res = client.post("/client-cancel-soldout/run", json={
            "products": [{"name": "빈티지 흑청 스커트", "option_codes": ["175252569"]}]
        })

    data = res.json()
    assert data["need_ezdesk_session"] is True
    assert data["cancelled_orders"][0]["sms_sent"] is False


def test_run_records_cancel_failure_and_continues(tmp_path):
    client, _get_db, _keep_alive = _make_client(tmp_path / "missing.xlsx")

    search_result = [{
        "sno": 636699893, "order_sno": 1784397062398,
        "option_stock_sync_code": "175252569", "goods_name": "빈티지 흑청 스커트",
    }]
    refund_info = {
        "refund_bank_sno": 23, "refund_bank_account_holder": "김도희",
        "refund_bank_account_number": "190869094396", "buyer_tel": "010-9895-3722",
    }

    with patch(
        "api.client_cancel_soldout_routes.AblyClient.search_order_items_by_goods_name",
        new=AsyncMock(return_value=search_result),
    ), patch(
        "api.client_cancel_soldout_routes.AblyClient.get_order_refund_info",
        new=AsyncMock(return_value=refund_info),
    ), patch(
        "api.client_cancel_soldout_routes.AblyClient.cancel_order_items",
        new=AsyncMock(side_effect=RuntimeError("cancel failed")),
    ):
        res = client.post("/client-cancel-soldout/run", json={
            "products": [{"name": "빈티지 흑청 스커트", "option_codes": ["175252569"]}]
        })

    data = res.json()
    assert data["cancelled_orders"] == []
    assert data["failed_orders"] == [
        {"order_sno": 1784397062398, "stage": "cancel", "reason": "cancel failed"}
    ]
