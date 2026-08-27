from __future__ import annotations

import os
import re

import httpx

TOP90_BASE = "https://top90.sosolution.net"
TOP90_EMAIL = os.environ.get("TOP90_EMAIL", "")
TOP90_PASSWORD = os.environ.get("TOP90_PASSWORD", "")

_HEADERS = {
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
    "accept-language": "ko-KR,ko;q=0.9",
    "origin": TOP90_BASE,
    "x-requested-with": "XMLHttpRequest",
}

_SHOP_NAME_RE = re.compile(
    r"class=\"shop-name\"[^>]*onclick=\"[^\"]*'a_idx'\s*:\s*'(\d+)'\s*,\s*'cs_idx'\s*:\s*'(\d*)'\s*,\s*'s_idx'\s*:\s*'(\d+)'[^\"]*\"[^>]*>\s*(.*?)\s*</span",
    re.DOTALL,
)
_SHOP_ADDR_RE = re.compile(
    r"shop-addr[^>]*onclick=\"[^\"]*'a_idx'\s*:\s*'(\d+)'[^\"]*\"[^>]*>(.*?)<i class=",
    re.DOTALL,
)
_PHONE_RE = re.compile(r'href=[\'"]tel:([0-9\-]+)[\'"]')
_INPUT_FIELD_RE = re.compile(r'<input[^>]+name=["\']([^"\']+)["\'][^>]*value=["\']([^"\']*)["\']')


class Top90Error(Exception):
    pass


async def _login(client: httpx.AsyncClient) -> None:
    if not TOP90_EMAIL or not TOP90_PASSWORD:
        raise Top90Error("TOP90_EMAIL / TOP90_PASSWORD 환경변수가 설정되어 있지 않습니다.")
    await client.get(f"{TOP90_BASE}/login", headers={**_HEADERS, "referer": f"{TOP90_BASE}/login"})
    r = await client.post(
        f"{TOP90_BASE}/login/auth",
        data={"login_email": TOP90_EMAIL, "login_password": TOP90_PASSWORD, "login_remember": "on"},
        headers={**_HEADERS, "referer": f"{TOP90_BASE}/login"},
    )
    r.raise_for_status()


def _parse_shop_search_html(html: str) -> list[dict]:
    stores = []
    outer_blocks = re.split(
        r'(?=<tr[^>]*>\s*<td[^>]*>\s*<span class="text-success shop-addr")', html
    )
    for block in outer_blocks:
        addr_m = _SHOP_ADDR_RE.search(block)
        if not addr_m:
            continue
        a_idx_base = addr_m.group(1)
        addr = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", addr_m.group(2))).strip()
        for sm in _SHOP_NAME_RE.finditer(block):
            name = re.sub(r"\s+", " ", sm.group(4)).strip()
            if name:
                stores.append({
                    "a_idx": a_idx_base,
                    "s_idx": sm.group(3),
                    "cs_idx": sm.group(2),
                    "name": name,
                    "addr": addr,
                    "phone": (_PHONE_RE.findall(block) or [""])[0],
                })
    return stores


async def search_shop(client: httpx.AsyncClient, keyword: str) -> list[dict]:
    r = await client.post(
        f"{TOP90_BASE}/lib/shop_search",
        data={"obj[type]": "shop-name", "obj[target]": "db-shop", "obj[tag]": keyword},
        headers={
            **_HEADERS,
            "referer": f"{TOP90_BASE}/excel/excel",
            "accept": "text/html, */*; q=0.01",
            "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        },
    )
    return _parse_shop_search_html(r.content.decode("utf-8", errors="replace"))


def find_store_match(stores: list[dict], store_name: str) -> dict:
    """이름이 정확히 일치하는 매장만 채택한다 (오배송 방지)."""
    target = re.sub(r"\s+", " ", store_name).strip()
    candidates = [s for s in stores if s["name"] == target]
    registered = [s for s in candidates if s["cs_idx"].isdigit()]
    if registered:
        best = max(registered, key=lambda s: int(s["cs_idx"]))
        return {"status": "matched", "cs_idx": best["cs_idx"], "shop_idx": best["s_idx"]}
    if candidates:
        c = candidates[0]
        return {"status": "unregistered", "a_idx": c["a_idx"], "s_idx": c["s_idx"]}
    return {"status": "not_found"}


async def register_and_match_shop(
    client: httpx.AsyncClient, a_idx: str, s_idx: str, cs_name: str, cs_nick: str = ""
) -> str:
    """미등록 매장을 거래처로 등록하고, 새로 발급된 cs_idx를 반환한다. 실패 시 빈 문자열."""
    r = await client.post(
        f"{TOP90_BASE}/lib/shop",
        data={
            "target[a_idx]": a_idx, "target[cs_idx]": "",
            "target[s_idx]": s_idx, "target[type]": "match-shop",
            "target[cs_name]": cs_name, "target[match_id]": "0",
        },
        headers={
            **_HEADERS,
            "referer": f"{TOP90_BASE}/excel/excel",
            "accept": "text/html, */*; q=0.01",
            "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        },
    )
    html = r.content.decode("utf-8", errors="replace")
    fields = dict(_INPUT_FIELD_RE.findall(html))

    await client.post(
        f"{TOP90_BASE}/lib/set_order",
        files={
            "target": (None, "match-shop"),
            "a_idx": (None, fields.get("a_idx", a_idx)),
            "s_idx": (None, fields.get("s_idx", s_idx)),
            "match_id": (None, "0"),
            "building": (None, fields.get("building", "")),
            "floor": (None, fields.get("floor", "")),
            "area": (None, ""),
            "line": (None, fields.get("line", "")),
            "ho1": (None, fields.get("ho1", "")),
            "ho2": (None, ""),
            "cs_nick": (None, cs_nick or cs_name),
            "s_name1": (None, fields.get("s_name1", cs_name)),
            "userfile[]": ("", b"", "application/octet-stream"),
        },
        headers={
            **_HEADERS,
            "referer": f"{TOP90_BASE}/excel/excel",
            "accept": "application/json, text/javascript, */*; q=0.01",
        },
    )

    stores = await search_shop(client, cs_nick or cs_name)
    max_cs, found_cs = 0, ""
    for s in stores:
        if s["s_idx"] == s_idx and s["cs_idx"].isdigit() and int(s["cs_idx"]) > max_cs:
            max_cs, found_cs = int(s["cs_idx"]), s["cs_idx"]
    return found_cs


async def place_orders_for_store(
    client: httpx.AsyncClient,
    cs_idx: str,
    shop_idx: str,
    store_name: str,
    product_names: list[str],
    category: str = "",
    message: str = "",
) -> None:
    """같은 거래처(cs_idx+shop_idx)로 나가는 상품들을 한 번에 발주."""
    msg_formatted = message.replace("? ", "?\n", 1) if message else ""
    pname_combined = "\n".join(product_names)
    textarea = f"{store_name}\t주문\t{pname_combined}\t{category}\t{msg_formatted}"

    r = await client.post(
        f"{TOP90_BASE}/excel/excel_convert",
        data={
            "excel-textarea": textarea, "type": "saib",
            "cs_idx[]": cs_idx, "shop_idx[]": shop_idx,
            "d_money[]": "0", "type[]": "주문",
            "pname[]": pname_combined, "pcolor[]": category, "psize[]": msg_formatted,
            "pcount[]": "", "pcost[]": "", "pmemo[]": "",
            "pimg[]": "", "pcode[]": "", "psname[]": "",
        },
        headers={
            **_HEADERS,
            "referer": f"{TOP90_BASE}/excel/excel",
            "accept": "application/json, text/javascript, */*; q=0.01",
            "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        },
    )
    r.raise_for_status()


async def execute_main_orders(groups: dict[str, list[str]]) -> dict:
    """groups: {매장명: [상품명 문자열, ...]}. 매장별로 매칭/등록 후 발주를 실행한다."""
    success: list[dict] = []
    failed: list[dict] = []

    async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
        await _login(client)
        for store_name, product_names in groups.items():
            try:
                stores = await search_shop(client, store_name)
                match = find_store_match(stores, store_name)

                if match["status"] == "matched":
                    cs_idx, shop_idx = match["cs_idx"], match["shop_idx"]
                elif match["status"] == "unregistered":
                    cs_idx = await register_and_match_shop(
                        client, match["a_idx"], match["s_idx"], store_name
                    )
                    shop_idx = match["s_idx"]
                    if not cs_idx:
                        failed.append({"store_name": store_name, "reason": "거래처 등록 실패"})
                        continue
                else:
                    failed.append({
                        "store_name": store_name,
                        "reason": "top90에서 매장명을 찾을 수 없음 (수동 매칭 필요)",
                    })
                    continue

                try:
                    await place_orders_for_store(client, cs_idx, shop_idx, store_name, product_names)
                except httpx.HTTPStatusError as exc:
                    if exc.response.status_code == 401:
                        await _login(client)
                        await place_orders_for_store(client, cs_idx, shop_idx, store_name, product_names)
                    else:
                        raise
                success.append({"store_name": store_name, "count": len(product_names)})
            except Exception as exc:
                failed.append({"store_name": store_name, "reason": f"{type(exc).__name__}: {exc}"})

    return {"success": success, "failed": failed}
