import asyncio
import sqlite3
import sys
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.barcode_routes import build_barcode_router
from services import ezadmin_orders as ezo


def _client():
    uri = f"file:test_ship_cancel_{uuid.uuid4().hex}?mode=memory&cache=shared"
    keep = sqlite3.connect(uri, uri=True)
    keep.row_factory = sqlite3.Row
    keep.execute(
        "CREATE TABLE post_shipment_cancel (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT, seq TEXT, "
        "invoice_no TEXT, shop TEXT, manager TEXT, ship_time TEXT, cancel_time TEXT, product_name TEXT, "
        "carrier TEXT, fetched_at TEXT, manual INTEGER DEFAULT 0)"
    )
    keep.execute(
        "CREATE TABLE post_shipment_cancel_hold (hold_key TEXT PRIMARY KEY, date TEXT NOT NULL, held_by TEXT, held_at TEXT NOT NULL)"
    )
    # 같은 송장에 seq 두 개(합포장) + seq 없는 수동 건
    for seq in ("718115", "718029"):
        keep.execute("INSERT INTO post_shipment_cancel (date, seq, invoice_no, fetched_at) VALUES ('2026-11-05', ?, 'INV1', 'x')", (seq,))
    keep.execute("INSERT INTO post_shipment_cancel (date, seq, invoice_no, fetched_at, manual) VALUES ('2026-11-05', NULL, 'INV2', 'x', 1)")
    keep.commit()

    def factory():
        conn = sqlite3.connect(uri, uri=True)
        conn.row_factory = sqlite3.Row
        return conn

    mk = MagicMock()
    app = FastAPI()
    app.include_router(build_barcode_router(
        get_current_user=lambda: "tester", get_barcode_state=mk, to_int=mk, process_and_load_any=mk,
        load_excel_any=mk, normalize_code=mk, process_easyadmin_product_upload=mk, content_disposition=mk,
        get_shared_incoming_counts=mk, set_shared_incoming_counts=mk, get_shared_defect_counts=mk,
        set_shared_defect_counts=mk, get_shared_defect_summon_counts=mk, set_shared_defect_summon_counts=mk,
        get_shared_kimsungil_counts=mk, set_shared_kimsungil_counts=mk, set_shared_barcode_data=mk,
        get_setting=lambda key: "SESS", set_setting=mk, get_user_display=mk, get_shared_db=factory, get_db=factory,
    ))
    return TestClient(app), keep


def _pack(order_id):
    return [{"cell": {"list_order_id": order_id, "order_cs": "0"}, "row": {"order_id": order_id, "prd_seq": "9", "trans_corp_id": "30079"}}]


def test_lookup_states_and_hold_persistence():
    client, keep = _client()
    ids = [r["id"] for r in keep.execute("SELECT id FROM post_shipment_cancel ORDER BY id")]
    orders = {"718115": "O-CANCEL", "718029": "O-SHIP"}

    async def fake_pack_rows(sess, seq):
        return _pack(orders[seq])

    async def fake_cancels(self, oid, **kw):
        return [{"sno": 5, "order_items": [{"order_sno": oid}]}] if oid == "O-CANCEL" else []

    async def fake_ship(self, oid):
        return [{"order_sno": oid}] if oid == "O-SHIP" else []

    with patch.object(ezo, "pack_rows", fake_pack_rows), \
         patch("api.barcode_routes.AblyClient.login", AsyncMock(return_value="t")), \
         patch("api.barcode_routes.AblyClient.search_refund_requests_by_order_sno", AsyncMock(return_value=[])), \
         patch("api.barcode_routes.AblyClient.search_cancels_by_order_sno", fake_cancels), \
         patch("api.barcode_routes.AblyClient.search_shipping_items_by_order_sno", fake_ship):
        res = client.post("/barcode/post-shipment-cancel/ably-lookup", json={"ids": ids}).json()
    by_id = {r["id"]: r for r in res["results"]}
    assert by_id[ids[0]]["in_cancel"] and not by_id[ids[0]]["in_shipping"]
    assert by_id[ids[1]]["in_shipping"] and not by_id[ids[1]]["in_cancel"]
    assert by_id[ids[2]]["ok"] is False  # 수동 건: seq 없음

    assert client.post("/barcode/post-shipment-cancel/hold", json={"id": ids[1]}).json()["ok"]
    items = client.get("/barcode/post-shipment-cancel/list").json()["items"]
    held = {i["id"]: i["held"] for i in items}
    # 같은 송장이라도 seq가 다르면 보류가 번지지 않는다
    assert held == {ids[0]: 0, ids[1]: 1, ids[2]: 0}


def test_ship_cancel_refuses_when_not_in_cancel_list_and_runs_steps_when_it_is():
    client, keep = _client()
    rid = keep.execute("SELECT id FROM post_shipment_cancel WHERE seq='718115'").fetchone()["id"]
    run = AsyncMock(return_value=["배송취소", "송장삭제", "전체취소"])

    async def fake_pack_rows(sess, seq):
        return _pack("O1")

    async def ship_only(self, oid, **kw):
        return []

    async def in_cancel(self, oid, **kw):
        return [{"sno": 1, "order_items": [{"order_sno": oid}]}]

    async def no_ship(self, oid):
        return []

    with patch.object(ezo, "pack_rows", fake_pack_rows), patch.object(ezo, "cancel_shipped_pack", run), \
         patch("api.barcode_routes.AblyClient.login", AsyncMock(return_value="t")), \
         patch("api.barcode_routes.AblyClient.search_refund_requests_by_order_sno", AsyncMock(return_value=[])), \
         patch("api.barcode_routes.AblyClient.search_shipping_items_by_order_sno", no_ship):
        with patch("api.barcode_routes.AblyClient.search_cancels_by_order_sno", ship_only):
            r = client.post("/barcode/post-shipment-cancel/ship-cancel", json={"id": rid})
            assert r.status_code == 409
            run.assert_not_awaited()
        with patch("api.barcode_routes.AblyClient.search_cancels_by_order_sno", in_cancel):
            r = client.post("/barcode/post-shipment-cancel/ship-cancel", json={"id": rid}).json()
    assert r["ok"] and r["steps"] == ["배송취소", "송장삭제", "전체취소"]
    run.assert_awaited_once_with("SESS", "718115")


def test_cancel_shipped_pack_order_and_error_reports_progress():
    asyncio.run(_cancel_shipped_pack_scenario())


async def _cancel_shipped_pack_scenario():
    calls = []

    def rec(name, result=None):
        async def f(*a, **k):
            calls.append(name)
            return result if result is not None else {"error": 0}
        return f

    with patch.object(ezo, "pack_rows", AsyncMock(return_value=_pack("O1"))), \
         patch.object(ezo, "cancel_trans", rec("cancel_trans")), \
         patch.object(ezo, "delete_trans_no", rec("delete_trans_no")), \
         patch.object(ezo, "find_multilocation", rec("find", {"location": "Def", "expire_date": "2026-11-05"})), \
         patch.object(ezo, "cancel_pack", rec("cancel_pack")):
        done = await ezo.cancel_shipped_pack("S", "1")
    assert calls == ["cancel_trans", "delete_trans_no", "find", "cancel_pack"]
    assert done == ["배송취소", "송장삭제", "전체취소"]

    with patch.object(ezo, "pack_rows", AsyncMock(return_value=_pack("O1"))), \
         patch.object(ezo, "cancel_trans", rec("cancel_trans")), \
         patch.object(ezo, "delete_trans_no", rec("delete_trans_no", {"error": 1})):
        with pytest.raises(RuntimeError, match="완료된 단계: 배송취소"):
            await ezo.cancel_shipped_pack("S", "1")


def test_refund_request_fallback_enables_cancel_when_first_pass_misses():
    client, keep = _client()
    rid = keep.execute("SELECT id FROM post_shipment_cancel WHERE seq='718115'").fetchone()["id"]

    async def fake_pack_rows(sess, seq):
        return _pack("O1")

    refund = AsyncMock(return_value=[{"sno": 9, "order_items": [{"order_sno": "O1"}]}])
    with patch.object(ezo, "pack_rows", fake_pack_rows), \
         patch("api.barcode_routes.AblyClient.login", AsyncMock(return_value="t")), \
         patch("api.barcode_routes.AblyClient.search_cancels_by_order_sno", AsyncMock(return_value=[])), \
         patch("api.barcode_routes.AblyClient.search_shipping_items_by_order_sno", AsyncMock(return_value=[])), \
         patch("api.barcode_routes.AblyClient.search_refund_requests_by_order_sno", refund):
        r = client.post("/barcode/post-shipment-cancel/ably-lookup", json={"ids": [rid]}).json()["results"][0]
    assert r["in_cancel"] and r["in_refund"] and not r["in_shipping"]
    refund.assert_awaited_once()
