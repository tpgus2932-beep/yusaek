import asyncio
import sqlite3
import sys
import uuid
from pathlib import Path
from unittest.mock import patch

import httpx
import pytest
import respx

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sdk.ably import AblyClient
from services.order_recommendation_ably_sales import (
    _backfill_date_range,
    _fetch_goods_sno_stats,
    _missing_dates,
    collect_ably_sales_history,
    get_sales_history_progress,
)
from services.order_recommendation_store import (
    ensure_row,
    get_row,
    init_order_recommendation_tables,
    today_kst,
)

_LOGIN_URL = "https://api.a-bly.com/seller/login/"
_STATS_URL = "https://api.a-bly.com/seller/statistics/goods/"


def _make_db_factory():
    uri = f"file:test_order_recommendation_ably_sales_{uuid.uuid4().hex}?mode=memory&cache=shared"
    keep_alive = sqlite3.connect(uri, uri=True)
    keep_alive.row_factory = sqlite3.Row

    def factory():
        conn = sqlite3.connect(uri, uri=True)
        conn.row_factory = sqlite3.Row
        return conn

    return factory, keep_alive


def _mock_login():
    respx.post(_LOGIN_URL).mock(return_value=httpx.Response(200, json={"token": "test-token"}))


def _goods_option(sno, order_count, cart_count):
    return {"goods_option_sno": sno, "order_count": order_count, "cart_count": cart_count, "like_count": 999}


def _stats_response(goods_options):
    return {
        "results": {
            "statistics": [{"goods_sno": 1, "goods_options": goods_options}] if goods_options is not None else [],
        }
    }


def test_missing_dates_includes_dates_with_no_row():
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    conn = get_db()

    result = _missing_dates(conn, "S24083", ["2026-07-01", "2026-07-02"])

    assert result == ["2026-07-01", "2026-07-02"]
    conn.close()


def test_missing_dates_includes_dates_with_null_sales_qty():
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    conn = get_db()
    ensure_row(conn, "2026-07-01", "S24083")
    conn.commit()

    result = _missing_dates(conn, "S24083", ["2026-07-01"])

    assert result == ["2026-07-01"]
    conn.close()


def test_missing_dates_excludes_dates_already_filled():
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    conn = get_db()
    ensure_row(conn, "2026-07-01", "S24083")
    conn.execute(
        "UPDATE order_recommendation_daily SET sales_qty = 5 WHERE date = ? AND yusas_code = ?",
        ("2026-07-01", "S24083"),
    )
    conn.commit()

    result = _missing_dates(conn, "S24083", ["2026-07-01"])

    assert result == []
    conn.close()


@respx.mock
def test_fetch_goods_sno_stats_parses_goods_options():
    _mock_login()
    respx.get(_STATS_URL).mock(
        return_value=httpx.Response(200, json=_stats_response([_goods_option("111", 5, 2)]))
    )
    client = AblyClient()

    options = asyncio.run(_fetch_goods_sno_stats(client, "1", "2026-07-01"))

    assert options == [_goods_option("111", 5, 2)]


@respx.mock
def test_fetch_goods_sno_stats_returns_empty_list_when_no_statistics():
    _mock_login()
    respx.get(_STATS_URL).mock(return_value=httpx.Response(200, json=_stats_response(None)))
    client = AblyClient()

    options = asyncio.run(_fetch_goods_sno_stats(client, "1", "2026-07-01"))

    assert options == []


@respx.mock
def test_fetch_goods_sno_stats_raises_on_http_failure():
    _mock_login()
    respx.get(_STATS_URL).mock(return_value=httpx.Response(500, text="server error"))
    client = AblyClient()

    with pytest.raises(RuntimeError):
        asyncio.run(_fetch_goods_sno_stats(client, "1", "2026-07-01"))


@respx.mock
def test_collect_ably_sales_history_fills_shared_group_from_one_call():
    _mock_login()
    stats_route = respx.get(_STATS_URL).mock(
        return_value=httpx.Response(
            200,
            json=_stats_response([
                _goods_option("111", 5, 2),
                _goods_option("222", 3, 1),
            ]),
        )
    )
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)

    with patch(
        "services.order_recommendation_ably_sales.load_wonbe_goods_sno_map",
        return_value={"1": [("111", "S24083"), ("222", "S24067")]},
    ):
        updated = asyncio.run(collect_ably_sales_history(get_db))

    assert updated == 56  # 28개 날짜 x 2개 상품코드
    assert stats_route.call_count == 28  # goods_sno가 1개뿐이라 날짜당 1번만 호출

    conn = get_db()
    target_date = _backfill_date_range(today_kst())[0]
    row_a = get_row(conn, target_date, "S24083")
    row_b = get_row(conn, target_date, "S24067")
    assert row_a["sales_qty"] == 5
    assert row_a["cart_count"] == 2
    assert row_a["wish_count"] is None
    assert row_b["sales_qty"] == 3
    assert row_b["cart_count"] == 1
    conn.close()


@respx.mock
def test_collect_ably_sales_history_skips_already_filled_dates():
    _mock_login()
    stats_route = respx.get(_STATS_URL).mock(
        return_value=httpx.Response(200, json=_stats_response([_goods_option("111", 5, 2)]))
    )
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    conn = get_db()
    all_dates = _backfill_date_range(today_kst())
    for date in all_dates:
        ensure_row(conn, date, "S24083")
        conn.execute(
            "UPDATE order_recommendation_daily SET sales_qty = 99 WHERE date = ? AND yusas_code = ?",
            (date, "S24083"),
        )
    conn.commit()
    conn.close()

    with patch(
        "services.order_recommendation_ably_sales.load_wonbe_goods_sno_map",
        return_value={"1": [("111", "S24083")]},
    ):
        updated = asyncio.run(collect_ably_sales_history(get_db))

    assert updated == 0
    assert stats_route.call_count == 0


@respx.mock
def test_collect_ably_sales_history_ignores_unmapped_option_sno():
    _mock_login()
    respx.get(_STATS_URL).mock(
        return_value=httpx.Response(
            200,
            json=_stats_response([
                _goods_option("111", 5, 2),
                _goods_option("999", 100, 50),  # 매핑에 없는 옵션
            ]),
        )
    )
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)

    with patch(
        "services.order_recommendation_ably_sales.load_wonbe_goods_sno_map",
        return_value={"1": [("111", "S24083")]},
    ):
        updated = asyncio.run(collect_ably_sales_history(get_db))

    assert updated == 28  # S24083만, 999는 무시


@respx.mock
def test_collect_ably_sales_history_limits_concurrent_fetches():
    _mock_login()
    concurrent = 0
    max_concurrent = 0

    async def _side_effect(request):
        nonlocal concurrent, max_concurrent
        concurrent += 1
        max_concurrent = max(max_concurrent, concurrent)
        await asyncio.sleep(0.01)
        concurrent -= 1
        return httpx.Response(200, json=_stats_response([_goods_option("111", 1, 0)]))

    respx.get(_STATS_URL).mock(side_effect=_side_effect)

    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    # goods_sno 10개 x 28일 = 280번 호출될 여지를 만들어 동시성이 실제로 발동하는지 본다.
    goods_sno_map = {str(i): [(f"opt{i}", f"S{i}")] for i in range(10)}

    with patch(
        "services.order_recommendation_ably_sales.load_wonbe_goods_sno_map",
        return_value=goods_sno_map,
    ):
        asyncio.run(collect_ably_sales_history(get_db))

    assert 1 < max_concurrent <= 8


def test_get_sales_history_progress_returns_default_when_never_run():
    progress = get_sales_history_progress("never-ran-user")

    assert progress == {"running": False, "total": 0, "done": 0, "updated": 0}


@respx.mock
def test_collect_ably_sales_history_updates_progress_to_completed_state():
    _mock_login()
    respx.get(_STATS_URL).mock(
        return_value=httpx.Response(
            200,
            json=_stats_response([
                _goods_option("111", 5, 2),
                _goods_option("222", 3, 1),
            ]),
        )
    )
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)

    with patch(
        "services.order_recommendation_ably_sales.load_wonbe_goods_sno_map",
        return_value={"1": [("111", "S24083"), ("222", "S24067")]},
    ):
        updated = asyncio.run(collect_ably_sales_history(get_db, user="tester"))

    progress = get_sales_history_progress("tester")
    assert progress == {"running": False, "total": 28, "done": 28, "updated": updated}
