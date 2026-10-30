import React, { useState } from 'react';
import styles from './Dashboard.module.css';
import { LOCAL_API_BASE as API, getAuthHeaders, handleUnauthorized } from '../../lib/api';

// 입고체크의 "판단 불가" 목록. 상품코드 매칭 실패 건은 옵션을 보면서 상품을 직접 골라 저장할 수 있고,
// 저장한 매칭은 다음 입고체크부터 자동으로 쓰인다 (matchUrl: 매칭 저장 API 주소).
export default function ReceiptSkippedList({ skipped, matchUrl }) {
    const authHeaders = getAuthHeaders();
    // { [id]: { open, query, rows, loading, msg, saved } }
    const [panels, setPanels] = useState({});

    if (!skipped?.length) return null;

    const patch = (id, next) => setPanels((prev) => ({ ...prev, [id]: { ...(prev[id] || {}), ...next } }));

    const search = async (k, queryOverride) => {
        const query = (queryOverride ?? panels[k.id]?.query ?? '').trim();
        if (!query) { patch(k.id, { rows: [], msg: '검색어를 입력하세요.' }); return; }
        patch(k.id, { loading: true, msg: '' });
        try {
            const res = await fetch(`${API}/barcode/defect/search?q=${encodeURIComponent(query)}`, { headers: authHeaders });
            if (handleUnauthorized(res)) return;
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.detail || '상품 검색 실패');
            const rows = data.rows || [];
            patch(k.id, { rows, loading: false, msg: rows.length ? '' : '검색 결과가 없습니다.' });
        } catch (err) {
            patch(k.id, { rows: [], loading: false, msg: err.message || '상품 검색 실패' });
        }
    };

    const toggle = (k) => {
        const panel = panels[k.id] || {};
        if (panel.open) { patch(k.id, { open: false }); return; }
        patch(k.id, { open: true, query: panel.query ?? (k.productName || '') });
        if (!panel.rows) search(k, k.productName || '');
    };

    const save = async (k, row) => {
        try {
            const res = await fetch(matchUrl, {
                method: 'POST',
                headers: { ...authHeaders, 'Content-Type': 'application/json' },
                body: JSON.stringify({ key: k.matchKey, code: row.base_code || row.code, name: row.base_name, option: row.base_color || '' }),
            });
            if (handleUnauthorized(res)) return;
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data?.ok) throw new Error(data?.detail || '매칭 저장 실패');
            patch(k.id, { open: false, saved: `${row.base_name}${row.base_color ? ` [${row.base_color}]` : ''} (${data.code})` });
        } catch (err) {
            patch(k.id, { msg: err.message || '매칭 저장 실패' });
        }
    };

    return (
        <details open={skipped.some((k) => k.matchKey)}>
            <summary>판단 불가 {skipped.length}건</summary>
            {skipped.map((k) => {
                const panel = panels[k.id] || {};
                return (
                    <div key={k.id} style={{ fontSize: '0.8rem', padding: '0.3rem 0' }}>
                        {k.returnInvoiceNo} · {k.productName}{k.optionInfo ? ` [${k.optionInfo}]` : ''} · {k.skip_reason}
                        {k.matchKey && (
                            panel.saved ? (
                                <span style={{ marginLeft: '0.5rem', color: 'var(--d-indigo, #4f46e5)' }}>
                                    ✓ 직접 매칭됨: {panel.saved} · 다음 입고체크부터 적용
                                </span>
                            ) : (
                                <button type="button" className={styles.filterBtn} style={{ marginLeft: '0.5rem' }} onClick={() => toggle(k)}>
                                    {panel.open ? '닫기' : '직접 매칭'}
                                </button>
                            )
                        )}
                        {panel.open && !panel.saved && (
                            <div style={{ marginTop: '0.4rem', display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                                <div style={{ display: 'flex', gap: '0.4rem' }}>
                                    <input
                                        value={panel.query ?? ''}
                                        placeholder="상품명 / 옵션 검색"
                                        onChange={(e) => patch(k.id, { query: e.target.value })}
                                        onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && search(k)}
                                        style={{ flex: 1 }}
                                    />
                                    <button type="button" className={styles.filterBtn} disabled={panel.loading} onClick={() => search(k)}>
                                        {panel.loading ? '검색 중...' : '검색'}
                                    </button>
                                </div>
                                {panel.msg && <div>{panel.msg}</div>}
                                <div style={{ maxHeight: '220px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                                    {(panel.rows || []).map((row, i) => (
                                        <button
                                            key={`${row.base_code}-${i}`}
                                            type="button"
                                            className={styles.filterBtn}
                                            style={{ textAlign: 'left', whiteSpace: 'normal' }}
                                            onClick={() => save(k, row)}
                                        >
                                            <strong>{row.base_name}</strong>
                                            {row.base_color && <span> · 옵션 {row.base_color}</span>}
                                            <span style={{ opacity: 0.7 }}> · {row.base_code}{row.base_vendor ? ` · ${row.base_vendor}` : ''}</span>
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                );
            })}
        </details>
    );
}
