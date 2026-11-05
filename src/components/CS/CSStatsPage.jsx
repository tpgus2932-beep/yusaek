import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import styles from './CSStatsPage.module.css';
import ReturnScanStats from './ReturnScanStats';
import NormalizationStats from './NormalizationStats';
import { LOCAL_API_BASE, getAuthHeaders, handleUnauthorized } from '../../lib/api';

const PERIODS = [7, 14, 30, 90];

const fmtTime = (iso) => (iso ? iso.slice(0, 16).replace('T', ' ') : '');

const fmtDuration = (sec) => {
    const s = Math.round(sec || 0);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (h > 0) return `${h}시간 ${m}분`;
    return `${m}분`;
};

const CSStatsTab = () => {
    const [days, setDays] = useState(14);
    const [data, setData] = useState(null);
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);

    const [sessions, setSessions] = useState([]);
    const [products, setProducts] = useState([]);
    const [open, setOpen] = useState({});
    const [q, setQ] = useState('');
    const [found, setFound] = useState(null);
    const [searching, setSearching] = useState(false);

    const search = async () => {
        const term = q.trim();
        if (!term) { setFound(null); return; }
        setSearching(true);
        setError('');
        try {
            const res = await fetch(`${LOCAL_API_BASE}/cs/stats/search?q=${encodeURIComponent(term)}&days=365`, { headers: getAuthHeaders() });
            if (handleUnauthorized(res)) return;
            const body = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(body?.detail || '검색 실패');
            setFound(body);
        } catch (err) {
            setError(err.message);
        } finally {
            setSearching(false);
        }
    };

    const load = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            const get = async (path) => {
                const res = await fetch(`${LOCAL_API_BASE}/cs/${path}`, { headers: getAuthHeaders() });
                if (handleUnauthorized(res)) return null;
                const body = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(body?.detail || '통계 조회 실패');
                return body;
            };
            const [stats, sess, comp] = await Promise.all([
                get(`stats?days=${days}`),
                get(`stats/sessions?days=${Math.min(days, 90)}`),
                get(`stats/completed?days=${days}`),
            ]);
            if (!stats) return;
            setData(stats);
            setSessions(sess?.sessions || []);
            setProducts(comp?.products || []);
        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    }, [days]);

    useEffect(() => {
        load();
    }, [load]);

    return (
        <div className={styles.page}>
            <header className={styles.top}>
                <h2 className={styles.title}>CS 통계</h2>
                {PERIODS.map((p) => (
                    <button
                        key={p}
                        type="button"
                        className={`${styles.chip} ${days === p ? styles.chipActive : ''}`}
                        onClick={() => setDays(p)}
                    >
                        {p}일
                    </button>
                ))}
                <button type="button" className={styles.chip} onClick={load} disabled={loading}>
                    <RefreshCw size={14} /> 새로고침
                </button>
                <input
                    className={styles.chip}
                    value={q}
                    placeholder="수령인명 / 주문자명 / 상품명 검색"
                    onChange={(e) => setQ(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && search()}
                />
                <button type="button" className={styles.chip} onClick={search} disabled={searching}>
                    {searching ? '검색 중...' : '검색'}
                </button>
            </header>
            {error && <p className={styles.error}>{error}</p>}
            {found && (
                <>
                    <h3 className={styles.sub}>
                        완료 CS 검색 결과 ({found.total}건{found.total > found.items.length ? ` · 최근 ${found.items.length}건만 표시` : ''}, 최근 1년)
                        <button type="button" className={styles.chip} style={{ marginLeft: 8 }} onClick={() => { setFound(null); setQ(''); }}>닫기</button>
                    </h3>
                    <table className={styles.table}>
                        <thead>
                            <tr><th>완료 시각</th><th>담당자</th><th>주문자</th><th>수령인</th><th>상품명</th><th>분류</th><th>마지막 메시지</th></tr>
                        </thead>
                        <tbody>
                            {found.items.length === 0 && <tr><td colSpan={7}>검색 결과 없음</td></tr>}
                            {found.items.map((it) => (
                                <tr key={`${it.room_sno}-${it.completed_at}`}>
                                    <td>{fmtTime(it.completed_at)}</td>
                                    <td>{it.completed_by}</td>
                                    <td>{it.member_name || '-'}</td>
                                    <td>{it.receiver_name || '-'}</td>
                                    <td>{it.goods_name || '(상품 정보 없음)'}</td>
                                    <td>{it.category}</td>
                                    <td>{it.last_message}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </>
            )}
            {data && (
                <>
                    <div className={styles.cards}>
                        <div className={styles.card}><span>오늘 보내기</span><b>{data.today.completed}</b></div>
                        <div className={styles.card}><span>오늘 완료 처리</span><b>{data.today.done ?? 0}</b></div>
                        <div className={styles.card}><span>오늘 새로 들어온 CS</span><b>{data.today.new}</b></div>
                        <div className={styles.card}><span>오늘 CS 시간</span><b>{fmtDuration(data.today.work_seconds)}</b></div>
                        <div className={styles.card}><span>{days}일 CS 시간</span><b>{fmtDuration(data.total.work_seconds)}</b></div>
                        <div className={styles.card}><span>{days}일 보내기 합계</span><b>{data.total.completed}</b></div>
                        <div className={styles.card}><span>{days}일 완료 처리 합계</span><b>{data.total.done ?? 0}</b></div>
                        <div className={styles.card}><span>{days}일 신규 합계</span><b>{data.total.new}</b></div>
                    </div>
                    <div className={styles.row}>
                        <table className={styles.table}>
                            <thead>
                                <tr><th>날짜</th><th>보내기</th><th>완료 처리</th><th>새로 들어온 CS</th><th>CS 시간</th></tr>
                            </thead>
                            <tbody>
                                {[...data.daily].reverse().map((d) => (
                                    <tr key={d.date}>
                                        <td>{d.date}</td>
                                        <td>{d.completed}</td>
                                        <td>{d.done ?? 0}</td>
                                        <td>{d.new}</td>
                                        <td>{fmtDuration(d.work_seconds)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                        <table className={styles.table}>
                            <thead>
                                <tr><th>담당자</th><th>보내기 ({days}일)</th><th>완료 처리</th><th>CS 시간</th></tr>
                            </thead>
                            <tbody>
                                {data.by_user.length === 0 && <tr><td colSpan={4}>기록 없음</td></tr>}
                                {data.by_user.map((u) => (
                                    <tr key={u.user}><td>{u.user || '-'}</td><td>{u.count}</td><td>{u.done ?? 0}</td><td>{fmtDuration(u.work_seconds)}</td></tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    <h3 className={styles.sub}>CS 세션 (완료 간격 5분 초과 시 끊김)</h3>
                    <table className={styles.table}>
                        <thead>
                            <tr><th>담당자</th><th>시작</th><th>종료(끊긴 시각)</th><th>완료 수</th><th>CS 시간</th><th>마지막 CS</th></tr>
                        </thead>
                        <tbody>
                            {sessions.length === 0 && <tr><td colSpan={6}>기록 없음</td></tr>}
                            {sessions.map((s, i) => (
                                <tr key={`${s.user}-${s.start}-${i}`}>
                                    <td>{s.user || '-'}</td>
                                    <td>{fmtTime(s.start)}</td>
                                    <td>{fmtTime(s.end)}</td>
                                    <td>{s.count}</td>
                                    <td>{fmtDuration(s.work_seconds)}</td>
                                    <td>
                                        <div>{s.last.goods_name || '(상품 정보 없음)'}</div>
                                        <div className={styles.muted}>
                                            {[s.last.member_name, s.last.category].filter(Boolean).join(' · ')}
                                            {s.last.last_message ? ` — ${s.last.last_message}` : ''}
                                        </div>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>

                    <h3 className={styles.sub}>완료 CS 상품별 ({days}일)</h3>
                    {products.length === 0 && <p className={styles.muted}>기록 없음</p>}
                    {products.map((p) => (
                        <div key={p.goods_sno || p.goods_name} className={styles.group}>
                            <button
                                type="button"
                                className={styles.groupHead}
                                onClick={() => setOpen((o) => ({ ...o, [p.goods_sno]: !o[p.goods_sno] }))}
                            >
                                <span>{open[p.goods_sno] ? '▾' : '▸'} {p.goods_name}</span>
                                <b>{p.count}건</b>
                            </button>
                            {open[p.goods_sno] && (
                                <table className={styles.table}>
                                    <tbody>
                                        {p.items.map((it) => (
                                            <tr key={`${it.room_sno}-${it.completed_at}`}>
                                                <td>{fmtTime(it.completed_at)}</td>
                                                <td>{it.completed_by}</td>
                                                <td>{it.member_name}</td>
                                                <td>{it.category}</td>
                                                <td>{it.last_message}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            )}
                        </div>
                    ))}

                    <p className={styles.note}>새로 들어온 CS는 이 기능 적용 이후 동기화된 문의부터 집계됩니다. CS 시간은 완료 간격이 5분 이내일 때만 합산하며, 첫 완료 전이나 마지막 완료 뒤 시간은 포함되지 않습니다.</p>
                </>
            )}
        </div>
    );
};

const CSStatsPage = () => {
    const [tab, setTab] = useState('cs');
    return (
        <div>
            <div className={styles.tabs}>
                <button type="button" className={`${styles.chip} ${tab === 'cs' ? styles.chipActive : ''}`} onClick={() => setTab('cs')}>
                    CS 통계
                </button>
                <button type="button" className={`${styles.chip} ${tab === 'returns' ? styles.chipActive : ''}`} onClick={() => setTab('returns')}>
                    반품 통계
                </button>
                <button type="button" className={`${styles.chip} ${tab === 'normalization' ? styles.chipActive : ''}`} onClick={() => setTab('normalization')}>
                    정상화 통계
                </button>
            </div>
            {tab === 'cs' ? <CSStatsTab /> : tab === 'returns' ? <ReturnScanStats /> : <NormalizationStats />}
        </div>
    );
};

export default CSStatsPage;
