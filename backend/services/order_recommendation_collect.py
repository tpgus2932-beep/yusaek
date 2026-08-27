from __future__ import annotations

from services.order_recommendation_store import ensure_row, today_kst

ALLOWED_COLLECTOR_COLUMNS = {
    "sales_qty", "stock_qty", "incoming_qty", "actual_received_qty",
    "ezadmin_lack_qty", "ezadmin_real_lack_qty", "ad_budget", "wish_count", "cart_count",
}

# EZAdmin 재고 컬렉터(stock_qty/incoming_qty/ezadmin_lack_qty/ezadmin_real_lack_qty)가
# 재수집되면, 그 값에 의존하는 compute_row의 결과 컬럼도 전부 같이 비운다 — compute_row는
# stock_qty가 없는 행을 다시 계산하지 않으므로(order_recommendation_calc.py), 여기서
# 안 비우면 이번 수집에서 빠진(재고문제 해소된) 상품이 예전 추천값을 그대로 들고 있게 된다.
_EZADMIN_STOCK_COLUMNS = {"stock_qty", "incoming_qty", "ezadmin_lack_qty", "ezadmin_real_lack_qty"}
_DOWNSTREAM_COMPUTE_COLUMNS = [
    "previous_day_sales_qty", "sales_3d", "sales_7d", "sales_14d",
    "avg_sales_3d", "avg_sales_7d", "avg_sales_14d", "weekday_average_sales",
    "expected_sales_today",
    "model_version", "model_weight_weekday", "model_weight_previous_day",
    "model_weight_avg_7d", "model_weight_avg_14d", "model_weight_avg_3d",
    "coverage_days_used", "recommended_qty", "confirmed_qty",
    "ad_budget_change", "ad_budget_change_rate",
    "wish_count_change", "wish_count_change_rate",
    "cart_count_change", "cart_count_change_rate",
    "incoming_qty_change", "incoming_qty_change_rate",
]

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
        # 같은 날짜에 재수집하면 이번에 갱신하는 컬럼들을 먼저 전부 비운다 —
        # 안 그러면 이번 조회 결과에서 빠진(더 이상 부족/재고문제가 아니게 된)
        # 상품이 예전 값을 그대로 유지해서 조용히 낡은 데이터로 남는다.
        clear_columns = set(COLLECTORS.keys())
        if clear_columns & _EZADMIN_STOCK_COLUMNS:
            clear_columns |= set(_DOWNSTREAM_COMPUTE_COLUMNS)
        if clear_columns:
            clear_clause = ", ".join(f"{col} = NULL" for col in clear_columns)
            conn.execute(
                f"UPDATE order_recommendation_daily SET {clear_clause} WHERE date = ?",
                (target_date,),
            )

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
