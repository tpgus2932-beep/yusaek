import React, { useRef, useState } from "react";
import styles from "./MobileRequestKimsungilPage.module.css";

const API = `http://${window.location.hostname}:8000`;
const TARGET_DISPLAY_NAME = "김승일";

export default function MobileRequestKimsungilPage() {
  const [requestText, setRequestText] = useState("");
  const [requestFiles, setRequestFiles] = useState([]);
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const fileInputRef = useRef(null);

  const handlePaste = (e) => {
    const items = e.clipboardData?.items;
    if (!items?.length) return;
    const imageFiles = [];
    for (const item of items) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const blob = item.getAsFile();
        if (!blob) continue;
        const ext = blob.type.split("/")[1] || "png";
        imageFiles.push(new File([blob], `paste-${Date.now()}-${imageFiles.length}.${ext}`, { type: blob.type }));
      }
    }
    if (imageFiles.length) {
      e.preventDefault();
      setRequestFiles((prev) => [...prev, ...imageFiles]);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setMessage("");
    setError("");
    if (!requestText.trim()) {
      setError("요청 내용을 입력하세요.");
      return;
    }

    try {
      setSending(true);
      const formData = new FormData();
      formData.append("text", requestText.trim());
      requestFiles.forEach((file) => formData.append("files", file));

      const res = await fetch(`${API}/requests/public/kimsungil`, {
        method: "POST",
        body: formData,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "요청 전송 실패");

      setRequestText("");
      setRequestFiles([]);
      if (fileInputRef.current) fileInputRef.current.value = "";
      setMessage(`${TARGET_DISPLAY_NAME}에게 요청을 보냈습니다.`);
    } catch (err) {
      setError(err.message || "요청 전송 실패");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.shell}>
        <header className={styles.header}>
          <div>
            <h1 className={styles.title}>요청 보내기</h1>
            <p className={styles.subtitle}>모바일 전용 / 수신자 고정</p>
          </div>
        </header>

        <section className={styles.card}>
          <div className={styles.targetRow}>
            <span className={styles.label}>받는 사람</span>
            <strong className={styles.targetName}>{TARGET_DISPLAY_NAME}</strong>
            <span className={styles.targetMeta}>보내는 사람: 익명</span>
          </div>

          <form className={styles.form} onSubmit={handleSubmit}>
            <label className={styles.field}>
              <span className={styles.label}>요청 내용</span>
              <textarea
                className={styles.textarea}
                rows={8}
                value={requestText}
                onChange={(e) => setRequestText(e.target.value)}
                onPaste={handlePaste}
                placeholder="김승일에게 보낼 요청 내용을 입력하세요."
              />
            </label>

            <div className={styles.field}>
              <span className={styles.label}>첨부 파일</span>
              <div className={styles.attachBox}>
                <button
                  type="button"
                  className={styles.secondaryBtn}
                  onClick={() => fileInputRef.current?.click()}
                  disabled={sending}
                >
                  파일 선택
                </button>
                <span className={styles.attachHint}>
                  {requestFiles.length ? `${requestFiles.length}개 선택됨` : "선택된 파일 없음"}
                </span>
                <input
                  ref={fileInputRef}
                  className={styles.hiddenInput}
                  type="file"
                  multiple
                  accept=".xlsx,.xls,.csv,.jpg,.jpeg,.png,.gif,.webp"
                  onChange={(e) => setRequestFiles(Array.from(e.target.files || []))}
                />
              </div>
              <div className={styles.smallText}>사진은 붙여넣기(Ctrl+V)도 가능합니다.</div>
              {requestFiles.length > 0 && (
                <div className={styles.fileList}>{requestFiles.map((f) => f.name).join(", ")}</div>
              )}
            </div>

            {error && <div className={styles.error}>{error}</div>}
            {message && <div className={styles.success}>{message}</div>}

            <button
              type="submit"
              className={styles.primaryBtn}
              disabled={sending}
            >
              {sending ? "전송 중..." : `${TARGET_DISPLAY_NAME}에게 요청 보내기`}
            </button>
          </form>
        </section>
      </div>
    </div>
  );
}
