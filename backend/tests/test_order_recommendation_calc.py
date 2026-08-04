import pytest
import sqlite3
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.order_recommendation_calc import (
    calc_sales_window,
    calc_weekday_average_sales,
)
from services.order_recommendation_store import ensure_row, get_row, init_order_recommendation_tables


def _make_db_factory():
    uri = f"file:test_order_recommendation_calc_{uuid.uuid4().hex}?mode=memory&cache=shared"
    keep_alive = sqlite3.connect(uri, uri=True)
    keep_alive.row_factory = sqlite3.Row

    def factory():
        conn = sqlite3.connect(uri, uri=True)
        conn.row_factory = sqlite3.Row
        return conn

    return factory, keep_alive


def _seed(conn, date, code, sales_qty=None, excluded=0):
    ensure_row(conn, date, code)
    conn.execute(
        "UPDATE order_recommendation_daily SET sales_qty = ?, excluded_from_avg = ? WHERE date = ? AND yusas_code = ?",
        (sales_qty, excluded, date, code),
    )


def test_calc_sales_window_excludes_target_date_itself():
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    conn = get_db()
    code = "YUSAS00001"

    _seed(conn, "2026-07-29", code, sales_qty=100)  # 대상일 — 절대 합산되면 안 됨
    for d in ["2026-07-22", "2026-07-23", "2026-07-24", "2026-07-25",
              "2026-07-26", "2026-07-27", "2026-07-28"]:
        _seed(conn, d, code, sales_qty=10)
    conn.commit()

    total, count = calc_sales_window(conn, code, "2026-07-29", 7)
    assert (total, count) == (70, 7)
    conn.close()


def test_calc_sales_window_14_days():
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    conn = get_db()
    code = "YUSAS00001"

    _seed(conn, "2026-07-29", code, sales_qty=999)  # 대상일 — 제외돼야 함
    d = _dates_before("2026-07-29", 14)
    for date in d:
        _seed(conn, date, code, sales_qty=10)
    conn.commit()

    total, count = calc_sales_window(conn, code, "2026-07-29", 14)
    assert (total, count) == (140, 14)
    conn.close()


def _dates_before(date, n):
    from datetime import datetime, timedelta
    base = datetime.strptime(date, "%Y-%m-%d")
    return [(base - timedelta(days=i)).strftime("%Y-%m-%d") for i in range(1, n + 1)]


def test_calc_sales_window_returns_none_total_when_no_data():
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    conn = get_db()
    total, count = calc_sales_window(conn, "YUSAS00001", "2026-07-29", 7)
    assert (total, count) == (None, 0)
    conn.close()


def test_calc_weekday_average_sales_uses_3_week_lookback_when_enough_data():
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    conn = get_db()
    code = "YUSAS00001"

    # 2026-07-29(수)와 같은 요일 3주치
    for date, qty in [("2026-07-22", 10), ("2026-07-15", 12), ("2026-07-08", 8)]:
        _seed(conn, date, code, sales_qty=qty)
    conn.commit()

    avg = calc_weekday_average_sales(conn, code, "2026-07-29")
    assert avg == 10.0
    conn.close()


def test_calc_weekday_average_sales_ignores_excluded_rows():
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    conn = get_db()
    code = "YUSAS00001"

    for date, qty in [("2026-07-22", 10), ("2026-07-15", 10), ("2026-07-08", 10)]:
        _seed(conn, date, code, sales_qty=qty)
    _seed(conn, "2026-06-24", code, sales_qty=1000, excluded=1)  # 품절일 취급 — 제외돼야 함
    conn.commit()

    avg = calc_weekday_average_sales(conn, code, "2026-07-29")
    assert avg == 10.0
    conn.close()


def test_calc_weekday_average_sales_falls_back_to_14_day_average_when_under_3_weeks():
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    conn = get_db()
    code = "YUSAS00001"

    # 같은 요일(수) 데이터는 2주치뿐 — 폴백 조건(최소 3주 미달)
    _seed(conn, "2026-07-22", code, sales_qty=10)
    _seed(conn, "2026-07-15", code, sales_qty=20)
    # 14일 윈도 안의 다른 요일 데이터
    _seed(conn, "2026-07-20", code, sales_qty=5)
    _seed(conn, "2026-07-25", code, sales_qty=15)
    conn.commit()

    # 14일 윈도(2026-07-15 ~ 2026-07-28) 안의 값: 20, 5, 10, 15 => 합 50, 개수 4 => 평균 12.5
    avg = calc_weekday_average_sales(conn, code, "2026-07-29")
    assert avg == 12.5
    conn.close()


def test_calc_weekday_average_sales_returns_none_when_no_data_at_all():
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    conn = get_db()
    avg = calc_weekday_average_sales(conn, "YUSAS00001", "2026-07-29")
    assert avg is None
    conn.close()


from services.order_recommendation_calc import (
    calc_change_and_rate,
    calc_expected_sales_for_coverage,
    calc_expected_sales_today,
    calc_recommended_qty,
)


def test_expected_sales_today_none_when_all_values_none():
    assert calc_expected_sales_today(None, None, None, None, 0.35, 0.25, 0.25, 0.15) is None


def test_expected_sales_today_none_when_available_weights_sum_to_zero():
    # weekday_average_sales만 존재하지만 그 가중치가 0이라 재정규화 분모도 0
    assert calc_expected_sales_today(10, None, None, None, 0.0, 0.25, 0.25, 0.15) is None


def test_expected_sales_today_weighted_average_with_all_values_present():
    # 10*.35 + 20*.25 + 12*.25 + 11*.15 = 3.5+5.0+3.0+1.65 = 13.15
    result = calc_expected_sales_today(10, 20, 12, 11, 0.35, 0.25, 0.25, 0.15)
    assert result == pytest.approx(13.15)


def test_expected_sales_today_renormalizes_when_one_value_missing():
    # previous_day_sales_qty가 NULL -> 남은 가중치(.35+.25+.15=.75)로 재정규화
    # (10*.35 + 15*.25 + 17.5*.15) / .75 = 9.875 / .75
    result = calc_expected_sales_today(10, None, 15, 17.5, 0.35, 0.25, 0.25, 0.15)
    assert result == pytest.approx(9.875 / 0.75)


def test_expected_sales_today_equals_single_value_when_only_one_present():
    result = calc_expected_sales_today(10, None, None, None, 0.35, 0.25, 0.25, 0.15)
    assert result == pytest.approx(10.0)


def test_recommended_qty_none_when_expected_sales_missing():
    assert calc_recommended_qty(None, 0) is None


def test_recommended_qty_uses_ceil_not_round():
    # coverage_period_expected_sales=10.1 -> round()면 10, ceil()이면 11. 발주 부족 방지용 회귀 테스트.
    result = calc_recommended_qty(10.1, 0)
    assert result == 11


def test_recommended_qty_applies_safety_stock():
    # ceil(10+5)=15 — 재고/미송과는 무관한 순수 커버리지 수요치.
    result = calc_recommended_qty(10.0, 5)
    assert result == 15


def test_expected_sales_for_coverage_matches_single_day_when_coverage_is_one():
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    conn = get_db()
    code = "YUSAS00001"
    _seed_weekday_history(conn, code, [
        ("2026-07-22", 10), ("2026-07-15", 10), ("2026-07-08", 10), ("2026-07-01", 10),
    ])
    conn.commit()

    result = calc_expected_sales_for_coverage(
        conn, code, "2026-07-29", 1,
        previous_day_sales_qty=None, avg_sales_7d=None, avg_sales_14d=None,
        weight_weekday_average=1.0, weight_previous_day=0.25, weight_avg_7d=0.25, weight_avg_14d=0.15,
    )

    assert result == pytest.approx(10.0)
    conn.close()


def test_expected_sales_for_coverage_sums_each_days_own_weekday_average():
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    conn = get_db()
    code = "YUSAS00001"
    # date=2026-07-29(수)에 발주 -> 리드타임(1일) 때문에 실제로 커버되는 건
    # 2026-07-30(목)/2026-07-31(금)부터다. 각 요일평균 4주치.
    _seed_weekday_history(conn, code, [
        ("2026-07-23", 20), ("2026-07-16", 20), ("2026-07-09", 20), ("2026-07-02", 20),
    ])
    _seed_weekday_history(conn, code, [
        ("2026-07-24", 10), ("2026-07-17", 10), ("2026-07-10", 10), ("2026-07-03", 10),
    ])
    conn.commit()

    result = calc_expected_sales_for_coverage(
        conn, code, "2026-07-29", 2,
        previous_day_sales_qty=None, avg_sales_7d=None, avg_sales_14d=None,
        weight_weekday_average=1.0, weight_previous_day=0.25, weight_avg_7d=0.25, weight_avg_14d=0.15,
    )

    # 목요일 20.0 + 금요일 10.0 = 30.0 (다른 3개 신호는 전부 None이라 weekday만 남음)
    assert result == pytest.approx(30.0)
    conn.close()


def test_expected_sales_for_coverage_rounds_fractional_coverage_days():
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    conn = get_db()
    code = "YUSAS00001"
    _seed_weekday_history(conn, code, [
        ("2026-07-23", 20), ("2026-07-16", 20), ("2026-07-09", 20), ("2026-07-02", 20),
    ])
    _seed_weekday_history(conn, code, [
        ("2026-07-24", 10), ("2026-07-17", 10), ("2026-07-10", 10), ("2026-07-03", 10),
    ])
    conn.commit()

    # 1.6 -> round()=2일치로 취급 -> 목요일+금요일 = 30.0
    result = calc_expected_sales_for_coverage(
        conn, code, "2026-07-29", 1.6,
        previous_day_sales_qty=None, avg_sales_7d=None, avg_sales_14d=None,
        weight_weekday_average=1.0, weight_previous_day=0.25, weight_avg_7d=0.25, weight_avg_14d=0.15,
    )

    assert result == pytest.approx(30.0)
    conn.close()


def test_expected_sales_for_coverage_none_when_no_data_at_all():
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    conn = get_db()
    code = "YUSAS00001"

    result = calc_expected_sales_for_coverage(
        conn, code, "2026-07-29", 2,
        previous_day_sales_qty=None, avg_sales_7d=None, avg_sales_14d=None,
        weight_weekday_average=0.35, weight_previous_day=0.25, weight_avg_7d=0.25, weight_avg_14d=0.15,
    )

    assert result is None
    conn.close()


def test_change_and_rate_normal_increase():
    assert calc_change_and_rate(15, 10) == (5, 0.5)


def test_change_and_rate_allows_negative_change():
    assert calc_change_and_rate(5, 10) == (-5, -0.5)


def test_change_and_rate_none_when_today_missing():
    assert calc_change_and_rate(None, 10) == (None, None)


def test_change_and_rate_none_when_previous_missing():
    assert calc_change_and_rate(10, None) == (None, None)


def test_change_rate_none_when_previous_is_zero():
    change, rate = calc_change_and_rate(5, 0)
    assert change == 5
    assert rate is None


from services.order_recommendation_calc import _setting_weight


def test_setting_weight_uses_default_when_missing():
    assert _setting_weight(lambda key: None, "k", 0.35) == 0.35


def test_setting_weight_uses_default_when_not_a_number():
    assert _setting_weight(lambda key: "abc", "k", 0.35) == 0.35


def test_setting_weight_uses_default_when_negative():
    assert _setting_weight(lambda key: "-0.1", "k", 0.35) == 0.35


def test_setting_weight_uses_default_when_nan():
    assert _setting_weight(lambda key: "nan", "k", 0.35) == 0.35


def test_setting_weight_uses_default_when_infinite():
    assert _setting_weight(lambda key: "inf", "k", 0.35) == 0.35


def test_setting_weight_accepts_valid_positive_value():
    assert _setting_weight(lambda key: "0.6", "k", 0.35) == 0.6


def test_setting_weight_accepts_zero():
    assert _setting_weight(lambda key: "0", "k", 0.35) == 0.0


from services.order_recommendation_calc import coverage_days_for_expected_sales


def test_coverage_days_for_expected_sales_under_5_is_1_day():
    assert coverage_days_for_expected_sales(0) == 1.0
    assert coverage_days_for_expected_sales(4.9) == 1.0


def test_coverage_days_for_expected_sales_5_to_9_is_3_days():
    assert coverage_days_for_expected_sales(5) == 3.0
    assert coverage_days_for_expected_sales(9.9) == 3.0


def test_coverage_days_for_expected_sales_10_to_15_is_5_days():
    assert coverage_days_for_expected_sales(10) == 5.0
    assert coverage_days_for_expected_sales(15) == 5.0


def test_coverage_days_for_expected_sales_over_15_is_7_days():
    assert coverage_days_for_expected_sales(15.1) == 7.0
    assert coverage_days_for_expected_sales(100) == 7.0


def test_coverage_days_for_expected_sales_none_defaults_to_1_day():
    assert coverage_days_for_expected_sales(None) == 1.0


from services.order_recommendation_calc import default_confirmed_qty_for_row


def test_default_confirmed_qty_under_3_uses_lack_qty_only():
    # 재고/미송이 있어도(=0, 100) 무시하고 부족수량 그대로.
    assert default_confirmed_qty_for_row(2.9, 5, 4, 0, 100) == 4


def test_default_confirmed_qty_under_3_with_no_lack_qty_is_none():
    assert default_confirmed_qty_for_row(2.9, 5, None, 0, 0) is None


def test_default_confirmed_qty_at_least_3_uses_lack_plus_recommended_minus_stock_and_incoming():
    # 재고/미송이 0이면 부족수량 + 추천발주량 그대로: 10 + 13 = 23
    assert default_confirmed_qty_for_row(3.0, 13, 10, 0, 0) == 23


def test_default_confirmed_qty_at_least_3_none_when_any_input_missing():
    assert default_confirmed_qty_for_row(5, None, 10, 0, 0) is None
    assert default_confirmed_qty_for_row(5, 13, None, 0, 0) is None
    assert default_confirmed_qty_for_row(5, 13, 10, None, 0) is None
    assert default_confirmed_qty_for_row(5, 13, 10, 0, None) is None


def test_default_confirmed_qty_none_expected_sales_uses_at_least_3_formula():
    assert default_confirmed_qty_for_row(None, 13, 10, 0, 0) == 23


def test_default_confirmed_qty_incoming_surplus_offsets_lack_qty():
    # 회귀 테스트: 예상판매량 5.5, 커버리지 3일 -> 추천발주량(순수 수요) 15,
    # 부족수량 21, 미송 30. 총필요 36 - 총가용(재고0+미송30) = 6.
    assert default_confirmed_qty_for_row(5.5, 15, 21, 0, 30) == 6


def test_default_confirmed_qty_incoming_fully_covers_lack_and_recommended():
    # 미송이 총필요량보다 많으면 0으로 클램프(음수 아님).
    assert default_confirmed_qty_for_row(5.5, 15, 21, 0, 100) == 0


from services.order_recommendation_calc import compute_all, compute_row


def _seed_weekday_history(conn, code, dates_and_qty):
    for date, qty in dates_and_qty:
        _seed(conn, date, code, sales_qty=qty)


def _seed_full_pipeline_scenario(conn, code):
    """avg_sales_7d=12.0, avg_sales_14d=11.0, previous_day_sales_qty=20이 나오도록
    손으로 검증한 조합(이 셋은 date=2026-07-29 기준, 리드타임과 무관하게 고정).
    weekday_average_sales는 리드타임(1일) 때문에 다음날(2026-07-30, 목)의 3주치
    요일평균 — 14일 윈도 안에 이미 있는 07-23/07-16(각 10)에 07-09(10)만 추가하면
    10.0이 나온다."""
    # 요일평균용 4주치 수요일(2026-07-29 기준 -7/-14/-21/-28일) — 이제 weekday_average와
    # 무관하지만 avg_sales_7d/14d 윈도 값으로는 그대로 쓰인다.
    _seed_weekday_history(conn, code, [
        ("2026-07-22", 14), ("2026-07-15", 10), ("2026-07-08", 10), ("2026-07-01", 6),
    ])
    # 14일 윈도(07-15~07-28) 나머지 날짜들
    for date in ["2026-07-16", "2026-07-17", "2026-07-18", "2026-07-19", "2026-07-20", "2026-07-21"]:
        _seed(conn, date, code, sales_qty=10)
    for date in ["2026-07-23", "2026-07-24", "2026-07-25", "2026-07-26", "2026-07-27"]:
        _seed(conn, date, code, sales_qty=10)
    _seed(conn, "2026-07-28", code, sales_qty=20)  # 전날 — previous_day_sales_qty로 복사됨
    _seed(conn, "2026-07-09", code, sales_qty=10)  # 2026-07-30(목) 요일평균 3번째 관측치
    ensure_row(conn, "2026-07-29", code)


from services.order_recommendation_calc import calc_expected_sales_today_for_date


def test_calc_expected_sales_today_for_date_matches_known_scenario():
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    conn = get_db()
    code = "YUSAS00001"
    _seed_full_pipeline_scenario(conn, code)
    conn.commit()

    result = calc_expected_sales_today_for_date(conn, code, "2026-07-29", get_setting=lambda key: None)

    assert result["weekday_average_sales"] == pytest.approx(10.0)
    assert result["avg_sales_3d"] == pytest.approx(40 / 3)
    assert result["avg_sales_7d"] == pytest.approx(12.0)
    assert result["avg_sales_14d"] == pytest.approx(11.0)
    assert result["previous_day_sales_qty"] == 20
    assert result["expected_sales_today"] == pytest.approx(13.716666666666667)
    assert result["weight_weekday_average"] == pytest.approx(0.20)
    assert result["weight_avg_3d"] == pytest.approx(0.20)
    conn.close()


def test_calc_expected_sales_today_for_date_honors_zero_weight_override():
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    conn = get_db()
    code = "YUSAS00001"
    _seed_full_pipeline_scenario(conn, code)
    conn.commit()

    result = calc_expected_sales_today_for_date(
        conn, code, "2026-07-29", get_setting=lambda key: None,
        weight_overrides={"weight_avg_3d": 0.0},
    )

    # avg_3d(40/3) 신호가 weight 0으로 완전히 배제돼야 함 -> weight_sum = .20+.25+.20+.15 = .80
    # (10.0*.20 + 20*.25 + 12*.20 + 11*.15) / .80 = 13.8125
    # (buggy `override or default` 패턴이었다면 0.0이 falsy라 기본값 0.20으로 폴백해서
    #  13.716666666666667 — 원래 시나리오 값 — 이 나왔을 것)
    assert result["expected_sales_today"] == pytest.approx(13.8125)
    assert result["weight_avg_3d"] == 0.0
    conn.close()


def test_compute_row_full_pipeline_with_default_settings():
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    conn = get_db()
    code = "YUSAS00001"

    _seed_full_pipeline_scenario(conn, code)
    conn.execute(
        "UPDATE order_recommendation_daily SET stock_qty = 5, incoming_qty = 3 "
        "WHERE date = ? AND yusas_code = ?",
        ("2026-07-29", code),
    )
    conn.commit()

    compute_row(conn, code, "2026-07-29", get_setting=lambda key: None)

    row = get_row(conn, "2026-07-29", code)
    # 리드타임 때문에 다음날(2026-07-30,목) 3주 요일 이력 사용: (10+10+10)/3 = 10.0
    assert row["weekday_average_sales"] == pytest.approx(10.0)
    assert row["avg_sales_3d"] == pytest.approx(40 / 3)  # 07-26,07-27,07-28 = 10+10+20
    assert row["avg_sales_7d"] == pytest.approx(12.0)
    assert row["avg_sales_14d"] == pytest.approx(11.0)
    assert row["previous_day_sales_qty"] == 20
    # (10.0*.20 + 20*.25 + 12*.20 + 11*.15 + 40/3*.20) / 1.0
    assert row["expected_sales_today"] == pytest.approx(13.716666666666667)
    # expected_sales_today가 10~15 구간 -> 커버리지 자동 5일치 (coverage_days_for_expected_sales)
    assert row["coverage_days_used"] == pytest.approx(5.0)
    # recommended_qty는 재고/미송과 무관한 순수 커버리지 수요치(ceil(coverage_period_expected_sales))
    assert row["recommended_qty"] == 70
    assert row["model_version"] == "weighted_v1"
    assert row["model_weight_weekday"] == pytest.approx(0.20)
    assert row["model_weight_previous_day"] == pytest.approx(0.25)
    assert row["model_weight_avg_7d"] == pytest.approx(0.20)
    assert row["model_weight_avg_14d"] == pytest.approx(0.15)
    assert row["model_weight_avg_3d"] == pytest.approx(0.20)
    conn.close()


def test_compute_row_respects_custom_weight_and_recommendation_settings():
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    conn = get_db()
    code = "YUSAS00001"

    _seed_full_pipeline_scenario(conn, code)
    conn.execute(
        "UPDATE order_recommendation_daily SET stock_qty = 5, incoming_qty = 3 "
        "WHERE date = ? AND yusas_code = ?",
        ("2026-07-29", code),
    )
    conn.commit()

    settings = {
        "order_recommendation_weight_weekday_average": "0.5",
        "order_recommendation_weight_previous_day": "0.5",
        "order_recommendation_weight_avg_7d": "0",
        "order_recommendation_weight_avg_14d": "0",
        "order_recommendation_weight_avg_3d": "0",
        "order_recommendation_safety_stock_qty": "1",
    }
    compute_row(conn, code, "2026-07-29", get_setting=lambda key: settings.get(key))

    row = get_row(conn, "2026-07-29", code)
    # 요일평균(리드타임 반영, 다음날 목요일 3주)=10.0, (10*.5 + 20*.5) / (.5+.5) = 15.0
    assert row["expected_sales_today"] == pytest.approx(15.0)
    # 10~15 구간(경계값 15 포함) -> 커버리지 자동 5일치
    assert row["coverage_days_used"] == pytest.approx(5.0)
    assert row["recommended_qty"] == 79
    assert row["model_version"] == "weighted_v1"
    assert row["model_weight_weekday"] == pytest.approx(0.5)
    assert row["model_weight_previous_day"] == pytest.approx(0.5)
    assert row["model_weight_avg_7d"] == pytest.approx(0.0)
    assert row["model_weight_avg_14d"] == pytest.approx(0.0)
    assert row["model_weight_avg_3d"] == pytest.approx(0.0)
    conn.close()


def test_compute_row_sums_multi_day_coverage_using_each_days_own_weekday_average():
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    conn = get_db()
    code = "YUSAS00001"

    # date=2026-07-29(수) 계산, 리드타임 때문에 실제 커버는 2026-07-30(목)부터.
    # 목요일 요일평균 20, 금요일 요일평균 10 — 각각 4주치 깔끔하게 준비.
    _seed_weekday_history(conn, code, [
        ("2026-07-23", 20), ("2026-07-16", 20), ("2026-07-09", 20), ("2026-07-02", 20),
    ])
    _seed_weekday_history(conn, code, [
        ("2026-07-24", 10), ("2026-07-17", 10), ("2026-07-10", 10), ("2026-07-03", 10),
    ])
    ensure_row(conn, "2026-07-29", code)
    conn.execute(
        "UPDATE order_recommendation_daily SET stock_qty = 5, incoming_qty = 3 "
        "WHERE date = ? AND yusas_code = ?",
        ("2026-07-29", code),
    )
    conn.commit()

    settings = {
        "order_recommendation_weight_weekday_average": "1",
        "order_recommendation_weight_previous_day": "0",
        "order_recommendation_weight_avg_7d": "0",
        "order_recommendation_weight_avg_14d": "0",
        "order_recommendation_safety_stock_qty": "0",
    }
    compute_row(conn, code, "2026-07-29", get_setting=lambda key: settings.get(key))

    row = get_row(conn, "2026-07-29", code)
    # expected_sales_today는 D+1(목, 리드타임 반영) 하루치 예측만 저장 -> 20.0 (정확도 평가용, 커버리지 합산과는 별개)
    assert row["expected_sales_today"] == pytest.approx(20.0)
    # 15개 초과 구간 -> 커버리지 자동 7일치 (D+1~D+7, 요일마다 각자 요일평균 재계산해서 합산)
    assert row["coverage_days_used"] == pytest.approx(7.0)
    assert row["recommended_qty"] == 105
    conn.close()


def test_compute_row_confirmed_qty_null_when_stock_missing():
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    conn = get_db()
    code = "YUSAS00001"
    _seed_weekday_history(conn, code, [
        ("2026-07-22", 10), ("2026-07-15", 10), ("2026-07-08", 10), ("2026-07-01", 10),
    ])
    ensure_row(conn, "2026-07-29", code)  # stock_qty/incoming_qty 둘 다 NULL, previous_day도 없음
    conn.commit()

    compute_row(conn, code, "2026-07-29", get_setting=lambda key: None)

    row = get_row(conn, "2026-07-29", code)
    # weekday=10.0, avg_sales_7d=10.0(07-22만 윈도 안), avg_sales_14d=10.0(07-15,07-22),
    # previous_day_sales_qty=None -> 남은 가중치(.35+.25+.15=.75)로 재정규화해도 전부 10 -> 10.0
    assert row["expected_sales_today"] == pytest.approx(10.0)
    # recommended_qty는 재고/미송과 무관해서 stock_qty가 없어도 계산된다.
    assert row["recommended_qty"] is not None
    # confirmed_qty는 재고/미송이 있어야 계산되므로 stock_qty가 NULL이면 None.
    assert row["confirmed_qty"] is None
    conn.close()


def test_compute_row_does_nothing_when_row_missing():
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    conn = get_db()
    compute_row(conn, "YUSAS_NOT_SEEDED", "2026-07-29", get_setting=lambda key: None)
    assert get_row(conn, "2026-07-29", "YUSAS_NOT_SEEDED") is None
    conn.close()


def test_compute_all_processes_every_code_for_the_date():
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    conn = get_db()
    ensure_row(conn, "2026-07-29", "YUSAS00001")
    ensure_row(conn, "2026-07-29", "YUSAS00002")
    conn.commit()
    conn.close()

    count = compute_all(get_db, "2026-07-29", get_setting=lambda key: None)
    assert count == 2


def test_compute_row_is_order_independent():
    """D+1을 계산하기 전에 D를 먼저 compute_row 했는지 여부와 무관하게, D+1의
    결과는 항상 같아야 한다. 새 공식은 전날 weekday_average_sales 캐시가 아니라
    전날 행의 원본 sales_qty만 읽으므로(previous_day_sales_qty), D의 sales_qty만
    있으면 D의 compute_row 실행 여부는 D+1 결과에 영향을 주면 안 된다."""
    code = "YUSAS00001"

    def _seed_order_independence_data(conn):
        # D+1(2026-07-30,목)의 compute_row는 리드타임 때문에 D+2(2026-07-31,금)의 요일
        # 이력을 쓴다 — 그 이력만 준비하고 D/D+1 자신의 요일 이력은 준비하지 않는다.
        _seed_weekday_history(conn, code, [
            ("2026-07-24", 6), ("2026-07-17", 6), ("2026-07-10", 6), ("2026-07-03", 6),
        ])
        _seed(conn, "2026-07-29", code, sales_qty=12)  # D의 원본 판매량만
        ensure_row(conn, "2026-07-30", code)
        conn.execute(
            "UPDATE order_recommendation_daily SET stock_qty = 1, incoming_qty = 0 "
            "WHERE date = ? AND yusas_code = ?",
            ("2026-07-30", code),
        )
        conn.commit()

    # Run A: D를 먼저 compute_row 한 뒤 D+1 compute_row
    get_db_a, _keep_alive_a = _make_db_factory()
    init_order_recommendation_tables(get_db_a)
    conn_a = get_db_a()
    _seed_order_independence_data(conn_a)
    compute_row(conn_a, code, "2026-07-29", get_setting=lambda key: None)
    compute_row(conn_a, code, "2026-07-30", get_setting=lambda key: None)
    row_a = get_row(conn_a, "2026-07-30", code)

    # Run B: D는 compute_row 하지 않고 D+1만 바로 compute_row
    get_db_b, _keep_alive_b = _make_db_factory()
    init_order_recommendation_tables(get_db_b)
    conn_b = get_db_b()
    _seed_order_independence_data(conn_b)
    compute_row(conn_b, code, "2026-07-30", get_setting=lambda key: None)
    row_b = get_row(conn_b, "2026-07-30", code)

    assert row_a["expected_sales_today"] == row_b["expected_sales_today"] == pytest.approx(9.6)
    # 5~9 구간 -> 커버리지 자동 3일치
    assert row_a["coverage_days_used"] == row_b["coverage_days_used"] == pytest.approx(3.0)
    assert row_a["recommended_qty"] == row_b["recommended_qty"] == 30
    conn_a.close()
    conn_b.close()


def test_compute_row_computes_incoming_qty_change():
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    conn = get_db()
    code = "YUSAS00001"

    ensure_row(conn, "2026-07-28", code)
    conn.execute(
        "UPDATE order_recommendation_daily SET incoming_qty = 10 WHERE date = ? AND yusas_code = ?",
        ("2026-07-28", code),
    )
    ensure_row(conn, "2026-07-29", code)
    conn.execute(
        "UPDATE order_recommendation_daily SET incoming_qty = 15 WHERE date = ? AND yusas_code = ?",
        ("2026-07-29", code),
    )
    conn.commit()

    compute_row(conn, code, "2026-07-29", get_setting=lambda key: None)

    row = get_row(conn, "2026-07-29", code)
    assert row["incoming_qty_change"] == 5
    assert row["incoming_qty_change_rate"] == pytest.approx(0.5)
    conn.close()


def test_compute_row_forces_zero_recommended_and_confirms_lack_qty_when_expected_sales_under_3():
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    conn = get_db()
    code = "YUSAS00001"

    _seed(conn, "2026-07-28", code, sales_qty=2)  # 전날값만 있음 -> expected_sales_today = 2 (3 미만)
    ensure_row(conn, "2026-07-29", code)
    conn.execute(
        "UPDATE order_recommendation_daily SET stock_qty = 0, incoming_qty = 5, ezadmin_lack_qty = 4 "
        "WHERE date = ? AND yusas_code = ?",
        ("2026-07-29", code),
    )
    conn.commit()

    compute_row(conn, code, "2026-07-29", get_setting=lambda key: None)

    row = get_row(conn, "2026-07-29", code)
    assert row["expected_sales_today"] == pytest.approx(2.0)
    assert row["recommended_qty"] == 0  # 예상판매량 3 미만이라 강제로 0
    assert row["confirmed_qty"] == 4  # 부족수량 그대로 (미송 5는 무시)
    conn.close()


def test_compute_row_confirmed_qty_none_when_expected_sales_under_3_and_lack_qty_missing():
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    conn = get_db()
    code = "YUSAS00001"

    _seed(conn, "2026-07-28", code, sales_qty=2)
    ensure_row(conn, "2026-07-29", code)
    conn.execute(
        "UPDATE order_recommendation_daily SET stock_qty = 0, incoming_qty = 5 "
        "WHERE date = ? AND yusas_code = ?",
        ("2026-07-29", code),
    )
    conn.commit()

    compute_row(conn, code, "2026-07-29", get_setting=lambda key: None)

    row = get_row(conn, "2026-07-29", code)
    assert row["recommended_qty"] == 0
    assert row["confirmed_qty"] is None  # ezadmin_lack_qty가 없어서 채우지 않음
    conn.close()


def test_compute_row_default_confirmed_qty_at_least_3_uses_lack_plus_recommended():
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    conn = get_db()
    code = "YUSAS00001"

    _seed(conn, "2026-07-28", code, sales_qty=5)  # 전날값만 있음 -> expected_sales_today = 5 (3 이상)
    ensure_row(conn, "2026-07-29", code)
    conn.execute(
        "UPDATE order_recommendation_daily SET stock_qty = 0, incoming_qty = 2, ezadmin_lack_qty = 10 "
        "WHERE date = ? AND yusas_code = ?",
        ("2026-07-29", code),
    )
    conn.commit()

    compute_row(conn, code, "2026-07-29", get_setting=lambda key: None)

    row = get_row(conn, "2026-07-29", code)
    assert row["expected_sales_today"] == pytest.approx(5.0)
    assert row["recommended_qty"] is not None
    # recommended_qty는 재고/미송과 무관한 순수 커버리지 수요치.
    # 확정수량 = (부족수량 + 추천발주량) - 재고(0) - 미송(2)
    assert row["confirmed_qty"] == max(0, (10 + row["recommended_qty"]) - 0 - 2)
    conn.close()
