import { useCallback, useEffect, useState } from 'react';
import styles from './CSPage.module.css';
import { LOCAL_API_BASE, getAuthHeaders, handleUnauthorized } from '../../lib/api';

const post = async (path, body) => {
    const res = await fetch(`${LOCAL_API_BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify(body),
    });
    if (handleUnauthorized(res)) throw new Error('로그인이 만료되었습니다.');
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.detail || '요청 실패');
    return data;
};

// 회수신청 모달: 전화번호로 이지어드민 주문 검색 → 주문 선택(CS 로그 표시) → 그 주문의 송장으로 회수접수.
export default function CSRecallModal({ phone = '', onClose }) {
    const [query, setQuery] = useState(phone);
    const [packs, setPacks] = useState(null);
    const [packId, setPackId] = useState(null);
    const [history, setHistory] = useState(null);
    const [busy, setBusy] = useState(false);
    const [logBusy, setLogBusy] = useState(false);
    const [error, setError] = useState('');
    const [recalling, setRecalling] = useState(false);
    const [recallError, setRecallError] = useState('');
    const [recalled, setRecalled] = useState({}); // 회수접수를 마친 합포 → true

    useEffect(() => {
        const onKey = (e) => e.key === 'Escape' && !recalling && onClose();
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onClose, recalling]);

    const search = useCallback(async (value) => {
        setBusy(true);
        setError('');
        setPackId(null);
        try {
            const data = await post('/cs/delivery/search', { phone: value });
            setPacks(data.packs || []);
            if (data.packs?.length === 1) setPackId(data.packs[0].pack);
        } catch (e) {
            setPacks(null);
            setError(e.message);
        } finally {
            setBusy(false);
        }
    }, []);

    // 문의 고객의 번호가 있으면 열자마자 검색한다.
    useEffect(() => {
        if (phone) search(phone);
    }, [phone, search]);

    // 주문을 고르면 그 주문의 C/S 이력을 불러온다.
    useEffect(() => {
        setHistory(null);
        setRecallError('');
        if (!packId) return undefined;
        let cancelled = false;
        setLogBusy(true);
        setError('');
        post('/cs/history', { pack: packId })
            .then((data) => !cancelled && setHistory(data.history || []))
            .catch((e) => !cancelled && setError(e.message))
            .finally(() => !cancelled && setLogBusy(false));
        return () => {
            cancelled = true;
        };
    }, [packId]);

    const current = (packs || []).find((p) => p.pack === packId);
    const invoice = current?.trans_no ? String(current.trans_no) : '';

    const recall = async () => {
        if (!invoice) return;
        const itemText = current.items.map((i) => `${i.name}${i.options ? ` ${i.options}` : ''} x${i.qty}`).join('\n');
        if (!window.confirm(`송장 ${invoice} 회수접수를 이지어드민에 등록할까요?\n\n${current.recv_name || '-'} · 주문번호 ${current.order_id}\n${itemText}\n\n문자는 발송되지 않고, 한 번 등록하면 되돌릴 수 없어요.`)) return;
        setRecalling(true);
        setRecallError('');
        try {
            const data = await post('/return-shipping/recall-pickup', { invoice });
            if (data.need_session) setRecallError('EZAdmin 세션이 없어요. 상단 EZAdmin 설정에서 세션을 등록해 주세요.');
            else if (!data.ok) setRecallError(data.error || data.detail || '회수접수 실패');
            else {
                setRecalled((r) => ({ ...r, [packId]: true }));
                post('/cs/history', { pack: packId }).then((d) => setHistory(d.history || [])).catch(() => {});
            }
        } catch (e) {
            setRecallError(e.message || '요청 실패');
        } finally {
            setRecalling(false);
        }
    };

    return (
        <div className={styles.modalOverlay} onClick={recalling ? undefined : onClose}>
            <div className={styles.modal} style={{ maxWidth: 600 }} role="dialog" aria-label="회수신청" onClick={(e) => e.stopPropagation()}>
                <div className={styles.modalHead}>
                    <strong>회수신청</strong>
                    <span className={styles.modalSub}>전화번호로 주문 검색 (최근 30일)</span>
                    <button type="button" className={styles.modalClose} onClick={onClose} disabled={recalling} aria-label="닫기">×</button>
                </div>
                <div className={styles.modalBody}>
                    <div className={styles.deliverySearch}>
                        <input
                            value={query}
                            placeholder="010-1234-5678"
                            onChange={(e) => setQuery(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && !busy && search(query)}
                        />
                        <button type="button" className={styles.btn} disabled={busy || !query.trim()} onClick={() => search(query)}>
                            {busy ? '검색 중...' : '검색'}
                        </button>
                    </div>
                    {error && <div className={styles.error}>{error}</div>}
                    {packs && packs.length === 0 && <div className={styles.hint}>이 번호로 검색된 주문이 없어요.</div>}
                    {packs && packs.length > 1 && <div className={styles.hint}>주문이 {packs.length}건 검색됐어요. 회수할 주문을 선택하세요.</div>}

                    <div className={styles.deliveryList}>
                        {(packs || []).map((p) => (
                            <button
                                type="button"
                                key={p.pack}
                                className={`${styles.deliveryItem} ${packId === p.pack ? styles.deliveryItemOn : ''}`}
                                onClick={() => setPackId(p.pack)}
                            >
                                <div className={styles.deliveryTop}>
                                    <strong>{p.recv_name || '-'}</strong>
                                    <span className={styles.sideMuted}>{p.collect_date} · {p.shop_name}</span>
                                    <span className={p.trans_no ? styles.deliveryHas : styles.deliveryNone}>
                                        {recalled[p.pack] ? '회수접수 완료' : p.trans_no ? '송장 있음' : '송장 없음'}
                                    </span>
                                </div>
                                <div className={styles.sideMuted}>
                                    {p.items.map((i) => `${i.name}${i.options ? ` ${i.options}` : ''} x${i.qty}`).join(' / ')}
                                </div>
                                <div className={styles.sideMuted}>주문번호 {p.order_id}</div>
                            </button>
                        ))}
                    </div>

                    {current && (
                        <div className={styles.deliveryResult}>
                            <h4>회수신청</h4>
                            {invoice ? (
                                <div className={styles.deliveryInvoice}>
                                    <span className={styles.sideMuted}>송장번호</span>
                                    <b>{invoice}</b>
                                    {current.trans_corp && <span className={styles.sideMuted}>{current.trans_corp}</span>}
                                </div>
                            ) : (
                                <div className={styles.sideMuted}>송장이 아직 없는 주문이라 회수신청할 수 없어요.</div>
                            )}
                            {recallError && <div className={styles.error}>{recallError}</div>}
                            {recalled[packId] ? (
                                <div className={styles.hint}>이지어드민에 회수접수를 등록했어요. 아래 C/S 이력에서 확인할 수 있어요.</div>
                            ) : (
                                <div className={styles.replyActions}>
                                    <button type="button" className={styles.btn} disabled={!invoice || recalling} onClick={recall}>
                                        {recalling ? '처리 중...' : '회수신청 (회수접수만)'}
                                    </button>
                                </div>
                            )}
                        </div>
                    )}

                    {packId && (
                        <div className={styles.deliveryResult}>
                            <h4>C/S 이력{history ? ` (${history.length}건)` : ''}</h4>
                            {logBusy && <div className={styles.sideMuted}>불러오는 중...</div>}
                            {history && history.length === 0 && <div className={styles.sideMuted}>C/S 이력이 없어요.</div>}
                            <ol className={styles.csLogList}>
                                {(history || []).map((h) => (
                                    <li key={h.id || `${h.time}:${h.type}`}>
                                        <div className={styles.csLogTop}>
                                            <span className={styles.csLogType}>{h.type_name}</span>
                                            <span className={styles.sideMuted}>{h.time}</span>
                                            <span className={styles.csLogWriter}>{h.writer}</span>
                                        </div>
                                        {h.content && <div className={styles.csLogText}>{h.content}</div>}
                                        {h.reply && (
                                            <div className={styles.csLogReply}>
                                                답변{h.reply_writer ? ` (${h.reply_writer})` : ''}: {h.reply}
                                            </div>
                                        )}
                                    </li>
                                ))}
                            </ol>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
