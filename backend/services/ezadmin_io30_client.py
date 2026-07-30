from __future__ import annotations

import re
from datetime import datetime, timedelta

from sdk import config
from sdk.ezadmin import EzAdminClient

_MAX_PAGES = 20
_PAGE_ROWS = 1000


def ez_val(html_value) -> str:
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


def to_int(value, default: int = 0) -> int:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


def _io30_par(shop_par_fragment: str, start_date: str, end_date: str) -> str:
    return (
        "template=IO30&action=&page_code=IO00&search=1&now_page=&is_sort=&"
        "_sort=supply_options&sort_order=1&product_qty_list=&bill_seq=&"
        "offset_top=&work_no=&location_str=&date_type=collect_date&"
        f"start_date={start_date}&start_hour=00%3A00%3A00&"
        f"end_date={end_date}&end_hour=23%3A59%3A59&"
        f"date_period_sel=9&{shop_par_fragment}&"
        "multi_supply_group=&multi_supply=&str_supply_code=0&"
        "supply_name_search=&brand=&supply_options=&tags_string=&"
        "product_tag_include_type=1&product_id=&name=&options=&"
        "search_keyword_type=origin&search_keyword=&enable_stock_type=2&"
        "order_status=3&except_soldout=1&sel_reserve_qty=none&"
        "sel_return_qty=none&sel_lack_qty=none&sel_req_qty=none&category=0"
    )


async def fetch_io30_rows(get_setting, *, shop_par_fragment: str) -> list[dict]:
    """EZAdmin IO30을 shop_par_fragment(예:
    "multi_shop_group=&multi_shop=&str_shop_code=10028") 필터로 페이지네이션
    조회해서 각 행의 cell 딕셔너리 리스트를 그대로 반환한다(컬럼 매핑은
    호출부 책임). PHPSESSID 미설정/세션 만료 시 EzAdminSessionExpired가
    그대로 전파된다."""
    client = EzAdminClient(get_setting)
    today = datetime.now()
    start = (today - timedelta(days=90)).strftime("%Y-%m-%d")
    end = today.strftime("%Y-%m-%d")
    par = _io30_par(shop_par_fragment, start, end)
    referer_headers = {"Referer": f"{config.EZADMIN_BASE}/template40.htm?template=IO30"}

    rows: list[dict] = []
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
            rows.append(row.get("cell", row))

        total_pages = int(data.get("total") or 1)
        if page >= total_pages or page >= _MAX_PAGES:
            break
        page += 1

    return rows
