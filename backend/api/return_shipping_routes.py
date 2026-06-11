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

_CANCEL_REASON = {
    30: "단순변심",
    31: "사이즈/색상 불만족",
    32: "상품 하자/오배송",
    1: "셀러 변경",
}


def build_return_shipping_router(*, get_current_user):
    router = APIRouter(prefix="/return-shipping")

    async def _ably_login() -> str:
        async with httpx.AsyncClient(timeout=15.0) as client:
            res = await client.post(
                f"{ABLY_BASE}/seller/login/",
                json={"email": ABLY_EMAIL, "password": ABLY_PASSWORD},
                headers={
                    "Content-Type": "application/json",
                    "User-Agent": "Mozilla/5.0",
                    "Referer": "https://seller.a-bly.com/",
                    "Origin": "https://seller.a-bly.com",
                },
            )
            res.raise_for_status()
        token = res.json().get("token")
        if not token:
            raise HTTPException(status_code=502, detail="에이블리 로그인 실패: 토큰 없음")
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
                    "User-Agent": "Mozilla/5.0",
                    "Referer": "https://partner.alps.llogis.com/",
                    "Origin": "https://partner.alps.llogis.com",
                },
            )
            res.raise_for_status()
        token = res.json().get("accessToken")
        if not token:
            raise HTTPException(status_code=502, detail="llogis 로그인 실패: 토큰 없음")
        return token

    async def _llogis_query(inv_no: str, token: str) -> dict:
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
            "Accept-Language": "ko-KR,ko;q=0.9",
            "Authorization": token,
            "Content-Type": "application/json",
            "Host": "pid.alps.llogis.com:18210",
            "Menulink": json.dumps(
                {
                    "menuId": "21966",
                    "pgmId": "100001378",
                    "pgmUrl": f"{LLOGIS_BASE}/pid/pages/ftr/PIDFTR051U",
                }
            ),
            "Referer": f"{LLOGIS_BASE}/pid/pages/ftr/PIDFTR051U",
            "X-Requested-With": "XMLHttpRequest",
            "User-Agent": "Mozilla/5.0",
            "sec-fetch-dest": "empty",
            "sec-fetch-mode": "cors",
            "sec-fetch-site": "same-origin",
        }
        async with httpx.AsyncClient(timeout=20.0, verify=False) as client:
            res = await client.get(url, params=params, headers=headers)
            res.raise_for_status()
        return res.json()

    @router.get("/ably-returns")
    async def get_ably_returns(
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

        headers = {
            "Authorization": f"JWT {token}",
            "Accept": "application/json",
            "User-Agent": "Mozilla/5.0",
            "Referer": "https://seller.a-bly.com/",
            "Origin": "https://seller.a-bly.com",
        }

        all_items = []
        page = 1
        async with httpx.AsyncClient(timeout=30.0) as client:
            while True:
                res = await client.get(
                    f"{ABLY_BASE}/seller/order_cancels/",
                    headers=headers,
                    params={
                        "cancel_type": "return",
                        "processing_sub_status[]": ["41", "42"],
                        "delivery_type[]": ["standard", "today", "combine", "reserved"],
                        "order": "cancel_received_at",
                        "page": page,
                        "per_page": 30,
                        "start_date": start_date,
                        "end_date": end_date,
                    },
                )
                res.raise_for_status()
                data = res.json()

                cancels = data.get("order_cancels", [])
                max_page = data.get("max_page_number", 1)

                if not cancels:
                    break

                for cancel in cancels:
                    return_delivery = cancel.get("return_delivery") or {}
                    for item in cancel.get("order_items", []):
                        reason_code = item.get("cancel_reason")
                        all_items.append(
                            {
                                "상품명": item.get("goods_name"),
                                "옵션": item.get("option_info"),
                                "주문번호": item.get("order_sno"),
                                "송장번호": item.get("invoice"),
                                "반품신청일시": item.get("cancel_received_at"),
                                "수취인명": item.get("receiver_name"),
                                "반품사유": _CANCEL_REASON.get(reason_code, f"기타({reason_code})"),
                                "고객메모": item.get("user_comment"),
                                "수거택배사": return_delivery.get("courier_name"),
                                "반품송장번호": return_delivery.get("invoice_number"),
                                "수거주소": return_delivery.get("address"),
                                "환불금액": item.get("refund_amount"),
                                "반품배송비": item.get("return_delivery_fee"),
                                "수량": item.get("ea") or 1,
                            }
                        )

                if page >= max_page:
                    break
                page += 1

        return {"items": all_items, "total": len(all_items)}

    @router.post("/llogis-check")
    async def check_llogis(
        invoice_nos: list[str] = Body(..., embed=True),
        user=Depends(get_current_user),
    ):
        if not invoice_nos:
            return {"results": {}}

        token = await _llogis_login()
        results = {}

        for inv_no in invoice_nos:
            inv_no = str(inv_no).strip()
            if not inv_no:
                continue
            try:
                data = await _llogis_query(inv_no, token)
                inv_info_list = data.get("invInfoList") or []
                mvm_list = data.get("mvmList") or []
                if not inv_info_list:
                    results[inv_no] = {
                        "status": "-",
                        "location": "-",
                        "scan_date": "-",
                        "error": "llogis에서 송장을 찾을 수 없음 (다른 택배사이거나 미등록 송장)",
                    }
                elif not mvm_list:
                    results[inv_no] = {
                        "status": "이동이력 없음",
                        "location": "-",
                        "scan_date": "-",
                        "error": None,
                    }
                else:
                    latest = mvm_list[-1]
                    results[inv_no] = {
                        "status": latest.get("paclStatNm") or "-",
                        "location": latest.get("scanBrshNm") or "-",
                        "scan_date": latest.get("rgstYmd") or "-",
                        "error": None,
                    }
            except Exception as e:
                results[inv_no] = {
                    "status": "-",
                    "location": "-",
                    "scan_date": "-",
                    "error": str(e),
                }

        return {"results": results}

    @router.post("/llogis-check-by-origin")
    async def check_llogis_by_origin(
        invoice_nos: list[str] = Body(..., embed=True),
        user=Depends(get_current_user),
    ):
        if not invoice_nos:
            return {"results": {}}

        try:
            token = await _llogis_login()
        except Exception as e:
            return {"results": {}, "error": f"llogis 로그인 실패: {e}"}

        results = {}

        for inv_no in invoice_nos:
            inv_no = str(inv_no).strip()
            if not inv_no:
                continue
            try:
                data = await _llogis_query(inv_no, token)
                if not (data.get("invInfoList") or []):
                    results[inv_no] = {"return_invoices": [], "error": "llogis에서 송장을 찾을 수 없음"}
                    continue

                return_raws = [
                    r for r in (data.get("rltnInvList") or [])
                    if r.get("wkSctCd") == "02"
                ]

                returns = []
                for r in return_raws:
                    rtn_no = r.get("rltnInvNo")
                    rtn_no_view = r.get("rltnInvNoView") or rtn_no
                    try:
                        rtn_data = await _llogis_query(rtn_no, token)
                        rtn_inv_info = (rtn_data.get("invInfoList") or [{}])[0]
                        rtn_mvm = rtn_data.get("mvmList") or []
                        rtn_latest = rtn_mvm[-1] if rtn_mvm else {}
                        status = (
                            rtn_inv_info.get("wkSctNm")
                            or rtn_latest.get("paclStatNm")
                            or "이동이력 없음"
                        )
                        returns.append({
                            "invoice_no": rtn_no_view,
                            "status": status,
                            "location": rtn_latest.get("scanBrshNm") or "-",
                            "scan_date": rtn_latest.get("rgstYmd") or "-",
                            "error": None,
                            "_inv_info_keys": list(rtn_inv_info.keys()),
                        })
                    except Exception as e:
                        returns.append({
                            "invoice_no": rtn_no_view,
                            "status": "-",
                            "location": "-",
                            "scan_date": "-",
                            "error": str(e),
                        })

                results[inv_no] = {"return_invoices": returns, "error": None}
            except Exception as e:
                results[inv_no] = {"return_invoices": [], "error": str(e)}

        return {"results": results}

    @router.get("/llogis-detail")
    async def llogis_detail(inv_no: str, user=Depends(get_current_user)):
        token = await _llogis_login()
        data = await _llogis_query(inv_no, token)

        inv_info_list = data.get("invInfoList") or []
        if not inv_info_list:
            raise HTTPException(status_code=404, detail="llogis에서 송장을 찾을 수 없습니다.")

        inv_info = inv_info_list[0]
        mvm_list = data.get("mvmList") or []
        latest = mvm_list[-1] if mvm_list else {}

        return_invoices_raw = [
            r for r in (data.get("rltnInvList") or [])
            if r.get("wkSctCd") == "02"
        ]

        returns = []
        for r in return_invoices_raw:
            rtn_no = r.get("rltnInvNo")
            rtn_no_view = r.get("rltnInvNoView") or rtn_no
            try:
                rtn_data = await _llogis_query(rtn_no, token)
                rtn_inv_info = (rtn_data.get("invInfoList") or [{}])[0]
                rtn_mvm = rtn_data.get("mvmList") or []
                rtn_latest = rtn_mvm[-1] if rtn_mvm else {}
                latest_status = (
                    rtn_inv_info.get("wkSctNm")
                    or rtn_latest.get("paclStatNm")
                    or "-"
                )
                returns.append({
                    "invoice_no": rtn_no_view,
                    "status_name": r.get("paclStatNm"),
                    "latest_status": latest_status,
                    "location": rtn_latest.get("scanBrshNm") or "-",
                    "scan_date": rtn_latest.get("rgstYmd") or "-",
                    "error": None,
                    "_inv_info_keys": list(rtn_inv_info.keys()),
                })
            except Exception as e:
                returns.append({
                    "invoice_no": rtn_no_view,
                    "status_name": r.get("paclStatNm"),
                    "latest_status": "-",
                    "location": "-",
                    "scan_date": "-",
                    "error": str(e),
                })

        return {
            "inv_no": inv_no,
            "inv_info": {
                "receiver": inv_info.get("acperNm"),
                "product": inv_info.get("artcNm"),
                "sent_date": inv_info.get("acptRgstYmd"),
                "delivered_date": inv_info.get("dlvYmd"),
            },
            "latest_status": latest.get("paclStatNm") or "-",
            "location": latest.get("scanBrshNm") or "-",
            "scan_date": latest.get("rgstYmd") or "-",
            "returns": returns,
        }

    return router
