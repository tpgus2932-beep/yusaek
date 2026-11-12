import * as XLSX from 'xlsx';

// 거래처 일정(ClientSchedulePage)과 CS 거래처 카톡 보내기가 같이 쓰는 순수 계산 함수들.

export const DEFAULT_PREFIX = '\uc548\ub155\ud558\uc138\uc694';
export const DEFAULT_SUFFIX = '일정 알 수 있을까요?';
export const DEFAULT_TEXT_MSG = '\uc624\ub298 \uc8fc\ubb38 \uac00\ub2a5\ud558\uc2e4\uae4c\uc694? \uac00\ub2a5\ud558\uc2dc\uba74 \uc77c\uc815 \ubd80\ud0c1\ub4dc\ub9bd\ub2c8\ub2e4.';
export const HEADER_SHEET1 = ['\uac70\ub798\ucc98', '\ubb38\uc790'];

export function formatInputDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function toDisplayText(value) {
  if (value == null) return '';
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return formatInputDate(value);
  }
  return String(value).trim();
}

export function toNumber(value) {
  const parsed = Number(String(value ?? '').replace(/,/g, '').trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

export function excelSerialToDate(value) {
  if (typeof value !== 'number' || value <= 0) return null;
  const parsed = XLSX.SSF.parse_date_code(value);
  if (!parsed) return null;
  return new Date(parsed.y, parsed.m - 1, parsed.d);
}

export function coerceDate(value) {
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

export function uniquePreserve(values) {
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

export function makeRowId(row, index) {
  return `${row.A}::${row.B}::${row.C}::${row.F}::${index}`;
}

export function ensureWidth(rows, width) {
  return rows.map((row) => {
    const next = Array.isArray(row) ? [...row] : [];
    while (next.length <= width) next.push('');
    return next;
  });
}

export function withIds(rows) {
  return rows.map((row, index) => ({ ...row, id: row.id || makeRowId(row, index) }));
}

export function preprocessBaseSheet(rawRows) {
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
      productCode: toDisplayText(row[8]),
    });
  });

  sheet2.sort((left, right) => left.B.localeCompare(right.B, 'ko'));
  return withIds(sheet2);
}

export function normalizeDValueForMerge(value, baseDate) {
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

export function mergeScheduleRows(baseRows, mergeRows, baseDate) {
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

export function buildItemText(row) {
  const base = [toDisplayText(row.C), toDisplayText(row.F)].filter(Boolean).join(' ').trim();
  if (!base) return '';

  const g = toNumber(row.G);
  const h = toNumber(row.H);
  if (g > 0) return `${base} ${g}\uac1c`;
  if (g === 0 && h >= 1) return `${base} \ubbf8\uc1a1\ud53d\uc5c5\uac74`;
  return '';
}

export function parseExcludedClients(text) {
  return String(text || '')
    .split(/\r?\n|,/)
    .map((value) => value.trim())
    .filter(Boolean);
}

export function matchesExcludedClient(clientName, excludedClients) {
  const name = toDisplayText(clientName);
  if (!name || excludedClients.length === 0) {
    return false;
  }
  return excludedClients.some((keyword) => name.includes(keyword));
}

export function buildSheet1AndSheet2(rows, prefix, suffix, excludedClients = []) {
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
