import asyncio
import sqlite3
import sys
import uuid
from pathlib import Path

import httpx
import pytest
import respx

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sdk.ezadmin import EzAdminSessionExpired
from services.order_non_ably_backorder import (
    collect_non_ably_snapshot,
    fetch_non_ably_snapshot,
    init_non_ably_backorder_table,
    list_non_ably_snapshot,
    upsert_non_ably_snapshot,
)

_IO30_URL = "https://ga80.ezadmin.co.kr/function.htm"


def _make_db_factory():
    uri = f"file:test_order_non_ably_backorder_{uuid.uuid4().hex}?mode=memory&cache=shared"
    keep_alive = sqlite3.connect(uri, uri=True)
    keep_alive.row_factory = sqlite3.Row

    def factory():
        conn = sqlite3.connect(uri, uri=True)
        conn.row_factory = sqlite3.Row
        return conn

    return factory, keep_alive


def _setting(sessid="sess123"):
    return lambda key: sessid if key == "ezadmin_phpsessid" else None


def _cell(product_id, stock, not_yet_deliv, lack_qty):
    return {
        "product_id": product_id,
        "stock": f"<a class=atd href='#' onclick=javascript:run_stock(this)>{stock}</a>",
        "not_yet_deliv": f"<a class=atd href='#' onclick=javascript:run_not_yet_deliv(this)>{not_yet_deliv}</a>",
        "lack_qty": str(lack_qty),
    }


def test_init_creates_table_with_expected_columns():
    get_db, _keep_alive = _make_db_factory()
    init_non_ably_backorder_table(get_db)
    conn = get_db()
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(order_non_ably_backorder)").fetchall()}
    assert cols == {"yusas_code", "stock_qty", "incoming_qty", "lack_qty", "updated_at"}
    conn.close()


def test_init_is_idempotent():
    get_db, _keep_alive = _make_db_factory()
    init_non_ably_backorder_table(get_db)
    init_non_ably_backorder_table(get_db)  # 두 번째 호출도 에러 없이 통과해야 함

    conn = get_db()
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(order_non_ably_backorder)").fetchall()}
    assert "yusas_code" in cols
    conn.close()


def test_upsert_inserts_new_rows():
    get_db, _keep_alive = _make_db_factory()
    init_non_ably_backorder_table(get_db)
    conn = get_db()

    upsert_non_ably_snapshot(conn, {
        "S24083": {"stock_qty": 0, "incoming_qty": 5, "lack_qty": 3},
        "S24067": {"stock_qty": 2, "incoming_qty": 1, "lack_qty": 0},
    })

    rows = list_non_ably_snapshot(conn)
    assert [r["yusas_code"] for r in rows] == ["S24067", "S24083"]
    row = conn.execute(
        "SELECT * FROM order_non_ably_backorder WHERE yusas_code = ?", ("S24083",)
    ).fetchone()
    assert row["stock_qty"] == 0
    assert row["incoming_qty"] == 5
    assert row["lack_qty"] == 3
    assert row["updated_at"] is not None
    conn.close()


def test_upsert_overwrites_existing_row_values():
    get_db, _keep_alive = _make_db_factory()
    init_non_ably_backorder_table(get_db)
    conn = get_db()

    upsert_non_ably_snapshot(conn, {"S24083": {"stock_qty": 0, "incoming_qty": 5, "lack_qty": 3}})
    first_updated_at = conn.execute(
        "SELECT updated_at FROM order_non_ably_backorder WHERE yusas_code = ?", ("S24083",)
    ).fetchone()["updated_at"]

    upsert_non_ably_snapshot(conn, {"S24083": {"stock_qty": 10, "incoming_qty": 0, "lack_qty": 0}})

    row = conn.execute(
        "SELECT * FROM order_non_ably_backorder WHERE yusas_code = ?", ("S24083",)
    ).fetchone()
    assert row["stock_qty"] == 10
    assert row["incoming_qty"] == 0
    assert row["lack_qty"] == 0
    assert row["updated_at"] is not None
    assert first_updated_at is not None
    conn.close()


def test_upsert_removes_rows_not_in_new_snapshot():
    """이번 스냅샷에 없는 코드는 EZAdmin IO30에서 더 이상 안 잡히는(해소된) 상품이므로
    예전 lack_qty가 영구히 남지 않도록 지워야 한다 — top90 발주 조회에 해소된
    부족수량이 계속 끼어드는 걸 막기 위한 동작."""
    get_db, _keep_alive = _make_db_factory()
    init_non_ably_backorder_table(get_db)
    conn = get_db()

    upsert_non_ably_snapshot(conn, {
        "S24083": {"stock_qty": 0, "incoming_qty": 5, "lack_qty": 3},
        "S24067": {"stock_qty": 2, "incoming_qty": 1, "lack_qty": 0},
    })
    upsert_non_ably_snapshot(conn, {"S24083": {"stock_qty": 9, "incoming_qty": 0, "lack_qty": 0}})

    rows = {r["yusas_code"]: r for r in list_non_ably_snapshot(conn)}
    assert set(rows.keys()) == {"S24083"}
    conn.close()


@respx.mock
def test_fetch_non_ably_snapshot_parses_response():
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

    snapshot = asyncio.run(fetch_non_ably_snapshot(_setting()))

    assert snapshot == {
        "S24083": {"stock_qty": 0, "incoming_qty": 5, "lack_qty": 3},
        "S24067": {"stock_qty": 2, "incoming_qty": 1, "lack_qty": 0},
    }


def test_fetch_non_ably_snapshot_raises_session_expired_when_no_phpsessid_configured():
    with pytest.raises(EzAdminSessionExpired):
        asyncio.run(fetch_non_ably_snapshot(_setting(sessid=None)))


@respx.mock
def test_collect_non_ably_snapshot_fetches_and_upserts_returns_count():
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
    get_db, _keep_alive = _make_db_factory()
    init_non_ably_backorder_table(get_db)

    count = asyncio.run(collect_non_ably_snapshot(get_db, _setting()))

    assert count == 2
    conn = get_db()
    rows = list_non_ably_snapshot(conn)
    assert len(rows) == 2
    conn.close()


def test_list_non_ably_snapshot_returns_rows_ordered_by_yusas_code():
    get_db, _keep_alive = _make_db_factory()
    init_non_ably_backorder_table(get_db)
    conn = get_db()

    upsert_non_ably_snapshot(conn, {
        "S24067": {"stock_qty": 2, "incoming_qty": 1, "lack_qty": 0},
        "S24083": {"stock_qty": 0, "incoming_qty": 5, "lack_qty": 3},
    })

    rows = list_non_ably_snapshot(conn)
    assert [r["yusas_code"] for r in rows] == ["S24067", "S24083"]
    conn.close()
