# 발주 대시보드 V1 — 운영 현황판

## 배경

지금까지 7라운드에 걸쳐 추천발주 파이프라인(계산 엔진, 수요예측
정확도 평가, 발주 운영 성과 평가, EZAdmin/에이블리 실데이터 컬렉터)을
전부 백엔드 API로만 만들었고, 이를 볼 수 있는 화면이 없다. 이번
라운드는 프론트엔드에 "발주 대시보드"를 처음 만든다 — 순수 프론트엔드
작업이며, 신규 백엔드 API는 필요 없다(기존 6개 엔드포인트를 그대로
호출).

기존 "재고대시보드"는 사이드바가 아니라 `Header.jsx`의 상단바
(`topMode` 방식)로 구현돼 있다. 사용자가 "상단에 재고대시보드 옆에"
라고 요청했으므로, 같은 상단바 방식으로 추가한다.

## 목표 (V1 범위)

한 페이지, 3개 섹션:

1. **실행 버튼 6개** — 오늘 날짜 고정(날짜 선택기 없음), 각각 독립
   실행:
   - 에이블리 재고수집 — `POST /order-recommendation/collect`
   - 판매량 수집 — `POST /order-recommendation/collect-sales-history`
   - 예상발주 계산 — `POST /order-recommendation/compute`
   - 수요예측 정확도 평가 — `POST /order-recommendation/evaluate`
   - 발주성과 평가 — `POST /order-recommendation/evaluate-order-performance`
   - 비에이블리 재고수집 — `POST /non-ably-order/collect`

   에이블리 재고수집/비에이블리 재고수집 2개는 EZAdmin 세션이 필요해
   `{"ok": false, "need_session": true}`를 반환할 수 있다 — 기존
   `InventoryDashboardPage.jsx`가 쓰는 `useEzadminSession()` 모달을
   그대로 재사용해 세션 입력 후 자동 재시도한다. 나머지 4개는 세션
   개념이 없으므로 실패 시 에러 메시지만 표시.

   각 버튼은 클릭 시 로딩 → 결과 메시지(성공 건수/실패 사유)를 버튼
   바로 아래 인라인으로 표시. 6개 버튼 중 하나라도 성공하면 아래
   요약/통계 섹션을 자동 새로고침한다.

2. **오늘자 요약** — 페이지 진입 시 `GET /order-recommendation/daily`
   (날짜 파라미터 없이 호출 → 백엔드가 오늘 날짜로 기본 처리) 자동
   조회. `items.length`(전체 상품 수), `items.filter(i =>
   i.confirmed_qty != null).length`(확정 완료 수)를 카드로 표시.

3. **통계 카드** — 페이지 진입 시 다음 2개를 병렬로 자동 조회:
   - `GET /order-recommendation/forecast-accuracy?days=7` →
     `sample_count`, `mae`(원값), `wape`(×100, % 표시),
     `hit_rate_20pct`(×100, % 표시). 값이 `null`이면 "데이터 없음".
   - `GET /order-recommendation/order-performance?days=7` →
     `sample_count`, `avg_confirm_deviation`, `avg_fulfillment_gap`,
     `avg_incoming_qty_change`(전부 원값, 소수 1자리 반올림). 값이
     `null`이면 "데이터 없음".

## 비범위 (다음 버전)

- 날짜 선택기 — 항상 오늘만.
- 개별 상품별 리스트/확정수량 수정 화면(최종발주 확인 테이블,
  `/non-ably-order/final-order` 활용) — 이번엔 없음.
- 버튼 6개 → 3개 통합(수집/계산/평가) — 지금은 개별 테스트를 위해
  따로 둔다.
- 신규 백엔드 변경 — 없음(기존 엔드포인트 그대로 사용).

## 배치 (`Header.jsx` / `App.jsx`)

`Header.jsx`의 `.topNav` 안, 기존 재고대시보드 버튼(107~131번째 줄
근처) 바로 다음에 같은 패턴으로 버튼 추가:

```jsx
<button
    type="button"
    className={`${styles.topNavItem} ${topMode === 'order-dashboard' ? styles.topNavItemActive : ''}`}
    onClick={() => setTopMode?.('order-dashboard')}
>
    <ClipboardList size={14} />
    발주대시보드
</button>
```

`lucide-react` import에 `ClipboardList` 추가.

`App.jsx`:
- import 추가: `import OrderRecommendationDashboardPage from
  './components/OrderRecommendation/OrderRecommendationDashboardPage';`
- `useState('home')` 옆 주석에 `'order-dashboard'` 추가(문서화용,
  동작에는 영향 없음).
- 기존 `{topMode === 'inventory-dashboard' && <InventoryDashboardPage
  />}` 바로 다음 줄에 `{topMode === 'order-dashboard' &&
  <OrderRecommendationDashboardPage />}` 추가.

## 신규 컴포넌트

- `src/components/OrderRecommendation/OrderRecommendationDashboardPage.jsx`
- `src/components/OrderRecommendation/OrderRecommendationDashboardPage.module.css`

`InventoryDashboardPage.jsx`와 같은 구조 관례(단일 파일, 데이터
fetch는 `LOCAL_API_BASE`/`getAuthHeaders()`, `res.json().catch(() =>
({}))` 후 `!res.ok` 체크)를 따르되, **스타일은
`InventoryDashboardPage.module.css`의 미바인딩 커스텀 프로퍼티
(`--surface`, `--border`, `--bg-card`, 블루 accent)를 따라하지 않고**
`src/index.css`에 실제로 정의된 토큰(`--bg-primary`, `--bg-secondary`,
`--border-color`, `--text-primary`, `--text-secondary`,
`--text-muted`, `--accent-black`, `--radius-sm|md|lg`,
`--card-shadow`)만 사용한다 — 다크모드 대응 및 앱 전체 톤 일치 목적.

액션 6개는 배열로 정의해 반복 렌더링한다(거의 동일한 버튼 UI를 6번
손으로 반복하지 않기 위함):

```js
const ACTIONS = [
  { key: 'ably-stock', label: '에이블리 재고수집', path: '/order-recommendation/collect', method: 'POST', needsSession: true },
  { key: 'sales-history', label: '판매량 수집', path: '/order-recommendation/collect-sales-history', method: 'POST', needsSession: false },
  { key: 'compute', label: '예상발주 계산', path: '/order-recommendation/compute', method: 'POST', needsSession: false },
  { key: 'evaluate', label: '수요예측 정확도 평가', path: '/order-recommendation/evaluate', method: 'POST', needsSession: false },
  { key: 'evaluate-performance', label: '발주성과 평가', path: '/order-recommendation/evaluate-order-performance', method: 'POST', needsSession: false },
  { key: 'non-ably-stock', label: '비에이블리 재고수집', path: '/non-ably-order/collect', method: 'POST', needsSession: true },
];
```

각 액션의 성공 응답 필드명이 서로 다르므로(`updated_codes`가
`/order-recommendation/collect`에서는 배열, `/non-ably-order/collect`
에서는 개수 정수, 나머지는 `computed`/`evaluated`/`updated`), 표시
문구는 다음 우선순위로 개수를 뽑는 헬퍼로 통일한다:

```js
function extractCount(data) {
  if (Array.isArray(data.updated_codes)) return data.updated_codes.length;
  if (typeof data.updated_codes === 'number') return data.updated_codes;
  return data.computed ?? data.evaluated ?? data.updated ?? null;
}
```

## 테스트 계획

이 저장소는 프론트엔드 자동 테스트가 없다(CLAUDE.md: "No test
suite" — Vite 개발 서버로 수동 확인하는 게 관례). 이번 라운드도 동일
관례를 따른다:

- `npm run dev`로 실행 후 브라우저에서 발주대시보드 진입 확인.
- 버튼 6개 각각 클릭해 성공/실패 메시지가 올바르게 뜨는지 확인
  (EZAdmin 세션 없는 상태에서 에이블리/비에이블리 재고수집 버튼을
  눌러 세션 모달이 뜨는지도 확인).
- 오늘자 요약/통계 카드가 페이지 진입 시 자동으로 채워지는지, 버튼
  성공 후 새로고침되는지 확인.
- 다크모드 토글 시 색이 깨지지 않는지 확인(재고대시보드는 이 부분이
  깨져 있었음 — 회귀 방지 확인 포인트).
