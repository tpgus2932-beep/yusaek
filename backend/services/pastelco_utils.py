from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

import httpx
from fastapi import HTTPException

ABLY_BASE = "https://api.a-bly.com"
PASTELCO_BASE = "https://api.pastelco.jp"
ABLY_EMAIL = "eostm1997@naver.com"
ABLY_PASSWORD = "!Glqgkqdldi1126"
KST = ZoneInfo("Asia/Seoul")


def _pastelco_headers(token: str) -> dict:
    return {
        "Authorization": f"JWT {token}",
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Origin": "https://my.a-bly.com",
        "Referer": "https://my.a-bly.com/",
        "User-Agent": "Mozilla/5.0",
    }


def pastelco_today_kst() -> str:
    return datetime.now(KST).date().isoformat()


async def pastelco_login() -> str:
    async with httpx.AsyncClient(timeout=15.0) as client:
        res = await client.post(
            f"{ABLY_BASE}/seller/login/",
            json={"email": ABLY_EMAIL, "password": ABLY_PASSWORD},
            headers={
                "Content-Type": "application/json",
                "Origin": "https://my.a-bly.com",
                "Referer": "https://my.a-bly.com/",
                "User-Agent": "Mozilla/5.0",
            },
        )
        res.raise_for_status()
    token = res.json().get("token")
    if not token:
        raise HTTPException(status_code=502, detail="에이블리 로그인 실패")
    return token


async def pastelco_fetch_all_orders(token: str) -> list:
    all_items = []
    page = 1
    async with httpx.AsyncClient(timeout=30.0) as client:
        while True:
            res = await client.get(
                f"{PASTELCO_BASE}/seller/orders/",
                headers=_pastelco_headers(token),
                params={
                    "status": "SHIPPING_READYING",
                    "page": page,
                    "page_size": 30,
                    "order_by": "-order_placed_date",
                },
            )
            if res.status_code != 200:
                break
            data = res.json()
            items = data.get("order_line_items", [])
            if not items:
                break
            all_items.extend(items)
            total_pages = data.get("total_page", 1)
            if page >= total_pages:
                break
            page += 1
    return all_items


async def pastelco_fetch_shipping_processing_today(token: str, today: str | None = None) -> list:
    today = today or pastelco_today_kst()
    all_items = []
    page = 1
    async with httpx.AsyncClient(timeout=30.0) as client:
        while True:
            res = await client.get(
                f"{PASTELCO_BASE}/seller/orders/",
                headers=_pastelco_headers(token),
                params={
                    "status": "SHIPPING_PROCESSING",
                    "shipping_processed_date_start": today,
                    "shipping_processed_date_end": today,
                    "shipping_processed_date": f"{today}~{today}",
                    "page": page,
                    "page_size": 30,
                    "order_by": "-shipping_processed_date",
                },
            )
            if res.status_code != 200:
                break
            data = res.json()
            items = data.get("order_line_items", [])
            if not items:
                break
            all_items.extend(items)
            total_pages = data.get("total_page", 1)
            if page >= total_pages:
                break
            page += 1
    return all_items
