# 비에이블리 채널 재고부족 + 최종발주 합산

## 배경

직전 라운드에서 EZAdmin IO30을 에이블리 채널(`str_shop_code=10028`)로
조회해 `order_recommendation_daily`(예상발주 파이프라인)를 채우는
컬렉터를 만들었다. 이번 라운드는 에이블리 외 채널(쿠팡 등,
`multi_shop=10080,10031`)을 연결한다.

에이블리 외 채널은 처음부터 완전히 다른 워크플로우로 정의됐다 —
수요예측/가중평균 계산을 하지 않고, EZAdmin이 계산해주는 부족수량
(`lack_qty`)을 그대로 발주수량으로 쓴다. 담당자는 최종적으로 "에이블리
채널 예상발주수량(확인/수정 가능) + 에이블리 외 채널 부족수량"을 합산한
하나의 최종발주 목록을 보고 싶어 한다 — 같은 상품이 여러 채널에서
동시에 팔리더라도 공급처에는 총 필요수량 하나로 발주를 넣어야 하기
때문이다.

## 목표

- EZAdmin IO30을 `multi_shop=10080,10031`로 조회해 상품별
  재고/미입고/부족수량을 가져와 신규 스냅샷 테이블에 저장한다. 날짜별
  이력을 쌓지 않는다 — 계산 로직이 없는 "지금 이 순간 상태"만 있으면
  되므로 `yusas_code`를 PK로 쓰고, 조회 결과에 포함된 상품만 값을
  덮어쓴다(이번 조회에 없는 기존 상품 행은 삭제하지 않고 그대로 둠 —
  아래 `upsert_non_ably_snapshot` 참고).
- `GET /non-ably-order/final-order`가 호출 시점마다 다음을 계산해
  반환한다(저장하지 않음):
  - 에이블리 쪽 발주수량 = 담당자가 확인/수정한 `confirmed_qty`(있으면
    그 값), 없으면 시스템이 계산한 `recommended_qty`. 둘 다 없으면 0.
  - `final_order_qty` = 위 값 + 비에이블리 `lack_qty`(없으면 0).
  - 두 소스 중 한쪽에만 있는 상품도 빠지지 않고 나머지 쪽을 0으로
    취급해 합산에 포함한다.
- 기존 `order_recommendation_ezadmin_collectors.py`의 IO30
  페이지네이션·파싱 로직을 신규 공용 모듈로 추출해 에이블리
  컬렉터와 이번 비에이블리 모듈이 함께 재사용한다(같은 로직을 두 곳에
  복붙하지 않기 위한 리팩터링 — 동작 변경 없음, 기존 7개 테스트가 그대로
  통과해야 한다).

## 비범위

- 비에이블리 채널의 수요예측/평가 로직 — 애초에 이 라운드의 전제가
  "예측 없이 부족수량 그대로 발주"이므로 없음.
- `final-order` 계산 결과를 저장하는 테이블/컬럼, 이력 추적 — 매번
  계산만 하고 저장하지 않는다.
- 엑셀 다운로드/EZAdmin 발주 업로드 자동화 — 이번은 JSON API까지만.
- 프론트엔드 "확인·수정 → 합산 버튼" UI 구현 — 이번 라운드는 백엔드
  API까지. UI는 다음 라운드.

## 공용 리팩터링: `backend/services/ezadmin_io30_client.py`

기존 `order_recommendation_ezadmin_collectors.py`에 있던 다음
요소들을 이 신규 파일로 옮긴다:

- `_ez_val(html_value) -> str` — HTML 래핑 값 파싱.
- `_to_int(value, default=0) -> int`
- `fetch_io30_rows(get_setting, *, shop_par_fragment: str) -> list[dict]`
  — `str_shop_code=`/`multi_shop=` 필터 조각을 인자로 받아 IO30을
  페이지네이션 조회하고, 각 행의 `cell`을 그대로(파싱 전) 리스트로
  반환한다(기존 `_fetch_ably_io30_snapshot`의 페이지네이션 루프를
  이 함수로 이동, `product_id`/컬럼 매핑은 호출부 책임으로 뺀다).

`order_recommendation_ezadmin_collectors.py`는 `fetch_io30_rows`를
호출하도록 리팩터링하고, 자신의 30초 TTL 캐시(`_cache`)와
`stock_qty`/`incoming_qty`/`ezadmin_lack_qty` 컬럼 매핑은 그대로
유지한다. 동작은 변경되지 않으므로 기존 7개 테스트를 그대로 다시
돌려서 회귀가 없는지 확인한다.

## 신규 테이블 (`backend/services/order_non_ably_backorder.py`)

```sql
CREATE TABLE IF NOT EXISTS order_non_ably_backorder (
    yusas_code TEXT PRIMARY KEY,
    stock_qty INTEGER,
    incoming_qty INTEGER,
    lack_qty INTEGER,
    updated_at TEXT NOT NULL
)
```

```python
_NON_ABLY_SHOP_CODES = "10080,10031"

async def fetch_non_ably_snapshot(get_setting) -> dict[str, dict]:
    """fetch_io30_rows(get_setting, shop_par_fragment=f"multi_shop={_NON_ABLY_SHOP_CODES}&str_shop_code=0")를
    호출해 {product_id: {"stock_qty", "incoming_qty", "lack_qty"}}로 매핑."""

def upsert_non_ably_snapshot(conn, snapshot: dict[str, dict]) -> None:
    """snapshot의 각 yusas_code를 INSERT ... ON CONFLICT(yusas_code) DO UPDATE로
    덮어쓴다(updated_at 갱신 포함). snapshot에 없는 기존 행은 그대로 둔다
    (상품이 이번 조회에서 빠졌다고 즉시 삭제하지 않음 — 다음 조회에서
    다시 나타나면 갱신됨)."""

async def collect_non_ably_snapshot(get_db, get_setting) -> int:
    """fetch_non_ably_snapshot + upsert_non_ably_snapshot을 한 번에 실행하고
    upsert된 상품 수를 반환. EzAdminSessionExpired는 그대로 전파."""

def list_non_ably_snapshot(conn) -> list:
    """order_non_ably_backorder 전체 행을 yusas_code 순으로 반환."""
```

## API (`backend/api/order_non_ably_backorder_routes.py`, prefix `/non-ably-order`)

- `POST /non-ably-order/collect` — `collect_non_ably_snapshot` 실행,
  `{"ok": true, "updated_codes": N}`. `EzAdminSessionExpired` 시
  `{"ok": false, "need_session": true}`(기존 `/order-recommendation/collect`와
  동일 패턴).
- `GET /non-ably-order/snapshot` — `{"ok": true, "items": [...]}`.
- `GET /non-ably-order/final-order?date=YYYY-MM-DD`(기본
  `today_kst()`) — `order_recommendation_daily`(해당 date)와
  `order_non_ably_backorder`를 `yusas_code` 기준 합쳐서:

```json
{
  "ok": true,
  "date": "2026-07-30",
  "items": [
    {
      "yusas_code": "S24083",
      "recommended_qty": 8,
      "confirmed_qty": 10,
      "ably_order_qty": 10,
      "non_ably_lack_qty": 3,
      "final_order_qty": 13
    }
  ]
}
```

`ably_order_qty = confirmed_qty if confirmed_qty is not None else
(recommended_qty if recommended_qty is not None else 0)`.
`non_ably_lack_qty`는 스냅샷에 없으면 0. `final_order_qty =
ably_order_qty + non_ably_lack_qty`. 두 소스 중 한쪽에만 있는
`yusas_code`도 결과에 포함된다(없는 쪽 필드는 0/None으로 채움 —
`recommended_qty`/`confirmed_qty`는 없으면 `None`으로 그대로 노출하고,
합산에 쓰인 `ably_order_qty`만 0으로 정규화한다).

## 테스트 계획

- `ezadmin_io30_client.py` 추출 후 `order_recommendation_ezadmin_collectors.py`의
  기존 7개 테스트가 회귀 없이 통과하는지.
- `fetch_non_ably_snapshot`: 파싱, 페이지네이션, 세션 만료 예외(공용
  모듈을 통해 상속되는 동작이므로 최소 1~2개 케이스로 확인).
- `upsert_non_ably_snapshot`: 신규 삽입, 기존 값 덮어쓰기, snapshot에
  없는 기존 행 보존.
- `collect_non_ably_snapshot`: 전체 흐름(fetch+upsert) 통합, 세션
  만료 전파.
- `list_non_ably_snapshot`: 정렬/반환 형태.
- 라우트: `/collect` 세션 만료 처리, `/snapshot` 목록, `/final-order`의
  합산 로직(양쪽 다 있는 경우/에이블리만 있는 경우/비에이블리만 있는
  경우/둘 다 없는 경우 없음 — 애초에 결과에 안 나타남 확인).
