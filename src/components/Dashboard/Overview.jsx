import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Plus, Calendar, Bell, ChevronDown, ChevronUp, Pin, PinOff, GripVertical, MessageSquare } from 'lucide-react';
import styles from './Dashboard.module.css';
import { COLLAB_API_BASE as API, LOCAL_API_BASE, getAuthHeaders, handleUnauthorized } from '../../lib/api';

function AuthImage({ src, token, className, alt, onClick }) {
    const [blobUrl, setBlobUrl] = useState('');
    useEffect(() => {
        let objectUrl = '';
        const headers = token ? { Authorization: `Bearer ${token}` } : {};
        fetch(src, { headers })
            .then((r) => (r.ok ? r.blob() : null))
            .then((blob) => {
                if (blob) {
                    objectUrl = URL.createObjectURL(blob);
                    setBlobUrl(objectUrl);
                }
            })
            .catch(() => {});
        return () => { if (objectUrl) URL.revokeObjectURL(objectUrl); };
    }, [src, token]);
    if (!blobUrl) return null;
    return <img src={blobUrl} className={className} alt={alt} onClick={onClick} />;
}

const Overview = ({ currentUser, currentUserPhone: authPhoneNumber = '' }) => {
    const [users, setUsers] = useState([]);
    const [assignee, setAssignee] = useState('');
    const [requestText, setRequestText] = useState('');
    const [requestFiles, setRequestFiles] = useState([]);
    const fileInputRef = useRef(null);
    const [activity, setActivity] = useState([]);
    const [resolved, setResolved] = useState([]);
    const [loadingUsers, setLoadingUsers] = useState(true);
    const [loadingActivity, setLoadingActivity] = useState(true);
    const [loadingResolved, setLoadingResolved] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState('');
    const [freshnessChecking, setFreshnessChecking] = useState(false);
    const [freshnessResult, setFreshnessResult] = useState(null);
    const [freshnessError, setFreshnessError] = useState('');
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
    const [collapsedTodayGroups, setCollapsedTodayGroups] = useState({});
    const [draggingTodaySectionKey, setDraggingTodaySectionKey] = useState('');
    const [dragOverTodaySectionKey, setDragOverTodaySectionKey] = useState('');
    const [sharedTodoOpen, setSharedTodoOpen] = useState(false);
    const [sentRequestsOpen, setSentRequestsOpen] = useState(false);
    const [activityPanelWidth, setActivityPanelWidth] = useState(420);
    const [dashboardLayoutLoaded, setDashboardLayoutLoaded] = useState(false);
    const [pinnedRequestIds, setPinnedRequestIds] = useState([]);
    const [pinnedRequestsLoaded, setPinnedRequestsLoaded] = useState(false);
    const [requestAlertsEnabled, setRequestAlertsEnabled] = useState(false);
    const [editingRequestId, setEditingRequestId] = useState(null);
    const [editingRequestText, setEditingRequestText] = useState('');
    const [expandedCommentIds, setExpandedCommentIds] = useState(new Set());
    // { [requestId]: { items: Comment[]|null, loading, input, submitting } }
    const [commentsCache, setCommentsCache] = useState({});
    const isAdmin = useMemo(() => localStorage.getItem('isAdmin') === 'true', []);
    const resizeStateRef = useRef(null);
    const activityListRef = useRef(null);
    const pendingActivityScrollTopRef = useRef(null);
    const hasLoadedActivityRef = useRef(false);
    const previousOpenRequestIdsRef = useRef(new Set());
    const requestAlertsPrimedRef = useRef(false);
    const previousSmsWatchIdsRef = useRef(new Set());
    const requestSmsWatchPrimedRef = useRef(false);

    const dashboardUserKey = currentUser || localStorage.getItem('username') || 'guest';
    const pinnedRequestsStorageKey = `dashboard:pinned-requests:${dashboardUserKey}`;
    const activityWidthStorageKey = `dashboard:activity-width:${dashboardUserKey}`;
    const requestAlertsStorageKey = `dashboard:request-alerts:${dashboardUserKey}`;
    const requestSmsSentStorageKey = `dashboard:request-sms-sent:${dashboardUserKey}`;
    const requestSmsWatchSinceStorageKey = `dashboard:request-sms-watch-since:${dashboardUserKey}`;
    const todayTodoGroupStorageKey = `dashboard:today-todo-groups:${dashboardUserKey}`;

    const authHeaders = getAuthHeaders();
    const currentUserPhone = useMemo(() => {
        const fromAuth = String(authPhoneNumber || '').replace(/[^0-9]/g, '');
        if (fromAuth) return fromAuth;
        return String(localStorage.getItem('phoneNumber') || '').replace(/[^0-9]/g, '');
    }, [authPhoneNumber]);

    useEffect(() => {
        try {
            const raw = localStorage.getItem(todayTodoGroupStorageKey);
            const parsed = raw ? JSON.parse(raw) : {};
            setCollapsedTodayGroups(parsed && typeof parsed === 'object' ? parsed : {});
        } catch {
            setCollapsedTodayGroups({});
        }
    }, [todayTodoGroupStorageKey]);

    useEffect(() => {
        try {
            localStorage.setItem(todayTodoGroupStorageKey, JSON.stringify(collapsedTodayGroups));
        } catch {
            // ignore local cache failures
        }
    }, [collapsedTodayGroups, todayTodoGroupStorageKey]);
    const canSendLocalRequestSms = useMemo(() => {
        if (typeof window === 'undefined') return false;
        const host = (window.location.hostname || '').trim();
        return (
            host === 'localhost' ||
            host === '127.0.0.1' ||
            /^192\.168\./.test(host) ||
            /^10\./.test(host) ||
            /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
        );
    }, []);

    const markRequestSmsSent = useCallback((requestId) => {
        try {
            const raw = localStorage.getItem(requestSmsSentStorageKey);
            const parsed = raw ? JSON.parse(raw) : [];
            const next = Array.isArray(parsed) ? parsed.filter((id) => Number.isFinite(id)) : [];
            if (!next.includes(requestId)) next.push(requestId);
            localStorage.setItem(requestSmsSentStorageKey, JSON.stringify(next.slice(-300)));
        } catch {
            // ignore local cache failures
        }
    }, [requestSmsSentStorageKey]);

    const hasRequestSmsBeenSent = useCallback((requestId) => {
        try {
            const raw = localStorage.getItem(requestSmsSentStorageKey);
            const parsed = raw ? JSON.parse(raw) : [];
            return Array.isArray(parsed) && parsed.includes(requestId);
        } catch {
            return false;
        }
    }, [requestSmsSentStorageKey]);

    const getRequestSmsWatchSince = useCallback(() => {
        try {
            const raw = localStorage.getItem(requestSmsWatchSinceStorageKey);
            return raw ? String(raw) : '';
        } catch {
            return '';
        }
    }, [requestSmsWatchSinceStorageKey]);

    const sendLocalRequestSms = useCallback(async (item) => {
        if (!canSendLocalRequestSms) {
            console.debug('[request-sms] skipped non-local host', {
                host: typeof window !== 'undefined' ? window.location.hostname : '',
                requestId: item?.id,
            });
            return;
        }
        if (!currentUserPhone) {
            console.debug('[request-sms] skipped missing phone', {
                dashboardUserKey,
                requestId: item?.id,
                authPhoneNumber,
            });
            return;
        }
        if (!item?.id) {
            console.debug('[request-sms] skipped missing request id', { item });
            return;
        }
        if (hasRequestSmsBeenSent(item.id)) {
            console.debug('[request-sms] skipped already sent', { requestId: item.id });
            return;
        }
        const body = (item.text || '').trim();
        if (!body) {
            console.debug('[request-sms] skipped empty text', { requestId: item.id });
            return;
        }
        const preview = body.length > 80 ? `${body.slice(0, 80)}...` : body;
        console.debug('[request-sms] sending', {
            requestId: item.id,
            receiver: currentUserPhone,
            createdAt: item.created_at,
            requester: item.requester_display || item.requester_username,
        });
        const res = await fetch(`${LOCAL_API_BASE}/sms/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders },
            body: JSON.stringify({
                receiver: currentUserPhone,
                msg: `[요청알림]\n보낸사람: ${item.requester_display || item.requester_username || '익명'}\n담당자: ${item.assignee_display || item.assignee_username || dashboardUserKey}\n내용: ${preview}`,
                msg_type: 'LMS',
                title: '새 요청 알림',
            }),
        });
        if (handleUnauthorized(res)) return;
        const data = await res.json().catch(() => ({}));
        if (!res.ok || Number(data?.result_code || 0) <= 0) {
            console.debug('[request-sms] send failed', {
                requestId: item.id,
                status: res.status,
                data,
            });
            throw new Error(data?.detail || data?.message || 'Failed to send request SMS');
        }
        console.debug('[request-sms] send success', {
            requestId: item.id,
            data,
        });
        markRequestSmsSent(item.id);
    }, [authHeaders, authPhoneNumber, canSendLocalRequestSms, currentUserPhone, dashboardUserKey, hasRequestSmsBeenSent, markRequestSmsSent]);

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
        const isInitial = !hasLoadedActivityRef.current;
        try {
            if (isInitial) setLoadingActivity(true);
            const res = await fetch(`${API}/requests/assigned`, {
                headers: authHeaders,
            });
            if (handleUnauthorized(res)) return;
            const data = await res.json();
            if (!res.ok) throw new Error(data?.detail || 'Failed to load activity');
            const requests = Array.isArray(data?.requests) ? data.requests : [];
            const openRequests = requests.filter((item) => item.status !== 'completed');
            const openRequestIds = new Set(openRequests.map((item) => item.id));

            const newItems = openRequests.filter((item) => !previousOpenRequestIdsRef.current.has(item.id));
            console.debug('[request-sms] poll', {
                dashboardUserKey,
                requestAlertsEnabled,
                currentUserPhone,
                openRequestIds: Array.from(openRequestIds),
                previousOpenRequestIds: Array.from(previousOpenRequestIdsRef.current),
                newItemIds: newItems.map((item) => item.id),
            });

            if (requestSmsWatchPrimedRef.current && canSendLocalRequestSms) {
                const watchSince = getRequestSmsWatchSince();
                console.debug('[request-sms] watch active', {
                    watchSince,
                    previousSmsWatchIds: Array.from(previousSmsWatchIdsRef.current),
                });
                newItems.forEach((item) => {
                    const createdAt = String(item?.created_at || '');
                    const isNewForSms = !previousSmsWatchIdsRef.current.has(item.id);
                    const isAfterWatchSince = !watchSince || createdAt > watchSince;
                    console.debug('[request-sms] evaluate item', {
                        requestId: item.id,
                        createdAt,
                        isNewForSms,
                        isAfterWatchSince,
                    });
                    if (isNewForSms && isAfterWatchSince) {
                        sendLocalRequestSms(item).catch(() => {});
                    }
                });
            } else {
                console.debug('[request-sms] watch inactive', {
                    requestSmsWatchPrimed: requestSmsWatchPrimedRef.current,
                    canSendLocalRequestSms,
                });
            }

            if (requestAlertsPrimedRef.current && requestAlertsEnabled && typeof window !== 'undefined' && 'Notification' in window) {
                if (Notification.permission === 'granted') {
                    newItems.forEach((item) => {
                        const body = (item.text || '').trim() || '새 요청이 도착했습니다.';
                        new Notification('새 받은 요청', {
                            body: body.length > 80 ? `${body.slice(0, 80)}...` : body,
                            tag: `request-${item.id}`,
                        });
                    });
                }
            }

            previousOpenRequestIdsRef.current = openRequestIds;
            requestAlertsPrimedRef.current = true;
            previousSmsWatchIdsRef.current = openRequestIds;
            requestSmsWatchPrimedRef.current = true;
            hasLoadedActivityRef.current = true;
            if (activityListRef.current) {
                pendingActivityScrollTopRef.current = activityListRef.current.scrollTop;
            }
            setActivity(requests);
        } catch (err) {
            setError(err.message || 'Failed to load activity');
        } finally {
            if (isInitial) setLoadingActivity(false);
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

    const handleFreshnessCheck = async () => {
        setFreshnessChecking(true);
        setFreshnessError('');
        try {
            const res = await fetch(`${LOCAL_API_BASE}/wonbe/freshness-check`, {
                method: 'POST',
                headers: authHeaders,
            });
            if (handleUnauthorized(res)) return;
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.ok) throw new Error(data?.detail || '최신화 확인 실패');
            setFreshnessResult(data);
        } catch (err) {
            setFreshnessError(err.message || '최신화 확인 실패');
        } finally {
            setFreshnessChecking(false);
        }
    };

    const fetchFreshnessStatus = async () => {
        try {
            const res = await fetch(`${LOCAL_API_BASE}/wonbe/freshness-status`, {
                headers: authHeaders,
            });
            if (handleUnauthorized(res)) return;
            const data = await res.json().catch(() => ({}));
            if (res.ok && data.ok && data.status) {
                setFreshnessResult(data);
            }
        } catch {
            // 네트워크 오류 시 조용히 무시 — "아직 확인하지 않았습니다" 상태 유지
        }
    };

    useEffect(() => {
        fetchUsers();
        fetchResolved();
        fetchTodos();
        fetchTodayTodos();
        fetchFreshnessStatus();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        fetchActivity();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentUser]);

    useEffect(() => {
        const stored = localStorage.getItem(requestAlertsStorageKey);
        setRequestAlertsEnabled(stored === '1');
        previousOpenRequestIdsRef.current = new Set();
        requestAlertsPrimedRef.current = false;
    }, [requestAlertsStorageKey]);

    useEffect(() => {
        previousSmsWatchIdsRef.current = new Set();
        requestSmsWatchPrimedRef.current = false;
        try {
            if (!localStorage.getItem(requestSmsWatchSinceStorageKey)) {
                localStorage.setItem(requestSmsWatchSinceStorageKey, new Date().toISOString());
            }
        } catch {
            // ignore local cache failures
        }
    }, [dashboardUserKey, requestSmsWatchSinceStorageKey]);

    useEffect(() => {
        if (!requestAlertsEnabled) return undefined;
        const timer = window.setInterval(() => {
            fetchActivity();
        }, 15000);
        return () => window.clearInterval(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [requestAlertsEnabled, currentUser]);

    useEffect(() => {
        if (!canSendLocalRequestSms) return undefined;
        const timer = window.setInterval(() => {
            fetchActivity();
        }, 15000);
        return () => window.clearInterval(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [canSendLocalRequestSms, currentUser]);

    useEffect(() => {
        const storedPins = localStorage.getItem(pinnedRequestsStorageKey);
        if (!storedPins) {
            setPinnedRequestIds([]);
            setPinnedRequestsLoaded(true);
            return;
        }
        try {
            const parsed = JSON.parse(storedPins);
            setPinnedRequestIds(Array.isArray(parsed) ? parsed.filter((id) => Number.isFinite(id)) : []);
        } catch {
            setPinnedRequestIds([]);
        } finally {
            setPinnedRequestsLoaded(true);
        }
    }, [pinnedRequestsStorageKey]);

    useEffect(() => {
        const storedWidth = Number(localStorage.getItem(activityWidthStorageKey));
        if (Number.isFinite(storedWidth) && storedWidth >= 320 && storedWidth <= 760) {
            setActivityPanelWidth(storedWidth);
        } else {
            setActivityPanelWidth(420);
        }
        setDashboardLayoutLoaded(false);
    }, [activityWidthStorageKey]);

    useEffect(() => {
        if (!pinnedRequestsLoaded) return;
        localStorage.setItem(pinnedRequestsStorageKey, JSON.stringify(pinnedRequestIds));
    }, [pinnedRequestIds, pinnedRequestsLoaded, pinnedRequestsStorageKey]);

    useEffect(() => {
        localStorage.setItem(activityWidthStorageKey, String(Math.round(activityPanelWidth)));
    }, [activityPanelWidth, activityWidthStorageKey]);

    useEffect(() => {
        let cancelled = false;

        const fetchDashboardLayout = async () => {
            try {
                const res = await fetch(`${API}/settings/dashboard-layout`, { headers: authHeaders });
                if (handleUnauthorized(res)) return;
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(data?.detail || 'Failed to load dashboard layout');
                const width = Number(data?.activity_panel_width);
                if (!cancelled && Number.isFinite(width) && width >= 320 && width <= 760) {
                    setActivityPanelWidth(width);
                    localStorage.setItem(activityWidthStorageKey, String(Math.round(width)));
                }
            } catch (err) {
                if (!cancelled) {
                    setError((prev) => prev || err.message || 'Failed to load dashboard layout');
                }
            } finally {
                if (!cancelled) {
                    setDashboardLayoutLoaded(true);
                }
            }
        };

        fetchDashboardLayout();

        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activityWidthStorageKey]);

    useEffect(() => {
        if (!dashboardLayoutLoaded) return undefined;

        const roundedWidth = Math.round(activityPanelWidth);
        const timer = window.setTimeout(async () => {
            try {
                const res = await fetch(`${API}/settings/dashboard-layout`, {
                    method: 'PATCH',
                    headers: {
                        'Content-Type': 'application/json',
                        ...authHeaders,
                    },
                    body: JSON.stringify({ activity_panel_width: roundedWidth }),
                });
                if (handleUnauthorized(res)) return;
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(data?.detail || 'Failed to save dashboard layout');
            } catch (err) {
                setError((prev) => prev || err.message || 'Failed to save dashboard layout');
            }
        }, 250);

        return () => {
            window.clearTimeout(timer);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activityPanelWidth, dashboardLayoutLoaded]);

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

    const getCommentState = (id) =>
        commentsCache[id] ?? { items: null, loading: false, input: '', submitting: false };

    const handleToggleComments = async (id) => {
        const isOpen = expandedCommentIds.has(id);
        setExpandedCommentIds((prev) => {
            const next = new Set(prev);
            if (isOpen) next.delete(id); else next.add(id);
            return next;
        });
        if (!isOpen && !commentsCache[id]?.items) {
            setCommentsCache((prev) => ({ ...prev, [id]: { ...getCommentState(id), loading: true } }));
            try {
                const res = await fetch(`${API}/requests/${id}/comments`, { headers: authHeaders });
                const data = await res.json().catch(() => ({}));
                setCommentsCache((prev) => ({
                    ...prev,
                    [id]: { ...prev[id], items: data.comments || [], loading: false },
                }));
            } catch {
                setCommentsCache((prev) => ({ ...prev, [id]: { ...prev[id], loading: false, items: [] } }));
            }
        }
    };

    const handleAddComment = async (id) => {
        const text = (commentsCache[id]?.input || '').trim();
        if (!text) return;
        setCommentsCache((prev) => ({ ...prev, [id]: { ...prev[id], submitting: true } }));
        try {
            const res = await fetch(`${API}/requests/${id}/comments`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders },
                body: JSON.stringify({ text }),
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok && data.comment) {
                setCommentsCache((prev) => ({
                    ...prev,
                    [id]: {
                        ...prev[id],
                        items: [...(prev[id]?.items || []), data.comment],
                        input: '',
                        submitting: false,
                    },
                }));
            } else {
                setCommentsCache((prev) => ({ ...prev, [id]: { ...prev[id], submitting: false } }));
            }
        } catch {
            setCommentsCache((prev) => ({ ...prev, [id]: { ...prev[id], submitting: false } }));
        }
    };

    const handleDeleteComment = async (requestId, commentId) => {
        try {
            const res = await fetch(`${API}/requests/${requestId}/comments/${commentId}`, {
                method: 'DELETE',
                headers: authHeaders,
            });
            if (!res.ok) return;
            setCommentsCache((prev) => ({
                ...prev,
                [requestId]: {
                    ...prev[requestId],
                    items: (prev[requestId]?.items || []).filter((c) => c.id !== commentId),
                },
            }));
        } catch {
            // ignore
        }
    };

    const handleComplete = async (id) => {
        try {
            if (activityListRef.current) {
                pendingActivityScrollTopRef.current = activityListRef.current.scrollTop;
            }
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

    const togglePinnedRequest = (requestId) => {
        setPinnedRequestIds((prev) => (
            prev.includes(requestId)
                ? prev.filter((id) => id !== requestId)
                : [requestId, ...prev]
        ));
    };

    const handleRequestAlertsToggle = async () => {
        if (typeof window === 'undefined' || !('Notification' in window)) {
            setError('This browser does not support notifications.');
            return;
        }

        if (requestAlertsEnabled) {
            setRequestAlertsEnabled(false);
            localStorage.setItem(requestAlertsStorageKey, '0');
            return;
        }

        let permission = Notification.permission;
        if (permission === 'default') {
            permission = await Notification.requestPermission();
        }

        if (permission !== 'granted') {
            setError('Notification permission was not granted.');
            return;
        }

        setRequestAlertsEnabled(true);
        localStorage.setItem(requestAlertsStorageKey, '1');
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

    const handleEditRequest = (item) => {
        setEditingRequestId(item.id);
        setEditingRequestText(item.text);
    };

    const handleSaveEditRequest = async (id) => {
        const text = editingRequestText.trim();
        if (!text) return;
        try {
            const res = await fetch(`${API}/requests/${id}`, {
                method: 'PATCH',
                headers: { ...authHeaders, 'Content-Type': 'application/json' },
                body: JSON.stringify({ text }),
            });
            if (handleUnauthorized(res)) return;
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.detail || '수정에 실패했습니다');
            setEditingRequestId(null);
            setEditingRequestText('');
            await fetchResolved();
        } catch (err) {
            setError(err.message || '수정에 실패했습니다');
        }
    };

    const handleDeleteRequest = async (id) => {
        if (!window.confirm('이 요청을 삭제할까요?')) return;
        try {
            const res = await fetch(`${API}/requests/${id}`, {
                method: 'DELETE',
                headers: authHeaders,
            });
            if (handleUnauthorized(res)) return;
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.detail || '삭제에 실패했습니다');
            await fetchResolved();
        } catch (err) {
            setError(err.message || '삭제에 실패했습니다');
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

    const getAttachmentUrl = (file) => `${API}${file.url}`;

    const closePreview = () => {
        setPreviewImage((prev) => {
            if (prev?.isBlob) URL.revokeObjectURL(prev.url);
            return null;
        });
    };

    const downloadAttachment = async (file) => {
        try {
            const res = await fetch(getAttachmentUrl(file), { headers: authHeaders });
            if (!res.ok) throw new Error('다운로드 실패');
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = file.filename;
            a.click();
            URL.revokeObjectURL(url);
        } catch {
            // 실패 시 무시
        }
    };

    const openImagePreview = async (file) => {
        try {
            const res = await fetch(getAttachmentUrl(file), { headers: authHeaders });
            if (!res.ok) return;
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            setPreviewScale(1);
            setPreviewImage({ url, name: file.filename, isBlob: true });
        } catch {
            // 실패 시 무시
        }
    };

    const renderAttachments = (item) => {
        if (!item.attachments || item.attachments.length === 0) return null;
        return (
            <div className={styles.attachmentList}>
                {item.attachments.map((file) => (
                    <div key={file.id} className={styles.attachmentItem}>
                        {file.is_image ? (
                            <AuthImage
                                className={styles.attachmentThumb}
                                src={getAttachmentUrl(file)}
                                token={localStorage.getItem('token')}
                                alt={file.filename}
                                onClick={() => openImagePreview(file)}
                            />
                        ) : (
                            <div className={styles.attachmentIcon}>FILE</div>
                        )}
                        <div className={styles.attachmentMeta}>
                            <button
                                type="button"
                                className={styles.attachmentLink}
                                onClick={() => downloadAttachment(file)}
                            >
                                {file.filename}
                            </button>
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

    const orderedActivity = useMemo(() => {
        const pinnedSet = new Set(pinnedRequestIds);
        return [...activity].sort((a, b) => {
            const aPinned = pinnedSet.has(a.id);
            const bPinned = pinnedSet.has(b.id);
            if (aPinned !== bPinned) return aPinned ? -1 : 1;

            const aDone = a.status === 'completed';
            const bDone = b.status === 'completed';
            if (aDone !== bDone) return aDone ? 1 : -1;

            return String(b.created_at || '').localeCompare(String(a.created_at || ''));
        });
    }, [activity, pinnedRequestIds]);

    useEffect(() => {
        const savedScrollTop = pendingActivityScrollTopRef.current;
        const listEl = activityListRef.current;
        if (savedScrollTop == null || !listEl) return;

        const maxScrollTop = Math.max(0, listEl.scrollHeight - listEl.clientHeight);
        listEl.scrollTop = Math.min(savedScrollTop, maxScrollTop);
        pendingActivityScrollTopRef.current = null;
    }, [orderedActivity]);

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

    const persistTodayTodoOrder = useCallback(async (orderedIds) => {
        const res = await fetch(`${API}/my-todos/order`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', ...authHeaders },
            body: JSON.stringify({ ordered_ids: orderedIds }),
        });
        if (handleUnauthorized(res)) return false;
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.detail || 'Failed to reorder my todos');
        return true;
    }, [authHeaders]);

    const orderedTodayTodos = useMemo(() => {
        return [...todayTodos].sort((a, b) => {
            const aDone = a.status === 'completed';
            const bDone = b.status === 'completed';
            if (aDone !== bDone) return aDone ? 1 : -1;
            const orderDiff = Number(a.sort_order || 0) - Number(b.sort_order || 0);
            if (orderDiff !== 0) return orderDiff;
            return String(a.created_at || '').localeCompare(String(b.created_at || ''));
        });
    }, [todayTodos]);

    const todayTodoSections = useMemo(() => {
        const sections = [];
        const grouped = new Map();
        orderedTodayTodos.forEach((item) => {
            const groupId = String(item.group_id || '');
            if (!groupId) {
                sections.push({ type: 'item', key: `item:${item.id}`, item, ids: [item.id] });
                return;
            }
            if (!grouped.has(groupId)) {
                const section = {
                    type: 'group',
                    key: `group:${groupId}`,
                    groupId,
                    title: item.group_title || '선택 묶음',
                    items: [],
                    ids: [],
                };
                grouped.set(groupId, section);
                sections.push(section);
            }
            grouped.get(groupId).items.push(item);
            grouped.get(groupId).ids.push(item.id);
        });
        return sections;
    }, [orderedTodayTodos]);

    const moveTodayTodoBlock = useCallback(async (movingIds, targetIds) => {
        const movingIdSet = new Set(movingIds);
        const nextIds = orderedTodayTodos
            .filter((item) => !movingIdSet.has(item.id))
            .map((item) => item.id);
        const targetIndex = nextIds.findIndex((id) => id === targetIds[0]);
        if (targetIndex < 0) return;
        nextIds.splice(targetIndex, 0, ...movingIds);
        try {
            const ok = await persistTodayTodoOrder(nextIds);
            if (!ok) return;
            await fetchTodayTodos();
        } catch (err) {
            setError(err.message || 'Failed to reorder my todos');
        }
    }, [orderedTodayTodos, persistTodayTodoOrder]);

    useEffect(() => {
        const nextGroupIds = new Set(
            todayTodoSections
                .filter((section) => section.type === 'group')
                .map((section) => section.groupId)
        );
        setCollapsedTodayGroups((prev) => {
            const next = {};
            let changed = false;
            Object.entries(prev).forEach(([groupId, isCollapsed]) => {
                if (nextGroupIds.has(groupId)) next[groupId] = isCollapsed;
                else changed = true;
            });
            nextGroupIds.forEach((groupId) => {
                if (!(groupId in next)) {
                    next[groupId] = true;
                    changed = true;
                }
            });
            return changed ? next : prev;
        });
    }, [todayTodoSections]);

    const toggleTodayTodoGroup = (groupId) => {
        setCollapsedTodayGroups((prev) => ({ ...prev, [groupId]: !prev[groupId] }));
    };

    const handleTodaySectionDrop = async (targetSection) => {
        const draggingSection = todayTodoSections.find((section) => section.key === draggingTodaySectionKey);
        if (!draggingSection || draggingSection.key === targetSection.key) {
            setDraggingTodaySectionKey('');
            setDragOverTodaySectionKey('');
            return;
        }
        await moveTodayTodoBlock(draggingSection.ids, targetSection.ids);
        setDraggingTodaySectionKey('');
        setDragOverTodaySectionKey('');
    };

    const handleGroupSelectedTodayTodos = async () => {
        if (selectedTodayTodoIds.length < 2) return;
        const title = window.prompt('묶음 이름을 입력하세요.', '선택 묶음');
        if (title === null) return;
        try {
            const res = await fetch(`${API}/my-todos/group`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders },
                body: JSON.stringify({ ids: selectedTodayTodoIds, title: title.trim() }),
            });
            if (handleUnauthorized(res)) return;
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.detail || 'Failed to group my todos');
            if (data?.group_id) {
                setCollapsedTodayGroups((prev) => ({ ...prev, [data.group_id]: true }));
            }
            setSelectedTodayTodoIds([]);
            await fetchTodayTodos();
        } catch (err) {
            setError(err.message || 'Failed to group my todos');
        }
    };

    const handleUngroupTodayTodos = async (groupId) => {
        try {
            const res = await fetch(`${API}/my-todos/ungroup`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders },
                body: JSON.stringify({ group_id: groupId }),
            });
            if (handleUnauthorized(res)) return;
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.detail || 'Failed to ungroup my todos');
            setCollapsedTodayGroups((prev) => {
                const next = { ...prev };
                delete next[groupId];
                return next;
            });
            await fetchTodayTodos();
        } catch (err) {
            setError(err.message || 'Failed to ungroup my todos');
        }
    };

    useEffect(() => {
        if (loadingActivity) return;
        const activityIds = new Set(activity.map((item) => item.id));
        setPinnedRequestIds((prev) => prev.filter((id) => activityIds.has(id)));
    }, [activity, loadingActivity]);

    useEffect(() => {
        const handlePointerMove = (event) => {
            const state = resizeStateRef.current;
            if (!state) return;
            const clientX = 'touches' in event ? event.touches[0]?.clientX : event.clientX;
            if (typeof clientX !== 'number') return;
            const delta = state.startX - clientX;
            const nextWidth = Math.min(760, Math.max(320, state.startWidth + delta));
            setActivityPanelWidth(nextWidth);
        };

        const stopResize = () => {
            resizeStateRef.current = null;
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        };

        window.addEventListener('mousemove', handlePointerMove);
        window.addEventListener('mouseup', stopResize);
        window.addEventListener('touchmove', handlePointerMove, { passive: false });
        window.addEventListener('touchend', stopResize);

        return () => {
            window.removeEventListener('mousemove', handlePointerMove);
            window.removeEventListener('mouseup', stopResize);
            window.removeEventListener('touchmove', handlePointerMove);
            window.removeEventListener('touchend', stopResize);
        };
    }, []);

    const startActivityResize = (event) => {
        const clientX = 'touches' in event ? event.touches[0]?.clientX : event.clientX;
        if (typeof clientX !== 'number') return;
        resizeStateRef.current = {
            startX: clientX,
            startWidth: activityPanelWidth,
        };
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
    };

    const freshnessDotClassName = `${styles.freshnessDot} ${
        freshnessResult?.status === 'red' ? styles.freshnessDotRed
            : freshnessResult?.status === 'blue' ? styles.freshnessDotBlue
                : ''
    }`;

    return (
        <section className={styles.dashboard}>
            <div className={styles.headerRow}>
                <h1 className={styles.title}>대시보드</h1>
            </div>

            <div className={styles.card}>
                <div className={styles.cardTitle}>DB 업데이트 관리</div>
                <div className={styles.freshnessCard}>
                    <div className={styles.freshnessItems}>
                        <div className={styles.freshnessInfo}>
                            <span className={freshnessDotClassName} />
                            <div className={styles.freshnessText}>
                                <span className={styles.freshnessTextTitle}>원가베이스유</span>
                                <span>
                                    {!freshnessResult && !freshnessError && '아직 확인하지 않았습니다.'}
                                    {freshnessResult?.status === 'red' && '재수집이 필요합니다.'}
                                    {freshnessResult?.status === 'blue' && '최신 상태입니다.'}
                                    {freshnessError && freshnessError}
                                    {freshnessResult && (
                                        <>
                                            {' · 에이블리 최신 등록일 '}{freshnessResult.latest_created_at || '-'}
                                            {' · 마지막 동기화 '}{freshnessResult.last_sync_at || '없음'}
                                            {' ('}상품 {freshnessResult.checked_goods}건 / {freshnessResult.checked_pages}페이지 확인)
                                        </>
                                    )}
                                </span>
                            </div>
                        </div>
                        <div className={styles.freshnessInfo}>
                            <span className={freshnessDotClassName} />
                            <div className={styles.freshnessText}>
                                <span className={styles.freshnessTextTitle}>입고대기</span>
                                <span>
                                    {freshnessResult
                                        ? `신규 ${freshnessResult.ingodaegi_added ?? 0}건 추가됨`
                                        : '아직 확인하지 않았습니다.'}
                                </span>
                            </div>
                        </div>
                        <div className={styles.freshnessInfo}>
                            <span className={freshnessDotClassName} />
                            <div className={styles.freshnessText}>
                                <span className={styles.freshnessTextTitle}>에이블리재고변경</span>
                                <span>
                                    {freshnessResult
                                        ? `신규 ${freshnessResult.ablystock_added ?? 0}건 추가됨`
                                        : '아직 확인하지 않았습니다.'}
                                </span>
                            </div>
                        </div>
                        {freshnessResult?.checked_at && (
                            <div className={styles.freshnessCheckedAt}>
                                마지막 최신화 확인 {freshnessResult.checked_at}
                            </div>
                        )}
                    </div>
                    <button
                        type="button"
                        className={styles.primaryBtn}
                        onClick={handleFreshnessCheck}
                        disabled={freshnessChecking}
                    >
                        {freshnessChecking ? '확인 중...' : '최신화 확인'}
                    </button>
                </div>
            </div>

            <div
                className={styles.contentGrid}
                style={{ '--activity-panel-width': `${activityPanelWidth}px` }}
            >
                <div className={styles.contentColumn}>
                    <div className={styles.card}>
                        <div className={styles.todoHeader}>
                            <div className={styles.cardTitle}>오늘 할 일</div>
                            <div className={styles.todoHeaderActions}>
                                <button
                                    type="button"
                                    className={styles.filterBtn}
                                    onClick={handleGroupSelectedTodayTodos}
                                    disabled={selectedTodayTodoIds.length < 2}
                                >
                                    선택 묶기
                                </button>
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
                        {todayTodoSections.length > 1 && (
                            <div className={styles.todoDragHint}>할 일 카드를 끌어서 순서를 바꿀 수 있습니다.</div>
                        )}
                        <div
                            className={`${styles.todoList} ${
                                !showAllTodayTodos ? styles.todoListCollapsed : ''
                            }`}
                        >
                            {loadingTodayTodos && <div className={styles.mutedText}>불러오는 중...</div>}
                            {!loadingTodayTodos && todayTodoSections.length === 0 && (
                                <div className={styles.mutedText}>
                                    등록된 오늘 할 일이 없습니다.
                                </div>
                            )}
                            {!loadingTodayTodos && todayTodoSections.map((section) => {
                                if (section.type === 'group') {
                                    const isCollapsed = collapsedTodayGroups[section.groupId] !== false;
                                    return (
                                        <div
                                            key={section.groupId}
                                            className={`${styles.todoGroup} ${draggingTodaySectionKey === section.key ? styles.todoSectionDragging : ''} ${dragOverTodaySectionKey === section.key && draggingTodaySectionKey !== section.key ? styles.todoSectionDropTarget : ''}`}
                                            draggable
                                            onDragStart={() => setDraggingTodaySectionKey(section.key)}
                                            onDragEnd={() => {
                                                setDraggingTodaySectionKey('');
                                                setDragOverTodaySectionKey('');
                                            }}
                                            onDragOver={(e) => {
                                                e.preventDefault();
                                                if (draggingTodaySectionKey && draggingTodaySectionKey !== section.key) {
                                                    setDragOverTodaySectionKey(section.key);
                                                }
                                            }}
                                            onDragLeave={() => {
                                                if (dragOverTodaySectionKey === section.key) {
                                                    setDragOverTodaySectionKey('');
                                                }
                                            }}
                                            onDrop={() => handleTodaySectionDrop(section)}
                                        >
                                            <div className={styles.todoGroupHeader}>
                                                <button
                                                    type="button"
                                                    className={styles.todoGroupToggle}
                                                    onClick={() => toggleTodayTodoGroup(section.groupId)}
                                                >
                                                    {isCollapsed ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
                                                    <span>{section.title}</span>
                                                    <span className={styles.todoGroupCount}>{section.items.length}</span>
                                                </button>
                                                <button
                                                    type="button"
                                                    className={styles.todoDoneBtn}
                                                    onClick={() => handleUngroupTodayTodos(section.groupId)}
                                                >
                                                    묶기 해제
                                                </button>
                                            </div>
                                            {!isCollapsed && (
                                                <div className={styles.todoGroupItems}>
                                                    {section.items.map((item) => {
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
                                            )}
                                        </div>
                                    );
                                }

                                const item = section.item;
                                const done = item.status === 'completed';
                                const checked = selectedTodayTodoIds.includes(item.id);
                                return (
                                    <div
                                        key={item.id}
                                        className={`${styles.todoItem} ${styles.todoItemDraggable} ${draggingTodaySectionKey === section.key ? styles.todoSectionDragging : ''} ${dragOverTodaySectionKey === section.key && draggingTodaySectionKey !== section.key ? styles.todoSectionDropTarget : ''}`}
                                        draggable
                                        onDragStart={() => setDraggingTodaySectionKey(section.key)}
                                        onDragEnd={() => {
                                            setDraggingTodaySectionKey('');
                                            setDragOverTodaySectionKey('');
                                        }}
                                        onDragOver={(e) => {
                                            e.preventDefault();
                                            if (draggingTodaySectionKey && draggingTodaySectionKey !== section.key) {
                                                setDragOverTodaySectionKey(section.key);
                                            }
                                        }}
                                        onDragLeave={() => {
                                            if (dragOverTodaySectionKey === section.key) {
                                                setDragOverTodaySectionKey('');
                                            }
                                        }}
                                        onDrop={() => handleTodaySectionDrop(section)}
                                    >
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
                        {todayTodoSections.length > 0 && (
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

                <button
                    type="button"
                    className={styles.resizeHandle}
                    onMouseDown={startActivityResize}
                    onTouchStart={startActivityResize}
                    aria-label="받은 요청 너비 조절"
                >
                    <GripVertical size={16} />
                </button>

                <div className={`${styles.card} ${styles.activityPanelCard}`}>
                    <div className={styles.requestListHeader}>
                        <div className={styles.cardTitle} style={{ margin: 0 }}>
                            받은 요청
                            {orderedActivity.filter((a) => a.status !== 'completed').length > 0 && (
                                <span className={styles.requestCountBadge}>
                                    {orderedActivity.filter((a) => a.status !== 'completed').length}
                                </span>
                            )}
                        </div>
                        <div className={styles.requestHeaderActions}>
                            <button
                                className={`${styles.alertToggleBtn} ${requestAlertsEnabled ? styles.alertToggleBtnActive : ''}`}
                                type="button"
                                onClick={handleRequestAlertsToggle}
                            >
                                <Bell size={14} />
                                {requestAlertsEnabled ? '알림 켜짐' : '알림 받기'}
                            </button>
                            <button className={styles.clearBtn} type="button" onClick={handleClearActivity}>
                                지우기
                            </button>
                        </div>
                    </div>
                    <div ref={activityListRef} className={styles.requestList}>
                        {loadingActivity && <div className={styles.mutedText}>불러오는 중...</div>}
                        {!loadingActivity && activity.length === 0 && (
                            <div className={styles.emptyState}>
                                <div className={styles.emptyStateText}>받은 요청이 없습니다.</div>
                            </div>
                        )}
                        {!loadingActivity &&
                            orderedActivity.map((item) => {
                                const done = item.status === 'completed';
                                const pinned = pinnedRequestIds.includes(item.id);
                                return (
                                    <div
                                        key={item.id}
                                        className={`${styles.requestItem} ${done ? styles.requestItemDone : styles.requestItemPending} ${pinned ? styles.requestItemPinned : ''}`}
                                    >
                                        <div className={styles.requestItemInner}>
                                            <div className={styles.requestItemTop}>
                                                <span className={styles.requesterTag}>
                                                    {item.requester_display || item.requester_username}
                                                </span>
                                                {pinned && <span className={styles.pinnedBadge}>상단고정</span>}
                                                <span className={styles.requestTime}>{formatDateTime(item.created_at)}</span>
                                            </div>
                                            <div className={styles.requestText}>{item.text}</div>
                                            {renderAttachments(item)}
                                            {/* 댓글 토글 */}
                                            <button
                                                type="button"
                                                className={styles.commentToggleBtn}
                                                onClick={() => handleToggleComments(item.id)}
                                            >
                                                <MessageSquare size={11} />
                                                댓글
                                                {commentsCache[item.id]?.items?.length > 0 && (
                                                    <span className={styles.commentCount}>
                                                        {commentsCache[item.id].items.length}
                                                    </span>
                                                )}
                                                {expandedCommentIds.has(item.id)
                                                    ? <ChevronUp size={11} />
                                                    : <ChevronDown size={11} />}
                                            </button>
                                            {/* 댓글 스레드 */}
                                            {expandedCommentIds.has(item.id) && (
                                                <div className={styles.commentSection}>
                                                    {commentsCache[item.id]?.loading && (
                                                        <div className={styles.commentLoading}>불러오는 중...</div>
                                                    )}
                                                    {(commentsCache[item.id]?.items || []).map((c) => (
                                                        <div key={c.id} className={styles.commentItem}>
                                                            <div className={styles.commentMeta}>
                                                                <span className={styles.commentAuthor}>
                                                                    {c.author_display || c.author_username}
                                                                </span>
                                                                <span className={styles.commentTime}>
                                                                    {formatDateTime(c.created_at)}
                                                                </span>
                                                                {c.author_username === currentUser && (
                                                                    <button
                                                                        type="button"
                                                                        className={styles.commentDeleteBtn}
                                                                        onClick={() => handleDeleteComment(item.id, c.id)}
                                                                    >
                                                                        삭제
                                                                    </button>
                                                                )}
                                                            </div>
                                                            <div className={styles.commentText}>{c.text}</div>
                                                        </div>
                                                    ))}
                                                    {!commentsCache[item.id]?.loading &&
                                                        (commentsCache[item.id]?.items || []).length === 0 && (
                                                        <div className={styles.commentEmpty}>댓글이 없습니다.</div>
                                                    )}
                                                    <div className={styles.commentInputRow}>
                                                        <input
                                                            className={styles.commentInput}
                                                            placeholder="댓글 입력..."
                                                            value={commentsCache[item.id]?.input || ''}
                                                            onChange={(e) =>
                                                                setCommentsCache((prev) => ({
                                                                    ...prev,
                                                                    [item.id]: { ...getCommentState(item.id), ...prev[item.id], input: e.target.value },
                                                                }))
                                                            }
                                                            onKeyDown={(e) => {
                                                                if (e.key === 'Enter' && !e.shiftKey) {
                                                                    e.preventDefault();
                                                                    handleAddComment(item.id);
                                                                }
                                                            }}
                                                        />
                                                        <button
                                                            type="button"
                                                            className={styles.commentSubmitBtn}
                                                            onClick={() => handleAddComment(item.id)}
                                                            disabled={commentsCache[item.id]?.submitting}
                                                        >
                                                            등록
                                                        </button>
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                        <div className={styles.requestItemAction}>
                                            <button
                                                type="button"
                                                className={styles.pinBtn}
                                                onClick={() => togglePinnedRequest(item.id)}
                                            >
                                                {pinned ? <PinOff size={14} /> : <Pin size={14} />}
                                                {pinned ? '고정 해제' : '상단 고정'}
                                            </button>
                                            {done ? (
                                                <span className={styles.completedStatusBadge}>완료됨</span>
                                            ) : (
                                                <button
                                                    className={styles.completeBtn}
                                                    type="button"
                                                    disabled={!item.can_complete}
                                                    onClick={() => handleComplete(item.id)}
                                                >
                                                    완료
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
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
                                                {editingRequestId === item.id ? (
                                                    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                                                        <input
                                                            className={styles.credentialInput}
                                                            value={editingRequestText}
                                                            onChange={(e) => setEditingRequestText(e.target.value)}
                                                            onKeyDown={(e) => {
                                                                if (e.key === 'Enter') handleSaveEditRequest(item.id);
                                                                if (e.key === 'Escape') { setEditingRequestId(null); setEditingRequestText(''); }
                                                            }}
                                                            autoFocus
                                                            style={{ flex: 1 }}
                                                        />
                                                        <button className={styles.primaryBtn} type="button" onClick={() => handleSaveEditRequest(item.id)}>저장</button>
                                                        <button className={styles.secondaryBtn} type="button" onClick={() => { setEditingRequestId(null); setEditingRequestText(''); }}>취소</button>
                                                    </div>
                                                ) : (
                                                    <div className={styles.resolvedTitle}>{item.text}</div>
                                                )}
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
                                                    <>
                                                        <span className={styles.pendingBadge}>진행중</span>
                                                        {editingRequestId !== item.id && (
                                                            <>
                                                                <button
                                                                    className={styles.secondaryBtn}
                                                                    type="button"
                                                                    onClick={() => handleEditRequest(item)}
                                                                    style={{ marginLeft: '0.4rem' }}
                                                                >
                                                                    수정
                                                                </button>
                                                                <button
                                                                    className={styles.dangerBtn}
                                                                    type="button"
                                                                    onClick={() => handleDeleteRequest(item.id)}
                                                                    style={{ marginLeft: '0.25rem' }}
                                                                >
                                                                    삭제
                                                                </button>
                                                            </>
                                                        )}
                                                    </>
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
                <div className={styles.credSectionHeader}>
                    <div className={styles.cardTitle} style={{ margin: 0 }}>회사 계정 정보</div>
                    <div className={styles.credPinGroup}>
                        <span className={styles.credPinLabel}>공용 PIN</span>
                        <input
                            className={styles.credentialPin}
                            placeholder="••••"
                            value={companyPin}
                            onChange={(e) => setCompanyPin(e.target.value)}
                            maxLength={4}
                            type="password"
                        />
                    </div>
                </div>
                {loadingCreds && <div className={styles.mutedText}>불러오는 중...</div>}
                {!loadingCreds && (
                    <>
                        {isAdmin && (
                            <div className={styles.credAddCard}>
                                <div className={styles.credAddTitle}>새 항목 추가</div>
                                <div className={styles.credAddFields}>
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
                                    <button type="button" className={styles.primaryBtn} onClick={handleCredentialsCreate}>
                                        추가
                                    </button>
                                </div>
                            </div>
                        )}
                        {companyCreds.length === 0 ? (
                            <div className={styles.emptyState}>
                                <div className={styles.emptyStateText}>등록된 항목이 없습니다.</div>
                            </div>
                        ) : (
                            <div className={styles.credGrid}>
                                {companyCreds.map((item) => (
                                    <div key={item.id} className={styles.credCard}>
                                        {isAdmin ? (
                                            <>
                                                <input
                                                    className={styles.credCardLabelInput}
                                                    placeholder="항목명"
                                                    value={(credEdit[item.id]?.label ?? item.label ?? '')}
                                                    onChange={(e) => updateCredEdit(item.id, { label: e.target.value })}
                                                />
                                                <div className={styles.credFieldRow}>
                                                    <span className={styles.credFieldLabel}>ID</span>
                                                    <input
                                                        className={styles.credFieldInput}
                                                        placeholder="아이디"
                                                        value={(credEdit[item.id]?.username ?? item.username ?? '')}
                                                        onChange={(e) => updateCredEdit(item.id, { username: e.target.value })}
                                                    />
                                                </div>
                                                <div className={styles.credFieldRow}>
                                                    <span className={styles.credFieldLabel}>PW</span>
                                                    <input
                                                        className={styles.credFieldInput}
                                                        placeholder="비밀번호"
                                                        value={(credEdit[item.id]?.password ?? item.password ?? '')}
                                                        onChange={(e) => updateCredEdit(item.id, { password: e.target.value })}
                                                    />
                                                </div>
                                                <div className={styles.credCardActions}>
                                                    <button
                                                        type="button"
                                                        className={styles.credSaveBtn}
                                                        onClick={() => handleCredentialsSave(item)}
                                                    >
                                                        저장
                                                    </button>
                                                    <button
                                                        type="button"
                                                        className={styles.credViewBtn}
                                                        onClick={() => handleCredentialsView(item.id)}
                                                    >
                                                        보기
                                                    </button>
                                                    <button
                                                        type="button"
                                                        className={styles.credDeleteBtn}
                                                        onClick={() => handleCredentialsDelete(item.id)}
                                                    >
                                                        삭제
                                                    </button>
                                                </div>
                                            </>
                                        ) : (
                                            <>
                                                <div className={styles.credCardName}>{item.label}</div>
                                                {credView[item.id] ? (
                                                    <div className={styles.credRevealedFields}>
                                                        <div className={styles.credFieldRow}>
                                                            <span className={styles.credFieldLabel}>ID</span>
                                                            <span className={styles.credFieldValue}>{credView[item.id].username || '-'}</span>
                                                        </div>
                                                        <div className={styles.credFieldRow}>
                                                            <span className={styles.credFieldLabel}>PW</span>
                                                            <span className={styles.credFieldValue}>{credView[item.id].password || '-'}</span>
                                                        </div>
                                                    </div>
                                                ) : (
                                                    <div className={styles.credHidden}>•••••••••</div>
                                                )}
                                                <button
                                                    type="button"
                                                    className={styles.credViewBtn}
                                                    onClick={() => {
                                                        if (credView[item.id]) {
                                                            setCredView((prev) => { const n = {...prev}; delete n[item.id]; return n; });
                                                        } else {
                                                            handleCredentialsView(item.id);
                                                        }
                                                    }}
                                                >
                                                    {credView[item.id] ? '숨기기' : '보기'}
                                                </button>
                                            </>
                                        )}
                                    </div>
                                ))}
                            </div>
                        )}
                    </>
                )}
            </div>
            {previewImage && (
                <div
                    className={styles.previewOverlay}
                    onClick={() => closePreview()}
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
                                    onClick={() => closePreview()}
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
