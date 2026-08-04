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
            actual_received_qty INTEGER,
            ezadmin_lack_qty INTEGER,
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
            incoming_qty_change INTEGER,
            incoming_qty_change_rate REAL,

            sales_7d INTEGER,
            sales_14d INTEGER,
            avg_sales_7d REAL,
            avg_sales_14d REAL,
            weekday_average_sales REAL,
            expected_sales_today REAL,

            model_version TEXT,
            model_weight_weekday REAL,
            model_weight_previous_day REAL,
            model_weight_avg_7d REAL,
            model_weight_avg_14d REAL,

            recommended_qty INTEGER,

            forecast_error REAL,
            absolute_error REAL,
            within_20_percent INTEGER,
            evaluated_at TEXT,

            confirm_deviation INTEGER,
            fulfillment_gap INTEGER,
            order_performance_evaluated_at TEXT,

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
    _ensure_forecast_accuracy_columns(conn)
    _ensure_order_performance_columns(conn)
    _ensure_ezadmin_columns(conn)
    _ensure_avg_sales_3d_columns(conn)
    _ensure_registered_at_column(conn)
    _ensure_coverage_days_used_column(conn)
    conn.commit()
    conn.close()


def _ensure_avg_sales_14d_column(conn) -> None:
    cols = [r["name"] for r in conn.execute("PRAGMA table_info(order_recommendation_daily)").fetchall()]
    if "avg_sales_14d" not in cols:
        conn.execute("ALTER TABLE order_recommendation_daily ADD COLUMN avg_sales_14d REAL")


_FORECAST_ACCURACY_COLUMNS = [
    ("model_version", "TEXT"),
    ("model_weight_weekday", "REAL"),
    ("model_weight_previous_day", "REAL"),
    ("model_weight_avg_7d", "REAL"),
    ("model_weight_avg_14d", "REAL"),
    ("forecast_error", "REAL"),
    ("absolute_error", "REAL"),
    ("within_20_percent", "INTEGER"),
    ("evaluated_at", "TEXT"),
    # expected_sales_today는 date+ORDER_LEAD_DAYS(발주 리드타임 이후 첫날)의 예측이라
    # date 자신의 sales_qty와는 다른 날짜의 실제값과 비교된다. 그 실제값을 그대로
    # 저장해둬야 집계(WAPE 등)에서 올바른 분모를 쓸 수 있다.
    ("evaluated_actual_qty", "INTEGER"),
]


def _ensure_forecast_accuracy_columns(conn) -> None:
    cols = [r["name"] for r in conn.execute("PRAGMA table_info(order_recommendation_daily)").fetchall()]
    for column, ddl_type in _FORECAST_ACCURACY_COLUMNS:
        if column not in cols:
            conn.execute(f"ALTER TABLE order_recommendation_daily ADD COLUMN {column} {ddl_type}")


_ORDER_PERFORMANCE_COLUMNS = [
    ("actual_received_qty", "INTEGER"),
    ("incoming_qty_change", "INTEGER"),
    ("incoming_qty_change_rate", "REAL"),
    ("confirm_deviation", "INTEGER"),
    ("fulfillment_gap", "INTEGER"),
    ("order_performance_evaluated_at", "TEXT"),
]


def _ensure_order_performance_columns(conn) -> None:
    cols = [r["name"] for r in conn.execute("PRAGMA table_info(order_recommendation_daily)").fetchall()]
    for column, ddl_type in _ORDER_PERFORMANCE_COLUMNS:
        if column not in cols:
            conn.execute(f"ALTER TABLE order_recommendation_daily ADD COLUMN {column} {ddl_type}")


_EZADMIN_COLUMNS = [
    ("ezadmin_lack_qty", "INTEGER"),
]


def _ensure_ezadmin_columns(conn) -> None:
    cols = [r["name"] for r in conn.execute("PRAGMA table_info(order_recommendation_daily)").fetchall()]
    for column, ddl_type in _EZADMIN_COLUMNS:
        if column not in cols:
            conn.execute(f"ALTER TABLE order_recommendation_daily ADD COLUMN {column} {ddl_type}")


_AVG_SALES_3D_COLUMNS = [
    ("sales_3d", "INTEGER"),
    ("avg_sales_3d", "REAL"),
    ("model_weight_avg_3d", "REAL"),
]


def _ensure_avg_sales_3d_columns(conn) -> None:
    cols = [r["name"] for r in conn.execute("PRAGMA table_info(order_recommendation_daily)").fetchall()]
    for column, ddl_type in _AVG_SALES_3D_COLUMNS:
        if column not in cols:
            conn.execute(f"ALTER TABLE order_recommendation_daily ADD COLUMN {column} {ddl_type}")


def _ensure_registered_at_column(conn) -> None:
    """상품 등록일("YYYY-MM-DD"). wonbe DB는 별도 파일이라 집계 쿼리에서 매번
    크로스 레퍼런스할 수 없으므로, 이 테이블에 직접 박아넣어 SQL로 바로 필터링한다."""
    cols = [r["name"] for r in conn.execute("PRAGMA table_info(order_recommendation_daily)").fetchall()]
    if "registered_at" not in cols:
        conn.execute("ALTER TABLE order_recommendation_daily ADD COLUMN registered_at TEXT")


def _ensure_coverage_days_used_column(conn) -> None:
    """그날 발주추천 계산에 실제로 쓰인 커버리지(며칠치)를 스냅샷으로 남긴다.
    예상판매량 구간별 자동계산 결과라서 나중에 값이 바뀌어도 그날 실제 쓰인 값을 추적 가능."""
    cols = [r["name"] for r in conn.execute("PRAGMA table_info(order_recommendation_daily)").fetchall()]
    if "coverage_days_used" not in cols:
        conn.execute("ALTER TABLE order_recommendation_daily ADD COLUMN coverage_days_used REAL")


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
