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

const DEFAULT_REASON = '고객 요청으로 반품 철회';

// 반품 철회 모달: 주문번호로 에이블리 진행 중인 반품 요청을 찾아 철회(거부 처리)한다.
export default function CSReturnWithdrawModal({ orderNo, onClose }) {
    const [cancels, setCancels] = useState(null);
    const [reason, setReason] = useState(DEFAULT_REASON);
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
        post('/cs/return/search', { order_no: orderNo })
            .then((data) => !cancelled && setCancels(data.cancels || []))
            .catch((e) => !cancelled && setError(e.message))
            .finally(() => !cancelled && setBusy(false));
        return () => {
            cancelled = true;
        };
    }, [orderNo]);

    const withdraw = async (cancel) => {
        if (!reason.trim()) return setError('철회 사유를 입력하세요.');
        if (!window.confirm(`주문 ${orderNo}의 반품 요청(${cancel.cancel_sno})을 철회할까요?\n한 번 처리하면 되돌릴 수 없습니다.`)) return;
        setSaving(cancel.cancel_sno);
        setError('');
        try {
            await post('/cs/return/withdraw', { cancel_sno: cancel.cancel_sno, reason: reason.trim() });
            setDoneSnos((list) => [...list, cancel.cancel_sno]);
        } catch (e) {
            setError(e.message);
        } finally {
            setSaving('');
        }
    };

    return (
        <div className={styles.modalOverlay} onClick={saving ? undefined : onClose}>
            <div className={styles.modal} style={{ maxWidth: 520 }} role="dialog" aria-label="반품 철회" onClick={(e) => e.stopPropagation()}>
                <div className={styles.modalHead}>
                    <strong>반품 철회</strong>
                    <span className={styles.modalSub}>주문 {orderNo}</span>
                    <button type="button" className={styles.modalClose} onClick={onClose} disabled={Boolean(saving)} aria-label="닫기">×</button>
                </div>
                <div className={styles.modalBody}>
                    {busy && <div className={styles.hint}>에이블리에서 반품 요청을 찾는 중...</div>}
                    {error && <div className={styles.error}>{error}</div>}
                    {cancels && cancels.length === 0 && (
                        <div className={styles.hint}>이 주문의 진행 중인 반품 요청이 없어요. (최근 60일, 반품 요청·수거 단계만 조회)</div>
                    )}
                    {cancels && cancels.length > 0 && (
                        <>
                            <textarea
                                value={reason}
                                rows={2}
                                placeholder="철회 사유 (에이블리에 전달돼요)"
                                onChange={(e) => setReason(e.target.value)}
                            />
                            <div className={styles.deliveryList}>
                                {cancels.map((c) => (
                                    <div key={c.cancel_sno} className={styles.deliveryItem}>
                                        <div className={styles.deliveryTop}>
                                            <strong>반품요청 {c.cancel_sno}</strong>
                                            <span className={styles.sideMuted}>{c.received_at} {c.status}</span>
                                        </div>
                                        <div className={styles.sideMuted}>
                                            {c.items.map((i) => `${i.name}${i.options ? ` ${i.options}` : ''} x${i.qty}`).join(' / ')}
                                        </div>
                                        {doneSnos.includes(c.cancel_sno) ? (
                                            <div className={styles.hint}>철회했어요.</div>
                                        ) : (
                                            <div className={styles.replyActions}>
                                                <button type="button" className={styles.btn} disabled={Boolean(saving)} onClick={() => withdraw(c)}>
                                                    {saving === c.cancel_sno ? '처리 중...' : '반품 철회'}
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
