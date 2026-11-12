import { useState } from "react";
import { LOCAL_API_BASE as API, handleUnauthorized } from "../../lib/api";
import DefectPhotoPicker from "./DefectPhotoPicker";
import styles from "./DefectRecord.module.css";

const REASON_CHIPS = ["봉제 불량", "사이즈 불량", "거래처 오배송", "얼룩", "구멍"];
const emptyEntry = () => ({ photos: [], photoReasons: [], reason: "" });

// 불량 스캔 직후 뜨는 사진·사유 등록 시트.
//  1) 1개              : 수량 1
//  2) 여러 개 + 일괄 적용 : 수량 N, 사진·사유 한 세트를 전체에 적용
//  3) 여러 개 + 일괄 해제 : N건 각각 사진·사유를 따로 입력
// attachExisting: 이미 불량 수량이 잡혀 있는 상품에 사진·사유만 붙이는 모드 (수량을 다시 올리지 않는다).
export default function DefectRecordSheet({ code, label, tabHeaders, onSaved, onClose, initialQty = 1, attachExisting = false }) {
  const [qty, setQty] = useState(Math.min(Math.max(Number(initialQty) || 1, 1), 99));
  const [batch, setBatch] = useState(true);
  const [entries, setEntries] = useState([emptyEntry()]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [zoom, setZoom] = useState("");

  const individual = qty > 1 && !batch;
  const visibleCount = individual ? qty : 1;

  const getEntry = (idx) => entries[idx] || emptyEntry();
  const patchEntry = (idx, patch) =>
    setEntries((prev) => {
      const next = [...prev];
      while (next.length <= idx) next.push(emptyEntry());
      next[idx] = { ...next[idx], ...(typeof patch === "function" ? patch(next[idx]) : patch) };
      return next;
    });

  const changeQty = (value) => {
    const n = Math.min(Math.max(parseInt(value, 10) || 1, 1), 99);
    setQty(n);
  };

  const submit = async () => {
    setError("");
    const used = Array.from({ length: visibleCount }, (_, i) => getEntry(i));
    // 사진 또는 사유가 빠진 불량이 있으면 어느 항목이 빠졌는지 알려주고, 그래도 등록할지 묻는다.
    // 사진이 있으면 사진마다 사유, 사진이 없으면 기록 사유 한 줄을 본다.
    const lacks = used
      .map((entry, i) => ({
        no: i + 1,
        photo: entry.photos.length === 0,
        reason: entry.photos.length > 0
          ? entry.photos.some((_, n) => !(entry.photoReasons[n] || "").trim())
          : entry.reason.trim() === "",
      }))
      .filter((x) => x.photo || x.reason);
    if (lacks.length > 0) {
      const detail = lacks
        .map((x) => `${individual ? `${x.no}번째: ` : ""}${[x.photo && "사진첨부", x.reason && "사유(사진별)"].filter(Boolean).join(", ")}`)
        .join("\n");
      const ok = window.confirm(`사진첨부 또는 사유가 등록되지 않았습니다.\n\n${detail}\n\n그래도 등록하시겠습니까?`);
      if (!ok) return;
    }
    const common = { code, allow_incomplete: lacks.length > 0, attach_existing: attachExisting };
    // 사진마다 { data, reason } 로 보낸다. 기록 사유는 서버가 사진별 사유를 모아 채운다.
    const toPayload = (entry) => ({
      reason: entry.photos.length > 0 ? "" : entry.reason.trim(),
      photos: entry.photos.map((src, n) => ({ data: src, reason: (entry.photoReasons[n] || "").trim() })),
    });
    const body = individual
      ? { ...common, entries: used.map(toPayload) }
      : { ...common, qty, ...toPayload(used[0]) };
    setSaving(true);
    try {
      const res = await fetch(`${API}/barcode/defect/record/add`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...tabHeaders() },
        body: JSON.stringify(body),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "등록 실패");
      onSaved(data);
    } catch (err) {
      setError(err.message || "등록 실패");
    } finally {
      setSaving(false);
    }
  };

  const renderEntry = (idx) => {
    const entry = getEntry(idx);
    return (
      <div key={idx} className={styles.entryCard}>
        {individual && <div className={styles.entryTitle}>{idx + 1}번째 불량</div>}
        <DefectPhotoPicker
          photos={entry.photos.map((src, i) => ({ key: i, src }))}
          reasons={entry.photoReasons}
          onReasonChange={(i, value) => patchEntry(idx, (cur) => {
            const next = [...cur.photoReasons];
            next[i] = value;
            return { photoReasons: next };
          })}
          onAdd={(added) => patchEntry(idx, (cur) => ({
            photos: [...cur.photos, ...added],
            // 사진 찍기 전에 적어 둔 사유가 있으면 첫 사진 사유로 옮긴다
            photoReasons: [...cur.photoReasons, ...added.map((_, n) => (cur.photos.length === 0 && n === 0 ? cur.reason : ""))],
          }))}
          onRemove={(i) => patchEntry(idx, (cur) => ({
            photos: cur.photos.filter((_, n) => n !== i),
            photoReasons: cur.photoReasons.filter((_, n) => n !== i),
          }))}
          onZoom={setZoom}
          disabled={saving}
        />
        {entry.photos.length === 0 && (
          <>
            <div className={styles.chipRow}>
              {REASON_CHIPS.map((chip) => (
                <button
                  key={chip}
                  type="button"
                  className={`${styles.chip} ${entry.reason === chip ? styles.chipOn : ""}`}
                  onClick={() => patchEntry(idx, { reason: chip })}
                  disabled={saving}
                >
                  {chip}
                </button>
              ))}
            </div>
            <input
              className={styles.reasonInput}
              value={entry.reason}
              onChange={(e) => patchEntry(idx, { reason: e.target.value })}
              placeholder="사유 직접 입력"
              disabled={saving}
            />
          </>
        )}
      </div>
    );
  };

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.sheet} onClick={(e) => e.stopPropagation()}>
        <div className={styles.sheetHeader}>
          <div>
            <div className={styles.sheetTitle}>불량 사진·사유 등록</div>
            <div className={styles.sheetSub}>{label || code}</div>
            <div className={styles.sheetCode}>{code}</div>
          </div>
          <button type="button" className={styles.laterBtn} onClick={onClose} disabled={saving}>취소</button>
        </div>

        <div className={styles.qtyRow}>
          <span className={styles.qtyLabel}>불량 수량</span>
          <div className={styles.stepper}>
            <button type="button" onClick={() => changeQty(qty - 1)} disabled={saving || qty <= 1}>−</button>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={99}
              value={qty}
              onChange={(e) => changeQty(e.target.value)}
              disabled={saving}
            />
            <button type="button" onClick={() => changeQty(qty + 1)} disabled={saving || qty >= 99}>+</button>
          </div>
          {qty > 1 && (
            <label className={styles.batchToggle}>
              <input type="checkbox" checked={batch} onChange={(e) => setBatch(e.target.checked)} disabled={saving} />
              일괄 적용
            </label>
          )}
        </div>
        {qty > 1 && (
          <div className={styles.hint}>
            {batch
              ? `사진·사유 한 세트를 ${qty}개 모두에 적용합니다.`
              : `${qty}개 각각 사진·사유를 따로 입력합니다.`}
          </div>
        )}

        <div className={styles.entries}>
          {Array.from({ length: visibleCount }, (_, idx) => renderEntry(idx))}
        </div>

        {error && <div className={styles.error}>{error}</div>}
        <button type="button" className={styles.confirmBtn} onClick={submit} disabled={saving}>
          {saving ? "저장 중..." : "확인"}
        </button>
      </div>
      {zoom && (
        <div className={styles.zoomOverlay} onClick={(e) => { e.stopPropagation(); setZoom(""); }}>
          <img src={zoom} alt="확대" className={styles.zoomImg} />
        </div>
      )}
    </div>
  );
}
