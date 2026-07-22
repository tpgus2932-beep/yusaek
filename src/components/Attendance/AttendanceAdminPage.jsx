import { useState, useEffect, useCallback, useMemo, useRef, Fragment } from 'react';
import html2canvas from 'html2canvas';
import styles from './AttendanceAdminPage.module.css';
import { COLLAB_API_BASE } from '../../lib/api';
import ScheduleTab from './ScheduleTab';

const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const copySalaryCardImage = async (element) => {
  if (!element) throw new Error('복사할 급여명세서를 찾을 수 없습니다.');
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
    throw new Error('이 브라우저에서는 이미지 복사를 지원하지 않습니다.');
  }
  const scrollParent = element.closest('[data-salary-scroll]');
  const previousOverflow = scrollParent?.style.overflow;
  const previousMaxHeight = scrollParent?.style.maxHeight;
  if (scrollParent) {
    scrollParent.style.overflow = 'visible';
    scrollParent.style.maxHeight = 'none';
  }
  try {
    const canvas = await html2canvas(element, {
      backgroundColor: '#ffffff',
      scale: Math.max(2, window.devicePixelRatio || 1),
      useCORS: true,
      logging: false,
      ignoreElements: (node) => node?.dataset?.captureIgnore === 'true',
    });
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((value) => value ? resolve(value) : reject(new Error('이미지 생성에 실패했습니다.')), 'image/png');
    });
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  } finally {
    if (scrollParent) {
      scrollParent.style.overflow = previousOverflow;
      scrollParent.style.maxHeight = previousMaxHeight;
    }
  }
};

const DailySalaryCard = ({ result }) => {
  const cardRef = useRef(null);
  const [copyState, setCopyState] = useState('idle');

  const copyCard = async () => {
    setCopyState('copying');
    try {
      await copySalaryCardImage(cardRef.current);
      setCopyState('done');
      window.setTimeout(() => setCopyState('idle'), 1600);
    } catch (error) {
      setCopyState('idle');
      window.alert(error.message || '이미지 복사에 실패했습니다.');
    }
  };

  return (
  <div className={styles.card} ref={cardRef}>
    <div className={styles.slipHeader}>
      <div>
        <div className={styles.slipTitle}>일일 알바 급여 명세서</div>
        <div className={styles.slipPeriod}>{result.year}년 {result.month}월</div>
      </div>
      <button className={styles.copyImageBtn} onClick={copyCard} disabled={copyState === 'copying'} data-capture-ignore="true">
        {copyState === 'copying' ? '이미지 생성 중...' : copyState === 'done' ? '복사 완료' : '📋 이미지 복사'}
      </button>
    </div>
    <div className={styles.slipName}>{result.member}</div>
    <div className={styles.slipRows}>
      <div className={styles.slipRow}><span className={styles.slipKey}>시급</span><span className={styles.slipVal}>{result.hourlyRate.toLocaleString()}원</span></div>
      <div className={styles.slipRow}><span className={styles.slipKey}>월 근무시간</span><span className={styles.slipVal}>{result.monthlyHours.toFixed(1)}H</span></div>
      <div className={styles.slipRow}><span className={styles.slipKey}>기본급</span><span className={styles.slipVal}>{result.basicPay.toLocaleString()}원</span></div>
      <div className={styles.slipRow}><span className={styles.slipKey}>주휴수당 ({result.qualifyingWeeks}주)</span><span className={styles.slipVal}>{result.holTotal.toLocaleString()}원</span></div>
      {result.allowances.map((allowance, index) => (
        <div key={`${allowance.name}-${index}`} className={styles.slipRow}>
          <span className={styles.slipKey}>{allowance.name}</span>
          <span className={styles.slipVal}>{Number(allowance.amount).toLocaleString()}원</span>
        </div>
      ))}
      <div className={styles.slipRow}><span className={styles.slipKey}>총지급액</span><span className={styles.slipVal}>{result.totalPay.toLocaleString()}원</span></div>
      <div className={styles.slipRow}><span className={styles.slipKey}>소득세 ({result.deductPct}%)</span><span className={`${styles.slipVal} ${styles.slipValDeduct}`}>−{result.incomeTax.toLocaleString()}원</span></div>
      <div className={styles.slipRow}><span className={styles.slipKey}>지방소득세</span><span className={`${styles.slipVal} ${styles.slipValDeduct}`}>−{result.localTax.toLocaleString()}원</span></div>
      <div className={`${styles.slipRow} ${styles.slipRowNet}`}><span className={styles.slipKeyNet}>실지급액</span><span className={styles.slipValNet}>{result.netPay.toLocaleString()}원</span></div>
    </div>
    <div className={styles.slipWeekLabel}>주별 근무 내역</div>
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead><tr><th>주차</th><th>주 시작</th><th>근무시간</th><th>주휴</th><th>주휴수당</th></tr></thead>
        <tbody>
          {result.weeks.map((week) => (
            <tr key={week.wkStart} style={week.qualifies ? { background: '#f0fdf4' } : {}}>
              <td>{week.week}주</td><td className={styles.dateCell}>{week.wkStart.slice(5)}</td><td>{week.hours.toFixed(1)}H</td>
              <td>{week.qualifies ? <span className={`${styles.badge} ${styles.badgeIn}`}>적용</span> : <span style={{ color: '#cbd5e1' }}>—</span>}</td>
              <td>{week.holPay > 0 ? `${week.holPay.toLocaleString()}원` : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </div>
  );
};


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
  const [editingMember, setEditingMember] = useState(null);
  const [memberEditName, setMemberEditName] = useState('');
  const [memberEditError, setMemberEditError] = useState('');
  const [memberEditSaving, setMemberEditSaving] = useState(false);

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

  // 급여명세서
  const [salaryYear, setSalaryYear] = useState(() => new Date().getFullYear());
  const [salaryMonth, setSalaryMonth] = useState(() => new Date().getMonth() + 1);
  const [salaryMember, setSalaryMember] = useState('');
  const [salaryHourlyRate, setSalaryHourlyRate] = useState(10400);
  const [salaryHolidayMin, setSalaryHolidayMin] = useState(15);
  const [salaryWorkDays, setSalaryWorkDays] = useState(5);
  const [salaryDeductPct, setSalaryDeductPct] = useState(3);
  const [salaryResult, setSalaryResult] = useState(null);
  const [allSalaryResults, setAllSalaryResults] = useState(null);
  const [dailySalaryResults, setDailySalaryResults] = useState(null);
  const [salaryAllowances, setSalaryAllowances] = useState([]);
  const [allowanceName, setAllowanceName] = useState('');
  const [allowanceAmount, setAllowanceAmount] = useState('');
  const [salaryLoading, setSalaryLoading] = useState(false);
  const [salaryError, setSalaryError] = useState('');
  const salaryCardRef = useRef(null);
  const [salaryCopyState, setSalaryCopyState] = useState('idle');

  // 일일 알바
  const [dailyWorkers, setDailyWorkers] = useState([]);
  const [dailyName, setDailyName] = useState('');
  const [dailyDate, setDailyDate] = useState(todayStr);
  const [dailyStartTime, setDailyStartTime] = useState('09:00');
  const [dailyEndTime, setDailyEndTime] = useState('14:00');
  const [dailyLoading, setDailyLoading] = useState(false);
  const [dailyError, setDailyError] = useState('');

  // 시간 수정
  const [editingRecord, setEditingRecord] = useState(null);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState('');

  const eachDate = (from, to) => {
    if (!from && !to) return [todayStr()];
    const start = new Date(`${from || to}T00:00:00`);
    const end = new Date(`${to || from}T00:00:00`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
      return [from || to || todayStr()];
    }
    const dates = [];
    for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      dates.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
    }
    return dates;
  };

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
    } catch {
      // 다음 화면 진입 시 다시 조회한다.
    }
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
    } catch {
      // 조회 버튼으로 재시도할 수 있다.
    }
    setRecLoading(false);
  }, [pin, filterDateFrom, filterDateTo, filterName]);

  useEffect(() => {
    if (pinAuth && tab === 'records') loadRecords();
  }, [pinAuth, tab, loadRecords]);

  const loadDailyWorkers = useCallback(async () => {
    setDailyLoading(true);
    setDailyError('');
    try {
      const params = new URLSearchParams({ pin });
      const res = await fetch(`${COLLAB_API_BASE}/attendance/daily-workers?${params}`);
      const data = await res.json().catch(() => []);
      if (!res.ok) throw new Error(data?.detail || '일일 알바 기록 조회에 실패했습니다.');
      setDailyWorkers(Array.isArray(data) ? data : []);
    } catch (error) {
      setDailyError(error.message || '일일 알바 기록 조회에 실패했습니다.');
    } finally {
      setDailyLoading(false);
    }
  }, [pin]);

  useEffect(() => {
    if (pinAuth && tab === 'daily') loadDailyWorkers();
  }, [pinAuth, tab, loadDailyWorkers]);

  const addDailyWorker = async () => {
    const name = dailyName.trim();
    if (!name) {
      setDailyError('이름을 입력하세요.');
      return;
    }
    setDailyLoading(true);
    setDailyError('');
    try {
      const res = await fetch(`${COLLAB_API_BASE}/attendance/daily-workers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin, name, date: dailyDate, startTime: dailyStartTime, endTime: dailyEndTime }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || '일일 알바 등록에 실패했습니다.');
      setDailyName('');
      await loadDailyWorkers();
    } catch (error) {
      setDailyError(error.message || '일일 알바 등록에 실패했습니다.');
    } finally {
      setDailyLoading(false);
    }
  };

  const deleteDailyWorker = async (entry) => {
    if (!window.confirm(`${entry.name}님의 ${entry.date} 기록을 삭제하시겠습니까?`)) return;
    const res = await fetch(`${COLLAB_API_BASE}/attendance/daily-workers/${entry.id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin }),
    });
    if (res.ok) {
      await loadDailyWorkers();
      if (tab === 'records') await loadRecords();
    } else {
      const data = await res.json().catch(() => ({}));
      setDailyError(data?.detail || '삭제에 실패했습니다.');
    }
  };

  // ── 같은 날짜+이름 → 한 줄로 묶기 ─────────────────
  const groupedRecords = useMemo(() => {
    const map = {};
    records.forEach((r) => {
      const key = `${r.date}__${r.name}`;
      if (!map[key]) map[key] = { date: r.date, name: r.name, 출근: null, 퇴근: null };
      if (r.type === '출근' && !map[key].출근) map[key].출근 = r;
      if (r.type === '퇴근') map[key].퇴근 = r; // 마지막 퇴근 기록 사용
    });
    const targetMembers = filterName
      ? members.filter((m) => m.name === filterName)
      : members;
    eachDate(filterDateFrom, filterDateTo).forEach((date) => {
      targetMembers.forEach((m) => {
        const key = `${date}__${m.name}`;
        if (!map[key]) map[key] = { date, name: m.name, 출근: null, 퇴근: null };
      });
    });
    return Object.values(map).sort((a, b) => {
      if (a.date !== b.date) return b.date.localeCompare(a.date);
      return a.name.localeCompare(b.name, 'ko-KR');
    });
  }, [records, members, filterName, filterDateFrom, filterDateTo]);

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

  const toggleScheduleVisibility = async (id, includeInSchedule) => {
    await fetch(`${COLLAB_API_BASE}/attendance/members/${id}/schedule-visibility`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin, includeInSchedule }),
    });
    loadMembers();
  };

  const openMemberEdit = (member) => {
    setEditingMember(member);
    setMemberEditName(member.name);
    setMemberEditError('');
  };

  const updateMember = async () => {
    if (!editingMember) return;
    const name = memberEditName.trim();
    if (!name) {
      setMemberEditError('이름을 입력하세요.');
      return;
    }
    setMemberEditSaving(true);
    setMemberEditError('');
    try {
      const res = await fetch(`${COLLAB_API_BASE}/attendance/members/${editingMember.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, pin }),
      });
      if (res.ok) {
        setEditingMember(null);
        await loadMembers();
        await loadRecords();
      } else {
        const d = await res.json().catch(() => ({}));
        setMemberEditError(d.detail || '이름 수정에 실패했습니다.');
      }
    } catch {
      setMemberEditError('서버에 연결할 수 없습니다.');
    }
    setMemberEditSaving(false);
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
    const exportNames = members.map((m) => m.name);

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
    const row1 = `<tr>${cell('날짜')}${empty8}${exportNames.map((n) => cell(n)).join('')}</tr>`;

    // Row 2~: 날짜 + B~I 빈칸 + J열~ 일별 근무시간 (파란색)
    const summaryRows = perDay.map(({ date, map }) =>
      `<tr>${cell(date)}${empty8}${exportNames.map((n) => {
        const val = map[n] !== undefined ? fmtDecimalHours(map[n]) : '0.0';
        return cell(val, BLUE);
      }).join('')}</tr>`
    ).join('');

    // 빈 구분 행
    const blankRow = `<tr>${`<td style="${BD}"></td>`.repeat(9 + exportNames.length)}</tr>`;

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

  const calcSalaryData = (records, cfg) => {
    const { hourlyRate, holidayMin, workDays, deductPct, memberName, year, month, allowances = [] } = cfg;
    // 30분 단위 반올림: 15분 이하 버림, 16분 이상 올림
    const roundHalf = (h) => Math.floor((h * 60 + 14) / 30) * 30 / 60;
    // 날짜별 출/퇴근 그룹화
    const byDate = {};
    records.forEach((r) => {
      if (!byDate[r.date]) byDate[r.date] = { 출근: null, 퇴근: null };
      if (r.type === '출근' && !byDate[r.date].출근) byDate[r.date].출근 = r;
      if (r.type === '퇴근') byDate[r.date].퇴근 = r;
    });
    // 날짜 → 주(월요일 기준)별 근무시간 집계
    const weekMap = {};
    Object.entries(byDate).forEach(([date, pair]) => {
      const raw = calcHours(pair.출근, pair.퇴근);
      if (!raw || raw <= 0) return;
      const h = roundHalf(raw);
      const d = new Date(`${date}T00:00:00+09:00`);
      const daysSinceMon = (d.getDay() + 6) % 7; // Mon=0
      const monday = new Date(d);
      monday.setDate(d.getDate() - daysSinceMon);
      const wk = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`;
      weekMap[wk] = (weekMap[wk] || 0) + h;
    });

    const monthlyHours = Object.values(weekMap).reduce((s, h) => s + h, 0);
    const weeks = Object.entries(weekMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([wkStart, hours], idx) => {
        const qualifies = hours >= holidayMin;
        const holPay = qualifies ? Math.round((hours / workDays) * hourlyRate) : 0;
        return { week: idx + 1, wkStart, hours, qualifies, holPay };
      });

    const basicPay = Math.round(monthlyHours * hourlyRate);
    const holTotal = weeks.reduce((s, w) => s + w.holPay, 0);
    const allowanceTotal = allowances.reduce((s, a) => s + (Number(a.amount) || 0), 0);
    const totalPay = basicPay + holTotal + allowanceTotal;
    // 소득세(deductPct%) + 지방소득세(소득세의 10%)
    const incomeTax = Math.round(totalPay * (deductPct / 100));
    const localTax = Math.round(incomeTax * 0.1);
    const deduction = incomeTax + localTax;
    const netPay = totalPay - deduction;

    return {
      member: memberName, year, month,
      hourlyRate, deductPct,
      monthlyHours, basicPay, holTotal, allowances, allowanceTotal, totalPay, incomeTax, localTax, deduction, netPay,
      qualifyingWeeks: weeks.filter((w) => w.qualifies).length,
      weeks,
    };
  };

  const loadSalary = async () => {
    setSalaryError('');
    setSalaryResult(null);
    setAllSalaryResults(null);
    setDailySalaryResults(null);
    setSalaryLoading(true);
    try {
      const y = salaryYear, m = salaryMonth;
      const dateFrom = `${y}-${String(m).padStart(2, '0')}-01`;
      const lastDay = new Date(y, m, 0).getDate();
      const dateTo = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
      const cfg = { hourlyRate: salaryHourlyRate, holidayMin: salaryHolidayMin, workDays: salaryWorkDays, deductPct: salaryDeductPct, allowances: salaryAllowances, year: y, month: m };

      if (salaryMember === '__daily__') {
        const params = new URLSearchParams({ pin, date_from: dateFrom, date_to: dateTo });
        const res = await fetch(`${COLLAB_API_BASE}/attendance/daily-workers?${params}`);
        if (!res.ok) throw new Error('일일 알바 기록 조회 실패');
        const entries = await res.json();
        const byName = entries.reduce((grouped, entry) => {
          if (!grouped[entry.name]) grouped[entry.name] = [];
          grouped[entry.name].push(
            { date: entry.date, type: '출근', timestamp: entry.checkInTimestamp },
            { date: entry.date, type: '퇴근', timestamp: entry.checkOutTimestamp },
          );
          return grouped;
        }, {});
        const results = Object.entries(byName)
          .sort(([a], [b]) => a.localeCompare(b, 'ko-KR'))
          .map(([name, workerRecords]) => calcSalaryData(workerRecords, { ...cfg, memberName: name }));
        setDailySalaryResults(results);
      } else if (salaryMember) {
        const params = new URLSearchParams({ pin, date_from: dateFrom, date_to: dateTo, name: salaryMember });
        const res = await fetch(`${COLLAB_API_BASE}/attendance/records?${params}`);
        if (!res.ok) throw new Error('출퇴근 기록 조회 실패');
        const fetched = await res.json();
        setSalaryResult(calcSalaryData(fetched, { ...cfg, memberName: salaryMember }));
      } else {
        if (!members.length) throw new Error('직원 목록이 없습니다.');
        const results = await Promise.all(members.map(async (mem) => {
          const params = new URLSearchParams({ pin, date_from: dateFrom, date_to: dateTo, name: mem.name });
          const res = await fetch(`${COLLAB_API_BASE}/attendance/records?${params}`);
          if (!res.ok) throw new Error(`${mem.name} 조회 실패`);
          const fetched = await res.json();
          return calcSalaryData(fetched, { ...cfg, memberName: mem.name });
        }));
        setAllSalaryResults(results);
      }
    } catch (e) {
      setSalaryError(e.message || '조회 실패');
    } finally {
      setSalaryLoading(false);
    }
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

  const copySalaryImage = async () => {
    setSalaryCopyState('copying');
    try {
      await copySalaryCardImage(salaryCardRef.current);
      setSalaryCopyState('done');
      window.setTimeout(() => setSalaryCopyState('idle'), 1600);
    } catch (error) {
      setSalaryCopyState('idle');
      window.alert(error.message || '이미지 복사에 실패했습니다.');
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

  const openAddRecord = (group, type) => {
    const now = new Date();
    const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    setEditingRecord({
      id: null,
      name: group.name,
      type,
      date: group.date,
      time,
      isNew: true,
    });
    setEditError('');
  };

  const updateRecord = async () => {
    if (!editingRecord) return;
    setEditSaving(true);
    setEditError('');
    try {
      const isNew = !editingRecord.id;
      const res = await fetch(
        isNew
          ? `${COLLAB_API_BASE}/attendance/records`
          : `${COLLAB_API_BASE}/attendance/records/${editingRecord.id}`,
        {
          method: isNew ? 'POST' : 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            pin,
            member_name: editingRecord.name,
            type: editingRecord.type,
            date: editingRecord.date,
            time: editingRecord.time,
          }),
        }
      );
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
          <button
            className={`${styles.tabBtn} ${tab === 'salary' ? styles.tabActive : ''}`}
            onClick={() => setTab('salary')}
          >
            💰 급여명세서
          </button>
          <button
            className={`${styles.tabBtn} ${tab === 'schedule' ? styles.tabActive : ''}`}
            onClick={() => setTab('schedule')}
          >
            📅 스케줄관리
          </button>
          <button
            className={`${styles.tabBtn} ${tab === 'daily' ? styles.tabActive : ''}`}
            onClick={() => setTab('daily')}
          >
            🧑‍🔧 일일 알바
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
                  <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.78rem', color: '#64748b', whiteSpace: 'nowrap' }}>
                    <input
                      type="checkbox"
                      checked={m.includeInSchedule}
                      onChange={() => toggleScheduleVisibility(m.id, !m.includeInSchedule)}
                    />
                    근무표 포함
                  </label>
                  <button className={styles.editMemberBtn} onClick={() => openMemberEdit(m)}>
                    수정
                  </button>
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
                                  <button className={styles.addSmBtn} onClick={() => openAddRecord(g, '출근')}>
                                    추가
                                  </button>
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
                                  <button className={styles.addSmBtn} onClick={() => openAddRecord(g, '퇴근')}>
                                    추가
                                  </button>
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
        {/* ── 급여명세서 탭 ── */}
        {tab === 'salary' && (
          <>
            <div className={styles.card}>
              <div className={styles.filterRow}>
                <select className={styles.filterInput} value={salaryYear} onChange={(e) => setSalaryYear(+e.target.value)}>
                  {[2024, 2025, 2026, 2027].map((y) => <option key={y} value={y}>{y}년</option>)}
                </select>
                <select className={styles.filterInput} value={salaryMonth} onChange={(e) => setSalaryMonth(+e.target.value)}>
                  {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => <option key={m} value={m}>{m}월</option>)}
                </select>
                <select className={styles.filterInput} value={salaryMember} onChange={(e) => { setSalaryMember(e.target.value); setSalaryResult(null); setAllSalaryResults(null); setDailySalaryResults(null); }}>
                  <option value="">전체</option>
                  {members.map((m) => <option key={m.id} value={m.name}>{m.name}</option>)}
                  <option value="__daily__">일일알바</option>
                </select>
              </div>
              <div className={styles.salarySettingRow}>
                <label className={styles.salarySettingItem}>
                  <span>시급(원)</span>
                  <input type="number" className={styles.salarySettingInput} value={salaryHourlyRate} onChange={(e) => setSalaryHourlyRate(+e.target.value)} />
                </label>
                <label className={styles.salarySettingItem}>
                  <span>주휴기준(H)</span>
                  <input type="number" className={styles.salarySettingInput} value={salaryHolidayMin} onChange={(e) => setSalaryHolidayMin(+e.target.value)} />
                </label>
                <label className={styles.salarySettingItem}>
                  <span>소정근로일</span>
                  <input type="number" className={styles.salarySettingInput} value={salaryWorkDays} onChange={(e) => setSalaryWorkDays(+e.target.value)} />
                </label>
                <label className={styles.salarySettingItem}>
                  <span>소득세율(%)</span>
                  <input type="number" step="0.1" className={styles.salarySettingInput} value={salaryDeductPct} onChange={(e) => setSalaryDeductPct(+e.target.value)} />
                </label>
              </div>
              <div className={styles.salarySettingRow} style={{ flexWrap: 'wrap', gap: '0.4rem', alignItems: 'center' }}>
                <span style={{ fontSize: '0.8rem', color: '#64748b', whiteSpace: 'nowrap' }}>추가수당</span>
                {salaryAllowances.map((a, i) => (
                  <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: '0.375rem', padding: '0.15rem 0.5rem', fontSize: '0.8rem' }}>
                    {a.name} {Number(a.amount).toLocaleString()}원
                    <button type="button" onClick={() => setSalaryAllowances((prev) => prev.filter((_, j) => j !== i))} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', padding: '0', lineHeight: 1 }}>✕</button>
                  </span>
                ))}
                <input
                  placeholder="항목명"
                  value={allowanceName}
                  onChange={(e) => setAllowanceName(e.target.value)}
                  className={styles.salarySettingInput}
                  style={{ width: '6rem' }}
                />
                <input
                  type="number"
                  placeholder="금액"
                  value={allowanceAmount}
                  onChange={(e) => setAllowanceAmount(e.target.value)}
                  className={styles.salarySettingInput}
                  style={{ width: '6rem' }}
                />
                <button
                  type="button"
                  className={styles.searchBtn}
                  style={{ padding: '0.25rem 0.6rem', fontSize: '0.8rem' }}
                  onClick={() => {
                    const name = allowanceName.trim();
                    const amount = Number(allowanceAmount);
                    if (!name || !amount) return;
                    setSalaryAllowances((prev) => [...prev, { name, amount }]);
                    setAllowanceName('');
                    setAllowanceAmount('');
                  }}
                >추가</button>
              </div>
              <div className={styles.filterBtns}>
                <button className={styles.searchBtn} onClick={loadSalary} disabled={salaryLoading}>
                  {salaryLoading ? '조회 중...' : '급여 계산'}
                </button>
              </div>
              {salaryError && <div className={styles.errorMsg}>{salaryError}</div>}
            </div>

            {allSalaryResults && (
              <div className={styles.card}>
                <div className={styles.slipHeader}>
                  <div>
                    <div className={styles.slipTitle}>전체 급여 요약</div>
                    <div className={styles.slipPeriod}>{salaryYear}년 {salaryMonth}월</div>
                  </div>
                </div>
                <div className={styles.tableWrap}>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th>직원</th>
                        <th>근무시간</th>
                        <th>기본급</th>
                        <th>주휴수당</th>
                        <th>총지급액</th>
                        <th>공제</th>
                        <th>실지급액</th>
                      </tr>
                    </thead>
                    <tbody>
                      {allSalaryResults.map((r) => (
                        <tr key={r.member}>
                          <td>{r.member}</td>
                          <td>{r.monthlyHours.toFixed(1)}H</td>
                          <td>{r.basicPay.toLocaleString()}원</td>
                          <td>{r.holTotal.toLocaleString()}원</td>
                          <td>{r.totalPay.toLocaleString()}원</td>
                          <td className={styles.slipValDeduct}>−{r.deduction.toLocaleString()}원</td>
                          <td><strong>{r.netPay.toLocaleString()}원</strong></td>
                        </tr>
                      ))}
                      <tr style={{ background: '#f8fafc', fontWeight: 600 }}>
                        <td>합계</td>
                        <td>{allSalaryResults.reduce((s, r) => s + r.monthlyHours, 0).toFixed(1)}H</td>
                        <td>{allSalaryResults.reduce((s, r) => s + r.basicPay, 0).toLocaleString()}원</td>
                        <td>{allSalaryResults.reduce((s, r) => s + r.holTotal, 0).toLocaleString()}원</td>
                        <td>{allSalaryResults.reduce((s, r) => s + r.totalPay, 0).toLocaleString()}원</td>
                        <td className={styles.slipValDeduct}>−{allSalaryResults.reduce((s, r) => s + r.deduction, 0).toLocaleString()}원</td>
                        <td><strong>{allSalaryResults.reduce((s, r) => s + r.netPay, 0).toLocaleString()}원</strong></td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {salaryResult && (
              <div className={styles.card} ref={salaryCardRef}>
                <div className={styles.slipHeader}>
                  <div>
                    <div className={styles.slipTitle}>급여 명세서</div>
                    <div className={styles.slipPeriod}>{salaryResult.year}년 {salaryResult.month}월</div>
                  </div>
                  <button className={styles.copyImageBtn} onClick={copySalaryImage} disabled={salaryCopyState === 'copying'} data-capture-ignore="true">
                    {salaryCopyState === 'copying' ? '이미지 생성 중...' : salaryCopyState === 'done' ? '복사 완료' : '📋 이미지 복사'}
                  </button>
                </div>

                <div className={styles.slipName}>{salaryResult.member}</div>

                <div className={styles.slipRows}>
                  <div className={styles.slipRow}>
                    <span className={styles.slipKey}>시급</span>
                    <span className={styles.slipVal}>{salaryResult.hourlyRate.toLocaleString()}원</span>
                  </div>
                  <div className={styles.slipRow}>
                    <span className={styles.slipKey}>월 근무시간</span>
                    <span className={styles.slipVal}>{salaryResult.monthlyHours.toFixed(1)}H</span>
                  </div>
                  <div className={styles.slipRow}>
                    <span className={styles.slipKey}>기본급</span>
                    <span className={styles.slipVal}>{salaryResult.basicPay.toLocaleString()}원</span>
                  </div>
                  <div className={styles.slipRow}>
                    <span className={styles.slipKey}>주휴수당 ({salaryResult.qualifyingWeeks}주)</span>
                    <span className={styles.slipVal}>{salaryResult.holTotal.toLocaleString()}원</span>
                  </div>
                  {salaryResult.allowances.map((a, i) => (
                    <div key={i} className={styles.slipRow}>
                      <span className={styles.slipKey}>{a.name}</span>
                      <span className={styles.slipVal}>{Number(a.amount).toLocaleString()}원</span>
                    </div>
                  ))}
                  <div className={styles.slipRow}>
                    <span className={styles.slipKey}>총지급액</span>
                    <span className={styles.slipVal}>{salaryResult.totalPay.toLocaleString()}원</span>
                  </div>
                  <div className={styles.slipRow}>
                    <span className={styles.slipKey}>소득세 ({salaryResult.deductPct}%)</span>
                    <span className={`${styles.slipVal} ${styles.slipValDeduct}`}>−{salaryResult.incomeTax.toLocaleString()}원</span>
                  </div>
                  <div className={styles.slipRow}>
                    <span className={styles.slipKey}>지방소득세 (소득세의 10%)</span>
                    <span className={`${styles.slipVal} ${styles.slipValDeduct}`}>−{salaryResult.localTax.toLocaleString()}원</span>
                  </div>
                  <div className={`${styles.slipRow} ${styles.slipRowNet}`}>
                    <span className={styles.slipKeyNet}>실지급액</span>
                    <span className={styles.slipValNet}>{salaryResult.netPay.toLocaleString()}원</span>
                  </div>
                </div>

                <div className={styles.slipWeekLabel}>주별 근무 내역</div>
                <div className={styles.tableWrap}>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th>주차</th>
                        <th>주 시작</th>
                        <th>근무시간</th>
                        <th>주휴</th>
                        <th>주휴수당</th>
                      </tr>
                    </thead>
                    <tbody>
                      {salaryResult.weeks.map((w) => (
                        <tr key={w.wkStart} style={w.qualifies ? { background: '#f0fdf4' } : {}}>
                          <td>{w.week}주</td>
                          <td className={styles.dateCell}>{w.wkStart.slice(5)}</td>
                          <td>{w.hours.toFixed(1)}H</td>
                          <td>
                            {w.qualifies
                              ? <span className={`${styles.badge} ${styles.badgeIn}`}>적용</span>
                              : <span style={{ color: '#cbd5e1' }}>—</span>}
                          </td>
                          <td>{w.holPay > 0 ? `${w.holPay.toLocaleString()}원` : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {dailySalaryResults && (
              <div className={styles.dailySalaryScroll} data-salary-scroll>
                {dailySalaryResults.length === 0 ? (
                  <div className={styles.card}><div className={styles.emptyMsg}>해당 월의 일일 알바 기록이 없습니다.</div></div>
                ) : dailySalaryResults.map((result) => (
                  <DailySalaryCard key={result.member} result={result} />
                ))}
              </div>
            )}
          </>
        )}
        {/* ── 스케줄관리 탭 ── */}
        {tab === 'schedule' && (
          <ScheduleTab pin={pin} members={members.filter((m) => m.includeInSchedule)} />
        )}

        {/* ── 일일 알바 탭 ── */}
        {tab === 'daily' && (
          <>
            <div className={styles.card}>
              <div className={styles.dailyFormGrid}>
                <label className={styles.dailyField}>
                  <span>이름</span>
                  <input className={styles.filterInput} value={dailyName} onChange={(e) => setDailyName(e.target.value)} placeholder="일일 알바 이름" />
                </label>
                <label className={styles.dailyField}>
                  <span>날짜</span>
                  <input type="date" className={styles.filterInput} value={dailyDate} onChange={(e) => setDailyDate(e.target.value)} />
                </label>
                <label className={styles.dailyField}>
                  <span>출근시간</span>
                  <input type="time" className={styles.filterInput} value={dailyStartTime} onChange={(e) => setDailyStartTime(e.target.value)} />
                </label>
                <label className={styles.dailyField}>
                  <span>퇴근시간</span>
                  <input type="time" className={styles.filterInput} value={dailyEndTime} onChange={(e) => setDailyEndTime(e.target.value)} />
                </label>
              </div>
              {dailyError && <div className={styles.errorMsg}>{dailyError}</div>}
              <button className={styles.addBtn} onClick={addDailyWorker} disabled={dailyLoading}>
                {dailyLoading ? '저장 중...' : '일일 알바 기록 추가'}
              </button>
            </div>

            <div className={styles.card}>
              <div className={styles.dailyListHeader}>
                <strong>일일 알바 기록</strong>
                <span>{dailyWorkers.length}명</span>
              </div>
              {dailyLoading && dailyWorkers.length === 0 ? (
                <div className={styles.loadingMsg}>불러오는 중...</div>
              ) : dailyWorkers.length === 0 ? (
                <div className={styles.emptyMsg}>등록된 일일 알바 기록이 없습니다.</div>
              ) : (
                <div className={styles.dailyWorkerScroll}>
                  {dailyWorkers.map((entry) => (
                    <article key={entry.id} className={styles.dailyWorkerCard}>
                      <div>
                        <strong>{entry.name}</strong>
                        <span>{entry.date}</span>
                      </div>
                      <div className={styles.dailyWorkerTime}>
                        <span>{entry.startTime} ~ {entry.endTime}</span>
                        <small>{calcDuration({ timestamp: entry.checkInTimestamp }, { timestamp: entry.checkOutTimestamp })}</small>
                      </div>
                      <button className={styles.delBtn} onClick={() => deleteDailyWorker(entry)}>삭제</button>
                    </article>
                  ))}
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
            <h3 className={styles.modalTitle}>{editingRecord.isNew ? '시간 추가' : '시간 수정'}</h3>
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
                {editSaving ? '저장 중...' : (editingRecord.isNew ? '추가' : '저장')}
              </button>
              <button className={styles.backLink} onClick={() => setEditingRecord(null)}>취소</button>
            </div>
          </div>
        </div>
      )}

      {/* 직원 이름 수정 모달 */}
      {editingMember && (
        <div className={styles.modalOverlay} onClick={() => setEditingMember(null)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h3 className={styles.modalTitle}>직원 이름 수정</h3>
            <input
              className={styles.editInput}
              value={memberEditName}
              onChange={(e) => setMemberEditName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && updateMember()}
              autoFocus
            />
            {memberEditError && <div className={styles.pinError}>{memberEditError}</div>}
            <div className={styles.modalBtns}>
              <button className={styles.pinSubmit} onClick={updateMember} disabled={memberEditSaving}>
                {memberEditSaving ? '저장 중...' : '저장'}
              </button>
              <button className={styles.backLink} onClick={() => setEditingMember(null)}>취소</button>
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
