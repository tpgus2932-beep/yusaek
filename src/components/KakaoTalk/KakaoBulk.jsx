import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Paperclip, Search, X } from 'lucide-react';
import styles from './KakaoBulk.module.css';
import { call, newRequestId, uploadPhoto } from './kakaoApi';

const MAX_PHOTOS = 10;
const MAX_TEXT = 2000;
const MAX_LIST_NAME = 30;
const INTERVALS = [0, 3, 5, 10, 20, 30];
const STATUS_LABEL = {
    queued: '대기',
    sending: '전송 중',
    sent: '보냄',
    failed: '실패',
    needs_check: '확인 필요',
    cancelled: '취소됨',
};

const fmtTime = (iso) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const countOf = (counts, ...keys) => keys.reduce((sum, key) => sum + (counts?.[key] || 0), 0);

/**
 * 일괄전송 모달. 바깥(어두운 영역)을 눌러도, ESC를 눌러도 닫히지 않고 '닫기' 버튼으로만 닫힌다.
 * 받는 사람을 여러 명 고르고 메시지(와 사진)를 한 번 지정하면 사람마다 하나씩 큐에 쌓여 차례로 나간다.
 * 시작할 때 '리스트 만들기' 창이 떠서, 이름을 주면 받는 사람들이 리스트로 묶인다.
 */
const KakaoBulk = ({ contacts, connected, lists, onNotice, onClose, onListsChanged }) => {
    const [query, setQuery] = useState('');
    const [picked, setPicked] = useState(() => new Set());
    const [hideGone, setHideGone] = useState(true);
    const [text, setText] = useState('');
    const [interval, setIntervalSec] = useState(5);
    const [attachments, setAttachments] = useState([]); // {key, name, preview, id}
    const [sending, setSending] = useState(false);
    const [confirmOpen, setConfirmOpen] = useState(false);
    const [listName, setListName] = useState('');
    const [batches, setBatches] = useState([]);
    const [openId, setOpenId] = useState(null);
    const [detail, setDetail] = useState([]);
    const fileInput = useRef(null);

    const sendable = useMemo(
        () => contacts.filter((c) => c.kind !== 'group' && (!hideGone || (c.inPhone && !String(c.memo || '').includes('전송 불가')))),
        [contacts, hideGone],
    );
    const visible = useMemo(() => {
        const q = query.trim().toLowerCase();
        return sendable.filter((c) => !q || c.name.toLowerCase().includes(q));
    }, [sendable, query]);
    const pickedList = useMemo(() => contacts.filter((c) => picked.has(c.id)), [contacts, picked]);
    const photosReady = attachments.length > 0 && attachments.every((a) => a.id);

    const loadBatches = useCallback(async () => {
        try {
            setBatches((await call('/bulk')).batches || []);
        } catch {
            /* 다음 폴링에서 복구 */
        }
    }, []);

    useEffect(() => {
        loadBatches();
        const timer = window.setInterval(loadBatches, 2500);
        return () => window.clearInterval(timer);
    }, [loadBatches]);

    useEffect(() => {
        if (!openId) return undefined;
        let alive = true;
        const load = async () => {
            try {
                const data = await call(`/bulk/${openId}`);
                if (alive) setDetail(data.items || []);
            } catch {
                /* ignore */
            }
        };
        load();
        const timer = window.setInterval(load, 2500);
        return () => { alive = false; window.clearInterval(timer); };
    }, [openId]);

    useEffect(() => () => attachments.forEach((a) => URL.revokeObjectURL(a.preview)), []); // eslint-disable-line react-hooks/exhaustive-deps

    const toggle = (id) => setPicked((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
    });
    const pickVisible = () => setPicked((prev) => new Set([...prev, ...visible.map((c) => c.id)]));
    const clearPicked = () => setPicked(new Set());

    const addFiles = (fileList) => {
        const files = Array.from(fileList || []).filter((f) => /^image\//.test(f.type) || /\.(jpe?g|png|gif|webp)$/i.test(f.name));
        if (!files.length) { onNotice('사진 파일(JPG, PNG, GIF, WEBP)만 첨부할 수 있습니다.'); return; }
        const room = MAX_PHOTOS - attachments.length;
        if (room <= 0) { onNotice(`사진은 ${MAX_PHOTOS}장까지 보낼 수 있습니다.`); return; }
        files.slice(0, room).forEach((file) => {
            const key = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
            setAttachments((list) => [...list, { key, name: file.name, preview: URL.createObjectURL(file), id: '' }]);
            uploadPhoto(file)
                .then((data) => setAttachments((list) => list.map((a) => (a.key === key ? { ...a, id: data.id } : a))))
                .catch((err) => {
                    onNotice(`${file.name}: ${err.message}`);
                    setAttachments((list) => list.filter((a) => a.key !== key));
                });
        });
    };
    const removeAttachment = (key) => setAttachments((list) => {
        const gone = list.find((a) => a.key === key);
        if (gone) URL.revokeObjectURL(gone.preview);
        return list.filter((a) => a.key !== key);
    });

    const messageCount = pickedList.length * ((text.trim() ? 1 : 0) + (photosReady ? 1 : 0));
    const etaMinutes = Math.max(1, Math.round((pickedList.length * (9 + interval) * (text.trim() && photosReady ? 1.6 : 1)) / 60));
    const preview = pickedList.length ? text.replace(/\{이름\}/g, pickedList[0].name) : text;
    const canStart = connected && pickedList.length > 0 && !sending && (text.trim() || photosReady)
        && !(attachments.length && !photosReady) && text.length <= MAX_TEXT;
    const trimmedListName = listName.replace(/\s+/g, ' ').trim();
    const existingList = lists.find((l) => l.name === trimmedListName);

    const openConfirm = () => {
        if (!canStart) return;
        setListName('');
        setConfirmOpen(true);
    };

    /** withList=false 이면 리스트를 만들지 않고 보낸다. */
    const start = async (withList) => {
        if (sending) return;
        if (withList && !trimmedListName) return;
        setSending(true);
        try {
            const data = await call('/bulk', {
                method: 'POST',
                body: {
                    contact_ids: pickedList.map((c) => c.id),
                    text,
                    media_ids: photosReady ? attachments.map((a) => a.id) : [],
                    interval_sec: interval,
                    list_name: withList ? trimmedListName : '',
                    request_id: newRequestId(),
                },
            });
            const listNote = data.listId ? ` · 리스트 '${data.listName}' ${data.listCreated ? '생성' : '에 추가'}` : '';
            onNotice(`${data.recipients}명에게 일괄 전송을 시작합니다.${listNote}${data.skipped ? ` (찾을 수 없는 ${data.skipped}명 제외)` : ''}`);
            attachments.forEach((a) => URL.revokeObjectURL(a.preview));
            setAttachments([]);
            setText('');
            setPicked(new Set());
            setConfirmOpen(false);
            setOpenId(data.batchId);
            loadBatches();
            onListsChanged();
        } catch (err) {
            onNotice(err.message);
        } finally {
            setSending(false);
        }
    };

    const batchAction = async (id, action, done) => {
        try {
            const data = await call(`/bulk/${id}/${action}`, { method: 'POST' });
            onNotice(done(data));
            loadBatches();
            if (openId === id) setDetail((await call(`/bulk/${id}`)).items || []);
        } catch (err) {
            onNotice(err.message);
        }
    };

    return (
        <div className={styles.overlay}>
            <div className={styles.modal} role="dialog" aria-modal="true" aria-label="일괄전송">
                <header className={styles.modalHead}>
                    <h2>일괄전송</h2>
                    <span>받는 사람 <b>{pickedList.length}</b>명 선택</span>
                    <button type="button" className={styles.closeBtn} onClick={onClose}>닫기</button>
                </header>

                <div className={styles.wrap}>
                    <section className={styles.picker}>
                        <div className={styles.searchBox}>
                            <Search size={14} />
                            <input placeholder="이름 검색" value={query} onChange={(e) => setQuery(e.target.value)} />
                            {query && <button type="button" onClick={() => setQuery('')}><X size={14} /></button>}
                        </div>
                        <div className={styles.pickTools}>
                            <button type="button" onClick={pickVisible}>보이는 {visible.length}명 선택</button>
                            <button type="button" onClick={clearPicked} disabled={!pickedList.length}>선택 해제</button>
                            <label>
                                <input type="checkbox" checked={hideGone} onChange={(e) => setHideGone(e.target.checked)} />
                                폰에 없는 친구·동명이인 숨김
                            </label>
                        </div>
                        <div className={styles.list}>
                            {visible.length === 0 && <div className={styles.empty}>보낼 수 있는 친구가 없습니다.</div>}
                            {visible.map((c) => (
                                <label key={c.id} className={`${styles.row} ${picked.has(c.id) ? styles.rowOn : ''}`}>
                                    <input type="checkbox" checked={picked.has(c.id)} onChange={() => toggle(c.id)} />
                                    <span className={styles.rowName}>{c.name}</span>
                                    {c.memo && <span className={styles.rowMemo}>{c.memo}</span>}
                                </label>
                            ))}
                        </div>
                    </section>

                    <section className={styles.main}>
                        <div className={styles.card}>
                            <h3>메시지 작성</h3>
                            <textarea
                                value={text}
                                placeholder="보낼 메시지를 입력하세요. {이름}을 쓰면 받는 사람 이름으로 바뀝니다. 예) {이름}님 안녕하세요"
                                onChange={(e) => setText(e.target.value)}
                            />
                            <div className={styles.cardMeta}>
                                <button type="button" onClick={() => setText((t) => `${t}{이름}`)}>+ {'{이름}'} 넣기</button>
                                <span className={text.length > MAX_TEXT ? styles.bad : ''}>{text.length}/{MAX_TEXT}</span>
                            </div>
                            {attachments.length > 0 && (
                                <div className={styles.attachRow}>
                                    {attachments.map((a) => (
                                        <div key={a.key} className={styles.attachItem} title={a.name}>
                                            <img src={a.preview} alt="" draggable={false} />
                                            {!a.id && <i className={styles.attachSpin} />}
                                            <button type="button" onClick={() => removeAttachment(a.key)}><X size={11} /></button>
                                        </div>
                                    ))}
                                </div>
                            )}
                            <div className={styles.options}>
                                <button type="button" className={styles.btn} onClick={() => fileInput.current?.click()}>
                                    <Paperclip size={14} /> 사진 첨부 ({attachments.length}/{MAX_PHOTOS})
                                </button>
                                <input
                                    ref={fileInput}
                                    type="file"
                                    hidden
                                    multiple
                                    accept="image/jpeg,image/png,image/gif,image/webp"
                                    onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }}
                                />
                                <label className={styles.intervalBox}>
                                    사람 사이 간격
                                    <select value={interval} onChange={(e) => setIntervalSec(Number(e.target.value))}>
                                        {INTERVALS.map((s) => <option key={s} value={s}>{s === 0 ? '없음' : `${s}초`}</option>)}
                                    </select>
                                </label>
                            </div>
                            {preview.trim() && pickedList.length > 0 && (
                                <div className={styles.preview}>
                                    <span>미리보기 · {pickedList[0].name}</span>
                                    <p>{preview}</p>
                                </div>
                            )}
                            <div className={styles.startRow}>
                                <div className={styles.hint}>
                                    {!connected ? '휴대폰이 연결되지 않았습니다. 왼쪽 아래 … 에서 먼저 연결하세요.'
                                        : pickedList.length === 0 ? '왼쪽에서 받는 사람을 선택하세요.'
                                            : `${pickedList.length}명 · 메시지 ${messageCount}건 · 예상 ${etaMinutes}분 이상`}
                                </div>
                                <button type="button" className={styles.start} disabled={!canStart} onClick={openConfirm}>
                                    {`${pickedList.length || ''}명에게 일괄 전송`}
                                </button>
                            </div>
                            <p className={styles.note}>
                                일반 메시지는 일괄 전송보다 먼저 나가고, 일괄 전송 중에도 취소할 수 있습니다. 한 번에 너무 많이 보내면 카카오톡이 스팸으로 볼 수 있으니 간격을 두세요.
                            </p>
                        </div>

                        <div className={styles.card}>
                            <h3>최근 일괄 전송</h3>
                            {batches.length === 0 && <div className={styles.empty}>아직 일괄 전송 기록이 없습니다.</div>}
                            {batches.map((b) => {
                                const done = countOf(b.counts, 'sent');
                                const failed = countOf(b.counts, 'failed');
                                const check = countOf(b.counts, 'needs_check');
                                const cancelled = countOf(b.counts, 'cancelled');
                                const waiting = countOf(b.counts, 'queued', 'sending');
                                const total = countOf(b.counts, 'sent', 'failed', 'needs_check', 'cancelled', 'queued', 'sending') || 1;
                                const open = openId === b.id;
                                return (
                                    <div key={b.id} className={styles.batch}>
                                        <button type="button" className={styles.batchHead} onClick={() => setOpenId(open ? null : b.id)}>
                                            <span className={styles.batchTitle}>
                                                {b.listName && <em className={styles.listTag}>{b.listName}</em>}
                                                {b.text.trim() ? b.text.replace(/\s+/g, ' ').slice(0, 40) : `(사진 ${b.photos}장)`}
                                                {b.text.trim() && b.photos > 0 && ` + 사진 ${b.photos}장`}
                                            </span>
                                            <span className={styles.batchMeta}>{b.recipients}명 · {fmtTime(b.createdAt)} · {b.createdByDisplay}</span>
                                        </button>
                                        <div className={styles.bar}>
                                            <i className={styles.barOk} style={{ width: `${(done / total) * 100}%` }} />
                                            <i className={styles.barBad} style={{ width: `${((failed + check) / total) * 100}%` }} />
                                            <i className={styles.barOff} style={{ width: `${(cancelled / total) * 100}%` }} />
                                        </div>
                                        <div className={styles.counts}>
                                            <span>보냄 {done}</span>
                                            {waiting > 0 && <span>대기 {waiting}</span>}
                                            {failed > 0 && <span className={styles.bad}>실패 {failed}</span>}
                                            {check > 0 && <span className={styles.warn}>확인 필요 {check}</span>}
                                            {cancelled > 0 && <span>취소 {cancelled}</span>}
                                            <span className={styles.spacer} />
                                            {waiting > 0 && (
                                                <button type="button" onClick={() => batchAction(b.id, 'cancel', (d) => `대기 중이던 ${d.cancelled}건을 취소했습니다.`)}>남은 것 취소</button>
                                            )}
                                            {failed > 0 && (
                                                <button type="button" onClick={() => batchAction(b.id, 'retry-failed', (d) => `실패한 ${d.retried}건을 다시 대기열에 넣었습니다.`)}>실패한 것만 다시</button>
                                            )}
                                        </div>
                                        {open && (
                                            <div className={styles.items}>
                                                {detail.map((item) => (
                                                    <div key={item.messageId} className={`${styles.item} ${styles[`s_${item.status}`] || ''}`}>
                                                        <span>{item.name}{item.kind === 'image' ? ' · 사진' : ''}</span>
                                                        <em>{STATUS_LABEL[item.status] || item.status}</em>
                                                        {item.error && item.status !== 'sent' && <small>{item.error}</small>}
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    </section>
                </div>

                {confirmOpen && (
                    <div className={`${styles.overlay} ${styles.overlayInner}`}>
                        <div className={styles.confirm} role="dialog" aria-modal="true" aria-label="리스트 만들기">
                            <h3>리스트 만들기</h3>
                            <p className={styles.confirmSummary}>
                                <b>{pickedList.length}명</b>에게 {[text.trim() && '메시지', photosReady && `사진 ${attachments.length}장`].filter(Boolean).join('와 ')}을(를)
                                {' '}차례로 보냅니다. (간격 {interval === 0 ? '없음' : `${interval}초`}, 예상 {etaMinutes}분 이상)
                            </p>
                            {preview.trim() && <div className={styles.confirmPreview}>{preview}</div>}
                            <label className={styles.confirmLabel}>
                                리스트 이름 <small>({MAX_LIST_NAME}자까지)</small>
                                <input
                                    autoFocus
                                    list="kakao-bulk-lists"
                                    maxLength={MAX_LIST_NAME}
                                    placeholder="예) 11월 공지 대상"
                                    value={listName}
                                    onChange={(e) => setListName(e.target.value)}
                                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && trimmedListName) start(true); }}
                                />
                                <datalist id="kakao-bulk-lists">
                                    {lists.map((l) => <option key={l.id} value={l.name} />)}
                                </datalist>
                            </label>
                            <p className={styles.confirmHint}>
                                {existingList
                                    ? `같은 이름의 리스트가 있어서 받는 사람 ${pickedList.length}명을 그 리스트에 추가합니다.`
                                    : '리스트를 만들면 오른쪽에 모여 보이고, 누르면 이 사람들의 채팅만 볼 수 있습니다.'}
                            </p>
                            <div className={styles.confirmBtns}>
                                <button type="button" className={styles.btn} disabled={sending} onClick={() => setConfirmOpen(false)}>취소</button>
                                <span className={styles.spacer} />
                                <button type="button" className={styles.btn} disabled={sending} onClick={() => start(false)}>
                                    {sending ? '등록 중…' : '리스트 없이 전송'}
                                </button>
                                <button type="button" className={styles.start} disabled={sending || !trimmedListName} onClick={() => start(true)}>
                                    {existingList ? '리스트에 추가하고 전송' : '리스트 만들고 전송'}
                                </button>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

export default KakaoBulk;
