from __future__ import annotations

import urllib.parse
from datetime import datetime

import httpx

_EZADMIN_BASE = "https://ga80.ezadmin.co.kr"
_MAX_PAGES = 40


async def fetch_ezadmin_stock_logs(
    phpsessid: str,
    product_id: str,
    start_date: str,
    end_date: str,
) -> list[dict] | None:
    """EZAdmin 재고내역(I100 get_tx_history)을 상품코드/기간으로 전부 가져온다.

    세션이 만료돼 JSON이 아닌 응답이 오면 None을 반환한다."""
    par = urllib.parse.urlencode({
        "product_id": product_id, "start_date": start_date, "end_date": end_date,
        "date_period_sel": "9", "show_trans": "1", "stock_type": "0", "work_type": "0",
    })
    logs: list[dict] = []
    page, total_pages = 1, 1
    async with httpx.AsyncClient(timeout=20.0, verify=False, follow_redirects=True) as client:
        while page <= total_pages and page <= _MAX_PAGES:
            r = await client.get(
                f"{_EZADMIN_BASE}/function.htm",
                params={
                    "_search": "false", "nd": str(int(datetime.now().timestamp() * 1000)),
                    "rows": "100", "page": str(page), "sidx": "", "sord": "asc",
                    "template": "I100", "action": "get_tx_history", "par": par,
                },
                headers={"X-Requested-With": "XMLHttpRequest", "Accept": "application/json, text/javascript, */*"},
                cookies={"PHPSESSID": phpsessid},
            )
            try:
                obj = r.json()
            except Exception:
                return None
            if "rows" not in obj:
                return None
            for row in obj.get("rows", []):
                c = row.get("cell") or {}
                logs.append({
                    "일시": c.get("col1") or "",
                    "상태": c.get("col2") or "",
                    "구분": c.get("col3") or "",
                    "수량": c.get("col4") or "",
                    "재고": c.get("col5") or "",
                    "수령자": c.get("recv_name") or "",
                    "주문자": c.get("order_name") or "",
                    "사유": c.get("col8") or "",
                })
            total_pages = int(obj.get("total") or 1)
            page += 1
    return logs
