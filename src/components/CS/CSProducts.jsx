import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link2, Search } from 'lucide-react';
import styles from './CSProducts.module.css';
import CSAddressModal from './CSAddressModal';
import CSInbound from './CSInbound';
import { LOCAL_API_BASE, getAuthHeaders, handleUnauthorized } from '../../lib/api';

const SORTS = [
    { value: 'count', label: '문의 많은 순' },
    { value: 'waiting', label: '답변 대기 많은 순' },
];

const ROOM_SORTS = [
    { value: 'waiting', label: '답변 대기 우선' },
    { value: 'newest', label: '최신순' },
    { value: 'oldest', label: '오래된순' },
];

const PRODUCT_METHOD = { manual: '직접 연결', id: '상품번호 일치', name: '상품명 일치' };
const OPTION_METHOD = { manual: '직접 연결', id: '옵션번호 일치', name: '옵션명 일치' };

const fmtTime = (iso) => {
    const d = new Date(iso);
    if (!iso || Number.isNaN(d.getTime())) return '';
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const won = (n) => (n == null ? '-' : `${Number(n).toLocaleString('ko-KR')}원`);

const costRange = (m) => {
    if (m.cost_min == null) return '-';
    return m.cost_min === m.cost_max ? won(m.cost_min) : `${won(m.cost_min)} ~ ${won(m.cost_max)}`;
};

const call = async (path, { method = 'GET', body } = {}) => {
    const res = await fetch(`${LOCAL_API_BASE}/cs${path}`, {
        method,
        headers: { ...getAuthHeaders(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    if (handleUnauthorized(res)) throw new Error('로그인이 만료되었습니다.');
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.detail || '요청 실패');
    return data;
};

// 선택한 상품의 원가베이스 연결 상태 + 직접 연결(검색)
function MatchPanel({ product, baseAvailable, onChanged }) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [results, setResults] = useState(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const match = product.match;

    const search = async () => {
        if (!query.trim()) return;
        setBusy(true);
        setError('');
        try {
            const data = await call(`/cost-base/search?q=${encodeURIComponent(query.trim())}`);
            setResults(data.products);
        } catch (e) {
            setError(e.message);
        } finally {
            setBusy(false);
        }
    };

    const link = async (baseName) => {
        setBusy(true);
        setError('');
        try {
            await call('/links/product', { method: 'PUT', body: { goods_sno: product.goods_sno, base_name: baseName } });
            setOpen(false);
            setResults(null);
            onChanged();
        } catch (e) {
            setError(e.message);
        } finally {
            setBusy(false);
        }
    };

    const unlink = async () => {
        setBusy(true);
        try {
            await call(`/links/product/${product.goods_sno}`, { method: 'DELETE' });
            onChanged();
        } catch (e) {
            setError(e.message);
        } finally {
            setBusy(false);
        }
    };

    if (baseAvailable === false) {
        return <div className={styles.matchBox}><span className={styles.matchMuted}>원가베이스를 읽을 수 없어 매칭을 건너뛰었어요. (백엔드 PC의 DB관리 원가베이스 필요)</span></div>;
    }

    return (
        <div className={styles.matchBox}>
            {match ? (
                <div className={styles.matchRow}>
                    <span className={styles.matchOk}>원가 연결됨</span>
                    <span className={styles.matchInfo}>
                        {match.base_name} · 거래처 {match.suppliers.join(', ') || '-'} · 원가 {costRange(match)} · 옵션 {match.option_count}개
                    </span>
                    <span className={styles.matchMuted}>({PRODUCT_METHOD[match.method]})</span>
                    <span className={styles.matchActions}>
                        <button type="button" className={styles.miniBtn} onClick={() => setOpen((v) => !v)}>변경</button>
                        {match.method === 'manual' && <button type="button" className={styles.miniBtn} disabled={busy} onClick={unlink}>연결 해제</button>}
                    </span>
                </div>
            ) : (
                <div className={styles.matchRow}>
                    <span className={styles.matchWarn}>원가베이스 미매칭</span>
                    <span className={styles.matchMuted}>상품번호·상품명(괄호 제외)이 일치하는 상품이 없어요.</span>
                    <span className={styles.matchActions}>
                        <button type="button" className={styles.miniBtn} onClick={() => setOpen((v) => !v)}>
                            <Link2 size={12} /> 직접 연결
                        </button>
                    </span>
                </div>
            )}
            {(open || (!match && results)) && (
                <div className={styles.picker}>
                    <div className={styles.pickerSearch}>
                        <input
                            placeholder="원가베이스 상품명으로 검색 (예: 노다 워싱)"
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && search()}
                        />
                        <button type="button" className={styles.miniBtn} disabled={busy} onClick={search}>검색</button>
                    </div>
                    {results && results.length === 0 && <div className={styles.matchMuted}>검색 결과가 없어요.</div>}
                    {(results || []).map((r) => (
                        <button type="button" key={r.base_name} className={styles.pickItem} disabled={busy} onClick={() => link(r.base_name)}>
                            <span className={styles.pickName}>{r.base_name}</span>
                            <span className={styles.matchMuted}>
                                {r.suppliers.join(', ') || '-'} · 원가 {costRange(r)} · 옵션 {r.option_count}개
                            </span>
                            <span className={styles.pickGo}>연결</span>
                        </button>
                    ))}
                </div>
            )}
            {error && <div className={styles.matchWarn}>{error}</div>}
        </div>
    );
}

// 문의 한 건의 옵션 ↔ 원가베이스 옵션 연결 상태
function OptionRow({ room, product, onChanged }) {
    const [picking, setPicking] = useState(false);
    const [options, setOptions] = useState([]);
    const [choice, setChoice] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const m = room.option_match;
    if (!room.option_label || room.option_match) return null;

    const openPicker = async () => {
        setPicking(true);
        setError('');
        try {
            const data = await call(`/products/${product.goods_sno}/base-options?name=${encodeURIComponent(product.name)}`);
            setOptions(data.options || []);
        } catch (e) {
            setError(e.message);
        }
    };

    const save = async () => {
        if (!choice) return;
        setBusy(true);
        try {
            await call('/links/option', { method: 'PUT', body: { goods_sno: product.goods_sno, option_key: room.option_key, base_code: choice } });
            setPicking(false);
            onChanged();
        } catch (e) {
            setError(e.message);
        } finally {
            setBusy(false);
        }
    };

    const unlink = async () => {
        setBusy(true);
        try {
            await call(`/links/option?goods_sno=${product.goods_sno}&option_key=${encodeURIComponent(room.option_key)}`, { method: 'DELETE' });
            onChanged();
        } catch (e) {
            setError(e.message);
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className={styles.optRow}>
            <span className={styles.optChip}>{room.option_label}</span>
            {m ? (
                <>
                    <span className={styles.optInfo}>
                        {m.label} · 원가 {won(m.cost)} · {m.supplier || '-'} · {m.status || '-'}
                    </span>
                    <span className={styles.matchMuted}>({OPTION_METHOD[m.method]})</span>
                    {m.method === 'manual' && <button type="button" className={styles.miniBtn} disabled={busy} onClick={unlink}>해제</button>}
                </>
            ) : product.match ? (
                <>
                    <span className={styles.matchWarn}>옵션 미매칭</span>
                    {!picking && <button type="button" className={styles.miniBtn} onClick={openPicker}><Link2 size={12} /> 옵션 연결</button>}
                </>
            ) : (
                <span className={styles.matchMuted}>상품을 먼저 연결하세요</span>
            )}
            {picking && (
                <span className={styles.optPicker}>
                    <select value={choice} onChange={(e) => setChoice(e.target.value)}>
                        <option value="">원가베이스 옵션 선택</option>
                        {options.map((o) => (
                            <option key={o.code} value={o.code}>{o.label} · {won(o.cost)} ({o.code})</option>
                        ))}
                    </select>
                    <button type="button" className={styles.miniBtn} disabled={busy || !choice} onClick={save}>저장</button>
                    <button type="button" className={styles.miniBtn} onClick={() => setPicking(false)}>취소</button>
                </span>
            )}
            {error && <span className={styles.matchWarn}>{error}</span>}
        </div>
    );
}

const CSProducts = ({ refreshKey, initialGoodsSno, selectedRoomSno, onSelectRoom, conversation }) => {
    const [products, setProducts] = useState([]);
    const [baseAvailable, setBaseAvailable] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [reloadTick, setReloadTick] = useState(0);
    const [sort, setSort] = useState('count');
    const [search, setSearch] = useState('');
    const [onlyUnmatched, setOnlyUnmatched] = useState(false);
    const [selectedSno, setSelectedSno] = useState(initialGoodsSno || null);
    const [topic, setTopic] = useState('');
    const [onlyWaiting, setOnlyWaiting] = useState(false);
    const [roomSort, setRoomSort] = useState('waiting'); // 선택한 상품의 문의 정렬
    const [addressOrder, setAddressOrder] = useState(''); // 주소 변경 모달에 띄울 주문번호

    const reload = useCallback(() => setReloadTick((t) => t + 1), []);

    useEffect(() => {
        let cancelled = false;
        call('/dashboard?product_limit=300&room_limit=200&with_match=true')
            .then((body) => {
                if (cancelled) return;
                setProducts(body.by_product || []);
                setBaseAvailable(body.base_available);
            })
            .catch((err) => {
                if (!cancelled) setError(err.message);
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [refreshKey, reloadTick]);

    const unmatchedCount = products.filter((p) => !p.match).length;

    const visible = useMemo(() => {
        const q = search.trim().toLowerCase();
        const list = products.filter(
            (p) => (!q || p.clean_name.toLowerCase().includes(q)) && (!onlyUnmatched || !p.match),
        );
        return [...list].sort((a, b) =>
            sort === 'waiting' ? b.waiting - a.waiting || b.count - a.count : b.count - a.count || b.waiting - a.waiting,
        );
    }, [products, search, sort, onlyUnmatched]);

    const selected = products.find((p) => p.goods_sno === selectedSno) || visible[0] || null;

    const selectProduct = (p) => {
        setSelectedSno(p.goods_sno);
        setTopic('');
        setOnlyWaiting(false);
    };

    const openRoom = (r) =>
        onSelectRoom({
            ...r,
            goods: { sno: selected.goods_sno, name: selected.name },
            asked_code: r.option_match?.code || '',
            order_item: { order_sno: r.order_sno },
        });

    const timeOf = (r) => r.updated_latest_message_at || '';
    const rooms = (selected?.rooms || [])
        .filter((r) => (!topic || r.child_category_display === topic) && (!onlyWaiting || r.waiting))
        .sort((a, b) => {
            if (roomSort === 'oldest') return timeOf(a).localeCompare(timeOf(b));
            if (roomSort === 'newest') return timeOf(b).localeCompare(timeOf(a));
            // 답변 대기 우선: 대기 중인 문의를 위로, 그 안에서는 최신순
            return Number(b.waiting) - Number(a.waiting) || timeOf(b).localeCompare(timeOf(a));
        });

    if (error) return <div className={styles.empty}>{error}</div>;
    if (loading) return <div className={styles.empty}>불러오는 중...</div>;

    return (
        <div className={styles.wrap}>
            <aside className={styles.side}>
                <div className={styles.tools}>
                    <label className={styles.search}>
                        <Search size={14} />
                        <input placeholder="상품명 검색" value={search} onChange={(e) => setSearch(e.target.value)} />
                    </label>
                    <select value={sort} onChange={(e) => setSort(e.target.value)}>
                        {SORTS.map((o) => (
                            <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                    </select>
                </div>
                {baseAvailable && (
                    <div className={styles.matchFilter}>
                        <button type="button" className={`${styles.pill} ${!onlyUnmatched ? styles.pillOn : ''}`} onClick={() => setOnlyUnmatched(false)}>
                            전체 {products.length}
                        </button>
                        <button type="button" className={`${styles.pill} ${onlyUnmatched ? styles.pillOn : ''}`} onClick={() => setOnlyUnmatched(true)}>
                            원가 미매칭 {unmatchedCount}
                        </button>
                    </div>
                )}
                <div className={styles.sideList}>
                    {visible.length === 0 && <div className={styles.empty}>해당하는 상품이 없어요</div>}
                    {visible.map((p) => (
                        <button
                            type="button"
                            key={p.goods_sno}
                            className={`${styles.prod} ${selected?.goods_sno === p.goods_sno ? styles.prodActive : ''}`}
                            onClick={() => selectProduct(p)}
                        >
                            {p.image ? <img src={p.image} alt="" className={styles.thumb} loading="lazy" /> : <span className={styles.thumb} />}
                            <span className={styles.prodName}>
                                {p.clean_name}
                                {baseAvailable && (
                                    <span className={p.match ? styles.dotOk : styles.dotWarn}>{p.match ? '원가 ✓' : '미매칭'}</span>
                                )}
                            </span>
                            <span className={styles.nums}>
                                <b>{p.count}</b>
                                {p.waiting > 0 && <i>대기 {p.waiting}</i>}
                            </span>
                        </button>
                    ))}
                </div>
            </aside>

            <section className={styles.main}>
                {!selected && <div className={styles.empty}>왼쪽에서 상품을 선택하세요.</div>}
                {selected && (
                    <>
                        <div className={styles.head}>
                            {selected.image && <img src={selected.image} alt="" className={styles.bigThumb} />}
                            <div className={styles.headText}>
                                <h2 title={selected.name}>{selected.clean_name}</h2>
                                <div className={styles.headSub}>
                                    진행 중 문의 {selected.count}건 · 답변 대기 {selected.waiting}건
                                </div>
                            </div>
                        </div>

                        <MatchPanel key={selected.goods_sno} product={selected} baseAvailable={baseAvailable} onChanged={reload} />
                        {baseAvailable && <CSInbound key={`inbound-${selected.goods_sno}`} product={selected} />}

                        <div className={styles.filters}>
                            <button type="button" className={`${styles.pill} ${!topic ? styles.pillOn : ''}`} onClick={() => setTopic('')}>
                                전체 {selected.count}
                            </button>
                            {selected.topics.map((t) => (
                                <button
                                    type="button"
                                    key={t.name}
                                    className={`${styles.pill} ${topic === t.name ? styles.pillOn : ''}`}
                                    onClick={() => setTopic(topic === t.name ? '' : t.name)}
                                >
                                    {t.name} {t.count}
                                </button>
                            ))}
                            <select className={styles.sortSelect} aria-label="문의 정렬" value={roomSort} onChange={(e) => setRoomSort(e.target.value)}>
                                {ROOM_SORTS.map((o) => (
                                    <option key={o.value} value={o.value}>{o.label}</option>
                                ))}
                            </select>
                            <label className={styles.check}>
                                <input type="checkbox" checked={onlyWaiting} onChange={(e) => setOnlyWaiting(e.target.checked)} />
                                답변 대기만
                            </label>
                        </div>

                        <div className={styles.rooms}>
                            {rooms.length === 0 && <div className={styles.empty}>조건에 맞는 문의가 없어요</div>}
                            {rooms.map((r) => (
                                <div
                                    key={r.sno}
                                    role="button"
                                    tabIndex={0}
                                    className={`${styles.roomCard} ${selectedRoomSno === r.sno ? styles.roomActive : ''}`}
                                    onClick={() => openRoom(r)}
                                    onKeyDown={(e) => {
                                        if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                                            e.preventDefault();
                                            openRoom(r);
                                        }
                                    }}
                                >
                                    <div className={styles.room}>
                                        <span className={styles.roomTop}>
                                            <strong>{r.member?.name || '-'}</strong>
                                            <span className={styles.topic}>{r.child_category_display}</span>
                                            {r.waiting && <span className={styles.wait}>답변 대기</span>}
                                            <span className={styles.when}>{fmtTime(r.updated_latest_message_at)}</span>
                                        </span>
                                        <span className={styles.msg}>{r.latest_message?.content || '[이미지]'}</span>
                                    </div>
                                    {/* 카드 안의 조작(옵션 연결·주소 변경)을 눌렀을 때 카드가 열리지 않도록 이벤트를 막는다 */}
                                    <div onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                                        {baseAvailable && <OptionRow room={r} product={selected} onChanged={reload} />}
                                        {r.order_sno && (
                                            <div className={styles.cardActions}>
                                                <button type="button" className={styles.miniBtn} onClick={() => setAddressOrder(String(r.order_sno))}>
                                                    주소 변경
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            ))}
                            {selected.count > selected.rooms.length && (
                                <div className={styles.more}>최근 {selected.rooms.length}건만 표시했어요. 전체는 문의함에서 확인하세요.</div>
                            )}
                        </div>
                    </>
                )}
            </section>

            <section className={styles.chat}>{conversation}</section>
            {addressOrder && <CSAddressModal orderNo={addressOrder} onClose={() => setAddressOrder('')} />}
        </div>
    );
};

export default CSProducts;
