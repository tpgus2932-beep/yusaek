import React, { useState } from "react";

export default function TsvAppendModal({
  open,
  title,
  styles,
  loading = false,
  onClose,
  onSubmit,
}) {
  const [text, setText] = useState("");
  const [skipHeader, setSkipHeader] = useState(false);

  if (!open) return null;

  const handleClose = () => {
    if (loading) return;
    setText("");
    setSkipHeader(false);
    onClose?.();
  };

  const handleSubmit = async () => {
    const ok = await onSubmit?.({ text, skipHeader });
    if (ok === false) return;
    setText("");
    setSkipHeader(false);
    onClose?.();
  };

  return (
    <div className={styles.modalOverlay} onClick={handleClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHeader}>
          <h3 className={styles.modalTitle}>{title}</h3>
          <div className={styles.modalActions}>
            <button className={styles.secondaryBtn} onClick={handleClose} disabled={loading}>
              닫기
            </button>
          </div>
        </div>

        <div className={styles.statusMsg}>
          <strong>TSV</strong> 2열 데이터를 붙여넣으면 A열 상품코드, I열 상품명 색상 사이즈 기준으로 원가베이스 마지막 행에 추가됩니다.
        </div>

        <textarea
          className={styles.scanInput}
          style={{ minHeight: 220 }}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={"상품코드\t상품명 색상 사이즈"}
          disabled={loading}
        />

        <label className={styles.checkboxItem}>
          <input
            type="checkbox"
            checked={skipHeader}
            onChange={(e) => setSkipHeader(e.target.checked)}
            disabled={loading}
          />
          첫 줄은 헤더로 건너뛰기
        </label>

        <div className={styles.uploadRow}>
          <button className={styles.primaryBtn} onClick={handleSubmit} disabled={loading}>
            {loading ? "추가 중..." : "원가베이스 데이터 추가"}
          </button>
          <button className={styles.secondaryBtn} onClick={handleClose} disabled={loading}>
            취소
          </button>
        </div>
      </div>
    </div>
  );
}
