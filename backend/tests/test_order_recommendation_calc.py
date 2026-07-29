import sqlite3
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.order_recommendation_calc import (
    calc_sales_window,
    calc_weekday_average_sales,
)
from services.order_recommendation_store import ensure_row, init_order_recommendation_tables


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


def test_calc_weekday_average_sales_uses_8_week_lookback_when_enough_data():
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    conn = get_db()
    code = "YUSAS00001"

    # 2026-07-29(수)와 같은 요일 4주치
    for date, qty in [("2026-07-22", 10), ("2026-07-15", 12), ("2026-07-08", 8), ("2026-07-01", 10)]:
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

    for date, qty in [("2026-07-22", 10), ("2026-07-15", 10), ("2026-07-08", 10), ("2026-07-01", 10)]:
        _seed(conn, date, code, sales_qty=qty)
    _seed(conn, "2026-06-24", code, sales_qty=1000, excluded=1)  # 품절일 취급 — 제외돼야 함
    conn.commit()

    avg = calc_weekday_average_sales(conn, code, "2026-07-29")
    assert avg == 10.0
    conn.close()


def test_calc_weekday_average_sales_falls_back_to_14_day_average_when_under_4_weeks():
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    conn = get_db()
    code = "YUSAS00001"

    # 같은 요일(수) 데이터는 3주치뿐 — 폴백 조건
    _seed(conn, "2026-07-22", code, sales_qty=10)
    _seed(conn, "2026-07-15", code, sales_qty=20)
    _seed(conn, "2026-07-08", code, sales_qty=999)  # 14일 윈도(07-15~07-28) 밖 — 폴백엔 안 들어감
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


from services.order_recommendation_calc import calc_previous_day_sales_ratio


def test_ratio_defaults_to_1_when_no_previous_row():
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    conn = get_db()
    ratio = calc_previous_day_sales_ratio(conn, "YUSAS00001", "2026-07-29", 50)
    assert ratio == 1.0
    conn.close()


def test_ratio_reuses_cached_weekday_average_when_present():
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    conn = get_db()
    code = "YUSAS00001"
    ensure_row(conn, "2026-07-28", code)
    conn.execute(
        "UPDATE order_recommendation_daily SET weekday_average_sales = 20 WHERE date = ? AND yusas_code = ?",
        ("2026-07-28", code),
    )
    conn.commit()

    ratio = calc_previous_day_sales_ratio(conn, code, "2026-07-29", 30)
    assert ratio == 1.5
    conn.close()


def test_ratio_computes_on_the_fly_when_cache_missing_and_clamps_upper_bound():
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    conn = get_db()
    code = "YUSAS00001"

    # 전날(2026-07-28, 화요일) 캐시는 비어있지만, 즉석 계산에 쓸 과거 화요일 4주치는 있다
    for date in ["2026-07-21", "2026-07-14", "2026-07-07", "2026-06-30"]:
        _seed(conn, date, code, sales_qty=8)
    ensure_row(conn, "2026-07-28", code)  # weekday_average_sales는 NULL인 채로 둠
    conn.commit()

    # 전날 실제 판매 16, 즉석 계산 요일평균 8 => 원래 비율 2.0(상한 경계)
    ratio = calc_previous_day_sales_ratio(conn, code, "2026-07-29", 16)
    assert ratio == 2.0
    conn.close()


def test_ratio_defaults_to_1_when_previous_day_sales_qty_is_none():
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    conn = get_db()
    code = "YUSAS00001"
    ensure_row(conn, "2026-07-28", code)
    conn.execute(
        "UPDATE order_recommendation_daily SET weekday_average_sales = 20 WHERE date = ? AND yusas_code = ?",
        ("2026-07-28", code),
    )
    conn.commit()

    ratio = calc_previous_day_sales_ratio(conn, code, "2026-07-29", None)
    assert ratio == 1.0
    conn.close()


def test_ratio_clamped_to_lower_bound():
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    conn = get_db()
    code = "YUSAS00001"
    ensure_row(conn, "2026-07-28", code)
    conn.execute(
        "UPDATE order_recommendation_daily SET weekday_average_sales = 100 WHERE date = ? AND yusas_code = ?",
        ("2026-07-28", code),
    )
    conn.commit()

    ratio = calc_previous_day_sales_ratio(conn, code, "2026-07-29", 10)
    assert ratio == 0.5
    conn.close()
