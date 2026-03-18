import React, { useCallback, useEffect, useState } from "react";
import styles from "./BarcodePage.module.css";
import { LOCAL_API_BASE as API, getAuthHeaders, handleUnauthorized } from "../../lib/api";

const COLUMNS = [
  { n: 1, label: "상품명 (G+I 가공)", defaultHeader: "상품명" },
  { n: 2, label: "상품코드 (원가베이스)", defaultHeader: "상품코드" },
  { n: 3, label: "수량 (J열)", defaultHeader: "수량" },
];

export default function JejuHapbaePage({ headerExtra = null }) {
  const [file, setFile] = useState(null);
  const [headers, setHeaders] = useState(["상품명", "상품코드", "수량"]);
  const [includes, setIncludes] = useState([true, true, true]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [costBase, setCostBase] = useState(null);

  const fetchCostBaseStatus = useCallback(async () => {
    try {
      const res = await fetch(`${API}/amood-hapbae/cost-base/status`, {
        headers: getAuthHeaders(),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (res.ok) setCostBase(data.status || null);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    fetchCostBaseStatus();
  }, [fetchCostBaseStatus]);

  const setHeader = (idx, val) => {
    setHeaders((prev) => prev.map((h, i) => (i === idx ? val : h)));
  };

  const setInclude = (idx, val) => {
    setIncludes((prev) => prev.map((v, i) => (i === idx ? val : v)));
  };

  const handleExport = async () => {
    if (!file) {
      setMessage("엑셀 파일을 먼저 선택하세요.");
      return;
    }
    if (!includes.some(Boolean)) {
      setMessage("다운로드할 열을 최소 1개 선택하세요.");
      return;
    }

    setLoading(true);
    setMessage("");
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("header_col1", headers[0]);
      formData.append("header_col2", headers[1]);
      formData.append("header_col3", headers[2]);
      formData.append("include_col1", includes[0] ? "true" : "false");
      formData.append("include_col2", includes[1] ? "true" : "false");
      formData.append("include_col3", includes[2] ? "true" : "false");

      const res = await fetch(`${API}/jeju-hapbae/export`, {
        method: "POST",
        headers: getAuthHeaders(),
        body: formData,
      });
      if (handleUnauthorized(res)) return;

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.detail || "가공 엑셀 생성 실패");
      }

      const blob = await res.blob();
      const disposition = res.headers.get("content-disposition") || "";
      const match = disposition.match(/filename\*?=(?:UTF-8''|"?)([^";]+)/i);
      const filename = match?.[1]
        ? decodeURIComponent(match[1].replace(/"/g, ""))
        : `${file.name.replace(/\.[^.]+$/, "")}_가공본.xls`;

      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);

      setMessage(`가공 엑셀 저장 완료: ${filename}`);
    } catch (err) {
      setMessage(err.message || "가공 엑셀 생성 실패");
    } finally {
      setLoading(false);
    }
  };

  const isError =
    message.includes("실패") ||
    message.includes("없음") ||
    message.includes("선택") ||
    message.includes("없습");

  return (
    <div className={styles.page}>
      {/* 헤더 */}
      <div className={styles.pageHeader}>
        <div>
          <h2 className={styles.title}>제주합배송</h2>
          <p className={styles.subtitle}>
            두 번째 시트 C열 중복 기준 &middot; G+I 가공본 생성 &middot; 원가베이스 상품코드 매칭
          </p>
        </div>
        {headerExtra}
      </div>

      {/* 원가베이스 상태 배너 */}
      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h3 className={styles.cardTitle}>② 원가베이스 상태</h3>
          {costBase?.mtime && (
            <span className={styles.pill}>수정: {costBase.mtime}</span>
          )}
        </div>
        {costBase?.exists ? (
          <div
            className={styles.statusMsg}
            style={{
              borderColor: "rgba(34,197,94,0.4)",
              backgroundColor: "rgba(34,197,94,0.07)",
              display: "flex",
              alignItems: "center",
              gap: "0.75rem",
              flexWrap: "wrap",
            }}
          >
            <strong>원가베이스 로드됨</strong>
            {costBase?.path && (
              <span style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
                {costBase.path}
              </span>
            )}
          </div>
        ) : (
          <div
            className={styles.statusMsg}
            style={{
              borderColor: "rgba(220,53,69,0.4)",
              backgroundColor: "rgba(220,53,69,0.07)",
            }}
          >
            <strong>원가베이스 파일 없음</strong>
            <span style={{ marginLeft: "0.5rem", color: "var(--text-muted)", fontSize: "0.875rem" }}>
              — 아무드합배 탭에서 업로드하세요.
            </span>
          </div>
        )}
      </section>

      {/* 엑셀 처리 */}
      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h3 className={styles.cardTitle}>① 엑셀 처리</h3>
          <span className={styles.pill}>두 번째 시트 기준</span>
        </div>

        {/* 파일 + 실행 버튼 */}
        <div className={styles.uploadRow}>
          <label
            className={styles.fileInput}
            style={{ flex: 1, justifyContent: "flex-start" }}
          >
            <input
              type="file"
              accept=".xlsx,.xlsm,.xls"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setMessage("");
              }}
            />
            {file ? file.name : "파일 선택 (xlsx / xlsm / xls)"}
          </label>
          <button
            type="button"
            className={styles.primaryBtn}
            onClick={handleExport}
            disabled={loading}
          >
            {loading ? "생성 중..." : "가공 엑셀 생성 (XLS)"}
          </button>
        </div>

        {/* 열 선택 */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
            gap: "0.6rem",
            padding: "0.9rem 1rem",
            background: "var(--bg-secondary)",
            borderRadius: "var(--radius-md)",
            border: "1px solid var(--border-color)",
          }}
        >
          {COLUMNS.map(({ n, label, defaultHeader }, idx) => (
            <div
              key={n}
              style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}
            >
              <label className={styles.checkboxItem} style={{ flexShrink: 0 }}>
                <input
                  type="checkbox"
                  checked={includes[idx]}
                  onChange={(e) => setInclude(idx, e.target.checked)}
                />
                {n}열
              </label>
              <input
                type="text"
                className={styles.cellInput}
                value={headers[idx]}
                onChange={(e) => setHeader(idx, e.target.value)}
                placeholder={defaultHeader}
                disabled={!includes[idx]}
                style={{ opacity: includes[idx] ? 1 : 0.45 }}
              />
            </div>
          ))}
        </div>

        {/* 상태 메시지 */}
        {message && (
          <div
            className={styles.statusMsg}
            style={{
              borderColor: isError
                ? "rgba(220,53,69,0.4)"
                : "rgba(34,197,94,0.4)",
              backgroundColor: isError
                ? "rgba(220,53,69,0.07)"
                : "rgba(34,197,94,0.07)",
            }}
          >
            <strong>{message}</strong>
          </div>
        )}
      </section>

      {/* 처리 방식 안내 */}
      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h3 className={styles.cardTitle}>처리 방식</h3>
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
            gap: "0.75rem",
          }}
        >
          {[
            {
              step: "STEP 1",
              desc: "두 번째 시트 읽기",
              detail: "엑셀 파일의 두 번째 시트(index 1)를 헤더 없이 읽습니다.",
            },
            {
              step: "STEP 2",
              desc: "C열 중복 필터",
              detail:
                "C열(3번째 열) 값이 2개 이상 등장하는 행만 남깁니다.",
            },
            {
              step: "STEP 3",
              desc: "G·I열 가공",
              detail:
                "G열: 앞쪽 대괄호·괄호 제거 / I열: 슬래시(/)를 공백으로 → 두 값을 합쳐 1열(상품명).",
            },
            {
              step: "STEP 4",
              desc: "원가베이스 매칭",
              detail:
                "1열(상품명)을 원가베이스 A열에서 대소문자 무시로 검색 → 2열(상품코드) 반환.",
            },
            {
              step: "STEP 5",
              desc: "J열 → 3열",
              detail: "J열(10번째 열) 값을 그대로 3열(수량)에 씁니다.",
            },
            {
              step: "STEP 6",
              desc: "XLS 다운로드",
              detail:
                "선택한 열만 포함하여 .xls 파일로 다운로드합니다.",
            },
          ].map(({ step, desc, detail }) => (
            <div
              key={step}
              style={{
                background: "var(--bg-secondary)",
                border: "1px solid var(--border-color)",
                borderRadius: "var(--radius-md)",
                padding: "0.9rem 1rem",
                display: "flex",
                flexDirection: "column",
                gap: "0.3rem",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <span
                  style={{
                    fontSize: "0.7rem",
                    fontWeight: 700,
                    padding: "0.15rem 0.5rem",
                    borderRadius: "999px",
                    background: "var(--accent-black)",
                    color: "var(--accent-white)",
                    flexShrink: 0,
                  }}
                >
                  {step}
                </span>
                <span style={{ fontWeight: 600, fontSize: "0.9rem" }}>{desc}</span>
              </div>
              <p
                style={{
                  margin: 0,
                  fontSize: "0.8rem",
                  color: "var(--text-secondary)",
                  lineHeight: 1.5,
                }}
              >
                {detail}
              </p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
