import { useState, useEffect, useCallback } from 'react';
import styles from './AttendanceAdminPage.module.css';
import { COLLAB_API_BASE } from '../../lib/api';

export default function AttendanceAdminPage() {
  const [pinAuth, setPinAuth] = useState(false);
  const [pin, setPin] = useState('');
  const [pinError, setPinError] = useState('');
  const [pinBusy, setPinBusy] = useState(false);
  const [tab, setTab] = useState('members');

  // 직원 관리
  const [members, setMembers] = useState([]);
  const [newName, setNewName] = useState('');
  const [addError, setAddError] = useState('');

  // 기록 조회
  const [records, setRecords] = useState([]);
  const [filterDate, setFilterDate] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
  const [filterName, setFilterName] = useState('');
  const [recLoading, setRecLoading] = useState(false);

  // PIN 변경
  const [showPinChange, setShowPinChange] = useState(false);
  const [newPin, setNewPin] = useState('');
  const [pinChangeMsg, setPinChangeMsg] = useState('');

  const verifyPin = async () => {
    if (!pin.trim()) return;
    setPinBusy(true);
    setPinError('');
    try {
      const res = await fetch(`${COLLAB_API_BASE}/attendance/verify-pin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin }),
      });
      if (res.ok) {
        setPinAuth(true);
      } else {
        setPinError('PIN이 올바르지 않습니다.');
        setPin('');
      }
    } catch {
      setPinError('서버에 연결할 수 없습니다.');
    }
    setPinBusy(false);
  };

  const loadMembers = useCallback(async () => {
    try {
      const res = await fetch(`${COLLAB_API_BASE}/attendance/members`);
      if (res.ok) setMembers(await res.json());
    } catch {}
  }, []);

  useEffect(() => {
    if (pinAuth) loadMembers();
  }, [pinAuth, loadMembers]);

  const loadRecords = useCallback(async () => {
    setRecLoading(true);
    try {
      const params = new URLSearchParams({ pin });
      if (filterDate) params.append('date', filterDate);
      if (filterName) params.append('name', filterName);
      const res = await fetch(`${COLLAB_API_BASE}/attendance/records?${params}`);
      if (res.ok) setRecords(await res.json());
    } catch {}
    setRecLoading(false);
  }, [pin, filterDate, filterName]);

  useEffect(() => {
    if (pinAuth && tab === 'records') loadRecords();
  }, [pinAuth, tab, loadRecords]);

  const addMember = async () => {
    const name = newName.trim();
    if (!name) return;
    setAddError('');
    const res = await fetch(`${COLLAB_API_BASE}/attendance/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, pin }),
    });
    if (res.ok) {
      setNewName('');
      loadMembers();
    } else {
      const d = await res.json().catch(() => ({}));
      setAddError(d.detail || '추가에 실패했습니다.');
    }
  };

  const deleteMember = async (id, name) => {
    if (!window.confirm(`'${name}'을(를) 삭제하시겠습니까?`)) return;
    await fetch(`${COLLAB_API_BASE}/attendance/members/${id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin }),
    });
    loadMembers();
  };

  const deleteRecord = async (id) => {
    if (!window.confirm('이 기록을 삭제하시겠습니까?')) return;
    await fetch(`${COLLAB_API_BASE}/attendance/records/${id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin }),
    });
    loadRecords();
  };

  const exportCSV = () => {
    const header = ['이름', '구분', '날짜', '시간'];
    const rows = records.map((r) => [
      r.name,
      r.type,
      r.date,
      new Date(r.timestamp).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }),
    ]);
    const csv = [header, ...rows].map((r) => r.join(',')).join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `출퇴근기록_${filterDate || '전체'}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const changePin = async () => {
    if (!newPin.trim()) return;
    setPinChangeMsg('');
    const res = await fetch(`${COLLAB_API_BASE}/attendance/change-pin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ old_pin: pin, new_pin: newPin }),
    });
    if (res.ok) {
      setPin(newPin);
      setNewPin('');
      setPinChangeMsg('PIN이 변경되었습니다.');
      setTimeout(() => { setShowPinChange(false); setPinChangeMsg(''); }, 1500);
    } else {
      setPinChangeMsg('PIN 변경 실패');
    }
  };

  const goBack = () => {
    if (window.opener) window.close();
    else window.history.back();
  };

  const fmtTime = (iso) =>
    new Date(iso).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });

  // ── PIN 입력 화면 ─────────────────────────────────────
  if (!pinAuth) {
    return (
      <div className={styles.pinPage}>
        <div className={styles.pinCard}>
          <div className={styles.pinIcon}>🔒</div>
          <h2 className={styles.pinTitle}>관리자 인증</h2>
          <p className={styles.pinSub}>관리자 PIN을 입력하세요<br /><span className={styles.pinHint}>(기본 PIN: 1234)</span></p>
          <input
            type="password"
            inputMode="numeric"
            className={styles.pinInput}
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && verifyPin()}
            placeholder="PIN"
            maxLength={12}
            autoFocus
          />
          {pinError && <div className={styles.pinError}>{pinError}</div>}
          <button className={styles.pinSubmit} onClick={verifyPin} disabled={pinBusy}>
            {pinBusy ? '확인 중...' : '확인'}
          </button>
          <button className={styles.backLink} onClick={goBack}>← 돌아가기</button>
        </div>
      </div>
    );
  }

  // ── 관리 화면 ─────────────────────────────────────────
  return (
    <div className={styles.page}>
      <nav className={styles.nav}>
        <span className={styles.navTitle}>⚙️ 출퇴근 관리</span>
        <div className={styles.navActions}>
          <button className={styles.navSecBtn} onClick={() => setShowPinChange(true)}>PIN 변경</button>
          <button className={styles.navBtn} onClick={goBack}>닫기</button>
        </div>
      </nav>

      <div className={styles.content}>
        {/* 탭 */}
        <div className={styles.tabBar}>
          <button
            className={`${styles.tabBtn} ${tab === 'members' ? styles.tabActive : ''}`}
            onClick={() => setTab('members')}
          >
            👥 직원 관리
          </button>
          <button
            className={`${styles.tabBtn} ${tab === 'records' ? styles.tabActive : ''}`}
            onClick={() => setTab('records')}
          >
            📋 출퇴근 기록
          </button>
        </div>

        {/* ── 직원 관리 탭 ── */}
        {tab === 'members' && (
          <div className={styles.card}>
            <div className={styles.inputRow}>
              <input
                className={styles.inputField}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addMember()}
                placeholder="직원 이름 입력"
              />
              <button className={styles.addBtn} onClick={addMember}>추가</button>
            </div>
            {addError && <div className={styles.errorMsg}>{addError}</div>}

            <ul className={styles.memberList}>
              {members.length === 0 && (
                <li className={styles.emptyMsg}>등록된 직원이 없습니다.</li>
              )}
              {members.map((m) => (
                <li key={m.id} className={styles.memberItem}>
                  <span className={styles.memberName}>{m.name}</span>
                  <button className={styles.delBtn} onClick={() => deleteMember(m.id, m.name)}>
                    삭제
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* ── 기록 조회 탭 ── */}
        {tab === 'records' && (
          <>
            <div className={styles.card}>
              <div className={styles.filterRow}>
                <input
                  type="date"
                  className={styles.filterInput}
                  value={filterDate}
                  onChange={(e) => setFilterDate(e.target.value)}
                />
                <select
                  className={styles.filterInput}
                  value={filterName}
                  onChange={(e) => setFilterName(e.target.value)}
                >
                  <option value="">전체 직원</option>
                  {members.map((m) => (
                    <option key={m.id} value={m.name}>{m.name}</option>
                  ))}
                </select>
              </div>
              <div className={styles.filterBtns}>
                <button className={styles.searchBtn} onClick={loadRecords}>조회</button>
                {records.length > 0 && (
                  <button className={styles.exportBtn} onClick={exportCSV}>CSV 다운로드</button>
                )}
              </div>
            </div>

            <div className={styles.card}>
              {recLoading ? (
                <div className={styles.loadingMsg}>불러오는 중...</div>
              ) : records.length === 0 ? (
                <div className={styles.emptyMsg}>해당 기간에 기록이 없습니다.</div>
              ) : (
                <div className={styles.tableWrap}>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th>이름</th>
                        <th>구분</th>
                        <th>시간</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {records.map((r) => (
                        <tr key={r.id}>
                          <td>{r.name}</td>
                          <td>
                            <span className={`${styles.badge} ${r.type === '출근' ? styles.badgeIn : styles.badgeOut}`}>
                              {r.type}
                            </span>
                          </td>
                          <td className={styles.timeCell}>{fmtTime(r.timestamp)}</td>
                          <td>
                            <button className={styles.delSmBtn} onClick={() => deleteRecord(r.id)}>✕</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* PIN 변경 모달 */}
      {showPinChange && (
        <div className={styles.modalOverlay} onClick={() => setShowPinChange(false)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h3 className={styles.modalTitle}>PIN 변경</h3>
            <input
              type="password"
              inputMode="numeric"
              className={styles.pinInput}
              value={newPin}
              onChange={(e) => setNewPin(e.target.value)}
              placeholder="새 PIN 입력"
              maxLength={12}
              autoFocus
            />
            {pinChangeMsg && (
              <div className={pinChangeMsg.includes('실패') ? styles.pinError : styles.pinSuccess}>
                {pinChangeMsg}
              </div>
            )}
            <div className={styles.modalBtns}>
              <button className={styles.pinSubmit} onClick={changePin}>변경</button>
              <button className={styles.backLink} onClick={() => setShowPinChange(false)}>취소</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
