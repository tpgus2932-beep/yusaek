import React, { useEffect, useState } from 'react';
import { LOCAL_API_BASE as API, getAuthHeaders, handleUnauthorized } from '../../lib/api';
import styles from './ClientCancelSoldOutPage.module.css';

const ACTION_LABELS = {
  run: '실행 (취소+미진열+문자발송)',
  delist: '미진열만 처리',
};

const formatDateTime = (iso) => {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('ko-KR');
};

const ClientCancelSoldOutLogPage = () => {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      setError('');
      try {
        const res = await fetch(`${API}/client-cancel-soldout/logs`, {
          headers: getAuthHeaders(),
        });
        if (handleUnauthorized(res)) return;
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data?.ok === false) throw new Error(data?.detail || '로그 조회에 실패했습니다.');
        setLogs(Array.isArray(data.items) ? data.items : []);
      } catch (err) {
        setError(err.message || '로그 조회에 실패했습니다.');
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  return (
    <div className={styles.page}>
      <div className={styles.section}>
        <h3 className={styles.sectionTitle}>품절취소 실행 이력</h3>
        {loading && <p className={styles.placeholder}>불러오는 중...</p>}
        {error && <p className={styles.error}>{error}</p>}
        {!loading && !error && logs.length === 0 && (
          <p className={styles.placeholder}>기록된 이력이 없습니다.</p>
        )}
        {!loading && logs.length > 0 && (
          <ul className={styles.resultList}>
            {logs.map((log) => {
              const { summary } = log;
              const productLine = (summary?.products || [])
                .map((p) => {
                  const labels = (p.options || []).map((o) => o.label).filter(Boolean);
                  return labels.length > 0 ? `${p.name} (${labels.join(', ')})` : p.name;
                })
                .join(', ');
              return (
                <li key={log.id} className={styles.orderCard}>
                  <div className={styles.orderHeader}>
                    <span>{formatDateTime(log.created_at)}</span>
                    <span>{log.username}</span>
                    <span>{ACTION_LABELS[log.action] || log.action}</span>
                  </div>
                  <div>{productLine || '(상품 정보 없음)'}</div>
                  {log.action === 'run' && (
                    <div className={styles.optionCount}>
                      취소된 주문 {summary?.cancelled_orders?.length ?? 0}건 / 실패{' '}
                      {summary?.failed_orders?.length ?? 0}건 / 미진열 처리{' '}
                      {summary?.non_display_option_count ?? 0}개 / 품절 처리{' '}
                      {summary?.soldout_goods_count ?? 0}개
                    </div>
                  )}
                  {log.action === 'delist' && (
                    <div className={styles.optionCount}>
                      미진열 처리된 옵션 {summary?.non_display_option_count ?? 0}개
                    </div>
                  )}
                  {summary?.cancelled_orders?.length > 0 && (
                    <ul className={styles.itemList}>
                      {summary.cancelled_orders.map((order, idx) => (
                        <li key={idx} className={styles.optionCount}>
                          주문 {order.order_sno} · {order.buyer_name || ''}
                          {order.buyer_tel ? ` (${order.buyer_tel})` : ''} ·{' '}
                          {order.sms_sent ? '문자 발송됨' : '문자 발송 실패'}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
};

export default ClientCancelSoldOutLogPage;
