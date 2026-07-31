import { useCallback, useEffect, useState } from 'react';
import { ClipboardList, RefreshCw } from 'lucide-react';
import styles from './OrderRecommendationDashboardPage.module.css';
import { LOCAL_API_BASE as API, getAuthHeaders } from '../../lib/api';
import { useEzadminSession } from '../../lib/EzadminSessionContext';

const ACTIONS = [
  { key: 'ably-stock', label: '에이블리 재고수집', path: '/order-recommendation/collect', needsSession: true },
  {
    key: 'sales-history',
    label: '판매량 수집',
    path: '/order-recommendation/collect-sales-history',
    needsSession: false,
    progressPath: '/order-recommendation/collect-sales-history/progress',
  },
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
  const [progress, setProgress] = useState(null);
  const { openModal } = useEzadminSession();

  useEffect(() => {
    if (!loading || !action.progressPath) return undefined;
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch(`${API}${action.progressPath}`, { headers: getAuthHeaders() });
        const data = await res.json().catch(() => ({}));
        if (!cancelled && res.ok) setProgress(data);
      } catch {
        // 폴링 실패는 다음 주기에 재시도(에러로 취급하지 않음)
      }
    };
    poll();
    const intervalId = setInterval(poll, 1500);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [loading, action.progressPath]);

  const run = useCallback(async () => {
    setLoading(true);
    setMessage('');
    setProgress(null);
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

  const progressText = loading && progress && progress.total > 0
    ? ` (${progress.done}/${progress.total}건)`
    : '';

  return (
    <div className={styles.actionCard}>
      <button className={styles.actionBtn} onClick={run} disabled={loading}>
        <RefreshCw size={13} className={loading ? styles.spinning : undefined} />
        {loading ? `실행 중...${progressText}` : action.label}
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

const DAILY_TABLE_COLUMNS = [
  { key: 'product_name', label: '상품명' },
  { key: 'yusas_code', label: '상품코드' },
  { key: 'stock_qty', label: '재고' },
  { key: 'expected_sales_today', label: '예상판매량' },
  { key: 'incoming_qty', label: '미송' },
  { key: 'ezadmin_lack_qty', label: '부족수량' },
  { key: 'recommended_qty', label: '추천발주량' },
];

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
      <td>{item.expected_sales_today != null ? item.expected_sales_today.toFixed(1) : '-'}</td>
      <td>{item.incoming_qty ?? '-'}</td>
      <td>{item.ezadmin_lack_qty ?? '-'}</td>
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
              <DailyTableRow key={item.yusas_code} date={date} item={item} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
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

function BacktestSection({ daily }) {
  const [date, setDate] = useState(yesterdayDateStr());
  const [weights, setWeights] = useState(() => initialWeightsFromDaily(daily));
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ date, ...weights });
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
  }, [date, weights]);

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
      </div>

      <div className={styles.dailyTableScroll}>
        <table className={styles.dailyTable}>
          <thead>
            <tr>
              <th>상품명</th>
              <th>예상판매량</th>
              <th>실제판매량</th>
              <th>오차</th>
              <th>±20%적중</th>
            </tr>
          </thead>
          <tbody>
            {(result?.items || []).map((item) => (
              <tr key={item.yusas_code}>
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

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>백테스팅</h3>
        <BacktestSection daily={daily} />
      </section>
    </div>
  );
}
