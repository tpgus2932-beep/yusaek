# 추천발주: 수요예측 정확도 평가 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `expected_sales_today` 예측값과 실제 신규 주문수(`sales_qty`, 곧
`actual_order_qty`)를 비교해 `forecast_error`/`absolute_error`/
`within_20_percent`를 일별·상품별로 저장하고, 최근 N일 MAE/WAPE/±20% 적중률을
집계하는 API를 추가한다.

**Architecture:** `order_recommendation_daily`에 예측 시점 스냅샷 5개
(`model_version` + 가중치 4개)와 평가 결과 4개(`forecast_error`/
`absolute_error`/`within_20_percent`/`evaluated_at`) 컬럼을 추가한다.
`compute_row`는 `expected_sales_today`를 계산할 때마다 스냅샷 5개도 같이
쓴다. 신규 `backend/services/order_recommendation_evaluate.py`가 순수
비교 함수(`calc_forecast_error`/`calc_within_20_percent`)와 행 단위
평가(`evaluate_row`/`evaluate_all`), 집계(`aggregate_forecast_accuracy`)를
담당한다. `evaluate_row`는 평가 결과 4개만 쓰고 스냅샷 5개는 절대 건드리지
않는다. API에 `POST /order-recommendation/evaluate`,
`GET /order-recommendation/forecast-accuracy`를 추가한다.

**Tech Stack:** FastAPI + SQLite(공유 DB), pytest.

## Global Constraints

- 실제값은 오직 `sales_qty`(그 날 신규 주문수)만 쓴다 — 출고량/입고량은
  절대 실제 수요값으로 쓰지 않는다.
- `model_version`/가중치 스냅샷 4개는 `compute_row`만 쓴다. `evaluate_row`는
  이 5개 컬럼을 읽지도 쓰지도 않는다.
- `actual_order_qty`용 별도 컬럼을 만들지 않는다 — 기존 `sales_qty`를 그대로
  실제값으로 읽는다.
- `actual_order_qty`(=`sales_qty`)가 0인 날은 `within_20_percent`를
  계산하지 않고 NULL로 두지만, `absolute_error`는 계산해 저장해서 MAE/WAPE
  집계에는 포함되게 한다.
- `recommended_qty`/`confirmed_qty`/`actual_received_qty` 비교, 미송 증감
  추적("발주 운영 성과" 평가)은 이번 범위 밖.
- 가중치 자동 변경/백테스트는 이번 범위 밖 — 성과 데이터만 쌓는다.

참고 스펙: `docs/superpowers/specs/2026-07-29-order-recommendation-forecast-accuracy-design.md`

---

### Task 1: DB 스키마 — 예측 스냅샷 5개 + 평가 결과 4개 컬럼 추가

**Files:**
- Modify: `backend/services/order_recommendation_store.py`
- Modify: `backend/tests/test_order_recommendation_store.py`

**Interfaces:**
- Consumes: 없음.
- Produces: `init_order_recommendation_tables(get_db) -> None`(시그니처 변경
  없음). 신규 `_ensure_forecast_accuracy_columns(conn) -> None`(private).

- [ ] **Step 1: 실패하는 테스트로 수정**

`backend/tests/test_order_recommendation_store.py`의 `EXPECTED_COLUMNS`를
다음으로 교체(9개 컬럼 추가):

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
    "model_version", "model_weight_weekday", "model_weight_previous_day",
    "model_weight_avg_7d", "model_weight_avg_14d",
    "recommended_qty",
    "forecast_error", "absolute_error", "within_20_percent", "evaluated_at",
    "confirmed_qty", "override_reason", "updated_by", "updated_at",
    "excluded_from_avg", "created_at",
}
```

파일 끝에 테스트 2개 추가:

```python
def test_init_adds_forecast_accuracy_columns_to_legacy_table_missing_them():
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
        "model_version", "model_weight_weekday", "model_weight_previous_day",
        "model_weight_avg_7d", "model_weight_avg_14d",
        "forecast_error", "absolute_error", "within_20_percent", "evaluated_at",
    ]:
        assert column in cols
    conn.close()


def test_init_is_idempotent_when_forecast_accuracy_columns_already_present():
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    init_order_recommendation_tables(get_db)  # 두 번째 호출도 에러 없이 통과해야 함

    conn = get_db()
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(order_recommendation_daily)").fetchall()}
    assert "model_version" in cols
    assert "evaluated_at" in cols
    conn.close()
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && python -m pytest tests/test_order_recommendation_store.py -v`
Expected: FAIL — 3개 실패(`test_init_creates_table_with_expected_columns`,
신규 2개).

- [ ] **Step 3: `backend/services/order_recommendation_store.py` 수정**

`init_order_recommendation_tables`의 `CREATE TABLE`을 다음으로 교체
(`expected_sales_today` 바로 아래 예측 스냅샷 5개, `recommended_qty` 바로
아래 평가 결과 4개 추가):

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
    conn.commit()
    conn.close()


_FORECAST_ACCURACY_COLUMNS = [
    ("model_version", "TEXT"),
    ("model_weight_weekday", "REAL"),
    ("model_weight_previous_day", "REAL"),
    ("model_weight_avg_7d", "REAL"),
    ("model_weight_avg_14d", "REAL"),
    ("forecast_error", "REAL"),
    ("absolute_error", "REAL"),
    ("within_20_percent", "INTEGER"),
    ("evaluated_at", "TEXT"),
]


def _ensure_forecast_accuracy_columns(conn) -> None:
    cols = [r["name"] for r in conn.execute("PRAGMA table_info(order_recommendation_daily)").fetchall()]
    for column, ddl_type in _FORECAST_ACCURACY_COLUMNS:
        if column not in cols:
            conn.execute(f"ALTER TABLE order_recommendation_daily ADD COLUMN {column} {ddl_type}")
```

(기존 `_ensure_avg_sales_14d_column` 함수는 그대로 둔다. `_FORECAST_ACCURACY_COLUMNS`
/`_ensure_forecast_accuracy_columns`는 `init_order_recommendation_tables` 다음에
배치.)

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && python -m pytest tests/test_order_recommendation_store.py -v`
Expected: PASS (11개 테스트 전부 — 기존 9개 + 신규 2개)

- [ ] **Step 5: 커밋**

```bash
git add backend/services/order_recommendation_store.py backend/tests/test_order_recommendation_store.py
git commit -m "feat: add forecast-accuracy snapshot and evaluation columns"
```

---

### Task 2: `compute_row`가 예측 시점에 model_version/가중치 스냅샷 기록

**Files:**
- Modify: `backend/services/order_recommendation_calc.py`
- Modify: `backend/tests/test_order_recommendation_calc.py`

**Interfaces:**
- Consumes: Task 1의 스키마(`model_version`/가중치 스냅샷 4개 컬럼 존재).
- Produces: `MODEL_VERSION = "weighted_v1"` 상수. `compute_row` 시그니처는
  그대로(`compute_row(conn, yusas_code, date, get_setting)`).

- [ ] **Step 1: 기존 테스트에 스냅샷 검증 추가**

`backend/tests/test_order_recommendation_calc.py`의
`test_compute_row_full_pipeline_with_default_settings` 끝에(`conn.close()`
직전) 추가:

```python
    assert row["model_version"] == "weighted_v1"
    assert row["model_weight_weekday"] == pytest.approx(0.35)
    assert row["model_weight_previous_day"] == pytest.approx(0.25)
    assert row["model_weight_avg_7d"] == pytest.approx(0.25)
    assert row["model_weight_avg_14d"] == pytest.approx(0.15)
```

`test_compute_row_respects_custom_weight_and_recommendation_settings` 끝에
(`conn.close()` 직전) 추가 — **커스텀 가중치가 그대로 스냅샷돼야 함**(기본값이
아니라):

```python
    assert row["model_version"] == "weighted_v1"
    assert row["model_weight_weekday"] == pytest.approx(0.5)
    assert row["model_weight_previous_day"] == pytest.approx(0.5)
    assert row["model_weight_avg_7d"] == pytest.approx(0.0)
    assert row["model_weight_avg_14d"] == pytest.approx(0.0)
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && python -m pytest tests/test_order_recommendation_calc.py -v`
Expected: FAIL — 두 테스트 모두 `row["model_version"]`이 `None`이라 실패
(컬럼은 Task 1에서 이미 추가됐지만 아직 아무도 안 씀).

- [ ] **Step 3: `backend/services/order_recommendation_calc.py` 수정**

`DEFAULT_WEIGHT_AVG_14D = 0.15` 바로 아래에 추가:

```python
MODEL_VERSION = "weighted_v1"
```

`compute_row` 안의 `UPDATE` 문을 다음으로 교체(`expected_sales_today = ?,`
바로 뒤에 스냅샷 5개 추가, values 튜플도 동일한 위치에 추가 — 이미 계산해둔
`weight_weekday_average`/`weight_previous_day`/`weight_avg_7d`/
`weight_avg_14d` 변수를 그대로 재사용):

```python
    conn.execute(
        """
        UPDATE order_recommendation_daily SET
            previous_day_sales_qty = ?,
            sales_7d = ?, sales_14d = ?, avg_sales_7d = ?, avg_sales_14d = ?,
            weekday_average_sales = ?, expected_sales_today = ?,
            model_version = ?, model_weight_weekday = ?, model_weight_previous_day = ?,
            model_weight_avg_7d = ?, model_weight_avg_14d = ?,
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
            MODEL_VERSION, weight_weekday_average, weight_previous_day,
            weight_avg_7d, weight_avg_14d,
            recommended_qty,
            ad_budget_change, ad_budget_change_rate,
            wish_count_change, wish_count_change_rate,
            cart_count_change, cart_count_change_rate,
            date, yusas_code,
        ),
    )
    conn.commit()
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && python -m pytest tests/test_order_recommendation_calc.py -v`
Expected: PASS (36개 테스트 전부 — 개수 변화 없음, 기존 2개 테스트에 assert만
추가됐음)

- [ ] **Step 5: 커밋**

```bash
git add backend/services/order_recommendation_calc.py backend/tests/test_order_recommendation_calc.py
git commit -m "feat: snapshot model_version and weights at prediction time"
```

---

### Task 3: `order_recommendation_evaluate.py` — 예측 오차 계산 + 집계

**Files:**
- Create: `backend/services/order_recommendation_evaluate.py`
- Test: `backend/tests/test_order_recommendation_evaluate.py`

**Interfaces:**
- Consumes: `services.order_recommendation_store.get_row`, `now_kst_iso`,
  `today_kst`.
- Produces:
  - `calc_forecast_error(expected_sales_today, actual_order_qty) -> float | None`
  - `calc_within_20_percent(absolute_error, actual_order_qty) -> int | None`
    (`actual_order_qty`가 `None`이거나 0이면 `None`)
  - `evaluate_row(conn, yusas_code: str, date: str) -> None` — 행이 없으면
    아무것도 안 함. `model_version`/가중치 스냅샷은 절대 안 건드림.
  - `evaluate_all(get_db, date: str) -> int`
  - `aggregate_forecast_accuracy(conn, days: int, yusas_code: str | None = None) -> dict`
    — `{"sample_count": int, "mae": float | None, "wape": float | None,
    "hit_rate_20pct": float | None}`

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_order_recommendation_evaluate.py` 생성:

```python
import sqlite3
import sys
import uuid
from datetime import datetime, timedelta
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

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
    date = _days_ago(1)
    ensure_row(conn, date, code)
    conn.execute(
        "UPDATE order_recommendation_daily SET expected_sales_today = 12, sales_qty = 10 "
        "WHERE date = ? AND yusas_code = ?",
        (date, code),
    )
    conn.commit()

    evaluate_row(conn, code, date)

    row = get_row(conn, date, code)
    assert row["forecast_error"] == 2.0
    assert row["absolute_error"] == 2.0
    assert row["within_20_percent"] == 1
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
    date = _days_ago(1)
    ensure_row(conn, date, code)
    conn.execute(
        "UPDATE order_recommendation_daily SET expected_sales_today = 12, sales_qty = 10, "
        "model_version = 'some_version', model_weight_weekday = 0.99 "
        "WHERE date = ? AND yusas_code = ?",
        (date, code),
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
    ensure_row(conn, date, code)
    conn.execute(
        "UPDATE order_recommendation_daily SET expected_sales_today = ?, sales_qty = ? "
        "WHERE date = ? AND yusas_code = ?",
        (expected, actual, date, code),
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
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && python -m pytest tests/test_order_recommendation_evaluate.py -v`
Expected: FAIL — `services.order_recommendation_evaluate` 모듈이 아직 없어
ImportError.

- [ ] **Step 3: `backend/services/order_recommendation_evaluate.py` 구현**

```python
from __future__ import annotations

from datetime import datetime, timedelta

from services.order_recommendation_store import get_row, now_kst_iso, today_kst

WITHIN_PERCENT_THRESHOLD = 0.20


def _date_minus(date: str, days: int) -> str:
    return (datetime.strptime(date, "%Y-%m-%d") - timedelta(days=days)).strftime("%Y-%m-%d")


def calc_forecast_error(expected_sales_today, actual_order_qty):
    if expected_sales_today is None or actual_order_qty is None:
        return None
    return expected_sales_today - actual_order_qty


def calc_within_20_percent(absolute_error, actual_order_qty):
    if absolute_error is None or actual_order_qty is None or actual_order_qty == 0:
        return None
    return 1 if absolute_error <= actual_order_qty * WITHIN_PERCENT_THRESHOLD else 0


def evaluate_row(conn, yusas_code: str, date: str) -> None:
    row = get_row(conn, date, yusas_code)
    if row is None:
        return

    actual_order_qty = row["sales_qty"]
    forecast_error = calc_forecast_error(row["expected_sales_today"], actual_order_qty)
    absolute_error = abs(forecast_error) if forecast_error is not None else None
    within_20_percent = calc_within_20_percent(absolute_error, actual_order_qty)

    conn.execute(
        """
        UPDATE order_recommendation_daily SET
            forecast_error = ?, absolute_error = ?, within_20_percent = ?, evaluated_at = ?
        WHERE date = ? AND yusas_code = ?
        """,
        (forecast_error, absolute_error, within_20_percent, now_kst_iso(), date, yusas_code),
    )
    conn.commit()


def evaluate_all(get_db, date: str) -> int:
    conn = get_db()
    try:
        codes = [
            r["yusas_code"]
            for r in conn.execute(
                "SELECT yusas_code FROM order_recommendation_daily WHERE date = ?", (date,)
            ).fetchall()
        ]
        for code in codes:
            evaluate_row(conn, code, date)
        return len(codes)
    finally:
        conn.close()


def aggregate_forecast_accuracy(conn, days: int, yusas_code: str | None = None) -> dict:
    start_date = _date_minus(today_kst(), days)
    query = (
        "SELECT absolute_error, sales_qty, within_20_percent FROM order_recommendation_daily "
        "WHERE date >= ? AND evaluated_at IS NOT NULL"
    )
    params: list = [start_date]
    if yusas_code is not None:
        query += " AND yusas_code = ?"
        params.append(yusas_code)
    rows = conn.execute(query, params).fetchall()

    sample_count = len(rows)
    abs_errors = [r["absolute_error"] for r in rows if r["absolute_error"] is not None]
    actuals_for_mae = [r["sales_qty"] for r in rows if r["absolute_error"] is not None]
    hit_flags = [r["within_20_percent"] for r in rows if r["within_20_percent"] is not None]

    mae = sum(abs_errors) / len(abs_errors) if abs_errors else None
    actual_sum = sum(actuals_for_mae)
    wape = (sum(abs_errors) / actual_sum) if abs_errors and actual_sum > 0 else None
    hit_rate_20pct = (sum(hit_flags) / len(hit_flags)) if hit_flags else None

    return {
        "sample_count": sample_count,
        "mae": mae,
        "wape": wape,
        "hit_rate_20pct": hit_rate_20pct,
    }
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && python -m pytest tests/test_order_recommendation_evaluate.py -v`
Expected: PASS (16개 테스트 전부)

- [ ] **Step 5: 커밋**

```bash
git add backend/services/order_recommendation_evaluate.py backend/tests/test_order_recommendation_evaluate.py
git commit -m "feat: add forecast-accuracy evaluation and aggregation"
```

---

### Task 4: API — `/evaluate`, `/forecast-accuracy`

**Files:**
- Modify: `backend/api/order_recommendation_routes.py`
- Modify: `backend/tests/test_order_recommendation_routes.py`

**Interfaces:**
- Consumes: Task 3의 `evaluate_all`, `aggregate_forecast_accuracy`.
- Produces: `POST /order-recommendation/evaluate`,
  `GET /order-recommendation/forecast-accuracy`.

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_order_recommendation_routes.py` 상단 import에 `import
pytest` 추가하고, `from services.order_recommendation_store import
ensure_row, init_order_recommendation_tables` 줄을 `from
services.order_recommendation_store import (ensure_row,
init_order_recommendation_tables, today_kst)`로 교체:

```python
import pytest
import sqlite3
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import FastAPI
from fastapi.testclient import TestClient

import services.order_recommendation_collect as collect_mod
from api.order_recommendation_routes import build_order_recommendation_router
from services.order_recommendation_store import (
    ensure_row,
    init_order_recommendation_tables,
    today_kst,
)
```

파일 끝에 테스트 2개 추가:

```python
def test_evaluate_endpoint_fills_forecast_accuracy_columns():
    client, get_db, _keep_alive = _make_client()
    conn = get_db()
    date = today_kst()
    ensure_row(conn, date, "YUSAS00001")
    conn.execute(
        "UPDATE order_recommendation_daily SET expected_sales_today = 12, sales_qty = 10 "
        "WHERE date = ? AND yusas_code = ?",
        (date, "YUSAS00001"),
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
    client, get_db, _keep_alive = _make_client()
    conn = get_db()
    date = today_kst()
    ensure_row(conn, date, "YUSAS00001")
    conn.execute(
        "UPDATE order_recommendation_daily SET expected_sales_today = 12, sales_qty = 10 "
        "WHERE date = ? AND yusas_code = ?",
        (date, "YUSAS00001"),
    )
    conn.commit()
    conn.close()
    client.post("/order-recommendation/evaluate", params={"date": date})

    res = client.get("/order-recommendation/forecast-accuracy", params={"days": 7})
    assert res.status_code == 200
    body = res.json()
    assert body["sample_count"] == 1
    assert body["mae"] == pytest.approx(2.0)
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && python -m pytest tests/test_order_recommendation_routes.py -v`
Expected: FAIL — `/order-recommendation/evaluate`, `/order-recommendation/forecast-accuracy`
둘 다 404.

- [ ] **Step 3: `backend/api/order_recommendation_routes.py` 수정**

파일 상단 import에 추가:

```python
from services.order_recommendation_calc import compute_all
from services.order_recommendation_collect import run_collectors
from services.order_recommendation_evaluate import aggregate_forecast_accuracy, evaluate_all
from services.order_recommendation_store import ensure_row, list_rows, now_kst_iso, today_kst
```

`@router.get("/daily")` 라우트 정의 끝(`return {"ok": True, ...}` 다음) —
`@router.post("/{date}/{yusas_code}/confirm")` 라우트 **앞에** 추가:

```python
    @router.post("/evaluate")
    def evaluate(date: str | None = None, user: str = Depends(get_current_user)):
        target_date = date or today_kst()
        count = evaluate_all(get_db, target_date)
        return {"ok": True, "date": target_date, "evaluated": count}

    @router.get("/forecast-accuracy")
    def forecast_accuracy(
        days: int = 7,
        yusas_code: str | None = None,
        user: str = Depends(get_current_user),
    ):
        conn = get_db()
        try:
            result = aggregate_forecast_accuracy(conn, days, yusas_code)
        finally:
            conn.close()
        return {"ok": True, "days": days, "yusas_code": yusas_code, **result}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && python -m pytest tests/test_order_recommendation_routes.py -v`
Expected: PASS (7개 테스트 전부 — 기존 5개 + 신규 2개)

- [ ] **Step 5: 커밋**

```bash
git add backend/api/order_recommendation_routes.py backend/tests/test_order_recommendation_routes.py
git commit -m "feat: add evaluate and forecast-accuracy API endpoints"
```

---

## 최종 확인

- [ ] `cd backend && python -m pytest tests/ -k order_recommendation -v` 전체
      PASS (store 11 + calc 36 + collect 5 + routes 7 + evaluate 16 = 75개)
- [ ] `cd backend && python -c "import main"` 에러 없음
- [ ] `cd backend && python -m pytest tests/ -q` 전체(회귀 포함) PASS
