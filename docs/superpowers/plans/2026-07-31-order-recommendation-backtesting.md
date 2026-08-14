# 발주 대시보드 백테스팅 섹션 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 발주 대시보드에 백테스팅 섹션을 추가해, 과거 특정 날짜의 예상판매량을 현재(또는 실험용) 가중치로 재계산해 실제 판매량과 비교하고, 마음에 드는 가중치는 저장할 수 있게 한다.

**Architecture:** `compute_row`가 이미 하던 "예상판매량 계산" 블록을 `calc_expected_sales_today_for_date()`로 뽑아내 DB 저장 없이도 호출 가능하게 만들고, 신규 `GET /backtest` 엔드포인트가 이를 재사용해 과거 날짜×오늘의 추천발주 대상 상품에 대해 즉석 계산 후 실제 `sales_qty`와 비교한다. 가중치 저장은 별도 `POST /weights` 엔드포인트.

**Tech Stack:** FastAPI + sqlite3 (backend), React + CSS Modules (frontend), pytest + TestClient.

## Global Constraints

- DB에 아무것도 쓰지 않음(`GET /backtest`는 순수 조회) — `POST /weights`만 설정 테이블에 씀.
- 대상 상품: 오늘 `recommended_qty IS NOT NULL`인 상품만 (일별 데이터 테이블과 동일 표본).
- 가중치 조정은 미리보기 전용 — 저장 버튼을 눌러야만 실제 설정(`order_recommendation_weight_*`)에 반영.
- 날짜 선택기: 기본 어제, 최근 28일 이전 선택 불가.
- 프론트엔드 자동 테스트 없음 — `npm run build`로 컴파일만 확인, 동작은 사용자가 dev 서버에서 직접 확인 (dev 서버를 직접 켜거나 끄지 않는다).

---

### Task 1: 백엔드 — 예상판매량 계산 로직 추출 + 재사용

**Files:**
- Modify: `backend/services/order_recommendation_calc.py`
- Test: `backend/tests/test_order_recommendation_calc.py`

**Interfaces:**
- Produces: `calc_expected_sales_today_for_date(conn, yusas_code: str, date: str, get_setting, weight_overrides: dict | None = None) -> dict` — 반환 딕셔너리 키:
  `previous_day_sales_qty, sales_3d, sales_7d, sales_14d, avg_sales_3d, avg_sales_7d, avg_sales_14d, weekday_average_sales, expected_sales_today, weight_weekday_average, weight_previous_day, weight_avg_7d, weight_avg_14d, weight_avg_3d`.
  `weight_overrides`는 `{"weight_weekday_average": 0.3, ...}` 형태(5개 키 전부 선택적), 값이 있으면(0.0 포함) 설정값 대신 그 값을 씀.

- [ ] **Step 1: 실패하는 테스트 작성 (기존 시나리오와 값이 일치하는지)**

`backend/tests/test_order_recommendation_calc.py`에서 `from services.order_recommendation_calc import compute_all, compute_row` 임포트 라인 바로 아래(`_seed_weekday_history`/`_seed_full_pipeline_scenario` 정의 다음, `test_compute_row_full_pipeline_with_default_settings` 함수 앞)에 추가:

```python
from services.order_recommendation_calc import calc_expected_sales_today_for_date


def test_calc_expected_sales_today_for_date_matches_known_scenario():
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    conn = get_db()
    code = "YUSAS00001"
    _seed_full_pipeline_scenario(conn, code)
    conn.commit()

    result = calc_expected_sales_today_for_date(conn, code, "2026-07-29", get_setting=lambda key: None)

    assert result["weekday_average_sales"] == pytest.approx(34 / 3)
    assert result["avg_sales_3d"] == pytest.approx(40 / 3)
    assert result["avg_sales_7d"] == pytest.approx(12.0)
    assert result["avg_sales_14d"] == pytest.approx(11.0)
    assert result["previous_day_sales_qty"] == 20
    assert result["expected_sales_today"] == pytest.approx(13.983333333333333)
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
    # (34/3*.20 + 20*.25 + 12*.20 + 11*.15) / .80 = 14.145833333333332
    # (buggy `override or default` 패턴이었다면 0.0이 falsy라 기본값 0.20으로 폴백해서
    #  13.983333333333333 — 원래 시나리오 값 — 이 나왔을 것)
    assert result["expected_sales_today"] == pytest.approx(14.145833333333332)
    assert result["weight_avg_3d"] == 0.0
    conn.close()
```

이 코드는 `services/order_recommendation_calc.py`에 위 함수를 정의하기 전이라 `ImportError`로 실패한다.

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && python -m pytest tests/test_order_recommendation_calc.py -k "calc_expected_sales_today_for_date" -v`
Expected: FAIL — `ImportError: cannot import name 'calc_expected_sales_today_for_date'`

- [ ] **Step 3: `calc_expected_sales_today_for_date` 구현**

`backend/services/order_recommendation_calc.py`에서 `compute_row` 함수(185번째 줄) 바로 앞에 추가:

```python
def calc_expected_sales_today_for_date(
    conn, yusas_code: str, date: str, get_setting, weight_overrides: dict | None = None
) -> dict:
    """date 기준으로 그 이전 데이터만 사용해 예상판매량을 계산한다.
    compute_row와 백테스트가 공유하는 순수 계산 함수 — DB에 아무것도 쓰지 않는다.

    weight_overrides에 값이 있으면(0.0 포함) 설정값 대신 그 값을 쓴다(백테스트 미리보기용)."""
    prev_date_str = previous_date(date)
    prev_row = get_row(conn, prev_date_str, yusas_code)
    previous_day_sales_qty = prev_row["sales_qty"] if prev_row is not None else None

    sales_3d, count_3d = calc_sales_window(conn, yusas_code, date, 3)
    sales_7d, count_7d = calc_sales_window(conn, yusas_code, date, 7)
    sales_14d, count_14d = calc_sales_window(conn, yusas_code, date, 14)
    avg_sales_3d = (sales_3d / count_3d) if sales_3d is not None and count_3d else None
    avg_sales_7d = (sales_7d / count_7d) if sales_7d is not None and count_7d else None
    avg_sales_14d = (sales_14d / count_14d) if sales_14d is not None and count_14d else None

    weekday_average_sales = calc_weekday_average_sales(conn, yusas_code, date)

    def _weight(key: str, setting_key: str, default: float) -> float:
        override = (weight_overrides or {}).get(key)
        if override is not None:
            return override
        return _setting_weight(get_setting, setting_key, default)

    weight_weekday_average = _weight(
        "weight_weekday_average", "order_recommendation_weight_weekday_average", DEFAULT_WEIGHT_WEEKDAY_AVERAGE
    )
    weight_previous_day = _weight(
        "weight_previous_day", "order_recommendation_weight_previous_day", DEFAULT_WEIGHT_PREVIOUS_DAY
    )
    weight_avg_7d = _weight("weight_avg_7d", "order_recommendation_weight_avg_7d", DEFAULT_WEIGHT_AVG_7D)
    weight_avg_14d = _weight("weight_avg_14d", "order_recommendation_weight_avg_14d", DEFAULT_WEIGHT_AVG_14D)
    weight_avg_3d = _weight("weight_avg_3d", "order_recommendation_weight_avg_3d", DEFAULT_WEIGHT_AVG_3D)

    expected_sales_today = calc_expected_sales_today(
        weekday_average_sales, previous_day_sales_qty, avg_sales_7d, avg_sales_14d,
        weight_weekday_average, weight_previous_day, weight_avg_7d, weight_avg_14d,
        avg_sales_3d, weight_avg_3d,
    )

    return {
        "previous_day_sales_qty": previous_day_sales_qty,
        "sales_3d": sales_3d, "sales_7d": sales_7d, "sales_14d": sales_14d,
        "avg_sales_3d": avg_sales_3d, "avg_sales_7d": avg_sales_7d, "avg_sales_14d": avg_sales_14d,
        "weekday_average_sales": weekday_average_sales,
        "expected_sales_today": expected_sales_today,
        "weight_weekday_average": weight_weekday_average,
        "weight_previous_day": weight_previous_day,
        "weight_avg_7d": weight_avg_7d,
        "weight_avg_14d": weight_avg_14d,
        "weight_avg_3d": weight_avg_3d,
    }
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && python -m pytest tests/test_order_recommendation_calc.py -k "calc_expected_sales_today_for_date" -v`
Expected: PASS (2건)

- [ ] **Step 5: `compute_row`가 새 함수를 재사용하도록 리팩터링**

`backend/services/order_recommendation_calc.py`의 `compute_row` 함수(190~226번째 줄 부분, "prev_date_str = previous_date(date)"부터 "coverage_period_expected_sales = calc_expected_sales_for_coverage(...)" 호출까지)를 다음으로 교체:

```python
def compute_row(conn, yusas_code: str, date: str, get_setting) -> None:
    row = get_row(conn, date, yusas_code)
    if row is None:
        return

    signals = calc_expected_sales_today_for_date(conn, yusas_code, date, get_setting)

    prev_date_str = previous_date(date)
    prev_row = get_row(conn, prev_date_str, yusas_code)

    coverage_days = _setting_float(get_setting, "order_recommendation_coverage_days", DEFAULT_COVERAGE_DAYS)
    safety_stock_qty = _setting_float(get_setting, "order_recommendation_safety_stock_qty", DEFAULT_SAFETY_STOCK_QTY)

    coverage_period_expected_sales = calc_expected_sales_for_coverage(
        conn, yusas_code, date, coverage_days,
        signals["previous_day_sales_qty"], signals["avg_sales_7d"], signals["avg_sales_14d"],
        signals["weight_weekday_average"], signals["weight_previous_day"],
        signals["weight_avg_7d"], signals["weight_avg_14d"],
        signals["avg_sales_3d"], signals["weight_avg_3d"],
    )
    recommended_qty = calc_recommended_qty(
        coverage_period_expected_sales, row["stock_qty"], row["incoming_qty"], safety_stock_qty
    )

    prev_ad_budget = prev_row["ad_budget"] if prev_row is not None else None
    prev_wish_count = prev_row["wish_count"] if prev_row is not None else None
    prev_cart_count = prev_row["cart_count"] if prev_row is not None else None
    ad_budget_change, ad_budget_change_rate = calc_change_and_rate(row["ad_budget"], prev_ad_budget)
    wish_count_change, wish_count_change_rate = calc_change_and_rate(row["wish_count"], prev_wish_count)
    cart_count_change, cart_count_change_rate = calc_change_and_rate(row["cart_count"], prev_cart_count)

    prev_incoming_qty = prev_row["incoming_qty"] if prev_row is not None else None
    incoming_qty_change, incoming_qty_change_rate = calc_change_and_rate(row["incoming_qty"], prev_incoming_qty)

    conn.execute(
        """
        UPDATE order_recommendation_daily SET
            previous_day_sales_qty = ?,
            sales_3d = ?, sales_7d = ?, sales_14d = ?,
            avg_sales_3d = ?, avg_sales_7d = ?, avg_sales_14d = ?,
            weekday_average_sales = ?, expected_sales_today = ?,
            model_version = ?, model_weight_weekday = ?, model_weight_previous_day = ?,
            model_weight_avg_7d = ?, model_weight_avg_14d = ?, model_weight_avg_3d = ?,
            recommended_qty = ?,
            ad_budget_change = ?, ad_budget_change_rate = ?,
            wish_count_change = ?, wish_count_change_rate = ?,
            cart_count_change = ?, cart_count_change_rate = ?,
            incoming_qty_change = ?, incoming_qty_change_rate = ?
        WHERE date = ? AND yusas_code = ?
        """,
        (
            signals["previous_day_sales_qty"],
            signals["sales_3d"], signals["sales_7d"], signals["sales_14d"],
            signals["avg_sales_3d"], signals["avg_sales_7d"], signals["avg_sales_14d"],
            signals["weekday_average_sales"], signals["expected_sales_today"],
            MODEL_VERSION, signals["weight_weekday_average"], signals["weight_previous_day"],
            signals["weight_avg_7d"], signals["weight_avg_14d"], signals["weight_avg_3d"],
            recommended_qty,
            ad_budget_change, ad_budget_change_rate,
            wish_count_change, wish_count_change_rate,
            cart_count_change, cart_count_change_rate,
            incoming_qty_change, incoming_qty_change_rate,
            date, yusas_code,
        ),
    )
    conn.commit()
```

- [ ] **Step 6: 회귀 확인 (기존 compute_row 테스트가 전부 그대로 통과해야 함)**

Run: `cd backend && python -m pytest tests/test_order_recommendation_calc.py -v`
Expected: 전체 PASS (기존 `test_compute_row_*` 테스트들이 리팩터링 전과 동일한 값을 검증하므로, 하나라도 실패하면 리팩터링이 동작을 바꾼 것 — 원인을 찾아 고칠 것)

- [ ] **Step 7: 커밋**

```bash
cd "yusaek-main"
git add backend/services/order_recommendation_calc.py backend/tests/test_order_recommendation_calc.py
git commit -m "refactor: extract calc_expected_sales_today_for_date for reuse in backtesting"
```

---

### Task 2: 백엔드 — `GET /order-recommendation/backtest`

**Files:**
- Modify: `backend/api/order_recommendation_routes.py`
- Test: `backend/tests/test_order_recommendation_routes.py`

**Interfaces:**
- Consumes: Task 1의 `calc_expected_sales_today_for_date(conn, yusas_code, date, get_setting, weight_overrides=None) -> dict`; `order_recommendation_evaluate.py`의 `calc_forecast_error(expected, actual) -> float | None`, `calc_within_20_percent(absolute_error, actual) -> int | None`
- Produces: `GET /order-recommendation/backtest?date=&weight_weekday_average=&weight_previous_day=&weight_avg_7d=&weight_avg_14d=&weight_avg_3d=` — 응답 `{"ok": true, "date": ..., "sample_count": ..., "mae": ..., "wape": ..., "hit_rate_20pct": ..., "items": [{"yusas_code", "product_name", "expected_sales_today", "actual_sales_qty", "forecast_error", "within_20_percent"}, ...]}`

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_order_recommendation_routes.py`의 `test_confirm_creates_row_and_sets_confirmed_fields` 함수 뒤(또는 파일 임의 위치, 다른 테스트들과 나란히)에 추가:

```python
def test_backtest_returns_items_only_for_products_with_recommended_qty_today():
    client, get_db, _keep_alive = _make_client()
    conn = get_db()
    today = today_kst()

    # 오늘 추천발주량 있는 상품 -> 백테스트 대상
    ensure_row(conn, today, "YUSAS00001")
    conn.execute(
        "UPDATE order_recommendation_daily SET recommended_qty = 5 WHERE date = ? AND yusas_code = ?",
        (today, "YUSAS00001"),
    )
    # 오늘 추천발주량 없는 상품 -> 백테스트 대상 아님
    ensure_row(conn, today, "YUSAS00002")

    # 백테스트 대상 날짜의 실제 판매량
    ensure_row(conn, "2026-07-29", "YUSAS00001")
    conn.execute(
        "UPDATE order_recommendation_daily SET sales_qty = 10 WHERE date = ? AND yusas_code = ?",
        ("2026-07-29", "YUSAS00001"),
    )
    conn.commit()
    conn.close()

    res = client.get("/order-recommendation/backtest", params={"date": "2026-07-29"})
    assert res.status_code == 200
    body = res.json()
    assert body["date"] == "2026-07-29"
    assert len(body["items"]) == 1
    assert body["items"][0]["yusas_code"] == "YUSAS00001"
    assert body["items"][0]["actual_sales_qty"] == 10


def test_backtest_applies_weight_overrides_and_computes_aggregate():
    client, get_db, _keep_alive = _make_client()
    conn = get_db()
    today = today_kst()

    ensure_row(conn, today, "YUSAS00001")
    conn.execute(
        "UPDATE order_recommendation_daily SET recommended_qty = 5 WHERE date = ? AND yusas_code = ?",
        (today, "YUSAS00001"),
    )
    # 전날 판매량만 있는 단순 시나리오: previous_day_sales_qty=10, 나머지 신호는 그 값도 포함하는 창이라 결국 10
    ensure_row(conn, "2026-07-28", "YUSAS00001")
    conn.execute(
        "UPDATE order_recommendation_daily SET sales_qty = 10 WHERE date = ? AND yusas_code = ?",
        ("2026-07-28", "YUSAS00001"),
    )
    ensure_row(conn, "2026-07-29", "YUSAS00001")
    conn.execute(
        "UPDATE order_recommendation_daily SET sales_qty = 10 WHERE date = ? AND yusas_code = ?",
        ("2026-07-29", "YUSAS00001"),
    )
    conn.commit()
    conn.close()

    # weight_previous_day=1, 나머지 0 -> 신호가 전날값(10)만 남아 expected_sales_today == 10 -> 오차 0 -> 적중
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
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && python -m pytest tests/test_order_recommendation_routes.py -k backtest -v`
Expected: FAIL — `404 Not Found` (엔드포인트 없음)

- [ ] **Step 3: 엔드포인트 구현**

`backend/api/order_recommendation_routes.py` 상단 import 블록에 추가:

```python
from services.order_recommendation_calc import calc_expected_sales_today_for_date, compute_all
from services.order_recommendation_evaluate import calc_forecast_error, calc_within_20_percent
```

(`compute_all`은 이미 임포트돼 있으므로 같은 줄에 `calc_expected_sales_today_for_date`만 추가하면 됨. `calc_forecast_error, calc_within_20_percent`는 신규 import 라인 추가.)

`/order-performance` 핸들러(`order_performance`, `@router.get("/order-performance")`) 함수 뒤에 추가:

```python
    @router.get("/backtest")
    def backtest(
        date: str,
        weight_weekday_average: float | None = None,
        weight_previous_day: float | None = None,
        weight_avg_7d: float | None = None,
        weight_avg_14d: float | None = None,
        weight_avg_3d: float | None = None,
        user: str = Depends(get_current_user),
    ):
        overrides = {
            "weight_weekday_average": weight_weekday_average,
            "weight_previous_day": weight_previous_day,
            "weight_avg_7d": weight_avg_7d,
            "weight_avg_14d": weight_avg_14d,
            "weight_avg_3d": weight_avg_3d,
        }
        overrides = {k: v for k, v in overrides.items() if v is not None}

        conn = get_db()
        try:
            today = today_kst()
            codes = [
                r["yusas_code"]
                for r in conn.execute(
                    "SELECT yusas_code FROM order_recommendation_daily "
                    "WHERE date = ? AND recommended_qty IS NOT NULL",
                    (today,),
                ).fetchall()
            ]
            name_map = load_wonbe_product_name_map()

            items = []
            for code in codes:
                signals = calc_expected_sales_today_for_date(
                    conn, code, date, get_setting, overrides or None
                )
                expected = signals["expected_sales_today"]
                row = get_row(conn, date, code)
                actual = row["sales_qty"] if row is not None else None
                forecast_error = calc_forecast_error(expected, actual)
                absolute_error = abs(forecast_error) if forecast_error is not None else None
                within_20_percent = calc_within_20_percent(absolute_error, actual)
                items.append({
                    "yusas_code": code,
                    "product_name": name_map.get(code, ""),
                    "expected_sales_today": expected,
                    "actual_sales_qty": actual,
                    "forecast_error": forecast_error,
                    "within_20_percent": within_20_percent,
                })

            abs_errors = [abs(i["forecast_error"]) for i in items if i["forecast_error"] is not None]
            actuals = [i["actual_sales_qty"] for i in items if i["forecast_error"] is not None]
            hit_flags = [i["within_20_percent"] for i in items if i["within_20_percent"] is not None]
            mae = sum(abs_errors) / len(abs_errors) if abs_errors else None
            actual_sum = sum(actuals)
            wape = (sum(abs_errors) / actual_sum) if abs_errors and actual_sum > 0 else None
            hit_rate_20pct = (sum(hit_flags) / len(hit_flags)) if hit_flags else None

            return {
                "ok": True, "date": date,
                "sample_count": len(hit_flags), "mae": mae, "wape": wape,
                "hit_rate_20pct": hit_rate_20pct, "items": items,
            }
        finally:
            conn.close()
```

`get_row`도 `order_recommendation_store` 임포트 라인(`from services.order_recommendation_store import ensure_row, list_rows, now_kst_iso, today_kst`)에 추가해야 한다 — `get_row`를 포함하도록 수정:

```python
from services.order_recommendation_store import ensure_row, get_row, list_rows, now_kst_iso, today_kst
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && python -m pytest tests/test_order_recommendation_routes.py -v`
Expected: 전체 PASS

- [ ] **Step 5: 커밋**

```bash
git add backend/api/order_recommendation_routes.py backend/tests/test_order_recommendation_routes.py
git commit -m "feat: add GET /order-recommendation/backtest endpoint"
```

---

### Task 3: 백엔드 — 가중치 저장 `POST /order-recommendation/weights`

**Files:**
- Modify: `backend/api/order_recommendation_routes.py`
- Modify: `backend/main.py`
- Test: `backend/tests/test_order_recommendation_routes.py`

**Interfaces:**
- Produces: `POST /order-recommendation/weights` — body `{"weight_weekday_average": 0.3, ...}` (5개 키 전부 선택적), 저장되는 설정 키는 `order_recommendation_{key}` 형태.

- [ ] **Step 1: 실패하는 테스트 작성**

`test_order_recommendation_routes.py`의 `_make_client` 함수를 `set_setting`도 주입하도록 확장해야 한다. 기존 `_make_client`를 다음으로 교체:

```python
def _make_client(settings=None):
    get_db, keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    store = dict(settings or {})

    app = FastAPI()
    app.include_router(
        build_order_recommendation_router(
            get_current_user=lambda: "tester",
            get_db=get_db,
            get_setting=lambda key: store.get(key),
            set_setting=lambda key, value: store.__setitem__(key, value),
        )
    )
    return TestClient(app), get_db, keep_alive, store
```

(`store`를 네 번째 반환값으로 추가했으므로, 기존에 `client, get_db, _keep_alive = _make_client()`로 3개만 받던 호출부 14곳이 전부 깨진다.)

파일 안에서 정확히 이 두 패턴을 찾아서(에디터 찾아바꾸기, 전체 일치) 각각 교체한다:

찾기: `client, get_db, _keep_alive = _make_client()`
바꾸기: `client, get_db, _keep_alive, _store = _make_client()`
(9곳: 68, 85, 103, 120, 147, 173, 195, 216, 238번째 줄)

찾기: `client, _get_db, _keep_alive = _make_client()`
바꾸기: `client, _get_db, _keep_alive, _store = _make_client()`
(5곳: 61, 165, 259, 274, 287번째 줄)

줄번호는 `store` 반환값 추가 직후 `grep -n "_make_client(" backend/tests/test_order_recommendation_routes.py`로
재확인할 것 — 이 계획 작성 시점 기준이라 그 사이 파일이 바뀌었으면 달라질 수 있음.

파일 끝에 추가:

```python
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
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && python -m pytest tests/test_order_recommendation_routes.py -v`
Expected: FAIL — `_make_client()`가 아직 `set_setting`을 안 받아서 `build_order_recommendation_router` 호출 시 `TypeError`, 또는 새 테스트 2건이 `404`로 실패

- [ ] **Step 3: `build_order_recommendation_router`에 `set_setting` 파라미터 추가 + 엔드포인트 구현**

`backend/api/order_recommendation_routes.py`의 라우터 정의부:

```python
def build_order_recommendation_router(*, get_current_user, get_db, get_setting, set_setting):
    router = APIRouter(prefix="/order-recommendation", tags=["order-recommendation"])
```

(기존 `def build_order_recommendation_router(*, get_current_user, get_db, get_setting):`를 위처럼 `set_setting` 추가.)

`/backtest` 핸들러 뒤에 추가:

```python
    @router.post("/weights")
    def save_weights(payload: dict = Body(...), user: str = Depends(get_current_user)):
        keys = [
            "weight_weekday_average", "weight_previous_day",
            "weight_avg_7d", "weight_avg_14d", "weight_avg_3d",
        ]
        for key in keys:
            if key in payload and payload[key] is not None:
                set_setting(f"order_recommendation_{key}", str(payload[key]))
        return {"ok": True}
```

- [ ] **Step 4: `main.py`에서 `set_setting` 연결**

`backend/main.py`의 `build_order_recommendation_router(...)` 호출부(1438~1444번째 줄 근처)를 다음으로 교체:

```python
app.include_router(
    build_order_recommendation_router(
        get_current_user=_get_current_user,
        get_db=_get_order_recommendation_db,
        get_setting=_get_setting,
        set_setting=_set_setting,
    )
)
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `cd backend && python -m pytest tests/test_order_recommendation_routes.py -v`
Expected: 전체 PASS

- [ ] **Step 6: 전체 백엔드 회귀 확인**

Run: `cd backend && python -m pytest tests/ -q`
Expected: 전체 PASS

- [ ] **Step 7: 커밋**

```bash
git add backend/api/order_recommendation_routes.py backend/main.py backend/tests/test_order_recommendation_routes.py
git commit -m "feat: add POST /order-recommendation/weights to persist weight overrides"
```

---

### Task 4: 프론트엔드 — 백테스팅 섹션 (조회)

**Files:**
- Modify: `src/components/OrderRecommendation/OrderRecommendationDashboardPage.jsx`
- Modify: `src/components/OrderRecommendation/OrderRecommendationDashboardPage.module.css`

**Interfaces:**
- Consumes: `GET /order-recommendation/backtest?date=&weight_*=` (Task 2), `daily.items`(부모가 이미 로드한 오늘자 `/daily` 응답, 가중치 초기값 추출용)
- Produces: `BacktestSection({ daily })` 컴포넌트

- [ ] **Step 1: CSS 클래스 추가**

`OrderRecommendationDashboardPage.module.css` 맨 끝에 추가:

```css
.backtestControls {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 0.75rem;
  margin-bottom: 0.75rem;
}

.backtestField {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.backtestField label {
  font-size: 0.72rem;
  color: var(--text-muted);
}

.backtestDateInput,
.backtestWeightInput {
  padding: 0.35rem 0.5rem;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 0.82rem;
}

.backtestWeightInput {
  width: 70px;
}

.backtestSaveBtn {
  padding: 0.4rem 0.75rem;
  border: 1px solid var(--accent-black);
  border-radius: var(--radius-sm);
  background: var(--accent-black);
  color: var(--accent-white);
  font-size: 0.82rem;
  font-weight: 600;
  cursor: pointer;
}

.backtestSaveMsg {
  font-size: 0.78rem;
  color: var(--text-muted);
}
```

- [ ] **Step 2: `BacktestSection` 컴포넌트 작성**

`OrderRecommendationDashboardPage.jsx`의 `DailyDataTable` 함수(200번째 줄) 정의 뒤, `export default function OrderRecommendationDashboardPage()` 앞에 추가:

```jsx
function yesterdayDateStr() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

function minBacktestDateStr() {
  const d = new Date();
  d.setDate(d.getDate() - 28);
  return d.toISOString().slice(0, 10);
}

const WEIGHT_FIELDS = [
  { key: 'weight_weekday_average', label: '같은요일' },
  { key: 'weight_previous_day', label: '전날' },
  { key: 'weight_avg_7d', label: '7일' },
  { key: 'weight_avg_14d', label: '14일' },
  { key: 'weight_avg_3d', label: '3일' },
];

const DEFAULT_WEIGHTS = {
  weight_weekday_average: 0.2,
  weight_previous_day: 0.25,
  weight_avg_7d: 0.2,
  weight_avg_14d: 0.15,
  weight_avg_3d: 0.2,
};

function initialWeightsFromDaily(daily) {
  const item = (daily?.items || []).find((i) => i.model_weight_weekday != null);
  if (!item) return { ...DEFAULT_WEIGHTS };
  return {
    weight_weekday_average: item.model_weight_weekday,
    weight_previous_day: item.model_weight_previous_day,
    weight_avg_7d: item.model_weight_avg_7d,
    weight_avg_14d: item.model_weight_avg_14d,
    weight_avg_3d: item.model_weight_avg_3d,
  };
}

function BacktestSection({ daily }) {
  const [date, setDate] = useState(yesterdayDateStr());
  const [weights, setWeights] = useState(() => initialWeightsFromDaily(daily));
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ date, ...weights });
        const res = await fetch(`${API}/order-recommendation/backtest?${params}`, {
          headers: getAuthHeaders(),
        });
        const data = await res.json().catch(() => ({}));
        if (!cancelled && res.ok && data.ok) setResult(data);
      } catch {
        // 조회 실패 시 이전 결과 유지
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [date, weights]);

  const saveWeights = async () => {
    setSaveMessage('저장 중...');
    try {
      const res = await fetch(`${API}/order-recommendation/weights`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify(weights),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) throw new Error(data?.detail || '저장 실패');
      setSaveMessage('저장됨 — 다음 예상발주 계산부터 이 가중치가 적용됩니다');
    } catch (err) {
      setSaveMessage(err.message || '저장 실패');
    }
  };

  return (
    <div>
      <div className={styles.backtestControls}>
        <div className={styles.backtestField}>
          <label>날짜</label>
          <input
            type="date"
            className={styles.backtestDateInput}
            value={date}
            min={minBacktestDateStr()}
            max={yesterdayDateStr()}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>
        {WEIGHT_FIELDS.map((f) => (
          <div key={f.key} className={styles.backtestField}>
            <label>{f.label}</label>
            <input
              type="number"
              step="0.01"
              min="0"
              className={styles.backtestWeightInput}
              value={weights[f.key]}
              onChange={(e) =>
                setWeights((w) => ({ ...w, [f.key]: e.target.value === '' ? '' : Number(e.target.value) }))
              }
            />
          </div>
        ))}
        <button type="button" className={styles.backtestSaveBtn} onClick={saveWeights}>
          이 가중치로 저장
        </button>
        {saveMessage && <span className={styles.backtestSaveMsg}>{saveMessage}</span>}
      </div>

      <div className={styles.statGrid}>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>표본 수</div>
          <div className={styles.statValue}>{result ? `${result.sample_count}건` : loading ? '계산 중...' : '-'}</div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>MAE</div>
          <div className={styles.statValue}>{result ? formatNumber(result.mae) : '-'}</div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>WAPE</div>
          <div className={styles.statValue}>{result ? formatPercent(result.wape) : '-'}</div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>±20% 적중률</div>
          <div className={styles.statValue}>{result ? formatPercent(result.hit_rate_20pct) : '-'}</div>
        </div>
      </div>

      <div className={styles.dailyTableScroll}>
        <table className={styles.dailyTable}>
          <thead>
            <tr>
              <th>상품명</th>
              <th>예상판매량</th>
              <th>실제판매량</th>
              <th>오차</th>
              <th>±20%적중</th>
            </tr>
          </thead>
          <tbody>
            {(result?.items || []).map((item) => (
              <tr key={item.yusas_code}>
                <td>{item.product_name || '-'}</td>
                <td>{item.expected_sales_today != null ? item.expected_sales_today.toFixed(1) : '-'}</td>
                <td>{item.actual_sales_qty ?? '-'}</td>
                <td>{item.forecast_error != null ? item.forecast_error.toFixed(1) : '-'}</td>
                <td>{item.within_20_percent == null ? '-' : item.within_20_percent ? '✓' : '✗'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: 대시보드 페이지에 섹션 추가**

`OrderRecommendationDashboardPage.jsx`의 "일별 데이터" 섹션(356~370번째 줄) 바로 뒤, 함수 끝나는 `</div>\n  );\n}` 앞에 추가:

```jsx
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>백테스팅</h3>
        <BacktestSection daily={daily} />
      </section>
```

- [ ] **Step 4: 빌드 확인**

Run: `npm run build`
Expected: 에러 없이 빌드 성공

- [ ] **Step 5: 사용자 수동 확인 요청**

사용자에게 dev 서버에서 다음을 확인해달라고 요청한다:
- 날짜 바꾸면 결과가 자동으로(약간의 딜레이 후) 갱신되는지
- 가중치 입력값 바꾸면 결과가 갱신되는지
- 날짜 선택기가 최근 28일 이전은 선택 못 하게 막는지
- 상품별 상세 테이블에 예상판매량/실제판매량/오차/±20%적중이 정상적으로 뜨는지

- [ ] **Step 6: 커밋**

```bash
git add src/components/OrderRecommendation/OrderRecommendationDashboardPage.jsx src/components/OrderRecommendation/OrderRecommendationDashboardPage.module.css
git commit -m "feat: add backtesting section with adjustable weight preview"
```

---

### Task 5: 프론트엔드 — 가중치 저장 동작 확인 (통합 확인)

Task 4의 `saveWeights()`가 이미 `POST /weights`를 호출하도록 구현돼 있으므로(Step 2에 포함), 이 태스크는 별도 코드 작성 없이 **엔드투엔드 동작 확인**만 한다.

- [ ] **Step 1: 사용자 수동 확인 요청**

사용자에게 dev 서버에서 다음을 확인해달라고 요청한다:
- 가중치 입력값을 바꾼 뒤 [이 가중치로 저장] 클릭 → "저장됨" 메시지가 뜨는지
- 그 후 "실행" 섹션의 "예상발주 계산" 버튼을 눌러 오늘자를 재계산했을 때, 방금 저장한 가중치가 실제로 반영되는지 (일별 데이터 테이블의 예상판매량이 바뀌는지, 또는 서버 로그/DB로 `order_recommendation_weight_*` 설정값이 바뀌었는지 확인)

- [ ] **Step 2: 이상 없으면 완료 — 별도 커밋 없음 (Task 4에서 이미 커밋됨)**
