import { useState } from "react";
import { LOCAL_API_BASE as API, getAuthHeaders, handleUnauthorized } from "../../lib/api";
import styles from "../Barcode/DefectRecord.module.css";

const formatDate = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 16).replace("T", " ");
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

// 매입관리 탭에서 불량 등록 때 남긴 사진·사유를 조회한다 (DB 기준이라 불량 목록에서 빠진 상품도 조회됨).
// 사유와 사진은 기본 숨김이고, 눌러야 보인다.
export default function DefectRecordsViewer() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [records, setRecords] = useState(null); // null = 아직 조회 안 함
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showReason, setShowReason] = useState({});
  const [showPhotos, setShowPhotos] = useState({});
  const [photoCache, setPhotoCache] = useState({});
  const [zoom, setZoom] = useState("");

  const search = async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ q: q.trim(), date_from: dateFrom, date_to: dateTo, limit: "200" });
      const res = await fetch(`${API}/barcode/defect/record/search?${params}`, { headers: getAuthHeaders() });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "조회 실패");
      setRecords(data.records || []);
      setShowReason({});
      setShowPhotos({});
    } catch (err) {
      setError(err.message || "조회 실패");
    } finally {
      setLoading(false);
    }
  };

  const loadPhotos = async (ids) => {
    const missing = ids.filter((id) => !photoCache[id]);
    if (missing.length === 0) return;
    const results = await Promise.all(
      missing.map(async (id) => {
        try {
          const res = await fetch(`${API}/barcode/defect/record/photo/${id}`, { headers: getAuthHeaders() });
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

  return (
    <div style={{ marginBottom: "0.75rem" }}>
      <button
        type="button"
        className={styles.smallBtn}
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next && records === null) search();
        }}
      >
        불량 사진·사유 조회 {open ? "▴" : "▾"}
      </button>

      {open && (
        <div style={{ marginTop: "0.5rem", border: "1px solid var(--border-color, #e5e7eb)", borderRadius: 10, padding: "0.7rem" }}>
          <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap", alignItems: "center" }}>
            <input
              className={styles.reasonInput}
              style={{ flex: "1 1 180px", width: "auto" }}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") search(); }}
              placeholder="상품명 / 상품코드 / 사유"
            />
            <input type="date" className={styles.reasonInput} style={{ width: "auto" }} value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
            <span>~</span>
            <input type="date" className={styles.reasonInput} style={{ width: "auto" }} value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
            <button type="button" className={styles.smallBtn} onClick={search} disabled={loading}>
              {loading ? "조회 중..." : "조회"}
            </button>
          </div>

          {error && <div className={styles.error} style={{ marginTop: "0.5rem" }}>{error}</div>}

          {records && records.length === 0 && !error && (
            <div className={styles.hint} style={{ marginTop: "0.6rem" }}>조회된 사진·사유 기록이 없습니다.</div>
          )}

          {records && records.length > 0 && (
            <div className={styles.recordList} style={{ marginTop: "0.6rem", maxHeight: 480, overflowY: "auto" }}>
              {records.map((record) => (
                <div key={record.id} className={styles.recordItem}>
                  <div style={{ fontWeight: 600, fontSize: "0.9rem", wordBreak: "break-all" }}>{record.product_name || record.code}</div>
                  <div className={styles.hint}>
                    {record.code} · {record.tab}탭 · 수량 {record.qty} · {formatDate(record.created_at)}
                    {record.username ? ` · ${record.username}` : ""}
                  </div>
                  <div className={styles.recordTop}>
                    <button type="button" className={styles.smallBtn} onClick={() => setShowReason((p) => ({ ...p, [record.id]: !p[record.id] }))}>
                      사유
                    </button>
                    <button type="button" className={styles.smallBtn} onClick={() => togglePhotos(record)} disabled={record.photo_ids.length === 0}>
                      사진 {record.photo_ids.length}
                    </button>
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
                </div>
              ))}
            </div>
          )}
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
