import sqlite3
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.delivery_anomaly_routes import build_delivery_anomaly_router
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
    assert res.json() == {"items": []}


def test_list_returns_synced_anomaly():
    client, get_db, _keep_alive = _make_client()
    conn = get_db()
    sync_anomalies(conn, {"999": _sample()})
    conn.close()

    res = client.get("/delivery-anomaly/list")
    items = res.json()["items"]
    assert len(items) == 1
    assert items[0]["invoiceNo"] == "999"
    assert items[0]["commentCount"] == 0


def test_add_and_list_comment():
    client, get_db, _keep_alive = _make_client()
    conn = get_db()
    sync_anomalies(conn, {"999": _sample()})
    conn.close()
    anomaly_id = client.get("/delivery-anomaly/list").json()["items"][0]["id"]

    res = client.post(f"/delivery-anomaly/{anomaly_id}/comments", json={"text": "확인 중입니다"})
    assert res.status_code == 200

    comments = client.get(f"/delivery-anomaly/{anomaly_id}/comments").json()["items"]
    assert len(comments) == 1
    assert comments[0]["username"] == "tester"
    assert comments[0]["text"] == "확인 중입니다"


def test_add_comment_rejects_blank_text():
    client, get_db, _keep_alive = _make_client()
    conn = get_db()
    sync_anomalies(conn, {"999": _sample()})
    conn.close()
    anomaly_id = client.get("/delivery-anomaly/list").json()["items"][0]["id"]
    res = client.post(f"/delivery-anomaly/{anomaly_id}/comments", json={"text": "   "})
    assert res.status_code == 400


def test_add_comment_missing_anomaly_returns_404():
    client, _get_db, _keep_alive = _make_client()
    res = client.post("/delivery-anomaly/9999/comments", json={"text": "hi"})
    assert res.status_code == 404
