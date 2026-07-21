from __future__ import annotations
from typing import Any
import httpx
from . import config


class AblyClient:
    def __init__(self, *, timeout: float = 15.0):
        self._timeout = timeout
        self._token: str | None = None

    async def login(self, *, force: bool = False) -> str:
        if self._token and not force: return self._token
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            response = await client.post(f"{config.ABLY_BASE}/seller/login/", json={"email": config.ABLY_EMAIL, "password": config.ABLY_PASSWORD}, headers={"Content-Type": "application/json", "Origin": "https://seller-admin.a-bly.com", "Referer": "https://seller-admin.a-bly.com/", "User-Agent": "Mozilla/5.0"})
        if not response.is_success: raise RuntimeError("Ably login failed")
        token = response.json().get("token")
        if not token: raise RuntimeError("Ably login failed: token missing")
        self._token = token
        return token

    @staticmethod
    def headers(token: str, *, origin: str = "seller-admin.a-bly.com") -> dict:
        return {"Authorization": f"JWT {token}", "Accept": "application/json", "Content-Type": "application/json", "Origin": f"https://{origin}", "Referer": f"https://{origin}/", "User-Agent": "Mozilla/5.0"}

    async def request(self, method: str, path: str, *, json: Any = None, params: dict | None = None, origin: str = "seller-admin.a-bly.com", timeout: float | None = None) -> httpx.Response:
        token = await self.login()
        async with httpx.AsyncClient(timeout=timeout or self._timeout) as client:
            response = await client.request(method, f"{config.ABLY_BASE}{path}", headers=self.headers(token, origin=origin), json=json, params=params)
        if response.status_code == 401:
            token = await self.login(force=True)
            async with httpx.AsyncClient(timeout=timeout or self._timeout) as client:
                response = await client.request(method, f"{config.ABLY_BASE}{path}", headers=self.headers(token, origin=origin), json=json, params=params)
        return response

    async def rollback_order_items_to_prepare(self, sno_list: list[int]) -> httpx.Response:
        return await self.request("PUT", "/seller/order_items/rollback_to_prepare/", json={"sno_list": sno_list}, origin="my.a-bly.com")

    async def search_goods(self, *, page: int = 1, per_page: int = 30) -> dict:
        response = await self.request("POST", "/seller/goods/search/", json={"page": page, "per_page": per_page})
        response.raise_for_status()
        return response.json()

    async def get_goods_detail(self, sno: int | str) -> dict:
        response = await self.request("GET", f"/seller/goods/{sno}/")
        response.raise_for_status()
        return response.json().get("goods", {})

    def set_token(self, token: str) -> None:
        """이미 확보한 JWT를 재사용해 재로그인을 피할 때 사용."""
        self._token = token
