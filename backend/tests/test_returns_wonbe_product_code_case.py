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

    async def receive_stock(self, product_id, qty, *, memo=""):
        type(self).receive_stock_calls.append({"product_id": product_id, "qty": qty, "memo": memo})
        return {"error": 0}


def _make_client(monkeypatch, *, phpsessid="sess"):
    state = ReturnState(cost_base_path=Path("nonexistent.xlsx"))
    settings = {"ezadmin_phpsessid": phpsessid}

    def _get_return_state(user):
        return state

    _FakeEzAdminClient.receive_stock_calls = []
    monkeypatch.setattr(returns_routes, "EzAdminClient", _FakeEzAdminClient)
    # 원가베이스유(wonbe)에는 'S00002'로 대문자 등록돼 있는데, 에이블리
    # option_stock_sync_code는 소문자('s00002')로 내려오는 실제 사례를 재현.
    monkeypatch.setattr(returns_routes, "load_wonbe_product_codes", lambda: {"S00002": "S00002"})
    monkeypatch.setattr(returns_routes, "load_wonbe_option_sno_map", lambda: {})

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


def test_resolve_product_codes_is_case_insensitive(monkeypatch):
    client, _state = _make_client(monkeypatch)

    res = client.post(
        "/returns/resolve-product-codes",
        json={"items": [{"id": 1, "option_code": "s00002"}]},
    )

    assert res.status_code == 200
    result = res.json()["results"][0]
    assert result["error"] is None
    # 실제 EZAdmin에 넘길 값은 원가베이스유에 등록된 원본 표기(대문자)여야 한다.
    assert result["product_id"] == "S00002"


def test_resolve_product_codes_falls_back_to_option_sno(monkeypatch):
    client, _state = _make_client(monkeypatch)
    monkeypatch.setattr(returns_routes, "load_wonbe_option_sno_map", lambda: {"542200734": "S27714"})

    res = client.post(
        "/returns/resolve-product-codes",
        json={"items": [{"id": 1, "option_code": "542200734"}]},
    )

    assert res.status_code == 200
    result = res.json()["results"][0]
    assert result["error"] is None
    assert result["product_id"] == "S27714"


def test_ezadmin_receive_stock_is_case_insensitive(monkeypatch):
    client, state = _make_client(monkeypatch)
    item = {"id": 1, "scan": "return-1", "option_code": "s00002", "qty": "1", "order_no": "1001"}
    state.queue_customer = [item]
    state.all_items = [item]

    res = client.post(
        "/returns/ezadmin-receive-stock",
        json={"items": [{"id": 1, "option_code": "s00002", "qty": "1", "order_no": "1001"}]},
    )

    assert res.status_code == 200
    data = res.json()
    assert data["results"][0]["ok"] is True
    assert data["results"][0]["product_id"] == "S00002"
    assert _FakeEzAdminClient.receive_stock_calls == [
        {"product_id": "S00002", "qty": 1, "memo": "반품입고 1001"}
    ]


def test_ezadmin_receive_stock_falls_back_to_option_sno(monkeypatch):
    # 에이블리에서 해당 옵션의 재고동기화코드가 아직 상품코드로 설정 안 돼
    # 옵션번호(542200734)가 그대로 내려오는 실제 사례를 재현.
    client, state = _make_client(monkeypatch)
    monkeypatch.setattr(returns_routes, "load_wonbe_option_sno_map", lambda: {"542200734": "S27714"})
    item = {"id": 3, "scan": "return-3", "option_code": "542200734", "qty": "1", "order_no": "1003"}
    state.queue_customer = [item]
    state.all_items = [item]

    res = client.post(
        "/returns/ezadmin-receive-stock",
        json={"items": [{"id": 3, "option_code": "542200734", "qty": "1", "order_no": "1003"}]},
    )

    assert res.status_code == 200
    result = res.json()["results"][0]
    assert result["ok"] is True
    assert result["product_id"] == "S27714"
    assert _FakeEzAdminClient.receive_stock_calls == [
        {"product_id": "S27714", "qty": 1, "memo": "반품입고 1003"}
    ]


def test_ezadmin_receive_stock_unknown_code_still_errors(monkeypatch):
    client, state = _make_client(monkeypatch)
    item = {"id": 2, "scan": "return-2", "option_code": "zzz999", "qty": "1", "order_no": "1002"}
    state.queue_customer = [item]
    state.all_items = [item]

    res = client.post(
        "/returns/ezadmin-receive-stock",
        json={"items": [{"id": 2, "option_code": "zzz999", "qty": "1", "order_no": "1002"}]},
    )

    assert res.status_code == 200
    result = res.json()["results"][0]
    assert result["ok"] is False
    assert "원가베이스유에서 찾을 수 없음" in result["error"]
