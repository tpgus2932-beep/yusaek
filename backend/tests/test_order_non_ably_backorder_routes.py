import sqlite3
import sys
import uuid
from pathlib import Path

import httpx
import respx
from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from api.order_non_ably_backorder_routes import build_non_ably_order_router
from services.order_non_ably_backorder import init_non_ably_backorder_table
from services.order_recommendation_store import ensure_row, init_order_recommendation_tables, today_kst

_IO30_URL = "https://ga80.ezadmin.co.kr/function.htm"


def _make_db_factory():
    uri = f"file:test_non_ably_order_routes_{uuid.uuid4().hex}?mode=memory&cache=shared"
    keep_alive = sqlite3.connect(uri, uri=True)
    keep_alive.row_factory = sqlite3.Row

    def factory():
        conn = sqlite3.connect(uri, uri=True)
        conn.row_factory = sqlite3.Row
        return conn

    return factory, keep_alive


def _make_client(settings=None):
    get_db, keep_alive = _make_db_factory()
    init_non_ably_backorder_table(get_db)
    init_order_recommendation_tables(get_db)

    app = FastAPI()
    app.include_router(
        build_non_ably_order_router(
            get_current_user=lambda: "tester",
            get_db=get_db,
            get_setting=lambda key: (settings or {}).get(key),
        )
    )
    return TestClient(app), get_db, keep_alive


def _cell(product_id, stock, not_yet_deliv, lack_qty):
    return {
        "product_id": product_id,
        "stock": f"<a class=atd href='#' onclick=javascript:run_stock(this)>{stock}</a>",
        "not_yet_deliv": f"<a class=atd href='#' onclick=javascript:run_not_yet_deliv(this)>{not_yet_deliv}</a>",
        "lack_qty": str(lack_qty),
    }


def test_snapshot_endpoint_returns_empty_list_initially():
    client, _get_db, _keep_alive = _make_client()
    res = client.get("/non-ably-order/snapshot")
    assert res.status_code == 200
    assert res.json() == {"ok": True, "items": []}


@respx.mock
def test_collect_endpoint_invokes_ezadmin_and_upserts_snapshot():
    respx.post(_IO30_URL).mock(
        return_value=httpx.Response(
            200,
            json={"rows": [{"id": 0, "cell": _cell("S24083", 0, 5, 3)}], "total": 1},
        )
    )
    client, _get_db, _keep_alive = _make_client(settings={"ezadmin_phpsessid": "sess"})

    res = client.post("/non-ably-order/collect")
    assert res.status_code == 200
    assert res.json() == {"ok": True, "updated_codes": 1}

    res2 = client.get("/non-ably-order/snapshot")
    items = res2.json()["items"]
    assert len(items) == 1
    assert items[0]["yusas_code"] == "S24083"
    assert items[0]["lack_qty"] == 3


@respx.mock
def test_collect_endpoint_removes_stale_codes_not_in_latest_snapshot():
    route = respx.post(_IO30_URL)
    route.side_effect = [
        httpx.Response(
            200,
            json={
                "rows": [
                    {"id": 0, "cell": _cell("S24083", 0, 5, 3)},
                    {"id": 1, "cell": _cell("S13634", 0, 1, 1)},
                ],
                "total": 1,
            },
        ),
        httpx.Response(
            200,
            json={"rows": [{"id": 0, "cell": _cell("S24083", 0, 5, 3)}], "total": 1},
        ),
    ]
    client, _get_db, _keep_alive = _make_client(settings={"ezadmin_phpsessid": "sess"})

    res1 = client.post("/non-ably-order/collect")
    assert res1.json() == {"ok": True, "updated_codes": 2}

    res2 = client.post("/non-ably-order/collect")
    assert res2.json() == {"ok": True, "updated_codes": 1}

    items = client.get("/non-ably-order/snapshot").json()["items"]
    assert {i["yusas_code"] for i in items} == {"S24083"}


def test_collect_endpoint_returns_need_session_when_ezadmin_session_expired():
    client, _get_db, _keep_alive = _make_client()  # no ezadmin_phpsessid configured

    res = client.post("/non-ably-order/collect")
    assert res.status_code == 200
    assert res.json() == {"ok": False, "need_session": True}


def test_final_order_uses_confirmed_qty_when_present():
    client, get_db, _keep_alive = _make_client()
    conn = get_db()
    date = today_kst()
    ensure_row(conn, date, "S24083")
    conn.execute(
        "UPDATE order_recommendation_daily SET recommended_qty = 8, confirmed_qty = 10 "
        "WHERE date = ? AND yusas_code = ?",
        (date, "S24083"),
    )
    conn.commit()
    from services.order_non_ably_backorder import upsert_non_ably_snapshot
    upsert_non_ably_snapshot(conn, {"S24083": {"stock_qty": 0, "incoming_qty": 0, "lack_qty": 3}})
    conn.close()

    res = client.get("/non-ably-order/final-order", params={"date": date})
    assert res.status_code == 200
    items = res.json()["items"]
    assert len(items) == 1
    assert items[0] == {
        "yusas_code": "S24083",
        "recommended_qty": 8,
        "confirmed_qty": 10,
        "ably_order_qty": 10,
        "non_ably_lack_qty": 3,
        "final_order_qty": 13,
    }


def test_final_order_uses_recommended_qty_when_confirmed_missing():
    client, get_db, _keep_alive = _make_client()
    conn = get_db()
    date = today_kst()
    ensure_row(conn, date, "S24083")
    conn.execute(
        "UPDATE order_recommendation_daily SET recommended_qty = 8 WHERE date = ? AND yusas_code = ?",
        (date, "S24083"),
    )
    conn.commit()
    from services.order_non_ably_backorder import upsert_non_ably_snapshot
    upsert_non_ably_snapshot(conn, {"S24083": {"stock_qty": 0, "incoming_qty": 0, "lack_qty": 3}})
    conn.close()

    res = client.get("/non-ably-order/final-order", params={"date": date})
    item = res.json()["items"][0]
    assert item["ably_order_qty"] == 8
    assert item["final_order_qty"] == 11


def test_final_order_includes_non_ably_only_product():
    client, get_db, _keep_alive = _make_client()
    conn = get_db()
    from services.order_non_ably_backorder import upsert_non_ably_snapshot
    upsert_non_ably_snapshot(conn, {"S99999": {"stock_qty": 0, "incoming_qty": 0, "lack_qty": 5}})
    conn.close()

    res = client.get("/non-ably-order/final-order", params={"date": today_kst()})
    items = res.json()["items"]
    assert len(items) == 1
    assert items[0] == {
        "yusas_code": "S99999",
        "recommended_qty": None,
        "confirmed_qty": None,
        "ably_order_qty": 0,
        "non_ably_lack_qty": 5,
        "final_order_qty": 5,
    }


def test_final_order_includes_ably_only_product():
    client, get_db, _keep_alive = _make_client()
    conn = get_db()
    date = today_kst()
    ensure_row(conn, date, "S24083")
    conn.execute(
        "UPDATE order_recommendation_daily SET recommended_qty = 8 WHERE date = ? AND yusas_code = ?",
        (date, "S24083"),
    )
    conn.commit()
    conn.close()

    res = client.get("/non-ably-order/final-order", params={"date": date})
    items = res.json()["items"]
    assert len(items) == 1
    assert items[0] == {
        "yusas_code": "S24083",
        "recommended_qty": 8,
        "confirmed_qty": None,
        "ably_order_qty": 8,
        "non_ably_lack_qty": 0,
        "final_order_qty": 8,
    }
