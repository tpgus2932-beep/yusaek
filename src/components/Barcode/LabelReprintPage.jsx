import React, { useEffect, useRef, useState } from 'react';
import styles from './LabelReprintPage.module.css';
import { LOCAL_API_BASE as API, getAuthHeaders, handleUnauthorized } from '../../lib/api';
import { printProductLabels } from '../../lib/printProductLabels';

const rowOption = (row) => [row['색상'], row['사이즈']].filter(Boolean).join(' ');
const rowName = (row) => row['상품명'] || row['상품명합'] || '';

// 상품코드(바코드 스캔) 또는 상품명/거래처상품명+옵션 검색으로 고른 상품의 라벨을 다시 출력한다.
const LabelReprintPage = ({ onClose }) => {
  const [scanCode, setScanCode] = useState('');
  const [instantPrint, setInstantPrint] = useState(true);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [items, setItems] = useState([]); // { code, name, option, clientProductName, qty }
  const [message, setMessage] = useState({ text: '', error: false });
  const scanRef = useRef(null);

  useEffect(() => { scanRef.current?.focus(); }, []);

  const notify = (text, error = false) => setMessage({ text, error });

  const searchWonbe = async (q, limit) => {
    const params = new URLSearchParams({ q, limit: String(limit) });
    const res = await fetch(`${API}/wonbe/search?${params}`, { headers: getAuthHeaders() });
    if (handleUnauthorized(res)) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.detail || '상품 검색에 실패했습니다.');
    return data.rows || [];
  };

  // 접두어(R/K/L)와 (거래처상품명) 줄은 다른 화면과 같은 규칙으로 서버에서 받아온다.
  const buildLabels = async (list) => {
    let decorations = {};
    try {
      const res = await fetch(`${API}/order/label-decorations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ codes: [...new Set(list.map((it) => it.code))] }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data?.ok) decorations = data.decorations || {};
    } catch {
      // 꾸밈 정보 조회에 실패해도 출력은 막지 않는다.
    }
    return list.flatMap((it) => {
      const deco = decorations[it.code] || {};
      const title = deco.prefix ? `${deco.prefix} ${it.name}` : it.name;
      return Array.from({ length: Math.max(1, Number(it.qty) || 1) }, () => ({
        code: it.code, title, option: it.option, clientLine: deco.clientLine || '',
      }));
    });
  };

  const printItems = async (list) => {
    if (!list.length) { notify('출력할 상품이 없습니다.', true); return; }
    const labels = await buildLabels(list);
    if (!printProductLabels(labels)) notify('팝업이 차단되었거나 출력할 라벨이 없습니다.', true);
    else notify(`${labels.length}장 출력했습니다.`);
  };

  const addItem = (row, qty = 1) => {
    const code = String(row['상품코드'] || '').trim();
    if (!code) return;
    setItems((prev) => {
      const idx = prev.findIndex((it) => it.code === code);
      if (idx >= 0) return prev.map((it, i) => (i === idx ? { ...it, qty: it.qty + qty } : it));
      return [...prev, { code, name: rowName(row), option: rowOption(row), clientProductName: row['거래처상품명'] || '', qty }];
    });
  };

  const handleScan = async () => {
    const code = scanCode.trim();
    if (!code) return;
    setScanCode('');
    try {
      const rows = await searchWonbe(code, 20);
      if (rows === null) return;
      const hit = rows.find((r) => String(r['상품코드'] || '').trim().toLowerCase() === code.toLowerCase());
      if (!hit) { notify(`상품코드 "${code}"를 찾을 수 없습니다.`, true); return; }
      if (instantPrint) {
        await printItems([{ code: String(hit['상품코드']).trim(), name: rowName(hit), option: rowOption(hit), qty: 1 }]);
      } else {
        addItem(hit);
        notify(`${rowName(hit)} ${rowOption(hit)} 담김`.trim());
      }
    } catch (err) {
      notify(err.message, true);
    } finally {
      scanRef.current?.focus();
    }
  };

  const handleSearch = async () => {
    const q = query.trim();
    if (!q) { notify('검색어를 입력하세요.', true); return; }
    setSearching(true);
    try {
      const rows = await searchWonbe(q, 100);
      if (rows === null) return;
      setResults(rows);
      notify(rows.length ? `${rows.length}건 검색됨 - 행을 클릭하면 출력 목록에 담깁니다.` : '검색 결과가 없습니다.', !rows.length);
    } catch (err) {
      setResults([]);
      notify(err.message, true);
    } finally {
      setSearching(false);
    }
  };

  const setQty = (code, value) =>
    setItems((prev) => prev.map((it) => (it.code === code ? { ...it, qty: Math.max(1, Number(value) || 1) } : it)));
  const removeItem = (code) => setItems((prev) => prev.filter((it) => it.code !== code));

  return (
    <div className={styles.overlay} onClick={onClose}>
    <div className={styles.page} onClick={(e) => e.stopPropagation()}>
      <div className={styles.header}>
        <div>
          <div className={styles.title}>바코드 라벨 재출력</div>
          <div className={styles.subtitle}>상품코드를 스캔하거나, 상품명/거래처상품명 + 옵션으로 검색해 라벨을 다시 출력합니다.</div>
        </div>
        <button type="button" className={styles.btn} onClick={onClose}>닫기</button>
      </div>

      <div className={styles.card}>
        <div className={styles.cardTitle}>상품코드 스캔</div>
        <div className={styles.row}>
          <input
            ref={scanRef}
            className={styles.input}
            value={scanCode}
            placeholder="바코드를 스캔하거나 상품코드를 입력 후 Enter"
            onChange={(e) => setScanCode(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleScan(); }}
          />
          <label className={styles.check}>
            <input type="checkbox" checked={instantPrint} onChange={(e) => setInstantPrint(e.target.checked)} />
            스캔 즉시 출력
          </label>
        </div>
      </div>

      <div className={styles.card}>
        <div className={styles.cardTitle}>상품 검색</div>
        <div className={styles.row}>
          <input
            className={styles.input}
            value={query}
            placeholder="상품명 또는 거래처상품명 + 옵션 (예: 글로우 검정)"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleSearch(); }}
          />
          <button type="button" className={styles.btn} onClick={handleSearch} disabled={searching}>
            {searching ? '검색 중...' : '검색'}
          </button>
        </div>
        {results.length > 0 && (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr><th>상품코드</th><th>상품명</th><th>옵션</th><th>거래처</th><th>거래처상품명</th></tr>
              </thead>
              <tbody>
                {results.map((r) => (
                  <tr key={r['상품코드']} className={styles.clickable} onClick={() => addItem(r)}>
                    <td className={styles.code}>{r['상품코드']}</td>
                    <td>{rowName(r)}</td>
                    <td>{rowOption(r)}</td>
                    <td>{r['거래처']}</td>
                    <td>{r['거래처상품명']}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className={styles.card}>
        <div className={styles.cardTitle}>출력 목록 ({items.length})</div>
        {items.length === 0 ? (
          <div className={`${styles.message} ${styles.muted}`}>검색 결과를 클릭하거나 "스캔 즉시 출력"을 끄고 스캔하면 여기에 담깁니다.</div>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr><th>상품코드</th><th>상품명</th><th>옵션</th><th>수량</th><th /></tr>
              </thead>
              <tbody>
                {items.map((it) => (
                  <tr key={it.code}>
                    <td className={styles.code}>{it.code}</td>
                    <td>{it.name}</td>
                    <td>{it.option}</td>
                    <td>
                      <input
                        type="number" min="1" className={styles.qty} value={it.qty}
                        onChange={(e) => setQty(it.code, e.target.value)}
                      />
                    </td>
                    <td><button type="button" className={styles.btn} onClick={() => removeItem(it.code)}>삭제</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className={styles.row}>
          <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={!items.length} onClick={() => printItems(items)}>
            바코드 출력
          </button>
          <button type="button" className={styles.btn} disabled={!items.length} onClick={() => setItems([])}>목록 비우기</button>
        </div>
      </div>

      {message.text && <div className={`${styles.message} ${message.error ? styles.error : ''}`}>{message.text}</div>}
    </div>
    </div>
  );
};

export default LabelReprintPage;
