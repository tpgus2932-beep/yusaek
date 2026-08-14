# 발주 대시보드 커버리지 검증 섹션 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 백테스팅 탭에 "커버리지 검증" 섹션을 추가해서, 과거 날짜 D 시점에 저장됐던 `recommended_qty`가 그 상품의 자동 커버리지 기간(D~D+coverage_days_used-1) 동안의 실제 판매량 합계와 비교했을 때 얼마나 정확했는지 보여준다.

**Architecture:** 백엔드에 `GET /order-recommendation/coverage-check?date=` 신규 라우트를 추가해서 `order_recommendation_daily`에 이미 저장된 값만 읽어(재계산 없음) 상품별 미래방향 커버리지 합산 및 오차 집계를 반환한다. 프론트엔드는 `OrderRecommendationCoverageCheckSection.jsx` 신규 컴포넌트를 만들어 기존 `OrderRecommendationBacktestSection`과 같은 시각 패턴(통계 카드 + 상세 테이블)으로 결과를 표시하고, 대시보드 페이지의 "백테스팅" 탭 안에 기존 섹션 아래 나란히 배치한다.

**Tech Stack:** FastAPI + `sqlite3.Row`(백엔드), React + CSS Modules(프론트엔드). 프론트엔드 자동 테스트 없음(프로젝트 관례) — `npm run build`로 컴파일만 확인.

## Global Constraints

- 재계산 없음: `order_recommendation_daily`에 이미 저장된 `recommended_qty`/`coverage_days_used`/`sales_qty`만 읽는다.
- 대상 범위: 선택 날짜 D에 `recommended_qty IS NOT NULL`인 모든 상품(오늘 시점 표본이 아니라 D 시점 표본 전체).
- 커버리지 기간 중 하루라도 `sales_qty`가 없으면(행 없음 또는 NULL) 그 상품은 결과에서 완전히 제외(부분 합산 금지).
- 입력은 날짜 하나만(가중치/기간 조정 UI 없음).
- 기존 `calc_forecast_error`/`calc_within_20_percent` 계산 공식을 재사용한다(신규 계산 로직 없음).
- 신규 백엔드 로직은 반드시 실패하는 테스트를 먼저 작성 → 실패 확인 → 구현 → 통과 확인 순서로 진행한다(TDD).

---

### Task 1: `GET /order-recommendation/coverage-check` 백엔드 라우트

**Files:**
- Modify: `backend/api/order_recommendation_routes.py:188-190` (기존 `/backtest` 핸들러의 `conn.close()` 뒤, `/weights` 앞에 신규 라우트 삽입)
- Test: `backend/tests/test_order_recommendation_routes.py`

**Interfaces:**
- Consumes: 기존 import된 `calc_forecast_error`, `calc_within_20_percent` (both from `services.order_recommendation_evaluate`, 이미 파일 상단에 import돼 있음 — 신규 import 불필요), `load_wonbe_product_name_map` (이미 import돼 있음), `get_db`, `get_current_user` (라우터 팩토리 인자로 이미 존재)
- Produces: `GET /order-recommendation/coverage-check?date=YYYY-MM-DD` → `{"ok": true, "date": str, "sample_count": int, "mae": float|None, "wape": float|None, "bias": float|None, "hit_rate_20pct": float|None, "items": [{"yusas_code": str, "product_name": str, "coverage_days_used": int, "recommended_qty": int, "actual_coverage_sales": int, "forecast_error": float|None, "within_20_percent": 1|0|None}]}` (기존 `/backtest`와 동일하게 `calc_within_20_percent`가 1/0 정수를 반환한다). Task 2(프론트엔드)가 이 응답 스키마를 그대로 소비한다.

현재 파일 상태 확인(라인 110-199, `/backtest`와 `/weights` 사이):
```python
    @router.get("/backtest")
    def backtest(
        ...
        finally:
            conn.close()

    @router.post("/weights")
    def save_weights(payload: dict = Body(...), user: str = Depends(get_current_user)):
        ...
```

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_order_recommendation_routes.py`에 다음 4개 테스트를 추가한다. 파일 상단에 이미 `ensure_row`, `today_kst`가 import돼 있고(`from services.order_recommendation_store import ensure_row, init_order_recommendation_tables, today_kst`), `_make_client()`는 `(client, get_db, _keep_alive, _store)`를 반환하며, 행은 `ensure_row(conn, date, code)`로 뼈대를 만든 뒤 `UPDATE ... SET col = ?`로 값을 채우는 기존 관례를 그대로 따른다(`test_backtest_returns_items_only_for_products_with_recommended_qty_today` 등 참고). `_stub_wonbe_product_name_map` autouse fixture 때문에 `product_name`은 항상 빈 문자열이다:

```python
def test_coverage_check_single_day_coverage_matches_actual_sales():
    client, get_db, _keep_alive, _store = _make_client()
    conn = get_db()
    ensure_row(conn, "2026-07-01", "YUSAS00001")
    conn.execute(
        "UPDATE order_recommendation_daily SET recommended_qty = ?, coverage_days_used = ?, sales_qty = ? "
        "WHERE date = ? AND yusas_code = ?",
        (10, 1, 8, "2026-07-01", "YUSAS00001"),
    )
    conn.commit()
    conn.close()

    res = client.get("/order-recommendation/coverage-check", params={"date": "2026-07-01"})
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is True
    assert body["sample_count"] == 1
    item = body["items"][0]
    assert item["yusas_code"] == "YUSAS00001"
    assert item["coverage_days_used"] == 1
    assert item["recommended_qty"] == 10
    assert item["actual_coverage_sales"] == 8
    assert item["forecast_error"] == pytest.approx(2.0)


def test_coverage_check_multi_day_coverage_sums_forward():
    client, get_db, _keep_alive, _store = _make_client()
    conn = get_db()
    ensure_row(conn, "2026-07-01", "YUSAS00002")
    conn.execute(
        "UPDATE order_recommendation_daily SET recommended_qty = ?, coverage_days_used = ?, sales_qty = ? "
        "WHERE date = ? AND yusas_code = ?",
        (15, 3, 5, "2026-07-01", "YUSAS00002"),
    )
    ensure_row(conn, "2026-07-02", "YUSAS00002")
    conn.execute(
        "UPDATE order_recommendation_daily SET sales_qty = ? WHERE date = ? AND yusas_code = ?",
        (4, "2026-07-02", "YUSAS00002"),
    )
    ensure_row(conn, "2026-07-03", "YUSAS00002")
    conn.execute(
        "UPDATE order_recommendation_daily SET sales_qty = ? WHERE date = ? AND yusas_code = ?",
        (6, "2026-07-03", "YUSAS00002"),
    )
    conn.commit()
    conn.close()

    res = client.get("/order-recommendation/coverage-check", params={"date": "2026-07-01"})
    body = res.json()
    item = body["items"][0]
    assert item["actual_coverage_sales"] == 15  # 5 + 4 + 6
    assert item["recommended_qty"] == 15
    assert item["forecast_error"] == pytest.approx(0.0)


def test_coverage_check_excludes_product_with_incomplete_window():
    client, get_db, _keep_alive, _store = _make_client()
    conn = get_db()
    ensure_row(conn, "2026-07-01", "YUSAS00003")
    conn.execute(
        "UPDATE order_recommendation_daily SET recommended_qty = ?, coverage_days_used = ?, sales_qty = ? "
        "WHERE date = ? AND yusas_code = ?",
        (10, 3, 5, "2026-07-01", "YUSAS00003"),
    )
    ensure_row(conn, "2026-07-02", "YUSAS00003")
    conn.execute(
        "UPDATE order_recommendation_daily SET sales_qty = ? WHERE date = ? AND yusas_code = ?",
        (4, "2026-07-02", "YUSAS00003"),
    )
    # 2026-07-03 행 자체가 없음 -> 커버리지 3일 기간이 미완료 -> 결과에서 제외돼야 함
    conn.commit()
    conn.close()

    res = client.get("/order-recommendation/coverage-check", params={"date": "2026-07-01"})
    body = res.json()
    assert body["items"] == []
    assert body["sample_count"] == 0


def test_coverage_check_aggregates_mae_wape_bias_hit_rate():
    client, get_db, _keep_alive, _store = _make_client()
    conn = get_db()
    ensure_row(conn, "2026-07-01", "YUSAS_A")
    conn.execute(
        "UPDATE order_recommendation_daily SET recommended_qty = ?, coverage_days_used = ?, sales_qty = ? "
        "WHERE date = ? AND yusas_code = ?",
        (12, 1, 10, "2026-07-01", "YUSAS_A"),
    )
    ensure_row(conn, "2026-07-01", "YUSAS_B")
    conn.execute(
        "UPDATE order_recommendation_daily SET recommended_qty = ?, coverage_days_used = ?, sales_qty = ? "
        "WHERE date = ? AND yusas_code = ?",
        (8, 1, 10, "2026-07-01", "YUSAS_B"),
    )
    conn.commit()
    conn.close()

    res = client.get("/order-recommendation/coverage-check", params={"date": "2026-07-01"})
    body = res.json()

    # YUSAS_A: 오차 +2 (|2|<=20%*10=2 -> 적중), YUSAS_B: 오차 -2 (|2|<=2 -> 적중)
    assert body["sample_count"] == 2
    assert body["mae"] == pytest.approx(2.0)
    assert body["wape"] == pytest.approx(4 / 20)
    assert body["bias"] == pytest.approx(0 / 20)
    assert body["hit_rate_20pct"] == pytest.approx(1.0)
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && python -m pytest tests/test_order_recommendation_routes.py -k coverage_check -v`
Expected: FAIL (404 Not Found — `/order-recommendation/coverage-check` 라우트가 아직 없음)

- [ ] **Step 3: 라우트 구현**

`backend/api/order_recommendation_routes.py`의 188번째 줄(`/backtest` 핸들러의 `conn.close()`) 뒤, 190번째 줄(`@router.post("/weights")`) 앞에 삽입:

```python
    @router.get("/coverage-check")
    def coverage_check(date: str, user: str = Depends(get_current_user)):
        conn = get_db()
        try:
            rows = conn.execute(
                "SELECT yusas_code, recommended_qty, coverage_days_used FROM order_recommendation_daily "
                "WHERE date = ? AND recommended_qty IS NOT NULL",
                (date,),
            ).fetchall()
            name_map = load_wonbe_product_name_map()

            items = []
            for r in rows:
                coverage_days = int(r["coverage_days_used"] or 1)
                target_dates = [
                    (datetime.strptime(date, "%Y-%m-%d") + timedelta(days=offset)).strftime("%Y-%m-%d")
                    for offset in range(coverage_days)
                ]
                placeholders = ",".join("?" * len(target_dates))
                sales_rows = conn.execute(
                    f"SELECT date, sales_qty FROM order_recommendation_daily "
                    f"WHERE yusas_code = ? AND date IN ({placeholders})",
                    (r["yusas_code"], *target_dates),
                ).fetchall()
                sales_by_date = {sr["date"]: sr["sales_qty"] for sr in sales_rows}
                if len(sales_by_date) < len(target_dates) or any(
                    sales_by_date.get(d) is None for d in target_dates
                ):
                    continue
                actual_coverage_sales = sum(sales_by_date[d] for d in target_dates)
                recommended_qty = r["recommended_qty"]
                forecast_error = calc_forecast_error(recommended_qty, actual_coverage_sales)
                absolute_error = abs(forecast_error) if forecast_error is not None else None
                within_20_percent = calc_within_20_percent(absolute_error, actual_coverage_sales)
                items.append({
                    "yusas_code": r["yusas_code"],
                    "product_name": name_map.get(r["yusas_code"], ""),
                    "coverage_days_used": coverage_days,
                    "recommended_qty": recommended_qty,
                    "actual_coverage_sales": actual_coverage_sales,
                    "forecast_error": forecast_error,
                    "within_20_percent": within_20_percent,
                })

            signed_errors = [i["forecast_error"] for i in items if i["forecast_error"] is not None]
            abs_errors = [abs(e) for e in signed_errors]
            actuals = [i["actual_coverage_sales"] for i in items if i["forecast_error"] is not None]
            hit_flags = [i["within_20_percent"] for i in items if i["within_20_percent"] is not None]
            mae = sum(abs_errors) / len(abs_errors) if abs_errors else None
            actual_sum = sum(actuals)
            wape = (sum(abs_errors) / actual_sum) if abs_errors and actual_sum > 0 else None
            bias = (sum(signed_errors) / actual_sum) if signed_errors and actual_sum > 0 else None
            hit_rate_20pct = (sum(hit_flags) / len(hit_flags)) if hit_flags else None

            return {
                "ok": True, "date": date,
                "sample_count": len(hit_flags), "mae": mae, "wape": wape, "bias": bias,
                "hit_rate_20pct": hit_rate_20pct, "items": items,
            }
        finally:
            conn.close()

```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && python -m pytest tests/test_order_recommendation_routes.py -k coverage_check -v`
Expected: PASS (4개 테스트 모두)

- [ ] **Step 5: 전체 백엔드 회귀 테스트**

Run: `cd backend && python -m pytest`
Expected: 기존 통과하던 전체 스위트(347개, Task 시작 전 기준) + 신규 4개 = 351개 모두 PASS

- [ ] **Step 6: 커밋**

먼저 `git status` / `git diff --stat`로 이 작업과 무관한 기존 미커밋 변경(dirty worktree WIP)이 섞이지 않았는지 확인한 뒤:

```bash
git add backend/api/order_recommendation_routes.py backend/tests/test_order_recommendation_routes.py
git commit -m "feat: add coverage-check backend route for forward-looking recommended_qty validation"
```

---

### Task 2: 프론트엔드 `OrderRecommendationCoverageCheckSection` 컴포넌트 + 탭 배치

**Files:**
- Create: `src/components/OrderRecommendation/OrderRecommendationCoverageCheckSection.jsx`
- Modify: `src/components/OrderRecommendation/OrderRecommendationDashboardPage.jsx:1-10` (import 추가), `:311-314` (렌더링부 수정)

**Interfaces:**
- Consumes: Task 1의 `GET /order-recommendation/coverage-check?date=` 응답 스키마(위 Task 1 "Produces" 참조), `LOCAL_API_BASE`/`getAuthHeaders` (from `../../lib/api`, `OrderRecommendationBacktestSection.jsx`와 동일 패턴)
- Produces: `<OrderRecommendationCoverageCheckSection />` (props 없음 — 날짜는 컴포넌트 내부 state로 관리)

현재 `OrderRecommendationDashboardPage.jsx` 관련 부분:
```jsx
// line 6
import OrderRecommendationBacktestSection from './OrderRecommendationBacktestSection';

// lines 311-314
      {pageTab === 'backtest' ? (
        <section className={styles.section}>
          <OrderRecommendationBacktestSection daily={daily} />
        </section>
      ) : (
```

기존 섹션 제목 스타일 확인됨(`grep` 결과) — 이 파일은 소제목에 `<h3 className={styles.sectionTitle}>`를 일관되게 사용한다(`<h4>` 아님). 신규 섹션 제목도 이 관례를 따른다.

- [ ] **Step 1: 신규 컴포넌트 파일 작성**

`src/components/OrderRecommendation/OrderRecommendationCoverageCheckSection.jsx` 신규 생성:

```jsx
import { useEffect, useState } from 'react';
import styles from './OrderRecommendationDashboardPage.module.css';
import { LOCAL_API_BASE as API, getAuthHeaders } from '../../lib/api';

function formatPercent(value) {
  return value == null ? '데이터 없음' : `${(value * 100).toFixed(1)}%`;
}

function formatNumber(value, digits = 1) {
  return value == null ? '데이터 없음' : value.toFixed(digits);
}

function yesterdayDateStr() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

function minCoverageCheckDateStr() {
  const d = new Date();
  d.setDate(d.getDate() - 28);
  return d.toISOString().slice(0, 10);
}

export default function OrderRecommendationCoverageCheckSection() {
  const [date, setDate] = useState(yesterdayDateStr());
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const params = new URLSearchParams({ date });
        const res = await fetch(`${API}/order-recommendation/coverage-check?${params}`, {
          headers: getAuthHeaders(),
        });
        const data = await res.json().catch(() => ({}));
        if (!cancelled && res.ok && data.ok) setResult(data);
      } catch {
        // 조회 실패 시 이전 결과 유지
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [date]);

  return (
    <div>
      <div className={styles.backtestControls}>
        <div className={styles.backtestField}>
          <label>날짜</label>
          <input
            type="date"
            className={styles.backtestDateInput}
            value={date}
            min={minCoverageCheckDateStr()}
            max={yesterdayDateStr()}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>
      </div>

      <div className={styles.statGrid}>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>표본 수</div>
          <div className={styles.statValue}>{result ? `${result.sample_count}건` : loading ? '계산 중...' : '-'}</div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>MAE</div>
          <div className={styles.statValue}>{result ? formatNumber(result.mae) : '-'}</div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>WAPE</div>
          <div className={styles.statValue}>{result ? formatPercent(result.wape) : '-'}</div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>±20% 적중률</div>
          <div className={styles.statValue}>{result ? formatPercent(result.hit_rate_20pct) : '-'}</div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>평균 편향</div>
          <div className={styles.statValue}>
            {result && result.bias != null
              ? `${result.bias > 0 ? '+' : ''}${(result.bias * 100).toFixed(1)}%`
              : '-'}
          </div>
        </div>
      </div>

      <div className={styles.dailyTableScroll}>
        <table className={styles.dailyTable}>
          <thead>
            <tr>
              <th>상품명</th>
              <th>커버리지(일)</th>
              <th>추천발주량</th>
              <th>실제판매합계</th>
              <th>오차</th>
              <th>±20%적중</th>
            </tr>
          </thead>
          <tbody>
            {(result?.items || []).map((item) => (
              <tr key={item.yusas_code}>
                <td>{item.product_name || '-'}</td>
                <td>{item.coverage_days_used}</td>
                <td>{item.recommended_qty}</td>
                <td>{item.actual_coverage_sales}</td>
                <td>{item.forecast_error != null ? item.forecast_error.toFixed(1) : '-'}</td>
                <td>{item.within_20_percent == null ? '-' : item.within_20_percent ? '✓' : '✗'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 대시보드 페이지에 import + 탭 렌더링 배치**

`src/components/OrderRecommendation/OrderRecommendationDashboardPage.jsx` 6번째 줄(`OrderRecommendationBacktestSection` import) 바로 뒤에 추가:

```jsx
import OrderRecommendationCoverageCheckSection from './OrderRecommendationCoverageCheckSection';
```

311-314번째 줄을 다음으로 교체:

```jsx
      {pageTab === 'backtest' ? (
        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>일별 예측 정확도</h3>
          <OrderRecommendationBacktestSection daily={daily} />
          <h3 className={styles.sectionTitle}>커버리지 검증</h3>
          <OrderRecommendationCoverageCheckSection />
        </section>
      ) : (
```

- [ ] **Step 3: 빌드 확인**

Run: `npm run build`
Expected: 에러 없이 빌드 성공

- [ ] **Step 4: 수동 확인**

`npm run dev`가 이미 사용자에 의해 실행 중일 수 있으므로 직접 켜지 말고, 사용자가 브라우저에서 "발주대시보드 → 백테스팅 탭"으로 이동해 "커버리지 검증" 섹션이 "일별 예측 정확도" 섹션 아래에 나타나는지, 날짜를 바꾸면 표와 카드가 갱신되는지 확인하도록 안내한다.

- [ ] **Step 5: 커밋**

`git status` / `git diff --stat`로 무관한 변경 섞임 여부 확인 후:

```bash
git add src/components/OrderRecommendation/OrderRecommendationCoverageCheckSection.jsx src/components/OrderRecommendation/OrderRecommendationDashboardPage.jsx
git commit -m "feat: add coverage verification section to backtest tab"
```

---

## 완료 후

Task 1, 2가 모두 끝나면 `superpowers:finishing-a-development-branch` 절차대로 전체 테스트 재확인 후 사용자에게 다음 단계(로컬 병합 / PR 생성 / 그대로 유지)를 묻는다. 이 세션은 별도 브랜치 없이 현재 브랜치에서 계속 작업 중이었으므로, 병합 절차 대신 "지금까지 쌓인 미푸시 커밋을 origin에 push할지"를 사용자에게 명시적으로 확인한다(이미 여러 차례 확인된 프로젝트 관례).
