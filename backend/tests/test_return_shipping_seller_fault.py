import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import httpx
import respx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.return_shipping_routes import build_return_shipping_router


def _make_client(*, settings=None, enqueue_sms=None, get_shared_db=None, set_setting=None):
    settings = settings or {}
    app = FastAPI()
    app.include_router(
        build_return_shipping_router(
            get_current_user=lambda: "tester",
            get_db=lambda: None,
            get_setting=lambda key: settings.get(key),
            enqueue_sms=enqueue_sms,
            get_shared_db=get_shared_db,
            set_setting=set_setting,
        )
    )
    return TestClient(app)


@respx.mock
def test_seller_fault_pending_returns_only_seller_fault_items():
    respx.post("https://api.a-bly.com/seller/login/").mock(
        return_value=httpx.Response(200, json={"token": "tok"})
    )
    respx.get("https://api.a-bly.com/seller/order_cancels/").mock(
        return_value=httpx.Response(
            200,
            json={
                "order_cancels": [
                    {
                        "buyer_tel": "010-1111-2222",
                        "receiver_name": "홍길동",
                        "order_items": [
                            {
                                "invoice": "111",
                                "sno": 1,
                                "goods_name": "상품A",
                                "cancel_reason": 32,
                                "cancel_images": ["http://img/1.jpg"],
                                "user_comment": "박음질이 뜯어져 있어요",
                            },
                            {"invoice": "222", "sno": 2, "goods_name": "상품B", "cancel_reason": 30},
                        ],
                    }
                ],
                "max_page_number": 1,
            },
        )
    )

    client = _make_client()
    res = client.get("/return-shipping/seller-fault-pending")

    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is True
    assert len(data["items"]) == 1
    item = data["items"][0]
    assert item["invoice"] == "111"
    assert item["sno"] == 1
    assert item["reason"] == "상품 하자/오배송"
    assert item["user_comment"] == "박음질이 뜯어져 있어요"
    assert item["images"] == ["http://img/1.jpg"]
    assert item["buyer_tel"] == "01011112222"
    assert item["buyer_name"] == "홍길동"


def test_new_return_pickup_single_needs_session_without_phpsessid():
    client = _make_client(settings={})
    res = client.post("/return-shipping/new-return-pickup-single", json={"invoice": "111", "sno": 1})
    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is False
    assert data["need_session"] is True


def test_new_return_pickup_single_requires_invoice():
    client = _make_client(settings={"ezadmin_phpsessid": "sess"})
    res = client.post("/return-shipping/new-return-pickup-single", json={"invoice": "", "sno": 1})
    assert res.status_code == 400


@respx.mock
def test_new_return_pickup_single_registers_and_sends_sms(monkeypatch):
    monkeypatch.setenv("ALIGO_SENDER", "0100000000")
    respx.post("https://api.a-bly.com/seller/login/").mock(
        return_value=httpx.Response(200, json={"token": "tok"})
    )
    respx.post("https://ga80.ezadmin.co.kr/popup35.htm").mock(
        return_value=httpx.Response(200, text="batch_cs_abc123")
    )
    respx.post("https://ga80.ezadmin.co.kr/function.htm").mock(
        return_value=httpx.Response(200, json={"error": 0})
    )
    respx.put("https://api.a-bly.com/seller/order_items/request_return/").mock(
        return_value=httpx.Response(200, json={})
    )

    sent = []

    def fake_enqueue_sms(payload, source):
        sent.append((payload, source))

    class FakeConn:
        def execute(self, *a, **k):
            return self

        def fetchone(self):
            return {"msg": "안녕 {이름}님, {상품명} 반품 접수", "title": "반품접수", "msg_type": "LMS"}

        def close(self):
            pass

    client = _make_client(
        settings={"ezadmin_phpsessid": "sess"},
        enqueue_sms=fake_enqueue_sms,
        get_shared_db=lambda: FakeConn(),
    )

    res = client.post(
        "/return-shipping/new-return-pickup-single",
        json={
            "invoice": "111",
            "sno": 1,
            "buyer_tel": "010-1111-2222",
            "buyer_name": "홍길동",
            "goods_name": "상품A",
        },
    )

    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is True
    assert data["invoice_count"] == 1
    assert data["sms_queued"] == 1
    assert len(sent) == 1
    assert sent[0][0]["receiver"] == "01011112222"
    assert "홍길동" in sent[0][0]["msg"]
    assert "상품A" in sent[0][0]["msg"]


@respx.mock
def test_new_return_pickup_single_propagates_ezadmin_session_expired():
    respx.post("https://api.a-bly.com/seller/login/").mock(
        return_value=httpx.Response(200, json={"token": "tok"})
    )
    respx.post("https://ga80.ezadmin.co.kr/popup35.htm").mock(
        return_value=httpx.Response(200, text="<html>로그인이 필요합니다</html>")
    )

    client = _make_client(settings={"ezadmin_phpsessid": "sess"})
    res = client.post("/return-shipping/new-return-pickup-single", json={"invoice": "111", "sno": 1})

    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is False
    assert data["need_session"] is True
