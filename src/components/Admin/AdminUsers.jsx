import React, { useEffect, useState } from 'react';
import styles from './AdminUsers.module.css';
import { COLLAB_API_BASE as API, getAuthHeaders, handleUnauthorized } from '../../lib/api';

const CLIENT_SCHEDULE_MENU_TAB = { key: 'client-schedule', label: '거래처 일정' };

const ALL_MENU_TABS = [
  { key: 'dashboard', label: '대시보드' },
  { key: 'barcode', label: '바코드' },
  { key: 'returns', label: '반품' },
  { key: 'barcode-product-upload', label: '상품 업로드' },
  { key: 'shared-files', label: '유색 공용 파일' },
  { key: 'noye-kimsungil', label: '노예김승일' },
  { key: 'sms', label: '문자 발송' },
];

const AdminUsers = ({ currentUser }) => {
  const [users, setUsers] = useState([]);
  const [phoneDrafts, setPhoneDrafts] = useState({});
  const [loading, setLoading] = useState(true);
  const [smsSettingsLoading, setSmsSettingsLoading] = useState(true);
  const [smsSettingsSaving, setSmsSettingsSaving] = useState(false);
  const [requestSmsEnabled, setRequestSmsEnabled] = useState(true);
  const [requestSmsReceiver, setRequestSmsReceiver] = useState('01095806927');
  const [requestSmsStart, setRequestSmsStart] = useState('');
  const [requestSmsEnd, setRequestSmsEnd] = useState('');
  const [workingUser, setWorkingUser] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [filter, setFilter] = useState('all');
  const [menuPanel, setMenuPanel] = useState(null); // { username, hiddenTabs }
  const [menuSaving, setMenuSaving] = useState(false);

  const authHeaders = getAuthHeaders();

  const fetchUsers = async () => {
    try {
      setLoading(true);
      setError('');
      const res = await fetch(`${API}/admin/users`, { headers: authHeaders });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || 'Failed to load users');
      const nextUsers = data?.users || [];
      setUsers(nextUsers);
      setPhoneDrafts(Object.fromEntries(nextUsers.map((user) => [user.username, user.phone_number || ''])));
    } catch (err) {
      setError(err.message || 'Failed to load users');
    } finally {
      setLoading(false);
    }
  };

  const fetchRequestSmsSettings = async () => {
    try {
      setSmsSettingsLoading(true);
      const res = await fetch(`${API}/admin/request-sms-settings`, { headers: authHeaders });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || 'Failed to load request SMS settings');
      setRequestSmsEnabled(Boolean(data?.enabled));
      setRequestSmsReceiver(data?.receiver || '01095806927');
      setRequestSmsStart(data?.start || '');
      setRequestSmsEnd(data?.end || '');
    } catch (err) {
      setError(err.message || 'Failed to load request SMS settings');
    } finally {
      setSmsSettingsLoading(false);
    }
  };

  useEffect(() => {
    fetchUsers();
    fetchRequestSmsSettings();
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
      setError('본인 계정의 권한은 변경할 수 없습니다.');
      return;
    }
    const label = role === 'admin' ? '관리자로 승격' : role === 'viewer' ? '배포용으로 변경' : '일반 유저로 변경';
    if (!window.confirm(`${username} 계정을 ${label}할까요?`)) return;
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
      setMessage(`${username} 권한이 변경되었습니다.`);
      await fetchUsers();
    } catch (err) {
      setError(err.message || 'Failed to update role');
    } finally {
      setWorkingUser('');
    }
  };

  const openMenuPanel = async (username) => {
    if (menuPanel?.username === username) {
      setMenuPanel(null);
      return;
    }
    try {
      const res = await fetch(`${API}/admin/users/${encodeURIComponent(username)}/menu-visibility`, {
        headers: authHeaders,
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      setMenuPanel({ username, hiddenTabs: data.hidden_tabs || [] });
    } catch {
      setError('메뉴 설정을 불러오지 못했습니다.');
    }
  };

  const toggleMenuTab = (tab) => {
    if (!menuPanel) return;
    const hidden = menuPanel.hiddenTabs;
    setMenuPanel({
      ...menuPanel,
      hiddenTabs: hidden.includes(tab) ? hidden.filter((t) => t !== tab) : [...hidden, tab],
    });
  };

  const saveMenuPanel = async () => {
    if (!menuPanel) return;
    setMenuSaving(true);
    try {
      const res = await fetch(`${API}/admin/users/${encodeURIComponent(menuPanel.username)}/menu-visibility`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ hidden_tabs: menuPanel.hiddenTabs }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || '저장 실패');
      setMenuPanel({ ...menuPanel, hiddenTabs: data.hidden_tabs });
      setMessage(`${menuPanel.username} 메뉴 설정 저장 완료`);
    } catch (err) {
      setError(err.message || '저장 실패');
    } finally {
      setMenuSaving(false);
    }
  };

  const handleDelete = async (username) => {
    if (username === currentUser) {
      setError('본인 계정은 삭제할 수 없습니다.');
      return;
    }
    if (!window.confirm(`${username} 계정을 삭제할까요? 이 작업은 되돌릴 수 없습니다.`)) return;
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
      setMessage(`${username} 계정이 삭제되었습니다.`);
      await fetchUsers();
    } catch (err) {
      setError(err.message || 'Failed to delete user');
    } finally {
      setWorkingUser('');
    }
  };

  const handlePhoneDraftChange = (username, value) => {
    setPhoneDrafts((prev) => ({
      ...prev,
      [username]: value.replace(/[^0-9]/g, ''),
    }));
  };

  const savePhoneNumber = async (username) => {
    try {
      setWorkingUser(username);
      setError('');
      setMessage('');
      const res = await fetch(`${API}/admin/users/${encodeURIComponent(username)}/phone-number`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ phone_number: phoneDrafts[username] || '' }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || 'Failed to save phone number');
      setUsers((prev) => prev.map((user) => (
        user.username === username
          ? { ...user, phone_number: data.phone_number || '' }
          : user
      )));
      setPhoneDrafts((prev) => ({ ...prev, [username]: data.phone_number || '' }));
      setMessage(`${username} 전화번호가 저장되었습니다.`);
    } catch (err) {
      setError(err.message || 'Failed to save phone number');
    } finally {
      setWorkingUser('');
    }
  };

  const saveRequestSmsSettings = async () => {
    try {
      setSmsSettingsSaving(true);
      setError('');
      setMessage('');
      const res = await fetch(`${API}/admin/request-sms-settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({
          enabled: requestSmsEnabled,
          receiver: requestSmsReceiver,
          start: requestSmsStart,
          end: requestSmsEnd,
        }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || 'Failed to save request SMS settings');
      setRequestSmsEnabled(Boolean(data?.enabled));
      setRequestSmsReceiver(data?.receiver || '01095806927');
      setRequestSmsStart(data?.start || '');
      setRequestSmsEnd(data?.end || '');
      setMessage('요청 SMS 설정이 저장되었습니다.');
    } catch (err) {
      setError(err.message || 'Failed to save request SMS settings');
    } finally {
      setSmsSettingsSaving(false);
    }
  };

  return (
    <section className={styles.admin}>
      <div className={styles.headerRow}>
        <h1 className={styles.title}>사용자 관리</h1>
        <button className={styles.secondaryBtn} onClick={fetchUsers} disabled={loading}>
          새로고침
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
        <div className={styles.settingsHeader}>
          <div>
            <h2 className={styles.sectionTitle}>요청 SMS 알림</h2>
            <p className={styles.mutedText}>수신자 전화번호 우선 발송, 없으면 기본 번호로 대체</p>
          </div>
          <button
            className={styles.secondaryBtn}
            type="button"
            onClick={fetchRequestSmsSettings}
            disabled={smsSettingsLoading || smsSettingsSaving}
          >
            새로고침
          </button>
        </div>
        {smsSettingsLoading ? (
          <div className={styles.mutedText}>설정을 불러오는 중...</div>
        ) : (
          <div className={styles.smsSettingsGrid}>
            <label className={styles.fieldBlock}>
              <span className={styles.fieldLabel}>발송 사용</span>
              <input
                type="checkbox"
                checked={requestSmsEnabled}
                onChange={(e) => setRequestSmsEnabled(e.target.checked)}
              />
            </label>
            <label className={styles.fieldBlock}>
              <span className={styles.fieldLabel}>기본 수신 번호</span>
              <input
                className={styles.textInput}
                value={requestSmsReceiver}
                onChange={(e) => setRequestSmsReceiver(e.target.value)}
                placeholder="01095806927"
              />
            </label>
            <label className={styles.fieldBlock}>
              <span className={styles.fieldLabel}>발송 시작</span>
              <input
                className={styles.textInput}
                type="time"
                value={requestSmsStart}
                onChange={(e) => setRequestSmsStart(e.target.value)}
              />
            </label>
            <label className={styles.fieldBlock}>
              <span className={styles.fieldLabel}>발송 종료</span>
              <input
                className={styles.textInput}
                type="time"
                value={requestSmsEnd}
                onChange={(e) => setRequestSmsEnd(e.target.value)}
              />
            </label>
          </div>
        )}
        <div className={styles.settingsActions}>
          <button
            className={styles.primaryBtn}
            type="button"
            onClick={saveRequestSmsSettings}
            disabled={smsSettingsLoading || smsSettingsSaving}
          >
            {smsSettingsSaving ? '저장 중...' : '저장'}
          </button>
          <span className={styles.mutedText}>
            사용자별 전화번호는 아래 표에서 저장하고, 기본 수신 번호는 대체용으로만 사용됩니다.
          </span>
        </div>
      </div>

      <div className={styles.card}>
        {loading && <div className={styles.mutedText}>불러오는 중...</div>}
        {!loading && users.length === 0 && <div className={styles.mutedText}>등록된 계정이 없습니다.</div>}
        {!loading && users.length > 0 && (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>이름</th>
                <th>아이디</th>
                <th>전화번호</th>
                <th>권한</th>
                <th>승인</th>
                <th>가입일</th>
                <th className={styles.actionsCol}>관리</th>
              </tr>
            </thead>
            <tbody>
              {visibleUsers.map((user) => {
                const isSelf = user.username === currentUser;
                const isWorking = workingUser === user.username;
                const canDemote = user.role === 'admin' && adminCount > 1;
                const approvalStatus = user.approval_status || 'approved';
                return (
                  <React.Fragment key={user.username}>
                  <tr>
                    <td>{user.display_name || user.username}</td>
                    <td>{user.username}</td>
                    <td>
                      <div className={styles.phoneEditor}>
                        <input
                          className={styles.phoneInput}
                          value={phoneDrafts[user.username] || ''}
                          onChange={(e) => handlePhoneDraftChange(user.username, e.target.value)}
                          placeholder="01012345678"
                        />
                        <button
                          className={styles.secondaryBtn}
                          type="button"
                          disabled={isWorking}
                          onClick={() => savePhoneNumber(user.username)}
                        >
                          저장
                        </button>
                      </div>
                    </td>
                    <td>
                      <span
                        className={`${styles.roleBadge} ${
                          user.role === 'admin' ? styles.roleAdmin
                          : user.role === 'viewer' ? styles.roleViewer
                          : styles.roleUser
                        }`}
                      >
                        {user.role === 'admin' ? '관리자' : user.role === 'viewer' ? '배포용' : '유저'}
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
                        {approvalStatus === 'approved' ? '승인' : approvalStatus === 'pending' ? '대기' : '거절'}
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
                          관리자 해제
                        </button>
                      ) : user.role === 'viewer' ? (
                        <>
                          <button
                            className={styles.primaryBtn}
                            type="button"
                            disabled={isSelf || isWorking}
                            onClick={() => handleRoleChange(user.username, 'user')}
                          >
                            일반 유저로
                          </button>
                          <button
                            className={styles.primaryBtn}
                            type="button"
                            disabled={isSelf || isWorking}
                            onClick={() => handleRoleChange(user.username, 'admin')}
                          >
                            관리자로
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            className={styles.primaryBtn}
                            type="button"
                            disabled={isSelf || isWorking}
                            onClick={() => handleRoleChange(user.username, 'admin')}
                          >
                            관리자로
                          </button>
                          <button
                            className={styles.secondaryBtn}
                            type="button"
                            disabled={isSelf || isWorking}
                            onClick={() => handleRoleChange(user.username, 'viewer')}
                          >
                            배포용으로
                          </button>
                        </>
                      )}
                      <button
                        className={styles.secondaryBtn}
                        type="button"
                        disabled={isWorking}
                        onClick={() => openMenuPanel(user.username)}
                      >
                        메뉴
                      </button>
                      <button
                        className={styles.dangerBtn}
                        type="button"
                        disabled={isSelf || isWorking}
                        onClick={() => handleDelete(user.username)}
                      >
                        삭제
                      </button>
                    </td>
                  </tr>
                  {menuPanel?.username === user.username && (
                    <tr>
                      <td colSpan={7} className={styles.menuPanelCell}>
                        <div className={styles.menuPanel}>
                          <span className={styles.menuPanelTitle}>메뉴 표시 설정 — {user.display_name || user.username}</span>
                          <div className={styles.menuPanelGrid}>
                            {[...ALL_MENU_TABS, CLIENT_SCHEDULE_MENU_TAB].map((tab) => {
                              const isShown = !menuPanel.hiddenTabs.includes(tab.key);
                              return (
                                <button
                                  key={tab.key}
                                  type="button"
                                  className={`${styles.menuToggleBtn} ${isShown ? styles.menuToggleOn : styles.menuToggleOff}`}
                                  onClick={() => toggleMenuTab(tab.key)}
                                >
                                  {tab.label}
                                  <span className={styles.menuToggleDot} />
                                </button>
                              );
                            })}
                          </div>
                          <button
                            className={styles.primaryBtn}
                            type="button"
                            disabled={menuSaving}
                            onClick={saveMenuPanel}
                          >
                            {menuSaving ? '저장 중...' : '저장'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        )}
        {!loading && users.length > 0 && visibleUsers.length === 0 && (
          <div className={styles.mutedText}>해당 조건의 계정이 없습니다.</div>
        )}
      </div>
    </section>
  );
};

export default AdminUsers;
