import json
import sqlite3
import sys
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.client_cancel_soldout_routes import build_client_cancel_soldout_router
from sdk.ezadmin import EzAdminSessionExpired, EzDeskSessionExpired


def _make_db_factory():
    uri = f"file:test_client_cancel_soldout_{uuid.uuid4().hex}?mode=memory&cache=shared"
    keep_alive = sqlite3.connect(uri, uri=True)
    keep_alive.row_factory = sqlite3.Row
    keep_alive.execute(
        "CREATE TABLE sms_templates (id TEXT PRIMARY KEY, name TEXT, msg TEXT, title TEXT, msg_type TEXT, sort_order INTEGER)"
    )
    keep_alive.execute(
        "CREATE TABLE client_cancel_soldout_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, "
        "created_at TEXT NOT NULL, username TEXT NOT NULL, action TEXT NOT NULL, summary_json TEXT NOT NULL)"
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
    conn = sqlite3.connect(str(path))
    conn.execute(
        "CREATE TABLE wonbe (상품코드 TEXT, 상품명 TEXT, 색상 TEXT, 사이즈 TEXT, 거래처 TEXT, "
        "거래처상품명 TEXT, 옵션번호 TEXT)"
    )
    conn.execute(
        "INSERT INTO wonbe (상품코드, 상품명, 색상, 사이즈, 거래처, 거래처상품명, 옵션번호) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        ("S10456", "빈티지 흑청 스커트", "흑청", "S", "오즈브릿지", "273빈티지흑청스커트", "175252569"),
    )
    conn.commit()
    conn.close()


def test_cost_base_search_returns_grouped_items(tmp_path):
    cost_base_path = tmp_path / "cost_base.db"
    _write_cost_base(cost_base_path)
    client, _get_db, _keep_alive = _make_client(cost_base_path)

    res = client.get("/client-cancel-soldout/cost-base/search", params={"q": "빈티지"})

    assert res.status_code == 200
    assert res.json() == {
        "ok": True,
        "items": [{
            "name": "빈티지 흑청 스커트",
            "options": [{"code": "175252569", "label": "흑청/S", "product_id": "S10456"}],
        }],
    }


def test_pending_count_without_product_id_returns_400(tmp_path):
    client, _get_db, _keep_alive = _make_client(tmp_path / "missing.db")

    res = client.get("/client-cancel-soldout/pending-count", params={"product_id": ""})

    assert res.status_code == 400


def test_pending_count_returns_remaining(tmp_path):
    client, _get_db, _keep_alive = _make_client(tmp_path / "missing.db")

    with patch(
        "api.client_cancel_soldout_routes.EzAdminClient.get_pending_order_count",
        new=AsyncMock(return_value=56),
    ) as mock_get:
        res = client.get("/client-cancel-soldout/pending-count", params={"product_id": "S13438"})

    assert res.status_code == 200
    assert res.json() == {"ok": True, "product_id": "S13438", "remaining": 56}
    mock_get.assert_awaited_once_with("S13438")


def test_pending_count_product_not_found_returns_404(tmp_path):
    client, _get_db, _keep_alive = _make_client(tmp_path / "missing.db")

    with patch(
        "api.client_cancel_soldout_routes.EzAdminClient.get_pending_order_count",
        new=AsyncMock(side_effect=ValueError("상품코드 S99999를 찾을 수 없습니다")),
    ):
        res = client.get("/client-cancel-soldout/pending-count", params={"product_id": "S99999"})

    assert res.status_code == 404


def test_pending_count_ezadmin_session_expired_returns_409(tmp_path):
    client, _get_db, _keep_alive = _make_client(tmp_path / "missing.db")

    with patch(
        "api.client_cancel_soldout_routes.EzAdminClient.get_pending_order_count",
        new=AsyncMock(side_effect=EzAdminSessionExpired()),
    ):
        res = client.get("/client-cancel-soldout/pending-count", params={"product_id": "S13438"})

    assert res.status_code == 409


def test_delist_without_products_returns_400(tmp_path):
    client, _get_db, _keep_alive = _make_client(tmp_path / "missing.db")

    res = client.post("/client-cancel-soldout/delist", json={"products": []})

    assert res.status_code == 400


def test_delist_calls_stop_selling_with_option_codes_as_ints(tmp_path):
    client, _get_db, _keep_alive = _make_client(tmp_path / "missing.db")

    with patch(
        "api.client_cancel_soldout_routes.AblyClient.stop_selling",
        new=AsyncMock(return_value=None),
    ) as mock_stop_selling:
        res = client.post("/client-cancel-soldout/delist", json={
            "products": [{
                "name": "빈티지 흑청 스커트",
                "options": [
                    {"code": "175252569", "product_id": "S10456"},
                    {"code": "175252570", "product_id": "S10457"},
                ],
            }],
        })

    assert res.status_code == 200
    data = res.json()
    assert data == {"ok": True, "non_display_option_count": 2}

    call_kwargs = mock_stop_selling.call_args.kwargs
    assert sorted(call_kwargs["non_display_option_snos"]) == [175252569, 175252570]
    assert call_kwargs["soldout_goods_snos"] == []

    log_row = _keep_alive.execute(
        "SELECT username, action, summary_json FROM client_cancel_soldout_logs"
    ).fetchone()
    assert log_row["username"] == "tester"
    assert log_row["action"] == "delist"
    assert json.loads(log_row["summary_json"])["non_display_option_count"] == 2


def test_delist_stop_selling_failure_returns_502(tmp_path):
    client, _get_db, _keep_alive = _make_client(tmp_path / "missing.db")

    with patch(
        "api.client_cancel_soldout_routes.AblyClient.stop_selling",
        new=AsyncMock(side_effect=RuntimeError("boom")),
    ):
        res = client.post("/client-cancel-soldout/delist", json={
            "products": [{"name": "빈티지 흑청 스커트", "options": [{"code": "175252569", "product_id": "S10456"}]}]
        })

    assert res.status_code == 502


def test_run_without_products_returns_400(tmp_path):
    client, _get_db, _keep_alive = _make_client(tmp_path / "missing.db")

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
            cost_base_path=tmp_path / "missing.db",
        )
    )
    client = TestClient(app)

    res = client.post("/client-cancel-soldout/run", json={
        "products": [{"name": "빈티지 흑청 스커트", "options": [{"code": "175252569", "product_id": "S10456"}]}]
    })

    assert res.status_code == 400
    assert "품절 문자" in res.json()["detail"]


def test_run_cancels_matching_order_sends_sms_and_reports_pending_count(tmp_path):
    client, _get_db, _keep_alive = _make_client(tmp_path / "missing.db")

    search_result = [{
        "sno": 636699893, "order_sno": 1784397062398,
        "option_stock_sync_code": "175252569", "goods_name": "빈티지 흑청 스커트",
        "option_info": "흑청/S", "ea": 1,
    }]
    refund_info = {
        "refund_bank_sno": 23, "refund_bank_account_holder": "김도희",
        "refund_bank_account_number": "190869094396", "buyer_tel": "010-9895-3722",
        "buyer_name": "김도희",
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
    ) as mock_send_sms, patch(
        "api.client_cancel_soldout_routes.EzAdminClient.get_pending_order_count",
        new=AsyncMock(return_value=56),
    ) as mock_pending_count:
        res = client.post("/client-cancel-soldout/run", json={
            "products": [{
                "name": "빈티지 흑청 스커트",
                "options": [{"code": "175252569", "product_id": "S10456"}],
            }]
        })

    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is True
    assert data["cancelled_orders"] == [{
        "order_sno": 1784397062398, "buyer_name": "김도희", "buyer_tel": "010-9895-3722",
        "items": [{"name": "빈티지 흑청 스커트", "option_info": "흑청/S", "ea": 1}],
        "product_names": ["빈티지 흑청 스커트"], "sms_sent": True,
    }]
    assert data["failed_orders"] == []
    assert data["non_display_option_count"] == 1
    assert data["soldout_goods_count"] == 0
    assert data["need_ezdesk_session"] is False
    assert data["need_ezadmin_session"] is False
    assert data["pending_counts"] == [{"product_id": "S10456", "remaining": 56}]

    mock_stop_selling.assert_awaited_once_with(
        non_display_option_snos=[374652350], soldout_goods_snos=[]
    )
    mock_send_sms.assert_awaited_once_with(
        "010-9895-3722", "15339827", "주문해주신 '빈티지 흑청 스커트' 이 품절되었습니다."
    )
    mock_pending_count.assert_awaited_once_with("S10456")

    log_row = _keep_alive.execute(
        "SELECT username, action, summary_json FROM client_cancel_soldout_logs"
    ).fetchone()
    assert log_row["username"] == "tester"
    assert log_row["action"] == "run"
    summary = json.loads(log_row["summary_json"])
    assert summary["products"] == [{"name": "빈티지 흑청 스커트", "options": [{"code": "175252569", "label": ""}]}]
    assert summary["cancelled_orders"][0]["order_sno"] == 1784397062398
    assert summary["non_display_option_count"] == 1


def test_logs_endpoint_returns_recent_entries_newest_first(tmp_path):
    client, _get_db, keep_alive = _make_client(tmp_path / "missing.db")
    keep_alive.execute(
        "INSERT INTO client_cancel_soldout_logs (created_at, username, action, summary_json) VALUES (?, ?, ?, ?)",
        ("2026-07-28T10:00:00", "tester", "delist", '{"products": [], "non_display_option_count": 0}'),
    )
    keep_alive.execute(
        "INSERT INTO client_cancel_soldout_logs (created_at, username, action, summary_json) VALUES (?, ?, ?, ?)",
        ("2026-07-28T11:00:00", "tester2", "run", '{"products": [], "cancelled_orders": []}'),
    )
    keep_alive.commit()

    res = client.get("/client-cancel-soldout/logs")

    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is True
    assert [item["action"] for item in data["items"]] == ["run", "delist"]
    assert data["items"][0]["username"] == "tester2"
    assert data["items"][0]["summary"] == {"products": [], "cancelled_orders": []}


def test_run_records_ezdesk_session_expired_but_keeps_cancel_result(tmp_path):
    client, _get_db, _keep_alive = _make_client(tmp_path / "missing.db")

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
    ), patch(
        "api.client_cancel_soldout_routes.EzAdminClient.get_pending_order_count",
        new=AsyncMock(return_value=0),
    ):
        res = client.post("/client-cancel-soldout/run", json={
            "products": [{
                "name": "빈티지 흑청 스커트",
                "options": [{"code": "175252569", "product_id": "S10456"}],
            }]
        })

    data = res.json()
    assert data["need_ezdesk_session"] is True
    assert data["cancelled_orders"][0]["sms_sent"] is False


def test_run_records_cancel_failure_and_continues(tmp_path):
    client, _get_db, _keep_alive = _make_client(tmp_path / "missing.db")

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
    ), patch(
        "api.client_cancel_soldout_routes.EzAdminClient.get_pending_order_count",
        new=AsyncMock(return_value=0),
    ):
        res = client.post("/client-cancel-soldout/run", json={
            "products": [{
                "name": "빈티지 흑청 스커트",
                "options": [{"code": "175252569", "product_id": "S10456"}],
            }]
        })

    data = res.json()
    assert data["cancelled_orders"] == []
    assert data["failed_orders"] == [
        {"order_sno": 1784397062398, "stage": "cancel", "reason": "cancel failed"}
    ]


def test_run_pending_count_ezadmin_session_expired_is_reported(tmp_path):
    client, _get_db, _keep_alive = _make_client(tmp_path / "missing.db")

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
        new=AsyncMock(return_value={"ok": True}),
    ), patch(
        "api.client_cancel_soldout_routes.EzAdminClient.get_pending_order_count",
        new=AsyncMock(side_effect=EzAdminSessionExpired()),
    ):
        res = client.post("/client-cancel-soldout/run", json={
            "products": [{
                "name": "빈티지 흑청 스커트",
                "options": [{"code": "175252569", "product_id": "S10456"}],
            }]
        })

    data = res.json()
    assert data["need_ezadmin_session"] is True
    assert data["pending_counts"] == [{"product_id": "S10456", "remaining": None, "error": "EZAdmin 세션 만료"}]
