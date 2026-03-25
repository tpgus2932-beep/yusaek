import React, { useMemo, useState } from 'react';
import { CalendarDays, Download, FileSpreadsheet, GitMerge, Search, Sparkles, FileUp } from 'lucide-react';
import * as XLSX from 'xlsx';
import styles from './ClientSchedulePage.module.css';

const DEFAULT_PREFIX = '\uc548\ub155\ud558\uc138\uc694';
const DEFAULT_SUFFIX = '\uc77c\uc815 \ud655\uc778 \ud6c4 \uc548\ub0b4\ub4dc\ub9ac\uaca0\uc2b5\ub2c8\ub2e4. \uac10\uc0ac\ud569\ub2c8\ub2e4.';
const DEFAULT_TEXT_MSG = '\uc624\ub298 \uc8fc\ubb38 \uac00\ub2a5\ud558\uc2e4\uae4c\uc694? \uac00\ub2a5\ud558\uc2dc\uba74 \uc77c\uc815 \ubd80\ud0c1\ub4dc\ub9bd\ub2c8\ub2e4.';
const HEADER_SHEET1 = ['\uac70\ub798\ucc98', '\ubb38\uc790'];
const WEEKDAY_LABELS = [
  '\uc6d4\uc694\uc77c',
  '\ud654\uc694\uc77c',
  '\uc218\uc694\uc77c',
  '\ubaa9\uc694\uc77c',
  '\uae08\uc694\uc77c',
  '\ud1a0\uc694\uc77c',
  '\uc77c\uc694\uc77c',
];

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
  const rows = ensureWidth(Array.isArray(rawRows) ? rawRows.slice(1) : [], 11);
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
    });
  });

  if (sheet2.length > 0) {
    sheet2.pop();
  }

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

  const weekday = baseDate.getDay();
  const monday = new Date(baseDate);
  monday.setDate(baseDate.getDate() - ((baseDate.getDay() + 6) % 7));
  const thisThursday = new Date(monday);
  thisThursday.setDate(monday.getDate() + 3);
  const thisFriday = new Date(monday);
  thisFriday.setDate(monday.getDate() + 4);
  const nextFriday = new Date(monday);
  nextFriday.setDate(monday.getDate() + 11);

  let normalized = text;
  if (weekday === 0) {
    if (normalized === '\ub2e4\uc74c\uc8fc\uc911') normalized = '\uc774\ubc88\uc8fc\uc911';
    else if (normalized === '\ub2e4\ub2e4\uc74c\uc8fc\uc911') normalized = '\ub2e4\uc74c\uc8fc\uc911';
  }

  if (normalized === '\uc774\ubc88\uc8fc\uc911') {
    return baseDate > thisThursday ? '' : normalized;
  }
  if (normalized === '\ub2e4\uc74c\uc8fc\uc911') {
    return baseDate > thisFriday ? '' : normalized;
  }
  if (normalized === '\ub2e4\ub2e4\uc74c\uc8fc\uc911') {
    return baseDate > nextFriday ? '' : normalized;
  }
  return normalized;
}

function mergeScheduleRows(baseRows, mergeRows, baseDate) {
  const mergeMap = new Map();
  mergeRows.forEach((row) => {
    const key = [row.A, row.B, row.C, row.F].map(toDisplayText).join('||');
    mergeMap.set(key, {
      D: normalizeDValueForMerge(row.D, baseDate),
      E: toDisplayText(row.E),
    });
  });

  return withIds(
    baseRows.map((row) => {
      const key = [row.A, row.B, row.C, row.F].map(toDisplayText).join('||');
      const merged = mergeMap.get(key);
      if (!merged) return row;
      return {
        ...row,
        D: merged.D,
        E: merged.E,
      };
    })
  );
}

function readIncomingPairs(rawRows) {
  const rows = ensureWidth(Array.isArray(rawRows) ? rawRows : [], 1);
  const pairs = new Set();
  rows.forEach((row) => {
    const left = toDisplayText(row[0]);
    const right = toDisplayText(row[1]);
    if (left && right) {
      pairs.add(`${left}||${right}`);
    }
  });
  return pairs;
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

function buildGuideMessage(dValue) {
  const dateValue = coerceDate(dValue);
  if (dateValue) {
    const next = new Date(dateValue);
    next.setDate(dateValue.getDate() + 1);
    return `\uc548\ub155\ud558\uc138\uc694. \uc8fc\ubb38\ud574\uc8fc\uc2e0 \uc0c1\ud488 \ubc30\uc1a1 \uc77c\uc815\uc740 ${next.getFullYear()}\ub144 ${next.getMonth() + 1}\uc6d4 ${next.getDate()}\uc77c ${WEEKDAY_LABELS[(next.getDay() + 6) % 7]} \ubc1c\uc1a1 \uc608\uc815\uc785\ub2c8\ub2e4.`;
  }

  const text = toDisplayText(dValue).replace(/\s+/g, '');
  if (text === '\uc774\ubc88\uc8fc\uc911') {
    return '\uc548\ub155\ud558\uc138\uc694. \uc8fc\ubb38\ud574\uc8fc\uc2e0 \uc0c1\ud488 \uc774\ubc88\uc8fc\uc911 \ubc1c\uc1a1 \uc608\uc815\uc785\ub2c8\ub2e4. \uac10\uc0ac\ud569\ub2c8\ub2e4.';
  }
  if (text === '\ub2e4\uc74c\uc8fc\uc911') {
    return '\uc548\ub155\ud558\uc138\uc694. \uc8fc\ubb38\ud574\uc8fc\uc2e0 \uc0c1\ud488 \ub2e4\uc74c\uc8fc\uc911 \ubc1c\uc1a1 \uc608\uc815\uc785\ub2c8\ub2e4. \uac10\uc0ac\ud569\ub2c8\ub2e4.';
  }
  if (text === '\ub2e4\ub2e4\uc74c\uc8fc\uc911') {
    return '\uc548\ub155\ud558\uc138\uc694. \uc8fc\ubb38\ud574\uc8fc\uc2e0 \uc0c1\ud488 \ub2e4\ub2e4\uc74c\uc8fc\uc911 \ubc1c\uc1a1 \uc608\uc815\uc785\ub2c8\ub2e4. \uac10\uc0ac\ud569\ub2c8\ub2e4.';
  }
  return '\ud574\ub2f9 \uc0c1\ud488 \ud604\uc7ac \uc77c\uc815 \ud655\uc778\uc911\uc774\uba70 \uc785\uace0 \ud655\uc778\ub418\ub294\ub300\ub85c \uc77c\uc815 \uc548\ub0b4\ub4dc\ub9ac\uaca0\uc2b5\ub2c8\ub2e4. \uac10\uc0ac\ud569\ub2c8\ub2e4.';
}

function buildSheet1AndSheet2(rows, prefix, suffix) {
  const rolled = rows.map((row) => {
    if (!toDisplayText(row.D) && toDisplayText(row.E)) {
      return { ...row, D: toDisplayText(row.E), E: '' };
    }
    return { ...row };
  });

  const grouped = new Map();
  rolled
    .filter((row) => !toDisplayText(row.D) && toDisplayText(row.B))
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
      I: buildGuideMessage(row.D),
    }))
  );

  return { sheet1Rows, sheet2Rows };
}

function rowsToSheet2AoA(rows) {
  return rows.map((row) => [row.A, row.B, row.C, row.D, row.E, row.F, row.G, row.H, row.I]);
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
  const [baseFile, setBaseFile] = useState(null);
  const [mergeFile, setMergeFile] = useState(null);
  const [incomingFile, setIncomingFile] = useState(null);
  const [baseDateText, setBaseDateText] = useState(formatInputDate());
  const [msgPrefix, setMsgPrefix] = useState(DEFAULT_PREFIX);
  const [msgSuffix, setMsgSuffix] = useState(DEFAULT_SUFFIX);
  const [sheet1Rows, setSheet1Rows] = useState([HEADER_SHEET1]);
  const [sheet2Rows, setSheet2Rows] = useState([]);
  const [status, setStatus] = useState('\uae30\uc900 \ud30c\uc77c\uc744 \uc5c5\ub85c\ub4dc\ud558\uba74 \uac70\ub798\ucc98 \uc77c\uc815\uc6a9 Sheet2\uac00 \uc0dd\uc131\ub429\ub2c8\ub2e4.');
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');

  const filteredRows = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return sheet2Rows;
    return sheet2Rows.filter((row) =>
      [row.A, row.B, row.C, row.D, row.E, row.F, row.G, row.H, row.I].join(' ').toLowerCase().includes(keyword)
    );
  }, [query, sheet2Rows]);

  const baseDate = useMemo(() => coerceDate(baseDateText) || new Date(), [baseDateText]);

  const handleBaseProcess = async () => {
    if (!baseFile) {
      setStatus('\uae30\uc900 \ud30c\uc77c\uc744 \uba3c\uc800 \uc120\ud0dd\ud558\uc138\uc694.');
      return;
    }

    setLoading(true);
    try {
      const { rows } = await readWorkbook(baseFile);
      const processed = preprocessBaseSheet(rows);
      setSheet2Rows(processed);
      setSheet1Rows([HEADER_SHEET1]);
      setStatus(`\uae30\uc900 \ud30c\uc77c \uac00\uacf5 \uc644\ub8cc: ${processed.length}\ud589`);
    } catch (error) {
      setStatus(error.message || '\uae30\uc900 \ud30c\uc77c \ucc98\ub9ac\uc5d0 \uc2e4\ud328\ud588\uc2b5\ub2c8\ub2e4.');
    } finally {
      setLoading(false);
    }
  };

  const handleMerge = async () => {
    if (!sheet2Rows.length) {
      setStatus('\uba3c\uc800 \uae30\uc900 \ud30c\uc77c\uc744 \uac00\uacf5\ud558\uc138\uc694.');
      return;
    }
    if (!mergeFile) {
      setStatus('\ubcd1\ud569 \ud30c\uc77c\uc744 \uba3c\uc800 \uc120\ud0dd\ud558\uc138\uc694.');
      return;
    }

    setLoading(true);
    try {
      const mergeWorkbook = await readWorkbook(mergeFile, 'Sheet2');
      const mergeRows = mergeWorkbook.sheetName === 'Sheet2'
        ? parseScheduleSheet2Rows(mergeWorkbook.rows)
        : preprocessBaseSheet(mergeWorkbook.rows);

      let nextRows = mergeScheduleRows(sheet2Rows, mergeRows, baseDate);

      let removedCount = 0;
      if (incomingFile) {
        const { rows } = await readWorkbook(incomingFile);
        const incomingPairs = readIncomingPairs(rows);
        const before = nextRows.length;
        nextRows = withIds(nextRows.filter((row) => !incomingPairs.has(`${toDisplayText(row.A)}||${toDisplayText(row.F)}`)));
        removedCount = before - nextRows.length;
      }

      setSheet2Rows(nextRows);
      setStatus(`\ubcd1\ud569 \ubc18\uc601 \uc644\ub8cc: ${nextRows.length}\ud589, \uc785\uace0 \uae30\uc900 \uc0ad\uc81c ${removedCount}\ud589`);
    } catch (error) {
      setStatus(error.message || '\ubcd1\ud569 \ucc98\ub9ac\uc5d0 \uc2e4\ud328\ud588\uc2b5\ub2c8\ub2e4.');
    } finally {
      setLoading(false);
    }
  };

  const handleRunAll = () => {
    if (!sheet2Rows.length) {
      setStatus('\uba3c\uc800 \uae30\uc900 \ud30c\uc77c\uc744 \uac00\uacf5\ud558\uc138\uc694.');
      return;
    }

    const { sheet1Rows: nextSheet1, sheet2Rows: nextSheet2 } = buildSheet1AndSheet2(sheet2Rows, msgPrefix, msgSuffix);
    setSheet1Rows(nextSheet1);
    setSheet2Rows(nextSheet2);
    setStatus(`\ud1b5\ud569 \uc2e4\ud589 \uc644\ub8cc: Sheet1 ${Math.max(nextSheet1.length - 1, 0)}\uac74, Sheet2 ${nextSheet2.length}\ud589`);
  };

  const handleSheet2Change = (id, field, value) => {
    setSheet2Rows((prev) => prev.map((row) => (row.id === id ? { ...row, [field]: value } : row)));
  };

  const handleDownload = () => {
    if (!sheet2Rows.length) {
      setStatus('\ub2e4\uc6b4\ub85c\ub4dc\ud560 \ub370\uc774\ud130\uac00 \uc5c6\uc2b5\ub2c8\ub2e4.');
      return;
    }

    const result = buildSheet1AndSheet2(sheet2Rows, msgPrefix, msgSuffix);
    const finalSheet1 = sheet1Rows.length > 1 ? sheet1Rows : result.sheet1Rows;
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
          <span className={styles.statBadge}>Sheet2 <strong>{sheet2Rows.length}</strong>행</span>
          <span className={styles.statBadge}>문자 <strong>{Math.max(sheet1Rows.length - 1, 0)}</strong>건</span>
        </div>
      </div>

      {/* ── 컨트롤 패널 ── */}
      <div className={styles.controlPanel}>
        <div className={styles.controlLeft}>
          {/* 파일 선택 */}
          <div className={styles.fileRow}>
            <div className={styles.fileField}>
              <span className={styles.fieldLabel}>기준 파일</span>
              <label className={`${styles.fileInput} ${baseFile ? styles.fileSelected : ''}`}>
                <FileUp size={14} />
                <input type="file" accept=".xls,.xlsx,.xlsm" onChange={(e) => setBaseFile(e.target.files?.[0] ?? null)} />
                {baseFile ? baseFile.name : '당일 발주 파일 선택'}
              </label>
            </div>
            <div className={styles.fileField}>
              <span className={styles.fieldLabel}>병합 파일</span>
              <label className={`${styles.fileInput} ${mergeFile ? styles.fileSelected : ''}`}>
                <FileUp size={14} />
                <input type="file" accept=".xls,.xlsx,.xlsm" onChange={(e) => setMergeFile(e.target.files?.[0] ?? null)} />
                {mergeFile ? mergeFile.name : '전날 일정 파일 선택'}
              </label>
            </div>
            <div className={styles.fileField}>
              <span className={styles.fieldLabel}>입고 파일 <small>(선택)</small></span>
              <label className={`${styles.fileInput} ${incomingFile ? styles.fileSelected : ''}`}>
                <FileUp size={14} />
                <input type="file" accept=".xls,.xlsx,.xlsm" onChange={(e) => setIncomingFile(e.target.files?.[0] ?? null)} />
                {incomingFile ? incomingFile.name : '(A,F) 기준 행 삭제'}
              </label>
            </div>
          </div>
          {/* 액션 버튼 */}
          <div className={styles.btnRow}>
            <button className={styles.primaryBtn} onClick={handleBaseProcess} disabled={loading}>
              <Sparkles size={14} /> 기준 가공
            </button>
            <button className={styles.ghostBtn} onClick={handleMerge} disabled={loading}>
              <GitMerge size={14} /> 병합 반영
            </button>
            <button className={styles.ghostBtn} onClick={handleRunAll} disabled={loading}>
              <CalendarDays size={14} /> 통합 실행
            </button>
            <button className={styles.ghostBtn} onClick={handleDownload} disabled={loading}>
              <Download size={14} /> 다운로드
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

      {/* ── 미리보기 ── */}
      <div className={styles.previewGrid}>
        {/* Sheet1 문자 */}
        <div className={styles.panel}>
          <div className={styles.panelHead}>
            <span className={styles.panelTitle}>Sheet1 문자 미리보기</span>
            <span className={styles.panelCount}>{Math.max(sheet1Rows.length - 1, 0)}건</span>
          </div>
          <div className={styles.messageList}>
            {sheet1Rows.slice(1).map((row, index) => (
              <article key={`${row[0]}-${index}`} className={styles.messageCard}>
                <strong className={styles.messageClient}>{row[0]}</strong>
                <pre>{row[1]}</pre>
              </article>
            ))}
            {sheet1Rows.length <= 1 && (
              <div className={styles.empty}>통합 실행 후 문자 미리보기가 생성됩니다.</div>
            )}
          </div>
        </div>

        {/* Sheet2 테이블 */}
        <div className={styles.panel}>
          <div className={styles.panelHead}>
            <span className={styles.panelTitle}>Sheet2 일정 편집</span>
            <span className={styles.panelCount}>{filteredRows.length}행</span>
          </div>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>그룹</th>
                  <th>거래처</th>
                  <th>상세</th>
                  <th>일정</th>
                  <th>보조</th>
                  <th>상품코드</th>
                  <th>수량</th>
                  <th>미송</th>
                  <th>안내문구</th>
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((row) => (
                  <tr key={row.id}>
                    <td>{row.A}</td>
                    <td>{row.B}</td>
                    <td>{row.C}</td>
                    <td>
                      <input
                        className={styles.cellInput}
                        value={toDisplayText(row.D)}
                        onChange={(e) => handleSheet2Change(row.id, 'D', e.target.value)}
                        placeholder="날짜 또는 이번주중"
                      />
                    </td>
                    <td>
                      <input
                        className={styles.cellInput}
                        value={toDisplayText(row.E)}
                        onChange={(e) => handleSheet2Change(row.id, 'E', e.target.value)}
                        placeholder="보조 일정"
                      />
                    </td>
                    <td>{row.F}</td>
                    <td>{row.G}</td>
                    <td>{row.H}</td>
                    <td className={styles.colGuide}>{row.I}</td>
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
