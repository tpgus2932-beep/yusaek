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
- 요일평균 × 전날흐름계수 기반 추천수량 계산 로직.
- 담당자가 추천수량을 수정하면 확정값·사유 저장.
- 광고 배정금액/찜 수/장바구니 수는 원본값·전일 대비 증감·증감률만 저장하고
  계산에는 반영하지 않음 (참고 신호로만 응답에 포함).

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

## DB 스키마

`backend/main.py`에 `_init_order_recommendation_daily()` 추가 (기존
`_init_*` 함수들과 같은 위치/패턴), 공유 DB에 생성:

```sql
CREATE TABLE IF NOT EXISTS order_recommendation_daily (
    date TEXT NOT NULL,
    yusas_code TEXT NOT NULL,
    day_of_week INTEGER,              -- 0=월 ... 6=일, date로부터 계산해 저장

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

    -- 계산용 파생값 (계산 시 채워짐, 감사 가능하도록 캐싱)
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
    updated_at TEXT,

    excluded_from_avg INTEGER NOT NULL DEFAULT 0,  -- 품절/판매중지일 등, 요일평균 계산에서 제외
    created_at TEXT NOT NULL,

    PRIMARY KEY (date, yusas_code)
)
```

`app_settings`(기존 `get_setting`/`set_setting`)에 조정 가능한 파라미터 3개 추가
(코드 수정 없이 값 튜닝 가능):

| 키 | 기본값 | 의미 |
|---|---|---|
| `order_recommendation_blend_ratio` | `0.4` | 전날 흐름계수를 얼마나 반영할지 (30~50%) |
| `order_recommendation_coverage_days` | `1` | 추천수량이 며칠치 수요를 커버할지 (리드타임 대응용) |
| `order_recommendation_safety_stock_qty` | `0` | 안전재고 여유분 |

## 계산 로직 (`backend/services/order_recommendation.py`)

특정 `date`, `yusas_code`에 대해 아래 순서로 계산, 결과를 해당 행에 UPDATE:

**0. `previous_day_sales_qty`**
- 전날(`date - 1`) 같은 `yusas_code` 행의 `sales_qty`를 그대로 복사. 전날 행이
  없으면 NULL.

**1. `weekday_average_sales`** (오늘 요일의 과거 평균 판매량)
- 최근 8주 동일 요일의 `sales_qty` 중 `excluded_from_avg = 0`이고 NOT NULL인 값들의
  평균.
- 그 요일 데이터가 4주 미만이면, 최근 14일(`excluded_from_avg=0`, NOT NULL)
  일평균으로 대체.
- 그마저도 데이터가 없으면 NULL.

**2. `previous_day_sales_ratio`** (전날 흐름계수)
- 전날 행의 `weekday_average_sales`(전날 계산 시 이미 캐싱된 값)를 그대로 재사용
  — 재계산하지 않음.
- `previous_day_sales_qty ÷ 전날_weekday_average_sales`. 전날 값이 없거나 0이면
  `1.0`.
- 결과를 `[0.5, 2.0]`으로 클램프(이상치 방지).

**3. `expected_sales_today`**
- `flow_adjustment = 1 + (previous_day_sales_ratio - 1) × blend_ratio`
- `weekday_average_sales`가 NULL이면 `expected_sales_today`도 NULL.
- 아니면 `weekday_average_sales × flow_adjustment`.

**4. `recommended_qty`**
- `target_sales = expected_sales_today × coverage_days`
- `stock_qty` 또는 `incoming_qty`가 NULL, 또는 `expected_sales_today`가 NULL이면
  `recommended_qty = NULL` (잘못된 추천 방지).
- 아니면 `max(0, round(target_sales + safety_stock_qty) - stock_qty - incoming_qty)`.

**5. 참고지표 (광고/찜/장바구니)**
- `*_change = 오늘값 - 전날값` (전날 NULL이면 change도 NULL, 음수 허용).
- `*_change_rate = change ÷ 전날값` (전날 값이 없거나 0이면 NULL).
- 계산식 어디에도 반영하지 않음.

`sales_7d`/`sales_14d`/`avg_sales_7d`는 해당 `yusas_code`의 최근 7일/14일
`sales_qty` 합계·평균(NULL 제외)으로 채운다.

## 수집기(collector) 구조

`backend/services/order_recommendation.py`에 컬렉터 레지스트리를 둔다:

```python
# 각 컬렉터: async def(date: str) -> dict[yusas_code, value]
# 아직 실제 API가 안 붙은 변수는 레지스트리에 등록하지 않는다 (해당 컬럼은 계속 NULL)
COLLECTORS: dict[str, Collector] = {
    # "stock_qty": collect_stock_qty_from_ezadmin,  # 예: 다음 세션에 하나씩 추가
}
```

`POST /order-recommendation/collect?date=YYYY-MM-DD`가 등록된 컬렉터를 전부 돌려
결과를 UPSERT한다(컬렉터가 반환하지 않은 컬럼은 기존 값 유지). 이 구조 덕분에
"변수를 하나씩 API로 채운다"는 요청대로, 컬렉터 함수 하나 추가 + 레지스트리 등록
한 줄만으로 변수 하나씩 실 데이터로 전환할 수 있다.

## API (`backend/api/order_recommendation_routes.py`, prefix `/order-recommendation`)

- `POST /collect?date=YYYY-MM-DD` — 등록된 컬렉터 실행 후 UPSERT (date 생략 시 오늘).
- `POST /compute?date=YYYY-MM-DD` — 위 계산 로직을 그 날짜의 모든 행에 대해 실행.
- `GET /daily?date=YYYY-MM-DD` — 그 날짜의 전체 행 반환.
- `POST /{date}/{yusas_code}/confirm` — body `{confirmed_qty, override_reason}`,
  `updated_by`는 `get_current_user`, `updated_at`은 서버 시각으로 채워 UPSERT.

## 테스트 계획

- `backend/tests/`에 새 테스트 파일 추가 (기존 `test_delivery_anomaly_routes.py`
  등의 in-memory SQLite 패턴 재사용):
  - 계산 로직 단위 테스트: 8주 요일평균 정상 케이스, 4주 미만이라 14일 평균으로
    대체되는 케이스, `previous_day_sales_ratio` 클램프(0.5/2.0 경계),
    `stock_qty`/`incoming_qty` NULL일 때 `recommended_qty`가 NULL이 되는지.
  - 참고지표 증감률: 전일 0 또는 없음 → NULL 처리 확인, 감소(음수) 케이스.
  - API: `/collect`가 컬럼 일부만 UPSERT하고 나머지는 보존하는지, `/confirm`이
    기존 확정값을 덮어쓰는지, `/daily` 응답 형태.
- 프론트엔드 변경 없음 — 해당 없음.
