# 추천발주: expected_sales_today를 가중평균 공식으로 교체

## 배경

1차로 구현·병합된 `expected_sales_today` 계산은 "요일평균 × 전날흐름계수(0.5~2.0
클램프, blend_ratio로 30~50%만 반영)" 방식이었다. 이를 아래 4개 지표의 가중평균
방식으로 교체한다: 최근 8주 동일요일 평균(35%), 전날 주문량(25%), 직전 7일
일평균(25%), 직전 14일 일평균(15%). 전날 주문량이 가중치로 직접 반영되므로,
기존의 별도 흐름계수(`previous_day_sales_ratio`)·클램프·blend_ratio 개념은 이
계산에서 완전히 제거한다.

`recommended_qty` 계산식(재고·입고예정 차감, ceil 반올림)은 이번 변경과 무관하게
그대로 유지한다.

수요예측 정확도(MAE/WAPE/적중률)·발주 운영 성과평가(backorder 추적 등)는 이번
범위 밖 — 별도 스펙으로 분리해 다음 라운드에서 설계한다.

## 목표

- `expected_sales_today = Σ(value_i × weight_i) / Σ(weight_i)` — 존재하는
  지표만으로 재정규화.
- 4개 지표 전부 NULL이거나, 존재하는 지표들의 가중치 합이 0이면
  `expected_sales_today = NULL`.
- 가중치 4개는 `app_settings`에 저장해 코드 수정 없이 조정 가능.
- 가중치는 음수를 허용하지 않는다 — 잘못된 설정값(숫자 변환 불가, 음수)은 해당
  항목의 기본값으로 대체.
- `previous_day_sales_ratio` 관련 컬럼·함수·상수·전용 테스트를 전부 제거.
- `previous_date`, `get_row`는 다른 용도(전날 판매량 복사, 광고/찜/장바구니
  전일값 조회)에 계속 필요하므로 유지.

## 비범위

- 수요예측 정확도 평가(actual_order_qty, MAE, WAPE, 허용오차 적중률).
- 발주 운영 성과평가(confirmed_qty/actual_received_qty 비교, backorder_qty 추적).
- `recommended_qty` 공식 자체의 변경 — 그대로 유지.
- `order_recommendation_blend_ratio` 설정값 삭제 — 값은 `app_settings`에 남겨두되
  새 계산 코드는 더 이상 읽지 않는다.
- 기존 로컬 DB에 이미 생긴 `previous_day_sales_ratio` 컬럼의 DROP 마이그레이션 —
  신규 `CREATE TABLE`에서만 제거하고, 이미 만들어진 DB의 해당 컬럼은 사용 중단
  상태로 방치(이 저장소는 컬럼 ADD만 마이그레이션하고 DROP은 하지 않는 컨벤션).

## DB 스키마 변경 (`backend/services/order_recommendation_store.py`)

`init_order_recommendation_tables`의 `CREATE TABLE`에서:
- `previous_day_sales_ratio REAL` 라인 제거.
- `avg_sales_14d REAL` 라인 추가 (`avg_sales_7d` 바로 아래).

기존 DB 호환을 위해 `_ensure_avg_sales_14d_column(conn)`을 추가한다. 별도로
`get_db()`를 다시 열지 않고, `init_order_recommendation_tables`가 이미 열어둔
연결을 그대로 넘겨받아 `CREATE TABLE`과 같은 트랜잭션에서 실행하고 한 번에
커밋한다:

```python
def _ensure_avg_sales_14d_column(conn) -> None:
    cols = [r["name"] for r in conn.execute("PRAGMA table_info(order_recommendation_daily)").fetchall()]
    if "avg_sales_14d" not in cols:
        conn.execute("ALTER TABLE order_recommendation_daily ADD COLUMN avg_sales_14d REAL")


def init_order_recommendation_tables(get_db) -> None:
    conn = get_db()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS order_recommendation_daily (
            ...  -- avg_sales_14d 포함, previous_day_sales_ratio 제외
        )
        """
    )
    _ensure_avg_sales_14d_column(conn)
    conn.commit()
    conn.close()
```

## `app_settings` 신규 키 4개

| 키 | 기본값 |
|---|---|
| `order_recommendation_weight_weekday_average` | `0.35` |
| `order_recommendation_weight_previous_day` | `0.25` |
| `order_recommendation_weight_avg_7d` | `0.25` |
| `order_recommendation_weight_avg_14d` | `0.15` |

## 계산 로직 변경 (`backend/services/order_recommendation_calc.py`)

**제거:** `calc_previous_day_sales_ratio` 함수, `RATIO_MIN`, `RATIO_MAX`,
`DEFAULT_BLEND_RATIO` 상수.

**신규 헬퍼** (가중치 전용 — 음수/숫자 변환 불가/NaN/무한대 값은 기본값으로 대체):

```python
import math


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
```

`math.isfinite(value)`는 `NaN`과 `+inf`/`-inf`를 모두 걸러낸다(`float("nan")`,
`float("inf")` 같은 설정값이 들어와도 기본값으로 대체됨).

`_setting_float`(coverage_days/safety_stock_qty용)는 이번 변경과 무관하므로
그대로 둔다.

**`calc_expected_sales_today` 시그니처 교체:**

```python
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
```

**`compute_row` 변경:**
- `calc_sales_window(conn, yusas_code, date, 14)`가 이미 돌려주던 `count_14d`를
  실제로 사용해 `avg_sales_14d = (sales_14d / count_14d) if sales_14d is not
  None and count_14d else None` 계산 추가.
- `calc_previous_day_sales_ratio` 호출 및 `previous_day_sales_ratio` 컬럼 UPDATE
  제거.
- `blend_ratio = _setting_float(...)` 줄 제거, 대신 4개 가중치를
  `_setting_weight`로 읽어 새 `calc_expected_sales_today`에 전달.
- `UPDATE ... SET` 문에서 `previous_day_sales_ratio = ?` 제거,
  `avg_sales_14d = ?` 추가.
- `calc_recommended_qty` 호출부는 변경 없음(입력이 `expected_sales_today`인
  것만 동일, 내부 로직 무관).

## 테스트 변경 (`backend/tests/test_order_recommendation_store.py`,
`test_order_recommendation_calc.py`)

- `test_order_recommendation_store.py`: `EXPECTED_COLUMNS`에서
  `previous_day_sales_ratio` 제거, `avg_sales_14d` 추가.
- `test_order_recommendation_calc.py`: ratio 전용 테스트 5개
  (`test_ratio_defaults_to_1_when_no_previous_row`,
  `test_ratio_reuses_cached_weekday_average_when_present`,
  `test_ratio_computes_on_the_fly_when_cache_missing_and_clamps_upper_bound`,
  `test_ratio_defaults_to_1_when_previous_day_sales_qty_is_none`,
  `test_ratio_clamped_to_lower_bound`)와 관련 import 전부 삭제.
- `test_expected_sales_today_*` 2개(구 시그니처 대상)를 새 시그니처 대상으로
  교체.
- `_setting_weight` 직접 단위 테스트 6개 추가(누락/비숫자/음수/NaN·무한대/정상값/0
  케이스).
- `compute_row` 통합 테스트를 새 공식에 맞게 재작성 — `previous_day_sales_qty`
  복사, 날짜 순서 무관성, NULL 재정규화, 전체 파이프라인 테스트는 유지하되 새
  공식의 기대값으로 재계산.
- `calc_recommended_qty` 테스트 8개는 변경 없음(공식 자체가 안 바뀜).

## 테스트 계획

- `weight_sum이 0`이 되는 경우(전부 NULL, 또는 존재하는 값들의 가중치가 전부 0)
  `expected_sales_today`가 NULL인지.
- 일부 지표만 NULL일 때 재정규화된 가중평균이 수식대로 나오는지(값을 손으로
  검증 가능한 조합으로 구성).
- `_setting_weight`가 없음/빈 문자열/숫자 아님/음수/NaN/무한대 값에 대해
  기본값을, 0 이상 정상값에 대해 그 값을 그대로 반환하는지.
- 날짜 순서 무관성: 전날(D) 행에는 `sales_qty`만 채워두고(다른 파생값은 채우지
  않음), D+1의 요일 이력만 별도로 준비한 뒤 (A) `compute_row(D)`를 먼저 실행한
  뒤 `compute_row(D+1)`을 실행한 결과와 (B) `compute_row(D)`를 아예 실행하지
  않고 `compute_row(D+1)`만 실행한 결과가 동일한지 비교한다. 새 공식은 전날
  `weekday_average_sales` 캐시에 의존하지 않고 `previous_day_sales_qty`(원본
  `sales_qty` 그대로)만 읽으므로, 전날 `compute_row` 실행 여부와 무관하게
  결과가 같아야 한다.
- `avg_sales_14d`가 대상일을 제외한 직전 14일만으로 계산되는지(데이터 누수
  방지 원칙 유지).
- `init_order_recommendation_tables`가 신규 DB에서 `previous_day_sales_ratio`
  없이, `avg_sales_14d` 포함해서 테이블을 만드는지.
- `avg_sales_14d` 컬럼이 없는 구형 테이블(수동으로 축소된 스키마로 생성)에 대해
  `init_order_recommendation_tables`를 실행하면 컬럼이 추가되는지.
- 이미 `avg_sales_14d`가 있는 상태에서 `init_order_recommendation_tables`를 다시
  실행해도 에러 없이 그대로인지(idempotent).
