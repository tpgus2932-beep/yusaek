# 추천발주: 에이블리 판매량/장바구니 이력 수집(갭필)

## 배경

지금까지 만든 예상발주 계산 엔진(`order_recommendation_calc.py`)은
`order_recommendation_daily`에 이미 채워진 과거 `sales_qty`(판매량)를
읽어서 `previous_day_sales_qty`, `avg_sales_7d`, `avg_sales_14d`,
`weekday_average_sales`를 계산하고, 이 4개를 가중평균해
`expected_sales_today`를 만든다. 그런데 정작 `sales_qty`를 채워주는
컬렉터가 없어서 지금까지 이 값들이 전부 NULL이었고, 결과적으로
`recommended_qty`도 계산된 적이 없다.

판매량 데이터는 에이블리 셀러 통계 API
(`GET https://api.a-bly.com/seller/statistics/goods/`)에서 가져올 수
있다. `keyword_type=goods_sno`로 상품(에이블리 상품번호) 단위 조회 시
`option_enable=true`를 주면 옵션(`goods_option_sno`)별
`order_count`(판매수량)/`cart_count`(장바구니수)를 응답에 함께 준다.
단, `start_date`~`end_date` 범위를 주면 그 기간 전체의 합계 하나만
돌아오고 날짜별 내역은 안 준다 — 그래서 개별 날짜값이 필요하면
(상품번호, 날짜) 조합마다 한 번씩 호출해야 한다.

우리 상품코드(`yusas_code`, 예: `S24083`) ↔ 에이블리 상품번호/옵션번호
매핑은 기존 `wonbe` 테이블(`backend/api/wonbe_routes.py`)에 이미 있다
(`상품코드`, `옵션번호`, `에이블리상품번호` 컬럼) — 반품/재고 관련
기능들이 이미 이 테이블을 매핑 소스로 쓰고 있다.

## 목표

- 상품코드별로 최근 28일(어제부터 28일 전까지, 오늘 자신은 제외 —
  하루가 안 끝났으므로 부정확) 중 `order_recommendation_daily.sales_qty`가
  비어있는(행이 없거나 NULL인) 날짜만 골라 에이블리 통계 API로 채운다
  ("갭필" — 이미 채워진 날짜는 다시 안 부름).
- 28일을 고르는 이유: `calc_weekday_average_sales`의
  `WEEKDAY_MIN_WEEKS=4`(같은 요일 표본 4개)를 처음부터 만족시켜서,
  첫 실행부터 요일평균 모드가 14일 평균 폴백 없이 바로 동작하게
  하기 위함(4주 = 28일이 정확히 이 최소 요건).
- 같은 에이블리 상품번호(`goods_sno`)를 공유하는 옵션(=여러
  `yusas_code`)들은 API 호출을 묶어서 한 번에 처리한다 — 옵션마다
  따로 부르지 않는다.
- `cart_count`도 같은 응답에서 같이 채운다(`sales_qty`가 비어서 그
  날짜를 조회하게 됐을 때 부가로 저장 — 별도 갭 판정은 하지 않음).
  `like_count`(찜수)는 저장하지 않는다.
- `sdk/ably.py`의 `AblyClient`(JWT 로그인/401 재시도 자동 처리)를
  그대로 재사용한다 — 새 인증 로직을 만들지 않는다.

## 비범위

- `wish_count`(찜수) 수집 — 이번엔 안 함(사용자가 명시적으로 제외).
- 스케줄러/자동 실행 — 수동 `POST` 호출로 테스트(다른 컬렉터들과 동일
  범위 원칙).
- 기존 `register_collector`/`run_collectors` 프레임워크 확장 — 이
  컬렉터는 "하루치"가 아니라 "최근 28일 중 빈 곳"을 채우는 구조라
  프레임워크 계약(컬럼당 함수 1개, 날짜 1개)과 안 맞아서 별도
  엔드포인트로 분리한다.
- 에이블리 로그인 실패에 대한 별도 사용자 안내(예: EZAdmin의
  `need_session` 같은 패턴) — `AblyClient`는 환경변수 자격증명으로
  자동 로그인하는 구조라 세션 재입력 개념이 없음. 실패하면 그대로
  예외가 전파된다.

## 매핑 함수 (`backend/api/wonbe_routes.py`에 추가)

```python
def load_wonbe_goods_sno_map() -> dict[str, list[tuple[str, str]]]:
    """에이블리상품번호(goods_sno) → [(옵션번호, 상품코드), ...] 매핑.

    같은 goods_sno 아래 여러 옵션(색상/사이즈 등)이 서로 다른 상품코드로
    관리되는 경우를 그룹으로 묶어, 통계 API를 goods_sno 단위로 한 번만
    호출하면 되도록 한다."""
```

기존 `load_wonbe_option_sno_map`과 같은 자리·같은 관례(하드코딩된
`WONBE_DB_PATH`, 별도 단위테스트 없음 — 이 파일의 다른 로더 함수들도
전부 이 관례를 따름, 새로 규칙을 만들지 않는다).

## 신규 서비스 (`backend/services/order_recommendation_ably_sales.py`)

```python
BACKFILL_DAYS = 28

def _backfill_date_range(as_of_date: str) -> list[str]:
    """as_of_date 기준 어제부터 BACKFILL_DAYS일 전까지 날짜 목록(최신 순 아님, 순서 무관)."""

def _missing_dates(conn, yusas_code: str, dates: list[str]) -> list[str]:
    """dates 중 order_recommendation_daily.sales_qty가 NULL이거나 행이
    없는 날짜만 반환."""

async def _fetch_goods_sno_stats(client: AblyClient, goods_sno: str, date: str) -> list[dict]:
    """에이블리 통계 API를 (goods_sno, date)로 호출해 goods_options 리스트를
    반환(옵션이 없으면 빈 리스트). HTTP 실패 시 RuntimeError."""

async def collect_ably_sales_history(get_db) -> int:
    """wonbe 매핑으로 goods_sno 그룹을 만들고, 그룹 내 상품 중 하나라도
    비어있는 날짜의 합집합을 goods_sno당 한 번씩 조회해 sales_qty/cart_count를
    채운다. 채워진 (날짜, 상품코드) 개수를 반환."""
```

## API (`backend/api/order_recommendation_routes.py`에 추가)

- `POST /order-recommendation/collect-sales-history` —
  `collect_ably_sales_history(get_db)` 실행, `{"ok": true, "updated": N}`.
  동기식(요청이 끝날 때까지 응답 안 감 — 상품 수가 많으면 첫 백필은
  오래 걸릴 수 있음, 이후 실행은 빠진 날짜만 채우므로 빨라짐).

## 테스트 계획

- `_missing_dates`: 행 없음/`sales_qty` NULL/이미 채워짐 3가지 케이스
  정확히 구분하는지.
- `_fetch_goods_sno_stats`: 정상 파싱, 빈 `goods_options`, HTTP 실패 시
  예외(에이블리 로그인+통계 API 둘 다 respx로 모킹).
- `collect_ably_sales_history`: 같은 `goods_sno`를 공유하는 여러
  상품코드가 API 호출 1번으로 함께 채워지는지, 이미 채워진 날짜는
  재호출 안 하는지, `cart_count`도 같이 저장되는지, `like_count`는
  저장 안 하는지, 매핑에 없는 옵션은 무시하는지. `load_wonbe_goods_sno_map`은
  monkeypatch로 대체.
- 라우트: 정상 응답 형태(`{"ok": true, "updated": N}`).
