import styles from './OrderRecommendationDashboardPage.module.css';

export default function DailyTableRow({ item, edits }) {
  const fields = edits.getFields(item);
  const dirty = edits.isDirty(item);
  const saving = edits.isRowSaving(item);
  const message = edits.rowMessage(item);

  return (
    <tr>
      <td>{item.product_name || '-'}</td>
      <td>{item.client || '-'}</td>
      <td>{item.client_product_name || '-'}</td>
      <td>{item.yusas_code}</td>
      <td>{item.stock_qty ?? '-'}</td>
      <td>{item.expected_sales_today != null ? item.expected_sales_today.toFixed(1) : '-'}</td>
      <td>{item.incoming_qty ?? '-'}</td>
      <td>{item.ezadmin_lack_qty ?? '-'}</td>
      <td>{item.ezadmin_real_lack_qty ?? '-'}</td>
      <td>{item.coverage_days_used != null ? `${item.coverage_days_used}일` : '-'}</td>
      <td>{item.recommended_qty ?? '-'}</td>
      <td>
        <input
          type="number"
          className={styles.confirmInput}
          value={fields.confirmedQty}
          onChange={(e) => edits.setField(item, 'confirmedQty', e.target.value)}
        />
      </td>
      <td>
        <input
          type="text"
          className={styles.reasonInput}
          value={fields.reason}
          onChange={(e) => edits.setField(item, 'reason', e.target.value)}
        />
      </td>
      <td>
        <button
          type="button"
          className={styles.rowSaveBtn}
          disabled={!dirty || saving}
          onClick={() => edits.saveOne(item)}
        >
          {saving ? '저장 중...' : '저장'}
        </button>
        {message && <span className={styles.rowMessage}>{message}</span>}
      </td>
    </tr>
  );
}
