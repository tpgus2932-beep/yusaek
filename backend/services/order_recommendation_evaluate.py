from __future__ import annotations

from datetime import datetime, timedelta

from services.order_recommendation_calc import ORDER_LEAD_DAYS
from services.order_recommendation_store import get_row, now_kst_iso, today_kst

WITHIN_PERCENT_THRESHOLD = 0.20


def _date_minus(date: str, days: int) -> str:
    return (datetime.strptime(date, "%Y-%m-%d") - timedelta(days=days)).strftime("%Y-%m-%d")


def _date_plus(date: str, days: int) -> str:
    return (datetime.strptime(date, "%Y-%m-%d") + timedelta(days=days)).strftime("%Y-%m-%d")


def calc_forecast_error(expected_sales_today, actual_order_qty):
    if expected_sales_today is None or actual_order_qty is None:
        return None
    return expected_sales_today - actual_order_qty


def calc_within_20_percent(absolute_error, actual_order_qty):
    if absolute_error is None or actual_order_qty is None or actual_order_qty == 0:
        return None
    return 1 if absolute_error <= actual_order_qty * WITHIN_PERCENT_THRESHOLD else 0


def evaluate_row(conn, yusas_code: str, date: str) -> None:
    """date 행의 expected_sales_today는 date+ORDER_LEAD_DAYS(발주가 실제로 커버하는 날)의
    예측이므로, 그 날의 실제 판매량과 비교해야 한다 — date 자신의 sales_qty가 아니다."""
    row = get_row(conn, date, yusas_code)
    if row is None:
        return

    target_date = _date_plus(date, ORDER_LEAD_DAYS)
    target_row = get_row(conn, target_date, yusas_code)
    actual_order_qty = target_row["sales_qty"] if target_row is not None else None
    forecast_error = calc_forecast_error(row["expected_sales_today"], actual_order_qty)
    absolute_error = abs(forecast_error) if forecast_error is not None else None
    within_20_percent = calc_within_20_percent(absolute_error, actual_order_qty)

    conn.execute(
        """
        UPDATE order_recommendation_daily SET
            forecast_error = ?, absolute_error = ?, within_20_percent = ?,
            evaluated_actual_qty = ?, evaluated_at = ?
        WHERE date = ? AND yusas_code = ?
        """,
        (forecast_error, absolute_error, within_20_percent, actual_order_qty, now_kst_iso(), date, yusas_code),
    )
    conn.commit()


def evaluate_all(get_db, date: str) -> int:
    conn = get_db()
    try:
        codes = [
            r["yusas_code"]
            for r in conn.execute(
                "SELECT yusas_code FROM order_recommendation_daily WHERE date = ?", (date,)
            ).fetchall()
        ]
        for code in codes:
            evaluate_row(conn, code, date)
        return len(codes)
    finally:
        conn.close()


def aggregate_forecast_accuracy(conn, days: int, yusas_code: str | None = None) -> dict:
    start_date = _date_minus(today_kst(), days)
    query = (
        "SELECT absolute_error, evaluated_actual_qty, within_20_percent FROM order_recommendation_daily "
        "WHERE date >= ? AND evaluated_at IS NOT NULL"
    )
    params: list = [start_date]
    if yusas_code is not None:
        query += " AND yusas_code = ?"
        params.append(yusas_code)
    rows = conn.execute(query, params).fetchall()

    sample_count = len(rows)
    abs_errors = [r["absolute_error"] for r in rows if r["absolute_error"] is not None]
    # evaluated_actual_qty = date+ORDER_LEAD_DAYS(예측이 실제로 겨냥한 날)의 실제 판매량.
    # date 자신의 sales_qty가 아니다 — evaluate_row 저장 시점 값을 그대로 재사용한다.
    actuals_for_mae = [r["evaluated_actual_qty"] for r in rows if r["absolute_error"] is not None]
    hit_flags = [r["within_20_percent"] for r in rows if r["within_20_percent"] is not None]

    mae = sum(abs_errors) / len(abs_errors) if abs_errors else None
    actual_sum = sum(actuals_for_mae)
    wape = (sum(abs_errors) / actual_sum) if abs_errors and actual_sum > 0 else None
    hit_rate_20pct = (sum(hit_flags) / len(hit_flags)) if hit_flags else None

    return {
        "sample_count": sample_count,
        "mae": mae,
        "wape": wape,
        "hit_rate_20pct": hit_rate_20pct,
    }
