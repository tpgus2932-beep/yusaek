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
