import { useEffect, useState } from 'react';
import styles from './OrderRecommendationDashboardPage.module.css';
import { LOCAL_API_BASE as API, getAuthHeaders } from '../../lib/api';
import { sumValues, formatSum } from './tableSums';

function vendorOf(item) {
  return (item.supplyProductName || '').split(' ')[0] || '(거래처 없음)';
}

function todayLocalDate() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// 노예김승일 > 미송관리 > 엑셀복사(copyMisongTsv)와 같은 필드 매핑(A=거래처,B=상품명,D=색상,E=사이즈,F=수량).
// 거기선 텍스트로 복사만 하지만, 여기선 그 항목들을 그대로 top90 발주 형식으로 바꿔서 등록한다.
function misongItemToTop90Item(item) {
  const supplyProductName = `${item.A || ''} ${item.B || ''}`.trim();
  const colorSize = [item.D, item.E].filter(Boolean).join('-');
  return {
    code: item.originalF || '',
    name: item.B || '',
    options: [colorSize, '(미송픽업)'].filter(Boolean).join(' '),
    supplyProductName,
    requestQty: Number(item.F) || 0,
    recommendedQtySource: 'misong_pickup',
  };
}

function matchesSearch(item, term) {
  if (!term) return true;
  const t = term.trim().toLowerCase();
  if (!t) return true;
  return (
    vendorOf(item).toLowerCase().includes(t) ||
    (item.supplyProductName || '').toLowerCase().includes(t) ||
    (item.name || '').toLowerCase().includes(t) ||
    (item.code || '').toLowerCase().includes(t)
  );
}

export default function OrderRecommendationTop90Section({ date }) {
  const [items, setItems] = useState([]);
  const [skipped, setSkipped] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(new Set());
  const [search, setSearch] = useState('');
  const [message, setMessage] = useState('');
  const [executing, setExecuting] = useState(false);
  const [execResult, setExecResult] = useState(null);
  const [excludedClients, setExcludedClients] = useState([]);
  const [excludedInput, setExcludedInput] = useState('');

  const visibleItems = items.filter((item) => matchesSearch(item, search));

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`${API}/order-recommendation/top90-excluded-clients`, {
          headers: getAuthHeaders(),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.ok) setExcludedClients(data.clients || []);
      } catch {
        // 제외 거래처 목록 로드 실패는 조용히 무시 - 빈 목록으로 시작
      }
    })();
  }, []);

  const saveExcludedClients = async (next) => {
    setExcludedClients(next);
    try {
      await fetch(`${API}/order-recommendation/top90-excluded-clients`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ clients: next }),
      });
    } catch {
      // 저장 실패해도 화면 목록은 유지 - 다음 조회 때 서버 목록으로 다시 맞춰짐
    }
  };

  const addExcludedClient = (name) => {
    const trimmed = (name || '').trim();
    if (!trimmed || excludedClients.includes(trimmed)) return;
    saveExcludedClients([...excludedClients, trimmed].sort());
    setExcludedInput('');
    setItems((prev) => prev.filter((item) => vendorOf(item) !== trimmed));
  };

  const removeExcludedClient = (name) => {
    if (!window.confirm(`"${name}"를 제외 거래처 목록에서 빼시겠습니까?\n다음 조회부터 다시 나타납니다.`)) return;
    saveExcludedClients(excludedClients.filter((c) => c !== name));
  };

  const fetchItems = async () => {
    setLoading(true);
    setMessage('');
    setExecResult(null);
    try {
      const res = await fetch(`${API}/order-recommendation/${date}/top90-items`, {
        headers: getAuthHeaders(),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) throw new Error(data?.detail || '조회 실패');
      setItems(data.items || []);
      setSkipped(data.skipped_no_client_info || []);
      setSelected(new Set());
      setSearch('');
      const skippedMsg = data.skipped_no_client_info?.length
        ? ` (거래처 정보 없어 제외 ${data.skipped_no_client_info.length}건)`
        : '';
      setMessage(`조회 완료: ${data.count}건${skippedMsg}`);
    } catch (err) {
      setMessage(err.message || '조회 실패');
    } finally {
      setLoading(false);
    }
  };

  const updateRequestQty = (code, value) => {
    setItems((prev) => prev.map((item) => (item.code === code ? { ...item, requestQty: value } : item)));
  };

  const toggleSelected = (code) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  };

  const toggleSelectAll = () => {
    const visibleCodes = visibleItems.map((i) => i.code);
    const allVisibleSelected = visibleCodes.length > 0 && visibleCodes.every((code) => selected.has(code));
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        visibleCodes.forEach((code) => next.delete(code));
      } else {
        visibleCodes.forEach((code) => next.add(code));
      }
      return next;
    });
  };

  const removeSearched = () => {
    if (!search.trim()) {
      setMessage('제거할 검색어를 입력하세요.');
      return;
    }
    const removedCodes = new Set(visibleItems.map((item) => item.code));
    if (removedCodes.size === 0) {
      setMessage('검색 결과가 없어 제거할 항목이 없습니다.');
      return;
    }
    setItems((prev) => prev.filter((item) => !removedCodes.has(item.code)));
    setSelected((prev) => {
      const next = new Set(prev);
      removedCodes.forEach((code) => next.delete(code));
      return next;
    });
    setMessage(`검색된 ${removedCodes.size}건을 목록에서 제거했습니다.`);
    setSearch('');
  };

  // 매장명 \t 주문 \t 상품명 \t 옵션 \t 수량 — 한 줄에 상품 하나씩.
  const buildTsvRows = (targetItems) => {
    const rows = [];
    for (const item of targetItems) {
      const qty = Number(item.requestQty) || 0;
      if (qty <= 0) continue;
      const supplyProductName = (item.supplyProductName || '').trim();
      if (!supplyProductName) continue;
      const spaceIdx = supplyProductName.indexOf(' ');
      const storeName = spaceIdx === -1 ? supplyProductName : supplyProductName.slice(0, spaceIdx);
      const productName = spaceIdx === -1 ? '' : supplyProductName.slice(spaceIdx + 1).trim();
      const options = (item.options || '').trim();
      rows.push([storeName, '주문', productName, options, qty].join('\t'));
    }
    return rows;
  };

  // 노예김승일 > 미송관리에 오늘 등록된 항목을 top90 발주 형식으로 조회한다.
  const fetchMisongTop90Items = async () => {
    const res = await fetch(
      `${API}/noye-kimsungil/misong/items?today=${encodeURIComponent(todayLocalDate())}`,
      { headers: getAuthHeaders() }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data?.detail || '미송관리 조회 실패');
    const misongItems = data.items || [];
    return misongItems.map(misongItemToTop90Item).filter((i) => i.requestQty > 0);
  };

  const copyTsv = async () => {
    const targetItems = items.filter((item) => selected.has(item.code) && Number(item.requestQty) > 0);
    if (targetItems.length === 0) {
      setMessage('체크되고 확정수량이 0보다 큰 항목이 없습니다.');
      return;
    }
    const rows = buildTsvRows(targetItems);
    if (rows.length === 0) {
      setMessage('복사할 항목이 없습니다.');
      return;
    }

    let misongOrderItems = [];
    try {
      misongOrderItems = await fetchMisongTop90Items();
    } catch {
      // 미송관리 조회 실패는 top90 복사 자체를 막지 않는다 — 미송픽업 행만 빠진다.
    }
    const misongRows = buildTsvRows(misongOrderItems);
    const allRows = [...rows, ...misongRows];

    const tsv = allRows.join('\n');
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(tsv);
      } else {
        const ta = document.createElement('textarea');
        ta.value = tsv;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      const misongMsg = misongRows.length ? ` (미송픽업 ${misongRows.length}행 포함)` : '';
      try {
        const recRes = await fetch(`${API}/order/main-order/record-tsv-copy`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
          body: JSON.stringify({ items: [...targetItems, ...misongOrderItems] }),
        });
        const recData = await recRes.json().catch(() => ({}));
        if (!recRes.ok || recData?.ok === false) {
          throw new Error(recData?.detail || recData?.error || '발주내역 저장 실패');
        }
        setMessage(`엑셀 복사 완료 (${allRows.length}행)${misongMsg}`);
      } catch (recErr) {
        setMessage(
          `⚠ 엑셀 복사는 완료됐지만 발주내역 저장에 실패했습니다 (${recErr.message || ''}). 다시 눌러 재시도해주세요.`
        );
      }
    } catch (err) {
      setMessage(`복사 실패: ${err.message || ''}`);
    }
  };

  const mergeExecResult = (prev, next) => ({
    success: [...(prev?.success || []), ...(next.success || [])],
    failed: [...(prev?.failed || []), ...(next.failed || [])],
  });

  const submitMisongPickupOrders = async () => {
    const misongOrderItems = await fetchMisongTop90Items();
    if (misongOrderItems.length === 0) return null;

    const execRes = await fetch(`${API}/order/main-order/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify({ items: misongOrderItems }),
    });
    const execData = await execRes.json().catch(() => ({}));
    if (!execData?.ok) throw new Error(execData?.error || '미송픽업 발주 실행 실패');
    return execData;
  };

  const executeOrders = async () => {
    const targetItems = items.filter((item) => selected.has(item.code) && Number(item.requestQty) > 0);
    if (targetItems.length === 0) {
      setMessage('체크되고 확정수량이 0보다 큰 항목이 없습니다.');
      return;
    }
    if (!window.confirm(`체크된 ${targetItems.length}건을 top90에 발주 등록합니다.\n\n계속하시겠습니까?`)) {
      return;
    }

    setExecuting(true);
    setExecResult(null);
    setMessage('');
    let combinedResult = null;
    let statusMsg = '';
    try {
      const res = await fetch(`${API}/order/main-order/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ items: targetItems }),
      });
      const data = await res.json().catch(() => ({}));
      if (!data?.ok) {
        setMessage(data?.error || '발주 실행 실패');
        return;
      }
      combinedResult = data;
      statusMsg = `발주 완료: 성공 ${data.success?.length ?? 0}개 매장 / 실패 ${data.failed?.length ?? 0}개 매장`;
      // 발주 등록에 실제로 넘어간 항목은 목록에서 지운다 — 실패한 매장 것도 top90 쪽에서
      // 수동 확인이 필요한 거라 여기 목록에 남겨봐야 다시 체크하고 또 등록될 위험만 있다.
      const executedCodes = new Set(targetItems.map((item) => item.code));
      setItems((prev) => prev.filter((item) => !executedCodes.has(item.code)));
      setSelected((prev) => {
        const next = new Set(prev);
        executedCodes.forEach((code) => next.delete(code));
        return next;
      });

      if (window.confirm('미송픽업 발주도 top90에 등록하시겠습니까?\n\n(노예김승일 > 미송관리에 오늘 등록된 항목을 그대로 넣습니다.)')) {
        try {
          const misongResult = await submitMisongPickupOrders();
          if (misongResult === null) {
            statusMsg += ' · 미송관리에 오늘 등록된 항목이 없어 미송픽업 발주는 건너뜀';
          } else {
            combinedResult = mergeExecResult(combinedResult, misongResult);
            statusMsg += ` · 미송픽업 발주 완료: 성공 ${misongResult.success?.length ?? 0}개 매장 / 실패 ${misongResult.failed?.length ?? 0}개 매장`;
          }
        } catch (err) {
          statusMsg += ` · 미송픽업 발주 실패: ${err.message || ''}`;
        }
      }

      setExecResult(combinedResult);
      setMessage(statusMsg);
    } catch (err) {
      setMessage(err.message || '발주 실행 실패');
    } finally {
      setExecuting(false);
    }
  };

  return (
    <div>
      <p className={styles.actionMessage}>
        확정수량이 있는 상품을 top90 발주 형식으로 불러옵니다. 체크한 항목만 top90에 실제로 발주가
        등록됩니다 — 조회만으로는 발주가 나가지 않습니다. 발주 등록된 항목은 목록에서 자동으로 빠집니다.
      </p>
      <div className={styles.backtestControls}>
        <button type="button" className={styles.backtestSaveBtn} onClick={fetchItems} disabled={loading}>
          {loading ? '조회 중...' : '조회'}
        </button>
        <input
          type="text"
          className={styles.dailySearchInput}
          placeholder="거래처, 상품명 또는 상품코드 검색"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button type="button" className={styles.backtestSaveBtn} onClick={removeSearched} disabled={!search.trim()}>
          검색결과 제거 ({visibleItems.length}건)
        </button>
        <button type="button" className={styles.backtestSaveBtn} onClick={copyTsv} disabled={selected.size === 0}>
          선택 항목 TSV 복사 ({selected.size}건)
        </button>
        <button
          type="button"
          className={styles.backtestSaveBtn}
          onClick={executeOrders}
          disabled={executing || selected.size === 0}
        >
          {executing ? '발주 실행 중...' : `선택 항목 발주 실행 (${selected.size}건)`}
        </button>
      </div>

      <div className={styles.backtestControls}>
        <span className={styles.dailyTableCount}>제외 거래처 (조회 시 자동 제외)</span>
        {excludedClients.map((name) => (
          <span key={name} className={styles.excludedTag}>
            {name}
            <button type="button" onClick={() => removeExcludedClient(name)} title="제외 목록에서 빼기">
              ×
            </button>
          </span>
        ))}
        <input
          type="text"
          list="top90-vendor-options"
          className={styles.dailySearchInput}
          placeholder="거래처명 입력 후 추가"
          value={excludedInput}
          onChange={(e) => setExcludedInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); addExcludedClient(excludedInput); }
          }}
        />
        <datalist id="top90-vendor-options">
          {[...new Set(items.map(vendorOf))].map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
        <button type="button" className={styles.backtestSaveBtn} onClick={() => addExcludedClient(excludedInput)} disabled={!excludedInput.trim()}>
          추가
        </button>
      </div>
      {message && <div className={styles.actionMessage}>{message}</div>}
      {execResult && (
        <div className={styles.actionMessage}>
          {execResult.success?.length > 0 && (
            <div>
              <strong>발주 성공:</strong>
              <ul>
                {execResult.success.map((s, i) => (
                  <li key={i}>
                    {s.store_name} — {s.count}건
                  </li>
                ))}
              </ul>
            </div>
          )}
          {execResult.failed?.length > 0 && (
            <div>
              <strong>발주 실패 (수동 확인 필요):</strong>
              <ul>
                {execResult.failed.map((f, i) => (
                  <li key={i}>
                    {f.store_name} — {f.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {visibleItems.length === 0 ? (
        <div className={styles.actionMessage}>
          {items.length === 0 ? '조회 버튼을 눌러 확정수량 있는 상품을 불러오세요.' : '검색 결과가 없습니다.'}
        </div>
      ) : (
        <div className={styles.dailyTableScroll}>
          <table className={styles.dailyTable}>
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    checked={
                      visibleItems.length > 0 && visibleItems.every((item) => selected.has(item.code))
                    }
                    onChange={toggleSelectAll}
                  />
                </th>
                <th>상품코드</th>
                <th>상품명</th>
                <th>공급처상품명</th>
                <th>옵션</th>
                <th>재고</th>
                <th>미송</th>
                <th>부족수량</th>
                <th>추천발주량</th>
                <th>확정수량</th>
              </tr>
            </thead>
            <tbody>
              {visibleItems.map((item) => (
                <tr key={item.code}>
                  <td>
                    <input
                      type="checkbox"
                      checked={selected.has(item.code)}
                      onChange={() => toggleSelected(item.code)}
                    />
                  </td>
                  <td>{item.code}</td>
                  <td>{item.name || '-'}</td>
                  <td>{item.supplyProductName}</td>
                  <td>{item.options || '-'}</td>
                  <td>{item.stock ?? '-'}</td>
                  <td>{item.notYetDeliv ?? '-'}</td>
                  <td>{item.lackQty ?? '-'}</td>
                  <td>{item.recommendedQty ?? '-'}</td>
                  <td>
                    <input
                      type="number"
                      className={styles.confirmInput}
                      value={item.requestQty}
                      onChange={(e) => updateRequestQty(item.code, e.target.value)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className={styles.sumRow}>
                <td colSpan={5}>합계 ({visibleItems.length}건)</td>
                <td>{formatSum(sumValues(visibleItems, (i) => i.stock))}</td>
                <td>{formatSum(sumValues(visibleItems, (i) => i.notYetDeliv))}</td>
                <td>{formatSum(sumValues(visibleItems, (i) => i.lackQty))}</td>
                <td>{formatSum(sumValues(visibleItems, (i) => i.recommendedQty))}</td>
                <td>{formatSum(sumValues(visibleItems, (i) => i.requestQty))}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {skipped.length > 0 && (
        <div className={styles.actionMessage}>
          거래처 정보가 없어 제외된 상품 {skipped.length}건: {skipped.join(', ')}
        </div>
      )}
    </div>
  );
}
