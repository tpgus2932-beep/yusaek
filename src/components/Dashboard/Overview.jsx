import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Plus, Calendar, Bell, ChevronDown, ChevronUp, Pin, PinOff, GripVertical, MessageSquare } from 'lucide-react';
import styles from './Dashboard.module.css';
import { COLLAB_API_BASE as API, LOCAL_API_BASE, getAuthHeaders, handleUnauthorized } from '../../lib/api';
import DeliveryAnomalyCard from './DeliveryAnomalyCard';
import ExchangeReturnAnomalyCard from './ExchangeReturnAnomalyCard';
import ReturnAnomalyCard from './ReturnAnomalyCard';
import DailyChecklistCard from './DailyChecklistCard';
import EquipmentCard from './EquipmentCard';
import DevUpdateCard from './DevUpdateCard';
import DevRequestCard from './DevRequestCard';

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
    const [loadingUsers, setLoadingUsers] = useState(true);
    const [loadingActivity, setLoadingActivity] = useState(true);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState('');
    const [previewImage, setPreviewImage] = useState(null);
    const [previewScale, setPreviewScale] = useState(1);
    const [companyCreds, setCompanyCreds] = useState([]);
    const [loadingCreds, setLoadingCreds] = useState(false);
    const [credView, setCredView] = useState({});
    const [credEdit, setCredEdit] = useState({});
    const [companyPin, setCompanyPin] = useState('');
    const [activityPanelWidth, setActivityPanelWidth] = useState(420);
    const [dashboardLayoutLoaded, setDashboardLayoutLoaded] = useState(false);
    const [pinnedRequestIds, setPinnedRequestIds] = useState([]);
    const [pinnedRequestsLoaded, setPinnedRequestsLoaded] = useState(false);
    const [requestAlertsEnabled, setRequestAlertsEnabled] = useState(false);
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

    const authHeaders = getAuthHeaders();
    const currentUserPhone = useMemo(() => {
        const fromAuth = String(authPhoneNumber || '').replace(/[^0-9]/g, '');
        if (fromAuth) return fromAuth;
        return String(localStorage.getItem('phoneNumber') || '').replace(/[^0-9]/g, '');
    }, [authPhoneNumber]);

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

    useEffect(() => {
        fetchUsers();
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
            if (data?.request && data.request.assignee_username === (currentUser || localStorage.getItem('username'))) {
                setActivity((prev) => [data.request, ...prev.filter((item) => item.id !== data.request.id)]);
            }
            setRequestText('');
            setRequestFiles([]);
            if (fileInputRef.current) fileInputRef.current.value = '';
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
        } catch (err) {
            setError(err.message || 'Failed to complete');
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

    return (
        <section className={styles.dashboard}>
            <div className={styles.headerRow}>
                <h1 className={styles.title}>대시보드</h1>
            </div>

            <DevUpdateCard />

            <div
                className={styles.contentGrid}
                style={{ '--activity-panel-width': `${activityPanelWidth}px` }}
            >
                <div className={styles.contentColumn}>
                    <DevRequestCard />

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

            <DeliveryAnomalyCard />

            <ExchangeReturnAnomalyCard />

            <ReturnAnomalyCard />

            <DailyChecklistCard />

            <EquipmentCard />

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
