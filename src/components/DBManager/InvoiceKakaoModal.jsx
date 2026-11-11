import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LOCAL_API_BASE as API, getAuthHeaders, handleUnauthorized } from "../../lib/api";
import { call } from "../KakaoTalk/kakaoApi";
import styles from "./DBManager.module.css";

const POLL_MS = 10000;

const isoDay = (offset = 0) => {
  const d = new Date();
  d.setDate(d.getDate() - offset);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const fmtTime = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/**
 * 계산서 관리: 거래처와 주고받은 카카오톡 대화를 본다.
 * 처음 보는 거래처는 카카오톡 친구를 직접 골라 매칭하고, 그 매칭은 서버에 저장돼 다음부터 자동으로 쓴다.
 * (바코드 불량 카톡 전송과 같은 거래처↔친구 매칭을 함께 쓴다.)
 */
export default function InvoiceKakaoModal({ vendor, onClose }) {
  const [contacts, setContacts] = useState([]);
  const [contactId, setContactId] = useState(null); // 매칭된 카톡 친구
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [messages, setMessages] = useState([]);
  const [msgError, setMsgError] = useState("");
  const [editing, setEditing] = useState(false);
  const [pick, setPick] = useState("");
  const [filter, setFilter] = useState("");
  const [saving, setSaving] = useState(false);
  const scroller = useRef(null);
  const [since, setSince] = useState(() => isoDay(0)); // 대화 동기화 시작일
  const [syncOpen, setSyncOpen] = useState(false);
  const [syncing, setSyncing] = useState(false); // 이 거래처 대화를 폰에서 읽는 중
  const [syncMsg, setSyncMsg] = useState({ text: "", ok: true });
  const wasSyncing = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [mapRes, kakao] = await Promise.all([
          fetch(`${API}/barcode/defect/kakao-vendor-map`, { headers: getAuthHeaders() }),
          call("/contacts"),
        ]);
        if (handleUnauthorized(mapRes)) return;
        const mapData = await mapRes.json().catch(() => ({}));
        if (cancelled) return;
        setContacts(kakao.contacts || []);
        setContactId(mapData.map?.[vendor] || null);
      } catch (e) {
        if (!cancelled) setError(e.message || "불러오기 실패");
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => { cancelled = true; };
  }, [vendor]);

  const contact = useMemo(() => contacts.find((c) => c.id === contactId) || null, [contacts, contactId]);

  const loadMessages = useCallback(async () => {
    if (!contactId) return;
    try {
      const data = await call("/messages", { params: { contact_id: contactId } });
      setMessages(data.messages || []);
      setMsgError("");
    } catch (e) {
      setMsgError(e.message || "대화를 불러오지 못했습니다.");
    }
  }, [contactId]);

  useEffect(() => {
    if (!contact) return undefined;
    loadMessages();
    const timer = window.setInterval(loadMessages, POLL_MS);
    return () => window.clearInterval(timer);
  }, [contact, loadMessages]);

  // 폰에서 대화를 읽는 동안 상태를 짧게 확인하고, 끝나면 결과를 보여준 뒤 대화를 다시 읽는다.
  useEffect(() => {
    if (!syncing || !contactId) return undefined;
    wasSyncing.current = true;
    const timer = window.setInterval(async () => {
      try {
        const st = await call("/status");
        const rs = st.roomSync || {};
        if (rs.running) return;
        window.clearInterval(timer);
        setSyncing(false);
        if (rs.error) setSyncMsg({ text: `대화 동기화 실패: ${rs.error}`, ok: false });
        else if (rs.result) {
          const r = rs.result;
          setSyncMsg({ text: `${r.since}부터 대화 ${r.read}개를 확인해 ${r.added}개를 가져왔습니다.`, ok: true });
        } else setSyncMsg({ text: "대화 동기화가 끝났습니다.", ok: true });
        loadMessages();
      } catch {
        /* 일시 오류는 다음 확인에서 복구 */
      }
    }, 1500);
    return () => window.clearInterval(timer);
  }, [syncing, contactId, loadMessages]);

  const startSync = async () => {
    if (!contactId || !since || syncing) return;
    setSyncMsg({ text: "", ok: true });
    try {
      await call(`/contacts/${contactId}/sync-room`, { method: "POST", body: { since } });
      setSyncOpen(false);
      setSyncing(true);
      setSyncMsg({ text: `${since}부터 폰에서 대화를 읽는 중입니다. 끝날 때까지 폰을 만지지 마세요.`, ok: true });
    } catch (e) {
      setSyncMsg({ text: e.message || "동기화를 시작하지 못했습니다.", ok: false });
    }
  };

  // 새 메시지가 오면 맨 아래로
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [messages.length, contactId]);

  const saveMatch = async () => {
    const id = Number(pick);
    if (!id) { setError("카카오톡 친구를 선택하세요."); return; }
    setSaving(true);
    setError("");
    try {
      const res = await fetch(`${API}/barcode/defect/kakao-vendor-map`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ vendor, contact_id: id }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "매칭 저장 실패");
      setContactId(id);
      setMessages([]);
      setEditing(false);
    } catch (e) {
      setError(e.message || "매칭 저장 실패");
    } finally {
      setSaving(false);
    }
  };

  const showMatchForm = ready && (!contact || editing);
  const kw = filter.trim().toLowerCase();
  const options = contacts.filter((c) => !kw || c.name.toLowerCase().includes(kw)).slice(0, 60);
  const visibleMessages = messages.filter((m) => !m.dryRun && m.status !== "cancelled");

  return (
    <div className={styles.catOverlay} onClick={onClose}>
      <div className={styles.catModal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.catHeader}>
          <strong>{vendor} · 카톡</strong>
          {contact && !editing && <span>{contact.name}</span>}
          {contact && !editing && (
            <span>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnSecondary}`}
                onClick={() => { setEditing(true); setPick(String(contact.id)); setError(""); }}
              >
                매칭 변경
              </button>{" "}
              <button
                type="button"
                className={`${styles.btn} ${styles.btnSecondary}`}
                disabled={syncing}
                onClick={() => setSyncOpen((v) => !v)}
                title="폰의 카카오톡 대화를 날짜부터 읽어와 웹에 없는 대화를 채웁니다"
              >
                {syncing ? "동기화 중..." : "대화 동기화"}
              </button>{" "}
              <button type="button" className={`${styles.btn} ${styles.btnSecondary}`} onClick={loadMessages}>새로고침</button>
            </span>
          )}
        </div>

        {showMatchForm && (
          <div style={{ padding: "12px 16px", borderBottom: "1px solid #e5e7eb" }}>
            <div style={{ color: "#b45309", marginBottom: 8 }}>
              {contact
                ? "매칭된 카톡을 바꿉니다."
                : "처음 보는 거래처입니다. 카카오톡 친구를 직접 골라 매칭하세요. (한 번 저장하면 다음부터 자동)"}
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <input
                className={styles.inlineInput}
                style={{ flex: "1 1 160px" }}
                placeholder="카톡 친구 검색"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
              <select
                className={styles.inlineInput}
                style={{ flex: "1 1 200px" }}
                value={pick}
                onChange={(e) => setPick(e.target.value)}
              >
                <option value="">친구 선택 ({options.length}명)</option>
                {options.map((c) => (
                  <option key={c.id} value={c.id}>{c.kind === "group" ? `[단톡] ${c.name}` : c.name}</option>
                ))}
              </select>
              <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={saving} onClick={saveMatch}>
                {saving ? "저장 중..." : "매칭 저장"}
              </button>
              {contact && (
                <button type="button" className={`${styles.btn} ${styles.btnSecondary}`} onClick={() => { setEditing(false); setError(""); }}>
                  취소
                </button>
              )}
            </div>
          </div>
        )}

        {contact && !editing && syncOpen && (
          <div style={{ padding: "12px 16px", borderBottom: "1px solid #e5e7eb" }}>
            <div style={{ marginBottom: 8, color: "#374151" }}>
              선택한 날짜부터 지금까지, 폰 대화방에 있고 웹에 없는 대화만 가져옵니다. 읽는 동안 폰을 만지지 마세요.
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
              {[[0, "오늘"], [1, "어제"], [3, "3일"], [7, "7일"], [30, "30일"]].map(([d, label]) => (
                <button
                  key={label}
                  type="button"
                  className={`${styles.btn} ${since === isoDay(d) ? styles.btnPrimary : styles.btnSecondary}`}
                  onClick={() => setSince(isoDay(d))}
                >
                  {label}
                </button>
              ))}
              <input type="date" className={styles.inlineInput} value={since} max={isoDay(0)} onChange={(e) => setSince(e.target.value)} />
              <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={!since || syncing} onClick={startSync}>
                {since ? `${since}부터 동기화` : "날짜를 선택하세요"}
              </button>
            </div>
          </div>
        )}
        {syncMsg.text && (
          <div style={{ padding: "8px 16px", color: syncMsg.ok ? "#15803d" : "#dc2626", borderBottom: "1px solid #e5e7eb" }}>{syncMsg.text}</div>
        )}

        {error && <div className={styles.catEmpty} style={{ color: "#dc2626" }}>{error}</div>}

        <div className={styles.catList} ref={scroller} style={{ background: "#f3f4f6" }}>
          {!ready && <div className={styles.catEmpty}>불러오는 중...</div>}
          {ready && contact && !editing && msgError && <div className={styles.catEmpty} style={{ color: "#dc2626" }}>{msgError}</div>}
          {ready && contact && !editing && !msgError && visibleMessages.length === 0 && (
            <div className={styles.catEmpty}>저장된 대화가 없습니다. (카카오톡 페이지에서 대화 동기화를 하면 폰의 대화가 들어옵니다)</div>
          )}
          {contact && !editing && visibleMessages.map((m) => {
            const mine = m.direction !== "in";
            const photos = (m.mediaIds || []).length;
            return (
              <div key={m.id} style={{ display: "flex", justifyContent: mine ? "flex-end" : "flex-start", margin: "6px 12px" }}>
                <div style={{ maxWidth: "78%" }}>
                  {!mine && m.sender && <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 2 }}>{m.sender}</div>}
                  <div
                    style={{
                      background: mine ? "#fee500" : "#fff",
                      borderRadius: 10,
                      padding: "7px 10px",
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                      boxShadow: "0 1px 1px rgba(0,0,0,0.08)",
                    }}
                  >
                    {photos > 0 && <div style={{ color: "#6b7280" }}>[사진 {photos}장]</div>}
                    {m.text}
                  </div>
                  <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 2, textAlign: mine ? "right" : "left" }}>
                    {fmtTime(m.createdAt)}
                    {mine && m.status === "failed" && <span style={{ color: "#dc2626" }}> · 전송 실패</span>}
                    {mine && m.status === "queued" && <span> · 대기 중</span>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className={styles.catFooter}>
          <span style={{ marginRight: "auto", color: "#6b7280", fontSize: 12 }}>
            {contact && !editing ? `최근 ${visibleMessages.length}개 · ${POLL_MS / 1000}초마다 갱신` : ""}
          </span>
          <button className={`${styles.btn} ${styles.btnSecondary}`} onClick={onClose}>닫기</button>
        </div>
      </div>
    </div>
  );
}
