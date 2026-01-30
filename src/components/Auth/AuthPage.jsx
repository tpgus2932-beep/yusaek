import { useState } from "react";
import styles from "./AuthPage.module.css";

const API = `http://${window.location.hostname}:8000`;

export default function AuthPage({ onAuth }) {
  const [mode, setMode] = useState("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const resetError = () => setError("");

  const handleSubmit = async (e) => {
    e.preventDefault();
    resetError();
    if (!username || !password || (mode === "register" && !displayName)) {
      setError("아이디, 비밀번호, 이름을 입력해주세요.");
      return;
    }
    if (mode === "register" && password !== confirm) {
      setError("비밀번호가 일치하지 않습니다.");
      return;
    }

    try {
      setLoading(true);
      if (mode === "register") {
        const res = await fetch(`${API}/auth/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password, display_name: displayName }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.detail || "회원가입 실패");
      }

      const res = await fetch(`${API}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "로그인 실패");

      if (data?.token) onAuth(data.token, data.display_name || data.username, data.username);
    } catch (err) {
      setError(err.message || "요청 실패");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <div className={styles.header}>
          <h1>YUSAEK</h1>
          <p>{mode === "login" ? "로그인" : "회원가입"}</p>
        </div>

        <form className={styles.form} onSubmit={handleSubmit}>
          <label className={styles.label}>
            아이디
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onFocus={resetError}
              placeholder="아이디"
            />
          </label>

          <label className={styles.label}>
            비밀번호
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onFocus={resetError}
              placeholder="비밀번호"
            />
          </label>

          {mode === "register" && (
            <label className={styles.label}>
              이름
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                onFocus={resetError}
                placeholder="이름"
              />
            </label>
          )}

          {mode === "register" && (
            <label className={styles.label}>
              비밀번호 확인
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                onFocus={resetError}
                placeholder="비밀번호 확인"
              />
            </label>
          )}

          {error && <div className={styles.error}>{error}</div>}

          <button className={styles.primaryBtn} type="submit" disabled={loading}>
            {loading ? "처리 중..." : mode === "login" ? "로그인" : "회원가입"}
          </button>
        </form>

        <div className={styles.switchRow}>
          {mode === "login" ? "계정이 없나요?" : "이미 계정이 있나요?"}
          <button
            type="button"
            className={styles.linkBtn}
            onClick={() => {
              setMode(mode === "login" ? "register" : "login");
              setError("");
            }}
          >
            {mode === "login" ? "회원가입" : "로그인"}
          </button>
        </div>
      </div>
    </div>
  );
}
