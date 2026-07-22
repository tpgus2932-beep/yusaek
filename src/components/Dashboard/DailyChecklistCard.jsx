import React, { useState, useEffect, useCallback, useRef } from 'react';
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

// 대시보드(Overview)는 사이드메뉴를 옮기면 통째로 언마운트된다 - 이 카드도 같이
// 사라졌다 다시 마운트되는데, 실행 중이던 fetch 체인 자체는 끊기지 않고 계속
// 진행된다(JS 타이머/프로미스는 컴포넌트 생명주기와 무관). 문제는 "실행 중" 상태를
// 컴포넌트 state로만 들고 있으면 언마운트 시 사라져서, 다시 들어왔을 때 버튼이
// 멀쩡해 보여 같은/다른 액션을 또 눌러 진짜 동시실행(EZAdmin 세션 충돌)을 만들 수
// 있다는 것 - 그래서 실행 상태를 모듈 스코프에 두고, 재마운트한 카드가 진행 중인
// 작업을 이어서 구독하도록 한다(ReturnAutomationDashboard의 activePreviewJob과 동일 패턴).
//
// 이건 같은 브라우저 탭 안에서의 메뉴 이동까지만 지켜준다 - 실제 브라우저
// 새로고침(F5)은 이 모듈 자체를 포함해 JS 런타임을 통째로 날려버리므로 클라이언트
// 상태만으로는 절대 복구할 수 없다. 그래서 각 액션의 진행 여부를 서버(app_settings의
// `${key}_running_at`)에도 남긴다 - 단일 백엔드 호출로 끝나는 항목(신규반품/교환
// 회수접수/상품준비중 송장입력)은 해당 라우터가 자체적으로 try/finally로 기록하므로
// 새로고침에도 진짜 진행 상태를 정확히 반영한다. 여러 단계를 프론트에서 순차 호출하는
// "전체처리"만 mark-start/mark-finish로 감싸는데, 새로고침으로 그 루프 자체가
// 끊기면 mark-finish가 못 불리므로 서버의 stale 타임아웃(30분)이 안전장치 역할을 한다.
//
// 실행 결과 메시지도 같은 이유로 서버(`${key}_last_result`)에 남긴다 - 작업이
// 끝나는 순간 다른 메뉴에 가 있거나 그 사이 새로고침했다면, 이 컴포넌트의 로컬
// resultMsg state는 사라지므로 status 응답의 last_result로 복원한다.
let activeJob = null; // { key, listeners: Set<(result) => void> }

function startJob(key, fn, authHeaders) {
    const listeners = new Set();
    const job = { key, listeners };
    activeJob = job;

    fetch(`${API}/daily-checklist/${key}/mark-start`, { method: 'POST', headers: authHeaders }).catch(() => {});

    (async () => {
        let result;
        try {
            result = await fn();
        } catch (err) {
            result = { message: err.message || '실패' };
        }
        if (activeJob === job) activeJob = null;
        // fetchStatus()가 곧이어 listeners 쪽에서 호출되므로, 그 전에 결과 메시지가
        // 서버에 반영되도록 기다린다 - 그래야 다른 메뉴에 갔다 오거나 새로고침한
        // 뒤에도 "마지막 실행 결과"가 비어 보이지 않는다.
        const finishBody = result?.pending ? {} : { message: result?.message || '완료' };
        try {
            await fetch(`${API}/daily-checklist/${key}/mark-finish`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders },
                body: JSON.stringify(finishBody),
            });
        } catch {
            // 백엔드에 연결 안 되면 로컬 표시(resultMsg)만으로 대체
        }
        listeners.forEach((cb) => cb(result));
    })();

    return job;
}

const POLL_INTERVAL_MS = 4000;

export default function DailyChecklistCard() {
    const [items, setItems] = useState([]);
    const [loading, setLoading] = useState(true);
    const [activeKey, setActiveKey] = useState(() => activeJob?.key ?? null);
    const [resultMsg, setResultMsg] = useState({});
    const { openModal: openEzadminModal } = useEzadminSession();
    const authHeaders = getAuthHeaders();
    const pollTimerRef = useRef(null);

    const fetchStatus = useCallback(async () => {
        try {
            const res = await fetch(`${API}/daily-checklist/status`, { headers: getAuthHeaders() });
            if (handleUnauthorized(res)) return;
            const data = await res.json().catch(() => ({}));
            if (res.ok) {
                const nextItems = data.items || [];
                setItems(nextItems);

                // 이 탭에서 시작한 작업(activeJob)을 이미 구독 중이면 그쪽이 진행 상황을
                // 즉시 알려주므로 여기서는 건드리지 않는다. activeJob이 없는데 서버가
                // "진행 중"이라고 하면(새로고침으로 로컬 상태를 잃은 경우) 그 항목을
                // 이어서 폴링한다 - 완료될 때까지 버튼이 재활성화되면 안 되기 때문.
                if (!activeJob) {
                    const running = nextItems.find((it) => it.in_progress);
                    if (running) {
                        setActiveKey(running.key);
                        if (!pollTimerRef.current) {
                            pollTimerRef.current = setTimeout(() => {
                                pollTimerRef.current = null;
                                fetchStatus();
                            }, POLL_INTERVAL_MS);
                        }
                    } else {
                        setActiveKey(null);
                        if (pollTimerRef.current) {
                            clearTimeout(pollTimerRef.current);
                            pollTimerRef.current = null;
                        }
                    }
                }
            }
        } catch {
            // 로컬 백엔드에 연결할 수 없으면 조용히 무시
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchStatus();
        return () => {
            if (pollTimerRef.current) {
                clearTimeout(pollTimerRef.current);
                pollTimerRef.current = null;
            }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // 이 카드가 마운트됐을 때 이미 실행 중인 작업(다른 탭에 있는 동안 시작된 것)이
    // 있으면 그 결과를 이어서 구독한다 - 새로 시작하지 않는다.
    useEffect(() => {
        if (!activeJob) return undefined;
        const job = activeJob;
        setActiveKey(job.key);
        const onDone = (result) => {
            setActiveKey(null);
            if (!result?.pending) {
                setResultMsg((prev) => ({ ...prev, [job.key]: result?.message || '완료' }));
            }
            fetchStatus();
        };
        job.listeners.add(onDone);
        return () => job.listeners.delete(onDone);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const run = (key, fn) => {
        if (activeJob) return; // 이미 다른 작업이 실행 중 - 버튼도 비활성화돼 있어야 정상
        setResultMsg((prev) => ({ ...prev, [key]: '' }));
        setActiveKey(key);
        const job = startJob(key, fn, authHeaders);
        job.listeners.add((result) => {
            setActiveKey(null);
            if (!result?.pending) {
                setResultMsg((prev) => ({ ...prev, [key]: result?.message || '완료' }));
            }
            fetchStatus();
        });
    };

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
        const excludedNote = data.seller_fault_excluded > 0 ? ` (판매자 부담 ${data.seller_fault_excluded}건 제외)` : '';
        return { message: `송장 ${data.invoice_count || 0}건 처리${excludedNote}` };
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
        // 전체 대상을 끝까지 처리했을 때만 "오늘 실행됨"으로 기록한다 - 이 호출
        // 전에 새로고침되면 루프가 여기까지 오지 못해 done_today가 false로 남는다.
        await fetch(`${API}/exchange-return/process-all-complete`, {
            method: 'POST',
            headers: authHeaders,
        }).catch(() => {});
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
                                    {(resultMsg[item.key] || item.last_result) && ` · ${resultMsg[item.key] || item.last_result}`}
                                </span>
                            </div>
                            <button
                                type="button"
                                className={styles.primaryBtn}
                                style={{ marginLeft: 'auto' }}
                                onClick={() => run(item.key, RUNNERS[item.key])}
                                disabled={!!activeKey}
                            >
                                {activeKey === item.key ? '실행 중...' : '실행'}
                            </button>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}
