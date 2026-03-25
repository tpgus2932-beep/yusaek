import React, { useMemo, useState } from 'react';
import { CalendarDays, Download, FileSpreadsheet, GitMerge, Search, Sparkles } from 'lucide-react';
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
      <section className={styles.hero}>
        <div className={styles.heroText}>
          <span className={styles.eyebrow}>CLIENT SCHEDULE STUDIO</span>
          <h2 className={styles.title}>&#xac70;&#xb798;&#xcc98; &#xc77c;&#xc815;</h2>
          <p className={styles.subtitle}>
            <code>CSCS.py</code> \ud575\uc2ec \ud750\ub984\uc744 \uc6f9\uc73c\ub85c \uc62e\uacbc\uc2b5\ub2c8\ub2e4. \uae30\uc900 \ud30c\uc77c \uac00\uacf5,
            \uc804\ub0a0 \uc77c\uc815 \ubcd1\ud569, \uc785\uace0 \uae30\uc900 \uc0ad\uc81c, Sheet1 \ubb38\uc790 \uc0dd\uc131,
            Sheet2 \uc77c\uc815 \ubbf8\ub9ac\ubcf4\uae30\uc640 \ub2e4\uc6b4\ub85c\ub4dc\uae4c\uc9c0 \ud55c \ud654\uba74\uc5d0\uc11c \ucc98\ub9ac\ud569\ub2c8\ub2e4.
          </p>
        </div>
        <div className={styles.heroStats}>
          <div className={styles.statCard}>
            <strong>{sheet2Rows.length}</strong>
            <span>Sheet2 \ud589</span>
          </div>
          <div className={styles.statCard}>
            <strong>{Math.max(sheet1Rows.length - 1, 0)}</strong>
            <span>\ubb38\uc790 \ub300\uc0c1</span>
          </div>
        </div>
      </section>

      <section className={styles.controlGrid}>
        <div className={styles.card}>
          <div className={styles.cardHead}>
            <div>
              <h3 className={styles.cardTitle}><FileSpreadsheet size={18} /> &#xd30c;&#xc77c; &#xc900;&#xbe44;</h3>
              <p className={styles.cardDesc}>&#xae30;&#xc900; &#xd30c;&#xc77c;, &#xbcd1;&#xd569; &#xd30c;&#xc77c;, &#xc785;&#xace0; &#xd30c;&#xc77c;&#xc744; &#xc21c;&#xc11c;&#xb300;&#xb85c; &#xb123;&#xc744; &#xc218; &#xc788;&#xc2b5;&#xb2c8;&#xb2e4;.</p>
            </div>
          </div>
          <div className={styles.fieldGrid}>
            <div className={styles.fileField}>
              <span>&#xae30;&#xc900; &#xd30c;&#xc77c;</span>
              <label className={styles.fileInput}>
                <input type="file" accept=".xls,.xlsx,.xlsm" onChange={(e) => setBaseFile(e.target.files?.[0] ?? null)} />
                {baseFile ? baseFile.name : '\ub2f9\uc77c \ubc1c\uc8fc \ud30c\uc77c \uc120\ud0dd'}
              </label>
              <em>{baseFile ? baseFile.name : '\ub2f9\uc77c \ubc1c\uc8fc \ud30c\uc77c \uc120\ud0dd'}</em>
            </div>
            <div className={styles.fileField}>
              <span>&#xbcd1;&#xd569; &#xd30c;&#xc77c;</span>
              <label className={styles.fileInput}>
                <input type="file" accept=".xls,.xlsx,.xlsm" onChange={(e) => setMergeFile(e.target.files?.[0] ?? null)} />
                {mergeFile ? mergeFile.name : '\uc804\ub0a0 \uc77c\uc815 \ud30c\uc77c \uc120\ud0dd'}
              </label>
              <em>{mergeFile ? mergeFile.name : '\uc804\ub0a0 \uc77c\uc815 \ud30c\uc77c \uc120\ud0dd'}</em>
            </div>
            <div className={styles.fileField}>
              <span>&#xc785;&#xace0; &#xd30c;&#xc77c;</span>
              <label className={styles.fileInput}>
                <input type="file" accept=".xls,.xlsx,.xlsm" onChange={(e) => setIncomingFile(e.target.files?.[0] ?? null)} />
                {incomingFile ? incomingFile.name : '\uc120\ud0dd \uc2dc (A,F) \uae30\uc900 \uc0ad\uc81c \ubc18\uc601'}
              </label>
              <em>{incomingFile ? incomingFile.name : '\uc120\ud0dd \uc2dc (A,F) \uae30\uc900 \uc0ad\uc81c \ubc18\uc601'}</em>
            </div>
          </div>
          <div className={styles.actionRow}>
            <button className={styles.primaryBtn} onClick={handleBaseProcess} disabled={loading}>
              <Sparkles size={16} />
              &#xae30;&#xc900; &#xd30c;&#xc77c; &#xac00;&#xacf5;
            </button>
            <button className={styles.secondaryBtn} onClick={handleMerge} disabled={loading}>
              <GitMerge size={16} />
              &#xbcd1;&#xd569; &#xbc18;&#xc601;
            </button>
            <button className={styles.secondaryBtn} onClick={handleRunAll} disabled={loading}>
              <CalendarDays size={16} />
              &#xd1b5;&#xd569; &#xc2e4;&#xd589;
            </button>
            <button className={styles.secondaryBtn} onClick={handleDownload} disabled={loading}>
              <Download size={16} />
              &#xacb0;&#xacfc; &#xb2e4;&#xc6b4;&#xb85c;&#xb4dc;
            </button>
          </div>
        </div>

        <div className={styles.card}>
          <div className={styles.cardHead}>
            <div>
              <h3 className={styles.cardTitle}><CalendarDays size={18} /> &#xc77c;&#xc815; &#xc124;&#xc815;</h3>
              <p className={styles.cardDesc}>&#xae30;&#xc900; &#xb0a0;&#xc9dc;&#xc640; Sheet1 &#xbb38;&#xc790; &#xba38;&#xb9ac;&#xb9d0;/&#xb9c8;&#xbb34;&#xb9ac;&#xb97c; &#xbc14;&#xb85c; &#xbc14;&#xafc0; &#xc218; &#xc788;&#xc2b5;&#xb2c8;&#xb2e4;.</p>
            </div>
          </div>
          <div className={styles.fieldGrid}>
            <label className={styles.textField}>
              <span>&#xae30;&#xc900; &#xb0a0;&#xc9dc;</span>
              <input type="date" value={baseDateText} onChange={(e) => setBaseDateText(e.target.value)} />
            </label>
            <label className={styles.textField}>
              <span>&#xbb38;&#xc790; &#xc2dc;&#xc791;</span>
              <input value={msgPrefix} onChange={(e) => setMsgPrefix(e.target.value)} placeholder={DEFAULT_PREFIX} />
            </label>
            <label className={`${styles.textField} ${styles.fullWidth}`}>
              <span>&#xbb38;&#xc790; &#xb9c8;&#xbb34;&#xb9ac;</span>
              <input value={msgSuffix} onChange={(e) => setMsgSuffix(e.target.value)} placeholder={DEFAULT_SUFFIX} />
            </label>
          </div>
          <div className={styles.noteBox}>
            <strong>&#xae30;&#xbcf8; &#xaddc;&#xce59;</strong>
            <p>&#xae30;&#xc900; &#xd30c;&#xc77c;&#xc740; 1&#xd589; &#xd5e4;&#xb354; &#xc81c;&#xc678; &#xd6c4; &#xac00;&#xacf5;&#xd569;&#xb2c8;&#xb2e4;. &#xb9c8;&#xc9c0;&#xb9c9; &#xd569;&#xacc4; &#xd589;&#xc740; &#xc81c;&#xac70;&#xd558;&#xace0;, B&#xc5f4; &#xae30;&#xc900; &#xc815;&#xb82c; &#xd6c4; &#xbcd1;&#xd569;&#xacfc; &#xbb38;&#xc790; &#xc0dd;&#xc131;&#xc744; &#xc9c4;&#xd589;&#xd569;&#xb2c8;&#xb2e4;.</p>
            <p>&#xbcd1;&#xd569;&#xc740; <code>(A,B,C,F)</code> &#xd0a4;&#xb85c; D/E&#xb97c; &#xb36e;&#xc5b4;&#xc4f0;&#xace0;, &#xc785;&#xace0; &#xd30c;&#xc77c;&#xc744; &#xb123;&#xc73c;&#xba74; <code>(A,F)</code> &#xc30d;&#xacfc; &#xc77c;&#xce58;&#xd558;&#xb294; &#xd589;&#xc744; &#xc0ad;&#xc81c;&#xd569;&#xb2c8;&#xb2e4;.</p>
            <p>Sheet1&#xc740; D&#xac00; &#xbe44;&#xc5b4; &#xc788;&#xb294; &#xd589;&#xb9cc; &#xb300;&#xc0c1;&#xc73c;&#xb85c; &#xc0dd;&#xc131;&#xb418;&#xba70;, G &#xc218;&#xb7c9;&#xacfc; H &#xbbf8;&#xc1a1;&#xd53d;&#xc5c5; &#xac12;&#xc73c;&#xb85c; &#xd488;&#xbaa9; &#xbb38;&#xad6c;&#xb97c; &#xb9cc;&#xB4ED;&#xb2c8;&#xb2e4;.</p>
          </div>
        </div>
      </section>

      <section className={styles.statusBar}>
        <span>{status}</span>
        <label className={styles.searchBox}>
          <Search size={16} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="\uac70\ub798\ucc98, \uc0c1\ud488\uba85, \uc77c\uc815 \uac80\uc0c9" />
        </label>
      </section>

      <section className={styles.previewGrid}>
        <div className={styles.previewCard}>
          <div className={styles.previewHead}>
            <h3>Sheet1 &#xbb38;&#xc790; &#xbbf8;&#xb9ac;&#xbcf4;&#xae30;</h3>
            <span>{Math.max(sheet1Rows.length - 1, 0)}\uac74</span>
          </div>
          <div className={styles.messageList}>
            {sheet1Rows.slice(1).map((row, index) => (
              <article key={`${row[0]}-${index}`} className={styles.messageCard}>
                <strong>{row[0]}</strong>
                <pre>{row[1]}</pre>
              </article>
            ))}
            {sheet1Rows.length <= 1 && <div className={styles.empty}>&#xd1b5;&#xd569; &#xc2e4;&#xd589; &#xd6c4; &#xbb38;&#xc790; &#xbbf8;&#xb9ac;&#xbcf4;&#xae30;&#xac00; &#xc0dd;&#xc131;&#xb429;&#xb2c8;&#xb2e4;.</div>}
          </div>
        </div>

        <div className={styles.previewCard}>
          <div className={styles.previewHead}>
            <h3>Sheet2 &#xc77c;&#xc815; &#xd3b8;&#xc9d1;</h3>
            <span>{filteredRows.length}\ud589</span>
          </div>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>A</th>
                  <th>B</th>
                  <th>C</th>
                  <th>D</th>
                  <th>E</th>
                  <th>F</th>
                  <th>G</th>
                  <th>H</th>
                  <th>I</th>
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
                        placeholder="\ub0a0\uc9dc \ub610\ub294 \uc774\ubc88\uc8fc\uc911"
                      />
                    </td>
                    <td>
                      <input
                        className={styles.cellInput}
                        value={toDisplayText(row.E)}
                        onChange={(e) => handleSheet2Change(row.id, 'E', e.target.value)}
                        placeholder="\ubcf4\uc870 \uc77c\uc815"
                      />
                    </td>
                    <td>{row.F}</td>
                    <td>{row.G}</td>
                    <td>{row.H}</td>
                    <td className={styles.guideCell}>{row.I}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {filteredRows.length === 0 && <div className={styles.empty}>&#xd45c;&#xc2dc;&#xd560; &#xb370;&#xc774;&#xd130;&#xac00; &#xc5c6;&#xc2b5;&#xb2c8;&#xb2e4;.</div>}
          </div>
        </div>
      </section>

      <section className={styles.ribbon}>
        <div>
          <strong>&#xbe60;&#xb978; &#xc2dc;&#xc791;</strong>
          <p>1. &#xae30;&#xc900; &#xd30c;&#xc77c; &#xac00;&#xacf5; 2. &#xbcd1;&#xd569; &#xbc18;&#xc601; 3. &#xd1b5;&#xd569; &#xc2e4;&#xd589; 4. &#xacb0;&#xacfc; &#xb2e4;&#xc6b4;&#xb85c;&#xb4dc;</p>
        </div>
        <div>
          <strong>&#xcd08;&#xae30; &#xbb38;&#xc790;</strong>
          <p>{DEFAULT_TEXT_MSG}</p>
        </div>
      </section>
    </div>
  );
}
