import React, { useState, useEffect, useCallback } from 'react';
import { RefreshCw } from 'lucide-react';
import styles from './Dashboard.module.css';
import { LOCAL_API_BASE as API, getAuthHeaders, handleUnauthorized } from '../../lib/api';
import { useEzadminSession } from '../../lib/EzadminSessionContext';

function toDateStr(d) {
    return d.toISOString().slice(0, 10);
}

function defaultDateRange() {
    const today = new Date();
    const monthAgo = new Date(today);
    monthAgo.setDate(monthAgo.getDate() - 30);
    return { start_date: toDateStr(monthAgo), end_date: toDateStr(today) };
}

function formatDateTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return `${d.getMonth() + 1}월 ${d.getDate()}일 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

export default function DailyChecklistCard() {
    const [items, setItems] = useState([]);
    const [loading, setLoading] = useState(true);
    const [running, setRunning] = useState({});
    const [resultMsg, setResultMsg] = useState({});
    const { openModal: openEzadminModal } = useEzadminSession();
    const authHeaders = getAuthHeaders();

    const fetchStatus = useCallback(async () => {
        try {
            const res = await fetch(`${API}/daily-checklist/status`, { headers: authHeaders });
            if (handleUnauthorized(res)) return;
            const data = await res.json().catch(() => ({}));
            if (res.ok) setItems(data.items || []);
        } catch {
            // 로컬 백엔드에 연결할 수 없으면 조용히 무시
        } finally {
            setLoading(false);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        fetchStatus();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const run = useCallback(async (key, fn) => {
        setRunning((prev) => ({ ...prev, [key]: true }));
        setResultMsg((prev) => ({ ...prev, [key]: '' }));
        try {
            const result = await fn();
            if (result?.pending) return; // EZAdmin 세션 모달을 띄운 상태 - 저장 후 재시도됨
            setResultMsg((prev) => ({ ...prev, [key]: result?.message || '완료' }));
        } catch (err) {
            setResultMsg((prev) => ({ ...prev, [key]: err.message || '실패' }));
        } finally {
            setRunning((prev) => ({ ...prev, [key]: false }));
            await fetchStatus();
        }
    }, [fetchStatus]);

    const runNewReturnPickup = async () => {
        const res = await fetch(`${API}/return-shipping/new-return-pickup`, {
            method: 'POST',
            headers: authHeaders,
        });
        const data = await res.json().catch(() => ({}));
        if (data?.need_session) {
            openEzadminModal(() => run('daily_check_new_return_pickup', runNewReturnPickup));
            return { pending: true };
        }
        if (!res.ok || !data.ok) return { message: data.error || data.detail || '실패' };
        return { message: `송장 ${data.invoice_count || 0}건 처리` };
    };

    const runExchangePickup = async () => {
        const res = await fetch(`${API}/exchange-return/process-exchange-pickup`, {
            method: 'POST',
            headers: authHeaders,
        });
        const data = await res.json().catch(() => ({}));
        if (data?.need_session) {
            openEzadminModal(() => run('daily_check_exchange_pickup', runExchangePickup));
            return { pending: true };
        }
        if (!res.ok || !data.ok) return { message: data.error || data.detail || '실패' };
        return { message: `교환 ${data.exchange_count || 0}건, 송장 ${data.invoice_count || 0}건` };
    };

    const runShipPending = async () => {
        const { start_date, end_date } = defaultDateRange();
        const res = await fetch(`${API}/exchange-return/ship-pending`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders },
            body: JSON.stringify({ start_date, end_date }),
        });
        const data = await res.json().catch(() => ({}));
        if (data?.need_session) {
            openEzadminModal(() => run('daily_check_ship_pending', runShipPending));
            return { pending: true };
        }
        if (!res.ok || data.ok === false) return { message: data.error || data.detail || '실패' };
        return { message: `성공 ${data.success ?? 0} / 스킵 ${data.skipped ?? 0} / 실패 ${data.failed ?? 0}` };
    };

    const runProcessAll = async () => {
        const { start_date, end_date } = defaultDateRange();
        const listRes = await fetch(
            `${API}/exchange-return/list?start_date=${start_date}&end_date=${end_date}`,
            { headers: authHeaders }
        );
        const listData = await listRes.json().catch(() => ({}));
        if (!listRes.ok) return { message: listData.detail || '목록 조회 실패' };
        const targets = listData.items || [];
        if (!targets.length) return { message: '교환수거중 미처리 건 없음' };
        let success = 0, skipped = 0, failed = 0;
        for (const item of targets) {
            try {
                const res = await fetch(`${API}/exchange-return/process-one`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', ...authHeaders },
                    body: JSON.stringify({ exchange_sno: item.exchange_sno, order_item_sno: item.order_item_sno }),
                });
                const data = await res.json().catch(() => ({}));
                if (data.ok) success++;
                else if (data.skipped) skipped++;
                else failed++;
            } catch {
                failed++;
            }
            await sleep(300);
        }
        return { message: `성공 ${success} / 스킵 ${skipped} / 실패 ${failed}` };
    };

    const RUNNERS = {
        daily_check_new_return_pickup: runNewReturnPickup,
        daily_check_exchange_pickup: runExchangePickup,
        daily_check_process_all: runProcessAll,
        daily_check_ship_pending: runShipPending,
    };

    if (loading || items.length === 0) return null;

    return (
        <div className={styles.card}>
            <div className={styles.cardTitle}>
                <span>일일 체크리스트</span>
                <button
                    type="button"
                    className={`${styles.filterBtn} ${styles.anomalyRefreshBtn}`}
                    onClick={fetchStatus}
                >
                    <RefreshCw size={12} />
                    새로고침
                </button>
            </div>
            <div className={styles.freshnessCard}>
                <div className={styles.freshnessItems}>
                    {items.map((item) => (
                        <div key={item.key} className={styles.freshnessInfo}>
                            <span
                                className={`${styles.freshnessDot} ${item.done_today ? styles.freshnessDotBlue : styles.freshnessDotRed}`}
                            />
                            <div className={styles.freshnessText}>
                                <span className={styles.freshnessTextTitle}>{item.label}</span>
                                <span>
                                    {item.done_today
                                        ? `오늘 ${formatDateTime(item.last_run_at)} 실행됨`
                                        : item.last_run_at
                                            ? `마지막 실행 ${formatDateTime(item.last_run_at)} (오늘 아직 안 함)`
                                            : '아직 실행하지 않았습니다.'}
                                    {resultMsg[item.key] && ` · ${resultMsg[item.key]}`}
                                </span>
                            </div>
                            <button
                                type="button"
                                className={styles.primaryBtn}
                                style={{ marginLeft: 'auto' }}
                                onClick={() => run(item.key, RUNNERS[item.key])}
                                disabled={!!running[item.key]}
                            >
                                {running[item.key] ? '실행 중...' : '실행'}
                            </button>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}
