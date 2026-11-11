import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import styles from './CSStatsPage.module.css';
import { LOCAL_API_BASE, getAuthHeaders, handleUnauthorized } from '../../lib/api';

const TYPE_LABEL = { in: '입고', out: '출고' };

// 정상화 통계: 재고체크 정상화 + 로그확인 입고/출고 + 송장삭제 출고를 월별로 모아 본다.
const NormalizationStats = () => {
    const [month, setMonth] = useState('');
    const [q, setQ] = useState('');
    const [query, setQuery] = useState('');
    const [data, setData] = useState(null);
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const [bothOnly, setBothOnly] = useState(false);
    const [typeFilter, setTypeFilter] = useState('all'); // all | in | out
    const [viewMode, setViewMode] = useState('rows'); // rows(내역별) | products(상품별)

    const load = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            const params = new URLSearchParams();
            if (month) params.set('month', month);
            if (query) params.set('q', query);
            const res = await fetch(`${LOCAL_API_BASE}/stock-check/normalization/stats?${params}`, { headers: getAuthHeaders() });
            if (handleUnauthorized(res)) return;
            const body = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(body?.detail || '정상화 통계 조회 실패');
            setData(body);
            if (!month) setMonth(body.month);
        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    }, [month, query]);

    useEffect(() => {
        load();
    }, [load]);

    const sm = data?.summary;
    const allProducts = data?.products || [];
    const bothCodes = new Set(allProducts.filter((p) => p.both).map((p) => p.code));
    const typeOk = (t) => typeFilter === 'all' || t === typeFilter;
    // 입고만 / 출고만 보기: 상품별 집계도 해당 처리 수량이 있는 상품과 방식만 남긴다.
    const products = allProducts
        .filter((p) => (!bothOnly || p.both)
            && (typeFilter === 'all' || (typeFilter === 'in' ? p.in_qty > 0 : p.out_qty > 0)))
        .map((p) => ({
            ...p,
            in_qty: typeFilter === 'out' ? 0 : p.in_qty,
            out_qty: typeFilter === 'in' ? 0 : p.out_qty,
            by_source: (p.by_source || []).filter((b) => typeOk(b.type)),
        }));
    const rows = (data?.rows || []).filter((r) => typeOk(r.type) && (!bothOnly || bothCodes.has(r.code)));
    const shownCount = viewMode === 'rows' ? rows.length : products.length;

    return (
        <div className={styles.page}>
            <header className={styles.top}>
                <h2 className={styles.title}>정상화 통계</h2>
                <select className={styles.chip} value={month} onChange={(e) => setMonth(e.target.value)}>
                    {(data?.months || (month ? [month] : [])).map((m) => (
                        <option key={m} value={m}>{m}</option>
                    ))}
                </select>
                <input
                    className={styles.chip}
                    value={q}
                    placeholder="상품명 / 코드 / 계정 검색"
                    onChange={(e) => setQ(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && setQuery(q.trim())}
                />
                <button type="button" className={styles.chip} onClick={() => setQuery(q.trim())}>검색</button>
                <label className={styles.chip} style={{ cursor: 'pointer' }}>
                    <input type="checkbox" checked={bothOnly} onChange={(e) => setBothOnly(e.target.checked)} /> 입고·출고 모두 한 상품만 ({bothCodes.size}종)
                </label>
                <button type="button" className={styles.chip} onClick={load} disabled={loading}>
                    <RefreshCw size={14} /> 새로고침
                </button>
            </header>
            {error && <p className={styles.error}>{error}</p>}
            {data && (
                <>
                    <div className={styles.cards}>
                        <div className={styles.card}><span>{data.month} 정상화 입고</span><b>{sm.in_qty}개</b><span>{sm.in_count}건</span></div>
                        <div className={styles.card}><span>{data.month} 정상화 출고</span><b>{sm.out_qty}개</b><span>{sm.out_count}건</span></div>
                        <div className={styles.card}><span>{data.month} 상품 수</span><b>{sm.products}종</b></div>
                    </div>

                    <h3 className={styles.sub}>
                        정상화 내역 ({data.month} · {viewMode === 'rows' ? `${shownCount}건${(data.rows_total || 0) > (data.rows || []).length ? ' 이상 · 최근 1000건만 표시' : ''}` : `${shownCount}종`})
                    </h3>
                    <div className={styles.top} style={{ marginBottom: 8 }}>
                        {[['all', '전체'], ['in', '입고만'], ['out', '출고만']].map(([k, label]) => (
                            <button key={k} type="button" className={`${styles.chip} ${typeFilter === k ? styles.chipActive : ''}`} onClick={() => setTypeFilter(k)}>
                                {label}
                            </button>
                        ))}
                        <span className={styles.muted}>|</span>
                        {[['rows', '내역별'], ['products', '상품별']].map(([k, label]) => (
                            <button key={k} type="button" className={`${styles.chip} ${viewMode === k ? styles.chipActive : ''}`} onClick={() => setViewMode(k)}>
                                {label}
                            </button>
                        ))}
                    </div>

                    {viewMode === 'rows' ? (
                        <table className={styles.table}>
                            <thead>
                                <tr><th>일시</th><th>계정</th><th>정상화 방식</th><th>처리</th><th>상품명</th><th>옵션</th><th>수량</th><th>비고</th></tr>
                            </thead>
                            <tbody>
                                {rows.length === 0 && <tr><td colSpan={8}>기록 없음</td></tr>}
                                {rows.map((r, i) => (
                                    <tr key={`${r.ts}-${r.code}-${i}`}>
                                        <td>{r.ts}</td>
                                        <td>{r.username || '-'}</td>
                                        <td>{r.source_label}</td>
                                        <td style={{ color: r.type === 'in' ? '#16a34a' : '#dc2626', fontWeight: 600 }}>{TYPE_LABEL[r.type] || r.type}</td>
                                        <td>{r.name || r.code}</td>
                                        <td>{r.option}</td>
                                        <td>{r.qty}</td>
                                        <td>{[r.ref ? `송장 ${r.ref}` : '', r.memo ? `메모: ${r.memo}` : ''].filter(Boolean).join(' · ')}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    ) : (
                        <table className={styles.table}>
                            <thead>
                                <tr><th>상품코드</th><th>상품명</th><th>옵션</th><th>입고</th><th>출고</th><th>횟수</th><th>처리 순서</th><th>정상화 방식별</th></tr>
                            </thead>
                            <tbody>
                                {products.length === 0 && <tr><td colSpan={8}>기록 없음</td></tr>}
                                {products.map((p) => (
                                    <tr key={p.code}>
                                        <td>{p.code}</td><td>{p.name}</td><td>{p.option}</td>
                                        <td>{p.in_qty || ''}</td><td>{p.out_qty || ''}</td><td>{p.times}</td>
                                        <td style={p.both ? { fontWeight: 600, color: '#d97706' } : undefined}>{p.flow}</td>
                                        <td>
                                            {p.by_source.map((b) => (
                                                <div key={`${b.source}-${b.type}`} className={styles.muted}>
                                                    <span style={{ color: b.type === 'in' ? '#16a34a' : '#dc2626', fontWeight: 600 }}>{TYPE_LABEL[b.type]}</span>
                                                    {' '}{b.label} {b.qty}개 ({b.count}건)
                                                </div>
                                            ))}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                    <p className={styles.note}>로그확인 입고/출고와 송장삭제 출고는 이 기능 적용 이후 처리분부터 기록됩니다. 재고체크 정상화는 기존 이력이 함께 표시됩니다.</p>
                </>
            )}
        </div>
    );
};

export default NormalizationStats;
