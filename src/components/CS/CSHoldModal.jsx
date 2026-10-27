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

// 이지어드민 order_cs 의 첫 값: 0 정상, 1 취소 (그 밖의 값은 CS 상태로만 표시)
const csLabel = (orderCs) => {
    const code = String(orderCs || '0').split(',')[0];
    if (code === '0') return '';
    return code === '1' ? '취소' : `CS(${code})`;
};

const stateOf = (p) => ({ held: p.hold !== '0', cs: csLabel(p.order_cs) });

// 보류 해제 / 정상 복귀 모달: 전화번호로 이지어드민 주문 검색 → 주문 선택 → 해제.
export default function CSHoldModal({ phone = '', onClose }) {
    const [query, setQuery] = useState(phone);
    const [packs, setPacks] = useState(null);
    const [packId, setPackId] = useState(null);
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
    const state = pack ? stateOf(pack) : null;
    const actionable = state && (state.held || state.cs);

    const submit = async () => {
        if (!pack || !actionable) return;
        const steps = [state.held && '보류 해제', state.cs && '정상 복귀'].filter(Boolean).join(' + ');
        const warn = state.cs ? `\n\n※ 이 주문은 '${state.cs}' 상태입니다. 정상 복귀하면 다시 출고 대상이 됩니다.` : '';
        if (!window.confirm(`${pack.recv_name} · 주문번호 ${pack.order_id}\n${steps}을(를) 진행할까요?${warn}`)) return;
        setSaving(true);
        setError('');
        try {
            const data = await post('/cs/hold/release', { pack: pack.pack, allow_cancelled: Boolean(state.cs) });
            setDone(data);
            setPacks((list) => (list || []).map((p) => (p.pack === pack.pack ? { ...p, ...data.after } : p)));
        } catch (e) {
            setError(e.message);
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className={styles.modalOverlay} onClick={saving ? undefined : onClose}>
            <div className={styles.modal} style={{ maxWidth: 560 }} role="dialog" aria-label="보류 해제" onClick={(e) => e.stopPropagation()}>
                <div className={styles.modalHead}>
                    <strong>보류 해제 · 정상 복귀</strong>
                    <span className={styles.modalSub}>전화번호로 주문 검색 (최근 30일)</span>
                    <button type="button" className={styles.modalClose} onClick={onClose} disabled={saving} aria-label="닫기">×</button>
                </div>
                <div className={styles.modalBody}>
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
                    {packs && packs.length > 1 && <div className={styles.hint}>주문이 {packs.length}건 검색됐어요. 해제할 주문을 선택하세요.</div>}

                    <div className={styles.deliveryList}>
                        {(packs || []).map((p) => {
                            const s = stateOf(p);
                            return (
                                <button
                                    type="button"
                                    key={p.pack}
                                    className={`${styles.deliveryItem} ${packId === p.pack ? styles.deliveryItemOn : ''}`}
                                    onClick={() => { setPackId(p.pack); setDone(null); }}
                                >
                                    <div className={styles.deliveryTop}>
                                        <strong>{p.recv_name || '-'}</strong>
                                        <span className={styles.sideMuted}>{p.collect_date} · {p.shop_name}</span>
                                        <span className={styles.holdTags}>
                                            {s.held && <span className={styles.deliveryNone}>보류</span>}
                                            {s.cs && <span className={styles.deliveryNone}>{s.cs}</span>}
                                            {!s.held && !s.cs && <span className={styles.deliveryHas}>정상</span>}
                                        </span>
                                    </div>
                                    <div className={styles.sideMuted}>
                                        {p.items.map((i) => `${i.name}${i.options ? ` ${i.options}` : ''} x${i.qty}`).join(' / ')}
                                    </div>
                                    <div className={styles.sideMuted}>주문번호 {p.order_id}</div>
                                </button>
                            );
                        })}
                    </div>

                    {pack && (
                        <div className={styles.deliveryResult}>
                            {done && <div className={styles.hint}>{done.done.join(' + ')} 완료했어요. 현재 상태를 다시 확인했습니다.</div>}
                            {!actionable && !done && <div className={styles.sideMuted}>보류도 취소·CS 상태도 아닌 정상 주문이에요.</div>}
                            {actionable && (
                                <>
                                    <div className={styles.sideMuted}>
                                        {[state.held && '보류 해제', state.cs && `정상 복귀 (현재 ${state.cs} 상태)`].filter(Boolean).join(' → ')}
                                    </div>
                                    <div className={styles.replyActions}>
                                        <button type="button" className={styles.btn} disabled={saving} onClick={submit}>
                                            {saving ? '처리 중...' : [state.held && '보류 해제', state.cs && '정상 복귀'].filter(Boolean).join(' + ')}
                                        </button>
                                    </div>
                                </>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
