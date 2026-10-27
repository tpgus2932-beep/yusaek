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

// CS 로그 확인 모달: 전화번호로 이지어드민 주문 검색 → 주문 선택 → C/S 이력 목록.
export default function CSLogModal({ phone = '', onClose }) {
    const [query, setQuery] = useState(phone);
    const [packs, setPacks] = useState(null);
    const [packId, setPackId] = useState(null);
    const [history, setHistory] = useState(null);
    const [busy, setBusy] = useState(false);
    const [logBusy, setLogBusy] = useState(false);
    const [error, setError] = useState('');

    useEffect(() => {
        const onKey = (e) => e.key === 'Escape' && onClose();
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onClose]);

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

    return (
        <div className={styles.modalOverlay} onClick={onClose}>
            <div className={styles.modal} style={{ maxWidth: 600 }} role="dialog" aria-label="CS 로그 확인" onClick={(e) => e.stopPropagation()}>
                <div className={styles.modalHead}>
                    <strong>CS 로그 확인</strong>
                    <span className={styles.modalSub}>전화번호로 주문 검색 (최근 30일)</span>
                    <button type="button" className={styles.modalClose} onClick={onClose} aria-label="닫기">×</button>
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
                    {packs && packs.length > 1 && <div className={styles.hint}>주문이 {packs.length}건 검색됐어요. 확인할 주문을 선택하세요.</div>}

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
                                </div>
                                <div className={styles.sideMuted}>
                                    {p.items.map((i) => `${i.name}${i.options ? ` ${i.options}` : ''} x${i.qty}`).join(' / ')}
                                </div>
                                <div className={styles.sideMuted}>주문번호 {p.order_id}</div>
                            </button>
                        ))}
                    </div>

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
