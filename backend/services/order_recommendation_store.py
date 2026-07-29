from __future__ import annotations

from datetime import datetime, timedelta, timezone

_KST = timezone(timedelta(hours=9))


def today_kst() -> str:
    return datetime.now(_KST).strftime("%Y-%m-%d")


def now_kst_iso() -> str:
    return datetime.now(_KST).isoformat()


def previous_date(date: str) -> str:
    d = datetime.strptime(date, "%Y-%m-%d") - timedelta(days=1)
    return d.strftime("%Y-%m-%d")


def init_order_recommendation_tables(get_db) -> None:
    conn = get_db()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS order_recommendation_daily (
            date TEXT NOT NULL,
            yusas_code TEXT NOT NULL,
            day_of_week INTEGER,

            sales_qty INTEGER,
            stock_qty INTEGER,
            incoming_qty INTEGER,
            previous_day_sales_qty INTEGER,
            ad_budget INTEGER,
            wish_count INTEGER,
            cart_count INTEGER,

            ad_budget_change INTEGER,
            ad_budget_change_rate REAL,
            wish_count_change INTEGER,
            wish_count_change_rate REAL,
            cart_count_change INTEGER,
            cart_count_change_rate REAL,

            sales_7d INTEGER,
            sales_14d INTEGER,
            avg_sales_7d REAL,
            avg_sales_14d REAL,
            weekday_average_sales REAL,
            expected_sales_today REAL,

            recommended_qty INTEGER,

            confirmed_qty INTEGER,
            override_reason TEXT,
            updated_by TEXT,
            updated_at TEXT,

            excluded_from_avg INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,

            PRIMARY KEY (date, yusas_code)
        )
        """
    )
    _ensure_avg_sales_14d_column(conn)
    conn.commit()
    conn.close()


def _ensure_avg_sales_14d_column(conn) -> None:
    cols = [r["name"] for r in conn.execute("PRAGMA table_info(order_recommendation_daily)").fetchall()]
    if "avg_sales_14d" not in cols:
        conn.execute("ALTER TABLE order_recommendation_daily ADD COLUMN avg_sales_14d REAL")


def get_row(conn, date: str, yusas_code: str):
    return conn.execute(
        "SELECT * FROM order_recommendation_daily WHERE date = ? AND yusas_code = ?",
        (date, yusas_code),
    ).fetchone()


def list_rows(conn, date: str):
    return conn.execute(
        "SELECT * FROM order_recommendation_daily WHERE date = ? ORDER BY yusas_code",
        (date,),
    ).fetchall()


def ensure_row(conn, date: str, yusas_code: str) -> None:
    day_of_week = datetime.strptime(date, "%Y-%m-%d").weekday()
    conn.execute(
        """
        INSERT INTO order_recommendation_daily (date, yusas_code, day_of_week, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(date, yusas_code) DO NOTHING
        """,
        (date, yusas_code, day_of_week, now_kst_iso()),
    )
