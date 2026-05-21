import { useState, useEffect, useCallback } from 'react';
import styles from './AttendancePage.module.css';
import { COLLAB_API_BASE } from '../../lib/api';

export default function AttendancePage() {
  const [members, setMembers] = useState([]);
  const [selectedName, setSelectedName] = useState('');
  const [todayRecords, setTodayRecords] = useState([]);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState({ msg: '', type: '', show: false });
  const [now, setNow] = useState(new Date());

  // 1초마다 시계 갱신
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const loadMembers = useCallback(async () => {
    try {
      const res = await fetch(`${COLLAB_API_BASE}/attendance/members`);
      if (res.ok) setMembers(await res.json());
    } catch {}
  }, []);

  const loadToday = useCallback(async () => {
    try {
      const res = await fetch(`${COLLAB_API_BASE}/attendance/records/today`);
      if (res.ok) setTodayRecords(await res.json());
    } catch {}
  }, []);

  useEffect(() => {
    loadMembers();
    loadToday();
    const t = setInterval(loadToday, 30_000);
    return () => clearInterval(t);
  }, [loadMembers, loadToday]);

  const showToast = (msg, type = '') => {
    setToast({ msg, type, show: true });
    setTimeout(() => setToast(p => ({ ...p, show: false })), 2800);
  };

  const record = async (type) => {
    if (!selectedName || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`${COLLAB_API_BASE}/attendance/record`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ member_name: selectedName, type }),
      });
      if (!res.ok) throw new Error();
      showToast(`${selectedName}님 ${type} 완료! ✓`, 'success');
      setSelectedName('');
      await loadToday();
    } catch {
      showToast('저장에 실패했습니다. 다시 시도해 주세요.', 'error');
    }
    setBusy(false);
  };

  const fmt2 = (n) => String(n).padStart(2, '0');
  const days = ['일', '월', '화', '수', '목', '금', '토'];
  const clockStr = `${fmt2(now.getHours())}:${fmt2(now.getMinutes())}:${fmt2(now.getSeconds())}`;
  const dateStr = `${now.getFullYear()}년 ${now.getMonth() + 1}월 ${now.getDate()}일 (${days[now.getDay()]})`;

  const fmtTime = (iso) =>
    new Date(iso).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });

  return (
    <div className={styles.page}>
      {/* ── 상단 네비게이션 ── */}
      <nav className={styles.nav}>
        <span className={styles.navTitle}>🏢 출퇴근 체크</span>
        <button
          className={styles.navBtn}
          onClick={() => window.open('/attendance-admin', '_blank', 'width=480,height=780')}
        >
          관리
        </button>
      </nav>

      <div className={styles.content}>
        {/* 시계 */}
        <div className={styles.card}>
          <div className={styles.clock}>{clockStr}</div>
          <div className={styles.dateLabel}>{dateStr}</div>
        </div>

        {/* 이름 선택 + 버튼 */}
        <div className={styles.card}>
          <label className={styles.selectLabel}>이름 선택</label>
          <select
            className={styles.nameSelect}
            value={selectedName}
            onChange={(e) => setSelectedName(e.target.value)}
          >
            <option value="">-- 이름을 선택하세요 --</option>
            {members.map((m) => (
              <option key={m.id} value={m.name}>{m.name}</option>
            ))}
          </select>

          <div className={styles.actionBtns}>
            <button
              className={`${styles.btn} ${styles.btnCheckin}`}
              onClick={() => record('출근')}
              disabled={!selectedName || busy}
            >
              <span className={styles.btnIcon}>☀️</span>
              출&nbsp;근
            </button>
            <button
              className={`${styles.btn} ${styles.btnCheckout}`}
              onClick={() => record('퇴근')}
              disabled={!selectedName || busy}
            >
              <span className={styles.btnIcon}>🌙</span>
              퇴&nbsp;근
            </button>
          </div>
        </div>

        {/* 오늘 기록 */}
        <div className={styles.card}>
          <div className={styles.logTitle}>📋 오늘의 기록</div>
          {todayRecords.length === 0 ? (
            <div className={styles.logEmpty}>오늘 기록이 없습니다.</div>
          ) : (
            todayRecords.map((r) => (
              <div key={r.id} className={styles.logItem}>
                <span className={styles.logName}>{r.name}</span>
                <span className={`${styles.logBadge} ${r.type === '출근' ? styles.badgeIn : styles.badgeOut}`}>
                  {r.type}
                </span>
                <span className={styles.logTime}>{fmtTime(r.timestamp)}</span>
              </div>
            ))
          )}
        </div>
      </div>

      {/* 토스트 */}
      <div className={[
        styles.toast,
        toast.show ? styles.toastShow : '',
        toast.type === 'success' ? styles.toastSuccess : '',
        toast.type === 'error' ? styles.toastError : '',
      ].join(' ')}>
        {toast.msg}
      </div>
    </div>
  );
}
