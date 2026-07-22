import React, { useState } from 'react';
import { LOCAL_API_BASE as API, getAuthHeaders, handleUnauthorized } from '../../lib/api';
import styles from './ClientCancelSoldOutPage.module.css';

const ClientCancelSoldOutPage = () => {
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [products, setProducts] = useState([]);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [runError, setRunError] = useState('');

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
      setSearchResults(Array.isArray(data.items) ? data.items : []);
    } catch (err) {
      setSearchError(err.message || '검색에 실패했습니다.');
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  };

  const addProduct = (item) => {
    setProducts((prev) => {
      if (prev.some((p) => p.name === item.name)) return prev;
      return [...prev, item];
    });
  };

  const removeProduct = (name) => {
    setProducts((prev) => prev.filter((p) => p.name !== name));
  };

  const handleRun = async () => {
    if (products.length === 0) return;
    setRunning(true);
    setRunError('');
    setResult(null);
    try {
      const res = await fetch(`${API}/client-cancel-soldout/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ products }),
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
            <li key={item.name} className={styles.resultItem}>
              <span>{item.name}</span>
              <span className={styles.optionCount}>옵션 {item.option_codes.length}개</span>
              <button type="button" className={styles.addBtn} onClick={() => addProduct(item)}>
                추가
              </button>
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
                <span className={styles.optionCount}>옵션 {p.option_codes.length}개</span>
                <button type="button" className={styles.removeBtn} onClick={() => removeProduct(p.name)}>
                  삭제
                </button>
              </li>
            ))}
          </ul>
        )}
        <button
          type="button"
          className={styles.runBtn}
          onClick={handleRun}
          disabled={running || products.length === 0}
        >
          {running ? '실행 중...' : '실행'}
        </button>
        {runError && <p className={styles.error}>{runError}</p>}
      </div>

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
