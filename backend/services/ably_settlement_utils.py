from __future__ import annotations

import asyncio

import httpx

from services.amood_settlement_utils import now_iso, preprocess_product_name

ABLY_BASE = "https://api.a-bly.com"


def _ably_headers(jwt_token: str) -> dict:
    return {
        "Authorization": f"JWT {jwt_token}",
        "Accept": "application/json, text/plain, */*",
        "Origin": "https://my.a-bly.com",
        "Referer": "https://my.a-bly.com/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "x-token-type": "ably",
    }


async def fetch_ably_history_list(jwt_token: str, start: str, end: str) -> list[dict]:
    async with httpx.AsyncClient(timeout=20.0) as client:
        res = await client.get(
            f"{ABLY_BASE}/seller/balance_accounts/histories/",
            headers=_ably_headers(jwt_token),
            params={"start_date": start, "end_date": end},
        )
        res.raise_for_status()
    data = res.json()
    if isinstance(data, list):
        return data
    if "balance_accounts_histories" in data:
        return data["balance_accounts_histories"]
    return []


async def fetch_ably_settlement_csv(sno: int | str, jwt_token: str) -> list[dict]:
    async with httpx.AsyncClient(timeout=30.0) as client:
        res = await client.post(
            f"{ABLY_BASE}/seller/balance_accounts/histories/{sno}/download/",
            headers=_ably_headers(jwt_token),
        )
        res.raise_for_status()

    raw = res.content
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = raw.decode("euc-kr", errors="replace")

    rows = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        cols = line.split(",")
        if len(cols) < 13:
            continue
        # col[6] = 상품 주문 번호, col[12] = 정산금
        order_id_raw = cols[6].strip().strip('"')
        if not order_id_raw.isdigit():
            continue
        try:
            settlement_krw = int(float(cols[12].strip().strip('"')))
        except (ValueError, IndexError):
            continue
        try:
            payment_krw = int(float(cols[7].strip().strip('"')))
        except (ValueError, IndexError):
            payment_krw = settlement_krw
        rows.append({
            "order_id": order_id_raw,
            "category": cols[5].strip().strip('"'),
            "settlement_krw": settlement_krw,
            "payment_krw": payment_krw,
        })
    return rows


async def _fetch_single_ably_order(
    client: httpx.AsyncClient,
    semaphore: asyncio.Semaphore,
    order_id: str,
    jwt_token: str,
) -> tuple[str, dict | None]:
    async with semaphore:
        try:
            res = await client.get(
                f"{ABLY_BASE}/seller/order_items/{order_id}/",
                headers=_ably_headers(jwt_token),
                timeout=15.0,
            )
            if res.status_code == 200:
                data = res.json()
                item = data.get("order_item", {})
                goods_name = item.get("goods_name", "")
                quantity = item.get("ea", 1) or 1
                return order_id, {
                    "name_origin": goods_name,
                    "processed_name": preprocess_product_name(goods_name),
                    "quantity": quantity,
                }
        except Exception:
            pass
        return order_id, None


async def fetch_ably_order_details_batch(
    order_ids: list[str],
    jwt_token: str,
    concurrency: int = 10,
    cached: dict[str, dict] | None = None,
) -> dict[str, dict | None]:
    cached = cached or {}
    result: dict[str, dict | None] = dict(cached)
    to_fetch = [oid for oid in order_ids if oid not in cached]

    if not to_fetch:
        return result

    semaphore = asyncio.Semaphore(concurrency)
    async with httpx.AsyncClient(timeout=15.0) as client:
        tasks = [
            _fetch_single_ably_order(client, semaphore, oid, jwt_token)
            for oid in to_fetch
        ]
        for coro in asyncio.as_completed(tasks):
            oid, detail = await coro
            result[oid] = detail

    return result
