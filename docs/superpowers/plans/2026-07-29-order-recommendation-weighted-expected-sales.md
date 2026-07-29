# 추천발주: expected_sales_today 가중평균 공식 교체 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 이미 병합된 `expected_sales_today` 계산(요일평균×전날흐름계수)을,
요일평균(35%)·전날 주문량(25%)·직전 7일평균(25%)·직전 14일평균(15%)의 가중평균
+ NULL 재정규화 방식으로 교체한다. `recommended_qty` 공식은 그대로 유지.

**Architecture:** `order_recommendation_daily`에서 `previous_day_sales_ratio`
컬럼을 신규 테이블 생성 시 제거하고 `avg_sales_14d` 컬럼을 추가한다(기존 DB는
`_ensure_avg_sales_14d_column`으로 ALTER). `calc_previous_day_sales_ratio`와
관련 상수를 삭제하고, `calc_expected_sales_today`를 4-지표 가중평균 함수로
교체한다. 가중치는 `app_settings` 4개 키로 조정 가능하며, 음수/비숫자/NaN/무한대
값은 `_setting_weight`가 기본값으로 대체한다.

**Tech Stack:** FastAPI + SQLite(공유 DB), pytest.

## Global Constraints

- `recommended_qty` 계산식(ceil, 재고·입고예정 차감)은 절대 변경하지 않는다.
- 4개 지표 중 존재하는 값만으로 가중치를 재정규화하고, 존재하는 값의 가중치
  합이 0이면(전부 NULL이거나 존재하는 값의 가중치가 전부 0) `expected_sales_today
  = None`.
- 가중치 설정값은 음수/비숫자/NaN/무한대를 거부하고 해당 항목 기본값으로
  대체한다.
- `previous_day_sales_ratio` 컬럼은 신규 `CREATE TABLE`에서만 제거 — 기존 로컬
  DB에 이미 있는 컬럼은 DROP하지 않고 방치한다(이 저장소는 컬럼 ADD만
  마이그레이션하는 컨벤션).
- `avg_sales_14d` 컬럼 추가는 `init_order_recommendation_tables`가 이미 열어둔
  연결을 그대로 써서 `CREATE TABLE`과 같은 트랜잭션에서 처리한다.
- `previous_date`, `get_row`는 삭제하지 않는다(전날 판매량 복사, 광고/찜/장바구니
  전일값 조회에 계속 필요).
- `order_recommendation_blend_ratio` 설정값 자체는 삭제하지 않되, 새 계산
  코드에서는 더 이상 읽지 않는다.

참고 스펙: `docs/superpowers/specs/2026-07-29-order-recommendation-weighted-expected-sales-design.md`

---

### Task 1: DB 스키마 — `previous_day_sales_ratio` 제거, `avg_sales_14d` 추가

**Files:**
- Modify: `backend/services/order_recommendation_store.py`
- Modify: `backend/tests/test_order_recommendation_store.py`

**Interfaces:**
- Consumes: 없음 (스키마/초기화 계층, 다른 함수에 의존하지 않음).
- Produces: `init_order_recommendation_tables(get_db) -> None` (시그니처 변경
  없음, 내부 스키마만 변경). 신규 `_ensure_avg_sales_14d_column(conn) -> None`
  (private, `init_order_recommendation_tables` 내부에서만 호출).

- [ ] **Step 1: 실패하는 테스트로 수정**

`backend/tests/test_order_recommendation_store.py`의 `EXPECTED_COLUMNS`
집합을 다음으로 교체(`previous_day_sales_ratio` 제거, `avg_sales_14d` 추가):

```python
EXPECTED_COLUMNS = {
    "date", "yusas_code", "day_of_week",
    "sales_qty", "stock_qty", "incoming_qty", "previous_day_sales_qty",
    "ad_budget", "wish_count", "cart_count",
    "ad_budget_change", "ad_budget_change_rate",
    "wish_count_change", "wish_count_change_rate",
    "cart_count_change", "cart_count_change_rate",
    "sales_7d", "sales_14d", "avg_sales_7d", "avg_sales_14d",
    "weekday_average_sales", "expected_sales_today",
    "recommended_qty",
    "confirmed_qty", "override_reason", "updated_by", "updated_at",
    "excluded_from_avg", "created_at",
}
```

파일 끝에 테스트 2개 추가:

```python
def test_init_adds_avg_sales_14d_column_to_legacy_table_missing_it():
    get_db, _keep_alive = _make_db_factory()
    conn = get_db()
    conn.execute(
        """
        CREATE TABLE order_recommendation_daily (
            date TEXT NOT NULL,
            yusas_code TEXT NOT NULL,
            sales_qty INTEGER,
            created_at TEXT NOT NULL,
            PRIMARY KEY (date, yusas_code)
        )
        """
    )
    conn.commit()
    conn.close()

    init_order_recommendation_tables(get_db)

    conn = get_db()
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(order_recommendation_daily)").fetchall()}
    assert "avg_sales_14d" in cols
    conn.close()


def test_init_is_idempotent_when_avg_sales_14d_already_present():
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    init_order_recommendation_tables(get_db)  # 두 번째 호출도 에러 없이 통과해야 함

    conn = get_db()
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(order_recommendation_daily)").fetchall()}
    assert "avg_sales_14d" in cols
    conn.close()
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && python -m pytest tests/test_order_recommendation_store.py -v`
Expected: FAIL — `test_init_creates_table_with_expected_columns`는 현재
스키마에 `previous_day_sales_ratio`가 남아있고 `avg_sales_14d`가 없어서
`EXPECTED_COLUMNS`와 불일치, 신규 테스트 2개는 `avg_sales_14d`가 없어서 실패.

- [ ] **Step 3: `backend/services/order_recommendation_store.py` 수정**

`init_order_recommendation_tables` 함수 전체를 다음으로 교체(`CREATE TABLE`
에서 `previous_day_sales_ratio REAL,` 라인 삭제, `avg_sales_7d REAL,` 바로
아래 `avg_sales_14d REAL,` 추가, `_ensure_avg_sales_14d_column` 신설 후 같은
연결·트랜잭션에서 호출):

```python
def init_order_recommendation_tables(get_db) -> None:
    conn = get_db()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS order_recommendation_daily (
            date TEXT NOT NULL,
            yusas_code TEXT NOT NULL,
            day_of_week INTEGER,

            sales_qty INTEGER,
            stock_qty INTEGER,
            incoming_qty INTEGER,
            previous_day_sales_qty INTEGER,
            ad_budget INTEGER,
            wish_count INTEGER,
            cart_count INTEGER,

            ad_budget_change INTEGER,
            ad_budget_change_rate REAL,
            wish_count_change INTEGER,
            wish_count_change_rate REAL,
            cart_count_change INTEGER,
            cart_count_change_rate REAL,

            sales_7d INTEGER,
            sales_14d INTEGER,
            avg_sales_7d REAL,
            avg_sales_14d REAL,
            weekday_average_sales REAL,
            expected_sales_today REAL,

            recommended_qty INTEGER,

            confirmed_qty INTEGER,
            override_reason TEXT,
            updated_by TEXT,
            updated_at TEXT,

            excluded_from_avg INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,

            PRIMARY KEY (date, yusas_code)
        )
        """
    )
    _ensure_avg_sales_14d_column(conn)
    conn.commit()
    conn.close()


def _ensure_avg_sales_14d_column(conn) -> None:
    cols = [r["name"] for r in conn.execute("PRAGMA table_info(order_recommendation_daily)").fetchall()]
    if "avg_sales_14d" not in cols:
        conn.execute("ALTER TABLE order_recommendation_daily ADD COLUMN avg_sales_14d REAL")
```

(`_ensure_avg_sales_14d_column`은 `init_order_recommendation_tables` 바로
위/아래 어디에 둬도 무방 — 위 코드는 `init_order_recommendation_tables` 다음에
배치했다.)

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && python -m pytest tests/test_order_recommendation_store.py -v`
Expected: PASS (9개 테스트 전부 — 기존 7개 + 신규 2개)

- [ ] **Step 5: 커밋**

```bash
git add backend/services/order_recommendation_store.py backend/tests/test_order_recommendation_store.py
git commit -m "feat: replace previous_day_sales_ratio column with avg_sales_14d"
```

---

### Task 2: `expected_sales_today`를 가중평균 공식으로 교체

**Files:**
- Modify: `backend/services/order_recommendation_calc.py`
- Modify: `backend/tests/test_order_recommendation_calc.py`

**Interfaces:**
- Consumes: Task 1의 스키마(`avg_sales_14d` 컬럼 존재, `previous_day_sales_ratio`
  컬럼 없음).
- Produces:
  - `calc_expected_sales_today(weekday_average_sales, previous_day_sales_qty,
    avg_sales_7d, avg_sales_14d, weight_weekday_average, weight_previous_day,
    weight_avg_7d, weight_avg_14d) -> float | None` (시그니처 완전 교체).
  - `_setting_weight(get_setting, key: str, default: float) -> float`
    (private, 음수/비숫자/NaN/무한대 거부).
  - `DEFAULT_WEIGHT_WEEKDAY_AVERAGE = 0.35`, `DEFAULT_WEIGHT_PREVIOUS_DAY = 0.25`,
    `DEFAULT_WEIGHT_AVG_7D = 0.25`, `DEFAULT_WEIGHT_AVG_14D = 0.15`.
  - `calc_previous_day_sales_ratio`, `RATIO_MIN`, `RATIO_MAX`,
    `DEFAULT_BLEND_RATIO` — 전부 삭제.
  - `compute_row`/`compute_all` 시그니처는 그대로(`compute_row(conn, yusas_code,
    date, get_setting)`, `compute_all(get_db, date, get_setting) -> int`).

- [ ] **Step 1: 테스트 파일 전체를 새 공식 기준으로 교체**

`backend/tests/test_order_recommendation_calc.py`의 **147~465번째 줄
전체**(`from services.order_recommendation_calc import
calc_previous_day_sales_ratio`부터 파일 끝까지 — ratio 테스트 5개,
`calc_expected_sales_today` 구 시그니처 테스트 2개, `compute_row` 통합
테스트들 포함)를 아래 내용으로 통째로 교체한다. 앞쪽 1~145번째 줄
(`calc_sales_window`/`calc_weekday_average_sales` 테스트, `_seed`/
`_make_db_factory`/`_dates_before` 헬퍼)은 그대로 둔다.

파일 맨 위 import 블록에 `import pytest`를 추가한다(부동소수점 비교용):

```python
import pytest
import sqlite3
import sys
import uuid
from pathlib import Path
```

147번째 줄부터는 다음으로 교체:

```python
from services.order_recommendation_calc import (
    calc_change_and_rate,
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
    assert calc_recommended_qty(None, 0, 0, 1, 0) is None


def test_recommended_qty_none_when_stock_missing():
    assert calc_recommended_qty(10.0, None, 0, 1, 0) is None


def test_recommended_qty_none_when_incoming_missing():
    assert calc_recommended_qty(10.0, 0, None, 1, 0) is None


def test_recommended_qty_uses_ceil_not_round():
    # target_sales=10.1 -> round()면 10, ceil()이면 11. 발주 부족 방지용 회귀 테스트.
    result = calc_recommended_qty(10.1, 0, 0, 1, 0)
    assert result == 11


def test_recommended_qty_never_negative():
    result = calc_recommended_qty(5.0, 100, 50, 1, 0)
    assert result == 0


def test_recommended_qty_applies_coverage_days_and_safety_stock():
    # target_sales = 10 * 3 = 30, ceil(30+5)=35, 35-2-1=32
    result = calc_recommended_qty(10.0, 2, 1, 3, 5)
    assert result == 32


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


from services.order_recommendation_calc import compute_all, compute_row


def _seed_weekday_history(conn, code, dates_and_qty):
    for date, qty in dates_and_qty:
        _seed(conn, date, code, sales_qty=qty)


def _seed_full_pipeline_scenario(conn, code):
    """weekday_average_sales=10.0, avg_sales_7d=12.0, avg_sales_14d=11.0,
    previous_day_sales_qty=20 이 나오도록 손으로 검증한 조합."""
    # 요일평균용 4주치 수요일(2026-07-29 기준 -7/-14/-21/-28일)
    _seed_weekday_history(conn, code, [
        ("2026-07-22", 14), ("2026-07-15", 10), ("2026-07-08", 10), ("2026-07-01", 6),
    ])
    # 14일 윈도(07-15~07-28) 나머지 날짜들
    for date in ["2026-07-16", "2026-07-17", "2026-07-18", "2026-07-19", "2026-07-20", "2026-07-21"]:
        _seed(conn, date, code, sales_qty=10)
    for date in ["2026-07-23", "2026-07-24", "2026-07-25", "2026-07-26", "2026-07-27"]:
        _seed(conn, date, code, sales_qty=10)
    _seed(conn, "2026-07-28", code, sales_qty=20)  # 전날 — previous_day_sales_qty로 복사됨
    ensure_row(conn, "2026-07-29", code)


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
    assert row["weekday_average_sales"] == pytest.approx(10.0)
    assert row["avg_sales_7d"] == pytest.approx(12.0)
    assert row["avg_sales_14d"] == pytest.approx(11.0)
    assert row["previous_day_sales_qty"] == 20
    assert row["expected_sales_today"] == pytest.approx(13.15)
    assert row["recommended_qty"] == 6  # ceil(13.15)-5-3
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
        "order_recommendation_coverage_days": "2",
        "order_recommendation_safety_stock_qty": "1",
    }
    compute_row(conn, code, "2026-07-29", get_setting=lambda key: settings.get(key))

    row = get_row(conn, "2026-07-29", code)
    # (10*.5 + 20*.5) / (.5+.5) = 15.0
    assert row["expected_sales_today"] == pytest.approx(15.0)
    # target=15*2=30, ceil(30+1)=31, 31-5-3=23
    assert row["recommended_qty"] == 23
    conn.close()


def test_compute_row_recommended_qty_null_when_stock_missing():
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
    assert row["recommended_qty"] is None
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
        # D+1(2026-07-30, 목) 요일 이력만 준비 — D 자신의 요일 이력은 준비하지 않는다
        _seed_weekday_history(conn, code, [
            ("2026-07-23", 6), ("2026-07-16", 6), ("2026-07-09", 6), ("2026-07-02", 6),
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

    assert row_a["expected_sales_today"] == row_b["expected_sales_today"] == pytest.approx(8.549999999999999)
    assert row_a["recommended_qty"] == row_b["recommended_qty"] == 8
    conn_a.close()
    conn_b.close()
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && python -m pytest tests/test_order_recommendation_calc.py -v`
Expected: FAIL — `calc_previous_day_sales_ratio`/`_setting_weight` import 에러,
`calc_expected_sales_today` 시그니처 불일치 등 다수 실패.

- [ ] **Step 3: `backend/services/order_recommendation_calc.py` 전체 교체**

파일 전체를 다음으로 교체:

```python
from __future__ import annotations

import math
from datetime import datetime, timedelta

from services.order_recommendation_store import get_row, previous_date

WEEKDAY_LOOKBACK_WEEKS = 8
WEEKDAY_MIN_WEEKS = 4
FALLBACK_WINDOW_DAYS = 14


def _date_minus(date: str, days: int) -> str:
    return (datetime.strptime(date, "%Y-%m-%d") - timedelta(days=days)).strftime("%Y-%m-%d")


def calc_sales_window(conn, yusas_code: str, date: str, days: int):
    start = _date_minus(date, days)
    rows = conn.execute(
        """
        SELECT sales_qty FROM order_recommendation_daily
        WHERE yusas_code = ? AND date >= ? AND date < ? AND sales_qty IS NOT NULL
        """,
        (yusas_code, start, date),
    ).fetchall()
    values = [r["sales_qty"] for r in rows]
    if not values:
        return None, 0
    return sum(values), len(values)


def calc_weekday_average_sales(conn, yusas_code: str, as_of_date: str):
    candidates = []
    for week in range(1, WEEKDAY_LOOKBACK_WEEKS + 1):
        candidate_date = _date_minus(as_of_date, week * 7)
        row = conn.execute(
            """
            SELECT sales_qty FROM order_recommendation_daily
            WHERE yusas_code = ? AND date = ? AND excluded_from_avg = 0 AND sales_qty IS NOT NULL
            """,
            (yusas_code, candidate_date),
        ).fetchone()
        if row is not None:
            candidates.append(row["sales_qty"])

    if len(candidates) >= WEEKDAY_MIN_WEEKS:
        return sum(candidates) / len(candidates)

    start = _date_minus(as_of_date, FALLBACK_WINDOW_DAYS)
    rows = conn.execute(
        """
        SELECT sales_qty FROM order_recommendation_daily
        WHERE yusas_code = ? AND date >= ? AND date < ? AND excluded_from_avg = 0 AND sales_qty IS NOT NULL
        """,
        (yusas_code, start, as_of_date),
    ).fetchall()
    values = [r["sales_qty"] for r in rows]
    if not values:
        return None
    return sum(values) / len(values)


DEFAULT_WEIGHT_WEEKDAY_AVERAGE = 0.35
DEFAULT_WEIGHT_PREVIOUS_DAY = 0.25
DEFAULT_WEIGHT_AVG_7D = 0.25
DEFAULT_WEIGHT_AVG_14D = 0.15


def calc_expected_sales_today(
    weekday_average_sales,
    previous_day_sales_qty,
    avg_sales_7d,
    avg_sales_14d,
    weight_weekday_average: float,
    weight_previous_day: float,
    weight_avg_7d: float,
    weight_avg_14d: float,
):
    weighted_sum = 0.0
    weight_sum = 0.0
    for value, weight in (
        (weekday_average_sales, weight_weekday_average),
        (previous_day_sales_qty, weight_previous_day),
        (avg_sales_7d, weight_avg_7d),
        (avg_sales_14d, weight_avg_14d),
    ):
        if value is not None:
            weighted_sum += value * weight
            weight_sum += weight
    if weight_sum == 0:
        return None
    return weighted_sum / weight_sum


def calc_recommended_qty(expected_sales_today, stock_qty, incoming_qty, coverage_days: float, safety_stock_qty: float):
    if expected_sales_today is None or stock_qty is None or incoming_qty is None:
        return None
    target_sales = expected_sales_today * coverage_days
    return max(0, math.ceil(target_sales + safety_stock_qty) - stock_qty - incoming_qty)


def calc_change_and_rate(today_value, previous_value):
    if today_value is None or previous_value is None:
        return None, None
    change = today_value - previous_value
    if previous_value == 0:
        return change, None
    return change, change / previous_value


DEFAULT_COVERAGE_DAYS = 1.0
DEFAULT_SAFETY_STOCK_QTY = 0.0


def _setting_float(get_setting, key: str, default: float) -> float:
    raw = get_setting(key)
    if raw is None or str(raw).strip() == "":
        return default
    return float(raw)


def _setting_weight(get_setting, key: str, default: float) -> float:
    raw = get_setting(key)
    if raw is None or str(raw).strip() == "":
        return default
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return default
    if not math.isfinite(value) or value < 0:
        return default
    return value


def compute_row(conn, yusas_code: str, date: str, get_setting) -> None:
    row = get_row(conn, date, yusas_code)
    if row is None:
        return

    prev_date_str = previous_date(date)
    prev_row = get_row(conn, prev_date_str, yusas_code)
    previous_day_sales_qty = prev_row["sales_qty"] if prev_row is not None else None

    sales_7d, count_7d = calc_sales_window(conn, yusas_code, date, 7)
    sales_14d, count_14d = calc_sales_window(conn, yusas_code, date, 14)
    avg_sales_7d = (sales_7d / count_7d) if sales_7d is not None and count_7d else None
    avg_sales_14d = (sales_14d / count_14d) if sales_14d is not None and count_14d else None

    weekday_average_sales = calc_weekday_average_sales(conn, yusas_code, date)

    weight_weekday_average = _setting_weight(
        get_setting, "order_recommendation_weight_weekday_average", DEFAULT_WEIGHT_WEEKDAY_AVERAGE
    )
    weight_previous_day = _setting_weight(
        get_setting, "order_recommendation_weight_previous_day", DEFAULT_WEIGHT_PREVIOUS_DAY
    )
    weight_avg_7d = _setting_weight(get_setting, "order_recommendation_weight_avg_7d", DEFAULT_WEIGHT_AVG_7D)
    weight_avg_14d = _setting_weight(get_setting, "order_recommendation_weight_avg_14d", DEFAULT_WEIGHT_AVG_14D)

    coverage_days = _setting_float(get_setting, "order_recommendation_coverage_days", DEFAULT_COVERAGE_DAYS)
    safety_stock_qty = _setting_float(get_setting, "order_recommendation_safety_stock_qty", DEFAULT_SAFETY_STOCK_QTY)

    expected_sales_today = calc_expected_sales_today(
        weekday_average_sales, previous_day_sales_qty, avg_sales_7d, avg_sales_14d,
        weight_weekday_average, weight_previous_day, weight_avg_7d, weight_avg_14d,
    )
    recommended_qty = calc_recommended_qty(
        expected_sales_today, row["stock_qty"], row["incoming_qty"], coverage_days, safety_stock_qty
    )

    prev_ad_budget = prev_row["ad_budget"] if prev_row is not None else None
    prev_wish_count = prev_row["wish_count"] if prev_row is not None else None
    prev_cart_count = prev_row["cart_count"] if prev_row is not None else None
    ad_budget_change, ad_budget_change_rate = calc_change_and_rate(row["ad_budget"], prev_ad_budget)
    wish_count_change, wish_count_change_rate = calc_change_and_rate(row["wish_count"], prev_wish_count)
    cart_count_change, cart_count_change_rate = calc_change_and_rate(row["cart_count"], prev_cart_count)

    conn.execute(
        """
        UPDATE order_recommendation_daily SET
            previous_day_sales_qty = ?,
            sales_7d = ?, sales_14d = ?, avg_sales_7d = ?, avg_sales_14d = ?,
            weekday_average_sales = ?, expected_sales_today = ?,
            recommended_qty = ?,
            ad_budget_change = ?, ad_budget_change_rate = ?,
            wish_count_change = ?, wish_count_change_rate = ?,
            cart_count_change = ?, cart_count_change_rate = ?
        WHERE date = ? AND yusas_code = ?
        """,
        (
            previous_day_sales_qty,
            sales_7d, sales_14d, avg_sales_7d, avg_sales_14d,
            weekday_average_sales, expected_sales_today,
            recommended_qty,
            ad_budget_change, ad_budget_change_rate,
            wish_count_change, wish_count_change_rate,
            cart_count_change, cart_count_change_rate,
            date, yusas_code,
        ),
    )
    conn.commit()


def compute_all(get_db, date: str, get_setting) -> int:
    conn = get_db()
    try:
        codes = [
            r["yusas_code"]
            for r in conn.execute(
                "SELECT yusas_code FROM order_recommendation_daily WHERE date = ?", (date,)
            ).fetchall()
        ]
        for code in codes:
            compute_row(conn, code, date, get_setting)
        return len(codes)
    finally:
        conn.close()
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && python -m pytest tests/test_order_recommendation_calc.py -v`
Expected: PASS (7 + 5 + 6 + 5 + 7 + 6 = 36개 테스트 전부 — 기존 유지되는
`calc_sales_window`/`calc_weekday_average_sales` 7개, 신규
`calc_expected_sales_today` 5개, `calc_recommended_qty` 6개(변경 없음),
`calc_change_and_rate` 5개(변경 없음), `_setting_weight` 7개, `compute_row`/
`compute_all` 6개)

- [ ] **Step 5: 커밋**

```bash
git add backend/services/order_recommendation_calc.py backend/tests/test_order_recommendation_calc.py
git commit -m "feat: replace expected_sales_today with weighted-average formula"
```

---

## 최종 확인

- [ ] `cd backend && python -m pytest tests/ -k order_recommendation -v` 전체
      PASS
- [ ] `cd backend && python -c "import main"` 에러 없음
- [ ] `cd backend && python -m pytest tests/ -q` 전체(회귀 포함) PASS
