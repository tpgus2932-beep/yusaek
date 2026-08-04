from __future__ import annotations

import asyncio
import sys
import traceback
from datetime import datetime, timedelta

from api.wonbe_routes import load_wonbe_goods_sno_map, load_wonbe_registered_at_map
from sdk.ably import AblyClient
from services.order_recommendation_store import ensure_row, today_kst

BACKFILL_DAYS = 28
FETCH_CONCURRENCY = 8
RETRY_CONCURRENCY = 2

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
    registered_at_map = load_wonbe_registered_at_map()
    dates = _backfill_date_range(today_kst())

    conn = get_db()
    try:
        # (goods_sno, date, option_to_code) 단위 호출 목록을 미리 만들어서
        # 진행률의 total(=API 호출 예정 횟수)을 안다. 같은 goods_sno는 한 번만
        # option_to_code로 묶고, 실제 (goods_sno, date) 조합마다 한 번씩 호출한다.
        calls: list[tuple[str, str, dict[str, list[str]]]] = []
        for goods_sno, options in goods_sno_map.items():
            # 같은 에이블리 옵션번호가 서로 다른 상품코드 여러 개에 매핑되는 경우가 있어
            # (예: 세트/번들 구성으로 같은 옵션을 공유) sno -> code 단일 매핑으로 만들면
            # 뒤의 코드가 앞의 코드를 덮어써서 한쪽이 영원히 통계를 못 받는다. 리스트로 묶는다.
            option_to_code: dict[str, list[str]] = {}
            for sno, code in options:
                option_to_code.setdefault(sno, []).append(code)

            # 상품 등록일 이전 날짜는 애초에 존재하지 않았던 기간이므로 백필 대상에서
            # 제외한다 — 안 그러면 에이블리가 그 날짜에 통계를 안 주는 걸 "활동 0건"으로
            # 착각해서 sales_qty=0을 채워버려(_run_one 아래쪽 분기), 신상품 예측이 왜곡된다.
            registered_dates = [registered_at_map[code] for _sno, code in options if code in registered_at_map]
            earliest_registered = min(registered_dates) if registered_dates else None
            allowed_dates = [d for d in dates if earliest_registered is None or d >= earliest_registered]

            missing: set[str] = set()
            for _sno, yusas_code in options:
                missing.update(_missing_dates(conn, yusas_code, allowed_dates))
            for date in sorted(missing):
                calls.append((goods_sno, date, option_to_code))

        progress = {"running": True, "total": len(calls), "done": 0, "updated": 0}
        _sales_history_progress[user] = progress

        client = AblyClient()
        updated = 0

        async def _run_one(sem: asyncio.Semaphore, goods_sno: str, date: str, option_to_code: dict[str, list[str]]) -> bool:
            nonlocal updated
            # 세마포어는 네트워크 호출(느린 부분)만 감싼다 — DB 쓰기는 로컬이라 빠르고,
            # 동시에 여러 개가 기다려도 상관없다. 이렇게 네트워크 대기 중에 이벤트루프가
            # 자유로워져서 진행률 폴링 같은 다른 요청도 그 사이 처리된다.
            async with sem:
                try:
                    goods_options = await _fetch_goods_sno_stats(client, goods_sno, date)
                except Exception:
                    # 네트워크 순단/Ably 레이트리밋 등으로 이 (goods_sno, date) 하나가 실패해도
                    # asyncio.gather 전체를 죽이지 않는다 — 실패한 건은 호출측에서 동시성을
                    # 낮춰 재시도하고, 그래도 안 되면 다음 실행 때 자동 재시도된다.
                    print(f"[sales-history] fetch failed goods_sno={goods_sno} date={date}", file=sys.stderr)
                    traceback.print_exc(file=sys.stderr)
                    return False
            try:
                returned_snos: set[str] = set()
                for opt in goods_options:
                    sno = str(opt.get("goods_option_sno") or "")
                    returned_snos.add(sno)
                    yusas_codes = option_to_code.get(sno)
                    if yusas_codes is None:
                        continue
                    for yusas_code in yusas_codes:
                        ensure_row(conn, date, yusas_code)
                        conn.execute(
                            "UPDATE order_recommendation_daily SET sales_qty = ?, cart_count = ? "
                            "WHERE date = ? AND yusas_code = ?",
                            (int(opt.get("order_count") or 0), int(opt.get("cart_count") or 0), date, yusas_code),
                        )
                        updated += 1
                # Ably는 그날 주문/장바구니 활동이 전혀 없는 옵션을 응답에서 통째로
                # 생략한다. 매핑된 옵션인데 응답에 없으면 활동이 0이었다는 뜻이므로
                # 명시적으로 0을 채운다 — 안 그러면 sales_qty가 계속 NULL로 남아
                # _missing_dates가 영원히 이 (goods_sno, date)를 다시 조회 대상으로 잡는다.
                for sno, yusas_codes in option_to_code.items():
                    if sno in returned_snos:
                        continue
                    for yusas_code in yusas_codes:
                        ensure_row(conn, date, yusas_code)
                        conn.execute(
                            "UPDATE order_recommendation_daily SET sales_qty = COALESCE(sales_qty, 0), "
                            "cart_count = COALESCE(cart_count, 0) WHERE date = ? AND yusas_code = ?",
                            (date, yusas_code),
                        )
                        updated += 1
                conn.commit()
            except Exception:
                # DB 쓰기 실패도 마찬가지로 이 한 건만 건너뛰고 전체 수집은 계속한다.
                print(f"[sales-history] write failed goods_sno={goods_sno} date={date}", file=sys.stderr)
                traceback.print_exc(file=sys.stderr)
            progress["updated"] = updated
            return True

        async def _run_pass(sem: asyncio.Semaphore, batch: list[tuple[str, str, dict[str, list[str]]]], *, count_done: bool) -> list[tuple[str, str, dict[str, list[str]]]]:
            oks = await asyncio.gather(*[_run_one(sem, goods_sno, date, option_to_code) for goods_sno, date, option_to_code in batch])
            # done은 total(=1차 호출 목록 크기) 기준이므로 재시도 패스에서는 다시 세지 않는다 —
            # 안 그러면 progress.done이 total을 넘어가 진행률 표시가 깨진다.
            if count_done:
                progress["done"] += len(batch)
            progress["updated"] = updated
            return [call for call, ok in zip(batch, oks) if not ok]

        try:
            failed = await _run_pass(asyncio.Semaphore(FETCH_CONCURRENCY), calls, count_done=True)
            if failed:
                # 1차 시도에서 실패한 건은 Ably 쪽 순간 레이트리밋/타임아웃일 가능성이 높으므로
                # 동시성을 낮춰(FETCH_CONCURRENCY -> RETRY_CONCURRENCY) 다시 시도한다.
                print(f"[sales-history] retrying {len(failed)} failed call(s) at concurrency={RETRY_CONCURRENCY}", file=sys.stderr)
                await _run_pass(asyncio.Semaphore(RETRY_CONCURRENCY), failed, count_done=False)
        finally:
            progress["running"] = False
    finally:
        conn.close()
    return updated
