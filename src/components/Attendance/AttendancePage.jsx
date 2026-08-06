import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import styles from './AttendancePage.module.css';
import { COLLAB_API_BASE } from '../../lib/api';

export default function AttendancePage() {
  const [members, setMembers] = useState([]);
  const [selectedName, setSelectedName] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerArea, setPickerArea] = useState(null);
  const pickerRef = useRef(null);
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
      if (res.ok) {
        const data = await res.json();
        setMembers(data.filter((m) => m.payType !== 'studio'));
      }
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

  useEffect(() => {
    if (!pickerOpen) return undefined;
    const handleOutside = (e) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target)) setPickerOpen(false);
    };
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, [pickerOpen]);

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

  const membersByArea = useMemo(() => {
    const groups = { back: [], front: [] };
    members.forEach((m) => {
      groups[m.workArea === 'front' ? 'front' : 'back'].push(m);
    });
    return groups;
  }, [members]);

  const openPicker = () => {
    setPickerArea(null);
    setPickerOpen(true);
  };

  const closePicker = () => {
    setPickerOpen(false);
    setPickerArea(null);
  };

  const choosePickerName = (name) => {
    setSelectedName(name);
    closePicker();
  };

  // 이름별로 출근·퇴근 한 줄로 묶기
  const groupedToday = useMemo(() => {
    const map = {};
    todayRecords.forEach((r) => {
      if (!map[r.name]) map[r.name] = { name: r.name, 출근: null, 퇴근: null };
      if (r.type === '출근' && !map[r.name].출근) map[r.name].출근 = r;
      if (r.type === '퇴근') map[r.name].퇴근 = r; // 마지막 퇴근 사용
    });
    return Object.values(map).sort((a, b) => {
      const ta = a.출근?.timestamp || a.퇴근?.timestamp || '';
      const tb = b.출근?.timestamp || b.퇴근?.timestamp || '';
      return ta.localeCompare(tb);
    });
  }, [todayRecords]);

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
          <div className={styles.pickerAnchor} ref={pickerRef}>
            <button type="button" className={styles.nameTrigger} onClick={() => (pickerOpen ? closePicker() : openPicker())}>
              <span className={selectedName ? styles.nameTriggerValue : styles.nameTriggerPlaceholder}>
                {selectedName || '-- 이름을 선택하세요 --'}
              </span>
              <span className={styles.nameTriggerArrow}>▾</span>
            </button>

            {pickerOpen && (
              <div className={styles.pickerDropdown}>
                {pickerArea === null ? (
                  <>
                    <div className={styles.pickerRow} onClick={() => setPickerArea('back')}>백</div>
                    <div className={styles.pickerRow} onClick={() => setPickerArea('front')}>프론트</div>
                  </>
                ) : (
                  <>
                    <div className={`${styles.pickerRow} ${styles.pickerRowBack}`} onClick={() => setPickerArea(null)}>‹ 뒤로</div>
                    {membersByArea[pickerArea].length === 0 ? (
                      <div className={styles.pickerRowEmpty}>등록된 직원이 없습니다.</div>
                    ) : (
                      membersByArea[pickerArea].map((m) => (
                        <div key={m.id} className={styles.pickerRow} onClick={() => choosePickerName(m.name)}>
                          {m.name}
                        </div>
                      ))
                    )}
                  </>
                )}
              </div>
            )}
          </div>

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
          {groupedToday.length === 0 ? (
            <div className={styles.logEmpty}>오늘 기록이 없습니다.</div>
          ) : (
            <>
              <div className={styles.logHeader}>
                <span className={styles.logHeaderName}></span>
                <span className={styles.logHeaderIn}>☀️ 출근</span>
                <span className={styles.logHeaderOut}>🌙 퇴근</span>
              </div>
              {groupedToday.map((g) => (
                <div key={g.name} className={styles.logItem}>
                  <span className={styles.logName}>{g.name}</span>
                  <span className={`${styles.logTimeCell} ${styles.logTimeCellIn}`}>
                    {g.출근 ? fmtTime(g.출근.timestamp) : <span className={styles.logNoTime}>-</span>}
                  </span>
                  <span className={`${styles.logTimeCell} ${styles.logTimeCellOut}`}>
                    {g.퇴근 ? fmtTime(g.퇴근.timestamp) : <span className={styles.logNoTime}>-</span>}
                  </span>
                </div>
              ))}
            </>
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
