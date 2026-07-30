import pytest
import sqlite3
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import FastAPI
from fastapi.testclient import TestClient

import services.order_recommendation_collect as collect_mod
from api.order_recommendation_routes import build_order_recommendation_router
from sdk.ezadmin import EzAdminSessionExpired
from services.order_recommendation_store import (
    ensure_row,
    init_order_recommendation_tables,
    today_kst,
)


def _make_db_factory():
    uri = f"file:test_order_recommendation_routes_{uuid.uuid4().hex}?mode=memory&cache=shared"
    keep_alive = sqlite3.connect(uri, uri=True)
    keep_alive.row_factory = sqlite3.Row

    def factory():
        conn = sqlite3.connect(uri, uri=True)
        conn.row_factory = sqlite3.Row
        return conn

    return factory, keep_alive


def _make_client(settings=None):
    get_db, keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)

    app = FastAPI()
    app.include_router(
        build_order_recommendation_router(
            get_current_user=lambda: "tester",
            get_db=get_db,
            get_setting=lambda key: (settings or {}).get(key),
        )
    )
    return TestClient(app), get_db, keep_alive


def test_daily_returns_empty_list_initially():
    client, _get_db, _keep_alive = _make_client()
    res = client.get("/order-recommendation/daily", params={"date": "2026-07-29"})
    assert res.status_code == 200
    assert res.json() == {"ok": True, "date": "2026-07-29", "items": []}


def test_confirm_creates_row_and_sets_confirmed_fields():
    client, get_db, _keep_alive = _make_client()
    res = client.post(
        "/order-recommendation/2026-07-29/YUSAS00001/confirm",
        json={"confirmed_qty": 7, "override_reason": "장마철 여유분"},
    )
    assert res.status_code == 200

    res2 = client.get("/order-recommendation/daily", params={"date": "2026-07-29"})
    items = res2.json()["items"]
    assert len(items) == 1
    assert items[0]["confirmed_qty"] == 7
    assert items[0]["override_reason"] == "장마철 여유분"
    assert items[0]["updated_by"] == "tester"
    assert items[0]["updated_at"] is not None


def test_compute_endpoint_fills_recommended_qty_for_existing_rows():
    client, get_db, _keep_alive = _make_client()
    conn = get_db()
    for date, qty in [("2026-07-22", 10), ("2026-07-15", 10), ("2026-07-08", 10), ("2026-07-01", 10)]:
        ensure_row(conn, date, "YUSAS00001")
        conn.execute(
            "UPDATE order_recommendation_daily SET sales_qty = ? WHERE date = ? AND yusas_code = ?",
            (qty, date, "YUSAS00001"),
        )
    ensure_row(conn, "2026-07-29", "YUSAS00001")
    conn.execute(
        "UPDATE order_recommendation_daily SET stock_qty = 0, incoming_qty = 0 "
        "WHERE date = ? AND yusas_code = ?",
        ("2026-07-29", "YUSAS00001"),
    )
    conn.commit()
    conn.close()

    res = client.post("/order-recommendation/compute", params={"date": "2026-07-29"})
    assert res.status_code == 200
    assert res.json()["computed"] == 1

    res2 = client.get("/order-recommendation/daily", params={"date": "2026-07-29"})
    row = res2.json()["items"][0]
    assert row["recommended_qty"] == 10


def test_collect_endpoint_invokes_registered_collectors():
    client, get_db, _keep_alive = _make_client()
    try:
        async def fake_collector(date):
            return {"YUSAS00001": 42}

        collect_mod.register_collector("sales_qty", fake_collector)

        res = client.post("/order-recommendation/collect", params={"date": "2026-07-29"})
        assert res.status_code == 200
        assert res.json()["updated_codes"] == ["YUSAS00001"]

        res2 = client.get("/order-recommendation/daily", params={"date": "2026-07-29"})
        assert res2.json()["items"][0]["sales_qty"] == 42
    finally:
        collect_mod.COLLECTORS.clear()


def test_collect_endpoint_defaults_to_empty_when_no_collectors_registered():
    client, _get_db, _keep_alive = _make_client()
    collect_mod.COLLECTORS.clear()
    res = client.post("/order-recommendation/collect", params={"date": "2026-07-29"})
    assert res.status_code == 200
    assert res.json()["updated_codes"] == []


def test_evaluate_endpoint_fills_forecast_accuracy_columns():
    client, get_db, _keep_alive = _make_client()
    conn = get_db()
    date = today_kst()
    ensure_row(conn, date, "YUSAS00001")
    conn.execute(
        "UPDATE order_recommendation_daily SET expected_sales_today = 12, sales_qty = 10 "
        "WHERE date = ? AND yusas_code = ?",
        (date, "YUSAS00001"),
    )
    conn.commit()
    conn.close()

    res = client.post("/order-recommendation/evaluate", params={"date": date})
    assert res.status_code == 200
    assert res.json()["evaluated"] == 1

    res2 = client.get("/order-recommendation/daily", params={"date": date})
    row = res2.json()["items"][0]
    assert row["forecast_error"] == 2.0


def test_forecast_accuracy_endpoint_returns_aggregate_metrics():
    client, get_db, _keep_alive = _make_client()
    conn = get_db()
    date = today_kst()
    ensure_row(conn, date, "YUSAS00001")
    conn.execute(
        "UPDATE order_recommendation_daily SET expected_sales_today = 12, sales_qty = 10 "
        "WHERE date = ? AND yusas_code = ?",
        (date, "YUSAS00001"),
    )
    conn.commit()
    conn.close()
    client.post("/order-recommendation/evaluate", params={"date": date})

    res = client.get("/order-recommendation/forecast-accuracy", params={"days": 7})
    assert res.status_code == 200
    body = res.json()
    assert body["sample_count"] == 1
    assert body["mae"] == pytest.approx(2.0)


def test_evaluate_order_performance_endpoint_fills_deviation_columns():
    client, get_db, _keep_alive = _make_client()
    conn = get_db()
    date = today_kst()
    ensure_row(conn, date, "YUSAS00001")
    conn.execute(
        "UPDATE order_recommendation_daily SET recommended_qty = 10, confirmed_qty = 12 "
        "WHERE date = ? AND yusas_code = ?",
        (date, "YUSAS00001"),
    )
    conn.commit()
    conn.close()

    res = client.post("/order-recommendation/evaluate-order-performance", params={"date": date})
    assert res.status_code == 200
    assert res.json()["evaluated"] == 1

    res2 = client.get("/order-recommendation/daily", params={"date": date})
    row = res2.json()["items"][0]
    assert row["confirm_deviation"] == 2


def test_order_performance_endpoint_returns_aggregate_metrics():
    client, get_db, _keep_alive = _make_client()
    conn = get_db()
    date = today_kst()
    ensure_row(conn, date, "YUSAS00001")
    conn.execute(
        "UPDATE order_recommendation_daily SET recommended_qty = 10, confirmed_qty = 12 "
        "WHERE date = ? AND yusas_code = ?",
        (date, "YUSAS00001"),
    )
    conn.commit()
    conn.close()
    client.post("/order-recommendation/evaluate-order-performance", params={"date": date})

    res = client.get("/order-recommendation/order-performance", params={"days": 7})
    assert res.status_code == 200
    body = res.json()
    assert body["sample_count"] == 1
    assert body["avg_confirm_deviation"] == pytest.approx(2.0)


def test_collect_endpoint_returns_need_session_when_ezadmin_session_expired():
    client, _get_db, _keep_alive = _make_client()
    try:
        async def failing_collector(date):
            raise EzAdminSessionExpired()

        collect_mod.register_collector("stock_qty", failing_collector)

        res = client.post("/order-recommendation/collect", params={"date": "2026-07-29"})
        assert res.status_code == 200
        assert res.json() == {"ok": False, "need_session": True}
    finally:
        collect_mod.COLLECTORS.clear()
