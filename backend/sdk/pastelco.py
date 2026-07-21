from __future__ import annotations
from datetime import datetime, timedelta, timezone
import httpx
from . import config
from .ably import AblyClient

_KST = timezone(timedelta(hours=9))


class PastelcoClient:
    def __init__(self, ably_client: AblyClient | None = None): self._ably = ably_client or AblyClient()

    @staticmethod
    def today_kst() -> str: return datetime.now(_KST).strftime("%Y-%m-%d")

    async def fetch_orders(self, status: str, *, today: str | None = None) -> list[dict]:
        token = await self._ably.login()
        headers = {"Authorization": f"JWT {token}", "Accept": "application/json", "Content-Type": "application/json", "Origin": "https://my.a-bly.com", "Referer": "https://my.a-bly.com/", "User-Agent": "Mozilla/5.0"}
        today = today or self.today_kst()
        params = {"status": status, "page": 1, "page_size": 30, "order_by": "-order_placed_date"}
        if status == "SHIPPING_PROCESSING":
            params.update({"shipping_processed_date_start": today, "shipping_processed_date_end": today, "shipping_processed_date": f"{today}~{today}", "order_by": "-shipping_processed_date"})
        items: list[dict] = []
        async with httpx.AsyncClient(timeout=30.0) as client:
            while True:
                response = await client.get(f"{config.PASTELCO_BASE}/seller/orders/", headers=headers, params=params)
                if response.status_code != 200: break
                data = response.json(); page_items = data.get("order_line_items", [])
                if not page_items: break
                items.extend(page_items); total_pages = data.get("total_page", 1)
                if params["page"] >= total_pages: break
                params["page"] += 1
        return items
