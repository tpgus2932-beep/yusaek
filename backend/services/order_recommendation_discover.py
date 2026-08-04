from __future__ import annotations

import asyncio
from datetime import datetime, timedelta

from api.wonbe_routes import load_wonbe_product_name_map
from sdk.ezadmin import EzAdminClient, EzAdminSessionExpired
from services.misong_lookup import load_misong_qty_by_code
from services.order_recommendation_calc import (
    DEFAULT_SAFETY_STOCK_QTY,
    _setting_float,
    calc_expected_sales_for_coverage,
    calc_expected_sales_today_for_date,
    calc_recommended_qty,
    coverage_days_for_expected_sales,
    default_confirmed_qty_for_row,
)
from services.order_recommendation_store import today_kst

DEFAULT_DISCOVER_DAYS = 3
DEFAULT_DISCOVER_LIMIT = 150
_EZADMIN_LOOKUP_CONCURRENCY = 6


def _date_minus(date: str, days: int) -> str:
    return (datetime.strptime(date, "%Y-%m-%d") - timedelta(days=days)).strftime("%Y-%m-%d")


def _recent_avg_sales_candidates(conn, today: str, days: int, limit: int) -> list[tuple[str, float]]:
    """최근 days일(오늘 제외, 완료된 날짜만) 평균 판매량 상위 limit개.

    오늘자 행이 이미 있는 상품(=오늘 IO30 수집에 이미 잡혀서 정상적으로 발주추천
    계산이 도는 상품)은 제외한다 — 여기서 찾는 건 재고가 아직 있어서 IO30
    리포트에 안 잡히는 바람에 오늘자 행 자체가 없는 상품이다."""
    start = _date_minus(today, days)
    rows = conn.execute(
        """
        SELECT yusas_code, AVG(sales_qty) AS avg_sales
        FROM order_recommendation_daily
        WHERE date >= ? AND date < ? AND sales_qty IS NOT NULL
          AND yusas_code NOT IN (SELECT yusas_code FROM order_recommendation_daily WHERE date = ?)
        GROUP BY yusas_code
        ORDER BY avg_sales DESC
        LIMIT ?
        """,
        (start, today, today, limit),
    ).fetchall()
    return [(r["yusas_code"], r["avg_sales"]) for r in rows]


async def _fetch_stock_and_pending(get_setting, codes: list[str]) -> tuple[dict[str, dict], bool]:
    """상품코드별 EZAdmin I100 재고(stock)+접수(pending) 조회 (인기재고와 동일한 방식)."""
    ez = EzAdminClient(get_setting)
    semaphore = asyncio.Semaphore(_EZADMIN_LOOKUP_CONCURRENCY)
    need_ezadmin_session = False

    async def _lookup(code: str) -> tuple[str, dict | None]:
        nonlocal need_ezadmin_session
        async with semaphore:
            try:
                return code, await ez.get_stock_and_pending(code)
            except EzAdminSessionExpired:
                need_ezadmin_session = True
                return code, None
            except Exception:
                return code, None

    results = await asyncio.gather(*[_lookup(code) for code in codes])
    return {code: value for code, value in results if value is not None}, need_ezadmin_session


async def discover_missed_reorder_candidates(
    get_db, get_setting, get_shared_db, *, days: int = DEFAULT_DISCOVER_DAYS, limit: int = DEFAULT_DISCOVER_LIMIT
) -> dict:
    """재고가 아직 있어서 오늘 IO30 수집에 안 잡힌(=오늘자 행이 없는) 상품 중,
    최근 판매 속도가 빨라서 발주가 필요해지고 있는 후보를 찾는다.

    발주추천과 완전히 동일한 공식(calc_recommended_qty + default_confirmed_qty_for_row)을
    재사용하되, IO30에서 못 가져오는 값은 다른 경로로 대체한다:
    - 재고/접수 → EZAdmin I100 (인기재고와 동일, get_stock_and_pending)
    - 부족수량 자리 → 접수수량(pending)을 그대로 사용 (IO30 부족수량은 조회하지 않음)
    - 미송(입고예정) 자리 → 미송관리(misong_items) 수량
    """
    days = max(1, days)
    limit = max(1, min(limit, 500))
    today = today_kst()

    conn = get_db()
    try:
        candidates = _recent_avg_sales_candidates(conn, today, days, limit)
        if not candidates:
            return {
                "date": today,
                "days": days, "limit": limit, "candidate_count": 0,
                "need_ezadmin_session": False, "items": [],
            }

        stock_pending_by_code, need_ezadmin_session = await _fetch_stock_and_pending(
            get_setting, [code for code, _ in candidates]
        )
        misong_qty_by_code = load_misong_qty_by_code(get_shared_db)
        name_map = load_wonbe_product_name_map()
        safety_stock_qty = _setting_float(
            get_setting, "order_recommendation_safety_stock_qty", DEFAULT_SAFETY_STOCK_QTY
        )

        items = []
        for code, avg_sales in candidates:
            stock_and_pending = stock_pending_by_code.get(code)
            if stock_and_pending is None:
                continue
            stock_qty = stock_and_pending["stock"]
            pending_qty = stock_and_pending["pending"]
            incoming_qty = misong_qty_by_code.get(code, 0)

            signals = calc_expected_sales_today_for_date(conn, code, today, get_setting)
            expected_sales_today = signals["expected_sales_today"]
            coverage_days = coverage_days_for_expected_sales(expected_sales_today)
            coverage_period_expected_sales = calc_expected_sales_for_coverage(
                conn, code, today, coverage_days,
                signals["previous_day_sales_qty"], signals["avg_sales_7d"], signals["avg_sales_14d"],
                signals["weight_weekday_average"], signals["weight_previous_day"],
                signals["weight_avg_7d"], signals["weight_avg_14d"],
                signals["avg_sales_3d"], signals["weight_avg_3d"],
            )
            recommended_qty = calc_recommended_qty(coverage_period_expected_sales, safety_stock_qty)
            if expected_sales_today is not None and expected_sales_today < 3:
                recommended_qty = 0
            confirmed_qty = default_confirmed_qty_for_row(
                expected_sales_today, recommended_qty, pending_qty, stock_qty, incoming_qty
            )
            if not confirmed_qty:
                continue

            items.append({
                "yusas_code": code,
                "product_name": name_map.get(code, ""),
                "recent_avg_daily_sales": round(avg_sales, 2),
                "expected_sales_today": expected_sales_today,
                "coverage_days": coverage_days,
                "stock_qty": stock_qty,
                "pending_qty": pending_qty,
                "misong_qty": incoming_qty,
                "recommended_qty": recommended_qty,
                "confirmed_qty": confirmed_qty,
            })

        items.sort(key=lambda i: i["confirmed_qty"], reverse=True)
        return {
            "date": today,
            "days": days, "limit": limit, "candidate_count": len(candidates),
            "need_ezadmin_session": need_ezadmin_session, "items": items,
        }
    finally:
        conn.close()
