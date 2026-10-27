import { useCallback, useEffect, useMemo, useState } from 'react';
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

// 상품 교환 모달: 전화번호로 이지어드민 주문 검색 → 주문 선택 → 교환할 상품 선택 → 새 옵션 선택 → 교환 처리.
export default function CSExchangeModal({ phone = '', onClose }) {
    const [query, setQuery] = useState(phone);
    const [packs, setPacks] = useState(null);
    const [packId, setPackId] = useState(null);
    const [prdSeq, setPrdSeq] = useState(null);
    const [options, setOptions] = useState(null);
    const [optionFilter, setOptionFilter] = useState('');
    const [newId, setNewId] = useState('');
    const [qty, setQty] = useState(1);
    const [reason, setReason] = useState('');
    const [busy, setBusy] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const [done, setDone] = useState(null);

    useEffect(() => {
        const onKey = (e) => e.key === 'Escape' && !saving && onClose();
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onClose, saving]);

    const search = useCallback(async (value) => {
        setBusy(true);
        setError('');
        setDone(null);
        setPackId(null);
        setPrdSeq(null);
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

    const pack = (packs || []).find((p) => p.pack === packId);
    const item = pack?.items.find((i) => i.prd_seq === prdSeq);

    // 교환할 상품을 고르면 같은 상품의 옵션 목록을 불러온다.
    useEffect(() => {
        setOptions(null);
        setOptionFilter('');
        setNewId('');
        if (!item || !pack) return undefined;
        setQty(Number(item.qty) || 1);
        let cancelled = false;
        setBusy(true);
        post('/cs/exchange/options', { name: item.name, shop_id: pack.shop_id })
            .then((data) => !cancelled && setOptions(data.options || []))
            .catch((e) => !cancelled && setError(e.message))
            .finally(() => !cancelled && setBusy(false));
        return () => {
            cancelled = true;
        };
    }, [item, pack]);

    const visibleOptions = useMemo(() => {
        const q = optionFilter.trim().toLowerCase();
        return (options || []).filter((o) => o.product_id !== item?.product_id && (!q || o.options.toLowerCase().includes(q)));
    }, [options, optionFilter, item]);

    const target = (options || []).find((o) => o.product_id === newId);

    const submit = async () => {
        if (!item || !target) return;
        const ship = pack.trans_no ? `\n※ 이미 송장(${pack.trans_no})이 발행된 주문입니다.` : '';
        if (!window.confirm(`${item.name}\n${item.options}  →  ${target.options}\n수량 ${qty}개를 이지어드민에서 교환 처리할까요?${ship}`)) return;
        setSaving(true);
        setError('');
        try {
            setDone(await post('/cs/exchange/change', {
                pack: pack.pack,
                prd_seq: item.prd_seq,
                old_product_id: item.product_id,
                new_product_id: target.product_id,
                qty,
                reason,
                allow_shipped: Boolean(pack.trans_no),
            }));
        } catch (e) {
            setError(e.message);
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className={styles.modalOverlay} onClick={saving ? undefined : onClose}>
            <div className={styles.modal} style={{ maxWidth: 600 }} role="dialog" aria-label="상품 교환" onClick={(e) => e.stopPropagation()}>
                <div className={styles.modalHead}>
                    <strong>상품 교환</strong>
                    <span className={styles.modalSub}>전화번호로 주문 검색 (최근 30일)</span>
                    <button type="button" className={styles.modalClose} onClick={onClose} disabled={saving} aria-label="닫기">×</button>
                </div>
                <div className={styles.modalBody}>
                    {done ? (
                        <div className={styles.purchaseReturnForm}>
                            <div>교환 처리했어요. → {done.new_options} ({done.qty}개)</div>
                            {!done.verified && <div className={styles.error}>이지어드민에서 변경이 확인되지 않았어요. 주문을 직접 확인해 주세요.</div>}
                            <div className={styles.replyActions}>
                                <button type="button" className={styles.btn} onClick={onClose}>닫기</button>
                            </div>
                        </div>
                    ) : (
                        <>
                            <div className={styles.deliverySearch}>
                                <input
                                    value={query}
                                    placeholder="010-1234-5678"
                                    onChange={(e) => setQuery(e.target.value)}
                                    onKeyDown={(e) => e.key === 'Enter' && !busy && search(query)}
                                />
                                <button type="button" className={styles.btn} disabled={busy || saving || !query.trim()} onClick={() => search(query)}>
                                    {busy ? '조회 중...' : '검색'}
                                </button>
                            </div>
                            {error && <div className={styles.error}>{error}</div>}
                            {packs && packs.length === 0 && <div className={styles.hint}>이 번호로 검색된 주문이 없어요.</div>}
                            {packs && packs.length > 1 && <div className={styles.hint}>주문이 {packs.length}건 검색됐어요. 교환할 주문을 선택하세요.</div>}

                            <div className={styles.deliveryList}>
                                {(packs || []).map((p) => (
                                    <button
                                        type="button"
                                        key={p.pack}
                                        className={`${styles.deliveryItem} ${packId === p.pack ? styles.deliveryItemOn : ''}`}
                                        onClick={() => { setPackId(p.pack); setPrdSeq(null); }}
                                    >
                                        <div className={styles.deliveryTop}>
                                            <strong>{p.recv_name || '-'}</strong>
                                            <span className={styles.sideMuted}>{p.collect_date} · {p.shop_name}</span>
                                            <span className={p.trans_no ? styles.deliveryHas : styles.deliveryNone}>
                                                {p.trans_no ? '송장 발행됨' : '송장 없음'}
                                            </span>
                                        </div>
                                        <div className={styles.sideMuted}>주문번호 {p.order_id} · 상품 {p.items.length}개</div>
                                    </button>
                                ))}
                            </div>

                            {pack && (
                                <div className={styles.deliveryResult}>
                                    <h4>교환할 상품 선택</h4>
                                    <div className={styles.deliveryList}>
                                        {pack.items.map((i) => (
                                            <button
                                                type="button"
                                                key={i.prd_seq}
                                                className={`${styles.deliveryItem} ${prdSeq === i.prd_seq ? styles.deliveryItemOn : ''}`}
                                                onClick={() => setPrdSeq(i.prd_seq)}
                                            >
                                                <div className={styles.sideGoods}>{i.name}</div>
                                                <div className={styles.sideMuted}>{i.options} · {i.qty}개</div>
                                            </button>
                                        ))}
                                    </div>
                                    {pack.trans_no && (
                                        <div className={styles.error}>이미 송장({pack.trans_no})이 발행된 주문이에요. 교환 처리 전에 한 번 더 확인하세요.</div>
                                    )}
                                </div>
                            )}

                            {item && (
                                <div className={styles.deliveryResult}>
                                    <h4>변경할 옵션</h4>
                                    <div className={styles.sideMuted}>현재: {item.options}</div>
                                    <input
                                        className={styles.exchangeFilter}
                                        placeholder="옵션 검색 (예: L, 롱, 그레이)"
                                        value={optionFilter}
                                        onChange={(e) => setOptionFilter(e.target.value)}
                                    />
                                    {options && visibleOptions.length === 0 && <div className={styles.sideMuted}>선택할 수 있는 옵션이 없어요.</div>}
                                    <div className={styles.exchangeOptions}>
                                        {visibleOptions.map((o) => (
                                            <button
                                                type="button"
                                                key={o.product_id}
                                                className={`${styles.deliveryItem} ${newId === o.product_id ? styles.deliveryItemOn : ''}`}
                                                onClick={() => setNewId(o.product_id)}
                                            >
                                                {o.options}
                                            </button>
                                        ))}
                                    </div>
                                    <div className={styles.exchangeForm}>
                                        <label>
                                            수량
                                            <input
                                                type="number"
                                                min={1}
                                                max={Number(item.qty) || 1}
                                                value={qty}
                                                onChange={(e) => setQty(Math.max(1, Math.min(Number(item.qty) || 1, Number(e.target.value) || 1)))}
                                            />
                                        </label>
                                        <label>
                                            사유 (선택)
                                            <input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} />
                                        </label>
                                    </div>
                                    <div className={styles.replyActions}>
                                        <button type="button" className={styles.btn} disabled={!target || saving} onClick={submit}>
                                            {saving ? '처리 중...' : '교환 처리'}
                                        </button>
                                    </div>
                                </div>
                            )}
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}
