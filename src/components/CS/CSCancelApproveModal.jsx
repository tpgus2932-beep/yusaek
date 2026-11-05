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

// 취소 승인 모달: 주문번호로 에이블리 진행 중인 구매자 취소요청을 찾아 승인(확정)한다.
export default function CSCancelApproveModal({ orderNo, onClose }) {
    const [cancels, setCancels] = useState(null);
    const [busy, setBusy] = useState(true);
    const [saving, setSaving] = useState('');
    const [error, setError] = useState('');
    const [doneSnos, setDoneSnos] = useState([]);

    useEffect(() => {
        const onKey = (e) => e.key === 'Escape' && !saving && onClose();
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onClose, saving]);

    useEffect(() => {
        let cancelled = false;
        post('/cs/cancel/search', { order_no: orderNo })
            .then((data) => !cancelled && setCancels(data.cancels || []))
            .catch((e) => !cancelled && setError(e.message))
            .finally(() => !cancelled && setBusy(false));
        return () => {
            cancelled = true;
        };
    }, [orderNo]);

    const approve = async (cancel) => {
        if (!window.confirm(`주문 ${orderNo}의 취소요청(${cancel.cancel_sno})을 승인할까요?\n한 번 처리하면 되돌릴 수 없습니다.`)) return;
        setSaving(cancel.cancel_sno);
        setError('');
        try {
            await post('/cs/cancel/approve', { item_snos: cancel.item_snos });
            setDoneSnos((list) => [...list, cancel.cancel_sno]);
        } catch (e) {
            setError(e.message);
        } finally {
            setSaving('');
        }
    };

    return (
        <div className={styles.modalOverlay} onClick={saving ? undefined : onClose}>
            <div className={styles.modal} style={{ maxWidth: 520 }} role="dialog" aria-label="취소 승인" onClick={(e) => e.stopPropagation()}>
                <div className={styles.modalHead}>
                    <strong>취소 승인</strong>
                    <span className={styles.modalSub}>주문 {orderNo}</span>
                    <button type="button" className={styles.modalClose} onClick={onClose} disabled={Boolean(saving)} aria-label="닫기">×</button>
                </div>
                <div className={styles.modalBody}>
                    {busy && <div className={styles.hint}>에이블리에서 취소 요청을 찾는 중...</div>}
                    {error && <div className={styles.error}>{error}</div>}
                    {cancels && cancels.length === 0 && (
                        <div className={styles.hint}>이 주문의 진행 중인 취소 요청이 없어요. (최근 60일, 취소 요청 단계만 조회)</div>
                    )}
                    {cancels && cancels.length > 0 && (
                        <>
                            <div className={styles.deliveryList}>
                                {cancels.map((c) => (
                                    <div key={c.cancel_sno} className={styles.deliveryItem}>
                                        <div className={styles.deliveryTop}>
                                            <strong>취소요청 {c.cancel_sno}</strong>
                                            <span className={styles.sideMuted}>{c.received_at} {c.status}</span>
                                        </div>
                                        <div className={styles.sideMuted}>
                                            {c.items.map((i) => `${i.name}${i.options ? ` ${i.options}` : ''} x${i.qty}`).join(' / ')}
                                        </div>
                                        {doneSnos.includes(c.cancel_sno) ? (
                                            <div className={styles.hint}>승인했어요.</div>
                                        ) : (
                                            <div className={styles.replyActions}>
                                                <button type="button" className={styles.btn} disabled={Boolean(saving)} onClick={() => approve(c)}>
                                                    {saving === c.cancel_sno ? '처리 중...' : '취소 승인'}
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                ))}
                            </div>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}
