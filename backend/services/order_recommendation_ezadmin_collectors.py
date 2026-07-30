from __future__ import annotations

import time

from services.ezadmin_io30_client import ez_val, fetch_io30_rows, to_int

_CACHE_TTL_SECONDS = 30
_ABLY_SHOP_CODE = "10028"

_cache: dict[str, tuple[float, dict[str, dict]]] = {}


async def _fetch_ably_io30_snapshot(get_setting, date: str) -> dict[str, dict]:
    """EZAdmin IO30(에이블리 채널, str_shop_code=10028)을 조회해
    {product_id: {"stock_qty", "incoming_qty", "ezadmin_lack_qty"}}로 반환한다.
    같은 date로 _CACHE_TTL_SECONDS 안에 재호출되면 캐시를 재사용한다.
    PHPSESSID 미설정/세션 만료 시 EzAdminSessionExpired가 그대로 전파된다
    (실패한 조회는 캐시하지 않음)."""
    cached = _cache.get(date)
    now = time.monotonic()
    if cached is not None and (now - cached[0]) < _CACHE_TTL_SECONDS:
        return cached[1]

    rows = await fetch_io30_rows(
        get_setting,
        shop_par_fragment=f"multi_shop_group=&multi_shop=&str_shop_code={_ABLY_SHOP_CODE}",
    )

    snapshot: dict[str, dict] = {}
    for cell in rows:
        product_id = ez_val(cell.get("product_id")).strip()
        if not product_id:
            continue
        snapshot[product_id] = {
            "stock_qty": to_int(ez_val(cell.get("stock"))),
            "incoming_qty": to_int(ez_val(cell.get("not_yet_deliv"))),
            "ezadmin_lack_qty": to_int(ez_val(cell.get("lack_qty"))),
        }

    _cache[date] = (now, snapshot)
    return snapshot


def build_ezadmin_collectors(get_setting) -> dict:
    async def _collect_column(column: str, date: str) -> dict:
        snapshot = await _fetch_ably_io30_snapshot(get_setting, date)
        return {code: values[column] for code, values in snapshot.items()}

    async def collect_stock_qty(date: str) -> dict:
        return await _collect_column("stock_qty", date)

    async def collect_incoming_qty(date: str) -> dict:
        return await _collect_column("incoming_qty", date)

    async def collect_ezadmin_lack_qty(date: str) -> dict:
        return await _collect_column("ezadmin_lack_qty", date)

    return {
        "stock_qty": collect_stock_qty,
        "incoming_qty": collect_incoming_qty,
        "ezadmin_lack_qty": collect_ezadmin_lack_qty,
    }
