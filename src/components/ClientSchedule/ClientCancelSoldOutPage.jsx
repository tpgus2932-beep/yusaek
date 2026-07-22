import React, { useState } from 'react';
import { LOCAL_API_BASE as API, getAuthHeaders, handleUnauthorized } from '../../lib/api';
import styles from './ClientCancelSoldOutPage.module.css';

const ClientCancelSoldOutPage = () => {
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [checkedCodes, setCheckedCodes] = useState({}); // { [productName]: Set<code> }
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [products, setProducts] = useState([]);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [runError, setRunError] = useState('');
  const [delisting, setDelisting] = useState(false);
  const [delistResult, setDelistResult] = useState(null);
  const [delistError, setDelistError] = useState('');

  const handleSearch = async (e) => {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    setSearchError('');
    try {
      const res = await fetch(`${API}/client-cancel-soldout/cost-base/search?q=${encodeURIComponent(q)}`, {
        headers: getAuthHeaders(),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok === false) throw new Error(data?.detail || '검색에 실패했습니다.');
      const items = Array.isArray(data.items) ? data.items : [];
      setSearchResults(items);
      // 기본값: 옵션 전부 선택된 상태로 시작 (전부 취소하고 싶은 경우가 대부분)
      setCheckedCodes(
        Object.fromEntries(items.map((item) => [item.name, new Set(item.options.map((o) => o.code))]))
      );
    } catch (err) {
      setSearchError(err.message || '검색에 실패했습니다.');
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  };

  const toggleOption = (productName, code) => {
    setCheckedCodes((prev) => {
      const next = new Set(prev[productName] || []);
      if (next.has(code)) next.delete(code); else next.add(code);
      return { ...prev, [productName]: next };
    });
  };

  const addProduct = (item) => {
    const selected = checkedCodes[item.name] || new Set();
    const chosenOptions = item.options.filter((o) => selected.has(o.code));
    if (chosenOptions.length === 0) return;
    setProducts((prev) => {
      const others = prev.filter((p) => p.name !== item.name);
      return [...others, { name: item.name, options: chosenOptions }];
    });
  };

  const removeProduct = (name) => {
    setProducts((prev) => prev.filter((p) => p.name !== name));
  };

  const toPayloadProducts = () =>
    products.map((p) => ({
      name: p.name,
      options: p.options.map((o) => ({ code: o.code, product_id: o.product_id })),
    }));

  const handleRun = async () => {
    if (products.length === 0) return;
    setRunning(true);
    setRunError('');
    setResult(null);
    try {
      const res = await fetch(`${API}/client-cancel-soldout/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ products: toPayloadProducts() }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok === false) throw new Error(data?.detail || '실행에 실패했습니다.');
      setResult(data);
      setProducts([]);
    } catch (err) {
      setRunError(err.message || '실행에 실패했습니다.');
    } finally {
      setRunning(false);
    }
  };

  const handleDelistOnly = async () => {
    if (products.length === 0) return;
    setDelisting(true);
    setDelistError('');
    setDelistResult(null);
    try {
      const res = await fetch(`${API}/client-cancel-soldout/delist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ products: toPayloadProducts() }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok === false) throw new Error(data?.detail || '미진열 처리에 실패했습니다.');
      setDelistResult(data);
      setProducts([]);
    } catch (err) {
      setDelistError(err.message || '미진열 처리에 실패했습니다.');
    } finally {
      setDelisting(false);
    }
  };

  return (
    <div className={styles.page}>
      <form className={styles.searchRow} onSubmit={handleSearch}>
        <input
          className={styles.searchInput}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="상품명으로 원가베이스유 검색"
        />
        <button className={styles.searchBtn} type="submit" disabled={searching}>
          {searching ? '검색 중...' : '검색'}
        </button>
      </form>
      {searchError && <p className={styles.error}>{searchError}</p>}

      {searchResults.length > 0 && (
        <ul className={styles.resultList}>
          {searchResults.map((item) => (
            <li key={item.name} className={styles.resultCard}>
              <div className={styles.resultHeader}>
                <span>{item.name}</span>
                <button type="button" className={styles.addBtn} onClick={() => addProduct(item)}>
                  추가
                </button>
              </div>
              <div className={styles.optionChecks}>
                {item.options.map((opt) => (
                  <label key={opt.code} className={styles.optionCheckLabel}>
                    <input
                      type="checkbox"
                      checked={(checkedCodes[item.name] || new Set()).has(opt.code)}
                      onChange={() => toggleOption(item.name, opt.code)}
                    />
                    {opt.label}
                  </label>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className={styles.section}>
        <h3 className={styles.sectionTitle}>취소 대상 상품</h3>
        {products.length === 0 ? (
          <p className={styles.placeholder}>추가된 상품이 없습니다.</p>
        ) : (
          <ul className={styles.productList}>
            {products.map((p) => (
              <li key={p.name} className={styles.productItem}>
                <span>{p.name}</span>
                <span className={styles.optionCount}>{p.options.map((o) => o.label).join(', ')}</span>
                <button type="button" className={styles.removeBtn} onClick={() => removeProduct(p.name)}>
                  삭제
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className={styles.actionRow}>
          <button
            type="button"
            className={styles.runBtn}
            onClick={handleRun}
            disabled={running || delisting || products.length === 0}
          >
            {running ? '실행 중...' : '실행 (취소+미진열+문자발송)'}
          </button>
          <button
            type="button"
            className={styles.delistBtn}
            onClick={handleDelistOnly}
            disabled={running || delisting || products.length === 0}
            title="주문 취소/문자 발송 없이 선택한 옵션만 미진열 처리합니다"
          >
            {delisting ? '처리 중...' : '미진열만 처리'}
          </button>
        </div>
        {runError && <p className={styles.error}>{runError}</p>}
        {delistError && <p className={styles.error}>{delistError}</p>}
      </div>

      {delistResult && (
        <div className={styles.section}>
          <h3 className={styles.sectionTitle}>미진열 처리 결과</h3>
          <p>미진열 처리된 옵션 {delistResult.non_display_option_count}개</p>
        </div>
      )}

      {result && (
        <div className={styles.section}>
          <h3 className={styles.sectionTitle}>실행 결과</h3>
          <p>
            취소된 주문 {result.cancelled_orders.length}건 / 실패 {result.failed_orders.length}건 /
            미진열 처리 {result.non_display_option_count}개 / 품절 처리 {result.soldout_goods_count}개
          </p>
          {result.need_ezdesk_session && (
            <p className={styles.error}>
              EZDesk 세션이 만료되었습니다. 문자 발송이 안 된 건이 있으니 세션을 다시 붙여넣고 재실행해주세요.
            </p>
          )}
          {result.need_ezadmin_session && (
            <p className={styles.error}>
              EZAdmin 세션이 만료되어 남은 접수 수량을 조회하지 못했습니다. 세션을 다시 붙여넣고 확인해주세요.
            </p>
          )}
          {result.pending_counts?.length > 0 && (
            <ul className={styles.resultList}>
              {result.pending_counts.map((pc) => (
                <li key={pc.product_id} className={styles.resultItem}>
                  <span>{pc.product_id}</span>
                  <span>
                    {pc.remaining === null
                      ? `접수 조회 실패${pc.error ? `: ${pc.error}` : ''}`
                      : `남은 접수 ${pc.remaining}건`}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {result.cancelled_orders.length > 0 && (
            <ul className={styles.resultList}>
              {result.cancelled_orders.map((order) => (
                <li key={order.order_sno} className={styles.resultItem}>
                  <span>주문 {order.order_sno}</span>
                  <span>{order.product_names.join(', ')}</span>
                  <span>{order.sms_sent ? '문자 발송됨' : `문자 발송 실패${order.sms_error ? `: ${order.sms_error}` : ''}`}</span>
                </li>
              ))}
            </ul>
          )}
          {result.failed_orders.length > 0 && (
            <ul className={styles.resultList}>
              {result.failed_orders.map((fail, idx) => (
                <li key={idx} className={styles.resultItem}>
                  <span>{fail.product_name || fail.order_sno}</span>
                  <span>{fail.stage}</span>
                  <span>{fail.reason}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};

export default ClientCancelSoldOutPage;
