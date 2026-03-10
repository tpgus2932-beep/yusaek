import React, { useState, useCallback, useEffect, useRef } from 'react';
import { COLLAB_API_BASE as API } from '../../lib/api';
import styles from './ServerStatsModal.module.css';

const fmt = (n) => (n == null ? '—' : n.toLocaleString());
const fmtBytes = (b) => {
  if (b == null) return '—';
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(2)} MB`;
};

const TABLE_KO = {
  users: '사용자',
  requests: '요청',
  shared_todos: '공용 할일',
  my_todos: '개인 할일',
  order_registered_codes: '발주 코드',
  shared_files: '공용 파일',
  request_attachments: '요청 첨부',
  company_credentials: '회사 정보',
  app_settings: '설정',
};

const ServerStatsModal = ({ onClose }) => {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const ref = useRef(null);

  const fetchStats = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API}/admin/stats`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || '불러오기 실패');
      setStats(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  // Close on outside click
  useEffect(() => {
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  return (
    <div className={styles.backdrop}>
      <div className={styles.modal} ref={ref}>
        <div className={styles.header}>
          <span className={styles.title}>서버 현황</span>
          <div className={styles.headerBtns}>
            <button className={styles.refreshBtn} onClick={fetchStats} disabled={loading} title="새로고침">
              ↻
            </button>
            <button className={styles.closeBtn} onClick={onClose}>✕</button>
          </div>
        </div>

        {loading && <div className={styles.center}>조회 중…</div>}
        {error && <div className={styles.error}>{error}</div>}

        {stats && !loading && (
          <div className={styles.body}>
            {/* DB 모드 */}
            <div className={styles.section}>
              <div className={styles.label}>DB</div>
              <span className={`${styles.badge} ${stats.mode === 'turso' ? styles.turso : styles.sqlite}`}>
                {stats.mode === 'turso' ? '☁️ Turso' : '💾 SQLite'}
              </span>
              {stats.db_size_bytes != null && (
                <span className={styles.size}>{fmtBytes(stats.db_size_bytes)}</span>
              )}
            </div>

            {/* 테이블 행 수 */}
            <div className={styles.section}>
              <div className={styles.label}>테이블 데이터</div>
              <div className={styles.tableGrid}>
                {Object.entries(stats.table_counts || {}).map(([tbl, cnt]) => (
                  <div key={tbl} className={styles.tableRow}>
                    <span>{TABLE_KO[tbl] || tbl}</span>
                    <strong>{fmt(cnt)}</strong>
                  </div>
                ))}
              </div>
            </div>

            {/* 서비스 한도 */}
            <div className={styles.section}>
              <div className={styles.label}>무료 한도</div>
              <div className={styles.limitBlock}>
                <div className={styles.limitTitle}>
                  Turso
                  <a href={stats.turso_limits?.dashboard_url} target="_blank" rel="noreferrer" className={styles.link}>대시보드 →</a>
                </div>
                <div className={styles.limitRow}>
                  <span>월 읽기</span>
                  <span>{fmt(stats.turso_limits?.row_reads_per_month)} rows</span>
                </div>
                <div className={styles.limitRow}>
                  <span>월 쓰기</span>
                  <span>{fmt(stats.turso_limits?.row_writes_per_month)} rows</span>
                </div>
                <div className={styles.limitRow}>
                  <span>저장 용량</span>
                  <span>{stats.turso_limits?.storage_gb} GB</span>
                </div>
              </div>
              <div className={styles.limitBlock}>
                <div className={styles.limitTitle}>
                  Render
                  <a href={stats.render_limits?.dashboard_url} target="_blank" rel="noreferrer" className={styles.link}>대시보드 →</a>
                </div>
                <div className={styles.limitRow}>
                  <span>RAM</span>
                  <span>{stats.render_limits?.ram_mb} MB</span>
                </div>
                <div className={styles.limitRow}>
                  <span>월 인스턴스</span>
                  <span>{stats.render_limits?.instance_hours_per_month}시간</span>
                </div>
                <div className={styles.limitRow}>
                  <span>슬립</span>
                  <span>{stats.render_limits?.spin_down_minutes}분 비활성 시</span>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default ServerStatsModal;
