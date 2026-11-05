import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import styles from './CSStatsPage.module.css';
import { LOCAL_API_BASE, getAuthHeaders, handleUnauthorized } from '../../lib/api';

const PERIODS = [1, 7, 14, 30];

const fmtTime = (iso) => (iso ? iso.slice(0, 16).replace('T', ' ') : '');
const fmtDuration = (sec) => {
    const s = Math.round(sec || 0);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h > 0 ? `${h}시간 ${m}분` : `${m}분 ${s % 60}초`;
};

const ReturnScanStats = () => {
    const [days, setDays] = useState(7);
    const [data, setData] = useState(null);
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);

    const load = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            const res = await fetch(`${LOCAL_API_BASE}/returns/stats?days=${days}`, { headers: getAuthHeaders() });
            if (handleUnauthorized(res)) return;
            const body = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(body?.detail || '반품 통계 조회 실패');
            setData(body);
        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    }, [days]);

    useEffect(() => {
        load();
    }, [load]);

    const sessions = data?.sessions || [];
    const deletes = data?.deletes || [];
    const totalScans = sessions.reduce((a, s) => a + s.count, 0);
    const totalTypes = {};
    sessions.forEach((s) => Object.entries(s.types || {}).forEach(([t, c]) => { totalTypes[t] = (totalTypes[t] || 0) + c; }));

    return (
        <div className={styles.page}>
            <header className={styles.top}>
                <h2 className={styles.title}>반품 스캔 통계</h2>
                {PERIODS.map((p) => (
                    <button key={p} type="button" className={`${styles.chip} ${days === p ? styles.chipActive : ''}`} onClick={() => setDays(p)}>
                        {p === 1 ? '오늘' : `${p}일`}
                    </button>
                ))}
                <button type="button" className={styles.chip} onClick={load} disabled={loading}>
                    <RefreshCw size={14} /> 새로고침
                </button>
            </header>
            {error && <p className={styles.error}>{error}</p>}
            {data && (
                <>
                    <div className={styles.cards}>
                        <div className={styles.card}><span>세션 수</span><b>{sessions.length}</b></div>
                        <div className={styles.card}><span>세션 내 스캔 합계</span><b>{totalScans}</b></div>
                        <div className={styles.card}>
                            <span>세션 밖 스캔 (시작 없이/끊긴 뒤)</span>
                            <b>{Object.values(data.outside_scans || {}).reduce((a, b) => a + b, 0)}</b>
                        </div>
                    </div>
                    <div className={styles.cards}>
                        <div className={styles.card}>
                            <span>삭제 버튼 누른 횟수</span><b>{data.delete_clicks || 0}번</b>
                            <span>
                                선택삭제 {data.delete_clicks_by_source?.delete || 0}번 · 되돌리기 {data.delete_clicks_by_source?.undo || 0}번
                            </span>
                        </div>
                        <div className={styles.card}><span>삭제된 항목</span><b>{data.delete_items || 0}개</b></div>
                        <div className={styles.card}>
                            <span>스캔 합계 − 삭제 항목</span><b>{(data.total_scans || 0) - (data.delete_items || 0)}개</b>
                        </div>
                    </div>
                    {Object.keys(totalTypes).length > 0 && (
                        <div className={styles.cards}>
                            {Object.entries(totalTypes).sort((a, b) => b[1] - a[1]).map(([t, c]) => (
                                <div key={t} className={styles.card}><span>{t}</span><b>{c}개</b></div>
                            ))}
                        </div>
                    )}
                    <table className={styles.table}>
                        <thead>
                            <tr><th>담당자</th><th>시작</th><th>마지막 스캔</th><th>상태</th><th>처리 수</th><th>구성</th><th>소요</th><th>10분당</th><th>10분 구간별</th></tr>
                        </thead>
                        <tbody>
                            {sessions.length === 0 && <tr><td colSpan={9}>기록 없음</td></tr>}
                            {sessions.map((s, i) => (
                                <tr key={`${s.user}-${s.start}-${i}`}>
                                    <td>{s.user}</td>
                                    <td>{fmtTime(s.start)}</td>
                                    <td>{s.count > 0 ? fmtTime(s.end) : '-'}</td>
                                    <td>{s.active ? <span className={styles.live}>진행 중</span> : '끊김'}</td>
                                    <td>{s.count}</td>
                                    <td>
                                        {Object.entries(s.types || {}).sort((a, b) => b[1] - a[1]).map(([t, c]) => (
                                            <div key={t} className={styles.muted}>{t}: {c}개</div>
                                        ))}
                                    </td>
                                    <td>{fmtDuration(s.elapsed_seconds)}</td>
                                    <td>{s.per_10min == null ? '-' : `${s.per_10min}개`}</td>
                                    <td>
                                        {s.buckets.map((b) => (
                                            <div key={b.label} className={styles.muted}>{b.label}: {b.count}개</div>
                                        ))}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    <h3 className={styles.sub}>삭제된 데이터 ({deletes.length}개{(data.delete_items || 0) > deletes.length ? ` · 최근 ${deletes.length}개만 표시` : ''})</h3>
                    <table className={styles.table}>
                        <thead>
                            <tr><th>삭제 시각</th><th>담당자</th><th>방식</th><th>구분</th><th>스캔 바코드</th><th>내용</th></tr>
                        </thead>
                        <tbody>
                            {deletes.length === 0 && <tr><td colSpan={6}>삭제 기록 없음</td></tr>}
                            {deletes.map((d, i) => (
                                <tr key={`${d.at}-${d.barcode}-${i}`}>
                                    <td>{fmtTime(d.at)}</td>
                                    <td>{d.user}</td>
                                    <td>{d.source === 'undo' ? '되돌리기' : '선택삭제'}</td>
                                    <td>{d.type || '-'}</td>
                                    <td>{d.barcode}</td>
                                    <td>{d.text}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    <p className={styles.note}>
                        삭제는 이 기능 적용 이후부터 기록됩니다. 스캔 합계는 삭제해도 줄어들지 않으므로 저장내역(남아 있는 개수)보다 많을 수 있습니다.
                    </p>
                    <p className={styles.note}>
                        반품 화면에서 "전체 API 불러오기"를 누르면 세션이 시작되고, 마지막 스캔(스캔 전에는 시작) 후 5분간 스캔이 없으면 끊깁니다.
                        소요 시간은 시작 시각부터 마지막 스캔까지이며, 10분당 처리 수 = 처리 수 ÷ 소요 시간 × 10분 입니다. 이 기능 적용 이후 기록부터 집계됩니다.
                    </p>
                </>
            )}
        </div>
    );
};

export default ReturnScanStats;
