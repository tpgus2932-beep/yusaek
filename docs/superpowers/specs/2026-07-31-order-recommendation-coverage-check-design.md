# 발주 대시보드 — 커버리지 검증 섹션

## 배경

발주추천량(`recommended_qty`)은 이제 상품마다 예상판매량 구간에 따라 자동으로
1/3/5/7일치 커버리지로 계산된다(`coverage_days_used`에 스냅샷 저장됨). 기존
"백테스팅" 탭의 "일별 예측 정확도" 섹션은 `expected_sales_today`(하루 예측)를
과거 방향으로 검증하는데, 이건 "그날 낸 추천발주량이 실제로 그 커버리지
기간 수요를 얼마나 잘 커버했는지"는 보여주지 못한다 — 커버리지 계산
(`calc_expected_sales_for_coverage`) 자체가 날짜 D부터 미래 방향(D, D+1, ...,
D+coverage-1)으로 합산하는 구조이기 때문에, 검증도 같은 방향으로 가야 한다.

이번 라운드는 "커버리지 검증" 섹션을 추가해서, 과거 특정 날짜에 실제로
계산됐던 추천발주량이 그 커버리지 기간의 실제 판매량 합계와 비교했을 때
얼마나 정확했는지 보여준다.

## 목표

**데이터 소스**: 재계산 없음. `order_recommendation_daily`에 이미 저장된
`recommended_qty`/`coverage_days_used`를 그대로 읽는다.

**대상 범위**: 선택한 날짜 D에 `recommended_qty IS NOT NULL`인 모든 상품
(오늘 표본이 아니라 D 시점에 실제로 추천이 나왔던 상품 전체).

**계산**: 상품별로 `coverage_days_used`만큼 D부터 미래 방향으로
(`D, D+1, ..., D+coverage_days_used-1`) 실제 `sales_qty`를 합산해
`actual_coverage_sales`를 구하고, `recommended_qty`와 비교한다.

```
오차 = recommended_qty - actual_coverage_sales
```

**미완료 기간 처리**: 그 기간 중 하루라도 `sales_qty`가 없으면(아직 지나지
않은 날짜 포함) 그 상품은 이번 날짜의 결과에서 통째로 제외한다. 부분 데이터로
합산하지 않는다.

**입력**: 단일 날짜 선택기만 있음(가중치/기간 입력 없음 — 커버리지가 상품별
자동이라 사용자가 조정할 게 없음).

**출력**: 집계 카드(표본수·MAE·WAPE·평균편향·±20%적중률) + 상품별 상세
테이블(상품명·커버리지일수·추천발주량·실제판매합계·오차·±20%적중여부).
기존 "일별 예측 정확도" 섹션과 같은 시각적 패턴, 같은 계산 공식
(`calc_forecast_error`/`calc_within_20_percent`)을 재사용하되 대상 값만
다르다(`recommended_qty` vs `actual_coverage_sales`).

## 비범위

- 재계산/가중치 실험 — 이 섹션은 순수 히스토리 검증용, 백테스트 미리보기
  기능 없음.
- 상품별 검색/필터 — 기존 백테스트 섹션과 동일하게 표본 전체 표시.
- 미완료 상품에 대한 부분 결과 표시 — 완전히 제외만 한다.

## 백엔드

### `GET /order-recommendation/coverage-check`

`backend/api/order_recommendation_routes.py`의 `backtest` 핸들러 뒤에 추가:

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
            # 기간 중 하루라도 없으면(행 자체가 없거나 sales_qty NULL) 제외
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

`calc_forecast_error`/`calc_within_20_percent`는 이미 import돼 있음(기존
`backtest` 핸들러에서 사용 중). 신규 import 불필요.

## 프론트엔드

`src/components/OrderRecommendation/OrderRecommendationCoverageCheckSection.jsx`
신규 파일. `OrderRecommendationBacktestSection.jsx`와 같은 스타일 클래스
재사용(`styles.statGrid`, `styles.dailyTable` 등), 날짜 선택기만 있고
가중치/기간 입력 없음. 날짜 바뀔 때 디바운스 없이 바로 조회(가중치 조정처럼
빈번하게 바뀌는 값이 아니므로).

`OrderRecommendationDashboardPage.jsx`의 "백테스팅" 탭 렌더링 부분에서
`OrderRecommendationBacktestSection` 다음에 소제목과 함께 추가:

```jsx
{pageTab === 'backtest' ? (
  <section className={styles.section}>
    <h4 className={styles.sectionTitle}>일별 예측 정확도</h4>
    <OrderRecommendationBacktestSection daily={daily} />
    <h4 className={styles.sectionTitle}>커버리지 검증</h4>
    <OrderRecommendationCoverageCheckSection />
  </section>
) : (
  ...
)}
```

## 테스트

- 백엔드 (`test_order_recommendation_routes.py`):
  - 커버리지 1일 상품: 단일 날짜 실제판매량과 정상 비교
  - 커버리지 3일 상품: 3일치 합산 정상 작동
  - 기간 중 하루라도 `sales_qty` 없으면 그 상품이 결과에서 제외되는지
  - 집계(표본수/MAE/WAPE/편향/±20%적중률) 계산 정확성
- 프론트: 자동 테스트 없음(프로젝트 관례) — `npm run build`로 컴파일 확인,
  날짜 선택 시 결과 갱신되는지 수동 확인.
