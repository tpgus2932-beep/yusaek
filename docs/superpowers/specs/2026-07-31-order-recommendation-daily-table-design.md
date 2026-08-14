# 발주 대시보드 — 일별 데이터 테이블

## 배경

발주 대시보드(V1, `2026-07-30-order-recommendation-dashboard-v1-design.md`)는
실행 버튼과 요약 통계 카드만 있고, 개별 상품별 데이터를 보거나
`confirmed_qty`(발주 확정수량)를 입력하는 화면이 없었다. 그 결과
`POST /order-recommendation/{date}/{yusas_code}/confirm` 엔드포인트는
백엔드에 존재하지만 실제로 호출하는 프론트엔드가 없어 `confirmed_qty`가
운영 데이터에 단 한 건도 채워지지 않고 있었다 — "발주 운영 성과" 카드가
계속 "데이터 없음"으로 뜨는 근본 원인.

이번 라운드는 발주 대시보드에 상품별 리스트 테이블을 추가해서, 실제로
추천발주량을 보고 확정수량을 입력할 수 있게 한다.

## 목표

발주 대시보드 페이지에 새 섹션 "일별 데이터"를 추가한다.

**표시 범위**: 오늘 날짜 고정(날짜 선택기 없음, V1과 동일 관례).
`recommended_qty IS NOT NULL`인 행만 기본 표시 — 재고수집이 실제로
이루어진 상품만 보여준다는 뜻. (판매량수집 백필이 8,000여 개 상품의
행을 매일 만들어내지만, 그중 재고/입고예정까지 채워져 추천발주량이
계산된 건 그날 재고수집이 실제로 닿은 상품뿐이다 — 보통 수백 건
수준.)

**컬럼**: 상품명 · 상품코드 · 재고(`stock_qty`) · 입고예정(`incoming_qty`)
· 예상판매량(`expected_sales_today`) · 추천발주량(`recommended_qty`) ·
확정수량(`confirmed_qty`, 입력 가능) · 사유(`override_reason`, 입력
가능).

**검색/정렬**: 상품명·상품코드 부분일치 검색, 컬럼 클릭으로 정렬
토글(기본: 추천발주량 내림차순). 건수가 수백 건 수준이라 전부
클라이언트 사이드로 처리하고 페이지네이션은 두지 않는다.

**확정수량 저장**: 행마다 독립적인 입력창 + 저장 버튼(값이 바뀐
행만 활성화). 일괄저장 없음 — 실수로 여러 건이 한 번에 잘못
저장되는 걸 방지하기 위해 행 단위로만 저장한다.

## 비범위

- 날짜 선택기 — 항상 오늘만 (V1과 동일).
- 재고/입고예정/예상판매량 등 계산된 값의 직접 수정 — `confirmed_qty`/
  `override_reason`만 편집 가능.
- 페이지네이션, 서버사이드 검색/정렬 — 지금 데이터 규모(수백 건)에서는
  불필요.
- 일괄 확정(선택 다중 저장) — 다음 라운드로 미룸.

## 백엔드 변경

### `wonbe_routes.py`

`load_wonbe_registered_at_map()`과 동일한 패턴으로 추가:

```python
def load_wonbe_product_name_map() -> dict[str, str]:
    """상품코드 → 상품명 매핑."""
    conn = _get_wonbe_db()
    try:
        _init_wonbe_table(conn)
        rows = conn.execute(
            "SELECT 상품코드, 상품명 FROM wonbe WHERE 상품코드 != ''"
        ).fetchall()
    finally:
        conn.close()
    return {r["상품코드"]: r["상품명"] or "" for r in rows if r["상품코드"]}
```

### `order_recommendation_routes.py`

`daily()` 핸들러에서 위 맵을 불러와 각 행에 `product_name` 필드를
얹어서 반환한다 (기존 `date`/응답 구조는 그대로 유지, 필드 추가만):

```python
from api.wonbe_routes import load_wonbe_product_name_map

@router.get("/daily")
def daily(date: str | None = None, user: str = Depends(get_current_user)):
    target_date = date or today_kst()
    name_map = load_wonbe_product_name_map()
    conn = get_db()
    try:
        rows = list_rows(conn, target_date)
        items = []
        for r in rows:
            item = _row_to_dict(r)
            item["product_name"] = name_map.get(item["yusas_code"], "")
            items.append(item)
        return {"ok": True, "date": target_date, "items": items}
    finally:
        conn.close()
```

`POST /{date}/{yusas_code}/confirm`은 기존 그대로 재사용, 변경 없음.

## 프론트엔드 컴포넌트

`OrderRecommendationDashboardPage.jsx`에 "일별 데이터" 섹션 추가
(기존 "발주 운영 성과" 섹션 다음). 별도 파일로 분리하지 않고 같은
파일 안에 하위 컴포넌트로 둔다 — 이미 로드된 `daily` 데이터를 그대로
재사용할 수 있어서(현재 "오늘자 요약" 카드가 쓰는 `useJsonGet`
호출과 동일한 데이터 소스).

- 표시 대상: `daily.items.filter(i => i.recommended_qty != null)`
- 검색 입력 + 정렬 상태(`useState`)로 클라이언트 필터링/정렬
- 각 행: 확정수량 `<input type="number">` + 사유 `<input type="text">`,
  로컬 상태로 원본 값과 비교해 변경 여부 추적 → 변경 시에만 저장 버튼
  활성화
- 저장 클릭 → `POST /order-recommendation/{date}/{yusas_code}/confirm`
  (`{ confirmed_qty, override_reason }`) → 성공 시 그 행에 "저장됨"
  잠깐 표시 후 사라짐, 실패 시 그 행에 에러 메시지 유지(입력값은
  안 지움 → 재시도 가능)
- 테이블 자체 로드 실패 시 섹션 안에 "불러오기 실패" + 재시도 버튼

스타일은 기존 `OrderRecommendationDashboardPage.module.css`의 토큰
(`--bg-secondary`, `--border-color`, `--radius-*`, `--text-*`)을
그대로 따르고, 테이블 전용 클래스(`.dailyTable`, `.dailyTableRow`,
`.confirmInput` 등)를 추가한다.

## 테스트 계획

- 백엔드: `test_order_recommendation_routes.py`에 `daily` 응답의
  각 item에 `product_name`이 포함되는지 테스트 추가 (wonbe 매칭
  되는 경우/안 되는 경우 둘 다).
- 프론트: 이 저장소는 프론트엔드 자동 테스트가 없다(V1과 동일 관례
  — `npm run dev`로 수동 확인).
  - 재고수집 실행 후 "일별 데이터" 섹션에 그 건수만큼 행이 뜨는지
    확인
  - 검색/정렬 동작 확인
  - 확정수량 입력 → 저장 → 새로고침해도 값 유지되는지 확인 (실제로
    `order_recommendation_daily.confirmed_qty`에 저장됐는지)
  - 저장 실패 시나리오(네트워크 끊고 시도) 에러 메시지 확인
  - 다크모드 토글 시 테이블 색 안 깨지는지 확인
