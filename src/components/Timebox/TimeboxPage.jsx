import { useEffect, useState } from 'react';
import { MessageSquare, Plus, Timer } from 'lucide-react';
import styles from './TimeboxPage.module.css';
import { LOCAL_API_BASE as API, getAuthHeaders, handleUnauthorized } from '../../lib/api';

const STATUS_LABEL = {
    unassigned: '미배정',
    assigned: '배정됨',
    in_progress: '진행중',
};

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

    const [showCreateForm, setShowCreateForm] = useState(false);
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
                setShowCreateForm(false);
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
                setAssigneePick((prev) => ({ ...prev, [issueId]: '' }));
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

    const renderIssueCard = (issue, { compact } = {}) => {
        const isOpen = expanded.has(issue.id);
        const comments = commentsCache[issue.id] || [];
        return (
            <div key={issue.id} className={`${styles.issueCard} ${compact ? styles.issueCardCompact : ''}`}>
                <div className={styles.issueTop}>
                    <span className={`${styles.statusBadge} ${styles[`status_${issue.status}`]}`}>
                        {STATUS_LABEL[issue.status] || issue.status}
                    </span>
                    <span className={styles.issueTitle}>{issue.title}</span>
                </div>
                {issue.description && <div className={styles.issueDesc}>{issue.description}</div>}
                <div className={styles.issueMeta}>
                    작성자 {issue.createdByDisplay || issue.createdBy} · {fmtTime(issue.createdAt)}
                </div>

                <div className={styles.actionRow}>
                    {issue.status === 'unassigned' && (
                        <>
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
                                배정
                            </button>
                        </>
                    )}

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
    };

    const unassignedIssues = issues.filter((it) => it.status === 'unassigned');

    return (
        <div className={styles.page}>
            <div className={styles.pageHeader}>
                <Timer size={20} />
                <h2>타임박스</h2>
            </div>

            {error && <div className={styles.error}>{error}</div>}

            {loading ? (
                <div className={styles.empty}>불러오는 중...</div>
            ) : (
                <div className={styles.board}>
                    <div className={styles.backlogColumn}>
                        <div className={styles.columnHeader}>
                            <span>문제 리스트</span>
                            <span className={styles.columnCount}>{unassignedIssues.length}</span>
                            <button
                                type="button"
                                className={styles.addBtn}
                                onClick={() => setShowCreateForm((prev) => !prev)}
                            >
                                <Plus size={13} />
                                추가
                            </button>
                        </div>
                        <div className={styles.backlogList}>
                            {showCreateForm && (
                                <div className={styles.createCard}>
                                    <input
                                        type="text"
                                        className={styles.titleInput}
                                        placeholder="새 이슈 제목"
                                        autoFocus
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
                                    <div className={styles.createCardActions}>
                                        <button
                                            type="button"
                                            className={styles.secondaryBtn}
                                            onClick={() => {
                                                setShowCreateForm(false);
                                                setNewTitle('');
                                                setNewDescription('');
                                            }}
                                        >
                                            취소
                                        </button>
                                        <button
                                            type="button"
                                            className={styles.primaryBtn}
                                            onClick={handleCreate}
                                            disabled={creating || !newTitle.trim()}
                                        >
                                            {creating ? '등록 중...' : '등록'}
                                        </button>
                                    </div>
                                </div>
                            )}
                            {unassignedIssues.length === 0 && !showCreateForm ? (
                                <div className={styles.emptySmall}>미배정 문제가 없습니다.</div>
                            ) : (
                                unassignedIssues.map((issue) => renderIssueCard(issue))
                            )}
                        </div>
                    </div>

                    <div className={styles.userGrid}>
                        {users.map((u) => {
                            const userIssues = issues.filter((it) => it.assignedTo === u.username);
                            const displayName = u.display_name || u.username;
                            return (
                                <div key={u.username} className={styles.userCard}>
                                    <div className={styles.userCardHeader}>
                                        <div className={styles.userAvatar}>{displayName.slice(0, 2)}</div>
                                        <div className={styles.userCardName}>{displayName}</div>
                                        <span className={styles.columnCount}>{userIssues.length}</span>
                                    </div>
                                    <div className={styles.userIssueList}>
                                        {userIssues.length === 0 ? (
                                            <div className={styles.emptySmall}>배정된 문제가 없습니다.</div>
                                        ) : (
                                            userIssues.map((issue) => renderIssueCard(issue, { compact: true }))
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
};

export default TimeboxPage;
