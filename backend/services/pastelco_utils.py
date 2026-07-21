"""Backward-compatible wrappers around the consolidated Pastelco SDK."""
from __future__ import annotations

from sdk.ably import AblyClient
from sdk.pastelco import PastelcoClient
from sdk import config

_ably_client = AblyClient()
_pastelco_client = PastelcoClient(ably_client=_ably_client)

def _pastelco_headers(token: str) -> dict:
    """Compatibility helper for the legacy pastelco route."""
    return {
        "Authorization": f"JWT {token}", "Accept": "application/json",
        "Content-Type": "application/json", "Origin": "https://my.a-bly.com",
        "Referer": "https://my.a-bly.com/", "User-Agent": "Mozilla/5.0",
    }


async def pastelco_login() -> str:
    return await _ably_client.login()


def pastelco_today_kst() -> str:
    return PastelcoClient.today_kst()


async def pastelco_fetch_all_orders(token: str) -> list[dict]:
    return await _pastelco_client.fetch_orders("SHIPPING_READYING")


async def pastelco_fetch_shipping_processing_today(token: str, today: str | None = None) -> list[dict]:
    return await _pastelco_client.fetch_orders("SHIPPING_PROCESSING", today=today)
