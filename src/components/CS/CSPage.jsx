import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Copy, RefreshCw } from 'lucide-react';
import styles from './CSPage.module.css';
import CSDashboard from './CSDashboard';
import CSProducts from './CSProducts';
import CSConversation from './CSConversation';
import CSAddress from './CSAddress';
import { LOCAL_API_BASE, getAuthHeaders, handleUnauthorized } from '../../lib/api';

const STATUS_OPTIONS = [
    { value: '1,2', label: '진행 중' },
    { value: '3,4,5', label: '완료/기타' },
    { value: '', label: '전체' },
];

const fmtDate = (d) => {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const fmtTime = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const SYNC_INTERVAL_MS = 60000;
const PAGE_SIZE = 100;

const apiCall = async (path, params, method = 'GET') => {
    const qs = params ? `?${new URLSearchParams(params)}` : '';
    const res = await fetch(`${LOCAL_API_BASE}/cs${path}${qs}`, { method, headers: getAuthHeaders() });
    if (handleUnauthorized(res)) throw new Error('로그인이 만료되었습니다.');
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.detail || '요청 실패');
    return data;
};

const apiGet = (path, params) => apiCall(path, params);

const CSPage = () => {
    const today = useMemo(() => new Date(), []);
    const [startDate, setStartDate] = useState(() => fmtDate(new Date(today.getTime() - 30 * 86400000)));
    const [endDate, setEndDate] = useState(() => fmtDate(today));
    const [status, setStatus] = useState('1,2');
    const [rooms, setRooms] = useState([]);
    const [totalCount, setTotalCount] = useState(null);
    const [lastSyncAt, setLastSyncAt] = useState('');
    const [query, setQuery] = useState('');
    const [limit, setLimit] = useState(PAGE_SIZE);
    const [view, setView] = useState(() => {
        try {
            const saved = localStorage.getItem('csView');
            return ['dashboard', 'products', 'inbox', 'address'].includes(saved) ? saved : 'dashboard';
        } catch {
            return 'dashboard';
        }
    }); // 'dashboard' | 'products' | 'inbox' — 새로고침해도 유지
    const [productSno, setProductSno] = useState(null);
    const [syncTick, setSyncTick] = useState(0);
    const [syncing, setSyncing] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [selected, setSelected] = useState(null);
    const [preview, setPreview] = useState(null); // 상세 로딩 중 목록 정보로 먼저 보여줄 문의
    const [detail, setDetail] = useState(null);
    const [detailLoading, setDetailLoading] = useState(false);
    const [templates, setTemplates] = useState([]);

    useEffect(() => {
        try {
            localStorage.setItem('csView', view);
        } catch { /* 저장 실패는 무시 */ }
    }, [view]);

    const loadRooms = useCallback(async (silent = false) => {
        if (!silent) setLoading(true);
        setError('');
        try {
            const params = { start_date: startDate, end_date: endDate, limit };
            if (status) params.status = status;
            if (query.trim()) params.q = query.trim();
            const data = await apiGet('/rooms', params);
            setRooms(data.contact_rooms || []);
            setTotalCount(data.total_count ?? null);
            setLastSyncAt(data.last_sync_at || '');
        } catch (err) {
            setError(err.message || '목록 조회 실패');
        } finally {
            setLoading(false);
        }
    }, [startDate, endDate, status, query, limit]);

    const syncRooms = useCallback(async () => {
        setSyncing(true);
        try {
            const result = await apiCall('/sync', null, 'POST');
            if (result.fetched > 0) {
                await loadRooms(true);
                setSyncTick((t) => t + 1);
            }
            else setLastSyncAt(result.synced_at || '');
        } catch (err) {
            setError(err.message || '동기화 실패');
        } finally {
            setSyncing(false);
        }
    }, [loadRooms]);

    // 저장된 목록은 즉시 보여주고, 새 문의만 백그라운드로 가져온다.
    useEffect(() => {
        loadRooms();
    }, [loadRooms]);

    useEffect(() => {
        syncRooms();
        const timer = setInterval(syncRooms, SYNC_INTERVAL_MS);
        return () => clearInterval(timer);
    }, [syncRooms]);

    useEffect(() => {
        apiGet('/templates')
            .then((d) => setTemplates(d.answer_templates || []))
            .catch(() => {});
    }, []);

    // 상세는 (문의번호 + 마지막 메시지 시각) 기준으로 메모리에 캐시한다.
    const detailCache = useRef(new Map());
    const cacheKey = (r) => `${r.sno}:${r.updated_latest_message_at}`;

    const fetchDetail = useCallback(async (r) => {
        const key = cacheKey(r);
        const cached = detailCache.current.get(key);
        if (cached) return cached;
        const data = await apiGet(`/rooms/${r.sno}`);
        detailCache.current.set(key, data);
        return data;
    }, []);

    const prefetchRoom = (r) => {
        fetchDetail(r).catch(() => {});
    };

    const selectedRef = useRef(null);

    const openRoom = async (r) => {
        selectedRef.current = r.sno;
        setSelected(r.sno);
        setPreview(r);
        const cached = detailCache.current.get(cacheKey(r));
        if (cached) {
            setDetail(cached);
            setDetailLoading(false);
            return;
        }
        setDetail(null);
        setDetailLoading(true);
        try {
            const data = await fetchDetail(r);
            if (selectedRef.current === r.sno) setDetail(data);
        } catch (err) {
            if (selectedRef.current === r.sno) setError(err.message || '상세 조회 실패');
        } finally {
            if (selectedRef.current === r.sno) setDetailLoading(false);
        }
    };

    const copyText = (text) => navigator.clipboard?.writeText(text).catch(() => {});

    return (
        <div className={styles.page}>
            <header className={styles.topBar}>
                <h1 className={styles.title}>CS</h1>
                <button
                    type="button"
                    className={`${styles.tab} ${view === 'dashboard' ? styles.tabActive : ''}`}
                    onClick={() => setView('dashboard')}
                >
                    대시보드
                </button>
                <button
                    type="button"
                    className={`${styles.tab} ${view === 'products' ? styles.tabActive : ''}`}
                    onClick={() => setView('products')}
                >
                    상품별
                </button>
                <button
                    type="button"
                    className={`${styles.tab} ${view === 'inbox' ? styles.tabActive : ''}`}
                    onClick={() => setView('inbox')}
                >
                    문의함
                </button>
                <button
                    type="button"
                    className={`${styles.tab} ${view === 'address' ? styles.tabActive : ''}`}
                    onClick={() => setView('address')}
                >
                    주소변경
                </button>
                {view === 'inbox' && (
                    <>
                <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
                <span>~</span>
                <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
                <select value={status} onChange={(e) => setStatus(e.target.value)}>
                    {STATUS_OPTIONS.map((o) => (
                        <option key={o.label} value={o.value}>{o.label}</option>
                    ))}
                </select>
                <input
                    type="search"
                    placeholder="이름/전화/주문번호/내용 검색"
                    value={query}
                    onChange={(e) => { setQuery(e.target.value); setLimit(PAGE_SIZE); }}
                />
                    </>
                )}
                <button type="button" className={styles.btn} onClick={syncRooms} disabled={syncing}>
                    <RefreshCw size={14} /> {syncing ? '동기화 중...' : '새로고침'}
                </button>
                <span className={styles.count}>
                    {view === 'inbox' && totalCount != null ? `총 ${totalCount}건` : ''}
                    {lastSyncAt ? ` · 마지막 동기화 ${fmtTime(lastSyncAt)}` : ''}
                </span>
            </header>
            {error && <div className={styles.error}>{error}</div>}
            {view === 'dashboard' && (
                <CSDashboard
                    refreshKey={syncTick}
                    onOpenInbox={() => setView('inbox')}
                    onOpenProduct={(sno) => {
                        setProductSno(sno);
                        setView('products');
                    }}
                    onOpenRoom={(r) => {
                        setView('inbox');
                        openRoom(r);
                    }}
                />
            )}
            {view === 'products' && (
                <CSProducts
                    key={productSno ?? 'all'}
                    refreshKey={syncTick}
                    initialGoodsSno={productSno}
                    selectedRoomSno={selected}
                    onSelectRoom={openRoom}
                    conversation={
                        <CSConversation selected={selected} preview={preview} detail={detail} detailLoading={detailLoading} />
                    }
                />
            )}
            {view === 'address' && <CSAddress />}
            <div className={styles.body} style={view === 'inbox' ? undefined : { display: 'none' }}>
                <aside className={styles.list}>
                    {loading && <div className={styles.empty}>불러오는 중...</div>}
                    {!loading && rooms.length === 0 && <div className={styles.empty}>문의가 없습니다.</div>}
                    {rooms.map((r) => (
                        <button
                            type="button"
                            key={r.sno}
                            className={`${styles.roomItem} ${selected === r.sno ? styles.roomItemActive : ''}`}
                            onClick={() => openRoom(r)}
                            onMouseEnter={() => prefetchRoom(r)}
                        >
                            <div className={styles.roomHead}>
                                <strong>{r.member?.name || '-'}</strong>
                                <span className={styles.badge}>{r.get_status_display}</span>
                                <span className={styles.time}>{fmtTime(r.updated_latest_message_at)}</span>
                            </div>
                            <div className={styles.cat}>
                                {r.parent_category_display} &gt; {r.child_category_display}
                            </div>
                            <div className={styles.preview}>
                                {r.latest_message?.content || (r.latest_message?.image_url ? '[이미지]' : '')}
                            </div>
                        </button>
                    ))}
                    {rooms.length < (totalCount ?? 0) && (
                        <button type="button" className={styles.btn} onClick={() => setLimit((l) => l + PAGE_SIZE)}>
                            더 보기
                        </button>
                    )}
                </aside>

                <main className={styles.detail}>
                    <CSConversation selected={selected} preview={preview} detail={detail} detailLoading={detailLoading} />
                </main>

                <aside className={styles.templates}>
                    <h3>답변 템플릿</h3>
                    <p className={styles.hint}>클릭하면 복사됩니다.</p>
                    {templates.map((t) => (
                        <button type="button" key={t.sno} className={styles.tpl} onClick={() => copyText(t.content)}>
                            <div className={styles.tplTitle}><Copy size={12} /> {t.title}</div>
                            <div className={styles.tplBody}>{t.content}</div>
                        </button>
                    ))}
                </aside>
            </div>
        </div>
    );
};

export default CSPage;
