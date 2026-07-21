from __future__ import annotations

import json
import time
from datetime import datetime, timedelta, timezone

import httpx
from fastapi import APIRouter, Body, Depends, HTTPException

from services.delivery_anomaly_logic import (
    LOST_PACKAGE_MESSAGE,
    build_confirm_receipt_message,
    evaluate_anomaly,
    is_invoice_missing,
    latest_movement,
    latest_reply_after,
    parse_ably_sent_date,
    parse_ezdesk_time,
)
from services.delivery_anomaly_store import sync_anomalies

try:
    from sdk import config as ez_config
    from sdk.ezadmin import EzAdminClient, EzDeskSessionExpired, extract_sms_rows, normalize_sms_row
except ModuleNotFoundError:  # package import in unit tests
    from backend.sdk import config as ez_config
    from backend.sdk.ezadmin import EzAdminClient, EzDeskSessionExpired, extract_sms_rows, normalize_sms_row

_KST = timezone(timedelta(hours=9))

ABLY_BASE = "https://api.a-bly.com"
ABLY_EMAIL = "eostm1997@naver.com"
ABLY_PASSWORD = "!Glqgkqdldi1126"

LLOGIS_LOGIN_URL = "https://partner.alps.llogis.com/auth/login"
LLOGIS_BASE = "https://pid.alps.llogis.com:18210"
LLOGIS_PRINCIPAL = "348867"
LLOGIS_CREDENTIAL = "1q2w3e4r5t"
LLOGIS_EMP_NO = "348867"

_LAST_RUN_SETTING_KEY = "delivery_anomaly_last_run_date"


def build_delivery_anomaly_router(*, get_current_user, get_db, get_setting, set_setting):
    router = APIRouter(prefix="/delivery-anomaly")

    async def _ably_login() -> str:
        async with httpx.AsyncClient(timeout=15.0) as client:
            res = await client.post(
                f"{ABLY_BASE}/seller/login/",
                json={"email": ABLY_EMAIL, "password": ABLY_PASSWORD},
                headers={
                    "Content-Type": "application/json",
                    "User-Agent": "Mozilla/5.0",
                    "Referer": "https://my.a-bly.com/",
                    "Origin": "https://my.a-bly.com",
                },
            )
            res.raise_for_status()
        token = res.json().get("token")
        if not token:
            raise HTTPException(status_code=502, detail="에이블리 로그인 실패: 토큰 없음")
        return token

    async def _fetch_ably_shipping_items(token: str) -> list[dict]:
        headers = {
            "Authorization": f"JWT {token}",
            "Accept": "application/json",
            "User-Agent": "Mozilla/5.0",
            "Origin": "https://my.a-bly.com",
            "Referer": "https://my.a-bly.com/",
        }
        items: list[dict] = []
        async with httpx.AsyncClient(timeout=30.0) as client:
            res = await client.get(
                f"{ABLY_BASE}/seller/order_items/",
                headers=headers,
                params={
                    "processing_status[]": 3,
                    "processing_sub_status[]": 0,
                    "order": "goods_sent_at",
                    "delivery_type[]": ["standard", "today", "combine", "reserved"],
                    "per_page": 100,
                    "sponsorship_type": -1,
                    "page": 1,
                },
            )
            if res.status_code == 200:
                for item in res.json().get("order_items", []):
                    items.append({
                        "product_name": item.get("goods_name") or "",
                        "option_info": item.get("option_info") or "",
                        "order_no": str(item.get("order_sno") or item.get("sno") or ""),
                        "invoice_no": str(item.get("invoice") or "").strip(),
                        "phone": item.get("receiver_tel") or "",
                        "sent_date": item.get("goods_sent_at") or "",
                    })
        return items

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
            "Authorization": token,
            "Content-Type": "application/json",
            "Host": "pid.alps.llogis.com:18210",
            "Referer": f"{LLOGIS_BASE}/pid/pages/ftr/PIDFTR051U",
            "X-Requested-With": "XMLHttpRequest",
            "User-Agent": "Mozilla/5.0",
        }
        async with httpx.AsyncClient(timeout=20.0, verify=False) as client:
            res = await client.get(url, params=params, headers=headers)
            res.raise_for_status()
        return res.json()

    @router.get("/list")
    def list_anomalies(user: str = Depends(get_current_user)):
        conn = get_db()
        rows = conn.execute(
            "SELECT * FROM delivery_anomalies ORDER BY detected_at ASC"
        ).fetchall()
        conn.close()
        return {
            "items": [
                {
                    "id": r["id"],
                    "invoiceNo": r["invoice_no"],
                    "orderNo": r["order_no"],
                    "productName": r["product_name"],
                    "optionInfo": r["option_info"],
                    "phone": r["phone"],
                    "sentDate": r["sent_date"],
                    "status": r["status"],
                    "location": r["location"],
                    "scanDate": r["scan_date"],
                    "reason": r["reason"],
                    "detectedAt": r["detected_at"],
                    "confirmSentAt": r["confirm_sent_at"] or None,
                    "confirmReply": r["confirm_reply"] or None,
                    "confirmReplyAt": r["confirm_reply_at"] or None,
                    "responseSentAt": r["response_sent_at"] or None,
                    "responseText": r["response_text"] or None,
                }
                for r in rows
            ]
        }

    async def _send_sms_or_error(phone: str, msg: str) -> dict | None:
        """문자 발송. 성공하면 None, EZDesk 세션 만료면 에러 응답 dict 반환."""
        ez = EzAdminClient(get_setting)
        try:
            await ez.send_sms(phone, ez_config.EZDESK_SMS_SENDER, msg)
        except EzDeskSessionExpired:
            return {"ok": False, "need_ezdesk_session": True}
        return None

    def _get_anomaly_phone(anomaly_id: int) -> tuple:
        """(row, phone)을 반환. row가 없으면 404, phone이 없으면 400."""
        conn = get_db()
        row = conn.execute("SELECT * FROM delivery_anomalies WHERE id = ?", (anomaly_id,)).fetchone()
        conn.close()
        if not row:
            raise HTTPException(404, "이상현상 항목을 찾을 수 없습니다")
        phone = str(row["phone"] or "").strip()
        if not phone:
            raise HTTPException(400, "전화번호가 없습니다")
        return row, phone

    @router.post("/{anomaly_id}/confirm-send")
    async def send_confirm_sms(anomaly_id: int, user: str = Depends(get_current_user)):
        row, phone = _get_anomaly_phone(anomaly_id)

        error = await _send_sms_or_error(phone, build_confirm_receipt_message(row["product_name"]))
        if error:
            return error

        sent_at = datetime.now(_KST).isoformat()
        conn = get_db()
        conn.execute(
            "UPDATE delivery_anomalies SET confirm_sent_at = ?, confirm_reply = '', confirm_reply_at = '' WHERE id = ?",
            (sent_at, anomaly_id),
        )
        conn.commit()
        conn.close()
        return {"ok": True, "confirmSentAt": sent_at}

    async def _respond(anomaly_id: int, msg: str) -> dict:
        _row, phone = _get_anomaly_phone(anomaly_id)

        error = await _send_sms_or_error(phone, msg)
        if error:
            return error

        sent_at = datetime.now(_KST).isoformat()
        conn = get_db()
        conn.execute(
            "UPDATE delivery_anomalies SET response_sent_at = ?, response_text = ? WHERE id = ?",
            (sent_at, msg, anomaly_id),
        )
        conn.commit()
        conn.close()
        return {"ok": True, "responseSentAt": sent_at}

    @router.post("/{anomaly_id}/respond-lost")
    async def respond_lost(anomaly_id: int, user: str = Depends(get_current_user)):
        return await _respond(anomaly_id, LOST_PACKAGE_MESSAGE)

    @router.post("/{anomaly_id}/respond-custom")
    async def respond_custom(
        anomaly_id: int,
        text: str = Body(..., embed=True),
        user: str = Depends(get_current_user),
    ):
        text = text.strip()
        if not text:
            raise HTTPException(400, "내용을 입력하세요")
        return await _respond(anomaly_id, text)

    async def _apply_reply_updates(conn, ez, rows, since_column: str, *, reset_response: bool) -> bool:
        """rows 각각에 대해 since_column 이후 답장을 찾아 반영. 세션 만료면 False(중단) 반환."""
        for row in rows:
            phone = str(row["phone"] or "").strip()
            since = parse_ezdesk_time(row[since_column])
            if not phone or since is None:
                continue
            try:
                sms = await ez.sms_chat_detail(phone, ez_config.EZDESK_SMS_SENDER)
            except EzDeskSessionExpired:
                return False
            except Exception:
                continue
            normalized = [normalize_sms_row(r) for r in extract_sms_rows(sms)]
            reply = latest_reply_after(normalized, since)
            if not reply:
                continue
            if reset_response:
                conn.execute(
                    "UPDATE delivery_anomalies "
                    "SET confirm_reply = ?, confirm_reply_at = ?, response_sent_at = '', response_text = '' "
                    "WHERE id = ?",
                    (reply["content"], reply["input_time"], row["id"]),
                )
            else:
                conn.execute(
                    "UPDATE delivery_anomalies SET confirm_reply = ?, confirm_reply_at = ? WHERE id = ?",
                    (reply["content"], reply["input_time"], row["id"]),
                )
        return True

    async def _check_confirm_replies(conn) -> None:
        """수령여부확인 문자 발송 후 답장 확인.

        1) 아직 답장을 한 번도 못 찾은 건 — confirm_sent_at 이후 첫 답장을 찾는다.
        2) 이미 응대(미수령/답변하기)한 건 — 응대 이후 새 답장이 왔는지 재확인해서,
           있으면 confirm_reply를 그 새 답장으로 갱신하고 응대 상태를 초기화한다
           (버튼이 다시 활성화됨). 새 답장이 없으면 그대로 둔다.
        """
        ez = EzAdminClient(get_setting)

        pending_rows = conn.execute(
            "SELECT id, phone, confirm_sent_at FROM delivery_anomalies "
            "WHERE confirm_sent_at != '' AND confirm_reply = ''"
        ).fetchall()
        if pending_rows:
            ok = await _apply_reply_updates(conn, ez, pending_rows, "confirm_sent_at", reset_response=False)
            if not ok:
                conn.commit()
                return  # 세션이 없으면 이후 조회도 실패할 것이므로 중단

        responded_rows = conn.execute(
            "SELECT id, phone, response_sent_at FROM delivery_anomalies WHERE response_sent_at != ''"
        ).fetchall()
        if responded_rows:
            await _apply_reply_updates(conn, ez, responded_rows, "response_sent_at", reset_response=True)

        conn.commit()

    @router.post("/run")
    async def run_check(force: bool = False, user: str = Depends(get_current_user)):
        today_str = datetime.now(_KST).strftime("%Y-%m-%d")
        last_run = get_setting(_LAST_RUN_SETTING_KEY)
        if last_run == today_str and not force:
            return list_anomalies(user=user)  # 오늘 이미 실행됨 — 재조회 없이 현재 목록만 반환

        ably_token = await _ably_login()
        ably_items = await _fetch_ably_shipping_items(ably_token)

        llogis_token = await _llogis_login()
        computed: dict[str, dict] = {}
        today = datetime.now(_KST).date()
        for item in ably_items:
            inv_no = item["invoice_no"]
            if not inv_no:
                continue
            sent_date = parse_ably_sent_date(item["sent_date"])
            try:
                llogis_raw = await _llogis_query(inv_no, llogis_token)
            except Exception:
                continue
            reason = evaluate_anomaly(sent_date, today, llogis_raw)
            if not reason:
                continue
            if is_invoice_missing(llogis_raw):
                status, location, scan_date = "-", "-", "-"
            else:
                latest = latest_movement(llogis_raw) or {}
                status = latest.get("paclStatNm") or "-"
                location = latest.get("scanBrshNm") or "-"
                scan_date = latest.get("rgstYmd") or "-"
            computed[inv_no] = {
                "order_no": item["order_no"],
                "product_name": item["product_name"],
                "option_info": item["option_info"],
                "phone": item["phone"],
                "sent_date": item["sent_date"],
                "status": status,
                "location": location,
                "scan_date": scan_date,
                "reason": reason,
            }

        conn = get_db()
        sync_anomalies(conn, computed)
        try:
            await _check_confirm_replies(conn)
        except Exception:
            pass  # 답장 확인 실패는 이상현상 갱신 자체를 막지 않는다
        conn.close()
        set_setting(_LAST_RUN_SETTING_KEY, today_str)

        return list_anomalies(user=user)

    return router
