import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Calendar, Bell, ChevronDown, ChevronUp } from 'lucide-react';
import styles from './Dashboard.module.css';
import { COLLAB_API_BASE as API } from '../../lib/api';

const Overview = ({ currentUser }) => {
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
    const [todoTab, setTodoTab] = useState('open');
    const [todoCompleteInputId, setTodoCompleteInputId] = useState(null);
    const [todoCompleteComment, setTodoCompleteComment] = useState('');
    const [loadingTodos, setLoadingTodos] = useState(false);
    const [submittingTodo, setSubmittingTodo] = useState(false);
    const [todayTodoText, setTodayTodoText] = useState('');
    const [todayTodos, setTodayTodos] = useState([]);
    const [showTodayTodoInput, setShowTodayTodoInput] = useState(false);
    const [showAllTodayTodos, setShowAllTodayTodos] = useState(false);
    const [loadingTodayTodos, setLoadingTodayTodos] = useState(false);
    const [submittingTodayTodo, setSubmittingTodayTodo] = useState(false);
    const [selectedTodayTodoIds, setSelectedTodayTodoIds] = useState([]);
    const [sharedTodoOpen, setSharedTodoOpen] = useState(false);
    const [sentRequestsOpen, setSentRequestsOpen] = useState(false);
    const isAdmin = useMemo(() => localStorage.getItem('isAdmin') === 'true', []);

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
        fetchTodos();
        fetchTodayTodos();
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

    const fetchTodos = async () => {
        try {
            setLoadingTodos(true);
            const res = await fetch(`${API}/shared-todos`, { headers: authHeaders });
            if (handleUnauthorized(res)) return;
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.detail || 'Failed to load todos');
            setTodos(Array.isArray(data?.todos) ? data.todos : []);
        } catch (err) {
            setError(err.message || 'Failed to load todos');
        } finally {
            setLoadingTodos(false);
        }
    };

    const fetchTodayTodos = async () => {
        try {
            setLoadingTodayTodos(true);
            const res = await fetch(`${API}/my-todos`, { headers: authHeaders });
            if (handleUnauthorized(res)) return;
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.detail || 'Failed to load my todos');
            setTodayTodos(Array.isArray(data?.todos) ? data.todos : []);
        } catch (err) {
            setError(err.message || 'Failed to load my todos');
        } finally {
            setLoadingTodayTodos(false);
        }
    };


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
            if (data?.request) {
                setResolved((prev) => [data.request, ...prev.filter((item) => item.id !== data.request.id)]);
                if (data.request.assignee_username === (currentUser || localStorage.getItem('username'))) {
                    setActivity((prev) => [data.request, ...prev.filter((item) => item.id !== data.request.id)]);
                }
            }
            setRequestText('');
            setRequestFiles([]);
            if (fileInputRef.current) fileInputRef.current.value = '';
            await fetchResolved();
            if ((data?.request?.assignee_username || assignee) === (currentUser || localStorage.getItem('username'))) {
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

    const handleAddTodo = async () => {
        const text = todoText.trim();
        if (!text) return;
        try {
            setSubmittingTodo(true);
            const res = await fetch(`${API}/shared-todos`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders },
                body: JSON.stringify({ text }),
            });
            if (handleUnauthorized(res)) return;
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.detail || 'Failed to add todo');
            setTodoText('');
            await fetchTodos();
        } catch (err) {
            setError(err.message || 'Failed to add todo');
        } finally {
            setSubmittingTodo(false);
        }
    };

    const handleCompleteTodo = async (id, comment = '') => {
        try {
            const res = await fetch(`${API}/shared-todos/${id}/complete`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders },
                body: JSON.stringify({ comment }),
            });
            if (handleUnauthorized(res)) return;
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.detail || 'Failed to complete todo');
            setTodoCompleteInputId(null);
            setTodoCompleteComment('');
            await fetchTodos();
        } catch (err) {
            setError(err.message || 'Failed to complete todo');
        }
    };

    const orderedTodos = useMemo(() => {
        return [...todos].sort((a, b) => {
            const aDone = a.status === 'completed';
            const bDone = b.status === 'completed';
            if (aDone !== bDone) return aDone ? 1 : -1;
            return String(a.created_at || '').localeCompare(String(b.created_at || ''));
        });
    }, [todos]);

    const visibleTodos = useMemo(() => {
        if (todoTab === 'completed') return orderedTodos.filter((item) => item.status === 'completed');
        return orderedTodos.filter((item) => item.status !== 'completed');
    }, [orderedTodos, todoTab]);

    const handleAddTodayTodo = async () => {
        const text = todayTodoText.trim();
        if (!text) return;
        try {
            setSubmittingTodayTodo(true);
            const res = await fetch(`${API}/my-todos`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders },
                body: JSON.stringify({ text }),
            });
            if (handleUnauthorized(res)) return;
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.detail || 'Failed to add my todo');
            setTodayTodoText('');
            await fetchTodayTodos();
        } catch (err) {
            setError(err.message || 'Failed to add my todo');
        } finally {
            setSubmittingTodayTodo(false);
        }
    };

    const handleCompleteTodayTodo = async (id) => {
        try {
            const res = await fetch(`${API}/my-todos/${id}/complete`, {
                method: 'POST',
                headers: authHeaders,
            });
            if (handleUnauthorized(res)) return;
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.detail || 'Failed to complete my todo');
            await fetchTodayTodos();
        } catch (err) {
            setError(err.message || 'Failed to complete my todo');
        }
    };

    const handleUncompleteTodayTodo = async (id) => {
        try {
            const res = await fetch(`${API}/my-todos/${id}/uncomplete`, {
                method: 'POST',
                headers: authHeaders,
            });
            if (handleUnauthorized(res)) return;
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.detail || 'Failed to uncomplete my todo');
            await fetchTodayTodos();
        } catch (err) {
            setError(err.message || 'Failed to uncomplete my todo');
        }
    };

    const handleDeleteTodayTodo = async (id, refreshAfter = true) => {
        try {
            const res = await fetch(`${API}/my-todos/${id}`, {
                method: 'DELETE',
                headers: authHeaders,
            });
            if (handleUnauthorized(res)) return;
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.detail || 'Failed to delete my todo');
            if (refreshAfter) {
                await fetchTodayTodos();
            }
        } catch (err) {
            setError(err.message || 'Failed to delete my todo');
            throw err;
        }
    };

    const toggleTodayTodoSelection = (id) => {
        setSelectedTodayTodoIds((prev) => {
            if (prev.includes(id)) return prev.filter((v) => v !== id);
            return [...prev, id];
        });
    };

    const handleDeleteSelectedTodayTodos = async () => {
        if (selectedTodayTodoIds.length === 0) return;
        if (!window.confirm(`선택한 ${selectedTodayTodoIds.length}개 할 일을 삭제할까요?`)) return;
        try {
            await Promise.all(selectedTodayTodoIds.map((id) => handleDeleteTodayTodo(id, false)));
            setSelectedTodayTodoIds([]);
            await fetchTodayTodos();
        } catch (err) {
            setError(err.message || 'Failed to delete selected todos');
        }
    };

    useEffect(() => {
        const validIds = new Set(todayTodos.map((item) => item.id));
        setSelectedTodayTodoIds((prev) => prev.filter((id) => validIds.has(id)));
    }, [todayTodos]);

    const orderedTodayTodos = useMemo(() => {
        return [...todayTodos].sort((a, b) => {
            const aDone = a.status === 'completed';
            const bDone = b.status === 'completed';
            if (aDone !== bDone) return aDone ? 1 : -1;
            return String(a.created_at || '').localeCompare(String(b.created_at || ''));
        });
    }, [todayTodos]);


    return (
        <section className={styles.dashboard}>
            <div className={styles.headerRow}>
                <h1 className={styles.title}>대시보드</h1>
            </div>

            <div className={styles.contentGrid}>
                <div className={styles.contentColumn}>
                    <div className={styles.card}>
                        <div className={styles.todoHeader}>
                            <div className={styles.cardTitle}>오늘 할 일</div>
                            <div className={styles.todoHeaderActions}>
                                <button
                                    type="button"
                                    className={styles.filterBtn}
                                    onClick={handleDeleteSelectedTodayTodos}
                                    disabled={selectedTodayTodoIds.length === 0}
                                >
                                    선택 삭제
                                </button>
                                <button
                                    type="button"
                                    className={styles.todoAddToggle}
                                    onClick={() => setShowTodayTodoInput((v) => !v)}
                                >
                                    <Plus size={16} />
                                    {showTodayTodoInput ? '닫기' : '추가'}
                                </button>
                            </div>
                        </div>
                        {showTodayTodoInput && (
                            <div className={styles.todoRow}>
                                <input
                                    className={styles.todoInput}
                                    placeholder="오늘 할 일을 입력하세요"
                                    value={todayTodoText}
                                    onChange={(e) => setTodayTodoText(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') {
                                            e.preventDefault();
                                            handleAddTodayTodo();
                                        }
                                    }}
                                />
                                <button type="button" className={styles.primaryBtn} onClick={handleAddTodayTodo} disabled={submittingTodayTodo}>
                                    {submittingTodayTodo ? '등록 중...' : '등록'}
                                </button>
                            </div>
                        )}
                        <div
                            className={`${styles.todoList} ${
                                !showAllTodayTodos ? styles.todoListCollapsed : ''
                            }`}
                        >
                            {loadingTodayTodos && <div className={styles.mutedText}>불러오는 중...</div>}
                            {!loadingTodayTodos && orderedTodayTodos.length === 0 && (
                                <div className={styles.mutedText}>
                                    등록된 오늘 할 일이 없습니다.
                                </div>
                            )}
                            {!loadingTodayTodos && orderedTodayTodos.map((item) => {
                                const done = item.status === 'completed';
                                const checked = selectedTodayTodoIds.includes(item.id);
                                return (
                                    <div key={item.id} className={styles.todoItem}>
                                        <label className={styles.todoLabel}>
                                            <input
                                                type="checkbox"
                                                className={styles.todoCheckInput}
                                                checked={checked}
                                                onChange={() => toggleTodayTodoSelection(item.id)}
                                            />
                                            <span className={`${styles.todoCheckBox} ${checked ? styles.todoCheckBoxChecked : ''}`} aria-hidden="true">
                                                {checked ? '✓' : ''}
                                            </span>
                                            <span className={`${styles.todoText} ${done ? styles.todoTextDone : ''}`}>
                                                {item.text}
                                            </span>
                                        </label>
                                        <div className={styles.todoActions}>
                                            {done ? (
                                                <button
                                                    type="button"
                                                    className={styles.secondaryBtn}
                                                    onClick={() => handleUncompleteTodayTodo(item.id)}
                                                >
                                                    완료 해제
                                                </button>
                                            ) : (
                                                <button
                                                    type="button"
                                                    className={styles.todoDoneBtn}
                                                    onClick={() => handleCompleteTodayTodo(item.id)}
                                                >
                                                    완료
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                        {orderedTodayTodos.length > 0 && (
                            <div className={styles.todoToggleRow}>
                                <button
                                    type="button"
                                    className={styles.todoToggleBtn}
                                    onClick={() => setShowAllTodayTodos((v) => !v)}
                                >
                                    {showAllTodayTodos ? '접기' : '펼치기'}
                                </button>
                            </div>
                        )}
                    </div>

                <div className={styles.card}>
                    <div className={styles.cardTitle}>
                        요청 보내기
                        <Plus size={18} className={styles.cardHeaderIcon} />
                    </div>
                    <form className={styles.requestForm} onSubmit={handleSubmit}>
                        <label className={styles.formLabel}>
                            받는 사람
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
                            내용
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
                            {submitting ? '전송 중...' : '요청 전송'}
                        </button>
                    </form>
                </div>
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
                        {loadingActivity && <div className={styles.mutedText}>불러오는 중...</div>}
                        {!loadingActivity && activity.length === 0 && (
                            <div className={styles.mutedText}>받은 요청이 없습니다.</div>
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
                                            <span className={styles.completedBadge}>완료됨</span>
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
                {/* 공동 할 일 - 접기/펼치기 */}
                <div className={styles.card}>
                    <button
                        type="button"
                        className={styles.collapsibleHeader}
                        onClick={() => setSharedTodoOpen((v) => !v)}
                    >
                        <span className={styles.collapsibleTitle}>공동 할 일</span>
                        <span className={styles.collapsibleMeta}>
                            {todos.filter((t) => t.status !== 'completed').length > 0 && (
                                <span className={styles.countBadge}>
                                    {todos.filter((t) => t.status !== 'completed').length}
                                </span>
                            )}
                            {sharedTodoOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                        </span>
                    </button>
                    {sharedTodoOpen && (
                        <>
                            <div className={styles.todoHeaderActions} style={{ marginBottom: '1rem' }}>
                                <button
                                    type="button"
                                    className={`${styles.filterBtn} ${todoTab === 'open' ? styles.filterActive : ''}`}
                                    onClick={() => setTodoTab('open')}
                                >
                                    진행중
                                </button>
                                <button
                                    type="button"
                                    className={`${styles.filterBtn} ${todoTab === 'completed' ? styles.filterActive : ''}`}
                                    onClick={() => setTodoTab('completed')}
                                >
                                    완료
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
                            {showTodoInput && (
                                <div className={styles.todoRow}>
                                    <input
                                        className={styles.todoInput}
                                        placeholder="공동 할 일을 입력하세요"
                                        value={todoText}
                                        onChange={(e) => setTodoText(e.target.value)}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter') {
                                                e.preventDefault();
                                                handleAddTodo();
                                            }
                                        }}
                                    />
                                    <button type="button" className={styles.primaryBtn} onClick={handleAddTodo} disabled={submittingTodo}>
                                        {submittingTodo ? '등록 중...' : '등록'}
                                    </button>
                                </div>
                            )}
                            <div className={`${styles.todoList} ${!showAllTodos ? styles.todoListCollapsed : ''}`}>
                                {loadingTodos && <div className={styles.mutedText}>불러오는 중...</div>}
                                {!loadingTodos && visibleTodos.length === 0 && (
                                    <div className={styles.mutedText}>
                                        {todoTab === 'completed' ? '완료된 공동 할 일이 없습니다.' : '등록된 공동 할 일이 없습니다.'}
                                    </div>
                                )}
                                {!loadingTodos && visibleTodos.map((item) => {
                                    const done = item.status === 'completed';
                                    return (
                                        <div key={item.id} className={styles.todoItem}>
                                            <label className={styles.todoLabel}>
                                                <div>
                                                    <div className={`${styles.todoText} ${done ? styles.todoTextDone : ''}`}>
                                                        {item.text}
                                                    </div>
                                                    <div className={styles.todoMeta}>
                                                        등록: {item.created_by_display || item.created_by_username || '-'}
                                                        {done && (
                                                            <>
                                                                {' · '}완료: {item.completed_by_display || item.completed_by_username || '-'}
                                                            </>
                                                        )}
                                                    </div>
                                                    {done && item.completed_comment && (
                                                        <div className={styles.todoMeta}>코멘트: {item.completed_comment}</div>
                                                    )}
                                                    {!done && todoCompleteInputId === item.id && (
                                                        <div className={styles.todoInlineEditor}>
                                                            <input
                                                                className={styles.todoInput}
                                                                placeholder="완료 코멘트 (선택)"
                                                                value={todoCompleteComment}
                                                                onChange={(e) => setTodoCompleteComment(e.target.value)}
                                                                onKeyDown={(e) => {
                                                                    if (e.key === 'Enter') {
                                                                        e.preventDefault();
                                                                        handleCompleteTodo(item.id, todoCompleteComment);
                                                                    }
                                                                }}
                                                            />
                                                            <button
                                                                type="button"
                                                                className={styles.primaryBtn}
                                                                onClick={() => handleCompleteTodo(item.id, todoCompleteComment)}
                                                            >
                                                                완료 저장
                                                            </button>
                                                            <button
                                                                type="button"
                                                                className={styles.secondaryBtn}
                                                                onClick={() => {
                                                                    setTodoCompleteInputId(null);
                                                                    setTodoCompleteComment('');
                                                                }}
                                                            >
                                                                취소
                                                            </button>
                                                        </div>
                                                    )}
                                                </div>
                                            </label>
                                            <div className={styles.todoActions}>
                                                {done ? (
                                                    <span className={styles.completedBadge}>완료됨</span>
                                                ) : (
                                                    <button
                                                        type="button"
                                                        className={styles.todoDoneBtn}
                                                        onClick={() => {
                                                            setTodoCompleteInputId(item.id);
                                                            setTodoCompleteComment('');
                                                        }}
                                                    >
                                                        완료
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                            {visibleTodos.length > 0 && (
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
                        </>
                    )}
                </div>

                {/* 보낸 요청 - 접기/펼치기 */}
                <div className={styles.card}>
                    <button
                        type="button"
                        className={styles.collapsibleHeader}
                        onClick={() => setSentRequestsOpen((v) => !v)}
                    >
                        <span className={styles.collapsibleTitle}>
                            보낸 요청
                            <Bell size={15} className={styles.cardHeaderIcon} />
                        </span>
                        <span className={styles.collapsibleMeta}>
                            {resolved.filter((r) => r.status !== 'completed').length > 0 && (
                                <span className={styles.countBadge}>
                                    {resolved.filter((r) => r.status !== 'completed').length}
                                </span>
                            )}
                            {resolved.some((r) => r.can_ack) && (
                                <span className={styles.newBadge}>NEW</span>
                            )}
                            {sentRequestsOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                        </span>
                    </button>
                    {sentRequestsOpen && (
                        <>
                            <div className={styles.filterGroup} style={{ marginBottom: '1rem' }}>
                                <button
                                    type="button"
                                    className={`${styles.filterBtn} ${sentFilter === 'all' ? styles.filterActive : ''}`}
                                    onClick={() => setSentFilter('all')}
                                >
                                    전체
                                </button>
                                <button
                                    type="button"
                                    className={`${styles.filterBtn} ${sentFilter === 'open' ? styles.filterActive : ''}`}
                                    onClick={() => setSentFilter('open')}
                                >
                                    진행중
                                </button>
                                <button
                                    type="button"
                                    className={`${styles.filterBtn} ${sentFilter === 'completed' ? styles.filterActive : ''}`}
                                    onClick={() => setSentFilter('completed')}
                                >
                                    완료
                                </button>
                                <button className={styles.filterBtn} type="button" onClick={handleClearSent}>
                                    목록 지우기
                                </button>
                            </div>
                            <div className={styles.resolvedList}>
                                {loadingResolved && <div className={styles.mutedText}>불러오는 중...</div>}
                                {!loadingResolved && resolved.length === 0 && (
                                    <div className={styles.mutedText}>보낸 요청이 없습니다.</div>
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
                                                    받는사람: {item.assignee_display || item.assignee_username}
                                                    {' · '}{formatDateTime(item.created_at)}
                                                </div>
                                                {renderAttachments(item)}
                                            </div>
                                            <div className={styles.resolvedActions}>
                                                {item.status === 'completed' && item.can_ack ? (
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
                                                ) : item.status === 'completed' ? (
                                                    <span className={styles.completedStatusBadge}>완료됨</span>
                                                ) : (
                                                    <span className={styles.pendingBadge}>진행중</span>
                                                )}
                                            </div>
                                        </div>
                                    ))}
                            </div>
                        </>
                    )}
                </div>
            </div>

            <div className={styles.card}>
                <div className={styles.cardTitleRow}>
                    <div className={styles.cardTitle}>회사 계정 정보</div>
                </div>
                {loadingCreds && <div className={styles.mutedText}>불러오는 중...</div>}
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
