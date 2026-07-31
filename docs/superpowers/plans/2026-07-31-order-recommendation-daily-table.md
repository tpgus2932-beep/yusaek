# 발주 대시보드 일별 데이터 테이블 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 발주 대시보드에 상품별 일별 데이터 테이블을 추가해, 추천발주량을 보고 확정수량(`confirmed_qty`)을 실제로 입력/저장할 수 있게 한다.

**Architecture:** 백엔드는 기존 `/order-recommendation/daily` 응답에 상품명 필드 하나만 추가(신규 엔드포인트 없음, 기존 확정 엔드포인트 재사용). 프론트엔드는 `OrderRecommendationDashboardPage.jsx` 안에 새 하위 컴포넌트(`DailyDataTable`, `DailyTableRow`)를 추가해 이미 로드된 `daily` 데이터를 그대로 재사용한다.

**Tech Stack:** FastAPI + sqlite3 (backend), React + CSS Modules (frontend), pytest + TestClient (backend test).

## Global Constraints

- 신규 백엔드 엔드포인트 없음 — 기존 `GET /daily`, `POST /{date}/{yusas_code}/confirm`만 사용.
- 표시 기본 필터: `recommended_qty IS NOT NULL`인 행만.
- 표시 컬럼: 상품명 · 상품코드 · 재고 · 입고예정 · 예상판매량 · 추천발주량 · 확정수량(편집 가능) · 사유(편집 가능).
- 검색/정렬은 클라이언트 사이드 전용 (페이지네이션 없음).
- 확정수량 저장은 행 단위로만 (일괄저장 없음).
- 스타일은 `src/index.css`에 실제 정의된 토큰만 사용: `--bg-primary`, `--bg-secondary`, `--border-color`, `--text-primary`, `--text-secondary`, `--text-muted`, `--accent-black`, `--accent-white`, `--radius-sm|md|lg`.
- 이 저장소는 프론트엔드 자동 테스트가 없다 — 프론트 작업은 `npm run build`로 컴파일 오류만 확인하고, 실제 동작 확인은 사용자가 이미 켜둔 dev 서버에서 사용자가 직접 확인한다 (dev 서버를 직접 켜거나 끄지 않는다).

---

### Task 1: 백엔드 — `/daily` 응답에 상품명 포함

**Files:**
- Modify: `backend/api/wonbe_routes.py` (290번째 줄 `load_wonbe_registered_at_map` 함수 바로 뒤에 새 함수 추가)
- Modify: `backend/api/order_recommendation_routes.py:1-14` (import), `:48-56` (`daily` 핸들러)
- Test: `backend/tests/test_order_recommendation_routes.py`

**Interfaces:**
- Produces: `load_wonbe_product_name_map() -> dict[str, str]` (상품코드 → 상품명, `wonbe_routes.py`에서 export)
- Produces: `GET /order-recommendation/daily` 응답의 각 `items[]` 원소에 `product_name: str` 필드 추가 (기존 필드는 전부 그대로 유지)

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_order_recommendation_routes.py` 파일 맨 위 import 블록에 `patch` 추가 (이미 `from unittest.mock import AsyncMock, patch`로 되어 있으므로 확인만 하면 됨 — 없으면 추가), 그리고 `test_confirm_creates_row_and_sets_confirmed_fields` 함수 뒤에 다음 테스트 두 개를 추가:

```python
def test_daily_includes_product_name_when_wonbe_matches():
    client, get_db, _keep_alive = _make_client()
    conn = get_db()
    ensure_row(conn, "2026-07-29", "S24083")
    conn.commit()
    conn.close()

    with patch(
        "api.order_recommendation_routes.load_wonbe_product_name_map",
        return_value={"S24083": "나샤 실버 목걸이"},
    ):
        res = client.get("/order-recommendation/daily", params={"date": "2026-07-29"})

    items = res.json()["items"]
    assert len(items) == 1
    assert items[0]["product_name"] == "나샤 실버 목걸이"


def test_daily_product_name_empty_string_when_wonbe_has_no_match():
    client, get_db, _keep_alive = _make_client()
    conn = get_db()
    ensure_row(conn, "2026-07-29", "S24083")
    conn.commit()
    conn.close()

    with patch(
        "api.order_recommendation_routes.load_wonbe_product_name_map",
        return_value={},
    ):
        res = client.get("/order-recommendation/daily", params={"date": "2026-07-29"})

    items = res.json()["items"]
    assert items[0]["product_name"] == ""
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && python -m pytest tests/test_order_recommendation_routes.py -k product_name -v`
Expected: FAIL — `AttributeError` 또는 `ModuleNotFoundError`류 (아직 `api.order_recommendation_routes.load_wonbe_product_name_map`가 없어서 `patch()`가 타겟을 못 찾음), 또는 `KeyError: 'product_name'` (응답에 그 필드가 아직 없어서).

- [ ] **Step 3: `wonbe_routes.py`에 상품명 맵 함수 추가**

`backend/api/wonbe_routes.py`의 290번째 줄 `load_wonbe_registered_at_map` 함수(302~310번째 줄에서 끝남) 바로 뒤, `load_wonbe_product_cost_map` 함수(313번째 줄) 앞에 삽입:

```python
def load_wonbe_product_name_map() -> dict[str, str]:
    """상품코드 → 상품명 매핑. 발주 대시보드 일별 데이터 테이블에서 상품명 표시용."""
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

- [ ] **Step 4: `order_recommendation_routes.py`에서 사용하도록 연결**

`backend/api/order_recommendation_routes.py` 5번째 줄(`from services.order_recommendation_ably_sales import ...`) 바로 위에 import 추가:

```python
from api.wonbe_routes import load_wonbe_product_name_map
```

48~56번째 줄의 `daily` 핸들러를 다음으로 교체:

```python
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

- [ ] **Step 5: 테스트 통과 확인**

Run: `cd backend && python -m pytest tests/test_order_recommendation_routes.py -v`
Expected: PASS 전체 (새로 추가한 2건 포함, 기존 테스트도 전부 그대로 통과 — `product_name` 필드가 추가돼도 기존 테스트들은 특정 필드만 assert하므로 깨지지 않음).

- [ ] **Step 6: 전체 회귀 확인**

Run: `cd backend && python -m pytest tests/ -q`
Expected: 전체 PASS (322건 이상 — 이번 세션에서 이미 추가된 order_recommendation 관련 테스트 포함).

- [ ] **Step 7: 커밋**

```bash
cd "yusaek-main"
git add backend/api/wonbe_routes.py backend/api/order_recommendation_routes.py backend/tests/test_order_recommendation_routes.py
git commit -m "feat: include product_name in order-recommendation daily response"
```

---

### Task 2: 프론트엔드 — 일별 데이터 테이블 렌더링 (검색/정렬 포함)

**Files:**
- Modify: `src/components/OrderRecommendation/OrderRecommendationDashboardPage.jsx`
- Modify: `src/components/OrderRecommendation/OrderRecommendationDashboardPage.module.css`

**Interfaces:**
- Consumes: Task 1에서 확장된 `GET /order-recommendation/daily` 응답 — `items[]`의 각 원소는 `{ yusas_code, product_name, stock_qty, incoming_qty, expected_sales_today, recommended_qty, confirmed_qty, override_reason, ... }`
- Produces: `DailyDataTable({ date, items })` 컴포넌트 — Task 3의 `DailyTableRow`가 이 컴포넌트 안에서 쓰임

- [ ] **Step 1: CSS 클래스 추가**

`src/components/OrderRecommendation/OrderRecommendationDashboardPage.module.css` 맨 끝(108번째 줄 `.statValue` 블록 다음)에 추가:

```css
.dailyTableToolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  margin-bottom: 0.75rem;
}

.dailySearchInput {
  flex: 1;
  max-width: 320px;
  padding: 0.4rem 0.6rem;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 0.85rem;
}

.dailyTableCount {
  font-size: 0.78rem;
  color: var(--text-muted);
}

.dailyTableScroll {
  overflow-x: auto;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
}

.dailyTable {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.82rem;
}

.dailyTable th,
.dailyTable td {
  padding: 0.5rem 0.65rem;
  text-align: left;
  border-bottom: 1px solid var(--border-color);
  white-space: nowrap;
}

.sortableTh {
  cursor: pointer;
  user-select: none;
  color: var(--text-secondary);
  font-weight: 600;
}

.dailySectionHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.75rem;
}

.dailySectionHeader .sectionTitle {
  margin-bottom: 0;
}

.refreshLinkBtn {
  border: none;
  background: none;
  color: var(--text-secondary);
  font-size: 0.78rem;
  cursor: pointer;
  text-decoration: underline;
  padding: 0;
}
```

- [ ] **Step 2: `DailyDataTable` 컴포넌트 작성**

`src/components/OrderRecommendation/OrderRecommendationDashboardPage.jsx`의 `formatNumber` 함수(117~119번째 줄) 바로 뒤, `export default function OrderRecommendationDashboardPage()` (121번째 줄) 앞에 추가:

```jsx
const DAILY_TABLE_COLUMNS = [
  { key: 'product_name', label: '상품명' },
  { key: 'yusas_code', label: '상품코드' },
  { key: 'stock_qty', label: '재고' },
  { key: 'incoming_qty', label: '입고예정' },
  { key: 'expected_sales_today', label: '예상판매량' },
  { key: 'recommended_qty', label: '추천발주량' },
];

function DailyDataTable({ date, items }) {
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState('recommended_qty');
  const [sortDir, setSortDir] = useState('desc');

  const withRecommendation = (items || []).filter((i) => i.recommended_qty != null);
  const term = search.trim();
  const searched = term
    ? withRecommendation.filter(
        (i) => (i.product_name || '').includes(term) || (i.yusas_code || '').includes(term)
      )
    : withRecommendation;
  const sorted = [...searched].sort((a, b) => {
    const av = a[sortKey] ?? -Infinity;
    const bv = b[sortKey] ?? -Infinity;
    if (av === bv) return 0;
    const cmp = av > bv ? 1 : -1;
    return sortDir === 'asc' ? cmp : -cmp;
  });

  const toggleSort = (key) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  return (
    <div>
      <div className={styles.dailyTableToolbar}>
        <input
          type="text"
          className={styles.dailySearchInput}
          placeholder="상품명 또는 상품코드 검색"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <span className={styles.dailyTableCount}>{sorted.length}건</span>
      </div>
      <div className={styles.dailyTableScroll}>
        <table className={styles.dailyTable}>
          <thead>
            <tr>
              {DAILY_TABLE_COLUMNS.map((col) => (
                <th key={col.key} className={styles.sortableTh} onClick={() => toggleSort(col.key)}>
                  {col.label}
                  {sortKey === col.key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
                </th>
              ))}
              <th>확정수량</th>
              <th>사유</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((item) => (
              <tr key={item.yusas_code}>
                <td>{item.product_name || '-'}</td>
                <td>{item.yusas_code}</td>
                <td>{item.stock_qty ?? '-'}</td>
                <td>{item.incoming_qty ?? '-'}</td>
                <td>{item.expected_sales_today != null ? item.expected_sales_today.toFixed(1) : '-'}</td>
                <td>{item.recommended_qty ?? '-'}</td>
                <td colSpan={3} style={{ color: 'var(--text-muted)' }}>Task 3에서 편집 UI로 교체됨</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

(마지막 `colSpan` placeholder 행은 Task 3에서 `DailyTableRow`로 완전히 대체된다 — 이 Task는 조회/검색/정렬만 확인하는 중간 지점.)

- [ ] **Step 3: 대시보드 페이지에 섹션 추가**

`OrderRecommendationDashboardPage.jsx`의 "발주 운영 성과" 섹션(188~208번째 줄) 바로 뒤, 함수 끝나는 `</div>\n  );\n}` (209~211번째 줄) 앞에 추가. `refresh`는 이미 컴포넌트 상단(123번째 줄)에 정의돼 있는 콜백을 그대로 재사용한다 — 로드가 안 뜨거나 실패했을 때 사용자가 눌러서 재시도할 수 있게:

```jsx
      <section className={styles.section}>
        <div className={styles.dailySectionHeader}>
          <h3 className={styles.sectionTitle}>일별 데이터</h3>
          <button type="button" className={styles.refreshLinkBtn} onClick={refresh}>
            새로고침
          </button>
        </div>
        {daily ? (
          <DailyDataTable date={daily.date} items={daily.items} />
        ) : (
          <div className={styles.actionMessage}>
            불러오는 중이거나 실패했습니다. 위 새로고침을 눌러보세요.
          </div>
        )}
      </section>
```

- [ ] **Step 4: 빌드 확인**

Run: `npm run build`
Expected: 에러 없이 빌드 성공.

- [ ] **Step 5: 사용자 수동 확인 요청**

사용자에게 이미 켜져 있는 dev 서버에서 발주 대시보드 페이지를 열어 다음을 확인해달라고 요청한다 (dev 서버를 직접 켜거나 끄지 않는다):
- "일별 데이터" 섹션에 추천발주량이 있는 행만 뜨는지
- 검색창에 상품명/상품코드 입력 시 필터링되는지
- 컬럼 헤더 클릭 시 정렬 방향이 바뀌는지
- 다크모드 토글해도 표가 깨지지 않는지

- [ ] **Step 6: 커밋**

```bash
git add src/components/OrderRecommendation/OrderRecommendationDashboardPage.jsx src/components/OrderRecommendation/OrderRecommendationDashboardPage.module.css
git commit -m "feat: render daily order-recommendation data table with search/sort"
```

---

### Task 3: 프론트엔드 — 확정수량/사유 편집 및 저장

**Files:**
- Modify: `src/components/OrderRecommendation/OrderRecommendationDashboardPage.jsx`
- Modify: `src/components/OrderRecommendation/OrderRecommendationDashboardPage.module.css`

**Interfaces:**
- Consumes: Task 2의 `DailyDataTable`이 렌더링하는 `<tr>` 행, `item.confirmed_qty`/`item.override_reason` (초기값), `date`/`item.yusas_code` (저장 API 호출용)
- Produces: `POST /order-recommendation/{date}/{yusas_code}/confirm` 호출 (기존 백엔드 엔드포인트, 변경 없음)

- [ ] **Step 1: CSS 클래스 추가**

`OrderRecommendationDashboardPage.module.css` 맨 끝에 추가:

```css
.confirmInput {
  width: 70px;
  padding: 0.3rem 0.4rem;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 0.82rem;
}

.reasonInput {
  width: 140px;
  padding: 0.3rem 0.4rem;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 0.82rem;
}

.rowSaveBtn {
  padding: 0.3rem 0.6rem;
  border: 1px solid var(--accent-black);
  border-radius: var(--radius-sm);
  background: var(--accent-black);
  color: var(--accent-white);
  font-size: 0.78rem;
  font-weight: 600;
  cursor: pointer;
}

.rowSaveBtn:disabled {
  opacity: 0.4;
  cursor: default;
  background: var(--bg-secondary);
  color: var(--text-muted);
  border-color: var(--border-color);
}

.rowMessage {
  margin-left: 0.5rem;
  font-size: 0.75rem;
  color: var(--text-muted);
}
```

- [ ] **Step 2: `DailyTableRow` 컴포넌트 작성**

`OrderRecommendationDashboardPage.jsx`에서 `DailyDataTable` 함수 바로 앞에 추가 (Task 2에서 만든 `DAILY_TABLE_COLUMNS` 다음, `DailyDataTable` 정의 이전):

```jsx
function DailyTableRow({ date, item }) {
  const [confirmedQty, setConfirmedQty] = useState(item.confirmed_qty ?? '');
  const [reason, setReason] = useState(item.override_reason ?? '');
  const [savedConfirmedQty, setSavedConfirmedQty] = useState(item.confirmed_qty ?? '');
  const [savedReason, setSavedReason] = useState(item.override_reason ?? '');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  const dirty = String(confirmedQty) !== String(savedConfirmedQty) || reason !== savedReason;

  const save = async () => {
    setSaving(true);
    setMessage('');
    try {
      const res = await fetch(`${API}/order-recommendation/${date}/${item.yusas_code}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({
          confirmed_qty: confirmedQty === '' ? null : Number(confirmedQty),
          override_reason: reason || null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) throw new Error(data?.detail || '저장 실패');
      setSavedConfirmedQty(confirmedQty);
      setSavedReason(reason);
      setMessage('저장됨');
    } catch (err) {
      setMessage(err.message || '저장 실패');
    } finally {
      setSaving(false);
    }
  };

  return (
    <tr>
      <td>{item.product_name || '-'}</td>
      <td>{item.yusas_code}</td>
      <td>{item.stock_qty ?? '-'}</td>
      <td>{item.incoming_qty ?? '-'}</td>
      <td>{item.expected_sales_today != null ? item.expected_sales_today.toFixed(1) : '-'}</td>
      <td>{item.recommended_qty ?? '-'}</td>
      <td>
        <input
          type="number"
          className={styles.confirmInput}
          value={confirmedQty}
          onChange={(e) => setConfirmedQty(e.target.value)}
        />
      </td>
      <td>
        <input
          type="text"
          className={styles.reasonInput}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </td>
      <td>
        <button type="button" className={styles.rowSaveBtn} disabled={!dirty || saving} onClick={save}>
          {saving ? '저장 중...' : '저장'}
        </button>
        {message && <span className={styles.rowMessage}>{message}</span>}
      </td>
    </tr>
  );
}
```

- [ ] **Step 3: `DailyDataTable`의 placeholder 행을 `DailyTableRow`로 교체**

Task 2 Step 2에서 만든 `DailyDataTable`의 `<tbody>` 안 `sorted.map(...)` 블록을 다음으로 교체:

```jsx
          <tbody>
            {sorted.map((item) => (
              <DailyTableRow key={item.yusas_code} date={date} item={item} />
            ))}
          </tbody>
```

- [ ] **Step 4: 빌드 확인**

Run: `npm run build`
Expected: 에러 없이 빌드 성공.

- [ ] **Step 5: 사용자 수동 확인 요청**

사용자에게 dev 서버에서 다음을 확인해달라고 요청한다:
- 확정수량/사유 입력 전엔 저장 버튼이 비활성화 상태인지
- 값을 바꾸면 저장 버튼이 활성화되는지, 저장 클릭 시 "저장됨"이 뜨는지
- 페이지 새로고침 후에도 방금 저장한 확정수량이 유지되는지 (실제 DB 반영 확인)
- 네트워크를 끊고 저장을 시도했을 때 에러 메시지가 뜨고 입력값이 사라지지 않는지

- [ ] **Step 6: 커밋**

```bash
git add src/components/OrderRecommendation/OrderRecommendationDashboardPage.jsx src/components/OrderRecommendation/OrderRecommendationDashboardPage.module.css
git commit -m "feat: allow editing and saving confirmed_qty per row in daily table"
```
