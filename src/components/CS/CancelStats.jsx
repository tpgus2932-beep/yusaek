import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, DownloadCloud } from 'lucide-react';
import {
    Bar, BarChart, CartesianGrid, Legend, Line, LineChart,
    ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import styles from './CSStatsPage.module.css';
import cs from './CancelStats.module.css';
import { LOCAL_API_BASE, getAuthHeaders, handleUnauthorized } from '../../lib/api';

const PERIODS = [7, 14, 30, 60, 90];
const GROUPS = [['day', '일별'], ['week', '주간'], ['month', '월별']];
const TABS = [['products', '상품 리스트'], ['trend', '추이·사유 그래프'], ['delay', '지연 현황']];
const FILTERS = [['all', '전체'], ['surge', '급증'], ['delay', '지연중'], ['risk', '위험 높음']];
const MAX_REASONS = 4; // 사유는 많은 순 4개 + 기타로 묶어 보여준다
const REASON_COLORS = {
    배송지연: '#ef4444',
    '재주문/주문실수': '#4f7cff',
    '옵션(사이즈·색상) 변경': '#14b8a6',
    단순변심: '#a855f7',
    '배송지·배송 관련': '#f59e0b',
    품절: '#64748b',
    '문의/응대 불만': '#ec4899',
    기타: '#94a3b8',
};
const colorOf = (name) => REASON_COLORS[name] || '#94a3b8';
const TOTAL_COLOR = '#4f7cff';
const AXIS = { fill: 'currentColor', fontSize: 12, opacity: 0.7 };
const GRID = { strokeDasharray: '3 3', opacity: 0.15, vertical: false };
const TIP = { background: 'var(--bg-color, #fff)', border: '1px solid var(--border-color, #ddd)', borderRadius: 8, color: 'inherit', fontSize: 12 };

const fmtTime = (iso) => (iso ? iso.slice(0, 16).replace('T', ' ') : '-');
const short = (s, n = 16) => (s && s.length > n ? `${s.slice(0, n)}…` : s || '');
const periodLabel = (p, group) => (group === 'week' ? `${p.slice(5)}~` : group === 'month' ? p : p.slice(5));

// 사유 상위 N개만 남기고 나머지는 '기타'로 합친다
const foldReasons = (rows, names) => {
    const top = names.slice(0, MAX_REASONS);
    const rest = names.slice(MAX_REASONS);
    const out = rows.map((r) => (rest.length ? { ...r, 기타: rest.reduce((a, n) => a + (r[n] || 0), 0) } : r));
    return { rows: out, names: rest.length ? [...top, '기타'] : top };
};

const Toggle = ({ value, onChange, options }) => (
    <div className={cs.toggle}>
        {options.map(([v, label]) => (
            <button key={v} type="button" className={`${cs.mini} ${value === v ? cs.miniActive : ''}`} onClick={() => onChange(v)}>
                {label}
            </button>
        ))}
    </div>
);

const Panel = ({ title, right, children }) => (
    <div className={cs.panel}>
        <div className={cs.panelHead}>
            <h4 className={cs.panelTitle}>{title}</h4>
            {right && <div className={cs.panelRight}>{right}</div>}
        </div>
        {children}
    </div>
);

const Empty = () => <div className={cs.empty}>데이터가 없습니다.</div>;

const Spark = ({ data, color = '#ef4444' }) => {
    const w = 84;
    const h = 24;
    const max = Math.max(1, ...data);
    const pts = data.map((v, i) => `${((i / (data.length - 1)) * w).toFixed(1)},${(h - 2 - (v / max) * (h - 4)).toFixed(1)}`).join(' ');
    return (
        <svg width={w} height={h} className={cs.spark} aria-hidden="true">
            <polyline points={pts} fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" />
        </svg>
    );
};

const SORTS = {
    cancel: (p) => p.cancel,
    ratio: (p) => p.ratio,
    delay: (p) => p.delay_max * 1000 + p.delay_items,
};

const ProductTable = ({ items, total }) => {
    const [filter, setFilter] = useState('all');
    const [sort, setSort] = useState('cancel');
    const [q, setQ] = useState('');
    const [limit, setLimit] = useState(30);
    const [open, setOpen] = useState(null);

    const counts = useMemo(() => ({
        all: items.length,
        surge: items.filter((p) => p.surging).length,
        delay: items.filter((p) => p.delay_items > 0).length,
        risk: items.filter((p) => p.level === '높음').length,
    }), [items]);

    const rows = useMemo(() => {
        const kw = q.trim().toLowerCase();
        return items
            .filter((p) => (filter === 'surge' ? p.surging : filter === 'delay' ? p.delay_items > 0 : filter === 'risk' ? p.level === '높음' : true))
            .filter((p) => !kw || `${p.name} ${p.vendor}`.toLowerCase().includes(kw))
            .sort((a, b) => SORTS[sort](b) - SORTS[sort](a));
    }, [items, filter, sort, q]);

    const th = (key, label) => (
        <th className={`${cs.num} ${cs.sortable} ${sort === key ? cs.sorted : ''}`} onClick={() => setSort(key)}>{label}{sort === key ? ' ▼' : ''}</th>
    );

    return (
        <div className={cs.panel}>
            <div className={cs.panelHead}>
                <div className={cs.toggle}>
                    {FILTERS.map(([v, label]) => (
                        <button key={v} type="button" className={`${cs.mini} ${filter === v ? cs.miniActive : ''}`} onClick={() => { setFilter(v); setLimit(30); }}>
                            {label} {counts[v]}
                        </button>
                    ))}
                </div>
                <input className={cs.search} placeholder="상품명·거래처 검색" value={q} onChange={(e) => { setQ(e.target.value); setLimit(30); }} />
            </div>
            <div className={cs.tableWrapBig}>
                <table className={cs.tbl}>
                    <thead>
                        <tr>
                            <th>#</th><th>상품 / 거래처</th>
                            {th('cancel', '취소')}
                            <th>주요 사유</th><th>최근 14일</th>
                            {th('ratio', '3일 추이')}
                            {th('delay', '현재 지연')}
                            <th>위험</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.slice(0, limit).map((p, i) => (
                            <Fragment key={p.goods_sno}>
                                <tr className={cs.clickRow} onClick={() => setOpen(open === p.goods_sno ? null : p.goods_sno)}>
                                    <td className={cs.rankIdx}>{i + 1}</td>
                                    <td>
                                        <div className={cs.prodName} title={p.name}>{p.name}</div>
                                        <div className={cs.prodVendor}>{p.vendor || '거래처 미지정'}</div>
                                    </td>
                                    <td className={cs.num}><b>{p.cancel.toLocaleString()}</b></td>
                                    <td>
                                        {p.top_reason ? <span className={cs.reasonTag} style={{ borderColor: colorOf(p.top_reason), color: colorOf(p.top_reason) }}>{p.top_reason} {p.top_reason_pct}%</span> : '-'}
                                    </td>
                                    <td><Spark data={p.spark} /></td>
                                    <td className={cs.num}>
                                        <span className={p.surging ? cs.surgeText : ''}>{p.prev} → {p.recent}</span>
                                        {p.surging && <span className={`${cs.badge} ${cs.high}`}>급증 {p.ratio}배</span>}
                                    </td>
                                    <td className={cs.num}>{p.delay_items ? <><b>{p.delay_items}건</b> <span className={cs.dim}>최대 {p.delay_max}일</span></> : <span className={cs.dim}>-</span>}</td>
                                    <td>{p.level ? <span className={`${cs.badge} ${p.level === '높음' ? cs.high : p.level === '주의' ? cs.warn : cs.watch}`}>{p.level}</span> : ''}</td>
                                </tr>
                                {open === p.goods_sno && (
                                    <tr className={cs.detailRow}>
                                        <td />
                                        <td colSpan={7}>
                                            <div className={cs.detail}>
                                                {Object.entries(p.reasons).map(([name, n]) => (
                                                    <span key={name} className={cs.reasonTag} style={{ borderColor: colorOf(name), color: colorOf(name) }}>{name} {n}</span>
                                                ))}
                                                {p.delay_items > 0 && <span className={cs.dim}>지연 평균 {p.delay_avg}일 · 최근 7일 지연사유 취소 {p.delay_cancel_7d}건</span>}
                                            </div>
                                        </td>
                                    </tr>
                                )}
                            </Fragment>
                        ))}
                    </tbody>
                </table>
                {!rows.length && <Empty />}
            </div>
            {rows.length > limit && (
                <button type="button" className={cs.more} onClick={() => setLimit(limit + 50)}>더 보기 ({limit}/{rows.length})</button>
            )}
            <div className={styles.note}>전체 {total}개 상품 중 취소 많은 순 상위 {items.length}개 · 행을 누르면 사유 상세</div>
        </div>
    );
};

const RankList = ({ rows, color }) => {
    const max = Math.max(1, ...rows.map((r) => r.value));
    return (
        <div className={cs.rank}>
            {rows.map((r) => (
                <div key={r.name} className={cs.rankRow}>
                    <span className={cs.rankName} title={r.name}>{r.name}</span>
                    <div className={cs.rankTrack}><div className={cs.rankFill} style={{ width: `${(r.value / max) * 100}%`, background: r.color || color }} /></div>
                    <b className={cs.rankNum}>{r.value.toLocaleString()}</b>
                </div>
            ))}
            {!rows.length && <Empty />}
        </div>
    );
};

const CancelStats = () => {
    const [days, setDays] = useState(30);
    const [group, setGroup] = useState('day');
    const [reasonMode, setReasonMode] = useState('reason');
    const [elapsedMode, setElapsedMode] = useState('total');
    const [tab, setTab] = useState('products');
    const [products, setProducts] = useState(null);
    const [summary, setSummary] = useState(null);
    const [delay, setDelay] = useState(null);
    const [minRecent, setMinRecent] = useState(5);
    const [minRatio, setMinRatio] = useState(2);
    const [loading, setLoading] = useState(false);
    const [syncing, setSyncing] = useState(false);
    const [error, setError] = useState('');

    const get = useCallback(async (path) => {
        const res = await fetch(`${LOCAL_API_BASE}/cancel-stats/${path}`, { headers: getAuthHeaders() });
        if (handleUnauthorized(res)) return null;
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body?.detail || '취소통계 조회 실패');
        return body;
    }, []);

    const load = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            const [s, d, pr] = await Promise.all([
                get(`summary?days=${days}&group=${group}`),
                get('delay'),
                get(`products?days=${days}&min_recent=${minRecent}&min_ratio=${minRatio}`),
            ]);
            if (s) setSummary(s);
            if (d) setDelay(d);
            if (pr) setProducts(pr);
        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    }, [get, days, group, minRecent, minRatio]);

    useEffect(() => {
        load();
    }, [load]);

    const syncNow = async () => {
        setSyncing(true);
        setError('');
        try {
            const res = await fetch(`${LOCAL_API_BASE}/cancel-stats/sync`, { method: 'POST', headers: getAuthHeaders() });
            if (handleUnauthorized(res)) return;
            const body = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(body?.detail || '동기화 실패');
            await load();
        } catch (err) {
            setError(err.message);
        } finally {
            setSyncing(false);
        }
    };

    const names = useMemo(() => summary?.reason_names || [], [summary]);
    const trend = useMemo(
        () => foldReasons((summary?.series || []).map((r) => ({ ...r, label: periodLabel(r.period, group) })), names),
        [summary, group, names],
    );
    const elapsed = useMemo(() => foldReasons(summary?.elapsed || [], names), [summary, names]);
    const delayRatio = summary?.total ? Math.round((summary.delay_reason_count / summary.total) * 100) : 0;
    const topProducts = (summary?.top_products || []).slice(0, 8).map((p) => ({ ...p, label: short(p.name, 20) }));
    const stacks = (mode, list) => (mode === 'reason' ? list : ['total']);
    const bar = (r, id) => (
        <Bar key={r} dataKey={r} name={r === 'total' ? '전체 취소' : r} stackId={id} fill={r === 'total' ? TOTAL_COLOR : colorOf(r)} />
    );
    const legend = <Legend verticalAlign="top" align="left" height={28} wrapperStyle={{ fontSize: 12 }} />;

    return (
        <div className={styles.page}>
            <header className={styles.top} style={{ flexWrap: 'wrap' }}>
                <h2 className={styles.title}>취소 통계</h2>
                {PERIODS.map((p) => (
                    <button key={p} type="button" className={`${styles.chip} ${days === p ? styles.chipActive : ''}`} onClick={() => setDays(p)}>
                        {p}일
                    </button>
                ))}
                <button type="button" className={styles.chip} onClick={load} disabled={loading}><RefreshCw size={14} /> 새로고침</button>
                <button type="button" className={styles.chip} onClick={syncNow} disabled={syncing}>
                    <DownloadCloud size={14} /> {syncing ? '수집 중…' : '에이블리 수집'}
                </button>
                <span className={styles.note}>마지막 수집 {fmtTime(summary?.last_sync_at)} · 3시간마다 자동</span>
            </header>
            {error && <p className={styles.error}>{error}</p>}
            {summary?.last_error && <p className={styles.error}>자동 수집 오류: {summary.last_error}</p>}

            {summary && (
                <div className={cs.kpi}>
                    <div className={cs.kpiCard}><span>취소 건수</span><b>{summary.total.toLocaleString()}</b><small>최근 {days}일</small></div>
                    <div className={cs.kpiCard}><span>배송지연 사유</span><b>{delayRatio}%</b><small>{summary.delay_reason_count.toLocaleString()}건</small></div>
                    <div className={cs.kpiCard}><span>평균 경과일</span><b>{summary.avg_elapsed ?? '-'}일</b><small>결제 → 취소요청</small></div>
                    <div className={cs.kpiCard}><span>현재 지연 주문</span><b>{(delay?.total ?? 0).toLocaleString()}</b><small>{delay?.snapshot_at ? `${fmtTime(delay.snapshot_at)} 기준` : ''}</small></div>
                </div>
            )}

            <div className={cs.subTabs}>
                {TABS.map(([v, label]) => (
                    <button key={v} type="button" className={`${cs.subTab} ${tab === v ? cs.subTabActive : ''}`} onClick={() => setTab(v)}>{label}</button>
                ))}
            </div>

            {tab === 'trend' && (
                <>
                    <Panel
                        title="취소 건수 추이"
                        right={<><Toggle value={group} onChange={setGroup} options={GROUPS} /><Toggle value={reasonMode} onChange={setReasonMode} options={[['reason', '사유별'], ['total', '통합']]} /></>}
                    >
                        {trend.rows.length ? (
                            <ResponsiveContainer width="100%" height={320}>
                                <BarChart data={trend.rows}>
                                    <CartesianGrid {...GRID} />
                                    <XAxis dataKey="label" tick={AXIS} interval="preserveStartEnd" />
                                    <YAxis tick={AXIS} width={40} />
                                    <Tooltip contentStyle={TIP} />
                                    {reasonMode === 'reason' && legend}
                                    {stacks(reasonMode, trend.names).map((r) => bar(r, 'a'))}
                                </BarChart>
                            </ResponsiveContainer>
                        ) : <Empty />}
                    </Panel>

                    <div className={cs.grid2}>
                        <Panel title="결제 후 취소까지 걸린 기간" right={<Toggle value={elapsedMode} onChange={setElapsedMode} options={[['total', '통합'], ['reason', '사유별']]} />}>
                            {elapsed.rows.length ? (
                                <ResponsiveContainer width="100%" height={260}>
                                    <BarChart data={elapsed.rows}>
                                        <CartesianGrid {...GRID} />
                                        <XAxis dataKey="bucket" tick={AXIS} />
                                        <YAxis tick={AXIS} width={40} />
                                        <Tooltip contentStyle={TIP} />
                                        {elapsedMode === 'reason' && legend}
                                        {stacks(elapsedMode, elapsed.names).map((r) => bar(r, 'e'))}
                                    </BarChart>
                                </ResponsiveContainer>
                            ) : <Empty />}
                        </Panel>

                        <Panel title="취소 사유">
                            <RankList rows={(summary?.reasons || []).map((r) => ({ name: r.name, value: r.count, color: colorOf(r.name) }))} />
                        </Panel>
                    </div>

                    <Panel title="취소 많은 상품 TOP 8">
                        {topProducts.length ? (
                            <ResponsiveContainer width="100%" height={topProducts.length * 34 + 20}>
                                <BarChart data={topProducts} layout="vertical" margin={{ left: 10, right: 30 }}>
                                    <XAxis type="number" hide />
                                    <YAxis type="category" dataKey="label" tick={AXIS} width={150} />
                                    <Tooltip contentStyle={TIP} formatter={(v) => [`${v}건`, '취소']} />
                                    <Bar dataKey="count" name="취소" fill={TOTAL_COLOR} radius={[0, 4, 4, 0]} label={{ position: 'right', fontSize: 12, fill: 'currentColor' }} />
                                </BarChart>
                            </ResponsiveContainer>
                        ) : <Empty />}
                    </Panel>
                </>
            )}

            {tab === 'products' && (
                <>
                    <div className={cs.filters}>
                        급증 기준: 최근 3일 취소 ≥<input type="number" min={1} value={minRecent} onChange={(e) => setMinRecent(Math.max(1, Number(e.target.value) || 1))} />건 · 직전 3일 대비 ≥<input type="number" min={1} step={0.5} value={minRatio} onChange={(e) => setMinRatio(Math.max(1, Number(e.target.value) || 1))} />배
                    </div>
                    {products ? <ProductTable items={products.items} total={products.total_products} /> : <Empty />}
                </>
            )}

            {tab === 'delay' && (
                <>
                    <div className={cs.grid2}>
                        <Panel title="지연 일수 분포">
                            {delay?.total ? (
                                <ResponsiveContainer width="100%" height={220}>
                                    <BarChart data={delay.days_dist}>
                                        <CartesianGrid {...GRID} />
                                        <XAxis dataKey="bucket" tick={AXIS} />
                                        <YAxis tick={AXIS} width={40} />
                                        <Tooltip contentStyle={TIP} />
                                        <Bar dataKey="count" name="주문상품" fill="#f59e0b" label={{ position: 'top', fontSize: 12, fill: 'currentColor' }} />
                                    </BarChart>
                                </ResponsiveContainer>
                            ) : <Empty />}
                        </Panel>
                        <Panel title="거래처별 지연 주문 (선제 연락)">
                            <RankList rows={(delay?.vendors || []).slice(0, 8).map((v) => ({ name: v.vendor, value: v.items }))} color="#f59e0b" />
                        </Panel>
                    </div>
                    {delay?.trend?.length > 1 && (
                        <Panel title="지연 주문 추이">
                            <ResponsiveContainer width="100%" height={180}>
                                <LineChart data={delay.trend}>
                                    <CartesianGrid {...GRID} />
                                    <XAxis dataKey="day" tick={AXIS} />
                                    <YAxis tick={AXIS} width={40} />
                                    <Tooltip contentStyle={TIP} />
                                    <Line type="monotone" dataKey="count" name="지연 주문" stroke="#ef4444" strokeWidth={2} dot={{ r: 3 }} />
                                </LineChart>
                            </ResponsiveContainer>
                        </Panel>
                    )}
                </>
            )}
        </div>
    );
};

export default CancelStats;
