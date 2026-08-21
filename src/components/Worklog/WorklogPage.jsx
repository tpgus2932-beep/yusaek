import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, NotebookPen, Play } from 'lucide-react';
import styles from './WorklogPage.module.css';
import { LOCAL_API_BASE as API, getAuthHeaders, handleUnauthorized } from '../../lib/api';

const kstDateStr = (date = new Date()) => date.toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });

const shiftDateStr = (dateStr, days) => {
    const d = new Date(`${dateStr}T00:00:00+09:00`);
    d.setDate(d.getDate() + days);
    return kstDateStr(d);
};

const fmtTime = (iso) => {
    if (!iso) return '';
    try {
        return new Date(iso).toLocaleString('ko-KR', { hour: '2-digit', minute: '2-digit' });
    } catch {
        return iso;
    }
};

const fmtDuration = (ms) => {
    if (ms < 0) ms = 0;
    const totalMinutes = Math.floor(ms / 60000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours > 0) return `${hours}시간 ${minutes}분`;
    if (minutes > 0) return `${minutes}분`;
    return '1분 미만';
};

const REFRESH_INTERVAL_MS = 20000;
const TICK_INTERVAL_MS = 30000;

const WorklogPage = ({ currentUser }) => {
    const todayStr = kstDateStr();
    const [selectedDate, setSelectedDate] = useState(todayStr);
    const [entries, setEntries] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [now, setNow] = useState(Date.now());

    const [newTask, setNewTask] = useState('');
    const [starting, setStarting] = useState(false);

    const [completingId, setCompletingId] = useState(null);
    const [notesInput, setNotesInput] = useState('');
    const [completing, setCompleting] = useState(false);

    const authHeaders = getAuthHeaders();
    const isToday = selectedDate === todayStr;

    const loadEntries = async (date) => {
        try {
            const res = await fetch(`${API}/worklog/entries?date=${date}`, { headers: authHeaders });
            if (handleUnauthorized(res)) return;
            const data = await res.json();
            setEntries(data.entries || []);
        } catch {
            setError('기록을 불러오지 못했습니다.');
        }
    };

    useEffect(() => {
        (async () => {
            setLoading(true);
            setError('');
            await loadEntries(selectedDate);
            setLoading(false);
        })();
        const refreshTimer = setInterval(() => loadEntries(selectedDate), REFRESH_INTERVAL_MS);
        return () => clearInterval(refreshTimer);
    }, [selectedDate]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        const tickTimer = setInterval(() => setNow(Date.now()), TICK_INTERVAL_MS);
        return () => clearInterval(tickTimer);
    }, []);

    const handleStart = async () => {
        const task = newTask.trim();
        if (!task) return;
        setStarting(true);
        setError('');
        try {
            const res = await fetch(`${API}/worklog/entries`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders },
                body: JSON.stringify({ task }),
            });
            if (handleUnauthorized(res)) return;
            const data = await res.json();
            if (res.ok && data.entry) {
                setEntries((prev) => [data.entry, ...prev]);
                setNewTask('');
            } else {
                setError(data.detail || '시작에 실패했습니다.');
            }
        } catch {
            setError('시작에 실패했습니다.');
        } finally {
            setStarting(false);
        }
    };

    const handleComplete = async (entryId) => {
        setCompleting(true);
        setError('');
        try {
            const res = await fetch(`${API}/worklog/entries/${entryId}/complete`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json', ...authHeaders },
                body: JSON.stringify({ notes: notesInput.trim() }),
            });
            if (handleUnauthorized(res)) return;
            const data = await res.json();
            if (res.ok && data.entry) {
                setEntries((prev) => prev.map((e) => (e.id === entryId ? data.entry : e)));
                setCompletingId(null);
                setNotesInput('');
            } else {
                setError(data.detail || '완료 처리에 실패했습니다.');
            }
        } catch {
            setError('완료 처리에 실패했습니다.');
        } finally {
            setCompleting(false);
        }
    };

    const renderEntryRow = (e) => (
        <div key={e.id} className={styles.entryRow}>
            <div className={styles.entryTop}>
                <span className={styles.entryTask}>{e.task}</span>
                <span className={`${styles.entryStatus} ${e.status === 'in_progress' ? styles.entryStatusActive : ''}`}>
                    {e.status === 'in_progress' ? '진행중' : fmtDuration(new Date(e.endedAt).getTime() - new Date(e.startedAt).getTime())}
                </span>
            </div>
            <div className={styles.entryMeta}>
                {fmtTime(e.startedAt)} ~ {e.status === 'done' ? fmtTime(e.endedAt) : '진행중'}
            </div>
            {e.notes && <div className={styles.entryNotes}>특이사항: {e.notes}</div>}
        </div>
    );

    const grouped = {};
    entries.forEach((e) => {
        (grouped[e.username] = grouped[e.username] || []).push(e);
    });
    const usernames = Object.keys(grouped);
    if (isToday && !usernames.includes(currentUser)) usernames.push(currentUser);
    usernames.sort((a, b) => {
        if (a === currentUser) return -1;
        if (b === currentUser) return 1;
        const da = grouped[a]?.[0]?.displayName || a;
        const db = grouped[b]?.[0]?.displayName || b;
        return da.localeCompare(db, 'ko');
    });

    return (
        <div className={styles.page}>
            <div className={styles.pageHeader}>
                <NotebookPen size={20} />
                <h2>업무일지</h2>
            </div>

            {error && <div className={styles.error}>{error}</div>}

            <div className={styles.dateBar}>
                <button
                    type="button"
                    className={styles.dateNavBtn}
                    onClick={() => setSelectedDate((d) => shiftDateStr(d, -1))}
                >
                    <ChevronLeft size={16} />
                </button>
                <input
                    type="date"
                    className={styles.dateInput}
                    value={selectedDate}
                    max={todayStr}
                    onChange={(e) => e.target.value && setSelectedDate(e.target.value)}
                />
                <button
                    type="button"
                    className={styles.dateNavBtn}
                    onClick={() => setSelectedDate((d) => shiftDateStr(d, 1))}
                    disabled={isToday}
                >
                    <ChevronRight size={16} />
                </button>
                {!isToday && (
                    <button
                        type="button"
                        className={styles.todayBtn}
                        onClick={() => setSelectedDate(todayStr)}
                    >
                        오늘로
                    </button>
                )}
            </div>

            {loading ? (
                <div className={styles.empty}>불러오는 중...</div>
            ) : usernames.length === 0 ? (
                <div className={styles.empty}>이 날짜에는 기록이 없습니다.</div>
            ) : (
                <div className={styles.userGrid}>
                    {usernames.map((username) => {
                        const userEntries = grouped[username] || [];
                        const isMine = username === currentUser;
                        const displayName = userEntries[0]?.displayName || username;
                        const activeEntries = isToday
                            ? userEntries.filter((e) => e.status === 'in_progress')
                            : [];
                        const activeIds = new Set(activeEntries.map((e) => e.id));
                        const historyEntries = activeIds.size
                            ? userEntries.filter((e) => !activeIds.has(e.id))
                            : userEntries;

                        return (
                            <div key={username} className={styles.userCard}>
                                <div className={styles.userCardHeader}>
                                    <div className={styles.userAvatar}>{displayName.slice(0, 2)}</div>
                                    <div className={styles.userCardName}>{displayName}</div>
                                    <span className={styles.columnCount}>{userEntries.length}</span>
                                </div>

                                {isMine && isToday && (
                                    <div className={styles.activeSection}>
                                        <div className={styles.startRow}>
                                            <input
                                                type="text"
                                                className={styles.taskInput}
                                                placeholder="지금 하는 일을 적어주세요"
                                                value={newTask}
                                                onChange={(e) => setNewTask(e.target.value)}
                                                onKeyDown={(e) => {
                                                    if (e.key === 'Enter') handleStart();
                                                }}
                                            />
                                            <button
                                                type="button"
                                                className={styles.primaryBtn}
                                                onClick={handleStart}
                                                disabled={starting || !newTask.trim()}
                                            >
                                                <Play size={14} />
                                                시작
                                            </button>
                                        </div>
                                    </div>
                                )}

                                {activeEntries.length > 0 && (
                                    <div className={styles.activeSection}>
                                        <div className={styles.activeList}>
                                            {activeEntries.map((entry) => (
                                                <div key={entry.id} className={styles.activeItem}>
                                                    <div className={styles.activeTask}>{entry.task}</div>
                                                    <div className={styles.activeMeta}>
                                                        {fmtTime(entry.startedAt)} 시작 · {fmtDuration(now - new Date(entry.startedAt).getTime())} 경과
                                                    </div>
                                                    {completingId === entry.id ? (
                                                        <div className={styles.completeForm}>
                                                            <textarea
                                                                className={styles.notesInput}
                                                                placeholder="특이사항 (선택)"
                                                                value={notesInput}
                                                                onChange={(e) => setNotesInput(e.target.value)}
                                                                rows={2}
                                                                autoFocus
                                                            />
                                                            <div className={styles.completeFormActions}>
                                                                <button
                                                                    type="button"
                                                                    className={styles.secondaryBtn}
                                                                    onClick={() => {
                                                                        setCompletingId(null);
                                                                        setNotesInput('');
                                                                    }}
                                                                >
                                                                    취소
                                                                </button>
                                                                <button
                                                                    type="button"
                                                                    className={styles.primaryBtn}
                                                                    onClick={() => handleComplete(entry.id)}
                                                                    disabled={completing}
                                                                >
                                                                    {completing ? '처리 중...' : '완료 확정'}
                                                                </button>
                                                            </div>
                                                        </div>
                                                    ) : (
                                                        <button
                                                            type="button"
                                                            className={styles.completeBtn}
                                                            onClick={() => {
                                                                setCompletingId(entry.id);
                                                                setNotesInput('');
                                                            }}
                                                        >
                                                            완료
                                                        </button>
                                                    )}
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                <div className={styles.entryList}>
                                    {historyEntries.length === 0 ? (
                                        <div className={styles.emptySmall}>기록이 없습니다.</div>
                                    ) : (
                                        historyEntries.map(renderEntryRow)
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
};

export default WorklogPage;
