import { useEffect, useState } from 'react';
import { NotebookPen, Play } from 'lucide-react';
import styles from './WorklogPage.module.css';
import { LOCAL_API_BASE as API, getAuthHeaders, handleUnauthorized } from '../../lib/api';

const fmtTime = (iso) => {
    if (!iso) return '';
    try {
        return new Date(iso).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
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
    const [entries, setEntries] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [now, setNow] = useState(Date.now());

    const [newTask, setNewTask] = useState('');
    const [starting, setStarting] = useState(false);

    const [showCompleteForm, setShowCompleteForm] = useState(false);
    const [notesInput, setNotesInput] = useState('');
    const [completing, setCompleting] = useState(false);

    const authHeaders = getAuthHeaders();

    const loadEntries = async () => {
        try {
            const res = await fetch(`${API}/worklog/entries`, { headers: authHeaders });
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
            await loadEntries();
            setLoading(false);
        })();
        const refreshTimer = setInterval(loadEntries, REFRESH_INTERVAL_MS);
        const tickTimer = setInterval(() => setNow(Date.now()), TICK_INTERVAL_MS);
        return () => {
            clearInterval(refreshTimer);
            clearInterval(tickTimer);
        };
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
                setShowCompleteForm(false);
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

    const myActive = entries.find((e) => e.status === 'in_progress' && e.username === currentUser);

    return (
        <div className={styles.page}>
            <div className={styles.pageHeader}>
                <NotebookPen size={20} />
                <h2>업무일지</h2>
            </div>

            {error && <div className={styles.error}>{error}</div>}

            <div className={styles.activeCard}>
                {myActive ? (
                    <>
                        <div className={styles.activeTask}>{myActive.task}</div>
                        <div className={styles.activeMeta}>
                            {fmtTime(myActive.startedAt)} 시작 · {fmtDuration(now - new Date(myActive.startedAt).getTime())} 경과
                        </div>
                        {showCompleteForm ? (
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
                                            setShowCompleteForm(false);
                                            setNotesInput('');
                                        }}
                                    >
                                        취소
                                    </button>
                                    <button
                                        type="button"
                                        className={styles.primaryBtn}
                                        onClick={() => handleComplete(myActive.id)}
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
                                onClick={() => setShowCompleteForm(true)}
                            >
                                완료
                            </button>
                        )}
                    </>
                ) : (
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
                )}
            </div>

            <div className={styles.historyHeader}>기록</div>

            {loading ? (
                <div className={styles.empty}>불러오는 중...</div>
            ) : entries.length === 0 ? (
                <div className={styles.empty}>아직 기록이 없습니다.</div>
            ) : (
                <div className={styles.entryList}>
                    {entries.map((e) => (
                        <div key={e.id} className={styles.entryRow}>
                            <div className={styles.entryTop}>
                                <span className={styles.entryAuthor}>{e.displayName || e.username}</span>
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
                    ))}
                </div>
            )}
        </div>
    );
};

export default WorklogPage;
