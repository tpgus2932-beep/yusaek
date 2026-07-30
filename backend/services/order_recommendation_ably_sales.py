from __future__ import annotations

from datetime import datetime, timedelta

from api.wonbe_routes import load_wonbe_goods_sno_map
from sdk.ably import AblyClient
from services.order_recommendation_store import ensure_row, today_kst

BACKFILL_DAYS = 28


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
    options: list[dict] = []
    page = 1
    while True:
        response = await client.request(
            "GET", "/seller/business-insight/market-performance/option-stats-options/",
            params={
                "goods_sno": goods_sno, "start_date": date, "end_date": date,
                "page": page, "per_page": 100,
                "sort_key": "sold_quantity", "sort_order": "desc",
            },
        )
        if not response.is_success:
            raise RuntimeError(
                f"Ably 판매통계 조회 실패 (goods_sno={goods_sno}, date={date}, HTTP {response.status_code})"
            )
        data = response.json()
        options.extend(data.get("options") or [])

        max_page = data.get("max_page_number") or 1
        current_page = data.get("current_page") or page
        if current_page >= max_page:
            break
        page += 1

    return options


async def collect_ably_sales_history(get_db) -> int:
    goods_sno_map = load_wonbe_goods_sno_map()
    dates = _backfill_date_range(today_kst())

    conn = get_db()
    try:
        client = AblyClient()
        updated = 0
        for goods_sno, options in goods_sno_map.items():
            option_to_code = {sno: code for sno, code in options}
            missing: set[str] = set()
            for _sno, yusas_code in options:
                missing.update(_missing_dates(conn, yusas_code, dates))

            for date in sorted(missing):
                goods_options = await _fetch_goods_sno_stats(client, goods_sno, date)
                for opt in goods_options:
                    sno = str(opt.get("goods_option_sno") or "")
                    yusas_code = option_to_code.get(sno)
                    if yusas_code is None:
                        continue
                    ensure_row(conn, date, yusas_code)
                    conn.execute(
                        "UPDATE order_recommendation_daily SET sales_qty = ?, cart_count = ? "
                        "WHERE date = ? AND yusas_code = ?",
                        (int(opt.get("sold_quantity") or 0), int(opt.get("cart_count") or 0), date, yusas_code),
                    )
                    updated += 1
                conn.commit()
    finally:
        conn.close()
    return updated
