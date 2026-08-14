from __future__ import annotations

from fastapi import APIRouter, Depends

from sdk.ezadmin import EzAdminSessionExpired
from services.order_non_ably_backorder import collect_non_ably_snapshot, list_non_ably_snapshot
from services.order_recommendation_store import today_kst


def _row_to_dict(row) -> dict:
    return {key: row[key] for key in row.keys()}


def build_non_ably_order_router(*, get_current_user, get_db, get_setting):
    router = APIRouter(prefix="/non-ably-order", tags=["non-ably-order"])

    @router.post("/collect")
    async def collect(user: str = Depends(get_current_user)):
        try:
            count = await collect_non_ably_snapshot(get_db, get_setting)
        except EzAdminSessionExpired:
            return {"ok": False, "need_session": True}
        return {"ok": True, "updated_codes": count}

    @router.get("/snapshot")
    def snapshot(user: str = Depends(get_current_user)):
        conn = get_db()
        try:
            rows = list_non_ably_snapshot(conn)
            return {"ok": True, "items": [_row_to_dict(r) for r in rows]}
        finally:
            conn.close()

    @router.get("/final-order")
    def final_order(date: str | None = None, user: str = Depends(get_current_user)):
        target_date = date or today_kst()
        conn = get_db()
        try:
            ably_rows = {
                r["yusas_code"]: r
                for r in conn.execute(
                    "SELECT yusas_code, recommended_qty, confirmed_qty "
                    "FROM order_recommendation_daily WHERE date = ?",
                    (target_date,),
                ).fetchall()
            }
            non_ably_rows = {
                r["yusas_code"]: r["lack_qty"]
                for r in conn.execute("SELECT yusas_code, lack_qty FROM order_non_ably_backorder").fetchall()
            }
        finally:
            conn.close()

        codes = sorted(set(ably_rows.keys()) | set(non_ably_rows.keys()))
        items = []
        for code in codes:
            ably_row = ably_rows.get(code)
            recommended_qty = ably_row["recommended_qty"] if ably_row is not None else None
            confirmed_qty = ably_row["confirmed_qty"] if ably_row is not None else None
            ably_order_qty = confirmed_qty if confirmed_qty is not None else (recommended_qty or 0)
            non_ably_lack_qty = non_ably_rows.get(code) or 0
            items.append({
                "yusas_code": code,
                "recommended_qty": recommended_qty,
                "confirmed_qty": confirmed_qty,
                "ably_order_qty": ably_order_qty,
                "non_ably_lack_qty": non_ably_lack_qty,
                "final_order_qty": ably_order_qty + non_ably_lack_qty,
            })
        return {"ok": True, "date": target_date, "items": items}

    return router
