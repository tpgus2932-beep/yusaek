# 추천발주: 수요예측 정확도 평가

## 배경

`expected_sales_today` 예측이 실제로 얼마나 맞는지 아직 아무도 측정하지 않는다.
1차 계산 파이프라인(요일평균×전날흐름계수 → 가중평균으로 이미 교체됨)이 얼마나
정확한지 데이터로 쌓아야, 다음 라운드에서 가중치 후보들을 백테스트할 근거가
생긴다. 이번 라운드는 **수요예측 정확도 평가만** 다룬다 — `recommended_qty`
대비 `confirmed_qty`/`actual_received_qty` 비교, 미송(`incoming_qty`) 증감
추적 같은 "발주 운영 성과" 쪽은 다음 라운드로 분리한다.

## 목표

- 예측값(`expected_sales_today`, 예측 시점에 저장된 값 그대로)과 실제값
  (`actual_order_qty` — 그 날의 신규 주문수, 이미 있는 `sales_qty` 컬럼을 그대로
  사용)을 비교해 `forecast_error`/`absolute_error`/`within_20_percent`를
  일별·상품별로 저장한다.
- `model_version`과 그 시점에 실제 쓰인 가중치 4개를 **예측 시점**
  (`compute_row`가 `expected_sales_today`를 계산할 때)에 함께 스냅샷으로
  저장해, 나중에 계산식/가중치가 바뀌어도 과거 행의 "그때 어떤 공식으로
  예측했는지"가 보존되게 한다.
- 최근 N일 집계 API로 MAE, WAPE, ±20% 적중률을 계산한다.
- 출고량/입고량은 실제 수요값으로 쓰지 않는다 — 오직 `sales_qty`(신규
  주문수)만 실제값으로 취급한다.

## 비범위

- `recommended_qty`/`confirmed_qty`/`actual_received_qty` 비교, 미송
  (`incoming_qty`) 증감 추적 — "발주 운영 성과" 평가는 다음 라운드.
- 가중치 자동 변경/백테스트 — 이번엔 성과 데이터만 쌓는다.
- 품절일 제외, stockout 관련 평가 컬럼 — 도입하지 않는다(이 사업 특성상
  재고 0이어도 주문은 계속 들어오므로 `sales_qty`는 이미 수요가 잘리지 않은
  값으로 간주).
- `actual_order_qty`용 별도 컬럼/수집기 — 신설하지 않는다. 기존 `sales_qty`를
  그대로 실제값으로 읽는다.

## DB 스키마 변경 (`backend/services/order_recommendation_store.py`)

`order_recommendation_daily`에 신규 컬럼 9개 추가. `CREATE TABLE`에는
`expected_sales_today` 바로 아래 예측 시점 스냅샷 4+1개, `recommended_qty`
바로 아래 평가 결과 4개를 배치한다:

```sql
            ...
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
            ...
```

기존 DB 호환을 위해 `_ensure_forecast_accuracy_columns(conn)`을 추가하고,
`_ensure_avg_sales_14d_column(conn)`과 같은 자리에서 같은 트랜잭션으로 호출한다:

```python
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

## `compute_row` 변경 (`order_recommendation_calc.py`)

`MODEL_VERSION = "weighted_v1"` 상수 추가. `expected_sales_today`를 계산하는
`UPDATE` 문에 `model_version`, `model_weight_weekday`,
`model_weight_previous_day`, `model_weight_avg_7d`, `model_weight_avg_14d`를
추가로 SET한다 — 값은 이미 `compute_row` 안에서 계산해 쓰고 있는
`weight_weekday_average`/`weight_previous_day`/`weight_avg_7d`/
`weight_avg_14d` 변수를 그대로 재사용한다(추가 계산 불필요).

**중요 규칙**: `model_version`/가중치 스냅샷은 오직 `compute_row`만 쓴다.
`evaluate_row`(아래)는 이 컬럼들을 절대 읽거나 쓰지 않는다. 계산식/가중치를
바꿀 때는 `MODEL_VERSION` 문자열도 함께 바꾼다(같은 버전명 유지한 채 가중치만
바꾸지 않는다).

## 신규 파일 `backend/services/order_recommendation_evaluate.py`

```python
WITHIN_PERCENT_THRESHOLD = 0.20


def calc_forecast_error(expected_sales_today, actual_order_qty):
    if expected_sales_today is None or actual_order_qty is None:
        return None
    return expected_sales_today - actual_order_qty


def calc_within_20_percent(absolute_error, actual_order_qty):
    if absolute_error is None or actual_order_qty is None or actual_order_qty == 0:
        return None
    return 1 if absolute_error <= actual_order_qty * WITHIN_PERCENT_THRESHOLD else 0


def evaluate_row(conn, yusas_code: str, date: str) -> None:
    """expected_sales_today와 sales_qty(=actual_order_qty)를 비교해
    forecast_error/absolute_error/within_20_percent/evaluated_at만 갱신한다.
    model_version·가중치 스냅샷은 손대지 않는다."""
    ...


def evaluate_all(get_db, date: str) -> int:
    """compute_all과 동일 패턴 — 그 날짜의 모든 yusas_code 행을 평가."""
    ...


def aggregate_forecast_accuracy(conn, days: int, yusas_code: str | None = None) -> dict:
    """date >= (오늘 - days) 이고 evaluated_at IS NOT NULL인 행들을 대상으로
    {sample_count, mae, wape, hit_rate_20pct}를 계산."""
    ...
```

- `evaluate_row`: 행이 없거나 `expected_sales_today`/`sales_qty` 중 하나라도
  NULL이면 평가 컬럼들은 NULL로 남긴다(`calc_forecast_error`가 이미 그렇게
  동작). `absolute_error = abs(forecast_error)`(forecast_error가 None이면
  None). `within_20_percent`는 `actual_order_qty`(=sales_qty)가 없거나 0이면
  NULL — **개별 퍼센트 오차는 계산하지 않지만, absolute_error는 그대로
  저장**해 MAE/WAPE 집계에는 포함되게 한다.
- `aggregate_forecast_accuracy` 집계 규칙:
  - `mae` = `absolute_error`가 NOT NULL인 행들의 평균 (actual=0인 행도 포함).
  - `wape` = 그 행들의 `absolute_error` 합계 ÷ `sales_qty` 합계 (분모 합이
    0이면 `wape = None`, ZeroDivisionError 방지).
  - `hit_rate_20pct` = `within_20_percent = 1`인 행 수 ÷ `within_20_percent
    IS NOT NULL`인 행 수 (actual=0인 행은 분모에서 제외). 분모가 0이면
    `None`.
  - `sample_count` = 조회된(`evaluated_at IS NOT NULL`) 전체 행 수.
  - `yusas_code`를 지정하면 그 상품만, 생략하면 전체 상품 합산.

## API 추가 (`order_recommendation_routes.py`)

- `POST /order-recommendation/evaluate?date=YYYY-MM-DD` — 그 날짜의 모든 행을
  평가(생략 시 KST 오늘). `{"ok": true, "date": ..., "evaluated": N}`.
- `GET /order-recommendation/forecast-accuracy?days=7&yusas_code=선택` —
  집계 지표 반환. `{"ok": true, "days": 7, "yusas_code": null|"YUSAS...",
  "sample_count": N, "mae": ..., "wape": ..., "hit_rate_20pct": ...}`.

## 테스트 계획

- `_ensure_forecast_accuracy_columns`가 9개 컬럼을 전부 추가하는지, 신규
  DB의 `CREATE TABLE`에 이미 포함돼 있어도 재실행 시 에러 없는지(idempotent).
- `compute_row`가 `expected_sales_today`를 계산할 때마다
  `model_version`/가중치 스냅샷 4개를 실제 사용된 값 그대로 저장하는지.
- `calc_forecast_error`/`calc_within_20_percent`: 정상 케이스, `actual=0`일
  때 `within_20_percent`는 NULL이지만 `forecast_error`/`absolute_error`는
  값이 나오는지, `expected_sales_today`나 `actual_order_qty`가 NULL이면
  전부 NULL인지.
- `evaluate_row`가 `model_version`/가중치 컬럼을 절대 덮어쓰지 않는지(호출
  전후 값이 그대로인지 직접 비교).
- `aggregate_forecast_accuracy`: MAE/WAPE가 손으로 검증 가능한 조합으로
  정확히 나오는지, actual=0 행이 hit_rate 분모에서 빠지지만 MAE/WAPE에는
  포함되는지, `days` 범위 밖 행이나 미평가(`evaluated_at IS NULL`) 행이
  집계에서 빠지는지, `yusas_code` 필터가 정확히 그 상품만 남기는지, 대상
  행이 하나도 없을 때 `mae`/`wape`/`hit_rate_20pct`가 `None`인지.
- API: `/evaluate`가 평가된 행 수를 정확히 반환하는지, `/forecast-accuracy`
  가 집계 함수 결과를 그대로 응답에 담는지.
