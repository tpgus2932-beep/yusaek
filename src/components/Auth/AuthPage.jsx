import { useEffect, useState } from "react";
import styles from "./AuthPage.module.css";
import { COLLAB_API_BASE as API } from "../../lib/api";

export default function AuthPage({
  onAuth,
  title = "YUSAEK",
  loginSubtitle = "계정을 선택하세요",
  registerSubtitle = "회원가입",
  registerSuccessMessage = "회원가입이 완료되었습니다. 관리자 승인 후 로그인 가능합니다.",
}) {
  const [mode, setMode] = useState("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  const resetFeedback = () => {
    setError("");
    setMessage("");
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    resetFeedback();
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
        setMessage(registerSuccessMessage);
        setMode("login");
        setPassword("");
        setConfirm("");
        return;
      }

    } catch (err) {
      setError(err.message || "요청 실패");
    } finally {
      setLoading(false);
    }
  };

  const [accounts, setAccounts] = useState([]);

  useEffect(() => {
    fetch(`${API}/auth/accounts`)
      .then((res) => res.json())
      .then((data) => setAccounts(Array.isArray(data?.accounts) ? data.accounts : []))
      .catch(() => setError("계정 목록을 불러오지 못했습니다."));
  }, []);

  const handleSelect = async (account) => {
    resetFeedback();
    try {
      setLoading(true);
      const res = await fetch(`${API}/auth/select`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: account.username }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "입장 실패");
      if (data?.token) onAuth(data.token, data.display_name || data.username, data.username, !!data.is_admin, data.role || "user", data.phone_number || "");
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
          <h1>{title}</h1>
          <p>{mode === "login" ? loginSubtitle : registerSubtitle}</p>
        </div>

        {mode === "login" && (
          <div className={styles.form}>
            <div className={styles.accountList}>
              {accounts.map((a) => (
                <button
                  key={a.username}
                  type="button"
                  className={styles.accountBtn}
                  disabled={loading}
                  onClick={() => handleSelect(a)}
                >
                  <span>{a.display_name}</span>
                  <span className={styles.accountId}>{a.username}</span>
                </button>
              ))}
            </div>
            {message && <div className={styles.success}>{message}</div>}
            {error && <div className={styles.error}>{error}</div>}
          </div>
        )}

        {mode === "register" && (
        <form className={styles.form} onSubmit={handleSubmit}>
          <label className={styles.label}>
            아이디
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onFocus={resetFeedback}
              placeholder="아이디"
            />
          </label>

          <label className={styles.label}>
            비밀번호
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onFocus={resetFeedback}
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
                onFocus={resetFeedback}
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
                onFocus={resetFeedback}
                placeholder="비밀번호 확인"
              />
            </label>
          )}

          {message && <div className={styles.success}>{message}</div>}
          {error && <div className={styles.error}>{error}</div>}

          <button className={styles.primaryBtn} type="submit" disabled={loading}>
            {loading ? "처리 중..." : "회원가입"}
          </button>
        </form>
        )}

        <div className={styles.switchRow}>
          {mode === "login" ? "계정이 없나요?" : "이미 계정이 있나요?"}
          <button
            type="button"
            className={styles.linkBtn}
            onClick={() => {
              setMode(mode === "login" ? "register" : "login");
              resetFeedback();
            }}
          >
            {mode === "login" ? "회원가입" : "로그인"}
          </button>
        </div>
      </div>
    </div>
  );
}
