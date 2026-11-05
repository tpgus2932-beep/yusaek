import React, { useState, useEffect, useCallback, useRef } from 'react';
import { MessageSquare, ChevronDown, ChevronUp, RefreshCw } from 'lucide-react';
import styles from './Dashboard.module.css';
import { LOCAL_API_BASE as API, getAuthHeaders, handleUnauthorized } from '../../lib/api';
import { useEzadminSession } from '../../lib/EzadminSessionContext';
import ReceiptSkippedList from './ReceiptSkippedList';

function formatDate(raw) {
    if (!raw) return '-';
    return String(raw).slice(0, 10);
}

function formatPhone(raw) {
    if (!raw) return '-';
    return String(raw).replace(/-/g, '');
}

// 오회수 큐에 쌓이는 값(스캔 원본, 숫자만)과 반품 이상현상의 반품송장번호
// (LLogis rltnInvNoView, 대시 포함 표시용 값)는 같은 송장이라도 문자열
// 표기가 달라서 그냥 비교하면 매칭이 안 된다 - 숫자만 남겨서 비교한다.
function normalizeInvoice(raw) {
    return String(raw || '').replace(/[^0-9]/g, '');
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
    const { openModal: openEzadminModal } = useEzadminSession();
    const [receiptOpen, setReceiptOpen] = useState(false);
    const [receiptLoading, setReceiptLoading] = useState(false);
    const [receiptError, setReceiptError] = useState('');
    const [receiptResult, setReceiptResult] = useState(null);
    const [receiptProgress, setReceiptProgress] = useState({ phase: '', done: 0, total: 0 });
    const receiptRunRef = useRef(0);
    const [refundLoading, setRefundLoading] = useState(false);
    const [refundMsg, setRefundMsg] = useState('');

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
                    .map((it) => normalizeInvoice(it.return_invoice))
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

    // 반품 이상현상 건마다 EZAdmin 재고로그에서 원송장번호가 사유에 잡히는지(이미 입고됐는지) 확인
    const runReceiptCheck = async () => {
        const runId = ++receiptRunRef.current;
        setReceiptOpen(true);
        setReceiptLoading(true);
        setReceiptError('');
        setReceiptResult(null);
        setRefundMsg('');
        setReceiptProgress({ phase: '시작 중', done: 0, total: 0 });
        try {
            const res = await fetch(`${API}/return-anomaly/receipt-check`, { method: 'POST', headers: authHeaders });
            if (handleUnauthorized(res)) return;
            const start = await res.json().catch(() => ({}));
            if (start?.need_session) { setReceiptOpen(false); setReceiptLoading(false); openEzadminModal(runReceiptCheck); return; }
            if (!res.ok || !start?.job_id) throw new Error(start?.detail || '입고체크 실패');
            while (receiptRunRef.current === runId) {
                await new Promise((r) => setTimeout(r, 1000));
                if (receiptRunRef.current !== runId) return;
                const sres = await fetch(`${API}/return-anomaly/receipt-check/${start.job_id}`, { headers: authHeaders });
                if (handleUnauthorized(sres)) return;
                const job = await sres.json().catch(() => ({}));
                if (!sres.ok) throw new Error(job?.detail || '진행도 조회 실패');
                setReceiptProgress({ phase: job.phase, done: job.done, total: job.total });
                if (!job.finished) continue;
                if (job.error) throw new Error(job.error);
                if (job.result?.need_session) { setReceiptOpen(false); openEzadminModal(runReceiptCheck); return; }
                setReceiptResult(job.result);
                break;
            }
        } catch (err) {
            if (receiptRunRef.current !== runId) return;
            setReceiptResult(null);
            setReceiptError(err.message || '입고체크 실패');
        } finally {
            if (receiptRunRef.current === runId) setReceiptLoading(false);
        }
    };

    const closeReceipt = () => {
        receiptRunRef.current += 1;
        setReceiptLoading(false);
        setReceiptOpen(false);
    };

    // 입고체크로 잡힌 건을 에이블리 반품환불요청으로 넘김
    const requestRefund = async () => {
        const ids = (receiptResult?.matched || []).map((m) => m.id);
        if (!ids.length) return;
        if (!window.confirm(`잡힌 ${ids.length}건을 반품환불요청으로 넘길까요?`)) return;
        setRefundLoading(true);
        setRefundMsg('');
        try {
            const res = await fetch(`${API}/return-anomaly/refund-request`, {
                method: 'POST',
                headers: { ...authHeaders, 'Content-Type': 'application/json' },
                body: JSON.stringify({ ids }),
            });
            if (handleUnauthorized(res)) return;
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data?.ok) throw new Error(data?.error || data?.detail || '처리 실패');
            const fails = (data.results || []).filter((r) => !r.ok).map((r) => `${r.orderNo || r.returnInvoiceNo}: ${r.error}`);
            setRefundMsg(`반품환불요청 성공 ${data.success} / 실패 ${data.failed}${fails.length ? `\n${fails.join('\n')}` : ''}`);
        } catch (err) {
            setRefundMsg(err.message || '처리 실패');
        } finally {
            setRefundLoading(false);
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
                        onClick={runReceiptCheck}
                        disabled={receiptLoading}
                    >
                        입고체크
                    </button>
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
                                <span
                                    style={{
                                        marginLeft: '0.4rem',
                                        fontSize: '0.62rem',
                                        fontWeight: 700,
                                        padding: '0.14rem 0.45rem',
                                        borderRadius: '999px',
                                        background: item.isSeller ? 'rgba(239,68,68,0.12)' : 'rgba(128,128,128,0.15)',
                                        color: item.isSeller ? '#dc2626' : 'var(--text-muted, #6b7280)',
                                    }}
                                >
                                    {item.isSeller ? '판매자' : '고객'}
                                </span>
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
                                {regatheringInvoices.has(normalizeInvoice(item.returnInvoiceNo)) && (
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
            {receiptOpen && (
                <div className={styles.previewOverlay} onClick={closeReceipt}>
                    <div className={styles.previewModal} style={{ width: 'min(1100px, 96vw)' }} onClick={(e) => e.stopPropagation()}>
                        <div className={styles.previewHeader}>
                            <strong>입고체크 (원송장번호가 EZAdmin 재고로그 사유에 잡힌 반품 건)</strong>
                            <button type="button" className={styles.filterBtn} onClick={closeReceipt}>닫기</button>
                        </div>
                        <div style={{ overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                            {receiptLoading && (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                                    <div>
                                        {receiptProgress.phase}
                                        {receiptProgress.total > 0 && ` (${receiptProgress.done} / ${receiptProgress.total})`}
                                    </div>
                                    <div style={{ height: '8px', borderRadius: '999px', background: 'var(--d-border-strong, #ddd)', overflow: 'hidden' }}>
                                        <div
                                            style={{
                                                height: '100%',
                                                width: `${receiptProgress.total > 0 ? Math.round((receiptProgress.done / receiptProgress.total) * 100) : 5}%`,
                                                background: 'var(--d-indigo, #4f46e5)',
                                                transition: 'width 0.3s ease',
                                            }}
                                        />
                                    </div>
                                </div>
                            )}
                            {receiptError && <div style={{ color: 'var(--d-red, #dc3545)' }}>{receiptError}</div>}
                            {receiptResult && !receiptLoading && (
                                <>
                                    <div>
                                        검사 {receiptResult.checked}건 중 <strong>{receiptResult.matched.length}건</strong> 잡힘
                                        {receiptResult.skipped.length > 0 && ` · 판단 불가 ${receiptResult.skipped.length}건`}
                                    </div>
                                    {receiptResult.matched.length === 0 && <div>잡히는 건이 없습니다.</div>}
                                    {receiptResult.matched.length > 0 && (
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                                            <button type="button" className={styles.filterBtn} disabled={refundLoading} onClick={requestRefund}>
                                                {refundLoading ? '처리 중...' : `잡힌 ${receiptResult.matched.length}건 반품환불요청`}
                                            </button>
                                            {refundMsg && <div style={{ whiteSpace: 'pre-wrap', fontSize: '0.85rem' }}>{refundMsg}</div>}
                                        </div>
                                    )}
                                    {receiptResult.matched.map((m) => (
                                        <div key={m.id} className={styles.anomalyRow}>
                                            <div className={styles.anomalyGrid}>
                                                <div className={styles.anomalyField}><span className={styles.anomalyFieldLabel}>주문번호</span>{m.orderNo || '-'}</div>
                                                <div className={styles.anomalyField}><span className={styles.anomalyFieldLabel}>상품코드</span>{m.productCode}</div>
                                                <div className={styles.anomalyField}><span className={styles.anomalyFieldLabel}>상품명</span>{m.productName || '-'}</div>
                                                <div className={styles.anomalyField}><span className={styles.anomalyFieldLabel}>옵션</span>{m.optionInfo || '-'}</div>
                                                <div className={styles.anomalyField}><span className={styles.anomalyFieldLabel}>원송장번호</span>{m.originInvoice}</div>
                                                <div className={styles.anomalyField}><span className={styles.anomalyFieldLabel}>반품송장번호</span>{m.returnInvoiceNo}</div>
                                                <div className={styles.anomalyField}><span className={styles.anomalyFieldLabel}>조회기간</span>{m.range}</div>
                                            </div>
                                            {m.logs.map((l, i) => (
                                                <div key={i} style={{ fontSize: '0.8rem', marginTop: '0.35rem' }}>
                                                    {l.일시} · {l.구분} {l.수량} (재고 {l.재고}) · {l.사유}
                                                </div>
                                            ))}
                                        </div>
                                    ))}
                                    <ReceiptSkippedList skipped={receiptResult.skipped} matchUrl={`${API}/return-anomaly/receipt-check/match`} />
                                </>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
