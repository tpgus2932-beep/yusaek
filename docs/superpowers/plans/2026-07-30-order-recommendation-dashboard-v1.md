# 발주 대시보드 V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 상단바(재고대시보드 옆)에 "발주대시보드" 페이지를 추가한다 —
실행 버튼 6개(에이블리/비에이블리 재고수집, 판매량 수집, 계산, 정확도
평가, 성과평가), 오늘자 요약, 수요예측/발주성과 통계 카드.

**Architecture:** 순수 프론트엔드 작업, 신규 백엔드 API 없음(기존 6개
엔드포인트 그대로 호출). 신규 컴포넌트
`OrderRecommendationDashboardPage.jsx`가 `LOCAL_API_BASE`/
`getAuthHeaders()`(`src/lib/api.js`)로 데이터를 가져오고, EZAdmin
세션이 필요한 2개 액션은 기존 `useEzadminSession()`
(`src/lib/EzadminSessionContext.jsx`) 모달을 재사용한다. `Header.jsx`
상단바에 버튼을 추가하고 `App.jsx`의 `topMode` 스위치에 새 분기를
추가해 배선한다.

**Tech Stack:** React(Vite, JSX, CSS Modules), 기존 `lucide-react`
아이콘. 이 저장소는 프론트엔드 자동 테스트가 없음(CLAUDE.md 명시) —
각 태스크는 `npm run build`로 문법/빌드 오류만 확인하고, 최종적으로
`npm run dev`를 띄워 브라우저에서 수동 확인한다.

## Global Constraints

- 날짜 선택기 없음 — 모든 API 호출은 날짜 파라미터 없이 호출(백엔드가
  오늘 날짜로 기본 처리).
- 스타일은 `src/index.css`에 실제로 정의된 토큰만 사용한다
  (`--bg-primary`, `--bg-secondary`, `--bg-tertiary`, `--border-color`,
  `--text-primary`, `--text-secondary`, `--text-muted`,
  `--accent-black`, `--accent-white`, `--radius-sm|md|lg`,
  `--card-shadow`) — `InventoryDashboardPage.module.css`처럼 정의 안 된
  커스텀 프로퍼티(`--surface`, `--border`, `--bg-card`)나 하드코딩된
  블루/퍼플 색을 쓰지 않는다.
- 신규 백엔드 코드 변경 없음.

참고 스펙: `docs/superpowers/specs/2026-07-30-order-recommendation-dashboard-v1-design.md`

---

### Task 1: `OrderRecommendationDashboardPage` 컴포넌트

**Files:**
- Create: `src/components/OrderRecommendation/OrderRecommendationDashboardPage.jsx`
- Create: `src/components/OrderRecommendation/OrderRecommendationDashboardPage.module.css`

**Interfaces:**
- Consumes: `LOCAL_API_BASE`/`getAuthHeaders`(`src/lib/api.js`),
  `useEzadminSession`(`src/lib/EzadminSessionContext.jsx`).
- Produces: `export default function OrderRecommendationDashboardPage()`
  — 이 컴포넌트만 export, 인자 없음.

- [ ] **Step 1: `OrderRecommendationDashboardPage.module.css` 작성**

```css
.page {
  padding: 1.25rem 1.5rem 2rem;
}

.pageHeader {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 1.25rem;
  color: var(--text-primary);
}

.pageHeader h2 {
  margin: 0;
  font-size: 1.25rem;
  font-weight: 700;
}

.section {
  margin-bottom: 1.5rem;
}

.sectionTitle {
  margin: 0 0 0.75rem;
  font-size: 0.95rem;
  font-weight: 700;
  color: var(--text-primary);
}

.actionGrid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 0.75rem;
}

.actionCard {
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  padding: 0.75rem;
}

.actionBtn {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  width: 100%;
  justify-content: center;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--accent-black);
  border-radius: var(--radius-sm);
  background: var(--accent-black);
  color: var(--accent-white);
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
}

.actionBtn:disabled {
  opacity: 0.6;
  cursor: default;
}

.spinning {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.actionMessage {
  margin-top: 0.5rem;
  padding: 0.4rem 0.6rem;
  border-radius: var(--radius-sm);
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  font-size: 0.78rem;
  color: var(--text-secondary);
}

.statGrid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 0.75rem;
}

.statCard {
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  padding: 0.75rem 1rem;
  box-shadow: var(--card-shadow);
}

.statLabel {
  font-size: 0.75rem;
  color: var(--text-muted);
  margin-bottom: 0.3rem;
}

.statValue {
  font-size: 1.25rem;
  font-weight: 700;
  color: var(--text-primary);
}
```

- [ ] **Step 2: `OrderRecommendationDashboardPage.jsx` 작성**

```jsx
import { useCallback, useEffect, useState } from 'react';
import { ClipboardList, RefreshCw } from 'lucide-react';
import styles from './OrderRecommendationDashboardPage.module.css';
import { LOCAL_API_BASE as API, getAuthHeaders } from '../../lib/api';
import { useEzadminSession } from '../../lib/EzadminSessionContext';

const ACTIONS = [
  { key: 'ably-stock', label: '에이블리 재고수집', path: '/order-recommendation/collect', needsSession: true },
  { key: 'sales-history', label: '판매량 수집', path: '/order-recommendation/collect-sales-history', needsSession: false },
  { key: 'compute', label: '예상발주 계산', path: '/order-recommendation/compute', needsSession: false },
  { key: 'evaluate', label: '수요예측 정확도 평가', path: '/order-recommendation/evaluate', needsSession: false },
  { key: 'evaluate-performance', label: '발주성과 평가', path: '/order-recommendation/evaluate-order-performance', needsSession: false },
  { key: 'non-ably-stock', label: '비에이블리 재고수집', path: '/non-ably-order/collect', needsSession: true },
];

function extractCount(data) {
  if (Array.isArray(data.updated_codes)) return data.updated_codes.length;
  if (typeof data.updated_codes === 'number') return data.updated_codes;
  return data.computed ?? data.evaluated ?? data.updated ?? null;
}

function ActionButton({ action, onSuccess }) {
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const { openModal } = useEzadminSession();

  const run = useCallback(async () => {
    setLoading(true);
    setMessage('');
    try {
      const res = await fetch(`${API}${action.path}`, {
        method: 'POST',
        headers: getAuthHeaders(),
      });
      const data = await res.json().catch(() => ({}));
      if (action.needsSession && data.need_session) {
        openModal(run);
        setMessage('이지어드민 세션이 없습니다. 설정 후 다시 시도해주세요.');
        return;
      }
      if (!res.ok || data.ok === false) throw new Error(data?.detail || '실행 실패');
      const count = extractCount(data);
      setMessage(count === null ? '완료' : `완료 (${count}건)`);
      onSuccess?.();
    } catch (err) {
      setMessage(err.message || '실행 실패');
    } finally {
      setLoading(false);
    }
  }, [action, onSuccess, openModal]);

  return (
    <div className={styles.actionCard}>
      <button className={styles.actionBtn} onClick={run} disabled={loading}>
        <RefreshCw size={13} className={loading ? styles.spinning : undefined} />
        {loading ? '실행 중...' : action.label}
      </button>
      {message && <div className={styles.actionMessage}>{message}</div>}
    </div>
  );
}

function useJsonGet(path, refreshKey) {
  const [data, setData] = useState(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API}${path}`, { headers: getAuthHeaders() });
        const body = await res.json().catch(() => ({}));
        if (!cancelled && res.ok && body.ok) setData(body);
      } catch {
        // 조회 실패 시 이전 값 유지(대시보드 카드는 최신값 없으면 '-' 표시)
      }
    })();
    return () => { cancelled = true; };
  }, [path, refreshKey]);
  return data;
}

function formatPercent(value) {
  return value == null ? '데이터 없음' : `${(value * 100).toFixed(1)}%`;
}

function formatNumber(value, digits = 1) {
  return value == null ? '데이터 없음' : value.toFixed(digits);
}

export default function OrderRecommendationDashboardPage() {
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  const daily = useJsonGet('/order-recommendation/daily', refreshKey);
  const accuracy = useJsonGet('/order-recommendation/forecast-accuracy?days=7', refreshKey);
  const performance = useJsonGet('/order-recommendation/order-performance?days=7', refreshKey);

  const summary = daily
    ? {
        total: (daily.items || []).length,
        confirmed: (daily.items || []).filter((i) => i.confirmed_qty != null).length,
      }
    : null;

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <ClipboardList size={20} />
        <h2>발주 대시보드</h2>
      </header>

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>실행</h3>
        <div className={styles.actionGrid}>
          {ACTIONS.map((action) => (
            <ActionButton key={action.key} action={action} onSuccess={refresh} />
          ))}
        </div>
      </section>

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>오늘자 요약</h3>
        <div className={styles.statGrid}>
          <div className={styles.statCard}>
            <div className={styles.statLabel}>전체 상품</div>
            <div className={styles.statValue}>{summary ? `${summary.total}개` : '-'}</div>
          </div>
          <div className={styles.statCard}>
            <div className={styles.statLabel}>확정 완료</div>
            <div className={styles.statValue}>{summary ? `${summary.confirmed}개` : '-'}</div>
          </div>
        </div>
      </section>

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>수요예측 정확도 (최근 7일)</h3>
        <div className={styles.statGrid}>
          <div className={styles.statCard}>
            <div className={styles.statLabel}>표본 수</div>
            <div className={styles.statValue}>{accuracy ? `${accuracy.sample_count}건` : '-'}</div>
          </div>
          <div className={styles.statCard}>
            <div className={styles.statLabel}>MAE</div>
            <div className={styles.statValue}>{accuracy ? formatNumber(accuracy.mae) : '-'}</div>
          </div>
          <div className={styles.statCard}>
            <div className={styles.statLabel}>WAPE</div>
            <div className={styles.statValue}>{accuracy ? formatPercent(accuracy.wape) : '-'}</div>
          </div>
          <div className={styles.statCard}>
            <div className={styles.statLabel}>±20% 적중률</div>
            <div className={styles.statValue}>{accuracy ? formatPercent(accuracy.hit_rate_20pct) : '-'}</div>
          </div>
        </div>
      </section>

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>발주 운영 성과 (최근 7일)</h3>
        <div className={styles.statGrid}>
          <div className={styles.statCard}>
            <div className={styles.statLabel}>표본 수</div>
            <div className={styles.statValue}>{performance ? `${performance.sample_count}건` : '-'}</div>
          </div>
          <div className={styles.statCard}>
            <div className={styles.statLabel}>평균 확정편차</div>
            <div className={styles.statValue}>{performance ? formatNumber(performance.avg_confirm_deviation) : '-'}</div>
          </div>
          <div className={styles.statCard}>
            <div className={styles.statLabel}>평균 입고편차</div>
            <div className={styles.statValue}>{performance ? formatNumber(performance.avg_fulfillment_gap) : '-'}</div>
          </div>
          <div className={styles.statCard}>
            <div className={styles.statLabel}>평균 미송증감</div>
            <div className={styles.statValue}>{performance ? formatNumber(performance.avg_incoming_qty_change) : '-'}</div>
          </div>
        </div>
      </section>
    </div>
  );
}
```

- [ ] **Step 3: 빌드 확인**

Run: `npm run build`
Expected: 에러 없이 빌드 성공(문법/import 오류 없음 확인용 — 이
저장소는 프론트엔드 자동 테스트가 없어 빌드 통과가 최소 검증 기준).

- [ ] **Step 4: 커밋**

```bash
git add src/components/OrderRecommendation/OrderRecommendationDashboardPage.jsx src/components/OrderRecommendation/OrderRecommendationDashboardPage.module.css
git commit -m "feat: add order-recommendation dashboard page"
```

---

### Task 2: `Header.jsx` / `App.jsx` 배선

**Files:**
- Modify: `src/components/Layout/Header.jsx`
- Modify: `src/App.jsx`

**Interfaces:**
- Consumes: `OrderRecommendationDashboardPage`(Task 1 산출물).
- Produces: 없음(배선만).

- [ ] **Step 1: `Header.jsx` 수정**

`import { Bell, DatabaseZap, Key, Warehouse } from 'lucide-react';`를:

```jsx
import { Bell, ClipboardList, DatabaseZap, Key, Warehouse } from 'lucide-react';
```

재고대시보드 버튼(`topMode === 'inventory-dashboard'` 블록, 123~130번째
줄 근처) 바로 다음에 추가:

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

- [ ] **Step 2: `App.jsx` 수정**

`import InventoryDashboardPage from
'./components/InventoryDashboard/InventoryDashboardPage';`(27번째 줄
근처) 바로 다음에 추가:

```jsx
import OrderRecommendationDashboardPage from './components/OrderRecommendation/OrderRecommendationDashboardPage';
```

`const [topMode, setTopMode] = useState('home'); // 'home' |
'db-manager' | 'inventory-dashboard'`(45번째 줄 근처) 주석을:

```jsx
  const [topMode, setTopMode] = useState('home'); // 'home' | 'db-manager' | 'inventory-dashboard' | 'order-dashboard'
```

`{topMode === 'inventory-dashboard' && <InventoryDashboardPage />}`
(278번째 줄 근처) 바로 다음에 추가:

```jsx
        {topMode === 'order-dashboard' && <OrderRecommendationDashboardPage />}
```

- [ ] **Step 3: 빌드 확인**

Run: `npm run build`
Expected: 에러 없이 빌드 성공.

- [ ] **Step 4: 커밋**

```bash
git add src/components/Layout/Header.jsx src/App.jsx
git commit -m "feat: wire order-recommendation dashboard into top nav"
```

---

## 최종 확인

- [ ] `npm run build` 에러 없음(Task 1, 2 각각에서 이미 확인했지만
      최종 통합 확인)
- [ ] `npm run dev`로 개발 서버 실행 후 브라우저에서: 상단바에
      "발주대시보드" 버튼이 재고대시보드 옆에 보이는지, 클릭 시 페이지
      전환되는지, 실행 버튼 6개가 각각 동작하는지(에이블리/비에이블리
      재고수집은 EZAdmin 세션 없으면 모달이 뜨는지), 오늘자 요약과
      통계 카드가 채워지는지, 다크모드 토글에서 색이 깨지지 않는지
      확인.
