import { useCallback, useEffect, useState } from 'react';
import { ClipboardList, RefreshCw } from 'lucide-react';
import styles from './OrderRecommendationDashboardPage.module.css';
import { LOCAL_API_BASE as API, getAuthHeaders } from '../../lib/api';
import { useEzadminSession } from '../../lib/EzadminSessionContext';
import OrderRecommendationBacktestSection from './OrderRecommendationBacktestSection';
import OrderRecommendationCoverageCheckSection from './OrderRecommendationCoverageCheckSection';
import OrderRecommendationDiscoverSection from './OrderRecommendationDiscoverSection';
import OrderRecommendationTop90Section from './OrderRecommendationTop90Section';
import OrderRecommendationExcelOrderSection from './OrderRecommendationExcelOrderSection';
import DailyTableRow from './DailyTableRow';
import { DAILY_TABLE_COLUMNS, DAILY_TABLE_LABEL_COLUMN_COUNT } from './dailyTableColumns';
import { useDailyRowEdits } from './useDailyRowEdits';
import { useDiscoverMissedReorders } from './useDiscoverMissedReorders';
import { sumValues, formatSum } from './tableSums';

const PAGE_TABS = [
  { key: 'dashboard', label: '대시보드' },
  { key: 'backtest', label: '백테스팅' },
  { key: 'excel-order', label: '엑셀주문' },
];

// 에이블리 재고수집/비에이블리 재고수집/예상발주 계산은 순서가 어긋나면 문제가 생겨서
// (CombinedRunButton 주석 참고) 개별 버튼을 없애고 전체 실행 버튼으로만 돌리게 한다.
const ACTIONS = [
  {
    key: 'sales-history',
    label: '판매량 수집',
    path: '/order-recommendation/collect-sales-history',
    needsSession: false,
    progressPath: '/order-recommendation/collect-sales-history/progress',
  },
  { key: 'evaluate', label: '수요예측 정확도 평가', path: '/order-recommendation/evaluate', needsSession: false },
  { key: 'evaluate-performance', label: '발주성과 평가', path: '/order-recommendation/evaluate-order-performance', needsSession: false },
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

// 에이블리 재고수집 → 비에이블리 재고수집 → 예상발주 계산 → 추가된 상품 조회를 순서대로
// 이어서 실행한다. 순서가 중요하다: 계산(compute)은 재고수집으로 채워진 stock_qty가
// 있어야 그 행을 계산하고, 추가된 상품 조회는 계산이 끝난 뒤라야 방금 계산된 코드들이
// 후보에서 제대로 빠진다(안 그러면 일별 데이터와 겹쳐 보일 수 있음).
function CombinedRunButton({ onSuccess, discover }) {
  const [loading, setLoading] = useState(false);
  const [stepLabel, setStepLabel] = useState('');
  const [message, setMessage] = useState('');
  const { openModal } = useEzadminSession();

  // EZAdmin 세션이 없으면 모달을 띄우고, 모달에서 세션을 저장하면 같은 단계를 자동으로
  // 재시도한다 - 세션은 한 번 저장되면 서버에 공유 저장되므로, 뒤 단계에서 또 필요해도
  // 이미 유효해서 보통은 모달이 한 번만 뜬다.
  const postWithSession = (path) =>
    new Promise((resolve, reject) => {
      const attempt = async () => {
        try {
          const res = await fetch(`${API}${path}`, { method: 'POST', headers: getAuthHeaders() });
          const data = await res.json().catch(() => ({}));
          if (data.need_session) {
            openModal(attempt);
            return;
          }
          if (!res.ok || data.ok === false) {
            reject(new Error(data?.detail || '실행 실패'));
            return;
          }
          resolve(data);
        } catch (err) {
          reject(err);
        }
      };
      attempt();
    });

  const run = async () => {
    setLoading(true);
    setMessage('');
    try {
      setStepLabel('에이블리 재고수집 중...');
      await postWithSession('/order-recommendation/collect');

      setStepLabel('비에이블리 재고수집 중...');
      await postWithSession('/non-ably-order/collect');

      setStepLabel('예상발주 계산 중...');
      await postWithSession('/order-recommendation/compute');

      setStepLabel('추가된 상품 조회 중...');
      await discover.run();

      setMessage('전체 완료');
      onSuccess?.();
    } catch (err) {
      setMessage(err.message || '실행 실패');
    } finally {
      setLoading(false);
      setStepLabel('');
    }
  };

  return (
    <div className={styles.actionCard}>
      <button className={styles.actionBtn} onClick={run} disabled={loading}>
        <RefreshCw size={13} className={loading ? styles.spinning : undefined} />
        {loading ? stepLabel || '실행 중...' : '전체 실행 (재고수집→계산→추가상품)'}
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

function DailyDataTable({ date, items }) {
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState('recommended_qty');
  const [sortDir, setSortDir] = useState('desc');
  const edits = useDailyRowEdits(date);

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

  const dirtyCount = edits.dirtyCount(withRecommendation);

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
        <button
          type="button"
          className={styles.rowSaveBtn}
          disabled={dirtyCount === 0 || edits.savingAll}
          onClick={() => edits.saveAll(withRecommendation)}
        >
          {edits.savingAll ? '일괄저장 중...' : `일괄저장 (${dirtyCount}건)`}
        </button>
        {edits.bulkMessage && <span className={styles.rowMessage}>{edits.bulkMessage}</span>}
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
              <DailyTableRow key={item.yusas_code} item={item} edits={edits} />
            ))}
          </tbody>
          <tfoot>
            <tr className={styles.sumRow}>
              <td colSpan={DAILY_TABLE_LABEL_COLUMN_COUNT}>합계 ({sorted.length}건)</td>
              {DAILY_TABLE_COLUMNS.slice(DAILY_TABLE_LABEL_COLUMN_COUNT).map((col) => (
                <td key={col.key}>
                  {col.numeric ? formatSum(sumValues(sorted, (i) => i[col.key]), col.decimals || 0) : ''}
                </td>
              ))}
              <td>{formatSum(sumValues(sorted, (i) => edits.getFields(i).confirmedQty))}</td>
              <td></td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

export default function OrderRecommendationDashboardPage() {
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);
  const [pageTab, setPageTab] = useState('dashboard');

  const daily = useJsonGet('/order-recommendation/daily', refreshKey);
  const accuracy = useJsonGet('/order-recommendation/forecast-accuracy?days=7', refreshKey);
  const performance = useJsonGet('/order-recommendation/order-performance?days=7', refreshKey);
  const discover = useDiscoverMissedReorders();

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

      <div className={styles.pageTabs}>
        {PAGE_TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            className={`${styles.pageTabBtn} ${pageTab === tab.key ? styles.pageTabBtnActive : ''}`}
            onClick={() => setPageTab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {pageTab === 'backtest' ? (
        <section className={styles.section}>
          <h4 className={styles.sectionTitle}>일별 예측 정확도</h4>
          <OrderRecommendationBacktestSection daily={daily} />
          <h4 className={styles.sectionTitle}>커버리지 검증</h4>
          <OrderRecommendationCoverageCheckSection />
        </section>
      ) : pageTab === 'excel-order' ? (
        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>엑셀주문</h3>
          <OrderRecommendationExcelOrderSection daily={daily} discover={discover} />
        </section>
      ) : (
        <>
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>실행</h3>
        <div className={styles.actionGrid}>
          <CombinedRunButton onSuccess={refresh} discover={discover} />
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
        <h3 className={styles.sectionTitle}>추가된 상품</h3>
        <OrderRecommendationDiscoverSection discover={discover} />
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
        <h3 className={styles.sectionTitle}>TOP90 발주</h3>
        {daily ? (
          <OrderRecommendationTop90Section date={daily.date} />
        ) : (
          <div className={styles.actionMessage}>
            불러오는 중이거나 실패했습니다. 위 새로고침을 눌러보세요.
          </div>
        )}
      </section>
        </>
      )}
    </div>
  );
}
