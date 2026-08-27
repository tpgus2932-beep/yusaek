import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import FastAPI
from fastapi.testclient import TestClient

import api.returns_routes as returns_routes
from services.returns_utils import (
    ReturnState,
    _clean_invoice,
    _clean_product_name,
    _clean_qty,
    _load_return_state_from_payload,
    _lowercase_size_words,
    _normalize_key,
    _normalize_spaces,
    _option_slash_to_space,
    _read_return_excel,
    _reason_type,
    _return_queue_payload,
    _return_rows,
    _return_state_to_payload,
    _return_status,
)


class _FakeEzAdminClient:
    receive_stock_calls = []

    def __init__(self, get_setting):
        pass

    async def find_order_by_invoice(self, invoice_no, *, start_date, end_date):
        orders = {
            "111": {"pack": "p111", "phone": "010-1111-1111"},
            "222": None,
            "333": {"pack": "p333", "phone": "010-2222-2222"},
            "444": {"pack": "p444", "phone": "010-3333-3333"},
        }
        return orders.get(invoice_no)

    async def packlist_items(self, pack):
        packs = {
            "p111": [{"product_id": "S1", "qty": "1"}, {"product_id": "S1", "qty": "1"}, {"product_id": "S2", "qty": "2"}],
            "p333": [{"product_id": "S3", "qty": "1"}],
            "p444": [{"product_id": "S4", "qty": "1"}],
        }
        return packs.get(pack, [])

    async def receive_stock(self, product_id, qty, *, memo=""):
        type(self).receive_stock_calls.append({"product_id": product_id, "qty": qty, "memo": memo})
        return {"error": 0}


class _FakeAblyClient:
    async def count_contact_rooms_by_mobile(self, mobile, *, start_date, end_date):
        return 1 if mobile == "010-1111-1111" else 0

    async def list_contact_rooms_by_mobile(self, mobile, *, start_date, end_date):
        if mobile != "010-1111-1111":
            return []
        return [{"sno": 555, "get_status_display": "완료", "market": {"name": "유색"}}]

    async def get_contact_room_messages(self, sno):
        assert sno == 555
        return {"status_display": "완료", "market_name": "유색", "messages": [{"sender": "구매자", "content": "환불 요청", "created_at": "2026-07-20"}]}


class _FakeZigzagClient:
    closed = False

    def __init__(self, *args, **kwargs):
        pass

    async def find_return_claim_by_phone(self, phone, **kwargs):
        if phone == "010-2222-2222":
            return {
                "order_item_request_number": "zz-1",
                "shipping_fee_additional_charge_method": {"initial": "DEDUCT_FROM_REFUND_PAYMENT", "return": "DEDUCT_FROM_REFUND_PAYMENT"},
            }
        return None

    async def close(self):
        type(self).closed = True


def _make_client(monkeypatch, *, phpsessid="sess"):
    state = ReturnState(cost_base_path=Path("nonexistent.xlsx"))
    settings = {"ezadmin_phpsessid": phpsessid}

    def _get_return_state(user):
        return state

    _FakeEzAdminClient.receive_stock_calls = []
    _FakeZigzagClient.closed = False
    monkeypatch.setattr(returns_routes, "EzAdminClient", _FakeEzAdminClient)
    monkeypatch.setattr(returns_routes, "AblyClient", _FakeAblyClient)
    monkeypatch.setattr(returns_routes, "ZigzagClient", _FakeZigzagClient)

    app = FastAPI()
    app.include_router(
        returns_routes.build_returns_router(
            get_current_user=lambda: "tester",
            require_admin=lambda: "tester",
            get_return_state=_get_return_state,
            get_db=lambda: None,
            get_setting=lambda key: settings.get(key),
            return_status=_return_status,
            return_queue_payload=_return_queue_payload,
            return_rows=_return_rows,
            return_state_to_payload=_return_state_to_payload,
            load_return_state_from_payload=_load_return_state_from_payload,
            load_return_cost_base=lambda *a, **k: None,
            load_cost_base_df=lambda *a, **k: None,
            save_cost_base_df=lambda *a, **k: None,
            read_return_excel=_read_return_excel,
            clean_invoice=_clean_invoice,
            clean_product_name=_clean_product_name,
            lowercase_size_words=_lowercase_size_words,
            option_slash_to_space=_option_slash_to_space,
            clean_qty=_clean_qty,
            normalize_spaces=_normalize_spaces,
            reason_type=_reason_type,
            normalize_key=_normalize_key,
            content_disposition=lambda filename: f'attachment; filename="{filename}"',
            return_allowed_exts={".xlsx", ".xls"},
        )
    )
    return TestClient(app), state


def test_lookup_cs_requires_ids(monkeypatch):
    client, _ = _make_client(monkeypatch)
    res = client.post("/returns/unmatched/lookup-cs", json={"ids": []})
    assert res.status_code == 400


def test_lookup_cs_needs_ezadmin_session(monkeypatch):
    client, _ = _make_client(monkeypatch, phpsessid="")
    res = client.post("/returns/unmatched/lookup-cs", json={"ids": [1]})
    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is False
    assert data["need_session"] is True


def test_lookup_cs_finds_phone_and_ably_hit(monkeypatch):
    client, state = _make_client(monkeypatch)
    # scan(반품송장)은 이지어드민에 없는 값이라 일부러 다르게 두고,
    # 검색에는 match(원송장 e_val)가 쓰여야 한다.
    item_a = {"id": 1, "scan": "return-999", "match": "111", "item_text": "found"}
    state.queue_unmatched = [item_a]
    state.all_items = [item_a]

    res = client.post("/returns/unmatched/lookup-cs", json={"ids": [1]})

    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is True
    assert data["checked"] == 1
    updated = data["queues"]["unmatched"][0]
    assert updated["cs_phone"] == "010-1111-1111"
    assert updated["cs_ably_exists"] is True
    products_by_id = {p["product_id"]: p for p in updated["cs_products"]}
    assert set(products_by_id) == {"S1", "S2"}
    assert products_by_id["S1"]["qty"] == 2.0
    assert products_by_id["S2"]["qty"] == 2.0


def test_lookup_cs_falls_back_to_zigzag_when_ably_misses(monkeypatch):
    client, state = _make_client(monkeypatch)
    item_a = {"id": 4, "scan": "return-333", "match": "333", "item_text": "zigzag hit"}
    state.queue_unmatched = [item_a]
    state.all_items = [item_a]

    res = client.post("/returns/unmatched/lookup-cs", json={"ids": [4]})

    assert res.status_code == 200
    updated = res.json()["queues"]["unmatched"][0]
    assert updated["cs_phone"] == "010-2222-2222"
    assert updated["cs_ably_exists"] is False
    assert updated["cs_zigzag_exists"] is True
    assert updated["cs_zigzag_type"] == "고객"
    assert _FakeZigzagClient.closed is True


def test_lookup_cs_zigzag_also_misses(monkeypatch):
    client, state = _make_client(monkeypatch)
    item_a = {"id": 5, "scan": "return-444", "match": "444", "item_text": "neither"}
    state.queue_unmatched = [item_a]
    state.all_items = [item_a]

    res = client.post("/returns/unmatched/lookup-cs", json={"ids": [5]})

    assert res.status_code == 200
    updated = res.json()["queues"]["unmatched"][0]
    assert updated["cs_ably_exists"] is False
    assert updated["cs_zigzag_exists"] is False


def test_lookup_cs_phone_not_found_in_ezadmin(monkeypatch):
    client, state = _make_client(monkeypatch)
    item_a = {"id": 2, "scan": "return-888", "match": "222", "item_text": "not found"}
    state.queue_unmatched = [item_a]
    state.all_items = [item_a]

    res = client.post("/returns/unmatched/lookup-cs", json={"ids": [2]})

    assert res.status_code == 200
    updated = res.json()["queues"]["unmatched"][0]
    assert updated["cs_phone"] == ""
    assert updated["cs_ably_exists"] is None
    assert updated["cs_error"] == "이지어드민 미조회"
    assert updated["cs_products"] == []
    assert updated["cs_product_error"] == "이지어드민 미조회"


def test_lookup_cs_missing_original_invoice(monkeypatch):
    client, state = _make_client(monkeypatch)
    item_a = {"id": 3, "scan": "return-777", "match": "", "item_text": "no mapping"}
    state.queue_unmatched = [item_a]
    state.all_items = [item_a]

    res = client.post("/returns/unmatched/lookup-cs", json={"ids": [3]})

    assert res.status_code == 200
    updated = res.json()["queues"]["unmatched"][0]
    assert updated["cs_error"] == "원송장번호 없음 (반품송장 매핑 실패)"
    assert updated["cs_products"] == []
    assert updated["cs_product_error"] == "원송장번호 없음"


def test_receive_stock_requires_prior_lookup(monkeypatch):
    client, state = _make_client(monkeypatch)
    item_a = {"id": 1, "scan": "return-999", "match": "111", "item_text": "found"}
    state.queue_unmatched = [item_a]
    state.all_items = [item_a]

    res = client.post("/returns/unmatched/receive-stock", json={"ids": [1]})

    assert res.status_code == 200
    data = res.json()
    assert data["results"][0]["ok"] is False
    assert data["results"][0]["error"] == "상품코드 없음 (먼저 CS 조회를 실행하세요)"
    assert _FakeEzAdminClient.receive_stock_calls == []


def test_receive_stock_uses_cached_products_and_original_invoice_memo(monkeypatch):
    client, state = _make_client(monkeypatch)
    item_a = {
        "id": 1, "scan": "return-999", "match": "111", "item_text": "found",
        "cs_products": [{"product_id": "S1", "qty": 2}, {"product_id": "S2", "qty": 1}],
    }
    state.queue_unmatched = [item_a]
    state.all_items = [item_a]

    res = client.post("/returns/unmatched/receive-stock", json={"ids": [1]})

    assert res.status_code == 200
    data = res.json()
    assert data["results"][0]["ok"] is True
    calls = _FakeEzAdminClient.receive_stock_calls
    assert len(calls) == 2
    assert all(c["memo"] == "반품입고 111" for c in calls)
    assert {c["product_id"] for c in calls} == {"S1", "S2"}
    updated = data["queues"]["unmatched"][0]
    assert updated["ezadmin_stockin_done"] is True


def test_receive_stock_missing_original_invoice(monkeypatch):
    client, state = _make_client(monkeypatch)
    item_a = {"id": 2, "scan": "return-888", "match": "", "cs_products": [{"product_id": "S1", "qty": 1}]}
    state.queue_unmatched = [item_a]
    state.all_items = [item_a]

    res = client.post("/returns/unmatched/receive-stock", json={"ids": [2]})

    assert res.status_code == 200
    assert res.json()["results"][0]["error"] == "원송장번호 없음"


def test_cs_detail_requires_phone(monkeypatch):
    client, _ = _make_client(monkeypatch)
    res = client.post("/returns/unmatched/cs-detail", json={"phone": ""})
    assert res.status_code == 400


def test_cs_detail_returns_room_messages(monkeypatch):
    client, _ = _make_client(monkeypatch)
    res = client.post("/returns/unmatched/cs-detail", json={"phone": "010-1111-1111"})
    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is True
    assert len(data["rooms"]) == 1
    room = data["rooms"][0]
    assert room["status_display"] == "완료"
    assert room["market_name"] == "유색"
    assert room["messages"][0]["content"] == "환불 요청"


def test_cs_detail_no_rooms_found(monkeypatch):
    client, _ = _make_client(monkeypatch)
    res = client.post("/returns/unmatched/cs-detail", json={"phone": "010-0000-0000"})
    assert res.status_code == 200
    assert res.json()["rooms"] == []
