from __future__ import annotations

import json
import time
from datetime import datetime, timedelta

import httpx
from fastapi import APIRouter, Body, Depends, HTTPException

ABLY_BASE = "https://api.a-bly.com"
LLOGIS_LOGIN_URL = "https://partner.alps.llogis.com/auth/login"
LLOGIS_BASE = "https://pid.alps.llogis.com:18210"

ABLY_EMAIL = "eostm1997@naver.com"
ABLY_PASSWORD = "!Glqgkqdldi1126"

LLOGIS_PRINCIPAL = "331595"
LLOGIS_CREDENTIAL = "plan123!"
LLOGIS_EMP_NO = "331595"

LLOGIS_COURIER_SNO = 5  # 롯데택배


def build_exchange_return_router(*, get_current_user):
    router = APIRouter(prefix="/exchange-return")

    def _ably_headers(token: str) -> dict:
        return {
            "Authorization": f"JWT {token}",
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Origin": "https://seller-admin.a-bly.com",
            "Referer": "https://seller-admin.a-bly.com/",
            "User-Agent": "Mozilla/5.0",
        }

    async def _ably_login() -> str:
        async with httpx.AsyncClient(timeout=15.0) as client:
            res = await client.post(
                f"{ABLY_BASE}/seller/login/",
                json={"email": ABLY_EMAIL, "password": ABLY_PASSWORD},
                headers={
                    "Content-Type": "application/json",
                    "Origin": "https://seller-admin.a-bly.com",
                    "Referer": "https://seller-admin.a-bly.com/",
                    "User-Agent": "Mozilla/5.0",
                },
            )
            res.raise_for_status()
        token = res.json().get("token")
        if not token:
            raise HTTPException(status_code=502, detail="에이블리 로그인 실패")
        return token

    async def _llogis_login() -> str:
        async with httpx.AsyncClient(timeout=15.0, verify=False) as client:
            res = await client.post(
                LLOGIS_LOGIN_URL,
                json={
                    "principal": LLOGIS_PRINCIPAL,
                    "credential": LLOGIS_CREDENTIAL,
                    "macAddress": "normal-browser",
                },
                headers={
                    "Content-Type": "application/json",
                    "Origin": "https://partner.alps.llogis.com",
                    "Referer": "https://partner.alps.llogis.com/",
                    "User-Agent": "Mozilla/5.0",
                },
            )
            res.raise_for_status()
        token = res.json().get("accessToken")
        if not token:
            raise HTTPException(status_code=502, detail="llogis 로그인 실패")
        return token

    async def _llogis_query_status(inv_no: str, llogis_token: str) -> dict:
        url = f"{LLOGIS_BASE}/pid/ftr/pacltrc/inner/bcraiinvinfo"
        params = {
            "filter": json.dumps(
                {
                    "srchInvNo": inv_no,
                    "blngBrshCd": None,
                    "empno": LLOGIS_EMP_NO,
                    "usrId": LLOGIS_EMP_NO,
                    "currPageId": "PIDFTR001U",
                    "crdFarePrntStat": "N",
                    "srchOrgInvNo": "",
                },
                ensure_ascii=False,
            ),
            "_": str(int(time.time() * 1000)),
        }
        headers = {
            "Accept": "application/json, text/javascript, */*; q=0.01",
            "Authorization": llogis_token,
            "Content-Type": "application/json",
            "Host": "pid.alps.llogis.com:18210",
            "Menulink": json.dumps({
                "menuId": "21966",
                "pgmId": "100001378",
                "pgmUrl": f"{LLOGIS_BASE}/pid/pages/ftr/PIDFTR051U",
            }),
            "Referer": f"{LLOGIS_BASE}/pid/pages/ftr/PIDFTR051U",
            "X-Requested-With": "XMLHttpRequest",
            "User-Agent": "Mozilla/5.0",
        }
        async with httpx.AsyncClient(timeout=20.0, verify=False) as client:
            res = await client.get(url, params=params, headers=headers)
        if res.status_code != 200:
            return {"llogis_status": "-", "llogis_location": "-", "llogis_scan_date": "-"}
        data = res.json()
        mvm = data.get("mvmList") or []
        latest = mvm[-1] if mvm else {}
        return {
            "llogis_status": latest.get("paclStatNm") or "-",
            "llogis_location": latest.get("scanBrshNm") or "-",
            "llogis_scan_date": latest.get("rgstYmd") or "-",
        }

    async def _llogis_get_return_invoice(origin_inv: str, llogis_token: str) -> str | None:
        url = f"{LLOGIS_BASE}/pid/ftr/pacltrc/inner/bcraiinvinfo"
        params = {
            "filter": json.dumps(
                {
                    "srchInvNo": origin_inv,
                    "blngBrshCd": None,
                    "empno": LLOGIS_EMP_NO,
                    "usrId": LLOGIS_EMP_NO,
                    "currPageId": "PIDFTR001U",
                    "crdFarePrntStat": "N",
                    "srchOrgInvNo": "",
                },
                ensure_ascii=False,
            ),
            "_": str(int(time.time() * 1000)),
        }
        headers = {
            "Accept": "application/json, text/javascript, */*; q=0.01",
            "Authorization": llogis_token,
            "Content-Type": "application/json",
            "Host": "pid.alps.llogis.com:18210",
            "Menulink": json.dumps({
                "menuId": "21966",
                "pgmId": "100001378",
                "pgmUrl": f"{LLOGIS_BASE}/pid/pages/ftr/PIDFTR051U",
            }),
            "Referer": f"{LLOGIS_BASE}/pid/pages/ftr/PIDFTR051U",
            "X-Requested-With": "XMLHttpRequest",
            "User-Agent": "Mozilla/5.0",
            "sec-fetch-dest": "empty",
            "sec-fetch-mode": "cors",
            "sec-fetch-site": "same-origin",
        }
        async with httpx.AsyncClient(timeout=20.0, verify=False) as client:
            res = await client.get(url, params=params, headers=headers)
            if res.status_code != 200:
                return None
        rtn_list = [
            r for r in res.json().get("rltnInvList", [])
            if r.get("wkSctCd") == "02"
        ]
        return rtn_list[0].get("rltnInvNo") if rtn_list else None

    @router.get("/list")
    async def get_exchange_list(
        start_date: str = None,
        end_date: str = None,
        user=Depends(get_current_user),
    ):
        if not end_date:
            end_date = datetime.today().strftime("%Y-%m-%d")
        if not start_date:
            start_date = (datetime.today() - timedelta(days=30)).strftime("%Y-%m-%d")

        try:
            token = await _ably_login()
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"에이블리 로그인 실패: {e}")

        all_items = []
        page = 1

        async with httpx.AsyncClient(timeout=30.0) as client:
            while True:
                res = await client.get(
                    f"{ABLY_BASE}/seller/exchanges/",
                    headers=_ably_headers(token),
                    params={
                        "page": page,
                        "per_page": 30,
                        "requested_at_start": f"{start_date} 00:00:00",
                        "requested_at_end": f"{end_date} 23:59:59",
                        "status[]": 3,
                    },
                )
                res.raise_for_status()
                data = res.json()
                exchanges = data.get("exchanges", [])
                if not exchanges:
                    break

                for ex in exchanges:
                    rd = ex.get("return_delivery") or {}
                    if rd.get("invoice_number"):
                        continue  # 이미 반품송장 등록됨
                    items_list = ex.get("exchange_items") or []
                    if not items_list:
                        continue
                    first = items_list[0]
                    order_item = first.get("order_item") or {}
                    all_items.append({
                        "exchange_sno": ex.get("exchange_sno") or ex.get("sno"),
                        "order_item_sno": first.get("order_item_sno"),
                        "goods_name": order_item.get("goods_name") or first.get("goods_name"),
                        "option_info": order_item.get("option_info") or first.get("option_info"),
                        "member_name": (ex.get("member") or {}).get("name"),
                        "requested_at": ex.get("requested_at"),
                    })

                if page >= data.get("max_page_number", 1):
                    break
                page += 1

        return {"items": all_items, "total": len(all_items)}

    @router.get("/registered")
    async def list_registered(
        start_date: str = None,
        end_date: str = None,
        user=Depends(get_current_user),
    ):
        if not end_date:
            end_date = datetime.today().strftime("%Y-%m-%d")
        if not start_date:
            start_date = (datetime.today() - timedelta(days=30)).strftime("%Y-%m-%d")

        try:
            ably_token = await _ably_login()
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"에이블리 로그인 실패: {e}")

        registered = []
        page = 1
        async with httpx.AsyncClient(timeout=30.0) as client:
            while True:
                res = await client.get(
                    f"{ABLY_BASE}/seller/exchanges/",
                    headers=_ably_headers(ably_token),
                    params={
                        "page": page,
                        "per_page": 30,
                        "requested_at_start": f"{start_date} 00:00:00",
                        "requested_at_end": f"{end_date} 23:59:59",
                        "status[]": 3,
                    },
                )
                res.raise_for_status()
                data = res.json()
                exchanges = data.get("exchanges", [])
                if not exchanges:
                    break
                for ex in exchanges:
                    rd = ex.get("return_delivery") or {}
                    if not rd.get("invoice_number"):
                        continue
                    items_list = ex.get("exchange_items") or []
                    first = items_list[0] if items_list else {}
                    order_item = first.get("order_item") or {}
                    registered.append({
                        "exchange_sno": ex.get("exchange_sno") or ex.get("sno"),
                        "goods_name": order_item.get("goods_name") or first.get("goods_name") or "",
                        "option_info": order_item.get("option_info") or first.get("option_info") or "",
                        "member_name": (ex.get("member") or {}).get("name") or "",
                        "requested_at": ex.get("requested_at") or "",
                        "return_invoice": rd["invoice_number"],
                    })
                if page >= data.get("max_page_number", 1):
                    break
                page += 1

        if not registered:
            return {"items": []}

        try:
            llogis_token = await _llogis_login()
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"llogis 로그인 실패: {e}")

        results = []
        for item in registered:
            try:
                status = await _llogis_query_status(item["return_invoice"], llogis_token)
                item.update(status)
            except Exception as e:
                item.update({
                    "llogis_status": "-",
                    "llogis_location": "-",
                    "llogis_scan_date": str(e)[:80],
                })
            results.append(item)

        return {"items": results}

    @router.post("/process-one")
    async def process_one(
        exchange_sno: int = Body(...),
        order_item_sno: int = Body(...),
        user=Depends(get_current_user),
    ):
        try:
            ably_token = await _ably_login()
            llogis_token = await _llogis_login()

            # ① 원송장번호 조회
            async with httpx.AsyncClient(timeout=15.0) as client:
                res = await client.get(
                    f"{ABLY_BASE}/seller/order_items/{order_item_sno}/",
                    headers=_ably_headers(ably_token),
                )
            if res.status_code != 200:
                return {"ok": False, "skipped": False, "error": f"원송장 조회 실패 (HTTP {res.status_code})"}

            origin_invoice = (res.json().get("order_item") or {}).get("invoice")
            if not origin_invoice:
                return {"ok": False, "skipped": True, "origin_invoice": None, "return_invoice": None, "error": "원송장번호 없음"}

            # ② llogis → 반품송장번호
            return_invoice = await _llogis_get_return_invoice(origin_invoice, llogis_token)
            if not return_invoice:
                return {"ok": False, "skipped": True, "origin_invoice": origin_invoice, "return_invoice": None, "error": "llogis 반품송장 없음"}

            # ③ 에이블리에 반품송장 등록
            async with httpx.AsyncClient(timeout=15.0) as client:
                res = await client.put(
                    f"{ABLY_BASE}/seller/exchanges/{exchange_sno}/return-delivery-tracking/",
                    headers=_ably_headers(ably_token),
                    json={"delivery_sno": LLOGIS_COURIER_SNO, "invoice": return_invoice},
                )

            if res.status_code == 204:
                return {"ok": True, "skipped": False, "origin_invoice": origin_invoice, "return_invoice": return_invoice, "error": None}
            else:
                body = res.text[:200]
                return {"ok": False, "skipped": False, "origin_invoice": origin_invoice, "return_invoice": return_invoice, "error": f"등록 실패 (HTTP {res.status_code}): {body}"}

        except Exception as e:
            return {"ok": False, "skipped": False, "error": str(e)}

    return router
