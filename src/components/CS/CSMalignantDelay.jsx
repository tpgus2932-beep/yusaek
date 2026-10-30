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

    const load = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            const data = await call('/malignant-delay/list');
            setItems(data.items || []);
            setFetchedAt(data.fetched_at || '');
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

    const shown = useMemo(() => {
        const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
        return items.filter((i) => {
            if (onlyNoSchedule && hasSchedule(i.inbound)) return false;
            if (!words.length) return true;
            const hay = `${i.goods_name} ${i.option_info} ${i.order_sno} ${i.buyer_name}`.toLowerCase();
            return words.every((w) => hay.includes(w));
        });
    }, [items, onlyNoSchedule, query]);

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
        return (
            <>
                <b className={o.stock_qty > 0 ? styles.num : styles.zero}>{o.stock_qty > 0 ? `${o.stock_qty}개` : '재고 없음'}</b>
                {o.stock_in_standby > 0 && <span className={styles.muted}> · 입고대기 {o.stock_in_standby}</span>}
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

            <section className={styles.card}>
                {loading && items.length === 0 && <div className={styles.muted}>불러오는 중…</div>}
                {!loading && shown.length === 0 && <div className={styles.muted}>표시할 주문이 없어요.</div>}
                {shown.length > 0 && (
                    <div className={styles.tableWrap}>
                        <table className={styles.table}>
                            <thead>
                                <tr>
                                    <th>상품명</th>
                                    <th>옵션</th>
                                    <th>지연</th>
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
        </div>
    );
}
