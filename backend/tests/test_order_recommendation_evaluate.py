import sqlite3
import sys
import uuid
from datetime import datetime, timedelta
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.order_recommendation_calc import ORDER_LEAD_DAYS
from services.order_recommendation_evaluate import (
    aggregate_forecast_accuracy,
    calc_forecast_error,
    calc_within_20_percent,
    evaluate_all,
    evaluate_row,
)
from services.order_recommendation_store import (
    ensure_row,
    get_row,
    init_order_recommendation_tables,
    today_kst,
)


def _make_db_factory():
    uri = f"file:test_order_recommendation_evaluate_{uuid.uuid4().hex}?mode=memory&cache=shared"
    keep_alive = sqlite3.connect(uri, uri=True)
    keep_alive.row_factory = sqlite3.Row

    def factory():
        conn = sqlite3.connect(uri, uri=True)
        conn.row_factory = sqlite3.Row
        return conn

    return factory, keep_alive


def _days_ago(n):
    base = datetime.strptime(today_kst(), "%Y-%m-%d")
    return (base - timedelta(days=n)).strftime("%Y-%m-%d")


def _date_plus(date, days):
    return (datetime.strptime(date, "%Y-%m-%d") + timedelta(days=days)).strftime("%Y-%m-%d")


def test_calc_forecast_error_normal():
    assert calc_forecast_error(10.0, 8) == 2.0


def test_calc_forecast_error_none_when_expected_missing():
    assert calc_forecast_error(None, 8) is None


def test_calc_forecast_error_none_when_actual_missing():
    assert calc_forecast_error(10.0, None) is None


def test_calc_within_20_percent_hit_when_within_threshold():
    assert calc_within_20_percent(2.0, 10) == 1  # threshold=2.0, abs=2.0 -> 경계 포함


def test_calc_within_20_percent_miss_when_outside_threshold():
    assert calc_within_20_percent(2.1, 10) == 0


def test_calc_within_20_percent_none_when_actual_is_zero():
    assert calc_within_20_percent(5, 0) is None


def test_calc_within_20_percent_none_when_actual_is_none():
    assert calc_within_20_percent(5, None) is None


def test_calc_within_20_percent_none_when_absolute_error_is_none():
    assert calc_within_20_percent(None, 10) is None


def test_evaluate_row_computes_error_and_hit_flag():
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    conn = get_db()
    code = "YUSAS00001"
    date = _days_ago(2)  # date+ORDER_LEAD_DAYS의 실제값과 비교하므로 2일 전으로 잡아 여유를 둔다
    target_date = _date_plus(date, ORDER_LEAD_DAYS)
    ensure_row(conn, date, code)
    conn.execute(
        "UPDATE order_recommendation_daily SET expected_sales_today = 12 WHERE date = ? AND yusas_code = ?",
        (date, code),
    )
    ensure_row(conn, target_date, code)
    conn.execute(
        "UPDATE order_recommendation_daily SET sales_qty = 10 WHERE date = ? AND yusas_code = ?",
        (target_date, code),
    )
    conn.commit()

    evaluate_row(conn, code, date)

    row = get_row(conn, date, code)
    assert row["forecast_error"] == 2.0
    assert row["absolute_error"] == 2.0
    assert row["within_20_percent"] == 1
    assert row["evaluated_actual_qty"] == 10
    assert row["evaluated_at"] is not None
    conn.close()


def test_evaluate_row_leaves_columns_null_when_expected_sales_today_missing():
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    conn = get_db()
    code = "YUSAS00001"
    date = _days_ago(1)
    ensure_row(conn, date, code)
    conn.execute(
        "UPDATE order_recommendation_daily SET sales_qty = 10 WHERE date = ? AND yusas_code = ?",
        (date, code),
    )
    conn.commit()

    evaluate_row(conn, code, date)

    row = get_row(conn, date, code)
    assert row["forecast_error"] is None
    assert row["absolute_error"] is None
    assert row["within_20_percent"] is None
    conn.close()


def test_evaluate_row_does_nothing_when_row_missing():
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    conn = get_db()
    evaluate_row(conn, "YUSAS_NOT_SEEDED", "2026-07-29")
    assert get_row(conn, "2026-07-29", "YUSAS_NOT_SEEDED") is None
    conn.close()


def test_evaluate_row_never_touches_model_version_or_weight_snapshot():
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    conn = get_db()
    code = "YUSAS00001"
    date = _days_ago(2)
    target_date = _date_plus(date, ORDER_LEAD_DAYS)
    ensure_row(conn, date, code)
    conn.execute(
        "UPDATE order_recommendation_daily SET expected_sales_today = 12, "
        "model_version = 'some_version', model_weight_weekday = 0.99 "
        "WHERE date = ? AND yusas_code = ?",
        (date, code),
    )
    ensure_row(conn, target_date, code)
    conn.execute(
        "UPDATE order_recommendation_daily SET sales_qty = 10 WHERE date = ? AND yusas_code = ?",
        (target_date, code),
    )
    conn.commit()

    evaluate_row(conn, code, date)

    row = get_row(conn, date, code)
    assert row["model_version"] == "some_version"
    assert row["model_weight_weekday"] == 0.99
    conn.close()


def test_evaluate_all_processes_every_code_for_the_date():
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    conn = get_db()
    date = _days_ago(1)
    for code in ["YUSAS00001", "YUSAS00002"]:
        ensure_row(conn, date, code)
        conn.execute(
            "UPDATE order_recommendation_daily SET expected_sales_today = 10, sales_qty = 10 "
            "WHERE date = ? AND yusas_code = ?",
            (date, code),
        )
    conn.commit()
    conn.close()

    count = evaluate_all(get_db, date)
    assert count == 2


def _seed_and_evaluate(conn, code, date, expected, actual):
    """expected는 date 행에, actual은 date+ORDER_LEAD_DAYS(발주가 실제로 커버하는 날) 행에 심는다."""
    target_date = _date_plus(date, ORDER_LEAD_DAYS)
    ensure_row(conn, date, code)
    conn.execute(
        "UPDATE order_recommendation_daily SET expected_sales_today = ? WHERE date = ? AND yusas_code = ?",
        (expected, date, code),
    )
    ensure_row(conn, target_date, code)
    conn.execute(
        "UPDATE order_recommendation_daily SET sales_qty = ? WHERE date = ? AND yusas_code = ?",
        (actual, target_date, code),
    )
    conn.commit()
    evaluate_row(conn, code, date)


def test_aggregate_forecast_accuracy_computes_mae_wape_and_hit_rate():
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    conn = get_db()
    code = "YUSAS00001"

    _seed_and_evaluate(conn, code, _days_ago(2), expected=12, actual=10)  # abs=2, hit
    _seed_and_evaluate(conn, code, _days_ago(5), expected=8, actual=10)   # abs=2, hit
    _seed_and_evaluate(conn, code, _days_ago(1), expected=6, actual=0)    # abs=6, actual=0 -> hit=None
    _seed_and_evaluate(conn, code, _days_ago(10), expected=100, actual=1)  # 7일 윈도 밖 — 제외돼야 함

    result = aggregate_forecast_accuracy(conn, days=7)

    assert result["sample_count"] == 3
    assert result["mae"] == pytest.approx(10 / 3)
    assert result["wape"] == pytest.approx(0.5)
    assert result["hit_rate_20pct"] == pytest.approx(1.0)
    conn.close()


def test_aggregate_forecast_accuracy_filters_by_yusas_code():
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    conn = get_db()

    _seed_and_evaluate(conn, "YUSAS00001", _days_ago(1), expected=12, actual=10)  # abs=2
    _seed_and_evaluate(conn, "YUSAS00002", _days_ago(1), expected=50, actual=10)  # abs=40, 다른 상품

    result = aggregate_forecast_accuracy(conn, days=7, yusas_code="YUSAS00001")

    assert result["sample_count"] == 1
    assert result["mae"] == pytest.approx(2.0)
    conn.close()


def test_aggregate_forecast_accuracy_returns_none_metrics_when_no_data():
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    conn = get_db()

    result = aggregate_forecast_accuracy(conn, days=7)

    assert result["sample_count"] == 0
    assert result["mae"] is None
    assert result["wape"] is None
    assert result["hit_rate_20pct"] is None
    conn.close()
