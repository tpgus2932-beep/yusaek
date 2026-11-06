import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    AlertCircle, FlaskConical, MessageCircle, MoreHorizontal, Paperclip, Pause, Play,
    Plus, RefreshCw, Search, Settings, Smile, Smartphone, Trash2, User, UserPlus, X,
} from 'lucide-react';
import styles from './KakaoTalkPage.module.css';
import { LOCAL_API_BASE, getAuthHeaders, handleUnauthorized } from '../../lib/api';

const MESSAGE_POLL_MS = 1500;
const STATUS_POLL_MS = 4000;
const WEEKDAYS = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'];
const AVATAR_COLORS = ['#a8c4e6', '#f2b8a2', '#b7d9b0', '#d8c1e8', '#f4d58d', '#9fd3d6'];

const call = async (path, { method = 'GET', body, params } = {}) => {
    const qs = params ? `?${new URLSearchParams(params)}` : '';
    const res = await fetch(`${LOCAL_API_BASE}/kakao${path}${qs}`, {
        method,
        headers: body ? { ...getAuthHeaders(), 'Content-Type': 'application/json' } : getAuthHeaders(),
        body: body ? JSON.stringify(body) : undefined,
    });
    if (handleUnauthorized(res)) throw new Error('로그인이 만료되었습니다.');
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || '요청에 실패했습니다.');
    return data;
};

const toDate = (iso) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d;
};
const clock = (iso) => {
    const d = toDate(iso);
    if (!d) return '';
    const h = d.getHours();
    return `${h < 12 ? '오전' : '오후'} ${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const dayKey = (iso) => {
    const d = toDate(iso);
    return d ? `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}` : '';
};
const minuteKey = (iso) => `${dayKey(iso)}-${toDate(iso)?.getHours()}-${toDate(iso)?.getMinutes()}`;
const dayLabel = (iso) => {
    const d = toDate(iso);
    return d ? `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 ${WEEKDAYS[d.getDay()]}` : '';
};
const listTime = (iso) => {
    const d = toDate(iso);
    if (!d) return '';
    const now = new Date();
    if (dayKey(iso) === dayKey(now.toISOString())) return clock(iso);
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    if (dayKey(iso) === `${yesterday.getFullYear()}-${yesterday.getMonth()}-${yesterday.getDate()}`) return '어제';
    return `${d.getMonth() + 1}월 ${d.getDate()}일`;
};
const colorFor = (name) => {
    let hash = 0;
    for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    return AVATAR_COLORS[hash % AVATAR_COLORS.length];
};
const newRequestId = () => (window.crypto?.randomUUID ? window.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

const Avatar = ({ name, size = 44 }) => (
    <span className={styles.avatar} style={{ width: size, height: size, background: colorFor(name) }}>
        <User size={Math.round(size * 0.58)} strokeWidth={2.2} />
    </span>
);

const KakaoTalkPage = () => {
    const [rail, setRail] = useState('friends'); // friends | chats | more
    const [contacts, setContacts] = useState([]);
    const [selectedId, setSelectedId] = useState(() => {
        const saved = Number(localStorage.getItem('kakaoSelectedContact'));
        return Number.isFinite(saved) && saved > 0 ? saved : null;
    });
    const [messages, setMessages] = useState([]);
    const [status, setStatus] = useState(null);
    const [draft, setDraft] = useState('');
    const [query, setQuery] = useState('');
    const [searchOpen, setSearchOpen] = useState(false);
    const [adding, setAdding] = useState(false);
    const [newName, setNewName] = useState('');
    const [notice, setNotice] = useState('');
    const [devices, setDevices] = useState(null);
    const [serialInput, setSerialInput] = useState('');
    const [busy, setBusy] = useState(false);
    const scroller = useRef(null);
    const stickToBottom = useRef(true);
    const textarea = useRef(null);

    const selected = useMemo(() => contacts.find((c) => c.id === selectedId) || null, [contacts, selectedId]);

    const noticeTimer = useRef(null);
    const showNotice = useCallback((text) => {
        setNotice(text);
        window.clearTimeout(noticeTimer.current);
        noticeTimer.current = window.setTimeout(() => setNotice(''), 4500);
    }, []);
    useEffect(() => () => window.clearTimeout(noticeTimer.current), []);

    const loadContacts = useCallback(async () => {
        try {
            const data = await call('/contacts');
            setContacts(data.contacts || []);
        } catch (err) {
            showNotice(err.message);
        }
    }, [showNotice]);

    const loadStatus = useCallback(async () => {
        try {
            setStatus(await call('/status'));
        } catch {
            setStatus(null);
        }
    }, []);

    const loadMessages = useCallback(async (contactId) => {
        if (!contactId) return;
        try {
            const data = await call('/messages', { params: { contact_id: contactId } });
            setMessages(data.messages || []);
        } catch {
            /* 일시 오류는 다음 폴링에서 복구 */
        }
    }, []);

    useEffect(() => {
        loadContacts();
        loadStatus();
        const timer = window.setInterval(() => { loadContacts(); loadStatus(); }, STATUS_POLL_MS);
        return () => window.clearInterval(timer);
    }, [loadContacts, loadStatus]);

    useEffect(() => {
        setMessages([]);
        stickToBottom.current = true;
        if (!selectedId) return undefined;
        localStorage.setItem('kakaoSelectedContact', String(selectedId));
        loadMessages(selectedId);
        const timer = window.setInterval(() => loadMessages(selectedId), MESSAGE_POLL_MS);
        return () => window.clearInterval(timer);
    }, [selectedId, loadMessages]);

    useEffect(() => {
        const el = scroller.current;
        if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
    }, [messages]);

    useEffect(() => {
        const el = textarea.current;
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = `${Math.min(el.scrollHeight, 110)}px`;
    }, [draft]);

    const onScroll = () => {
        const el = scroller.current;
        if (el) stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    };

    const submit = async (dryRun = false) => {
        const text = dryRun ? (draft.trim() || '(전송 테스트)') : draft;
        if (!selected || !text.trim()) return;
        if (!dryRun) setDraft('');
        stickToBottom.current = true;
        try {
            await call('/send', { method: 'POST', body: { contact_id: selected.id, text, request_id: newRequestId(), dry_run: dryRun } });
            await loadMessages(selected.id);
            loadStatus();
        } catch (err) {
            if (!dryRun) setDraft(text);
            showNotice(err.message);
        }
    };

    const onKeyDown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit(false);
        }
    };

    const addContact = async () => {
        const name = newName.trim();
        if (!name) return;
        try {
            const data = await call('/contacts', { method: 'POST', body: { name } });
            setNewName('');
            setAdding(false);
            await loadContacts();
            setSelectedId(data.id);
        } catch (err) {
            showNotice(err.message);
        }
    };

    const removeContact = async (contact) => {
        if (!window.confirm(`'${contact.name}' 님을 목록에서 삭제할까요?\n대화 기록도 함께 삭제됩니다.`)) return;
        try {
            await call(`/contacts/${contact.id}`, { method: 'DELETE' });
            if (selectedId === contact.id) setSelectedId(null);
            loadContacts();
        } catch (err) {
            showNotice(err.message);
        }
    };

    const act = async (path, options) => {
        try {
            await call(path, options);
            await loadMessages(selectedId);
            loadStatus();
        } catch (err) {
            showNotice(err.message);
        }
    };

    const openChat = (contact) => {
        setSelectedId(contact.id);
        if (rail === 'more') setRail('chats');
    };

    const refreshDevices = async () => {
        setBusy(true);
        try {
            setDevices((await call('/devices')).devices);
        } catch (err) {
            setDevices([]);
            showNotice(err.message);
        } finally {
            setBusy(false);
        }
    };

    const bindDevice = async () => {
        setBusy(true);
        try {
            await call('/device/bind', { method: 'POST', body: { serial: serialInput.trim() } });
            showNotice('휴대폰과 카카오 계정을 확인했습니다.');
            await loadStatus();
        } catch (err) {
            showNotice(err.message);
        } finally {
            setBusy(false);
        }
    };

    const syncing = !!status?.sync?.running;
    const wasSyncing = useRef(false);

    const syncFriends = async () => {
        try {
            await call('/contacts/sync', { method: 'POST' });
            showNotice('휴대폰에서 친구 목록을 읽는 중입니다. 끝날 때까지 폰을 만지지 마세요.');
            loadStatus();
        } catch (err) {
            showNotice(err.message);
        }
    };

    // 동기화가 끝나는 순간 결과를 알리고 목록을 새로 읽는다. 진행 중에는 상태를 더 자주 확인한다.
    useEffect(() => {
        if (syncing) {
            wasSyncing.current = true;
            const timer = window.setInterval(loadStatus, 1500);
            return () => window.clearInterval(timer);
        }
        if (wasSyncing.current && status?.sync) {
            wasSyncing.current = false;
            const { result, error } = status.sync;
            if (error) {
                showNotice(`친구 동기화 실패: ${error}`);
            } else if (result) {
                const parts = [`친구 ${result.total}명을 읽었습니다 (카카오톡 표시 ${result.expected}명, 추천친구·채널 제외)`, `새로 ${result.added}명 추가`];
                if (result.duplicates.length) parts.push(`동명이인 ${result.duplicates.length}명(전송 불가)`);
                if (result.missingCount) parts.push(`폰에 없는 기존 친구 ${result.missingCount}명(삭제하지 않음)`);
                showNotice(parts.join(' · '));
            }
            loadContacts();
        }
        return undefined;
    }, [syncing, status, loadStatus, loadContacts, showNotice]);

    const toggleQueue = async () => {
        try {
            await call('/queue', { method: 'POST', body: { paused: !status?.paused } });
            loadStatus();
        } catch (err) {
            showNotice(err.message);
        }
    };

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        return contacts.filter((c) => !q || c.name.toLowerCase().includes(q));
    }, [contacts, query]);

    const chatList = useMemo(
        () => filtered.filter((c) => c.lastAt).sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt))),
        [filtered],
    );

    const renderMessage = (m, index) => {
        const prev = messages[index - 1];
        const next = messages[index + 1];
        const newDay = !prev || dayKey(prev.createdAt) !== dayKey(m.createdAt);
        const dayDivider = newDay && <div className={styles.dayDivider}><span>{dayLabel(m.createdAt)}</span></div>;

        if (m.dryRun) {
            const label = {
                tested: '전송 테스트 성공 · 실제로 보내지 않았습니다',
                queued: '전송 테스트 대기 중…',
                sending: '전송 테스트 중…',
                failed: `전송 테스트 실패 · ${m.error}`,
            }[m.status] || '전송 테스트';
            return (
                <div key={m.id}>
                    {dayDivider}
                    <div className={styles.systemRow}><span className={m.status === 'failed' ? styles.systemFail : ''}>{label}</span></div>
                </div>
            );
        }

        const sameMinuteAsNext = next && !next.dryRun && minuteKey(next.createdAt) === minuteKey(m.createdAt);
        const startsGroup = !prev || prev.dryRun || minuteKey(prev.createdAt) !== minuteKey(m.createdAt);
        const settled = m.status === 'sent';
        return (
            <div key={m.id}>
                {dayDivider}
                <div className={styles.rowMine}>
                    <div className={styles.meta}>
                        {m.status === 'queued' && <span className={styles.pending}>대기 중{m.queuePosition ? ` (앞 ${m.queuePosition}건)` : ''}</span>}
                        {m.status === 'sending' && <span className={styles.pending}><i className={styles.spinner} />전송 중</span>}
                        {m.status === 'failed' && (
                            <span className={styles.fail} title={m.error}>
                                <AlertCircle size={13} /> 전송 실패
                                <button type="button" onClick={() => act(`/messages/${m.id}/retry`, { method: 'POST' })}>재전송</button>
                            </span>
                        )}
                        {m.status === 'needs_check' && (
                            <span className={styles.check} title={m.error}>
                                확인 필요 · 폰에서 확인 후 선택
                                <button type="button" onClick={() => act(`/messages/${m.id}/resolve`, { method: 'POST', body: { status: 'sent' } })}>보냄</button>
                                <button type="button" onClick={() => act(`/messages/${m.id}/resolve`, { method: 'POST', body: { status: 'failed' } })}>안 보냄</button>
                            </span>
                        )}
                        {settled && !sameMinuteAsNext && <span className={styles.time}>{clock(m.sentAt || m.createdAt)}</span>}
                    </div>
                    <div className={`${styles.bubble} ${startsGroup ? styles.bubbleTail : ''} ${m.status === 'failed' ? styles.bubbleFailed : ''}`}>
                        {m.text}
                    </div>
                </div>
                {m.status === 'failed' && m.error && <div className={styles.errorLine}>{m.error}</div>}
            </div>
        );
    };

    const connected = status?.bound;
    const canSend = !!selected && !!draft.trim();

    const renderList = () => {
        if (rail === 'more') {
            return (
                <div className={styles.moreWrap}>
                    <div className={styles.panelHeader}><h2>더보기</h2></div>
                    <div className={styles.card}>
                        <div className={styles.cardTitle}><Smartphone size={16} /> 휴대폰 연결</div>
                        <div className={styles.kv}>
                            <span>상태</span>
                            <b className={connected ? styles.ok : styles.bad}>{connected ? '연결됨' : '연결 안 됨'}</b>
                        </div>
                        {connected && <div className={styles.kv}><span>기기</span><b>{status.serial}</b></div>}
                        {connected && <div className={styles.kv}><span>계정</span><b>{status.account}…</b></div>}
                        <input
                            className={styles.textInput}
                            placeholder="기기번호 (한 대만 연결했으면 비워두기)"
                            value={serialInput}
                            onChange={(e) => setSerialInput(e.target.value)}
                        />
                        <div className={styles.btnRow}>
                            <button type="button" className={styles.btn} onClick={refreshDevices} disabled={busy}><RefreshCw size={13} /> 기기 목록</button>
                            <button type="button" className={styles.btnYellow} onClick={bindDevice} disabled={busy}>
                                {busy ? '확인 중…' : '계정 확인 / 연결'}
                            </button>
                        </div>
                        {devices && (
                            <ul className={styles.deviceList}>
                                {devices.length === 0 && <li>연결된 기기가 없습니다.</li>}
                                {devices.map((d) => (
                                    <li key={d.serial}>
                                        <button type="button" onClick={() => setSerialInput(d.serial)}>{d.serial}</button>
                                        <span>{d.model}</span>
                                        <em className={d.state === 'device' ? styles.ok : styles.bad}>{d.state}</em>
                                    </li>
                                ))}
                            </ul>
                        )}
                        <p className={styles.hint}>
                            휴대폰에서 USB 디버깅을 허용하고, 브리지 앱의 접근성(YUSAEK TALK 화면 속도 시험)을 켠 뒤 연결하세요.
                            전송 중에는 폰을 직접 조작하지 마세요.
                        </p>
                    </div>
                    <div className={styles.card}>
                        <div className={styles.cardTitle}><Settings size={16} /> 전송 큐</div>
                        <div className={styles.kv}><span>대기</span><b>{status?.queued ?? 0}건</b></div>
                        <div className={styles.kv}><span>전송 중</span><b>{status?.sending ?? 0}건</b></div>
                        <div className={styles.kv}><span>확인 필요</span><b className={status?.needsCheck ? styles.bad : ''}>{status?.needsCheck ?? 0}건</b></div>
                        <div className={styles.kv}>
                            <span>상태</span>
                            <b className={status?.paused ? styles.bad : styles.ok}>{status?.paused ? '멈춤' : '동작 중'}</b>
                        </div>
                        {status?.paused && status.pauseReason && <p className={styles.warn}>{status.pauseReason}</p>}
                        <button type="button" className={styles.btn} onClick={toggleQueue}>
                            {status?.paused ? <><Play size={13} /> 큐 재개</> : <><Pause size={13} /> 큐 멈춤</>}
                        </button>
                        <p className={styles.hint}>동시에 여러 명이 보내면 요청 순서대로 한 건씩 처리합니다.</p>
                    </div>
                </div>
            );
        }

        const rows = rail === 'chats' ? chatList : filtered;
        return (
            <>
                <div className={styles.panelHeader}>
                    <h2>{rail === 'friends' ? '친구' : '채팅'}</h2>
                    <div className={styles.panelIcons}>
                        <button type="button" title="검색" onClick={() => { setSearchOpen((v) => !v); setQuery(''); }}><Search size={18} /></button>
                        <button type="button" title="친구 추가" onClick={() => setAdding((v) => !v)}><UserPlus size={18} /></button>
                    </div>
                </div>
                {searchOpen && (
                    <div className={styles.searchBox}>
                        <Search size={14} />
                        <input autoFocus placeholder="이름 검색" value={query} onChange={(e) => setQuery(e.target.value)} />
                        {query && <button type="button" onClick={() => setQuery('')}><X size={14} /></button>}
                    </div>
                )}
                {adding && (
                    <div className={styles.addBox}>
                        <input
                            autoFocus
                            placeholder="카카오톡 친구 이름"
                            value={newName}
                            onChange={(e) => setNewName(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) addContact(); }}
                        />
                        <button type="button" className={styles.btnYellow} onClick={addContact}><Plus size={14} /> 추가</button>
                        <p>폰의 카카오톡 친구 목록에 보이는 이름과 <b>정확히 같아야</b> 합니다.</p>
                    </div>
                )}
                {rail === 'friends' && (
                    <div className={styles.sectionLabel}>
                        <span>친구 {filtered.length}</span>
                        <button
                            type="button"
                            className={styles.syncBtn}
                            disabled={syncing}
                            title="폰의 카카오톡 친구 목록을 읽어 옵니다. 읽는 동안 폰을 만지지 마세요."
                            onClick={syncFriends}
                        >
                            <RefreshCw size={12} className={syncing ? styles.spin : ''} />
                            {syncing ? '동기화 중…' : '폰에서 동기화'}
                        </button>
                    </div>
                )}
                <div className={styles.list}>
                    {rows.length === 0 && (
                        <div className={styles.empty}>
                            {rail === 'chats' ? '대화 내역이 없습니다.' : '친구를 추가해 주세요.'}
                        </div>
                    )}
                    {rows.map((c) => (
                        <div
                            key={c.id}
                            role="button"
                            tabIndex={0}
                            className={`${styles.item} ${c.id === selectedId ? styles.itemActive : ''}`}
                            onClick={() => openChat(c)}
                            onKeyDown={(e) => { if (e.key === 'Enter') openChat(c); }}
                        >
                            <Avatar name={c.name} />
                            <div className={styles.itemBody}>
                                <div className={styles.itemName}>{c.name}</div>
                                {rail === 'chats'
                                    ? <div className={styles.itemSub}>{c.lastText}</div>
                                    : c.memo && <div className={styles.itemSub}>{c.memo}</div>}
                            </div>
                            <div className={styles.itemSide}>
                                {rail === 'chats' && <span className={styles.itemTime}>{listTime(c.lastAt)}</span>}
                                {c.problemCount > 0 && <span className={styles.badge}>{c.problemCount}</span>}
                            </div>
                            <button
                                type="button"
                                className={styles.itemDelete}
                                title="삭제"
                                onClick={(e) => { e.stopPropagation(); removeContact(c); }}
                            >
                                <Trash2 size={14} />
                            </button>
                        </div>
                    ))}
                </div>
            </>
        );
    };

    return (
        <div className={styles.root}>
            <nav className={styles.rail}>
                <button type="button" className={rail === 'friends' ? styles.railActive : ''} title="친구" onClick={() => setRail('friends')}>
                    <User size={24} fill={rail === 'friends' ? 'currentColor' : 'none'} />
                </button>
                <button type="button" className={rail === 'chats' ? styles.railActive : ''} title="채팅" onClick={() => setRail('chats')}>
                    <MessageCircle size={24} fill={rail === 'chats' ? 'currentColor' : 'none'} />
                    {status?.needsCheck > 0 && <i className={styles.railDot} />}
                </button>
                <span className={styles.railSpacer} />
                <button type="button" className={rail === 'more' ? styles.railActive : ''} title="더보기" onClick={() => setRail('more')}>
                    <MoreHorizontal size={24} />
                    {!connected && <i className={styles.railDot} />}
                </button>
            </nav>

            <section className={styles.panel}>{renderList()}</section>

            <section className={styles.chat}>
                {!selected ? (
                    <div className={styles.placeholder}>
                        <span className={styles.logo}><MessageCircle size={46} fill="#3c1e1e" strokeWidth={0} /></span>
                        <p>대화할 친구를 선택하세요</p>
                    </div>
                ) : (
                    <>
                        <header className={styles.chatHeader}>
                            <Avatar name={selected.name} size={38} />
                            <div className={styles.chatTitle}>
                                <b>{selected.name}</b>
                                <span>{selected.memo || '나와의 1:1 채팅'}</span>
                            </div>
                            <button type="button" className={styles.headerBtn} title="실제로 보내지 않고 상대·채팅방만 확인" onClick={() => submit(true)}>
                                <FlaskConical size={15} /> 전송 테스트
                            </button>
                        </header>

                        {!connected && (
                            <div className={styles.banner}>
                                휴대폰이 연결되지 않았습니다. <button type="button" onClick={() => setRail('more')}>더보기에서 연결하기</button>
                            </div>
                        )}
                        {connected && status?.paused && (
                            <div className={styles.banner}>
                                전송 큐가 멈춰 있습니다. {status.pauseReason}
                                <button type="button" onClick={toggleQueue}>재개</button>
                            </div>
                        )}

                        <div className={styles.messages} ref={scroller} onScroll={onScroll}>
                            {messages.length === 0 && <div className={styles.dayDivider}><span>대화를 시작해 보세요</span></div>}
                            {messages.map(renderMessage)}
                        </div>

                        <footer className={styles.composer}>
                            <textarea
                                ref={textarea}
                                rows={1}
                                value={draft}
                                placeholder="메시지를 입력하세요"
                                onChange={(e) => setDraft(e.target.value)}
                                onKeyDown={onKeyDown}
                            />
                            <div className={styles.composerBar}>
                                <div className={styles.composerIcons}>
                                    <button type="button" disabled title="이모티콘은 지원하지 않습니다"><Smile size={20} /></button>
                                    <button type="button" disabled title="파일 전송은 지원하지 않습니다"><Paperclip size={20} /></button>
                                </div>
                                <button type="button" className={styles.sendBtn} disabled={!canSend} onClick={() => submit(false)}>
                                    전송
                                </button>
                            </div>
                        </footer>
                    </>
                )}
                {notice && <div className={styles.toast}>{notice}</div>}
            </section>
        </div>
    );
};

export default KakaoTalkPage;
