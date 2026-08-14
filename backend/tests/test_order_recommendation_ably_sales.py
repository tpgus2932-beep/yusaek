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
    ), patch(
        "services.order_recommendation_ably_sales.load_wonbe_registered_at_map",
        return_value={},
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
    ), patch(
        "services.order_recommendation_ably_sales.load_wonbe_registered_at_map",
        return_value={},
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
    ), patch(
        "services.order_recommendation_ably_sales.load_wonbe_registered_at_map",
        return_value={},
    ):
        updated = asyncio.run(collect_ably_sales_history(get_db))

    assert updated == 28  # S24083만, 999는 무시


@respx.mock
def test_collect_ably_sales_history_fills_zero_for_option_missing_from_response():
    """에이블리는 그날 판매/장바구니 활동이 없는 옵션을 응답에서 통째로 생략한다.
    매핑된 옵션인데 응답에 없으면 sales_qty=0으로 명시적으로 채워야 한다 —
    안 그러면 NULL로 남아서 _missing_dates가 영원히 재조회 대상으로 잡는다."""
    _mock_login()
    respx.get(_STATS_URL).mock(
        return_value=httpx.Response(200, json=_stats_response([_goods_option("111", 5, 2)]))
    )
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)

    with patch(
        "services.order_recommendation_ably_sales.load_wonbe_goods_sno_map",
        return_value={"1": [("111", "S24083"), ("222", "S24067")]},
    ), patch(
        "services.order_recommendation_ably_sales.load_wonbe_registered_at_map",
        return_value={},
    ):
        updated = asyncio.run(collect_ably_sales_history(get_db))

    assert updated == 56  # 28일 x 2옵션 (222는 매번 응답 생략, 0으로 채움)

    conn = get_db()
    target_date = _backfill_date_range(today_kst())[0]
    row_a = get_row(conn, target_date, "S24083")
    row_b = get_row(conn, target_date, "S24067")
    assert row_a["sales_qty"] == 5
    assert row_b["sales_qty"] == 0
    assert row_b["cart_count"] == 0
    conn.close()


@respx.mock
def test_collect_ably_sales_history_skips_dates_before_registration():
    """상품 등록일 이전 날짜는 에이블리가 통계를 안 주는 걸 '활동 0건'으로 착각해서
    sales_qty=0을 채워버리면 안 된다 — 아예 백필/조회 대상에서 제외해야 한다."""
    _mock_login()
    stats_route = respx.get(_STATS_URL).mock(
        return_value=httpx.Response(200, json=_stats_response([_goods_option("111", 5, 2)]))
    )
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)

    # _backfill_date_range는 [어제, ..., 28일 전] 순서(최신 -> 과거)이므로,
    # 앞쪽 5개(all_dates[4])를 등록일로 잡으면 최근 5일치만 허용 범위에 남는다.
    all_dates = _backfill_date_range(today_kst())
    registered_at = all_dates[4]  # 최근 5일치만 등록 이후 (나머지 23일은 등록 이전으로 제외돼야 함)

    with patch(
        "services.order_recommendation_ably_sales.load_wonbe_goods_sno_map",
        return_value={"1": [("111", "S24083")]},
    ), patch(
        "services.order_recommendation_ably_sales.load_wonbe_registered_at_map",
        return_value={"S24083": registered_at},
    ):
        updated = asyncio.run(collect_ably_sales_history(get_db))

    assert updated == 5
    assert stats_route.call_count == 5

    conn = get_db()
    excluded_date = all_dates[-1]  # 등록일보다 한참 전(28일 전, 가장 오래된 날짜)
    row = get_row(conn, excluded_date, "S24083")
    assert row is None  # 아예 조회/생성 대상이 아니었어야 함
    conn.close()


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
    ), patch(
        "services.order_recommendation_ably_sales.load_wonbe_registered_at_map",
        return_value={},
    ):
        asyncio.run(collect_ably_sales_history(get_db))

    assert 1 < max_concurrent <= 8


@respx.mock
def test_collect_ably_sales_history_skips_failed_call_and_continues():
    """1건이 1차 시도뿐 아니라 저동시성 재시도까지 계속 실패하면(영구 장애) 그 건만
    스킵하고 나머지는 정상 반영돼야 한다 — 특정 date 하나를 재시도 때도 계속
    실패하게 고정해서(호출 순번이 아니라 date 기준) 검증한다."""
    _mock_login()
    failing_date = {}

    def _side_effect(request):
        date = request.url.params.get("start_date")
        if not failing_date:
            failing_date["date"] = date  # 가장 먼저 들어온 요청의 날짜를 영구 장애 대상으로 고정
        if date == failing_date["date"]:
            raise httpx.ConnectTimeout("simulated network timeout")
        return httpx.Response(200, json=_stats_response([_goods_option("111", 5, 2)]))

    respx.get(_STATS_URL).mock(side_effect=_side_effect)

    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)

    with patch(
        "services.order_recommendation_ably_sales.load_wonbe_goods_sno_map",
        return_value={"1": [("111", "S24083")]},
    ), patch(
        "services.order_recommendation_ably_sales.load_wonbe_registered_at_map",
        return_value={},
    ):
        updated = asyncio.run(collect_ably_sales_history(get_db, user="tester"))

    # 28개 날짜 중 1건은 재시도까지 계속 네트워크 실패로 스킵, 나머지 27건은 정상 반영.
    assert updated == 27

    progress = get_sales_history_progress("tester")
    assert progress["running"] is False
    assert progress["done"] == 28  # 실패한 것도 done에는 카운트(진행률이 멈추지 않게)
    assert progress["updated"] == 27


@respx.mock
def test_collect_ably_sales_history_retries_failed_call_at_lower_concurrency_and_recovers():
    """1차 시도에서만 실패하고(예: 레이트리밋 순단) 재시도 때는 정상 응답하는 경우,
    저동시성 재시도 패스가 그 건을 회수해서 최종적으로는 전부 반영돼야 한다."""
    _mock_login()
    failed_once = {}

    def _side_effect(request):
        date = request.url.params.get("start_date")
        if not failed_once:
            failed_once["date"] = date  # 가장 먼저 들어온 요청만 1회성으로 실패시킨다
            raise httpx.ConnectTimeout("simulated transient network blip")
        return httpx.Response(200, json=_stats_response([_goods_option("111", 5, 2)]))

    respx.get(_STATS_URL).mock(side_effect=_side_effect)

    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)

    with patch(
        "services.order_recommendation_ably_sales.load_wonbe_goods_sno_map",
        return_value={"1": [("111", "S24083")]},
    ), patch(
        "services.order_recommendation_ably_sales.load_wonbe_registered_at_map",
        return_value={},
    ):
        updated = asyncio.run(collect_ably_sales_history(get_db, user="tester-retry"))

    # 1차 시도 실패 1건이 저동시성 재시도로 회수돼 28건 전부 반영돼야 한다.
    assert updated == 28

    progress = get_sales_history_progress("tester-retry")
    assert progress["running"] is False
    assert progress["done"] == 28
    assert progress["updated"] == 28


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
    ), patch(
        "services.order_recommendation_ably_sales.load_wonbe_registered_at_map",
        return_value={},
    ):
        updated = asyncio.run(collect_ably_sales_history(get_db, user="tester"))

    progress = get_sales_history_progress("tester")
    assert progress == {"running": False, "total": 28, "done": 28, "updated": updated}


@respx.mock
def test_collect_ably_sales_history_progress_done_increments_per_call_not_per_batch():
    """대시보드의 "판매량 수집" 진행률(done/total)이 0에서 안 움직이다가 막판에 갑자기
    끝나는 문제 재현: done이 배치(=1차 호출 전체) 단위로만 오르면, 그 중 한 건이라도
    느리게 응답하면 나머지가 다 끝나도 done은 0에 머문다. 빠른 호출 1건이 실제로 끝났으면
    느린 호출이 아직 안 끝났어도 done은 이미 올라가 있어야 한다."""
    _mock_login()
    release_slow = asyncio.Event()

    async def _side_effect(request):
        goods_sno = request.url.params.get("keyword")
        if goods_sno == "1":
            await release_slow.wait()
        return httpx.Response(200, json=_stats_response([_goods_option("111", 1, 0)]))

    respx.get(_STATS_URL).mock(side_effect=_side_effect)

    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    goods_sno_map = {"1": [("111", "S1")], "2": [("222", "S2")]}

    async def scenario():
        with patch(
            "services.order_recommendation_ably_sales.load_wonbe_goods_sno_map",
            return_value=goods_sno_map,
        ), patch(
            "services.order_recommendation_ably_sales.load_wonbe_registered_at_map",
            return_value={},
        ), patch(
            "services.order_recommendation_ably_sales.BACKFILL_DAYS", 1,
        ):
            task = asyncio.create_task(collect_ably_sales_history(get_db, user="progress-test"))
            for _ in range(200):
                if get_sales_history_progress("progress-test")["done"] >= 1:
                    break
                await asyncio.sleep(0.01)
            else:
                release_slow.set()
                await task
                pytest.fail("빠른 호출(goods_sno=2)이 끝났는데도 done이 0에서 안 움직였다")

            assert not task.done(), "느린 호출(goods_sno=1)이 아직 안 끝났으니 전체 수집도 안 끝나 있어야 한다"
            release_slow.set()
            await task

    asyncio.run(scenario())
