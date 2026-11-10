"""통계 > 취소통계 API.

- 수집: 에이블리 목록 API(per_page=100)를 페이지 병렬로 받아 SQLite 에 upsert (주문 단건 조회 없음)
    · 취소  : GET /seller/order_cancels/ (cancel_type=cancel)  — 첫 실행 30일 백필, 이후 최근 7일 증분
    · 지연  : GET /seller/order_items/ (상품준비중 + is_delayed=2) — 스냅샷
- 화면은 DB 집계(/cancel-stats/summary, /surge, /delay)만 읽는다.
- 3시간마다 main.py 의 스케줄러가 run_scheduled 를 호출한다.
"""
from __future__ import annotations

import asyncio
import time
import traceback
from datetime import datetime, timedelta, timezone

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query

from sdk import config
from sdk.ably import AblyClient
from services import cancel_stats_store as store

_KST = timezone(timedelta(hours=9))
_STATS_USERS = ("ksh2932", "tmddlfnan")  # 통계 메뉴 허용 계정(김세현, 김승일)
_PER_PAGE = 100
_CONCURRENCY = 5
_BACKFILL_DAYS = 30
_INCREMENT_DAYS = 7
_DELIVERY_TYPES = ["standard", "today", "combine", "reserved"]


def build_cancel_stats_router(*, get_current_user, get_db):
    router = APIRouter(prefix="/cancel-stats")
    ably = AblyClient(timeout=60.0)
    lock = asyncio.Lock()
    state = {"running": False, "last_error": ""}

    def _check(user: str) -> None:
        if user not in _STATS_USERS:
            raise HTTPException(status_code=403, detail="권한이 없습니다.")

    async def _get(client: httpx.AsyncClient, sem, path: str, params: dict) -> dict:
        """429/5xx 는 짧게 백오프하며 재시도, 401 은 재로그인 1회."""
        async with sem:
            for attempt in range(4):
                token = await ably.login()
                res = await client.get(
                    f"{config.ABLY_BASE}{path}",
                    headers=AblyClient.headers(token, origin="my.a-bly.com"),
                    params=params,
                )
                if res.status_code == 401 and attempt == 0:
                    await ably.login(force=True)
                    continue
                if res.status_code == 429 or res.status_code >= 500:
                    wait = float(res.headers.get("Retry-After") or (1.5 * (attempt + 1)))
                    await asyncio.sleep(min(wait, 10))
                    continue
                res.raise_for_status()
                return res.json()
            res.raise_for_status()
            return res.json()

    async def _collect_cancels(client, start: str, end: str) -> list[dict]:
        sem = asyncio.Semaphore(_CONCURRENCY)
        params = {
            "cancel_type": "cancel",
            "processing_sub_status[]": ["41", "42", "43", "44"],
            "delivery_type[]": _DELIVERY_TYPES,
            "order": "-cancel_received_at",
            "date_type": "cancel_received_at",
            "per_page": _PER_PAGE,
            "start_date": start,
            "end_date": end,
        }
        first = await _get(client, sem, "/seller/order_cancels/", {**params, "page": 1})
        pages = [first]
        max_page = int(first.get("max_page_number") or 1)
        if max_page > 1:
            pages += await asyncio.gather(*(
                _get(client, sem, "/seller/order_cancels/", {**params, "page": p})
                for p in range(2, max_page + 1)
            ))
        rows = []
        for data in pages:
            for cancel in data.get("order_cancels", []):
                for item in cancel.get("order_items", []):
                    rows.append(store.cancel_row(item, cancel.get("sno")))
        return rows

    async def _collect_delays(client, snapshot_at: str) -> list[dict]:
        sem = asyncio.Semaphore(_CONCURRENCY)
        params = {
            "order": "-checked_at",
            "delivery_type[]": _DELIVERY_TYPES,
            "is_delayed": 2,
            "processing_status[]": 2,
            "processing_sub_status[]": 0,
            "per_page": _PER_PAGE,
        }
        count_params = {k: v for k, v in params.items() if k not in ("order", "per_page")}
        total = int((await _get(client, sem, "/seller/order_items/total-count/", count_params)).get("total_count") or 0)
        n_pages = max(1, -(-total // _PER_PAGE))
        pages = await asyncio.gather(*(
            _get(client, sem, "/seller/order_items/", {**params, "page": p}) for p in range(1, n_pages + 1)
        ))
        seen, rows = set(), []
        for data in pages:
            for item in data.get("order_items", []):
                row = store.delay_row(item, snapshot_at)
                if row["item_sno"] in seen:
                    continue
                seen.add(row["item_sno"])
                rows.append(row)
        return rows

    async def _sync(days: int | None, with_delay: bool = True) -> dict:
        """days=None 이면 자동: 테이블이 비어 있으면 30일 백필, 아니면 7일 증분."""
        if lock.locked():
            return {"ok": False, "skipped": "이미 수집 중입니다."}
        async with lock:
            state["running"] = True
            t0 = time.time()
            try:
                conn = get_db()
                try:
                    store.init_tables(conn)
                    has_data = conn.execute("SELECT 1 FROM cancel_items LIMIT 1").fetchone() is not None
                finally:
                    conn.close()
                n_days = days or (_INCREMENT_DAYS if has_data else _BACKFILL_DAYS)
                now = datetime.now(_KST)
                end = now.strftime("%Y-%m-%d")
                start = (now - timedelta(days=n_days)).strftime("%Y-%m-%d")
                snapshot_at = now.strftime("%Y-%m-%dT%H:%M:%S")
                async with httpx.AsyncClient(timeout=60.0) as client:
                    cancels = await _collect_cancels(client, start, end)
                    delays = await _collect_delays(client, snapshot_at) if with_delay else []
                conn = get_db()
                try:
                    saved = store.upsert_cancels(conn, cancels)
                    snap = store.save_delay_snapshot(conn, delays) if with_delay else 0
                    store.meta_set(conn, "last_sync_at", now.isoformat(timespec="seconds"))
                finally:
                    conn.close()
                state["last_error"] = ""
                return {
                    "ok": True, "start": start, "end": end, "cancels": saved, "delays": snap,
                    "seconds": round(time.time() - t0, 1),
                }
            except Exception as exc:
                state["last_error"] = str(exc)
                traceback.print_exc()
                raise
            finally:
                state["running"] = False

    async def run_scheduled(force: bool = False) -> None:
        await _sync(None)

    router.run_scheduled = run_scheduled  # main.py 스케줄러 등록용

    @router.post("/sync")
    async def sync(days: int = Query(0, ge=0, le=90), user: str = Depends(get_current_user)):
        _check(user)
        try:
            return await _sync(days or None)
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"에이블리 조회 실패: {exc}")

    def _today():
        return datetime.now(_KST).date()

    @router.get("/summary")
    def summary(days: int = Query(30, ge=1, le=180), group: str = Query("day"), user: str = Depends(get_current_user)):
        _check(user)
        if group not in ("day", "week", "month"):
            raise HTTPException(status_code=400, detail="group 은 day/week/month 만 가능합니다.")
        conn = get_db()
        try:
            store.init_tables(conn)
            data = store.compute_cancel_stats(conn, _today(), days, group)
            data["last_sync_at"] = store.meta_get(conn, "last_sync_at")
        finally:
            conn.close()
        data["running"] = state["running"]
        data["last_error"] = state["last_error"]
        return {"ok": True, **data}

    @router.get("/products")
    def products(
        days: int = Query(30, ge=1, le=180),
        min_recent: int = Query(5, ge=1, le=500),
        min_ratio: float = Query(2.0, ge=1.0, le=100.0),
        user: str = Depends(get_current_user),
    ):
        _check(user)
        conn = get_db()
        try:
            store.init_tables(conn)
            data = store.compute_products(conn, _today(), days, 3, min_recent, min_ratio)
        finally:
            conn.close()
        return {"ok": True, **data}

    @router.get("/surge")
    def surge(
        window: int = Query(3, ge=1, le=7),
        min_recent: int = Query(5, ge=1, le=500),
        min_ratio: float = Query(2.0, ge=1.0, le=100.0),
        user: str = Depends(get_current_user),
    ):
        _check(user)
        conn = get_db()
        try:
            store.init_tables(conn)
            items = store.compute_surge(conn, _today(), window, min_recent, min_ratio)
        finally:
            conn.close()
        return {"ok": True, "window": window, "min_recent": min_recent, "min_ratio": min_ratio, "items": items}

    @router.get("/delay")
    def delay(user: str = Depends(get_current_user)):
        _check(user)
        conn = get_db()
        try:
            store.init_tables(conn)
            data = store.compute_delay(conn, _today())
        finally:
            conn.close()
        return {"ok": True, **data}

    return router
