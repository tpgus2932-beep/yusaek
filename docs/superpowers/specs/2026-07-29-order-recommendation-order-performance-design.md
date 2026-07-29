# 추천발주: 발주 운영 성과 평가

## 배경

"성과 평가"의 두 번째 축. 지난 라운드(수요예측 정확도)는 `expected_sales_today`가
실제 수요와 얼마나 맞았는지를 다뤘다. 이번 라운드는 발주 프로세스 자체의
운영 성과 — 담당자가 추천수량을 얼마나 조정했는지(`confirm_deviation`),
확정한 수량이 실제로 얼마나 들어왔는지(`fulfillment_gap`), 추천 발주 이후
미송(`incoming_qty`)이 얼마나 늘거나 줄었는지(`incoming_qty_change`) — 를
다룬다.

## 목표

- `actual_received_qty`(실제 입고수량)를 신규 원본 입력 컬럼으로 추가하고
  컬렉터 화이트리스트에 포함한다(이번 라운드에서 실제 API 연결은 안 함 —
  기존 `sales_qty`/`stock_qty` 등과 동일하게 나중에 컬렉터 하나씩 붙임).
- `incoming_qty`(=미송)의 전일 대비 증감을 기존 `ad_budget_change`와 동일한
  패턴(`calc_change_and_rate` 재사용)으로 `compute_row`가 매일 계산·저장한다.
- `confirm_deviation`(담당자가 추천수량을 얼마나 조정했는지)과
  `fulfillment_gap`(확정수량 대비 실제 입고량 차이)을 계산·저장하는
  별도 평가 단계(`evaluate_order_performance_row`)를 추가한다. 이 값들은
  `confirmed_qty`/`actual_received_qty`가 각각 언제 들어오느냐에 따라 시점이
  다르므로, 준비된 값만으로 부분 계산하고 나머지는 NULL로 둔다(나중에
  `actual_received_qty`가 들어오면 다시 평가 호출해서 채움).
- 최근 N일 집계 API로 평균 `confirm_deviation`/`fulfillment_gap`/
  `incoming_qty_change`를 반환한다(수요예측 정확도 라운드의
  `aggregate_forecast_accuracy`와 동일한 패턴).

## 비범위

- 미송 자동 감소 목표치, 재고 최적화 알고리즘 등 — 데이터만 쌓는다.
- `actual_received_qty`의 실제 EZAdmin/거래처 API 연동 — 컬렉터 화이트리스트
  등록만 하고 실제 수집기 함수는 다음 세션에.
- `confirm_deviation`/`fulfillment_gap` 기반 자동 알림·경고 — 이번 범위 밖.

## DB 스키마 변경 (`backend/services/order_recommendation_store.py`)

신규 컬럼 6개. `CREATE TABLE`에서 `incoming_qty` 바로 아래
`actual_received_qty`, `cart_count_change_rate` 바로 아래(참고지표 그룹 끝)
`incoming_qty_change`/`incoming_qty_change_rate`, `evaluated_at` 바로 아래
(평가 결과 그룹 끝) `confirm_deviation`/`fulfillment_gap`/
`order_performance_evaluated_at`을 추가한다:

```sql
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
            ...
            forecast_error REAL,
            absolute_error REAL,
            within_20_percent INTEGER,
            evaluated_at TEXT,
            confirm_deviation INTEGER,
            fulfillment_gap INTEGER,
            order_performance_evaluated_at TEXT,
            ...
```

`_ensure_avg_sales_14d_column`/`_ensure_forecast_accuracy_columns`와 같은
자리, 같은 트랜잭션에서 `_ensure_order_performance_columns(conn)`을 새로
추가해 호출한다(같은 `(column, ddl_type)` 리스트+루프 패턴).

## `order_recommendation_collect.py` 변경

`ALLOWED_COLLECTOR_COLUMNS`에 `"actual_received_qty"` 추가.

## `compute_row` 변경 (`order_recommendation_calc.py`)

기존 `ad_budget_change`/`wish_count_change`/`cart_count_change` 계산 블록
바로 옆에 `incoming_qty_change, incoming_qty_change_rate =
calc_change_and_rate(row["incoming_qty"], prev_row["incoming_qty"] if
prev_row is not None else None)`을 추가하고, `UPDATE` 문에
`incoming_qty_change = ?, incoming_qty_change_rate = ?`를 추가한다.
`calc_change_and_rate` 함수 자체는 이미 있으므로 재사용만 한다.

## 신규 파일 `backend/services/order_recommendation_order_performance.py`

```python
def calc_confirm_deviation(confirmed_qty, recommended_qty):
    """confirmed_qty - recommended_qty. 둘 중 하나라도 NULL이면 NULL."""


def calc_fulfillment_gap(actual_received_qty, confirmed_qty):
    """actual_received_qty - confirmed_qty. 둘 중 하나라도 NULL이면 NULL."""


def evaluate_order_performance_row(conn, yusas_code: str, date: str) -> None:
    """confirm_deviation은 confirmed_qty만 있어도 계산, fulfillment_gap은
    confirmed_qty+actual_received_qty가 둘 다 있어야 계산. 준비된 값만
    부분적으로 채우고 order_performance_evaluated_at은 행이 존재하면 항상
    갱신한다(평가 단계가 실행됐다는 사실 자체를 기록 — evaluate_row와 동일
    관례)."""


def evaluate_order_performance_all(get_db, date: str) -> int:
    """evaluate_all과 동일 패턴."""


def aggregate_order_performance(conn, days: int, yusas_code: str | None = None) -> dict:
    """date >= (오늘-days)이고 order_performance_evaluated_at IS NOT NULL인
    행 대상으로 {sample_count, avg_confirm_deviation, avg_fulfillment_gap,
    avg_incoming_qty_change} 계산. 각 평균은 해당 값이 NOT NULL인 행만
    대상으로 하고(그 값이 하나도 없으면 None), avg_incoming_qty_change는
    compute_row가 채운 값이라 order_performance_evaluated_at과 무관하게
    같은 행 집합 안에서 조회한다."""
```

## API 추가 (`order_recommendation_routes.py`)

- `POST /order-recommendation/evaluate-order-performance?date=YYYY-MM-DD` —
  `{"ok": true, "date": ..., "evaluated": N}`.
- `GET /order-recommendation/order-performance?days=7&yusas_code=선택` —
  `{"ok": true, "days": 7, "yusas_code": ..., "sample_count": N,
  "avg_confirm_deviation": ..., "avg_fulfillment_gap": ...,
  "avg_incoming_qty_change": ...}`.

## 테스트 계획

- 신규 컬럼 6개가 신규 DB `CREATE TABLE`에 포함되는지, 구형 테이블에
  `_ensure_order_performance_columns`로 추가되는지, 재실행해도 idempotent한지.
- `actual_received_qty`가 컬렉터 화이트리스트에 있는지.
- `compute_row`가 `incoming_qty_change`/`rate`를 전일 `incoming_qty`
  대비로 정확히 계산하는지(증가/감소/전일 데이터 없음 케이스).
- `calc_confirm_deviation`/`calc_fulfillment_gap`: 정상 케이스, 입력 중
  하나라도 NULL이면 NULL인지.
- `evaluate_order_performance_row`: `confirmed_qty`만 있을 때
  `confirm_deviation`만 채워지고 `fulfillment_gap`은 NULL인지,
  `actual_received_qty`까지 있을 때 둘 다 채워지는지, 행이 없으면 아무것도
  안 하는지, `order_performance_evaluated_at`이 항상 갱신되는지.
- `aggregate_order_performance`: 평균값이 손으로 검증 가능한 조합으로
  정확히 나오는지, 대상 행이 없을 때 지표들이 `None`인지, `days`/
  `yusas_code` 필터가 정확히 동작하는지.
- API 2개가 각각 evaluate/aggregate 결과를 그대로 응답에 담는지.
