from __future__ import annotations

from services.order_recommendation_store import ensure_row, today_kst

ALLOWED_COLLECTOR_COLUMNS = {
    "sales_qty", "stock_qty", "incoming_qty", "actual_received_qty",
    "ad_budget", "wish_count", "cart_count",
}

COLLECTORS: dict = {}


def register_collector(column: str, fn) -> None:
    if column not in ALLOWED_COLLECTOR_COLUMNS:
        raise ValueError(f"컬렉터는 화이트리스트 컬럼만 등록할 수 있습니다: {column}")
    COLLECTORS[column] = fn


async def run_collectors(get_db, date: str | None = None) -> dict:
    target_date = date or today_kst()

    results: dict = {}
    for column, collector in COLLECTORS.items():
        results[column] = await collector(target_date)

    merged: dict = {}
    for column, values in results.items():
        for yusas_code, value in values.items():
            merged.setdefault(yusas_code, {})[column] = value

    conn = get_db()
    try:
        for yusas_code, columns in merged.items():
            ensure_row(conn, target_date, yusas_code)
            set_clause = ", ".join(f"{col} = ?" for col in columns)
            params = list(columns.values()) + [target_date, yusas_code]
            conn.execute(
                f"UPDATE order_recommendation_daily SET {set_clause} WHERE date = ? AND yusas_code = ?",
                params,
            )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

    return merged
