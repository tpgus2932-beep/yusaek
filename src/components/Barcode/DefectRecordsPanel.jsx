import { useState } from "react";
import { LOCAL_API_BASE as API, handleUnauthorized } from "../../lib/api";
import DefectPhotoPicker from "./DefectPhotoPicker";
import styles from "./DefectRecord.module.css";

// 불량 리스트의 한 상품코드에 붙은 등록 기록(수량·사유·사진). 기본은 모두 접힘/숨김 상태.
export default function DefectRecordsPanel({ records, tabHeaders, onChanged, controlledOpen }) {
  // controlledOpen 이 boolean 이면 부모(📷 버튼)가 열림을 제어하고 자체 토글 버튼은 숨긴다.
  const [innerOpen, setInnerOpen] = useState(false);
  const isControlled = typeof controlledOpen === "boolean";
  const open = isControlled ? controlledOpen : innerOpen;
  const setOpen = setInnerOpen;
  const [showReason, setShowReason] = useState({}); // { [recordId]: true }
  const [showPhotos, setShowPhotos] = useState({}); // { [recordId]: true }
  const [photoCache, setPhotoCache] = useState({}); // { [photoId]: dataURL }
  const [zoom, setZoom] = useState("");
  const [editing, setEditing] = useState(null); // { id, qty, reason, keepIds, added }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  if (!records || records.length === 0) return null;

  const loadPhotos = async (ids) => {
    const missing = ids.filter((id) => !photoCache[id]);
    if (missing.length === 0) return;
    const results = await Promise.all(
      missing.map(async (id) => {
        try {
          const res = await fetch(`${API}/barcode/defect/record/photo/${id}`, { headers: tabHeaders() });
          if (handleUnauthorized(res)) return [id, ""];
          const data = await res.json().catch(() => ({}));
          return [id, data?.data_url || ""];
        } catch {
          return [id, ""];
        }
      }),
    );
    setPhotoCache((prev) => ({ ...prev, ...Object.fromEntries(results) }));
  };

  const togglePhotos = (record) => {
    const next = !showPhotos[record.id];
    setShowPhotos((prev) => ({ ...prev, [record.id]: next }));
    if (next) loadPhotos(record.photo_ids);
  };

  const post = async (path, body) => {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`${API}/barcode/defect/record/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...tabHeaders() },
        body: JSON.stringify(body),
      });
      if (handleUnauthorized(res)) return false;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "처리 실패");
      onChanged(data.records || []);
      return true;
    } catch (err) {
      setError(err.message || "처리 실패");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (record) => {
    setError("");
    loadPhotos(record.photo_ids);
    setEditing({ id: record.id, qty: record.qty, reason: record.reason || "", keepIds: [...record.photo_ids], added: [] });
  };

  const saveEdit = async () => {
    const original = records.find((r) => r.id === editing.id);
    if (!original) return;
    const noPhoto = editing.keepIds.length + editing.added.length < 1;
    const noReason = editing.reason.trim() === "";
    if (noPhoto || noReason) {
      const what = [noPhoto && "사진첨부", noReason && "사유"].filter(Boolean).join(", ");
      if (!window.confirm(`${what}가 등록되지 않았습니다.\n\n그래도 저장하시겠습니까?`)) return;
    }
    const ok = await post("update", {
      id: editing.id,
      qty: editing.qty,
      reason: editing.reason.trim(),
      add_photos: editing.added,
      remove_photo_ids: original.photo_ids.filter((id) => !editing.keepIds.includes(id)),
    });
    if (ok) {
      setEditing(null);
      // 사진 구성이 바뀌었을 수 있으니 열려 있던 사진 보기는 새로 불러오도록 닫는다.
      setShowPhotos((prev) => ({ ...prev, [editing.id]: false }));
    }
  };

  const removeRecord = async (record) => {
    if (!window.confirm("이 불량 기록(사진·사유)을 삭제할까요?\n불량 수량 카운트는 그대로 유지됩니다.")) return;
    await post("remove", { id: record.id });
  };

  const renderEdit = () => {
    const existing = editing.keepIds.map((id) => ({ key: `e${id}`, id, src: photoCache[id] || "" }));
    const added = editing.added.map((src, i) => ({ key: `n${i}`, src }));
    const all = [...existing, ...added];
    return (
      <div className={styles.editBox}>
        <div className={styles.qtyRow}>
          <span className={styles.qtyLabel}>수량</span>
          <input
            type="number"
            min={1}
            max={999}
            className={styles.qtyInput}
            value={editing.qty}
            onChange={(e) => setEditing({ ...editing, qty: Math.max(1, parseInt(e.target.value, 10) || 1) })}
          />
        </div>
        <DefectPhotoPicker
          photos={all}
          onAdd={(srcs) => setEditing({ ...editing, added: [...editing.added, ...srcs] })}
          onRemove={(i) =>
            i < existing.length
              ? setEditing({ ...editing, keepIds: editing.keepIds.filter((id) => id !== existing[i].id) })
              : setEditing({ ...editing, added: editing.added.filter((_, n) => n !== i - existing.length) })
          }
          onZoom={setZoom}
          disabled={busy}
        />
        <input
          className={styles.reasonInput}
          value={editing.reason}
          onChange={(e) => setEditing({ ...editing, reason: e.target.value })}
          placeholder="사유"
          disabled={busy}
        />
        <div className={styles.rowBtns}>
          <button type="button" className={styles.smallBtn} onClick={saveEdit} disabled={busy}>저장</button>
          <button type="button" className={styles.smallBtn} onClick={() => { setEditing(null); setError(""); }} disabled={busy}>취소</button>
        </div>
      </div>
    );
  };

  return (
    <div className={styles.panel}>
      {!isControlled && (
        <button type="button" className={styles.panelToggle} onClick={() => setOpen((v) => !v)}>
          사진·사유 {records.length}건 {open ? "▴" : "▾"}
        </button>
      )}
      {open && (
        <div className={styles.recordList}>
          {records.map((record) => (
            <div key={record.id} className={styles.recordItem}>
              <div className={styles.recordTop}>
                <span className={styles.recordQty}>수량 {record.qty}</span>
                <button type="button" className={styles.smallBtn} onClick={() => setShowReason((p) => ({ ...p, [record.id]: !p[record.id] }))}>
                  사유
                </button>
                <button type="button" className={styles.smallBtn} onClick={() => togglePhotos(record)}>
                  사진 {record.photo_ids.length}
                </button>
                <button type="button" className={styles.smallBtn} onClick={() => startEdit(record)} disabled={busy}>수정</button>
                <button type="button" className={styles.smallBtn} onClick={() => removeRecord(record)} disabled={busy}>삭제</button>
              </div>
              {showReason[record.id] && (
                <div className={styles.reasonText}>{record.reason || "(사유 없음)"}</div>
              )}
              {showPhotos[record.id] && (
                <div className={styles.photoRow}>
                  {record.photo_ids.map((id) =>
                    photoCache[id] ? (
                      <img key={id} src={photoCache[id]} alt="불량 사진" className={styles.thumb} onClick={() => setZoom(photoCache[id])} />
                    ) : (
                      <div key={id} className={styles.thumbLoading}>불러오는 중…</div>
                    ),
                  )}
                </div>
              )}
              {editing?.id === record.id && renderEdit()}
            </div>
          ))}
          {error && <div className={styles.error}>{error}</div>}
        </div>
      )}
      {zoom && (
        <div className={styles.zoomOverlay} onClick={() => setZoom("")}>
          <img src={zoom} alt="확대" className={styles.zoomImg} />
        </div>
      )}
    </div>
  );
}
