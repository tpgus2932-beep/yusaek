from __future__ import annotations

import re
import time
from datetime import datetime, timedelta

from sdk import config
from sdk.ezadmin import EzAdminClient

_CACHE_TTL_SECONDS = 30
_ABLY_SHOP_CODE = "10028"
_MAX_PAGES = 20
_PAGE_ROWS = 1000

_cache: dict[str, tuple[float, dict[str, dict]]] = {}


def _ez_val(html_value) -> str:
    """EZAdmin 셀 값에서 실값을 뽑아낸다: <input value='X'> → X, <a>X</a> → X,
    태그 없으면 그대로. order_routes.py의 동일 로직(로컬 클로저라 임포트
    불가)을 여기 독립적으로 재구현한 것."""
    s = str(html_value or "")
    m = re.search(r"<input[^>]+\bvalue=['\"]([^'\"]*)['\"]", s, re.IGNORECASE)
    if m:
        return m.group(1)
    m = re.search(r">([^<]+)</a>", s)
    if m:
        return m.group(1).strip()
    return re.sub(r"<[^>]+>", "", s).strip()


def _to_int(value, default: int = 0) -> int:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


def _io30_par(start_date: str, end_date: str) -> str:
    return (
        "template=IO30&action=&page_code=IO00&search=1&now_page=&is_sort=&"
        "_sort=supply_options&sort_order=1&product_qty_list=&bill_seq=&"
        "offset_top=&work_no=&location_str=&date_type=collect_date&"
        f"start_date={start_date}&start_hour=00%3A00%3A00&"
        f"end_date={end_date}&end_hour=23%3A59%3A59&"
        f"date_period_sel=9&multi_shop_group=&multi_shop=&str_shop_code={_ABLY_SHOP_CODE}&"
        "multi_supply_group=&multi_supply=&str_supply_code=0&"
        "supply_name_search=&brand=&supply_options=&tags_string=&"
        "product_tag_include_type=1&product_id=&name=&options=&"
        "search_keyword_type=origin&search_keyword=&enable_stock_type=2&"
        "order_status=3&except_soldout=1&sel_reserve_qty=none&"
        "sel_return_qty=none&sel_lack_qty=none&sel_req_qty=none&category=0"
    )


async def _fetch_ably_io30_snapshot(get_setting, date: str) -> dict[str, dict]:
    """EZAdmin IO30(에이블리 채널, str_shop_code=10028)을 조회해
    {product_id: {"stock_qty", "incoming_qty", "ezadmin_lack_qty"}}로 반환한다.
    같은 date로 _CACHE_TTL_SECONDS 안에 재호출되면 캐시를 재사용한다.
    PHPSESSID 미설정/세션 만료 시 EzAdminSessionExpired가 그대로 전파된다
    (실패한 조회는 캐시하지 않음)."""
    cached = _cache.get(date)
    now = time.monotonic()
    if cached is not None and (now - cached[0]) < _CACHE_TTL_SECONDS:
        return cached[1]

    client = EzAdminClient(get_setting)
    today = datetime.now()
    start = (today - timedelta(days=90)).strftime("%Y-%m-%d")
    end = today.strftime("%Y-%m-%d")
    par = _io30_par(start, end)
    referer_headers = {"Referer": f"{config.EZADMIN_BASE}/template40.htm?template=IO30"}

    snapshot: dict[str, dict] = {}
    page = 1
    while True:
        nd = str(int(datetime.now().timestamp() * 1000))
        data = await client.post(
            "IO30", "search_IO30",
            data={"_search": "false", "nd": nd, "rows": str(_PAGE_ROWS), "page": str(page), "sidx": "", "sord": "asc"},
            par=par,
            time_flag=None,
            extra_headers=referer_headers,
        )
        for row in data.get("rows") or []:
            cell = row.get("cell", row)
            product_id = _ez_val(cell.get("product_id")).strip()
            if not product_id:
                continue
            snapshot[product_id] = {
                "stock_qty": _to_int(_ez_val(cell.get("stock"))),
                "incoming_qty": _to_int(_ez_val(cell.get("not_yet_deliv"))),
                "ezadmin_lack_qty": _to_int(_ez_val(cell.get("lack_qty"))),
            }

        total_pages = int(data.get("total") or 1)
        if page >= total_pages or page >= _MAX_PAGES:
            break
        page += 1

    _cache[date] = (now, snapshot)
    return snapshot


def build_ezadmin_collectors(get_setting) -> dict:
    async def _collect_column(column: str, date: str) -> dict:
        snapshot = await _fetch_ably_io30_snapshot(get_setting, date)
        return {code: values[column] for code, values in snapshot.items()}

    async def collect_stock_qty(date: str) -> dict:
        return await _collect_column("stock_qty", date)

    async def collect_incoming_qty(date: str) -> dict:
        return await _collect_column("incoming_qty", date)

    async def collect_ezadmin_lack_qty(date: str) -> dict:
        return await _collect_column("ezadmin_lack_qty", date)

    return {
        "stock_qty": collect_stock_qty,
        "incoming_qty": collect_incoming_qty,
        "ezadmin_lack_qty": collect_ezadmin_lack_qty,
    }
