import React, { useState, useEffect, useCallback } from 'react';
import { MessageSquare, ChevronDown, ChevronUp, RefreshCw, Send } from 'lucide-react';
import styles from './Dashboard.module.css';
import { LOCAL_API_BASE as API, getAuthHeaders, handleUnauthorized } from '../../lib/api';

function formatDate(raw) {
    if (!raw) return '-';
    return String(raw).slice(0, 10);
}

function formatPhone(raw) {
    if (!raw) return '-';
    return String(raw).replace(/-/g, '');
}

function formatScanDate(raw) {
    if (!raw) return '-';
    const s = String(raw).replace(/\D/g, '');
    if (s.length < 8) return raw;
    const month = parseInt(s.slice(4, 6), 10);
    const day = parseInt(s.slice(6, 8), 10);
    return `${month}월 ${day}일`;
}

function isPastFourPmKst() {
    const now = new Date();
    const kstHour = Number(
        new Intl.DateTimeFormat('en-US', {
            timeZone: 'Asia/Seoul',
            hour: '2-digit',
            hour12: false,
        }).format(now)
    );
    return kstHour >= 16;
}

export default function DeliveryAnomalyCard() {
    const [items, setItems] = useState([]);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [memos, setMemos] = useState({});
    const [draftMemos, setDraftMemos] = useState({});
    const [expandedInvoices, setExpandedInvoices] = useState(new Set());
    const [confirmStatus, setConfirmStatus] = useState({});
    const [respondStatus, setRespondStatus] = useState({});
    const [respondDrafts, setRespondDrafts] = useState({});
    const [expandedRespond, setExpandedRespond] = useState(new Set());
    const authHeaders = getAuthHeaders();

    const fetchList = useCallback(async () => {
        try {
            const res = await fetch(`${API}/delivery-anomaly/list`, { headers: authHeaders });
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
        let cancelled = false;
        (async () => {
            await fetchList();
            if (cancelled) return;
            if (isPastFourPmKst()) {
                try {
                    const res = await fetch(`${API}/delivery-anomaly/run`, {
                        method: 'POST',
                        headers: authHeaders,
                    });
                    if (res.ok && !cancelled) await fetchList();
                } catch {
                    // 로컬 백엔드에 연결할 수 없으면 조용히 무시
                }
            }
        })();
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        fetch(`${API}/return-shipping/memos`, { headers: authHeaders })
            .then((r) => (r.ok ? r.json() : null))
            .then((serverMemos) => {
                if (!serverMemos) return;
                const stripped = {};
                Object.entries(serverMemos).forEach(([k, v]) => {
                    stripped[k] = typeof v === 'object' ? v.memo ?? '' : v;
                });
                setMemos(stripped);
            })
            .catch(() => {});
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const handleManualRefresh = async () => {
        setRefreshing(true);
        try {
            const res = await fetch(`${API}/delivery-anomaly/run?force=true`, {
                method: 'POST',
                headers: authHeaders,
            });
            if (handleUnauthorized(res)) return;
            if (res.ok) await fetchList();
        } catch {
            // 로컬 백엔드에 연결할 수 없으면 조용히 무시
        } finally {
            setRefreshing(false);
        }
    };

    const toggleMemo = (inv) => {
        setExpandedInvoices((prev) => {
            const next = new Set(prev);
            if (next.has(inv)) {
                next.delete(inv);
            } else {
                next.add(inv);
                setDraftMemos((d) => ({ ...d, [inv]: memos[inv] || '' }));
            }
            return next;
        });
    };

    const saveMemo = (inv) => {
        const val = draftMemos[inv] ?? memos[inv] ?? '';
        setMemos((prev) => {
            if (!val) { const next = { ...prev }; delete next[inv]; return next; }
            return { ...prev, [inv]: val };
        });
        fetch(`${API}/return-shipping/memo`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders },
            body: JSON.stringify({ invoice_no: inv, memo: val }),
        }).catch(() => {});
    };

    const handleConfirmReceipt = async (item) => {
        const id = item.id;
        if (!String(item.phone || '').trim()) {
            setConfirmStatus((prev) => ({ ...prev, [id]: { state: 'error', message: '전화번호가 없습니다.' } }));
            return;
        }
        setConfirmStatus((prev) => ({ ...prev, [id]: { state: 'sending' } }));
        try {
            const res = await fetch(`${API}/delivery-anomaly/${id}/confirm-send`, {
                method: 'POST',
                headers: authHeaders,
            });
            const data = await res.json().catch(() => ({}));
            if (data?.need_ezdesk_session) {
                setConfirmStatus((prev) => ({
                    ...prev,
                    [id]: { state: 'error', message: 'EZDesk 세션이 만료되었습니다. 반품자동화 탭에서 세션을 다시 입력해주세요.' },
                }));
                return;
            }
            if (!res.ok || data?.ok === false) {
                setConfirmStatus((prev) => ({ ...prev, [id]: { state: 'error', message: '문자 발송에 실패했습니다.' } }));
                return;
            }
            setConfirmStatus((prev) => ({ ...prev, [id]: { state: 'idle' } }));
            await fetchList();
        } catch {
            setConfirmStatus((prev) => ({ ...prev, [id]: { state: 'error', message: '문자 발송에 실패했습니다.' } }));
        }
    };

    const sendRespond = async (id, endpoint, body) => {
        setRespondStatus((prev) => ({ ...prev, [id]: { state: 'sending' } }));
        try {
            const res = await fetch(`${API}/delivery-anomaly/${id}/${endpoint}`, {
                method: 'POST',
                headers: body ? { 'Content-Type': 'application/json', ...authHeaders } : authHeaders,
                body: body ? JSON.stringify(body) : undefined,
            });
            const data = await res.json().catch(() => ({}));
            if (data?.need_ezdesk_session) {
                setRespondStatus((prev) => ({
                    ...prev,
                    [id]: { state: 'error', message: 'EZDesk 세션이 만료되었습니다. 반품자동화 탭에서 세션을 다시 입력해주세요.' },
                }));
                return;
            }
            if (!res.ok || data?.ok === false) {
                setRespondStatus((prev) => ({ ...prev, [id]: { state: 'error', message: '문자 발송에 실패했습니다.' } }));
                return;
            }
            setRespondStatus((prev) => ({ ...prev, [id]: { state: 'idle' } }));
            setExpandedRespond((prev) => { const next = new Set(prev); next.delete(id); return next; });
            await fetchList();
        } catch {
            setRespondStatus((prev) => ({ ...prev, [id]: { state: 'error', message: '문자 발송에 실패했습니다.' } }));
        }
    };

    const handleRespondLost = (item) => sendRespond(item.id, 'respond-lost');

    const toggleRespond = (id) => {
        setExpandedRespond((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    };

    const handleRespondCustom = (item) => {
        const text = (respondDrafts[item.id] || '').trim();
        if (!text) return;
        sendRespond(item.id, 'respond-custom', { text });
    };

    if (loading || items.length === 0) return null;

    return (
        <div className={styles.card}>
            <div className={styles.cardTitle}>
                <span>
                    택배 이상현상
                    <span className={styles.countBadge} style={{ marginLeft: '0.45rem' }}>{items.length}</span>
                </span>
                <button
                    type="button"
                    className={`${styles.filterBtn} ${styles.anomalyRefreshBtn}`}
                    onClick={handleManualRefresh}
                    disabled={refreshing}
                >
                    <RefreshCw size={12} className={refreshing ? styles.spinning : undefined} />
                    새로고침
                </button>
            </div>
            <div className={styles.anomalyList}>
                {items.map((item) => (
                    <div key={item.id} className={styles.anomalyRow}>
                        <div className={styles.anomalyGrid}>
                            <div className={styles.anomalyField}>
                                <span className={styles.anomalyFieldLabel}>주문번호</span>
                                {item.orderNo || '-'}
                            </div>
                            <div className={styles.anomalyField}>
                                <span className={styles.anomalyFieldLabel}>상품명</span>
                                {item.productName || '-'}
                            </div>
                            <div className={styles.anomalyField}>
                                <span className={styles.anomalyFieldLabel}>옵션</span>
                                {item.optionInfo || '-'}
                            </div>
                            <div className={styles.anomalyField}>
                                <span className={styles.anomalyFieldLabel}>전화번호</span>
                                {formatPhone(item.phone)}
                            </div>
                            <div className={styles.anomalyField}>
                                <span className={styles.anomalyFieldLabel}>발송일</span>
                                {formatDate(item.sentDate)}
                            </div>
                            <div className={styles.anomalyField}>
                                <span className={styles.anomalyFieldLabel}>송장번호</span>
                                {item.invoiceNo}
                            </div>
                            {item.reason && (!item.status || item.status === '-') ? (
                                <div className={`${styles.anomalyField} ${styles.anomalyMissingMsg}`}>
                                    {item.reason}
                                </div>
                            ) : (
                                <>
                                    <div className={styles.anomalyField}>
                                        <span className={styles.anomalyFieldLabel}>배송상태</span>
                                        {item.status || '-'}
                                    </div>
                                    <div className={styles.anomalyField}>
                                        <span className={styles.anomalyFieldLabel}>위치</span>
                                        {item.location || '-'}
                                    </div>
                                    <div className={styles.anomalyField}>
                                        <span className={styles.anomalyFieldLabel}>최종스캔일</span>
                                        {formatScanDate(item.scanDate)}
                                    </div>
                                </>
                            )}
                        </div>
                        {item.confirmReply && (
                            <div className={styles.anomalyReplyBlock}>
                                <span className={styles.anomalyReplyBlockLabel}>고객 답장</span>
                                <div className={styles.anomalyReplyBlockText}>{item.confirmReply}</div>
                            </div>
                        )}
                        <div className={styles.anomalyActionRow}>
                            <button
                                type="button"
                                className={`${styles.commentToggleBtn} ${memos[item.invoiceNo] ? styles.anomalyMemoActive : ''}`}
                                onClick={() => toggleMemo(item.invoiceNo)}
                            >
                                <MessageSquare size={11} fill={memos[item.invoiceNo] ? 'currentColor' : 'none'} />
                                메모
                                {expandedInvoices.has(item.invoiceNo) ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                            </button>
                            <button
                                type="button"
                                className={styles.commentToggleBtn}
                                onClick={() => handleConfirmReceipt(item)}
                                disabled={confirmStatus[item.id]?.state === 'sending'}
                            >
                                <Send size={11} />
                                {item.confirmSentAt ? '재발송' : '수령여부확인'}
                            </button>
                            {confirmStatus[item.id]?.state === 'sending' && (
                                <span className={styles.anomalyConfirmStatus}>발송 중...</span>
                            )}
                            {confirmStatus[item.id]?.state === 'error' && (
                                <span className={`${styles.anomalyConfirmStatus} ${styles.anomalyConfirmError}`}>
                                    {confirmStatus[item.id].message}
                                </span>
                            )}
                            {confirmStatus[item.id]?.state !== 'sending' && item.confirmSentAt && (
                                <span className={styles.anomalyConfirmStatus}>
                                    발송완료 {formatDate(item.confirmSentAt)}
                                </span>
                            )}
                            {item.confirmReply && !item.responseSentAt && (
                                <>
                                    <button
                                        type="button"
                                        className={styles.commentToggleBtn}
                                        onClick={() => handleRespondLost(item)}
                                        disabled={respondStatus[item.id]?.state === 'sending'}
                                    >
                                        <Send size={11} />
                                        미수령
                                    </button>
                                    <button
                                        type="button"
                                        className={styles.commentToggleBtn}
                                        onClick={() => toggleRespond(item.id)}
                                        disabled={respondStatus[item.id]?.state === 'sending'}
                                    >
                                        답변하기
                                        {expandedRespond.has(item.id) ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                                    </button>
                                </>
                            )}
                            {respondStatus[item.id]?.state === 'sending' && (
                                <span className={styles.anomalyConfirmStatus}>발송 중...</span>
                            )}
                            {respondStatus[item.id]?.state === 'error' && (
                                <span className={`${styles.anomalyConfirmStatus} ${styles.anomalyConfirmError}`}>
                                    {respondStatus[item.id].message}
                                </span>
                            )}
                            {item.responseSentAt && (
                                <span className={styles.anomalyConfirmStatus}>
                                    응대완료 {formatDate(item.responseSentAt)}
                                </span>
                            )}
                        </div>
                        {expandedInvoices.has(item.invoiceNo) && (
                            <div className={styles.commentSection}>
                                <div className={styles.commentInputRow}>
                                    <textarea
                                        className={styles.commentInput}
                                        rows={2}
                                        placeholder="메모를 입력하세요... (배송현황조회와 공유됩니다)"
                                        value={draftMemos[item.invoiceNo] ?? ''}
                                        onChange={(e) => setDraftMemos((d) => ({ ...d, [item.invoiceNo]: e.target.value }))}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) saveMemo(item.invoiceNo);
                                        }}
                                    />
                                    <button
                                        type="button"
                                        className={styles.commentSubmitBtn}
                                        onClick={() => saveMemo(item.invoiceNo)}
                                    >
                                        저장
                                    </button>
                                </div>
                            </div>
                        )}
                        {expandedRespond.has(item.id) && (
                            <div className={styles.commentSection}>
                                <div className={styles.commentInputRow}>
                                    <textarea
                                        className={styles.commentInput}
                                        rows={3}
                                        placeholder="답변을 직접 입력하세요..."
                                        value={respondDrafts[item.id] ?? ''}
                                        onChange={(e) => setRespondDrafts((d) => ({ ...d, [item.id]: e.target.value }))}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handleRespondCustom(item);
                                        }}
                                    />
                                    <button
                                        type="button"
                                        className={styles.commentSubmitBtn}
                                        onClick={() => handleRespondCustom(item)}
                                        disabled={respondStatus[item.id]?.state === 'sending'}
                                    >
                                        보내기
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                ))}
            </div>
        </div>
    );
}
