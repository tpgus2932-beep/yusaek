import { useState } from 'react';
import styles from './OrderRecommendationDashboardPage.module.css';
import DailyTableRow from './DailyTableRow';
import { DAILY_TABLE_COLUMNS, DAILY_TABLE_LABEL_COLUMN_COUNT } from './dailyTableColumns';
import { useDailyRowEdits } from './useDailyRowEdits';
import { sumValues, formatSum } from './tableSums';

// 이 섹션은 부족수량 자리에 접수수량(pending)을 대신 채우므로("일별 데이터"와 필드명만
// 맞춘 것, toDailyRowItem 참고), 헤더 라벨도 이 섹션에서만 "접수"로 바꿔 보여준다.
const COLUMN_LABEL_OVERRIDES = { ezadmin_lack_qty: '접수' };

function toDailyRowItem(item) {
  // 일별 데이터 테이블과 같은 헤더/편집 UI를 그대로 재사용하기 위해 필드명을 맞춘다.
  // 접수수량(pending)이 부족수량 자리, 미송관리수량(misong)이 미송 자리를 대신한다.
  return {
    ...item,
    ezadmin_lack_qty: item.pending_qty,
    incoming_qty: item.misong_qty,
    coverage_days_used: item.coverage_days,
  };
}

export default function OrderRecommendationDiscoverSection({ discover }) {
  const { days, setDays, limit, setLimit, result, loading, message } = discover;
  const [sortKey, setSortKey] = useState(null);
  const [sortDir, setSortDir] = useState('desc');
  const edits = useDailyRowEdits(result?.date);

  const toggleSort = (key) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  return (
    <div>
      <p className={styles.actionMessage}>
        재고가 아직 있어서 오늘 에이블리 재고수집(IO30)에 안 잡힌 상품 중, 최근 판매 속도로 봤을 때
        재발주가 필요해지고 있는 상품을 찾습니다. 발주추천과 동일한 공식을 쓰되, 재고/접수는
        EZAdmin에서, 미송은 미송관리에서 가져옵니다. "실행" 섹션의 전체 실행 버튼을 눌러야
        조회됩니다(계산이 끝난 뒤라야 겹치지 않아서, 여기서 따로 조회하진 않습니다) — 아래 값은
        다음 전체 실행 때 적용될 설정입니다.
      </p>
      <div className={styles.backtestControls}>
        <div className={styles.backtestField}>
          <label>최근 N일 평균</label>
          <input
            type="number"
            min={1}
            className={styles.confirmInput}
            value={days}
            onChange={(e) => setDays(Number(e.target.value) || 3)}
          />
        </div>
        <div className={styles.backtestField}>
          <label>상위 N개</label>
          <input
            type="number"
            min={1}
            className={styles.confirmInput}
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value) || 150)}
          />
        </div>
        {loading && <span className={styles.dailyTableCount}>조회 중...</span>}
      </div>
      {message && <div className={styles.actionMessage}>{message}</div>}

      {result && result.items.length > 0 && (() => {
        const rows = result.items.map(toDailyRowItem);
        const sorted = sortKey
          ? [...rows].sort((a, b) => {
              const av = a[sortKey] ?? -Infinity;
              const bv = b[sortKey] ?? -Infinity;
              if (av === bv) return 0;
              const cmp = av > bv ? 1 : -1;
              return sortDir === 'asc' ? cmp : -cmp;
            })
          : rows;
        const dirtyCount = edits.dirtyCount(rows);
        return (
          <>
            <div className={styles.dailyTableToolbar}>
              <span className={styles.dailyTableCount}>{sorted.length}건</span>
              <button
                type="button"
                className={styles.rowSaveBtn}
                disabled={dirtyCount === 0 || edits.savingAll}
                onClick={() => edits.saveAll(rows)}
              >
                {edits.savingAll ? '일괄저장 중...' : `일괄저장 (${dirtyCount}건)`}
              </button>
              {edits.bulkMessage && <span className={styles.rowMessage}>{edits.bulkMessage}</span>}
            </div>
            <div className={styles.dailyTableScroll}>
              <table className={styles.dailyTable}>
                <thead>
                  <tr>
                    {DAILY_TABLE_COLUMNS.map((col) => (
                      <th key={col.key} className={styles.sortableTh} onClick={() => toggleSort(col.key)}>
                        {COLUMN_LABEL_OVERRIDES[col.key] || col.label}
                        {sortKey === col.key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
                      </th>
                    ))}
                    <th>확정수량</th>
                    <th>사유</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((item) => (
                    <DailyTableRow key={item.yusas_code} item={item} edits={edits} />
                  ))}
                </tbody>
                <tfoot>
                  <tr className={styles.sumRow}>
                    <td colSpan={DAILY_TABLE_LABEL_COLUMN_COUNT}>합계 ({sorted.length}건)</td>
                    {DAILY_TABLE_COLUMNS.slice(DAILY_TABLE_LABEL_COLUMN_COUNT).map((col) => (
                      <td key={col.key}>
                        {col.numeric ? formatSum(sumValues(sorted, (i) => i[col.key]), col.decimals || 0) : ''}
                      </td>
                    ))}
                    <td>{formatSum(sumValues(sorted, (i) => edits.getFields(i).confirmedQty))}</td>
                    <td></td>
                    <td></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </>
        );
      })()}
    </div>
  );
}
