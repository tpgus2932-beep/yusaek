import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import styles from './CSMalignantDelay.module.css';
import { LOCAL_API_BASE, getAuthHeaders, handleUnauthorized } from '../../lib/api';

const STOCK_CONCURRENCY = 3;

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

const todayStr = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const shortDate = (ymd) => (ymd ? `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}` : '');

const fmtTime = (iso) => {
    const d = new Date(iso);
    if (!iso || Number.isNaN(d.getTime())) return '';
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const hasSchedule = (inbound) => !!(inbound && (inbound.expected_date || inbound.note));

/**
 * 에이블리 악성지연(상품준비중 + 지연 + 옵션 구매불가) 주문 목록.
 * 입고 일정이 등록된 옵션은 일정을, 없으면 '일정문의필요'를 빨간색으로 보여주고,
 * 행별 '재고확인' / 전체 '일괄재고확인'으로 이지어드민 재고를 조회한다.
 */
export default function CSMalignantDelay() {
    const [items, setItems] = useState([]);
    const [fetchedAt, setFetchedAt] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [onlyNoSchedule, setOnlyNoSchedule] = useState(false);
    const [query, setQuery] = useState('');
    // goods_sno -> { loading, error, source, note, fetchedAt, byCode: {code: {stock_qty, stock_in_standby, found}} }
    const [stocks, setStocks] = useState({});
    const [bulk, setBulk] = useState(null); // { done, total } 일괄 조회 진행 상황
    const [selectedGoods, setSelectedGoods] = useState(null); // 왼쪽 목록에서 고른 상품 (null이면 전체)
    const [selectedOption, setSelectedOption] = useState(null); // 상품 안에서 고른 옵션 (null이면 상품의 모든 옵션)
    const [groupSort, setGroupSort] = useState({ key: 'avg', dir: 'desc' }); // 왼쪽 상품 목록 정렬
    const [sortDir, setSortDir] = useState('desc'); // 지연일 정렬: desc(많은 순) | asc(적은 순)
    const [images, setImages] = useState({}); // goods_sno -> 대표 이미지 주소

    // 상품 이미지는 목록과 따로 100개씩 받아 와서, 도착하는 대로 채운다.
    const loadImages = async (snos) => {
        for (let i = 0; i < snos.length; i += 100) {
            try {
                const data = await call('/malignant-delay/images', { method: 'POST', body: { goods_snos: snos.slice(i, i + 100) } });
                setImages((prev) => ({ ...prev, ...data.images }));
            } catch {
                break; // 이미지는 없어도 화면을 쓸 수 있다
            }
        }
    };

    const load = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            const data = await call('/malignant-delay/list');
            const list = data.items || [];
            setItems(list);
            setFetchedAt(data.fetched_at || '');
            loadImages([...new Set(list.map((i) => i.goods_sno))]);
        } catch (e) {
            setError(e.message);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        load();
    }, [load]);

    const checkStock = useCallback(async (item) => {
        const key = item.goods_sno;
        setStocks((prev) => ({ ...prev, [key]: { ...prev[key], loading: true, error: '' } }));
        try {
            const data = await call('/malignant-delay/stock', { method: 'POST', body: { goods_sno: item.goods_sno, name: item.goods_name } });
            const byCode = {};
            data.options.forEach((o) => { byCode[o.code] = o; });
            setStocks((prev) => ({ ...prev, [key]: { loading: false, error: '', source: data.source, note: data.note, fetchedAt: data.fetched_at, byCode } }));
        } catch (e) {
            setStocks((prev) => ({ ...prev, [key]: { loading: false, error: e.message, byCode: {} } }));
        }
    }, []);

    // 검색·일정문의필요 필터를 거친 주문 (왼쪽 상품 목록의 기준)
    const filtered = useMemo(() => {
        const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
        return items.filter((i) => {
            if (onlyNoSchedule && hasSchedule(i.inbound)) return false;
            if (!words.length) return true;
            const hay = `${i.goods_name} ${i.option_info} ${i.order_sno} ${i.buyer_name}`.toLowerCase();
            return words.every((w) => hay.includes(w));
        });
    }, [items, onlyNoSchedule, query]);

    // 상품별 주문 수와 평균 지연일 (왼쪽 목록 정렬 기준에 따라 정렬)
    const groups = useMemo(() => {
        const map = new Map();
        filtered.forEach((i) => {
            const g = map.get(i.goods_sno) || { goods_sno: i.goods_sno, name: i.goods_name, count: 0, delaySum: 0, delayCount: 0 };
            g.count += 1;
            if (i.delay_days != null) {
                g.delaySum += i.delay_days;
                g.delayCount += 1;
            }
            map.set(i.goods_sno, g);
        });
        const dir = groupSort.dir === 'asc' ? 1 : -1;
        const avgOf = (g) => g.avg ?? -1;
        return [...map.values()]
            .map((g) => ({ ...g, avg: g.delayCount ? g.delaySum / g.delayCount : null }))
            .sort((a, b) => (
                groupSort.key === 'count'
                    ? dir * (a.count - b.count) || avgOf(b) - avgOf(a)
                    : dir * (avgOf(a) - avgOf(b)) || b.count - a.count
            ));
    }, [filtered, groupSort]);

    // 같은 기준을 다시 누르면 방향만 바꾸고, 다른 기준을 누르면 내림차순으로 시작한다.
    const sortGroups = (key) => setGroupSort((g) => (g.key === key ? { key, dir: g.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' }));
    const sortMark = (key) => (groupSort.key === key ? (groupSort.dir === 'desc' ? ' ▼' : ' ▲') : '');

    const activeGoods = groups.some((g) => g.goods_sno === selectedGoods) ? selectedGoods : null;

    const optionKey = (i) => i.code || `opt:${i.option_info}`;
    const goodsItems = useMemo(
        () => (activeGoods == null ? [] : filtered.filter((i) => i.goods_sno === activeGoods)),
        [filtered, activeGoods],
    );

    // 고른 상품의 옵션별 주문 수·지연일 (재고·미송·입고 일정은 화면에서 붙인다)
    const optionRows = useMemo(() => {
        const map = new Map();
        goodsItems.forEach((i) => {
            const key = optionKey(i);
            const o = map.get(key) || { key, code: i.code, label: i.option_info, items: [], delaySum: 0, delayCount: 0, max: null };
            o.items.push(i);
            if (i.delay_days != null) {
                o.delaySum += i.delay_days;
                o.delayCount += 1;
                o.max = Math.max(o.max ?? 0, i.delay_days);
            }
            map.set(key, o);
        });
        const dir = sortDir === 'asc' ? 1 : -1;
        return [...map.values()]
            .map((o) => ({ ...o, avg: o.delayCount ? o.delaySum / o.delayCount : null }))
            .sort((a, b) => dir * ((a.avg ?? -1) - (b.avg ?? -1)));
    }, [goodsItems, sortDir]);

    const activeOption = optionRows.some((o) => o.key === selectedOption) ? selectedOption : null;

    // 오른쪽 주문 표: 전체 → 모든 주문, 상품 → 그 상품 주문, 옵션까지 고르면 그 옵션 주문
    const shown = useMemo(() => {
        let list = filtered;
        if (activeGoods != null) list = goodsItems;
        if (activeOption != null) list = list.filter((i) => optionKey(i) === activeOption);
        const dir = sortDir === 'asc' ? 1 : -1;
        return [...list].sort((a, b) => dir * ((a.delay_days ?? -1) - (b.delay_days ?? -1)));
    }, [filtered, goodsItems, activeGoods, activeOption, sortDir]);

    // 같은 상품은 한 번만 조회한다 (옵션 재고는 상품 단위로 함께 받아 온다).
    const checkAll = async () => {
        const goods = new Map();
        shown.forEach((i) => { if (i.code && !goods.has(i.goods_sno)) goods.set(i.goods_sno, i); });
        const queue = [...goods.values()];
        if (!queue.length) return;
        setBulk({ done: 0, total: queue.length });
        let done = 0;
        const worker = async () => {
            while (queue.length) {
                const item = queue.shift();
                await checkStock(item);
                done += 1;
                setBulk({ done, total: goods.size });
            }
        };
        await Promise.all(Array.from({ length: Math.min(STOCK_CONCURRENCY, queue.length) }, worker));
        setBulk(null);
    };

    const noScheduleCount = items.filter((i) => !hasSchedule(i.inbound)).length;

    const renderInbound = (i) => {
        if (!hasSchedule(i.inbound)) {
            return <span className={styles.ask}>일정문의필요</span>;
        }
        const { expected_date: date, note } = i.inbound;
        const past = date && date < todayStr();
        return (
            <>
                {date && <b className={past ? styles.past : styles.date}>{shortDate(date)}{past && ' (지남)'}</b>}
                {note && <span> {note}</span>}
            </>
        );
    };

    const renderStock = (i) => {
        if (!i.code) return <span className={styles.muted}>원가베이스 미연결</span>;
        const s = stocks[i.goods_sno];
        if (s?.loading) return <span className={styles.muted}>조회 중…</span>;
        if (s?.error) return <span className={styles.error} title={s.error}>{s.error}</span>;
        const o = s?.byCode?.[i.code];
        if (!s || !o) return <span className={styles.muted}>-</span>;
        if (s.source === 'none') return <span className={styles.muted}>재고 데이터 없음</span>;
        if (!o.found) return <span className={styles.muted}>이지어드민 미조회</span>;
        return (
            <>
                <b className={o.stock_qty > 0 ? styles.num : styles.zero}>{o.stock_qty > 0 ? `${o.stock_qty}개` : '재고 없음'}</b>
                {o.stock_in_standby > 0 && <span className={styles.misong}>미송 {o.stock_in_standby}</span>}
            </>
        );
    };

    return (
        <div className={styles.wrap}>
            <section className={styles.card}>
                <div className={styles.toolbar}>
                    <h3>악성지연 확인 <span className={styles.hint}>{items.length}건 · 일정문의필요 {noScheduleCount}건</span></h3>
                    <input
                        type="search"
                        className={styles.search}
                        placeholder="상품명/옵션/주문번호/구매자 검색"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                    />
                    <label className={styles.check}>
                        <input type="checkbox" checked={onlyNoSchedule} onChange={(e) => setOnlyNoSchedule(e.target.checked)} />
                        일정문의필요만
                    </label>
                    <button type="button" className={styles.secondary} disabled={loading} onClick={load}>
                        <RefreshCw size={13} /> {loading ? '불러오는 중…' : '목록 새로고침'}
                    </button>
                    <button type="button" className={styles.primary} disabled={!!bulk || loading || shown.length === 0} onClick={checkAll}>
                        {bulk ? `재고 조회 중 ${bulk.done}/${bulk.total}` : `일괄재고확인 (${shown.length}건)`}
                    </button>
                </div>
                <div className={styles.muted}>
                    에이블리 상품준비중 · 지연 · 옵션 구매불가 주문이에요. 입고 일정은 상품별 탭에서 등록한 값을 보여줘요.
                    {fetchedAt && ` · ${fmtTime(fetchedAt)} 기준`}
                </div>
                {error && <div className={styles.error}>{error}</div>}
            </section>

            <div className={styles.layout}>
            <aside className={`${styles.card} ${styles.side}`}>
                <div className={styles.sideHead}>
                    <b>상품별</b>
                    <span className={styles.muted}>{groups.length}개 상품</span>
                    <div className={styles.sortTabs}>
                        <button
                            type="button"
                            className={`${styles.sortTab} ${groupSort.key === 'avg' ? styles.sortTabOn : ''}`}
                            onClick={() => sortGroups('avg')}
                        >
                            평균 지연일{sortMark('avg')}
                        </button>
                        <button
                            type="button"
                            className={`${styles.sortTab} ${groupSort.key === 'count' ? styles.sortTabOn : ''}`}
                            onClick={() => sortGroups('count')}
                        >
                            건수{sortMark('count')}
                        </button>
                    </div>
                </div>
                <button
                    type="button"
                    className={`${styles.goods} ${activeGoods == null ? styles.goodsOn : ''}`}
                    onClick={() => { setSelectedGoods(null); setSelectedOption(null); }}
                >
                    <span className={styles.goodsName}>전체</span>
                    <span className={styles.goodsStat}>{filtered.length}건</span>
                </button>
                {groups.map((g) => (
                    <button
                        type="button"
                        key={g.goods_sno}
                        className={`${styles.goods} ${activeGoods === g.goods_sno ? styles.goodsOn : ''}`}
                        onClick={() => { setSelectedGoods(activeGoods === g.goods_sno ? null : g.goods_sno); setSelectedOption(null); }}
                    >
                        {images[g.goods_sno] ? (
                            <img src={images[g.goods_sno]} alt="" className={styles.thumb} loading="lazy" />
                        ) : (
                            <span className={styles.thumb} />
                        )}
                        <span className={styles.goodsText}>
                            <span className={styles.goodsName}>{g.name}</span>
                            <span className={styles.goodsStat}>
                                {g.count}건 · 평균 <b>{g.avg != null ? `${g.avg.toFixed(1)}일` : '-'}</b>
                            </span>
                        </span>
                    </button>
                ))}
            </aside>
            <div className={styles.mainRow}>
            <section className={`${styles.card} ${styles.main}`}>
                {activeOption != null && (
                    <div className={styles.filterNote}>
                        선택한 옵션 <b>{optionRows.find((o) => o.key === activeOption)?.label}</b> 주문 {shown.length}건
                        <button type="button" className={styles.small} onClick={() => setSelectedOption(null)}>옵션 선택 해제</button>
                    </div>
                )}
                {loading && items.length === 0 && <div className={styles.muted}>불러오는 중…</div>}
                {!loading && shown.length === 0 && <div className={styles.muted}>표시할 주문이 없어요.</div>}
                {shown.length > 0 && (
                    <div className={styles.tableWrap}>
                        <table className={styles.table}>
                            <thead>
                                <tr>
                                    <th>상품명</th>
                                    <th>옵션</th>
                                    <th>
                                        <button type="button" className={styles.sortBtn} onClick={() => setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'))}>
                                            지연 {sortDir === 'desc' ? '▼' : '▲'}
                                        </button>
                                    </th>
                                    <th>주문번호</th>
                                    <th>입고 일정</th>
                                    <th>재고</th>
                                    <th />
                                </tr>
                            </thead>
                            <tbody>
                                {shown.map((i) => (
                                    <tr key={i.sno}>
                                        <td className={styles.name}>{i.goods_name}</td>
                                        <td>{i.option_info}{i.ea > 1 && ` ×${i.ea}`}</td>
                                        <td className={styles.nowrap}>{i.delay_days != null ? `${i.delay_days}일` : '-'}</td>
                                        <td className={styles.nowrap}>{i.order_sno}</td>
                                        <td>{renderInbound(i)}</td>
                                        <td>{renderStock(i)}</td>
                                        <td>
                                            <button
                                                type="button"
                                                className={styles.small}
                                                disabled={!i.code || stocks[i.goods_sno]?.loading}
                                                onClick={() => checkStock(i)}
                                            >
                                                재고확인
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </section>
            {activeGoods != null && (
                <section className={`${styles.card} ${styles.optionPanel}`}>
                    <div className={styles.goodsHead}>
                        {images[activeGoods] && <img src={images[activeGoods]} alt="" className={styles.thumbLg} />}
                        <div className={styles.goodsHeadText}>
                            <b>{groups.find((g) => g.goods_sno === activeGoods)?.name}</b>
                            <span className={styles.muted}>옵션을 누르면 그 옵션의 주문만 왼쪽에 보여줘요</span>
                        </div>
                        <button
                            type="button"
                            className={styles.primary}
                            disabled={!goodsItems.some((i) => i.code) || stocks[activeGoods]?.loading}
                            onClick={() => checkStock(goodsItems.find((i) => i.code))}
                        >
                            {stocks[activeGoods]?.loading ? '조회 중…' : '이 상품 재고확인'}
                        </button>
                    </div>
                    <div className={styles.tableWrap}>
                        <table className={styles.table}>
                            <thead>
                                <tr>
                                    <th>옵션</th>
                                    <th>주문</th>
                                    <th>
                                        <button type="button" className={styles.sortBtn} onClick={() => setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'))}>
                                            평균 지연 {sortDir === 'desc' ? '▼' : '▲'}
                                        </button>
                                    </th>
                                    <th>최대</th>
                                    <th>재고</th>
                                    <th>입고 일정</th>
                                </tr>
                            </thead>
                            <tbody>
                                {optionRows.map((o) => (
                                    <tr
                                        key={o.key}
                                        className={`${styles.clickRow} ${activeOption === o.key ? styles.rowOn : ''}`}
                                        onClick={() => setSelectedOption(activeOption === o.key ? null : o.key)}
                                    >
                                        <td><b>{o.label || '-'}</b></td>
                                        <td className={styles.nowrap}>{o.items.length}건</td>
                                        <td className={styles.nowrap}>{o.avg != null ? `${o.avg.toFixed(1)}일` : '-'}</td>
                                        <td className={styles.nowrap}>{o.max != null ? `${o.max}일` : '-'}</td>
                                        <td>{renderStock(o.items[0])}</td>
                                        <td>{renderInbound(o.items[0])}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </section>
            )}
            </div>
            </div>
        </div>
    );
}
