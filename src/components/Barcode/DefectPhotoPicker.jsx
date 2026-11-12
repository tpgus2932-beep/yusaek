import { useRef } from "react";
import { shrinkImageFile } from "../../utils/imageResize";
import styles from "./DefectRecord.module.css";

const DEFECT_PHOTO_MAX = 10; // 서버 _DEFECT_PHOTO_MAX_COUNT 와 같은 값 (불량 1건당)
const REASON_CHIPS = ["봉제 불량", "사이즈 불량", "거래처 오배송", "얼룩", "구멍"];

// 사진 목록 + [+ 사진 추가] 버튼(모바일 카메라). 누를 때마다 한 장씩 계속 추가된다.
// photos: [{ key, src }]
// reasons 를 넘기면 사진마다 사유 칸(자주 쓰는 사유 버튼 + 직접 입력)이 붙는다.
//   onReasonChange(idx, 값): 입력할 때마다 / onReasonCommit(idx, 값): 버튼 선택·입력 끝(포커스 빠짐)에 저장용
export default function DefectPhotoPicker({
  photos,
  onAdd,
  onRemove,
  onZoom,
  disabled = false,
  max = DEFECT_PHOTO_MAX,
  reasons,
  onReasonChange,
  onReasonCommit,
}) {
  const cameraRef = useRef(null);
  const left = Math.max(0, max - photos.length);
  const full = left <= 0;
  const withReasons = Array.isArray(reasons);

  const handleFiles = async (e) => {
    const picked = Array.from(e.target.files || []);
    e.target.value = ""; // 같은 사진을 다시 찍어도 change 가 발생하도록 비운다
    if (picked.length === 0) return;
    const files = picked.slice(0, left);
    if (picked.length > left) alert(`사진은 불량 1건당 최대 ${max}장까지입니다. ${files.length}장만 추가합니다.`);
    if (files.length === 0) return;
    try {
      const added = await Promise.all(files.map(shrinkImageFile));
      onAdd(added);
    } catch (err) {
      alert(err.message || "사진을 읽을 수 없습니다.");
    }
  };

  const renderThumb = (photo, idx) => (
    <div className={styles.thumbWrap}>
      {withReasons && <span className={styles.thumbNo}>{idx + 1}</span>}
      {photo.src ? (
        <img
          src={photo.src}
          alt={`불량 사진 ${idx + 1}`}
          className={styles.thumb}
          onClick={() => onZoom?.(photo.src)}
        />
      ) : (
        <div className={styles.thumbLoading}>불러오는 중…</div>
      )}
      <button type="button" className={styles.thumbRemove} onClick={() => onRemove(idx)} disabled={disabled}>
        ×
      </button>
    </div>
  );

  const addButton = !full && (
    <button type="button" className={styles.addPhotoBtn} onClick={() => cameraRef.current?.click()} disabled={disabled}>
      <span className={styles.addPhotoPlus}>+</span>
      <span>사진 추가</span>
    </button>
  );

  const fileInput = (
    <input
      ref={cameraRef}
      type="file"
      accept="image/*"
      capture="environment"
      style={{ display: "none" }}
      onChange={handleFiles}
    />
  );

  if (!withReasons) {
    return (
      <div>
        <div className={styles.photoRow}>
          {photos.map((photo, idx) => <div key={photo.key ?? idx}>{renderThumb(photo, idx)}</div>)}
          {addButton}
        </div>
        {fileInput}
      </div>
    );
  }

  return (
    <div className={styles.photoReasonList}>
      {photos.map((photo, idx) => {
        const value = reasons[idx] ?? "";
        return (
          <div key={photo.key ?? idx} className={styles.photoReasonItem}>
            {renderThumb(photo, idx)}
            <div className={styles.photoReasonBody}>
              <div className={`${styles.photoReasonLabel} ${value.trim() ? "" : styles.photoReasonEmpty}`}>
                {idx + 1}번 사진 사유: {value.trim() || "미입력"}
              </div>
              <div className={styles.chipRow}>
                {REASON_CHIPS.map((chip) => (
                  <button
                    key={chip}
                    type="button"
                    className={`${styles.chip} ${styles.chipSmall} ${value === chip ? styles.chipOn : ""}`}
                    onClick={() => { onReasonChange?.(idx, chip); onReasonCommit?.(idx, chip); }}
                    disabled={disabled}
                  >
                    {chip}
                  </button>
                ))}
              </div>
              <input
                className={styles.reasonInput}
                value={value}
                onChange={(e) => onReasonChange?.(idx, e.target.value)}
                onBlur={(e) => onReasonCommit?.(idx, e.target.value)}
                placeholder={`${idx + 1}번 사진 사유`}
                disabled={disabled}
              />
            </div>
          </div>
        );
      })}
      <div className={styles.photoRow}>{addButton}</div>
      {fileInput}
    </div>
  );
}
