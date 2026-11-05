"""상단메뉴 판매자 - 판매자 반품 통계 대시보드용 API.

- POST /seller-stats/sync : 에이블리 환불요청(43)/반품완료(44) 내역에서 최근 N일 판매자 건을 모아 저장
- GET  /seller-stats      : 저장된 판매자 건 통계
일일 체크리스트(신규반품 회수신청/교환 회수접수)가 실행될 때도 같은 저장소에 쌓인다.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query

from api.return_shipping_routes import ABLY_BASE, ABLY_EMAIL, ABLY_PASSWORD
from services.seller_return_store import (
    compute_stats,
    init_seller_return_tables,
    is_seller_return_item,
    return_row,
    upsert_rows,
)

_KST = timezone(timedelta(hours=9))
_PER_PAGE = 30
_CONCURRENCY = 5

# (processing_sub_status, date_type, order) - HAR(환불요청/반품완료 화면)에서 확인한 조회 조건
_SYNC_TARGETS = (
    ("43", "confirm_requested_at", "-confirm_requested_at"),
    ("44", "cancel_completed_at", "-cancel_completed_at"),
)


def _goods_codes() -> dict:
    """에이블리 goods_sno → [상품코드, ...] (원가베이스유 기준). 실패하면 상품별 반품률만 빠진다."""
    try:
        from api.wonbe_routes import load_wonbe_goods_sno_map

        return {g: [code for _opt, code in pairs] for g, pairs in load_wonbe_goods_sno_map().items()}
    except Exception:
        return {}


def _code_vendor() -> dict:
    """상품코드 → 거래처 (원가베이스유 기준). 실패하면 거래처별 판매 수량만 빠진다."""
    try:
        from api.wonbe_routes import _get_wonbe_db

        conn = _get_wonbe_db()
        try:
            return {r[0]: r[1] for r in conn.execute("SELECT 상품코드, 거래처 FROM wonbe WHERE 거래처 != ''")}
        finally:
            conn.close()
    except Exception:
        return {}


def build_seller_stats_router(*, get_current_user, get_db):
    router = APIRouter(prefix="/seller-stats")

    async def _login(client: httpx.AsyncClient) -> str:
        res = await client.post(
            f"{ABLY_BASE}/seller/login/",
            json={"email": ABLY_EMAIL, "password": ABLY_PASSWORD},
            headers={
                "Content-Type": "application/json",
                "User-Agent": "Mozilla/5.0",
                "Referer": "https://my.a-bly.com/",
                "Origin": "https://my.a-bly.com",
            },
        )
        res.raise_for_status()
        body = res.json()
        token = body.get("access_token") or body.get("token")
        if not token:
            raise HTTPException(status_code=502, detail="에이블리 로그인 실패: 토큰 없음")
        return token

    async def _fetch_page(client, headers, sem, sub_status, date_type, order, start, end, page):
        async with sem:
            res = await client.get(
                f"{ABLY_BASE}/seller/order_cancels/",
                headers=headers,
                params={
                    "cancel_type": "return",
                    "processing_sub_status[]": [sub_status],
                    "delivery_type[]": ["standard", "today", "combine", "reserved"],
                    "order": order,
                    "date_type": date_type,
                    "page": page,
                    "per_page": _PER_PAGE,
                    "start_date": start,
                    "end_date": end,
                },
            )
            res.raise_for_status()
            return res.json()

    async def _collect(client, headers, sub_status, date_type, order, start, end) -> list[dict]:
        sem = asyncio.Semaphore(_CONCURRENCY)
        first = await _fetch_page(client, headers, sem, sub_status, date_type, order, start, end, 1)
        pages = [first]
        max_page = int(first.get("max_page_number") or 1)
        if max_page > 1:
            pages += await asyncio.gather(*(
                _fetch_page(client, headers, sem, sub_status, date_type, order, start, end, p)
                for p in range(2, max_page + 1)
            ))
        rows = []
        for data in pages:
            for cancel in data.get("order_cancels", []):
                for item in cancel.get("order_items", []):
                    if is_seller_return_item(item):
                        rows.append(return_row(item, cancel.get("sno"), "sync"))
        return rows

    @router.post("/sync")
    async def sync(days: int = Query(30, ge=1, le=365), user: str = Depends(get_current_user)):
        end = datetime.now(_KST).strftime("%Y-%m-%d")
        start = (datetime.now(_KST) - timedelta(days=days)).strftime("%Y-%m-%d")
        try:
            async with httpx.AsyncClient(timeout=60.0) as client:
                token = await _login(client)
                headers = {
                    "Authorization": f"JWT {token}",
                    "Accept": "application/json",
                    "User-Agent": "Mozilla/5.0",
                    "Referer": "https://my.a-bly.com/",
                    "Origin": "https://my.a-bly.com",
                }
                collected: dict[str, list[dict]] = {}
                for sub_status, date_type, order in _SYNC_TARGETS:
                    collected[sub_status] = await _collect(
                        client, headers, sub_status, date_type, order, start, end
                    )
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"에이블리 조회 실패: {e}")

        rows = [r for items in collected.values() for r in items]
        conn = get_db()
        try:
            saved = upsert_rows(conn, rows)
        finally:
            conn.close()
        return {
            "ok": True,
            "start": start,
            "end": end,
            "refund_requested": len(collected["43"]),
            "completed": len(collected["44"]),
            "saved": saved,
        }

    @router.get("")
    def stats(
        start: str = Query(""),
        end: str = Query(""),
        min_sales: int = Query(50, ge=1, le=10000),
        user: str = Depends(get_current_user),
    ):
        today = datetime.now(_KST)
        end = end or today.strftime("%Y-%m-%d")
        start = start or (today - timedelta(days=30)).strftime("%Y-%m-%d")
        goods_codes = _goods_codes()
        conn = get_db()
        try:
            init_seller_return_tables(conn)
            data = compute_stats(conn, start, end, goods_codes, min_sales, _code_vendor())
            last = conn.execute("SELECT MAX(updated_at) AS t FROM seller_returns").fetchone()
            data["last_updated"] = (last["t"] if last else None) or ""
        finally:
            conn.close()
        return {"ok": True, **data}

    return router
