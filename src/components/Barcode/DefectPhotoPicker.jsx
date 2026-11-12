import { useRef } from "react";
import { shrinkImageFile } from "../../utils/imageResize";
import styles from "./DefectRecord.module.css";

const DEFECT_PHOTO_MAX = 10; // 서버 _DEFECT_PHOTO_MAX_COUNT 와 같은 값 (불량 1건당)

// 사진 썸네일 목록 + [촬영] 버튼(모바일 카메라, 여러 번 눌러 계속 추가) + [앨범] 버튼(여러 장 한 번에 선택).
// photos: [{ key, src }]
export default function DefectPhotoPicker({ photos, onAdd, onRemove, onZoom, disabled = false, max = DEFECT_PHOTO_MAX }) {
  const cameraRef = useRef(null);
  const albumRef = useRef(null);
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
            <img
              src={photo.src}
              alt={`불량 사진 ${idx + 1}`}
              className={styles.thumb}
              onClick={() => onZoom?.(photo.src)}
            />
            <button type="button" className={styles.thumbRemove} onClick={() => onRemove(idx)} disabled={disabled}>
              ×
            </button>
          </div>
        ))}
        {!full && (
          <>
            <button type="button" className={styles.addPhotoBtn} onClick={() => cameraRef.current?.click()} disabled={disabled}>
              <span className={styles.addPhotoPlus}>+</span>
              <span>{photos.length > 0 ? "한 장 더 촬영" : "사진 촬영"}</span>
            </button>
            <button type="button" className={styles.addPhotoBtn} onClick={() => albumRef.current?.click()} disabled={disabled}>
              <span className={styles.addPhotoPlus}>🖼</span>
              <span>앨범 여러 장</span>
            </button>
          </>
        )}
      </div>
      <div className={styles.hint} style={{ marginTop: "0.3rem" }}>
        사진 {photos.length}/{max}장{full ? " (최대)" : " · 여러 장 등록 가능"}
      </div>
      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        style={{ display: "none" }}
        onChange={handleFiles}
      />
      <input
        ref={albumRef}
        type="file"
        accept="image/*"
        multiple
        style={{ display: "none" }}
        onChange={handleFiles}
      />
    </div>
  );
}
