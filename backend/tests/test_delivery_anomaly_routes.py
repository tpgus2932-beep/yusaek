import sqlite3
import sys
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.delivery_anomaly_routes import (
    EzAdminSessionExpired,
    EzDeskSessionExpired,
    build_delivery_anomaly_router,
)
from services.delivery_anomaly_store import init_delivery_anomaly_tables, sync_anomalies


def _make_db_factory():
    uri = f"file:test_delivery_anomaly_routes_{uuid.uuid4().hex}?mode=memory&cache=shared"
    keep_alive = sqlite3.connect(uri, uri=True)
    keep_alive.row_factory = sqlite3.Row

    def factory():
        conn = sqlite3.connect(uri, uri=True)
        conn.row_factory = sqlite3.Row
        return conn

    return factory, keep_alive


def _make_client():
    get_db, keep_alive = _make_db_factory()
    init_delivery_anomaly_tables(get_db)

    app = FastAPI()
    app.include_router(
        build_delivery_anomaly_router(
            get_current_user=lambda: "tester",
            get_db=get_db,
            get_setting=lambda key: None,
            set_setting=lambda key, value: None,
        )
    )
    return TestClient(app), get_db, keep_alive


def _sample():
    return {
        "order_no": "o1", "product_name": "상품A", "option_info": "M",
        "phone": "01011112222", "sent_date": "2026-07-18", "status": "-",
        "location": "-", "scan_date": "-", "reason": "llogis에서 송장을 찾을 수 없음",
    }


def test_list_empty_initially():
    client, _get_db, _keep_alive = _make_client()
    res = client.get("/delivery-anomaly/list")
    assert res.status_code == 200
    assert res.json() == {"items": [], "lastRunAt": None}


def test_list_returns_synced_anomaly():
    client, get_db, _keep_alive = _make_client()
    conn = get_db()
    sync_anomalies(conn, {"999": _sample()})
    conn.close()

    res = client.get("/delivery-anomaly/list")
    items = res.json()["items"]
    assert len(items) == 1
    assert items[0]["invoiceNo"] == "999"


def test_list_confirm_fields_default_to_none():
    client, get_db, _keep_alive = _make_client()
    conn = get_db()
    sync_anomalies(conn, {"999": _sample()})
    conn.close()

    items = client.get("/delivery-anomaly/list").json()["items"]
    assert items[0]["confirmSentAt"] is None
    assert items[0]["confirmReply"] is None
    assert items[0]["confirmReplyAt"] is None


def test_confirm_send_missing_anomaly_returns_404():
    client, _get_db, _keep_alive = _make_client()
    res = client.post("/delivery-anomaly/9999/confirm-send")
    assert res.status_code == 404


def test_confirm_send_missing_phone_returns_400():
    client, get_db, _keep_alive = _make_client()
    conn = get_db()
    sample = _sample()
    sample["phone"] = ""
    sync_anomalies(conn, {"999": sample})
    conn.close()
    anomaly_id = client.get("/delivery-anomaly/list").json()["items"][0]["id"]

    res = client.post(f"/delivery-anomaly/{anomaly_id}/confirm-send")
    assert res.status_code == 400


def test_confirm_send_success_persists_sent_at():
    client, get_db, _keep_alive = _make_client()
    conn = get_db()
    sync_anomalies(conn, {"999": _sample()})
    conn.close()
    anomaly_id = client.get("/delivery-anomaly/list").json()["items"][0]["id"]

    with patch("api.delivery_anomaly_routes.EzAdminClient.send_sms", new=AsyncMock(return_value={"ok": True})):
        res = client.post(f"/delivery-anomaly/{anomaly_id}/confirm-send")
    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is True
    assert data["confirmSentAt"]

    items = client.get("/delivery-anomaly/list").json()["items"]
    assert items[0]["confirmSentAt"] is not None
    assert items[0]["confirmReply"] is None


def test_confirm_send_need_ezdesk_session():
    client, get_db, _keep_alive = _make_client()
    conn = get_db()
    sync_anomalies(conn, {"999": _sample()})
    conn.close()
    anomaly_id = client.get("/delivery-anomaly/list").json()["items"][0]["id"]

    with patch(
        "api.delivery_anomaly_routes.EzAdminClient.send_sms",
        new=AsyncMock(side_effect=EzDeskSessionExpired()),
    ):
        res = client.post(f"/delivery-anomaly/{anomaly_id}/confirm-send")
    assert res.status_code == 200
    assert res.json() == {"ok": False, "need_ezdesk_session": True}

    items = client.get("/delivery-anomaly/list").json()["items"]
    assert items[0]["confirmSentAt"] is None


def test_list_response_fields_default_to_none():
    client, get_db, _keep_alive = _make_client()
    conn = get_db()
    sync_anomalies(conn, {"999": _sample()})
    conn.close()

    items = client.get("/delivery-anomaly/list").json()["items"]
    assert items[0]["responseSentAt"] is None
    assert items[0]["responseText"] is None


def test_respond_lost_missing_anomaly_returns_404():
    client, _get_db, _keep_alive = _make_client()
    res = client.post("/delivery-anomaly/9999/respond-lost")
    assert res.status_code == 404


def test_respond_lost_success_persists_response():
    client, get_db, _keep_alive = _make_client()
    conn = get_db()
    sync_anomalies(conn, {"999": _sample()})
    conn.close()
    anomaly_id = client.get("/delivery-anomaly/list").json()["items"][0]["id"]

    with patch("api.delivery_anomaly_routes.EzAdminClient.send_sms", new=AsyncMock(return_value={"ok": True})):
        res = client.post(f"/delivery-anomaly/{anomaly_id}/respond-lost")
    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is True
    assert data["responseSentAt"]

    items = client.get("/delivery-anomaly/list").json()["items"]
    assert items[0]["responseSentAt"] is not None
    assert "택배사 분실 건으로 확인되었습니다" in items[0]["responseText"]


def test_respond_lost_need_ezdesk_session():
    client, get_db, _keep_alive = _make_client()
    conn = get_db()
    sync_anomalies(conn, {"999": _sample()})
    conn.close()
    anomaly_id = client.get("/delivery-anomaly/list").json()["items"][0]["id"]

    with patch(
        "api.delivery_anomaly_routes.EzAdminClient.send_sms",
        new=AsyncMock(side_effect=EzDeskSessionExpired()),
    ):
        res = client.post(f"/delivery-anomaly/{anomaly_id}/respond-lost")
    assert res.status_code == 200
    assert res.json() == {"ok": False, "need_ezdesk_session": True}

    items = client.get("/delivery-anomaly/list").json()["items"]
    assert items[0]["responseSentAt"] is None


def test_respond_custom_rejects_blank_text():
    client, get_db, _keep_alive = _make_client()
    conn = get_db()
    sync_anomalies(conn, {"999": _sample()})
    conn.close()
    anomaly_id = client.get("/delivery-anomaly/list").json()["items"][0]["id"]

    res = client.post(f"/delivery-anomaly/{anomaly_id}/respond-custom", json={"text": "   "})
    assert res.status_code == 400


def test_respond_custom_missing_phone_returns_400():
    client, get_db, _keep_alive = _make_client()
    conn = get_db()
    sample = _sample()
    sample["phone"] = ""
    sync_anomalies(conn, {"999": sample})
    conn.close()
    anomaly_id = client.get("/delivery-anomaly/list").json()["items"][0]["id"]

    res = client.post(f"/delivery-anomaly/{anomaly_id}/respond-custom", json={"text": "확인했습니다"})
    assert res.status_code == 400


def test_respond_custom_success_persists_response_text():
    client, get_db, _keep_alive = _make_client()
    conn = get_db()
    sync_anomalies(conn, {"999": _sample()})
    conn.close()
    anomaly_id = client.get("/delivery-anomaly/list").json()["items"][0]["id"]

    with patch("api.delivery_anomaly_routes.EzAdminClient.send_sms", new=AsyncMock(return_value={"ok": True})):
        res = client.post(f"/delivery-anomaly/{anomaly_id}/respond-custom", json={"text": "네 확인해보겠습니다"})
    assert res.status_code == 200
    assert res.json()["ok"] is True

    items = client.get("/delivery-anomaly/list").json()["items"]
    assert items[0]["responseSentAt"] is not None
    assert items[0]["responseText"] == "네 확인해보겠습니다"


def _packlist_item():
    return {
        "prd_seq": "593400",
        "shop_id": "10028",
        "product_id": "S14118",
        "product_name": "코링 드롭 와이 롱 실버 목걸이",
        "shop_product_name": "[길이조절가능!/코디필수템] 코링 드롭 와이 롱 실버 목걸이",
        "options": "[실버-FREE]",
        "qty": "1",
        "amount": 16400,
    }


def test_list_marks_lost_response_and_defaults_copy_fields_to_none():
    client, get_db, _keep_alive = _make_client()
    conn = get_db()
    sync_anomalies(conn, {"999": _sample()})
    conn.close()

    with patch("api.delivery_anomaly_routes.EzAdminClient.send_sms", new=AsyncMock(return_value={"ok": True})):
        client.post(f"/delivery-anomaly/{client.get('/delivery-anomaly/list').json()['items'][0]['id']}/respond-lost")

    items = client.get("/delivery-anomaly/list").json()["items"]
    assert items[0]["isLostResponse"] is True
    assert items[0]["orderCopiedAt"] is None


def test_copy_order_missing_anomaly_returns_404():
    client, _get_db, _keep_alive = _make_client()
    res = client.post("/delivery-anomaly/9999/copy-order")
    assert res.status_code == 404


def test_copy_order_success_persists_copied_at():
    client, get_db, _keep_alive = _make_client()
    conn = get_db()
    sync_anomalies(conn, {"999": _sample()})
    conn.close()
    anomaly_id = client.get("/delivery-anomaly/list").json()["items"][0]["id"]

    with patch(
        "api.delivery_anomaly_routes.EzAdminClient.find_pack_by_order_sno",
        new=AsyncMock(return_value="570105"),
    ), patch(
        "api.delivery_anomaly_routes.EzAdminClient.packlist_items",
        new=AsyncMock(return_value=[_packlist_item()]),
    ), patch(
        "api.delivery_anomaly_routes.EzAdminClient.copy_order",
        new=AsyncMock(return_value={"error": 0}),
    ) as mock_copy:
        res = client.post(f"/delivery-anomaly/{anomaly_id}/copy-order")

    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is True
    assert data["orderCopiedAt"]
    mock_copy.assert_awaited_once()
    _, kwargs = mock_copy.call_args
    assert kwargs["product_id"] == "S14118"
    assert kwargs["product_name"] == "[길이조절가능!/코디필수템] 코링 드롭 와이 롱 실버 목걸이"
    assert kwargs["extra_money"] == 16400

    items = client.get("/delivery-anomaly/list").json()["items"]
    assert items[0]["orderCopiedAt"] is not None


def test_copy_order_no_pack_found_returns_ok_false():
    client, get_db, _keep_alive = _make_client()
    conn = get_db()
    sync_anomalies(conn, {"999": _sample()})
    conn.close()
    anomaly_id = client.get("/delivery-anomaly/list").json()["items"][0]["id"]

    with patch(
        "api.delivery_anomaly_routes.EzAdminClient.find_pack_by_order_sno",
        new=AsyncMock(return_value=None),
    ):
        res = client.post(f"/delivery-anomaly/{anomaly_id}/copy-order")

    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is False

    items = client.get("/delivery-anomaly/list").json()["items"]
    assert items[0]["orderCopiedAt"] is None


def test_copy_order_multiple_items_no_match_returns_ok_false():
    client, get_db, _keep_alive = _make_client()
    conn = get_db()
    sync_anomalies(conn, {"999": _sample()})
    conn.close()
    anomaly_id = client.get("/delivery-anomaly/list").json()["items"][0]["id"]

    other_item = dict(_packlist_item(), prd_seq="999999", product_name="다른상품", shop_product_name="다른상품")
    with patch(
        "api.delivery_anomaly_routes.EzAdminClient.find_pack_by_order_sno",
        new=AsyncMock(return_value="570105"),
    ), patch(
        "api.delivery_anomaly_routes.EzAdminClient.packlist_items",
        new=AsyncMock(return_value=[_packlist_item(), other_item]),
    ):
        res = client.post(f"/delivery-anomaly/{anomaly_id}/copy-order")

    assert res.status_code == 200
    assert res.json()["ok"] is False


def test_copy_order_multiple_items_matches_by_product_name():
    client, get_db, _keep_alive = _make_client()
    conn = get_db()
    sample = _sample()
    sample["product_name"] = "코링 드롭 와이 롱 실버 목걸이"
    sync_anomalies(conn, {"999": sample})
    conn.close()
    anomaly_id = client.get("/delivery-anomaly/list").json()["items"][0]["id"]

    other_item = dict(_packlist_item(), prd_seq="999999", product_name="다른상품", shop_product_name="다른상품")
    with patch(
        "api.delivery_anomaly_routes.EzAdminClient.find_pack_by_order_sno",
        new=AsyncMock(return_value="570105"),
    ), patch(
        "api.delivery_anomaly_routes.EzAdminClient.packlist_items",
        new=AsyncMock(return_value=[other_item, _packlist_item()]),
    ), patch(
        "api.delivery_anomaly_routes.EzAdminClient.copy_order",
        new=AsyncMock(return_value={"error": 0}),
    ) as mock_copy:
        res = client.post(f"/delivery-anomaly/{anomaly_id}/copy-order")

    assert res.status_code == 200
    assert res.json()["ok"] is True
    _, kwargs = mock_copy.call_args
    assert kwargs["product_id"] == "S14118"


def test_copy_order_session_expired():
    client, get_db, _keep_alive = _make_client()
    conn = get_db()
    sync_anomalies(conn, {"999": _sample()})
    conn.close()
    anomaly_id = client.get("/delivery-anomaly/list").json()["items"][0]["id"]

    with patch(
        "api.delivery_anomaly_routes.EzAdminClient.find_pack_by_order_sno",
        new=AsyncMock(side_effect=EzAdminSessionExpired()),
    ):
        res = client.post(f"/delivery-anomaly/{anomaly_id}/copy-order")

    assert res.status_code == 200
    assert res.json() == {"ok": False, "need_session": True}
