import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import api.returns_routes as returns_routes
from tests.test_returns_unmatched_lookup_cs import _make_client


class _OrderEzAdminClient:
    def __init__(self, get_setting):
        pass

    async def find_order_by_invoice(self, invoice_no, *, start_date, end_date):
        orders = {
            "111": {"pack": "p111", "phone": "010-1111-1111", "order_id": "1790064191087"},
            "333": {"pack": "p333", "phone": "010-2222-2222", "order_id": None},
            "444": {"pack": "p444", "phone": "010-3333-3333", "order_id": "999"},
        }
        return orders.get(invoice_no)


class _OrderAblyClient:
    calls = []

    async def search_order_items_by_order_sno(self, order_sno, *, start_date, end_date):
        type(self).calls.append((order_sno, start_date, end_date))
        if order_sno != "1790064191087":
            return []
        return [{
            "sno": 655890171, "order_sno": 1790064191087, "status": "반품 완료",
            "goods_name": "스커트", "option_info": "그레이/Free", "ea": 1, "price": 19570,
            "invoice": "411945112445", "delivery": {"name": "롯데택배"}, "buyer_name": "김정미",
        }]


def _setup(monkeypatch):
    client, state = _make_client(monkeypatch)
    monkeypatch.setattr(returns_routes, "EzAdminClient", _OrderEzAdminClient)
    monkeypatch.setattr(returns_routes, "AblyClient", _OrderAblyClient)
    _OrderAblyClient.calls = []
    state.queue_unmatched = [
        {"id": 1, "scan": "return-999", "match": "111"},
        {"id": 2, "scan": "x", "match": ""},
        {"id": 3, "scan": "y", "match": "222"},
        {"id": 4, "scan": "z", "match": "333"},
        {"id": 5, "scan": "w", "match": "444"},
    ]
    return client


def test_order_lookup_requires_ids(monkeypatch):
    client = _setup(monkeypatch)
    assert client.post("/returns/unmatched/order-lookup", json={"ids": []}).status_code == 400


def test_order_lookup_needs_ezadmin_session(monkeypatch):
    client, _ = _make_client(monkeypatch, phpsessid="")
    data = client.post("/returns/unmatched/order-lookup", json={"ids": [1]}).json()
    assert data == {"ok": False, "need_session": True}


def test_order_lookup_finds_order_via_original_invoice(monkeypatch):
    client = _setup(monkeypatch)
    data = client.post("/returns/unmatched/order-lookup", json={"ids": [1]}).json()

    assert data["ok"] is True
    result = data["results"][0]
    assert result["original_invoice"] == "111"
    assert result["order_no"] == "1790064191087"
    assert result["error"] == ""
    assert result["order_items"][0]["goods_name"] == "스커트"
    assert result["order_items"][0]["delivery_name"] == "롯데택배"
    assert _OrderAblyClient.calls[0][0] == "1790064191087"


def test_order_lookup_reports_each_failure(monkeypatch):
    client = _setup(monkeypatch)
    data = client.post("/returns/unmatched/order-lookup", json={"ids": [2, 3, 4, 5]}).json()

    errors = {r["id"]: r["error"] for r in data["results"]}
    assert "원송장번호 없음" in errors[2]
    assert errors[3] == "이지어드민 미조회"
    assert "주문번호 없음" in errors[4]
    assert errors[5] == "에이블리에서 주문을 찾지 못함"
