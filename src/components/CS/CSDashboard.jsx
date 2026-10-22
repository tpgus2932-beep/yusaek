import { useEffect, useState } from 'react';
import { CalendarPlus, Hourglass, MessageCircleMore, Inbox } from 'lucide-react';
import styles from './CSDashboard.module.css';
import { LOCAL_API_BASE, getAuthHeaders, handleUnauthorized } from '../../lib/api';

const fmtHours = (h) => (h >= 24 ? `${Math.floor(h / 24)}일 ${Math.floor(h % 24)}시간` : `${Math.floor(h)}시간`);

const CSDashboard = ({ refreshKey, onOpenRoom, onOpenInbox, onOpenProduct }) => {
    const [data, setData] = useState(null);
    const [error, setError] = useState('');

    useEffect(() => {
        let cancelled = false;
        fetch(`${LOCAL_API_BASE}/cs/dashboard`, { headers: getAuthHeaders() })
            .then(async (res) => {
                if (handleUnauthorized(res)) return;
                const body = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(body?.detail || '대시보드 조회 실패');
                if (!cancelled) setData(body);
            })
            .catch((err) => {
                if (!cancelled) setError(err.message);
            });
        return () => {
            cancelled = true;
        };
    }, [refreshKey]);

    if (error) return <div className={styles.error}>{error}</div>;
    if (!data) return <div className={styles.empty}>불러오는 중...</div>;

    const maxDaily = Math.max(1, ...data.daily.map((d) => d.count));
    const maxCat = Math.max(1, ...data.by_category.map((c) => c.count));
    const diff = data.today_new - data.yesterday_new;

    return (
        <div className={styles.wrap}>
            <div className={styles.kpis}>
                <button type="button" className={`${styles.kpi} ${data.waiting > 0 ? styles.kpiWarn : styles.kpiOk}`} onClick={onOpenInbox}>
                    <span className={styles.kpiIcon}><MessageCircleMore size={22} /></span>
                    <span className={styles.kpiText}>
                        <span className={styles.kpiLabel}>답변 대기</span>
                        <span className={styles.kpiValue}>{data.waiting}</span>
                        <span className={styles.kpiSub}>고객이 마지막으로 보낸 문의</span>
                    </span>
                </button>
                <div className={`${styles.kpi} ${data.waiting_over_24h > 0 ? styles.kpiWarn : styles.kpiOk}`}>
                    <span className={styles.kpiIcon}><Hourglass size={22} /></span>
                    <span className={styles.kpiText}>
                        <span className={styles.kpiLabel}>24시간 넘게 대기</span>
                        <span className={styles.kpiValue}>{data.waiting_over_24h}</span>
                        <span className={styles.kpiSub}>먼저 챙겨주세요</span>
                    </span>
                </div>
                <div className={styles.kpi}>
                    <span className={styles.kpiIcon}><CalendarPlus size={22} /></span>
                    <span className={styles.kpiText}>
                        <span className={styles.kpiLabel}>오늘 새 문의</span>
                        <span className={styles.kpiValue}>{data.today_new}</span>
                        <span className={styles.kpiSub}>
                            어제 {data.yesterday_new}건 ({diff > 0 ? `+${diff}` : diff})
                        </span>
                    </span>
                </div>
                <div className={styles.kpi}>
                    <span className={styles.kpiIcon}><Inbox size={22} /></span>
                    <span className={styles.kpiText}>
                        <span className={styles.kpiLabel}>진행 중</span>
                        <span className={styles.kpiValue}>{data.in_progress}</span>
                        <span className={styles.kpiSub}>전체 진행 중 문의</span>
                    </span>
                </div>
            </div>

            <div className={styles.grid}>
                <section className={styles.card}>
                    <h3>일별 새 문의</h3>
                    <div className={styles.bars}>
                        {data.daily.map((d, i) => (
                            <div key={d.date} className={styles.barCol} title={`${d.date}: ${d.count}건`}>
                                <span className={styles.barNum}>{d.count || ''}</span>
                                <div
                                    className={`${styles.bar} ${i === data.daily.length - 1 ? styles.barToday : ''}`}
                                    style={{ height: `${(d.count / maxDaily) * 100}%` }}
                                />
                                <span className={styles.barLabel}>{d.date.slice(8)}</span>
                            </div>
                        ))}
                    </div>
                </section>

                <section className={styles.card}>
                    <h3>카테고리별 진행 중</h3>
                    {data.by_category.length === 0 && <div className={styles.empty}>진행 중 문의가 없어요</div>}
                    {data.by_category.map((c) => (
                        <div key={c.name} className={styles.catRow}>
                            <span>{c.name}</span>
                            <div className={styles.catTrack}>
                                <div className={styles.catFill} style={{ width: `${(c.count / maxCat) * 100}%` }} />
                            </div>
                            <span className={styles.catNum}>
                                {c.count}
                                {c.waiting > 0 && <em> · 대기 {c.waiting}</em>}
                            </span>
                        </div>
                    ))}
                </section>

                <section className={`${styles.card} ${styles.wide}`}>
                    <h3>
                        문의 많은 상품 <span className={styles.cardHint}>눌러서 상품별 문의 보기</span>
                        <button type="button" className={styles.linkBtn} onClick={() => onOpenProduct(null)}>전체 보기 →</button>
                    </h3>
                    {(data.by_product || []).length === 0 && <div className={styles.empty}>진행 중인 상품 문의가 없어요</div>}
                    <div className={styles.products}>
                        {(data.by_product || []).map((p) => (
                            <button type="button" key={p.goods_sno} className={styles.product} onClick={() => onOpenProduct(p.goods_sno)}>
                                {p.image ? <img src={p.image} alt="" className={styles.thumb} loading="lazy" /> : <span className={styles.thumb} />}
                                <span className={styles.productName}>{p.clean_name || p.name}</span>
                                <span className={styles.productNums}>
                                    <b>{p.count}</b>
                                    {p.waiting > 0 && <i>대기 {p.waiting}</i>}
                                </span>
                            </button>
                        ))}
                    </div>
                </section>

                <section className={`${styles.card} ${styles.wide}`}>
                    <h3>오래 기다린 문의 TOP 10</h3>
                    {data.oldest_waiting.length === 0 && <div className={styles.empty}>기다리는 문의가 없어요 🎉</div>}
                    {data.oldest_waiting.map((r) => (
                        <button type="button" key={r.sno} className={styles.waitRow} onClick={() => onOpenRoom(r)}>
                            <strong>{r.member?.name || '-'}</strong>
                            <span className={styles.waitCat}>{r.parent_category_display} &gt; {r.child_category_display}</span>
                            <span className={styles.ellipsis}>{r.latest_message?.content || '[이미지]'}</span>
                            <span className={`${styles.waitAge} ${r.waiting_hours >= 24 ? styles.waitOld : ''}`}>
                                {fmtHours(r.waiting_hours)} 경과
                            </span>
                        </button>
                    ))}
                </section>
            </div>
        </div>
    );
};

export default CSDashboard;
