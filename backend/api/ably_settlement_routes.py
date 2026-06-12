from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Body, Depends, HTTPException, Query

from services.ably_settlement_utils import (
    fetch_ably_history_list,
    fetch_ably_order_details_batch,
    fetch_ably_settlement_csv,
)
from services.amood_settlement_utils import aggregate_by_product, now_iso
from services.pastelco_utils import pastelco_login


def build_ably_settlement_router(*, get_current_user, get_db):
    router = APIRouter(prefix="/ably-settlement", tags=["ably-settlement"])

    @router.delete("/cache")
    def clear_cache(user: str = Depends(get_current_user)):
        """ably_order_cache 전체 삭제"""
        conn = get_db()
        try:
            conn.execute("DELETE FROM ably_order_cache")
            conn.commit()
            return {"ok": True, "message": "캐시 초기화 완료"}
        finally:
            conn.close()

    @router.get("/debug/order/{order_id}")
    async def debug_order(order_id: str, user: str = Depends(get_current_user)):
        """단건 주문 상세 raw 응답 확인용"""
        import httpx as _httpx
        from services.ably_settlement_utils import ABLY_BASE, _ably_headers
        jwt_token = await pastelco_login()
        async with _httpx.AsyncClient(timeout=15.0) as client:
            res = await client.get(
                f"{ABLY_BASE}/seller/order_items/{order_id}/",
                headers=_ably_headers(jwt_token),
            )
        return {
            "status_code": res.status_code,
            "raw": res.text[:3000],
        }

    @router.get("/histories")
    async def get_histories(
        start: str = Query(default=None, description="YYYY-MM"),
        end: str = Query(default=None, description="YYYY-MM"),
        user: str = Depends(get_current_user),
    ):
        today = date.today()
        if not start:
            start = f"{today.year - 1}-{today.month:02d}"
        if not end:
            end = f"{today.year}-{today.month:02d}"
        try:
            jwt_token = await pastelco_login()
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"에이블리 로그인 실패: {e}")
        try:
            histories = await fetch_ably_history_list(jwt_token, start, end)
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"정산 목록 조회 실패: {e}")
        return {"ok": True, "histories": histories, "start": start, "end": end}

    @router.post("/process")
    async def process_settlement(
        payload: dict = Body(...), user: str = Depends(get_current_user)
    ):
        sno = payload.get("sno")
        if not sno:
            raise HTTPException(status_code=400, detail="sno 필수")

        try:
            jwt_token = await pastelco_login()
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"에이블리 로그인 실패: {e}")

        # CSV 다운로드
        try:
            csv_rows = await fetch_ably_settlement_csv(sno, jwt_token)
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"CSV 다운로드 실패: {e}")

        if not csv_rows:
            return {"ok": True, "items": [], "summary": {"total_orders": 0}}

        order_ids = [r["order_id"] for r in csv_rows]

        # 캐시 조회
        conn = get_db()
        try:
            placeholders = ",".join("?" * len(order_ids))
            cached_rows = conn.execute(
                f"SELECT order_id, name_origin, processed_name, quantity FROM ably_order_cache WHERE order_id IN ({placeholders})",
                order_ids,
            ).fetchall()
            cached = {
                r["order_id"]: {
                    "name_origin": r["name_origin"],
                    "processed_name": r["processed_name"],
                    "quantity": r["quantity"],
                }
                for r in cached_rows
            }
        finally:
            conn.close()

        # 미캐시 주문 상세 조회
        try:
            order_details = await fetch_ably_order_details_batch(
                order_ids, jwt_token, concurrency=10, cached=cached
            )
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"주문 상세 조회 실패: {e}")

        # 새 캐시 저장
        new_entries = [
            (oid, det["name_origin"], det["processed_name"], det["quantity"], now_iso())
            for oid, det in order_details.items()
            if det is not None and oid not in cached
        ]
        if new_entries:
            conn = get_db()
            try:
                conn.executemany(
                    """
                    INSERT INTO ably_order_cache (order_id, name_origin, processed_name, quantity, fetched_at)
                    VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(order_id) DO NOTHING
                    """,
                    new_entries,
                )
                conn.commit()
            finally:
                conn.close()

        # 원가 DB (아무드와 공유)
        conn = get_db()
        try:
            cost_rows = conn.execute(
                "SELECT product_name, cost_price FROM amood_product_costs"
            ).fetchall()
            cost_map = {r["product_name"]: r["cost_price"] for r in cost_rows}
        finally:
            conn.close()

        # per_item_cost (아무드 설정 공유)
        conn = get_db()
        try:
            row = conn.execute(
                "SELECT value FROM amood_settlement_settings WHERE key = 'per_item_cost'"
            ).fetchone()
            per_item_cost = int(row["value"]) if row else 1900
        finally:
            conn.close()

        if "per_item_cost" in payload:
            try:
                per_item_cost = int(payload["per_item_cost"])
            except (TypeError, ValueError):
                pass

        items, summary = aggregate_by_product(
            csv_rows, order_details, cost_map, per_item_cost
        )

        return {"ok": True, "items": items, "summary": summary}

    return router
