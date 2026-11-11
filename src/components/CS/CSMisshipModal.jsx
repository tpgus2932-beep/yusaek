import { useEffect, useState } from 'react';
import styles from './CSPage.module.css';
import { LOCAL_API_BASE, getAuthHeaders, handleUnauthorized } from '../../lib/api';

const request = async (path, { method = 'GET', body } = {}) => {
    const res = await fetch(`${LOCAL_API_BASE}${path}`, {
        method,
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...getAuthHeaders() },
        body: body ? JSON.stringify(body) : undefined,
    });
    if (handleUnauthorized(res)) throw new Error('로그인이 만료되었습니다.');
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.detail || '요청 실패');
    return data;
};

// 상품명에서 [ ] ( ) { } 괄호와 안의 내용을 뺀다 (검색어용).
const cleanTitle = (name) => String(name || '').replace(/\[[^\]]*\]|\([^)]*\)|\{[^}]*\}/g, ' ').replace(/\s+/g, ' ').trim();

const monthStr = (offset) => {
    const d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth() + offset);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

// 한쪽 상품: 원가베이스유에서 상품명으로 찾아 고르고, 정상화 통계(이번 달·지난 달)에 그 상품이 있는지 보여준다.
function ProductPanel({ title, hint, initialQuery, panel, onChange, disabled }) {
    const [query, setQuery] = useState(initialQuery || '');
    const [results, setResults] = useState([]);
    const [searching, setSearching] = useState(false);
    const [msg, setMsg] = useState('');
    const [stats, setStats] = useState(null); // {rows:[...], loading, error}
    const picked = panel.product;

    const search = async (term = query) => {
        const q = term.trim();
        if (!q) return;
        setSearching(true);
        setMsg('');
        try {
            const data = await request(`/wonbe/search?${new URLSearchParams({ q, limit: '30' })}`);
            const rows = data.rows || [];
            setResults(rows);
            if (rows.length === 0) setMsg('원가베이스유에서 찾지 못했어요.');
        } catch (err) {
            setMsg(err.message);
        } finally {
            setSearching(false);
        }
    };

    useEffect(() => {
        if (initialQuery) search(initialQuery);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const checkStats = async (code) => {
        setStats({ loading: true, rows: [], error: '' });
        try {
            const bodies = await Promise.all(
                [monthStr(0), monthStr(-1)].map((m) =>
                    request(`/stock-check/normalization/stats?${new URLSearchParams({ month: m, q: code })}`)
                )
            );
            const rows = bodies.flatMap((b) => b.rows || []).filter((r) => String(r.code).toUpperCase() === code.toUpperCase());
            rows.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
            setStats({ loading: false, rows, error: '' });
        } catch (err) {
            setStats({ loading: false, rows: [], error: err.message });
        }
    };

    const pick = (row) => {
        const code = String(row['상품코드'] || '').trim();
        const name = String(row['상품명'] || row['상품명합'] || '').trim();
        const option = [row['색상'], row['사이즈']].filter(Boolean).join(' ');
        onChange({ ...panel, product: { code, name, option } });
        checkStats(code);
    };

    return (
        <div style={{ flex: 1, minWidth: 0, border: '1px solid var(--border-color, #e5e7eb)', borderRadius: 8, padding: 10 }}>
            <strong>{title}</strong>
            <div className={styles.hint}>{hint}</div>
            <div style={{ display: 'flex', gap: 6, margin: '6px 0' }}>
                <input
                    style={{ flex: 1, minWidth: 0 }}
                    value={query}
                    placeholder="상품명 또는 상품코드"
                    disabled={disabled}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.nativeEvent.isComposing) search();
                    }}
                />
                <button type="button" className={styles.btn} onClick={() => search()} disabled={disabled || searching || !query.trim()}>
                    {searching ? '검색 중...' : '검색'}
                </button>
            </div>
            {msg && <div className={styles.hint}>{msg}</div>}
            {!picked && results.length > 0 && (
                <div style={{ maxHeight: 180, overflowY: 'auto', fontSize: 13 }}>
                    {results.map((r) => (
                        <button
                            key={r['상품코드']}
                            type="button"
                            onClick={() => pick(r)}
                            disabled={disabled}
                            style={{ display: 'block', width: '100%', textAlign: 'left', padding: '4px 6px', border: 0, borderBottom: '1px solid #eee', background: 'transparent', cursor: 'pointer' }}
                        >
                            <b>{r['상품코드']}</b> {r['상품명'] || r['상품명합']} <span style={{ color: '#6b7280' }}>{[r['색상'], r['사이즈']].filter(Boolean).join(' ')}</span>
                        </button>
                    ))}
                </div>
            )}
            {picked && (
                <div style={{ fontSize: 13 }}>
                    <div>
                        <b>{picked.code}</b> {picked.name} <span style={{ color: '#6b7280' }}>{picked.option}</span>{' '}
                        <button type="button" className={styles.linkBtn} disabled={disabled} onClick={() => { onChange({ ...panel, product: null }); setStats(null); }}>다시 고르기</button>
                    </div>
                    <div style={{ marginTop: 6 }}>
                        <b>정상화 통계 (이번 달·지난 달)</b>
                        {stats?.loading && <div className={styles.hint}>확인 중...</div>}
                        {stats?.error && <div className={styles.error}>{stats.error}</div>}
                        {stats && !stats.loading && !stats.error && stats.rows.length === 0 && <div className={styles.hint}>정상화 내역이 없어요.</div>}
                        {stats && stats.rows.length > 0 && (
                            <ul style={{ margin: '4px 0 0', paddingLeft: 16 }}>
                                {stats.rows.slice(0, 8).map((r, i) => (
                                    <li key={`${r.ts}-${i}`}>
                                        {String(r.ts).slice(5, 16)} · {r.type === 'in' ? '입고' : '출고'} {r.qty}개 · {r.username} · {r.source_label}{r.memo ? ` · ${r.memo}` : ''}
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}

/**
 * 오배송: 원송장번호를 반품 특이사항에 '오배송'으로 등록하고,
 * 왼쪽(CS 상품)·오른쪽(실제 나간 상품)을 정상화 통계로 확인한 뒤 각각 입고/출고 처리한다 (재고메모 입력 가능).
 * orderNo: 연결된 주문번호(있으면 원송장번호를 이지어드민에서 미리 채움), goodsName: CS 상품명
 */
export default function CSMisshipModal({ orderNo, goodsName, onClose }) {
    const [invoice, setInvoice] = useState('');
    const [extra, setExtra] = useState('');
    const [lookupMsg, setLookupMsg] = useState(orderNo ? '원송장번호를 이지어드민에서 찾는 중...' : '원송장번호를 입력하세요.');
    const [registered, setRegistered] = useState(false);
    const [left, setLeft] = useState({ product: null, dir: '', qty: '1' });
    const [right, setRight] = useState({ product: null, dir: '', qty: '1' });
    const [memo, setMemo] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [results, setResults] = useState([]);

    useEffect(() => {
        const onKey = (e) => e.key === 'Escape' && !busy && onClose();
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onClose, busy]);

    useEffect(() => {
        if (!orderNo) return undefined;
        let cancelled = false;
        request('/cs/address/search', { method: 'POST', body: { order_no: orderNo } })
            .then((data) => {
                if (cancelled) return;
                const withInvoice = (data.packs || []).filter((p) => p.trans_no);
                const pick = withInvoice.find((p) => p.exact) || withInvoice[0];
                if (pick) {
                    setInvoice(String(pick.trans_no));
                    setLookupMsg(`이지어드민에서 찾음${withInvoice.length > 1 ? ` (송장 ${withInvoice.length}건 중 첫 번째, 확인 필요)` : ''}`);
                } else {
                    setLookupMsg('이지어드민에서 송장번호를 찾지 못했어요. 직접 입력해 주세요.');
                }
            })
            .catch((err) => !cancelled && setLookupMsg(`${err.message} 직접 입력해 주세요.`));
        return () => {
            cancelled = true;
        };
    }, [orderNo]);

    const register = async () => {
        const digits = invoice.replace(/\D/g, '');
        if (!digits) return setError('원송장번호를 입력하세요.');
        setBusy(true);
        setError('');
        try {
            await request('/return-special-notes/add', {
                method: 'POST',
                body: { invoice_no: digits, note: extra.trim() ? `오배송 - ${extra.trim()}` : '오배송' },
            });
            setInvoice(digits);
            setRegistered(true);
        } catch (err) {
            setError(err.message || '특이사항 등록 실패');
        } finally {
            setBusy(false);
        }
    };

    const targets = [
        { label: 'CS 상품', panel: left },
        { label: '검색한 상품', panel: right },
    ].filter((t) => t.panel.product && t.panel.dir);

    const run = async () => {
        if (targets.length === 0) return setError('입고 또는 출고할 상품을 선택하세요.');
        for (const t of targets) {
            if (!(parseInt(t.panel.qty, 10) >= 1)) return setError(`${t.label} 수량을 1 이상으로 입력하세요.`);
        }
        const summary = targets.map((t) => `${t.label} ${t.panel.product.code} ${t.panel.qty}개 ${t.panel.dir === 'in' ? '입고' : '출고'}`).join('\n');
        if (!window.confirm(`다음 작업을 진행합니다. (이지어드민 재고가 실제로 바뀝니다)\n\n${summary}\n\n진행하시겠습니까?`)) return;
        setBusy(true);
        setError('');
        setResults([]);
        const out = [];
        for (const t of targets) {
            const label = t.panel.dir === 'in' ? '입고' : '출고';
            try {
                const data = await request('/barcode/stock-adjust', {
                    method: 'POST',
                    body: { product_code: t.panel.product.code, qty: parseInt(t.panel.qty, 10), type: t.panel.dir, memo: memo.trim() },
                });
                if (data.need_session) {
                    out.push({ ok: false, text: `${t.label}: EZAdmin 세션이 없어요. 상단 EZAdmin 설정에서 세션을 등록해 주세요.` });
                    break;
                }
                out.push({ ok: true, text: `${t.label} ${t.panel.product.code} ${t.panel.qty}개 ${label} 완료` });
            } catch (err) {
                out.push({ ok: false, text: `${t.label} ${t.panel.product.code} ${label} 실패: ${err.message}` });
            }
        }
        setResults(out);
        setBusy(false);
    };

    const dirPicker = (panel, setPanel) => (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
            {[['', '처리 안 함'], ['in', '입고'], ['out', '출고']].map(([v, text]) => (
                <label key={v || 'none'} style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
                    <input type="radio" checked={panel.dir === v} disabled={busy || !panel.product} onChange={() => setPanel({ ...panel, dir: v })} />
                    {text}
                </label>
            ))}
            <input
                type="number"
                min="1"
                style={{ width: 64 }}
                value={panel.qty}
                disabled={busy || !panel.product || !panel.dir}
                onChange={(e) => setPanel({ ...panel, qty: e.target.value })}
            />
            <span>개</span>
        </div>
    );

    return (
        <div className={styles.modalOverlay} onClick={busy ? undefined : onClose}>
            <div className={styles.modal} style={{ maxWidth: 880, width: '95vw' }} role="dialog" aria-label="오배송" onClick={(e) => e.stopPropagation()}>
                <div className={styles.modalHead}>
                    <strong>오배송 특이사항 등록</strong>
                    {orderNo && <span className={styles.modalSub}>주문번호 {orderNo}</span>}
                    <button type="button" className={styles.modalClose} onClick={onClose} disabled={busy} aria-label="닫기">×</button>
                </div>
                <div className={styles.modalBody}>
                    <div className={styles.purchaseReturnForm}>
                        <label>
                            원송장번호
                            <input value={invoice} onChange={(e) => setInvoice(e.target.value)} disabled={busy || registered} />
                        </label>
                        <div className={styles.hint}>{lookupMsg}</div>
                        {!registered ? (
                            <>
                                <label>
                                    추가 메모 (선택)
                                    <input value={extra} placeholder="비워두면 '오배송'으로만 등록돼요." onChange={(e) => setExtra(e.target.value)} disabled={busy} />
                                </label>
                                <div className={styles.replyActions}>
                                    <button type="button" className={styles.btn} onClick={onClose} disabled={busy}>취소</button>
                                    <button type="button" className={styles.btn} onClick={register} disabled={busy}>
                                        {busy ? '등록 중...' : '반품 특이사항에 오배송 등록'}
                                    </button>
                                </div>
                            </>
                        ) : (
                            <div>✔ 반품 특이사항에 송장 {invoice} 을(를) &lsquo;오배송&rsquo;으로 등록했어요.</div>
                        )}
                        {error && <div className={styles.error}>{error}</div>}
                    </div>

                    {registered && (
                        <div style={{ marginTop: 12 }}>
                            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                                <div style={{ flex: 1, minWidth: 0 }}>
                                    <ProductPanel
                                        title="CS 상품 (주문한 상품)"
                                        hint="정상화 통계에 이 상품이 있는지 확인해요."
                                        initialQuery={cleanTitle(goodsName)}
                                        panel={left}
                                        onChange={setLeft}
                                        disabled={busy}
                                    />
                                    {dirPicker(left, setLeft)}
                                </div>
                                <div style={{ flex: 1, minWidth: 0 }}>
                                    <ProductPanel
                                        title="검색한 상품 (실제 나간 상품)"
                                        hint="원가베이스유에서 상품명을 찾아 고르세요."
                                        initialQuery=""
                                        panel={right}
                                        onChange={setRight}
                                        disabled={busy}
                                    />
                                    {dirPicker(right, setRight)}
                                </div>
                            </div>
                            <label style={{ display: 'block', marginTop: 10 }}>
                                재고메모
                                <input
                                    style={{ width: '100%' }}
                                    maxLength={100}
                                    value={memo}
                                    disabled={busy}
                                    placeholder="이지어드민 재고 입고/출고 메모 (선택)"
                                    onChange={(e) => setMemo(e.target.value)}
                                />
                            </label>
                            {results.map((r, i) => (
                                <div key={i} className={r.ok ? styles.hint : styles.error}>{r.text}</div>
                            ))}
                            <div className={styles.replyActions} style={{ marginTop: 8 }}>
                                <button type="button" className={styles.btn} onClick={onClose} disabled={busy}>닫기</button>
                                <button type="button" className={styles.btn} onClick={run} disabled={busy || targets.length === 0}>
                                    {busy ? '처리 중...' : '입출고 실행'}
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
