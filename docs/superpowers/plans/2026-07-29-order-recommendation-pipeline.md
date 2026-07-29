# 추천발주 대시보드 1차: 계산 파이프라인 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 상품(YUSAS 통합코드)별 일별 데이터를 모아 요일평균×전날흐름계수 기반 추천
발주수량을 계산하고, 담당자가 수정한 확정값·사유를 저장하는 백엔드 파이프라인을
만든다. 프론트엔드·RAG/LLM은 비범위.

**Architecture:** 신규 SQLite 테이블 `order_recommendation_daily`(공유 DB,
`_get_shared_db`)에 날짜×YUSAS코드별 원본 입력·파생값·결과를 저장한다.
`backend/services/order_recommendation_store.py`(스키마+행 CRUD 헬퍼),
`order_recommendation_calc.py`(순수 계산 함수 + 오케스트레이터),
`order_recommendation_collect.py`(마켓 API 수집기 레지스트리 + 화이트리스트
UPSERT) 세 서비스 모듈로 나누고, `backend/api/order_recommendation_routes.py`가
`/order-recommendation/collect|compute|daily|{date}/{yusas_code}/confirm` 4개
엔드포인트로 HTTP 계층을 담당한다. 컬렉터는 처음엔 전부 미등록 상태로 두어, 이후
세션에서 변수 하나당 함수 하나씩 실 API를 붙여나갈 수 있게 한다.

**Tech Stack:** FastAPI + SQLite(공유 DB `_get_shared_db`), pytest + FastAPI
TestClient(백엔드). 프론트엔드 변경 없음.

## Global Constraints

- 예측 계산에는 대상일(`date`) 당일의 `sales_qty`를 절대 포함하지 않는다 (데이터
  누수 방지) — `sales_7d`/`sales_14d`/`avg_sales_7d`/`weekday_average_sales` 전부
  대상일 미만 데이터만 사용.
- `previous_day_sales_ratio`는 전날 행의 캐시에만 의존하지 않는다 — 캐시가 없으면
  동일 계산 함수로 즉시 계산해, `/compute`가 날짜 순서와 무관하게 호출돼도 결과가
  같아야 한다.
- `recommended_qty` 반올림은 `math.ceil()`만 쓴다 — Python 기본 `round()`(은행반올림)
  금지.
- 모든 날짜/시각은 Asia/Seoul(KST, UTC+9) 고정 — 서버가 UTC 환경이어도 날짜가
  어긋나면 안 된다. `created_at`/`updated_at`은 타임존 오프셋 포함 ISO 8601.
- 컬렉터는 화이트리스트 컬럼(`sales_qty`, `stock_qty`, `incoming_qty`, `ad_budget`,
  `wish_count`, `cart_count`)만 쓸 수 있고, 반환하지 않은 컬럼은 기존 값을 NULL로
  덮어쓰지 않는다.
- 광고 배정금액/찜 수/장바구니 수는 추천수량 계산식에 반영하지 않는다 — 원본값·
  증감·증감률만 저장하고 참고지표로만 응답에 포함한다.
- 담당자 확정값(`confirmed_qty`/`override_reason`)은 행당 최신 1건만 덮어쓴다 —
  다건 이력 보관은 비범위.

참고 스펙: `docs/superpowers/specs/2026-07-29-order-recommendation-pipeline-design.md`

---

### Task 1: 스키마 + 행 CRUD 헬퍼 (`order_recommendation_store.py`)

**Files:**
- Create: `backend/services/order_recommendation_store.py`
- Test: `backend/tests/test_order_recommendation_store.py`

**Interfaces:**
- Produces:
  - `_KST: timezone` — UTC+9 고정 timezone 객체.
  - `today_kst() -> str` — KST 기준 `"YYYY-MM-DD"`.
  - `now_kst_iso() -> str` — KST 오프셋 포함 ISO 8601 문자열(`...+09:00`).
  - `previous_date(date: str) -> str` — `date`의 하루 전 `"YYYY-MM-DD"`.
  - `init_order_recommendation_tables(get_db) -> None` — 테이블 생성(있으면 통과).
  - `get_row(conn, date: str, yusas_code: str) -> sqlite3.Row | None`
  - `list_rows(conn, date: str) -> list[sqlite3.Row]` — `yusas_code` 오름차순.
  - `ensure_row(conn, date: str, yusas_code: str) -> None` — 행이 없으면
    `date`/`yusas_code`/`day_of_week`/`created_at`만 채워 삽입(`ON CONFLICT DO
    NOTHING`, 커밋은 호출자 책임).

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_order_recommendation_store.py` 생성:

```python
import sqlite3
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.order_recommendation_store import (
    ensure_row,
    get_row,
    init_order_recommendation_tables,
    list_rows,
    now_kst_iso,
    previous_date,
    today_kst,
)


def _make_db_factory():
    uri = f"file:test_order_recommendation_store_{uuid.uuid4().hex}?mode=memory&cache=shared"
    keep_alive = sqlite3.connect(uri, uri=True)
    keep_alive.row_factory = sqlite3.Row

    def factory():
        conn = sqlite3.connect(uri, uri=True)
        conn.row_factory = sqlite3.Row
        return conn

    return factory, keep_alive


EXPECTED_COLUMNS = {
    "date", "yusas_code", "day_of_week",
    "sales_qty", "stock_qty", "incoming_qty", "previous_day_sales_qty",
    "ad_budget", "wish_count", "cart_count",
    "ad_budget_change", "ad_budget_change_rate",
    "wish_count_change", "wish_count_change_rate",
    "cart_count_change", "cart_count_change_rate",
    "sales_7d", "sales_14d", "avg_sales_7d",
    "weekday_average_sales", "previous_day_sales_ratio", "expected_sales_today",
    "recommended_qty",
    "confirmed_qty", "override_reason", "updated_by", "updated_at",
    "excluded_from_avg", "created_at",
}


def test_init_creates_table_with_expected_columns():
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    conn = get_db()
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(order_recommendation_daily)").fetchall()}
    assert cols == EXPECTED_COLUMNS
    conn.close()


def test_ensure_row_creates_row_with_day_of_week_and_created_at():
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    conn = get_db()
    ensure_row(conn, "2026-07-29", "YUSAS00001")
    conn.commit()

    row = get_row(conn, "2026-07-29", "YUSAS00001")
    assert row["day_of_week"] == 2  # 2026-07-29는 수요일
    assert row["created_at"] is not None
    assert row["created_at"].endswith("+09:00")
    assert row["sales_qty"] is None
    conn.close()


def test_ensure_row_is_idempotent_and_preserves_existing_values():
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    conn = get_db()
    ensure_row(conn, "2026-07-29", "YUSAS00001")
    conn.commit()
    conn.execute(
        "UPDATE order_recommendation_daily SET sales_qty = 5 WHERE date = ? AND yusas_code = ?",
        ("2026-07-29", "YUSAS00001"),
    )
    conn.commit()

    ensure_row(conn, "2026-07-29", "YUSAS00001")
    conn.commit()

    row = get_row(conn, "2026-07-29", "YUSAS00001")
    assert row["sales_qty"] == 5
    conn.close()


def test_list_rows_returns_all_rows_for_date_ordered_by_code():
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    conn = get_db()
    ensure_row(conn, "2026-07-29", "YUSAS00002")
    ensure_row(conn, "2026-07-29", "YUSAS00001")
    conn.commit()

    rows = list_rows(conn, "2026-07-29")
    assert [r["yusas_code"] for r in rows] == ["YUSAS00001", "YUSAS00002"]
    conn.close()


def test_previous_date_handles_month_rollover():
    assert previous_date("2026-08-01") == "2026-07-31"


def test_today_kst_returns_iso_date_format():
    assert len(today_kst()) == 10
    assert today_kst()[4] == "-" and today_kst()[7] == "-"


def test_now_kst_iso_includes_seoul_offset():
    assert now_kst_iso().endswith("+09:00")
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && python -m pytest tests/test_order_recommendation_store.py -v`
Expected: FAIL — `services.order_recommendation_store` 모듈이 아직 없어 ImportError.

- [ ] **Step 3: `backend/services/order_recommendation_store.py` 구현**

```python
from __future__ import annotations

from datetime import datetime, timedelta, timezone

_KST = timezone(timedelta(hours=9))


def today_kst() -> str:
    return datetime.now(_KST).strftime("%Y-%m-%d")


def now_kst_iso() -> str:
    return datetime.now(_KST).isoformat()


def previous_date(date: str) -> str:
    d = datetime.strptime(date, "%Y-%m-%d") - timedelta(days=1)
    return d.strftime("%Y-%m-%d")


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
            weekday_average_sales REAL,
            previous_day_sales_ratio REAL,
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
    conn.commit()
    conn.close()


def get_row(conn, date: str, yusas_code: str):
    return conn.execute(
        "SELECT * FROM order_recommendation_daily WHERE date = ? AND yusas_code = ?",
        (date, yusas_code),
    ).fetchone()


def list_rows(conn, date: str):
    return conn.execute(
        "SELECT * FROM order_recommendation_daily WHERE date = ? ORDER BY yusas_code",
        (date,),
    ).fetchall()


def ensure_row(conn, date: str, yusas_code: str) -> None:
    day_of_week = datetime.strptime(date, "%Y-%m-%d").weekday()
    conn.execute(
        """
        INSERT INTO order_recommendation_daily (date, yusas_code, day_of_week, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(date, yusas_code) DO NOTHING
        """,
        (date, yusas_code, day_of_week, now_kst_iso()),
    )
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && python -m pytest tests/test_order_recommendation_store.py -v`
Expected: PASS (7개 테스트 전부)

- [ ] **Step 5: 커밋**

```bash
git add backend/services/order_recommendation_store.py backend/tests/test_order_recommendation_store.py
git commit -m "feat: add order_recommendation_daily schema and row helpers"
```

---

### Task 2: 계산 로직 1부 — 판매 집계 + 요일평균 (데이터 누수 방지)

**Files:**
- Create: `backend/services/order_recommendation_calc.py`
- Test: `backend/tests/test_order_recommendation_calc.py`

**Interfaces:**
- Consumes: `services.order_recommendation_store.previous_date`, `get_row`.
- Produces:
  - `calc_sales_window(conn, yusas_code: str, date: str, days: int) -> tuple[int | None, int]`
    — `date` 미만 최근 `days`일 `sales_qty` 합계와 값 개수(둘 다 NULL 값 제외,
    값이 하나도 없으면 `(None, 0)`).
  - `calc_weekday_average_sales(conn, yusas_code: str, as_of_date: str) -> float | None`
    — `as_of_date` 미만 데이터만 사용하는 순수 함수.

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_order_recommendation_calc.py` 생성:

```python
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
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && python -m pytest tests/test_order_recommendation_calc.py -v`
Expected: FAIL — `services.order_recommendation_calc` 모듈이 아직 없어 ImportError.

- [ ] **Step 3: `backend/services/order_recommendation_calc.py` 구현 (1부)**

```python
from __future__ import annotations

from datetime import datetime, timedelta

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
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && python -m pytest tests/test_order_recommendation_calc.py -v`
Expected: PASS (7개 테스트 전부)

- [ ] **Step 5: 커밋**

```bash
git add backend/services/order_recommendation_calc.py backend/tests/test_order_recommendation_calc.py
git commit -m "feat: add leakage-safe sales window and weekday average calculation"
```

---

### Task 3: 계산 로직 2부 — 전날 흐름계수 (순서 무관)

**Files:**
- Modify: `backend/services/order_recommendation_calc.py`
- Modify: `backend/tests/test_order_recommendation_calc.py`

**Interfaces:**
- Consumes: `services.order_recommendation_store.previous_date`, `get_row`;
  Task 2의 `calc_weekday_average_sales`.
- Produces:
  - `calc_previous_day_sales_ratio(conn, yusas_code: str, date: str, previous_day_sales_qty: int | None) -> float`
    — 전날 행이 없으면 `1.0`. 전날 행의 `weekday_average_sales`가 있으면 그 값을
    재사용, 없으면 `calc_weekday_average_sales`로 즉시 계산. 분모가 없거나 0,
    또는 `previous_day_sales_qty`가 `None`이면 `1.0`. 결과는 `[0.5, 2.0]`으로
    클램프.

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_order_recommendation_calc.py` 끝에 추가:

```python
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
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && python -m pytest tests/test_order_recommendation_calc.py -v`
Expected: FAIL — `calc_previous_day_sales_ratio`가 아직 없어 ImportError.

- [ ] **Step 3: `calc_previous_day_sales_ratio` 추가**

`backend/services/order_recommendation_calc.py`에 추가 (파일 상단 import에
`from services.order_recommendation_store import get_row, previous_date` 추가):

```python
from services.order_recommendation_store import get_row, previous_date

RATIO_MIN = 0.5
RATIO_MAX = 2.0


def calc_previous_day_sales_ratio(conn, yusas_code: str, date: str, previous_day_sales_qty):
    prev_date = previous_date(date)
    prev_row = get_row(conn, prev_date, yusas_code)
    if prev_row is None:
        return 1.0

    prev_avg = prev_row["weekday_average_sales"]
    if prev_avg is None:
        prev_avg = calc_weekday_average_sales(conn, yusas_code, prev_date)

    if not prev_avg or previous_day_sales_qty is None:
        return 1.0

    ratio = previous_day_sales_qty / prev_avg
    return max(RATIO_MIN, min(RATIO_MAX, ratio))
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && python -m pytest tests/test_order_recommendation_calc.py -v`
Expected: PASS (12개 테스트 전부)

- [ ] **Step 5: 커밋**

```bash
git add backend/services/order_recommendation_calc.py backend/tests/test_order_recommendation_calc.py
git commit -m "feat: add order-independent previous-day sales ratio calculation"
```

---

### Task 4: 계산 로직 3부 — 예상판매량 + 추천수량 (ceil, NULL 전파)

**Files:**
- Modify: `backend/services/order_recommendation_calc.py`
- Modify: `backend/tests/test_order_recommendation_calc.py`

**Interfaces:**
- Produces:
  - `calc_expected_sales_today(weekday_average_sales: float | None, previous_day_sales_ratio: float, blend_ratio: float) -> float | None`
  - `calc_recommended_qty(expected_sales_today: float | None, stock_qty: int | None, incoming_qty: int | None, coverage_days: float, safety_stock_qty: float) -> int | None`
    — `math.ceil(target_sales + safety_stock_qty) - stock_qty - incoming_qty`을
    0과 비교해 `max(0, ...)`. 입력 중 하나라도 `None`이면 `None`.

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_order_recommendation_calc.py` 끝에 추가:

```python
from services.order_recommendation_calc import (
    calc_expected_sales_today,
    calc_recommended_qty,
)


def test_expected_sales_today_none_when_weekday_average_none():
    assert calc_expected_sales_today(None, 1.3, 0.4) is None


def test_expected_sales_today_applies_flow_adjustment():
    result = calc_expected_sales_today(10.0, 1.5, 0.4)
    assert result == 12.0  # 1 + (1.5-1)*0.4 = 1.2, 10 * 1.2 = 12.0


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
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && python -m pytest tests/test_order_recommendation_calc.py -v`
Expected: FAIL — `calc_expected_sales_today`/`calc_recommended_qty`가 아직 없어
ImportError.

- [ ] **Step 3: 구현 추가**

`backend/services/order_recommendation_calc.py` 상단에 `import math` 추가,
파일 끝에 추가:

```python
def calc_expected_sales_today(weekday_average_sales, previous_day_sales_ratio: float, blend_ratio: float):
    if weekday_average_sales is None:
        return None
    flow_adjustment = 1 + (previous_day_sales_ratio - 1) * blend_ratio
    return weekday_average_sales * flow_adjustment


def calc_recommended_qty(expected_sales_today, stock_qty, incoming_qty, coverage_days: float, safety_stock_qty: float):
    if expected_sales_today is None or stock_qty is None or incoming_qty is None:
        return None
    target_sales = expected_sales_today * coverage_days
    return max(0, math.ceil(target_sales + safety_stock_qty) - stock_qty - incoming_qty)
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && python -m pytest tests/test_order_recommendation_calc.py -v`
Expected: PASS (20개 테스트 전부)

- [ ] **Step 5: 커밋**

```bash
git add backend/services/order_recommendation_calc.py backend/tests/test_order_recommendation_calc.py
git commit -m "feat: add expected-sales and recommended-qty calculation with ceil rounding"
```

---

### Task 5: 계산 로직 4부 — 참고지표(광고/찜/장바구니) 증감·증감률

**Files:**
- Modify: `backend/services/order_recommendation_calc.py`
- Modify: `backend/tests/test_order_recommendation_calc.py`

**Interfaces:**
- Produces:
  - `calc_change_and_rate(today_value: int | None, previous_value: int | None) -> tuple[int | None, float | None]`
    — `(change, change_rate)`. `change = today - previous`(음수 허용).
    `change_rate = change / previous`(단, `previous`가 없거나 0이면 `None`).
    `today`/`previous` 둘 중 하나라도 `None`이면 `(None, None)`.

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_order_recommendation_calc.py` 끝에 추가:

```python
from services.order_recommendation_calc import calc_change_and_rate


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
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && python -m pytest tests/test_order_recommendation_calc.py -v`
Expected: FAIL — `calc_change_and_rate`가 아직 없어 ImportError.

- [ ] **Step 3: 구현 추가**

`backend/services/order_recommendation_calc.py` 파일 끝에 추가:

```python
def calc_change_and_rate(today_value, previous_value):
    if today_value is None or previous_value is None:
        return None, None
    change = today_value - previous_value
    if previous_value == 0:
        return change, None
    return change, change / previous_value
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && python -m pytest tests/test_order_recommendation_calc.py -v`
Expected: PASS (25개 테스트 전부)

- [ ] **Step 5: 커밋**

```bash
git add backend/services/order_recommendation_calc.py backend/tests/test_order_recommendation_calc.py
git commit -m "feat: add reference-signal change/change-rate calculation"
```

---

### Task 6: 계산 오케스트레이터 (`compute_row`/`compute_all`) — 순서 무관성 통합 테스트 포함

**Files:**
- Modify: `backend/services/order_recommendation_calc.py`
- Modify: `backend/tests/test_order_recommendation_calc.py`

**Interfaces:**
- Consumes: Task 1~5의 모든 `calc_*` 함수, `get_row`/`previous_date` (구현부).
  테스트 코드는 행을 미리 만들기 위해 `ensure_row`도 함께 쓴다.
- Produces:
  - `DEFAULT_BLEND_RATIO = 0.4`, `DEFAULT_COVERAGE_DAYS = 1.0`,
    `DEFAULT_SAFETY_STOCK_QTY = 0.0` 상수.
  - `compute_row(conn, yusas_code: str, date: str, get_setting) -> None` — 행이
    없으면 아무것도 안 함(컬렉터로 아직 값이 안 들어온 상품은 계산 대상 아님).
    있으면 위 계산 함수들을 순서대로 실행해 해당 행을 UPDATE하고 커밋.
    `get_setting(key: str) -> str | None` — `order_recommendation_blend_ratio`,
    `order_recommendation_coverage_days`, `order_recommendation_safety_stock_qty`
    3개 키를 조회, 없으면 기본값 사용.
  - `compute_all(get_db, date: str, get_setting) -> int` — 그 날짜에 이미 존재하는
    모든 `yusas_code`에 대해 `compute_row` 실행, 처리한 행 수 반환.

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_order_recommendation_calc.py` 끝에 추가:

```python
from services.order_recommendation_calc import compute_all, compute_row


def _seed_weekday_history(conn, code, dates_and_qty):
    for date, qty in dates_and_qty:
        _seed(conn, date, code, sales_qty=qty)


def test_compute_row_full_pipeline_with_default_settings():
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    conn = get_db()
    code = "YUSAS00001"

    _seed_weekday_history(conn, code, [
        ("2026-07-22", 10), ("2026-07-15", 10), ("2026-07-08", 10), ("2026-07-01", 10),
    ])
    ensure_row(conn, "2026-07-28", code)
    conn.execute(
        "UPDATE order_recommendation_daily SET sales_qty = 12, weekday_average_sales = 8 "
        "WHERE date = ? AND yusas_code = ?",
        ("2026-07-28", code),
    )
    ensure_row(conn, "2026-07-29", code)
    conn.execute(
        "UPDATE order_recommendation_daily SET stock_qty = 5, incoming_qty = 3 "
        "WHERE date = ? AND yusas_code = ?",
        ("2026-07-29", code),
    )
    conn.commit()

    compute_row(conn, code, "2026-07-29", get_setting=lambda key: None)

    row = get_row(conn, "2026-07-29", code)
    assert row["weekday_average_sales"] == 10.0
    assert row["previous_day_sales_qty"] == 12
    assert row["previous_day_sales_ratio"] == 1.5
    assert row["expected_sales_today"] == 12.0  # 10 * 1.2
    assert row["recommended_qty"] == 4  # ceil(12)-5-3
    conn.close()


def test_compute_row_respects_custom_settings():
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    conn = get_db()
    code = "YUSAS00001"

    _seed_weekday_history(conn, code, [
        ("2026-07-22", 10), ("2026-07-15", 10), ("2026-07-08", 10), ("2026-07-01", 10),
    ])
    ensure_row(conn, "2026-07-28", code)
    conn.execute(
        "UPDATE order_recommendation_daily SET sales_qty = 12, weekday_average_sales = 8 "
        "WHERE date = ? AND yusas_code = ?",
        ("2026-07-28", code),
    )
    ensure_row(conn, "2026-07-29", code)
    conn.execute(
        "UPDATE order_recommendation_daily SET stock_qty = 5, incoming_qty = 3 "
        "WHERE date = ? AND yusas_code = ?",
        ("2026-07-29", code),
    )
    conn.commit()

    settings = {
        "order_recommendation_blend_ratio": "0.5",
        "order_recommendation_coverage_days": "2",
        "order_recommendation_safety_stock_qty": "1",
    }
    compute_row(conn, code, "2026-07-29", get_setting=lambda key: settings.get(key))

    row = get_row(conn, "2026-07-29", code)
    assert row["expected_sales_today"] == 12.5  # 10 * (1 + 0.5*0.5)
    assert row["recommended_qty"] == 18  # ceil(25+1)-5-3
    conn.close()


def test_compute_row_recommended_qty_null_when_stock_missing():
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    conn = get_db()
    code = "YUSAS00001"
    _seed_weekday_history(conn, code, [
        ("2026-07-22", 10), ("2026-07-15", 10), ("2026-07-08", 10), ("2026-07-01", 10),
    ])
    ensure_row(conn, "2026-07-29", code)  # stock_qty/incoming_qty 둘 다 NULL
    conn.commit()

    compute_row(conn, code, "2026-07-29", get_setting=lambda key: None)

    row = get_row(conn, "2026-07-29", code)
    assert row["expected_sales_today"] == 10.0  # ratio 기본 1.0 -> flow_adjustment 1.0
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
    """D+1을 계산하기 전에 D를 먼저 계산했는지 여부와 무관하게, D+1의 결과는
    항상 같아야 한다 (previous_day_sales_ratio가 캐시에만 의존하면 깨지는 시나리오)."""
    code = "YUSAS00001"

    def _seed_both_days(conn):
        # D=2026-07-29(수) 요일 이력
        _seed_weekday_history(conn, code, [
            ("2026-07-22", 10), ("2026-07-15", 10), ("2026-07-08", 10), ("2026-07-01", 10),
        ])
        # D+1=2026-07-30(목) 요일 이력
        _seed_weekday_history(conn, code, [
            ("2026-07-23", 6), ("2026-07-16", 6), ("2026-07-09", 6), ("2026-07-02", 6),
        ])
        ensure_row(conn, "2026-07-29", code)
        conn.execute(
            "UPDATE order_recommendation_daily SET sales_qty = 12, stock_qty = 1, incoming_qty = 0 "
            "WHERE date = ? AND yusas_code = ?",
            ("2026-07-29", code),
        )
        ensure_row(conn, "2026-07-30", code)
        conn.execute(
            "UPDATE order_recommendation_daily SET stock_qty = 1, incoming_qty = 0 "
            "WHERE date = ? AND yusas_code = ?",
            ("2026-07-30", code),
        )
        conn.commit()

    # Run A: D를 먼저 계산한 뒤 D+1 계산
    get_db_a, _keep_alive_a = _make_db_factory()
    init_order_recommendation_tables(get_db_a)
    conn_a = get_db_a()
    _seed_both_days(conn_a)
    compute_row(conn_a, code, "2026-07-29", get_setting=lambda key: None)
    compute_row(conn_a, code, "2026-07-30", get_setting=lambda key: None)
    row_a = get_row(conn_a, "2026-07-30", code)

    # Run B: D는 계산하지 않고 D+1만 바로 계산
    get_db_b, _keep_alive_b = _make_db_factory()
    init_order_recommendation_tables(get_db_b)
    conn_b = get_db_b()
    _seed_both_days(conn_b)
    compute_row(conn_b, code, "2026-07-30", get_setting=lambda key: None)
    row_b = get_row(conn_b, "2026-07-30", code)

    assert row_a["expected_sales_today"] == row_b["expected_sales_today"] == 6.48
    assert row_a["recommended_qty"] == row_b["recommended_qty"] == 6
    conn_a.close()
    conn_b.close()
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && python -m pytest tests/test_order_recommendation_calc.py -v`
Expected: FAIL — `compute_row`/`compute_all`이 아직 없어 ImportError.

- [ ] **Step 3: 오케스트레이터 구현**

`backend/services/order_recommendation_calc.py`의 기존 `from
services.order_recommendation_store import get_row, previous_date` import는
그대로 두고(추가 import 불필요 — `ensure_row`는 이 오케스트레이터에서 쓰지
않는다, 이미 존재하는 행만 계산 대상이므로), 파일 끝에 추가:

```python
DEFAULT_BLEND_RATIO = 0.4
DEFAULT_COVERAGE_DAYS = 1.0
DEFAULT_SAFETY_STOCK_QTY = 0.0


def _setting_float(get_setting, key: str, default: float) -> float:
    raw = get_setting(key)
    if raw is None or str(raw).strip() == "":
        return default
    return float(raw)


def compute_row(conn, yusas_code: str, date: str, get_setting) -> None:
    row = get_row(conn, date, yusas_code)
    if row is None:
        return

    prev_date_str = previous_date(date)
    prev_row = get_row(conn, prev_date_str, yusas_code)
    previous_day_sales_qty = prev_row["sales_qty"] if prev_row is not None else None

    sales_7d, count_7d = calc_sales_window(conn, yusas_code, date, 7)
    sales_14d, _count_14d = calc_sales_window(conn, yusas_code, date, 14)
    avg_sales_7d = (sales_7d / count_7d) if sales_7d is not None and count_7d else None

    weekday_average_sales = calc_weekday_average_sales(conn, yusas_code, date)
    previous_day_sales_ratio = calc_previous_day_sales_ratio(conn, yusas_code, date, previous_day_sales_qty)

    blend_ratio = _setting_float(get_setting, "order_recommendation_blend_ratio", DEFAULT_BLEND_RATIO)
    coverage_days = _setting_float(get_setting, "order_recommendation_coverage_days", DEFAULT_COVERAGE_DAYS)
    safety_stock_qty = _setting_float(get_setting, "order_recommendation_safety_stock_qty", DEFAULT_SAFETY_STOCK_QTY)

    expected_sales_today = calc_expected_sales_today(weekday_average_sales, previous_day_sales_ratio, blend_ratio)
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
            sales_7d = ?, sales_14d = ?, avg_sales_7d = ?,
            weekday_average_sales = ?, previous_day_sales_ratio = ?, expected_sales_today = ?,
            recommended_qty = ?,
            ad_budget_change = ?, ad_budget_change_rate = ?,
            wish_count_change = ?, wish_count_change_rate = ?,
            cart_count_change = ?, cart_count_change_rate = ?
        WHERE date = ? AND yusas_code = ?
        """,
        (
            previous_day_sales_qty,
            sales_7d, sales_14d, avg_sales_7d,
            weekday_average_sales, previous_day_sales_ratio, expected_sales_today,
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
Expected: PASS (31개 테스트 전부)

- [ ] **Step 5: 커밋**

```bash
git add backend/services/order_recommendation_calc.py backend/tests/test_order_recommendation_calc.py
git commit -m "feat: add compute_row/compute_all orchestrator with order-independence guarantee"
```

---

### Task 7: 컬렉터 레지스트리 + 화이트리스트 UPSERT (`order_recommendation_collect.py`)

**Files:**
- Create: `backend/services/order_recommendation_collect.py`
- Test: `backend/tests/test_order_recommendation_collect.py`

**Interfaces:**
- Consumes: `services.order_recommendation_store.ensure_row`, `today_kst`.
- Produces:
  - `ALLOWED_COLLECTOR_COLUMNS: set[str]` —
    `{"sales_qty", "stock_qty", "incoming_qty", "ad_budget", "wish_count", "cart_count"}`.
  - `COLLECTORS: dict[str, Callable[[str], Awaitable[dict[str, int]]]]` — 처음엔
    빈 딕셔너리.
  - `register_collector(column: str, fn) -> None` — 화이트리스트 밖 컬럼이면
    `ValueError`.
  - `async def run_collectors(get_db, date: str | None = None) -> dict[str, dict[str, int]]`
    — 등록된 컬렉터를 전부 실행해 `yusas_code`별로 결과를 병합한 뒤, 컬렉터가
    실제로 반환한 컬럼만 하나의 트랜잭션으로 UPSERT. 반환값은 `{yusas_code:
    {column: value}}` (실제로 갱신한 것).

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_order_recommendation_collect.py` 생성:

```python
import asyncio
import sqlite3
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import services.order_recommendation_collect as collect_mod
from services.order_recommendation_collect import (
    ALLOWED_COLLECTOR_COLUMNS,
    register_collector,
    run_collectors,
)
from services.order_recommendation_store import get_row, init_order_recommendation_tables, list_rows


def _make_db_factory():
    uri = f"file:test_order_recommendation_collect_{uuid.uuid4().hex}?mode=memory&cache=shared"
    keep_alive = sqlite3.connect(uri, uri=True)
    keep_alive.row_factory = sqlite3.Row

    def factory():
        conn = sqlite3.connect(uri, uri=True)
        conn.row_factory = sqlite3.Row
        return conn

    return factory, keep_alive


def _reset_collectors():
    collect_mod.COLLECTORS.clear()


def test_register_collector_rejects_column_not_in_whitelist():
    _reset_collectors()
    try:
        raised = False
        try:
            register_collector("recommended_qty", lambda date: None)
        except ValueError:
            raised = True
        assert raised
    finally:
        _reset_collectors()


def test_register_collector_allows_whitelisted_column():
    _reset_collectors()
    try:
        async def fake(date):
            return {}

        register_collector("stock_qty", fake)
        assert "stock_qty" in collect_mod.COLLECTORS
        assert ALLOWED_COLLECTOR_COLUMNS == {
            "sales_qty", "stock_qty", "incoming_qty", "ad_budget", "wish_count", "cart_count",
        }
    finally:
        _reset_collectors()


def test_run_collectors_upserts_only_returned_columns_and_creates_rows():
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    _reset_collectors()
    try:
        async def sales_collector(date):
            return {"YUSAS00001": 5}

        async def stock_collector(date):
            return {"YUSAS00001": 20, "YUSAS00002": 7}

        register_collector("sales_qty", sales_collector)
        register_collector("stock_qty", stock_collector)

        merged = asyncio.run(run_collectors(get_db, "2026-07-29"))
        assert merged == {"YUSAS00001": {"sales_qty": 5, "stock_qty": 20}, "YUSAS00002": {"stock_qty": 7}}

        conn = get_db()
        row1 = get_row(conn, "2026-07-29", "YUSAS00001")
        assert row1["sales_qty"] == 5
        assert row1["stock_qty"] == 20
        assert row1["incoming_qty"] is None
        assert row1["day_of_week"] == 2
        assert row1["created_at"] is not None

        row2 = get_row(conn, "2026-07-29", "YUSAS00002")
        assert row2["stock_qty"] == 7
        assert row2["sales_qty"] is None
        conn.close()
    finally:
        _reset_collectors()


def test_run_collectors_preserves_columns_not_returned_by_any_collector():
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    _reset_collectors()
    try:
        conn = get_db()
        conn.execute(
            "INSERT INTO order_recommendation_daily (date, yusas_code, day_of_week, ad_budget, created_at) "
            "VALUES (?, ?, ?, ?, ?)",
            ("2026-07-29", "YUSAS00001", 2, 100, "2026-07-29T00:00:00+09:00"),
        )
        conn.commit()
        conn.close()

        async def sales_collector(date):
            return {"YUSAS00001": 5}

        register_collector("sales_qty", sales_collector)
        asyncio.run(run_collectors(get_db, "2026-07-29"))

        conn = get_db()
        row = get_row(conn, "2026-07-29", "YUSAS00001")
        assert row["sales_qty"] == 5
        assert row["ad_budget"] == 100
        conn.close()
    finally:
        _reset_collectors()


def test_run_collectors_writes_nothing_when_a_collector_raises():
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    _reset_collectors()
    try:
        async def ok_collector(date):
            return {"YUSAS00001": 5}

        async def failing_collector(date):
            raise RuntimeError("marketplace API down")

        register_collector("sales_qty", ok_collector)
        register_collector("stock_qty", failing_collector)

        raised = False
        try:
            asyncio.run(run_collectors(get_db, "2026-07-29"))
        except RuntimeError:
            raised = True
        assert raised

        conn = get_db()
        assert list_rows(conn, "2026-07-29") == []
        conn.close()
    finally:
        _reset_collectors()
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && python -m pytest tests/test_order_recommendation_collect.py -v`
Expected: FAIL — `services.order_recommendation_collect` 모듈이 아직 없어
ImportError.

- [ ] **Step 3: `backend/services/order_recommendation_collect.py` 구현**

```python
from __future__ import annotations

from services.order_recommendation_store import ensure_row, today_kst

ALLOWED_COLLECTOR_COLUMNS = {
    "sales_qty", "stock_qty", "incoming_qty", "ad_budget", "wish_count", "cart_count",
}

COLLECTORS: dict = {}


def register_collector(column: str, fn) -> None:
    if column not in ALLOWED_COLLECTOR_COLUMNS:
        raise ValueError(f"컬렉터는 화이트리스트 컬럼만 등록할 수 있습니다: {column}")
    COLLECTORS[column] = fn


async def run_collectors(get_db, date: str | None = None) -> dict:
    target_date = date or today_kst()

    results: dict = {}
    for column, collector in COLLECTORS.items():
        results[column] = await collector(target_date)

    merged: dict = {}
    for column, values in results.items():
        for yusas_code, value in values.items():
            merged.setdefault(yusas_code, {})[column] = value

    conn = get_db()
    try:
        for yusas_code, columns in merged.items():
            ensure_row(conn, target_date, yusas_code)
            set_clause = ", ".join(f"{col} = ?" for col in columns)
            params = list(columns.values()) + [target_date, yusas_code]
            conn.execute(
                f"UPDATE order_recommendation_daily SET {set_clause} WHERE date = ? AND yusas_code = ?",
                params,
            )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

    return merged
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && python -m pytest tests/test_order_recommendation_collect.py -v`
Expected: PASS (5개 테스트 전부)

- [ ] **Step 5: 커밋**

```bash
git add backend/services/order_recommendation_collect.py backend/tests/test_order_recommendation_collect.py
git commit -m "feat: add whitelisted collector registry with transactional upsert"
```

---

### Task 8: API 라우터 (`order_recommendation_routes.py`)

**Files:**
- Create: `backend/api/order_recommendation_routes.py`
- Test: `backend/tests/test_order_recommendation_routes.py`

**Interfaces:**
- Consumes: `build_order_recommendation_router(*, get_current_user, get_db, get_setting)`
  — 기존 라우터들과 동일한 의존성 주입 패턴(`backend/main.py`가 `_get_current_user`/
  `_get_shared_db`/`_get_setting`을 넘겨줌).
- Produces: `POST /order-recommendation/collect`, `POST
  /order-recommendation/compute`, `GET /order-recommendation/daily`, `POST
  /order-recommendation/{date}/{yusas_code}/confirm` — 4개 엔드포인트.

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_order_recommendation_routes.py` 생성:

```python
import sqlite3
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import FastAPI
from fastapi.testclient import TestClient

import services.order_recommendation_collect as collect_mod
from api.order_recommendation_routes import build_order_recommendation_router
from services.order_recommendation_store import ensure_row, init_order_recommendation_tables


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

    app = FastAPI()
    app.include_router(
        build_order_recommendation_router(
            get_current_user=lambda: "tester",
            get_db=get_db,
            get_setting=lambda key: (settings or {}).get(key),
        )
    )
    return TestClient(app), get_db, keep_alive


def test_daily_returns_empty_list_initially():
    client, _get_db, _keep_alive = _make_client()
    res = client.get("/order-recommendation/daily", params={"date": "2026-07-29"})
    assert res.status_code == 200
    assert res.json() == {"ok": True, "date": "2026-07-29", "items": []}


def test_confirm_creates_row_and_sets_confirmed_fields():
    client, get_db, _keep_alive = _make_client()
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


def test_compute_endpoint_fills_recommended_qty_for_existing_rows():
    client, get_db, _keep_alive = _make_client()
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
    assert row["recommended_qty"] == 10


def test_collect_endpoint_invokes_registered_collectors():
    client, get_db, _keep_alive = _make_client()
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
    client, _get_db, _keep_alive = _make_client()
    collect_mod.COLLECTORS.clear()
    res = client.post("/order-recommendation/collect", params={"date": "2026-07-29"})
    assert res.status_code == 200
    assert res.json()["updated_codes"] == []
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && python -m pytest tests/test_order_recommendation_routes.py -v`
Expected: FAIL — `api.order_recommendation_routes` 모듈이 아직 없어 ImportError.

- [ ] **Step 3: `backend/api/order_recommendation_routes.py` 구현**

```python
from __future__ import annotations

from fastapi import APIRouter, Body, Depends

from services.order_recommendation_calc import compute_all
from services.order_recommendation_collect import run_collectors
from services.order_recommendation_store import ensure_row, list_rows, now_kst_iso, today_kst


def _row_to_dict(row) -> dict:
    return {key: row[key] for key in row.keys()}


def build_order_recommendation_router(*, get_current_user, get_db, get_setting):
    router = APIRouter(prefix="/order-recommendation", tags=["order-recommendation"])

    @router.post("/collect")
    async def collect(date: str | None = None, user: str = Depends(get_current_user)):
        target_date = date or today_kst()
        merged = await run_collectors(get_db, target_date)
        return {"ok": True, "date": target_date, "updated_codes": sorted(merged.keys())}

    @router.post("/compute")
    def compute(date: str | None = None, user: str = Depends(get_current_user)):
        target_date = date or today_kst()
        count = compute_all(get_db, target_date, get_setting)
        return {"ok": True, "date": target_date, "computed": count}

    @router.get("/daily")
    def daily(date: str | None = None, user: str = Depends(get_current_user)):
        target_date = date or today_kst()
        conn = get_db()
        try:
            rows = list_rows(conn, target_date)
            return {"ok": True, "date": target_date, "items": [_row_to_dict(r) for r in rows]}
        finally:
            conn.close()

    @router.post("/{date}/{yusas_code}/confirm")
    def confirm(
        date: str,
        yusas_code: str,
        payload: dict = Body(...),
        user: str = Depends(get_current_user),
    ):
        confirmed_qty = payload.get("confirmed_qty")
        override_reason = payload.get("override_reason")
        conn = get_db()
        try:
            ensure_row(conn, date, yusas_code)
            conn.execute(
                """
                UPDATE order_recommendation_daily
                SET confirmed_qty = ?, override_reason = ?, updated_by = ?, updated_at = ?
                WHERE date = ? AND yusas_code = ?
                """,
                (confirmed_qty, override_reason, user, now_kst_iso(), date, yusas_code),
            )
            conn.commit()
        finally:
            conn.close()
        return {"ok": True}

    return router
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && python -m pytest tests/test_order_recommendation_routes.py -v`
Expected: PASS (5개 테스트 전부)

- [ ] **Step 5: 커밋**

```bash
git add backend/api/order_recommendation_routes.py backend/tests/test_order_recommendation_routes.py
git commit -m "feat: add order-recommendation API router"
```

---

### Task 9: `backend/main.py`에 연결

**Files:**
- Modify: `backend/main.py`

**Interfaces:**
- Consumes: Task 1의 `init_order_recommendation_tables`, Task 8의
  `build_order_recommendation_router`, 기존 `_get_shared_db`, `_get_current_user`,
  `_get_setting`.

- [ ] **Step 1: import 추가**

`backend/main.py`에서 `from api.inventory_dashboard_routes import
build_inventory_dashboard_router` 줄 바로 아래에 추가:

```python
from api.order_recommendation_routes import build_order_recommendation_router
from services.order_recommendation_store import init_order_recommendation_tables
```

- [ ] **Step 2: 테이블 초기화 호출 추가**

`backend/main.py`의 `_init_request_attachments()` 호출부(약 838번째 줄,
`_init_app_settings()` 다음) 바로 아래에 추가:

```python
init_order_recommendation_tables(_get_shared_db)
```

- [ ] **Step 3: 라우터 등록 추가**

`backend/main.py`에서 `app.include_router(build_inventory_dashboard_router(...))`
블록(약 1411~1418번째 줄) 바로 아래에 추가:

```python
app.include_router(
    build_order_recommendation_router(
        get_current_user=_get_current_user,
        get_db=_get_shared_db,
        get_setting=_get_setting,
    )
)
```

- [ ] **Step 4: import 정상 동작 확인**

Run: `cd backend && python -c "import main; print('main imported OK')"`
Expected: `main imported OK` 출력, 에러 없음.

- [ ] **Step 5: 전체 테스트 통과 확인**

Run: `cd backend && python -m pytest tests/ -k order_recommendation -v`
Expected: PASS (Task 1~8에서 작성한 테스트 전부, store 7 + calc 31 + collect 5 + routes 5 = 총 48개)

- [ ] **Step 6: 커밋**

```bash
git add backend/main.py
git commit -m "feat: wire order-recommendation router and table init into main.py"
```

---

## 최종 확인

- [ ] `cd backend && python -m pytest tests/ -k order_recommendation -v` 전체 PASS
- [ ] `cd backend && python -c "import main"` 에러 없음
- [ ] 스펙(`docs/superpowers/specs/2026-07-29-order-recommendation-pipeline-design.md`)의
      5개 리뷰 반영 사항(데이터 누수 방지, 순서 무관 ratio, ceil 반올림, KST 고정,
      화이트리스트+트랜잭션 UPSERT) 전부 테스트로 커버됐는지 재확인.
