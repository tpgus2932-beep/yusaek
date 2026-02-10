import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Calendar, Bell } from 'lucide-react';
import styles from './Dashboard.module.css';

const Overview = ({ currentUser }) => {
    const API = `http://${window.location.hostname}:8000`;
    const [users, setUsers] = useState([]);
    const [assignee, setAssignee] = useState('');
    const [requestText, setRequestText] = useState('');
    const [requestFiles, setRequestFiles] = useState([]);
    const fileInputRef = useRef(null);
    const [activity, setActivity] = useState([]);
    const [resolved, setResolved] = useState([]);
    const [loadingUsers, setLoadingUsers] = useState(true);
    const [loadingActivity, setLoadingActivity] = useState(false);
    const [loadingResolved, setLoadingResolved] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState('');
    const [sentFilter, setSentFilter] = useState('all');
    const [previewImage, setPreviewImage] = useState(null);
    const [previewScale, setPreviewScale] = useState(1);
    const [companyCreds, setCompanyCreds] = useState([]);
    const [loadingCreds, setLoadingCreds] = useState(false);
    const [credView, setCredView] = useState({});
    const [credEdit, setCredEdit] = useState({});
    const [companyPin, setCompanyPin] = useState('');
    const [todoText, setTodoText] = useState('');
    const [todos, setTodos] = useState([]);
    const [showTodoInput, setShowTodoInput] = useState(false);
    const [showAllTodos, setShowAllTodos] = useState(false);
    const [todosLoaded, setTodosLoaded] = useState(false);
    const isAdmin = useMemo(() => localStorage.getItem('isAdmin') === 'true', []);
    const todoStorageKey = useMemo(() => {
        const user = currentUser || localStorage.getItem('username') || 'default';
        return `todos:${user}`;
    }, [currentUser]);

    const authHeaders = useMemo(() => {
        const token = localStorage.getItem('token');
        return token ? { Authorization: `Bearer ${token}` } : {};
    }, []);

    const handleUnauthorized = (res) => {
        if (res.status === 401) {
            localStorage.removeItem('token');
            localStorage.removeItem('displayName');
            localStorage.removeItem('username');
            localStorage.removeItem('isAdmin');
            window.location.reload();
            return true;
        }
        return false;
    };

    useEffect(() => {
        setTodosLoaded(false);
        try {
            const raw = localStorage.getItem(todoStorageKey);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed)) {
                    setTodos(parsed);
                    setTodosLoaded(true);
                    return;
                }
            }
        } catch (err) {
            console.warn('Failed to load todos', err);
        }
        setTodos([]);
        setTodosLoaded(true);
    }, [todoStorageKey]);

    useEffect(() => {
        if (!todosLoaded) return;
        if (localStorage.getItem('todos-reset-on-login') === '1') {
            setTodos((prev) => prev.map((item) => ({ ...item, done: false })));
            localStorage.removeItem('todos-reset-on-login');
        }
    }, [todosLoaded]);

    useEffect(() => {
        if (!todosLoaded) return;
        try {
            localStorage.setItem(todoStorageKey, JSON.stringify(todos));
        } catch (err) {
            console.warn('Failed to save todos', err);
        }
    }, [todoStorageKey, todos, todosLoaded]);

    const fetchUsers = async () => {
        try {
            setLoadingUsers(true);
            const res = await fetch(`${API}/users`, { headers: authHeaders });
            if (handleUnauthorized(res)) return;
            const data = await res.json();
            if (!res.ok) throw new Error(data?.detail || 'Failed to load users');
            const list = data?.users || [];
            setUsers(list);
            if (!assignee && list.length) setAssignee(list[0].username);
        } catch (err) {
            setError(err.message || 'Failed to load users');
        } finally {
            setLoadingUsers(false);
        }
    };

    const fetchActivity = async () => {
        try {
            setLoadingActivity(true);
            const res = await fetch(`${API}/requests/assigned`, {
                headers: authHeaders,
            });
            if (handleUnauthorized(res)) return;
            const data = await res.json();
            if (!res.ok) throw new Error(data?.detail || 'Failed to load activity');
            setActivity(data?.requests || []);
        } catch (err) {
            setError(err.message || 'Failed to load activity');
        } finally {
            setLoadingActivity(false);
        }
    };

    const fetchResolved = async () => {
        try {
            setLoadingResolved(true);
            const res = await fetch(`${API}/requests/resolved`, { headers: authHeaders });
            if (handleUnauthorized(res)) return;
            const data = await res.json();
            if (!res.ok) throw new Error(data?.detail || 'Failed to load resolved');
            setResolved(data?.requests || []);
        } catch (err) {
            setError(err.message || 'Failed to load resolved');
        } finally {
            setLoadingResolved(false);
        }
    };

    useEffect(() => {
        fetchUsers();
        fetchResolved();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        fetchActivity();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentUser]);

    const fetchCompanyCreds = async () => {
        try {
            setLoadingCreds(true);
            const res = await fetch(`${API}/company-credentials`, { headers: authHeaders });
            if (handleUnauthorized(res)) return;
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.detail || 'Failed to load credentials');
            setCompanyCreds(data?.items || []);
        } catch (err) {
            setError(err.message || 'Failed to load credentials');
        } finally {
            setLoadingCreds(false);
        }
    };

    useEffect(() => {
        fetchCompanyCreds();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);


    const handleSubmit = async (e) => {
        e.preventDefault();
        setError('');
        if (!assignee || !requestText.trim()) {
            setError('Please select a user and enter a request.');
            return;
        }
        try {
            setSubmitting(true);
            const formData = new FormData();
            formData.append('assignee', assignee);
            formData.append('text', requestText.trim());
            requestFiles.forEach((file) => {
                formData.append('files', file);
            });
            const res = await fetch(`${API}/requests`, {
                method: 'POST',
                headers: { ...authHeaders },
                body: formData,
            });
            if (handleUnauthorized(res)) return;
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.detail || 'Failed to send request');
            setRequestText('');
            setRequestFiles([]);
            if (fileInputRef.current) fileInputRef.current.value = '';
            await fetchResolved();
            if (assignee === (currentUser || localStorage.getItem('username'))) {
                await fetchActivity();
            }
        } catch (err) {
            setError(err.message || 'Failed to send request');
        } finally {
            setSubmitting(false);
        }
    };

    const handleComplete = async (id) => {
        try {
            const res = await fetch(`${API}/requests/${id}/complete`, {
                method: 'POST',
                headers: authHeaders,
            });
            if (handleUnauthorized(res)) return;
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.detail || 'Failed to complete');
            await fetchActivity();
            await fetchResolved();
        } catch (err) {
            setError(err.message || 'Failed to complete');
        }
    };

    const handleAck = async (id) => {
        try {
            const res = await fetch(`${API}/requests/${id}/ack`, {
                method: 'POST',
                headers: authHeaders,
            });
            if (handleUnauthorized(res)) return;
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.detail || 'Failed to acknowledge');
            await fetchResolved();
        } catch (err) {
            setError(err.message || 'Failed to acknowledge');
        }
    };

    const handleClearActivity = async () => {
        if (!window.confirm('요청 목록에서 완료된 항목만 삭제할까요?')) return;
        try {
            const res = await fetch(`${API}/requests/assigned/clear`, {
                method: 'DELETE',
                headers: authHeaders,
            });
            if (handleUnauthorized(res)) return;
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.detail || 'Failed to clear activity');
            await fetchActivity();
        } catch (err) {
            setError(err.message || 'Failed to clear activity');
        }
    };

    const handleClearSent = async () => {
        if (!window.confirm('보낸 요청에서 완료된 항목만 삭제할까요?')) return;
        try {
            const res = await fetch(`${API}/requests/sent/clear`, {
                method: 'DELETE',
                headers: authHeaders,
            });
            if (handleUnauthorized(res)) return;
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.detail || 'Failed to clear sent requests');
            await fetchResolved();
        } catch (err) {
            setError(err.message || 'Failed to clear sent requests');
        }
    };

    const handlePaste = (e) => {
        const items = e.clipboardData?.items;
        if (!items || items.length === 0) return;

        const imageFiles = [];
        for (const item of items) {
            if (item.kind === 'file' && item.type.startsWith('image/')) {
                const blob = item.getAsFile();
                if (blob) {
                    const ext = blob.type.split('/')[1] || 'png';
                    const name = `paste-${Date.now()}-${imageFiles.length}.${ext}`;
                    imageFiles.push(new File([blob], name, { type: blob.type }));
                }
            }
        }

        if (imageFiles.length > 0) {
            e.preventDefault();
            setRequestFiles((prev) => [...prev, ...imageFiles]);
        }
    };

    const formatFileSize = (bytes) => {
        if (!bytes && bytes !== 0) return '';
        if (bytes < 1024) return `${bytes}B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
    };

    const formatDateTime = (value) => {
        if (!value) return '-';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return String(value);
        return date.toLocaleString('ko-KR', {
            hour12: false,
            timeZone: 'Asia/Seoul',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
        });
    };

    const getAttachmentUrl = (file) => {
        const token = localStorage.getItem('token');
        const suffix = token ? `?token=${encodeURIComponent(token)}` : '';
        return `${API}${file.url}${suffix}`;
    };

    const renderAttachments = (item) => {
        if (!item.attachments || item.attachments.length === 0) return null;
        return (
            <div className={styles.attachmentList}>
                {item.attachments.map((file) => (
                    <div key={file.id} className={styles.attachmentItem}>
                        {file.is_image ? (
                            <img
                                className={styles.attachmentThumb}
                                src={getAttachmentUrl(file)}
                                alt={file.filename}
                                onClick={() => {
                                    setPreviewScale(1);
                                    setPreviewImage({
                                        url: getAttachmentUrl(file),
                                        name: file.filename,
                                    });
                                }}
                            />
                        ) : (
                            <div className={styles.attachmentIcon}>FILE</div>
                        )}
                        <div className={styles.attachmentMeta}>
                            <a
                                className={styles.attachmentLink}
                                href={getAttachmentUrl(file)}
                                download
                                target="_blank"
                                rel="noreferrer"
                            >
                                {file.filename}
                            </a>
                            <div className={styles.attachmentSize}>{formatFileSize(file.size)}</div>
                        </div>
                    </div>
                ))}
            </div>
        );
    };

    const updateCredEdit = (id, patch) => {
        setCredEdit((prev) => ({ ...prev, [id]: { ...(prev[id] || {}), ...patch } }));
    };

    const handleCredentialsSave = async (item) => {
        const id = item?.id;
        const data = (id ? credEdit[id] : {}) || {};
        const labelValue = (data.label ?? item?.label ?? '').trim();
        const usernameValue = (data.username ?? item?.username ?? '').trim();
        const passwordValue = (data.password ?? item?.password ?? '').trim();
        try {
            const res = await fetch(`${API}/company-credentials`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders },
                body: JSON.stringify({
                    id,
                    label: labelValue,
                    username: usernameValue,
                    password: passwordValue,
                }),
            });
            const payload = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(payload?.detail || 'Failed to save');
            setCredEdit((prev) => {
                const next = { ...prev };
                delete next[id];
                return next;
            });
            await fetchCompanyCreds();
        } catch (err) {
            setError(err.message || 'Failed to save');
        }
    };

    const handleCredentialsCreate = async () => {
        const data = credEdit.new || {};
        try {
            const res = await fetch(`${API}/company-credentials`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders },
                body: JSON.stringify({
                    label: (data.label || '').trim(),
                    username: (data.username || '').trim(),
                    password: (data.password || '').trim(),
                }),
            });
            const payload = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(payload?.detail || 'Failed to create');
            setCredEdit((prev) => ({ ...prev, new: { label: '', username: '', password: '' } }));
            await fetchCompanyCreds();
        } catch (err) {
            setError(err.message || 'Failed to create');
        }
    };

    const handleCredentialsView = async (id) => {
        const pin = (companyPin || '').trim();
        try {
            const res = await fetch(`${API}/company-credentials/${id}/view`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders },
                body: JSON.stringify({ pin }),
            });
            const payload = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(payload?.detail || 'Failed to view');
            if (isAdmin) {
                updateCredEdit(id, {
                    username: payload.username || '',
                    password: payload.password || '',
                    label: payload.label || '',
                });
            } else {
                setCredView((prev) => ({
                    ...prev,
                    [id]: { username: payload.username || '', password: payload.password || '' },
                }));
            }
        } catch (err) {
            setError(err.message || 'Failed to view');
        }
    };


    const handleCredentialsDelete = async (id) => {
        try {
            const res = await fetch(`${API}/company-credentials/${id}`, {
                method: 'DELETE',
                headers: authHeaders,
            });
            const payload = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(payload?.detail || 'Failed to delete');
            await fetchCompanyCreds();
        } catch (err) {
            setError(err.message || 'Failed to delete');
        }
    };

    const handleAddTodo = () => {
        const text = todoText.trim();
        if (!text) return;
        const next = [
            ...todos,
            {
                id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                text,
                done: false,
                createdAt: Date.now(),
            },
        ];
        setTodos(next);
        setTodoText('');
    };

    const handleToggleTodo = (id) => {
        setTodos((prev) =>
            prev.map((item) => (item.id === id ? { ...item, done: !item.done } : item))
        );
    };

    const handleRemoveTodo = (id) => {
        setTodos((prev) => prev.filter((item) => item.id !== id));
    };

    const handleResetTodos = () => {
        if (!window.confirm('전체 할 일 완료를 해제할까요?')) return;
        setTodos((prev) => prev.map((item) => ({ ...item, done: false })));
    };

    const orderedTodos = useMemo(() => {
        return [...todos].sort((a, b) => {
            if (a.done !== b.done) return a.done ? 1 : -1;
            return (a.createdAt || 0) - (b.createdAt || 0);
        });
    }, [todos]);


    return (
        <section className={styles.dashboard}>
            <div className={styles.headerRow}>
                <h1 className={styles.title}>대시보드</h1>
                <button className={styles.downloadBtn}>
                    <Plus size={18} />
                    Download Report
                </button>
            </div>

            <div className={styles.card}>
                <div className={styles.todoHeader}>
                    <div className={styles.cardTitle}>할 일 목록</div>
                    <div className={styles.todoHeaderActions}>
                        <button
                            type="button"
                            className={styles.secondaryBtn}
                            onClick={handleResetTodos}
                        >
                            전체 완료 해제
                        </button>
                        <button
                            type="button"
                            className={styles.todoAddToggle}
                            onClick={() => setShowTodoInput((v) => !v)}
                        >
                            <Plus size={16} />
                            {showTodoInput ? '닫기' : '추가'}
                        </button>
                    </div>
                </div>
                {showTodoInput && (
                    <div className={styles.todoRow}>
                        <input
                            className={styles.todoInput}
                            placeholder="할 일을 입력하세요"
                            value={todoText}
                            onChange={(e) => setTodoText(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                    e.preventDefault();
                                    handleAddTodo();
                                }
                            }}
                        />
                        <button type="button" className={styles.primaryBtn} onClick={handleAddTodo}>
                            등록
                        </button>
                    </div>
                )}
                <div
                    className={`${styles.todoList} ${
                        !showAllTodos ? styles.todoListCollapsed : ''
                    }`}
                >
                    {todos.length === 0 && (
                        <div className={styles.mutedText}>등록된 할 일이 없습니다.</div>
                    )}
                    {orderedTodos.map((item) => (
                        <div key={item.id} className={styles.todoItem}>
                            <label className={styles.todoLabel}>
                                <span
                                    className={`${styles.todoText} ${
                                        item.done ? styles.todoTextDone : ''
                                    }`}
                                >
                                    {item.text}
                                </span>
                            </label>
                            <div className={styles.todoActions}>
                                <button
                                    type="button"
                                    className={styles.todoDoneBtn}
                                    onClick={() => handleToggleTodo(item.id)}
                                >
                                    {item.done ? '완료됨' : '완료'}
                                </button>
                                <button
                                    type="button"
                                    className={styles.secondaryBtn}
                                    onClick={() => handleRemoveTodo(item.id)}
                                >
                                    삭제
                                </button>
                            </div>
                        </div>
                    ))}
                </div>
                {todos.length > 0 && (
                    <div className={styles.todoToggleRow}>
                        <button
                            type="button"
                            className={styles.todoToggleBtn}
                            onClick={() => setShowAllTodos((v) => !v)}
                        >
                            {showAllTodos ? '접기' : '펼치기'}
                        </button>
                    </div>
                )}
                <div className={styles.todoHint}>브라우저에 저장되어 다음날도 유지됩니다.</div>
            </div>

            <div className={styles.contentGrid}>
                <div className={styles.card}>
                    <div className={styles.cardTitle}>
                        요청 보내기
                        <Plus size={18} className={styles.cardHeaderIcon} />
                    </div>
                    <form className={styles.requestForm} onSubmit={handleSubmit}>
                        <label className={styles.formLabel}>
                            Select user
                            <select
                                className={styles.select}
                                value={assignee}
                                onChange={(e) => setAssignee(e.target.value)}
                                disabled={loadingUsers}
                            >
                                {loadingUsers && <option>Loading...</option>}
                                {!loadingUsers && users.length === 0 && <option>No users</option>}
                                {users.map((u) => (
                                    <option key={u.username} value={u.username}>
                                        {u.display_name || u.username}
                                    </option>
                                ))}
                            </select>
                        </label>
                        <label className={styles.formLabel}>
                            Request 내용
                            <textarea
                                className={styles.textarea}
                                rows={4}
                                value={requestText}
                                onChange={(e) => setRequestText(e.target.value)}
                                onPaste={handlePaste}
                                placeholder="요청 내용을 입력하세요."
                            />
                        </label>
                        <div className={styles.formLabel}>
                            파일 첨부
                            <div className={styles.fileRow}>
                                <button
                                    type="button"
                                    className={styles.fileButton}
                                    onClick={() => fileInputRef.current?.click()}
                                >
                                    파일 선택
                                </button>
                                <span className={styles.fileHint}>
                                    {requestFiles.length > 0
                                        ? `${requestFiles.length}개 선택됨`
                                        : '선택된 파일 없음'}
                                </span>
                            </div>
                            <input
                                ref={fileInputRef}
                                className={styles.fileInputHidden}
                                type="file"
                                multiple
                                accept=".xlsx,.xls,.csv,.jpg,.jpeg,.png,.gif,.webp"
                                onChange={(e) => setRequestFiles(Array.from(e.target.files || []))}
                            />
                            {requestFiles.length > 0 && (
                                <div className={styles.fileHint}>
                                    {requestFiles.map((file) => file.name).join(', ')}
                                </div>
                            )}
                            <div className={styles.fileHint}>사진은 붙여넣기(Ctrl+V)도 가능</div>
                        </div>
                        {error && <div className={styles.errorText}>{error}</div>}
                        <button className={styles.primaryBtn} type="submit" disabled={submitting}>
                            {submitting ? 'Sending...' : 'Send Request'}
                        </button>
                    </form>
                </div>

                <div className={styles.card}>
                    <div className={styles.cardTitle}>
                        요청 목록
                        <Calendar size={18} className={styles.cardHeaderIcon} />
                    </div>
                    <div className={styles.cardActions}>
                        <button className={styles.secondaryBtn} type="button" onClick={handleClearActivity}>
                            목록 지우기
                        </button>
                    </div>
                    <div className={styles.activityList}>
                        {loadingActivity && <div className={styles.mutedText}>Loading activity...</div>}
                        {!loadingActivity && activity.length === 0 && (
                            <div className={styles.mutedText}>No requests yet.</div>
                        )}
                        {!loadingActivity &&
                            activity.map((item) => (
                                <div
                                    key={item.id}
                                    className={`${styles.activityItem} ${item.status === 'completed' ? styles.activityItemCompleted : ''}`}
                                >
                                    <div className={styles.activityDot}></div>
                                    <div className={styles.activityInfo}>
                                        <div className={styles.activityText}>{item.text}</div>
                                        <div className={styles.activityMeta}>
                                            {item.requester_display || item.requester_username}
                                        </div>
                                        <div className={styles.activityMeta}>
                                            받은시간: {formatDateTime(item.created_at)}
                                        </div>
                                        {renderAttachments(item)}
                                    </div>
                                    <div className={styles.activityActions}>
                                        {item.status === 'completed' ? (
                                            <span className={styles.completedBadge}>Completed</span>
                                        ) : (
                                            <button
                                                className={styles.secondaryBtn}
                                                type="button"
                                                disabled={!item.can_complete}
                                                onClick={() => handleComplete(item.id)}
                                            >
                                                완료
                                            </button>
                                        )}
                                    </div>
                                </div>
                            ))}
                    </div>
                </div>
            </div>

            <div className={styles.resolvedGrid}>
                <div className={styles.card}>
                    <div className={styles.cardTitleRow}>
                        <div className={styles.cardTitle}>
                            보낸 요청
                            <Bell size={18} className={styles.cardHeaderIcon} />
                        </div>
                        <div className={styles.filterGroup}>
                            <button
                                type="button"
                                className={`${styles.filterBtn} ${
                                    sentFilter === 'open' ? styles.filterActive : ''
                                }`}
                                onClick={() => setSentFilter('open')}
                            >
                                요청한 목록만보기
                            </button>
                            <button
                                type="button"
                                className={`${styles.filterBtn} ${
                                    sentFilter === 'completed' ? styles.filterActive : ''
                                }`}
                                onClick={() => setSentFilter('completed')}
                            >
                                완료된 목록만보기
                            </button>
                            <button
                                type="button"
                                className={`${styles.filterBtn} ${
                                    sentFilter === 'all' ? styles.filterActive : ''
                                }`}
                                onClick={() => setSentFilter('all')}
                            >
                                전체보기
                            </button>
                            <button className={styles.filterBtn} type="button" onClick={handleClearSent}>
                                목록 지우기
                            </button>
                        </div>
                    </div>
                    <div className={styles.resolvedList}>
                        {loadingResolved && <div className={styles.mutedText}>Loading resolved...</div>}
                        {!loadingResolved && resolved.length === 0 && (
                            <div className={styles.mutedText}>No sent requests.</div>
                        )}
                        {!loadingResolved &&
                            resolved
                                .filter((item) => {
                                    if (sentFilter === 'open') return item.status !== 'completed';
                                    if (sentFilter === 'completed') return item.status === 'completed';
                                    return true;
                                })
                                .map((item) => (
                                <div key={item.id} className={styles.resolvedItem}>
                                    <div className={styles.resolvedInfo}>
                                        <div className={styles.resolvedTitle}>{item.text}</div>
                                        <div className={styles.resolvedMeta}>
                                            {item.assignee_display || item.assignee_username}
                                            {item.status === 'completed' ? ' completed' : ' in progress'}
                                            {' · '}보낸시간: {formatDateTime(item.created_at)}
                                        </div>
                                        {renderAttachments(item)}
                                    </div>
                                    <div className={styles.resolvedActions}>
                                        {item.status === 'completed' && item.can_ack && (
                                            <>
                                                <span className={styles.newBadge}>NEW</span>
                                                <button
                                                    className={styles.secondaryBtn}
                                                    type="button"
                                                    onClick={() => handleAck(item.id)}
                                                >
                                                    확인
                                                </button>
                                            </>
                                        )}
                                        {item.status !== 'completed' && (
                                            <span className={styles.pendingBadge}>OPEN</span>
                                        )}
                                    </div>
                                </div>
                            ))}
                    </div>
                </div>
            </div>

            <div className={styles.card}>
                <div className={styles.cardTitleRow}>
                    <div className={styles.cardTitle}>회사 계정 정보</div>
                </div>
                {loadingCreds && <div className={styles.mutedText}>Loading...</div>}
                {!loadingCreds && (
                    <div className={styles.companyCreds}>
                        <div className={styles.companyPinRow}>
                            <input
                                className={styles.credentialPin}
                                placeholder="공용 4자리 PIN"
                                value={companyPin}
                                onChange={(e) => setCompanyPin(e.target.value)}
                                maxLength={4}
                            />
                            <div className={styles.credentialHint}>PIN 입력 후 보기</div>
                        </div>
                        {isAdmin && (
                            <div className={styles.companyCredRow}>
                                <input
                                    className={styles.credentialInput}
                                    placeholder="항목명 (예: 택배사)"
                                    value={(credEdit.new?.label || '')}
                                    onChange={(e) => updateCredEdit('new', { label: e.target.value })}
                                />
                                <input
                                    className={styles.credentialInput}
                                    placeholder="아이디"
                                    value={(credEdit.new?.username || '')}
                                    onChange={(e) => updateCredEdit('new', { username: e.target.value })}
                                />
                                <input
                                    className={styles.credentialInput}
                                    placeholder="비밀번호"
                                    value={(credEdit.new?.password || '')}
                                    onChange={(e) => updateCredEdit('new', { password: e.target.value })}
                                />
                                <button type="button" className={styles.secondaryBtn} onClick={handleCredentialsCreate}>
                                    추가
                                </button>
                            </div>
                        )}

                        {companyCreds.length === 0 && (
                            <div className={styles.mutedText}>등록된 항목이 없습니다.</div>
                        )}
                        {companyCreds.map((item) => (
                            <div key={item.id} className={styles.companyCredRow}>
                                {isAdmin ? (
                                    <>
                                        <input
                                            className={styles.credentialInput}
                                            placeholder="항목명"
                                            value={(credEdit[item.id]?.label ?? item.label ?? '')}
                                            onChange={(e) =>
                                                updateCredEdit(item.id, { label: e.target.value })
                                            }
                                        />
                                        <input
                                            className={styles.credentialInput}
                                            placeholder="아이디"
                                            value={(credEdit[item.id]?.username ?? item.username ?? '')}
                                            onChange={(e) =>
                                                updateCredEdit(item.id, { username: e.target.value })
                                            }
                                        />
                                        <input
                                            className={styles.credentialInput}
                                            placeholder="비밀번호"
                                            value={(credEdit[item.id]?.password ?? item.password ?? '')}
                                            onChange={(e) =>
                                                updateCredEdit(item.id, { password: e.target.value })
                                            }
                                        />
                                        <button
                                            type="button"
                                            className={styles.secondaryBtn}
                                            onClick={() => handleCredentialsSave(item)}
                                        >
                                            저장
                                        </button>
                                        <button
                                            type="button"
                                            className={styles.secondaryBtn}
                                            onClick={() => handleCredentialsView(item.id)}
                                        >
                                            보기
                                        </button>
                                        <button
                                            type="button"
                                            className={styles.secondaryBtn}
                                            onClick={() => handleCredentialsDelete(item.id)}
                                        >
                                            삭제
                                        </button>
                                    </>
                                ) : (
                                    <>
                                        <div className={styles.companyCredLabel}>{item.label}</div>
                                        <button
                                            type="button"
                                            className={styles.secondaryBtn}
                                            onClick={() => handleCredentialsView(item.id)}
                                        >
                                            보기
                                        </button>
                                        {credView[item.id] && (
                                            <div className={styles.credentialValue}>
                                                <div>아이디: {credView[item.id].username || '-'}</div>
                                                <div>비밀번호: {credView[item.id].password || '-'}</div>
                                            </div>
                                        )}
                                    </>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </div>
            {previewImage && (
                <div
                    className={styles.previewOverlay}
                    onClick={() => setPreviewImage(null)}
                >
                    <div
                        className={styles.previewModal}
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className={styles.previewHeader}>
                            <div className={styles.previewTitle}>{previewImage.name}</div>
                            <div className={styles.previewActions}>
                                <button
                                    type="button"
                                    className={styles.secondaryBtn}
                                    onClick={() =>
                                        setPreviewScale((s) => Math.max(0.5, +(s - 0.25).toFixed(2)))
                                    }
                                >
                                    -
                                </button>
                                <button
                                    type="button"
                                    className={styles.secondaryBtn}
                                    onClick={() => setPreviewScale(1)}
                                >
                                    100%
                                </button>
                                <button
                                    type="button"
                                    className={styles.secondaryBtn}
                                    onClick={() =>
                                        setPreviewScale((s) => Math.min(3, +(s + 0.25).toFixed(2)))
                                    }
                                >
                                    +
                                </button>
                                <button
                                    type="button"
                                    className={styles.secondaryBtn}
                                    onClick={() => setPreviewImage(null)}
                                >
                                    닫기
                                </button>
                            </div>
                        </div>
                        <div className={styles.previewBody}>
                            <img
                                className={styles.previewImage}
                                src={previewImage.url}
                                alt={previewImage.name}
                                style={{ transform: `scale(${previewScale})` }}
                            />
                        </div>
                    </div>
                </div>
            )}
        </section>
    );
};

export default Overview;
