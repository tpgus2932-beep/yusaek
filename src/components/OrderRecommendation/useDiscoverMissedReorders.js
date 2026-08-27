import { useEffect, useState } from 'react';
import { LOCAL_API_BASE as API, getAuthHeaders } from '../../lib/api';
import { useEzadminSession } from '../../lib/EzadminSessionContext';

const DEFAULT_DAYS = 3;
const DEFAULT_LIMIT = 150;

// "추가된 상품" 조회 상태를 부모(OrderRecommendationDashboardPage)에서 한 번만 들고 있어서,
// 엑셀주문 탭도 같은 결과(result.items)를 다시 조회하지 않고 그대로 참조할 수 있게 한다.
export function useDiscoverMissedReorders() {
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

  return { days, setDays, limit, setLimit, result, loading, message, run };
}
