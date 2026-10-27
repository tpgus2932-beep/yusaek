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

// '20261027' / '20261027105514' → '10/27' / '10/27 10:55'
const fmtScan = (raw) => {
    const d = String(raw || '').replace(/\D/g, '');
    if (d.length < 8) return '-';
    const day = `${Number(d.slice(4, 6))}/${Number(d.slice(6, 8))}`;
    return d.length >= 12 ? `${day} ${d.slice(8, 10)}:${d.slice(10, 12)}` : day;
};

const copy = (text) => {
    try {
        navigator.clipboard?.writeText(text);
    } catch { /* 복사 실패는 무시 */ }
};

// 배송 확인 모달: 전화번호로 이지어드민 주문을 검색 → 주문을 고르면 송장번호를 보여준다.
export default function CSDeliveryModal({ phone = '', onClose }) {
    const [query, setQuery] = useState(phone);
    const [packs, setPacks] = useState(null);
    const [picked, setPicked] = useState(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [track, setTrack] = useState(null); // 롯데택배 조회 결과
    const [trackBusy, setTrackBusy] = useState(false);
    const [trackError, setTrackError] = useState('');

    useEffect(() => {
        const onKey = (e) => e.key === 'Escape' && onClose();
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onClose]);

    const search = useCallback(async (value) => {
        setBusy(true);
        setError('');
        setPicked(null);
        try {
            const data = await post('/cs/delivery/search', { phone: value });
            setPacks(data.packs || []);
            if (data.packs?.length === 1) setPicked(data.packs[0].pack);
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

    const current = (packs || []).find((p) => p.pack === picked);
    const invoice = current?.trans_no || '';

    // 주문을 고르면 송장번호로 롯데택배 배송 상태를 바로 조회한다.
    useEffect(() => {
        setTrack(null);
        setTrackError('');
        if (!invoice) return undefined;
        let cancelled = false;
        setTrackBusy(true);
        post('/cs/delivery/track', { invoice })
            .then((data) => !cancelled && setTrack(data))
            .catch((e) => !cancelled && setTrackError(e.message))
            .finally(() => !cancelled && setTrackBusy(false));
        return () => {
            cancelled = true;
        };
    }, [invoice]);

    return (
        <div className={styles.modalOverlay} onClick={onClose}>
            <div className={styles.modal} style={{ maxWidth: 560 }} role="dialog" aria-label="배송 확인" onClick={(e) => e.stopPropagation()}>
                <div className={styles.modalHead}>
                    <strong>배송 확인</strong>
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
                                className={`${styles.deliveryItem} ${picked === p.pack ? styles.deliveryItemOn : ''}`}
                                onClick={() => setPicked(p.pack)}
                            >
                                <div className={styles.deliveryTop}>
                                    <strong>{p.recv_name || '-'}</strong>
                                    <span className={styles.sideMuted}>{p.collect_date} · {p.shop_name}</span>
                                    <span className={p.trans_no ? styles.deliveryHas : styles.deliveryNone}>
                                        {p.trans_no ? '송장 있음' : '송장 없음'}
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
                            <h4>송장번호</h4>
                            {current.trans_no ? (
                                <div className={styles.deliveryInvoice}>
                                    <b>{current.trans_no}</b>
                                    {current.trans_corp && <span className={styles.sideMuted}>{current.trans_corp}</span>}
                                    <button type="button" className={styles.linkBtn} onClick={() => copy(current.trans_no)}>복사</button>
                                </div>
                            ) : (
                                <div className={styles.sideMuted}>아직 송장이 발행되지 않았어요.</div>
                            )}
                            <div className={styles.sideMuted}>{current.address}</div>
                            {invoice && (
                                <div className={styles.deliveryTrack}>
                                    {trackBusy && <div className={styles.sideMuted}>롯데택배 조회 중...</div>}
                                    {trackError && <div className={styles.error}>{trackError}</div>}
                                    {track && !track.found && (
                                        <div className={styles.sideMuted}>롯데택배에서 이 송장을 찾지 못했어요. (다른 택배사이거나 아직 집화 전일 수 있어요)</div>
                                    )}
                                    {track?.found && (
                                        <>
                                            <div className={styles.deliveryNow}>
                                                <b>{track.delivered_date ? '배송 완료' : track.latest?.status || '이동이력 없음'}</b>
                                                {track.latest && (
                                                    <span className={styles.sideMuted}>{track.latest.location} · {fmtScan(track.latest.scan_date)}</span>
                                                )}
                                            </div>
                                            <ol className={styles.deliveryHistory}>
                                                {track.history.map((h, i) => (
                                                    <li key={i}>
                                                        <span className={styles.sideMuted}>{fmtScan(h.scan_date)}</span>
                                                        <span>{h.status}</span>
                                                        <span className={styles.sideMuted}>{h.location}</span>
                                                    </li>
                                                ))}
                                            </ol>
                                        </>
                                    )}
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
