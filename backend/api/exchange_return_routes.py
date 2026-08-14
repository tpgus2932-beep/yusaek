from __future__ import annotations

import asyncio
import io
import json
import re
import time
from datetime import datetime, timedelta, timezone

import httpx
import xlwt
from fastapi import APIRouter, Body, Depends, HTTPException

ABLY_BASE = "https://api.a-bly.com"
LLOGIS_LOGIN_URL = "https://partner.alps.llogis.com/auth/login"
LLOGIS_BASE = "https://pid.alps.llogis.com:18210"

ABLY_EMAIL = "eostm1997@naver.com"
ABLY_PASSWORD = "!Glqgkqdldi1126"

LLOGIS_PRINCIPAL = "348867"
LLOGIS_CREDENTIAL = "1q2w3e4r5t"
LLOGIS_EMP_NO = "348867"

LLOGIS_COURIER_SNO = 5  # 롯데택배

_EZADMIN_BASE = "https://ga80.ezadmin.co.kr"
_EZADMIN_SESSION_KEY = "ezadmin_phpsessid"
_KST = timezone(timedelta(hours=9))
_BROWSER_WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
_BROWSER_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def build_exchange_return_router(*, get_current_user, get_setting, get_db=None, enqueue_sms=None, set_setting=None):
    router = APIRouter(prefix="/exchange-return")

    def _browser_time_flag(now: datetime) -> str:
        return (
            f"{_BROWSER_WEEKDAYS[now.weekday()]} "
            f"{_BROWSER_MONTHS[now.month - 1]} "
            f"{now.day:02d} {now.year} "
            f"{now:%H:%M:%S} GMT+0900 (한국 표준시)"
        )

    def _looks_like_ezadmin_session_error(response, body: str) -> bool:
        lowered = (body or "").lower()
        if response.url and "login" in str(response.url).lower():
            return True
        if "<html" in lowered or "<!doctype html" in lowered:
            return True
        return any(t in lowered for t in ("login", "phpsessid", "session", "로그인"))

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
                        # order_item.order_sno(중첩)는 자주 비어 있어 exchange 객체
                        # 최상위의 order_sno를 쓴다 - process_exchange_pickup 등에서
                        # 이미 검증된 신뢰 가능한 필드다.
                        "order_sno": ex.get("order_sno"),
                        "phone": "".join(
                            ch for ch in str(order_item.get("buyer_tel") or order_item.get("receiver_tel") or "")
                            if ch.isdigit()
                        ),
                    })

                if page >= data.get("max_page_number", 1):
                    break
                page += 1

        # 교환목록(exchange_items[].order_item)엔 buyer_tel/receiver_tel이 비어
        # 오는 경우가 많아, 상세조회(order_items/{sno}/)로 폴백해서 채운다 -
        # process_one/process_exchange_pickup이 이미 이 상세조회 필드로 전화번호를
        # 가져오고 있어 신뢰할 수 있는 소스다.
        async def _fetch_phone(client: httpx.AsyncClient, sno):
            if not sno:
                return ""
            try:
                res = await client.get(
                    f"{ABLY_BASE}/seller/order_items/{sno}/",
                    headers=_ably_headers(token),
                )
                if res.status_code != 200:
                    return ""
                oi = res.json().get("order_item") or {}
                raw_tel = oi.get("buyer_tel") or oi.get("receiver_tel") or ""
                return "".join(ch for ch in str(raw_tel) if ch.isdigit())
            except Exception:
                return ""

        need_phone = [item for item in all_items if not item.get("phone")]
        if need_phone:
            async with httpx.AsyncClient(timeout=15.0) as client:
                phones = await asyncio.gather(
                    *(_fetch_phone(client, item["order_item_sno"]) for item in need_phone)
                )
            for item, phone in zip(need_phone, phones):
                item["phone"] = phone

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
                    invoice = rd.get("invoice_number") or None
                    items_list = ex.get("exchange_items") or []
                    first = items_list[0] if items_list else {}
                    order_item = first.get("order_item") or {}
                    registered.append({
                        "exchange_sno": ex.get("exchange_sno") or ex.get("sno"),
                        "goods_name": order_item.get("goods_name") or first.get("goods_name") or "",
                        "option_info": order_item.get("option_info") or first.get("option_info") or "",
                        "member_name": (ex.get("member") or {}).get("name") or "",
                        "requested_at": ex.get("requested_at") or "",
                        "return_invoice": invoice,
                    })
                if page >= data.get("max_page_number", 1):
                    break
                page += 1

        if not registered:
            return {"items": []}

        # 반송장 있는 항목만 llogis 조회
        has_invoice = [item for item in registered if item["return_invoice"]]
        if has_invoice:
            try:
                llogis_token = await _llogis_login()
            except Exception as e:
                raise HTTPException(status_code=502, detail=f"llogis 로그인 실패: {e}")

            for item in has_invoice:
                try:
                    status = await _llogis_query_status(item["return_invoice"], llogis_token)
                    item.update(status)
                except Exception as e:
                    item.update({
                        "llogis_status": "-",
                        "llogis_location": "-",
                        "llogis_scan_date": str(e)[:80],
                    })

        return {"items": registered}

    @router.post("/process-one")
    async def process_one(
        exchange_sno: int = Body(...),
        order_item_sno: int = Body(...),
        user=Depends(get_current_user),
    ):
        # "daily_check_process_all"의 완료 표시는 여기서 하지 않는다 - 이 엔드포인트는
        # 프론트(runProcessAll)가 대상 건마다 순차 호출하는 것이라, 첫 건에서만 찍으면
        # 새로고침 등으로 나머지가 끊겨도 전체가 완료된 것처럼 보인다. 실제 완료 표시는
        # 프론트가 전체 목록을 다 처리한 뒤 /process-all-complete 를 호출할 때 남긴다.
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

    @router.post("/process-all-complete")
    async def process_all_complete(user=Depends(get_current_user)):
        # 프론트(runProcessAll)가 대상 전체에 대해 process-one을 순차 호출한 뒤
        # 마지막에 호출한다 - 새로고침 등으로 루프가 중간에 끊기면 이 호출 자체가
        # 나가지 않으므로 daily-checklist는 done_today=false로 정확히 남는다.
        if set_setting:
            set_setting("daily_check_process_all", datetime.now(_KST).isoformat())
        return {"ok": True}

    @router.post("/ship-pending")
    async def ship_pending(
        start_date: str = Body(None),
        end_date: str = Body(None),
        user=Depends(get_current_user),
    ):
        phpsessid = (get_setting(_EZADMIN_SESSION_KEY) or "").strip()
        if not phpsessid:
            return {"ok": False, "need_session": True}

        running_key = "daily_check_ship_pending_running_at"
        if set_setting:
            set_setting(running_key, datetime.now(_KST).isoformat())
        try:
            data = await _run_ship_pending(phpsessid, start_date, end_date)
            if set_setting and not data.get("need_session"):
                if data.get("ok") is not False:
                    message = f"성공 {data.get('success') or 0} / 스킵 {data.get('skipped') or 0} / 실패 {data.get('failed') or 0}"
                else:
                    message = data.get("error") or data.get("detail") or "실패"
                set_setting("daily_check_ship_pending_last_result", message)
            return data
        finally:
            if set_setting:
                set_setting(running_key, None)

    async def _run_ship_pending(phpsessid: str, start_date, end_date):
        if not end_date:
            end_date = datetime.now(_KST).strftime("%Y-%m-%d")
        if not start_date:
            start_date = (datetime.now(_KST) - timedelta(days=365)).strftime("%Y-%m-%d")

        ez_headers = {
            "User-Agent": "Mozilla/5.0",
            "Referer": f"{_EZADMIN_BASE}/template40.htm?template=E900",
            "X-Requested-With": "XMLHttpRequest",
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        }

        # 에이블리 status=9 교환건 수집
        try:
            token = await _ably_login()
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"에이블리 로그인 실패: {e}")

        all_exchanges = []
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
                        "status[]": 9,
                    },
                )
                res.raise_for_status()
                data = res.json()
                exchanges = data.get("exchanges", [])
                if not exchanges:
                    break
                all_exchanges.extend(exchanges)
                if page >= data.get("max_page_number", 1):
                    break
                page += 1

        results = []
        async with httpx.AsyncClient(timeout=30.0, verify=False, follow_redirects=True) as ez_client:
            for ex in all_exchanges:
                exchange_sno = ex.get("exchange_sno") or ex.get("sno")
                order_sno = ex.get("order_sno")
                delivery = ex.get("exchange_delivery") or {}

                if not order_sno:
                    results.append({"exchange_sno": exchange_sno, "ok": False, "skipped": True, "error": "order_sno 없음"})
                    continue

                keyword = f"C{order_sno}"

                # EZAdmin 주문 검색
                try:
                    search_payload = {
                        "_search": "false",
                        "rows": "10",
                        "page": "1",
                        "sidx": "",
                        "sord": "desc",
                        "readonly": "T",
                        "template": "E900",
                        "action": "query_json",
                        "par": (
                            f"pack=&history_seq=&date_type=collect_date"
                            f"&start_date={start_date}&end_date={end_date}"
                            f"&date_period_sel=0&search_type=7&keyword={keyword}"
                            f"&keyword1=&keyword2=&keyword3=&keyword4=&keyword5="
                            f"&super_keyword=&order_status=-1&order_cs=0"
                            f"&query_trans_who=0&is_gift=0&work_type=0"
                            f"&labels_string=&checkbox_options_string="
                        ),
                    }
                    search_res = await ez_client.post(
                        f"{_EZADMIN_BASE}/function.htm",
                        data=search_payload,
                        cookies={"PHPSESSID": phpsessid},
                        headers=ez_headers,
                    )
                    search_body = (search_res.text or "").strip()
                    if _looks_like_ezadmin_session_error(search_res, search_body):
                        return {"ok": False, "need_session": True}

                    search_data = json.loads(search_body)
                    rows = search_data.get("rows", [])
                    if not rows:
                        results.append({"exchange_sno": exchange_sno, "ok": False, "skipped": True, "error": f"EZAdmin 검색결과 없음 ({keyword})"})
                        continue

                    pack = None
                    for row in rows:
                        cell = row.get("cell", {})
                        if isinstance(cell, dict):
                            pack = cell.get("pack")
                        if pack:
                            break

                    if not pack:
                        results.append({"exchange_sno": exchange_sno, "ok": False, "skipped": True, "error": f"pack 없음 ({keyword})"})
                        continue

                    # EZAdmin pack 상세 조회
                    now = datetime.now(_KST)
                    detail_payload = {
                        "_search": "false",
                        "rows": "500",
                        "page": "1",
                        "sidx": "",
                        "sord": "",
                        "readonly": "T",
                        "template": "E900",
                        "action": "packlist_json",
                        "pack": pack,
                        "stock": "0",
                        "is_masking": "0",
                        "timeFlag": _browser_time_flag(now),
                    }
                    detail_res = await ez_client.post(
                        f"{_EZADMIN_BASE}/function.htm",
                        data=detail_payload,
                        cookies={"PHPSESSID": phpsessid},
                        headers=ez_headers,
                    )
                    detail_body = (detail_res.text or "").strip()
                    if _looks_like_ezadmin_session_error(detail_res, detail_body):
                        return {"ok": False, "need_session": True}

                    detail_data = json.loads(detail_body)
                    detail_rows = detail_data.get("rows", [])

                    trans_no = None
                    for drow in detail_rows:
                        dcell = drow.get("cell", {})
                        if isinstance(dcell, dict):
                            data_row_str = dcell.get("data_row")
                            if data_row_str:
                                try:
                                    data_row = json.loads(data_row_str)
                                    trans_no = data_row.get("trans_no")
                                    if trans_no:
                                        break
                                except Exception:
                                    pass

                    if not trans_no:
                        results.append({"exchange_sno": exchange_sno, "ok": False, "skipped": True, "error": f"송장번호 없음 (pack={pack})"})
                        continue

                    # 에이블리 배송처리
                    ship_body = {
                        "delivery_sno": 5,
                        "invoice": trans_no,
                        "exchange_deliveries": [{
                            "exchange_sno": exchange_sno,
                            "sno": delivery.get("sno"),
                            "name": delivery.get("name"),
                            "contact": delivery.get("contact"),
                            "address": delivery.get("address"),
                            "zipcode": delivery.get("zipcode"),
                            "delivery_request": delivery.get("delivery_request"),
                        }],
                    }
                    async with httpx.AsyncClient(timeout=15.0) as ably_client:
                        ship_res = await ably_client.post(
                            f"{ABLY_BASE}/seller/exchanges/ship/",
                            headers=_ably_headers(token),
                            json=ship_body,
                        )

                    if ship_res.status_code in (200, 201, 204):
                        results.append({"exchange_sno": exchange_sno, "ok": True, "skipped": False, "invoice": trans_no, "error": None})
                    else:
                        results.append({"exchange_sno": exchange_sno, "ok": False, "skipped": False, "invoice": trans_no, "error": f"배송처리 실패 (HTTP {ship_res.status_code}): {ship_res.text[:100]}"})

                except json.JSONDecodeError as e:
                    results.append({"exchange_sno": exchange_sno, "ok": False, "skipped": False, "error": f"EZAdmin 응답 파싱 실패: {str(e)[:80]}"})
                except Exception as e:
                    results.append({"exchange_sno": exchange_sno, "ok": False, "skipped": False, "error": str(e)[:100]})

        success = sum(1 for r in results if r.get("ok"))
        skipped = sum(1 for r in results if r.get("skipped"))
        failed = sum(1 for r in results if not r.get("ok") and not r.get("skipped"))
        # 체크리스트 "오늘 실행됨" 표시는 전체 배치가 끝난 뒤에만 기록한다 -
        # 도중에 새로고침/예외가 나면 이 지점에 도달하지 못해 done_today가
        # false로 남는다.
        if set_setting:
            set_setting("daily_check_ship_pending", datetime.now(_KST).isoformat())
        return {
            "ok": True,
            "results": results,
            "total": len(results),
            "success": success,
            "skipped": skipped,
            "failed": failed,
        }

    @router.post("/process-exchange-pickup")
    async def process_exchange_pickup(user=Depends(get_current_user)):
        phpsessid = get_setting(_EZADMIN_SESSION_KEY)
        if not phpsessid:
            return {"ok": False, "need_session": True}

        running_key = "daily_check_exchange_pickup_running_at"
        if set_setting:
            set_setting(running_key, datetime.now(_KST).isoformat())
        try:
            data = await _run_process_exchange_pickup(phpsessid)
            if set_setting and not data.get("need_session"):
                if data.get("ok"):
                    message = f"교환 {data.get('exchange_count') or 0}건, 송장 {data.get('invoice_count') or 0}건"
                else:
                    message = data.get("error") or data.get("detail") or "실패"
                set_setting("daily_check_exchange_pickup_last_result", message)
            return data
        finally:
            if set_setting:
                set_setting(running_key, None)

    async def _run_process_exchange_pickup(phpsessid: str):
        try:
            token = await _ably_login()
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"에이블리 로그인 실패: {e}")

        end_date = datetime.today().strftime("%Y-%m-%d")
        start_date = (datetime.today() - timedelta(days=30)).strftime("%Y-%m-%d")

        # 교환요청(status=2) 목록 조회
        exchanges = []
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
                        "status[]": 2,
                    },
                )
                res.raise_for_status()
                data = res.json()
                for ex in data.get("exchanges", []):
                    items_list = ex.get("exchange_items") or []
                    if not items_list:
                        continue
                    exchanges.append({
                        "exchange_sno": ex.get("sno") or ex.get("exchange_sno"),
                        "reason_code": ex.get("reason_code"),
                        "detail_reason": ex.get("detail_reason") or "",
                        "order_item_sno": items_list[0].get("order_item_sno"),
                        "exchange_items": items_list,
                        "return_delivery": ex.get("return_delivery") or {},
                        "exchange_delivery": ex.get("exchange_delivery") or {},
                    })
                if page >= data.get("max_page_number", 1):
                    break
                page += 1

        if not exchanges:
            return {"ok": False, "error": "처리할 교환요청이 없습니다"}

        # reason_code=2(상품 하자, 판매자 부담)는 교환요청에서 자동으로 넘기지 않음
        # → 회수신청(EZAdmin 등록)과 문자 발송도 함께 제외
        seller_fault_count = sum(1 for ex in exchanges if ex.get("reason_code") == 2)
        pickup_exchanges = [ex for ex in exchanges if ex.get("reason_code") != 2]

        if not pickup_exchanges:
            return {"ok": False, "error": "처리할 교환요청이 없습니다 (전체가 판매자 부담 사유로 제외됨)"}

        # 원송장 조회 + 수신자 정보 수집
        invoices = []
        sms_recipients: list[dict] = []
        seen_tels: set[str] = set()
        async with httpx.AsyncClient(timeout=30.0) as client:
            for ex in pickup_exchanges:
                sno = ex.get("order_item_sno")
                if not sno:
                    continue
                try:
                    r = await client.get(
                        f"{ABLY_BASE}/seller/order_items/{sno}/",
                        headers={
                            **_ably_headers(token),
                            "Origin": "https://my.a-bly.com",
                            "Referer": "https://my.a-bly.com/",
                        },
                    )
                    item = r.json().get("order_item") or {}
                    inv = item.get("invoice") or ""
                    if inv:
                        invoices.append(str(inv).strip())
                    tel_raw = item.get("buyer_tel") or item.get("receiver_tel") or ""
                    tel = "".join(ch for ch in str(tel_raw) if ch.isdigit())
                    if tel and tel not in seen_tels:
                        seen_tels.add(tel)
                        sms_recipients.append({
                            "tel": tel,
                            "name": str(item.get("receiver_name") or item.get("buyer_name") or "").strip(),
                            "goods_name": str(item.get("goods_name") or "").strip(),
                        })
                except Exception:
                    pass

        if not invoices:
            return {"ok": False, "error": "유효한 송장번호가 없습니다"}

        # EZAdmin 회수등록
        book = xlwt.Workbook()
        sheet = book.add_sheet("Sheet1")
        sheet.write(0, 0, "송장번호")
        for i, inv in enumerate(invoices, start=1):
            sheet.write(i, 0, inv)
        buf = io.BytesIO()
        book.save(buf)
        xls_bytes = buf.getvalue()

        ez_headers_base = {
            "User-Agent": "Mozilla/5.0",
            "Referer": f"{_EZADMIN_BASE}/popup35.htm?template=DS05&set_batch_cs=1",
        }
        ezadmin_ok = False
        async with httpx.AsyncClient(timeout=30.0, verify=False, follow_redirects=True) as ez_client:
            upload_res = await ez_client.post(
                f"{_EZADMIN_BASE}/popup35.htm",
                data={"template": "DS05", "action": "update_batch_cs", "set_batch_cs": "1", "set_order_label": ""},
                files={"_file": ("exchange_invoice.xls", xls_bytes, "application/vnd.ms-excel")},
                cookies={"PHPSESSID": phpsessid},
                headers=ez_headers_base,
            )
            upload_body = (upload_res.text or "").strip()
            m = re.search(r"batch_cs_\w+", upload_body)
            if not m:
                if _looks_like_ezadmin_session_error(upload_res, upload_body):
                    return {"ok": False, "need_session": True}
                return {"ok": False, "error": f"EZAdmin 업로드 실패: {upload_body[:200]}"}
            table_name = m.group(0)

            now_kst = datetime.now(_KST)
            set_res = await ez_client.post(
                f"{_EZADMIN_BASE}/function.htm",
                data={
                    "template": "DS00", "action": "set_batch_cs", "work": "takeback",
                    "table_name": table_name, "cs_reason": "일반", "arr_product": "[]",
                    "receiver_seq": "8", "receiver_name": "유색",
                    "receiver_tel1": "010", "receiver_tel2": "25466058",
                    "receiver_mobile1": "010", "receiver_mobile2": "25466058",
                    "receiver_zip1": "120", "receiver_zip2": "10",
                    "receiver_address": "경기 남양주시 진접읍 장현리 51-1 롯데오성대리점 (유색)",
                    "trans_who": "04", "trans_due_date": now_kst.strftime("%Y-%m-%d"),
                    "timeFlag": _browser_time_flag(now_kst),
                    "cs_content": "", "seq": "", "cancel_pack": "0", "recover_pack": "0",
                    "delete_pack": "0", "priority": "0", "auto_restockin_all": "0",
                    "auto_restockin_all_bad": "0", "restockin_ex": "0",
                    "update_unhold": "0", "unhold": "0", "set_cs_top_fix": "0",
                },
                cookies={"PHPSESSID": phpsessid},
                headers={
                    "User-Agent": "Mozilla/5.0",
                    "X-Requested-With": "XMLHttpRequest",
                    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                    "Referer": f"{_EZADMIN_BASE}/popup35.htm?template=DS05",
                },
            )
            set_body = (set_res.text or "").strip()
            if _looks_like_ezadmin_session_error(set_res, set_body):
                return {"ok": False, "need_session": True}
            ezadmin_ok = True

        # 에이블리 교환접수 승인
        def _map_exchange_item(item: dict) -> dict:
            return {
                "exchange_item_sno":        item.get("exchange_item_sno") or item.get("sno"),
                "exchange_goods_option_sno": (
                    item.get("exchange_goods_option_sno")
                    or (item.get("exchange_goods_option") or {}).get("sno")
                ),
            }

        approve_body = {"exchanges": [
            {
                "sno": ex["exchange_sno"],
                "reason_code": ex["reason_code"],
                "exchange_items": [_map_exchange_item(i) for i in ex["exchange_items"]],
                "return_delivery": ex["return_delivery"],
                "exchange_delivery": ex["exchange_delivery"],
            }
            for ex in pickup_exchanges
        ]}
        async with httpx.AsyncClient(timeout=30.0) as client:
            approve_res = await client.post(
                f"{ABLY_BASE}/seller/exchanges/approve/",
                headers=_ably_headers(token),
                json=approve_body,
            )
        approve_status = approve_res.status_code

        # SMS 발송 — 반품 최초 접수 템플릿 재사용
        sms_queued = 0
        if enqueue_sms and sms_recipients and get_db:
            import os
            sender = os.environ.get("ALIGO_SENDER", "").strip()
            if sender:
                conn = get_db()
                try:
                    tmpl = conn.execute(
                        "SELECT msg, title, msg_type FROM sms_templates WHERE name = ?",
                        ("반품 최초 접수",),
                    ).fetchone()
                finally:
                    conn.close()
                if tmpl and tmpl["msg"]:
                    for r in sms_recipients:
                        msg = tmpl["msg"]
                        msg = msg.replace("{이름}", r["name"])
                        msg = msg.replace("{수령인}", r["name"])
                        msg = msg.replace("{상품명}", r["goods_name"])
                        try:
                            enqueue_sms(
                                {
                                    "receiver": r["tel"],
                                    "msg": msg,
                                    "msg_type": tmpl["msg_type"] or "LMS",
                                    "title": tmpl["title"] or "",
                                    "sender": sender,
                                },
                                "auto-exchange-pickup",
                            )
                            sms_queued += 1
                        except Exception:
                            pass

        # 체크리스트 "오늘 실행됨" 표시는 회수신청/에이블리 승인까지 끝난
        # 뒤에만 기록한다 - 도중에 새로고침/예외가 나면 done_today가 false로 남는다.
        if set_setting:
            set_setting("daily_check_exchange_pickup", datetime.now(_KST).isoformat())

        return {
            "ok": True,
            "exchange_count": len(exchanges),
            "seller_fault_excluded": seller_fault_count,
            "invoice_count": len(invoices),
            "ezadmin_ok": ezadmin_ok,
            "approve_status": approve_status,
            "sms_queued": sms_queued,
        }

    return router
