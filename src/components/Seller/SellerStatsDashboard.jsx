import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw, DownloadCloud } from 'lucide-react';
import {
    Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import styles from './SellerStatsDashboard.module.css';
import { LOCAL_API_BASE as API, getAuthHeaders } from '../../lib/api';

const PERIODS = [
    { days: 7, label: '7일' },
    { days: 30, label: '30일' },
    { days: 90, label: '90일' },
];
const COLOR_RETURN = '#4f7cff';
const COLOR_EXCHANGE = '#f59e0b';
const COLOR_RATE = '#ef4444';

const ymd = (d) => {
    const z = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
};
const won = (n) => `${Number(n || 0).toLocaleString()}원`;

const RankList = ({ title, hint, rows, color, valueOf, subOf }) => {
    const max = Math.max(1, ...rows.map((r) => Number(valueOf(r)) || 0));
    return (
        <section className={styles.card}>
            <h3 className={styles.cardTitle}>{title}</h3>
            {hint && <p className={styles.hint}>{hint}</p>}
            {rows.length === 0 ? (
                <div className={styles.empty}>데이터 없음</div>
            ) : (
                <ol className={styles.rankList}>
                    {rows.map((r, i) => {
                        const v = Number(valueOf(r)) || 0;
                        return (
                            <li key={`${r.goods_sno || r.name}-${i}`} className={styles.rankRow}>
                                <span className={styles.rankNo}>{i + 1}</span>
                                <div className={styles.rankMain}>
                                    <span className={styles.rankName} title={r.name}>{r.name}</span>
                                    <div className={styles.rankBar}>
                                        <div className={styles.rankFill} style={{ width: `${(v / max) * 100}%`, background: color }} />
                                    </div>
                                </div>
                                <div className={styles.rankValue}>
                                    <b>{valueOf(r, true)}</b>
                                    {subOf && <small>{subOf(r)}</small>}
                                </div>
                            </li>
                        );
                    })}
                </ol>
            )}
        </section>
    );
};

const SellerStatsDashboard = () => {
    const [days, setDays] = useState(30);
    const [minSales, setMinSales] = useState(50);
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(false);
    const [syncing, setSyncing] = useState(false);
    const [message, setMessage] = useState('');
    const [error, setError] = useState('');

    const load = useCallback(async (periodDays, minSalesValue) => {
        setLoading(true);
        setError('');
        try {
            const end = new Date();
            const start = new Date();
            start.setDate(start.getDate() - periodDays);
            const qs = new URLSearchParams({ start: ymd(start), end: ymd(end), min_sales: String(minSalesValue) });
            const res = await fetch(`${API}/seller-stats?${qs}`, { headers: getAuthHeaders() });
            const body = await res.json().catch(() => ({}));
            if (!res.ok || body.ok === false) throw new Error(body.detail || '통계 조회에 실패했습니다.');
            setData(body);
        } catch (err) {
            setError(err.message || '통계 조회에 실패했습니다.');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { load(days, minSales); }, [days, minSales, load]);

    const sync = async () => {
        setSyncing(true);
        setError('');
        setMessage('');
        try {
            const res = await fetch(`${API}/seller-stats/sync?days=30`, { method: 'POST', headers: getAuthHeaders() });
            const body = await res.json().catch(() => ({}));
            if (!res.ok || body.ok === false) throw new Error(body.detail || '불러오기에 실패했습니다.');
            setMessage(`최근 30일 환불요청 ${body.refund_requested}건 + 반품완료 ${body.completed}건 중 판매자 건을 저장했습니다.`);
            await load(days, minSales);
        } catch (err) {
            setError(err.message || '불러오기에 실패했습니다.');
        } finally {
            setSyncing(false);
        }
    };

    const pct = (v) => (v === null || v === undefined ? '-' : `${v}%`);

    return (
        <div>
            <div className={styles.toolbar}>
                <div className={styles.segment}>
                    {PERIODS.map((p) => (
                        <button
                            key={p.days}
                            type="button"
                            className={`${styles.segBtn} ${days === p.days ? styles.segBtnActive : ''}`}
                            onClick={() => setDays(p.days)}
                        >
                            최근 {p.label}
                        </button>
                    ))}
                </div>
                <label className={styles.hint}>
                    반품률 순위 최소 판매
                    <select value={minSales} onChange={(e) => setMinSales(Number(e.target.value))} className={styles.select}>
                        {[20, 50, 100, 200].map((n) => <option key={n} value={n}>{n}개 이상</option>)}
                    </select>
                </label>
                <button type="button" className={styles.btn} onClick={() => load(days, minSales)} disabled={loading}>
                    <RefreshCw size={13} className={loading ? styles.spinning : undefined} />
                    새로고침
                </button>
                <button type="button" className={styles.btn} onClick={sync} disabled={syncing}>
                    <DownloadCloud size={13} className={syncing ? styles.spinning : undefined} />
                    {syncing ? '에이블리에서 불러오는 중...' : '에이블리 30일 불러오기'}
                </button>
                {data?.last_updated && <span className={styles.hint}>마지막 저장 {data.last_updated.replace('T', ' ')}</span>}
            </div>

            {error && <div className={styles.error}>{error}</div>}
            {message && <div className={styles.notice}>{message}</div>}

            {data && data.total === 0 && !loading && (
                <div className={styles.empty}>
                    저장된 판매자 건이 없습니다. “에이블리 30일 불러오기”를 눌러 환불요청·반품완료 내역을 가져오세요.
                </div>
            )}

            {data && data.total > 0 && (
                <>
                    <div className={styles.kpis}>
                        <div className={styles.kpi}><span>전체</span><b>{data.total}건</b></div>
                        <div className={styles.kpi}><span>반품</span><b style={{ color: COLOR_RETURN }}>{data.return_count}건</b></div>
                        <div className={styles.kpi}><span>교환</span><b style={{ color: COLOR_EXCHANGE }}>{data.exchange_count}건</b></div>
                        <div className={styles.kpi}><span>수량</span><b>{data.qty}개</b></div>
                        <div className={styles.kpi}><span>환불 금액</span><b>{won(data.refund_amount)}</b></div>
                        <div className={styles.kpi}>
                            <span>판매 수량 (출고 대용)</span>
                            <b>{data.sales_total.toLocaleString()}개</b>
                        </div>
                        <div className={styles.kpi}>
                            <span>판매자 반품률</span>
                            <b style={{ color: COLOR_RATE }}>{pct(data.return_rate)}</b>
                        </div>
                    </div>

                    <section className={styles.card}>
                        <h3 className={styles.cardTitle}>일별 판매자 건수 · 반품률(최근 7일 누적)</h3>
                        <ResponsiveContainer width="100%" height={280}>
                            <ComposedChart data={data.daily} margin={{ left: 0, right: 8 }}>
                                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                                <XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={(v) => v.slice(5)} minTickGap={24} />
                                <YAxis yAxisId="cnt" allowDecimals={false} width={36} />
                                <YAxis yAxisId="rate" orientation="right" width={44} tickFormatter={(v) => `${v}%`} />
                                <Tooltip formatter={(v, name) => (name === '반품률' ? pct(v) : v)} />
                                <Legend />
                                <Bar yAxisId="cnt" dataKey="return" name="반품" stackId="a" fill={COLOR_RETURN} />
                                <Bar yAxisId="cnt" dataKey="exchange" name="교환" stackId="a" fill={COLOR_EXCHANGE} />
                                <Line
                                    yAxisId="rate"
                                    type="monotone"
                                    dataKey="rate7"
                                    name="반품률"
                                    stroke={COLOR_RATE}
                                    strokeWidth={2}
                                    dot={false}
                                    connectNulls
                                />
                            </ComposedChart>
                        </ResponsiveContainer>
                        <p className={styles.hint}>
                            반품률 = 판매자 반품 수량 ÷ 에이블리 판매 수량(주문추천 판매통계 기준, 수집된 날만). 판매 수량이 수집되지 않은 날은 계산에서 빠집니다.
                        </p>
                    </section>

                    <div className={styles.grid}>
                        <RankList
                            title="상품별 반품률 순위"
                            hint={`판매 ${data.min_sales}개 이상 상품 · 판매자 반품 수량 ÷ 판매 수량`}
                            rows={data.products_by_rate}
                            color={COLOR_RATE}
                            valueOf={(r, text) => (text ? `${r.rate}%` : r.rate)}
                            subOf={(r) => `반품 ${r.return_qty} / 판매 ${r.sales.toLocaleString()}`}
                        />
                        <RankList
                            title="상품별 반품 건수 순위"
                            rows={data.products_by_count}
                            color={COLOR_RETURN}
                            valueOf={(r, text) => (text ? `${r.count}건` : r.count)}
                            subOf={(r) => `판매 ${r.sales.toLocaleString()}개 · 반품률 ${r.rate === null ? '-' : `${r.rate}%`}`}
                        />
                    </div>

                    <div className={styles.grid}>
                        <RankList
                            title="거래처별 TOP 10"
                            rows={data.by_vendor}
                            color="#10b981"
                            valueOf={(r, text) => (text ? `${r.count}건` : r.count)}
                            subOf={(r) => `판매 ${r.sales.toLocaleString()}개 · 반품률 ${r.rate === null ? '-' : `${r.rate}%`}`}
                        />
                        <RankList
                            title="처리 상태별"
                            rows={data.by_status}
                            color="#8b5cf6"
                            valueOf={(r, text) => (text ? `${r.count}건` : r.count)}
                        />
                    </div>
                </>
            )}
        </div>
    );
};

export default SellerStatsDashboard;
