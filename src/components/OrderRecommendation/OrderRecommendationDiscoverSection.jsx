import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import styles from './OrderRecommendationDashboardPage.module.css';
import DailyTableRow from './DailyTableRow';
import { DAILY_TABLE_COLUMNS } from './dailyTableColumns';
import { LOCAL_API_BASE as API, getAuthHeaders } from '../../lib/api';
import { useEzadminSession } from '../../lib/EzadminSessionContext';

const DEFAULT_DAYS = 3;
const DEFAULT_LIMIT = 150;

// 이 섹션은 부족수량 자리에 접수수량(pending)을 대신 채우므로("일별 데이터"와 필드명만
// 맞춘 것, toDailyRowItem 참고), 헤더 라벨도 이 섹션에서만 "접수"로 바꿔 보여준다.
const COLUMN_LABEL_OVERRIDES = { ezadmin_lack_qty: '접수' };

function toDailyRowItem(item) {
  // 일별 데이터 테이블과 같은 헤더/편집 UI를 그대로 재사용하기 위해 필드명을 맞춘다.
  // 접수수량(pending)이 부족수량 자리, 미송관리수량(misong)이 미송 자리를 대신한다.
  return {
    ...item,
    ezadmin_lack_qty: item.pending_qty,
    incoming_qty: item.misong_qty,
    coverage_days_used: item.coverage_days,
  };
}

export default function OrderRecommendationDiscoverSection() {
  const [days, setDays] = useState(DEFAULT_DAYS);
  const [limit, setLimit] = useState(DEFAULT_LIMIT);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const { openModal } = useEzadminSession();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API}/order-recommendation/discover-missed-reorders/saved`, {
          headers: getAuthHeaders(),
        });
        const data = await res.json().catch(() => ({}));
        if (cancelled || !res.ok || !data.ok || !data.saved) return;
        setResult(data);
        setDays(data.days);
        setLimit(data.limit);
        const updatedAt = data.updated_at ? new Date(data.updated_at).toLocaleString('ko-KR') : '';
        setMessage(`저장된 데이터 (${updatedAt}, ${data.items.length}건)`);
      } catch {
        // 저장된 데이터 로드 실패는 조용히 무시 - 조회 버튼으로 다시 시도 가능
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const run = async () => {
    setLoading(true);
    setMessage('');
    try {
      const params = new URLSearchParams({ days: String(days), limit: String(limit) });
      const res = await fetch(`${API}/order-recommendation/discover-missed-reorders?${params}`, {
        headers: getAuthHeaders(),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) throw new Error(data?.detail || '조회 실패');
      if (data.need_ezadmin_session) {
        openModal(run);
        setMessage('이지어드민 세션이 없습니다. 설정 후 다시 시도해주세요.');
        return;
      }
      setResult(data);
      setMessage(`조회 완료: 후보 ${data.candidate_count}개 중 ${data.items.length}개`);
    } catch (err) {
      setMessage(err.message || '조회 실패');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <p className={styles.actionMessage}>
        재고가 아직 있어서 오늘 에이블리 재고수집(IO30)에 안 잡힌 상품 중, 최근 판매 속도로 봤을 때
        재발주가 필요해지고 있는 상품을 찾습니다. 발주추천과 동일한 공식을 쓰되, 재고/접수는
        EZAdmin에서, 미송은 미송관리에서 가져옵니다.
      </p>
      <div className={styles.backtestControls}>
        <div className={styles.backtestField}>
          <label>최근 N일 평균</label>
          <input
            type="number"
            min={1}
            className={styles.confirmInput}
            value={days}
            onChange={(e) => setDays(Number(e.target.value) || DEFAULT_DAYS)}
          />
        </div>
        <div className={styles.backtestField}>
          <label>상위 N개</label>
          <input
            type="number"
            min={1}
            className={styles.confirmInput}
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value) || DEFAULT_LIMIT)}
          />
        </div>
        <button type="button" className={styles.actionBtn} onClick={run} disabled={loading}>
          <RefreshCw size={13} className={loading ? styles.spinning : undefined} />
          {loading ? '조회 중...' : '조회'}
        </button>
      </div>
      {message && <div className={styles.actionMessage}>{message}</div>}

      {result && result.items.length > 0 && (
        <div className={styles.dailyTableScroll}>
          <table className={styles.dailyTable}>
            <thead>
              <tr>
                {DAILY_TABLE_COLUMNS.map((col) => (
                  <th key={col.key}>{COLUMN_LABEL_OVERRIDES[col.key] || col.label}</th>
                ))}
                <th>확정수량</th>
                <th>사유</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {result.items.map((item) => (
                <DailyTableRow key={item.yusas_code} date={result.date} item={toDailyRowItem(item)} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
