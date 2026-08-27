import json
import sqlite3
import sys
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.post_shipment_cancel_stock_sms_routes import build_post_shipment_cancel_stock_sms_router
from sdk.ezadmin import EzAdminSessionExpired, EzDeskSessionExpired


def _make_db_factory():
    uri = f"file:test_post_shipment_cancel_stock_sms_{uuid.uuid4().hex}?mode=memory&cache=shared"
    keep_alive = sqlite3.connect(uri, uri=True)
    keep_alive.row_factory = sqlite3.Row
    keep_alive.execute(
        "CREATE TABLE sms_templates (id TEXT PRIMARY KEY, name TEXT, msg TEXT, title TEXT, msg_type TEXT, sort_order INTEGER)"
    )
    keep_alive.execute(
        "CREATE TABLE post_shipment_cancel_stock_review (id INTEGER PRIMARY KEY AUTOINCREMENT, "
        "created_at TEXT NOT NULL, username TEXT NOT NULL, cancel_sno TEXT NOT NULL UNIQUE, "
        "order_sno TEXT NOT NULL DEFAULT '', buyer_tel TEXT NOT NULL DEFAULT '', "
        "product_names TEXT NOT NULL DEFAULT '[]', action TEXT NOT NULL, error TEXT)"
    )
    keep_alive.commit()

    def factory():
        conn = sqlite3.connect(uri, uri=True)
        conn.row_factory = sqlite3.Row
        return conn

    return factory, keep_alive


def _make_client(*, with_template=True):
    get_db, keep_alive = _make_db_factory()
    if with_template:
        keep_alive.execute(
            "INSERT INTO sms_templates (id, name, msg, title, msg_type, sort_order) VALUES (?, ?, ?, '', '', 0)",
            ("1", "배송후취소 확인문자", "주문하신 '{상품}' 취소 진행해드릴까요?"),
        )
        keep_alive.commit()

    app = FastAPI()
    app.include_router(
        build_post_shipment_cancel_stock_sms_router(
            get_current_user=lambda: "tester",
            get_setting=lambda key: None,
            get_db=get_db,
        )
    )
    return TestClient(app), get_db, keep_alive


def _cancel(sno, order_sno, code, buyer_tel="010-1111-2222", goods_name="빈티지 흑청 스커트", item_sno=None):
    return {
        "sno": sno,
        "order_items": [{
            "sno": item_sno if item_sno is not None else sno * 10,
            "order_sno": order_sno,
            "option_stock_sync_code": code,
            "buyer_tel": buyer_tel,
            "goods_name": goods_name,
        }],
    }


def test_check_missing_template_returns_400():
    client, _get_db, _keep_alive = _make_client(with_template=False)

    res = client.post("/post-shipment-cancel-stock-sms/check")

    assert res.status_code == 400
    assert "배송후취소 확인문자" in res.json()["detail"]


def test_check_categorizes_by_stock():
    client, _get_db, _keep_alive = _make_client()

    cancels = [
        _cancel(1001, 5001, "S10456", buyer_tel="010-1111-2222"),
        _cancel(1002, 5002, "S10457", buyer_tel="010-3333-4444"),
    ]

    with patch(
        "api.post_shipment_cancel_stock_sms_routes.AblyClient.list_order_cancels",
        new=AsyncMock(return_value=cancels),
    ), patch(
        "api.post_shipment_cancel_stock_sms_routes.EzAdminClient.get_stock_for_codes",
        new=AsyncMock(return_value={"S10456": 3, "S10457": 0}),
    ) as mock_stock:
        res = client.post("/post-shipment-cancel-stock-sms/check")

    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is True
    assert data["checked_orders"] == 2
    assert [row["cancel_sno"] for row in data["with_stock"]] == ["1001"]
    assert data["with_stock"][0]["message"] == "주문하신 '빈티지 흑청 스커트' 취소 진행해드릴까요?"
    assert [row["cancel_sno"] for row in data["no_stock"]] == ["1002"]
    assert data["no_stock"][0]["item_snos"] == [10020]

    mock_stock.assert_awaited_once()
    assert sorted(mock_stock.call_args.args[0]) == ["S10456", "S10457"]


def test_check_skips_already_reviewed_cancels():
    client, _get_db, keep_alive = _make_client()
    keep_alive.execute(
        "INSERT INTO post_shipment_cancel_stock_review "
        "(created_at, username, cancel_sno, order_sno, buyer_tel, product_names, action) "
        "VALUES ('2026-08-01T00:00:00', 'tester', '1001', '5001', '010-1111-2222', '[]', 'sms_sent')"
    )
    keep_alive.commit()

    cancels = [_cancel(1001, 5001, "S10456")]

    with patch(
        "api.post_shipment_cancel_stock_sms_routes.AblyClient.list_order_cancels",
        new=AsyncMock(return_value=cancels),
    ), patch(
        "api.post_shipment_cancel_stock_sms_routes.EzAdminClient.get_stock_for_codes",
        new=AsyncMock(return_value={"S10456": 5}),
    ) as mock_stock:
        res = client.post("/post-shipment-cancel-stock-sms/check")

    data = res.json()
    assert data["checked_orders"] == 0
    mock_stock.assert_not_awaited()


def test_check_ezadmin_session_expired_returns_need_session():
    client, _get_db, _keep_alive = _make_client()
    cancels = [_cancel(1001, 5001, "S10456")]

    with patch(
        "api.post_shipment_cancel_stock_sms_routes.AblyClient.list_order_cancels",
        new=AsyncMock(return_value=cancels),
    ), patch(
        "api.post_shipment_cancel_stock_sms_routes.EzAdminClient.get_stock_for_codes",
        new=AsyncMock(side_effect=EzAdminSessionExpired()),
    ):
        res = client.post("/post-shipment-cancel-stock-sms/check")

    data = res.json()
    assert data["ok"] is False
    assert data["need_ezadmin_session"] is True


def test_send_sends_sms_and_completes_no_stock():
    client, _get_db, keep_alive = _make_client()
    payload = {
        "with_stock": [{
            "cancel_sno": "1001", "order_sno": "5001", "buyer_tel": "010-1111-2222",
            "product_names": ["빈티지 흑청 스커트"],
        }],
        "no_stock": [{
            "cancel_sno": "1002", "order_sno": "5002", "buyer_tel": "010-3333-4444",
            "product_names": ["다른 상품"], "item_snos": [648138733],
        }],
    }

    with patch(
        "api.post_shipment_cancel_stock_sms_routes.EzAdminClient.send_sms",
        new=AsyncMock(return_value={"ok": True}),
    ) as mock_send_sms, patch(
        "api.post_shipment_cancel_stock_sms_routes.AblyClient.confirm_order_items",
        new=AsyncMock(return_value=None),
    ) as mock_confirm:
        res = client.post("/post-shipment-cancel-stock-sms/send", json=payload)

    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is True
    assert [row["cancel_sno"] for row in data["sms_sent"]] == ["1001"]
    assert [row["cancel_sno"] for row in data["completed"]] == ["1002"]
    assert data["failed"] == []
    assert data["need_ezdesk_session"] is False

    mock_send_sms.assert_awaited_once_with(
        "010-1111-2222", "15339827", "주문하신 '빈티지 흑청 스커트' 취소 진행해드릴까요?"
    )
    mock_confirm.assert_awaited_once_with([648138733])

    review_rows = {
        row["cancel_sno"]: row["action"]
        for row in keep_alive.execute("SELECT cancel_sno, action FROM post_shipment_cancel_stock_review").fetchall()
    }
    assert review_rows == {"1001": "sms_sent", "1002": "completed"}


def test_send_ezdesk_session_expired_reports_failed_and_flag():
    client, _get_db, keep_alive = _make_client()
    payload = {
        "with_stock": [{
            "cancel_sno": "1001", "order_sno": "5001", "buyer_tel": "010-1111-2222",
            "product_names": ["빈티지 흑청 스커트"],
        }],
        "no_stock": [],
    }

    with patch(
        "api.post_shipment_cancel_stock_sms_routes.EzAdminClient.send_sms",
        new=AsyncMock(side_effect=EzDeskSessionExpired()),
    ):
        res = client.post("/post-shipment-cancel-stock-sms/send", json=payload)

    data = res.json()
    assert data["need_ezdesk_session"] is True
    assert [row["cancel_sno"] for row in data["failed"]] == ["1001"]
    # 실패했으므로 review 테이블에 남지 않아야 재실행 시 다시 시도된다.
    assert keep_alive.execute("SELECT COUNT(*) c FROM post_shipment_cancel_stock_review").fetchone()["c"] == 0


def test_send_no_stock_without_item_snos_reports_failed():
    client, _get_db, keep_alive = _make_client()
    payload = {
        "with_stock": [],
        "no_stock": [{
            "cancel_sno": "1002", "order_sno": "5002", "buyer_tel": "010-3333-4444",
            "product_names": ["다른 상품"],
        }],
    }

    with patch(
        "api.post_shipment_cancel_stock_sms_routes.AblyClient.confirm_order_items",
        new=AsyncMock(return_value=None),
    ) as mock_confirm:
        res = client.post("/post-shipment-cancel-stock-sms/send", json=payload)

    data = res.json()
    assert data["completed"] == []
    assert [row["cancel_sno"] for row in data["failed"]] == ["1002"]
    assert "주문상품 정보" in data["failed"][0]["reason"]
    mock_confirm.assert_not_awaited()
    assert keep_alive.execute("SELECT COUNT(*) c FROM post_shipment_cancel_stock_review").fetchone()["c"] == 0


def test_send_no_stock_ably_confirm_failure_reports_failed():
    client, _get_db, keep_alive = _make_client()
    payload = {
        "with_stock": [],
        "no_stock": [{
            "cancel_sno": "1002", "order_sno": "5002", "buyer_tel": "010-3333-4444",
            "product_names": ["다른 상품"], "item_snos": [648138733],
        }],
    }

    with patch(
        "api.post_shipment_cancel_stock_sms_routes.AblyClient.confirm_order_items",
        new=AsyncMock(side_effect=RuntimeError("boom")),
    ):
        res = client.post("/post-shipment-cancel-stock-sms/send", json=payload)

    data = res.json()
    assert data["completed"] == []
    assert [row["cancel_sno"] for row in data["failed"]] == ["1002"]
    assert "에이블리 취소 승인 실패" in data["failed"][0]["reason"]
    # 실패했으므로 review 테이블에 남지 않아야 재실행 시 다시 시도된다.
    assert keep_alive.execute("SELECT COUNT(*) c FROM post_shipment_cancel_stock_review").fetchone()["c"] == 0


def test_send_skips_already_reviewed_cancels():
    client, _get_db, keep_alive = _make_client()
    keep_alive.execute(
        "INSERT INTO post_shipment_cancel_stock_review "
        "(created_at, username, cancel_sno, order_sno, buyer_tel, product_names, action) "
        "VALUES ('2026-08-01T00:00:00', 'tester', '1001', '5001', '010-1111-2222', '[]', 'sms_sent')"
    )
    keep_alive.commit()
    payload = {
        "with_stock": [{
            "cancel_sno": "1001", "order_sno": "5001", "buyer_tel": "010-1111-2222",
            "product_names": ["빈티지 흑청 스커트"],
        }],
        "no_stock": [],
    }

    with patch(
        "api.post_shipment_cancel_stock_sms_routes.EzAdminClient.send_sms",
        new=AsyncMock(return_value={"ok": True}),
    ) as mock_send_sms:
        res = client.post("/post-shipment-cancel-stock-sms/send", json=payload)

    data = res.json()
    assert data["sms_sent"] == []
    mock_send_sms.assert_not_awaited()


def test_logs_endpoint_returns_recent_entries_newest_first():
    client, _get_db, keep_alive = _make_client()
    keep_alive.execute(
        "INSERT INTO post_shipment_cancel_stock_review "
        "(created_at, username, cancel_sno, order_sno, buyer_tel, product_names, action) "
        "VALUES ('2026-08-01T00:00:00', 'tester', '1001', '5001', '010-1111-2222', '[\"A\"]', 'sms_sent')"
    )
    keep_alive.execute(
        "INSERT INTO post_shipment_cancel_stock_review "
        "(created_at, username, cancel_sno, order_sno, buyer_tel, product_names, action) "
        "VALUES ('2026-08-02T00:00:00', 'tester', '1002', '5002', '010-3333-4444', '[\"B\"]', 'completed')"
    )
    keep_alive.commit()

    res = client.get("/post-shipment-cancel-stock-sms/logs")

    assert res.status_code == 200
    data = res.json()
    assert [item["cancel_sno"] for item in data["items"]] == ["1002", "1001"]
    assert data["items"][0]["product_names"] == ["B"]
