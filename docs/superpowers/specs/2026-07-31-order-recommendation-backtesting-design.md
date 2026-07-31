# 발주 대시보드 — 백테스팅 섹션

## 배경

발주 추천 모델(`calc_expected_sales_today`)은 5개 신호(같은요일평균·전날·3일·7일·14일)를
가중평균해서 예상판매량을 낸다. 이 가중치를 튜닝하고 싶어도 지금은 실제로
하루 지나야 결과(±20% 적중률 등)를 알 수 있다. 그런데 판매량 수집이 이미
최근 28일치를 백필해뒀기 때문에, 과거 날짜에 대해서도 "그 시점에 알 수
있었던 데이터만으로" 예상판매량을 다시 계산해 실제 판매량과 비교하는
백테스트가 가능하다 (계산 로직이 전부 대상 날짜 이전 데이터만 참조하도록
이미 짜여 있어 look-ahead bias 없음).

이번 라운드는 발주 대시보드에 "백테스팅" 섹션을 추가해서, 특정 과거 날짜의
예측 정확도를 확인하고 가중치를 실험적으로 조정해볼 수 있게 한다.

## 목표

**대상 범위**: 오늘 `recommended_qty IS NOT NULL`인 상품(현재 143개 수준, "일별
데이터" 테이블과 동일 표본) × 사용자가 고른 단일 날짜.

**날짜 선택**: 단일 날짜 선택기. 기본값 어제. 최근 28일(판매량 수집 백필
한계) 이전은 선택 불가.

**가중치 실험**: 같은요일평균/전날/3일/7일/14일 5개 가중치를 화면에서
직접 입력해 즉시 재계산해볼 수 있다. 기본값은 현재 저장된 설정값
(`order_recommendation_weight_*`). 조정한 값은 **미리보기 전용** —
[이 가중치로 저장] 버튼을 눌러야만 실제 설정에 반영되고, 그 전까지는
실제 `예상발주 계산`(compute)에 전혀 영향 없다.

**결과 표시**: 상단에 집계 요약(표본수·MAE·WAPE·±20%적중률), 하단에
상품별 상세 테이블(상품명·예상판매량·실제판매량·오차·±20%적중여부).
날짜/가중치를 바꿀 때마다 자동 재조회.

## 비범위

- 여러 날짜 동시 비교(범위 백테스트) — 이번엔 단일 날짜만.
- 가중치 저장 시 히스토리/버전 관리 — 그냥 현재값 덮어쓰기.
- 상품별 검색/필터 — 143개 수준이라 전부 표시.
- coverage_days/safety_stock_qty 백테스트 — `recommended_qty`가 아니라
  `expected_sales_today` 단일 값만 검증 대상 (사용자가 궁금해한 것도
  "예측량 대비 적중률"이라 이 범위로 충분).

## 백엔드 변경

### 1. `order_recommendation_calc.py` — 계산 로직 추출

`compute_row`(178~230번째 줄 부근)에서 예상판매량 계산 부분(전날/3일/7일/
14일/같은요일 신호 수집 + 가중치 적용, 190~220번째 줄에 해당하는 블록)을
별도 함수로 뽑는다:

```python
def calc_expected_sales_today_for_date(
    conn, yusas_code: str, date: str, get_setting, weight_overrides: dict | None = None
) -> float | None:
    """date 기준으로 그 이전 데이터만 사용해 예상판매량을 계산한다.
    compute_row와 백테스트가 공유하는 순수 계산 함수 — DB에 아무것도 쓰지 않는다.

    weight_overrides가 있으면 설정값 대신 그 값을 쓴다 (백테스트 미리보기용).
    키: weight_weekday_average, weight_previous_day, weight_avg_7d,
        weight_avg_14d, weight_avg_3d."""
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

    return calc_expected_sales_today(
        weekday_average_sales, previous_day_sales_qty, avg_sales_7d, avg_sales_14d,
        weight_weekday_average, weight_previous_day, weight_avg_7d, weight_avg_14d,
        avg_sales_3d, weight_avg_3d,
    )
```

`compute_row`는 이 함수를 호출하도록 바꾸고(같은 인자로, `weight_overrides`
없이), 결과를 그대로 `expected_sales_today`/`model_weight_*` 컬럼에 쓴다 —
동작 변화 없음, 순수 리팩터링.

`_weight()` 헬퍼가 `is not None`으로 체크하는 이유: override 값이 `0`이어도
(가중치 0을 실험하는 것도 유효한 시나리오) 폴백하지 않고 그대로 써야 하기
때문 — `or` 연산자로 짰다면 `0`이 falsy라 설정값으로 잘못 폴백하는 버그가
생긴다.

### 2. `GET /order-recommendation/backtest`

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
            expected = calc_expected_sales_today_for_date(
                conn, code, date, get_setting, overrides or None
            )
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

        sample_count = sum(1 for i in items if i["within_20_percent"] is not None)
        abs_errors = [abs(i["forecast_error"]) for i in items if i["forecast_error"] is not None]
        actuals = [i["actual_sales_qty"] for i in items if i["forecast_error"] is not None]
        hit_flags = [i["within_20_percent"] for i in items if i["within_20_percent"] is not None]
        mae = sum(abs_errors) / len(abs_errors) if abs_errors else None
        actual_sum = sum(actuals)
        wape = (sum(abs_errors) / actual_sum) if abs_errors and actual_sum > 0 else None
        hit_rate_20pct = (sum(hit_flags) / len(hit_flags)) if hit_flags else None

        return {
            "ok": True, "date": date,
            "sample_count": sample_count, "mae": mae, "wape": wape,
            "hit_rate_20pct": hit_rate_20pct, "items": items,
        }
    finally:
        conn.close()
```

`calc_forecast_error`/`calc_within_20_percent`는 `order_recommendation_evaluate.py`에서
그대로 import해서 재사용한다 (이미 순수 함수, DB 접근 없음).

집계 계산 부분은 `aggregate_forecast_accuracy`(`order_recommendation_evaluate.py`)와
로직이 거의 같지만, 그쪽은 DB에 저장된 `absolute_error`/`within_20_percent`
컬럼을 읽는 구조라 이번 건(요청 시점 계산값 기반)과 데이터 소스가 달라
직접 재사용은 안 하고 위처럼 인라인으로 계산한다.

### 3. `POST /order-recommendation/weights` (저장 버튼용)

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

`build_order_recommendation_router`가 `set_setting`을 새로 받도록 시그니처
확장 (`get_current_user, get_db, get_setting` → `..., set_setting`),
`main.py`의 라우터 등록부(1438~1444번째 줄)에 `set_setting=_set_setting`
추가.

## 프론트엔드

`OrderRecommendationDashboardPage.jsx`에 "백테스팅" 섹션 추가 ("일별
데이터" 섹션 다음). 새 하위 컴포넌트 `BacktestSection`:

- 상태: `date`(기본 어제), 5개 가중치 입력값. 마운트 시 이미 로드된
  `daily.items`(부모 컴포넌트가 갖고 있는 오늘자 `/daily` 응답) 중
  `model_weight_weekday`가 `null`이 아닌 **첫 번째 항목**의
  `model_weight_weekday`/`model_weight_previous_day`/`model_weight_avg_7d`/
  `model_weight_avg_14d`/`model_weight_avg_3d`로 초기화한다 (오늘
  `예상발주 계산`을 이미 돌렸다면 전 상품이 같은 설정값을 쓰므로 어느
  행이든 동일). 해당하는 항목이 하나도 없으면(아직 오늘 compute를
  한 번도 안 돌린 경우) 코드의 `DEFAULT_WEIGHT_*` 상수와 동일한 값
  (0.20/0.25/0.20/0.15/0.20)으로 초기화한다. 신규 조회 API는 필요 없다.
- `date` 또는 가중치 입력값이 바뀌면(디바운스 300ms) `GET /backtest` 재조회
- 집계 요약 카드(표본수/MAE/WAPE/±20%적중률) + 상품별 상세 테이블
- [이 가중치로 저장] 버튼 → `POST /weights` 호출 → 성공 메시지 표시

## 테스트 계획

- 백엔드:
  - `calc_expected_sales_today_for_date`가 `compute_row`와 동일한 값을
    내는지 (`compute_row`의 기존 테스트가 회귀로 이를 검증 — 리팩터링
    후에도 `test_compute_row_full_pipeline_with_default_settings` 등이
    그대로 통과해야 함)
  - `weight_overrides`가 있을 때 그 값을 쓰는지, 없을 때 설정값을 쓰는지
  - `weight_overrides`에 `0`이 들어와도 폴백되지 않는지 (falsy 버그 회귀
    테스트)
  - `GET /backtest`: 상품 목록이 오늘 `recommended_qty IS NOT NULL`
    기준으로 필터되는지, 집계값이 올바른지
  - `POST /weights`: 저장 후 `get_setting`으로 값이 실제로 바뀌는지
- 프론트: 자동 테스트 없음(프로젝트 관례) — `npm run build`로 컴파일
  확인 후 사용자가 dev 서버에서 날짜/가중치 변경 시 재조회되는지,
  저장 버튼이 실제로 설정을 바꾸는지 수동 확인.
