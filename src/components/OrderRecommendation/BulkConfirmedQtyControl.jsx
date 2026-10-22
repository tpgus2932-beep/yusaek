import { useState } from 'react';
import styles from './OrderRecommendationDashboardPage.module.css';

const MODES = [
  { value: 'set', label: '값으로 설정' },
  { value: 'percent', label: '추천발주량의 %' },
  { value: 'add', label: '현재값에 ±' },
];

function computeQty(mode, amount, item, currentQty) {
  if (mode === 'set') return Math.max(0, Math.round(amount));
  if (mode === 'percent') {
    if (item.recommended_qty == null) return currentQty;
    return Math.max(0, Math.ceil((item.recommended_qty * amount) / 100 - 1e-9));
  }
  const current = currentQty === '' ? 0 : Number(currentQty);
  return Math.max(0, Math.round(current + amount));
}

// 화면에 보이는 행(items) 전체의 확정수량을 한 번에 바꾸는 도구. 편집 상태만 바꾸므로
// 적용 후 옆의 "일괄저장"을 눌러야 서버에 저장된다.
export default function BulkConfirmedQtyControl({ items, edits }) {
  const [mode, setMode] = useState('set');
  const [amount, setAmount] = useState('');

  const apply = () => {
    const n = Number(amount);
    if (amount === '' || !Number.isFinite(n) || items.length === 0) return;
    edits.setConfirmedQtyForAll(items, (item, currentQty) => computeQty(mode, n, item, currentQty));
  };

  return (
    <>
      <select className={styles.confirmInput} value={mode} onChange={(e) => setMode(e.target.value)}>
        {MODES.map((m) => (
          <option key={m.value} value={m.value}>{m.label}</option>
        ))}
      </select>
      <input
        type="number"
        className={styles.confirmInput}
        placeholder="숫자"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
      />
      <button
        type="button"
        className={styles.rowSaveBtn}
        disabled={amount === '' || items.length === 0}
        onClick={apply}
      >
        확정수량 일괄적용 ({items.length}건)
      </button>
    </>
  );
}
