import React, { useEffect, useMemo, useState } from 'react';
import styles from './AdminUsers.module.css';

const API = `http://${window.location.hostname}:8000`;

const AdminUsers = ({ currentUser }) => {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [workingUser, setWorkingUser] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

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
                <th>Created</th>
                <th className={styles.actionsCol}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => {
                const isSelf = user.username === currentUser;
                const isWorking = workingUser === user.username;
                const canDemote = user.role === 'admin' && adminCount > 1;
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
                    <td>{user.created_at || '-'}</td>
                    <td className={styles.actionsCol}>
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
      </div>
    </section>
  );
};

export default AdminUsers;
