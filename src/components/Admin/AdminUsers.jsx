import React, { useEffect, useMemo, useState } from 'react';
import styles from './AdminUsers.module.css';
import { COLLAB_API_BASE as API } from '../../lib/api';

const AdminUsers = ({ currentUser }) => {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [workingUser, setWorkingUser] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [filter, setFilter] = useState('all');

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
      setLoading(true);
      setError('');
      const res = await fetch(`${API}/admin/users`, { headers: authHeaders });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || 'Failed to load users');
      setUsers(data?.users || []);
    } catch (err) {
      setError(err.message || 'Failed to load users');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUsers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const adminCount = users.filter((u) => u.role === 'admin').length;
  const pendingCount = users.filter((u) => (u.approval_status || 'approved') === 'pending').length;
  const approvedCount = users.filter((u) => (u.approval_status || 'approved') === 'approved').length;
  const rejectedCount = users.filter((u) => (u.approval_status || 'approved') === 'rejected').length;
  const visibleUsers = users.filter((user) => {
    if (filter === 'pending') return (user.approval_status || 'approved') === 'pending';
    if (filter === 'approved') return (user.approval_status || 'approved') === 'approved';
    if (filter === 'rejected') return (user.approval_status || 'approved') === 'rejected';
    return true;
  });

  const handleApprovalChange = async (username, approvalStatus) => {
    const actionLabel =
      approvalStatus === 'approved' ? '승인' : approvalStatus === 'rejected' ? '거절' : '보류';
    if (!window.confirm(`${username} 계정을 ${actionLabel} 처리할까요?`)) return;
    try {
      setWorkingUser(username);
      setError('');
      setMessage('');
      const res = await fetch(`${API}/admin/users/${encodeURIComponent(username)}/approval`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ approval_status: approvalStatus }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || 'Failed to update approval');
      setMessage(`${username} 계정이 ${actionLabel} 처리되었습니다.`);
      await fetchUsers();
    } catch (err) {
      setError(err.message || 'Failed to update approval');
    } finally {
      setWorkingUser('');
    }
  };

  const handleRoleChange = async (username, role) => {
    if (username === currentUser) {
      setError('You cannot change your own role.');
      return;
    }
    const label = role === 'admin' ? 'promote to admin' : 'remove admin role';
    if (!window.confirm(`Are you sure you want to ${label} for ${username}?`)) return;
    try {
      setWorkingUser(username);
      setError('');
      setMessage('');
      const res = await fetch(`${API}/admin/users/${encodeURIComponent(username)}/role`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ role }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || 'Failed to update role');
      setMessage(`${username} role updated to ${role}.`);
      await fetchUsers();
    } catch (err) {
      setError(err.message || 'Failed to update role');
    } finally {
      setWorkingUser('');
    }
  };

  const handleDelete = async (username) => {
    if (username === currentUser) {
      setError('You cannot delete your own account.');
      return;
    }
    if (!window.confirm(`Delete account for ${username}? This cannot be undone.`)) return;
    try {
      setWorkingUser(username);
      setError('');
      setMessage('');
      const res = await fetch(`${API}/admin/users/${encodeURIComponent(username)}`, {
        method: 'DELETE',
        headers: authHeaders,
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || 'Failed to delete user');
      setMessage(`${username} deleted.`);
      await fetchUsers();
    } catch (err) {
      setError(err.message || 'Failed to delete user');
    } finally {
      setWorkingUser('');
    }
  };

  return (
    <section className={styles.admin}>
      <div className={styles.headerRow}>
        <h1 className={styles.title}>Admin Users</h1>
        <button className={styles.secondaryBtn} onClick={fetchUsers} disabled={loading}>
          Refresh
        </button>
      </div>

      {(error || message) && (
        <div className={error ? styles.errorText : styles.successText}>
          {error || message}
        </div>
      )}

      <div className={styles.summaryGrid}>
        <button
          type="button"
          className={`${styles.summaryCard} ${filter === 'pending' ? styles.summaryCardActive : ''}`}
          onClick={() => setFilter('pending')}
        >
          <span className={styles.summaryLabel}>승인 대기</span>
          <strong className={styles.summaryValue}>{pendingCount}</strong>
        </button>
        <button
          type="button"
          className={`${styles.summaryCard} ${filter === 'approved' ? styles.summaryCardActive : ''}`}
          onClick={() => setFilter('approved')}
        >
          <span className={styles.summaryLabel}>승인 완료</span>
          <strong className={styles.summaryValue}>{approvedCount}</strong>
        </button>
        <button
          type="button"
          className={`${styles.summaryCard} ${filter === 'rejected' ? styles.summaryCardActive : ''}`}
          onClick={() => setFilter('rejected')}
        >
          <span className={styles.summaryLabel}>거절됨</span>
          <strong className={styles.summaryValue}>{rejectedCount}</strong>
        </button>
        <button
          type="button"
          className={`${styles.summaryCard} ${filter === 'all' ? styles.summaryCardActive : ''}`}
          onClick={() => setFilter('all')}
        >
          <span className={styles.summaryLabel}>전체 계정</span>
          <strong className={styles.summaryValue}>{users.length}</strong>
        </button>
      </div>

      <div className={styles.card}>
        {loading && <div className={styles.mutedText}>Loading users...</div>}
        {!loading && users.length === 0 && <div className={styles.mutedText}>No users found.</div>}
        {!loading && users.length > 0 && (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Name</th>
                <th>Username</th>
                <th>Role</th>
                <th>Approval</th>
                <th>Created</th>
                <th className={styles.actionsCol}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {visibleUsers.map((user) => {
                const isSelf = user.username === currentUser;
                const isWorking = workingUser === user.username;
                const canDemote = user.role === 'admin' && adminCount > 1;
                const approvalStatus = user.approval_status || 'approved';
                return (
                  <tr key={user.username}>
                    <td>{user.display_name || user.username}</td>
                    <td>{user.username}</td>
                    <td>
                      <span
                        className={`${styles.roleBadge} ${
                          user.role === 'admin' ? styles.roleAdmin : styles.roleUser
                        }`}
                      >
                        {user.role}
                      </span>
                    </td>
                    <td>
                      <span
                        className={`${styles.roleBadge} ${
                          approvalStatus === 'approved'
                            ? styles.statusApproved
                            : approvalStatus === 'pending'
                              ? styles.statusPending
                              : styles.statusRejected
                        }`}
                      >
                        {approvalStatus}
                      </span>
                    </td>
                    <td>{user.created_at || '-'}</td>
                    <td className={styles.actionsCol}>
                      {approvalStatus !== 'approved' && (
                        <button
                          className={styles.primaryBtn}
                          type="button"
                          disabled={isWorking}
                          onClick={() => handleApprovalChange(user.username, 'approved')}
                        >
                          승인
                        </button>
                      )}
                      {approvalStatus !== 'rejected' && (
                        <button
                          className={styles.secondaryBtn}
                          type="button"
                          disabled={isWorking}
                          onClick={() => handleApprovalChange(user.username, 'rejected')}
                        >
                          거절
                        </button>
                      )}
                      {user.role === 'admin' ? (
                        <button
                          className={styles.secondaryBtn}
                          type="button"
                          disabled={isSelf || isWorking || !canDemote}
                          onClick={() => handleRoleChange(user.username, 'user')}
                        >
                          Remove Admin
                        </button>
                      ) : (
                        <button
                          className={styles.primaryBtn}
                          type="button"
                          disabled={isSelf || isWorking}
                          onClick={() => handleRoleChange(user.username, 'admin')}
                        >
                          Make Admin
                        </button>
                      )}
                      <button
                        className={styles.dangerBtn}
                        type="button"
                        disabled={isSelf || isWorking}
                        onClick={() => handleDelete(user.username)}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {!loading && users.length > 0 && visibleUsers.length === 0 && (
          <div className={styles.mutedText}>선택한 조건에 맞는 계정이 없습니다.</div>
        )}
      </div>
    </section>
  );
};

export default AdminUsers;
