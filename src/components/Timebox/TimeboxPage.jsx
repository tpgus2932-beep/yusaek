import { useEffect, useState } from 'react';
import { MessageSquare, Timer } from 'lucide-react';
import styles from './TimeboxPage.module.css';
import { LOCAL_API_BASE as API, getAuthHeaders, handleUnauthorized } from '../../lib/api';

const STATUS_LABEL = {
    unassigned: '미배정',
    assigned: '배정됨',
    in_progress: '진행중',
};

const FILTERS = [
    { key: 'all', label: '전체' },
    { key: 'unassigned', label: '미배정' },
    { key: 'assigned', label: '배정됨' },
    { key: 'in_progress', label: '진행중' },
];

const fmtTime = (iso) => {
    if (!iso) return '';
    try {
        return new Date(iso).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    } catch {
        return iso;
    }
};

const TimeboxPage = ({ currentUser }) => {
    const [issues, setIssues] = useState([]);
    const [users, setUsers] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [filter, setFilter] = useState('all');

    const [newTitle, setNewTitle] = useState('');
    const [newDescription, setNewDescription] = useState('');
    const [creating, setCreating] = useState(false);

    const [assigneePick, setAssigneePick] = useState({});
    const [expanded, setExpanded] = useState(new Set());
    const [commentsCache, setCommentsCache] = useState({});
    const [commentInput, setCommentInput] = useState({});

    const authHeaders = getAuthHeaders();

    useEffect(() => {
        (async () => {
            setLoading(true);
            setError('');
            try {
                const [issuesRes, usersRes] = await Promise.all([
                    fetch(`${API}/timebox/issues`, { headers: authHeaders }),
                    fetch(`${API}/users`, { headers: authHeaders }),
                ]);
                if (handleUnauthorized(issuesRes) || handleUnauthorized(usersRes)) return;
                const issuesData = await issuesRes.json();
                const usersData = await usersRes.json();
                setIssues(issuesData.issues || []);
                setUsers(usersData.users || []);
            } catch {
                setError('데이터를 불러오지 못했습니다.');
            } finally {
                setLoading(false);
            }
        })();
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const handleCreate = async () => {
        const title = newTitle.trim();
        if (!title) return;
        setCreating(true);
        try {
            const res = await fetch(`${API}/timebox/issues`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders },
                body: JSON.stringify({ title, description: newDescription.trim() }),
            });
            if (handleUnauthorized(res)) return;
            const data = await res.json();
            if (res.ok && data.issue) {
                setIssues((prev) => [data.issue, ...prev]);
                setNewTitle('');
                setNewDescription('');
            } else {
                setError(data.detail || '등록에 실패했습니다.');
            }
        } catch {
            setError('등록에 실패했습니다.');
        } finally {
            setCreating(false);
        }
    };

    const handleAssign = async (issueId) => {
        const assignee = assigneePick[issueId];
        if (!assignee) return;
        try {
            const res = await fetch(`${API}/timebox/issues/${issueId}/assign`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json', ...authHeaders },
                body: JSON.stringify({ assignee }),
            });
            if (handleUnauthorized(res)) return;
            const data = await res.json();
            if (res.ok && data.issue) {
                setIssues((prev) => prev.map((it) => (it.id === issueId ? data.issue : it)));
            }
        } catch {
            setError('배정에 실패했습니다.');
        }
    };

    const handleStart = async (issueId) => {
        try {
            const res = await fetch(`${API}/timebox/issues/${issueId}/start`, {
                method: 'PATCH',
                headers: authHeaders,
            });
            if (handleUnauthorized(res)) return;
            const data = await res.json();
            if (res.ok && data.issue) {
                setIssues((prev) => prev.map((it) => (it.id === issueId ? data.issue : it)));
            } else {
                setError(data.detail || '전환에 실패했습니다.');
            }
        } catch {
            setError('전환에 실패했습니다.');
        }
    };

    const toggleComments = async (issueId) => {
        const isOpen = expanded.has(issueId);
        setExpanded((prev) => {
            const next = new Set(prev);
            if (isOpen) next.delete(issueId); else next.add(issueId);
            return next;
        });
        if (!isOpen && !commentsCache[issueId]) {
            try {
                const res = await fetch(`${API}/timebox/issues/${issueId}/comments`, { headers: authHeaders });
                const data = await res.json();
                setCommentsCache((prev) => ({ ...prev, [issueId]: data.comments || [] }));
            } catch {
                setCommentsCache((prev) => ({ ...prev, [issueId]: [] }));
            }
        }
    };

    const handleAddComment = async (issueId) => {
        const content = (commentInput[issueId] || '').trim();
        if (!content) return;
        try {
            const res = await fetch(`${API}/timebox/issues/${issueId}/comments`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders },
                body: JSON.stringify({ content }),
            });
            const data = await res.json();
            if (res.ok && data.comment) {
                setCommentsCache((prev) => ({ ...prev, [issueId]: [...(prev[issueId] || []), data.comment] }));
                setCommentInput((prev) => ({ ...prev, [issueId]: '' }));
            }
        } catch {
            setError('코멘트 등록에 실패했습니다.');
        }
    };

    const handleDeleteComment = async (issueId, commentId) => {
        try {
            const res = await fetch(`${API}/timebox/issues/${issueId}/comments/${commentId}`, {
                method: 'DELETE',
                headers: authHeaders,
            });
            if (res.ok) {
                setCommentsCache((prev) => ({
                    ...prev,
                    [issueId]: (prev[issueId] || []).filter((c) => c.id !== commentId),
                }));
            }
        } catch {
            setError('코멘트 삭제에 실패했습니다.');
        }
    };

    const filteredIssues = issues.filter((it) => filter === 'all' || it.status === filter);

    return (
        <div className={styles.page}>
            <div className={styles.pageHeader}>
                <Timer size={20} />
                <h2>타임박스</h2>
            </div>

            {error && <div className={styles.error}>{error}</div>}

            <div className={styles.createCard}>
                <input
                    type="text"
                    className={styles.titleInput}
                    placeholder="새 이슈 제목"
                    value={newTitle}
                    onChange={(e) => setNewTitle(e.target.value)}
                />
                <textarea
                    className={styles.descInput}
                    placeholder="상세 내용 (선택)"
                    value={newDescription}
                    onChange={(e) => setNewDescription(e.target.value)}
                    rows={2}
                />
                <button
                    type="button"
                    className={styles.primaryBtn}
                    onClick={handleCreate}
                    disabled={creating || !newTitle.trim()}
                >
                    {creating ? '등록 중...' : '이슈 등록'}
                </button>
            </div>

            <div className={styles.filterRow}>
                {FILTERS.map((f) => (
                    <button
                        key={f.key}
                        type="button"
                        className={`${styles.filterBtn} ${filter === f.key ? styles.filterBtnActive : ''}`}
                        onClick={() => setFilter(f.key)}
                    >
                        {f.label}
                    </button>
                ))}
            </div>

            {loading ? (
                <div className={styles.empty}>불러오는 중...</div>
            ) : filteredIssues.length === 0 ? (
                <div className={styles.empty}>표시할 이슈가 없습니다.</div>
            ) : (
                <div className={styles.issueList}>
                    {filteredIssues.map((issue) => {
                        const isOpen = expanded.has(issue.id);
                        const comments = commentsCache[issue.id] || [];
                        return (
                            <div key={issue.id} className={styles.issueCard}>
                                <div className={styles.issueTop}>
                                    <span className={`${styles.statusBadge} ${styles[`status_${issue.status}`]}`}>
                                        {STATUS_LABEL[issue.status] || issue.status}
                                    </span>
                                    <span className={styles.issueTitle}>{issue.title}</span>
                                </div>
                                {issue.description && <div className={styles.issueDesc}>{issue.description}</div>}
                                <div className={styles.issueMeta}>
                                    작성자 {issue.createdByDisplay || issue.createdBy} · {fmtTime(issue.createdAt)}
                                    {issue.assignedTo && (
                                        <> · 담당자 {issue.assignedToDisplay || issue.assignedTo}</>
                                    )}
                                </div>

                                <div className={styles.actionRow}>
                                    <select
                                        className={styles.assigneeSelect}
                                        value={assigneePick[issue.id] || ''}
                                        onChange={(e) => setAssigneePick((prev) => ({ ...prev, [issue.id]: e.target.value }))}
                                    >
                                        <option value="">담당자 선택</option>
                                        {users.map((u) => (
                                            <option key={u.username} value={u.username}>
                                                {u.display_name || u.username}
                                            </option>
                                        ))}
                                    </select>
                                    <button
                                        type="button"
                                        className={styles.secondaryBtn}
                                        onClick={() => handleAssign(issue.id)}
                                        disabled={!assigneePick[issue.id]}
                                    >
                                        {issue.assignedTo ? '재배정' : '배정'}
                                    </button>

                                    {issue.status === 'assigned' && issue.assignedTo === currentUser && (
                                        <button
                                            type="button"
                                            className={styles.primaryBtn}
                                            onClick={() => handleStart(issue.id)}
                                        >
                                            진행중으로 전환
                                        </button>
                                    )}

                                    <button
                                        type="button"
                                        className={styles.commentToggleBtn}
                                        onClick={() => toggleComments(issue.id)}
                                    >
                                        <MessageSquare size={14} />
                                        코멘트{comments.length > 0 ? ` ${comments.length}` : ''}
                                    </button>
                                </div>

                                {isOpen && (
                                    <div className={styles.commentSection}>
                                        {comments.length === 0 && (
                                            <div className={styles.commentEmpty}>아직 코멘트가 없습니다.</div>
                                        )}
                                        {comments.map((c) => (
                                            <div key={c.id} className={styles.commentItem}>
                                                <div className={styles.commentMeta}>
                                                    <span className={styles.commentAuthor}>{c.authorDisplay || c.author}</span>
                                                    <span className={styles.commentTime}>{fmtTime(c.createdAt)}</span>
                                                    {c.author === currentUser && (
                                                        <button
                                                            type="button"
                                                            className={styles.commentDeleteBtn}
                                                            onClick={() => handleDeleteComment(issue.id, c.id)}
                                                        >
                                                            삭제
                                                        </button>
                                                    )}
                                                </div>
                                                <div className={styles.commentText}>{c.content}</div>
                                            </div>
                                        ))}
                                        <div className={styles.commentInputRow}>
                                            <input
                                                type="text"
                                                className={styles.commentInput}
                                                placeholder="진행 상황 또는 피드백을 남겨주세요"
                                                value={commentInput[issue.id] || ''}
                                                onChange={(e) => setCommentInput((prev) => ({ ...prev, [issue.id]: e.target.value }))}
                                                onKeyDown={(e) => {
                                                    if (e.key === 'Enter') handleAddComment(issue.id);
                                                }}
                                            />
                                            <button
                                                type="button"
                                                className={styles.commentSubmitBtn}
                                                onClick={() => handleAddComment(issue.id)}
                                            >
                                                등록
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
};

export default TimeboxPage;
