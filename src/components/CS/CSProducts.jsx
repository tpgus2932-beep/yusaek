import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Link2, Search } from 'lucide-react';
import styles from './CSProducts.module.css';
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

// 에이블리 상품 페이지 (문의 상품의 goods_sno가 곧 상품번호)
const goodsUrl = (goodsSno) => `https://mobile.a-bly.com/goods/${goodsSno}`;
const openGoodsPage = (goodsSno) => window.open(goodsUrl(goodsSno), '_blank', 'noopener,noreferrer');

const won = (n) => (n == null ? '-' : `${Number(n).toLocaleString('ko-KR')}원`);

const costRange = (m) => {
    if (m.cost_min == null) return '-';
    return m.cost_min === m.cost_max ? won(m.cost_min) : `${won(m.cost_min)} ~ ${won(m.cost_max)}`;
};

let productsCache = null; // 마지막으로 받은 /cs/dashboard 응답 (탭을 옮겨도 유지)

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
    // 탭을 옮겼다 돌아오면 지난번 결과를 바로 보여주고, 최신 값은 뒤에서 받아 갱신한다.
    const [products, setProducts] = useState(() => productsCache?.by_product || []);
    const [baseAvailable, setBaseAvailable] = useState(() => productsCache?.base_available ?? null);
    const [loading, setLoading] = useState(!productsCache);
    const [error, setError] = useState('');
    const [reloadTick, setReloadTick] = useState(0);
    const [sort, setSort] = useState('count');
    const [search, setSearch] = useState('');
    const [onlyUnmatched, setOnlyUnmatched] = useState(false);
    const [selectedSno, setSelectedSno] = useState(initialGoodsSno || null);
    const [showRooms, setShowRooms] = useState(Boolean(initialGoodsSno)); // true면 왼쪽이 상품 목록 대신 선택한 상품의 문의 목록
    const [topic, setTopic] = useState('');
    const [onlyWaiting, setOnlyWaiting] = useState(false);
    const [roomSort, setRoomSort] = useState('waiting'); // 선택한 상품의 문의 정렬
    // 일괄발송: 대화를 보다가 카드의 '일괄발송'으로 담아 두고, 같은 답변을 한 번에 보낸다
    const [bulkSel, setBulkSel] = useState(() => new Set());
    const [bulkMsg, setBulkMsg] = useState('');
    const [bulkRun, setBulkRun] = useState(null); // {total, done, failed:[{name, error}]} 발송 진행/결과

    const reload = useCallback(() => setReloadTick((t) => t + 1), []);

    const exitBulk = () => {
        setBulkSel(new Set());
        setBulkMsg('');
        setBulkRun(null);
    };

    useEffect(() => {
        let cancelled = false;
        call('/dashboard?product_limit=300&room_limit=200&with_match=true')
            .then((body) => {
                if (cancelled) return;
                productsCache = body;
                setProducts(body.by_product || []);
                setBaseAvailable(body.base_available);
            })
            .catch((err) => {
                // 이미 보여줄 값이 있으면 배경 갱신 실패로 화면을 덮지 않는다.
                if (!cancelled && !productsCache) setError(err.message);
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
        exitBulk();
        setSelectedSno(p.goods_sno);
        setShowRooms(true);
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

    const sending = Boolean(bulkRun && bulkRun.done < bulkRun.total);
    const allPicked = rooms.length > 0 && rooms.every((r) => bulkSel.has(r.sno));
    const picked = rooms.filter((r) => bulkSel.has(r.sno));

    // 카드의 '일괄발송' 버튼: 이 문의를 발송 대상에 담거나 뺀다 (카드를 열어 보는 동작과는 별개).
    const toggleBulk = (r) => {
        if (sending) return;
        setBulkRun(null);
        setBulkSel((prev) => {
            const next = new Set(prev);
            if (next.has(r.sno)) next.delete(r.sno);
            else next.add(r.sno);
            return next;
        });
    };

    const toggleAll = () => setBulkSel(allPicked ? new Set() : new Set(rooms.map((r) => r.sno)));

    // 체크한 문의에 차례로 답변을 보낸다. 하나가 실패해도 나머지는 계속 보내고 결과를 모아 보여준다.
    const sendBulk = async () => {
        const text = bulkMsg.trim();
        if (!text || picked.length === 0 || sending) return;
        if (!window.confirm(`선택한 ${picked.length}건의 문의에 같은 답변을 보낼까요?\n보낸 답변은 되돌릴 수 없습니다.\n\n${text.slice(0, 200)}`)) return;
        const targets = picked;
        const failed = [];
        setBulkRun({ total: targets.length, done: 0, failed });
        for (let i = 0; i < targets.length; i += 1) {
            const r = targets[i];
            try {
                await call(`/rooms/${r.sno}/reply`, { method: 'POST', body: { content: text.replaceAll('{이름}', r.member?.name || '') } });
            } catch (e) {
                failed.push({ name: r.member?.name || String(r.sno), error: e.message });
            }
            setBulkRun({ total: targets.length, done: i + 1, failed: [...failed] });
        }
        setBulkSel(new Set());
        reload();
    };

    if (error) return <div className={styles.empty}>{error}</div>;
    if (loading) return <div className={styles.empty}>불러오는 중...</div>;

    return (
        <div className={styles.wrap}>
            {!showRooms && <aside className={styles.side}>
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
                            {/* 목록 줄 자체가 버튼이라 안에 <a>를 둘 수 없어서, 사진만 따로 눌러 상품 페이지를 연다 */}
                            <span
                                role="link"
                                tabIndex={-1}
                                className={styles.thumbLink}
                                title="상품 페이지 열기"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    openGoodsPage(p.goods_sno);
                                }}
                            >
                                {p.image ? <img src={p.image} alt="" className={styles.thumb} loading="lazy" /> : <span className={styles.thumb} />}
                            </span>
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
            </aside>}

            {showRooms && <section className={`${styles.side} ${styles.sideRooms}`}>
                {!selected && <div className={styles.empty}>상품이 없어요.</div>}
                {selected && (
                    <>
                        <button type="button" className={styles.backBtn} onClick={() => { exitBulk(); setShowRooms(false); }}>
                            <ArrowLeft size={14} /> 상품 목록
                        </button>
                        <div className={styles.head}>
                            {selected.image && (
                                <a href={goodsUrl(selected.goods_sno)} target="_blank" rel="noopener noreferrer" className={styles.thumbLink} title="상품 페이지 열기">
                                    <img src={selected.image} alt="" className={styles.bigThumb} />
                                </a>
                            )}
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

                        {(bulkSel.size > 0 || bulkRun) && (
                            <div className={styles.bulkBar}>
                                <div className={styles.bulkHead}>
                                    <label className={styles.check}>
                                        <input type="checkbox" checked={allPicked} disabled={sending} onChange={toggleAll} />
                                        전체 선택 ({rooms.length}건)
                                    </label>
                                    <span className={styles.bulkCount}>{picked.length}건 담음</span>
                                    <button type="button" className={styles.miniBtn} disabled={sending} onClick={exitBulk}>비우기</button>
                                </div>
                                <textarea
                                    rows={3}
                                    value={bulkMsg}
                                    disabled={sending}
                                    placeholder="선택한 문의에 보낼 답변 ({이름}은 고객 이름으로 바뀝니다)"
                                    onChange={(e) => setBulkMsg(e.target.value)}
                                />
                                <button type="button" className={styles.bulkSend} disabled={sending || !bulkMsg.trim() || picked.length === 0} onClick={sendBulk}>
                                    {sending ? `발송 중 ${bulkRun.done} / ${bulkRun.total}` : `${picked.length}건 일괄 발송`}
                                </button>
                                {bulkRun && !sending && (
                                    <div className={bulkRun.failed.length ? styles.matchWarn : styles.matchOk}>
                                        {bulkRun.total - bulkRun.failed.length}건 발송 완료{bulkRun.failed.length > 0 && `, ${bulkRun.failed.length}건 실패`}
                                    </div>
                                )}
                                {bulkRun && !sending && bulkRun.failed.map((f) => (
                                    <div key={`${f.name}:${f.error}`} className={styles.matchMuted}>{f.name}: {f.error}</div>
                                ))}
                            </div>
                        )}

                        <div className={styles.rooms}>
                            {rooms.length === 0 && <div className={styles.empty}>조건에 맞는 문의가 없어요</div>}
                            {rooms.map((r) => (
                                <div
                                    key={r.sno}
                                    role="button"
                                    tabIndex={0}
                                    className={`${styles.roomCard} ${selectedRoomSno === r.sno ? styles.roomActive : ''} ${bulkSel.has(r.sno) ? styles.roomBulk : ''}`}
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
                                    {/* 카드 안의 조작(옵션 연결·일괄발송)을 눌렀을 때 카드가 열리지 않도록 이벤트를 막는다 */}
                                    <div onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                                        {baseAvailable && <OptionRow room={r} product={selected} onChanged={reload} />}
                                        <div className={styles.cardActions}>
                                            <button
                                                type="button"
                                                className={`${styles.miniBtn} ${bulkSel.has(r.sno) ? styles.miniBtnOn : ''}`}
                                                disabled={sending}
                                                onClick={() => toggleBulk(r)}
                                            >
                                                {bulkSel.has(r.sno) ? '✓ 일괄발송 대상' : '일괄발송'}
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            ))}
                            {selected.count > selected.rooms.length && (
                                <div className={styles.more}>최근 {selected.rooms.length}건만 표시했어요. 전체는 문의함에서 확인하세요.</div>
                            )}
                        </div>
                    </>
                )}
            </section>}

            {conversation}
        </div>
    );
};

export default CSProducts;
