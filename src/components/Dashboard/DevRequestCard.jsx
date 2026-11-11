import React, { useCallback, useEffect, useState } from 'react';
import styles from './Dashboard.module.css';
import { COLLAB_API_BASE as API, getAuthHeaders, handleUnauthorized } from '../../lib/api';

const formatTime = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
};

// 개발요청: 모든 계정이 등록하고, 관리자가 완료하면 요청자에게 '요청 보내기'로 완료 알림이 간다.
export default function DevRequestCard() {
    const [items, setItems] = useState([]);
    const [loading, setLoading] = useState(false);
    const [text, setText] = useState('');
    const [showInput, setShowInput] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState('');

    const fetchItems = useCallback(async () => {
        setLoading(true);
        try {
            const res = await fetch(`${API}/dev-requests`, { headers: getAuthHeaders() });
            if (handleUnauthorized(res)) return;
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.detail || '개발요청 조회 실패');
            setItems(Array.isArray(data?.requests) ? data.requests : []);
            setError('');
        } catch (err) {
            setError(err.message || '개발요청 조회 실패');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { fetchItems(); }, [fetchItems]);

    const call = async (path, options, failMsg) => {
        const res = await fetch(`${API}${path}`, {
            ...options,
            headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        });
        if (handleUnauthorized(res)) return null;
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.detail || failMsg);
        return data;
    };

    const handleAdd = async () => {
        const body = text.trim();
        if (!body || submitting) return;
        setSubmitting(true);
        try {
            await call('/dev-requests', { method: 'POST', body: JSON.stringify({ text: body }) }, '개발요청 등록 실패');
            setText('');
            setShowInput(false);
            await fetchItems();
        } catch (err) {
            setError(err.message || '개발요청 등록 실패');
        } finally {
            setSubmitting(false);
        }
    };

    const handleComplete = async (item) => {
        if (!window.confirm(`"${item.text}"\n\n이 개발요청을 완료 처리하면 ${item.requester_display || item.requester_username}님에게 완료 알림이 갑니다. 진행할까요?`)) return;
        try {
            await call(`/dev-requests/${item.id}/complete`, { method: 'POST' }, '완료 처리 실패');
            await fetchItems();
        } catch (err) {
            setError(err.message || '완료 처리 실패');
        }
    };

    const handleReject = async (item) => {
        const reason = window.prompt(`"${item.text}"

기각 사유를 입력하세요. 사유와 함께 ${item.requester_display || item.requester_username}님에게 알림이 갑니다.`);
        if (reason === null) return;
        if (!reason.trim()) {
            setError('기각 사유를 입력해야 합니다.');
            return;
        }
        try {
            await call(`/dev-requests/${item.id}/reject`, { method: 'POST', body: JSON.stringify({ reason: reason.trim() }) }, '기각 처리 실패');
            setError('');
            await fetchItems();
        } catch (err) {
            setError(err.message || '기각 처리 실패');
        }
    };

    const handleDelete = async (item) => {
        if (!window.confirm('이 개발요청을 삭제할까요?')) return;
        try {
            await call(`/dev-requests/${item.id}`, { method: 'DELETE' }, '삭제 실패');
            await fetchItems();
        } catch (err) {
            setError(err.message || '삭제 실패');
        }
    };

    return (
        <div className={styles.card}>
            <div className={styles.todoHeader}>
                <div className={styles.cardTitle}>개발요청</div>
                <div className={styles.todoHeaderActions}>
                    <button type="button" className={styles.filterBtn} onClick={() => setShowInput((v) => !v)}>
                        {showInput ? '닫기' : '요청'}
                    </button>
                </div>
            </div>
            {showInput && (
                <div className={styles.todoRow}>
                    <input
                        className={styles.todoInput}
                        placeholder="개발 요청 내용을 입력하세요"
                        value={text}
                        maxLength={1000}
                        onChange={(e) => setText(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                                e.preventDefault();
                                handleAdd();
                            }
                        }}
                    />
                    <button type="button" className={styles.primaryBtn} onClick={handleAdd} disabled={submitting || !text.trim()}>
                        {submitting ? '등록 중...' : '등록'}
                    </button>
                </div>
            )}
            {error && <div className={styles.mutedText} style={{ color: '#dc2626' }}>{error}</div>}
            <div className={styles.todoList}>
                {loading && items.length === 0 && <div className={styles.mutedText}>불러오는 중...</div>}
                {!loading && items.length === 0 && <div className={styles.mutedText}>등록된 개발요청이 없습니다.</div>}
                {items.map((item) => {
                    const done = item.status === 'completed';
                    const rejected = item.status === 'rejected';
                    return (
                        <div key={item.id} className={styles.todoItem}>
                            <div className={styles.todoLabel}>
                                <span className={`${styles.todoText} ${done || rejected ? styles.todoTextDone : ''}`}>
                                    {item.text}
                                    <span className={styles.mutedText}>
                                        {' '}· {item.requester_display || item.requester_username} · {formatTime(item.created_at)}
                                        {done ? ` · 완료 ${formatTime(item.completed_at)}` : ''}
                                        {rejected ? ` · 기각 ${formatTime(item.rejected_at)} · 사유: ${item.reject_reason || ''}` : ''}
                                    </span>
                                </span>
                            </div>
                            <div className={styles.todoActions}>
                                {item.can_complete && (
                                    <button type="button" className={styles.todoDoneBtn} onClick={() => handleComplete(item)}>완료</button>
                                )}
                                {item.can_reject && (
                                    <button type="button" className={styles.secondaryBtn} onClick={() => handleReject(item)}>기각</button>
                                )}
                                {item.can_delete && (
                                    <button type="button" className={styles.secondaryBtn} onClick={() => handleDelete(item)}>삭제</button>
                                )}
                                {done && <span className={styles.mutedText}>완료됨</span>}
                                {rejected && <span className={styles.mutedText}>기각됨</span>}
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
