from __future__ import annotations

from fastapi import APIRouter, Body, Depends

from services.order_recommendation_ably_sales import collect_ably_sales_history
from services.order_recommendation_calc import compute_all
from services.order_recommendation_collect import run_collectors
from services.order_recommendation_evaluate import aggregate_forecast_accuracy, evaluate_all
from services.order_recommendation_order_performance import (
    aggregate_order_performance,
    evaluate_order_performance_all,
)
from services.order_recommendation_store import ensure_row, list_rows, now_kst_iso, today_kst
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
        updated = await collect_ably_sales_history(get_db)
        return {"ok": True, "updated": updated}

    @router.post("/compute")
    def compute(date: str | None = None, user: str = Depends(get_current_user)):
        target_date = date or today_kst()
        count = compute_all(get_db, target_date, get_setting)
        return {"ok": True, "date": target_date, "computed": count}

    @router.get("/daily")
    def daily(date: str | None = None, user: str = Depends(get_current_user)):
        target_date = date or today_kst()
        conn = get_db()
        try:
            rows = list_rows(conn, target_date)
            return {"ok": True, "date": target_date, "items": [_row_to_dict(r) for r in rows]}
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
