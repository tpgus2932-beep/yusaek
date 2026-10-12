import React, { useEffect, useRef, useState } from 'react';
import styles from './CollaborationMenuPage.module.css';
import { LOCAL_API_BASE, getAuthHeaders, handleUnauthorized } from '../../lib/api';

const POLL_MS = 2500;

const sumQty = (items) => items.reduce((sum, it) => sum + (Number(it.qty) || 0), 0);

const candidateLabel = (c) =>
  [c['거래처상품명'] || c['상품명합'], c['색상'], c['사이즈']].filter(Boolean).join(' / ');

// 영수증 사진 -> (Windows OCR + ChatGPT 고스트워커) -> 상품 리스트 -> 원가베이스유 DB 매칭.
// 사진을 여러 장 올리면 사진마다 버튼이 생기고(서버가 한 장씩 순서대로 분석), 버튼을 누르면 그 사진의
// 리스트가 뜬다. 한 번 담은 상품은 서버에 매칭이 저장돼서 다음 영수증에서는 다시 매칭하지 않는다.
export default function ReceiptOcrPanel({ onAdd, onPrint }) {
  const [ghostRunning, setGhostRunning] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [message, setMessage] = useState('');
  // { id, name, status: 'analyzing'|'done'|'failed', step, error, items }
  const [receipts, setReceipts] = useState([]);
  const [openId, setOpenId] = useState(null);
  const timersRef = useRef({});
  const nextIdRef = useRef(1);

  const api = async (path, options = {}) => {
    const res = await fetch(`${LOCAL_API_BASE}/receipt${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders(), ...(options.headers || {}) },
    });
    if (handleUnauthorized(res)) throw new Error('로그인이 필요합니다.');
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.detail || '요청에 실패했습니다.');
    return data;
  };

  const refreshGhost = async () => {
    try {
      setGhostRunning(Boolean((await api('/ghost/status')).running));
    } catch {
      setGhostRunning(false);
    }
  };

  useEffect(() => {
    refreshGhost();
    const timers = timersRef.current;
    return () => Object.values(timers).forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updateReceipt = (id, patch) => {
    setReceipts((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };

  const launchGhost = async () => {
    try {
      setLaunching(true);
      setMessage('고스트워커(Chrome)를 여는 중입니다...');
      await api('/ghost/launch', { method: 'POST' });
      setGhostRunning(true);
      setMessage('고스트워커가 실행됐습니다. ChatGPT에 로그인된 상태인지 확인한 뒤 영수증 사진을 올리세요.');
    } catch (error) {
      setMessage(error.message);
    } finally {
      setLaunching(false);
    }
  };

  const pollJob = (id, jobId) => {
    timersRef.current[id] = setTimeout(async () => {
      try {
        const job = await api(`/parse/${jobId}`);
        if (job.status === 'done') {
          updateReceipt(id, {
            status: 'done',
            step: '',
            items: (job.items || []).map((it) => ({ ...it, selected: it.product_code || '' })),
          });
        } else if (job.status === 'failed') {
          updateReceipt(id, { status: 'failed', step: '', error: job.error || '분석에 실패했습니다.' });
        } else {
          updateReceipt(id, { step: job.step || '' });
          pollJob(id, jobId);
        }
      } catch (error) {
        updateReceipt(id, { status: 'failed', step: '', error: error.message });
      }
    }, POLL_MS);
  };

  const analyzeFile = async (file) => {
    const id = nextIdRef.current;
    nextIdRef.current += 1;
    setReceipts((prev) => [...prev, { id, name: file.name || `사진 ${id}`, status: 'analyzing', step: '대기', error: '', items: [] }]);
    try {
      const image = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('사진을 읽을 수 없습니다.'));
        reader.readAsDataURL(file);
      });
      const data = await api('/parse', { method: 'POST', body: JSON.stringify({ image }) });
      pollJob(id, data.job_id);
    } catch (error) {
      updateReceipt(id, { status: 'failed', step: '', error: error.message });
      refreshGhost();
    }
  };

  const addFiles = (files) => {
    const images = [...(files || [])].filter((f) => f.type.startsWith('image/'));
    if (!images.length) return;
    setMessage('');
    images.forEach(analyzeFile);
  };

  // 이 탭 어디서든 Ctrl+V로 클립보드의 이미지를 추가한다(텍스트 붙여넣기는 건드리지 않는다).
  const addFilesRef = useRef(addFiles);
  addFilesRef.current = addFiles;
  useEffect(() => {
    const onPaste = (e) => {
      const images = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
      if (!images.length) return;
      e.preventDefault();
      addFilesRef.current(images);
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, []);

  const pasteFromClipboard = async () => {
    try {
      const clipItems = await navigator.clipboard.read();
      const files = [];
      for (const item of clipItems) {
        const type = item.types.find((t) => t.startsWith('image/'));
        if (type) {
          const blob = await item.getType(type);
          files.push(new File([blob], `붙여넣기.${type.split('/')[1] || 'png'}`, { type }));
        }
      }
      if (!files.length) {
        setMessage('클립보드에 이미지가 없습니다.');
        return;
      }
      addFiles(files);
    } catch {
      setMessage('클립보드를 읽지 못했습니다. 사진을 복사한 뒤 Ctrl+V를 눌러주세요.');
    }
  };

  const select = (receiptId, index, code) => {
    setReceipts((prev) => prev.map((r) => (r.id !== receiptId ? r : {
      ...r,
      items: r.items.map((it, i) => (i === index ? { ...it, selected: code } : it)),
    })));
  };

  const setMemo = (receiptId, index, memo) => {
    setReceipts((prev) => prev.map((r) => (r.id !== receiptId ? r : {
      ...r,
      items: r.items.map((it, i) => (i === index ? { ...it, memo } : it)),
    })));
  };

  const addItem = async (receiptId, index) => {
    const it = receipts.find((r) => r.id === receiptId)?.items[index];
    if (!it?.selected || it.added) return;
    const cand = (it.candidates || []).find((c) => c['상품코드'] === it.selected);
    onAdd(
      {
        product_code: it.selected,
        product_name: cand?.['상품명'] || cand?.['상품명합'] || it.name,
        supply_product_name: '',
        client_product_name: cand?.['거래처상품명'] || it.name,
        options: cand ? [cand['색상'], cand['사이즈']].filter(Boolean).join(' ') : it.option,
        store_name: '',
      },
      it.qty,
      it.memo || '',
      receiptId,
    );
    setReceipts((prev) => prev.map((r) => (r.id !== receiptId ? r : {
      ...r,
      items: r.items.map((x, i) => (i === index ? { ...x, added: true } : x)),
    })));
    try {
      await api('/match', { method: 'POST', body: JSON.stringify({ match_key: it.match_key, product_code: it.selected }) });
    } catch {
      // 매칭 기억 저장에 실패해도 담기 자체는 이미 끝났다.
    }
  };

  // 추천 매칭이 없거나 틀릴 때: 원가베이스유 상품 검색(/wonbe/search)과 같은 방식으로 직접 찾아 매칭한다.
  const [searchTarget, setSearchTarget] = useState(null); // { receiptId, index }
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searchMessage, setSearchMessage] = useState('');

  const runSearch = async (query) => {
    const q = query.trim();
    if (!q) {
      setSearchMessage('검색어를 입력하세요.');
      return;
    }
    try {
      setSearching(true);
      setSearchMessage('');
      const res = await fetch(`${LOCAL_API_BASE}/wonbe/search?${new URLSearchParams({ q, limit: '50' })}`, {
        headers: getAuthHeaders(),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) throw new Error(data.detail || '원가베이스유 검색에 실패했습니다.');
      setSearchResults(data.rows || []);
      if (!data.rows?.length) setSearchMessage('검색 결과가 없습니다.');
      return (data.rows || []).length;
    } catch (error) {
      setSearchResults([]);
      setSearchMessage(error.message);
      return 0;
    } finally {
      setSearching(false);
    }
  };

  const openSearch = async (receiptId, index, item) => {
    if (searchTarget?.receiptId === receiptId && searchTarget.index === index) {
      setSearchTarget(null);
      return;
    }
    const initial = [item.name, ...String(item.option || '').split('/'), item.length].filter(Boolean).join(' ');
    setSearchTarget({ receiptId, index });
    setSearchQuery(initial);
    setSearchResults([]);
    setSearchMessage('');
    const found = await runSearch(initial);
    // 색상명이 DB와 다르면(딥브라운 vs (기모)브라운) 결과가 0이므로, 색상을 뺀 검색어로 한 번 더 찾아준다.
    const color = String(item.option || '').split('/')[0].trim();
    if (!found && color) {
      const relaxed = initial.replace(color, '').replace(/\s+/g, ' ').trim();
      setSearchQuery(relaxed);
      await runSearch(relaxed);
    }
  };

  // 검색 결과를 고르면 바로 매칭을 저장한다 - 다음 영수증부터는 이 상품으로 자동 매칭된다.
  const pickSearchResult = async (receiptId, index, row) => {
    const it = receipts.find((r) => r.id === receiptId)?.items[index];
    if (!it) return;
    setReceipts((prev) => prev.map((r) => (r.id !== receiptId ? r : {
      ...r,
      items: r.items.map((x, i) => {
        if (i !== index) return x;
        const exists = (x.candidates || []).some((c) => c['상품코드'] === row['상품코드']);
        return {
          ...x,
          candidates: exists ? x.candidates : [row, ...(x.candidates || [])],
          selected: row['상품코드'],
          fuzzy: false,
          matched_before: true,
        };
      }),
    })));
    setSearchTarget(null);
    try {
      await api('/match', { method: 'POST', body: JSON.stringify({ match_key: it.match_key, product_code: row['상품코드'] }) });
    } catch {
      setMessage('매칭 저장에 실패했습니다. 이번 담기에는 적용되지만 다음 영수증에는 기억되지 않을 수 있습니다.');
    }
  };

  const addAll = async (receiptId) => {
    const target = receipts.find((r) => r.id === receiptId);
    if (!target) return;
    for (let i = 0; i < target.items.length; i += 1) {
      await addItem(receiptId, i);
    }
  };

  const openReceipt = receipts.find((r) => r.id === openId);

  return (
    <section className={styles.card}>
      <div className={styles.cardHeader}>
        <div>
          <h3 className={styles.cardTitle}>영수증 사진으로 담기</h3>
          <p className={styles.cardHint}>
            영수증 사진을 여러 장 올리면 사진마다 버튼이 생기고, 버튼을 누르면 읽은 상품 리스트가 뜹니다.
            한 번 담은 상품은 다음 영수증에서 다시 매칭하지 않습니다. (파일 선택, 또는 사진을 복사한 뒤 이 화면에서 Ctrl+V)
          </p>
        </div>
      </div>

      <div className={styles.headerActions}>
        <button type="button" className={styles.secondaryBtn} onClick={launchGhost} disabled={launching || ghostRunning}>
          {launching ? '실행 중...' : ghostRunning ? '고스트워커 실행됨' : '고스트워커 실행'}
        </button>
        <button type="button" className={styles.secondaryBtn} onClick={pasteFromClipboard}>
          클립보드 사진 붙여넣기 (Ctrl+V)
        </button>
        <input
          type="file"
          accept="image/*"
          multiple
          onChange={(e) => {
            addFiles(e.target.files);
            e.target.value = '';
          }}
        />
      </div>
      {message && <p className={styles.cardHint} style={{ marginTop: '0.5rem' }}>{message}</p>}

      {receipts.length > 0 && (
        <div className={styles.headerActions} style={{ marginTop: '0.5rem', flexWrap: 'wrap' }}>
          {receipts.map((r, idx) => {
            const state = r.status === 'analyzing' ? ` (분석 중${r.step ? `: ${r.step}` : ''})`
              : r.status === 'failed' ? ' (실패)' : ` (${r.items.length}건 / ${sumQty(r.items)}개)`;
            return (
              <button
                key={r.id}
                type="button"
                className={r.id === openId ? styles.primaryBtn : styles.secondaryBtn}
                onClick={() => setOpenId(r.id === openId ? null : r.id)}
                title={r.name}
              >
                {`사진 ${idx + 1}${state}`}
              </button>
            );
          })}
        </div>
      )}

      {openReceipt && openReceipt.status === 'analyzing' && (
        <p className={styles.cardHint} style={{ marginTop: '0.5rem' }}>분석 중입니다. 끝나면 이 자리에 리스트가 표시됩니다.</p>
      )}
      {openReceipt && openReceipt.status === 'failed' && (
        <p className={styles.cardHint} style={{ marginTop: '0.5rem' }}>{openReceipt.error}</p>
      )}
      {openReceipt && openReceipt.status === 'done' && (
        <div style={{ marginTop: '0.75rem', overflowX: 'auto' }}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>영수증 상품</th><th>수량</th><th>매칭 상품</th><th>요청메모</th><th />
              </tr>
            </thead>
            <tbody>
              {openReceipt.items.map((it, i) => {
                const searchOpen = searchTarget?.receiptId === openReceipt.id && searchTarget.index === i;
                return (
                  <React.Fragment key={`${it.match_key}-${i}`}>
                    <tr>
                      <td>{[it.name, it.option, it.length].filter(Boolean).join(' / ')}</td>
                      <td>{it.qty}</td>
                      <td>
                        <select value={it.selected} onChange={(e) => select(openReceipt.id, i, e.target.value)}>
                          <option value="">
                            {it.candidates?.length ? (it.fuzzy ? '후보 선택(색상 불일치)' : '선택') : '후보 없음'}
                          </option>
                          {(it.candidates || []).map((c) => (
                            <option key={c['상품코드']} value={c['상품코드']}>{candidateLabel(c)}</option>
                          ))}
                        </select>
                        <button
                          type="button"
                          className={styles.secondaryBtn}
                          style={{ marginLeft: '0.35rem' }}
                          onClick={() => openSearch(openReceipt.id, i, it)}
                        >
                          검색
                        </button>
                        {it.matched_before && <span className={styles.cardHint}> (이전 매칭)</span>}
                      </td>
                      <td>
                        <input
                          className={styles.textInput}
                          value={it.memo || ''}
                          disabled={it.added}
                          onChange={(e) => setMemo(openReceipt.id, i, e.target.value)}
                          placeholder="요청메모"
                        />
                      </td>
                      <td>
                        <button
                          type="button"
                          className={styles.secondaryBtn}
                          disabled={!it.selected || it.added}
                          onClick={() => addItem(openReceipt.id, i)}
                        >
                          {it.added ? '담김' : '담기'}
                        </button>
                      </td>
                    </tr>
                    {searchOpen && (
                      <tr>
                        <td colSpan={5}>
                          <div style={{ display: 'flex', gap: '0.5rem' }}>
                            <input
                              className={styles.textInput}
                              value={searchQuery}
                              onChange={(e) => setSearchQuery(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  e.preventDefault();
                                  runSearch(searchQuery);
                                }
                              }}
                              placeholder="상품코드 / 상품명 / 색상 / 사이즈 (공백으로 여러 단어)"
                              autoFocus
                            />
                            <button type="button" className={styles.primaryBtn} onClick={() => runSearch(searchQuery)} disabled={searching}>
                              {searching ? '검색 중...' : '검색'}
                            </button>
                          </div>
                          {searchMessage && <p className={styles.cardHint}>{searchMessage}</p>}
                          {searchResults.length > 0 && (
                            <div style={{ maxHeight: 220, overflowY: 'auto', marginTop: '0.4rem' }}>
                              {searchResults.map((row) => (
                                <button
                                  key={row['상품코드']}
                                  type="button"
                                  className={styles.secondaryBtn}
                                  style={{ display: 'block', width: '100%', textAlign: 'left', marginBottom: '0.2rem' }}
                                  onClick={() => pickSearchResult(openReceipt.id, i, row)}
                                >
                                  {candidateLabel(row)}
                                </button>
                              ))}
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
          <div className={styles.headerActions} style={{ marginTop: '0.5rem' }}>
            <button type="button" className={styles.secondaryBtn} onClick={() => addAll(openReceipt.id)}>
              매칭된 항목 모두 담기
            </button>
            <button
              type="button"
              className={styles.secondaryBtn}
              disabled={!openReceipt.items.some((it) => it.added)}
              onClick={() => onPrint(openReceipt.items.filter((it) => it.added).map((it) => it.selected))}
              title="이 사진에서 담은 상품들의 바코드 라벨을 출력합니다"
            >
              {`담은 항목 바코드 출력 (${openReceipt.items.filter((it) => it.added).length}건)`}
            </button>
            <span className={styles.cardHint} style={{ alignSelf: 'center', fontWeight: 600 }}>
              {`합계 ${sumQty(openReceipt.items)}개 · 담김 ${sumQty(openReceipt.items.filter((it) => it.added))}개 · 남음 ${sumQty(openReceipt.items.filter((it) => !it.added))}개`}
            </span>
          </div>
        </div>
      )}
    </section>
  );
}
