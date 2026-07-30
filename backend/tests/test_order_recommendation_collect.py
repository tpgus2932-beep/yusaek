import asyncio
import sqlite3
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import services.order_recommendation_collect as collect_mod
from services.order_recommendation_collect import (
    ALLOWED_COLLECTOR_COLUMNS,
    register_collector,
    run_collectors,
)
from services.order_recommendation_store import get_row, init_order_recommendation_tables, list_rows


def _make_db_factory():
    uri = f"file:test_order_recommendation_collect_{uuid.uuid4().hex}?mode=memory&cache=shared"
    keep_alive = sqlite3.connect(uri, uri=True)
    keep_alive.row_factory = sqlite3.Row

    def factory():
        conn = sqlite3.connect(uri, uri=True)
        conn.row_factory = sqlite3.Row
        return conn

    return factory, keep_alive


def _reset_collectors():
    collect_mod.COLLECTORS.clear()


def test_register_collector_rejects_column_not_in_whitelist():
    _reset_collectors()
    try:
        raised = False
        try:
            register_collector("recommended_qty", lambda date: None)
        except ValueError:
            raised = True
        assert raised
    finally:
        _reset_collectors()


def test_register_collector_allows_whitelisted_column():
    _reset_collectors()
    try:
        async def fake(date):
            return {}

        register_collector("stock_qty", fake)
        assert "stock_qty" in collect_mod.COLLECTORS
        assert ALLOWED_COLLECTOR_COLUMNS == {
            "sales_qty", "stock_qty", "incoming_qty", "actual_received_qty",
            "ad_budget", "wish_count", "cart_count",
        }
    finally:
        _reset_collectors()


def test_run_collectors_upserts_only_returned_columns_and_creates_rows():
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    _reset_collectors()
    try:
        async def sales_collector(date):
            return {"YUSAS00001": 5}

        async def stock_collector(date):
            return {"YUSAS00001": 20, "YUSAS00002": 7}

        register_collector("sales_qty", sales_collector)
        register_collector("stock_qty", stock_collector)

        merged = asyncio.run(run_collectors(get_db, "2026-07-29"))
        assert merged == {"YUSAS00001": {"sales_qty": 5, "stock_qty": 20}, "YUSAS00002": {"stock_qty": 7}}

        conn = get_db()
        row1 = get_row(conn, "2026-07-29", "YUSAS00001")
        assert row1["sales_qty"] == 5
        assert row1["stock_qty"] == 20
        assert row1["incoming_qty"] is None
        assert row1["day_of_week"] == 2
        assert row1["created_at"] is not None

        row2 = get_row(conn, "2026-07-29", "YUSAS00002")
        assert row2["stock_qty"] == 7
        assert row2["sales_qty"] is None
        conn.close()
    finally:
        _reset_collectors()


def test_run_collectors_preserves_columns_not_returned_by_any_collector():
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    _reset_collectors()
    try:
        conn = get_db()
        conn.execute(
            "INSERT INTO order_recommendation_daily (date, yusas_code, day_of_week, ad_budget, created_at) "
            "VALUES (?, ?, ?, ?, ?)",
            ("2026-07-29", "YUSAS00001", 2, 100, "2026-07-29T00:00:00+09:00"),
        )
        conn.commit()
        conn.close()

        async def sales_collector(date):
            return {"YUSAS00001": 5}

        register_collector("sales_qty", sales_collector)
        asyncio.run(run_collectors(get_db, "2026-07-29"))

        conn = get_db()
        row = get_row(conn, "2026-07-29", "YUSAS00001")
        assert row["sales_qty"] == 5
        assert row["ad_budget"] == 100
        conn.close()
    finally:
        _reset_collectors()


def test_run_collectors_writes_nothing_when_a_collector_raises():
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    _reset_collectors()
    try:
        async def ok_collector(date):
            return {"YUSAS00001": 5}

        async def failing_collector(date):
            raise RuntimeError("marketplace API down")

        register_collector("sales_qty", ok_collector)
        register_collector("stock_qty", failing_collector)

        raised = False
        try:
            asyncio.run(run_collectors(get_db, "2026-07-29"))
        except RuntimeError:
            raised = True
        assert raised

        conn = get_db()
        assert list_rows(conn, "2026-07-29") == []
        conn.close()
    finally:
        _reset_collectors()
