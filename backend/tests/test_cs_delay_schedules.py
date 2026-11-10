import sqlite3
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

import api.cs_routes as cs_routes
import services.order_recommendation_ezadmin_collectors as collectors
from sdk.ezadmin import EzAdminSessionExpired
from services.cs_store import init_cs_tables


def _d(offset: int) -> str:
    """오늘(KST)에서 offset일 뒤 날짜 YYYY-MM-DD."""
    return (datetime.now(timezone(timedelta(hours=9))) + timedelta(days=offset)).strftime("%Y-%m-%d")


def _client(monkeypatch, orders, shortage=None, session_expired=False):
    """orders: 에이블리 상품준비중 주문, shortage: {상품코드: (요청수량, 부족수량, 재고)} — 이지어드민 IO30 재고부족요청."""
    uri = f"file:test_cs_delay_{uuid.uuid4().hex}?mode=memory&cache=shared"
    keep = sqlite3.connect(uri, uri=True)

    def get_db():
        conn = sqlite3.connect(uri, uri=True)
        conn.row_factory = sqlite3.Row
        return conn

    init_cs_tables(get_db)

    async def fake_get(self, url, headers=None, params=None):
        if "total-count" in url:
            return httpx.Response(200, json={"total_count": len(orders)}, request=httpx.Request("GET", url))
        page = (params or {}).get("page", 1)
        return httpx.Response(200, json={"order_items": orders if page == 1 else []}, request=httpx.Request("GET", url))

    async def fake_post(self, url, **kwargs):
        return httpx.Response(200, json={"access_token": "t"}, request=httpx.Request("POST", url))

    async def fake_snapshot(get_setting, date):
        if session_expired:
            raise EzAdminSessionExpired()
        return {
            code: {"ezadmin_lack_qty": req, "ezadmin_real_lack_qty": lack, "stock_qty": stock, "incoming_qty": 0}
            for code, (req, lack, stock) in (shortage or {}).items()
        }

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)
    monkeypatch.setattr(collectors, "_fetch_ably_io30_snapshot", fake_snapshot)
    app = FastAPI()
    app.include_router(cs_routes.build_cs_router(
        get_current_user=lambda: {"username": "tester"}, get_db=get_db, get_setting=lambda key: None,
    ))
    return TestClient(app), keep


def _order(goods_sno, name, option, ordered_at, code, ea=1):
    return {
        "goods_sno": goods_sno, "goods_name": name, "option_info": option, "ordered_at": ordered_at,
        "ea": ea, "option_stock_sync_code": code, "delay_days": 2,
    }


def test_only_products_with_shortage_request_are_listed_oldest_first_and_limited_to_10(monkeypatch):
    orders = [_order(i, f"상품{i}", "블랙", f"2026-10-{i:02d} 10:00:00", f"S{i:05d}") for i in range(1, 16)]
    orders.append(_order(15, "상품15", "화이트", "2026-09-01 09:00:00", "S99915"))
    orders.append(_order(77, "재고충분 상품", "블랙", "2026-08-01 10:00:00", "S00777"))  # 재고부족요청에 없음 -> 제외
    shortage = {f"S{i:05d}": (3, 3, 0) for i in range(1, 16)}
    shortage["S99915"] = (5, 5, 0)
    client, _keep = _client(monkeypatch, orders, shortage)
    body = client.get("/cs/delay-schedules").json()
    assert body["ok"] is True
    assert len(body["items"]) == 10
    assert body["total_products"] == 15  # 77번 상품은 재고부족요청이 없어서 제외
    assert body["items"][0]["goods_sno"] == 15  # 가장 오래된 주문(9/1)이 있는 상품이 맨 앞
    assert body["items"][0]["order_count"] == 2
    assert {o["code"] for o in body["items"][0]["options"]} == {"S00015", "S99915"}
    assert [c["goods_sno"] for c in body["items"][1:]] == list(range(1, 10))
    first_option = [o for o in body["items"][0]["options"] if o["code"] == "S99915"][0]
    assert (first_option["request_qty"], first_option["lack_qty"], first_option["stock_qty"], first_option["orders"]) == (5, 5, 0, 1)


def test_search_finds_products_beyond_top_10(monkeypatch):
    orders = [_order(i, f"워싱 데님 {i}", "블랙", f"2026-10-{i:02d} 10:00:00", f"S{i:05d}") for i in range(1, 16)]
    orders.append(_order(99, "니트", "그레이", "2026-10-01 10:00:00", "S00099"))
    shortage = {f"S{i:05d}": (2, 2, 0) for i in [*range(1, 16), 99]}
    client, _keep = _client(monkeypatch, orders, shortage)
    body = client.get("/cs/delay-schedules", params={"q": "워싱 블랙"}).json()
    assert body["searched"] is True
    assert body["matched"] == 15
    assert len(body["items"]) == 15
    assert all(c["goods_sno"] != 99 for c in body["items"])


def test_ezadmin_session_expired_is_reported(monkeypatch):
    client, _keep = _client(monkeypatch, [], session_expired=True)
    assert client.get("/cs/delay-schedules").json() == {"ok": False, "need_session": True}


def test_schedule_is_saved_per_option_and_shown_on_that_option_only(monkeypatch):
    orders = [
        _order(1, "상품1", "블랙 S", "2026-10-01 10:00:00", "S00001"),
        _order(1, "상품1", "블랙 M", "2026-10-02 10:00:00", "S00002"),
    ]
    client, _keep = _client(monkeypatch, orders, {"S00001": (1, 1, 0), "S00002": (2, 2, 0)})
    res = client.put("/cs/delay-schedules", json={"code": "S00001", "expected_date": _d(5), "schedule": "11/12 발송"})
    assert res.status_code == 200
    options = {o["code"]: o for o in client.get("/cs/delay-schedules").json()["items"][0]["options"]}
    assert (options["S00001"]["expected_date"], options["S00001"]["schedule"], options["S00001"]["updated_by"]) == (_d(5), "11/12 발송", "tester")
    # 같은 상품의 다른 옵션은 영향을 받지 않는다
    assert (options["S00002"]["expected_date"], options["S00002"]["schedule"]) == ("", "")
    client.put("/cs/delay-schedules", json={"code": "S00001", "expected_date": "", "schedule": ""})
    options = {o["code"]: o for o in client.get("/cs/delay-schedules").json()["items"][0]["options"]}
    assert options["S00001"]["schedule"] == "" and options["S00001"]["expected_date"] == ""


def test_schedule_is_shared_with_cs_stock_inbound_schedule_both_ways(monkeypatch):
    """배송지연 일정은 CS 재고/상품별 탭의 입고 일정(/cs/inbound)과 같은 저장소를 쓴다."""
    import pandas as pd
    import api.wonbe_routes as wonbe_routes

    base_rows = [{"상품코드": "S00001", "상품명": "상품1", "색상": "블랙", "사이즈": "S", "거래처": "A", "거래처상품명": "A-1", "에이블리상품번호": "1", "옵션번호": ""}]
    monkeypatch.setattr(wonbe_routes, "load_wonbe_cost_base_df", lambda: pd.DataFrame(base_rows))
    client, _keep = _client(
        monkeypatch, [_order(1, "상품1", "블랙 S", "2026-10-01 10:00:00", "S00001")], {"S00001": (1, 1, 0)},
    )
    # CS 재고/상품별 탭에서 적은 입고 일정 -> 배송지연 목록과 달력에 보인다
    assert client.put("/cs/inbound", json={"code": "S00001", "expected_date": _d(1), "note": "재고탭에서 입력"}).status_code == 200
    opt = client.get("/cs/delay-schedules").json()["items"][0]["options"][0]
    assert (opt["expected_date"], opt["schedule"]) == (_d(1), "재고탭에서 입력")
    assert [i["code"] for i in client.get("/cs/delay-schedules/calendar", params={"month": _d(1)[:7]}).json()["items"]] == ["S00001"]
    # 배송지연 카드에서 고치면 입고 일정 쪽도 같은 값으로 바뀐다
    client.put("/cs/delay-schedules", json={"code": "S00001", "expected_date": _d(2), "schedule": "카드에서 수정"})
    rows = _keep.execute("SELECT expected_date, note FROM cs_inbound_schedules WHERE code = 'S00001'").fetchall()
    assert [tuple(r) for r in rows] == [(_d(2), "카드에서 수정")]


def test_calendar_lists_options_with_their_own_dates_and_cost_base_names(monkeypatch):
    import pandas as pd
    import api.wonbe_routes as wonbe_routes

    rows = [
        {"상품코드": "S00001", "상품명": "워싱 데님", "색상": "블랙", "사이즈": "S", "거래처": "동대문A", "거래처상품명": "DN-1", "에이블리상품번호": "1", "옵션번호": ""},
        {"상품코드": "S00002", "상품명": "워싱 데님", "색상": "블랙", "사이즈": "M", "거래처": "동대문A", "거래처상품명": "DN-1", "에이블리상품번호": "1", "옵션번호": ""},
    ]
    monkeypatch.setattr(wonbe_routes, "load_wonbe_cost_base_df", lambda: pd.DataFrame(rows))
    client, _keep = _client(monkeypatch, [], {})
    d1, d2, d3 = _d(2), _d(3), _d(40)
    client.put("/cs/delay-schedules", json={"code": "S00001", "expected_date": d1, "schedule": "오전 입고"})
    client.put("/cs/delay-schedules", json={"code": "S00002", "expected_date": d2})
    client.put("/cs/delay-schedules", json={"code": "S00003", "expected_date": d3})
    same_month = [d for d in (d1, d2) if d[:7] == d1[:7]]
    got = client.get("/cs/delay-schedules/calendar", params={"month": d1[:7]}).json()["items"]
    expected_rows = [
        ("S00001", d1, "워싱 데님", "블랙 S", "동대문A", "오전 입고"),
        ("S00002", d2, "워싱 데님", "블랙 M", "동대문A", ""),
    ][: len(same_month)]
    assert [(i["code"], i["expected_date"], i["goods_name"], i["option_label"], i["supplier"], i["schedule"]) for i in got][: len(expected_rows)] == expected_rows
    assert any(i["code"] == "S00003" for i in client.get("/cs/delay-schedules/calendar", params={"month": d3[:7]}).json()["items"])
    client.put("/cs/delay-schedules", json={"code": "S00001", "expected_date": "", "schedule": ""})
    assert all(i["code"] != "S00001" for i in client.get("/cs/delay-schedules/calendar", params={"month": d1[:7]}).json()["items"])


def test_invalid_expected_date_and_missing_code_are_rejected(monkeypatch):
    client, _keep = _client(monkeypatch, [], {})
    assert client.put("/cs/delay-schedules", json={"code": "S00001", "expected_date": "11/10"}).status_code == 400
    assert client.put("/cs/delay-schedules", json={"expected_date": _d(3)}).status_code == 400
    # 이미 지난 날짜는 입력할 수 없다
    assert client.put("/cs/delay-schedules", json={"code": "S00001", "expected_date": _d(-1)}).status_code == 400
    assert client.put("/cs/delay-schedules", json={"code": "S00001", "expected_date": _d(0)}).status_code == 200


def test_all_flag_returns_every_product_without_limit(monkeypatch):
    orders = [_order(i, f"상품{i}", "블랙", f"2026-10-{i:02d} 10:00:00", f"S{i:05d}") for i in range(1, 16)]
    shortage = {f"S{i:05d}": (1, 1, 0) for i in range(1, 16)}
    client, _keep = _client(monkeypatch, orders, shortage)
    assert len(client.get("/cs/delay-schedules").json()["items"]) == 10
    assert len(client.get("/cs/delay-schedules", params={"all": "true"}).json()["items"]) == 15


def test_supplier_name_is_returned_and_searching_it_lists_every_matching_product(monkeypatch):
    import pandas as pd
    import api.wonbe_routes as wonbe_routes

    rows = []
    for i in range(1, 13):  # 12개 상품은 '동대문A' 거래처
        rows.append({"상품코드": f"S{i:05d}", "상품명": f"상품{i}", "색상": "블랙", "사이즈": "S", "거래처": "동대문A",
                     "거래처상품명": f"A-{i}", "에이블리상품번호": str(i), "옵션번호": ""})
    rows.append({"상품코드": "S00099", "상품명": "상품99", "색상": "블랙", "사이즈": "S", "거래처": "남대문B",
                 "거래처상품명": "B-99", "에이블리상품번호": "99", "옵션번호": ""})
    monkeypatch.setattr(wonbe_routes, "load_wonbe_cost_base_df", lambda: pd.DataFrame(rows))
    orders = [_order(i, f"상품{i}", "블랙 S", f"2026-10-{i:02d} 10:00:00", f"S{i:05d}") for i in [*range(1, 13), 99]]
    shortage = {f"S{i:05d}": (1, 1, 0) for i in [*range(1, 13), 99]}
    client, _keep = _client(monkeypatch, orders, shortage)
    items = client.get("/cs/delay-schedules", params={"all": "true"}).json()["items"]
    assert {i["goods_sno"]: i["supplier"] for i in items}[1] == "동대문A"
    found = client.get("/cs/delay-schedules", params={"q": "동대문A"}).json()
    assert found["matched"] == 12  # 거래처로 검색하면 그 거래처의 매칭 상품이 전부 나온다
    assert all(i["supplier"] == "동대문A" for i in found["items"])


def _insert_inbound(keep, code, expected, note=""):
    keep.execute(
        "INSERT INTO cs_inbound_schedules (code, expected_date, note, updated_by, updated_at) VALUES (?, ?, ?, 'x', 'x')",
        (code, expected, note),
    )
    keep.commit()


def test_past_schedules_are_deleted_automatically_but_today_future_and_dateless_stay(monkeypatch):
    client, keep = _client(monkeypatch, [], {})
    _insert_inbound(keep, "S00001", _d(-1), "어제 입고 예정")
    _insert_inbound(keep, "S00002", _d(0), "오늘 입고 예정")
    _insert_inbound(keep, "S00003", _d(3), "미래 입고 예정")
    _insert_inbound(keep, "S00004", "", "날짜 없는 메모")
    client.get("/cs/delay-schedules/calendar", params={"month": _d(0)[:7]})  # 조회하면 정리된다
    left = {r[0] for r in keep.execute("SELECT code FROM cs_inbound_schedules").fetchall()}
    assert left == {"S00002", "S00003", "S00004"}


def test_delete_by_date_removes_only_that_dates_schedules(monkeypatch):
    client, keep = _client(monkeypatch, [], {})
    target, other = _d(4), _d(5)
    _insert_inbound(keep, "S00001", target)
    _insert_inbound(keep, "S00002", target, "메모")
    _insert_inbound(keep, "S00003", other)
    res = client.delete("/cs/delay-schedules/by-date", params={"date": target})
    assert res.json() == {"ok": True, "date": target, "deleted": 2}
    assert {r[0] for r in keep.execute("SELECT code FROM cs_inbound_schedules").fetchall()} == {"S00003"}
    assert client.delete("/cs/delay-schedules/by-date", params={"date": "11/10"}).status_code == 400
