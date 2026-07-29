import sqlite3
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.order_recommendation_store import (
    ensure_row,
    get_row,
    init_order_recommendation_tables,
    list_rows,
    now_kst_iso,
    previous_date,
    today_kst,
)


def _make_db_factory():
    uri = f"file:test_order_recommendation_store_{uuid.uuid4().hex}?mode=memory&cache=shared"
    keep_alive = sqlite3.connect(uri, uri=True)
    keep_alive.row_factory = sqlite3.Row

    def factory():
        conn = sqlite3.connect(uri, uri=True)
        conn.row_factory = sqlite3.Row
        return conn

    return factory, keep_alive


EXPECTED_COLUMNS = {
    "date", "yusas_code", "day_of_week",
    "sales_qty", "stock_qty", "incoming_qty", "previous_day_sales_qty",
    "ad_budget", "wish_count", "cart_count",
    "ad_budget_change", "ad_budget_change_rate",
    "wish_count_change", "wish_count_change_rate",
    "cart_count_change", "cart_count_change_rate",
    "sales_7d", "sales_14d", "avg_sales_7d",
    "weekday_average_sales", "previous_day_sales_ratio", "expected_sales_today",
    "recommended_qty",
    "confirmed_qty", "override_reason", "updated_by", "updated_at",
    "excluded_from_avg", "created_at",
}


def test_init_creates_table_with_expected_columns():
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    conn = get_db()
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(order_recommendation_daily)").fetchall()}
    assert cols == EXPECTED_COLUMNS
    conn.close()


def test_ensure_row_creates_row_with_day_of_week_and_created_at():
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    conn = get_db()
    ensure_row(conn, "2026-07-29", "YUSAS00001")
    conn.commit()

    row = get_row(conn, "2026-07-29", "YUSAS00001")
    assert row["day_of_week"] == 2  # 2026-07-29는 수요일
    assert row["created_at"] is not None
    assert row["created_at"].endswith("+09:00")
    assert row["sales_qty"] is None
    conn.close()


def test_ensure_row_is_idempotent_and_preserves_existing_values():
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    conn = get_db()
    ensure_row(conn, "2026-07-29", "YUSAS00001")
    conn.commit()
    conn.execute(
        "UPDATE order_recommendation_daily SET sales_qty = 5 WHERE date = ? AND yusas_code = ?",
        ("2026-07-29", "YUSAS00001"),
    )
    conn.commit()

    ensure_row(conn, "2026-07-29", "YUSAS00001")
    conn.commit()

    row = get_row(conn, "2026-07-29", "YUSAS00001")
    assert row["sales_qty"] == 5
    conn.close()


def test_list_rows_returns_all_rows_for_date_ordered_by_code():
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    conn = get_db()
    ensure_row(conn, "2026-07-29", "YUSAS00002")
    ensure_row(conn, "2026-07-29", "YUSAS00001")
    conn.commit()

    rows = list_rows(conn, "2026-07-29")
    assert [r["yusas_code"] for r in rows] == ["YUSAS00001", "YUSAS00002"]
    conn.close()


def test_previous_date_handles_month_rollover():
    assert previous_date("2026-08-01") == "2026-07-31"


def test_today_kst_returns_iso_date_format():
    assert len(today_kst()) == 10
    assert today_kst()[4] == "-" and today_kst()[7] == "-"


def test_now_kst_iso_includes_seoul_offset():
    assert now_kst_iso().endswith("+09:00")
