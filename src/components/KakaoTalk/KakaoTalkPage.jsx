import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    AlertCircle, FlaskConical, Pencil, Send, MessageCircle, MoreHorizontal, Paperclip, Pause, Play,
    Plus, RefreshCw, Search, Settings, Smile, Smartphone, Trash2, User, UserPlus, X,
} from 'lucide-react';
import styles from './KakaoTalkPage.module.css';
import { LOCAL_API_BASE, getAuthHeaders } from '../../lib/api';
import { call, newRequestId } from './kakaoApi';
import KakaoBulk from './KakaoBulk';
import KakaoRefresh from './KakaoRefresh';

const MESSAGE_POLL_MS = 1500;
const STATUS_POLL_MS = 4000;
const WEEKDAYS = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'];
const AVATAR_COLORS = ['#a8c4e6', '#f2b8a2', '#b7d9b0', '#d8c1e8', '#f4d58d', '#9fd3d6'];

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

const MAX_PHOTOS = 10;
const mediaCache = new Map(); // 미디어 id -> blob URL (같은 사진을 폴링마다 다시 받지 않는다)

/** 로그인 토큰이 필요한 사진을 받아서 보여 준다(<img src>는 Authorization 헤더를 못 보낸다). */
const AuthImage = ({ mediaId, className }) => {
    const [url, setUrl] = useState(() => mediaCache.get(mediaId) || '');
    useEffect(() => {
        if (mediaCache.has(mediaId)) return undefined;   // 초기 상태가 캐시된 사진을 이미 보여 준다
        let alive = true;
        fetch(`${LOCAL_API_BASE}/kakao/media/${mediaId}`, { headers: getAuthHeaders() })
            .then((res) => (res.ok ? res.blob() : null))
            .then((blob) => {
                if (!blob) return;
                const made = URL.createObjectURL(blob);
                mediaCache.set(mediaId, made);
                if (alive) setUrl(made);
            })
            .catch(() => {});
        return () => { alive = false; };
    }, [mediaId]);
    return url ? <img src={url} alt="" className={className} draggable={false} /> : <span className={className} />;
};

const Avatar = ({ name, size = 44 }) => (
    <span className={styles.avatar} style={{ width: size, height: size, background: colorFor(name) }}>
        <User size={Math.round(size * 0.58)} strokeWidth={2.2} />
    </span>
);

const KakaoTalkPage = ({ openContactId = null, openNonce = 0 }) => {
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
    const [repliedOnly, setRepliedOnly] = useState(false);
    const [adding, setAdding] = useState(false);
    const [newName, setNewName] = useState('');
    const [newPhone, setNewPhone] = useState('');
    const [newKakaoId, setNewKakaoId] = useState('');
    const [addMode, setAddMode] = useState('phone'); // phone | id | list
    const [notice, setNotice] = useState('');
    const [devices, setDevices] = useState(null);

    // 다른 화면(CS 재고 탭의 "카카오톡 확인")에서 특정 대화방을 열어 달라고 요청한 경우
    useEffect(() => {
        if (!openContactId) return;
        setSelectedId(openContactId);
        setRail('chats');
    }, [openContactId, openNonce]);
    const [serialInput, setSerialInput] = useState('');
    const [busy, setBusy] = useState(false);
    const [roomSyncOpen, setRoomSyncOpen] = useState(false);
    const [bulkOpen, setBulkOpen] = useState(false);
    const [refreshOpen, setRefreshOpen] = useState(false);
    const [lists, setLists] = useState([]);
    const [activeListId, setActiveListId] = useState(null);
    const [activeMembers, setActiveMembers] = useState(null); // Set<contact id> | null
    const [attachments, setAttachments] = useState([]); // {key, name, preview, id, error}
    const fileInput = useRef(null);
    const [roomSince, setRoomSince] = useState('');
    const [renameOpen, setRenameOpen] = useState(false);
    const [renameValue, setRenameValue] = useState('');
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

    const loadLists = useCallback(async () => {
        try {
            setLists((await call('/lists')).lists || []);
        } catch {
            /* 다음 폴링에서 복구 */
        }
    }, []);

    const [queueItems, setQueueItems] = useState([]); // 모든 대화방의 대기·전송 중·확인 필요 메시지
    const loadStatus = useCallback(async () => {
        try {
            const s = await call('/status');
            setStatus(s);
            if ((s.queued || 0) + (s.sending || 0) + (s.needsCheck || 0) > 0) {
                setQueueItems((await call('/queue/items')).items || []);
            } else {
                setQueueItems([]);
            }
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
        loadLists();
        const timer = window.setInterval(() => { loadContacts(); loadStatus(); loadLists(); }, STATUS_POLL_MS);
        return () => window.clearInterval(timer);
    }, [loadContacts, loadStatus, loadLists]);

    // 선택한 리스트의 구성원: 리스트를 고르고 있는 동안 주기적으로 새로 읽는다
    useEffect(() => {
        if (!activeListId) return undefined;
        let alive = true;
        const load = async () => {
            try {
                const data = await call(`/lists/${activeListId}`);
                if (alive) setActiveMembers(new Set(data.contactIds || []));
            } catch {
                if (alive) { setActiveListId(null); setActiveMembers(null); }   // 지워진 리스트
            }
        };
        load();
        const timer = window.setInterval(load, STATUS_POLL_MS);
        return () => { alive = false; window.clearInterval(timer); };
    }, [activeListId]);

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

    const addFiles = (fileList) => {
        const files = Array.from(fileList || []).filter((f) => /^image\//.test(f.type) || /\.(jpe?g|png|gif|webp)$/i.test(f.name));
        if (!files.length) { showNotice('사진 파일(JPG, PNG, GIF, WEBP)만 첨부할 수 있습니다.'); return; }
        const room = MAX_PHOTOS - attachments.length;
        if (room <= 0) { showNotice(`사진은 한 번에 ${MAX_PHOTOS}장까지 보낼 수 있습니다.`); return; }
        if (files.length > room) showNotice(`사진은 한 번에 ${MAX_PHOTOS}장까지라서 ${room}장만 추가했습니다.`);
        files.slice(0, room).forEach((file) => {
            const key = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
            setAttachments((list) => [...list, { key, name: file.name, preview: URL.createObjectURL(file), id: '' }]);
            fetch(`${LOCAL_API_BASE}/kakao/media?name=${encodeURIComponent(file.name)}`, {
                method: 'POST',
                headers: { ...getAuthHeaders(), 'Content-Type': 'application/octet-stream' },
                body: file,
            })
                .then(async (res) => {
                    const data = await res.json().catch(() => ({}));
                    if (!res.ok) throw new Error(data.detail || '사진을 올리지 못했습니다.');
                    setAttachments((list) => list.map((a) => (a.key === key ? { ...a, id: data.id } : a)));
                })
                .catch((err) => {
                    showNotice(`${file.name}: ${err.message}`);
                    setAttachments((list) => list.filter((a) => a.key !== key));
                });
        });
    };

    const removeAttachment = (key) => {
        setAttachments((list) => {
            const gone = list.find((a) => a.key === key);
            if (gone) URL.revokeObjectURL(gone.preview);
            return list.filter((a) => a.key !== key);
        });
    };

    // Ctrl+V: 커서가 입력창에 있든 대화창을 눌러 둔 상태든 사진이면 첨부한다.
    // (다른 입력칸 — 검색, 친구 추가 — 에 붙여넣는 글자는 건드리지 않는다.)
    const pasteRef = useRef({ addFiles: null, canAttach: false, notify: null });
    useEffect(() => {
        pasteRef.current = { addFiles, canAttach: !!selected, notify: showNotice };
    });
    useEffect(() => {
        const onPaste = (e) => {
            const { addFiles: add, canAttach, notify } = pasteRef.current;
            if (!canAttach || !add) return;
            const target = e.target;
            if (target instanceof Element && target.closest('input, textarea, [contenteditable="true"]') && target !== textarea.current) return;
            const data = e.clipboardData;
            if (!data) return;
            // 탐색기에서 복사한 파일·스크린샷은 files에, 웹의 '이미지 복사'는 items에만 있는 경우가 있다.
            const found = new Map();
            Array.from(data.files || []).forEach((f) => found.set(`${f.name}|${f.size}|${f.type}`, f));
            Array.from(data.items || []).forEach((item) => {
                if (item.kind !== 'file') return;
                const f = item.getAsFile();
                if (f) found.set(`${f.name}|${f.size}|${f.type}`, f);
            });
            const files = Array.from(found.values());
            if (!files.length) return;                       // 글자 붙여넣기는 그대로 둔다
            const images = files.filter((f) => /^image\//.test(f.type) || /\.(jpe?g|png|gif|webp)$/i.test(f.name));
            if (!images.length) { notify('사진 파일(JPG, PNG, GIF, WEBP)만 붙여넣을 수 있습니다.'); return; }
            e.preventDefault();
            add(images.map((f) => (f.name && f.name !== 'image.png' ? f : new File([f], `붙여넣은 사진-${Date.now()}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, { type: f.type }))));
        };
        document.addEventListener('paste', onPaste);
        return () => document.removeEventListener('paste', onPaste);
    }, []);

    const photosReady = attachments.length > 0 && attachments.every((a) => a.id);

    const sendAttachments = async () => {
        if (!photosReady) { showNotice('사진을 올리는 중입니다. 잠시 후 다시 눌러 주세요.'); return false; }
        try {
            await call('/send-images', { method: 'POST', body: { contact_id: selected.id, media_ids: attachments.map((a) => a.id), text: draft, request_id: newRequestId() } });
            attachments.forEach((a) => URL.revokeObjectURL(a.preview));
            setAttachments([]);
            return true;
        } catch (err) {
            showNotice(err.message);
            return false;
        }
    };

    const submit = async (dryRun = false) => {
        if (!dryRun && attachments.length && selected) {
            stickToBottom.current = true;
            if (!(await sendAttachments())) return;   // 글이 있으면 사진과 한 요청으로 함께 등록된다
            setDraft('');
            await loadMessages(selected.id);
            loadStatus();
            return;
        }
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

    const startPhoneAdd = async (body, message) => {
        try {
            await call('/friends/add', { method: 'POST', body });
            showNotice(message);
            setNewPhone('');
            setNewKakaoId('');
            setNewName('');
            setAdding(false);
            loadStatus();
        } catch (err) {
            showNotice(err.message);
        }
    };

    const addContact = async () => {
        const name = newName.trim();
        if (addMode === 'phone' && name && newPhone.trim()) {
            // 이름+전화번호: 폰의 카카오톡에 실제로 친구를 추가한다(전화번호는 저장하지 않음).
            await startPhoneAdd({ name, phone: newPhone.trim() },
                `'${name}' 님을 폰의 카카오톡에 추가하는 중입니다. 끝날 때까지 폰을 만지지 마세요.`);
            return;
        }
        if (addMode === 'id' && newKakaoId.trim()) {
            // 카카오톡 ID: 프로필을 검색해 친구 추가. 이름은 프로필 닉네임으로 저장된다.
            await startPhoneAdd({ kakao_id: newKakaoId.trim() },
                `카카오톡 ID '${newKakaoId.trim()}' 를 폰에서 검색해 추가하는 중입니다. 끝날 때까지 폰을 만지지 마세요.`);
            return;
        }
        if (addMode !== 'list') {
            showNotice(addMode === 'phone' ? '이름과 전화번호를 모두 입력하세요.' : '카카오톡 ID를 입력하세요.');
            return;
        }
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

    const syncFriends = async (mode = 'auto') => {
        try {
            await call('/contacts/sync', { method: 'POST', body: { mode } });
            showNotice(mode === 'full'
                ? '휴대폰에서 친구 목록 전체를 읽는 중입니다. 끝날 때까지 폰을 만지지 마세요.'
                : '휴대폰에서 바뀐 친구를 확인하는 중입니다. 끝날 때까지 폰을 만지지 마세요.');
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
                const parts = result.mode === 'incremental'
                    ? [result.added ? `새 친구 ${result.added}명 추가` : '바뀐 친구가 없습니다', `최근 추가 ${result.total}명만 확인`]
                    : [`친구 ${result.total}명을 모두 읽었습니다 (카카오톡 표시 ${result.expected}명, 추천친구·채널 제외)`, `새로 ${result.added}명 추가`];
                if (result.fallback) parts.unshift('변경이 감지되어 전체를 다시 읽었습니다');
                if (result.duplicates.length) parts.push(`동명이인 ${result.duplicates.length}명(전송 불가)`);
                if (result.missingCount) parts.push(`폰에 없는 기존 친구 ${result.missingCount}명('폰에 없음' 표시, 삭제하지 않음)`);
                showNotice(parts.join(' · '));
            }
            loadContacts();
        }
        return undefined;
    }, [syncing, status, loadStatus, loadContacts, showNotice]);

    const isoDay = (offset = 0) => {
        const d = new Date();
        d.setDate(d.getDate() - offset);
        const p = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    };

    const roomSyncing = !!status?.roomSync?.running;
    const wasRoomSyncing = useRef(false);
    const anySyncing = syncing || roomSyncing;

    const openRoomSync = () => {
        setRoomSince((v) => v || isoDay(7));
        setRoomSyncOpen((v) => !v);
    };

    const syncRoom = async () => {
        if (!selected || !roomSince) return;
        try {
            await call(`/contacts/${selected.id}/sync-room`, { method: 'POST', body: { since: roomSince } });
            setRoomSyncOpen(false);
            showNotice(`${selected.name} 님과의 대화를 ${roomSince}부터 폰에서 읽는 중입니다. 끝날 때까지 폰을 만지지 마세요.`);
            loadStatus();
        } catch (err) {
            showNotice(err.message);
        }
    };

    useEffect(() => {
        if (roomSyncing) {
            wasRoomSyncing.current = true;
            const timer = window.setInterval(loadStatus, 1500);
            return () => window.clearInterval(timer);
        }
        if (wasRoomSyncing.current && status?.roomSync) {
            wasRoomSyncing.current = false;
            const { result, error } = status.roomSync;
            if (error) showNotice(`대화 동기화 실패: ${error}`);
            else if (result) showNotice(`${result.since}부터 대화 ${result.read}개를 확인해 ${result.added}개를 가져왔습니다.${result.removed ? ` 전송 실패·확인 필요·취소 기록 ${result.removed}건은 지웠습니다.` : ''}`);
            loadMessages(selectedId);
        }
        return undefined;
    }, [roomSyncing, status, loadStatus, loadMessages, selectedId, showNotice]);

    const addingFriend = !!status?.addFriend?.running;
    const wasAddingFriend = useRef(false);
    useEffect(() => {
        if (addingFriend) {
            wasAddingFriend.current = true;
            const timer = window.setInterval(loadStatus, 1500);
            return () => window.clearInterval(timer);
        }
        if (wasAddingFriend.current && status?.addFriend) {
            wasAddingFriend.current = false;
            const { result, error } = status.addFriend;
            if (error) showNotice(`친구 추가 실패: ${error}`);
            else if (result?.renamedFrom) showNotice(`'${result.renamedFrom}' → '${result.name}' 이름을 바꿨습니다. 대화 기록은 그대로 유지됩니다.`);
            else if (result) showNotice(result.already ? `'${result.name}' 님은 이미 카카오톡 친구입니다. 목록에 추가했습니다.` : `'${result.name}' 님을 폰의 카카오톡 친구로 추가했습니다.`);
            loadContacts();
        }
        return undefined;
    }, [addingFriend, status, loadStatus, loadContacts, showNotice]);

    const startRename = async () => {
        const next = renameValue.trim();
        if (!selected || !next) return;
        try {
            await call(`/contacts/${selected.id}/rename`, { method: 'POST', body: { new_name: next } });
            setRenameOpen(false);
            showNotice(`'${selected.name}' 님의 이름을 폰의 카카오톡에서 '${next}'(으)로 바꾸는 중입니다. 끝날 때까지 폰을 만지지 마세요.`);
            loadStatus();
        } catch (err) {
            showNotice(err.message);
        }
    };

    const pickList = (list) => {
        if (activeListId === list.id) {
            setActiveListId(null);
            setActiveMembers(null);
            return;
        }
        setActiveMembers(null);
        setActiveListId(list.id);
        setRail('chats');
        setQuery('');
        setSearchOpen(false);
        setAdding(false);
    };

    const removeList = async (list) => {
        if (!window.confirm(`'${list.name}' 리스트를 삭제할까요?\n친구와 대화 기록은 그대로 남습니다.`)) return;
        try {
            await call(`/lists/${list.id}`, { method: 'DELETE' });
            if (activeListId === list.id) { setActiveListId(null); setActiveMembers(null); }
            loadLists();
        } catch (err) {
            showNotice(err.message);
        }
    };

    const refreshRunning = !!status?.refresh?.running;
    const wasRefreshing = useRef(false);
    useEffect(() => {
        if (refreshRunning) {
            wasRefreshing.current = true;
            const timer = window.setInterval(loadStatus, 1500);
            return () => window.clearInterval(timer);
        }
        if (wasRefreshing.current && status?.refresh) {
            wasRefreshing.current = false;
            const { result, error } = status.refresh;
            if (error) showNotice(`최신화 실패: ${error}`);
            else if (result) {
                const parts = [`최신화 완료 · 방 ${result.importedRooms}개에서 ${result.importedMessages}건을 가져왔습니다`];
                if (result.registered?.length) parts.push(`새 친구 ${result.registered.length}명 자동 등록`);
                showNotice(parts.join(' · '));
            }
            loadContacts();
        }
        return undefined;
    }, [refreshRunning, status, loadStatus, loadContacts, showNotice]);

    const ackNew = async (contactId) => {
        try {
            await call('/contacts/ack-new', { method: 'POST', body: contactId ? { contact_id: contactId } : {} });
            loadContacts();
            loadStatus();
        } catch (err) {
            showNotice(err.message);
        }
    };

    const excludeNew = async (contact) => {
        if (!window.confirm(`'${contact.name}' 방을 목록에서 지우고, 앞으로 자동 등록하지 않을까요?`)) return;
        try {
            await call(`/contacts/${contact.id}/exclude`, { method: 'POST' });
            if (selectedId === contact.id) setSelectedId(null);
            showNotice(`'${contact.name}' 방을 제외했습니다.`);
            loadContacts();
            loadStatus();
        } catch (err) {
            showNotice(err.message);
        }
    };

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

    const isGroup = selected?.kind === 'group';

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

        if (m.direction === 'in') {
            const who = isGroup ? (m.sender || '(보낸 사람 모름)') : selected.name;
            const sameSenderAbove = prev && !prev.dryRun && prev.direction === 'in' && (!isGroup || (prev.sender || '') === (m.sender || ''))
                && dayKey(prev.createdAt) === dayKey(m.createdAt);
            return (
                <div key={m.id}>
                    {dayDivider}
                    <div className={styles.rowTheirs}>
                        <span className={styles.theirAvatar}>{!sameSenderAbove && <Avatar name={who} size={36} />}</span>
                        <div className={styles.theirCol}>
                            {!sameSenderAbove && <span className={styles.theirName}>{who}</span>}
                            <div className={`${styles.bubbleTheirs} ${!sameSenderAbove ? styles.bubbleTheirsTail : ''}`}>{m.text}</div>
                        </div>
                    </div>
                </div>
            );
        }

        const sameMinuteAsNext = m.timeKnown && next && !next.dryRun && next.direction !== 'in' && next.timeKnown
            && minuteKey(next.createdAt) === minuteKey(m.createdAt);
        const startsGroup = !prev || prev.dryRun || prev.direction === 'in' || !m.timeKnown
            || minuteKey(prev.createdAt) !== minuteKey(m.createdAt);
        const settled = m.status === 'sent';
        return (
            <div key={m.id}>
                {dayDivider}
                <div className={styles.rowMine}>
                    <div className={styles.meta}>
                        {m.status === 'cancelled' && <span className={styles.pending}>취소됨</span>}
                        {m.status === 'queued' && (
                            <span className={styles.pending}>
                                {m.error || `대기 중${m.queuePosition ? ` (앞 ${m.queuePosition}건)` : ''}`}
                                <button type="button" onClick={() => act(`/messages/${m.id}/cancel`, { method: 'POST' })}>취소</button>
                            </span>
                        )}
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
                        {settled && m.timeKnown && !sameMinuteAsNext && <span className={styles.time}>{clock(m.sentAt || m.createdAt)}</span>}
                    </div>
                    {m.kind === 'image' ? (
                        <div className={`${styles.imgGrid} ${m.mediaIds.length === 1 ? styles.imgOne : ''} ${m.status === 'failed' ? styles.bubbleFailed : ''}`}>
                            {m.mediaIds.map((id) => <AuthImage key={id} mediaId={id} className={styles.imgThumb} />)}
                        </div>
                    ) : (
                        <div className={`${styles.bubble} ${startsGroup ? styles.bubbleTail : ''} ${m.status === 'failed' ? styles.bubbleFailed : ''}`}>
                            {m.text}
                        </div>
                    )}
                </div>
                {m.status === 'failed' && m.error && <div className={styles.errorLine}>{m.error}</div>}
            </div>
        );
    };

    const connected = status?.bound;
    const canSend = !!selected && (!!draft.trim() || photosReady);

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
                        {queueItems.length > 0 && (
                            <>
                                <div className={styles.cardTitle} style={{ marginTop: 12 }}>
                                    대기 목록 ({queueItems.length})
                                    {queueItems.some((m) => m.status === 'queued') && (
                                        <button
                                            type="button"
                                            className={styles.btn}
                                            style={{ marginLeft: 'auto' }}
                                            onClick={async () => {
                                                if (!window.confirm('대기 중인 메시지를 모두 취소할까요? (전송 중·확인 필요는 그대로 둡니다)')) return;
                                                try {
                                                    const r = await call('/queue/cancel-all', { method: 'POST' });
                                                    showNotice(`대기 ${r.cancelled}건을 취소했습니다.`);
                                                } catch (err) { showNotice(err.message); }
                                                loadStatus();
                                            }}
                                        >
                                            대기 전체 취소
                                        </button>
                                    )}
                                </div>
                                {queueItems.map((m) => (
                                    <div key={m.id} className={styles.kv} style={{ alignItems: 'flex-start', gap: 8 }}>
                                        <span style={{ flex: 1, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                                            <b>{m.contactName || `#${m.contactId}`}</b>{' '}
                                            {m.kind === 'image' ? `(사진 ${m.mediaIds.length}장)` : m.text.length > 60 ? `${m.text.slice(0, 60)}…` : m.text}
                                            <em style={{ marginLeft: 6 }}>
                                                {{ queued: '대기', sending: '전송 중', needs_check: '확인 필요' }[m.status]}
                                            </em>
                                        </span>
                                        {m.status === 'queued' && (
                                            <button type="button" className={styles.btn} onClick={async () => {
                                                try { await call(`/messages/${m.id}/cancel`, { method: 'POST' }); } catch (err) { showNotice(err.message); }
                                                loadStatus();
                                            }}>취소</button>
                                        )}
                                        {m.status === 'needs_check' && (
                                            <>
                                                <button type="button" className={styles.btn} onClick={async () => {
                                                    try { await call(`/messages/${m.id}/resolve`, { method: 'POST', body: { status: 'sent' } }); } catch (err) { showNotice(err.message); }
                                                    loadStatus();
                                                }}>보냄</button>
                                                <button type="button" className={styles.btn} onClick={async () => {
                                                    try { await call(`/messages/${m.id}/resolve`, { method: 'POST', body: { status: 'failed' } }); } catch (err) { showNotice(err.message); }
                                                    loadStatus();
                                                }}>안 보냄</button>
                                            </>
                                        )}
                                    </div>
                                ))}
                            </>
                        )}
                    </div>
                </div>
            );
        }

        const listActive = !!activeListId && !!activeMembers;
        const activeList = lists.find((l) => l.id === activeListId);
        // 리스트를 고르면 대화 기록 유무와 상관없이 그 리스트의 사람들을 모두 보여 준다
        const baseRows = listActive ? filtered.filter((c) => activeMembers.has(c.id)) : (rail === 'chats' ? chatList : filtered);
        const chatStyle = rail === 'chats' || listActive;
        // 마지막 메시지가 거래처(상대방)가 보낸 것 = 답장이 온(내가 아직 답하지 않은) 방
        const awaiting = (c) => c.lastDirection === 'in';
        const awaitingCount = baseRows.filter(awaiting).length;
        const rows = chatStyle && repliedOnly ? baseRows.filter(awaiting) : baseRows;
        return (
            <>
                <div className={styles.panelHeader}>
                    <h2>{rail === 'friends' ? '친구' : '채팅'}</h2>
                    <div className={styles.panelIcons}>
                        <button type="button" title="검색" onClick={() => { setSearchOpen((v) => !v); setQuery(''); }}><Search size={18} /></button>
                        <button type="button" className={styles.refreshIconBtn} title="최신화 — 폰의 새 대화 가져오기" onClick={() => setRefreshOpen(true)}>
                            <RefreshCw size={18} className={refreshRunning ? styles.spin : ''} />
                            {status?.newContacts > 0 && <i className={styles.iconDot} />}
                        </button>
                        <button type="button" title="일괄 전송" onClick={() => setBulkOpen(true)}><Send size={18} /></button>
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
                        <div className={styles.modeRow}>
                            {[['phone', '전화번호'], ['id', '카카오톡 ID'], ['list', '목록만']].map(([key, label]) => (
                                <button key={key} type="button" className={addMode === key ? styles.modeOn : ''} onClick={() => setAddMode(key)}>{label}</button>
                            ))}
                        </div>
                        {addMode !== 'id' && (
                            <input
                                autoFocus
                                className={styles.fullInput}
                                placeholder="친구 이름"
                                value={newName}
                                onChange={(e) => setNewName(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) addContact(); }}
                            />
                        )}
                        {addMode === 'phone' && (
                            <input
                                className={styles.fullInput}
                                placeholder="전화번호 (예: 010-1234-5678)"
                                inputMode="tel"
                                value={newPhone}
                                onChange={(e) => setNewPhone(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) addContact(); }}
                            />
                        )}
                        {addMode === 'id' && (
                            <input
                                autoFocus
                                className={styles.fullInput}
                                placeholder="상대의 카카오톡 ID"
                                value={newKakaoId}
                                onChange={(e) => setNewKakaoId(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) addContact(); }}
                            />
                        )}
                        <button type="button" className={`${styles.btnYellow} ${styles.fullInput}`} disabled={addMode !== 'list' && (addingFriend || anySyncing)} onClick={addContact}>
                            <Plus size={14} /> {addMode === 'list' ? '목록에 추가' : '폰에 친구 추가'}
                        </button>
                        <p>
                            {addMode === 'phone' && '폰의 카카오톡에 이름·전화번호로 친구를 추가합니다(카카오톡 가입자만 추가됨). 전화번호는 저장하지 않습니다.'}
                            {addMode === 'id' && '폰의 카카오톡에서 이 ID를 검색해 친구로 추가합니다. 이름은 상대 프로필의 닉네임으로 저장됩니다. (ID 검색을 허용한 계정만 찾을 수 있습니다)'}
                            {addMode === 'list' && '이미 폰에 있는 친구를 목록에만 추가합니다. 이름은 폰의 친구 이름과 정확히 같아야 합니다.'}
                        </p>
                    </div>
                )}
                {contacts.some((c) => c.isNew) && (
                    <div className={styles.newBanner}>
                        <div className={styles.newBannerHead}>
                            <b>새 친구 {contacts.filter((c) => c.isNew).length}명이 자동 등록되었습니다</b>
                            <button type="button" onClick={() => ackNew()}>모두 확인</button>
                        </div>
                        <div className={styles.newBannerNames}>
                            {contacts.filter((c) => c.isNew).slice(0, 8).map((c) => (
                                <button key={c.id} type="button" onClick={() => { openChat(c); ackNew(c.id); }}>{c.name}</button>
                            ))}
                            {contacts.filter((c) => c.isNew).length > 8 && <span>외 {contacts.filter((c) => c.isNew).length - 8}명</span>}
                        </div>
                    </div>
                )}
                {chatStyle && (
                    <div className={styles.replyFilter}>
                        <button
                            type="button"
                            className={repliedOnly ? styles.replyFilterOn : ''}
                            title="마지막 메시지가 거래처(상대방)가 보낸 답장인 방만 모아 봅니다."
                            onClick={() => setRepliedOnly((v) => !v)}
                        >
                            <i className={styles.replyDot} /> 답장 온 방만 보기 <b>{awaitingCount}</b>
                        </button>
                    </div>
                )}
                {activeListId && (
                    <div className={styles.listBanner}>
                        <span>리스트 · <b>{activeList?.name || '…'}</b> ({rows.length}명)</span>
                        <button type="button" onClick={() => { setActiveListId(null); setActiveMembers(null); }}>전체 보기 <X size={12} /></button>
                    </div>
                )}
                {rail === 'friends' && !activeListId && (
                    <div className={styles.sectionLabel}>
                        <span>친구 {filtered.length}</span>
                        <span className={styles.syncGroup}>
                            <button
                                type="button"
                                className={styles.syncBtn}
                                disabled={anySyncing}
                                title="최근에 추가된 친구만 확인해서 바뀐 것만 반영합니다. 처음에는 전체를 읽습니다. 읽는 동안 폰을 만지지 마세요."
                                onClick={() => syncFriends('auto')}
                            >
                                <RefreshCw size={12} className={syncing ? styles.spin : ''} />
                                {syncing ? '동기화 중…' : '폰에서 동기화'}
                            </button>
                            <button
                                type="button"
                                className={styles.syncBtn}
                                disabled={anySyncing}
                                title="친구 목록 전체를 처음부터 다시 읽습니다(이름 변경·삭제까지 확인, 1~2분)."
                                onClick={() => syncFriends('full')}
                            >
                                전체
                            </button>
                        </span>
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
                            className={`${styles.item} ${c.id === selectedId ? styles.itemActive : ''} ${awaiting(c) ? styles.itemReplied : ''}`}
                            onClick={() => openChat(c)}
                            onKeyDown={(e) => { if (e.key === 'Enter') openChat(c); }}
                        >
                            <Avatar name={c.name} />
                            <div className={styles.itemBody}>
                                <div className={styles.itemName}>
                                    <span className={styles.itemNameText}>{c.name}</span>
                                    {c.isNew && <span className={styles.newBadge}>신규</span>}
                                    {c.kind === 'group' && <span className={styles.groupBadge}>단톡</span>}
                                    {!c.inPhone && <span className={styles.gone}>폰에 없음</span>}
                                </div>
                                {chatStyle
                                    ? <div className={styles.itemSub}>{c.lastText}</div>
                                    : c.memo && <div className={styles.itemSub}>{c.memo}</div>}
                            </div>
                            <div className={styles.itemSide}>
                                {chatStyle && c.lastAt && <span className={styles.itemTime}>{listTime(c.lastAt)}</span>}
                                {awaiting(c) && <span className={styles.replyTag}>답장</span>}
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
                                <span>{isGroup ? '단톡방 · 답변 가능 (일괄 전송 불가)' : (selected.memo || '나와의 1:1 채팅')}</span>
                            </div>
                            <button
                                type="button"
                                className={styles.headerBtn}
                                disabled={anySyncing || addingFriend}
                                title={isGroup ? '폰의 카카오톡에서 이 단톡방의 이름을 바꿉니다(내 폰에서만 보이는 이름).' : '폰의 카카오톡에서 이 친구의 이름을 바꿉니다(내 폰에서만 보이는 이름).'}
                                onClick={() => { setRenameValue(selected.name); setRenameOpen((v) => !v); setRoomSyncOpen(false); }}
                            >
                                <Pencil size={14} /> 이름 변경
                            </button>
                            <button
                                type="button"
                                className={styles.headerBtn}
                                disabled={anySyncing}
                                title="폰의 이 대화방을 위로 읽어서 선택한 날짜부터 현재까지의 대화를 웹과 맞춥니다."
                                onClick={openRoomSync}
                            >
                                <RefreshCw size={14} className={roomSyncing && status.roomSync.contactId === selected.id ? styles.spin : ''} />
                                {roomSyncing && status.roomSync.contactId === selected.id ? '동기화 중…' : '대화 동기화'}
                            </button>
                            <button type="button" className={styles.headerBtn} title="실제로 보내지 않고 상대·채팅방만 확인" onClick={() => submit(true)}>
                                <FlaskConical size={15} /> 전송 테스트
                            </button>
                            {renameOpen && (
                                <div className={styles.syncPop}>
                                    <b>{isGroup ? '단톡방 이름 변경' : '친구 이름 변경'}</b>
                                    {isGroup
                                        ? <p>폰의 카카오톡 채팅 목록에서 이 단톡방을 길게 눌러 “채팅방 정보 설정”으로 이름을 바꿉니다. 내 폰에서만 보이는 이름이며 다른 참여자에게는 바뀌지 않습니다. 대화 기록은 그대로 유지됩니다. 채팅 목록에서 방을 찾느라 20초쯤 걸립니다.</p>
                                        : <p>폰의 카카오톡 &gt; 친구 설정에서 이 친구의 이름을 바꿉니다. 내 폰에서만 보이는 이름이며 상대 계정은 바뀌지 않습니다. 대화 기록은 그대로 유지됩니다.</p>}
                                    <input
                                        autoFocus
                                        className={styles.fullInput}
                                        maxLength={isGroup ? 50 : 20}
                                        value={renameValue}
                                        onChange={(e) => setRenameValue(e.target.value)}
                                        onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) startRename(); }}
                                    />
                                    <div className={styles.popBtns}>
                                        <button type="button" className={styles.btn} onClick={() => setRenameOpen(false)}>닫기</button>
                                        <button
                                            type="button"
                                            className={styles.btnYellow}
                                            disabled={!renameValue.trim() || renameValue.trim() === selected.name || anySyncing || addingFriend}
                                            onClick={startRename}
                                        >
                                            이름 바꾸기
                                        </button>
                                    </div>
                                </div>
                            )}
                            {roomSyncOpen && (
                                <div className={styles.syncPop}>
                                    <b>대화 동기화</b>
                                    <p>선택한 날짜부터 지금까지, 폰 대화방에 있고 웹에 없는 대화만 가져옵니다. 읽는 동안 폰을 만지지 마세요.</p>
                                    <div className={styles.presetRow}>
                                        {[[0, '오늘'], [1, '어제'], [3, '3일'], [7, '7일'], [30, '30일']].map(([d, label]) => (
                                            <button key={label} type="button" className={roomSince === isoDay(d) ? styles.presetOn : ''} onClick={() => setRoomSince(isoDay(d))}>{label}</button>
                                        ))}
                                    </div>
                                    <input type="date" value={roomSince} max={isoDay(0)} onChange={(e) => setRoomSince(e.target.value)} />
                                    <div className={styles.popBtns}>
                                        <button type="button" className={styles.btn} onClick={() => setRoomSyncOpen(false)}>닫기</button>
                                        <button type="button" className={styles.btnYellow} disabled={!roomSince || anySyncing} onClick={syncRoom}>
                                            {roomSince ? `${roomSince}부터 동기화` : '날짜를 선택하세요'}
                                        </button>
                                    </div>
                                </div>
                            )}
                        </header>

                        {selected.isNew && (
                            <div className={styles.newChatNote}>
                                <b>신규</b> 최신화에서 자동 등록된 친구입니다. 맞는 친구인지 확인해 주세요.
                                <button type="button" onClick={() => ackNew(selected.id)}>맞아요</button>
                                <button type="button" className={styles.newChatExclude} onClick={() => excludeNew(selected)}>제외</button>
                            </div>
                        )}

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

                        {isGroup && (
                            <footer className={styles.groupNote}>
                                단톡방에도 답변할 수 있습니다. 이름이 정확히 같은 단톡방 한 곳을 폰에서 찾지 못하면 전송하지 않고 멈춥니다. 새 대화는 “최신화”나 “대화 동기화”로 가져오세요.
                            </footer>
                        )}
                        <footer className={styles.composer}>
                            {attachments.length > 0 && (
                                <div className={styles.attachRow}>
                                    {attachments.map((a) => (
                                        <div key={a.key} className={styles.attachItem} title={a.name}>
                                            <img src={a.preview} alt="" draggable={false} />
                                            {!a.id && <i className={styles.attachSpin} />}
                                            <button type="button" onClick={() => removeAttachment(a.key)} title="빼기"><X size={11} /></button>
                                        </div>
                                    ))}
                                    <span className={styles.attachCount}>{attachments.length}/{MAX_PHOTOS}</span>
                                </div>
                            )}
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
                                    <button type="button" className={styles.attachBtn} title={`사진 첨부 (최대 ${MAX_PHOTOS}장)`} onClick={() => fileInput.current?.click()}><Paperclip size={20} /></button>
                                    <input
                                        ref={fileInput}
                                        type="file"
                                        hidden
                                        multiple
                                        accept="image/jpeg,image/png,image/gif,image/webp"
                                        onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }}
                                    />
                                </div>
                                <button type="button" className={styles.sendBtn} disabled={!canSend} onClick={() => submit(false)}>
                                    전송
                                </button>
                            </div>
                        </footer>
                    </>
                )}
            </section>

            {lists.length > 0 && (
                <aside className={styles.listsCol}>
                    <header className={styles.listsHead}>
                        <b>리스트</b>
                        <span>{lists.length}</span>
                    </header>
                    <div className={styles.listsBody}>
                        {lists.map((l) => (
                            <div
                                key={l.id}
                                role="button"
                                tabIndex={0}
                                className={`${styles.listItem} ${activeListId === l.id ? styles.listItemOn : ''}`}
                                onClick={() => pickList(l)}
                                onKeyDown={(e) => { if (e.key === 'Enter') pickList(l); }}
                            >
                                <span className={styles.listName}>{l.name}</span>
                                <span className={styles.listCount}>{l.count}명</span>
                                <button
                                    type="button"
                                    className={styles.listDelete}
                                    title="리스트 삭제(친구와 대화는 그대로)"
                                    onClick={(e) => { e.stopPropagation(); removeList(l); }}
                                >
                                    <Trash2 size={13} />
                                </button>
                            </div>
                        ))}
                    </div>
                </aside>
            )}

            {refreshOpen && (
                <KakaoRefresh
                    status={status}
                    connected={!!connected}
                    onClose={() => setRefreshOpen(false)}
                    onNotice={showNotice}
                    onChanged={() => { loadStatus(); loadContacts(); }}
                />
            )}
            {bulkOpen && (
                <KakaoBulk
                    contacts={contacts}
                    connected={!!connected}
                    lists={lists}
                    onNotice={showNotice}
                    onClose={() => setBulkOpen(false)}
                    onListsChanged={loadLists}
                />
            )}
            {notice && <div className={styles.toast}>{notice}</div>}
        </div>
    );
};

export default KakaoTalkPage;
