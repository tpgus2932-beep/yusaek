# 추천발주: EZAdmin 에이블리 채널 실데이터 컬렉터

## 배경

지금까지 5라운드에 걸쳐 만든 추천발주 파이프라인(계산 엔진, 수요예측
정확도 평가, 발주 운영 성과 평가)은 전부 계산/평가 로직과 API만 갖췄고,
`order_recommendation_daily`에 실제 값을 채워 넣는 컬렉터는 하나도
구현되어 있지 않았다(컬렉터 등록 프레임워크만 존재). 이번 라운드는 그
빈자리 중 EZAdmin에서 가져올 수 있는 재고 계열 데이터를 처음으로
채운다.

EZAdmin 사이드메뉴의 "발주 > 메인발주" 화면이 쓰는 것과 같은 API
(`IO30` 템플릿, `search_IO30` 액션, `POST /function.htm`)를 재사용한다.
이 화면은 상품별로 재고/미입고/부족수량을 보여주는데, `str_shop_code`
파라미터로 판매 채널(샵)을 필터링할 수 있다:

- `str_shop_code=10028` — 에이블리 채널
- `multi_shop=10080,10031` — 에이블리 외 채널(향후 별도 라운드: 예상발주
  없이 부족수량만큼만 바로 발주하는 별도 워크플로우 — 이번 범위 밖)

이번 라운드는 **에이블리 채널만** 연결한다.

## 목표

- EZAdmin IO30(에이블리 채널)에서 상품별 `stock`(재고), `not_yet_deliv`
  (미입고 = 우리 파이프라인의 `incoming_qty`/"미송"), `lack_qty`(EZAdmin
  자체 계산 부족수량)를 가져와 `order_recommendation_daily`에 매일
  채운다.
- `lack_qty`는 신규 컬럼 `ezadmin_lack_qty`에 원시값 그대로 저장한다 —
  우리 `recommended_qty`(가중평균 수요예측 기반)와 비교할 수 있는
  참고값이지, `recommended_qty` 계산에는 관여하지 않는다. 비교 자체는
  이번 라운드 범위 밖(API/프론트가 응답값 두 개를 그대로 노출하면 됨).
- EZAdmin `product_id`(예: `S24083`)를 정규화 없이 그대로 `yusas_code`
  컬럼에 저장한다 — 우리 상품코드 체계가 이미 이 형식이라 별도 변환이
  필요 없다(기존 `barcode_core.normalize_to_yusas`는 이 라운드에서
  사용하지 않음).
- 컬렉터 프레임워크(`register_collector`)는 컬럼당 함수 1개 구조를
  유지한다(변경하지 않음). `stock_qty`/`incoming_qty`/
  `ezadmin_lack_qty` 3개 컬럼이 사실 같은 IO30 조회 한 번으로 나오는
  값이므로, 짧은 TTL(30초) 메모리 캐시로 같은 `run_collectors` 호출
  안에서 중복 HTTP 호출을 막는다.
- EZAdmin 세션(PHPSESSID) 미설정/만료 시 `POST
  /order-recommendation/collect`가 `{"ok": false, "need_session":
  true}`를 반환한다(기존 `order_routes.py`의 `main_order_list`와 동일
  패턴).

## 비범위

- 에이블리 외 채널(`multi_shop=10080,10031`) 연결 — 완전히 다른
  워크플로우(예상발주 없이 부족수량 그대로 발주)라 다음 라운드로 미룬다.
- `ezadmin_lack_qty` vs `recommended_qty` 비교값을 저장하는 컬럼/로직
  (예: `forecast_vs_ezadmin_deviation`) — 원시값 저장까지만, 비교는
  범위 밖.
- `sales_qty`/`ad_budget`/`wish_count`/`cart_count` 등 다른 컬렉터 —
  이번 라운드는 EZAdmin IO30 계열만.
- 스케줄러(cron) 연결 — 여전히 수동 `POST /collect` 호출로 테스트.

## 데이터 소스: EZAdmin IO30 (에이블리 채널)

기존 `backend/api/order_routes.py`의 `main_order_list`가 쓰는 것과
동일한 엔드포인트·액션을 재사용하되, `str_shop_code`를 `0`(전체) 대신
`10028`(에이블리)로 바꾼다. 페이지네이션(최대 20페이지 × 1000행)도
`main_order_list`와 동일한 안전장치를 그대로 따른다.

응답 `cell` 필드 매핑:

| EZAdmin 필드 | 우리 컬럼 | 비고 |
|---|---|---|
| `product_id` | `yusas_code` | 정규화 없이 그대로 |
| `stock` | `stock_qty` | HTML `<a>` 래핑 파싱 필요 |
| `not_yet_deliv` | `incoming_qty` | 우리가 "미송"이라 불러온 값과 동일 개념 |
| `lack_qty` | `ezadmin_lack_qty` (신규) | EZAdmin 자체 계산, 원시값만 저장 |

값 파싱에 쓰는 `_ez_val`(HTML `<a>`/`<input>` 래핑에서 실값 추출)은
`order_routes.py`의 `build_order_router` 안에 정의된 로컬 클로저라
임포트할 수 없다 — 이 신규 파일 안에 동일한 정규식 로직을 모듈 레벨
헬퍼로 새로 작성한다(로직만 동일, 임포트 재사용 아님).

`request_qty`/`reserve_qty`/`return_qty`는 이번 라운드에서 사용하지
않는다(사람이 입력한 임시값이거나 우리 파이프라인과 무관).

기존 `sdk/ezadmin.py`의 `EzAdminClient.post(template, action, data=,
par=, extra_headers=)`를 재사용한다 — PHPSESSID 조회, 세션 만료 감지
(`EzAdminSessionExpired` 발생)가 이미 구현되어 있다. IO30은
`main_order_list`가 검증한 대로 `Referer:
{EZADMIN_BASE}/template40.htm?template=IO30`가 필요하므로
`extra_headers`로 지정한다(기본 Referer는 다른 값).

## 스키마 변경 (`backend/services/order_recommendation_store.py`)

`actual_received_qty` 바로 다음에 컬럼 1개 추가:

```sql
            actual_received_qty INTEGER,
            ezadmin_lack_qty INTEGER,
            previous_day_sales_qty INTEGER,
```

기존 `_ensure_forecast_accuracy_columns`/`_ensure_order_performance_columns`와
같은 자리, 같은 트랜잭션에서 `_ensure_ezadmin_columns(conn)`을 새로
추가해 호출한다(같은 `(column, ddl_type)` 리스트+루프 패턴).

## `order_recommendation_collect.py` 변경

`ALLOWED_COLLECTOR_COLUMNS`에 `"ezadmin_lack_qty"` 추가.

## 신규 파일 `backend/services/order_recommendation_ezadmin_collectors.py`

```python
_CACHE_TTL_SECONDS = 30
_ABLY_SHOP_CODE = "10028"

_cache: dict[str, tuple[float, dict[str, dict]]] = {}  # date -> (fetched_at, snapshot)


async def _fetch_ably_io30_snapshot(get_setting, date: str) -> dict[str, dict]:
    """EZAdmin IO30(에이블리 채널)을 조회해 {product_id: {"stock_qty":, "incoming_qty":,
    "ezadmin_lack_qty":}} 딕셔너리로 반환. 같은 date로 _CACHE_TTL_SECONDS 안에 재호출되면
    캐시를 재사용해 실제 HTTP 호출을 건너뛴다. PHPSESSID 미설정/세션 만료 시
    EzAdminSessionExpired를 그대로 전파한다(캐시하지 않음)."""


def build_ezadmin_collectors(get_setting) -> dict:
    """{"stock_qty": fn, "incoming_qty": fn, "ezadmin_lack_qty": fn} 반환.
    각 fn(date)는 _fetch_ably_io30_snapshot을 호출해 공유하고, 자기 컬럼만 뽑아
    {yusas_code: value} 형태로 돌려준다(register_collector 계약과 동일)."""
```

## `main.py` 배선

```python
from services.order_recommendation_ezadmin_collectors import build_ezadmin_collectors
from services.order_recommendation_collect import register_collector

for _column, _fn in build_ezadmin_collectors(_get_setting).items():
    register_collector(_column, _fn)
```

`init_order_recommendation_tables(_get_shared_db)` 호출 근처, 라우터
등록 이전에 실행한다.

## API 변경 (`order_recommendation_routes.py`)

`POST /order-recommendation/collect`에서 `EzAdminSessionExpired`를
캐치해 `{"ok": false, "need_session": true}`를 반환한다(HTTP 200,
`main_order_list`와 동일한 응답 형태).

## 테스트 계획

- `_fetch_ably_io30_snapshot`: 정상 응답 파싱(HTML 래핑 값, 여러 상품),
  페이지네이션(2페이지 이상), PHPSESSID 미설정 시
  `EzAdminSessionExpired`, 로그인 페이지 응답 시 동일 예외, 캐시 동작
  (같은 date 30초 안 재호출 시 HTTP 호출이 1번만 발생하는지 —
  `respx` 호출 카운트로 검증).
- `build_ezadmin_collectors`: 반환된 3개 함수가 각각 올바른 컬럼값을
  뽑아내는지(공유 fetch 결과 재사용 확인 포함).
- 스키마: `ezadmin_lack_qty`가 신규 `CREATE TABLE`에 포함되는지, 구형
  테이블에 마이그레이션으로 추가되는지, idempotent한지.
- `ezadmin_lack_qty`가 컬렉터 화이트리스트에 있는지.
- 라우트: EZAdmin 세션 만료 시 `/collect`가 `need_session: true`를
  반환하는지(200 상태코드).
