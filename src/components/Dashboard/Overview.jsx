import React, { useEffect, useMemo, useState } from 'react';
import { Plus, Calendar, Bell } from 'lucide-react';
import styles from './Dashboard.module.css';

const Overview = ({ currentUser }) => {
    const API = `http://${window.location.hostname}:8000`;
    const stats = [
        { title: 'Total Revenue', value: '$45,231.89', change: '+20.1%', status: 'up' },
        { title: 'Subscriptions', value: '+2,350', change: '+180.1%', status: 'up' },
        { title: 'Active Now', value: '573', change: '+201', status: 'up' },
        { title: 'Total Users', value: '+12,234', change: '+19.2%', status: 'up' },
    ];

    const [users, setUsers] = useState([]);
    const [assignee, setAssignee] = useState('');
    const [requestText, setRequestText] = useState('');
    const [activity, setActivity] = useState([]);
    const [resolved, setResolved] = useState([]);
    const [loadingUsers, setLoadingUsers] = useState(true);
    const [loadingActivity, setLoadingActivity] = useState(false);
    const [loadingResolved, setLoadingResolved] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState('');

    const authHeaders = useMemo(() => {
        const token = localStorage.getItem('token');
        return token ? { Authorization: `Bearer ${token}` } : {};
    }, []);

    const handleUnauthorized = (res) => {
        if (res.status === 401) {
            localStorage.removeItem('token');
            localStorage.removeItem('displayName');
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
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        fetchActivity();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentUser]);

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError('');
        if (!assignee || !requestText.trim()) {
            setError('Please select a user and enter a request.');
            return;
        }
        try {
            setSubmitting(true);
            const res = await fetch(`${API}/requests`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders },
                body: JSON.stringify({ assignee, text: requestText.trim() }),
            });
            if (handleUnauthorized(res)) return;
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.detail || 'Failed to send request');
            setRequestText('');
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

    return (
        <section className={styles.dashboard}>
            <div className={styles.headerRow}>
                <h1 className={styles.title}>Overview</h1>
                <button className={styles.downloadBtn}>
                    <Plus size={18} />
                    Download Report
                </button>
            </div>

            <div className={styles.statsGrid}>
                {stats.map((stat, i) => (
                    <div key={i} className={styles.statCard}>
                        <div className={styles.statTitle}>{stat.title}</div>
                        <div className={styles.statValue}>
                            {stat.value}
                            <span className={`${styles.statChange} ${styles[stat.status]}`}>
                                {stat.change}
                            </span>
                        </div>
                    </div>
                ))}
            </div>

            <div className={styles.contentGrid}>
                <div className={styles.card}>
                    <div className={styles.cardTitle}>
                        Request a Task
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
                                placeholder="요청 내용을 입력하세요."
                            />
                        </label>
                        {error && <div className={styles.errorText}>{error}</div>}
                        <button className={styles.primaryBtn} type="submit" disabled={submitting}>
                            {submitting ? 'Sending...' : 'Send Request'}
                        </button>
                    </form>
                </div>

                <div className={styles.card}>
                    <div className={styles.cardTitle}>
                        Activity Log
                        <Calendar size={18} className={styles.cardHeaderIcon} />
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
                                        <div>{item.text}</div>
                                        <div>
                                            {item.requester_display || item.requester_username}
                                        </div>
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
                    <div className={styles.cardTitle}>
                        Request Resolved
                        <Bell size={18} className={styles.cardHeaderIcon} />
                    </div>
                    <div className={styles.resolvedList}>
                        {loadingResolved && <div className={styles.mutedText}>Loading resolved...</div>}
                        {!loadingResolved && resolved.length === 0 && (
                            <div className={styles.mutedText}>No resolved requests.</div>
                        )}
                        {!loadingResolved &&
                            resolved.map((item) => (
                                <div key={item.id} className={styles.resolvedItem}>
                                    <div className={styles.resolvedInfo}>
                                        <div className={styles.resolvedTitle}>{item.text}</div>
                                        <div className={styles.resolvedMeta}>
                                            {item.assignee_display || item.assignee_username} completed
                                        </div>
                                    </div>
                                    <div className={styles.resolvedActions}>
                                        <span className={styles.newBadge}>NEW</span>
                                        <button
                                            className={styles.secondaryBtn}
                                            type="button"
                                            onClick={() => handleAck(item.id)}
                                        >
                                            확인
                                        </button>
                                    </div>
                                </div>
                            ))}
                    </div>
                </div>
            </div>
        </section>
    );
};

export default Overview;
