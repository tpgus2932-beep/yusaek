import asyncio
import sys
from pathlib import Path

import httpx
import pytest
import respx

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import services.order_recommendation_ezadmin_collectors as ez_collect_mod
from sdk.ezadmin import EzAdminSessionExpired
from services.order_recommendation_ezadmin_collectors import (
    _fetch_ably_io30_snapshot,
    build_ezadmin_collectors,
)

_IO30_URL = "https://ga80.ezadmin.co.kr/function.htm"


def _setting(sessid="sess123"):
    return lambda key: sessid if key == "ezadmin_phpsessid" else None


def _cell(product_id, stock, reserve_qty, lack_qty):
    return {
        "product_id": product_id,
        "stock": f"<a class=atd href='#' onclick=javascript:run_stock(this)>{stock}</a>",
        "reserve_qty": f"<input type='text' class='input22 right' value='{reserve_qty}' org_value='{reserve_qty}'>",
        "lack_qty": str(lack_qty),
    }


@respx.mock
def test_fetch_snapshot_parses_single_page_response():
    ez_collect_mod._cache.clear()
    respx.post(_IO30_URL).mock(
        return_value=httpx.Response(
            200,
            json={
                "rows": [
                    {"id": 0, "cell": _cell("S24083", 0, 5, 3)},
                    {"id": 1, "cell": _cell("S24067", 2, 1, 0)},
                ],
                "total": 1,
            },
        )
    )

    snapshot = asyncio.run(_fetch_ably_io30_snapshot(_setting(), "2026-07-30"))

    assert snapshot == {
        "S24083": {"stock_qty": 0, "incoming_qty": 5, "ezadmin_lack_qty": 3},
        "S24067": {"stock_qty": 2, "incoming_qty": 1, "ezadmin_lack_qty": 0},
    }


@respx.mock
def test_fetch_snapshot_skips_rows_with_empty_product_id():
    ez_collect_mod._cache.clear()
    respx.post(_IO30_URL).mock(
        return_value=httpx.Response(
            200,
            json={"rows": [{"id": 0, "cell": _cell("", 0, 5, 3)}], "total": 1},
        )
    )

    snapshot = asyncio.run(_fetch_ably_io30_snapshot(_setting(), "2026-07-30"))

    assert snapshot == {}


@respx.mock
def test_fetch_snapshot_follows_pagination_across_pages():
    ez_collect_mod._cache.clear()
    route = respx.post(_IO30_URL).mock(
        side_effect=[
            httpx.Response(200, json={"rows": [{"id": 0, "cell": _cell("S24083", 0, 5, 3)}], "total": 2}),
            httpx.Response(200, json={"rows": [{"id": 0, "cell": _cell("S24067", 2, 1, 0)}], "total": 2}),
        ]
    )

    snapshot = asyncio.run(_fetch_ably_io30_snapshot(_setting(), "2026-07-30"))

    assert set(snapshot.keys()) == {"S24083", "S24067"}
    assert route.call_count == 2


def test_fetch_snapshot_raises_session_expired_when_no_phpsessid_configured():
    ez_collect_mod._cache.clear()
    with pytest.raises(EzAdminSessionExpired):
        asyncio.run(_fetch_ably_io30_snapshot(_setting(sessid=None), "2026-07-30"))


@respx.mock
def test_fetch_snapshot_raises_session_expired_on_login_page_response():
    ez_collect_mod._cache.clear()
    respx.post(_IO30_URL).mock(
        return_value=httpx.Response(200, text="<html><body>login required</body></html>")
    )

    with pytest.raises(EzAdminSessionExpired):
        asyncio.run(_fetch_ably_io30_snapshot(_setting(), "2026-07-30"))


@respx.mock
def test_fetch_snapshot_caches_within_ttl_for_same_date():
    ez_collect_mod._cache.clear()
    route = respx.post(_IO30_URL).mock(
        return_value=httpx.Response(
            200, json={"rows": [{"id": 0, "cell": _cell("S24083", 0, 5, 3)}], "total": 1}
        )
    )

    first = asyncio.run(_fetch_ably_io30_snapshot(_setting(), "2026-07-30"))
    second = asyncio.run(_fetch_ably_io30_snapshot(_setting(), "2026-07-30"))

    assert first == second
    assert route.call_count == 1


@respx.mock
def test_build_ezadmin_collectors_returns_three_columns_from_shared_fetch():
    ez_collect_mod._cache.clear()
    route = respx.post(_IO30_URL).mock(
        return_value=httpx.Response(
            200,
            json={
                "rows": [
                    {"id": 0, "cell": _cell("S24083", 0, 5, 3)},
                    {"id": 1, "cell": _cell("S24067", 2, 1, 0)},
                ],
                "total": 1,
            },
        )
    )

    collectors = build_ezadmin_collectors(_setting())
    assert set(collectors.keys()) == {"stock_qty", "incoming_qty", "ezadmin_lack_qty"}

    stock = asyncio.run(collectors["stock_qty"]("2026-07-30"))
    incoming = asyncio.run(collectors["incoming_qty"]("2026-07-30"))
    lack = asyncio.run(collectors["ezadmin_lack_qty"]("2026-07-30"))

    assert stock == {"S24083": 0, "S24067": 2}
    assert incoming == {"S24083": 5, "S24067": 1}
    assert lack == {"S24083": 3, "S24067": 0}
    assert route.call_count == 1
