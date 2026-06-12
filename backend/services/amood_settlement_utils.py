from __future__ import annotations

import asyncio
import io
import re
from datetime import datetime, timezone

import httpx

PASTELCO_BASE = "https://api.pastelco.jp"
ABLY_MARKET_SNO = "63472"


def _settlement_headers(jwt_token: str) -> dict:
    """정산 관련 API (my.a-bly.com 포털)"""
    return {
        "Authorization": f"JWT {jwt_token}",
        "Accept": "application/json, text/plain, */*",
        "Origin": "https://my.a-bly.com",
        "Referer": "https://my.a-bly.com/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "x-token-type": "ably",
    }


def _order_headers(jwt_token: str) -> dict:
    """주문 상세 API (seller.amood.jp 포털)"""
    return {
        "Authorization": f"JWT {jwt_token}",
        "Accept": "application/json, text/plain, */*",
        "Origin": "https://seller.amood.jp",
        "Referer": "https://seller.amood.jp/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "x-token-type": "ably",
    }


def preprocess_product_name(name: str) -> str:
    if not name:
        return ""
    s = str(name).strip()
    # 선행 [...] 괄호 제거 (반복 적용)
    while True:
        ns = re.sub(r"^\s*\[[^\]]*\]\s*", "", s)
        if ns == s:
            break
        s = ns.strip()
    # 후행 (...) 괄호 제거 (반복 적용)
    while True:
        ns = re.sub(r"\s*\([^)]*\)\s*$", "", s)
        if ns == s:
            break
        s = ns.strip()
    return re.sub(r"\s+", " ", s).strip()


async def fetch_settlement_history_list(jwt_token: str, start: str, end: str) -> list[dict]:
    """
    정산 회차 목록 조회.
    start/end: "YYYY-MM" 형식
    반환: [{id, scheduled_at, is_completed, ...}]
    """
    async with httpx.AsyncClient(timeout=20.0) as client:
        res = await client.get(
            f"{PASTELCO_BASE}/seller/settlements/histories/",
            headers=_settlement_headers(jwt_token),
            params={"start": start, "end": end},
        )
        res.raise_for_status()
    data = res.json()
    if isinstance(data, list):
        return data
    if "settlements" in data:
        return data["settlements"]
    for key in ("results", "items", "histories", "data"):
        if key in data and isinstance(data[key], list):
            return data[key]
    return []


def build_settlement_download_url(history_id: int | str) -> str:
    return (
        f"{PASTELCO_BASE}/seller/settlements/histories/{history_id}/download/"
        f"?ably_market_sno={ABLY_MARKET_SNO}"
    )


async def fetch_settlement_csv(download_url: str, jwt_token: str) -> list[dict]:
    """
    CSV 다운로드 후 파싱.
    반환: [{order_id, settlement_krw, category, purchase_confirm_date, scheduled_date}]
    """
    async with httpx.AsyncClient(timeout=30.0) as client:
        res = await client.get(download_url, headers=_settlement_headers(jwt_token))
        res.raise_for_status()

    # CSV 디코딩 (UTF-8 or EUC-KR 시도)
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
        # 헤더 행 스킵: 7번째 컬럼이 숫자인지 확인
        order_id_raw = cols[6].strip().strip('"')
        if not order_id_raw.isdigit():
            continue
        try:
            settlement_krw = int(float(cols[12].strip().strip('"')))
        except (ValueError, IndexError):
            continue
        rows.append({
            "order_id": order_id_raw,
            "category": cols[5].strip().strip('"'),
            "purchase_confirm_date": cols[2].strip().strip('"'),
            "scheduled_date": cols[3].strip().strip('"'),
            "settlement_krw": settlement_krw,
        })
    return rows


async def _fetch_single_order(
    client: httpx.AsyncClient,
    semaphore: asyncio.Semaphore,
    order_id: str,
    jwt_token: str,
) -> tuple[str, dict | None]:
    async with semaphore:
        try:
            res = await client.get(
                f"{PASTELCO_BASE}/seller/orders/{order_id}/",
                headers=_order_headers(jwt_token),
                timeout=15.0,
            )
            if res.status_code == 200:
                data = res.json()
                product = data.get("product", {})
                name_origin = product.get("name_origin", "")
                quantity = data.get("quantity", 1)
                return order_id, {
                    "name_origin": name_origin,
                    "processed_name": preprocess_product_name(name_origin),
                    "quantity": quantity,
                }
        except Exception:
            pass
        return order_id, None


async def fetch_order_details_batch(
    order_ids: list[str],
    jwt_token: str,
    concurrency: int = 10,
    cached: dict[str, dict] | None = None,
) -> dict[str, dict | None]:
    """
    주문번호 목록으로 상세 정보 일괄 조회.
    cached: {order_id: {name_origin, processed_name, quantity}} 이미 캐시된 항목
    """
    cached = cached or {}
    result: dict[str, dict | None] = dict(cached)
    to_fetch = [oid for oid in order_ids if oid not in cached]

    if not to_fetch:
        return result

    semaphore = asyncio.Semaphore(concurrency)
    async with httpx.AsyncClient(timeout=15.0) as client:
        tasks = [
            _fetch_single_order(client, semaphore, oid, jwt_token)
            for oid in to_fetch
        ]
        for coro in asyncio.as_completed(tasks):
            oid, detail = await coro
            result[oid] = detail

    return result


def aggregate_by_product(
    csv_rows: list[dict],
    order_details: dict[str, dict | None],
    cost_map: dict[str, int],
    per_item_cost: int,
) -> tuple[list[dict], dict]:
    """
    상품명별 집계 + 전체 합계 계산.
    반환: (items, summary)
    """
    buckets: dict[str, dict] = {}

    for row in csv_rows:
        oid = row["order_id"]
        settlement = row["settlement_krw"]
        detail = order_details.get(oid)

        if detail is None:
            name = f"[조회실패:{oid}]"
            quantity = 1
        else:
            name = detail["processed_name"] or f"[이름없음:{oid}]"
            quantity = detail.get("quantity") or 1

        if name not in buckets:
            buckets[name] = {
                "product_name": name,
                "order_count": 0,
                "total_quantity": 0,
                "total_settlement_krw": 0,
                "orders": [],
            }
        buckets[name]["order_count"] += 1
        buckets[name]["total_quantity"] += quantity
        buckets[name]["total_settlement_krw"] += settlement
        buckets[name]["orders"].append({
            "order_id": oid,
            "quantity": quantity,
            "settlement_krw": settlement,
        })

    items = []
    total_settlement = 0
    total_cost = 0
    total_extra = 0
    total_margin = 0
    unmatched_count = 0

    for name, bucket in sorted(buckets.items()):
        cost_price = cost_map.get(name)
        matched = cost_price is not None

        # 정산금액이 원가보다 낮은 주문(환불·취소 등) 제외
        if matched and cost_price > 0:
            valid_orders = [o for o in bucket["orders"] if o["settlement_krw"] >= cost_price]
        else:
            valid_orders = bucket["orders"]

        if not valid_orders:
            continue

        qty = sum(o["quantity"] for o in valid_orders)
        settlement = sum(o["settlement_krw"] for o in valid_orders)

        if matched:
            item_cost = cost_price * qty
            item_vat = round(item_cost * 0.1)
            item_extra = per_item_cost * qty
            item_margin = settlement - item_cost - item_vat - item_extra
            margin_rate = round(item_margin / settlement * 100, 1) if settlement else 0.0
        else:
            item_cost = None
            item_vat = None
            item_extra = per_item_cost * qty
            item_margin = None
            margin_rate = None
            unmatched_count += 1

        items.append({
            "product_name": name,
            "order_count": len(valid_orders),
            "total_quantity": qty,
            "total_settlement_krw": settlement,
            "cost_price": cost_price,
            "total_cost": item_cost,
            "total_vat": item_vat,
            "per_item_extra_cost": per_item_cost,
            "total_extra_cost": item_extra,
            "total_margin": item_margin,
            "margin_rate": margin_rate,
            "matched": matched,
            "orders": sorted(valid_orders, key=lambda o: o["order_id"]),
        })

        total_settlement += settlement
        if matched:
            total_cost += item_cost
            total_extra += item_extra
            total_margin += item_margin

    matched_settlement = sum(
        it["total_settlement_krw"] for it in items if it["matched"]
    )
    overall_margin_rate = (
        round(total_margin / matched_settlement * 100, 1)
        if matched_settlement
        else 0.0
    )

    summary = {
        "total_orders": len(csv_rows),
        "total_products": len(items),
        "unmatched_count": unmatched_count,
        "total_settlement_krw": total_settlement,
        "total_cost": total_cost,
        "total_extra_cost": total_extra,
        "total_margin": total_margin,
        "overall_margin_rate": overall_margin_rate,
    }

    return items, summary


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()
