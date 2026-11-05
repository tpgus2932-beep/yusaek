import React, { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';
import styles from './SellerPage.module.css';
import { LOCAL_API_BASE as API, getAuthHeaders } from '../../lib/api';
import SellerStatsDashboard from './SellerStatsDashboard';

const TYPE_FILTERS = [
    { key: 'all', label: '전체' },
    { key: 'return', label: '반품' },
    { key: 'exchange', label: '교환' },
];

const SellerPage = () => {
    const [returns, setReturns] = useState([]);
    const [exchanges, setExchanges] = useState([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [typeFilter, setTypeFilter] = useState('all');
    const [groupByProduct, setGroupByProduct] = useState(true);
    const [search, setSearch] = useState('');
    const [collapsed, setCollapsed] = useState(new Set());
    const [zoomImage, setZoomImage] = useState(null);
    const [view, setView] = useState('list');
    const [loaded, setLoaded] = useState(false); // 새로고침 버튼을 눌러 한 번이라도 불러왔는지

    const fetchAll = async () => {
        setLoaded(true);
        setLoading(true);
        setError('');
        try {
            const [retRes, exRes] = await Promise.all([
                fetch(`${API}/return-shipping/seller-fault-pending`, { headers: getAuthHeaders() }),
                fetch(`${API}/exchange-return/seller-fault-pending`, { headers: getAuthHeaders() }),
            ]);
            const [retData, exData] = await Promise.all([
                retRes.json().catch(() => ({})),
                exRes.json().catch(() => ({})),
            ]);
            const errors = [];
            if (retRes.ok && retData.ok) setReturns(retData.items || []);
            else { setReturns([]); errors.push(`반품: ${retData?.detail || '조회 실패'}`); }
            if (exRes.ok && exData.ok) setExchanges(exData.items || []);
            else { setExchanges([]); errors.push(`교환: ${exData?.detail || '조회 실패'}`); }
            if (errors.length) setError(errors.join(' / '));
        } catch (err) {
            setError(err.message || '조회 실패');
        } finally {
            setLoading(false);
        }
    };

    const rows = useMemo(() => {
        const all = [
            ...returns.map((r) => ({
                type: 'return',
                key: `return:${r.invoice}_${r.sno}`,
                goods_name: r.goods_name,
                reason: r.reason,
                comment: r.user_comment,
                invoice: r.invoice,
                order_sno: r.order_sno,
                buyer_name: r.buyer_name,
                buyer_tel: r.buyer_tel,
                images: r.images || [],
                thumbs: r.images_webp || [],
            })),
            ...exchanges.map((e) => ({
                type: 'exchange',
                key: `exchange:${e.exchange_sno}`,
                goods_name: e.goods_name,
                reason: e.reason,
                comment: e.detail_reason,
                invoice: e.invoice,
                order_sno: e.order_sno,
                buyer_name: e.buyer_name,
                buyer_tel: e.buyer_tel,
                images: e.images || [],
            })),
        ];
        const q = search.trim().toLowerCase();
        return all.filter((r) => {
            if (typeFilter !== 'all' && r.type !== typeFilter) return false;
            if (!q) return true;
            return [r.goods_name, r.invoice, r.buyer_name, r.buyer_tel, r.comment]
                .some((v) => String(v || '').toLowerCase().includes(q));
        });
    }, [returns, exchanges, typeFilter, search]);

    const groups = useMemo(() => {
        const map = new Map();
        rows.forEach((r) => {
            const name = r.goods_name || '(상품명 없음)';
            if (!map.has(name)) map.set(name, []);
            map.get(name).push(r);
        });
        return [...map.entries()]
            .map(([name, items]) => ({ name, items }))
            .sort((a, b) => b.items.length - a.items.length);
    }, [rows]);

    const toggleGroup = (name) => {
        setCollapsed((prev) => {
            const next = new Set(prev);
            if (next.has(name)) next.delete(name); else next.add(name);
            return next;
        });
    };

    const renderRow = (r) => (
        <div key={r.key} className={styles.row}>
            <div className={styles.images}>
                {r.images.slice(0, 3).map((src, i) => (
                    <img
                        key={i}
                        src={r.thumbs?.[i] || src}
                        alt="사진"
                        loading="lazy"
                        decoding="async"
                        className={styles.thumb}
                        onClick={() => setZoomImage(src)}
                    />
                ))}
            </div>
            <div className={styles.rowBody}>
                <div className={styles.rowTop}>
                    <span className={`${styles.typeBadge} ${r.type === 'return' ? styles.typeReturn : styles.typeExchange}`}>
                        {r.type === 'return' ? '반품' : '교환'}
                    </span>
                    {!groupByProduct && <span className={styles.goodsName}>{r.goods_name}</span>}
                    <span className={styles.reason}>{r.reason}</span>
                </div>
                {r.comment && <div className={styles.comment}>고객메모: {r.comment}</div>}
                <div className={styles.meta}>
                    주문번호 {r.order_sno || '-'} · 송장 {r.invoice || '-'} · {r.buyer_name || '-'} · {r.buyer_tel || '-'}
                </div>
            </div>
        </div>
    );

    return (
        <div className={styles.page}>
            <div className={styles.header}>
                <div>
                    <h1 className={styles.title}>판매자 사유 (에이블리)</h1>
                    <p className={styles.subtitle}>
                        반품·교환 중 판매자 사유(상품 하자/오배송, 셀러 변경)로 접수된 미처리 건 · 최근 30일
                    </p>
                </div>
                <div className={styles.segment}>
                    <button
                        type="button"
                        className={`${styles.segBtn} ${view === 'list' ? styles.segBtnActive : ''}`}
                        onClick={() => setView('list')}
                    >
                        목록
                    </button>
                    <button
                        type="button"
                        className={`${styles.segBtn} ${view === 'stats' ? styles.segBtnActive : ''}`}
                        onClick={() => setView('stats')}
                    >
                        통계
                    </button>
                </div>
                {view === 'list' && (
                    <button type="button" className={styles.btn} onClick={fetchAll} disabled={loading}>
                        <RefreshCw size={13} className={loading ? styles.spinning : undefined} />
                        새로고침
                    </button>
                )}
            </div>

            {view === 'stats' ? <SellerStatsDashboard /> : (<>
            <div className={styles.toolbar}>
                <div className={styles.segment}>
                    {TYPE_FILTERS.map((f) => (
                        <button
                            key={f.key}
                            type="button"
                            className={`${styles.segBtn} ${typeFilter === f.key ? styles.segBtnActive : ''}`}
                            onClick={() => setTypeFilter(f.key)}
                        >
                            {f.label}
                            {f.key === 'return' && ` ${returns.length}`}
                            {f.key === 'exchange' && ` ${exchanges.length}`}
                        </button>
                    ))}
                </div>
                <label className={styles.check}>
                    <input
                        type="checkbox"
                        checked={groupByProduct}
                        onChange={(e) => setGroupByProduct(e.target.checked)}
                    />
                    상품별로 묶기
                </label>
                <input
                    type="text"
                    className={styles.search}
                    placeholder="상품명 / 송장 / 구매자 / 메모 검색"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                />
                <span className={styles.count}>{rows.length}건{groupByProduct ? ` · 상품 ${groups.length}종` : ''}</span>
            </div>

            {error && <div className={styles.error}>{error}</div>}
            {loading && <div className={styles.empty}>불러오는 중...</div>}
            {!loaded && !loading && (
                <div className={styles.empty}>새로고침 버튼을 누르면 판매자 사유 건을 불러옵니다.</div>
            )}
            {loaded && !loading && rows.length === 0 && !error && (
                <div className={styles.empty}>판매자 사유 건이 없습니다.</div>
            )}

            {!loading && groupByProduct && groups.map((g) => {
                const isCollapsed = collapsed.has(g.name);
                const retCnt = g.items.filter((i) => i.type === 'return').length;
                const exCnt = g.items.length - retCnt;
                return (
                    <section key={g.name} className={styles.group}>
                        <button type="button" className={styles.groupHeader} onClick={() => toggleGroup(g.name)}>
                            {isCollapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
                            <span className={styles.groupName}>{g.name}</span>
                            <span className={styles.groupCount}>
                                총 {g.items.length}건 (반품 {retCnt} / 교환 {exCnt})
                            </span>
                        </button>
                        {!isCollapsed && <div className={styles.groupBody}>{g.items.map(renderRow)}</div>}
                    </section>
                );
            })}

            {!loading && !groupByProduct && rows.length > 0 && (
                <div className={styles.groupBody}>{rows.map(renderRow)}</div>
            )}
            </>)}

            {zoomImage && (
                <div className={styles.zoomOverlay} onClick={() => setZoomImage(null)}>
                    <img src={zoomImage} alt="확대" className={styles.zoomImg} />
                </div>
            )}
        </div>
    );
};

export default SellerPage;
