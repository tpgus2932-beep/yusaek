import React, { useState, useEffect, useCallback } from 'react';
import { MessageSquare, ChevronDown, ChevronUp, RefreshCw } from 'lucide-react';
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

// 서버가 실제로 에이블리/LLogis를 다시 조회한 시각(lastRunAt)을 그대로 보여준다 -
// 브라우저에서 F5로 목록만 다시 불러온 시각을 쓰면, 오늘 이미 실행되어 캐시만
// 반환된 경우에도 "방금 새로고침한 것"처럼 보이는 문제가 있었다.
function formatRefreshTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return `${d.getMonth() + 1}월 ${d.getDate()}일 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export default function ReturnAnomalyCard() {
    const [items, setItems] = useState([]);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [lastRefreshedAt, setLastRefreshedAt] = useState(null);
    const [memos, setMemos] = useState({});
    const [draftMemos, setDraftMemos] = useState({});
    const [expandedInvoices, setExpandedInvoices] = useState(new Set());
    const [regatheringInvoices, setRegatheringInvoices] = useState(new Set());
    const authHeaders = getAuthHeaders();

    const fetchList = useCallback(async () => {
        try {
            const res = await fetch(`${API}/return-anomaly/list`, { headers: authHeaders });
            if (handleUnauthorized(res)) return;
            const data = await res.json().catch(() => ({}));
            if (res.ok) {
                setItems(data.items || []);
                setLastRefreshedAt(data.lastRunAt || null);
            }
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
            try {
                const res = await fetch(`${API}/return-anomaly/run`, {
                    method: 'POST',
                    headers: authHeaders,
                });
                if (res.ok && !cancelled) await fetchList();
            } catch {
                // 로컬 백엔드에 연결할 수 없으면 조용히 무시
            }
        })();
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        fetch(`${API}/return-regathering/list`, { headers: authHeaders })
            .then((r) => (r.ok ? r.json() : null))
            .then((data) => {
                if (!data) return;
                const invoices = (data.items || [])
                    .map((it) => it.return_invoice)
                    .filter(Boolean);
                setRegatheringInvoices(new Set(invoices));
            })
            .catch(() => {});
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
            const res = await fetch(`${API}/return-anomaly/run?force=true`, {
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

    if (loading || items.length === 0) return null;

    return (
        <div className={styles.card}>
            <div className={styles.cardTitle}>
                <span>
                    반품 이상현상
                    <span className={styles.countBadge} style={{ marginLeft: '0.45rem' }}>{items.length}</span>
                </span>
                <div className={styles.anomalyTitleActions}>
                    {lastRefreshedAt && (
                        <span className={styles.anomalyLastRefresh}>
                            마지막 새로고침 {formatRefreshTime(lastRefreshedAt)}
                        </span>
                    )}
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
                                <span className={styles.anomalyFieldLabel}>반품신청일</span>
                                {formatDate(item.requestedAt)}
                            </div>
                            <div className={styles.anomalyField}>
                                <span className={styles.anomalyFieldLabel}>반품송장번호</span>
                                {item.returnInvoiceNo}
                                {regatheringInvoices.has(item.returnInvoiceNo) && (
                                    <span className={styles.pendingBadge} style={{ marginLeft: '0.4rem' }}>오회수 접수됨</span>
                                )}
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
                                {formatScanDate(item.scanDate)}
                            </div>
                        </div>
                        <div className={styles.anomalyActionRow}>
                            <button
                                type="button"
                                className={`${styles.commentToggleBtn} ${memos[item.returnInvoiceNo] ? styles.anomalyMemoActive : ''}`}
                                onClick={() => toggleMemo(item.returnInvoiceNo)}
                            >
                                <MessageSquare size={11} fill={memos[item.returnInvoiceNo] ? 'currentColor' : 'none'} />
                                메모
                                {expandedInvoices.has(item.returnInvoiceNo) ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                            </button>
                        </div>
                        {expandedInvoices.has(item.returnInvoiceNo) && (
                            <div className={styles.commentSection}>
                                <div className={styles.commentInputRow}>
                                    <textarea
                                        className={styles.commentInput}
                                        rows={2}
                                        placeholder="메모를 입력하세요... (배송현황조회와 공유됩니다)"
                                        value={draftMemos[item.returnInvoiceNo] ?? ''}
                                        onChange={(e) => setDraftMemos((d) => ({ ...d, [item.returnInvoiceNo]: e.target.value }))}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) saveMemo(item.returnInvoiceNo);
                                        }}
                                    />
                                    <button
                                        type="button"
                                        className={styles.commentSubmitBtn}
                                        onClick={() => saveMemo(item.returnInvoiceNo)}
                                    >
                                        저장
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
