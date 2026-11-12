import { useRef } from "react";
import { shrinkImageFile } from "../../utils/imageResize";
import styles from "./DefectRecord.module.css";

const DEFECT_PHOTO_MAX = 10; // 서버 _DEFECT_PHOTO_MAX_COUNT 와 같은 값 (불량 1건당)

// 사진 썸네일 목록 + [+ 사진 추가] 버튼(모바일 카메라). 누를 때마다 한 장씩 계속 추가된다.
// photos: [{ key, src }]
export default function DefectPhotoPicker({ photos, onAdd, onRemove, onZoom, disabled = false, max = DEFECT_PHOTO_MAX }) {
  const cameraRef = useRef(null);
  const left = Math.max(0, max - photos.length);
  const full = left <= 0;

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

  return (
    <div>
      <div className={styles.photoRow}>
        {photos.map((photo, idx) => (
          <div key={photo.key ?? idx} className={styles.thumbWrap}>
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
        ))}
        {!full && (
          <button type="button" className={styles.addPhotoBtn} onClick={() => cameraRef.current?.click()} disabled={disabled}>
            <span className={styles.addPhotoPlus}>+</span>
            <span>사진 추가</span>
          </button>
        )}
      </div>
      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        style={{ display: "none" }}
        onChange={handleFiles}
      />
    </div>
  );
}
