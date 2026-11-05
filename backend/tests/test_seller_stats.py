import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import httpx
import respx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.seller_stats_routes import build_seller_stats_router
from services.seller_return_store import (
    compute_stats,
    exchange_row,
    is_seller_exchange,
    is_seller_return_item,
    record_safely,
    return_row,
    upsert_rows,
)


def _conn():
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    return c


def _item(sno, fee=0, reason=32, status=44, **kw):
    base = {
        "sno": sno, "order_sno": 1792946128911, "ea": 1, "invoice": "412117766023",
        "goods_name": "워싱 데님 팬츠", "option_info": "그레이/S", "goods_custom_code": "케이디지 FJ7351 14000",
        "processing_sub_status": status, "cancel_received_at": "2026-10-30T20:06:51.632772",
        "confirm_requested_at": "2026-10-31T10:00:00", "cancel_completed_at": "2026-11-01T09:00:00",
        "refund_amount": 23968, "return_delivery_fee": fee, "cancel_reason": reason,
        "user_comment": "메모",
    }
    base.update(kw)
    return base


def test_seller_classification_matches_sidebar():
    assert is_seller_return_item(_item(1, fee=0))
    assert is_seller_return_item(_item(1, fee=None))
    assert not is_seller_return_item(_item(1, fee=-3000))
    assert is_seller_exchange({"reason_code": 2})
    assert is_seller_exchange({"reason_code": 3})
    assert not is_seller_exchange({"reason_code": 1})


def test_return_row_fields():
    row = return_row(_item(5, reason=34), cancel_sno=99, source="sync")
    assert row["key"] == "return:5"
    assert row["order_sno"] == "1792946128911"
    assert row["vendor"] == "케이디지"
    assert row["reason_text"] == "기타(34)"
    assert row["ref_date"] == "2026-11-01"
    assert row["cancel_sno"] == "99"


def test_upsert_updates_status_and_keeps_dates():
    conn = _conn()
    pending = return_row(_item(7, status=41, confirm_requested_at=None, cancel_completed_at=None), 1, "auto-return")
    upsert_rows(conn, [pending])
    assert conn.execute("SELECT status, ref_date FROM seller_returns").fetchone()["ref_date"] == "2026-10-30"

    done = return_row(_item(7, status=44), 1, "sync")
    upsert_rows(conn, [done])
    rows = conn.execute("SELECT status, ref_date, completed_at FROM seller_returns").fetchall()
    assert len(rows) == 1
    assert rows[0]["status"] == 44
    assert rows[0]["ref_date"] == "2026-11-01"

    # 날짜가 비어 있는 스냅샷으로 다시 들어와도 기존 날짜를 지우지 않는다.
    upsert_rows(conn, [return_row(_item(7, status=44, cancel_completed_at=None), 1, "auto-return")])
    assert conn.execute("SELECT completed_at FROM seller_returns").fetchone()["completed_at"] != ""


def test_compute_stats_aggregates():
    conn = _conn()
    ex = exchange_row(
        {"exchange_sno": 10, "reason_code": 2, "detail_reason": "하자", "status": 2,
         "requested_at": "2026-11-02 10:00:00",
         "exchange_items": [{"order_item_sno": 1, "order_item": {"goods_name": "상품Z", "goods_custom_code": "다른 A1 1000"}}]},
        "auto-exchange",
    )
    upsert_rows(conn, [
        return_row(_item(1, reason=32), 1, "sync"),
        return_row(_item(2, reason=1), 1, "sync"),
        return_row(_item(3, reason=32, goods_name="다른 상품"), 1, "sync"),
        ex,
    ])
    s = compute_stats(conn, "2026-10-01", "2026-11-30")
    assert s["total"] == 4
    assert s["return_count"] == 3 and s["exchange_count"] == 1
    assert s["refund_amount"] == 23968 * 3
    assert s["by_vendor"][0]["name"] == "케이디지" and s["by_vendor"][0]["count"] == 3
    # 기간 안의 모든 날짜가 빠짐없이 나온다(데이터 없는 날은 0).
    assert len(s["daily"]) == 61
    by_date = {d["date"]: d for d in s["daily"]}
    assert by_date["2026-11-01"]["return"] == 3 and by_date["2026-11-02"]["exchange"] == 1
    assert by_date["2026-10-15"]["return"] == 0
    # 판매 데이터가 없으면 반품률은 계산하지 않는다.
    assert s["sales_total"] == 0 and s["return_rate"] is None
    assert compute_stats(conn, "2026-01-01", "2026-01-31")["total"] == 0


def test_return_rate_uses_sales_from_order_recommendation_daily():
    conn = _conn()
    conn.execute("CREATE TABLE order_recommendation_daily (date TEXT, yusas_code TEXT, sales_qty INTEGER)")
    conn.executemany(
        "INSERT INTO order_recommendation_daily VALUES (?,?,?)",
        [("2026-11-01", "A", 60), ("2026-11-01", "B", 40), ("2026-10-31", "A", 100), ("2026-11-02", "A", None)],
    )
    upsert_rows(conn, [
        return_row(_item(1), 1, "sync"),
        return_row(_item(2), 1, "sync"),
        return_row(_item(3, cancel_completed_at="2026-11-02T09:00:00"), 1, "sync"),  # 판매 미수집일 → 반품률에서 제외
    ])
    s = compute_stats(conn, "2026-10-30", "2026-11-02")
    assert s["sales_total"] == 200 and s["sales_days"] == 2
    assert s["return_rate"] == 1.0  # 11/1 반품 2건 ÷ 판매 200
    last = {d["date"]: d for d in s["daily"]}["2026-11-01"]
    assert last["sales"] == 100 and last["rate7"] == 1.0


def test_record_safely_swallows_errors():
    def boom():
        raise RuntimeError("db down")

    assert record_safely(boom, [return_row(_item(1), 1)]) == 0
    assert record_safely(None, [return_row(_item(1), 1)]) == 0


@respx.mock
def test_sync_endpoint_saves_only_seller_items(tmp_path):
    db = tmp_path / "t.db"

    def get_db():
        c = sqlite3.connect(db)
        c.row_factory = sqlite3.Row
        return c

    respx.post("https://api.a-bly.com/seller/login/").mock(return_value=httpx.Response(200, json={"token": "t"}))

    def handler(request):
        status = request.url.params.get_list("processing_sub_status[]")[0]
        page = int(request.url.params["page"])
        if status == "43":
            items = [_item(11, fee=0, status=43, cancel_completed_at=None), _item(12, fee=-6000, status=43)]
        else:
            items = [_item(21 + page, fee=0, status=44)]
        return httpx.Response(200, json={
            "order_cancels": [{"sno": 1, "order_items": items}],
            "max_page_number": 2 if status == "44" else 1,
        })

    respx.get("https://api.a-bly.com/seller/order_cancels/").mock(side_effect=handler)

    app = FastAPI()
    app.include_router(build_seller_stats_router(get_current_user=lambda: "tester", get_db=get_db))
    client = TestClient(app)

    res = client.post("/seller-stats/sync?days=30")
    assert res.status_code == 200
    body = res.json()
    assert body["refund_requested"] == 1  # 고객 부담(-6000)은 제외
    assert body["completed"] == 2
    assert body["saved"] == 3

    # 재실행해도 중복 저장되지 않는다.
    client.post("/seller-stats/sync?days=30")
    stats = client.get("/seller-stats?start=2026-01-01&end=2026-12-31").json()
    assert stats["ok"] is True and stats["total"] == 3


def test_product_return_rate_ranking():
    from services.seller_return_store import display_name

    conn = _conn()
    conn.execute("CREATE TABLE order_recommendation_daily (date TEXT, yusas_code TEXT, sales_qty INTEGER)")
    conn.executemany(
        "INSERT INTO order_recommendation_daily VALUES (?,?,?)",
        [
            ("2026-11-01", "A1", 30), ("2026-11-01", "A2", 30),  # 상품 111: 옵션 2개 합쳐 판매 60
            ("2026-11-01", "B1", 200),                             # 상품 222: 판매 200
            ("2026-11-01", "C1", 5),                               # 상품 333: 판매 5 (표본 부족)
        ],
    )
    upsert_rows(conn, [
        return_row(_item(1, goods_sno=111, goods_name="[홍보🖤] 워싱 데님 팬츠 #당일발송"), 1, "sync"),
        return_row(_item(2, goods_sno=111), 1, "sync"),
        return_row(_item(3, goods_sno=111), 1, "sync"),
        return_row(_item(4, goods_sno=222), 1, "sync"),
        return_row(_item(5, goods_sno=222), 1, "sync"),
        return_row(_item(6, goods_sno=222), 1, "sync"),
        return_row(_item(7, goods_sno=222), 1, "sync"),
        return_row(_item(8, goods_sno=333), 1, "sync"),
    ])
    codes = {"111": ["A1", "A2"], "222": ["B1"], "333": ["C1"]}
    s = compute_stats(conn, "2026-10-30", "2026-11-02", codes, min_sales=20)

    rate = {p["goods_sno"]: p for p in s["products_by_rate"]}
    assert set(rate) == {"111", "222"}  # 판매 5개짜리 333은 순위에서 제외
    assert rate["111"]["rate"] == 5.0 and rate["111"]["sales"] == 60  # 3 ÷ 60
    assert rate["222"]["rate"] == 2.0
    assert [p["goods_sno"] for p in s["products_by_rate"]] == ["111", "222"]
    assert s["products_by_count"][0]["goods_sno"] == "222"  # 건수 4건이 가장 많음
    assert rate["111"]["name"] == "워싱 데님 팬츠"
    assert display_name("[a] 상품명 (기모) #태그 💖") == "상품명"
    # 매핑이 없으면 상품별 순위만 비고 나머지는 정상 계산된다.
    s2 = compute_stats(conn, "2026-10-30", "2026-11-02")
    assert s2["products_by_rate"] == [] and s2["total"] == 8


def test_vendor_ranking_includes_sales_and_rate():
    conn = _conn()
    conn.execute("CREATE TABLE order_recommendation_daily (date TEXT, yusas_code TEXT, sales_qty INTEGER)")
    conn.executemany(
        "INSERT INTO order_recommendation_daily VALUES (?,?,?)",
        [("2026-11-01", "A1", 100), ("2026-11-01", "A2", 100), ("2026-11-01", "B1", 50), ("2026-11-01", "Z9", 999)],
    )
    upsert_rows(conn, [
        return_row(_item(1, goods_sno=111), 1, "sync"),
        return_row(_item(2, goods_sno=111), 1, "sync"),
        return_row(_item(3, goods_sno=222), 1, "sync"),
    ])
    codes = {"111": ["A1", "A2"], "222": ["B1"]}
    vendors = {"A1": "슈퍼땅콩", "A2": "슈퍼땅콩", "B1": "따봉", "Z9": "기타거래처"}
    s = compute_stats(conn, "2026-10-30", "2026-11-02", codes, 20, vendors)
    top = {v["name"]: v for v in s["by_vendor"]}
    # 상관관리코드 첫 단어("케이디지") 대신 원가베이스유 거래처명으로 통일된다.
    assert set(top) == {"슈퍼땅콩", "따봉"}
    assert top["슈퍼땅콩"]["count"] == 2 and top["슈퍼땅콩"]["sales"] == 200 and top["슈퍼땅콩"]["rate"] == 1.0
    assert top["따봉"]["sales"] == 50 and top["따봉"]["rate"] == 2.0
    assert s["by_vendor"][0]["name"] == "슈퍼땅콩"
