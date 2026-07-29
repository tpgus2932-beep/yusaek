# 추천발주 대시보드 1차: 계산 파이프라인 (백엔드)

## 배경

상품별 발주량을 담당자가 감으로 정하고 있어, 판매 추세·재고·입고예정을 반영한
추천 발주수량을 시스템이 계산해주려 한다. 최종적으로는 RAG로 과거 메모·이벤트를
검색해 LLM이 추천 근거를 설명해주는 것까지 목표지만, 그 부분은 수량 계산 로직이
안정화된 뒤 별도로 설계한다. 이번 1차는 **수량 계산 파이프라인만** 대상으로 한다:
입력 변수 9개를 일별로 모으고, 추천수량을 계산하고, 담당자가 수정한 확정값·사유를
저장하는 백엔드까지. 프론트엔드 화면과 RAG/LLM은 비범위.

입력 변수 9개(최근 7일/14일 판매량, 현재고, 입고예정수량, 요일, 광고 배정금액,
찜 수, 장바구니 수, 전날 주문량)는 실제 마켓 API(Ably/Zigzag/EZAdmin 등,
`backend/sdk/`)에서 하나씩 순서대로 연결해나갈 예정이라, 수집 구조는 "변수 하나당
수집기 함수 하나"로 나눠 아직 안 붙인 변수는 NULL로 남기고 나중에 수집기만 추가하면
되도록 설계한다.

## 목표

- `order_recommendation_daily` 테이블(날짜 × YUSAS 통합코드) 신설, 공유 DB
  (`_get_shared_db`) 사용.
- 변수별 수집기(collector) 레지스트리 구조 — 처음엔 대부분 미등록 상태로 두고,
  이후 세션에서 하나씩 실제 API 연결을 추가할 수 있게 한다.
- 요일평균 × 전날흐름계수 기반 추천수량 계산 로직. **당일 데이터는 계산에서 제외**
  (데이터 누수 방지).
- 담당자가 추천수량을 수정하면 확정값·사유 저장.
- 광고 배정금액/찜 수/장바구니 수는 원본값·전일 대비 증감·증감률만 저장하고
  계산에는 반영하지 않음 (참고 신호로만 응답에 포함).
- 날짜/시각은 서버 실행 환경(UTC 등)과 무관하게 Asia/Seoul 기준으로 통일.

## 비범위

- 프론트엔드 대시보드 화면 (다음 단계).
- RAG 검색, LLM 설명 생성 (다음 단계).
- 광고/찜/장바구니를 추천수량 계산식에 반영하는 가중치 (데이터가 쌓인 뒤 상관관계
  검증 후 추가).
- 마켓별(Ably/Zigzag 등) 분리 집계 — 전 마켓 합산해 YUSAS 통합코드 단위로만 계산.
- 여러 번 수정한 이력 다건 보관 — 담당자 확정값은 행당 최신 1건만 덮어쓴다. 다건
  이력이 필요해지면 별도 로그 테이블을 추가한다.
- 요일평균 계산 시 품절/판매중지일 "자동 감지" — 이번엔 `excluded_from_avg`
  플래그로 제외 가능한 구조만 만든다. 자동으로 채우는 로직(예: `stock_qty=0`이면
  자동 제외)은 이번 범위 밖.

## 타임존 정책 (Asia/Seoul 고정)

서버가 UTC 환경(Render 등)에서 돌아가도 날짜가 어긋나지 않도록, 이 파이프라인
전체는 KST(UTC+9)를 고정 기준으로 쓴다. `anomaly_scheduler.py`의
`_KST = timezone(timedelta(hours=9))`와 동일한 상수를 `order_recommendation.py`
에도 정의(또는 공용 유틸로 분리)해 재사용한다.

- `date` 쿼리 파라미터 생략 시 `datetime.now(_KST).strftime("%Y-%m-%d")`.
- `day_of_week`도 KST 기준 날짜로 계산.
- `created_at`/`updated_at`은 타임존 포함 ISO 8601(`datetime.now(_KST).isoformat()`,
  예: `2026-07-29T14:32:10+09:00`)로 저장 — naive datetime 문자열 저장 금지.

## DB 스키마

`backend/main.py`에 `_init_order_recommendation_daily()` 추가 (기존
`_init_*` 함수들과 같은 위치/패턴), 공유 DB에 생성:

```sql
CREATE TABLE IF NOT EXISTS order_recommendation_daily (
    date TEXT NOT NULL,
    yusas_code TEXT NOT NULL,
    day_of_week INTEGER,              -- 0=월 ... 6=일, KST date로부터 계산해 저장

    -- 원본 입력 (수집기가 하나씩 채움, 전부 NULL 허용)
    sales_qty INTEGER,                -- 그 날 판매량
    stock_qty INTEGER,
    incoming_qty INTEGER,
    previous_day_sales_qty INTEGER,   -- 외부 수집 대상 아님. compute 단계에서
                                       -- 전날 행의 sales_qty를 그대로 복사해 채운다.
    ad_budget INTEGER,
    wish_count INTEGER,
    cart_count INTEGER,

    -- 참고지표 (계산엔 미반영, 표시용, 전일 대비)
    ad_budget_change INTEGER,
    ad_budget_change_rate REAL,
    wish_count_change INTEGER,
    wish_count_change_rate REAL,
    cart_count_change INTEGER,
    cart_count_change_rate REAL,

    -- 계산용 파생값 (계산 시 채워짐, 감사 가능하도록 캐싱). 전부 "대상일 이전"
    -- 데이터만으로 계산 — 당일 sales_qty는 절대 포함하지 않는다.
    sales_7d INTEGER,
    sales_14d INTEGER,
    avg_sales_7d REAL,
    weekday_average_sales REAL,
    previous_day_sales_ratio REAL,
    expected_sales_today REAL,

    -- 결과
    recommended_qty INTEGER,

    -- 담당자 확정 (최신 1건만 덮어씀)
    confirmed_qty INTEGER,
    override_reason TEXT,
    updated_by TEXT,
    updated_at TEXT,                  -- ISO 8601 + KST 오프셋

    excluded_from_avg INTEGER NOT NULL DEFAULT 0,  -- 품절/판매중지일 등, 요일평균 계산에서 제외
    created_at TEXT NOT NULL,         -- ISO 8601 + KST 오프셋

    PRIMARY KEY (date, yusas_code)
)
```

**컬렉터가 쓸 수 있는 컬럼 화이트리스트** (수집기 UPSERT 절 참고):
`sales_qty`, `stock_qty`, `incoming_qty`, `ad_budget`, `wish_count`, `cart_count`.
그 외 컬럼(파생값·결과·확정값 등)은 컬렉터가 직접 쓸 수 없고 compute/confirm
단계에서만 채워진다.

`app_settings`(기존 `get_setting`/`set_setting`)에 조정 가능한 파라미터 3개 추가
(코드 수정 없이 값 튜닝 가능):

| 키 | 기본값 | 의미 |
|---|---|---|
| `order_recommendation_blend_ratio` | `0.4` | 전날 흐름계수를 얼마나 반영할지 (30~50%) |
| `order_recommendation_coverage_days` | `1` | 추천수량이 며칠치 수요를 커버할지 (리드타임 대응용) |
| `order_recommendation_safety_stock_qty` | `0` | 안전재고 여유분 |

## 계산 로직 (`backend/services/order_recommendation.py`)

핵심 원칙: **대상일(`date`)의 `sales_qty`는 어떤 계산에도 들어가지 않는다.** 모든
집계는 `date`보다 과거인 행만 사용한다 (데이터 누수 방지).

이를 위해 요일평균 계산을 재사용 가능한 순수 함수로 분리한다:

```python
def _calc_weekday_average_sales(conn, yusas_code: str, as_of_date: str) -> float | None:
    """as_of_date 미만(過去)의 데이터만 사용해 as_of_date와 같은 요일의
    과거 평균 판매량을 계산한다. 캐싱된 값에 의존하지 않는 순수 함수 —
    /compute가 날짜 순서와 무관하게 호출돼도 항상 같은 결과를 낸다."""
```

특정 `date`, `yusas_code`에 대해 아래 순서로 계산, 결과를 해당 행에 UPDATE:

**0. `previous_day_sales_qty`**
- 전날(`date - 1`) 같은 `yusas_code` 행의 `sales_qty`를 그대로 복사. 전날 행이
  없으면 NULL.

**1. `sales_7d` / `sales_14d` / `avg_sales_7d`**
- `sales_7d` = `date-7 ~ date-1`(대상일 미포함, 7일) `sales_qty` 합계(NULL 제외).
- `sales_14d` = `date-14 ~ date-1`(대상일 미포함, 14일) 합계(NULL 제외).
- `avg_sales_7d` = 같은 7일 구간의 평균(NULL 제외 값 개수로 나눔).

**2. `weekday_average_sales`** (오늘 요일의 과거 평균 판매량)
- `_calc_weekday_average_sales(conn, yusas_code, date)` 호출 결과.
- 함수 내부 규칙: `date` 미만 날짜 중 동일 요일, 최근 8주(최대 8개 데이터포인트),
  `excluded_from_avg=0`, `sales_qty` NOT NULL인 값들의 평균.
- 그 요일 데이터가 4주 미만이면, `date` 미만 최근 14일(`excluded_from_avg=0`,
  NOT NULL) 일평균으로 대체.
- 그마저도 없으면 NULL.

**3. `previous_day_sales_ratio`** (전날 흐름계수)
- 전날(`date - 1`) 행을 조회한다.
  - 전날 행이 없으면 → `ratio = 1.0`으로 확정, 아래 단계 스킵.
  - 전날 행의 `weekday_average_sales`가 NOT NULL이면 그 캐싱값을 `prev_avg`로
    재사용(재계산하지 않음).
  - 전날 행은 있는데 `weekday_average_sales`가 NULL이면
    `_calc_weekday_average_sales(conn, yusas_code, date - 1)`을 즉시 호출해
    `prev_avg`로 사용 (전날 행의 캐시를 갱신하지는 않음 — 조회 시점 계산만).
- `prev_avg`가 None이거나 0이면 → `ratio = 1.0`.
- 아니면 `ratio = previous_day_sales_qty ÷ prev_avg`, 결과를 `[0.5, 2.0]`으로
  클램프(이상치 방지).
- 이 로직은 `/compute`가 날짜 순서대로 호출되지 않아도(예: 어제 계산을 건너뛰고
  오늘부터 계산해도) 항상 동일한 결과를 내도록 캐시에만 의존하지 않는다.

**4. `expected_sales_today`**
- `flow_adjustment = 1 + (previous_day_sales_ratio - 1) × blend_ratio`
- `weekday_average_sales`가 NULL이면 `expected_sales_today`도 NULL.
- 아니면 `weekday_average_sales × flow_adjustment`.

**5. `recommended_qty`**
- `target_sales = expected_sales_today × coverage_days`
- `stock_qty` 또는 `incoming_qty`가 NULL, 또는 `expected_sales_today`가 NULL이면
  `recommended_qty = NULL` (잘못된 추천 방지).
- 아니면 `math.ceil(target_sales + safety_stock_qty) - stock_qty - incoming_qty`을
  0과 비교해 `max(0, ...)`. **`round()`는 쓰지 않는다** (0.5에서 은행반올림 발생,
  발주 부족 방지를 위해 올림 사용).
  ```python
  import math
  recommended_qty = max(
      0,
      math.ceil(target_sales + safety_stock_qty) - stock_qty - incoming_qty,
  )
  ```

**6. 참고지표 (광고/찜/장바구니)**
- `*_change = 오늘값 - 전날값` (전날 NULL이면 change도 NULL, 음수 허용).
- `*_change_rate = change ÷ 전날값` (전날 값이 없거나 0이면 NULL).
- 계산식 어디에도 반영하지 않음.

## 수집기(collector) 구조

`backend/services/order_recommendation.py`에 컬렉터 레지스트리를 둔다:

```python
# 각 컬렉터: async def(date: str) -> dict[yusas_code, value]
# 아직 실제 API가 안 붙은 변수는 레지스트리에 등록하지 않는다 (해당 컬럼은 계속 NULL)
COLLECTORS: dict[str, Collector] = {
    # "stock_qty": collect_stock_qty_from_ezadmin,  # 예: 다음 세션에 하나씩 추가
}
```

- 컬렉터 키는 반드시 DB 스키마의 화이트리스트(`sales_qty`, `stock_qty`,
  `incoming_qty`, `ad_budget`, `wish_count`, `cart_count`) 안에서만 등록 가능 —
  등록 시점에 검증한다.
- `POST /order-recommendation/collect?date=YYYY-MM-DD`는 등록된 컬렉터를 전부
  실행해 `yusas_code`별로 결과를 병합한 뒤, **컬렉터가 실제로 값을 반환한 컬럼만**
  `UPDATE ... SET col = ?`로 갱신한다 (반환하지 않은 컬럼은 기존 값을 NULL로
  덮어쓰지 않고 그대로 둔다).
- 신규 행(해당 `date`+`yusas_code` 최초 삽입)은 `INSERT ... ON CONFLICT(date,
  yusas_code) DO UPDATE SET <반환된 컬럼만>` 형태로 처리하고, `day_of_week`/
  `created_at`은 INSERT 시에만 채운다(KST 기준).
- 이번 호출에서 여러 컬렉터가 실행되고 여러 `yusas_code` 행이 UPSERT되더라도,
  전체를 하나의 DB 트랜잭션으로 묶어 커밋한다(중간 실패 시 부분 반영 방지).

## API (`backend/api/order_recommendation_routes.py`, prefix `/order-recommendation`)

- `POST /collect?date=YYYY-MM-DD` — 등록된 컬렉터 실행 후 UPSERT (date 생략 시
  KST 기준 오늘).
- `POST /compute?date=YYYY-MM-DD` — 위 계산 로직을 그 날짜의 모든 행에 대해 실행
  (date 생략 시 KST 기준 오늘).
- `GET /daily?date=YYYY-MM-DD` — 그 날짜의 전체 행 반환.
- `POST /{date}/{yusas_code}/confirm` — body `{confirmed_qty, override_reason}`,
  `updated_by`는 `get_current_user`, `updated_at`은 KST ISO 8601로 채워 UPSERT.

## 테스트 계획

- `backend/tests/`에 새 테스트 파일 추가 (기존 `test_delivery_anomaly_routes.py`
  등의 in-memory SQLite 패턴 재사용):
  - **데이터 누수 방지**: 대상일의 `sales_qty`를 크게 넣어도 `sales_7d`/
    `sales_14d`/`avg_sales_7d`/`weekday_average_sales`에 전혀 반영되지 않는지.
  - 8주 요일평균 정상 케이스, 4주 미만이라 14일 평균으로 대체되는 케이스.
  - `previous_day_sales_ratio`: 전날 행 없음 → 1.0, 전날 행은 있는데
    `weekday_average_sales`가 NULL → 즉석 계산 경로 확인, 클램프(0.5/2.0 경계).
    **날짜 역순으로 `/compute`를 호출해도**(예: D+1 먼저, D 나중) 결과가
    순서에 무관하게 동일한지.
  - `recommended_qty`: `stock_qty`/`incoming_qty` NULL일 때 NULL, `ceil` 적용
    확인(예: `target_sales=10.1` → 재고/입고 0이면 `recommended_qty=11`,
    `round()`였다면 10이 나왔을 값으로 회귀 방지).
  - 참고지표 증감률: 전일 0 또는 없음 → NULL 처리 확인, 감소(음수) 케이스.
  - 타임존: `date` 생략 시 시스템 타임존이 UTC로 설정된 상태에서도 KST 기준
    날짜가 나오는지, `created_at`/`updated_at`에 `+09:00` 오프셋이 포함되는지.
  - API: `/collect`가 화이트리스트 밖 컬럼 등록 시 에러가 나는지, 컬럼 일부만
    UPSERT하고 나머지는 보존하는지, `/confirm`이 기존 확정값을 덮어쓰는지,
    `/daily` 응답 형태.
- 프론트엔드 변경 없음 — 해당 없음.
