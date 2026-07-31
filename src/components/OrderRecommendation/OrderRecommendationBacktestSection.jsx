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

function minBacktestDateStr() {
  const d = new Date();
  d.setDate(d.getDate() - 28);
  return d.toISOString().slice(0, 10);
}

const WEIGHT_FIELDS = [
  { key: 'weight_weekday_average', label: '같은요일' },
  { key: 'weight_previous_day', label: '전날' },
  { key: 'weight_avg_7d', label: '7일' },
  { key: 'weight_avg_14d', label: '14일' },
  { key: 'weight_avg_3d', label: '3일' },
];

const DEFAULT_WEIGHTS = {
  weight_weekday_average: 0.2,
  weight_previous_day: 0.25,
  weight_avg_7d: 0.2,
  weight_avg_14d: 0.15,
  weight_avg_3d: 0.2,
};

function initialWeightsFromDaily(daily) {
  const item = (daily?.items || []).find((i) => i.model_weight_weekday != null);
  if (!item) return { ...DEFAULT_WEIGHTS };
  return {
    weight_weekday_average: item.model_weight_weekday,
    weight_previous_day: item.model_weight_previous_day,
    weight_avg_7d: item.model_weight_avg_7d,
    weight_avg_14d: item.model_weight_avg_14d,
    weight_avg_3d: item.model_weight_avg_3d,
  };
}

export default function OrderRecommendationBacktestSection({ daily }) {
  const [date, setDate] = useState(yesterdayDateStr());
  const [days, setDays] = useState(1);
  const [weights, setWeights] = useState(() => initialWeightsFromDaily(daily));
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ date, days, ...weights });
        const res = await fetch(`${API}/order-recommendation/backtest?${params}`, {
          headers: getAuthHeaders(),
        });
        const data = await res.json().catch(() => ({}));
        if (!cancelled && res.ok && data.ok) setResult(data);
      } catch {
        // 조회 실패 시 이전 결과 유지
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [date, days, weights]);

  const saveWeights = async () => {
    setSaveMessage('저장 중...');
    try {
      const res = await fetch(`${API}/order-recommendation/weights`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify(weights),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) throw new Error(data?.detail || '저장 실패');
      setSaveMessage('저장됨 — 다음 예상발주 계산부터 이 가중치가 적용됩니다');
    } catch (err) {
      setSaveMessage(err.message || '저장 실패');
    }
  };

  return (
    <div>
      <div className={styles.backtestControls}>
        <div className={styles.backtestField}>
          <label>날짜</label>
          <input
            type="date"
            className={styles.backtestDateInput}
            value={date}
            min={minBacktestDateStr()}
            max={yesterdayDateStr()}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>
        <div className={styles.backtestField}>
          <label>기간(일수, 최대 5일)</label>
          <input
            type="number"
            min="1"
            max="5"
            step="1"
            className={styles.backtestWeightInput}
            value={days}
            onChange={(e) => setDays(Math.min(5, Math.max(1, Number(e.target.value) || 1)))}
          />
        </div>
        {WEIGHT_FIELDS.map((f) => (
          <div key={f.key} className={styles.backtestField}>
            <label>{f.label}</label>
            <input
              type="number"
              step="0.01"
              min="0"
              className={styles.backtestWeightInput}
              value={weights[f.key]}
              onChange={(e) =>
                setWeights((w) => ({ ...w, [f.key]: e.target.value === '' ? '' : Number(e.target.value) }))
              }
            />
          </div>
        ))}
        <button type="button" className={styles.backtestSaveBtn} onClick={saveWeights}>
          이 가중치로 저장
        </button>
        {saveMessage && <span className={styles.backtestSaveMsg}>{saveMessage}</span>}
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
              <th>날짜</th>
              <th>상품명</th>
              <th>예상판매량</th>
              <th>실제판매량</th>
              <th>오차</th>
              <th>±20%적중</th>
            </tr>
          </thead>
          <tbody>
            {(result?.items || []).map((item) => (
              <tr key={`${item.date}-${item.yusas_code}`}>
                <td>{item.date}</td>
                <td>{item.product_name || '-'}</td>
                <td>{item.expected_sales_today != null ? item.expected_sales_today.toFixed(1) : '-'}</td>
                <td>{item.actual_sales_qty ?? '-'}</td>
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
