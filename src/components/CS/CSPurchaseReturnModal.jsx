import { useEffect, useState } from 'react';
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

/**
 * 구매확정 후 반품: 원송장번호 확인 + 특이사항 입력 → 이지어드민 회수접수, 회수 문자, 반품 특이사항 등록.
 * buyer: {name, tel}, goodsName: 문자에 들어갈 상품명
 */
export default function CSPurchaseReturnModal({ orderNo, buyer, goodsName, onClose }) {
    const [invoice, setInvoice] = useState('');
    const [note, setNote] = useState('');
    const [lookupMsg, setLookupMsg] = useState('원송장번호를 이지어드민에서 찾는 중...');
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const [done, setDone] = useState(null);

    useEffect(() => {
        const onKey = (e) => e.key === 'Escape' && !saving && onClose();
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onClose, saving]);

    // 주문번호로 이지어드민 합포를 찾아 송장번호를 미리 채운다. 못 찾으면 직접 입력한다.
    useEffect(() => {
        let cancelled = false;
        post('/cs/address/search', { order_no: orderNo })
            .then((data) => {
                if (cancelled) return;
                const withInvoice = (data.packs || []).filter((p) => p.trans_no);
                const pick = withInvoice.find((p) => p.exact) || withInvoice[0];
                if (pick) {
                    setInvoice(String(pick.trans_no));
                    setLookupMsg(`이지어드민에서 찾음${pick.trans_corp ? ` · ${pick.trans_corp}` : ''}${withInvoice.length > 1 ? ` (송장 ${withInvoice.length}건 중 첫 번째, 확인 필요)` : ''}`);
                } else {
                    setLookupMsg('이지어드민에서 송장번호를 찾지 못했어요. 직접 입력해 주세요.');
                }
            })
            .catch((err) => {
                if (!cancelled) setLookupMsg(`${err.message} 직접 입력해 주세요.`);
            });
        return () => {
            cancelled = true;
        };
    }, [orderNo]);

    const submit = async () => {
        const digits = invoice.replace(/\D/g, '');
        if (!digits) return setError('원송장번호를 입력하세요.');
        if (!note.trim()) return setError('특이사항 내용을 입력하세요.');
        if (!buyer.tel) return setError('고객 연락처가 없어 회수 문자를 보낼 수 없어요. 아무것도 처리하지 않았습니다.');
        if (!window.confirm(`송장 ${digits} 회수접수 + 회수 문자 발송 + 반품 특이사항 등록을 진행할까요?\n하나라도 실패하면 아무것도 처리하지 않습니다. (회수접수와 문자는 한 번 나가면 되돌릴 수 없습니다)`)) return;
        setSaving(true);
        setError('');
        try {
            const data = await post('/return-shipping/purchase-confirmed-return', {
                invoice: digits,
                note: note.trim(),
                buyer_name: buyer.name,
                buyer_tel: buyer.tel,
                goods_name: goodsName,
            });
            if (data.need_session) setError('EZAdmin 세션이 없어요. 상단 EZAdmin 설정에서 세션을 등록해 주세요.');
            else if (!data.ok) setError(data.error || data.detail || '회수접수 실패');
            else setDone(data);
        } catch (err) {
            setError(err.message || '요청 실패');
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className={styles.modalOverlay} onClick={saving ? undefined : onClose}>
            <div className={styles.modal} style={{ maxWidth: 520 }} role="dialog" aria-label="구매확정 반품" onClick={(e) => e.stopPropagation()}>
                <div className={styles.modalHead}>
                    <strong>구매확정 반품</strong>
                    <span className={styles.modalSub}>주문번호 {orderNo}</span>
                    <button type="button" className={styles.modalClose} onClick={onClose} disabled={saving} aria-label="닫기">×</button>
                </div>
                <div className={styles.modalBody}>
                    {done ? (
                        <div className={styles.purchaseReturnForm}>
                            <div>회수접수 완료 (송장 {done.invoice_count}건)</div>
                            <div>회수 문자 발송을 요청했어요.</div>
                            <div>반품 특이사항에 등록했어요.</div>
                            <div className={styles.replyActions}>
                                <button type="button" className={styles.btn} onClick={onClose}>닫기</button>
                            </div>
                        </div>
                    ) : (
                        <div className={styles.purchaseReturnForm}>
                            <label>
                                원송장번호
                                <input value={invoice} onChange={(e) => setInvoice(e.target.value)} disabled={saving} />
                            </label>
                            <div className={styles.hint}>{lookupMsg}</div>
                            <label>
                                특이사항
                                <textarea
                                    rows={4}
                                    value={note}
                                    placeholder="반품 시 확인할 내용을 입력하세요."
                                    onChange={(e) => setNote(e.target.value)}
                                    disabled={saving}
                                />
                            </label>
                            <div className={styles.hint}>
                                회수 문자: {buyer.tel ? `${buyer.name || ''} ${buyer.tel}` : '고객 연락처가 없어 진행할 수 없어요'}
                            </div>
                            {error && <div className={styles.error}>{error}</div>}
                            <div className={styles.replyActions}>
                                <button type="button" className={styles.btn} onClick={onClose} disabled={saving}>취소</button>
                                <button type="button" className={styles.btn} onClick={submit} disabled={saving}>
                                    {saving ? '처리 중...' : '회수접수 + 문자 + 특이사항 등록'}
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
