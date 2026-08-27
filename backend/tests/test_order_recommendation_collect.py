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
            "ezadmin_lack_qty", "ezadmin_real_lack_qty", "ad_budget", "wish_count", "cart_count",
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


def test_run_collectors_clears_stale_values_missing_from_a_rerun():
    """같은 날짜에 재수집했을 때, 이번 조회 결과에 더 이상 안 잡히는(예: 재고가
    회복돼서 부족 리포트에서 빠진) 상품의 예전 값이 낡은 채로 남지 않고 비워져야 한다."""
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    _reset_collectors()
    try:
        first_snapshot = {"YUSAS00001": 20, "YUSAS00002": 7}

        async def stock_collector(date):
            return dict(current_snapshot)

        current_snapshot = first_snapshot
        register_collector("stock_qty", stock_collector)

        asyncio.run(run_collectors(get_db, "2026-07-29"))
        conn = get_db()
        assert get_row(conn, "2026-07-29", "YUSAS00001")["stock_qty"] == 20
        assert get_row(conn, "2026-07-29", "YUSAS00002")["stock_qty"] == 7
        conn.close()

        # 재수집 — YUSAS00002는 이번엔 결과에서 아예 빠짐(더 이상 부족 대상 아님)
        current_snapshot = {"YUSAS00001": 25}
        asyncio.run(run_collectors(get_db, "2026-07-29"))

        conn = get_db()
        assert get_row(conn, "2026-07-29", "YUSAS00001")["stock_qty"] == 25
        assert get_row(conn, "2026-07-29", "YUSAS00002")["stock_qty"] is None
        conn.close()
    finally:
        _reset_collectors()


def test_run_collectors_clears_downstream_compute_columns_when_ezadmin_stock_reruns():
    """stock_qty/incoming_qty/ezadmin_lack_qty 컬렉터가 재수집되면, 거기 의존하는
    expected_sales_today/recommended_qty/confirmed_qty 같은 compute_row 결과도
    같이 비워져야 한다 — 안 그러면 이번 수집에서 빠진 상품이 예전 추천값을
    그대로 들고 있어서 재고는 비었는데 추천량만 남는 뒤섞인 상태가 된다."""
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    _reset_collectors()
    try:
        conn = get_db()
        conn.execute(
            "INSERT INTO order_recommendation_daily "
            "(date, yusas_code, day_of_week, stock_qty, ezadmin_lack_qty, "
            " expected_sales_today, recommended_qty, confirmed_qty, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ("2026-07-29", "YUSAS00001", 2, 0, 3, 10.0, 12, 9, "2026-07-29T00:00:00+09:00"),
        )
        conn.commit()
        conn.close()

        async def stock_collector(date):
            return {}  # 이번 수집엔 이 상품이 아예 안 잡힘(재고문제 해소)

        register_collector("stock_qty", stock_collector)
        asyncio.run(run_collectors(get_db, "2026-07-29"))

        conn = get_db()
        row = get_row(conn, "2026-07-29", "YUSAS00001")
        assert row["stock_qty"] is None
        assert row["expected_sales_today"] is None
        assert row["recommended_qty"] is None
        assert row["confirmed_qty"] is None
        conn.close()
    finally:
        _reset_collectors()


def test_run_collectors_clear_does_not_touch_columns_without_a_registered_collector():
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
        asyncio.run(run_collectors(get_db, "2026-07-29"))  # 재수집해도 ad_budget은 그대로

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
