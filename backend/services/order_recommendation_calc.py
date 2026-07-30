from __future__ import annotations

import math
from datetime import datetime, timedelta

from services.order_recommendation_store import get_row, previous_date

WEEKDAY_LOOKBACK_WEEKS = 4
WEEKDAY_MIN_WEEKS = 4
FALLBACK_WINDOW_DAYS = 14


def _date_minus(date: str, days: int) -> str:
    return (datetime.strptime(date, "%Y-%m-%d") - timedelta(days=days)).strftime("%Y-%m-%d")


def _date_plus(date: str, days: int) -> str:
    return (datetime.strptime(date, "%Y-%m-%d") + timedelta(days=days)).strftime("%Y-%m-%d")


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


DEFAULT_WEIGHT_WEEKDAY_AVERAGE = 0.35
DEFAULT_WEIGHT_PREVIOUS_DAY = 0.25
DEFAULT_WEIGHT_AVG_7D = 0.25
DEFAULT_WEIGHT_AVG_14D = 0.15

MODEL_VERSION = "weighted_v1"


def calc_expected_sales_today(
    weekday_average_sales,
    previous_day_sales_qty,
    avg_sales_7d,
    avg_sales_14d,
    weight_weekday_average: float,
    weight_previous_day: float,
    weight_avg_7d: float,
    weight_avg_14d: float,
):
    weighted_sum = 0.0
    weight_sum = 0.0
    for value, weight in (
        (weekday_average_sales, weight_weekday_average),
        (previous_day_sales_qty, weight_previous_day),
        (avg_sales_7d, weight_avg_7d),
        (avg_sales_14d, weight_avg_14d),
    ):
        if value is not None:
            weighted_sum += value * weight
            weight_sum += weight
    if weight_sum == 0:
        return None
    return weighted_sum / weight_sum


def calc_expected_sales_for_coverage(
    conn,
    yusas_code: str,
    date: str,
    coverage_days: float,
    previous_day_sales_qty,
    avg_sales_7d,
    avg_sales_14d,
    weight_weekday_average: float,
    weight_previous_day: float,
    weight_avg_7d: float,
    weight_avg_14d: float,
):
    """date부터 coverage_days일치(포함, round()로 정수화) 각 날짜를 따로 예측해서 합산한다.

    날짜마다 weekday_average_sales만 그 날짜 자신의 요일평균으로 새로 계산하고,
    previous_day_sales_qty/avg_sales_7d/avg_sales_14d는 date(오늘) 시점 기준값을
    그대로 재사용한다 — 미래 시점의 실제 최근 추세는 알 수 없기 때문."""
    num_days = round(coverage_days)
    if num_days <= 0:
        return None

    total = 0.0
    any_value = False
    for offset in range(num_days):
        target_date = _date_plus(date, offset)
        weekday_average_sales = calc_weekday_average_sales(conn, yusas_code, target_date)
        daily_expected = calc_expected_sales_today(
            weekday_average_sales, previous_day_sales_qty, avg_sales_7d, avg_sales_14d,
            weight_weekday_average, weight_previous_day, weight_avg_7d, weight_avg_14d,
        )
        if daily_expected is not None:
            total += daily_expected
            any_value = True

    return total if any_value else None


def calc_recommended_qty(coverage_period_expected_sales, stock_qty, incoming_qty, safety_stock_qty: float):
    if coverage_period_expected_sales is None or stock_qty is None or incoming_qty is None:
        return None
    return max(0, math.ceil(coverage_period_expected_sales + safety_stock_qty) - stock_qty - incoming_qty)


def calc_change_and_rate(today_value, previous_value):
    if today_value is None or previous_value is None:
        return None, None
    change = today_value - previous_value
    if previous_value == 0:
        return change, None
    return change, change / previous_value


DEFAULT_COVERAGE_DAYS = 1.0
DEFAULT_SAFETY_STOCK_QTY = 0.0


def _setting_float(get_setting, key: str, default: float) -> float:
    raw = get_setting(key)
    if raw is None or str(raw).strip() == "":
        return default
    return float(raw)


def _setting_weight(get_setting, key: str, default: float) -> float:
    raw = get_setting(key)
    if raw is None or str(raw).strip() == "":
        return default
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return default
    if not math.isfinite(value) or value < 0:
        return default
    return value


def compute_row(conn, yusas_code: str, date: str, get_setting) -> None:
    row = get_row(conn, date, yusas_code)
    if row is None:
        return

    prev_date_str = previous_date(date)
    prev_row = get_row(conn, prev_date_str, yusas_code)
    previous_day_sales_qty = prev_row["sales_qty"] if prev_row is not None else None

    sales_7d, count_7d = calc_sales_window(conn, yusas_code, date, 7)
    sales_14d, count_14d = calc_sales_window(conn, yusas_code, date, 14)
    avg_sales_7d = (sales_7d / count_7d) if sales_7d is not None and count_7d else None
    avg_sales_14d = (sales_14d / count_14d) if sales_14d is not None and count_14d else None

    weekday_average_sales = calc_weekday_average_sales(conn, yusas_code, date)

    weight_weekday_average = _setting_weight(
        get_setting, "order_recommendation_weight_weekday_average", DEFAULT_WEIGHT_WEEKDAY_AVERAGE
    )
    weight_previous_day = _setting_weight(
        get_setting, "order_recommendation_weight_previous_day", DEFAULT_WEIGHT_PREVIOUS_DAY
    )
    weight_avg_7d = _setting_weight(get_setting, "order_recommendation_weight_avg_7d", DEFAULT_WEIGHT_AVG_7D)
    weight_avg_14d = _setting_weight(get_setting, "order_recommendation_weight_avg_14d", DEFAULT_WEIGHT_AVG_14D)

    coverage_days = _setting_float(get_setting, "order_recommendation_coverage_days", DEFAULT_COVERAGE_DAYS)
    safety_stock_qty = _setting_float(get_setting, "order_recommendation_safety_stock_qty", DEFAULT_SAFETY_STOCK_QTY)

    expected_sales_today = calc_expected_sales_today(
        weekday_average_sales, previous_day_sales_qty, avg_sales_7d, avg_sales_14d,
        weight_weekday_average, weight_previous_day, weight_avg_7d, weight_avg_14d,
    )
    coverage_period_expected_sales = calc_expected_sales_for_coverage(
        conn, yusas_code, date, coverage_days,
        previous_day_sales_qty, avg_sales_7d, avg_sales_14d,
        weight_weekday_average, weight_previous_day, weight_avg_7d, weight_avg_14d,
    )
    recommended_qty = calc_recommended_qty(
        coverage_period_expected_sales, row["stock_qty"], row["incoming_qty"], safety_stock_qty
    )

    prev_ad_budget = prev_row["ad_budget"] if prev_row is not None else None
    prev_wish_count = prev_row["wish_count"] if prev_row is not None else None
    prev_cart_count = prev_row["cart_count"] if prev_row is not None else None
    ad_budget_change, ad_budget_change_rate = calc_change_and_rate(row["ad_budget"], prev_ad_budget)
    wish_count_change, wish_count_change_rate = calc_change_and_rate(row["wish_count"], prev_wish_count)
    cart_count_change, cart_count_change_rate = calc_change_and_rate(row["cart_count"], prev_cart_count)

    prev_incoming_qty = prev_row["incoming_qty"] if prev_row is not None else None
    incoming_qty_change, incoming_qty_change_rate = calc_change_and_rate(row["incoming_qty"], prev_incoming_qty)

    conn.execute(
        """
        UPDATE order_recommendation_daily SET
            previous_day_sales_qty = ?,
            sales_7d = ?, sales_14d = ?, avg_sales_7d = ?, avg_sales_14d = ?,
            weekday_average_sales = ?, expected_sales_today = ?,
            model_version = ?, model_weight_weekday = ?, model_weight_previous_day = ?,
            model_weight_avg_7d = ?, model_weight_avg_14d = ?,
            recommended_qty = ?,
            ad_budget_change = ?, ad_budget_change_rate = ?,
            wish_count_change = ?, wish_count_change_rate = ?,
            cart_count_change = ?, cart_count_change_rate = ?,
            incoming_qty_change = ?, incoming_qty_change_rate = ?
        WHERE date = ? AND yusas_code = ?
        """,
        (
            previous_day_sales_qty,
            sales_7d, sales_14d, avg_sales_7d, avg_sales_14d,
            weekday_average_sales, expected_sales_today,
            MODEL_VERSION, weight_weekday_average, weight_previous_day,
            weight_avg_7d, weight_avg_14d,
            recommended_qty,
            ad_budget_change, ad_budget_change_rate,
            wish_count_change, wish_count_change_rate,
            cart_count_change, cart_count_change_rate,
            incoming_qty_change, incoming_qty_change_rate,
            date, yusas_code,
        ),
    )
    conn.commit()


def compute_all(get_db, date: str, get_setting) -> int:
    conn = get_db()
    try:
        codes = [
            r["yusas_code"]
            for r in conn.execute(
                "SELECT yusas_code FROM order_recommendation_daily WHERE date = ?", (date,)
            ).fetchall()
        ]
        for code in codes:
            compute_row(conn, code, date, get_setting)
        return len(codes)
    finally:
        conn.close()
