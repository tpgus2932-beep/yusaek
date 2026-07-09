import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, Database, Download, GitMerge, RefreshCw, Save, Search, Sparkles, FileUp, Trash2, X } from 'lucide-react';
import * as XLSX from 'xlsx';
import { COLLAB_API_BASE as API, LOCAL_API_BASE, getAuthHeaders, handleUnauthorized } from '../../lib/api';
import { useEzadminSession } from '../../lib/EzadminSessionContext';
import styles from './ClientSchedulePage.module.css';

const DEFAULT_PREFIX = '\uc548\ub155\ud558\uc138\uc694';
const DEFAULT_SUFFIX = '일정 알 수 있을까요?';
const DEFAULT_TEXT_MSG = '\uc624\ub298 \uc8fc\ubb38 \uac00\ub2a5\ud558\uc2e4\uae4c\uc694? \uac00\ub2a5\ud558\uc2dc\uba74 \uc77c\uc815 \ubd80\ud0c1\ub4dc\ub9bd\ub2c8\ub2e4.';
const HEADER_SHEET1 = ['\uac70\ub798\ucc98', '\ubb38\uc790'];
const NUMERIC_SORT_COLUMNS = new Set(['G', 'H']);

function formatInputDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function toDisplayText(value) {
  if (value == null) return '';
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return formatInputDate(value);
  }
  return String(value).trim();
}

function toNumber(value) {
  const parsed = Number(String(value ?? '').replace(/,/g, '').trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function excelSerialToDate(value) {
  if (typeof value !== 'number' || value <= 0) return null;
  const parsed = XLSX.SSF.parse_date_code(value);
  if (!parsed) return null;
  return new Date(parsed.y, parsed.m - 1, parsed.d);
}

function coerceDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === 'number') return excelSerialToDate(value);

  const text = String(value ?? '').trim();
  if (!text) return null;

  const normalized = text.replace(/[./]/g, '-');
  const parts = normalized.split('-').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 3) {
    const [year, month, day] = parts.map(Number);
    const date = new Date(year, month - 1, day);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const direct = new Date(text);
  return Number.isNaN(direct.getTime()) ? null : direct;
}

function uniquePreserve(values) {
  const seen = new Set();
  const next = [];
  values.forEach((value) => {
    const text = String(value ?? '').trim();
    if (!text || seen.has(text)) return;
    seen.add(text);
    next.push(text);
  });
  return next;
}

function makeRowId(row, index) {
  return `${row.A}::${row.B}::${row.C}::${row.F}::${index}`;
}

function ensureWidth(rows, width) {
  return rows.map((row) => {
    const next = Array.isArray(row) ? [...row] : [];
    while (next.length <= width) next.push('');
    return next;
  });
}

function withIds(rows) {
  return rows.map((row, index) => ({ ...row, id: row.id || makeRowId(row, index) }));
}

function preprocessBaseSheet(rawRows) {
  // 헤더(첫 행) 제거 후, 상품코드(row[5])가 없는 행(합계·소계·빈 행 등) 모두 제거
  const allRows = ensureWidth(Array.isArray(rawRows) ? rawRows.slice(1) : [], 11);
  const rows = allRows.filter((row) => String(row[5] ?? '').trim() !== '');
  const sheet2 = [];
  let currentA = '';

  rows.forEach((row) => {
    const rawA = toDisplayText(row[0]);
    if (rawA) currentA = rawA;

    const bText = toDisplayText(row[1]);
    const [b = '', c = ''] = bText.split(/\s+/, 2);
    sheet2.push({
      A: currentA,
      B: b,
      C: c,
      D: '',
      E: '',
      F: toDisplayText(row[5]),
      G: toDisplayText(row[6]),
      H: toDisplayText(row[11]),
      I: '',
      srcI: toDisplayText(row[8]),
    });
  });

  sheet2.sort((left, right) => left.B.localeCompare(right.B, 'ko'));
  return withIds(sheet2);
}

function parseScheduleSheet2Rows(rawRows) {
  const rows = ensureWidth(Array.isArray(rawRows) ? rawRows : [], 8);
  const parsed = rows
    .map((row) => ({
      A: toDisplayText(row[0]),
      B: toDisplayText(row[1]),
      C: toDisplayText(row[2]),
      D: toDisplayText(row[3]),
      E: toDisplayText(row[4]),
      F: toDisplayText(row[5]),
      G: toDisplayText(row[6]),
      H: toDisplayText(row[7]),
      I: toDisplayText(row[8]),
    }))
    .filter((row) => Object.values(row).some(Boolean));

  parsed.sort((left, right) => left.B.localeCompare(right.B, 'ko'));
  return withIds(parsed);
}

function normalizeDValueForMerge(value, baseDate) {
  const dateValue = coerceDate(value);
  if (dateValue) {
    return dateValue < baseDate ? '' : formatInputDate(dateValue);
  }

  const text = toDisplayText(value).replace(/\s+/g, '');
  if (!text) return '';

  const monday = new Date(baseDate);
  monday.setDate(baseDate.getDate() - ((baseDate.getDay() + 6) % 7));

  const thisFriday      = new Date(monday); thisFriday.setDate(monday.getDate() + 4);
  const nextMonday      = new Date(monday); nextMonday.setDate(monday.getDate() + 7);
  const nextFriday      = new Date(monday); nextFriday.setDate(monday.getDate() + 11);
  const nextNextMonday  = new Date(monday); nextNextMonday.setDate(monday.getDate() + 14);
  const nextNextFriday  = new Date(monday); nextNextFriday.setDate(monday.getDate() + 18);

  if (text === '\uc774\ubc88\uc8fc\uc911') {
    return baseDate > thisFriday ? '' : text;
  }
  if (text === '\ub2e4\uc74c\uc8fc\uc911') {
    if (baseDate >= nextMonday) return baseDate > nextFriday ? '' : '\uc774\ubc88\uc8fc\uc911';
    return text;
  }
  if (text === '\ub2e4\ub2e4\uc74c\uc8fc\uc911') {
    if (baseDate >= nextNextMonday) return baseDate > nextNextFriday ? '' : '\uc774\ubc88\uc8fc\uc911';
    if (baseDate >= nextMonday) return '\ub2e4\uc74c\uc8fc\uc911';
    return text;
  }
  return text;
}

function mergeScheduleRows(baseRows, mergeRows, baseDate) {
  // 거래처(B) + 상품코드(F)로 매칭. 상세(C)는 원본 텍스트를 2단어로 절삭해 만든
  // 값이라 기준파일을 다시 가공할 때 살짝 달라질 수 있어 매칭 키에서 제외한다.
  const mergeMap = new Map();
  mergeRows.forEach((row) => {
    const key = [row.B, row.F].map(toDisplayText).join('||');
    mergeMap.set(key, {
      D: normalizeDValueForMerge(row.D, baseDate),
      E: toDisplayText(row.E),
      I: toDisplayText(row.I),
    });
  });

  return withIds(
    baseRows.map((row) => {
      const key = [row.B, row.F].map(toDisplayText).join('||');
      const merged = mergeMap.get(key);
      if (!merged) return row;
      return {
        ...row,
        D: merged.D,
        E: merged.E,
        I: merged.I,
      };
    })
  );
}

function readIncomingKeys(rawRows) {
  const keys = new Set();
  (Array.isArray(rawRows) ? rawRows : []).forEach((row) => {
    const val = toDisplayText(Array.isArray(row) ? row[0] : row);
    if (val) keys.add(val);
  });
  return keys;
}

function buildItemText(row) {
  const base = [toDisplayText(row.C), toDisplayText(row.F)].filter(Boolean).join(' ').trim();
  if (!base) return '';

  const g = toNumber(row.G);
  const h = toNumber(row.H);
  if (g > 0) return `${base} ${g}\uac1c`;
  if (g === 0 && h >= 1) return `${base} \ubbf8\uc1a1\ud53d\uc5c5\uac74`;
  return '';
}

function parseExcludedClients(text) {
  return String(text || '')
    .split(/\r?\n|,/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function matchesExcludedClient(clientName, excludedClients) {
  const name = toDisplayText(clientName);
  if (!name || excludedClients.length === 0) {
    return false;
  }
  return excludedClients.some((keyword) => name.includes(keyword));
}

function buildSheet1AndSheet2(rows, prefix, suffix, excludedClients = []) {
  const rolled = rows.map((row) => {
    if (!toDisplayText(row.D) && toDisplayText(row.E)) {
      return { ...row, D: toDisplayText(row.E), E: '' };
    }
    return { ...row };
  });

  const grouped = new Map();
  const excludedMatchedClients = new Set();
  rolled
    .filter((row) => {
      if (toDisplayText(row.D) || !toDisplayText(row.B)) {
        return false;
      }
      const isExcluded = matchesExcludedClient(row.B, excludedClients);
      if (isExcluded) {
        excludedMatchedClients.add(toDisplayText(row.B));
      }
      return !isExcluded;
    })
    .forEach((row) => {
      const key = toDisplayText(row.B);
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(buildItemText(row));
    });

  const sheet1Rows = [HEADER_SHEET1];
  Array.from(grouped.entries()).forEach(([client, itemList]) => {
    const items = uniquePreserve(itemList);
    if (items.length === 0) return;
    const message = [prefix.trim() || DEFAULT_PREFIX, ...items, suffix.trim() || DEFAULT_SUFFIX].join('\n');
    sheet1Rows.push([client, message]);
  });

  const sheet2Rows = withIds(
    rolled.map((row) => ({
      ...row,
      I: toDisplayText(row.I),
    }))
  );

  return { sheet1Rows, sheet2Rows, excludedMatchedClients: Array.from(excludedMatchedClients) };
}

function rowsToSheet2AoA(rows) {
  return rows.map((row) => [row.A, row.B, row.C, row.D, row.E, row.F, row.G, row.H, row.I]);
}

function expandDateShorthand(value, referenceDate = new Date()) {
  const text = (value || '').trim();
  const baseDate = coerceDate(referenceDate) || new Date();
  const compact = text.replace(/\s+/g, '').replace(/요일/g, '');

  if (compact === '오늘') {
    return formatInputDate(baseDate);
  }
  if (compact === '내일') {
    const next = new Date(baseDate);
    next.setDate(baseDate.getDate() + 1);
    return formatInputDate(next);
  }
  if (compact === '모레') {
    const next = new Date(baseDate);
    next.setDate(baseDate.getDate() + 2);
    return formatInputDate(next);
  }

  const weekdayMatch = compact.match(/^(이번주|다음주|다다음주)(월|화|수|목|금|토|일)$/);
  if (weekdayMatch) {
    const [, weekLabel, weekdayLabel] = weekdayMatch;
    const weekdayIndexMap = { 월: 0, 화: 1, 수: 2, 목: 3, 금: 4, 토: 5, 일: 6 };
    const currentWeekMonday = new Date(baseDate);
    currentWeekMonday.setDate(baseDate.getDate() - ((baseDate.getDay() + 6) % 7));

    const weekOffsetMap = { 이번주: 0, 다음주: 7, 다다음주: 14 };
    const result = new Date(currentWeekMonday);
    result.setDate(currentWeekMonday.getDate() + weekOffsetMap[weekLabel] + weekdayIndexMap[weekdayLabel]);
    return formatInputDate(result);
  }

  if (/^\d{3,4}$/.test(compact)) {
    const year = baseDate.getFullYear();
    const padded = compact.padStart(4, '0');
    const month = padded.slice(0, 2);
    const day = padded.slice(2, 4);
    const d = new Date(year, Number(month) - 1, Number(day));
    if (!Number.isNaN(d.getTime())) return `${year}-${month}-${day}`;
  }
  return text;
}

async function readWorkbook(file, preferredSheetName) {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: 'array', cellDates: true });
  const sheetName = preferredSheetName && workbook.Sheets[preferredSheetName]
    ? preferredSheetName
    : workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  return {
    sheetName,
    rows: XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true }),
  };
}

export default function ClientSchedulePage() {
  const { openModal: openEzadminModal } = useEzadminSession();
  const [baseFile, setBaseFile] = useState(null);
  const [incomingFile, setIncomingFile] = useState(null);
  const [incomingEzLoading, setIncomingEzLoading] = useState(false);
  const [baseEzLoading, setBaseEzLoading] = useState(false);
  const [baseEzStart, setBaseEzStart] = useState(() => formatInputDate(new Date(Date.now() - 90 * 86400000)));
  const [baseEzEnd, setBaseEzEnd] = useState(() => formatInputDate());
  const [baseDateText, setBaseDateText] = useState(formatInputDate());
  const [msgPrefix, setMsgPrefix] = useState(DEFAULT_PREFIX);
  const [msgSuffix, setMsgSuffix] = useState(DEFAULT_SUFFIX);
  const [excludedClients, setExcludedClients] = useState([]);
  const [excludedClientInput, setExcludedClientInput] = useState('');
  const [sheet1Rows, setSheet1Rows] = useState([HEADER_SHEET1]);
  const [sheet2Rows, setSheet2Rows] = useState([]);
  const [status, setStatus] = useState('DB에서 일정을 불러오는 중...');
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [dbRows, setDbRows] = useState([]);
  const [dbSavedAt, setDbSavedAt] = useState(null);
  const [dbLoading, setDbLoading] = useState(false);
  const [dirtyRowIds, setDirtyRowIds] = useState(() => new Set());
  const [showAllExcluded, setShowAllExcluded] = useState(false);
  const authHeaders = getAuthHeaders();
  const excludedClientInputRef = useRef(null);
  const saveTimerRef = useRef(null);

  const autoSaveToDb = (rowsToSave) => {
    if (!rowsToSave.length) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      try {
        const payload = rowsToSave.map(({ A, B, C, D, E, F, G, H, I }) => ({ A, B, C, D, E, F, G, H, I }));
        const res = await fetch(`${API}/client-schedule/db`, {
          method: 'PUT',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ rows: payload }),
        });
        if (handleUnauthorized(res)) return;
        const data = await res.json();
        if (!res.ok) throw new Error(data?.detail || 'DB 자동 저장 실패');
        setDbRows(withIds(rowsToSave));
        setDbSavedAt(data.saved_at);
        setDirtyRowIds(new Set());
        setStatus(`자동 저장 완료: ${data.count}행`);
      } catch (err) {
        setStatus(err.message || 'DB 자동 저장 실패');
      }
    }, 500);
  };

  const VISIBLE_TAG_COUNT = 2;
  const hiddenTagCount = Math.max(0, excludedClients.length - VISIBLE_TAG_COUNT);
  const visibleClients = showAllExcluded || excludedClients.length <= VISIBLE_TAG_COUNT
    ? excludedClients
    : excludedClients.slice(-VISIBLE_TAG_COUNT);

  const filteredRows = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return sheet2Rows;
    return sheet2Rows.filter((row) =>
      [row.A, row.B, row.C, row.D, row.E, row.F, row.G, row.H, row.I].join(' ').toLowerCase().includes(keyword)
    );
  }, [query, sheet2Rows]);

  const [sortColumn, setSortColumn] = useState(null);
  const [sortDirection, setSortDirection] = useState('asc');

  const handleSort = (column) => {
    if (sortColumn === column) {
      setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortColumn(column);
      setSortDirection('asc');
    }
  };

  const sortedRows = useMemo(() => {
    if (!sortColumn) return filteredRows;
    const sign = sortDirection === 'asc' ? 1 : -1;
    return [...filteredRows].sort((a, b) => {
      if (NUMERIC_SORT_COLUMNS.has(sortColumn)) {
        return (toNumber(a[sortColumn]) - toNumber(b[sortColumn])) * sign;
      }
      return toDisplayText(a[sortColumn]).localeCompare(toDisplayText(b[sortColumn]), 'ko') * sign;
    });
  }, [filteredRows, sortColumn, sortDirection]);

  const baseDate = useMemo(() => coerceDate(baseDateText) || new Date(), [baseDateText]);

  const saveExcludedClientsToDb = async (items) => {
    try {
      await fetch(`${API}/client-schedule/excluded`, {
        method: 'PUT',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
      });
    } catch {
      // 저장 실패 시 조용히 무시 (UI 동작에는 영향 없음)
    }
  };

  const addExcludedClients = (raw) => {
    const newItems = parseExcludedClients(raw);
    if (!newItems.length) return;
    setExcludedClients((prev) => {
      const next = [...new Set([...prev, ...newItems])];
      saveExcludedClientsToDb(next);
      return next;
    });
    setExcludedClientInput('');
  };

  const removeExcludedClient = (value) => {
    setExcludedClients((prev) => {
      const next = prev.filter((item) => item !== value);
      saveExcludedClientsToDb(next);
      return next;
    });
  };

  const handleExcludedClientKeyDown = (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addExcludedClients(excludedClientInput);
    } else if (e.key === 'Backspace' && !excludedClientInput && excludedClients.length > 0) {
      setExcludedClients((prev) => {
        const next = prev.slice(0, -1);
        saveExcludedClientsToDb(next);
        return next;
      });
    }
  };

  const fetchExcludedClients = async () => {
    try {
      const res = await fetch(`${API}/client-schedule/excluded`, { headers: authHeaders });
      if (!res.ok) return;
      const data = await res.json();
      let items = data.items || [];

      // localStorage에 기존 데이터가 있고 DB가 비어있으면 마이그레이션
      if (items.length === 0) {
        try {
          const raw = localStorage.getItem('client-schedule-excluded-clients');
          const legacy = raw ? JSON.parse(raw) : [];
          if (legacy.length > 0) {
            await fetch(`${API}/client-schedule/excluded`, {
              method: 'PUT',
              headers: { ...authHeaders, 'Content-Type': 'application/json' },
              body: JSON.stringify({ items: legacy }),
            });
            items = legacy;
          }
        } catch {
          // 마이그레이션 실패 시 무시
        }
      }
      localStorage.removeItem('client-schedule-excluded-clients');
      setExcludedClients(items);
    } catch {
      // 로드 실패 시 빈 배열 유지
    }
  };

  const fetchDbRows = async () => {
    setDbLoading(true);
    try {
      const res = await fetch(`${API}/client-schedule/db`, { headers: authHeaders });
      if (handleUnauthorized(res)) return;
      const data = await res.json();
      if (!res.ok) throw new Error(data?.detail || 'DB 로드 실패');
      const loaded = withIds(data.rows || []);
      setDbRows(loaded);
      setDbSavedAt(data.saved_at || null);
      if (loaded.length > 0) {
        const { sheet2Rows: s2 } = buildSheet1AndSheet2(loaded, DEFAULT_PREFIX, DEFAULT_SUFFIX, excludedClients);
        setSheet2Rows(s2);
      }
      setStatus(data.count > 0
        ? `DB 일정 ${data.count}행 불러옴 · 기준 파일을 올리면 자동 병합됩니다.`
        : 'DB가 비어있습니다. 기준 파일을 가공한 뒤 DB에 저장하세요.');
    } catch (err) {
      setStatus(err.message || 'DB 로드 실패');
    } finally {
      setDbLoading(false);
    }
  };

  useEffect(() => { fetchDbRows(); fetchExcludedClients(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSaveToDb = async () => {
    if (!sheet2Rows.length) { setStatus('저장할 데이터가 없습니다.'); return; }
    setDbLoading(true);
    try {
      const payload = sheet2Rows.map((r) => ({
        A: r.A, B: r.B, C: r.C, D: r.D, E: r.E, F: r.F, G: r.G, H: r.H, I: r.I,
      }));
      const res = await fetch(`${API}/client-schedule/db`, {
        method: 'PUT',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: payload }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json();
      if (!res.ok) throw new Error(data?.detail || 'DB 저장 실패');
      setDbRows(withIds(payload));
      setDbSavedAt(data.saved_at);
      setDirtyRowIds(new Set());
      setStatus(`DB 저장 완료: ${data.count}행`);
    } catch (err) {
      setStatus(err.message || 'DB 저장 실패');
    } finally {
      setDbLoading(false);
    }
  };

  const handleClearDb = async () => {
    if (!window.confirm('DB의 일정 데이터를 모두 삭제할까요?')) return;
    setDbLoading(true);
    try {
      const res = await fetch(`${API}/client-schedule/db`, { method: 'DELETE', headers: authHeaders });
      if (handleUnauthorized(res)) return;
      setDbRows([]);
      setDbSavedAt(null);
      setStatus('DB 초기화 완료');
    } catch (err) {
      setStatus(err.message || 'DB 초기화 실패');
    } finally {
      setDbLoading(false);
    }
  };

  const handleIncomingFromEzadmin = async () => {
    try {
      setIncomingEzLoading(true);
      setStatus('EZAdmin에서 입고파일 불러오는 중...');
      const res = await fetch(`${LOCAL_API_BASE}/barcode/incoming/raw-file-from-ezadmin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({}),
      });
      if (res.headers.get('content-type')?.includes('application/json')) {
        const data = await res.json().catch(() => ({}));
        if (data?.need_session) { openEzadminModal(handleIncomingFromEzadmin); return; }
        setStatus(data?.error || 'EZAdmin 입고파일 불러오기 실패');
        return;
      }
      if (!res.ok) { setStatus(`EZAdmin 입고파일 불러오기 실패 (HTTP ${res.status})`); return; }
      const blob = await res.blob();
      const file = new File([blob], 'incoming.xls', { type: 'application/vnd.ms-excel' });
      setIncomingFile(file);
      setStatus('EZAdmin 입고파일 불러오기 완료');
    } catch (err) {
      setStatus(`EZAdmin 입고파일 불러오기 실패: ${err.message || ''}`);
    } finally {
      setIncomingEzLoading(false);
    }
  };

  const handleBaseFromEzadmin = async () => {
    try {
      setBaseEzLoading(true);
      setStatus('EZAdmin에서 기준 파일 불러오는 중...');
      const res = await fetch(`${LOCAL_API_BASE}/barcode/base-file-from-ezadmin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ start_date: baseEzStart, end_date: baseEzEnd }),
      });
      if (res.headers.get('content-type')?.includes('application/json')) {
        const data = await res.json().catch(() => ({}));
        if (data?.need_session) { openEzadminModal(handleBaseFromEzadmin); return; }
        setStatus(data?.error || 'EZAdmin 기준 파일 불러오기 실패');
        return;
      }
      if (!res.ok) { setStatus(`EZAdmin 기준 파일 불러오기 실패 (HTTP ${res.status})`); return; }
      const blob = await res.blob();
      setBaseFile(new File([blob], 'base_file.xls', { type: 'application/vnd.ms-excel' }));
      setStatus('EZAdmin 기준 파일 불러오기 완료');
    } catch (err) {
      setStatus(`EZAdmin 기준 파일 불러오기 실패: ${err.message || ''}`);
    } finally {
      setBaseEzLoading(false);
    }
  };

  const handleBaseProcess = async () => {
    if (!baseFile) {
      setStatus('기준 파일을 먼저 선택하세요.');
      return;
    }

    setLoading(true);
    try {
      const { rows } = await readWorkbook(baseFile);
      let processed = preprocessBaseSheet(rows);

      // 현재 테이블에 데이터가 있으면 그걸로 병합 (DB 저장 여부 무관하게 날짜 유지)
      // 없으면 DB 데이터로 병합
      const mergeSourceLabel = sheet2Rows.length > 0 ? '현재 테이블' : 'DB';
      const mergeSource = sheet2Rows.length > 0 ? sheet2Rows : dbRows;
      if (mergeSource.length > 0) {
        processed = mergeScheduleRows(processed, mergeSource, baseDate);
      }

      // 입고 파일로 행 삭제
      let removedCount = 0;
      if (incomingFile) {
        const { rows: inRows } = await readWorkbook(incomingFile);
        const incomingKeys = readIncomingKeys(inRows);
        const before = processed.length;
        processed = withIds(processed.filter((row) => !incomingKeys.has(toDisplayText(row.srcI))));
        removedCount = before - processed.length;
      }

      setSheet2Rows(processed);
      setSheet1Rows([HEADER_SHEET1]);
      const mergeNote = mergeSource.length > 0 ? ` · ${mergeSourceLabel} ${mergeSource.length}행 병합` : ' · 병합 데이터 없음';
      const incomingNote = removedCount > 0 ? ` · 입고 삭제 ${removedCount}행` : '';
      setStatus(`가공 완료: ${processed.length}행${mergeNote}${incomingNote}`);
    } catch (error) {
      setStatus(error.message || '기준 파일 처리에 실패했습니다.');
    } finally {
      setLoading(false);
    }
  };

  const handleNormalizeDates = () => {
    let changed = 0;
    setSheet2Rows(prev =>
      prev.map(row => {
        const normalized = normalizeDValueForMerge(row.D, baseDate);
        if (normalized === row.D) return row;
        changed++;
        return { ...row, D: normalized };
      })
    );
    setStatus(`날짜 정규화 완료${changed ? ` (${changed}행 변경)` : ' (변경 없음)'}`);
  };

  const handleRunAll = () => {
    if (!sheet2Rows.length) {
      setStatus('\uba3c\uc800 \uae30\uc900 \ud30c\uc77c\uc744 \uac00\uacf5\ud558\uc138\uc694.');
      return;
    }

    const {
      sheet1Rows: nextSheet1,
      sheet2Rows: nextSheet2,
      excludedMatchedClients,
    } = buildSheet1AndSheet2(sheet2Rows, msgPrefix, msgSuffix, excludedClients);
    setSheet1Rows(nextSheet1);
    setSheet2Rows(nextSheet2);
    setStatus(
      `\ud1b5\ud569 \uc2e4\ud589 \uc644\ub8cc: Sheet1 ${Math.max(nextSheet1.length - 1, 0)}\uac74, Sheet2 ${nextSheet2.length}\ud589${
        excludedMatchedClients.length ? `, \uc81c\uc678 \uac70\ub798\ucc98 ${excludedMatchedClients.length}\uacf3` : ''
      }`
    );
  };

  const handleSheet2Change = (id, field, value) => {
    setSheet2Rows((prev) => prev.map((row) => (row.id === id ? { ...row, [field]: value } : row)));
    setDirtyRowIds((prev) => new Set(prev).add(id));
  };

  const handleDBlur = (id, value) => {
    const expanded = expandDateShorthand(value, baseDateText);
    let currentRows = sheet2Rows;
    if (expanded !== value) {
      currentRows = sheet2Rows.map((row) => (row.id === id ? { ...row, D: expanded } : row));
      setSheet2Rows(currentRows);
    }
    autoSaveToDb(currentRows);
  };

  const handleEBlur = () => {
    autoSaveToDb(sheet2Rows);
  };

  const handleIBlur = () => {
    autoSaveToDb(sheet2Rows);
  };

  const DB_HEADERS = ['그룹', '거래처', '상세', '일정', '보조', '상품코드', '수량', '미송'];

  const handleDbExport = () => {
    const rows = sheet2Rows.length ? sheet2Rows : dbRows;
    if (!rows.length) { setStatus('내보낼 데이터가 없습니다.'); return; }
    const aoa = [
      DB_HEADERS,
      ...rows.map((r) => [r.A, r.B, r.C, r.D, r.E, r.F, r.G, r.H]),
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'DB');
    XLSX.writeFile(wb, '거래처일정_DB.xlsx');
    setStatus('DB 엑셀 내보내기 완료');
  };

  const handleDbImport = async (file) => {
    if (!file) return;
    setDbLoading(true);
    try {
      const { rows: raw } = await readWorkbook(file, 'DB');
      // 첫 행이 헤더면 제거
      const dataRows = raw.length > 0 && String(raw[0][0] || '').trim() === '그룹' ? raw.slice(1) : raw;

      // 날짜(D열)가 입력된 행만 추출 → (A,B,C,F) 키로 맵 구성
      const dateUpdateMap = new Map();
      dataRows
        .filter((r) => r.some((v) => String(v ?? '').trim()))
        .forEach((r) => {
          const D = toDisplayText(r[3]);
          if (!D) return;
          const key = [toDisplayText(r[0]), toDisplayText(r[1]), toDisplayText(r[2]), toDisplayText(r[5])].join('||');
          dateUpdateMap.set(key, { D, E: toDisplayText(r[4]) });
        });

      if (dateUpdateMap.size === 0) {
        setStatus('날짜가 입력된 행이 없습니다. D열에 날짜를 입력 후 업로드하세요.');
        return;
      }

      // 현재 테이블(또는 DB)에서 매칭되는 행의 날짜만 업데이트
      const currentRows = sheet2Rows.length > 0 ? sheet2Rows : dbRows;
      if (!currentRows.length) {
        setStatus('현재 테이블에 데이터가 없습니다. 기준 파일을 먼저 가공하세요.');
        return;
      }

      let updatedCount = 0;
      const updated = currentRows.map((row) => {
        const key = [row.A, row.B, row.C, row.F].map(toDisplayText).join('||');
        const match = dateUpdateMap.get(key);
        if (!match) return row;
        updatedCount += 1;
        return { ...row, D: match.D, E: match.E };
      });

      const payload = updated.map(({ A, B, C, D, E, F, G, H, I }) => ({ A, B, C, D, E, F, G, H, I }));
      const res = await fetch(`${API}/client-schedule/db`, {
        method: 'PUT',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: payload }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json();
      if (!res.ok) throw new Error(data?.detail || 'DB 저장 실패');

      const withIdsUpdated = withIds(updated);
      setDbRows(withIdsUpdated);
      setDbSavedAt(data.saved_at);
      const { sheet2Rows: s2 } = buildSheet1AndSheet2(withIdsUpdated, msgPrefix, msgSuffix, excludedClients);
      setSheet2Rows(s2);
      setSheet1Rows([HEADER_SHEET1]);
      setStatus(`엑셀 업로드 완료: ${updatedCount}행 날짜 업데이트 · DB 저장`);
    } catch (err) {
      setStatus(err.message || '엑셀 업로드 실패');
    } finally {
      setDbLoading(false);
    }
  };

  const handleSheet1Download = () => {
    if (!sheet2Rows.length) { setStatus('먼저 기준 파일을 가공하세요.'); return; }
    const { sheet1Rows: built, excludedMatchedClients } = buildSheet1AndSheet2(sheet2Rows, msgPrefix, msgSuffix, excludedClients);
    const final = built;
    if (final.length <= 1) { setStatus('문자 대상이 없습니다. 통합 실행 후 시도하세요.'); return; }
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(final), 'Sheet1');
    XLSX.writeFile(wb, '거래처일정_Sheet1.xlsx');
    setStatus(`Sheet1 다운로드 완료: ${final.length - 1}건`);
  };

  const handleDownload = () => {
    if (!sheet2Rows.length) {
      setStatus('\ub2e4\uc6b4\ub85c\ub4dc\ud560 \ub370\uc774\ud130\uac00 \uc5c6\uc2b5\ub2c8\ub2e4.');
      return;
    }

    const result = buildSheet1AndSheet2(sheet2Rows, msgPrefix, msgSuffix, excludedClients);
    const finalSheet1 = result.sheet1Rows;
    const finalSheet2 = sheet1Rows.length > 1 ? sheet2Rows : result.sheet2Rows;

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(finalSheet1), 'Sheet1');
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rowsToSheet2AoA(finalSheet2)), 'Sheet2');
    XLSX.writeFile(workbook, '\uac70\ub798\ucc98\uc77c\uc815_\uac00\uacf5\ubcd1\ud569.xlsx');
    setStatus('\uc5d1\uc140 \ub2e4\uc6b4\ub85c\ub4dc\ub97c \uc2dc\uc791\ud588\uc2b5\ub2c8\ub2e4.');
  };

  return (
    <div className={styles.page}>
      {/* ── 헤더 ── */}
      <div className={styles.header}>
        <h2 className={styles.headerTitle}>거래처 일정</h2>
        <div className={styles.headerStats}>
          <span className={styles.statBadge}>
            <Database size={12} /> DB <strong>{dbRows.length}</strong>행
            {dbSavedAt && <span className={styles.savedAt}>{new Date(dbSavedAt).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 저장</span>}
          </span>
          <span className={styles.statBadge}>현재 <strong>{sheet2Rows.length}</strong>행</span>
        </div>
      </div>

      {/* ── 컨트롤 패널 ── */}
      <div className={styles.controlPanel}>
        <div className={styles.controlLeft}>
          {/* 파일 선택 */}
          <div className={styles.fileRow}>
            <div className={styles.fileField}>
              <span className={styles.fieldLabel}>기준 파일 <small>(당일 발주)</small></span>
              <label className={`${styles.fileInput} ${baseFile ? styles.fileSelected : ''}`}>
                <FileUp size={14} />
                <input type="file" accept=".xls,.xlsx,.xlsm" onChange={(e) => setBaseFile(e.target.files?.[0] ?? null)} />
                {baseFile ? baseFile.name : '파일 선택 → DB 자동 병합'}
              </label>
              <div style={{ display: 'flex', gap: '0.25rem', marginTop: '0.25rem', alignItems: 'center' }}>
                <input type="date" value={baseEzStart} onChange={(e) => setBaseEzStart(e.target.value)}
                  style={{ fontSize: '0.75rem', padding: '2px 4px' }} />
                <span style={{ fontSize: '0.75rem' }}>~</span>
                <input type="date" value={baseEzEnd} onChange={(e) => setBaseEzEnd(e.target.value)}
                  style={{ fontSize: '0.75rem', padding: '2px 4px' }} />
                <button
                  className={styles.ghostBtn}
                  onClick={handleBaseFromEzadmin}
                  disabled={baseEzLoading}
                  style={{ fontSize: '0.8rem' }}
                >
                  {baseEzLoading ? '불러오는 중...' : 'EZAdmin 불러오기'}
                </button>
              </div>
            </div>
            <div className={styles.fileField}>
              <span className={styles.fieldLabel}>입고 파일 <small>(선택 · (A,F) 삭제)</small></span>
              <label className={`${styles.fileInput} ${incomingFile ? styles.fileSelected : ''}`}>
                <FileUp size={14} />
                <input type="file" accept=".xls,.xlsx,.xlsm" onChange={(e) => setIncomingFile(e.target.files?.[0] ?? null)} />
                {incomingFile ? incomingFile.name : '파일 선택'}
              </label>
              <button
                className={styles.ghostBtn}
                onClick={handleIncomingFromEzadmin}
                disabled={incomingEzLoading}
                style={{ marginTop: '0.25rem', fontSize: '0.8rem' }}
              >
                {incomingEzLoading ? '불러오는 중...' : 'EZAdmin 불러오기'}
              </button>
            </div>
          </div>
          {/* 액션 버튼 */}
          <div className={styles.btnRow}>
            <button className={styles.primaryBtn} onClick={handleBaseProcess} disabled={loading || dbLoading}>
              <Sparkles size={14} /> 기준 가공 + 병합
            </button>
            <button className={styles.ghostBtn} onClick={handleRunAll} disabled={loading}>
              <CalendarDays size={14} /> 통합 실행
            </button>
            <button className={styles.ghostBtn} onClick={handleNormalizeDates} disabled={!sheet2Rows.length}>
              <RefreshCw size={14} /> 날짜 정규화
            </button>
            <button className={styles.ghostBtn} onClick={handleDownload} disabled={loading}>
              <Download size={14} /> 결과 다운로드
            </button>
            <button className={styles.ghostBtn} onClick={handleSheet1Download} disabled={loading}>
              <Download size={14} /> Sheet1
            </button>
            <span className={styles.btnDivider} />
            <button className={styles.dbSaveBtn} onClick={handleSaveToDb} disabled={dbLoading || !sheet2Rows.length}>
              <Database size={14} /> DB 저장
            </button>
            <button className={styles.ghostBtn} onClick={handleDbExport} disabled={dbLoading && !sheet2Rows.length && !dbRows.length}>
              <Download size={14} /> DB 엑셀
            </button>
            <label className={`${styles.ghostBtn} ${styles.uploadLabel}`}>
              <FileUp size={14} /> 엑셀 업로드
              <input type="file" accept=".xls,.xlsx,.xlsm" style={{ display: 'none' }} onChange={(e) => { handleDbImport(e.target.files?.[0] ?? null); e.target.value = ''; }} />
            </label>
            <button className={styles.dbClearBtn} onClick={handleClearDb} disabled={dbLoading || !dbRows.length}>
              <Trash2 size={14} />
            </button>
          </div>
        </div>

        {/* 설정 */}
        <div className={styles.controlRight}>
          <div className={styles.settingGroup}>
            <span className={styles.fieldLabel}>기준 날짜</span>
            <input type="date" value={baseDateText} onChange={(e) => setBaseDateText(e.target.value)} />
          </div>
          <div className={styles.settingGroup}>
            <span className={styles.fieldLabel}>문자 시작</span>
            <input value={msgPrefix} onChange={(e) => setMsgPrefix(e.target.value)} placeholder={DEFAULT_PREFIX} />
          </div>
          <div className={styles.settingGroup}>
            <span className={styles.fieldLabel}>문자 마무리</span>
            <input value={msgSuffix} onChange={(e) => setMsgSuffix(e.target.value)} placeholder={DEFAULT_SUFFIX} />
          </div>
          <div className={styles.settingGroup}>
            <div className={styles.excludedHeader}>
              <span className={styles.fieldLabel}>
                제외 거래처
                {excludedClients.length > 0 && (
                  <span className={styles.excludedCount}>{excludedClients.length}건</span>
                )}
              </span>
              {excludedClients.length > 0 && (
                <button
                  type="button"
                  className={styles.clearAllBtn}
                  onClick={() => { setExcludedClients([]); saveExcludedClientsToDb([]); }}
                  title="전체 삭제"
                >
                  전체 삭제
                </button>
              )}
            </div>
            <div
              className={`${styles.receiverBox} ${showAllExcluded ? styles.receiverBoxExpanded : ''}`}
              onClick={() => excludedClientInputRef.current?.focus()}
            >
              {hiddenTagCount > 0 && !showAllExcluded && (
                <button
                  type="button"
                  className={styles.moreTagsBtn}
                  onClick={(e) => { e.stopPropagation(); setShowAllExcluded(true); }}
                >
                  +{hiddenTagCount} 전체보기
                </button>
              )}
              {visibleClients.map((client) => (
                <span key={client} className={styles.tag}>
                  {client}
                  <button
                    type="button"
                    className={styles.tagRemove}
                    onClick={(e) => {
                      e.stopPropagation();
                      removeExcludedClient(client);
                    }}
                  >
                    <X size={12} />
                  </button>
                </span>
              ))}
              {showAllExcluded && excludedClients.length > VISIBLE_TAG_COUNT && (
                <button
                  type="button"
                  className={styles.moreTagsBtn}
                  onClick={(e) => { e.stopPropagation(); setShowAllExcluded(false); }}
                >
                  접기
                </button>
              )}
              <input
                ref={excludedClientInputRef}
                className={styles.receiverInput}
                value={excludedClientInput}
                onChange={(e) => setExcludedClientInput(e.target.value)}
                onKeyDown={handleExcludedClientKeyDown}
                onBlur={() => excludedClientInput && addExcludedClients(excludedClientInput)}
                placeholder={excludedClients.length === 0 ? '거래처 입력 후 Enter / 콤마' : '추가 입력...'}
              />
            </div>
            <span className={styles.hint}>키워드 포함 거래처는 Sheet1에서 제외됩니다.</span>
          </div>
        </div>
      </div>

      {/* ── 상태 + 검색 ── */}
      <div className={styles.statusRow}>
        <span className={styles.statusText}>{status}</span>
        <label className={styles.searchBox}>
          <Search size={14} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="거래처, 상품명, 일정 검색" />
        </label>
      </div>

      {/* ── 테이블 ── */}
      <div className={styles.tablePanel}>
        <div className={styles.panel}>
          <div className={styles.panelHead}>
            <span className={styles.panelTitle}>Sheet2 일정 편집</span>
            <span className={styles.panelCount}>{filteredRows.length}행</span>
          </div>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  {[
                    ['A', '그룹'],
                    ['B', '거래처'],
                    ['C', '상세'],
                    ['D', '일정'],
                    ['E', '보조'],
                    ['F', '상품코드'],
                    ['G', '수량'],
                    ['H', '미송'],
                    ['I', '안내문구'],
                  ].map(([col, label]) => (
                    <th
                      key={col}
                      className={styles.sortableHeader}
                      onClick={() => handleSort(col)}
                    >
                      {label}
                      {sortColumn === col && (
                        <span className={styles.sortArrow}>{sortDirection === 'asc' ? ' ▲' : ' ▼'}</span>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedRows.map((row) => (
                  <tr key={row.id}>
                    <td>{row.A}</td>
                    <td>{row.B}</td>
                    <td>{row.C}</td>
                    <td>
                      <input
                        className={styles.cellInput}
                        value={toDisplayText(row.D)}
                        onChange={(e) => handleSheet2Change(row.id, 'D', e.target.value)}
                        onBlur={(e) => handleDBlur(row.id, e.target.value)}
                        placeholder="날짜 또는 이번주중"
                      />
                    </td>
                    <td>
                      <input
                        className={styles.cellInput}
                        value={toDisplayText(row.E)}
                        onChange={(e) => handleSheet2Change(row.id, 'E', e.target.value)}
                        onBlur={handleEBlur}
                        placeholder="보조 일정"
                      />
                    </td>
                    <td>{row.F}</td>
                    <td>{row.G}</td>
                    <td>{row.H}</td>
                    <td className={styles.colGuide}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        <textarea
                          className={`${styles.cellInput} ${styles.cellTextarea}`}
                          value={toDisplayText(row.I)}
                          onChange={(e) => handleSheet2Change(row.id, 'I', e.target.value)}
                          onBlur={handleIBlur}
                          placeholder="안내문구 직접 입력"
                          rows={2}
                        />
                        {dirtyRowIds.has(row.id) && (
                          <button
                            type="button"
                            className={styles.cellSaveBtn}
                            onClick={handleSaveToDb}
                            disabled={dbLoading}
                            title="저장되지 않은 변경사항 저장"
                          >
                            <Save size={11} />저장
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {filteredRows.length === 0 && (
              <div className={styles.empty}>표시할 데이터가 없습니다.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );

}
