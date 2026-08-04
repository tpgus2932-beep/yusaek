import pytest
import sqlite3
import sys
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import FastAPI
from fastapi.testclient import TestClient

import services.order_recommendation_collect as collect_mod
from api.order_recommendation_routes import BACKTEST_TOP_N, build_order_recommendation_router
from sdk.ezadmin import EzAdminSessionExpired
from services.order_recommendation_calc import ORDER_LEAD_DAYS
from services.order_recommendation_store import (
    ensure_row,
    init_order_recommendation_tables,
    today_kst,
)


def _date_plus(date: str, days: int) -> str:
    return (datetime.strptime(date, "%Y-%m-%d") + timedelta(days=days)).strftime("%Y-%m-%d")


def _make_db_factory():
    uri = f"file:test_order_recommendation_routes_{uuid.uuid4().hex}?mode=memory&cache=shared"
    keep_alive = sqlite3.connect(uri, uri=True)
    keep_alive.row_factory = sqlite3.Row

    def factory():
        conn = sqlite3.connect(uri, uri=True)
        conn.row_factory = sqlite3.Row
        return conn

    return factory, keep_alive


def _make_client(settings=None):
    get_db, keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    get_shared_db, shared_keep_alive = _make_db_factory()
    store = dict(settings or {})

    app = FastAPI()
    app.include_router(
        build_order_recommendation_router(
            get_current_user=lambda: "tester",
            get_db=get_db,
            get_setting=lambda key: store.get(key),
            set_setting=lambda key, value: store.__setitem__(key, value),
            get_shared_db=get_shared_db,
        )
    )
    client = TestClient(app)
    client._shared_keep_alive = shared_keep_alive  # 참조 유지 - 없으면 in-memory 공유 DB가 사라짐
    return client, get_db, keep_alive, store


@pytest.fixture(autouse=True)
def _stub_wonbe_product_name_map(monkeypatch):
    """실제 wonbe.db 파일을 매번 열지 않도록 기본값(빈 매핑)으로 목 처리.
    상품명 매칭 자체를 검증하는 테스트는 자기 안에서 with patch(...)로 덮어쓴다."""
    monkeypatch.setattr(
        "api.order_recommendation_routes.load_wonbe_product_name_map", lambda: {}
    )


def test_daily_returns_empty_list_initially():
    client, _get_db, _keep_alive, _store = _make_client()
    res = client.get("/order-recommendation/daily", params={"date": "2026-07-29"})
    assert res.status_code == 200
    assert res.json() == {"ok": True, "date": "2026-07-29", "items": []}


def test_confirm_creates_row_and_sets_confirmed_fields():
    client, get_db, _keep_alive, _store = _make_client()
    res = client.post(
        "/order-recommendation/2026-07-29/YUSAS00001/confirm",
        json={"confirmed_qty": 7, "override_reason": "장마철 여유분"},
    )
    assert res.status_code == 200

    res2 = client.get("/order-recommendation/daily", params={"date": "2026-07-29"})
    items = res2.json()["items"]
    assert len(items) == 1
    assert items[0]["confirmed_qty"] == 7
    assert items[0]["override_reason"] == "장마철 여유분"
    assert items[0]["updated_by"] == "tester"
    assert items[0]["updated_at"] is not None


def test_daily_includes_product_name_when_wonbe_matches():
    client, get_db, _keep_alive, _store = _make_client()
    conn = get_db()
    ensure_row(conn, "2026-07-29", "S24083")
    conn.commit()
    conn.close()

    with patch(
        "api.order_recommendation_routes.load_wonbe_product_name_map",
        return_value={"S24083": "나샤 실버 목걸이"},
    ):
        res = client.get("/order-recommendation/daily", params={"date": "2026-07-29"})

    items = res.json()["items"]
    assert len(items) == 1
    assert items[0]["product_name"] == "나샤 실버 목걸이"


def test_daily_product_name_empty_string_when_wonbe_has_no_match():
    client, get_db, _keep_alive, _store = _make_client()
    conn = get_db()
    ensure_row(conn, "2026-07-29", "S24083")
    conn.commit()
    conn.close()

    with patch(
        "api.order_recommendation_routes.load_wonbe_product_name_map",
        return_value={},
    ):
        res = client.get("/order-recommendation/daily", params={"date": "2026-07-29"})

    items = res.json()["items"]
    assert items[0]["product_name"] == ""


def test_backtest_date_range_returns_null_when_no_sales_data():
    client, _get_db, _keep_alive, _store = _make_client()
    res = client.get("/order-recommendation/backtest/date-range")
    assert res.status_code == 200
    assert res.json() == {"ok": True, "min_date": None, "max_date": None}


def test_backtest_date_range_min_is_pushed_3_weeks_after_earliest_collected_date():
    """같은요일평균이 최대 3주 전까지 조회하므로, 수집 시작일 자체는 같은요일 3주치가
    없어 min으로 노출되면 안 되고 수집 시작일 + 21일부터 선택 가능해야 한다."""
    client, get_db, _keep_alive, _store = _make_client()
    conn = get_db()
    for d in ("2026-07-01", "2026-07-15", "2026-07-29"):
        ensure_row(conn, d, "YUSAS00001")
        conn.execute(
            "UPDATE order_recommendation_daily SET sales_qty = 3 WHERE date = ? AND yusas_code = ?",
            (d, "YUSAS00001"),
        )
    # sales_qty가 아직 안 채워진(수집 안 된) 날짜는 범위에 영향을 주면 안 됨
    ensure_row(conn, "2026-08-01", "YUSAS00001")
    conn.commit()
    conn.close()

    res = client.get("/order-recommendation/backtest/date-range")
    assert res.status_code == 200
    body = res.json()
    assert body["min_date"] == "2026-07-22"  # 2026-07-01 + 21일
    assert body["max_date"] == "2026-07-28"  # 수집 최신일(2026-07-29) - ORDER_LEAD_DAYS(1일)


def test_backtest_date_range_min_date_null_when_not_enough_runway_yet():
    """수집 시작일 + 21일이 아직 최신 수집일을 넘어가면(수집한 지 3주가 안 됐으면)
    같은요일 3주치를 온전히 갖춘 날짜가 하나도 없으므로 min_date는 null이어야 한다."""
    client, get_db, _keep_alive, _store = _make_client()
    conn = get_db()
    for d in ("2026-07-01", "2026-07-10"):
        ensure_row(conn, d, "YUSAS00001")
        conn.execute(
            "UPDATE order_recommendation_daily SET sales_qty = 3 WHERE date = ? AND yusas_code = ?",
            (d, "YUSAS00001"),
        )
    conn.commit()
    conn.close()

    res = client.get("/order-recommendation/backtest/date-range")
    assert res.status_code == 200
    body = res.json()
    assert body["min_date"] is None
    assert body["max_date"] == "2026-07-09"  # 수집 최신일(2026-07-10) - ORDER_LEAD_DAYS(1일)


def test_backtest_returns_items_only_for_products_with_collected_sales_qty():
    client, get_db, _keep_alive, _store = _make_client()
    conn = get_db()

    # 판매량이 수집된 상품 -> 백테스트 대상. 예측이 실제로 겨냥하는 날(2026-07-30,
    # 계산일+ORDER_LEAD_DAYS)에 실제값을 심어야 비교가 된다.
    ensure_row(conn, "2026-07-30", "YUSAS00001")
    conn.execute(
        "UPDATE order_recommendation_daily SET sales_qty = 10 WHERE date = ? AND yusas_code = ?",
        ("2026-07-30", "YUSAS00001"),
    )
    # 판매량이 전혀 수집 안 된 상품 -> 백테스트 대상 아님
    ensure_row(conn, "2026-07-29", "YUSAS00002")
    conn.commit()
    conn.close()

    res = client.get("/order-recommendation/backtest", params={"date": "2026-07-29"})
    assert res.status_code == 200
    body = res.json()
    assert body["date"] == "2026-07-29"
    assert len(body["items"]) == 1
    assert body["items"][0]["yusas_code"] == "YUSAS00001"
    assert body["items"][0]["actual_sales_qty"] == 10


def test_backtest_limits_to_top_n_products_by_total_sales_qty():
    client, get_db, _keep_alive, _store = _make_client()
    conn = get_db()
    for i in range(BACKTEST_TOP_N + 1):
        code = f"YUSAS{i:05d}"
        ensure_row(conn, "2026-07-29", code)
        conn.execute(
            "UPDATE order_recommendation_daily SET sales_qty = ? WHERE date = ? AND yusas_code = ?",
            (i + 1, "2026-07-29", code),  # 판매량 1~(N+1), YUSAS00000이 최소
        )
    conn.commit()
    conn.close()

    res = client.get("/order-recommendation/backtest", params={"date": "2026-07-29"})
    assert res.status_code == 200
    codes = {item["yusas_code"] for item in res.json()["items"]}
    assert len(codes) == BACKTEST_TOP_N
    assert "YUSAS00000" not in codes  # 판매량이 가장 적은 상품은 상위 N 밖
    assert f"YUSAS{BACKTEST_TOP_N:05d}" in codes  # 판매량이 가장 많은 상품은 포함


def test_backtest_applies_weight_overrides_and_computes_aggregate():
    client, get_db, _keep_alive, _store = _make_client()
    conn = get_db()

    ensure_row(conn, "2026-07-28", "YUSAS00001")
    conn.execute(
        "UPDATE order_recommendation_daily SET sales_qty = 10 WHERE date = ? AND yusas_code = ?",
        ("2026-07-28", "YUSAS00001"),
    )
    # 예측이 실제로 겨냥하는 날(2026-07-30, 계산일+ORDER_LEAD_DAYS)에 실제값을 심는다.
    ensure_row(conn, "2026-07-30", "YUSAS00001")
    conn.execute(
        "UPDATE order_recommendation_daily SET sales_qty = 10 WHERE date = ? AND yusas_code = ?",
        ("2026-07-30", "YUSAS00001"),
    )
    conn.commit()
    conn.close()

    # weight_previous_day=1, 나머지 0 -> 신호가 전날값(07-28=10)만 남아 expected_sales_today == 10 -> 오차 0 -> 적중
    res = client.get(
        "/order-recommendation/backtest",
        params={
            "date": "2026-07-29",
            "weight_weekday_average": 0,
            "weight_previous_day": 1,
            "weight_avg_7d": 0,
            "weight_avg_14d": 0,
            "weight_avg_3d": 0,
        },
    )
    assert res.status_code == 200
    body = res.json()
    assert body["items"][0]["expected_sales_today"] == pytest.approx(10.0)
    assert body["items"][0]["forecast_error"] == pytest.approx(0.0)
    assert body["items"][0]["within_20_percent"] == 1
    assert body["sample_count"] == 1
    assert body["hit_rate_20pct"] == pytest.approx(1.0)
    assert body["bias"] == pytest.approx(0.0)


def test_backtest_days_param_aggregates_multiple_dates_into_one_result():
    client, get_db, _keep_alive, _store = _make_client()
    conn = get_db()

    for date, qty in [("2026-07-26", 10), ("2026-07-27", 20), ("2026-07-28", 30), ("2026-07-29", 40), ("2026-07-30", 50)]:
        ensure_row(conn, date, "YUSAS00001")
        conn.execute(
            "UPDATE order_recommendation_daily SET sales_qty = ? WHERE date = ? AND yusas_code = ?",
            (qty, date, "YUSAS00001"),
        )
    conn.commit()
    conn.close()

    # date=07-29, days=3 -> 계산일 07-27,07-28,07-29 세 날짜를 전날값(weight_previous_day=1)만으로
    # 예측하고, 각각 계산일+1일(리드타임)의 실제값과 비교해 하나로 합산한다.
    # 07-27: 예상=전날(07-26)=10, 실제(07-28)=30, 오차=-20
    # 07-28: 예상=전날(07-27)=20, 실제(07-29)=40, 오차=-20
    # 07-29: 예상=전날(07-28)=30, 실제(07-30)=50, 오차=-20
    res = client.get(
        "/order-recommendation/backtest",
        params={
            "date": "2026-07-29",
            "days": 3,
            "weight_weekday_average": 0,
            "weight_previous_day": 1,
            "weight_avg_7d": 0,
            "weight_avg_14d": 0,
            "weight_avg_3d": 0,
        },
    )
    assert res.status_code == 200
    body = res.json()
    assert body["sample_count"] == 3  # 3개 날짜 x 1개 상품
    assert body["mae"] == pytest.approx(20.0)
    assert body["wape"] == pytest.approx(60 / 120)
    assert body["bias"] == pytest.approx(-60 / 120)
    assert body["hit_rate_20pct"] == pytest.approx(0.0)
    assert {item["date"] for item in body["items"]} == {"2026-07-27", "2026-07-28", "2026-07-29"}


def test_backtest_days_param_clamped_to_max_5():
    client, get_db, _keep_alive, _store = _make_client()
    conn = get_db()
    ensure_row(conn, "2026-07-29", "YUSAS00001")
    conn.execute(
        "UPDATE order_recommendation_daily SET sales_qty = 5 WHERE date = ? AND yusas_code = ?",
        ("2026-07-29", "YUSAS00001"),
    )
    conn.commit()
    conn.close()

    res = client.get(
        "/order-recommendation/backtest",
        params={"date": "2026-07-29", "days": 30},
    )
    assert res.status_code == 200
    body = res.json()
    dates = {item["date"] for item in body["items"]}
    assert len(dates) == 5


def test_backtest_bias_is_positive_when_overforecasting():
    client, get_db, _keep_alive, _store = _make_client()
    conn = get_db()

    ensure_row(conn, "2026-07-28", "YUSAS00001")
    conn.execute(
        "UPDATE order_recommendation_daily SET sales_qty = 20 WHERE date = ? AND yusas_code = ?",
        ("2026-07-28", "YUSAS00001"),
    )
    # 예측이 실제로 겨냥하는 날(2026-07-30, 계산일+ORDER_LEAD_DAYS)에 실제값을 심는다.
    ensure_row(conn, "2026-07-30", "YUSAS00001")
    conn.execute(
        "UPDATE order_recommendation_daily SET sales_qty = 10 WHERE date = ? AND yusas_code = ?",
        ("2026-07-30", "YUSAS00001"),
    )
    conn.commit()
    conn.close()

    # weight_previous_day=1 -> expected_sales_today = 전날(07-28=20), 실제(07-30)는 10 -> 오차 +10(과다예측)
    res = client.get(
        "/order-recommendation/backtest",
        params={
            "date": "2026-07-29",
            "weight_weekday_average": 0,
            "weight_previous_day": 1,
            "weight_avg_7d": 0,
            "weight_avg_14d": 0,
            "weight_avg_3d": 0,
        },
    )
    assert res.status_code == 200
    body = res.json()
    assert body["items"][0]["forecast_error"] == pytest.approx(10.0)
    # bias = 부호있는오차합(10) / 실제합(10) = 1.0 (실제보다 평균 100% 많이 예측 = 과다발주 경향)
    assert body["bias"] == pytest.approx(1.0)


def test_compute_endpoint_fills_recommended_qty_for_existing_rows():
    client, get_db, _keep_alive, _store = _make_client()
    conn = get_db()
    for date, qty in [("2026-07-22", 10), ("2026-07-15", 10), ("2026-07-08", 10), ("2026-07-01", 10)]:
        ensure_row(conn, date, "YUSAS00001")
        conn.execute(
            "UPDATE order_recommendation_daily SET sales_qty = ? WHERE date = ? AND yusas_code = ?",
            (qty, date, "YUSAS00001"),
        )
    ensure_row(conn, "2026-07-29", "YUSAS00001")
    conn.execute(
        "UPDATE order_recommendation_daily SET stock_qty = 0, incoming_qty = 0 "
        "WHERE date = ? AND yusas_code = ?",
        ("2026-07-29", "YUSAS00001"),
    )
    conn.commit()
    conn.close()

    res = client.post("/order-recommendation/compute", params={"date": "2026-07-29"})
    assert res.status_code == 200
    assert res.json()["computed"] == 1

    res2 = client.get("/order-recommendation/daily", params={"date": "2026-07-29"})
    row = res2.json()["items"][0]
    # expected_sales_today=10.0 -> 10~15 구간 -> 커버리지 자동 5일치로 합산
    assert row["recommended_qty"] == 50


def test_collect_endpoint_invokes_registered_collectors():
    client, get_db, _keep_alive, _store = _make_client()
    try:
        async def fake_collector(date):
            return {"YUSAS00001": 42}

        collect_mod.register_collector("sales_qty", fake_collector)

        res = client.post("/order-recommendation/collect", params={"date": "2026-07-29"})
        assert res.status_code == 200
        assert res.json()["updated_codes"] == ["YUSAS00001"]

        res2 = client.get("/order-recommendation/daily", params={"date": "2026-07-29"})
        assert res2.json()["items"][0]["sales_qty"] == 42
    finally:
        collect_mod.COLLECTORS.clear()


def test_collect_endpoint_defaults_to_empty_when_no_collectors_registered():
    client, _get_db, _keep_alive, _store = _make_client()
    collect_mod.COLLECTORS.clear()
    res = client.post("/order-recommendation/collect", params={"date": "2026-07-29"})
    assert res.status_code == 200
    assert res.json()["updated_codes"] == []


def test_evaluate_endpoint_fills_forecast_accuracy_columns():
    client, get_db, _keep_alive, _store = _make_client()
    conn = get_db()
    date = today_kst()
    target_date = _date_plus(date, ORDER_LEAD_DAYS)
    ensure_row(conn, date, "YUSAS00001")
    conn.execute(
        "UPDATE order_recommendation_daily SET expected_sales_today = 12 WHERE date = ? AND yusas_code = ?",
        (date, "YUSAS00001"),
    )
    ensure_row(conn, target_date, "YUSAS00001")
    conn.execute(
        "UPDATE order_recommendation_daily SET sales_qty = 10 WHERE date = ? AND yusas_code = ?",
        (target_date, "YUSAS00001"),
    )
    conn.commit()
    conn.close()

    res = client.post("/order-recommendation/evaluate", params={"date": date})
    assert res.status_code == 200
    assert res.json()["evaluated"] == 1

    res2 = client.get("/order-recommendation/daily", params={"date": date})
    row = res2.json()["items"][0]
    assert row["forecast_error"] == 2.0


def test_forecast_accuracy_endpoint_returns_aggregate_metrics():
    client, get_db, _keep_alive, _store = _make_client()
    conn = get_db()
    date = today_kst()
    target_date = _date_plus(date, ORDER_LEAD_DAYS)
    ensure_row(conn, date, "YUSAS00001")
    conn.execute(
        "UPDATE order_recommendation_daily SET expected_sales_today = 12 WHERE date = ? AND yusas_code = ?",
        (date, "YUSAS00001"),
    )
    ensure_row(conn, target_date, "YUSAS00001")
    conn.execute(
        "UPDATE order_recommendation_daily SET sales_qty = 10 WHERE date = ? AND yusas_code = ?",
        (target_date, "YUSAS00001"),
    )
    conn.commit()
    conn.close()
    client.post("/order-recommendation/evaluate", params={"date": date})

    res = client.get("/order-recommendation/forecast-accuracy", params={"days": 7})
    assert res.status_code == 200
    body = res.json()
    assert body["sample_count"] == 1
    assert body["mae"] == pytest.approx(2.0)


def test_evaluate_order_performance_endpoint_fills_deviation_columns():
    client, get_db, _keep_alive, _store = _make_client()
    conn = get_db()
    date = today_kst()
    ensure_row(conn, date, "YUSAS00001")
    conn.execute(
        "UPDATE order_recommendation_daily SET recommended_qty = 10, confirmed_qty = 12 "
        "WHERE date = ? AND yusas_code = ?",
        (date, "YUSAS00001"),
    )
    conn.commit()
    conn.close()

    res = client.post("/order-recommendation/evaluate-order-performance", params={"date": date})
    assert res.status_code == 200
    assert res.json()["evaluated"] == 1

    res2 = client.get("/order-recommendation/daily", params={"date": date})
    row = res2.json()["items"][0]
    assert row["confirm_deviation"] == 2


def test_order_performance_endpoint_returns_aggregate_metrics():
    client, get_db, _keep_alive, _store = _make_client()
    conn = get_db()
    date = today_kst()
    ensure_row(conn, date, "YUSAS00001")
    conn.execute(
        "UPDATE order_recommendation_daily SET recommended_qty = 10, confirmed_qty = 12 "
        "WHERE date = ? AND yusas_code = ?",
        (date, "YUSAS00001"),
    )
    conn.commit()
    conn.close()
    client.post("/order-recommendation/evaluate-order-performance", params={"date": date})

    res = client.get("/order-recommendation/order-performance", params={"days": 7})
    assert res.status_code == 200
    body = res.json()
    assert body["sample_count"] == 1
    assert body["avg_confirm_deviation"] == pytest.approx(2.0)


def test_collect_endpoint_returns_need_session_when_ezadmin_session_expired():
    client, _get_db, _keep_alive, _store = _make_client()
    try:
        async def failing_collector(date):
            raise EzAdminSessionExpired()

        collect_mod.register_collector("stock_qty", failing_collector)

        res = client.post("/order-recommendation/collect", params={"date": "2026-07-29"})
        assert res.status_code == 200
        assert res.json() == {"ok": False, "need_session": True}
    finally:
        collect_mod.COLLECTORS.clear()


def test_collect_sales_history_endpoint_returns_updated_count():
    client, _get_db, _keep_alive, _store = _make_client()

    with patch(
        "api.order_recommendation_routes.collect_ably_sales_history",
        new=AsyncMock(return_value=42),
    ):
        res = client.post("/order-recommendation/collect-sales-history")

    assert res.status_code == 200
    assert res.json() == {"ok": True, "updated": 42}


def test_collect_sales_history_progress_endpoint_returns_progress_dict():
    client, _get_db, _keep_alive, _store = _make_client()

    with patch(
        "api.order_recommendation_routes.get_sales_history_progress",
        return_value={"running": True, "total": 100, "done": 40, "updated": 60},
    ):
        res = client.get("/order-recommendation/collect-sales-history/progress")

    assert res.status_code == 200
    assert res.json() == {"running": True, "total": 100, "done": 40, "updated": 60}


def test_discover_missed_reorders_endpoint_passes_query_params_and_returns_result():
    client, _get_db, _keep_alive, _store = _make_client()

    fake_result = {
        "date": "2026-08-04", "days": 5, "limit": 10, "candidate_count": 2,
        "need_ezadmin_session": False,
        "items": [{"yusas_code": "S1", "confirmed_qty": 3}],
    }
    with patch(
        "api.order_recommendation_routes.discover_missed_reorder_candidates",
        new=AsyncMock(return_value=fake_result),
    ) as mocked:
        res = client.get("/order-recommendation/discover-missed-reorders", params={"days": 5, "limit": 10})

    assert res.status_code == 200
    assert res.json() == {"ok": True, **fake_result}
    _args, kwargs = mocked.call_args
    assert kwargs == {"days": 5, "limit": 10}


def test_discover_missed_reorders_endpoint_uses_defaults_when_no_params():
    client, _get_db, _keep_alive, _store = _make_client()

    fake_result = {
        "date": "2026-08-04", "days": 3, "limit": 150, "candidate_count": 0,
        "need_ezadmin_session": False, "items": [],
    }
    with patch(
        "api.order_recommendation_routes.discover_missed_reorder_candidates",
        new=AsyncMock(return_value=fake_result),
    ) as mocked:
        res = client.get("/order-recommendation/discover-missed-reorders")

    assert res.status_code == 200
    _args, kwargs = mocked.call_args
    assert kwargs == {"days": 3, "limit": 150}


def test_discover_missed_reorders_endpoint_saves_snapshot_for_that_date():
    client, _get_db, _keep_alive, _store = _make_client()

    fake_result = {
        "date": "2026-08-04", "days": 3, "limit": 150, "candidate_count": 1,
        "need_ezadmin_session": False,
        "items": [{"yusas_code": "S1", "confirmed_qty": 6}],
    }
    with patch(
        "api.order_recommendation_routes.discover_missed_reorder_candidates",
        new=AsyncMock(return_value=fake_result),
    ):
        client.get("/order-recommendation/discover-missed-reorders")

    res = client.get("/order-recommendation/discover-missed-reorders/saved", params={"date": "2026-08-04"})
    assert res.status_code == 200
    body = res.json()
    assert body["saved"] is True
    assert body["items"] == [{"yusas_code": "S1", "confirmed_qty": 6}]
    assert body["updated_by"] == "tester"


def test_discover_missed_reorders_endpoint_overwrites_same_day_snapshot():
    client, _get_db, _keep_alive, _store = _make_client()

    first = {
        "date": "2026-08-04", "days": 3, "limit": 150, "candidate_count": 1,
        "need_ezadmin_session": False, "items": [{"yusas_code": "OLD"}],
    }
    second = {
        "date": "2026-08-04", "days": 3, "limit": 150, "candidate_count": 1,
        "need_ezadmin_session": False, "items": [{"yusas_code": "NEW"}],
    }
    with patch(
        "api.order_recommendation_routes.discover_missed_reorder_candidates",
        new=AsyncMock(side_effect=[first, second]),
    ):
        client.get("/order-recommendation/discover-missed-reorders")
        client.get("/order-recommendation/discover-missed-reorders")

    res = client.get("/order-recommendation/discover-missed-reorders/saved", params={"date": "2026-08-04"})
    assert res.json()["items"] == [{"yusas_code": "NEW"}]


def test_discover_missed_reorders_saved_endpoint_returns_not_saved_when_empty():
    client, _get_db, _keep_alive, _store = _make_client()

    res = client.get("/order-recommendation/discover-missed-reorders/saved", params={"date": "2026-08-04"})
    assert res.status_code == 200
    assert res.json() == {"ok": True, "saved": False}


def test_save_weights_updates_settings_store():
    client, _get_db, _keep_alive, store = _make_client()

    res = client.post(
        "/order-recommendation/weights",
        json={"weight_weekday_average": 0.3, "weight_avg_3d": 0.1},
    )
    assert res.status_code == 200
    assert res.json() == {"ok": True}
    assert store["order_recommendation_weight_weekday_average"] == "0.3"
    assert store["order_recommendation_weight_avg_3d"] == "0.1"


def test_save_weights_ignores_missing_keys():
    client, _get_db, _keep_alive, store = _make_client()

    res = client.post("/order-recommendation/weights", json={"weight_previous_day": 0.4})
    assert res.status_code == 200
    assert "order_recommendation_weight_previous_day" in store
    assert "order_recommendation_weight_weekday_average" not in store


def test_coverage_check_single_day_coverage_matches_actual_sales():
    client, get_db, _keep_alive, _store = _make_client()
    conn = get_db()
    ensure_row(conn, "2026-07-01", "YUSAS00001")
    conn.execute(
        "UPDATE order_recommendation_daily SET recommended_qty = ?, coverage_days_used = ? "
        "WHERE date = ? AND yusas_code = ?",
        (10, 1, "2026-07-01", "YUSAS00001"),
    )
    # 커버리지가 실제로 겨냥하는 날(2026-07-02, 발주일+ORDER_LEAD_DAYS)에 실제값을 심는다.
    ensure_row(conn, "2026-07-02", "YUSAS00001")
    conn.execute(
        "UPDATE order_recommendation_daily SET sales_qty = ? WHERE date = ? AND yusas_code = ?",
        (8, "2026-07-02", "YUSAS00001"),
    )
    conn.commit()
    conn.close()

    res = client.get("/order-recommendation/coverage-check", params={"date": "2026-07-01"})
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is True
    assert body["sample_count"] == 1
    item = body["items"][0]
    assert item["yusas_code"] == "YUSAS00001"
    assert item["coverage_days_used"] == 1
    assert item["recommended_qty"] == 10
    assert item["actual_coverage_sales"] == 8
    assert item["forecast_error"] == pytest.approx(2.0)


def test_coverage_check_multi_day_coverage_sums_forward():
    client, get_db, _keep_alive, _store = _make_client()
    conn = get_db()
    ensure_row(conn, "2026-07-01", "YUSAS00002")
    conn.execute(
        "UPDATE order_recommendation_daily SET recommended_qty = ?, coverage_days_used = ? "
        "WHERE date = ? AND yusas_code = ?",
        (15, 3, "2026-07-01", "YUSAS00002"),
    )
    # 커버리지가 실제로 겨냥하는 3일(2026-07-02~04, 발주일+ORDER_LEAD_DAYS부터)에 실제값을 심는다.
    ensure_row(conn, "2026-07-02", "YUSAS00002")
    conn.execute(
        "UPDATE order_recommendation_daily SET sales_qty = ? WHERE date = ? AND yusas_code = ?",
        (5, "2026-07-02", "YUSAS00002"),
    )
    ensure_row(conn, "2026-07-03", "YUSAS00002")
    conn.execute(
        "UPDATE order_recommendation_daily SET sales_qty = ? WHERE date = ? AND yusas_code = ?",
        (4, "2026-07-03", "YUSAS00002"),
    )
    ensure_row(conn, "2026-07-04", "YUSAS00002")
    conn.execute(
        "UPDATE order_recommendation_daily SET sales_qty = ? WHERE date = ? AND yusas_code = ?",
        (6, "2026-07-04", "YUSAS00002"),
    )
    conn.commit()
    conn.close()

    res = client.get("/order-recommendation/coverage-check", params={"date": "2026-07-01"})
    body = res.json()
    item = body["items"][0]
    assert item["actual_coverage_sales"] == 15  # 5 + 4 + 6
    assert item["recommended_qty"] == 15
    assert item["forecast_error"] == pytest.approx(0.0)


def test_coverage_check_excludes_product_with_incomplete_window():
    client, get_db, _keep_alive, _store = _make_client()
    conn = get_db()
    ensure_row(conn, "2026-07-01", "YUSAS00003")
    conn.execute(
        "UPDATE order_recommendation_daily SET recommended_qty = ?, coverage_days_used = ?, sales_qty = ? "
        "WHERE date = ? AND yusas_code = ?",
        (10, 3, 5, "2026-07-01", "YUSAS00003"),
    )
    ensure_row(conn, "2026-07-02", "YUSAS00003")
    conn.execute(
        "UPDATE order_recommendation_daily SET sales_qty = ? WHERE date = ? AND yusas_code = ?",
        (4, "2026-07-02", "YUSAS00003"),
    )
    # 2026-07-03 행 자체가 없음 -> 커버리지 3일 기간이 미완료 -> 결과에서 제외돼야 함
    conn.commit()
    conn.close()

    res = client.get("/order-recommendation/coverage-check", params={"date": "2026-07-01"})
    body = res.json()
    assert body["items"] == []
    assert body["sample_count"] == 0


def test_coverage_check_aggregates_mae_wape_bias_hit_rate():
    client, get_db, _keep_alive, _store = _make_client()
    conn = get_db()
    ensure_row(conn, "2026-07-01", "YUSAS_A")
    conn.execute(
        "UPDATE order_recommendation_daily SET recommended_qty = ?, coverage_days_used = ? "
        "WHERE date = ? AND yusas_code = ?",
        (12, 1, "2026-07-01", "YUSAS_A"),
    )
    ensure_row(conn, "2026-07-01", "YUSAS_B")
    conn.execute(
        "UPDATE order_recommendation_daily SET recommended_qty = ?, coverage_days_used = ? "
        "WHERE date = ? AND yusas_code = ?",
        (8, 1, "2026-07-01", "YUSAS_B"),
    )
    # 커버리지가 실제로 겨냥하는 날(2026-07-02, 발주일+ORDER_LEAD_DAYS)에 실제값을 심는다.
    ensure_row(conn, "2026-07-02", "YUSAS_A")
    conn.execute(
        "UPDATE order_recommendation_daily SET sales_qty = ? WHERE date = ? AND yusas_code = ?",
        (10, "2026-07-02", "YUSAS_A"),
    )
    ensure_row(conn, "2026-07-02", "YUSAS_B")
    conn.execute(
        "UPDATE order_recommendation_daily SET sales_qty = ? WHERE date = ? AND yusas_code = ?",
        (10, "2026-07-02", "YUSAS_B"),
    )
    conn.commit()
    conn.close()

    res = client.get("/order-recommendation/coverage-check", params={"date": "2026-07-01"})
    body = res.json()

    # YUSAS_A: 오차 +2 (|2|<=20%*10=2 -> 적중), YUSAS_B: 오차 -2 (|2|<=2 -> 적중)
    assert body["sample_count"] == 2
    assert body["mae"] == pytest.approx(2.0)
    assert body["wape"] == pytest.approx(4 / 20)
    assert body["bias"] == pytest.approx(0 / 20)
    assert body["hit_rate_20pct"] == pytest.approx(1.0)
