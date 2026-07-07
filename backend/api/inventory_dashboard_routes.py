from __future__ import annotations

from datetime import datetime

import httpx
from fastapi import APIRouter, Depends, HTTPException

_EZADMIN_BASE = "https://ga80.ezadmin.co.kr"
_EZADMIN_SESSION_KEY = "ezadmin_phpsessid"


def build_inventory_dashboard_router(
    *,
    get_current_user,
    get_setting,
    normalize_to_yusas,
    get_shared_incoming_counts,
):
    router = APIRouter(prefix="/inventory-dashboard", tags=["inventory-dashboard"])

    @router.post("/today-stock-check")
    async def today_stock_check(user: str = Depends(get_current_user)):
        phpsessid = (get_setting(_EZADMIN_SESSION_KEY) or "").strip()
        if not phpsessid:
            return {"ok": False, "need_session": True}

        today = datetime.now().strftime("%Y-%m-%d")
        par = (
            "auto_search=&search_all_product=&multi_supply_group=&multi_supply=&str_supply_code=0"
            "&tags_string=&product_tag_include_type=1&query_type=name&query_str="
            "&stock_type=0&stock_start=1&stock_end=&notrans_day=&notrans_cnt=&notrans_status=0&stock_status=0"
            f"&start_date={today}&start_hour=00%3A00%3A00&end_date={today}&end_hour=23%3A59%3A59"
            "&date_period_sel=0&work_type=stockin&work_start=&work_end=&inout_type=0&product_date="
            f"&start_date2={today}&end_date2={today}&date_period_sel2=0"
            "&products_sort=1&category=0&except_soldout=0&temp_soldout=0&location=0"
        )

        cookies = {"PHPSESSID": phpsessid}
        try:
            async with httpx.AsyncClient(timeout=30.0, verify=False, follow_redirects=True) as client:
                r = await client.post(
                    f"{_EZADMIN_BASE}/function.htm",
                    data={
                        "template": "BX00",
                        "action": "add_option",
                        "par": par,
                        "page_code": "I100",
                        "is_auto": "1",
                    },
                    cookies=cookies,
                    headers={"X-Requested-With": "XMLHttpRequest"},
                )
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"이지어드민 연결 실패: {exc}")

        try:
            obj = r.json()
        except Exception:
            return {"ok": False, "need_session": True}

        if not isinstance(obj, dict) or "rows" not in obj:
            # 세션 만료(HTML 로그인 페이지) 또는 예상과 다른 응답 형태
            # 실 사용 중 필드명 확인용으로 원본 응답 일부를 함께 반환한다.
            return {"ok": False, "need_session": True, "raw_preview": str(obj)[:1000]}

        incoming_counts = get_shared_incoming_counts() or {}

        matched = []
        for row in obj.get("rows", []):
            cell = row.get("cell", {}) or {}
            raw_code = (
                cell.get("key")
                or cell.get("product_id")
                or cell.get("code")
                or cell.get("product_code")
                or ""
            )
            code = normalize_to_yusas(raw_code) or str(raw_code).strip()
            if not code or code not in incoming_counts:
                continue
            matched.append({
                "code": code,
                "productName": cell.get("product_name") or cell.get("name") or "",
                "stockQty": cell.get("stock") or cell.get("stock_qty") or cell.get("cnt") or "",
                "incomingQty": incoming_counts.get(code, 0),
                "raw": cell,
            })

        return {
            "ok": True,
            "date": today,
            "total_rows": len(obj.get("rows", [])),
            "incoming_codes": len(incoming_counts),
            "matched": matched,
        }

    return router
