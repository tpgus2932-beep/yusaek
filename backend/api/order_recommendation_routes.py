from __future__ import annotations

import json
from datetime import datetime, timedelta

from fastapi import APIRouter, Body, Depends

from api.wonbe_routes import build_dash_options, load_wonbe_client_info_by_code, load_wonbe_product_name_map
from services.order_recommendation_ably_sales import collect_ably_sales_history, get_sales_history_progress
from services.order_recommendation_discover import (
    DEFAULT_DISCOVER_DAYS,
    DEFAULT_DISCOVER_LIMIT,
    discover_missed_reorder_candidates,
)
from services.order_recommendation_discover_snapshot import get_discover_snapshot, save_discover_snapshot
from services.order_recommendation_calc import (
    ORDER_LEAD_DAYS,
    WEEKDAY_LOOKBACK_WEEKS,
    calc_expected_sales_today_for_date,
    compute_all,
)
from services.order_recommendation_collect import run_collectors
from services.order_recommendation_evaluate import (
    aggregate_forecast_accuracy,
    calc_forecast_error,
    calc_within_20_percent,
    evaluate_all,
)
from services.order_recommendation_order_performance import (
    aggregate_order_performance,
    evaluate_order_performance_all,
)
from services.order_recommendation_store import ensure_row, get_row, list_rows, now_kst_iso, today_kst
from sdk.ezadmin import EzAdminSessionExpired


BACKTEST_TOP_N = 50


def _row_to_dict(row) -> dict:
    return {key: row[key] for key in row.keys()}


def _load_top90_excluded_clients(get_setting) -> list[str]:
    raw = get_setting("order_recommendation_top90_excluded_clients")
    if not raw:
        return []
    try:
        return [str(c) for c in json.loads(raw)]
    except (TypeError, ValueError):
        return []


def _actual_coverage_sales(conn, yusas_code: str, start_date: str, coverage_days: int):
    """start_date에 발주해서 실제로 커버되는 첫날(start_date+ORDER_LEAD_DAYS)부터
    coverage_days일치(포함) 실제 판매량 합. 기간 중 하루라도 수집이 안 됐으면
    (sales_qty가 없으면) None — 아직 다 지나지 않은 기간은 검증 대상이 아님."""
    target_dates = [
        (datetime.strptime(start_date, "%Y-%m-%d") + timedelta(days=offset + ORDER_LEAD_DAYS)).strftime("%Y-%m-%d")
        for offset in range(coverage_days)
    ]
    placeholders = ",".join("?" * len(target_dates))
    sales_rows = conn.execute(
        f"SELECT date, sales_qty FROM order_recommendation_daily "
        f"WHERE yusas_code = ? AND date IN ({placeholders})",
        (yusas_code, *target_dates),
    ).fetchall()
    sales_by_date = {sr["date"]: sr["sales_qty"] for sr in sales_rows}
    if len(sales_by_date) < len(target_dates) or any(sales_by_date.get(d) is None for d in target_dates):
        return None
    return sum(sales_by_date[d] for d in target_dates)


def build_order_recommendation_router(*, get_current_user, get_db, get_setting, set_setting, get_shared_db):
    router = APIRouter(prefix="/order-recommendation", tags=["order-recommendation"])

    @router.post("/collect")
    async def collect(date: str | None = None, user: str = Depends(get_current_user)):
        target_date = date or today_kst()
        try:
            merged = await run_collectors(get_db, target_date)
        except EzAdminSessionExpired:
            return {"ok": False, "need_session": True}
        return {"ok": True, "date": target_date, "updated_codes": sorted(merged.keys())}

    @router.post("/collect-sales-history")
    async def collect_sales_history(user: str = Depends(get_current_user)):
        updated = await collect_ably_sales_history(get_db, user=user)
        return {"ok": True, "updated": updated}

    @router.get("/collect-sales-history/progress")
    def collect_sales_history_progress(user: str = Depends(get_current_user)):
        return get_sales_history_progress(user)

    @router.get("/discover-missed-reorders/saved")
    def discover_missed_reorders_saved(date: str | None = None, user: str = Depends(get_current_user)):
        """오늘(또는 지정 날짜) 마지막으로 조회했던 '추가된 상품' 결과를 재조회 없이 읽기만 한다."""
        target_date = date or today_kst()
        snapshot = get_discover_snapshot(get_shared_db, target_date)
        if snapshot is None:
            return {"ok": True, "saved": False}
        return {"ok": True, "saved": True, **snapshot}

    @router.get("/discover-missed-reorders")
    async def discover_missed_reorders(
        days: int = DEFAULT_DISCOVER_DAYS,
        limit: int = DEFAULT_DISCOVER_LIMIT,
        user: str = Depends(get_current_user),
    ):
        result = await discover_missed_reorder_candidates(
            get_db, get_setting, get_shared_db, days=days, limit=limit
        )
        try:
            save_discover_snapshot(
                get_shared_db,
                date=result["date"], days=result["days"], limit=result["limit"],
                candidate_count=result["candidate_count"], items=result["items"],
                need_ezadmin_session=result["need_ezadmin_session"], updated_by=user,
            )
        except Exception:
            pass  # 스냅샷 저장 실패는 이번 조회 결과 응답을 막지 않는다.
        return {"ok": True, **result}

    @router.post("/compute")
    def compute(date: str | None = None, user: str = Depends(get_current_user)):
        target_date = date or today_kst()
        count = compute_all(get_db, target_date, get_setting)
        return {"ok": True, "date": target_date, "computed": count}

    @router.get("/daily")
    def daily(date: str | None = None, user: str = Depends(get_current_user)):
        target_date = date or today_kst()
        name_map = load_wonbe_product_name_map()
        client_info_by_code = load_wonbe_client_info_by_code()
        conn = get_db()
        try:
            rows = list_rows(conn, target_date)
            items = []
            for r in rows:
                item = _row_to_dict(r)
                item["product_name"] = name_map.get(item["yusas_code"], "")
                client_info = client_info_by_code.get(item["yusas_code"]) or {}
                item["client"] = client_info.get("거래처", "")
                item["client_product_name"] = client_info.get("거래처상품명", "")
                item["options"] = build_dash_options(client_info)
                items.append(item)
            return {"ok": True, "date": target_date, "items": items}
        finally:
            conn.close()

    @router.get("/non-ably-items")
    def non_ably_items(user: str = Depends(get_current_user)):
        """비에이블리 재고수집(order_non_ably_backorder)에서 부족수량이 있는 상품을
        top90-items와 같은 방식으로 거래처 정보와 조인해서 돌려준다 - 엑셀주문 탭에서
        일별 데이터/추가된 상품에 안 잡히는(에이블리 IO30 쪽엔 확정수량이 없는) 상품도
        거래처별로 같이 모을 수 있게 하기 위함. 날짜 구분 없는 최신 스냅샷 하나뿐이다."""
        conn = get_db()
        try:
            rows = conn.execute(
                "SELECT yusas_code, stock_qty, incoming_qty, lack_qty FROM order_non_ably_backorder "
                "WHERE lack_qty > 0"
            ).fetchall()
        finally:
            conn.close()

        name_map = load_wonbe_product_name_map()
        client_info_by_code = load_wonbe_client_info_by_code()

        items = []
        for r in rows:
            code = r["yusas_code"]
            info = client_info_by_code.get(code) or {}
            client = info.get("거래처", "")
            client_product_name = info.get("거래처상품명", "")
            if not client or not client_product_name:
                continue
            options = build_dash_options(info)
            items.append({
                "yusas_code": code,
                "product_name": name_map.get(code, ""),
                "client": client,
                "client_product_name": client_product_name,
                "options": options,
                "stock_qty": r["stock_qty"],
                "incoming_qty": r["incoming_qty"],
                "recommended_qty": None,
                "confirmed_qty": None,
                "non_ably_lack_qty": r["lack_qty"],
            })
        return {"ok": True, "items": items}

    @router.get("/wonbe-search")
    def wonbe_search_for_order(
        client: str, q: str = "", limit: int = 20, user: str = Depends(get_current_user)
    ):
        """엑셀주문 탭에서 거래처 상품을 검색해 수동으로 추가할 때 쓴다 - 원가베이스유(wonbe)에서
        해당 거래처 상품만 걸러서 상품코드/상품명/옵션으로 검색한다."""
        limit = max(1, min(limit, 100))
        name_map = load_wonbe_product_name_map()
        client_info_by_code = load_wonbe_client_info_by_code()

        needle = q.strip().lower()
        items = []
        for code, info in client_info_by_code.items():
            if info.get("거래처") != client:
                continue
            client_product_name = info.get("거래처상품명", "")
            if not client_product_name:
                continue
            product_name = name_map.get(code, "")
            if needle and needle not in code.lower() and needle not in product_name.lower() \
                    and needle not in client_product_name.lower():
                continue
            items.append({
                "yusas_code": code,
                "product_name": product_name,
                "client": client,
                "client_product_name": client_product_name,
                "options": build_dash_options(info),
                "recommended_qty": None,
                "confirmed_qty": None,
            })
            if len(items) >= limit:
                break
        return {"ok": True, "items": items}

    @router.get("/{date}/top90-items")
    def top90_items(date: str, user: str = Depends(get_current_user)):
        """확정수량(confirmed_qty)이 있는 상품을 top90 발주 형식(/order/main-order/execute가
        받는 items[] 그대로)으로 변환한다. wonbe에 거래처/거래처상품명이 없는 상품은
        supplyProductName을 만들 수 없어서 제외하고 skipped_no_client_info로 따로 보여준다.
        일별 데이터(order_recommendation_daily)뿐 아니라 "추가된 상품"(discover) 스냅샷의
        확정수량도 같이 합친다 — discover 후보는 오늘자 일별 데이터 행 자체가 없는
        상품(재고가 있어 IO30에 안 잡힘)이라 daily 쪽에서는 절대 안 잡히기 때문이다.
        requestQty는 /non-ably-order/final-order와 동일하게 에이블리 확정수량 +
        비에이블리 부족수량(order_non_ably_backorder.lack_qty)을 합산한다 — 이 테이블은
        날짜 구분이 없는 최신 스냅샷 하나뿐이라 date 파라미터와 무관하게 그대로 쓴다.
        에이블리 쪽엔 값이 없고 비에이블리 부족수량만 있는 상품도 그만큼만 별도로 추가한다.
        lackQty는 화면 혼동을 막기 위해 확정수량 계산에 쓰는 ezadmin_lack_qty(실제로는
        요청수량)가 아니라 진짜 IO30 부족수량(ezadmin_real_lack_qty)을 보여준다 — 확정수량
        자체의 계산 공식은 그대로 요청수량 기준이라 여기서 바뀌는 건 없다.
        여기서 top90에 발주를 넣지는 않는다 — 반환된 items를 그대로 /order/main-order/execute에
        넘겨야 실제 발주가 등록된다."""
        conn = get_db()
        try:
            rows = conn.execute(
                "SELECT yusas_code, confirmed_qty, stock_qty, incoming_qty, ezadmin_real_lack_qty, recommended_qty "
                "FROM order_recommendation_daily WHERE date = ? AND confirmed_qty > 0",
                (date,),
            ).fetchall()
            non_ably_by_code = {
                r["yusas_code"]: dict(r)
                for r in conn.execute(
                    "SELECT yusas_code, stock_qty, incoming_qty, lack_qty FROM order_non_ably_backorder"
                ).fetchall()
            }
        finally:
            conn.close()

        name_map = load_wonbe_product_name_map()
        client_info_by_code = load_wonbe_client_info_by_code()

        def _build_item(code, ably_order_qty, stock_qty, incoming_qty, lack_qty, recommended_qty=None, source=None):
            info = client_info_by_code.get(code) or {}
            client = info.get("거래처", "")
            client_product_name = info.get("거래처상품명", "")
            if not client or not client_product_name:
                return None
            options = build_dash_options(info)
            non_ably_lack_qty = (non_ably_by_code.get(code) or {}).get("lack_qty") or 0
            return {
                "code": code,
                "name": name_map.get(code, ""),
                "options": options,
                "supplyProductName": f"{client} {client_product_name}".strip(),
                "clientProductName": client_product_name,
                "stock": stock_qty,
                "notYetDeliv": incoming_qty,
                "lackQty": lack_qty,
                "recommendedQty": recommended_qty,
                "recommendedQtySource": source,
                "requestQty": ably_order_qty + non_ably_lack_qty,
            }

        items = []
        skipped_no_client_info = []
        seen_codes = set()
        for r in rows:
            code = r["yusas_code"]
            seen_codes.add(code)
            item = _build_item(
                code, r["confirmed_qty"], r["stock_qty"], r["incoming_qty"], r["ezadmin_real_lack_qty"],
                r["recommended_qty"], source="daily",
            )
            if item is None:
                skipped_no_client_info.append(code)
                continue
            items.append(item)

        discover_snapshot = get_discover_snapshot(get_shared_db, date)
        for d in (discover_snapshot["items"] if discover_snapshot else []):
            code = d.get("yusas_code")
            confirmed_qty = d.get("confirmed_qty")
            if not code or code in seen_codes or not confirmed_qty:
                continue
            seen_codes.add(code)
            item = _build_item(
                code, confirmed_qty, d.get("stock_qty"), d.get("misong_qty"), d.get("pending_qty"),
                d.get("recommended_qty"), source="discover",
            )
            if item is None:
                skipped_no_client_info.append(code)
                continue
            items.append(item)

        # 에이블리 쪽엔 확정수량이 없지만 비에이블리 부족수량만 있는 상품도 추가한다
        # (/non-ably-order/final-order와 동일하게 두 목록의 합집합을 다룬다).
        for code, non_ably_row in non_ably_by_code.items():
            if code in seen_codes or not (non_ably_row.get("lack_qty") or 0):
                continue
            seen_codes.add(code)
            item = _build_item(
                code, 0, non_ably_row.get("stock_qty"), non_ably_row.get("incoming_qty"), non_ably_row.get("lack_qty"),
                source="non_ably_only",
            )
            if item is None:
                skipped_no_client_info.append(code)
                continue
            items.append(item)

        excluded_clients = set(_load_top90_excluded_clients(get_setting))
        if excluded_clients:
            items = [i for i in items if (i["supplyProductName"] or "").split(" ", 1)[0] not in excluded_clients]

        return {
            "ok": True, "date": date,
            "count": len(items), "items": items,
            "skipped_no_client_info": skipped_no_client_info,
        }

    @router.post("/evaluate")
    def evaluate(date: str | None = None, user: str = Depends(get_current_user)):
        target_date = date or today_kst()
        count = evaluate_all(get_db, target_date)
        return {"ok": True, "date": target_date, "evaluated": count}

    @router.get("/forecast-accuracy")
    def forecast_accuracy(
        days: int = 7,
        yusas_code: str | None = None,
        user: str = Depends(get_current_user),
    ):
        conn = get_db()
        try:
            result = aggregate_forecast_accuracy(conn, days, yusas_code)
        finally:
            conn.close()
        return {"ok": True, "days": days, "yusas_code": yusas_code, **result}

    @router.post("/evaluate-order-performance")
    def evaluate_order_performance(date: str | None = None, user: str = Depends(get_current_user)):
        target_date = date or today_kst()
        count = evaluate_order_performance_all(get_db, target_date)
        return {"ok": True, "date": target_date, "evaluated": count}

    @router.get("/order-performance")
    def order_performance(
        days: int = 7,
        yusas_code: str | None = None,
        user: str = Depends(get_current_user),
    ):
        conn = get_db()
        try:
            result = aggregate_order_performance(conn, days, yusas_code)
        finally:
            conn.close()
        return {"ok": True, "days": days, "yusas_code": yusas_code, **result}

    @router.get("/backtest/date-range")
    def backtest_date_range(user: str = Depends(get_current_user)):
        conn = get_db()
        try:
            row = conn.execute(
                "SELECT MIN(date) AS min_date, MAX(date) AS max_date "
                "FROM order_recommendation_daily WHERE sales_qty IS NOT NULL"
            ).fetchone()
            earliest, collected_max_date = row["min_date"], row["max_date"]

            # 백테스트 대상일(계산일)의 예측은 계산일+ORDER_LEAD_DAYS의 실제값과 비교하므로,
            # 그 실제값까지 이미 수집돼 있어야 한다 — 그래서 선택 가능한 최대 날짜를 그만큼 당긴다.
            max_date = None
            if collected_max_date is not None:
                max_date = (
                    datetime.strptime(collected_max_date, "%Y-%m-%d") - timedelta(days=ORDER_LEAD_DAYS)
                ).strftime("%Y-%m-%d")

            min_date = None
            if earliest is not None:
                # 같은요일평균 신호가 최대 3주(WEEKDAY_LOOKBACK_WEEKS) 전까지 조회하므로,
                # 대상 날짜 기준 그만큼 과거 판매량이 먼저 수집돼 있어야 한다. 그 전 날짜는
                # 이 신호가 통째로 비어 예측 신뢰도가 떨어지므로 선택 가능 범위에서 제외한다.
                candidate = (
                    datetime.strptime(earliest, "%Y-%m-%d") + timedelta(weeks=WEEKDAY_LOOKBACK_WEEKS)
                ).strftime("%Y-%m-%d")
                if candidate <= max_date:
                    min_date = candidate

            return {"ok": True, "min_date": min_date, "max_date": max_date}
        finally:
            conn.close()

    @router.get("/backtest")
    def backtest(
        date: str,
        days: int = 1,
        weight_weekday_average: float | None = None,
        weight_previous_day: float | None = None,
        weight_avg_7d: float | None = None,
        weight_avg_14d: float | None = None,
        weight_avg_3d: float | None = None,
        weight_avg_5d: float | None = None,
        user: str = Depends(get_current_user),
    ):
        days = max(1, min(days, 5))
        overrides = {
            "weight_weekday_average": weight_weekday_average,
            "weight_previous_day": weight_previous_day,
            "weight_avg_7d": weight_avg_7d,
            "weight_avg_14d": weight_avg_14d,
            "weight_avg_3d": weight_avg_3d,
            "weight_avg_5d": weight_avg_5d,
        }
        overrides = {k: v for k, v in overrides.items() if v is not None}

        conn = get_db()
        try:
            # 대상 상품 = 판매량이 수집된 기간 전체 합산 기준 상위 BACKTEST_TOP_N개.
            # (예전엔 "오늘 recommended_qty가 있는 상품"으로 걸렀는데, 그러면 오늘 재고수집
            # (/collect, EZAdmin IO30)이 안 돌면 대상 자체가 비어버렸다. expected_sales_today/
            # 커버리지 시뮬레이션 둘 다 sales_qty 히스토리만으로 계산되니 재고 데이터와 무관하게
            # 판매량 기준으로 뽑아도 된다.)
            codes = [
                r["yusas_code"]
                for r in conn.execute(
                    "SELECT yusas_code FROM order_recommendation_daily "
                    "WHERE sales_qty IS NOT NULL "
                    "GROUP BY yusas_code ORDER BY SUM(sales_qty) DESC LIMIT ?",
                    (BACKTEST_TOP_N,),
                ).fetchall()
            ]
            name_map = load_wonbe_product_name_map()
            end_date = datetime.strptime(date, "%Y-%m-%d")
            target_dates = [
                (end_date - timedelta(days=offset)).strftime("%Y-%m-%d") for offset in range(days)
            ]

            items = []
            for calc_date in target_dates:
                # expected_sales_today는 calc_date+ORDER_LEAD_DAYS(발주가 실제로 커버하는 날)의
                # 예측이므로, 그 날의 실제 판매량과 비교해야 한다 — calc_date 자신이 아니다.
                actual_date = (
                    datetime.strptime(calc_date, "%Y-%m-%d") + timedelta(days=ORDER_LEAD_DAYS)
                ).strftime("%Y-%m-%d")
                for code in codes:
                    signals = calc_expected_sales_today_for_date(
                        conn, code, calc_date, get_setting, overrides or None
                    )
                    expected = signals["expected_sales_today"]
                    row = get_row(conn, actual_date, code)
                    actual = row["sales_qty"] if row is not None else None
                    forecast_error = calc_forecast_error(expected, actual)
                    absolute_error = abs(forecast_error) if forecast_error is not None else None
                    within_20_percent = calc_within_20_percent(absolute_error, actual)

                    items.append({
                        "date": calc_date,
                        "actual_date": actual_date,
                        "yusas_code": code,
                        "product_name": name_map.get(code, ""),
                        "expected_sales_today": expected,
                        "actual_sales_qty": actual,
                        "forecast_error": forecast_error,
                        "within_20_percent": within_20_percent,
                    })

            signed_errors = [i["forecast_error"] for i in items if i["forecast_error"] is not None]
            abs_errors = [abs(e) for e in signed_errors]
            actuals = [i["actual_sales_qty"] for i in items if i["forecast_error"] is not None]
            hit_flags = [i["within_20_percent"] for i in items if i["within_20_percent"] is not None]
            mae = sum(abs_errors) / len(abs_errors) if abs_errors else None
            actual_sum = sum(actuals)
            wape = (sum(abs_errors) / actual_sum) if abs_errors and actual_sum > 0 else None
            # 부호 있는 오차 합 / 실제판매 합 — 양수면 실제보다 많이 예측(과다발주 경향),
            # 음수면 적게 예측(과소발주 경향). WAPE와 분모는 같고 부호만 살린 버전.
            bias = (sum(signed_errors) / actual_sum) if signed_errors and actual_sum > 0 else None
            hit_rate_20pct = (sum(hit_flags) / len(hit_flags)) if hit_flags else None

            return {
                "ok": True, "date": date,
                "sample_count": len(hit_flags), "mae": mae, "wape": wape, "bias": bias,
                "hit_rate_20pct": hit_rate_20pct,
                "items": items,
            }
        finally:
            conn.close()

    @router.get("/coverage-check")
    def coverage_check(date: str, user: str = Depends(get_current_user)):
        conn = get_db()
        try:
            rows = conn.execute(
                "SELECT yusas_code, recommended_qty, coverage_days_used FROM order_recommendation_daily "
                "WHERE date = ? AND recommended_qty IS NOT NULL",
                (date,),
            ).fetchall()
            name_map = load_wonbe_product_name_map()

            items = []
            for r in rows:
                coverage_days = int(r["coverage_days_used"] or 1)
                actual_coverage_sales = _actual_coverage_sales(conn, r["yusas_code"], date, coverage_days)
                if actual_coverage_sales is None:
                    continue
                recommended_qty = r["recommended_qty"]
                forecast_error = calc_forecast_error(recommended_qty, actual_coverage_sales)
                absolute_error = abs(forecast_error) if forecast_error is not None else None
                within_20_percent = calc_within_20_percent(absolute_error, actual_coverage_sales)
                items.append({
                    "yusas_code": r["yusas_code"],
                    "product_name": name_map.get(r["yusas_code"], ""),
                    "coverage_days_used": coverage_days,
                    "recommended_qty": recommended_qty,
                    "actual_coverage_sales": actual_coverage_sales,
                    "forecast_error": forecast_error,
                    "within_20_percent": within_20_percent,
                })

            signed_errors = [i["forecast_error"] for i in items if i["forecast_error"] is not None]
            abs_errors = [abs(e) for e in signed_errors]
            actuals = [i["actual_coverage_sales"] for i in items if i["forecast_error"] is not None]
            hit_flags = [i["within_20_percent"] for i in items if i["within_20_percent"] is not None]
            mae = sum(abs_errors) / len(abs_errors) if abs_errors else None
            actual_sum = sum(actuals)
            wape = (sum(abs_errors) / actual_sum) if abs_errors and actual_sum > 0 else None
            bias = (sum(signed_errors) / actual_sum) if signed_errors and actual_sum > 0 else None
            hit_rate_20pct = (sum(hit_flags) / len(hit_flags)) if hit_flags else None

            return {
                "ok": True, "date": date,
                "sample_count": len(hit_flags), "mae": mae, "wape": wape, "bias": bias,
                "hit_rate_20pct": hit_rate_20pct, "items": items,
            }
        finally:
            conn.close()

    @router.post("/weights")
    def save_weights(payload: dict = Body(...), user: str = Depends(get_current_user)):
        keys = [
            "weight_weekday_average", "weight_previous_day",
            "weight_avg_7d", "weight_avg_14d", "weight_avg_3d",
        ]
        for key in keys:
            if key in payload and payload[key] is not None:
                set_setting(f"order_recommendation_{key}", str(payload[key]))
        return {"ok": True}

    @router.get("/top90-excluded-clients")
    def get_top90_excluded_clients(user: str = Depends(get_current_user)):
        return {"ok": True, "clients": _load_top90_excluded_clients(get_setting)}

    @router.post("/top90-excluded-clients")
    def save_top90_excluded_clients(payload: dict = Body(...), user: str = Depends(get_current_user)):
        clients = sorted({str(c).strip() for c in (payload.get("clients") or []) if str(c).strip()})
        set_setting("order_recommendation_top90_excluded_clients", json.dumps(clients, ensure_ascii=False))
        return {"ok": True, "clients": clients}

    @router.post("/{date}/{yusas_code}/confirm")
    def confirm(
        date: str,
        yusas_code: str,
        payload: dict = Body(...),
        user: str = Depends(get_current_user),
    ):
        confirmed_qty = payload.get("confirmed_qty")
        override_reason = payload.get("override_reason")
        conn = get_db()
        try:
            ensure_row(conn, date, yusas_code)
            conn.execute(
                """
                UPDATE order_recommendation_daily
                SET confirmed_qty = ?, override_reason = ?, updated_by = ?, updated_at = ?
                WHERE date = ? AND yusas_code = ?
                """,
                (confirmed_qty, override_reason, user, now_kst_iso(), date, yusas_code),
            )
            conn.commit()
        finally:
            conn.close()
        return {"ok": True}

    @router.post("/{date}/confirm-batch")
    def confirm_batch(date: str, payload: dict = Body(...), user: str = Depends(get_current_user)):
        items = payload.get("items") or []
        conn = get_db()
        try:
            saved = 0
            updated_at = now_kst_iso()
            for it in items:
                yusas_code = str(it.get("yusas_code") or "").strip()
                if not yusas_code:
                    continue
                ensure_row(conn, date, yusas_code)
                conn.execute(
                    """
                    UPDATE order_recommendation_daily
                    SET confirmed_qty = ?, override_reason = ?, updated_by = ?, updated_at = ?
                    WHERE date = ? AND yusas_code = ?
                    """,
                    (it.get("confirmed_qty"), it.get("override_reason"), user, updated_at, date, yusas_code),
                )
                saved += 1
            conn.commit()
        finally:
            conn.close()
        return {"ok": True, "saved": saved}

    return router
