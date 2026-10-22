import JsBarcode from 'jsbarcode';

// EZAdmin 전표 없이 상품명/옵션/(거래처상품명)/상품코드로 40x30mm 라벨을 직접 그려 인쇄한다.
// 간단입고(CollaborationMenuPage)의 바코드 출력과 같은 모양이다.
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

function buildBarcodeSvgMarkup(text) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  try {
    JsBarcode(svg, String(text), {
      format: 'CODE128',
      width: 2.3,
      height: 40,
      displayValue: false,
      margin: 0,
    });
  } catch {
    return '';
  }
  return svg.outerHTML;
}

// labels: [{ title, clientLine, option, code }]
export function printProductLabels(labels) {
  const valid = labels.filter((l) => l.code);
  if (!valid.length) return false;
  const cardsHtml = valid.map((l) => `
    <div class="card">
        <div class="title">${escapeHtml(l.title)}</div>
        <div class="option"${l.option ? '' : ' style="visibility:hidden"'}>${l.option ? escapeHtml(l.option) : '-'}</div>
        ${l.clientLine ? `<div class="client">${escapeHtml(l.clientLine)}</div>` : ''}
        <div class="barcode">${buildBarcodeSvgMarkup(l.code)}</div>
    </div>
  `).join('\n');

  const win = window.open('', '_blank', 'width=900,height=700');
  if (!win) return false;
  win.document.write(`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<title>바코드 인쇄</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
@page { size: 40mm 30mm; margin: 0; }
body { background: #fff; font-family: sans-serif; }
.card {
  width: 40mm; height: 30mm;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  text-align: center; overflow: hidden; padding: 1.5mm;
  page-break-after: always; break-after: page;
}
.card:last-child { page-break-after: auto; break-after: auto; }
.title { font-size: 9pt; font-weight: 700; line-height: 1.2; color: #111; }
.option { font-size: 8pt; margin-top: 0.8mm; color: #111; }
.client { font-size: 8pt; margin-top: 0.8mm; color: #111; line-height: 1.2; }
.barcode { margin-top: 1.5mm; width: 100%; }
.barcode svg { width: 100%; height: 8mm; display: block; }
</style>
</head>
<body>${cardsHtml}</body>
</html>`);
  win.document.close();
  win.focus();
  setTimeout(() => { win.print(); win.close(); }, 600);
  return true;
}
