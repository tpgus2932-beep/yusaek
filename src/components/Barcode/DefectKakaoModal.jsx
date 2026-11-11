import { useEffect, useMemo, useState } from "react";
import { LOCAL_API_BASE as API, getAuthHeaders, handleUnauthorized } from "../../lib/api";
import { call, newRequestId, uploadPhoto } from "../KakaoTalk/kakaoApi";
import styles from "./BarcodePage.module.css";

const MAX_IMAGES = 10; // 카톡 한 번에 보낼 수 있는 사진 수

// 거래처별 메시지: 상품마다 "상품명 색상 사이즈 [수량>1이면 수량]사유,사유2" 한 줄.
const buildText = (items) => {
  const lines = items.map((it) => {
    const base = [it.productName || it.ownName || it.code, it.color, it.size].filter(Boolean).join(" ");
    const reasons = (it.records || []).map((r) => String(r.reason || "").trim()).filter(Boolean).join(",");
    return `${base} ${it.qty > 1 ? it.qty : ""}${reasons}`.trimEnd();
  });
  return `안녕하세요 사장님!\n${lines.join("\n")}\n불량 올리겠습니다!`;
};

/**
 * 불량 목록을 거래처별로 묶어 카카오톡으로 (사진 + 문구) 보낸다.
 * 처음 보는 거래처는 카카오톡 친구를 직접 골라 매칭하고, 그 매칭은 서버에 저장돼 다음부터 자동으로 쓴다.
 */
export default function DefectKakaoModal({ open, onClose, counts, tabHeaders }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [rows, setRows] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [vendorMap, setVendorMap] = useState({}); // { 거래처: contact_id }
  const [picks, setPicks] = useState({}); // 매칭 전 선택 { 거래처: contact_id }
  const [filters, setFilters] = useState({}); // 친구 검색어 { 거래처: text }
  const [editing, setEditing] = useState({}); // 매칭 변경 중인 거래처
  const [status, setStatus] = useState({}); // { 거래처: {busy, msg, ok} }

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError("");
      setStatus({});
      setPicks({});
      setEditing({});
      try {
        const [handoff, map, kakao] = await Promise.all([
          fetch(`${API}/barcode/defect/purchase-manager-handoff`, {
            method: "POST", headers: { "Content-Type": "application/json", ...tabHeaders() }, body: JSON.stringify({ counts }),
          }),
          fetch(`${API}/barcode/defect/kakao-vendor-map`, { headers: getAuthHeaders() }),
          call("/contacts"),
        ]);
        if (handleUnauthorized(handoff) || handleUnauthorized(map)) return;
        const handoffData = await handoff.json().catch(() => ({}));
        const mapData = await map.json().catch(() => ({}));
        if (!handoff.ok) throw new Error(handoffData?.detail || "불량 목록을 불러오지 못했습니다.");
        if (cancelled) return;
        setRows(handoffData.rows || []);
        setVendorMap(mapData.map || {});
        setContacts((kakao.contacts || []).filter((c) => c.kind !== "group"));
      } catch (e) {
        if (!cancelled) setError(e.message || "불러오기 실패");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const groups = useMemo(() => {
    const byVendor = new Map();
    rows.forEach((r) => {
      const v = String(r.vendor || "").trim();
      if (!byVendor.has(v)) byVendor.set(v, []);
      byVendor.get(v).push(r);
    });
    return [...byVendor.entries()].map(([vendor, items]) => ({ vendor, items })).sort((a, b) => a.vendor.localeCompare(b.vendor));
  }, [rows]);

  const contactById = useMemo(() => new Map(contacts.map((c) => [c.id, c])), [contacts]);
  const setSt = (vendor, patch) => setStatus((p) => ({ ...p, [vendor]: { ...p[vendor], ...patch } }));

  const saveMatch = async (vendor) => {
    const contactId = Number(picks[vendor]);
    if (!contactId) { setSt(vendor, { msg: "카카오톡 친구를 선택하세요.", ok: false }); return; }
    try {
      const res = await fetch(`${API}/barcode/defect/kakao-vendor-map`, {
        method: "POST", headers: { "Content-Type": "application/json", ...getAuthHeaders() }, body: JSON.stringify({ vendor, contact_id: contactId }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "매칭 저장 실패");
      setVendorMap((p) => ({ ...p, [vendor]: contactId }));
      setEditing((p) => ({ ...p, [vendor]: false }));
      setSt(vendor, { msg: "", ok: true });
    } catch (e) { setSt(vendor, { msg: e.message || "매칭 저장 실패", ok: false }); }
  };

  const send = async (g) => {
    const contact = contactById.get(vendorMap[g.vendor]);
    if (!contact) return;
    if (!window.confirm(`${g.vendor} → 카카오톡 "${contact.name}"에게 ${g.items.length}개 상품 불량을 보낼까요?`)) return;
    setSt(g.vendor, { busy: true, msg: "사진 올리는 중...", ok: undefined });
    try {
      const photoIds = [...new Set(g.items.flatMap((it) => (it.records || []).flatMap((r) => r.photo_ids || [])))];
      const mediaIds = [];
      for (const pid of photoIds) {
        const res = await fetch(`${API}/barcode/defect/record/photo/${pid}`, { headers: getAuthHeaders() });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.data_url) throw new Error("불량 사진을 불러오지 못했습니다.");
        const blob = await (await fetch(data.data_url)).blob();
        const uploaded = await uploadPhoto(new File([blob], `defect-${pid}.jpg`, { type: blob.type || "image/jpeg" }));
        mediaIds.push(uploaded.id);
      }
      const text = buildText(g.items);
      setSt(g.vendor, { msg: "전송 요청 중..." });
      if (mediaIds.length === 0) {
        await call("/send", { method: "POST", body: { contact_id: contact.id, text, request_id: newRequestId() } });
      } else {
        const chunks = [];
        for (let i = 0; i < mediaIds.length; i += MAX_IMAGES) chunks.push(mediaIds.slice(i, i + MAX_IMAGES));
        for (let i = 0; i < chunks.length; i += 1) {
          // 문구는 마지막 사진 묶음 바로 뒤에 붙는다
          await call("/send-images", {
            method: "POST",
            body: { contact_id: contact.id, media_ids: chunks[i], text: i === chunks.length - 1 ? text : "", request_id: newRequestId() },
          });
        }
      }
      setSt(g.vendor, { busy: false, ok: true, msg: `전송 요청됨 (사진 ${mediaIds.length}장)` });
    } catch (e) {
      setSt(g.vendor, { busy: false, ok: false, msg: e.message || "전송 실패" });
    }
  };

  if (!open) return null;
  return (
    <div className={styles.modalOverlay} style={{ zIndex: 70 }} onClick={onClose}>
      <div className={`${styles.modal} ${styles.mobileCompactModal}`} style={{ maxHeight: "90vh", overflowY: "auto" }} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHeader}>
          <h4 className={styles.modalTitle}>거래처 카톡 불량 전송</h4>
          <div className={styles.modalActions}>
            <button className={styles.secondaryBtn} onClick={onClose}>닫기</button>
          </div>
        </div>
        {loading && <div className={styles.statusMsg}>불러오는 중...</div>}
        {error && <div className={styles.statusMsg} style={{ color: "#dc2626" }}>{error}</div>}
        {!loading && !error && groups.length === 0 && <div className={styles.empty}>보낼 불량이 없습니다.</div>}
        {groups.map((g) => {
          const st = status[g.vendor] || {};
          const contact = contactById.get(vendorMap[g.vendor]);
          const matched = Boolean(contact) && !editing[g.vendor];
          const kw = (filters[g.vendor] || "").trim().toLowerCase();
          const options = contacts.filter((c) => !kw || c.name.toLowerCase().includes(kw)).slice(0, 60);
          return (
            <div key={g.vendor || "(none)"} style={{ borderTop: "1px solid var(--border-color)", padding: "0.75rem 0" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
                <strong>{g.vendor || "(거래처 없음)"}</strong>
                <span className={styles.pill}>{g.items.length}종</span>
              </div>
              <pre style={{ whiteSpace: "pre-wrap", margin: "0.4rem 0", fontFamily: "inherit", fontSize: "0.9em", background: "var(--bg-secondary)", padding: "0.5rem", borderRadius: 6 }}>
                {buildText(g.items)}
              </pre>
              <div className={styles.inlineMeta}>
                사진 {new Set(g.items.flatMap((it) => (it.records || []).flatMap((r) => r.photo_ids || []))).size}장
              </div>
              {!g.vendor ? (
                <div style={{ color: "#dc2626" }}>거래처가 없어 보낼 수 없습니다. 원가베이스유에서 거래처를 확인하세요.</div>
              ) : matched ? (
                <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap", marginTop: "0.4rem" }}>
                  <span className={styles.pill}>카톡: {contact.name}</span>
                  <button className={styles.primaryBtn} disabled={st.busy} onClick={() => send(g)}>
                    {st.busy ? "처리 중..." : st.ok ? "다시 전송" : "카톡 전송"}
                  </button>
                  <button className={styles.ghostBtn} disabled={st.busy} onClick={() => { setEditing((p) => ({ ...p, [g.vendor]: true })); setPicks((p) => ({ ...p, [g.vendor]: String(contact.id) })); }}>
                    매칭 변경
                  </button>
                </div>
              ) : (
                <div style={{ marginTop: "0.4rem" }}>
                  <div style={{ color: "#b45309", marginBottom: "0.3rem" }}>
                    {contact ? "매칭된 카톡을 바꿉니다." : "처음 보내는 거래처입니다. 카카오톡 친구를 직접 골라 매칭하세요. (한 번 저장하면 다음부터 자동)"}
                  </div>
                  <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                    <input
                      className={styles.searchInput}
                      placeholder="카톡 친구 검색"
                      value={filters[g.vendor] || ""}
                      onChange={(e) => setFilters((p) => ({ ...p, [g.vendor]: e.target.value }))}
                    />
                    <select
                      className={styles.searchInput}
                      value={picks[g.vendor] || ""}
                      onChange={(e) => setPicks((p) => ({ ...p, [g.vendor]: e.target.value }))}
                    >
                      <option value="">친구 선택 ({options.length}명)</option>
                      {options.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                    <button className={styles.primaryBtn} onClick={() => saveMatch(g.vendor)}>매칭 저장</button>
                    {contact && <button className={styles.ghostBtn} onClick={() => setEditing((p) => ({ ...p, [g.vendor]: false }))}>취소</button>}
                  </div>
                </div>
              )}
              {st.msg && <div style={{ marginTop: "0.3rem", color: st.ok === false ? "#dc2626" : "#15803d" }}>{st.msg}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
