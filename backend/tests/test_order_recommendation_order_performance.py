import sqlite3
import sys
import uuid
from datetime import datetime, timedelta
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.order_recommendation_order_performance import (
    aggregate_order_performance,
    calc_confirm_deviation,
    calc_fulfillment_gap,
    evaluate_order_performance_all,
    evaluate_order_performance_row,
)
from services.order_recommendation_store import (
    ensure_row,
    get_row,
    init_order_recommendation_tables,
    today_kst,
)


def _make_db_factory():
    uri = f"file:test_order_recommendation_order_performance_{uuid.uuid4().hex}?mode=memory&cache=shared"
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


def test_calc_confirm_deviation_normal():
    assert calc_confirm_deviation(12, 10) == 2


def test_calc_confirm_deviation_none_when_confirmed_missing():
    assert calc_confirm_deviation(None, 10) is None


def test_calc_confirm_deviation_none_when_recommended_missing():
    assert calc_confirm_deviation(12, None) is None


def test_calc_fulfillment_gap_normal():
    assert calc_fulfillment_gap(8, 10) == -2


def test_calc_fulfillment_gap_none_when_actual_missing():
    assert calc_fulfillment_gap(None, 10) is None


def test_calc_fulfillment_gap_none_when_confirmed_missing():
    assert calc_fulfillment_gap(8, None) is None


def test_evaluate_order_performance_row_computes_confirm_deviation_only_when_actual_received_missing():
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    conn = get_db()
    code = "YUSAS00001"
    date = _days_ago(1)
    ensure_row(conn, date, code)
    conn.execute(
        "UPDATE order_recommendation_daily SET recommended_qty = 10, confirmed_qty = 12 "
        "WHERE date = ? AND yusas_code = ?",
        (date, code),
    )
    conn.commit()

    evaluate_order_performance_row(conn, code, date)

    row = get_row(conn, date, code)
    assert row["confirm_deviation"] == 2
    assert row["fulfillment_gap"] is None
    assert row["order_performance_evaluated_at"] is not None
    conn.close()


def test_evaluate_order_performance_row_computes_both_when_all_present():
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    conn = get_db()
    code = "YUSAS00001"
    date = _days_ago(1)
    ensure_row(conn, date, code)
    conn.execute(
        "UPDATE order_recommendation_daily SET recommended_qty = 10, confirmed_qty = 12, "
        "actual_received_qty = 8 WHERE date = ? AND yusas_code = ?",
        (date, code),
    )
    conn.commit()

    evaluate_order_performance_row(conn, code, date)

    row = get_row(conn, date, code)
    assert row["confirm_deviation"] == 2
    assert row["fulfillment_gap"] == -4
    conn.close()


def test_evaluate_order_performance_row_does_nothing_when_row_missing():
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    conn = get_db()
    evaluate_order_performance_row(conn, "YUSAS_NOT_SEEDED", "2026-07-29")
    assert get_row(conn, "2026-07-29", "YUSAS_NOT_SEEDED") is None
    conn.close()


def test_evaluate_order_performance_all_processes_every_code_for_the_date():
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    conn = get_db()
    date = _days_ago(1)
    for code in ["YUSAS00001", "YUSAS00002"]:
        ensure_row(conn, date, code)
        conn.execute(
            "UPDATE order_recommendation_daily SET recommended_qty = 10, confirmed_qty = 10 "
            "WHERE date = ? AND yusas_code = ?",
            (date, code),
        )
    conn.commit()
    conn.close()

    count = evaluate_order_performance_all(get_db, date)
    assert count == 2


def _seed_row(conn, code, date, recommended, confirmed, actual_received, incoming_qty_change):
    ensure_row(conn, date, code)
    conn.execute(
        "UPDATE order_recommendation_daily SET recommended_qty = ?, confirmed_qty = ?, "
        "actual_received_qty = ?, incoming_qty_change = ? WHERE date = ? AND yusas_code = ?",
        (recommended, confirmed, actual_received, incoming_qty_change, date, code),
    )
    conn.commit()
    evaluate_order_performance_row(conn, code, date)


def test_aggregate_order_performance_computes_averages():
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    conn = get_db()
    code = "YUSAS00001"

    _seed_row(conn, code, _days_ago(2), recommended=10, confirmed=12, actual_received=8, incoming_qty_change=5)
    # confirm_deviation=2, fulfillment_gap=-4
    _seed_row(conn, code, _days_ago(5), recommended=20, confirmed=18, actual_received=None, incoming_qty_change=-3)
    # confirm_deviation=-2, fulfillment_gap=None
    _seed_row(conn, code, _days_ago(10), recommended=100, confirmed=200, actual_received=None, incoming_qty_change=None)
    # 7일 윈도 밖 — 제외돼야 함

    result = aggregate_order_performance(conn, days=7)

    assert result["sample_count"] == 2
    assert result["avg_confirm_deviation"] == pytest.approx(0.0)  # (2 + -2) / 2
    assert result["avg_fulfillment_gap"] == pytest.approx(-4.0)  # -4 하나뿐
    assert result["avg_incoming_qty_change"] == pytest.approx(1.0)  # (5 + -3) / 2
    conn.close()


def test_aggregate_order_performance_filters_by_yusas_code():
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    conn = get_db()

    _seed_row(conn, "YUSAS00001", _days_ago(1), recommended=10, confirmed=12, actual_received=None, incoming_qty_change=None)
    _seed_row(conn, "YUSAS00002", _days_ago(1), recommended=10, confirmed=50, actual_received=None, incoming_qty_change=None)

    result = aggregate_order_performance(conn, days=7, yusas_code="YUSAS00001")

    assert result["sample_count"] == 1
    assert result["avg_confirm_deviation"] == pytest.approx(2.0)
    conn.close()


def test_aggregate_order_performance_returns_none_metrics_when_no_data():
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    conn = get_db()

    result = aggregate_order_performance(conn, days=7)

    assert result["sample_count"] == 0
    assert result["avg_confirm_deviation"] is None
    assert result["avg_fulfillment_gap"] is None
    assert result["avg_incoming_qty_change"] is None
    conn.close()
