import asyncio
import sqlite3
import sys
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sdk.ezadmin import EzAdminSessionExpired
from services.order_recommendation_discover import (
    discover_missed_reorder_candidates,
    _recent_avg_sales_candidates,
)
from services.order_recommendation_store import ensure_row, init_order_recommendation_tables, today_kst


def _make_db_factory(label):
    uri = f"file:test_order_recommendation_discover_{label}_{uuid.uuid4().hex}?mode=memory&cache=shared"
    keep_alive = sqlite3.connect(uri, uri=True)
    keep_alive.row_factory = sqlite3.Row

    def factory():
        conn = sqlite3.connect(uri, uri=True)
        conn.row_factory = sqlite3.Row
        return conn

    return factory, keep_alive


def _date_minus(date, days):
    return (datetime.strptime(date, "%Y-%m-%d") - timedelta(days=days)).strftime("%Y-%m-%d")


def _seed_sales(conn, code, today, daily_qty_by_offset):
    """offset=1 -> 어제, offset=2 -> 그저께 ... 로 sales_qty를 채운다."""
    for offset, qty in daily_qty_by_offset.items():
        date = _date_minus(today, offset)
        ensure_row(conn, date, code)
        conn.execute(
            "UPDATE order_recommendation_daily SET sales_qty = ? WHERE date = ? AND yusas_code = ?",
            (qty, date, code),
        )
    conn.commit()


def _make_misong_db():
    get_shared_db, keep_alive = _make_db_factory("shared")
    conn = get_shared_db()
    conn.execute("CREATE TABLE misong_items (original_f TEXT, F INTEGER)")
    conn.commit()
    conn.close()
    return get_shared_db, keep_alive


def test_recent_avg_sales_excludes_products_with_todays_row():
    get_db, _keep_alive = _make_db_factory("candidates")
    init_order_recommendation_tables(get_db)
    conn = get_db()
    today = today_kst()

    _seed_sales(conn, "S1", today, {1: 10, 2: 10, 3: 10})  # 오늘자 행 없음 -> 후보
    _seed_sales(conn, "S2", today, {1: 100, 2: 100, 3: 100})
    ensure_row(conn, today, "S2")  # 오늘자 행 있음 -> 이미 IO30에 잡힘, 제외
    conn.commit()

    candidates = _recent_avg_sales_candidates(conn, today, 3, 150)
    codes = [c for c, _avg in candidates]
    assert "S1" in codes
    assert "S2" not in codes
    conn.close()


def test_recent_avg_sales_orders_by_average_descending_and_respects_limit():
    get_db, _keep_alive = _make_db_factory("order")
    init_order_recommendation_tables(get_db)
    conn = get_db()
    today = today_kst()

    _seed_sales(conn, "LOW", today, {1: 1, 2: 1, 3: 1})
    _seed_sales(conn, "HIGH", today, {1: 20, 2: 20, 3: 20})
    _seed_sales(conn, "MID", today, {1: 5, 2: 5, 3: 5})
    conn.commit()

    candidates = _recent_avg_sales_candidates(conn, today, 3, 2)
    assert [c for c, _avg in candidates] == ["HIGH", "MID"]
    conn.close()


def _patched_ezadmin(stock_pending_by_code, *, raise_session_expired_for=None):
    async def _get_stock_and_pending(self, product_id):
        if raise_session_expired_for and product_id in raise_session_expired_for:
            raise EzAdminSessionExpired()
        return stock_pending_by_code[product_id]

    return patch(
        "services.order_recommendation_discover.EzAdminClient.get_stock_and_pending",
        new=_get_stock_and_pending,
    )


def test_discover_uses_pending_as_lack_qty_and_misong_as_incoming_qty():
    get_db, _keep_alive = _make_db_factory("full")
    init_order_recommendation_tables(get_db)
    conn = get_db()
    today = today_kst()
    code = "S24083"

    # 요일 이력 없이 최근 판매만: previous_day_sales_qty=10 -> expected_sales_today=10 (가중치 재정규화)
    _seed_sales(conn, code, today, {1: 10, 2: 10, 3: 10})
    conn.commit()
    conn.close()

    get_shared_db, _shared_keep_alive = _make_misong_db()
    shared_conn = get_shared_db()
    shared_conn.execute("INSERT INTO misong_items (original_f, F) VALUES (?, ?)", (code, 7))
    shared_conn.commit()
    shared_conn.close()

    with _patched_ezadmin({code: {"stock": 0, "pending": 21}}):
        result = asyncio.run(
            discover_missed_reorder_candidates(
                get_db, lambda key: None, get_shared_db, days=3, limit=150
            )
        )

    assert result["need_ezadmin_session"] is False
    items = result["items"]
    assert len(items) == 1
    item = items[0]
    assert item["yusas_code"] == code
    assert item["stock_qty"] == 0
    assert item["pending_qty"] == 21
    assert item["misong_qty"] == 7
    # 확정수량 = max(0, (부족수량자리=접수 21 + 추천발주량) - 재고(0) - 미송자리=misong(7))
    assert item["confirmed_qty"] == max(0, (21 + item["recommended_qty"]) - 0 - 7)
    assert item["confirmed_qty"] > 0


def test_discover_skips_candidates_with_non_positive_confirmed_qty():
    get_db, _keep_alive = _make_db_factory("zero")
    init_order_recommendation_tables(get_db)
    conn = get_db()
    today = today_kst()
    code = "S1"
    _seed_sales(conn, code, today, {1: 10, 2: 10, 3: 10})
    conn.commit()
    conn.close()

    get_shared_db, _shared_keep_alive = _make_misong_db()

    # 재고/미송이 넉넉해서 확정수량이 0 이하가 되는 상황
    with _patched_ezadmin({code: {"stock": 1000, "pending": 0}}):
        result = asyncio.run(
            discover_missed_reorder_candidates(get_db, lambda key: None, get_shared_db, days=3, limit=150)
        )

    assert result["items"] == []


def test_discover_flags_need_ezadmin_session_and_skips_that_code():
    get_db, _keep_alive = _make_db_factory("session")
    init_order_recommendation_tables(get_db)
    conn = get_db()
    today = today_kst()
    _seed_sales(conn, "S1", today, {1: 10, 2: 10, 3: 10})
    conn.commit()
    conn.close()

    get_shared_db, _shared_keep_alive = _make_misong_db()

    with _patched_ezadmin({}, raise_session_expired_for={"S1"}):
        result = asyncio.run(
            discover_missed_reorder_candidates(get_db, lambda key: None, get_shared_db, days=3, limit=150)
        )

    assert result["need_ezadmin_session"] is True
    assert result["items"] == []


def test_discover_returns_empty_when_no_candidates():
    get_db, _keep_alive = _make_db_factory("empty")
    init_order_recommendation_tables(get_db)
    get_shared_db, _shared_keep_alive = _make_misong_db()

    result = asyncio.run(
        discover_missed_reorder_candidates(get_db, lambda key: None, get_shared_db, days=3, limit=150)
    )

    assert result == {
        "date": today_kst(),
        "days": 3, "limit": 150, "candidate_count": 0,
        "need_ezadmin_session": False, "items": [],
    }
