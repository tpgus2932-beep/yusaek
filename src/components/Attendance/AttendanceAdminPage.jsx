import { useState, useEffect, useCallback, useMemo, useRef, Fragment } from 'react';
import html2canvas from 'html2canvas';
import * as XLSX from 'xlsx';
import styles from './AttendanceAdminPage.module.css';
import { COLLAB_API_BASE } from '../../lib/api';
import ScheduleTab from './ScheduleTab';

const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const weekInfoForDate = (dateStr) => {
  const date = new Date(`${dateStr}T00:00:00`);
  const daysSinceMonday = (date.getDay() + 6) % 7;
  const monday = new Date(date);
  monday.setDate(date.getDate() - daysSinceMonday);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const key = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`;
  const startLabel = `${monday.getFullYear()}년 ${monday.getMonth() + 1}월 ${monday.getDate()}일`;
  const endLabel = monday.getFullYear() === sunday.getFullYear()
    ? `${sunday.getMonth() + 1}월 ${sunday.getDate()}일`
    : `${sunday.getFullYear()}년 ${sunday.getMonth() + 1}월 ${sunday.getDate()}일`;
  return { key, label: `${startLabel} ~ ${endLabel}` };
};

const DAILY_BANK_CODES = {
  국민: '004', 산업: '002', 하나: '081', 케이뱅크: '089', 경남: '039', 저축: '050',
  우리: '020', 카카오: '090', 광주: '034', 새마을금고: '045', 우체국: '071', 토스뱅크: '092',
  기업: '003', 수협: '007', 전북: '037', 농협: '011', 신한: '088', SC: '023',
  아이엠뱅크: '031', 신협: '048', 제주: '035', 부산: '032', 씨티: '027', HSBC: '054',
};
const DAILY_BANK_OPTIONS = [...Object.keys(DAILY_BANK_CODES), '직접입력:'];

const copyTextToClipboard = async (text) => {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
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
  const [payrollMode, setPayrollMode] = useState('fixed');

  // 직원 관리
  const [members, setMembers] = useState([]);
  const [memberArea, setMemberArea] = useState('back');
  const [newName, setNewName] = useState('');
  const [addError, setAddError] = useState('');
  const [editingMember, setEditingMember] = useState(null);
  const [memberEditName, setMemberEditName] = useState('');
  const [memberEditHourlyRate, setMemberEditHourlyRate] = useState('');
  const [showMemberRateHistory, setShowMemberRateHistory] = useState(false);
  const [memberEditError, setMemberEditError] = useState('');
  const [memberEditSaving, setMemberEditSaving] = useState(false);
  const [memberAccounts, setMemberAccounts] = useState({});
  const [editingMemberAccount, setEditingMemberAccount] = useState(null);
  const [memberAccountError, setMemberAccountError] = useState('');

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
  const [fixedAllowancesByMember, setFixedAllowancesByMember] = useState({});
  const [fixedAllowanceSaving, setFixedAllowanceSaving] = useState(false);
  const [salaryLoading, setSalaryLoading] = useState(false);
  const [salaryError, setSalaryError] = useState('');
  const salaryCardRef = useRef(null);
  const [salaryCopyState, setSalaryCopyState] = useState('idle');

  // 일일 알바
  const [dailyWorkers, setDailyWorkers] = useState([]);
  const [showDailyWorkerForm, setShowDailyWorkerForm] = useState(false);
  const [dailyName, setDailyName] = useState('');
  const [dailyDate, setDailyDate] = useState(todayStr);
  const [dailyStartTime, setDailyStartTime] = useState('09:00');
  const [dailyEndTime, setDailyEndTime] = useState('14:00');
  const [dailyBank, setDailyBank] = useState('국민');
  const [dailyCustomBank, setDailyCustomBank] = useState('');
  const [dailyAccountHolder, setDailyAccountHolder] = useState('');
  const [dailyAccountNumber, setDailyAccountNumber] = useState('');
  const [dailyResidentNumber, setDailyResidentNumber] = useState('');
  const [dailyLoading, setDailyLoading] = useState(false);
  const [dailyError, setDailyError] = useState('');
  const [dailyCopyMessage, setDailyCopyMessage] = useState('');
  const [dailyFilterFrom, setDailyFilterFrom] = useState(todayStr);
  const [dailyFilterTo, setDailyFilterTo] = useState(todayStr);
  const [editingDailyAccount, setEditingDailyAccount] = useState(null);
  const [expandedDailyWorkerId, setExpandedDailyWorkerId] = useState(null);
  const [editingDailyResident, setEditingDailyResident] = useState(null);
  const [fixedPayrollYear, setFixedPayrollYear] = useState(() => new Date().getFullYear());
  const [fixedPayrollMonth, setFixedPayrollMonth] = useState(() => new Date().getMonth() + 1);
  const [fixedPayrollArea, setFixedPayrollArea] = useState('all');
  const [fixedPayrollRows, setFixedPayrollRows] = useState([]);
  const [fixedPayrollLoading, setFixedPayrollLoading] = useState(false);
  const [fixedPayrollError, setFixedPayrollError] = useState('');
  const [fixedCopyMessage, setFixedCopyMessage] = useState('');
  const [pendingTransferCopy, setPendingTransferCopy] = useState(null);
  const [transferConfirmBusy, setTransferConfirmBusy] = useState(false);
  const [transferConfirmError, setTransferConfirmError] = useState('');
  const [selectedDailyTransferIds, setSelectedDailyTransferIds] = useState(new Set());
  const [selectedFixedTransferIds, setSelectedFixedTransferIds] = useState(new Set());

  // 입금 요청
  const [paymentRequestMode, setPaymentRequestMode] = useState('personal');
  const [paymentRequests, setPaymentRequests] = useState([]);
  const [paymentRequestDate, setPaymentRequestDate] = useState(todayStr);
  const [paymentRequestFilterDate, setPaymentRequestFilterDate] = useState(todayStr);
  const [paymentRequestBank, setPaymentRequestBank] = useState('국민');
  const [paymentRequestCustomBank, setPaymentRequestCustomBank] = useState('');
  const [paymentRequestHolder, setPaymentRequestHolder] = useState('');
  const [paymentRequestAccount, setPaymentRequestAccount] = useState('');
  const [paymentRequestAmount, setPaymentRequestAmount] = useState('');
  const [paymentRequestContent, setPaymentRequestContent] = useState('');
  const [paymentRequestResident, setPaymentRequestResident] = useState('');
  const [paymentRequestLoading, setPaymentRequestLoading] = useState(false);
  const [paymentRequestError, setPaymentRequestError] = useState('');
  const [paymentRequestCopyMessage, setPaymentRequestCopyMessage] = useState('');
  const [editingPaymentRequest, setEditingPaymentRequest] = useState(null);
  const [studioPayments, setStudioPayments] = useState([]);
  const [studioForm, setStudioForm] = useState({
    studioName: '', usageTime: '', amount: '', vatAmount: '', bankName: '국민', customBank: '',
    accountNumber: '', accountHolder: '', modelName: '', modelPayment: '', shootDate: todayStr,
  });
  const [studioPaymentFilterDate, setStudioPaymentFilterDate] = useState(todayStr);
  const [studioPaymentLoading, setStudioPaymentLoading] = useState(false);
  const [studioPaymentError, setStudioPaymentError] = useState('');
  const [studioPaymentCopyMessage, setStudioPaymentCopyMessage] = useState('');
  const [selectedStudioPaymentIds, setSelectedStudioPaymentIds] = useState(new Set());
  const [expandedStudioPaymentId, setExpandedStudioPaymentId] = useState(null);
  const [editingStudioPayment, setEditingStudioPayment] = useState(null);
  const [requestEditSaving, setRequestEditSaving] = useState(false);
  const [requestEditError, setRequestEditError] = useState('');
  const [lastStudioHistoryPromptName, setLastStudioHistoryPromptName] = useState('');
  const [selectedPaymentRequestIds, setSelectedPaymentRequestIds] = useState(new Set());

  // 시간 수정
  const [editingRecord, setEditingRecord] = useState(null);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState('');
  const [showRecordCreate, setShowRecordCreate] = useState(false);
  const [recordCreateMember, setRecordCreateMember] = useState('');
  const [recordCreateDate, setRecordCreateDate] = useState(todayStr);
  const [recordCreateStart, setRecordCreateStart] = useState('09:00');
  const [recordCreateEnd, setRecordCreateEnd] = useState('14:00');
  const [recordCreateSaving, setRecordCreateSaving] = useState(false);
  const [recordCreateError, setRecordCreateError] = useState('');

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

  const loadMemberAccounts = useCallback(async () => {
    try {
      const params = new URLSearchParams({ pin });
      const res = await fetch(`${COLLAB_API_BASE}/attendance/members/accounts?${params}`);
      if (!res.ok) return;
      const accounts = await res.json();
      setMemberAccounts(Object.fromEntries(accounts.map((account) => [account.id, account])));
    } catch {
      // 관리자 화면을 다시 열 때 재조회한다.
    }
  }, [pin]);

  const loadFixedAllowances = useCallback(async () => {
    try {
      const params = new URLSearchParams({ pin });
      const res = await fetch(`${COLLAB_API_BASE}/attendance/members/fixed-allowances?${params}`);
      if (res.ok) setFixedAllowancesByMember(await res.json());
    } catch {
      // 급여관리 화면에서 다시 저장하거나 새로고침해 재조회할 수 있다.
    }
  }, [pin]);

  useEffect(() => {
    if (pinAuth) loadMemberAccounts();
  }, [pinAuth, loadMemberAccounts]);

  useEffect(() => {
    if (pinAuth) loadFixedAllowances();
  }, [pinAuth, loadFixedAllowances]);

  const openMemberAccountEdit = (member) => {
    const account = memberAccounts[member.id] || {};
    const listedBank = Boolean(DAILY_BANK_CODES[account.bankName]);
    setEditingMemberAccount({
      id: member.id,
      name: member.name,
      hasAccount: Boolean(account.accountNumber),
      bank: listedBank ? account.bankName : (account.bankName ? '직접입력:' : '국민'),
      customBank: listedBank ? '' : (account.bankName || ''),
      accountHolder: account.accountHolder || '',
      accountNumber: account.accountNumber || '',
    });
    setMemberAccountError('');
  };

  const saveMemberAccount = async () => {
    if (!editingMemberAccount) return;
    const bankName = editingMemberAccount.bank === '직접입력:'
      ? editingMemberAccount.customBank.trim()
      : editingMemberAccount.bank;
    if (!bankName || !editingMemberAccount.accountHolder.trim() || !editingMemberAccount.accountNumber.trim()) {
      setMemberAccountError('은행, 예금주, 계좌번호를 모두 입력하세요.');
      return;
    }
    const res = await fetch(`${COLLAB_API_BASE}/attendance/members/${editingMemberAccount.id}/account`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pin,
        bankName,
        accountHolder: editingMemberAccount.accountHolder.trim(),
        accountNumber: editingMemberAccount.accountNumber.trim(),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setMemberAccountError(data.detail || '계좌정보 저장에 실패했습니다.');
      return;
    }
    setEditingMemberAccount(null);
    await loadMemberAccounts();
  };

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
      if (dailyFilterFrom) params.append('date_from', dailyFilterFrom);
      if (dailyFilterTo) params.append('date_to', dailyFilterTo);
      const res = await fetch(`${COLLAB_API_BASE}/attendance/daily-workers?${params}`);
      const data = await res.json().catch(() => []);
      if (!res.ok) throw new Error(data?.detail || '일일 알바 기록 조회에 실패했습니다.');
      setDailyWorkers(Array.isArray(data) ? data : []);
      setSelectedDailyTransferIds(new Set());
    } catch (error) {
      setDailyError(error.message || '일일 알바 기록 조회에 실패했습니다.');
    } finally {
      setDailyLoading(false);
    }
  }, [pin, dailyFilterFrom, dailyFilterTo]);

  useEffect(() => {
    if (pinAuth && tab === 'payroll' && payrollMode === 'daily') loadDailyWorkers();
  }, [pinAuth, tab, payrollMode, loadDailyWorkers]);

  const loadPaymentRequests = useCallback(async () => {
    setPaymentRequestLoading(true);
    setPaymentRequestError('');
    try {
      const params = new URLSearchParams({ pin });
      if (paymentRequestFilterDate) params.append('date', paymentRequestFilterDate);
      const res = await fetch(`${COLLAB_API_BASE}/attendance/payment-requests?${params}`);
      const data = await res.json().catch(() => []);
      if (!res.ok) throw new Error(data?.detail || '입금 요청 조회에 실패했습니다.');
      setPaymentRequests(Array.isArray(data) ? data : []);
      setSelectedPaymentRequestIds(new Set());
    } catch (error) {
      setPaymentRequestError(error.message || '입금 요청 조회에 실패했습니다.');
    } finally {
      setPaymentRequestLoading(false);
    }
  }, [pin, paymentRequestFilterDate]);

  useEffect(() => {
    if (pinAuth && tab === 'paymentRequest' && paymentRequestMode === 'personal') loadPaymentRequests();
  }, [pinAuth, tab, paymentRequestMode, loadPaymentRequests]);

  useEffect(() => {
    if (pinAuth && tab === 'paymentRequest' && paymentRequestMode === 'studio') loadStudioPayments();
  }, [pinAuth, tab, paymentRequestMode]);

  const addPaymentRequest = async () => {
    const bankName = paymentRequestBank === '직접입력:'
      ? paymentRequestCustomBank.trim()
      : paymentRequestBank;
    const residentDigits = paymentRequestResident.replace(/\D/g, '');
    const amount = Number(paymentRequestAmount);
    setPaymentRequestError('');
    if (!paymentRequestDate || !bankName || !paymentRequestHolder.trim()
      || !paymentRequestAccount.trim() || !paymentRequestContent.trim()) {
      setPaymentRequestError('날짜, 은행, 예금주, 계좌번호, 내용을 모두 입력하세요.');
      return;
    }
    if (!Number.isInteger(amount) || amount <= 0) {
      setPaymentRequestError('이체금액을 1원 이상의 정수로 입력하세요.');
      return;
    }
    if (residentDigits && residentDigits.length !== 13) {
      setPaymentRequestError('주민등록번호 13자리를 정확히 입력하세요.');
      return;
    }
    setPaymentRequestLoading(true);
    try {
      const res = await fetch(`${COLLAB_API_BASE}/attendance/payment-requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pin,
          date: paymentRequestDate,
          bankName,
          accountHolder: paymentRequestHolder.trim(),
          accountNumber: paymentRequestAccount.trim(),
          amount,
          content: paymentRequestContent.trim(),
          residentRegistrationNumber: residentDigits,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || '입금 요청 등록에 실패했습니다.');
      setPaymentRequestHolder('');
      setPaymentRequestAccount('');
      setPaymentRequestAmount('');
      setPaymentRequestContent('');
      setPaymentRequestResident('');
      setPaymentRequestFilterDate(paymentRequestDate);
      setPaymentRequests([data]);
      setSelectedPaymentRequestIds(new Set());
    } catch (error) {
      setPaymentRequestError(error.message || '입금 요청 등록에 실패했습니다.');
    } finally {
      setPaymentRequestLoading(false);
    }
  };

  const togglePaymentRequestPayment = async (entry) => {
    const res = await fetch(`${COLLAB_API_BASE}/attendance/payment-requests/${entry.id}/payment`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin, completed: !entry.paymentCompleted }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setPaymentRequestError(data.detail || '입금 상태 변경에 실패했습니다.');
      return;
    }
    setPaymentRequests((current) => current.map((item) => (
      item.id === entry.id ? { ...item, paymentCompleted: !entry.paymentCompleted } : item
    )));
    setSelectedPaymentRequestIds((current) => {
      const next = new Set(current);
      next.delete(entry.id);
      return next;
    });
  };

  const deletePaymentRequest = async (entry) => {
    if (!window.confirm(`${entry.accountHolder}님의 ${entry.date} 입금 요청을 삭제하시겠습니까?`)) return;
    const res = await fetch(`${COLLAB_API_BASE}/attendance/payment-requests/${entry.id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setPaymentRequestError(data.detail || '입금 요청 삭제에 실패했습니다.');
      return;
    }
    await loadPaymentRequests();
  };

  const loadStudioPayments = async () => {
    setStudioPaymentLoading(true);
    setStudioPaymentError('');
    try {
      const params = new URLSearchParams({ pin, date: studioPaymentFilterDate });
      const res = await fetch(`${COLLAB_API_BASE}/attendance/studio-payments?${params}`);
      const data = await res.json().catch(() => []);
      if (!res.ok) throw new Error(data.detail || '스튜디오 입금 조회에 실패했습니다.');
      setStudioPayments(Array.isArray(data) ? data : []);
      setSelectedStudioPaymentIds(new Set());
    } catch (error) {
      setStudioPaymentError(error.message || '스튜디오 입금 조회에 실패했습니다.');
    } finally {
      setStudioPaymentLoading(false);
    }
  };

  const addStudioPayment = async () => {
    const bankName = studioForm.bankName === '직접입력:' ? studioForm.customBank.trim() : studioForm.bankName;
    const amount = Number(studioForm.amount);
    const vatAmount = Number(studioForm.vatAmount || 0);
    const modelPayment = Number(studioForm.modelPayment);
    setStudioPaymentError('');
    if (!studioForm.studioName.trim() || !studioForm.usageTime.trim() || !bankName
      || !studioForm.accountNumber.trim() || !studioForm.accountHolder.trim()
      || !studioForm.modelName.trim() || !studioForm.shootDate) {
      setStudioPaymentError('스튜디오 입금 정보를 모두 입력하세요.');
      return;
    }
    if (!Number.isInteger(amount) || amount <= 0 || !Number.isInteger(vatAmount) || vatAmount < 0 || !Number.isInteger(modelPayment) || modelPayment < 0) {
      setStudioPaymentError('입금액과 모델지급액을 확인하세요.');
      return;
    }
    setStudioPaymentLoading(true);
    try {
      const res = await fetch(`${COLLAB_API_BASE}/attendance/studio-payments`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...studioForm, pin, bankName, amount, vatAmount, modelPayment }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || '스튜디오 입금 등록에 실패했습니다.');
      setStudioForm((current) => ({ ...current, studioName: '', usageTime: '', amount: '', vatAmount: '', accountNumber: '', accountHolder: '', modelName: '', modelPayment: '' }));
      setLastStudioHistoryPromptName('');
      setStudioPaymentFilterDate(studioForm.shootDate);
      setStudioPayments([data]);
    } catch (error) {
      setStudioPaymentError(error.message || '스튜디오 입금 등록에 실패했습니다.');
    } finally {
      setStudioPaymentLoading(false);
    }
  };

  const applyStudioHistory = async () => {
    const studioName = studioForm.studioName.trim();
    if (!studioName || studioName === lastStudioHistoryPromptName) return;
    try {
      const params = new URLSearchParams({ pin, studio_name: studioName });
      const res = await fetch(`${COLLAB_API_BASE}/attendance/studio-payments/history?${params}`);
      const history = await res.json().catch(() => null);
      if (!res.ok || !history) return;
      setLastStudioHistoryPromptName(studioName);
      if (!window.confirm('과거 동일한 이력이 있습니다. 자동 기입 하시겠습니까?')) return;
      const listedBank = DAILY_BANK_OPTIONS.includes(history.bankName);
      setStudioForm((current) => ({
        ...current,
        usageTime: history.usageTime || '',
        bankName: listedBank ? history.bankName : '직접입력:',
        customBank: listedBank ? '' : history.bankName,
        accountNumber: history.accountNumber || '',
        accountHolder: history.accountHolder || '',
        modelName: history.modelName || '',
      }));
    } catch {
      // 과거 이력 자동입력은 선택 기능이므로 직접 입력을 계속할 수 있다.
    }
  };

  const toggleStudioPayment = async (entry) => {
    const res = await fetch(`${COLLAB_API_BASE}/attendance/studio-payments/${entry.id}/payment`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin, completed: !entry.paymentCompleted }),
    });
    if (res.ok) setStudioPayments((current) => current.map((item) => item.id === entry.id ? { ...item, paymentCompleted: !entry.paymentCompleted } : item));
  };

  const deleteStudioPayment = async (entry) => {
    if (!window.confirm('삭제하시겠습니까?')) return;
    await fetch(`${COLLAB_API_BASE}/attendance/studio-payments/${entry.id}`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }),
    });
    await loadStudioPayments();
  };

  const savePaymentRequestEdit = async () => {
    if (!editingPaymentRequest) return;
    setRequestEditSaving(true);
    setRequestEditError('');
    try {
      const res = await fetch(`${COLLAB_API_BASE}/attendance/payment-requests/${editingPaymentRequest.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...editingPaymentRequest, pin, amount: Number(editingPaymentRequest.amount) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || '수정에 실패했습니다.');
      setPaymentRequests((current) => current.map((item) => item.id === data.id ? data : item));
      setEditingPaymentRequest(null);
    } catch (error) {
      setRequestEditError(error.message || '수정에 실패했습니다.');
    } finally {
      setRequestEditSaving(false);
    }
  };

  const saveStudioPaymentEdit = async () => {
    if (!editingStudioPayment) return;
    setRequestEditSaving(true);
    setRequestEditError('');
    try {
      const res = await fetch(`${COLLAB_API_BASE}/attendance/studio-payments/${editingStudioPayment.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...editingStudioPayment, pin, amount: Number(editingStudioPayment.amount), vatAmount: Number(editingStudioPayment.vatAmount || 0), modelPayment: Number(editingStudioPayment.modelPayment) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || '수정에 실패했습니다.');
      setStudioPayments((current) => current.map((item) => item.id === data.id ? data : item));
      setEditingStudioPayment(null);
    } catch (error) {
      setRequestEditError(error.message || '수정에 실패했습니다.');
    } finally {
      setRequestEditSaving(false);
    }
  };

  const addDailyWorker = async () => {
    const name = dailyName.trim();
    const residentNumberDigits = dailyResidentNumber.replace(/\D/g, '');
    const hasAccountInput = Boolean(dailyAccountHolder.trim() || dailyAccountNumber.trim() || dailyCustomBank.trim());
    const bankName = hasAccountInput ? (dailyBank === '직접입력:' ? dailyCustomBank.trim() : dailyBank) : '';
    if (!name) {
      setDailyError('이름을 입력하세요.');
      return;
    }
    if (hasAccountInput && (!bankName || !dailyAccountHolder.trim() || !dailyAccountNumber.trim())) {
      setDailyError('계좌정보를 입력하려면 은행, 예금주, 계좌번호를 모두 입력하세요. 입력하지 않고 등록해도 됩니다.');
      return;
    }
    if (residentNumberDigits && residentNumberDigits.length !== 13) {
      setDailyError('주민등록번호 13자리를 정확히 입력하세요.');
      return;
    }
    setDailyLoading(true);
    setDailyError('');
    try {
      const res = await fetch(`${COLLAB_API_BASE}/attendance/daily-workers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pin, name, date: dailyDate, startTime: dailyStartTime, endTime: dailyEndTime,
          bankName, accountHolder: dailyAccountHolder.trim(), accountNumber: dailyAccountNumber.trim(),
          residentRegistrationNumber: residentNumberDigits,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || '일일 알바 등록에 실패했습니다.');
      setDailyName('');
      setDailyAccountHolder('');
      setDailyAccountNumber('');
      setDailyResidentNumber('');
      setShowDailyWorkerForm(false);
      await loadDailyWorkers();
    } catch (error) {
      setDailyError(error.message || '일일 알바 등록에 실패했습니다.');
    } finally {
      setDailyLoading(false);
    }
  };

  const startDailyAccountEdit = (entry) => {
    const listedBank = Boolean(DAILY_BANK_CODES[entry.bankName]);
    setEditingDailyAccount({
      id: entry.id,
      bank: listedBank ? entry.bankName : (entry.bankName ? '직접입력:' : '국민'),
      customBank: listedBank ? '' : entry.bankName,
      accountHolder: entry.accountHolder || '',
      accountNumber: entry.accountNumber || '',
    });
    setDailyError('');
  };

  const saveDailyAccount = async () => {
    if (!editingDailyAccount) return;
    const bankName = editingDailyAccount.bank === '직접입력:'
      ? editingDailyAccount.customBank.trim()
      : editingDailyAccount.bank;
    if (!bankName || !editingDailyAccount.accountHolder.trim() || !editingDailyAccount.accountNumber.trim()) {
      setDailyError('수정할 은행, 예금주, 계좌번호를 모두 입력하세요.');
      return;
    }
    const res = await fetch(`${COLLAB_API_BASE}/attendance/daily-workers/${editingDailyAccount.id}/account`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pin,
        bankName,
        accountHolder: editingDailyAccount.accountHolder.trim(),
        accountNumber: editingDailyAccount.accountNumber.trim(),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setDailyError(data.detail || '계좌정보 수정에 실패했습니다.');
      return;
    }
    setEditingDailyAccount(null);
    await loadDailyWorkers();
  };

  const startDailyResidentEdit = (entry) => {
    const digits = (entry.residentRegistrationNumber || '').replace(/\D/g, '');
    setEditingDailyResident({
      id: entry.id,
      value: digits.length > 6 ? `${digits.slice(0, 6)}-${digits.slice(6)}` : digits,
    });
    setDailyError('');
  };

  const saveDailyResident = async () => {
    if (!editingDailyResident) return;
    const digits = editingDailyResident.value.replace(/\D/g, '');
    if (digits && digits.length !== 13) {
      setDailyError('주민등록번호 13자리를 정확히 입력하세요.');
      return;
    }
    const res = await fetch(`${COLLAB_API_BASE}/attendance/daily-workers/${editingDailyResident.id}/resident-number`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin, residentRegistrationNumber: digits }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setDailyError(data.detail || '주민등록번호 수정에 실패했습니다.');
      return;
    }
    setEditingDailyResident(null);
    await loadDailyWorkers();
  };

  const getDailyWorkerAmount = (entry) => {
    const year = Number(entry.date.slice(0, 4));
    const month = Number(entry.date.slice(5, 7));
    return calcSalaryData([
      { date: entry.date, type: '출근', timestamp: entry.checkInTimestamp },
      { date: entry.date, type: '퇴근', timestamp: entry.checkOutTimestamp },
    ], {
      hourlyRate: salaryHourlyRate,
      holidayMin: salaryHolidayMin,
      workDays: salaryWorkDays,
      deductPct: salaryDeductPct,
      memberName: entry.name,
      year,
      month,
      allowances: [],
    }).netPay;
  };

  const toggleDailyPayment = async (entry) => {
    setDailyError('');
    const res = await fetch(`${COLLAB_API_BASE}/attendance/daily-workers/${entry.id}/payment`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin, completed: !entry.paymentCompleted }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setDailyError(data.detail || '입금 상태 변경에 실패했습니다.');
      return;
    }
    setDailyWorkers((current) => current.map((item) => (
      item.id === entry.id ? { ...item, paymentCompleted: !entry.paymentCompleted } : item
    )));
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
    return Object.values(map).sort((a, b) => {
      if (a.date !== b.date) return b.date.localeCompare(a.date);
      return a.name.localeCompare(b.name, 'ko-KR');
    });
  }, [records]);

  const recordWeekNumbers = useMemo(() => {
    const weekKeys = [...new Set(groupedRecords.map((group) => weekInfoForDate(group.date).key))]
      .sort((a, b) => a.localeCompare(b));
    return Object.fromEntries(weekKeys.map((key, index) => [key, index + 1]));
  }, [groupedRecords]);

  const displayedMembers = useMemo(
    () => members.filter((member) => (member.workArea || 'back') === memberArea),
    [members, memberArea],
  );

  const displayedFixedPayrollRows = useMemo(
    () => fixedPayrollRows.filter((row) => (
      fixedPayrollArea === 'all' || (row.workArea || 'back') === fixedPayrollArea
    )),
    [fixedPayrollRows, fixedPayrollArea],
  );

  const addMember = async () => {
    const name = newName.trim();
    if (!name) return;
    setAddError('');
    const res = await fetch(`${COLLAB_API_BASE}/attendance/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, pin, workArea: memberArea }),
    });
    if (res.ok) {
      setNewName('');
      loadMembers();
    } else {
      const d = await res.json().catch(() => ({}));
      setAddError(d.detail || '추가에 실패했습니다.');
    }
  };

  const deleteMember = async (id) => {
    if (!window.confirm('삭제하시겠습니까?')) return;
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
    setMemberEditHourlyRate(member.hourlyRate || '');
    setShowMemberRateHistory(false);
    setMemberEditError('');
  };

  const updateMember = async () => {
    if (!editingMember) return;
    const name = memberEditName.trim();
    const hourlyRate = memberEditHourlyRate === '' ? null : Number(memberEditHourlyRate);
    if (!name) {
      setMemberEditError('이름을 입력하세요.');
      return;
    }
    if (hourlyRate !== null && (!Number.isInteger(hourlyRate) || hourlyRate <= 0)) {
      setMemberEditError('개별 시급은 1원 이상의 정수로 입력하세요.');
      return;
    }
    setMemberEditSaving(true);
    setMemberEditError('');
    try {
      const res = await fetch(`${COLLAB_API_BASE}/attendance/members/${editingMember.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, pin, hourlyRate }),
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
    const { hourlyRate, hourlyRateHistory = [], holidayMin, workDays, deductPct, memberName, year, month, allowances = [] } = cfg;
    const rateForDate = (date) => {
      const applicable = hourlyRateHistory.filter((entry) => entry.effectiveDate <= date);
      const override = applicable.length ? applicable[applicable.length - 1].hourlyRate : null;
      return override || hourlyRate;
    };
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
      if (!weekMap[wk]) weekMap[wk] = { hours: 0, basicPay: 0, latestDate: date };
      weekMap[wk].hours += h;
      weekMap[wk].basicPay += h * rateForDate(date);
      if (date > weekMap[wk].latestDate) weekMap[wk].latestDate = date;
    });

    const monthlyHours = Object.values(weekMap).reduce((s, week) => s + week.hours, 0);
    const weeks = Object.entries(weekMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([wkStart, week], idx) => {
        const { hours } = week;
        const qualifies = hours >= holidayMin;
        const holPay = qualifies ? Math.round((hours / workDays) * rateForDate(week.latestDate)) : 0;
        return { week: idx + 1, wkStart, hours, qualifies, holPay };
      });

    const basicPay = Math.round(Object.values(weekMap).reduce((sum, week) => sum + week.basicPay, 0));
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
      hourlyRate: rateForDate(`${year}-${String(month).padStart(2, '0')}-${String(new Date(year, month, 0).getDate()).padStart(2, '0')}`), deductPct,
      monthlyHours, basicPay, holTotal, allowances, allowanceTotal, totalPay, incomeTax, localTax, deduction, netPay,
      qualifyingWeeks: weeks.filter((w) => w.qualifies).length,
      weeks,
    };
  };

  const copyUnpaidDailyWorkers = async () => {
    setDailyCopyMessage('');
    const unpaid = dailyWorkers.filter((entry) => !entry.paymentCompleted);
    const copyTargets = selectedDailyTransferIds.size > 0
      ? unpaid.filter((entry) => selectedDailyTransferIds.has(entry.id))
      : unpaid;
    if (copyTargets.length === 0) {
      setDailyCopyMessage('복사할 미입금 기록이 없습니다.');
      return;
    }
    const missing = copyTargets.filter((entry) => !entry.bankName || !entry.accountHolder || !entry.accountNumber);
    if (missing.length > 0) {
      const message = `계좌정보 미등록: ${missing.map((entry) => entry.name).join(', ')}`;
      setDailyCopyMessage(message);
      window.alert(message);
      return;
    }
    const unmatched = [...new Set(copyTargets.filter((entry) => !DAILY_BANK_CODES[entry.bankName]).map((entry) => entry.bankName))];
    if (unmatched.length > 0) {
      const message = `은행코드 미매칭: ${unmatched.join(', ')}`;
      setDailyCopyMessage(message);
      window.alert(message);
      return;
    }
    const rows = copyTargets.map((entry) => {
      const year = Number(entry.date.slice(0, 4));
      const month = Number(entry.date.slice(5, 7));
      const salary = calcSalaryData([
        { date: entry.date, type: '출근', timestamp: entry.checkInTimestamp },
        { date: entry.date, type: '퇴근', timestamp: entry.checkOutTimestamp },
      ], {
        hourlyRate: salaryHourlyRate,
        holidayMin: salaryHolidayMin,
        workDays: salaryWorkDays,
        deductPct: salaryDeductPct,
        memberName: entry.name,
        year,
        month,
        allowances: [],
      });
      return {
        id: entry.id,
        name: entry.name,
        amount: salary.netPay,
        excel: [
          DAILY_BANK_CODES[entry.bankName], entry.accountNumber, salary.netPay,
          entry.accountHolder, '주식회사유색', '일일알바',
        ].join('\t'),
      };
    });
    setTransferConfirmError('');
    setPendingTransferCopy({ type: 'daily', title: '일일 알바 미입금 정보', rows });
  };

  const loadFixedPayroll = async () => {
    setFixedPayrollLoading(true);
    setFixedPayrollError('');
    setFixedCopyMessage('');
    try {
      const dateFrom = `${fixedPayrollYear}-${String(fixedPayrollMonth).padStart(2, '0')}-01`;
      const lastDay = new Date(fixedPayrollYear, fixedPayrollMonth, 0).getDate();
      const dateTo = `${fixedPayrollYear}-${String(fixedPayrollMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
      const paymentParams = new URLSearchParams({
        pin, year: String(fixedPayrollYear), month: String(fixedPayrollMonth),
      });
      const [paymentRes, ...recordResponses] = await Promise.all([
        fetch(`${COLLAB_API_BASE}/attendance/fixed-worker-payments?${paymentParams}`),
        ...members.map((member) => {
          const params = new URLSearchParams({ pin, date_from: dateFrom, date_to: dateTo, name: member.name });
          return fetch(`${COLLAB_API_BASE}/attendance/records?${params}`);
        }),
      ]);
      if (!paymentRes.ok || recordResponses.some((res) => !res.ok)) {
        throw new Error('고정 알바 급여 조회에 실패했습니다.');
      }
      const payments = await paymentRes.json();
      const recordSets = await Promise.all(recordResponses.map((res) => res.json()));
      const rows = members.map((member, index) => {
        const salary = calcSalaryData(recordSets[index], {
          hourlyRate: salaryHourlyRate,
          hourlyRateHistory: member.hourlyRateHistory || [],
          holidayMin: salaryHolidayMin,
          workDays: salaryWorkDays,
          deductPct: salaryDeductPct,
          memberName: member.name,
          year: fixedPayrollYear,
          month: fixedPayrollMonth,
          allowances: fixedAllowancesByMember[member.id] || [],
        });
        return {
          ...member,
          ...(memberAccounts[member.id] || {}),
          salary,
          paymentCompleted: Boolean(payments[String(member.id)]),
        };
      });
      setFixedPayrollRows(rows);
      setSelectedFixedTransferIds(new Set());
    } catch (error) {
      setFixedPayrollError(error.message || '고정 알바 급여 조회에 실패했습니다.');
    } finally {
      setFixedPayrollLoading(false);
    }
  };

  const toggleFixedPayment = async (row) => {
    const res = await fetch(`${COLLAB_API_BASE}/attendance/fixed-worker-payments/${row.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pin,
        year: fixedPayrollYear,
        month: fixedPayrollMonth,
        completed: !row.paymentCompleted,
      }),
    });
    if (!res.ok) {
      setFixedPayrollError('입금 상태 변경에 실패했습니다.');
      return;
    }
    setFixedPayrollRows((current) => current.map((item) => (
      item.id === row.id ? { ...item, paymentCompleted: !row.paymentCompleted } : item
    )));
  };

  const copyUnpaidFixedWorkers = async () => {
    setFixedCopyMessage('');
    const unpaid = displayedFixedPayrollRows.filter((row) => !row.paymentCompleted && row.salary.netPay > 0);
    const copyTargets = selectedFixedTransferIds.size > 0
      ? unpaid.filter((row) => selectedFixedTransferIds.has(row.id))
      : unpaid;
    if (copyTargets.length === 0) {
      setFixedCopyMessage('복사할 미입금 급여가 없습니다.');
      return;
    }
    const missing = copyTargets.filter((row) => !row.bankName || !row.accountHolder || !row.accountNumber);
    if (missing.length > 0) {
      const message = `계좌정보 미등록: ${missing.map((row) => row.name).join(', ')}`;
      setFixedCopyMessage(message);
      window.alert(message);
      return;
    }
    const unmatched = copyTargets.filter((row) => !DAILY_BANK_CODES[row.bankName]);
    if (unmatched.length > 0) {
      const message = `은행코드 미매칭: ${unmatched.map((row) => `${row.name}(${row.bankName})`).join(', ')}`;
      setFixedCopyMessage(message);
      window.alert(message);
      return;
    }
    const rows = copyTargets.map((row) => ({
      id: row.id,
      name: row.name,
      amount: row.salary.netPay,
      excel: [
        DAILY_BANK_CODES[row.bankName],
        row.accountNumber,
        row.salary.netPay,
        row.accountHolder,
        '주식회사유색',
        `${fixedPayrollMonth}월 급여`,
      ].join('\t'),
    }));
    setTransferConfirmError('');
    setPendingTransferCopy({ type: 'fixed', title: `${fixedPayrollMonth}월 고정 알바 미입금 정보`, rows });
  };

  const exportFixedPayrollExcel = () => {
    const header = [
      '이름', '구분', '시급', '근무시간(H)', '기본급', '주휴수당', '수당', '세전합계',
      '소득세', '지방소득세', '공제합계', '실지급액', '입금상태', '은행', '예금주', '계좌번호',
    ];
    const body = displayedFixedPayrollRows.map((row) => [
      row.name,
      (row.workArea || 'back') === 'front' ? '프론트' : '백',
      row.salary.hourlyRate,
      Number(row.salary.monthlyHours.toFixed(1)),
      row.salary.basicPay,
      row.salary.holTotal,
      row.salary.allowanceTotal,
      row.salary.totalPay,
      row.salary.incomeTax,
      row.salary.localTax,
      row.salary.deduction,
      row.salary.netPay,
      row.paymentCompleted ? '입금완료' : '미입금',
      row.bankName || '',
      row.accountHolder || '',
      row.accountNumber || '',
    ]);
    const sheet = XLSX.utils.aoa_to_sheet([header, ...body]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, '급여조회');
    XLSX.writeFile(workbook, `${fixedPayrollYear}년_${fixedPayrollMonth}월_급여조회.xlsx`);
  };

  const copyUnpaidPaymentRequests = () => {
    setPaymentRequestCopyMessage('');
    const unpaid = paymentRequests.filter((entry) => !entry.paymentCompleted);
    const copyTargets = selectedPaymentRequestIds.size > 0
      ? unpaid.filter((entry) => selectedPaymentRequestIds.has(entry.id))
      : unpaid;
    if (copyTargets.length === 0) {
      setPaymentRequestCopyMessage('복사할 미입금 요청이 없습니다.');
      return;
    }
    const unmatched = [...new Set(copyTargets
      .filter((entry) => !DAILY_BANK_CODES[entry.bankName])
      .map((entry) => entry.bankName))];
    if (unmatched.length > 0) {
      const message = `은행코드 미매칭: ${unmatched.join(', ')}`;
      setPaymentRequestCopyMessage(message);
      window.alert(message);
      return;
    }
    const rows = copyTargets.map((entry) => ({
      id: entry.id,
      name: entry.accountHolder,
      amount: entry.amount,
      excel: [
        DAILY_BANK_CODES[entry.bankName],
        entry.accountNumber,
        entry.amount,
        entry.accountHolder,
        '주식회사유색',
        entry.content,
      ].join('\t'),
    }));
    setTransferConfirmError('');
    setPendingTransferCopy({ type: 'request', title: `${paymentRequestFilterDate} 입금 요청 미입금 정보`, rows });
  };

  const copyUnpaidStudioPayments = () => {
    setStudioPaymentCopyMessage('');
    const unpaid = studioPayments.filter((entry) => !entry.paymentCompleted);
    const targets = selectedStudioPaymentIds.size > 0
      ? unpaid.filter((entry) => selectedStudioPaymentIds.has(entry.id)) : unpaid;
    if (!targets.length) {
      setStudioPaymentCopyMessage('복사할 미입금 정보가 없습니다.');
      return;
    }
    const unmatched = [...new Set(targets.filter((entry) => !DAILY_BANK_CODES[entry.bankName]).map((entry) => entry.bankName))];
    if (unmatched.length) {
      const message = `은행코드 미매칭: ${unmatched.join(', ')}`;
      setStudioPaymentCopyMessage(message);
      window.alert(message);
      return;
    }
    const rows = targets.map((entry) => ({
      id: entry.id, name: entry.accountHolder, amount: entry.amount + (entry.vatAmount || 0),
      excel: [DAILY_BANK_CODES[entry.bankName], entry.accountNumber, entry.amount + (entry.vatAmount || 0),
        entry.accountHolder, '주식회사유색', `${entry.studioName} 스튜디오 입금`].join('\t'),
    }));
    setPendingTransferCopy({ type: 'studio', title: `${studioPaymentFilterDate} 스튜디오 미입금 정보`, rows });
  };

  const confirmTransferCopy = async () => {
    if (!pendingTransferCopy || transferConfirmBusy) return;
    setTransferConfirmBusy(true);
    setTransferConfirmError('');
    try {
      await copyTextToClipboard(pendingTransferCopy.rows.map((row) => row.excel).join('\n'));
      const responses = await Promise.all(pendingTransferCopy.rows.map((row) => (
        pendingTransferCopy.type === 'daily'
          ? fetch(`${COLLAB_API_BASE}/attendance/daily-workers/${row.id}/payment`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ pin, completed: true }),
            })
          : pendingTransferCopy.type === 'fixed'
          ? fetch(`${COLLAB_API_BASE}/attendance/fixed-worker-payments/${row.id}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                pin,
                year: fixedPayrollYear,
                month: fixedPayrollMonth,
                completed: true,
              }),
            })
          : pendingTransferCopy.type === 'studio'
          ? fetch(`${COLLAB_API_BASE}/attendance/studio-payments/${row.id}/payment`, {
              method: 'PATCH', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ pin, completed: true }),
            })
          : fetch(`${COLLAB_API_BASE}/attendance/payment-requests/${row.id}/payment`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ pin, completed: true }),
            })
      )));
      if (responses.some((response) => !response.ok)) {
        throw new Error('복사는 완료됐지만 일부 입금 상태를 변경하지 못했습니다. 다시 조회해 확인해 주세요.');
      }
      const copiedCount = pendingTransferCopy.rows.length;
      const completedIds = new Set(pendingTransferCopy.rows.map((row) => row.id));
      if (pendingTransferCopy.type === 'daily') {
        setDailyWorkers((current) => current.map((entry) => (
          completedIds.has(entry.id) ? { ...entry, paymentCompleted: true } : entry
        )));
        setDailyCopyMessage(`${copiedCount}건을 복사하고 입금완료 처리했습니다.`);
        setSelectedDailyTransferIds(new Set());
      } else if (pendingTransferCopy.type === 'fixed') {
        setFixedPayrollRows((current) => current.map((row) => (
          completedIds.has(row.id) ? { ...row, paymentCompleted: true } : row
        )));
        setFixedCopyMessage(`${copiedCount}건을 복사하고 입금완료 처리했습니다.`);
        setSelectedFixedTransferIds(new Set());
      } else if (pendingTransferCopy.type === 'studio') {
        setStudioPayments((current) => current.map((entry) => (
          completedIds.has(entry.id) ? { ...entry, paymentCompleted: true } : entry
        )));
        setSelectedStudioPaymentIds(new Set());
      } else {
        setPaymentRequests((current) => current.map((row) => (
          completedIds.has(row.id) ? { ...row, paymentCompleted: true } : row
        )));
        setPaymentRequestCopyMessage(`${copiedCount}건을 복사하고 입금완료 처리했습니다.`);
        setSelectedPaymentRequestIds(new Set());
      }
      setPendingTransferCopy(null);
    } catch (error) {
      setTransferConfirmError(error.message || '복사 및 입금완료 처리에 실패했습니다.');
    } finally {
      setTransferConfirmBusy(false);
    }
  };

  const changeSalaryMember = (value) => {
    setSalaryMember(value);
    setSalaryResult(null);
    setAllSalaryResults(null);
    setDailySalaryResults(null);
    const member = members.find((item) => item.name === value);
    setSalaryAllowances(member ? [...(fixedAllowancesByMember[member.id] || [])] : []);
  };

  const saveFixedAllowances = async () => {
    const member = members.find((item) => item.name === salaryMember);
    if (!member) {
      window.alert('고정할 직원을 먼저 선택하세요.');
      return;
    }
    if (salaryAllowances.length === 0) {
      window.alert('추가수당을 먼저 추가하세요.');
      return;
    }
    if (!window.confirm('앞으로 해당 내용과 금액을 고정합니다')) return;
    setFixedAllowanceSaving(true);
    setSalaryError('');
    try {
      const res = await fetch(`${COLLAB_API_BASE}/attendance/members/${member.id}/fixed-allowances`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pin,
          allowances: salaryAllowances.map(({ name, amount }) => ({ name, amount: Number(amount) })),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || '추가수당 고정에 실패했습니다.');
      await loadFixedAllowances();
      setSalaryAllowances((current) => current.map((item) => ({ ...item, fixed: true })));
    } catch (error) {
      setSalaryError(error.message || '추가수당 고정에 실패했습니다.');
    } finally {
      setFixedAllowanceSaving(false);
    }
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
        const member = members.find((item) => item.name === salaryMember);
        setSalaryResult(calcSalaryData(fetched, {
          ...cfg,
          memberName: salaryMember,
          hourlyRate: salaryHourlyRate,
          hourlyRateHistory: member?.hourlyRateHistory || [],
        }));
      } else {
        if (!members.length) throw new Error('직원 목록이 없습니다.');
        const results = await Promise.all(members.map(async (mem) => {
          const params = new URLSearchParams({ pin, date_from: dateFrom, date_to: dateTo, name: mem.name });
          const res = await fetch(`${COLLAB_API_BASE}/attendance/records?${params}`);
          if (!res.ok) throw new Error(`${mem.name} 조회 실패`);
          const fetched = await res.json();
          return calcSalaryData(fetched, {
            ...cfg,
            memberName: mem.name,
            hourlyRate: salaryHourlyRate,
            hourlyRateHistory: mem.hourlyRateHistory || [],
            allowances: fixedAllowancesByMember[mem.id] || [],
          });
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
    if (inRec.payrollEligible === false || outRec.payrollEligible === false) return null;
    const diff = new Date(outRec.normalizedTimestamp || outRec.timestamp)
      - new Date(inRec.normalizedTimestamp || inRec.timestamp);
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

  const openRecordCreate = () => {
    setRecordCreateMember(filterName || members[0]?.name || '');
    setRecordCreateDate(filterDateFrom || todayStr());
    setRecordCreateStart('09:00');
    setRecordCreateEnd('14:00');
    setRecordCreateError('');
    setShowRecordCreate(true);
  };

  const createRecordPair = async () => {
    if (!recordCreateMember || !recordCreateDate || !recordCreateStart || !recordCreateEnd) {
      setRecordCreateError('직원, 날짜, 출근시간, 퇴근시간을 모두 입력하세요.');
      return;
    }
    setRecordCreateSaving(true);
    setRecordCreateError('');
    try {
      const res = await fetch(`${COLLAB_API_BASE}/attendance/records/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pin,
          member_name: recordCreateMember,
          date: recordCreateDate,
          startTime: recordCreateStart,
          endTime: recordCreateEnd,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || '출퇴근 기록 등록에 실패했습니다.');

      const params = new URLSearchParams({
        pin,
        date: recordCreateDate,
        name: recordCreateMember,
      });
      const recordsRes = await fetch(`${COLLAB_API_BASE}/attendance/records?${params}`);
      const nextRecords = recordsRes.ok ? await recordsRes.json() : [];
      setFilterDateFrom(recordCreateDate);
      setFilterDateTo(recordCreateDate);
      setFilterName(recordCreateMember);
      setRecords(Array.isArray(nextRecords) ? nextRecords : []);
      setShowRecordCreate(false);
    } catch (error) {
      setRecordCreateError(error.message || '출퇴근 기록 등록에 실패했습니다.');
    } finally {
      setRecordCreateSaving(false);
    }
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
            className={`${styles.tabBtn} ${tab === 'schedule' ? styles.tabActive : ''}`}
            onClick={() => setTab('schedule')}
          >
            📅 스케줄관리
          </button>
          <button
            className={`${styles.tabBtn} ${tab === 'payroll' ? styles.tabActive : ''}`}
            onClick={() => setTab('payroll')}
          >
            🧾 급여 계산
          </button>
          <button
            className={`${styles.tabBtn} ${tab === 'paymentRequest' ? styles.tabActive : ''}`}
            onClick={() => setTab('paymentRequest')}
          >
            💸 입금 요청
          </button>
        </div>

        {tab === 'payroll' && (
          <div className={styles.payrollSubTabs}>
            <button className={`${styles.payrollSubBtn} ${payrollMode === 'fixed' ? styles.payrollSubActive : ''}`} onClick={() => setPayrollMode('fixed')}>
              고정 알바
            </button>
            <button className={`${styles.payrollSubBtn} ${payrollMode === 'daily' ? styles.payrollSubActive : ''}`} onClick={() => setPayrollMode('daily')}>
              일일 알바
            </button>
            <button className={`${styles.payrollSubBtn} ${payrollMode === 'salary' ? styles.payrollSubActive : ''}`} onClick={() => setPayrollMode('salary')}>
              급여 명세서
            </button>
          </div>
        )}

        {/* ── 입금 요청 탭 ── */}
        {tab === 'paymentRequest' && (
          <>
            <div className={styles.memberAreaTabs}>
              <button className={`${styles.memberAreaTab} ${paymentRequestMode === 'personal' ? styles.memberAreaTabActive : ''}`} onClick={() => setPaymentRequestMode('personal')}>개인요청</button>
              <button className={`${styles.memberAreaTab} ${paymentRequestMode === 'studio' ? styles.memberAreaTabActive : ''}`} onClick={() => setPaymentRequestMode('studio')}>스튜디오 입금</button>
            </div>
            {paymentRequestMode === 'personal' && (
              <>
            <div className={styles.card}>
              <div className={styles.dailyListHeader}>
                <strong>입금 요청 등록</strong>
                <button className={styles.copyUnpaidBtn} onClick={copyUnpaidPaymentRequests} disabled={paymentRequestLoading || paymentRequests.length === 0}>
                  미입금 정보 복사
                </button>
              </div>
              <div className={styles.paymentRequestGrid}>
                <label className={styles.dailyField}>
                  <span>날짜</span>
                  <input type="date" className={styles.filterInput} value={paymentRequestDate} onChange={(e) => setPaymentRequestDate(e.target.value)} />
                </label>
                <label className={styles.dailyField}>
                  <span>은행</span>
                  <select className={styles.filterInput} value={paymentRequestBank} onChange={(e) => setPaymentRequestBank(e.target.value)}>
                    {DAILY_BANK_OPTIONS.map((bank) => <option key={bank} value={bank}>{bank}</option>)}
                  </select>
                </label>
                {paymentRequestBank === '직접입력:' && (
                  <label className={styles.dailyField}>
                    <span>은행명 직접입력</span>
                    <input className={styles.filterInput} value={paymentRequestCustomBank} onChange={(e) => setPaymentRequestCustomBank(e.target.value)} placeholder="은행명" />
                  </label>
                )}
                <label className={styles.dailyField}>
                  <span>예금주</span>
                  <input className={styles.filterInput} value={paymentRequestHolder} onChange={(e) => setPaymentRequestHolder(e.target.value)} placeholder="예금주" />
                </label>
                <label className={styles.dailyField}>
                  <span>계좌번호</span>
                  <input className={styles.filterInput} inputMode="numeric" value={paymentRequestAccount} onChange={(e) => setPaymentRequestAccount(e.target.value)} placeholder="숫자만 입력" />
                </label>
                <label className={styles.dailyField}>
                  <span>이체금액</span>
                  <input type="number" min="1" className={styles.filterInput} value={paymentRequestAmount} onChange={(e) => setPaymentRequestAmount(e.target.value)} placeholder="금액" />
                </label>
                <label className={`${styles.dailyField} ${styles.paymentRequestContentField}`}>
                  <span>내용</span>
                  <input className={styles.filterInput} value={paymentRequestContent} onChange={(e) => setPaymentRequestContent(e.target.value)} placeholder="이체 내용" />
                </label>
                <label className={styles.dailyField}>
                  <span>주민등록번호 (필요시)</span>
                  <input
                    className={styles.filterInput}
                    inputMode="numeric"
                    autoComplete="off"
                    maxLength={14}
                    value={paymentRequestResident}
                    onChange={(e) => {
                      const digits = e.target.value.replace(/\D/g, '').slice(0, 13);
                      setPaymentRequestResident(digits.length > 6 ? `${digits.slice(0, 6)}-${digits.slice(6)}` : digits);
                    }}
                    placeholder="000000-0000000"
                  />
                </label>
              </div>
              {paymentRequestError && <div className={styles.errorMsg}>{paymentRequestError}</div>}
              <button className={styles.addBtn} onClick={addPaymentRequest} disabled={paymentRequestLoading}>
                {paymentRequestLoading ? '등록 중...' : '등록'}
              </button>
            </div>

            <div className={styles.card}>
              <div className={styles.dailyListHeader}>
                <strong>입금 요청 목록</strong>
                <span>{paymentRequests.length}건</span>
              </div>
              <div className={styles.paymentRequestFilter}>
                <label className={styles.dailyField}>
                  <span>조회 날짜</span>
                  <input type="date" className={styles.filterInput} value={paymentRequestFilterDate} onChange={(e) => setPaymentRequestFilterDate(e.target.value)} />
                </label>
                <button className={`${styles.searchBtn} ${styles.dailySearchBtn}`} onClick={loadPaymentRequests} disabled={paymentRequestLoading}>조회</button>
              </div>
              {paymentRequestCopyMessage && <div className={styles.dailyCopyMessage}>{paymentRequestCopyMessage}</div>}
              {paymentRequestLoading && paymentRequests.length === 0 ? (
                <div className={styles.loadingMsg}>불러오는 중...</div>
              ) : paymentRequests.length === 0 ? (
                <div className={styles.emptyMsg}>해당 날짜에 등록된 입금 요청이 없습니다.</div>
              ) : (
                <div className={styles.dailyWorkerScroll}>
                  {paymentRequests.map((entry) => {
                    const residentDigits = (entry.residentRegistrationNumber || '').replace(/\D/g, '');
                    const resident = residentDigits.length === 13
                      ? `${residentDigits.slice(0, 6)}-${residentDigits.slice(6)}`
                      : '미기재';
                    return (
                      <article key={entry.id} className={`${styles.paymentRequestCard} ${entry.paymentCompleted ? styles.dailyWorkerCardPaid : ''}`}>
                        <label className={styles.transferSelectBox} title="선택한 항목만 복사">
                          <input
                            type="checkbox"
                            checked={selectedPaymentRequestIds.has(entry.id)}
                            disabled={entry.paymentCompleted}
                            onChange={(e) => setSelectedPaymentRequestIds((current) => {
                              const next = new Set(current);
                              if (e.target.checked) next.add(entry.id); else next.delete(entry.id);
                              return next;
                            })}
                          />
                        </label>
                        <div><strong>{entry.accountHolder}</strong><span>{entry.date}</span></div>
                        <div className={styles.dailyWorkerAccount}><strong>{entry.bankName}</strong><span>{entry.accountNumber}</span></div>
                        <div className={styles.paymentRequestDetails}><strong>{entry.amount.toLocaleString()}원</strong><span>{entry.content}</span><small>주민등록번호 {resident}</small></div>
                        <div className={styles.dailyWorkerActions}>
                          <button className={`${styles.paymentBtn} ${entry.paymentCompleted ? styles.paymentBtnActive : ''}`} onClick={() => togglePaymentRequestPayment(entry)}>
                            {entry.paymentCompleted ? '입금완료 해제' : '입금완료'}
                          </button>
                          <button className={styles.editMemberBtn} onClick={() => { setRequestEditError(''); setEditingPaymentRequest({ ...entry }); }}>수정</button>
                          <button className={styles.delBtn} onClick={() => deletePaymentRequest(entry)}>삭제</button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </div>
              </>
            )}
            {paymentRequestMode === 'studio' && (
              <>
                <div className={styles.card}>
                  <div className={styles.dailyListHeader}>
                    <strong>스튜디오 입금 등록</strong>
                    <button className={styles.copyUnpaidBtn} onClick={copyUnpaidStudioPayments} disabled={studioPaymentLoading || studioPayments.length === 0}>미입금 정보 복사</button>
                  </div>
                  <div className={styles.paymentRequestGrid}>
                    <label className={styles.dailyField}><span>스튜디오 이름</span><input className={styles.filterInput} value={studioForm.studioName} onChange={(e) => { setStudioForm((v) => ({ ...v, studioName: e.target.value })); if (e.target.value.trim() !== lastStudioHistoryPromptName) setLastStudioHistoryPromptName(''); }} onBlur={applyStudioHistory} /></label>
                    <label className={styles.dailyField}><span>시간</span><input className={styles.filterInput} value={studioForm.usageTime} onChange={(e) => setStudioForm((v) => ({ ...v, usageTime: e.target.value }))} placeholder="예: 3시간" /></label>
                    <label className={styles.dailyField}><span>입금액</span><input type="number" min="1" className={styles.filterInput} value={studioForm.amount} onChange={(e) => setStudioForm((v) => ({ ...v, amount: e.target.value }))} /></label>
                    <label className={styles.dailyField}><span>부가세 (필요시)</span><input type="number" min="0" className={styles.filterInput} value={studioForm.vatAmount} onChange={(e) => setStudioForm((v) => ({ ...v, vatAmount: e.target.value }))} placeholder="미입력 시 0원" /></label>
                    <label className={styles.dailyField}><span>은행</span><select className={styles.filterInput} value={studioForm.bankName} onChange={(e) => setStudioForm((v) => ({ ...v, bankName: e.target.value }))}>{DAILY_BANK_OPTIONS.map((bank) => <option key={bank} value={bank}>{bank}</option>)}</select></label>
                    {studioForm.bankName === '직접입력:' && <label className={styles.dailyField}><span>은행명 직접입력</span><input className={styles.filterInput} value={studioForm.customBank} onChange={(e) => setStudioForm((v) => ({ ...v, customBank: e.target.value }))} /></label>}
                    <label className={styles.dailyField}><span>계좌</span><input className={styles.filterInput} inputMode="numeric" value={studioForm.accountNumber} onChange={(e) => setStudioForm((v) => ({ ...v, accountNumber: e.target.value }))} /></label>
                    <label className={styles.dailyField}><span>예금주</span><input className={styles.filterInput} value={studioForm.accountHolder} onChange={(e) => setStudioForm((v) => ({ ...v, accountHolder: e.target.value }))} /></label>
                    <label className={styles.dailyField}><span>모델명</span><input className={styles.filterInput} value={studioForm.modelName} onChange={(e) => setStudioForm((v) => ({ ...v, modelName: e.target.value }))} /></label>
                    <label className={styles.dailyField}><span>모델지급액</span><input type="number" min="0" className={styles.filterInput} value={studioForm.modelPayment} onChange={(e) => setStudioForm((v) => ({ ...v, modelPayment: e.target.value }))} /></label>
                    <label className={styles.dailyField}><span>촬영예정일 ({new Date(`${studioForm.shootDate}T00:00:00`).toLocaleDateString('ko-KR', { weekday: 'short' })})</span><input type="date" className={styles.filterInput} value={studioForm.shootDate} onChange={(e) => setStudioForm((v) => ({ ...v, shootDate: e.target.value }))} /></label>
                  </div>
                  {studioPaymentError && <div className={styles.errorMsg}>{studioPaymentError}</div>}
                  <button className={styles.addBtn} onClick={addStudioPayment} disabled={studioPaymentLoading}>{studioPaymentLoading ? '등록 중...' : '등록'}</button>
                </div>
                <div className={styles.card}>
                  <div className={styles.dailyListHeader}><strong>스튜디오 입금 목록</strong><span>{studioPayments.length}건</span></div>
                  <div className={styles.paymentRequestFilter}>
                    <label className={styles.dailyField}><span>조회 날짜</span><input type="date" className={styles.filterInput} value={studioPaymentFilterDate} onChange={(e) => setStudioPaymentFilterDate(e.target.value)} /></label>
                    <button className={`${styles.searchBtn} ${styles.dailySearchBtn}`} onClick={loadStudioPayments} disabled={studioPaymentLoading}>조회</button>
                  </div>
                  {studioPaymentCopyMessage && <div className={styles.dailyCopyMessage}>{studioPaymentCopyMessage}</div>}
                  {!studioPayments.length ? <div className={styles.emptyMsg}>해당 날짜에 등록된 스튜디오 입금이 없습니다.</div> : (
                    <div className={styles.dailyWorkerScroll}>{studioPayments.map((entry) => (
                      <article key={entry.id} className={`${styles.studioPaymentCard} ${entry.paymentCompleted ? styles.dailyWorkerCardPaid : ''}`}>
                        <label className={styles.transferSelectBox} onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={selectedStudioPaymentIds.has(entry.id)} disabled={entry.paymentCompleted} onChange={(e) => setSelectedStudioPaymentIds((current) => { const next = new Set(current); if (e.target.checked) next.add(entry.id); else next.delete(entry.id); return next; })} /></label>
                        <button type="button" className={styles.studioPaymentSummary} onClick={() => setExpandedStudioPaymentId((id) => id === entry.id ? null : entry.id)}>
                          <strong>{entry.studioName}</strong><span>{entry.usageTime}</span><span>{(entry.amount + (entry.vatAmount || 0)).toLocaleString()}원</span><span>{entry.shootDate}</span>
                        </button>
                        {expandedStudioPaymentId === entry.id && <div className={styles.studioPaymentDetails}>
                          <span>입금액 {entry.amount.toLocaleString()}원</span><span>부가세 {(entry.vatAmount || 0).toLocaleString()}원</span><span>은행 {entry.bankName}</span><span>계좌 {entry.accountNumber}</span><span>예금주 {entry.accountHolder}</span><span>모델명 {entry.modelName}</span><span>모델지급액 {entry.modelPayment.toLocaleString()}원</span><span>촬영예정일 {entry.shootDate} ({new Date(`${entry.shootDate}T00:00:00`).toLocaleDateString('ko-KR', { weekday: 'short' })})</span>
                        </div>}
                        <div className={styles.dailyWorkerActions}><button className={`${styles.paymentBtn} ${entry.paymentCompleted ? styles.paymentBtnActive : ''}`} onClick={() => toggleStudioPayment(entry)}>{entry.paymentCompleted ? '입금완료 해제' : '입금완료'}</button><button className={styles.editMemberBtn} onClick={() => { setRequestEditError(''); setEditingStudioPayment({ ...entry }); }}>수정</button><button className={styles.delBtn} onClick={() => deleteStudioPayment(entry)}>삭제</button></div>
                      </article>
                    ))}</div>
                  )}
                </div>
              </>
            )}
          </>
        )}

        {/* ── 직원 관리 탭 ── */}
        {tab === 'members' && (
          <div className={styles.card}>
            <div className={styles.memberAreaTabs}>
              <button
                className={`${styles.memberAreaTab} ${memberArea === 'back' ? styles.memberAreaTabActive : ''}`}
                onClick={() => setMemberArea('back')}
              >
                백
              </button>
              <button
                className={`${styles.memberAreaTab} ${memberArea === 'front' ? styles.memberAreaTabActive : ''}`}
                onClick={() => setMemberArea('front')}
              >
                프론트
              </button>
            </div>
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
              {displayedMembers.length === 0 && (
                <li className={styles.emptyMsg}>등록된 직원이 없습니다.</li>
              )}
              {displayedMembers.map((m) => (
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
                  <button className={styles.delBtn} onClick={() => deleteMember(m.id)}>
                    삭제
                  </button>
                  <button
                    className={`${styles.memberAccountBtn} ${memberAccounts[m.id]?.accountNumber ? styles.memberAccountRegistered : styles.memberAccountUnregistered}`}
                    onClick={() => openMemberAccountEdit(m)}
                  >
                    {memberAccounts[m.id]?.accountNumber ? '계좌조회' : '계좌등록'}
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
                <button className={styles.addBtn} onClick={openRecordCreate}>등록</button>
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
                      {groupedRecords.map((g, index) => {
                        const dur = calcDuration(g.출근, g.퇴근);
                        const weekInfo = weekInfoForDate(g.date);
                        const previousWeekKey = index > 0
                          ? weekInfoForDate(groupedRecords[index - 1].date).key
                          : null;
                        return (
                          <Fragment key={`${g.date}__${g.name}`}>
                            {weekInfo.key !== previousWeekKey && (
                              <tr className={styles.weekDividerRow}>
                                <td colSpan={4}>
                                  <strong>{recordWeekNumbers[weekInfo.key]}주차</strong>
                                </td>
                              </tr>
                            )}
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
        {tab === 'payroll' && payrollMode === 'salary' && (
          <>
            <div className={styles.card}>
              <div className={styles.filterRow}>
                <select className={styles.filterInput} value={salaryYear} onChange={(e) => setSalaryYear(+e.target.value)}>
                  {[2024, 2025, 2026, 2027].map((y) => <option key={y} value={y}>{y}년</option>)}
                </select>
                <select className={styles.filterInput} value={salaryMonth} onChange={(e) => setSalaryMonth(+e.target.value)}>
                  {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => <option key={m} value={m}>{m}월</option>)}
                </select>
                <select className={styles.filterInput} value={salaryMember} onChange={(e) => changeSalaryMember(e.target.value)}>
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
                    {a.name} {Number(a.amount).toLocaleString()}원{a.fixed ? ' · 고정' : ''}
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
                <button
                  type="button"
                  className={styles.fixedAllowanceBtn}
                  onClick={saveFixedAllowances}
                  disabled={fixedAllowanceSaving}
                >{fixedAllowanceSaving ? '저장 중...' : '고정'}</button>
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

        {/* ── 급여 계산 탭 ── */}
        {tab === 'payroll' && (
          <>
            {payrollMode === 'daily' && (
              <>
            <div className={styles.card}>
              <div className={styles.dailyActionRow}>
                <button className={styles.addBtn} onClick={() => { setShowDailyWorkerForm(true); setDailyError(''); }}>
                  일일 알바 기록 추가
                </button>
                <button className={styles.copyUnpaidBtn} onClick={copyUnpaidDailyWorkers} disabled={dailyLoading}>
                  미입금 정보 복사
                </button>
              </div>
              {dailyCopyMessage && <div className={styles.dailyCopyMessage}>{dailyCopyMessage}</div>}
              {showDailyWorkerForm && (
                <div className={styles.dailyFormDetails}>
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
              <div className={styles.dailyAccountGrid}>
                <label className={`${styles.dailyField} ${styles.dailyBankField}`}>
                  <span>은행</span>
                  <select className={styles.filterInput} value={dailyBank} onChange={(e) => setDailyBank(e.target.value)}>
                    {DAILY_BANK_OPTIONS.map((bank) => <option key={bank} value={bank}>{bank}</option>)}
                  </select>
                </label>
                {dailyBank === '직접입력:' && (
                  <label className={styles.dailyField}>
                    <span>은행명 직접입력</span>
                    <input className={styles.filterInput} value={dailyCustomBank} onChange={(e) => setDailyCustomBank(e.target.value)} placeholder="은행명" />
                  </label>
                )}
                <label className={`${styles.dailyField} ${styles.dailyHolderField}`}>
                  <span>예금주</span>
                  <input className={styles.filterInput} value={dailyAccountHolder} onChange={(e) => setDailyAccountHolder(e.target.value)} placeholder="예금주" />
                </label>
                <label className={`${styles.dailyField} ${styles.dailyAccountNumberField}`}>
                  <span>계좌번호</span>
                  <input className={styles.filterInput} type="text" inputMode="numeric" value={dailyAccountNumber} onChange={(e) => setDailyAccountNumber(e.target.value)} placeholder="숫자만 입력" />
                </label>
                <label className={`${styles.dailyField} ${styles.dailyResidentField}`}>
                  <span>주민등록번호</span>
                  <input
                    className={styles.filterInput}
                    type="text"
                    inputMode="numeric"
                    autoComplete="off"
                    maxLength={14}
                    value={dailyResidentNumber}
                    onChange={(e) => {
                      const digits = e.target.value.replace(/\D/g, '').slice(0, 13);
                      setDailyResidentNumber(digits.length > 6 ? `${digits.slice(0, 6)}-${digits.slice(6)}` : digits);
                    }}
                    placeholder="000000-0000000"
                  />
                </label>
              </div>
              {dailyError && <div className={styles.errorMsg}>{dailyError}</div>}
              <div className={styles.dailyActionRow}>
                <button className={styles.addBtn} onClick={addDailyWorker} disabled={dailyLoading}>
                  {dailyLoading ? '저장 중...' : '등록 저장'}
                </button>
                <button className={styles.resetBtn} onClick={() => { setShowDailyWorkerForm(false); setDailyError(''); }} disabled={dailyLoading}>
                  닫기
                </button>
              </div>
                </div>
              )}
            </div>

            <div className={styles.card}>
              <div className={styles.dailyListHeader}>
                <strong>일일 알바 기록</strong>
                <span>{dailyWorkers.length}명</span>
              </div>
              <div className={styles.dailyFilterRow}>
                <label className={styles.dailyField}>
                  <span>날짜 설정</span>
                  <div className={styles.dailyDateControl}>
                    <input type="date" className={styles.filterInput} value={dailyFilterFrom} onChange={(e) => setDailyFilterFrom(e.target.value)} />
                    <span className={styles.dateRangeSeparator}>~</span>
                    <input type="date" className={styles.filterInput} value={dailyFilterTo} onChange={(e) => setDailyFilterTo(e.target.value)} />
                  </div>
                </label>
                <button className={`${styles.searchBtn} ${styles.dailySearchBtn}`} onClick={loadDailyWorkers}>조회</button>
              </div>
              {dailyLoading && dailyWorkers.length === 0 ? (
                <div className={styles.loadingMsg}>불러오는 중...</div>
              ) : dailyWorkers.length === 0 ? (
                <div className={styles.emptyMsg}>등록된 일일 알바 기록이 없습니다.</div>
              ) : (
                <div className={styles.dailyWorkerScroll}>
                  {dailyWorkers.map((entry) => {
                    const isExpanded = expandedDailyWorkerId === entry.id;
                    const residentDigits = (entry.residentRegistrationNumber || '').replace(/\D/g, '');
                    const formattedResidentNumber = residentDigits.length === 13
                      ? `${residentDigits.slice(0, 6)}-${residentDigits.slice(6)}`
                      : '미등록';
                    return (
                      <article key={entry.id} className={`${styles.dailyWorkerCard} ${entry.paymentCompleted ? styles.dailyWorkerCardPaid : ''}`}>
                        <label className={styles.transferSelectBox} title="선택한 항목만 복사">
                          <input
                            type="checkbox"
                            checked={selectedDailyTransferIds.has(entry.id)}
                            disabled={entry.paymentCompleted}
                            onChange={(e) => setSelectedDailyTransferIds((current) => {
                              const next = new Set(current);
                              if (e.target.checked) next.add(entry.id); else next.delete(entry.id);
                              return next;
                            })}
                          />
                        </label>
                        <button
                          type="button"
                          className={styles.dailyWorkerSummary}
                          onClick={() => {
                            setExpandedDailyWorkerId(isExpanded ? null : entry.id);
                            setEditingDailyAccount(null);
                            setEditingDailyResident(null);
                            setDailyError('');
                          }}
                          aria-expanded={isExpanded}
                        >
                          <span className={styles.dailyWorkerIdentity}>
                            <strong>{entry.name}</strong>
                            <small>{entry.date}</small>
                          </span>
                          <span className={styles.dailyWorkerTime}>
                            <strong>{entry.startTime} ~ {entry.endTime}</strong>
                            <small>{calcDuration({ timestamp: entry.checkInTimestamp }, { timestamp: entry.checkOutTimestamp })}</small>
                          </span>
                          <span className={styles.dailyWorkerAmount}>
                            <small>실지급액</small>
                            <strong>{getDailyWorkerAmount(entry).toLocaleString()}원</strong>
                          </span>
                          <span className={styles.dailyWorkerExpandHint}>{isExpanded ? '접기' : '상세보기'}</span>
                        </button>

                        {isExpanded ? (
                          <div className={styles.dailyWorkerDetail}>
                            <section className={styles.dailyDetailSection}>
                              <div className={styles.dailyDetailHeader}>
                                <strong>계좌정보</strong>
                                {editingDailyAccount?.id !== entry.id ? (
                                  <button type="button" className={styles.accountEditBtn} onClick={() => startDailyAccountEdit(entry)}>계좌수정</button>
                                ) : null}
                              </div>
                              {editingDailyAccount?.id === entry.id ? (
                                <>
                                  <div className={styles.dailyAccountEditor}>
                                    <select className={styles.filterInput} value={editingDailyAccount.bank} onChange={(e) => setEditingDailyAccount((current) => ({ ...current, bank: e.target.value }))}>
                                      {DAILY_BANK_OPTIONS.map((bank) => <option key={bank} value={bank}>{bank}</option>)}
                                    </select>
                                    {editingDailyAccount.bank === '직접입력:' ? (
                                      <input className={styles.filterInput} value={editingDailyAccount.customBank} onChange={(e) => setEditingDailyAccount((current) => ({ ...current, customBank: e.target.value }))} placeholder="은행명" />
                                    ) : null}
                                    <input className={styles.filterInput} value={editingDailyAccount.accountHolder} onChange={(e) => setEditingDailyAccount((current) => ({ ...current, accountHolder: e.target.value }))} placeholder="예금주" />
                                    <input className={styles.filterInput} inputMode="numeric" value={editingDailyAccount.accountNumber} onChange={(e) => setEditingDailyAccount((current) => ({ ...current, accountNumber: e.target.value }))} placeholder="계좌번호" />
                                  </div>
                                  <div className={styles.dailyDetailEditActions}>
                                    <button type="button" className={styles.accountEditBtn} onClick={saveDailyAccount}>저장</button>
                                    <button type="button" className={styles.resetBtn} onClick={() => setEditingDailyAccount(null)}>취소</button>
                                  </div>
                                </>
                              ) : (
                                <div className={styles.dailyWorkerAccount}>
                                  {entry.bankName ? (
                                    <><strong>{entry.bankName}</strong><span>예금주 {entry.accountHolder}</span><span>{entry.accountNumber}</span></>
                                  ) : <span className={styles.accountMissing}>계좌정보 미등록</span>}
                                </div>
                              )}
                            </section>

                            <section className={styles.dailyDetailSection}>
                              <div className={styles.dailyDetailHeader}>
                                <strong>주민등록번호</strong>
                                {editingDailyResident?.id !== entry.id ? (
                                  <button type="button" className={styles.accountEditBtn} onClick={() => startDailyResidentEdit(entry)}>주민등록번호 수정</button>
                                ) : null}
                              </div>
                              {editingDailyResident?.id === entry.id ? (
                                <>
                                  <input
                                    className={styles.filterInput}
                                    inputMode="numeric"
                                    autoComplete="off"
                                    maxLength={14}
                                    value={editingDailyResident.value}
                                    onChange={(e) => {
                                      const digits = e.target.value.replace(/\D/g, '').slice(0, 13);
                                      setEditingDailyResident((current) => ({
                                        ...current,
                                        value: digits.length > 6 ? `${digits.slice(0, 6)}-${digits.slice(6)}` : digits,
                                      }));
                                    }}
                                    placeholder="000000-0000000"
                                  />
                                  <div className={styles.dailyDetailEditActions}>
                                    <button type="button" className={styles.accountEditBtn} onClick={saveDailyResident}>저장</button>
                                    <button type="button" className={styles.resetBtn} onClick={() => setEditingDailyResident(null)}>취소</button>
                                  </div>
                                </>
                              ) : (
                                <span className={residentDigits.length === 13 ? styles.dailyResidentValue : styles.accountMissing}>
                                  {formattedResidentNumber}
                                </span>
                              )}
                            </section>

                            <div className={styles.dailyWorkerActions}>
                              <button className={`${styles.paymentBtn} ${entry.paymentCompleted ? styles.paymentBtnActive : ''}`} onClick={() => toggleDailyPayment(entry)}>
                                {entry.paymentCompleted ? '입금완료 해제' : '입금완료'}
                              </button>
                              <button className={styles.delBtn} onClick={() => deleteDailyWorker(entry)}>삭제</button>
                            </div>
                          </div>
                        ) : null}
                      </article>
                    );
                  })}
                </div>
              )}
            </div>
              </>
            )}

            {payrollMode === 'fixed' && (
              <>
                <div className={styles.card}>
                  <div className={styles.fixedPayrollFilters}>
                    <label className={styles.dailyField}>
                      <span>급여 연도</span>
                      <select className={styles.filterInput} value={fixedPayrollYear} onChange={(e) => setFixedPayrollYear(Number(e.target.value))}>
                        {[2024, 2025, 2026, 2027].map((year) => <option key={year} value={year}>{year}년</option>)}
                      </select>
                    </label>
                    <label className={styles.dailyField}>
                      <span>급여 월</span>
                      <select className={styles.filterInput} value={fixedPayrollMonth} onChange={(e) => setFixedPayrollMonth(Number(e.target.value))}>
                        {Array.from({ length: 12 }, (_, index) => index + 1).map((month) => <option key={month} value={month}>{month}월</option>)}
                      </select>
                    </label>
                    <label className={styles.dailyField}>
                      <span>직원 구분</span>
                      <select
                        className={styles.filterInput}
                        value={fixedPayrollArea}
                        onChange={(e) => {
                          setFixedPayrollArea(e.target.value);
                          setSelectedFixedTransferIds(new Set());
                        }}
                      >
                        <option value="all">전체</option>
                        <option value="back">백</option>
                        <option value="front">프론트</option>
                      </select>
                    </label>
                    <button className={`${styles.searchBtn} ${styles.dailySearchBtn}`} onClick={loadFixedPayroll} disabled={fixedPayrollLoading}>
                      {fixedPayrollLoading ? '계산 중...' : '급여 조회'}
                    </button>
                    <button className={styles.copyUnpaidBtn} onClick={copyUnpaidFixedWorkers} disabled={fixedPayrollLoading || displayedFixedPayrollRows.length === 0}>
                      미입금 정보 복사
                    </button>
                    <button className={styles.copyUnpaidBtn} onClick={exportFixedPayrollExcel} disabled={fixedPayrollLoading || displayedFixedPayrollRows.length === 0}>
                      엑셀 다운로드
                    </button>
                  </div>
                  {fixedPayrollError && <div className={styles.errorMsg}>{fixedPayrollError}</div>}
                  {fixedCopyMessage && <div className={styles.dailyCopyMessage}>{fixedCopyMessage}</div>}
                </div>
                <div className={styles.card}>
                  <div className={styles.dailyListHeader}>
                    <strong>고정 알바 급여 기록</strong>
                    <span>{fixedPayrollYear}년 {fixedPayrollMonth}월 · {displayedFixedPayrollRows.length}명</span>
                  </div>
                  {displayedFixedPayrollRows.length === 0 ? (
                    <div className={styles.emptyMsg}>
                      {fixedPayrollRows.length === 0
                        ? '급여 조회를 눌러 월별 급여를 계산하세요.'
                        : '선택한 구분에 등록된 직원이 없습니다.'}
                    </div>
                  ) : (
                    <div className={styles.dailyWorkerScroll}>
                      {displayedFixedPayrollRows.map((row) => (
                        <article key={row.id} className={`${styles.fixedWorkerCard} ${row.paymentCompleted ? styles.dailyWorkerCardPaid : ''}`}>
                          <label className={styles.transferSelectBox} title="선택한 항목만 복사">
                            <input
                              type="checkbox"
                              checked={selectedFixedTransferIds.has(row.id)}
                              disabled={row.paymentCompleted || row.salary.netPay <= 0}
                              onChange={(e) => setSelectedFixedTransferIds((current) => {
                                const next = new Set(current);
                                if (e.target.checked) next.add(row.id); else next.delete(row.id);
                                return next;
                              })}
                            />
                          </label>
                          <div><strong>{row.name}</strong><span>{fixedPayrollYear}년 {fixedPayrollMonth}월</span></div>
                          <div className={styles.dailyWorkerTime}>
                            <span>{row.salary.monthlyHours.toFixed(1)}H</span>
                            <small>실지급액 {row.salary.netPay.toLocaleString()}원</small>
                          </div>
                          <div className={styles.dailyWorkerAccount}>
                            {row.bankName ? (
                              <><strong>{row.bankName}</strong><span>예금주 {row.accountHolder}</span><span>{row.accountNumber}</span></>
                            ) : <span className={styles.accountMissing}>계좌정보 미등록</span>}
                          </div>
                          <div className={styles.dailyWorkerActions}>
                            <button className={`${styles.paymentBtn} ${row.paymentCompleted ? styles.paymentBtnActive : ''}`} onClick={() => toggleFixedPayment(row)}>
                              {row.paymentCompleted ? '입금완료 해제' : '입금완료'}
                            </button>
                          </div>
                        </article>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}
          </>
        )}
      </div>

      {/* 출퇴근 기록 신규 등록 모달 */}
      {showRecordCreate && (
        <div className={styles.modalOverlay} onClick={() => !recordCreateSaving && setShowRecordCreate(false)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h3 className={styles.modalTitle}>출퇴근 기록 등록</h3>
            <div className={styles.editFields}>
              <label className={styles.editLabel}>
                직원
                <select className={styles.editInput} value={recordCreateMember} onChange={(e) => setRecordCreateMember(e.target.value)}>
                  <option value="">직원 선택</option>
                  {members.map((member) => <option key={member.id} value={member.name}>{member.name}</option>)}
                </select>
              </label>
              <label className={styles.editLabel}>
                날짜
                <input type="date" className={styles.editInput} value={recordCreateDate} onChange={(e) => setRecordCreateDate(e.target.value)} />
              </label>
              <label className={styles.editLabel}>
                출근시간
                <input type="time" className={styles.editInput} value={recordCreateStart} onChange={(e) => setRecordCreateStart(e.target.value)} />
              </label>
              <label className={styles.editLabel}>
                퇴근시간
                <input type="time" className={styles.editInput} value={recordCreateEnd} onChange={(e) => setRecordCreateEnd(e.target.value)} />
              </label>
            </div>
            {recordCreateError && <div className={styles.pinError}>{recordCreateError}</div>}
            <div className={styles.modalBtns}>
              <button className={styles.pinSubmit} onClick={createRecordPair} disabled={recordCreateSaving}>
                {recordCreateSaving ? '등록 중...' : '등록'}
              </button>
              <button className={styles.backLink} onClick={() => setShowRecordCreate(false)} disabled={recordCreateSaving}>취소</button>
            </div>
          </div>
        </div>
      )}

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
            <h3 className={styles.modalTitle}>직원 정보 수정</h3>
            <div className={styles.editFields}>
              <label className={styles.editLabel}>
                이름
                <input
                  className={styles.editInput}
                  value={memberEditName}
                  onChange={(e) => setMemberEditName(e.target.value)}
                  autoFocus
                />
              </label>
              <label className={styles.editLabel}>
                <span className={styles.memberRateLabelRow}>
                  <span>개별 시급</span>
                  <button type="button" className={styles.memberRateHistoryBtn} onClick={() => setShowMemberRateHistory((value) => !value)}>이력</button>
                </span>
                <input
                  type="number"
                  min="1"
                  step="1"
                  className={styles.editInput}
                  value={memberEditHourlyRate}
                  onChange={(e) => setMemberEditHourlyRate(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && updateMember()}
                  placeholder="미입력 시 공통 시급 적용"
                />
              </label>
              {showMemberRateHistory && (
                <div className={styles.memberRateHistory}>
                  {(editingMember.hourlyRateHistory || []).length === 0 ? (
                    <span>변경 이력이 없습니다.</span>
                  ) : [...editingMember.hourlyRateHistory].reverse().map((history) => (
                    <div key={history.id}>
                      <span>{history.effectiveDate}</span>
                      <strong>{history.hourlyRate ? `${history.hourlyRate.toLocaleString()}원` : '공통 시급 적용'}</strong>
                    </div>
                  ))}
                </div>
              )}
            </div>
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

      {/* 직원 계좌 등록 모달 */}
      {editingMemberAccount && (
        <div className={styles.modalOverlay} onClick={() => setEditingMemberAccount(null)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h3 className={styles.modalTitle}>
              {editingMemberAccount.name} {editingMemberAccount.hasAccount ? '계좌조회 및 수정' : '계좌등록'}
            </h3>
            <div className={styles.memberAccountFields}>
              <label className={styles.editLabel}>
                은행
                <select className={styles.editInput} value={editingMemberAccount.bank} onChange={(e) => setEditingMemberAccount((current) => ({ ...current, bank: e.target.value }))}>
                  {DAILY_BANK_OPTIONS.map((bank) => <option key={bank} value={bank}>{bank}</option>)}
                </select>
              </label>
              {editingMemberAccount.bank === '직접입력:' && (
                <label className={styles.editLabel}>
                  은행명 직접입력
                  <input className={styles.editInput} value={editingMemberAccount.customBank} onChange={(e) => setEditingMemberAccount((current) => ({ ...current, customBank: e.target.value }))} />
                </label>
              )}
              <label className={styles.editLabel}>
                예금주
                <input className={styles.editInput} value={editingMemberAccount.accountHolder} onChange={(e) => setEditingMemberAccount((current) => ({ ...current, accountHolder: e.target.value }))} />
              </label>
              <label className={styles.editLabel}>
                계좌번호
                <input className={styles.editInput} inputMode="numeric" value={editingMemberAccount.accountNumber} onChange={(e) => setEditingMemberAccount((current) => ({ ...current, accountNumber: e.target.value }))} />
              </label>
            </div>
            {memberAccountError && <div className={styles.pinError}>{memberAccountError}</div>}
            <div className={styles.modalBtns}>
              <button className={styles.pinSubmit} onClick={saveMemberAccount}>저장</button>
              <button className={styles.backLink} onClick={() => setEditingMemberAccount(null)}>취소</button>
            </div>
          </div>
        </div>
      )}

      {/* 미입금 이체정보 복사 확인 */}
      {pendingTransferCopy && (
        <div className={styles.modalOverlay} onClick={() => !transferConfirmBusy && setPendingTransferCopy(null)}>
          <div className={`${styles.modal} ${styles.transferConfirmModal}`} onClick={(e) => e.stopPropagation()}>
            <div className={styles.transferConfirmHeader}>
              <div>
                <span className={styles.transferConfirmEyebrow}>이체 전 최종 확인</span>
                <h3 className={styles.modalTitle}>{pendingTransferCopy.title}</h3>
              </div>
              <span className={styles.transferCountBadge}>{pendingTransferCopy.rows.length}명</span>
            </div>
            <p className={styles.transferConfirmNotice}>
              확인을 누르면 Excel용 정보가 복사되고 아래 인원이 자동으로 입금완료 처리됩니다.
            </p>
            <div className={styles.transferPreviewList}>
              {pendingTransferCopy.rows.map((row) => (
                <div key={row.id} className={styles.transferPreviewRow}>
                  <span>{row.name}</span>
                  <strong>{row.amount.toLocaleString()}원</strong>
                </div>
              ))}
            </div>
            <div className={styles.transferTotalRow}>
              <span>총 이체금액</span>
              <strong>{pendingTransferCopy.rows.reduce((sum, row) => sum + row.amount, 0).toLocaleString()}원</strong>
            </div>
            {transferConfirmError && <div className={styles.pinError}>{transferConfirmError}</div>}
            <div className={styles.transferConfirmActions}>
              <button className={styles.transferCancelBtn} onClick={() => setPendingTransferCopy(null)} disabled={transferConfirmBusy}>취소</button>
              <button className={styles.transferConfirmBtn} onClick={confirmTransferCopy} disabled={transferConfirmBusy}>
                {transferConfirmBusy ? '처리 중...' : '확인 후 복사'}
              </button>
            </div>
          </div>
        </div>
      )}

      {editingPaymentRequest && (
        <div className={styles.modalOverlay} onClick={() => !requestEditSaving && setEditingPaymentRequest(null)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h3 className={styles.modalTitle}>개인요청 수정</h3>
            <div className={styles.editFields}>
              {[
                ['date', '날짜', 'date'], ['bankName', '은행', 'text'], ['accountHolder', '예금주', 'text'],
                ['accountNumber', '계좌번호', 'text'], ['amount', '이체금액', 'number'], ['content', '내용', 'text'],
                ['residentRegistrationNumber', '주민등록번호 (필요시)', 'text'],
              ].map(([key, label, type]) => (
                <label key={key} className={styles.editLabel}>{label}<input type={type} className={styles.editInput} value={editingPaymentRequest[key] ?? ''} onChange={(e) => setEditingPaymentRequest((current) => ({ ...current, [key]: e.target.value }))} /></label>
              ))}
            </div>
            {requestEditError && <div className={styles.pinError}>{requestEditError}</div>}
            <div className={styles.modalBtns}><button className={styles.pinSubmit} onClick={savePaymentRequestEdit} disabled={requestEditSaving}>{requestEditSaving ? '저장 중...' : '저장'}</button><button className={styles.backLink} onClick={() => setEditingPaymentRequest(null)}>취소</button></div>
          </div>
        </div>
      )}

      {editingStudioPayment && (
        <div className={styles.modalOverlay} onClick={() => !requestEditSaving && setEditingStudioPayment(null)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h3 className={styles.modalTitle}>스튜디오 입금 수정</h3>
            <div className={styles.editFields}>
              {[
                ['studioName', '스튜디오 이름', 'text'], ['usageTime', '시간', 'text'], ['amount', '입금액', 'number'], ['vatAmount', '부가세 (필요시)', 'number'],
                ['bankName', '은행', 'text'], ['accountNumber', '계좌', 'text'], ['accountHolder', '예금주', 'text'],
                ['modelName', '모델명', 'text'], ['modelPayment', '모델지급액', 'number'], ['shootDate', '촬영예정일', 'date'],
              ].map(([key, label, type]) => (
                <label key={key} className={styles.editLabel}>{label}<input type={type} className={styles.editInput} value={editingStudioPayment[key] ?? ''} onChange={(e) => setEditingStudioPayment((current) => ({ ...current, [key]: e.target.value }))} /></label>
              ))}
            </div>
            {requestEditError && <div className={styles.pinError}>{requestEditError}</div>}
            <div className={styles.modalBtns}><button className={styles.pinSubmit} onClick={saveStudioPaymentEdit} disabled={requestEditSaving}>{requestEditSaving ? '저장 중...' : '저장'}</button><button className={styles.backLink} onClick={() => setEditingStudioPayment(null)}>취소</button></div>
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
