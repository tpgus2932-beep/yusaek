from __future__ import annotations

import asyncio
import sys
import traceback
from datetime import datetime, timedelta

from api.wonbe_routes import load_wonbe_goods_sno_map
from sdk.ably import AblyClient
from services.order_recommendation_store import ensure_row, today_kst

BACKFILL_DAYS = 28
FETCH_CONCURRENCY = 8

# user -> {"running": bool, "total": int, "done": int, "updated": int} — 판매량 수집 진행상황 폴링용
_sales_history_progress: dict[str, dict] = {}


def get_sales_history_progress(user: str) -> dict:
    return _sales_history_progress.get(user) or {"running": False, "total": 0, "done": 0, "updated": 0}


def _date_minus(date: str, days: int) -> str:
    return (datetime.strptime(date, "%Y-%m-%d") - timedelta(days=days)).strftime("%Y-%m-%d")


def _backfill_date_range(as_of_date: str) -> list[str]:
    return [_date_minus(as_of_date, d) for d in range(1, BACKFILL_DAYS + 1)]


def _missing_dates(conn, yusas_code: str, dates: list[str]) -> list[str]:
    placeholders = ",".join("?" * len(dates))
    rows = conn.execute(
        f"SELECT date, sales_qty FROM order_recommendation_daily "
        f"WHERE yusas_code = ? AND date IN ({placeholders})",
        [yusas_code, *dates],
    ).fetchall()
    filled = {r["date"] for r in rows if r["sales_qty"] is not None}
    return [d for d in dates if d not in filled]


async def _fetch_goods_sno_stats(client: AblyClient, goods_sno: str, date: str) -> list[dict]:
    response = await client.request(
        "GET", "/seller/statistics/goods/",
        params={
            "page": 1, "per_page": 100, "option_enable": "true",
            "keyword": goods_sno, "keyword_type": "goods_sno",
            "start_date": date, "end_date": date,
        },
        origin="my.a-bly.com",
    )
    if not response.is_success:
        raise RuntimeError(
            f"Ably 판매통계 조회 실패 (goods_sno={goods_sno}, date={date}, HTTP {response.status_code})"
        )
    data = response.json()
    statistics = (data.get("results") or {}).get("statistics") or []
    if not statistics:
        return []
    return statistics[0].get("goods_options") or []


async def collect_ably_sales_history(get_db, user: str = "_default") -> int:
    goods_sno_map = load_wonbe_goods_sno_map()
    dates = _backfill_date_range(today_kst())

    conn = get_db()
    try:
        # (goods_sno, date, option_to_code) 단위 호출 목록을 미리 만들어서
        # 진행률의 total(=API 호출 예정 횟수)을 안다. 같은 goods_sno는 한 번만
        # option_to_code로 묶고, 실제 (goods_sno, date) 조합마다 한 번씩 호출한다.
        calls: list[tuple[str, str, dict[str, str]]] = []
        for goods_sno, options in goods_sno_map.items():
            option_to_code = {sno: code for sno, code in options}
            missing: set[str] = set()
            for _sno, yusas_code in options:
                missing.update(_missing_dates(conn, yusas_code, dates))
            for date in sorted(missing):
                calls.append((goods_sno, date, option_to_code))

        progress = {"running": True, "total": len(calls), "done": 0, "updated": 0}
        _sales_history_progress[user] = progress

        client = AblyClient()
        semaphore = asyncio.Semaphore(FETCH_CONCURRENCY)
        updated = 0

        async def _run_one(goods_sno: str, date: str, option_to_code: dict[str, str]) -> None:
            nonlocal updated
            # 세마포어는 네트워크 호출(느린 부분)만 감싼다 — DB 쓰기는 로컬이라 빠르고,
            # 동시에 여러 개가 기다려도 상관없다. 이렇게 네트워크 대기 중에 이벤트루프가
            # 자유로워져서 진행률 폴링 같은 다른 요청도 그 사이 처리된다.
            async with semaphore:
                try:
                    goods_options = await _fetch_goods_sno_stats(client, goods_sno, date)
                except Exception:
                    # 네트워크 순단 등으로 이 (goods_sno, date) 하나가 실패해도 asyncio.gather
                    # 전체를 죽이지 않는다 — 갭필 구조라 다음 실행 때 이 날짜만 자동 재시도된다.
                    print(f"[sales-history] fetch failed goods_sno={goods_sno} date={date}", file=sys.stderr)
                    traceback.print_exc(file=sys.stderr)
                    progress["done"] += 1
                    return
            try:
                for opt in goods_options:
                    sno = str(opt.get("goods_option_sno") or "")
                    yusas_code = option_to_code.get(sno)
                    if yusas_code is None:
                        continue
                    ensure_row(conn, date, yusas_code)
                    conn.execute(
                        "UPDATE order_recommendation_daily SET sales_qty = ?, cart_count = ? "
                        "WHERE date = ? AND yusas_code = ?",
                        (int(opt.get("order_count") or 0), int(opt.get("cart_count") or 0), date, yusas_code),
                    )
                    updated += 1
                conn.commit()
            except Exception:
                # DB 쓰기 실패도 마찬가지로 이 한 건만 건너뛰고 전체 수집은 계속한다.
                print(f"[sales-history] write failed goods_sno={goods_sno} date={date}", file=sys.stderr)
                traceback.print_exc(file=sys.stderr)
            progress["done"] += 1
            progress["updated"] = updated

        try:
            await asyncio.gather(*[_run_one(goods_sno, date, option_to_code) for goods_sno, date, option_to_code in calls])
        finally:
            progress["running"] = False
    finally:
        conn.close()
    return updated
