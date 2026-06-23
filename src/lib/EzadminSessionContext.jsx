import { createContext, useContext, useRef, useState } from "react";
import { LOCAL_API_BASE as API, getAuthHeaders } from "./api";

const EzadminSessionContext = createContext(null);

export function EzadminSessionProvider({ children }) {
  const [show, setShow] = useState(false);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState("");
  const retryFn = useRef(null);

  const openModal = (fn) => {
    retryFn.current = fn;
    setMsg("");
    setShow(true);
  };

  const saveSession = async () => {
    const phpsessid = input.trim();
    if (!phpsessid) { setMsg("PHPSESSID를 입력해주세요."); return; }
    try {
      setLoading(true); setMsg("저장 중...");
      const res = await fetch(`${API}/ezadmin/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ phpsessid }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) throw new Error(data?.detail || "세션 저장 실패");
      setShow(false);
      setInput("");
      await retryFn.current?.();
    } catch (err) {
      setMsg(err.message || "세션 저장 실패");
    } finally { setLoading(false); }
  };

  return (
    <EzadminSessionContext.Provider value={{ openModal }}>
      {children}
      {show && (
        <div
          onClick={() => { setShow(false); setMsg(""); }}
          style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)",
            display: "flex", alignItems: "center", justifyContent: "center",
            padding: "1.5rem", zIndex: 9999,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "var(--bg-primary)", borderRadius: "var(--radius-lg)",
              border: "1px solid var(--border-color)", boxShadow: "var(--card-shadow)",
              width: "min(480px, 92vw)", padding: "1.25rem",
              display: "flex", flexDirection: "column", gap: "1rem",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontSize: "1.1rem", fontWeight: 700 }}>EZAdmin 세션 쿠키 입력</span>
              <button
                onClick={() => { setShow(false); setMsg(""); }}
                style={{ padding: "0.3rem 0.8rem", cursor: "pointer", borderRadius: "var(--radius-sm)", border: "1px solid var(--border-color)", background: "var(--bg-secondary)", color: "var(--text-primary)" }}
              >닫기</button>
            </div>
            <p style={{ color: "var(--text-muted)", fontSize: "0.9rem", margin: 0 }}>
              EZAdmin에 로그인 후 개발자 도구(F12) → 쿠키에서 PHPSESSID 값을 복사해 입력하세요.
            </p>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") saveSession(); }}
              placeholder="PHPSESSID 값 붙여넣기"
              autoFocus
              style={{
                padding: "0.6rem 0.8rem", borderRadius: "var(--radius-sm)",
                border: "1px solid var(--border-color)", background: "var(--bg-secondary)",
                color: "var(--text-primary)", fontSize: "0.95rem", width: "100%", boxSizing: "border-box",
              }}
            />
            {msg && (
              <div style={{
                padding: "0.6rem 0.8rem", borderRadius: "var(--radius-sm)",
                border: "1px solid rgba(220,53,69,0.4)", background: "rgba(220,53,69,0.07)",
                color: "var(--text-primary)", fontSize: "0.9rem",
              }}>
                <strong>{msg}</strong>
              </div>
            )}
            <button
              onClick={saveSession}
              disabled={loading}
              style={{
                padding: "0.6rem 1rem", borderRadius: "var(--radius-sm)", cursor: "pointer",
                background: "var(--accent)", color: "#fff", border: "none",
                fontWeight: 600, fontSize: "0.95rem", opacity: loading ? 0.7 : 1,
              }}
            >
              {loading ? "저장 중..." : "저장 후 불러오기"}
            </button>
          </div>
        </div>
      )}
    </EzadminSessionContext.Provider>
  );
}

export const useEzadminSession = () => useContext(EzadminSessionContext);
