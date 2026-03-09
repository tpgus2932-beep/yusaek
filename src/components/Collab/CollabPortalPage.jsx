import { useEffect, useMemo, useRef, useState } from 'react';
import styles from './CollabPortalPage.module.css';
import { COLLAB_API_BASE as API } from '../../lib/api';

export default function CollabPortalPage({ currentUser, displayName, onLogout }) {
  const [users, setUsers] = useState([]);
  const [assignee, setAssignee] = useState('');
  const [requestText, setRequestText] = useState('');
  const [requestFiles, setRequestFiles] = useState([]);
  const [inbox, setInbox] = useState([]);
  const [outbox, setOutbox] = useState([]);
  const [todos, setTodos] = useState([]);
  const [todoText, setTodoText] = useState('');
  const [todoComment, setTodoComment] = useState('');
  const [todoCommentId, setTodoCommentId] = useState(null);
  const [todoTab, setTodoTab] = useState('open');
  const [sentFilter, setSentFilter] = useState('all');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [savingTodo, setSavingTodo] = useState(false);
  const fileInputRef = useRef(null);

  const authHeaders = useMemo(() => {
    const token = localStorage.getItem('token');
    return token ? { Authorization: `Bearer ${token}` } : {};
  }, []);

  const handleAuthFailure = (res) => {
    if (res.status === 401 || res.status === 403) {
      onLogout();
      return true;
    }
    return false;
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

  const formatFileSize = (bytes) => {
    if (!bytes && bytes !== 0) return '';
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  };

  const fileUrl = (file) => {
    const token = localStorage.getItem('token');
    const suffix = token ? `?token=${encodeURIComponent(token)}` : '';
    return `${API}${file.url}${suffix}`;
  };

  const loadPortalData = async () => {
    try {
      setLoading(true);
      setError('');
      const [usersRes, inboxRes, outboxRes, todosRes] = await Promise.all([
        fetch(`${API}/users`, { headers: authHeaders }),
        fetch(`${API}/requests/assigned`, { headers: authHeaders }),
        fetch(`${API}/requests/resolved`, { headers: authHeaders }),
        fetch(`${API}/shared-todos`, { headers: authHeaders }),
      ]);
      if ([usersRes, inboxRes, outboxRes, todosRes].some(handleAuthFailure)) return;
      const [usersData, inboxData, outboxData, todosData] = await Promise.all([
        usersRes.json().catch(() => ({})),
        inboxRes.json().catch(() => ({})),
        outboxRes.json().catch(() => ({})),
        todosRes.json().catch(() => ({})),
      ]);
      if (!usersRes.ok) throw new Error(usersData?.detail || '사용자 목록을 불러오지 못했습니다.');
      if (!inboxRes.ok) throw new Error(inboxData?.detail || '받은 요청을 불러오지 못했습니다.');
      if (!outboxRes.ok) throw new Error(outboxData?.detail || '보낸 요청을 불러오지 못했습니다.');
      if (!todosRes.ok) throw new Error(todosData?.detail || '공동 할 일을 불러오지 못했습니다.');
      const nextUsers = Array.isArray(usersData?.users) ? usersData.users : [];
      setUsers(nextUsers);
      setInbox(Array.isArray(inboxData?.requests) ? inboxData.requests : []);
      setOutbox(Array.isArray(outboxData?.requests) ? outboxData.requests : []);
      setTodos(Array.isArray(todosData?.todos) ? todosData.todos : []);
      if (!assignee && nextUsers.length > 0) {
        const fallback = nextUsers.find((item) => item.username !== currentUser) || nextUsers[0];
        setAssignee(fallback?.username || '');
      }
    } catch (err) {
      setError(err.message || '포털 데이터를 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadPortalData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submitRequest = async (e) => {
    e.preventDefault();
    if (!assignee || !requestText.trim()) {
      setError('받는 사람과 요청 내용을 입력해주세요.');
      return;
    }
    try {
      setSending(true);
      setError('');
      setMessage('');
      const formData = new FormData();
      formData.append('assignee', assignee);
      formData.append('text', requestText.trim());
      requestFiles.forEach((file) => formData.append('files', file));
      const res = await fetch(`${API}/requests`, {
        method: 'POST',
        headers: authHeaders,
        body: formData,
      });
      if (handleAuthFailure(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || '요청 전송 실패');
      setRequestText('');
      setRequestFiles([]);
      if (fileInputRef.current) fileInputRef.current.value = '';
      setMessage('요청을 전송했습니다.');
      await loadPortalData();
    } catch (err) {
      setError(err.message || '요청 전송 실패');
    } finally {
      setSending(false);
    }
  };

  const completeRequest = async (id) => {
    try {
      setError('');
      const res = await fetch(`${API}/requests/${id}/complete`, {
        method: 'POST',
        headers: authHeaders,
      });
      if (handleAuthFailure(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || '요청 완료 처리 실패');
      await loadPortalData();
    } catch (err) {
      setError(err.message || '요청 완료 처리 실패');
    }
  };

  const clearReceivedRequests = async () => {
    if (!window.confirm('요청 목록에서 완료된 항목만 삭제할까요?')) return;
    try {
      setError('');
      const res = await fetch(`${API}/requests/assigned/clear`, {
        method: 'DELETE',
        headers: authHeaders,
      });
      if (handleAuthFailure(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || '요청 목록 정리 실패');
      await loadPortalData();
    } catch (err) {
      setError(err.message || '요청 목록 정리 실패');
    }
  };

  const acknowledgeRequest = async (id) => {
    try {
      setError('');
      const res = await fetch(`${API}/requests/${id}/ack`, {
        method: 'POST',
        headers: authHeaders,
      });
      if (handleAuthFailure(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || '확인 처리 실패');
      await loadPortalData();
    } catch (err) {
      setError(err.message || '확인 처리 실패');
    }
  };

  const clearSentRequests = async () => {
    if (!window.confirm('보낸 요청에서 완료된 항목만 삭제할까요?')) return;
    try {
      setError('');
      const res = await fetch(`${API}/requests/sent/clear`, {
        method: 'DELETE',
        headers: authHeaders,
      });
      if (handleAuthFailure(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || '보낸 요청 정리 실패');
      await loadPortalData();
    } catch (err) {
      setError(err.message || '보낸 요청 정리 실패');
    }
  };

  const addTodo = async () => {
    if (!todoText.trim()) return;
    try {
      setSavingTodo(true);
      setError('');
      const res = await fetch(`${API}/shared-todos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ text: todoText.trim() }),
      });
      if (handleAuthFailure(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || '공동 할 일 등록 실패');
      setTodoText('');
      await loadPortalData();
    } catch (err) {
      setError(err.message || '공동 할 일 등록 실패');
    } finally {
      setSavingTodo(false);
    }
  };

  const completeTodo = async (id, comment = '') => {
    try {
      setSavingTodo(true);
      setError('');
      const res = await fetch(`${API}/shared-todos/${id}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ comment }),
      });
      if (handleAuthFailure(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || '공동 할 일 완료 실패');
      setTodoComment('');
      setTodoCommentId(null);
      await loadPortalData();
    } catch (err) {
      setError(err.message || '공동 할 일 완료 실패');
    } finally {
      setSavingTodo(false);
    }
  };

  const renderAttachments = (item) => {
    if (!item.attachments || item.attachments.length === 0) return null;
    return (
      <div className={styles.attachments}>
        {item.attachments.map((file) => (
          <a
            key={file.id}
            className={styles.attachment}
            href={fileUrl(file)}
            target="_blank"
            rel="noreferrer"
          >
            <span className={styles.attachmentName}>{file.filename}</span>
            <span className={styles.attachmentMeta}>{formatFileSize(file.size)}</span>
          </a>
        ))}
      </div>
    );
  };

  const orderedTodos = [...todos].sort((a, b) => {
    const aDone = a.status === 'completed';
    const bDone = b.status === 'completed';
    if (aDone !== bDone) return aDone ? 1 : -1;
    return String(a.created_at || '').localeCompare(String(b.created_at || ''));
  });
  const visibleTodos = orderedTodos.filter((item) =>
    todoTab === 'completed' ? item.status === 'completed' : item.status !== 'completed'
  );
  const approvedPeerCount = users.filter((item) => item.username !== currentUser).length;

  return (
    <div className={styles.page}>
      <section className={styles.hero}>
        <div>
          <div className={styles.eyebrow}>External Collaboration Portal</div>
          <h1 className={styles.title}>요청과 공동할일만 따로 연결한 외부 포털</h1>
          <p className={styles.subtitle}>
            외부 계정도 같은 협업 데이터에 연결됩니다. 현재 로그인 계정은{' '}
            <strong>{displayName || currentUser || '-'}</strong> 입니다.
          </p>
          <div className={styles.heroStats}>
            <div className={styles.heroStat}>
              <span className={styles.heroStatLabel}>연결 사용자</span>
              <strong>{users.length}</strong>
            </div>
            <div className={styles.heroStat}>
              <span className={styles.heroStatLabel}>요청 가능 대상</span>
              <strong>{approvedPeerCount}</strong>
            </div>
            <div className={styles.heroStat}>
              <span className={styles.heroStatLabel}>받은 요청</span>
              <strong>{inbox.length}</strong>
            </div>
          </div>
        </div>
        <div className={styles.heroActions}>
          <button type="button" className={styles.refreshBtn} onClick={loadPortalData} disabled={loading}>
            새로고침
          </button>
          <button type="button" className={styles.logoutBtn} onClick={onLogout}>
            로그아웃
          </button>
        </div>
      </section>

      {(error || message) && (
        <div className={error ? styles.errorBox : styles.successBox}>{error || message}</div>
      )}

      <div className={styles.topGrid}>
        <section className={styles.panel}>
          <div className={styles.panelHeader}>
            <h2>요청 보내기</h2>
            <span>{users.length}명 연결됨</span>
          </div>
          <div className={styles.helperText}>
            승인된 계정끼리만 서로 요청을 주고받습니다. 첨부 파일은 요청과 함께 저장됩니다.
          </div>
          <form className={styles.form} onSubmit={submitRequest}>
            <label className={styles.label}>
              받는 사람
              <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
                <option value="">선택하세요</option>
                {users.map((user) => (
                  <option key={user.username} value={user.username}>
                    {user.display_name || user.username}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.label}>
              요청 내용
              <textarea
                rows={6}
                value={requestText}
                onChange={(e) => setRequestText(e.target.value)}
                placeholder="작업 요청 내용을 입력하세요"
              />
            </label>
            <label className={styles.label}>
              첨부 파일
              <input
                ref={fileInputRef}
                type="file"
                multiple
                onChange={(e) => setRequestFiles(Array.from(e.target.files || []))}
              />
            </label>
            {requestFiles.length > 0 && (
              <div className={styles.fileChips}>
                {requestFiles.map((file) => (
                  <span key={`${file.name}-${file.size}`} className={styles.fileChip}>
                    {file.name}
                  </span>
                ))}
              </div>
            )}
            <button type="submit" className={styles.primaryBtn} disabled={sending}>
              {sending ? '전송 중...' : '요청 보내기'}
            </button>
          </form>
        </section>

        <section className={styles.panel}>
          <div className={styles.cardTitleRow}>
            <h2 className={styles.sectionTitle}>요청 목록</h2>
            <button type="button" className={styles.secondaryBtn} onClick={clearReceivedRequests}>
              목록 지우기
            </button>
          </div>
          <div className={styles.activityList}>
            {inbox.map((item) => (
              <div
                key={item.id}
                className={`${styles.activityItem} ${item.status === 'completed' ? styles.activityItemCompleted : ''}`}
              >
                <div className={styles.activityDot}></div>
                <div className={styles.activityInfo}>
                  <div>
                    <div className={styles.activityText}>{item.text}</div>
                    <div className={styles.activityMeta}>
                      {item.requester_display || item.requester_username || '-'}
                    </div>
                    <div className={styles.activityMeta}>받은시간: {formatDateTime(item.created_at)}</div>
                  </div>
                  {renderAttachments(item)}
                </div>
                <div className={styles.activityActions}>
                  {item.status === 'completed' ? (
                    <span className={styles.completedBadge}>Completed</span>
                  ) : (
                    <button type="button" className={styles.primaryBtn} onClick={() => completeRequest(item.id)}>
                      완료 처리
                    </button>
                  )}
                </div>
              </div>
            ))}
            {!loading && inbox.length === 0 && <div className={styles.empty}>받은 요청이 없습니다.</div>}
          </div>
        </section>
      </div>

      <div className={styles.bottomStack}>
        <section className={styles.panel}>
          <div className={styles.panelHeader}>
            <h2>공동 할 일</h2>
            <div className={styles.tabGroup}>
              <button
                type="button"
                className={`${styles.tabBtn} ${todoTab === 'open' ? styles.tabBtnActive : ''}`}
                onClick={() => setTodoTab('open')}
              >
                진행중
              </button>
              <button
                type="button"
                className={`${styles.tabBtn} ${todoTab === 'completed' ? styles.tabBtnActive : ''}`}
                onClick={() => setTodoTab('completed')}
              >
                완료
              </button>
            </div>
          </div>
          <div className={styles.todoComposer}>
            <input
              value={todoText}
              onChange={(e) => setTodoText(e.target.value)}
              placeholder="공동 할 일을 추가하세요"
            />
            <button type="button" className={styles.primaryBtn} onClick={addTodo} disabled={savingTodo}>
              추가
            </button>
          </div>
          <div className={styles.todoList}>
            {visibleTodos.map((item) => {
              const done = item.status === 'completed';
              return (
                <div key={item.id} className={styles.todoItem}>
                  <div>
                    <div className={`${styles.todoText} ${done ? styles.todoTextDone : ''}`}>{item.text}</div>
                    <div className={styles.todoMeta}>
                      등록 {item.created_by_display || item.created_by_username || '-'}
                      {done && ` · 완료 ${item.completed_by_display || item.completed_by_username || '-'}`}
                    </div>
                    {done && item.completed_comment && (
                      <div className={styles.todoComment}>코멘트: {item.completed_comment}</div>
                    )}
                    {!done && todoCommentId === item.id && (
                      <div className={styles.todoInline}>
                        <input
                          value={todoComment}
                          onChange={(e) => setTodoComment(e.target.value)}
                          placeholder="완료 코멘트"
                        />
                        <button
                          type="button"
                          className={styles.primaryBtn}
                          onClick={() => completeTodo(item.id, todoComment)}
                        >
                          저장
                        </button>
                      </div>
                    )}
                  </div>
                  <div className={styles.todoAction}>
                    {done ? (
                      <span className={styles.doneBadge}>완료</span>
                    ) : (
                      <button
                        type="button"
                        className={styles.secondaryBtn}
                        onClick={() => {
                          setTodoCommentId(item.id);
                          setTodoComment('');
                        }}
                      >
                        완료 처리
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
            {!loading && visibleTodos.length === 0 && (
              <div className={styles.empty}>
                {todoTab === 'completed' ? '완료된 공동 할 일이 없습니다.' : '등록된 공동 할 일이 없습니다.'}
              </div>
            )}
          </div>
        </section>

        <section className={styles.panel}>
          <div className={styles.cardTitleRow}>
            <h2 className={styles.sectionTitle}>보낸 요청</h2>
            <div className={styles.tabGroup}>
              <button
                type="button"
                className={`${styles.tabBtn} ${sentFilter === 'open' ? styles.tabBtnActive : ''}`}
                onClick={() => setSentFilter('open')}
              >
                요청중
              </button>
              <button
                type="button"
                className={`${styles.tabBtn} ${sentFilter === 'completed' ? styles.tabBtnActive : ''}`}
                onClick={() => setSentFilter('completed')}
              >
                완료
              </button>
              <button
                type="button"
                className={`${styles.tabBtn} ${sentFilter === 'all' ? styles.tabBtnActive : ''}`}
                onClick={() => setSentFilter('all')}
              >
                전체
              </button>
              <button type="button" className={styles.tabBtn} onClick={clearSentRequests}>
                목록 지우기
              </button>
            </div>
          </div>
          <div className={styles.requestList}>
            {outbox
              .filter((item) => {
                if (sentFilter === 'open') return item.status !== 'completed';
                if (sentFilter === 'completed') return item.status === 'completed';
                return true;
              })
              .map((item) => (
              <article key={item.id} className={styles.requestCard}>
                <div className={styles.requestHead}>
                  <div>
                    <h3>{item.text}</h3>
                    <p>
                      {item.assignee_display || item.assignee_username || '-'}
                      {item.status === 'completed' ? ' completed' : ' in progress'}
                      {' · '}보낸시간: {formatDateTime(item.created_at)}
                    </p>
                  </div>
                  <div className={styles.activityActions}>
                    {item.status === 'completed' && item.can_ack ? (
                      <>
                        <span className={styles.newBadge}>NEW</span>
                        <button type="button" className={styles.secondaryBtn} onClick={() => acknowledgeRequest(item.id)}>
                          확인
                        </button>
                      </>
                    ) : null}
                    {item.status !== 'completed' && <span className={styles.pendingBadge}>OPEN</span>}
                  </div>
                </div>
                {renderAttachments(item)}
              </article>
            ))}
            {!loading &&
              outbox.filter((item) => {
                if (sentFilter === 'open') return item.status !== 'completed';
                if (sentFilter === 'completed') return item.status === 'completed';
                return true;
              }).length === 0 && <div className={styles.empty}>보낸 요청이 없습니다.</div>}
          </div>
        </section>
      </div>
    </div>
  );
}
