import React, { useState, useEffect, useCallback } from 'react';
import { MessageSquare, ChevronDown, ChevronUp } from 'lucide-react';
import styles from './Dashboard.module.css';
import { LOCAL_API_BASE as API, getAuthHeaders, handleUnauthorized } from '../../lib/api';

function formatDate(raw) {
    if (!raw) return '-';
    return String(raw).slice(0, 10);
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
    const [expandedIds, setExpandedIds] = useState(new Set());
    const [commentsCache, setCommentsCache] = useState({});
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

    const getCommentState = (id) => commentsCache[id] ?? { items: null, loading: false, input: '', submitting: false };

    const toggleExpanded = async (id) => {
        const isOpen = expandedIds.has(id);
        setExpandedIds((prev) => {
            const next = new Set(prev);
            if (isOpen) next.delete(id); else next.add(id);
            return next;
        });
        if (!isOpen && !commentsCache[id]?.items) {
            setCommentsCache((prev) => ({ ...prev, [id]: { ...getCommentState(id), loading: true } }));
            try {
                const res = await fetch(`${API}/delivery-anomaly/${id}/comments`, { headers: authHeaders });
                const data = await res.json().catch(() => ({}));
                setCommentsCache((prev) => ({ ...prev, [id]: { ...prev[id], items: data.items || [], loading: false } }));
            } catch {
                setCommentsCache((prev) => ({ ...prev, [id]: { ...prev[id], loading: false, items: [] } }));
            }
        }
    };

    const submitComment = async (id) => {
        const text = (commentsCache[id]?.input || '').trim();
        if (!text) return;
        setCommentsCache((prev) => ({ ...prev, [id]: { ...prev[id], submitting: true } }));
        try {
            const res = await fetch(`${API}/delivery-anomaly/${id}/comments`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders },
                body: JSON.stringify({ text }),
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok) {
                setCommentsCache((prev) => ({
                    ...prev,
                    [id]: {
                        ...prev[id],
                        items: [...(prev[id]?.items || []), { id: `local-${Date.now()}`, username: '나', text, createdAt: data.createdAt }],
                        input: '',
                        submitting: false,
                    },
                }));
                setItems((prev) => prev.map((it) => (it.id === id ? { ...it, commentCount: (it.commentCount || 0) + 1 } : it)));
            } else {
                setCommentsCache((prev) => ({ ...prev, [id]: { ...prev[id], submitting: false } }));
            }
        } catch {
            setCommentsCache((prev) => ({ ...prev, [id]: { ...prev[id], submitting: false } }));
        }
    };

    if (loading || items.length === 0) return null;

    return (
        <div className={styles.card}>
            <div className={styles.cardTitle}>
                택배 이상현상
                <span className={styles.countBadge}>{items.length}</span>
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
                                {item.phone || '-'}
                            </div>
                            <div className={styles.anomalyField}>
                                <span className={styles.anomalyFieldLabel}>발송일</span>
                                {formatDate(item.sentDate)}
                            </div>
                            <div className={styles.anomalyField}>
                                <span className={styles.anomalyFieldLabel}>송장번호</span>
                                {item.invoiceNo}
                            </div>
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
                                {formatDate(item.scanDate)}
                            </div>
                        </div>
                        <button type="button" className={styles.commentToggleBtn} onClick={() => toggleExpanded(item.id)}>
                            <MessageSquare size={11} />
                            댓글
                            {item.commentCount > 0 && <span className={styles.commentCount}>{item.commentCount}</span>}
                            {expandedIds.has(item.id) ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                        </button>
                        {expandedIds.has(item.id) && (
                            <div className={styles.commentSection}>
                                {commentsCache[item.id]?.loading && <div className={styles.commentLoading}>불러오는 중...</div>}
                                {(commentsCache[item.id]?.items || []).map((c) => (
                                    <div key={c.id} className={styles.commentItem}>
                                        <div className={styles.commentMeta}>
                                            <span className={styles.commentAuthor}>{c.username}</span>
                                            <span className={styles.commentTime}>{formatDate(c.createdAt)}</span>
                                        </div>
                                        <div className={styles.commentText}>{c.text}</div>
                                    </div>
                                ))}
                                {!commentsCache[item.id]?.loading && (commentsCache[item.id]?.items || []).length === 0 && (
                                    <div className={styles.commentEmpty}>댓글이 없습니다.</div>
                                )}
                                <div className={styles.commentInputRow}>
                                    <input
                                        className={styles.commentInput}
                                        placeholder="댓글 입력..."
                                        value={commentsCache[item.id]?.input || ''}
                                        onChange={(e) => setCommentsCache((prev) => ({
                                            ...prev,
                                            [item.id]: { ...getCommentState(item.id), ...prev[item.id], input: e.target.value },
                                        }))}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter' && !e.shiftKey) {
                                                e.preventDefault();
                                                submitComment(item.id);
                                            }
                                        }}
                                    />
                                    <button
                                        type="button"
                                        className={styles.commentSubmitBtn}
                                        onClick={() => submitComment(item.id)}
                                        disabled={commentsCache[item.id]?.submitting}
                                    >
                                        등록
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
