import { useEffect, useState } from 'react';
import { GripVertical, Plus, Timer, UserPlus, X } from 'lucide-react';
import styles from './TimeboxPage.module.css';
import { LOCAL_API_BASE as API, getAuthHeaders, handleUnauthorized } from '../../lib/api';

const STATUS_LABEL = {
    unassigned: '미배정',
    assigned: '배정됨',
    in_progress: '진행중',
    done: '완료',
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
    const [members, setMembers] = useState([]);
    const [allUsers, setAllUsers] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    const [showCreateForm, setShowCreateForm] = useState(false);
    const [newTitle, setNewTitle] = useState('');
    const [newDescription, setNewDescription] = useState('');
    const [creating, setCreating] = useState(false);

    const [showAddMember, setShowAddMember] = useState(false);
    const [memberPick, setMemberPick] = useState('');
    const [addingMember, setAddingMember] = useState(false);

    const [commentsCache, setCommentsCache] = useState({});
    const [commentInput, setCommentInput] = useState({});

    const [draggedIssueId, setDraggedIssueId] = useState(null);
    const [dragOverMember, setDragOverMember] = useState(null);

    const [progressEditing, setProgressEditing] = useState({});
    const [progressDraft, setProgressDraft] = useState({});

    const authHeaders = getAuthHeaders();

    const loadComments = async (issueId) => {
        try {
            const res = await fetch(`${API}/timebox/issues/${issueId}/comments`, { headers: authHeaders });
            const data = await res.json();
            setCommentsCache((prev) => ({ ...prev, [issueId]: data.comments || [] }));
        } catch {
            setCommentsCache((prev) => ({ ...prev, [issueId]: [] }));
        }
    };

    useEffect(() => {
        (async () => {
            setLoading(true);
            setError('');
            try {
                const [issuesRes, membersRes, usersRes] = await Promise.all([
                    fetch(`${API}/timebox/issues`, { headers: authHeaders }),
                    fetch(`${API}/timebox/members`, { headers: authHeaders }),
                    fetch(`${API}/users`, { headers: authHeaders }),
                ]);
                if (handleUnauthorized(issuesRes) || handleUnauthorized(membersRes) || handleUnauthorized(usersRes)) return;
                const issuesData = await issuesRes.json();
                const membersData = await membersRes.json();
                const usersData = await usersRes.json();
                const loadedIssues = issuesData.issues || [];
                setIssues(loadedIssues);
                setMembers(membersData.members || []);
                setAllUsers(usersData.users || []);
                await Promise.all(
                    loadedIssues.filter((issue) => issue.status !== 'unassigned').map((issue) => loadComments(issue.id))
                );
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
                setCommentsCache((prev) => ({ ...prev, [data.issue.id]: [] }));
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

    const handleAddMember = async () => {
        if (!memberPick) return;
        setAddingMember(true);
        try {
            const res = await fetch(`${API}/timebox/members`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders },
                body: JSON.stringify({ username: memberPick }),
            });
            if (handleUnauthorized(res)) return;
            const data = await res.json();
            if (res.ok && data.member) {
                setMembers((prev) => [...prev, data.member]);
                setMemberPick('');
                setShowAddMember(false);
            } else {
                setError(data.detail || '멤버 추가에 실패했습니다.');
            }
        } catch {
            setError('멤버 추가에 실패했습니다.');
        } finally {
            setAddingMember(false);
        }
    };

    const handleRemoveMember = async (username) => {
        try {
            const res = await fetch(`${API}/timebox/members/${encodeURIComponent(username)}`, {
                method: 'DELETE',
                headers: authHeaders,
            });
            if (res.ok) {
                setMembers((prev) => prev.filter((m) => m.username !== username));
            }
        } catch {
            setError('멤버 제거에 실패했습니다.');
        }
    };

    const assignIssueTo = async (issueId, assignee) => {
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
                if (!commentsCache[issueId]) loadComments(issueId);
            } else {
                setError(data.detail || '배정에 실패했습니다.');
            }
        } catch {
            setError('배정에 실패했습니다.');
        }
    };

    const handleIssueDragStart = (e, issueId) => {
        e.dataTransfer.setData('text/plain', String(issueId));
        e.dataTransfer.effectAllowed = 'move';
        setDraggedIssueId(issueId);
    };

    const handleIssueDragEnd = () => {
        setDraggedIssueId(null);
        setDragOverMember(null);
    };

    const handleMemberDragOver = (e, username) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (dragOverMember !== username) setDragOverMember(username);
    };

    const handleMemberDragLeave = (username) => {
        setDragOverMember((prev) => (prev === username ? null : prev));
    };

    const handleMemberDrop = (e, username) => {
        e.preventDefault();
        const issueId = Number(e.dataTransfer.getData('text/plain'));
        setDragOverMember(null);
        setDraggedIssueId(null);
        if (issueId) assignIssueTo(issueId, username);
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

    const handleComplete = async (issueId) => {
        try {
            const res = await fetch(`${API}/timebox/issues/${issueId}/complete`, {
                method: 'PATCH',
                headers: authHeaders,
            });
            if (handleUnauthorized(res)) return;
            const data = await res.json();
            if (res.ok && data.issue) {
                setIssues((prev) => prev.map((it) => (it.id === issueId ? data.issue : it)));
            } else {
                setError(data.detail || '완료 처리에 실패했습니다.');
            }
        } catch {
            setError('완료 처리에 실패했습니다.');
        }
    };

    const handleSaveProgress = async (issueId) => {
        const progress = (progressDraft[issueId] || '').trim();
        try {
            const res = await fetch(`${API}/timebox/issues/${issueId}/progress`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json', ...authHeaders },
                body: JSON.stringify({ progress }),
            });
            if (handleUnauthorized(res)) return;
            const data = await res.json();
            if (res.ok && data.issue) {
                setIssues((prev) => prev.map((it) => (it.id === issueId ? data.issue : it)));
                setProgressEditing((prev) => ({ ...prev, [issueId]: false }));
            } else {
                setError(data.detail || '진행상황 저장에 실패했습니다.');
            }
        } catch {
            setError('진행상황 저장에 실패했습니다.');
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
            setError('피드백 등록에 실패했습니다.');
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
            setError('피드백 삭제에 실패했습니다.');
        }
    };

    const renderIssueCard = (issue, { compact, minimal } = {}) => {
        if (minimal) {
            return (
                <div
                    key={issue.id}
                    className={`${styles.issueCard} ${styles.issueCardDraggable} ${draggedIssueId === issue.id ? styles.issueCardDragging : ''}`}
                    draggable={members.length > 0}
                    onDragStart={(e) => handleIssueDragStart(e, issue.id)}
                    onDragEnd={handleIssueDragEnd}
                >
                    <div className={styles.issueTop}>
                        <GripVertical size={14} className={styles.dragHandle} />
                        <span className={`${styles.statusBadge} ${styles[`status_${issue.status}`]}`}>
                            {STATUS_LABEL[issue.status] || issue.status}
                        </span>
                        <span className={styles.issueTitle}>{issue.title}</span>
                    </div>
                    {issue.description && (
                        <div className={styles.descBlock}>
                            <div className={styles.progressLabel}>문제내용</div>
                            <div className={styles.issueDesc}>{issue.description}</div>
                        </div>
                    )}
                    <div className={styles.dragHint}>
                        {members.length === 0 ? '배정하려면 먼저 사용자를 추가하세요' : '담당자 카드로 드래그해서 배정'}
                    </div>
                </div>
            );
        }

        const comments = commentsCache[issue.id] || [];
        const canEditProgress = !!issue.assignedTo && currentUser === issue.assignedTo;
        const isEditingProgress = !!progressEditing[issue.id];
        return (
            <div key={issue.id} className={`${styles.issueCard} ${compact ? styles.issueCardCompact : ''}`}>
                <div className={styles.issueTop}>
                    <span className={`${styles.statusBadge} ${styles[`status_${issue.status}`]}`}>
                        {STATUS_LABEL[issue.status] || issue.status}
                    </span>
                    <span className={styles.issueTitle}>{issue.title}</span>
                    {issue.status === 'assigned' && issue.assignedTo === currentUser && (
                        <button
                            type="button"
                            className={`${styles.primaryBtn} ${styles.titleActionBtn}`}
                            onClick={() => handleStart(issue.id)}
                        >
                            진행중으로 전환
                        </button>
                    )}
                    {issue.status === 'in_progress' && issue.assignedTo === currentUser && (
                        <button
                            type="button"
                            className={`${styles.completeBtn} ${styles.titleActionBtn}`}
                            onClick={() => handleComplete(issue.id)}
                        >
                            완료
                        </button>
                    )}
                </div>
                {issue.description && (
                    <div className={styles.descBlock}>
                        <div className={styles.progressLabel}>문제내용</div>
                        <div className={styles.issueDesc}>{issue.description}</div>
                    </div>
                )}
                <div className={styles.issueMeta}>
                    작성자 {issue.createdByDisplay || issue.createdBy} · {fmtTime(issue.createdAt)}
                </div>

                <div className={styles.progressSection}>
                    <div className={styles.progressLabel}>진행상황</div>
                    {isEditingProgress ? (
                        <textarea
                            className={styles.descInput}
                            value={progressDraft[issue.id] || ''}
                            onChange={(e) => setProgressDraft((prev) => ({ ...prev, [issue.id]: e.target.value }))}
                            onBlur={() => handleSaveProgress(issue.id)}
                            rows={3}
                            autoFocus
                        />
                    ) : (
                        <div
                            className={`${styles.issueDesc} ${canEditProgress ? styles.editableText : ''}`}
                            onClick={() => {
                                if (!canEditProgress) return;
                                setProgressDraft((prev) => ({ ...prev, [issue.id]: issue.progress || '' }));
                                setProgressEditing((prev) => ({ ...prev, [issue.id]: true }));
                            }}
                        >
                            {issue.progress || (
                                <span className={styles.commentEmpty}>
                                    {canEditProgress ? '눌러서 진행상황을 작성하세요.' : '아직 작성된 진행상황이 없습니다.'}
                                </span>
                            )}
                        </div>
                    )}
                </div>

                <div className={styles.progressSection}>
                    <div className={styles.progressLabel}>피드백</div>
                    {comments.length === 0 && (
                        <div className={styles.commentEmpty}>아직 작성된 피드백이 없습니다.</div>
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
                            placeholder="피드백을 남겨주세요"
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
            </div>
        );
    };

    const unassignedIssues = issues.filter((it) => it.status === 'unassigned');
    const doneIssues = issues.filter((it) => it.status === 'done');
    const memberUsernames = new Set(members.map((m) => m.username));
    const availableToAdd = allUsers.filter((u) => !memberUsernames.has(u.username));

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
                                unassignedIssues.map((issue) => renderIssueCard(issue, { minimal: true }))
                            )}
                        </div>
                    </div>

                    <div className={styles.userGrid}>
                        {members.map((m) => {
                            const userIssues = issues.filter((it) => it.assignedTo === m.username && it.status !== 'done');
                            const displayName = m.displayName || m.username;
                            return (
                                <div
                                    key={m.username}
                                    className={`${styles.userCard} ${dragOverMember === m.username ? styles.userCardDropActive : ''}`}
                                    onDragOver={(e) => handleMemberDragOver(e, m.username)}
                                    onDragLeave={() => handleMemberDragLeave(m.username)}
                                    onDrop={(e) => handleMemberDrop(e, m.username)}
                                >
                                    <div className={styles.userCardHeader}>
                                        <div className={styles.userAvatar}>{displayName.slice(0, 2)}</div>
                                        <div className={styles.userCardName}>{displayName}</div>
                                        <span className={styles.columnCount}>{userIssues.length}</span>
                                        <button
                                            type="button"
                                            className={styles.removeMemberBtn}
                                            onClick={() => handleRemoveMember(m.username)}
                                            title="타임박스에서 제거"
                                        >
                                            <X size={13} />
                                        </button>
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

                        <div className={styles.addMemberCard}>
                            {showAddMember ? (
                                <div className={styles.addMemberForm}>
                                    <select
                                        className={styles.assigneeSelect}
                                        value={memberPick}
                                        onChange={(e) => setMemberPick(e.target.value)}
                                        autoFocus
                                    >
                                        <option value="">사용자 선택</option>
                                        {availableToAdd.map((u) => (
                                            <option key={u.username} value={u.username}>
                                                {u.display_name || u.username}
                                            </option>
                                        ))}
                                    </select>
                                    <div className={styles.createCardActions}>
                                        <button
                                            type="button"
                                            className={styles.secondaryBtn}
                                            onClick={() => {
                                                setShowAddMember(false);
                                                setMemberPick('');
                                            }}
                                        >
                                            취소
                                        </button>
                                        <button
                                            type="button"
                                            className={styles.primaryBtn}
                                            onClick={handleAddMember}
                                            disabled={addingMember || !memberPick}
                                        >
                                            추가
                                        </button>
                                    </div>
                                </div>
                            ) : (
                                <button
                                    type="button"
                                    className={styles.addMemberBtn}
                                    onClick={() => setShowAddMember(true)}
                                    disabled={availableToAdd.length === 0}
                                >
                                    <UserPlus size={16} />
                                    {availableToAdd.length === 0 ? '추가할 사용자 없음' : '사용자 추가'}
                                </button>
                            )}
                        </div>
                    </div>

                    <div className={styles.doneColumn}>
                        <div className={styles.columnHeader}>
                            <span>완료 리스트</span>
                            <span className={styles.columnCount}>{doneIssues.length}</span>
                        </div>
                        <div className={styles.backlogList}>
                            {doneIssues.length === 0 ? (
                                <div className={styles.emptySmall}>완료된 문제가 없습니다.</div>
                            ) : (
                                doneIssues.map((issue) => renderIssueCard(issue))
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default TimeboxPage;
