import { useState, useEffect, useCallback, useMemo, Fragment } from 'react';
import styles from './AttendanceAdminPage.module.css';
import { COLLAB_API_BASE } from '../../lib/api';

const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const FIXED_NAMES = ['효진', '은영', '가희', '영아', '은진', '미진', '정란', '주아'];

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
  const [filterDateFrom, setFilterDateFrom] = useState(todayStr);
  const [filterDateTo, setFilterDateTo] = useState(todayStr);
  const [filterName, setFilterName] = useState('');
  const [recLoading, setRecLoading] = useState(false);

  // PIN 변경
  const [showPinChange, setShowPinChange] = useState(false);
  const [newPin, setNewPin] = useState('');
  const [pinChangeMsg, setPinChangeMsg] = useState('');

  // 시간 수정
  const [editingRecord, setEditingRecord] = useState(null);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState('');

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
      if (filterDateFrom) params.append('date_from', filterDateFrom);
      if (filterDateTo)   params.append('date_to',   filterDateTo);
      if (filterName)     params.append('name',       filterName);
      const res = await fetch(`${COLLAB_API_BASE}/attendance/records?${params}`);
      if (res.ok) setRecords(await res.json());
    } catch {}
    setRecLoading(false);
  }, [pin, filterDateFrom, filterDateTo, filterName]);

  useEffect(() => {
    if (pinAuth && tab === 'records') loadRecords();
  }, [pinAuth, tab, loadRecords]);

  // ── 같은 날짜+이름 → 한 줄로 묶기 ─────────────────
  const groupedRecords = useMemo(() => {
    const map = {};
    records.forEach((r) => {
      const key = `${r.date}__${r.name}`;
      if (!map[key]) map[key] = { date: r.date, name: r.name, 출근: null, 퇴근: null };
      if (r.type === '출근' && !map[key].출근) map[key].출근 = r;
      if (r.type === '퇴근') map[key].퇴근 = r; // 마지막 퇴근 기록 사용
    });
    return Object.values(map); // 이미 date DESC, name ASC, timestamp ASC 순으로 정렬됨
  }, [records]);

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

  const exportExcel = () => {
    const BD = 'border:1px solid #CCCCCC;';
    const cell = (val, style = '') =>
      `<td style="${BD}${style}">${val ?? ''}</td>`;
    const BLUE = "color:#0000FF;mso-number-format:'0.0'";

    // 날짜 오름차순 정렬
    const uniqueDates = [...new Set(groupedRecords.map((g) => g.date))].sort();

    // 날짜별 인물별 근무시간 맵
    const perDay = uniqueDates.map((date) => {
      const map = {};
      groupedRecords
        .filter((g) => g.date === date)
        .forEach((g) => {
          const h = calcHours(g.출근, g.퇴근);
          if (h !== null) map[g.name] = h;
        });
      return { date, map };
    });

    const empty8 = `<td style="${BD}"></td>`.repeat(8); // B~I (A=날짜 뒤 8칸)

    // Row 1: "날짜" + B~I 빈칸 + J열~ 이름
    const row1 = `<tr>${cell('날짜')}${empty8}${FIXED_NAMES.map((n) => cell(n)).join('')}</tr>`;

    // Row 2~: 날짜 + B~I 빈칸 + J열~ 일별 근무시간 (파란색)
    const summaryRows = perDay.map(({ date, map }) =>
      `<tr>${cell(date)}${empty8}${FIXED_NAMES.map((n) => {
        const val = map[n] !== undefined ? fmtDecimalHours(map[n]) : '0.0';
        return cell(val, BLUE);
      }).join('')}</tr>`
    ).join('');

    // 빈 구분 행
    const blankRow = `<tr>${`<td style="${BD}"></td>`.repeat(9 + FIXED_NAMES.length)}</tr>`;

    // 상세 헤더
    const detailHeader = `<tr>${['이름', '날짜', '출근', '퇴근', '근무시간'].map((h) => cell(h)).join('')}</tr>`;

    // 상세 데이터 (E열 = "4시간 7분" 텍스트)
    const dataRows = groupedRecords.map((g) =>
      `<tr>${cell(g.name)}${cell(g.date)}${cell(g.출근 ? fmtTime(g.출근.timestamp) : '')}${cell(g.퇴근 ? fmtTime(g.퇴근.timestamp) : '')}${cell(calcDuration(g.출근, g.퇴근) ?? '')}</tr>`
    ).join('');

    const html = `<html><head><meta charset="UTF-8"></head><body><table style="border-collapse:collapse">${row1}${summaryRows}${blankRow}${detailHeader}${dataRows}</table></body></html>`;
    const blob = new Blob([html], { type: 'application/vnd.ms-excel;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `출퇴근기록_${filterDateFrom || ''}${filterDateTo && filterDateTo !== filterDateFrom ? `~${filterDateTo}` : ''}.xls`;
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

  /** 출근~퇴근 차이를 시간(소수)으로 반환. 미기록이면 null */
  const calcHours = (inRec, outRec) => {
    if (!inRec || !outRec) return null;
    const diff = new Date(outRec.timestamp) - new Date(inRec.timestamp);
    if (diff <= 0) return null;
    return diff / 3_600_000;
  };

  /** 표시용 문자열 (예: "9시간 3분") */
  const calcDuration = (inRec, outRec) => {
    const h = calcHours(inRec, outRec);
    if (h === null) return null;
    const totalMins = Math.round(h * 60);
    const hours = Math.floor(totalMins / 60);
    const mins = totalMins % 60;
    if (hours === 0) return `${mins}분`;
    if (mins === 0) return `${hours}시간`;
    return `${hours}시간 ${mins}분`;
  };

  /** 총합 소수 포맷 — 30분(0.5) 단위 반올림, 항상 소수점 1자리 (예: 4→4.0, 1.5→1.5) */
  const fmtDecimalHours = (h) => (Math.round(h * 2) / 2).toFixed(1);

  /** ISO UTC → { date: 'YYYY-MM-DD', time: 'HH:MM' } in KST */
  const toKSTDatetime = (iso) => {
    const kst = new Date(new Date(iso).getTime() + 9 * 60 * 60 * 1000);
    return { date: kst.toISOString().slice(0, 10), time: kst.toISOString().slice(11, 16) };
  };

  const openEdit = (r) => {
    const { date, time } = toKSTDatetime(r.timestamp);
    setEditingRecord({ id: r.id, name: r.name, type: r.type, date, time });
    setEditError('');
  };

  const updateRecord = async () => {
    if (!editingRecord) return;
    setEditSaving(true);
    setEditError('');
    try {
      const res = await fetch(`${COLLAB_API_BASE}/attendance/records/${editingRecord.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin, date: editingRecord.date, time: editingRecord.time }),
      });
      if (res.ok) {
        setEditingRecord(null);
        loadRecords();
      } else {
        const d = await res.json().catch(() => ({}));
        setEditError(d.detail || '수정에 실패했습니다.');
      }
    } catch {
      setEditError('서버에 연결할 수 없습니다.');
    }
    setEditSaving(false);
  };

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
              {/* 날짜 범위 */}
              <div className={styles.dateRangeRow}>
                <input
                  type="date"
                  className={styles.filterInput}
                  value={filterDateFrom}
                  onChange={(e) => setFilterDateFrom(e.target.value)}
                />
                <span className={styles.dateSep}>~</span>
                <input
                  type="date"
                  className={styles.filterInput}
                  value={filterDateTo}
                  onChange={(e) => setFilterDateTo(e.target.value)}
                />
              </div>
              {/* 직원 필터 */}
              <div className={styles.filterRow}>
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
                {groupedRecords.length > 0 && (
                  <button className={styles.exportBtn} onClick={exportExcel}>엑셀 다운로드</button>
                )}
              </div>
            </div>

            <div className={styles.card}>
              {recLoading ? (
                <div className={styles.loadingMsg}>불러오는 중...</div>
              ) : groupedRecords.length === 0 ? (
                <div className={styles.emptyMsg}>해당 기간에 기록이 없습니다.</div>
              ) : (
                <div className={styles.tableWrap}>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th>이름</th>
                        <th>날짜</th>
                        <th>출근</th>
                        <th>퇴근</th>
                      </tr>
                    </thead>
                    <tbody>
                      {groupedRecords.map((g) => {
                        const dur = calcDuration(g.출근, g.퇴근);
                        return (
                          <Fragment key={`${g.date}__${g.name}`}>
                            <tr>
                              <td className={styles.nameCell}>{g.name}</td>
                              <td className={styles.dateCell}>{g.date}</td>
                              <td>
                                {g.출근 ? (
                                  <span className={styles.timeGroup}>
                                    <span className={`${styles.badge} ${styles.badgeIn}`}>
                                      {fmtTime(g.출근.timestamp)}
                                    </span>
                                    <button className={styles.editSmBtn} onClick={() => openEdit(g.출근)} title="수정">✎</button>
                                    <button className={styles.delSmBtn} onClick={() => deleteRecord(g.출근.id)} title="삭제">✕</button>
                                  </span>
                                ) : (
                                  <span className={styles.noRecord}>-</span>
                                )}
                              </td>
                              <td>
                                {g.퇴근 ? (
                                  <span className={styles.timeGroup}>
                                    <span className={`${styles.badge} ${styles.badgeOut}`}>
                                      {fmtTime(g.퇴근.timestamp)}
                                    </span>
                                    <button className={styles.editSmBtn} onClick={() => openEdit(g.퇴근)} title="수정">✎</button>
                                    <button className={styles.delSmBtn} onClick={() => deleteRecord(g.퇴근.id)} title="삭제">✕</button>
                                  </span>
                                ) : (
                                  <span className={styles.noRecord}>-</span>
                                )}
                              </td>
                            </tr>
                            {dur && (
                              <tr className={styles.durationRow}>
                                <td colSpan={4} className={styles.durationCell}>
                                  ⏱ 근무 {dur}
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* 시간 수정 모달 */}
      {editingRecord && (
        <div className={styles.modalOverlay} onClick={() => setEditingRecord(null)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h3 className={styles.modalTitle}>시간 수정</h3>
            <p className={styles.editInfo}>
              <strong>{editingRecord.name}</strong>{' '}
              <span className={`${styles.badge} ${editingRecord.type === '출근' ? styles.badgeIn : styles.badgeOut}`}>
                {editingRecord.type}
              </span>
            </p>
            <div className={styles.editFields}>
              <label className={styles.editLabel}>
                날짜
                <input
                  type="date"
                  className={styles.editInput}
                  value={editingRecord.date}
                  onChange={(e) => setEditingRecord((prev) => ({ ...prev, date: e.target.value }))}
                />
              </label>
              <label className={styles.editLabel}>
                시간 (KST)
                <input
                  type="time"
                  className={styles.editInput}
                  value={editingRecord.time}
                  onChange={(e) => setEditingRecord((prev) => ({ ...prev, time: e.target.value }))}
                />
              </label>
            </div>
            {editError && <div className={styles.pinError}>{editError}</div>}
            <div className={styles.modalBtns}>
              <button className={styles.pinSubmit} onClick={updateRecord} disabled={editSaving}>
                {editSaving ? '저장 중...' : '저장'}
              </button>
              <button className={styles.backLink} onClick={() => setEditingRecord(null)}>취소</button>
            </div>
          </div>
        </div>
      )}

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
