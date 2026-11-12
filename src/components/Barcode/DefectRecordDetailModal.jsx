import { useEffect, useState } from "react";
import { LOCAL_API_BASE as API, handleUnauthorized } from "../../lib/api";
import DefectPhotoPicker from "./DefectPhotoPicker";
import styles from "./DefectRecord.module.css";

const formatDate = (iso) => (iso ? String(iso).slice(0, 16).replace("T", " ") : "");

// 불량 리스트의 📷 버튼: 한 상품의 사진·사유를 바로 보여주고 그 자리에서 수정/삭제한다.
export default function DefectRecordDetailModal({ title, records, tabHeaders, onChanged, onClose }) {
  const [photoCache, setPhotoCache] = useState({}); // { [photoId]: dataURL }
  const [zoom, setZoom] = useState("");
  const [editing, setEditing] = useState(null); // { id, qty, reason, hasPhotos } — 수량(사진 없으면 사유도) 수정
  const [drafts, setDrafts] = useState({}); // 사진별 사유 입력 중인 값 { [photoId]: 사유 }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const photoKey = records.flatMap((r) => r.photo_ids).join(",");

  // 열자마자 사진을 모두 불러온다.
  useEffect(() => {
    const missing = records.flatMap((r) => r.photo_ids).filter((id) => !photoCache[id]);
    if (missing.length === 0) return;
    let cancelled = false;
    (async () => {
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
      if (!cancelled) setPhotoCache((prev) => ({ ...prev, ...Object.fromEntries(results) }));
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photoKey]);

  // 기록이 모두 없어지면(삭제) 자동으로 닫는다.
  useEffect(() => {
    if (records.length === 0) onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [records.length]);

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
    setEditing({ id: record.id, qty: record.qty, reason: record.reason || "", hasPhotos: record.photo_ids.length > 0 });
  };

  const savedPhotoReason = (record, i) => record.photo_reasons?.[i] ?? "";
  const photoReasonValue = (record, i) => drafts[record.photo_ids[i]] ?? savedPhotoReason(record, i);
  const clearDraft = (pid) => setDrafts((prev) => { const next = { ...prev }; delete next[pid]; return next; });

  // 사진별 사유: 버튼을 누르거나 입력칸에서 빠져나가면 바로 저장
  const commitPhotoReason = async (record, i, value) => {
    const pid = record.photo_ids[i];
    const text = String(value || "").trim();
    if (text === savedPhotoReason(record, i).trim()) { clearDraft(pid); return; }
    const ok = await post("update", { id: record.id, photo_reasons: { [pid]: text } });
    if (ok) clearDraft(pid);
  };

  const saveEdit = async () => {
    const original = records.find((r) => r.id === editing.id);
    if (!original) return;
    if (!editing.hasPhotos && editing.reason.trim() === "") {
      if (!window.confirm("사유가 등록되지 않았습니다.\n\n그래도 저장하시겠습니까?")) return;
    }
    const ok = await post("update", {
      id: editing.id,
      qty: editing.qty,
      ...(editing.hasPhotos ? {} : { reason: editing.reason.trim() }),
    });
    if (ok) setEditing(null);
  };

  const removeRecord = async (record) => {
    if (!window.confirm("이 불량 기록(사진·사유)을 삭제할까요?\n불량 수량 카운트는 그대로 유지됩니다.")) return;
    await post("remove", { id: record.id });
  };

  const renderEdit = () => (
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
      {!editing.hasPhotos && (
        <input
          className={styles.reasonInput}
          value={editing.reason}
          onChange={(e) => setEditing({ ...editing, reason: e.target.value })}
          placeholder="사유"
          disabled={busy}
        />
      )}
      <div className={styles.rowBtns}>
        <button type="button" className={styles.smallBtn} onClick={saveEdit} disabled={busy}>저장</button>
        <button type="button" className={styles.smallBtn} onClick={() => { setEditing(null); setError(""); }} disabled={busy}>취소</button>
      </div>
    </div>
  );

  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 1300, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", padding: "12px" }}
      onClick={onClose}
    >
      <div
        style={{ background: "var(--card-bg, #fff)", color: "inherit", borderRadius: 14, width: "100%", maxWidth: 520, maxHeight: "88vh", overflowY: "auto", padding: "14px" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.6rem" }}>
          <strong style={{ flex: 1, wordBreak: "break-all" }}>{title}</strong>
          <button type="button" className={styles.smallBtn} onClick={onClose}>닫기</button>
        </div>

        {records.map((record, idx) => (
          <div key={record.id} className={styles.recordItem} style={{ marginBottom: "0.7rem" }}>
            <div className={styles.recordTop}>
              <span className={styles.recordQty}>#{idx + 1} · 수량 {record.qty}</span>
              <span className={styles.hint}>{formatDate(record.created_at)}</span>
              <span style={{ marginLeft: "auto", display: "flex", gap: "0.3rem" }}>
                <button type="button" className={styles.smallBtn} onClick={() => startEdit(record)} disabled={busy || !!editing}>수정</button>
                <button type="button" className={styles.smallBtn} onClick={() => removeRecord(record)} disabled={busy}>삭제</button>
              </span>
            </div>

            {editing?.id === record.id && renderEdit()}
            {/* 사진 추가·삭제·사진별 사유는 바로 저장된다 */}
            <DefectPhotoPicker
              photos={record.photo_ids.map((id) => ({ key: id, id, src: photoCache[id] || "" }))}
              reasons={record.photo_ids.map((_, i) => photoReasonValue(record, i))}
              onReasonChange={(i, value) => setDrafts((prev) => ({ ...prev, [record.photo_ids[i]]: value }))}
              onReasonCommit={(i, value) => commitPhotoReason(record, i, value)}
              onAdd={(srcs) => post("update", { id: record.id, add_photos: srcs.map((src) => ({ data: src, reason: "" })) })}
              onRemove={(i) => {
                if (!window.confirm("이 사진을 삭제할까요?")) return;
                post("update", { id: record.id, remove_photo_ids: [record.photo_ids[i]] });
              }}
              onZoom={setZoom}
              disabled={busy}
            />
            {/* 사진별 사유가 없는 기록(사진 없이 등록했거나 예전 기록)은 기록 사유를 보여준다 */}
            {!(record.photo_reasons ?? []).some((r) => (r || "").trim()) && editing?.id !== record.id && (
              <div className={styles.reasonText}>{record.reason || "(사유 없음)"}</div>
            )}
          </div>
        ))}
        {error && <div className={styles.error}>{error}</div>}
      </div>

      {zoom && (
        <div className={styles.zoomOverlay} style={{ zIndex: 1400 }} onClick={(e) => { e.stopPropagation(); setZoom(""); }}>
          <img src={zoom} alt="확대" className={styles.zoomImg} />
        </div>
      )}
    </div>
  );
}
