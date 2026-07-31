from __future__ import annotations

import math
from datetime import datetime, timedelta

from services.order_recommendation_store import get_row, previous_date

WEEKDAY_LOOKBACK_WEEKS = 3
WEEKDAY_MIN_WEEKS = 3
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


DEFAULT_WEIGHT_WEEKDAY_AVERAGE = 0.20
DEFAULT_WEIGHT_PREVIOUS_DAY = 0.25
DEFAULT_WEIGHT_AVG_7D = 0.20
DEFAULT_WEIGHT_AVG_14D = 0.15
DEFAULT_WEIGHT_AVG_3D = 0.20

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
    avg_sales_3d=None,
    weight_avg_3d: float = 0.0,
):
    weighted_sum = 0.0
    weight_sum = 0.0
    for value, weight in (
        (weekday_average_sales, weight_weekday_average),
        (previous_day_sales_qty, weight_previous_day),
        (avg_sales_7d, weight_avg_7d),
        (avg_sales_14d, weight_avg_14d),
        (avg_sales_3d, weight_avg_3d),
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
    avg_sales_3d=None,
    weight_avg_3d: float = 0.0,
):
    """date부터 coverage_days일치(포함, round()로 정수화) 각 날짜를 따로 예측해서 합산한다.

    날짜마다 weekday_average_sales만 그 날짜 자신의 요일평균으로 새로 계산하고,
    previous_day_sales_qty/avg_sales_7d/avg_sales_14d/avg_sales_3d는 date(오늘) 시점 기준값을
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
            avg_sales_3d, weight_avg_3d,
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


def calc_expected_sales_today_for_date(
    conn, yusas_code: str, date: str, get_setting, weight_overrides: dict | None = None
) -> dict:
    """date 기준으로 그 이전 데이터만 사용해 예상판매량을 계산한다.
    compute_row와 백테스트가 공유하는 순수 계산 함수 — DB에 아무것도 쓰지 않는다.

    weight_overrides에 값이 있으면(0.0 포함) 설정값 대신 그 값을 쓴다(백테스트 미리보기용)."""
    prev_date_str = previous_date(date)
    prev_row = get_row(conn, prev_date_str, yusas_code)
    previous_day_sales_qty = prev_row["sales_qty"] if prev_row is not None else None

    sales_3d, count_3d = calc_sales_window(conn, yusas_code, date, 3)
    sales_7d, count_7d = calc_sales_window(conn, yusas_code, date, 7)
    sales_14d, count_14d = calc_sales_window(conn, yusas_code, date, 14)
    avg_sales_3d = (sales_3d / count_3d) if sales_3d is not None and count_3d else None
    avg_sales_7d = (sales_7d / count_7d) if sales_7d is not None and count_7d else None
    avg_sales_14d = (sales_14d / count_14d) if sales_14d is not None and count_14d else None

    weekday_average_sales = calc_weekday_average_sales(conn, yusas_code, date)

    def _weight(key: str, setting_key: str, default: float) -> float:
        override = (weight_overrides or {}).get(key)
        if override is not None:
            return override
        return _setting_weight(get_setting, setting_key, default)

    weight_weekday_average = _weight(
        "weight_weekday_average", "order_recommendation_weight_weekday_average", DEFAULT_WEIGHT_WEEKDAY_AVERAGE
    )
    weight_previous_day = _weight(
        "weight_previous_day", "order_recommendation_weight_previous_day", DEFAULT_WEIGHT_PREVIOUS_DAY
    )
    weight_avg_7d = _weight("weight_avg_7d", "order_recommendation_weight_avg_7d", DEFAULT_WEIGHT_AVG_7D)
    weight_avg_14d = _weight("weight_avg_14d", "order_recommendation_weight_avg_14d", DEFAULT_WEIGHT_AVG_14D)
    weight_avg_3d = _weight("weight_avg_3d", "order_recommendation_weight_avg_3d", DEFAULT_WEIGHT_AVG_3D)

    expected_sales_today = calc_expected_sales_today(
        weekday_average_sales, previous_day_sales_qty, avg_sales_7d, avg_sales_14d,
        weight_weekday_average, weight_previous_day, weight_avg_7d, weight_avg_14d,
        avg_sales_3d, weight_avg_3d,
    )

    return {
        "previous_day_sales_qty": previous_day_sales_qty,
        "sales_3d": sales_3d, "sales_7d": sales_7d, "sales_14d": sales_14d,
        "avg_sales_3d": avg_sales_3d, "avg_sales_7d": avg_sales_7d, "avg_sales_14d": avg_sales_14d,
        "weekday_average_sales": weekday_average_sales,
        "expected_sales_today": expected_sales_today,
        "weight_weekday_average": weight_weekday_average,
        "weight_previous_day": weight_previous_day,
        "weight_avg_7d": weight_avg_7d,
        "weight_avg_14d": weight_avg_14d,
        "weight_avg_3d": weight_avg_3d,
    }


def coverage_days_for_expected_sales(expected_sales) -> float:
    """예상판매량 구간별로 발주 커버리지(한 번에 며칠치를 발주할지)를 자동으로 정한다.
    0~4개: 1일치 / 5~9개: 3일치 / 10~15개: 5일치 / 15개 초과: 7일치.
    예상판매량을 모르면(None) 가장 보수적인 1일치로 계산한다."""
    if expected_sales is None or expected_sales < 5:
        return 1.0
    if expected_sales < 10:
        return 3.0
    if expected_sales <= 15:
        return 5.0
    return 7.0


def compute_row(conn, yusas_code: str, date: str, get_setting) -> None:
    row = get_row(conn, date, yusas_code)
    if row is None:
        return

    signals = calc_expected_sales_today_for_date(conn, yusas_code, date, get_setting)

    prev_date_str = previous_date(date)
    prev_row = get_row(conn, prev_date_str, yusas_code)

    coverage_days = coverage_days_for_expected_sales(signals["expected_sales_today"])
    safety_stock_qty = _setting_float(get_setting, "order_recommendation_safety_stock_qty", DEFAULT_SAFETY_STOCK_QTY)

    coverage_period_expected_sales = calc_expected_sales_for_coverage(
        conn, yusas_code, date, coverage_days,
        signals["previous_day_sales_qty"], signals["avg_sales_7d"], signals["avg_sales_14d"],
        signals["weight_weekday_average"], signals["weight_previous_day"],
        signals["weight_avg_7d"], signals["weight_avg_14d"],
        signals["avg_sales_3d"], signals["weight_avg_3d"],
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
            sales_3d = ?, sales_7d = ?, sales_14d = ?,
            avg_sales_3d = ?, avg_sales_7d = ?, avg_sales_14d = ?,
            weekday_average_sales = ?, expected_sales_today = ?,
            model_version = ?, model_weight_weekday = ?, model_weight_previous_day = ?,
            model_weight_avg_7d = ?, model_weight_avg_14d = ?, model_weight_avg_3d = ?,
            coverage_days_used = ?,
            recommended_qty = ?,
            ad_budget_change = ?, ad_budget_change_rate = ?,
            wish_count_change = ?, wish_count_change_rate = ?,
            cart_count_change = ?, cart_count_change_rate = ?,
            incoming_qty_change = ?, incoming_qty_change_rate = ?
        WHERE date = ? AND yusas_code = ?
        """,
        (
            signals["previous_day_sales_qty"],
            signals["sales_3d"], signals["sales_7d"], signals["sales_14d"],
            signals["avg_sales_3d"], signals["avg_sales_7d"], signals["avg_sales_14d"],
            signals["weekday_average_sales"], signals["expected_sales_today"],
            MODEL_VERSION, signals["weight_weekday_average"], signals["weight_previous_day"],
            signals["weight_avg_7d"], signals["weight_avg_14d"], signals["weight_avg_3d"],
            coverage_days,
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
