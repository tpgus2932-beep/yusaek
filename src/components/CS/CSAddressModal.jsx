import { useEffect } from 'react';
import styles from './CSPage.module.css';
import CSAddress from './CSAddress';

// 주소 변경 모달 (주문번호로 이지어드민 검색 → 선택 → 변경). 대화창과 상품별 문의 카드에서 함께 쓴다.
export default function CSAddressModal({ orderNo, onClose }) {
    useEffect(() => {
        const onKey = (e) => e.key === 'Escape' && onClose();
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onClose]);

    return (
        <div className={styles.modalOverlay} onClick={onClose}>
            <div className={styles.modal} role="dialog" aria-label="주소 변경" onClick={(e) => e.stopPropagation()}>
                <div className={styles.modalHead}>
                    <strong>주소 변경</strong>
                    <span className={styles.modalSub}>주문번호 {orderNo}</span>
                    <button type="button" className={styles.modalClose} onClick={onClose} aria-label="닫기">×</button>
                </div>
                <div className={styles.modalBody}>
                    <CSAddress initialOrderNo={orderNo} />
                </div>
            </div>
        </div>
    );
}
