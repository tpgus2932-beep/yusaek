from __future__ import annotations

import json
import time
from datetime import datetime, timedelta, timezone

import httpx
from fastapi import APIRouter, Body, Depends, HTTPException

from services.delivery_anomaly_logic import evaluate_anomaly, parse_ably_sent_date
from services.delivery_anomaly_store import sync_anomalies

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
            """
            SELECT a.*, COUNT(c.id) AS comment_count
            FROM delivery_anomalies a
            LEFT JOIN delivery_anomaly_comments c ON c.anomaly_id = a.id
            GROUP BY a.id
            ORDER BY a.detected_at ASC
            """
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
                    "detectedAt": r["detected_at"],
                    "commentCount": r["comment_count"],
                }
                for r in rows
            ]
        }

    @router.get("/{anomaly_id}/comments")
    def list_comments(anomaly_id: int, user: str = Depends(get_current_user)):
        conn = get_db()
        rows = conn.execute(
            "SELECT id, username, text, created_at FROM delivery_anomaly_comments"
            " WHERE anomaly_id = ? ORDER BY created_at ASC",
            (anomaly_id,),
        ).fetchall()
        conn.close()
        return {
            "items": [
                {"id": r["id"], "username": r["username"], "text": r["text"], "createdAt": r["created_at"]}
                for r in rows
            ]
        }

    @router.post("/{anomaly_id}/comments")
    def add_comment(
        anomaly_id: int,
        text: str = Body(..., embed=True),
        user: str = Depends(get_current_user),
    ):
        text = text.strip()
        if not text:
            raise HTTPException(400, "댓글 내용을 입력하세요")
        conn = get_db()
        exists = conn.execute(
            "SELECT id FROM delivery_anomalies WHERE id = ?", (anomaly_id,)
        ).fetchone()
        if not exists:
            conn.close()
            raise HTTPException(404, "이상현상 항목을 찾을 수 없습니다")
        created_at = datetime.now(_KST).isoformat()
        conn.execute(
            "INSERT INTO delivery_anomaly_comments (anomaly_id, username, text, created_at) VALUES (?, ?, ?, ?)",
            (anomaly_id, user, text, created_at),
        )
        conn.commit()
        conn.close()
        return {"ok": True, "createdAt": created_at}

    @router.post("/run")
    async def run_check(user: str = Depends(get_current_user)):
        today_str = datetime.now(_KST).strftime("%Y-%m-%d")
        last_run = get_setting(_LAST_RUN_SETTING_KEY)
        if last_run == today_str:
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
            mvm_list = llogis_raw.get("mvmList") or []
            latest = mvm_list[-1] if mvm_list else {}
            computed[inv_no] = {
                "order_no": item["order_no"],
                "product_name": item["product_name"],
                "option_info": item["option_info"],
                "phone": item["phone"],
                "sent_date": item["sent_date"],
                "status": latest.get("paclStatNm") or "-",
                "location": latest.get("scanBrshNm") or "-",
                "scan_date": latest.get("rgstYmd") or "-",
                "reason": reason,
            }

        conn = get_db()
        sync_anomalies(conn, computed)
        conn.close()
        set_setting(_LAST_RUN_SETTING_KEY, today_str)

        return list_anomalies(user=user)

    return router
