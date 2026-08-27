import { useEffect, useMemo, useState } from 'react';
import styles from './OrderRecommendationDashboardPage.module.css';
import DailyTableRow from './DailyTableRow';
import { DAILY_TABLE_COLUMNS } from './dailyTableColumns';
import { useDailyRowEdits } from './useDailyRowEdits';
import { ORDER_EXCEL_VENDORS } from './orderExcelTemplates';
import { LOCAL_API_BASE as API, getAuthHeaders } from '../../lib/api';

// 확정수량이 아직 없으면 추천발주량(에이블리) 또는 비에이블리 부족수량을 기본값으로 보여준다
// - "추천발주량 받고 수정" 요구사항.
function excelDefaultConfirmedQty(item) {
  return item.confirmed_qty ?? item.recommended_qty ?? item.non_ably_lack_qty ?? '';
}

// 일별 데이터 테이블과 같은 헤더/컬럼(재고·예상판매량·미송·요청수량·부족수량·커버리지·추천발주량)을
// 그대로 쓰기 위해, 출처별로 다른 필드명을 DAILY_TABLE_COLUMNS 기준 이름으로 맞춘다.
function normalizeDiscoverItem(item) {
  return {
    ...item,
    ezadmin_lack_qty: item.pending_qty,
    incoming_qty: item.misong_qty,
    coverage_days_used: item.coverage_days,
  };
}

function normalizeNonAblyItem(item) {
  return {
    ...item,
    ezadmin_real_lack_qty: item.non_ably_lack_qty,
  };
}

export default function OrderRecommendationExcelOrderSection({ daily, discover }) {
  const [activeVendor, setActiveVendor] = useState(null);
  const [nonAblyItems, setNonAblyItems] = useState([]);
  const [manualItems, setManualItems] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searchMessage, setSearchMessage] = useState('');
  const [sortKey, setSortKey] = useState(null);
  const [sortDir, setSortDir] = useState('desc');
  const edits = useDailyRowEdits(daily?.date, excelDefaultConfirmedQty);

  const selectVendor = (key) => {
    setActiveVendor(key);
    setManualItems([]);
    setSearchQuery('');
    setSearchResults([]);
    setSearchMessage('');
  };

  const searchWonbe = async () => {
    if (!activeVendor) return;
    setSearching(true);
    setSearchMessage('');
    try {
      const params = new URLSearchParams({ client: activeVendor, q: searchQuery, limit: '20' });
      const res = await fetch(`${API}/order-recommendation/wonbe-search?${params}`, {
        headers: getAuthHeaders(),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) throw new Error(data?.detail || '검색 실패');
      setSearchResults(data.items || []);
      if (!data.items?.length) setSearchMessage('검색 결과가 없습니다.');
    } catch (err) {
      setSearchMessage(err.message || '검색 실패');
    } finally {
      setSearching(false);
    }
  };

  const addManualItem = (item) => {
    setManualItems((prev) => (prev.some((i) => i.yusas_code === item.yusas_code) ? prev : [...prev, item]));
  };

  const removeManualItem = (code) => {
    setManualItems((prev) => prev.filter((i) => i.yusas_code !== code));
  };

  const toggleSort = (key) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`${API}/order-recommendation/non-ably-items`, { headers: getAuthHeaders() });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.ok) setNonAblyItems(data.items || []);
      } catch {
        // 비에이블리 조회 실패는 조용히 무시 - 에이블리 항목만으로 목록이 채워진다
      }
    })();
  }, []);

  const vendorItems = useMemo(() => {
    if (!activeVendor) return [];
    const dailyItems = (daily?.items || []).filter(
      (i) => i.recommended_qty != null && i.client === activeVendor
    );
    const discoverItems = (discover.result?.items || [])
      .filter((i) => i.client === activeVendor)
      .map(normalizeDiscoverItem);
    const nonAblyForVendor = nonAblyItems
      .filter((i) => i.client === activeVendor)
      .map(normalizeNonAblyItem);

    // 에이블리와 비에이블리 양쪽에 다 있는 상품은 항목을 두 줄로 만들지 않고,
    // 비에이블리 부족수량을 에이블리 쪽 부족수량에 정보용으로 더해서 한 줄로 보여준다
    // (확정수량 기본값은 안 건드림 - top90-items에서 다시 합산할 때 이중카운팅 방지).
    const nonAblyByCode = new Map(nonAblyForVendor.map((i) => [i.yusas_code, i]));
    const ablyItems = [...dailyItems, ...discoverItems].map((item) => {
      const nonAbly = nonAblyByCode.get(item.yusas_code);
      if (!nonAbly) return item;
      return {
        ...item,
        ezadmin_real_lack_qty: (item.ezadmin_real_lack_qty || 0) + (nonAbly.non_ably_lack_qty || 0),
      };
    });

    const seen = new Set();
    const merged = [];
    for (const item of [...ablyItems, ...nonAblyForVendor, ...manualItems]) {
      if (seen.has(item.yusas_code)) continue;
      seen.add(item.yusas_code);
      merged.push(item);
    }
    return merged;
  }, [daily, discover.result, nonAblyItems, manualItems, activeVendor]);

  const sortedItems = sortKey
    ? [...vendorItems].sort((a, b) => {
        const av = a[sortKey] ?? -Infinity;
        const bv = b[sortKey] ?? -Infinity;
        if (av === bv) return 0;
        const cmp = av > bv ? 1 : -1;
        return sortDir === 'asc' ? cmp : -cmp;
      })
    : vendorItems;

  const dirtyCount = edits.dirtyCount(vendorItems);

  const downloadExcel = () => {
    const vendor = ORDER_EXCEL_VENDORS.find((v) => v.key === activeVendor);
    if (!vendor || vendorItems.length === 0) return;
    const rows = vendorItems.map((item) => {
      const fields = edits.getFields(item);
      return {
        productName: item.client_product_name || '',
        options: item.options || '',
        qty: fields.confirmedQty === '' ? 0 : Number(fields.confirmedQty),
        internalName: item.product_name || '',
      };
    });
    vendor.build(rows);
  };

  return (
    <div>
      <p className={styles.actionMessage}>
        추가된 상품 · 일별 데이터에 이미 불러와져 있는 항목과 비에이블리 재고수집 부족수량 항목 중
        거래처가 일치하는 상품만 모아서 보여줍니다. 확정수량은 추천발주량(비에이블리만 있는 상품은
        부족수량)이 기본값이고, 수정 후 저장하면 일별 데이터/추가된 상품에도 그대로 반영됩니다.
        엑셀 다운로드는 기존 발주 메뉴와 같은 양식입니다. 목록에 없는 상품은 아래에서 원가베이스유를
        검색해 직접 추가할 수 있습니다.
      </p>
      <div className={styles.backtestControls}>
        {ORDER_EXCEL_VENDORS.map((v) => (
          <button
            key={v.key}
            type="button"
            className={styles.backtestSaveBtn}
            onClick={() => selectVendor(v.key)}
            disabled={!daily}
          >
            {v.label}
          </button>
        ))}
      </div>

      {!activeVendor ? (
        <div className={styles.actionMessage}>거래처 버튼을 눌러 상품을 불러오세요.</div>
      ) : (
        <>
          <div className={styles.backtestControls}>
            <input
              type="text"
              className={styles.dailySearchInput}
              placeholder={`"${activeVendor}" 상품 검색 후 추가 (상품코드/상품명)`}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') searchWonbe(); }}
            />
            <button type="button" className={styles.backtestSaveBtn} onClick={searchWonbe} disabled={searching}>
              {searching ? '검색 중...' : '검색'}
            </button>
          </div>
          {searchMessage && <div className={styles.actionMessage}>{searchMessage}</div>}

          {searchResults.length > 0 && (
            <div className={styles.dailyTableScroll} style={{ marginBottom: '0.75rem' }}>
              <table className={styles.dailyTable}>
                <thead>
                  <tr>
                    <th>상품코드</th>
                    <th>상품명</th>
                    <th>거래처상품명</th>
                    <th>옵션</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {searchResults.map((item) => {
                    const already = vendorItems.some((i) => i.yusas_code === item.yusas_code);
                    return (
                      <tr key={item.yusas_code}>
                        <td>{item.yusas_code}</td>
                        <td>{item.product_name || '-'}</td>
                        <td>{item.client_product_name || '-'}</td>
                        <td>{item.options || '-'}</td>
                        <td>
                          <button
                            type="button"
                            className={styles.rowSaveBtn}
                            disabled={already}
                            onClick={() => addManualItem(item)}
                          >
                            {already ? '추가됨' : '추가'}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {manualItems.length > 0 && (
            <div className={styles.backtestControls}>
              <span className={styles.dailyTableCount}>수동 추가:</span>
              {manualItems.map((item) => (
                <span key={item.yusas_code} className={styles.excludedTag}>
                  {item.client_product_name || item.yusas_code}
                  <button type="button" onClick={() => removeManualItem(item.yusas_code)} title="추가 취소">
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}

          {vendorItems.length === 0 ? (
            <div className={styles.actionMessage}>"{activeVendor}" 거래처 상품이 없습니다.</div>
          ) : (
            <>
              <div className={styles.dailyTableToolbar}>
                <span className={styles.dailyTableCount}>{vendorItems.length}건</span>
                <button
                  type="button"
                  className={styles.rowSaveBtn}
                  disabled={dirtyCount === 0 || edits.savingAll}
                  onClick={() => edits.saveAll(vendorItems)}
                >
                  {edits.savingAll ? '일괄저장 중...' : `일괄저장 (${dirtyCount}건)`}
                </button>
                <button type="button" className={styles.backtestSaveBtn} onClick={downloadExcel}>
                  엑셀 다운로드
                </button>
                {edits.bulkMessage && <span className={styles.rowMessage}>{edits.bulkMessage}</span>}
              </div>
              <div className={styles.dailyTableScroll}>
                <table className={styles.dailyTable}>
                  <thead>
                    <tr>
                      {DAILY_TABLE_COLUMNS.map((col) => (
                        <th key={col.key} className={styles.sortableTh} onClick={() => toggleSort(col.key)}>
                          {col.label}
                          {sortKey === col.key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
                        </th>
                      ))}
                      <th>확정수량</th>
                      <th>사유</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedItems.map((item) => (
                      <DailyTableRow key={item.yusas_code} item={item} edits={edits} />
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
