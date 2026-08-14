# 추천발주: 발주 운영 성과 평가 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 담당자의 추천수량 조정폭(`confirm_deviation`), 확정수량 대비 실제
입고량 차이(`fulfillment_gap`), 미송(`incoming_qty`)의 전일 대비 증감
(`incoming_qty_change`)을 저장하고, 최근 N일 평균을 집계하는 API를 추가한다.

**Architecture:** `order_recommendation_daily`에 신규 원본 입력
`actual_received_qty`, 참고지표 `incoming_qty_change`/`incoming_qty_change_rate`
(`compute_row`가 기존 `ad_budget_change`와 동일 패턴으로 계산), 평가 결과
`confirm_deviation`/`fulfillment_gap`/`order_performance_evaluated_at`
(신규 `evaluate_order_performance_row`가 계산) 컬럼 6개를 추가한다.
`actual_received_qty`를 컬렉터 화이트리스트에 추가한다(실제 API 연결은 다음
세션). 신규 `backend/services/order_recommendation_order_performance.py`가
순수 비교 함수, 행 단위 평가, 집계를 담당한다. API에
`POST /order-recommendation/evaluate-order-performance`,
`GET /order-recommendation/order-performance`를 추가한다.

**Tech Stack:** FastAPI + SQLite(공유 DB), pytest.

## Global Constraints

- `confirm_deviation = confirmed_qty - recommended_qty`, `fulfillment_gap =
  actual_received_qty - confirmed_qty` — 입력 중 하나라도 NULL이면 결과도
  NULL(부분 계산 허용 — `confirmed_qty`만 있어도 `confirm_deviation`은 채워짐).
- `incoming_qty_change`/`rate`는 기존 `calc_change_and_rate`를 그대로
  재사용한다 — 새 계산 로직을 만들지 않는다.
- `evaluate_order_performance_row`는 `compute_row`가 쓰는 컬럼
  (`recommended_qty`, `incoming_qty_change` 등)을 절대 건드리지 않는다 —
  `confirm_deviation`/`fulfillment_gap`/`order_performance_evaluated_at`만
  쓴다.
- `actual_received_qty`의 실제 수집기 연결은 이번 범위 밖 — 화이트리스트
  등록만 한다.
- 집계(`aggregate_order_performance`)는 `order_performance_evaluated_at`
  여부와 무관하게 날짜 범위 안의 모든 행을 대상으로 하고, 각 지표는 자기
  자신이 NULL이 아닌 행만으로 평균을 낸다(지표별로 분모가 다를 수 있음).

참고 스펙: `docs/superpowers/specs/2026-07-29-order-recommendation-order-performance-design.md`

---

### Task 1: DB 스키마 — 6개 컬럼 + 컬렉터 화이트리스트

**Files:**
- Modify: `backend/services/order_recommendation_store.py`
- Modify: `backend/services/order_recommendation_collect.py`
- Modify: `backend/tests/test_order_recommendation_store.py`
- Modify: `backend/tests/test_order_recommendation_collect.py`

**Interfaces:**
- Consumes: 없음.
- Produces: `init_order_recommendation_tables(get_db) -> None`(시그니처
  변경 없음). 신규 `_ensure_order_performance_columns(conn) -> None`(private).
  `ALLOWED_COLLECTOR_COLUMNS`에 `"actual_received_qty"` 포함.

- [ ] **Step 1: 실패하는 테스트로 수정**

`backend/tests/test_order_recommendation_store.py`의 `EXPECTED_COLUMNS`를
다음으로 교체(6개 컬럼 추가 — `incoming_qty` 다음에 `actual_received_qty`,
`cart_count_change_rate` 다음에 `incoming_qty_change`/`incoming_qty_change_rate`,
`evaluated_at` 다음에 `confirm_deviation`/`fulfillment_gap`/
`order_performance_evaluated_at`):

```python
EXPECTED_COLUMNS = {
    "date", "yusas_code", "day_of_week",
    "sales_qty", "stock_qty", "incoming_qty", "actual_received_qty",
    "previous_day_sales_qty",
    "ad_budget", "wish_count", "cart_count",
    "ad_budget_change", "ad_budget_change_rate",
    "wish_count_change", "wish_count_change_rate",
    "cart_count_change", "cart_count_change_rate",
    "incoming_qty_change", "incoming_qty_change_rate",
    "sales_7d", "sales_14d", "avg_sales_7d", "avg_sales_14d",
    "weekday_average_sales", "expected_sales_today",
    "model_version", "model_weight_weekday", "model_weight_previous_day",
    "model_weight_avg_7d", "model_weight_avg_14d",
    "recommended_qty",
    "forecast_error", "absolute_error", "within_20_percent", "evaluated_at",
    "confirm_deviation", "fulfillment_gap", "order_performance_evaluated_at",
    "confirmed_qty", "override_reason", "updated_by", "updated_at",
    "excluded_from_avg", "created_at",
}
```

파일 끝에 테스트 2개 추가:

```python
def test_init_adds_order_performance_columns_to_legacy_table_missing_them():
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
    for column in [
        "actual_received_qty", "incoming_qty_change", "incoming_qty_change_rate",
        "confirm_deviation", "fulfillment_gap", "order_performance_evaluated_at",
    ]:
        assert column in cols
    conn.close()


def test_init_is_idempotent_when_order_performance_columns_already_present():
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    init_order_recommendation_tables(get_db)  # 두 번째 호출도 에러 없이 통과해야 함

    conn = get_db()
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(order_recommendation_daily)").fetchall()}
    assert "actual_received_qty" in cols
    assert "order_performance_evaluated_at" in cols
    conn.close()
```

`backend/tests/test_order_recommendation_collect.py`의
`test_register_collector_allows_whitelisted_column` 안의 assert를 다음으로
교체:

```python
        assert ALLOWED_COLLECTOR_COLUMNS == {
            "sales_qty", "stock_qty", "incoming_qty", "actual_received_qty",
            "ad_budget", "wish_count", "cart_count",
        }
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && python -m pytest tests/test_order_recommendation_store.py tests/test_order_recommendation_collect.py -v`
Expected: FAIL — store 3개(`test_init_creates_table_with_expected_columns`,
신규 2개), collect 1개(`test_register_collector_allows_whitelisted_column`).

- [ ] **Step 3: `order_recommendation_store.py`/`order_recommendation_collect.py` 수정**

`init_order_recommendation_tables`의 `CREATE TABLE`을 다음으로 교체:

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
            actual_received_qty INTEGER,
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
            incoming_qty_change INTEGER,
            incoming_qty_change_rate REAL,

            sales_7d INTEGER,
            sales_14d INTEGER,
            avg_sales_7d REAL,
            avg_sales_14d REAL,
            weekday_average_sales REAL,
            expected_sales_today REAL,

            model_version TEXT,
            model_weight_weekday REAL,
            model_weight_previous_day REAL,
            model_weight_avg_7d REAL,
            model_weight_avg_14d REAL,

            recommended_qty INTEGER,

            forecast_error REAL,
            absolute_error REAL,
            within_20_percent INTEGER,
            evaluated_at TEXT,

            confirm_deviation INTEGER,
            fulfillment_gap INTEGER,
            order_performance_evaluated_at TEXT,

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
    _ensure_forecast_accuracy_columns(conn)
    _ensure_order_performance_columns(conn)
    conn.commit()
    conn.close()
```

파일 끝(`_ensure_forecast_accuracy_columns` 다음)에 추가:

```python
_ORDER_PERFORMANCE_COLUMNS = [
    ("actual_received_qty", "INTEGER"),
    ("incoming_qty_change", "INTEGER"),
    ("incoming_qty_change_rate", "REAL"),
    ("confirm_deviation", "INTEGER"),
    ("fulfillment_gap", "INTEGER"),
    ("order_performance_evaluated_at", "TEXT"),
]


def _ensure_order_performance_columns(conn) -> None:
    cols = [r["name"] for r in conn.execute("PRAGMA table_info(order_recommendation_daily)").fetchall()]
    for column, ddl_type in _ORDER_PERFORMANCE_COLUMNS:
        if column not in cols:
            conn.execute(f"ALTER TABLE order_recommendation_daily ADD COLUMN {column} {ddl_type}")
```

`backend/services/order_recommendation_collect.py`의 `ALLOWED_COLLECTOR_COLUMNS`를:

```python
ALLOWED_COLLECTOR_COLUMNS = {
    "sales_qty", "stock_qty", "incoming_qty", "actual_received_qty",
    "ad_budget", "wish_count", "cart_count",
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && python -m pytest tests/test_order_recommendation_store.py tests/test_order_recommendation_collect.py -v`
Expected: PASS (store 13개 — 기존 11개 + 신규 2개, collect 5개 — 개수 변화
없음, assert 값만 수정됨)

- [ ] **Step 5: 커밋**

```bash
git add backend/services/order_recommendation_store.py backend/services/order_recommendation_collect.py backend/tests/test_order_recommendation_store.py backend/tests/test_order_recommendation_collect.py
git commit -m "feat: add order-performance columns and actual_received_qty to collector whitelist"
```

---

### Task 2: `compute_row`가 `incoming_qty_change`/`rate` 계산

**Files:**
- Modify: `backend/services/order_recommendation_calc.py`
- Modify: `backend/tests/test_order_recommendation_calc.py`

**Interfaces:**
- Consumes: Task 1의 스키마, 기존 `calc_change_and_rate`.
- Produces: `compute_row` 시그니처 변경 없음.

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_order_recommendation_calc.py` 파일 끝에 추가:

```python
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
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && python -m pytest tests/test_order_recommendation_calc.py -v`
Expected: FAIL — `row["incoming_qty_change"]`가 `None`이라 실패(컬럼은
Task 1에서 이미 추가됐지만 `compute_row`가 아직 안 씀).

- [ ] **Step 3: `compute_row` 수정**

기존 참고지표 계산 블록(`ad_budget_change, ad_budget_change_rate =
calc_change_and_rate(...)` 등) 바로 다음에 추가:

```python
    prev_incoming_qty = prev_row["incoming_qty"] if prev_row is not None else None
    incoming_qty_change, incoming_qty_change_rate = calc_change_and_rate(row["incoming_qty"], prev_incoming_qty)
```

`UPDATE` 문의 `cart_count_change = ?, cart_count_change_rate = ?` 바로
뒤에 `incoming_qty_change = ?, incoming_qty_change_rate = ?` 추가, values
튜플의 `cart_count_change, cart_count_change_rate,` 바로 뒤에
`incoming_qty_change, incoming_qty_change_rate,` 추가.

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && python -m pytest tests/test_order_recommendation_calc.py -v`
Expected: PASS (37개 테스트 전부 — 기존 36개 + 신규 1개)

- [ ] **Step 5: 커밋**

```bash
git add backend/services/order_recommendation_calc.py backend/tests/test_order_recommendation_calc.py
git commit -m "feat: compute incoming_qty (backorder) day-over-day change"
```

---

### Task 3: `order_recommendation_order_performance.py`

**Files:**
- Create: `backend/services/order_recommendation_order_performance.py`
- Test: `backend/tests/test_order_recommendation_order_performance.py`

**Interfaces:**
- Consumes: `services.order_recommendation_store.get_row`, `now_kst_iso`,
  `today_kst`.
- Produces:
  - `calc_confirm_deviation(confirmed_qty, recommended_qty) -> int | None`
  - `calc_fulfillment_gap(actual_received_qty, confirmed_qty) -> int | None`
  - `evaluate_order_performance_row(conn, yusas_code: str, date: str) -> None`
  - `evaluate_order_performance_all(get_db, date: str) -> int`
  - `aggregate_order_performance(conn, days: int, yusas_code: str | None = None) -> dict`
    — `{"sample_count": int, "avg_confirm_deviation": float | None,
    "avg_fulfillment_gap": float | None, "avg_incoming_qty_change": float | None}`

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_order_recommendation_order_performance.py` 생성:

```python
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
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && python -m pytest tests/test_order_recommendation_order_performance.py -v`
Expected: FAIL — `services.order_recommendation_order_performance` 모듈이
아직 없어 ImportError.

- [ ] **Step 3: `backend/services/order_recommendation_order_performance.py` 구현**

```python
from __future__ import annotations

from datetime import datetime, timedelta

from services.order_recommendation_store import get_row, now_kst_iso, today_kst


def _date_minus(date: str, days: int) -> str:
    return (datetime.strptime(date, "%Y-%m-%d") - timedelta(days=days)).strftime("%Y-%m-%d")


def calc_confirm_deviation(confirmed_qty, recommended_qty):
    if confirmed_qty is None or recommended_qty is None:
        return None
    return confirmed_qty - recommended_qty


def calc_fulfillment_gap(actual_received_qty, confirmed_qty):
    if actual_received_qty is None or confirmed_qty is None:
        return None
    return actual_received_qty - confirmed_qty


def evaluate_order_performance_row(conn, yusas_code: str, date: str) -> None:
    row = get_row(conn, date, yusas_code)
    if row is None:
        return

    confirm_deviation = calc_confirm_deviation(row["confirmed_qty"], row["recommended_qty"])
    fulfillment_gap = calc_fulfillment_gap(row["actual_received_qty"], row["confirmed_qty"])

    conn.execute(
        """
        UPDATE order_recommendation_daily SET
            confirm_deviation = ?, fulfillment_gap = ?, order_performance_evaluated_at = ?
        WHERE date = ? AND yusas_code = ?
        """,
        (confirm_deviation, fulfillment_gap, now_kst_iso(), date, yusas_code),
    )
    conn.commit()


def evaluate_order_performance_all(get_db, date: str) -> int:
    conn = get_db()
    try:
        codes = [
            r["yusas_code"]
            for r in conn.execute(
                "SELECT yusas_code FROM order_recommendation_daily WHERE date = ?", (date,)
            ).fetchall()
        ]
        for code in codes:
            evaluate_order_performance_row(conn, code, date)
        return len(codes)
    finally:
        conn.close()


def aggregate_order_performance(conn, days: int, yusas_code: str | None = None) -> dict:
    start_date = _date_minus(today_kst(), days)
    query = (
        "SELECT confirm_deviation, fulfillment_gap, incoming_qty_change "
        "FROM order_recommendation_daily WHERE date >= ?"
    )
    params: list = [start_date]
    if yusas_code is not None:
        query += " AND yusas_code = ?"
        params.append(yusas_code)
    rows = conn.execute(query, params).fetchall()

    sample_count = len(rows)
    confirm_deviations = [r["confirm_deviation"] for r in rows if r["confirm_deviation"] is not None]
    fulfillment_gaps = [r["fulfillment_gap"] for r in rows if r["fulfillment_gap"] is not None]
    incoming_qty_changes = [r["incoming_qty_change"] for r in rows if r["incoming_qty_change"] is not None]

    avg_confirm_deviation = sum(confirm_deviations) / len(confirm_deviations) if confirm_deviations else None
    avg_fulfillment_gap = sum(fulfillment_gaps) / len(fulfillment_gaps) if fulfillment_gaps else None
    avg_incoming_qty_change = (
        sum(incoming_qty_changes) / len(incoming_qty_changes) if incoming_qty_changes else None
    )

    return {
        "sample_count": sample_count,
        "avg_confirm_deviation": avg_confirm_deviation,
        "avg_fulfillment_gap": avg_fulfillment_gap,
        "avg_incoming_qty_change": avg_incoming_qty_change,
    }
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && python -m pytest tests/test_order_recommendation_order_performance.py -v`
Expected: PASS (13개 테스트 전부)

- [ ] **Step 5: 커밋**

```bash
git add backend/services/order_recommendation_order_performance.py backend/tests/test_order_recommendation_order_performance.py
git commit -m "feat: add order-performance evaluation and aggregation"
```

---

### Task 4: API — `/evaluate-order-performance`, `/order-performance`

**Files:**
- Modify: `backend/api/order_recommendation_routes.py`
- Modify: `backend/tests/test_order_recommendation_routes.py`

**Interfaces:**
- Consumes: Task 3의 `evaluate_order_performance_all`,
  `aggregate_order_performance`.
- Produces: `POST /order-recommendation/evaluate-order-performance`,
  `GET /order-recommendation/order-performance`.

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_order_recommendation_routes.py` 파일 끝에 추가:

```python
def test_evaluate_order_performance_endpoint_fills_deviation_columns():
    client, get_db, _keep_alive = _make_client()
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
    client, get_db, _keep_alive = _make_client()
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
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && python -m pytest tests/test_order_recommendation_routes.py -v`
Expected: FAIL — 두 엔드포인트 다 404.

- [ ] **Step 3: `backend/api/order_recommendation_routes.py` 수정**

import에 추가:

```python
from services.order_recommendation_order_performance import (
    aggregate_order_performance,
    evaluate_order_performance_all,
)
```

`@router.get("/forecast-accuracy")` 라우트 정의 끝 다음,
`@router.post("/{date}/{yusas_code}/confirm")` 라우트 **앞에** 추가:

```python
    @router.post("/evaluate-order-performance")
    def evaluate_order_performance(date: str | None = None, user: str = Depends(get_current_user)):
        target_date = date or today_kst()
        count = evaluate_order_performance_all(get_db, target_date)
        return {"ok": True, "date": target_date, "evaluated": count}

    @router.get("/order-performance")
    def order_performance(
        days: int = 7,
        yusas_code: str | None = None,
        user: str = Depends(get_current_user),
    ):
        conn = get_db()
        try:
            result = aggregate_order_performance(conn, days, yusas_code)
        finally:
            conn.close()
        return {"ok": True, "days": days, "yusas_code": yusas_code, **result}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && python -m pytest tests/test_order_recommendation_routes.py -v`
Expected: PASS (9개 테스트 전부 — 기존 7개 + 신규 2개)

- [ ] **Step 5: 커밋**

```bash
git add backend/api/order_recommendation_routes.py backend/tests/test_order_recommendation_routes.py
git commit -m "feat: add evaluate-order-performance and order-performance API endpoints"
```

---

## 최종 확인

- [ ] `cd backend && python -m pytest tests/ -k order_recommendation -v` 전체
      PASS (store 13 + calc 37 + collect 5 + routes 9 + evaluate 16 +
      order_performance 13 = 93개)
- [ ] `cd backend && python -c "import main"` 에러 없음
- [ ] `cd backend && python -m pytest tests/ -q` 전체(회귀 포함) PASS
