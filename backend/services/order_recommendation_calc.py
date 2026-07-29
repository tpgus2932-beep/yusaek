from __future__ import annotations

import math
from datetime import datetime, timedelta

from services.order_recommendation_store import get_row, previous_date

WEEKDAY_LOOKBACK_WEEKS = 8
WEEKDAY_MIN_WEEKS = 4
FALLBACK_WINDOW_DAYS = 14
RATIO_MIN = 0.5
RATIO_MAX = 2.0


def _date_minus(date: str, days: int) -> str:
    return (datetime.strptime(date, "%Y-%m-%d") - timedelta(days=days)).strftime("%Y-%m-%d")


def calc_sales_window(conn, yusas_code: str, date: str, days: int):
    start = _date_minus(date, days)
    rows = conn.execute(
        """
        SELECT sales_qty FROM order_recommendation_daily
        WHERE yusas_code = ? AND date >= ? AND date < ? AND sales_qty IS NOT NULL
        """,
        (yusas_code, start, date),
    ).fetchall()
    values = [r["sales_qty"] for r in rows]
    if not values:
        return None, 0
    return sum(values), len(values)


def calc_weekday_average_sales(conn, yusas_code: str, as_of_date: str):
    candidates = []
    for week in range(1, WEEKDAY_LOOKBACK_WEEKS + 1):
        candidate_date = _date_minus(as_of_date, week * 7)
        row = conn.execute(
            """
            SELECT sales_qty FROM order_recommendation_daily
            WHERE yusas_code = ? AND date = ? AND excluded_from_avg = 0 AND sales_qty IS NOT NULL
            """,
            (yusas_code, candidate_date),
        ).fetchone()
        if row is not None:
            candidates.append(row["sales_qty"])

    if len(candidates) >= WEEKDAY_MIN_WEEKS:
        return sum(candidates) / len(candidates)

    start = _date_minus(as_of_date, FALLBACK_WINDOW_DAYS)
    rows = conn.execute(
        """
        SELECT sales_qty FROM order_recommendation_daily
        WHERE yusas_code = ? AND date >= ? AND date < ? AND excluded_from_avg = 0 AND sales_qty IS NOT NULL
        """,
        (yusas_code, start, as_of_date),
    ).fetchall()
    values = [r["sales_qty"] for r in rows]
    if not values:
        return None
    return sum(values) / len(values)


def calc_previous_day_sales_ratio(conn, yusas_code: str, date: str, previous_day_sales_qty):
    prev_date = previous_date(date)
    prev_row = get_row(conn, prev_date, yusas_code)
    if prev_row is None:
        return 1.0

    prev_avg = prev_row["weekday_average_sales"]
    if prev_avg is None:
        prev_avg = calc_weekday_average_sales(conn, yusas_code, prev_date)

    if not prev_avg or previous_day_sales_qty is None:
        return 1.0

    ratio = previous_day_sales_qty / prev_avg
    return max(RATIO_MIN, min(RATIO_MAX, ratio))


def calc_expected_sales_today(weekday_average_sales, previous_day_sales_ratio: float, blend_ratio: float):
    if weekday_average_sales is None:
        return None
    flow_adjustment = 1 + (previous_day_sales_ratio - 1) * blend_ratio
    return weekday_average_sales * flow_adjustment


def calc_recommended_qty(expected_sales_today, stock_qty, incoming_qty, coverage_days: float, safety_stock_qty: float):
    if expected_sales_today is None or stock_qty is None or incoming_qty is None:
        return None
    target_sales = expected_sales_today * coverage_days
    return max(0, math.ceil(target_sales + safety_stock_qty) - stock_qty - incoming_qty)
