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
