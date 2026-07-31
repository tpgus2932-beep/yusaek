from __future__ import annotations

from fastapi import APIRouter, Body, Depends

from api.wonbe_routes import load_wonbe_product_name_map
from services.order_recommendation_ably_sales import collect_ably_sales_history, get_sales_history_progress
from services.order_recommendation_calc import calc_expected_sales_today_for_date, compute_all
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


def _row_to_dict(row) -> dict:
    return {key: row[key] for key in row.keys()}


def build_order_recommendation_router(*, get_current_user, get_db, get_setting):
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

    @router.post("/compute")
    def compute(date: str | None = None, user: str = Depends(get_current_user)):
        target_date = date or today_kst()
        count = compute_all(get_db, target_date, get_setting)
        return {"ok": True, "date": target_date, "computed": count}

    @router.get("/daily")
    def daily(date: str | None = None, user: str = Depends(get_current_user)):
        target_date = date or today_kst()
        name_map = load_wonbe_product_name_map()
        conn = get_db()
        try:
            rows = list_rows(conn, target_date)
            items = []
            for r in rows:
                item = _row_to_dict(r)
                item["product_name"] = name_map.get(item["yusas_code"], "")
                items.append(item)
            return {"ok": True, "date": target_date, "items": items}
        finally:
            conn.close()

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

    @router.get("/backtest")
    def backtest(
        date: str,
        weight_weekday_average: float | None = None,
        weight_previous_day: float | None = None,
        weight_avg_7d: float | None = None,
        weight_avg_14d: float | None = None,
        weight_avg_3d: float | None = None,
        user: str = Depends(get_current_user),
    ):
        overrides = {
            "weight_weekday_average": weight_weekday_average,
            "weight_previous_day": weight_previous_day,
            "weight_avg_7d": weight_avg_7d,
            "weight_avg_14d": weight_avg_14d,
            "weight_avg_3d": weight_avg_3d,
        }
        overrides = {k: v for k, v in overrides.items() if v is not None}

        conn = get_db()
        try:
            today = today_kst()
            codes = [
                r["yusas_code"]
                for r in conn.execute(
                    "SELECT yusas_code FROM order_recommendation_daily "
                    "WHERE date = ? AND recommended_qty IS NOT NULL",
                    (today,),
                ).fetchall()
            ]
            name_map = load_wonbe_product_name_map()

            items = []
            for code in codes:
                signals = calc_expected_sales_today_for_date(
                    conn, code, date, get_setting, overrides or None
                )
                expected = signals["expected_sales_today"]
                row = get_row(conn, date, code)
                actual = row["sales_qty"] if row is not None else None
                forecast_error = calc_forecast_error(expected, actual)
                absolute_error = abs(forecast_error) if forecast_error is not None else None
                within_20_percent = calc_within_20_percent(absolute_error, actual)
                items.append({
                    "yusas_code": code,
                    "product_name": name_map.get(code, ""),
                    "expected_sales_today": expected,
                    "actual_sales_qty": actual,
                    "forecast_error": forecast_error,
                    "within_20_percent": within_20_percent,
                })

            abs_errors = [abs(i["forecast_error"]) for i in items if i["forecast_error"] is not None]
            actuals = [i["actual_sales_qty"] for i in items if i["forecast_error"] is not None]
            hit_flags = [i["within_20_percent"] for i in items if i["within_20_percent"] is not None]
            mae = sum(abs_errors) / len(abs_errors) if abs_errors else None
            actual_sum = sum(actuals)
            wape = (sum(abs_errors) / actual_sum) if abs_errors and actual_sum > 0 else None
            hit_rate_20pct = (sum(hit_flags) / len(hit_flags)) if hit_flags else None

            return {
                "ok": True, "date": date,
                "sample_count": len(hit_flags), "mae": mae, "wape": wape,
                "hit_rate_20pct": hit_rate_20pct, "items": items,
            }
        finally:
            conn.close()

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

    return router
