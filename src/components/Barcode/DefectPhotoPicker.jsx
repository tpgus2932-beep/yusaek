import { useRef } from "react";
import { shrinkImageFile } from "../../utils/imageResize";
import styles from "./DefectRecord.module.css";

// 사진 썸네일 목록 + [+] 버튼(모바일에서 카메라 바로 실행). photos: [{ key, src }]
export default function DefectPhotoPicker({ photos, onAdd, onRemove, onZoom, disabled = false }) {
  const inputRef = useRef(null);

  const handleFiles = async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = ""; // 같은 사진을 다시 찍어도 change 가 발생하도록 비운다
    if (files.length === 0) return;
    try {
      const added = await Promise.all(files.map(shrinkImageFile));
      onAdd(added);
    } catch (err) {
      alert(err.message || "사진을 읽을 수 없습니다.");
    }
  };

  return (
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
      <button type="button" className={styles.addPhotoBtn} onClick={() => inputRef.current?.click()} disabled={disabled}>
        <span className={styles.addPhotoPlus}>+</span>
        <span>사진 촬영</span>
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        style={{ display: "none" }}
        onChange={handleFiles}
      />
    </div>
  );
}
