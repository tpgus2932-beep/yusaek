import XLSXStyle from 'xlsx-js-style';

// Admin > 발주 > 기성발주 가공(OrderPage.jsx)의 거래처별 엑셀 양식을 그대로 재사용한다.
// 그쪽은 업로드한 엑셀의 B열(거래처+상품명)/F열(옵션, 색상-사이즈)/G열(수량)에서 값을 뽑아 쓰지만,
// 여기서는 발주대시보드 항목 { productName(=거래처상품명), options(색상-사이즈), qty, internalName } 을
// 같은 자리에 채워 넣는다.

const SIZE_SET = new Set(['S', 'M', 'L', 'XL', '2XL', 'FREE', 'F1', 'F2']);

function parseKDGFColumn(fValue) {
  const cleaned = String(fValue || '').replace(/[[\]]/g, '').trim();
  const parts = cleaned.split('-');
  let size = '';
  let gijang = '';
  for (const part of parts) {
    const trimmed = part.trim();
    const lower = trimmed.toLowerCase();
    if (SIZE_SET.has(trimmed)) {
      size = trimmed;
    } else if (trimmed.includes('롱') || lower.includes('long')) {
      gijang = trimmed;
    } else if (trimmed.includes('숏') || lower.includes('short')) {
      gijang = trimmed;
    } else if (trimmed.includes('기본')) {
      gijang = trimmed;
    } else if (lower.includes('midi')) {
      gijang = trimmed;
    }
  }
  return { size, gijang };
}

function parseEggFColumn(fValue) {
  const cleaned = String(fValue || '').replace(/[[\]]/g, '').trim();
  const parts = cleaned.split('-');
  const color = parts[0] ? parts[0].trim() : '';
  let size = '';
  let gijang = '';
  for (let i = 1; i < parts.length; i++) {
    const trimmed = parts[i].trim();
    const lower = trimmed.toLowerCase();
    if (SIZE_SET.has(trimmed) || SIZE_SET.has(trimmed.toUpperCase())) {
      size = trimmed.toUpperCase();
    } else if (trimmed.includes('롱') || lower.includes('long')) {
      gijang = trimmed;
    } else if (trimmed.includes('숏') || lower.includes('short')) {
      gijang = trimmed;
    } else if (trimmed.includes('기본')) {
      gijang = trimmed;
    } else if (lower.includes('midi')) {
      gijang = trimmed;
    }
  }
  return { color, gijang, size };
}

function dateStr() {
  return new Date().toISOString().slice(0, 10).replace(/-/g, '');
}

function download(ws, sheetName, filenamePrefix) {
  const wb = XLSXStyle.utils.book_new();
  XLSXStyle.utils.book_append_sheet(wb, ws, sheetName);
  XLSXStyle.writeFile(wb, `${filenamePrefix}_발주_${dateStr()}.xlsx`);
}

function buildEggYolkWorkbook(items) {
  const ws = {};
  const total = items.length;
  ws['!ref'] = `A1:G${1 + total}`;
  ws['A1'] = { v: '계란속 노른자', t: 's' };
  ws['B1'] = { v: '품번', t: 's' };
  ws['C1'] = { v: '기장', t: 's' };
  ws['D1'] = { v: '색상', t: 's' };
  ws['E1'] = { v: '사이즈', t: 's' };
  ws['F1'] = { v: '수량', t: 's' };
  ws['G1'] = { v: '비고', t: 's' };

  items.forEach((item, ri) => {
    const { color, gijang, size } = parseEggFColumn(item.options);
    const rowNum = 2 + ri;
    ws[`A${rowNum}`] = { v: '유색', t: 's' };
    ws[`B${rowNum}`] = { v: item.productName, t: 's' };
    ws[`C${rowNum}`] = { v: gijang, t: 's' };
    ws[`D${rowNum}`] = { v: color, t: 's' };
    ws[`E${rowNum}`] = { v: size, t: 's' };
    ws[`F${rowNum}`] = { v: item.qty, t: 'n' };
    ws[`G${rowNum}`] = { v: '', t: 's' };
  });

  download(ws, '계란속노른자발주', '계란속노른자');
}

function buildRemindWorkbook(items) {
  const ws = {};
  const total = items.length;
  ws['!ref'] = `A1:C${1 + total}`;
  ws['A1'] = { v: '품명', t: 's' };
  ws['B1'] = { v: '색상-기장-사이즈', t: 's' };
  ws['C1'] = { v: '수량', t: 's' };

  items.forEach((item, ri) => {
    const rowNum = 2 + ri;
    ws[`A${rowNum}`] = { v: item.productName, t: 's' };
    ws[`B${rowNum}`] = { v: String(item.options || ''), t: 's' };
    ws[`C${rowNum}`] = { v: item.qty, t: 'n' };
  });

  download(ws, '리마인드발주', '리마인드');
}

function buildKDGWorkbook(items) {
  const cols = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
  const total = items.length;
  const ws = {};
  ws['!ref'] = `A1:G${1 + total}`;

  const blueStyle = { font: { bold: true }, fill: { patternType: 'solid', fgColor: { rgb: 'DDEBF7' } } };
  const redYellowStyle = { font: { bold: true, color: { rgb: 'FF0000' } }, fill: { patternType: 'solid', fgColor: { rgb: 'FFFF00' } } };

  ['품번', '기장', '사이즈', '수량'].forEach((v, i) => {
    ws[`${cols[i]}1`] = { v, t: 's', s: blueStyle };
  });
  ws['E1'] = { v: '', t: 's' };
  ws['F1'] = { v: '총수량', t: 's', s: redYellowStyle };
  ws['G1'] = { t: 'n', f: `SUM(D2:D${1 + total})`, s: redYellowStyle };

  items.forEach((item, ri) => {
    const { size, gijang } = parseKDGFColumn(item.options);
    const rowNum = 2 + ri;
    ws[`A${rowNum}`] = { v: item.productName, t: 's' };
    ws[`B${rowNum}`] = { v: gijang, t: 's' };
    ws[`C${rowNum}`] = { v: size, t: 's' };
    ws[`D${rowNum}`] = { v: item.qty, t: 'n' };
    ws[`E${rowNum}`] = { v: '', t: 's' };
    ws[`F${rowNum}`] = { v: '', t: 's' };
    ws[`G${rowNum}`] = { v: '', t: 's' };
  });

  download(ws, '케이디지발주', '케이디지');
}

function buildDomaeKimWorkbook(items) {
  const total = items.length;
  const FILL_ROWS = 200;
  const ws = {};
  ws['!ref'] = `A1:I${Math.max(1 + total, 1 + FILL_ROWS)}`;

  const thin = { style: 'thin', color: { rgb: 'CCCCCC' } };
  const border = { top: thin, bottom: thin, left: thin, right: thin };
  const hBlue = {
    font: { name: '맑은 고딕', sz: 11, color: { rgb: 'FFFFFF' }, bold: true },
    fill: { patternType: 'solid', fgColor: { rgb: '3366CC' } },
    border,
  };
  const hGreen = {
    font: { name: '맑은 고딕', sz: 11, color: { rgb: 'FFFFFF' }, bold: true },
    fill: { patternType: 'solid', fgColor: { rgb: '339966' } },
    border,
  };
  const dBlue = { fill: { patternType: 'solid', fgColor: { rgb: 'DFE6F7' } }, border };
  const dGreen = { fill: { patternType: 'solid', fgColor: { rgb: 'CCF2E3' } }, border };

  const blueCols = ['A', 'B', 'C', 'D'];
  const greenCols = ['E', 'F', 'G', 'H', 'I'];
  const headers = ['상품코드', '색상', '사이즈', '주문수량', '고객바코드', '고객상품명', '고객색상', '고객사이즈', '고객정보'];

  blueCols.forEach((col, i) => { ws[`${col}1`] = { v: headers[i], t: 's', s: hBlue }; });
  greenCols.forEach((col, i) => { ws[`${col}1`] = { v: headers[4 + i], t: 's', s: hGreen }; });

  for (let r = 2; r <= 1 + FILL_ROWS; r++) {
    blueCols.forEach((col) => { ws[`${col}${r}`] = { v: '', t: 's', s: dBlue }; });
    greenCols.forEach((col) => { ws[`${col}${r}`] = { v: '', t: 's', s: dGreen }; });
  }

  items.forEach((item, ri) => {
    const { color, size } = parseEggFColumn(item.options);
    const rowNum = 2 + ri;
    ws[`A${rowNum}`] = { v: item.productName, t: 's', s: dBlue };
    ws[`B${rowNum}`] = { v: color, t: 's', s: dBlue };
    ws[`C${rowNum}`] = { v: size, t: 's', s: dBlue };
    ws[`D${rowNum}`] = { v: item.qty, t: 'n', s: dBlue };
    ws[`E${rowNum}`] = { v: '', t: 's', s: dGreen };
    ws[`F${rowNum}`] = { v: item.internalName || '', t: 's', s: dGreen };
    ws[`G${rowNum}`] = { v: color, t: 's', s: dGreen };
    ws[`H${rowNum}`] = { v: size, t: 's', s: dGreen };
    ws[`I${rowNum}`] = { v: '유색', t: 's', s: dGreen };
  });

  download(ws, '도매킴발주', '도매킴');
}

function buildLizardStandardWorkbook(items) {
  const yellowFill = { patternType: 'solid', fgColor: { rgb: 'FFFF00' } };
  const headers = ['상호', '건물명', '도매처명', '연락처', '도매처상품명', '옵션', '수량', '비고', '전달사항'];
  const cols = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'];

  const ws = {};
  ws['!ref'] = `A1:I${2 + items.length}`;
  ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 8 } }];

  cols.forEach((col) => { ws[`${col}1`] = { v: '', t: 's' }; });
  headers.forEach((h, i) => { ws[`${cols[i]}2`] = { v: h, t: 's', s: { fill: yellowFill } }; });

  items.forEach((item, ri) => {
    const dataRow = [
      '벨류스',
      '★매장 : 디오트 지하2층 N-67,68호 ★샘플반납 : 경기도 용인시 처인구 포곡읍 둔전로59',
      '리자드스탠다드',
      '010-3019-1351',
      item.productName,
      item.options || '',
      item.qty,
      '',
      '',
    ];
    dataRow.forEach((val, ci) => {
      ws[`${cols[ci]}${3 + ri}`] = { v: String(val), t: 's' };
    });
  });

  download(ws, '리자드스탠다드발주', '리자드스탠다드');
}

export const ORDER_EXCEL_VENDORS = [
  { key: '리자드스탠다드', label: '리자드스탠다드 발주', build: buildLizardStandardWorkbook },
  { key: '케이디지', label: '케이디지 발주', build: buildKDGWorkbook },
  { key: '리마인드', label: '리마인드 발주', build: buildRemindWorkbook },
  { key: '계란속노른자', label: '계란속노른자 발주', build: buildEggYolkWorkbook },
  { key: '도매킴', label: '도매킴 발주', build: buildDomaeKimWorkbook },
];
