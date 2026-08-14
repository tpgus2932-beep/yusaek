import { useState } from 'react';
import styles from './OrderRecommendationDashboardPage.module.css';
import { LOCAL_API_BASE as API, getAuthHeaders } from '../../lib/api';

export default function DailyTableRow({ date, item }) {
  const [confirmedQty, setConfirmedQty] = useState(item.confirmed_qty ?? '');
  const [reason, setReason] = useState(item.override_reason ?? '');
  const [savedConfirmedQty, setSavedConfirmedQty] = useState(item.confirmed_qty ?? '');
  const [savedReason, setSavedReason] = useState(item.override_reason ?? '');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  const dirty = String(confirmedQty) !== String(savedConfirmedQty) || reason !== savedReason;

  const save = async () => {
    setSaving(true);
    setMessage('');
    try {
      const res = await fetch(`${API}/order-recommendation/${date}/${item.yusas_code}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({
          confirmed_qty: confirmedQty === '' ? null : Number(confirmedQty),
          override_reason: reason || null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) throw new Error(data?.detail || '저장 실패');
      setSavedConfirmedQty(confirmedQty);
      setSavedReason(reason);
      setMessage('저장됨');
    } catch (err) {
      setMessage(err.message || '저장 실패');
    } finally {
      setSaving(false);
    }
  };

  return (
    <tr>
      <td>{item.product_name || '-'}</td>
      <td>{item.yusas_code}</td>
      <td>{item.stock_qty ?? '-'}</td>
      <td>{item.expected_sales_today != null ? item.expected_sales_today.toFixed(1) : '-'}</td>
      <td>{item.incoming_qty ?? '-'}</td>
      <td>{item.ezadmin_lack_qty ?? '-'}</td>
      <td>{item.coverage_days_used != null ? `${item.coverage_days_used}일` : '-'}</td>
      <td>{item.recommended_qty ?? '-'}</td>
      <td>
        <input
          type="number"
          className={styles.confirmInput}
          value={confirmedQty}
          onChange={(e) => setConfirmedQty(e.target.value)}
        />
      </td>
      <td>
        <input
          type="text"
          className={styles.reasonInput}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </td>
      <td>
        <button type="button" className={styles.rowSaveBtn} disabled={!dirty || saving} onClick={save}>
          {saving ? '저장 중...' : '저장'}
        </button>
        {message && <span className={styles.rowMessage}>{message}</span>}
      </td>
    </tr>
  );
}
