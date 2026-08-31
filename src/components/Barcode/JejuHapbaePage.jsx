import React, { useCallback, useEffect, useState } from "react";
import styles from "./BarcodePage.module.css";
import { LOCAL_API_BASE as API, getAuthHeaders, handleUnauthorized } from "../../lib/api";

const COLUMNS = [
  { n: 1, label: "상품명 (G+I 가공)", defaultHeader: "상품명" },
  { n: 2, label: "상품코드 (원가베이스)", defaultHeader: "상품코드" },
  { n: 3, label: "수량 (가공 후 합산)", defaultHeader: "수량" },
];

export default function JejuHapbaePage({ headerExtra = null }) {
  const [file, setFile] = useState(null);
  const [lastFileInfo, setLastFileInfo] = useState(null);
  const [headers, setHeaders] = useState(["상품명", "상품코드", "수량"]);
  const [includes, setIncludes] = useState([true, true, true]);
  const [loading, setLoading] = useState(false);
  const [loadingAbly, setLoadingAbly] = useState(false);
  const [loadingEzadmin, setLoadingEzadmin] = useState(false);
  const [message, setMessage] = useState("");
  const [unmatchedProducts, setUnmatchedProducts] = useState([]);
  const [ablyPreview, setAblyPreview] = useState({ columns: [], rows: [] });
  const [ablyStats, setAblyStats] = useState(null);
  const [ablySourceRows, setAblySourceRows] = useState([]);
  const [ablySavedAt, setAblySavedAt] = useState("");
  const [ezadminMsg, setEzadminMsg] = useState("");
  const [ezadminLog, setEzadminLog] = useState([]);

  const fetchEzadminLog = useCallback(async () => {
    try {
      const res = await fetch(`${API}/jeju-hapbae/ezadmin-log`, { headers: getAuthHeaders() });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        setEzadminLog(data.log || []);
      }
    } catch { /* ignore */ }
  }, []);

  const applyAblyPreviewData = useCallback((data) => {
    setAblyPreview({
      columns: Array.isArray(data.columns) ? data.columns : [],
      rows: Array.isArray(data.rows) ? data.rows : [],
    });
    setAblyStats(data.stats || null);
    setAblySourceRows(Array.isArray(data.source_rows) ? data.source_rows : []);
    setUnmatchedProducts(Array.isArray(data.unmatched) ? data.unmatched : []);
    setAblySavedAt(data.saved_at || "");
  }, []);

  const fetchSavedAblyPreview = useCallback(async () => {
    try {
      const res = await fetch(`${API}/jeju-hapbae/ably-preview`, { headers: getAuthHeaders() });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (res.ok && data?.has_data) {
        applyAblyPreviewData(data);
      }
    } catch {
      // ignore
    }
  }, [applyAblyPreviewData]);

  useEffect(() => {
    fetchEzadminLog();
    fetchSavedAblyPreview();
    fetch(`${API}/jeju-hapbae/last-file/info`, { headers: getAuthHeaders() })
      .then((r) => r.json())
      .then((d) => { if (d.file) setLastFileInfo(d.file); })
      .catch(() => {});
  }, [fetchEzadminLog, fetchSavedAblyPreview]);

  const setHeader = (idx, val) => {
    setHeaders((prev) => prev.map((header, i) => (i === idx ? val : header)));
  };

  const setInclude = (idx, val) => {
    setIncludes((prev) => prev.map((item, i) => (i === idx ? val : item)));
  };

  const handleExport = async () => {
    if (!file) {
      setMessage("작업 파일을 먼저 선택하세요.");
      return;
    }
    if (!includes.some(Boolean)) {
      setMessage("다운로드할 열을 최소 1개 선택하세요.");
      return;
    }

    setLoading(true);
    setMessage("");
    setUnmatchedProducts([]);
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
        throw new Error(data?.detail || "가공 파일 생성 실패");
      }

      const blob = await res.blob();
      const filename = "제주 합배 마이너스.xls";

      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);

      setMessage(`가공 파일 다운로드 완료: ${filename}`);

      // 매칭 안된 상품 조회
      try {
        const unmatchedForm = new FormData();
        unmatchedForm.append("file", file);
        const unmatchedRes = await fetch(`${API}/jeju-hapbae/unmatched`, {
          method: "POST",
          headers: getAuthHeaders(),
          body: unmatchedForm,
        });
        if (!handleUnauthorized(unmatchedRes) && unmatchedRes.ok) {
          const unmatchedData = await unmatchedRes.json().catch(() => ({}));
          setUnmatchedProducts(unmatchedData.unmatched || []);
        }
      } catch {
        // ignore
      }
    } catch (err) {
      setMessage(err.message || "가공 파일 생성 실패");
    } finally {
      setLoading(false);
    }
  };

  const handleExportFromAbly = async () => {
    if (!includes.some(Boolean)) {
      setMessage("다운로드할 열을 최소 1개 선택하세요.");
      return;
    }
    setLoadingAbly(true);
    setMessage("");
    setUnmatchedProducts([]);
    setAblyPreview({ columns: [], rows: [] });
    setAblyStats(null);
    setAblySourceRows([]);
    setAblySavedAt("");
    try {
      const res = await fetch(`${API}/jeju-hapbae/export-from-ably`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({
          header_col1: headers[0],
          header_col2: headers[1],
          header_col3: headers[2],
          include_col1: includes[0],
          include_col2: includes[1],
          include_col3: includes[2],
          preview_only: true,
        }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.detail || "에이블리 불러오기 실패");
      }
      applyAblyPreviewData(data);
      setMessage(
        `에이블리 제주합배 미리보기 반영 완료: 원본 ${data.stats?.jeju_duplicate_item_count ?? 0}건 → 합산 ${data.count ?? 0}건 (미매칭 ${data.unmatched_count ?? 0}건)`
      );
    } catch (err) {
      setMessage(err.message || "에이블리 불러오기 실패");
    } finally {
      setLoadingAbly(false);
    }
  };

  const handleSendToEzadmin = async (direction) => {
    if (!file && !lastFileInfo && !ablySourceRows.length) {
      setEzadminMsg("작업 파일을 먼저 선택하거나 에이블리 불러오기를 실행하세요.");
      return;
    }
    setLoadingEzadmin(true);
    setEzadminMsg("");
    try {
      let res;
      if (file || lastFileInfo) {
        const formData = new FormData();
        if (file) formData.append("file", file);
        formData.append("direction", direction);
        res = await fetch(`${API}/jeju-hapbae/send-to-ezadmin`, {
          method: "POST",
          headers: getAuthHeaders(),
          body: formData,
        });
      } else {
        res = await fetch(`${API}/jeju-hapbae/send-preview-to-ezadmin`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...getAuthHeaders() },
          body: JSON.stringify({ direction, rows: ablySourceRows }),
        });
      }
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (data?.need_session) { setEzadminMsg("EZAdmin 세션이 없습니다. 헤더에서 PHPSESSID를 설정하세요."); return; }
      if (!res.ok || !data?.ok) { setEzadminMsg(data?.error || data?.detail || "EZAdmin 처리 실패"); return; }
      const label = direction === "out" ? "출고" : "입고";
      setEzadminMsg(`EZAdmin ${label}처리 완료 (${data.count ?? 0}건)`);
      await fetchEzadminLog();
    } catch (err) {
      setEzadminMsg(err.message || "EZAdmin 처리 실패");
    } finally {
      setLoadingEzadmin(false);
    }
  };

  const isError =
    message.includes("실패") ||
    message.includes("없음") ||
    message.includes("선택") ||
    message.includes("없습니다");

  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <div>
          <h2 className={styles.title}>제주합배송</h2>
          <p className={styles.subtitle}>
            2번택 시트 기준 중복 건만 추출하고 G+I 가공 후 원가베이스 상품코드로 묶어 수량을 합산합니다.
          </p>
        </div>
        {headerExtra}
      </div>


      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h3 className={styles.cardTitle}>작업 파일 처리</h3>
          <span className={styles.pill}>상품코드 중복 시 수량 합산</span>
        </div>

        <div className={styles.uploadRow}>
          <label
            className={styles.fileInput}
            style={{ flex: 1, justifyContent: "flex-start" }}
          >
            <input
              type="file"
              accept=".xlsx,.xlsm,.xls"
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                setFile(f);
                if (f) setLastFileInfo({ filename: f.name, uploaded_at: new Date().toISOString() });
                setMessage("");
              }}
            />
            {file
              ? file.name
              : lastFileInfo
              ? `이전 파일: ${lastFileInfo.filename} (${new Date(lastFileInfo.uploaded_at).toLocaleString("ko-KR")})`
              : "파일 선택 (xlsx / xlsm / xls)"}
          </label>
          <button
            type="button"
            className={styles.primaryBtn}
            onClick={handleExport}
            disabled={loading || loadingAbly || loadingEzadmin}
          >
            {loading ? "생성 중.." : "가공 파일 생성 (XLS)"}
          </button>
          <button
            type="button"
            className={styles.secondaryBtn}
            onClick={handleExportFromAbly}
            disabled={loading || loadingAbly || loadingEzadmin}
          >
            {loadingAbly ? "불러오는 중..." : "에이블리 불러오기"}
          </button>
          <button
            type="button"
            className={styles.secondaryBtn}
            onClick={() => handleSendToEzadmin("out")}
            disabled={loading || loadingAbly || loadingEzadmin}
          >
            {loadingEzadmin ? "처리 중..." : "EZAdmin 출고"}
          </button>
          <button
            type="button"
            className={styles.secondaryBtn}
            onClick={() => handleSendToEzadmin("in")}
            disabled={loading || loadingAbly || loadingEzadmin}
          >
            {loadingEzadmin ? "처리 중..." : "EZAdmin 입고"}
          </button>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: "0.6rem",
            padding: "0.9rem 1rem",
            background: "var(--bg-secondary)",
            borderRadius: "var(--radius-md)",
            border: "1px solid var(--border-color)",
          }}
        >
          {COLUMNS.map(({ n, label, defaultHeader }, idx) => (
            <div key={n} style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
              <div style={{ fontSize: "0.82rem", color: "var(--text-secondary)", fontWeight: 600 }}>
                {label}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
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
            </div>
          ))}
        </div>

        {message && (
          <div
            className={styles.statusMsg}
            style={{
              borderColor: isError ? "rgba(220,53,69,0.4)" : "rgba(34,197,94,0.4)",
              backgroundColor: isError ? "rgba(220,53,69,0.07)" : "rgba(34,197,94,0.07)",
            }}
          >
            <strong>{message}</strong>
          </div>
        )}

        {ezadminMsg && (
          <div
            className={styles.statusMsg}
            style={{
              borderColor: ezadminMsg.includes("실패") || ezadminMsg.includes("없습니다") || ezadminMsg.includes("세션")
                ? "rgba(220,53,69,0.4)" : "rgba(34,197,94,0.4)",
              backgroundColor: ezadminMsg.includes("실패") || ezadminMsg.includes("없습니다") || ezadminMsg.includes("세션")
                ? "rgba(220,53,69,0.07)" : "rgba(34,197,94,0.07)",
            }}
          >
            <strong>{ezadminMsg}</strong>
          </div>
        )}

        {ezadminLog.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.2rem", marginTop: "0.5rem" }}>
            {ezadminLog.map((entry, idx) => (
              <span key={idx} style={{ fontSize: "0.78rem", color: entry.ok ? "var(--text-secondary)" : "rgba(220,53,69,0.8)" }}>
                {entry.time} · {entry.label}{entry.ok ? ` ${entry.count}건` : ` 실패${entry.error ? ` (${entry.error})` : ""}`}
              </span>
            ))}
          </div>
        )}

        {ablyPreview.rows.length > 0 && (
          <>
            {ablyStats && (
              <div className={styles.metaGrid}>
                {[
                  ["저장 시각", ablySavedAt || "-"],
                  ["API 전체", `${ablyStats.total_items ?? 0}건`],
                  ["조회 페이지", `${ablyStats.pages ?? 0}`],
                  ["합배송 후보", `${ablyStats.duplicate_item_count ?? 0}건`],
                  ["제주 원본", `${ablyStats.jeju_duplicate_item_count ?? 0}건`],
                  ["제주 원본 수량", `${ablyStats.jeju_duplicate_qty_total ?? 0}`],
                  ["합산 후", `${ablyStats.merged_row_count ?? 0}건`],
                ].map(([label, value]) => (
                  <div key={label} className={styles.metaItem}>
                    <span className={styles.metaLabel}>{label}</span>
                    <strong className={styles.metaValue}>{value}</strong>
                  </div>
                ))}
              </div>
            )}
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    {ablyPreview.columns.map((column, idx) => (
                      <th key={`${column}-${idx}`}>{column}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {ablyPreview.rows.map((row, rowIdx) => (
                    <tr key={rowIdx}>
                      {row.map((value, colIdx) => (
                        <td key={`${rowIdx}-${colIdx}`}>{value ?? ""}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {unmatchedProducts.length > 0 && (
          <div
            className={styles.statusMsg}
            style={{
              borderColor: "rgba(245,158,11,0.4)",
              backgroundColor: "rgba(245,158,11,0.07)",
            }}
          >
            <strong>상품코드 매칭 안된 상품 {unmatchedProducts.length}건</strong>
            <div style={{ marginTop: "0.5rem", display: "flex", flexDirection: "column", gap: "0.2rem" }}>
              {unmatchedProducts.map((name, idx) => (
                <span key={idx} style={{ fontSize: "0.85rem", color: "var(--text-secondary)" }}>
                  · {name}
                </span>
              ))}
            </div>
          </div>
        )}
      </section>

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
              desc: "2번택 시트 읽기",
              detail: "업로드한 파일의 두 번째 시트를 기준으로 C열 중복 건만 대상으로 잡습니다.",
            },
            {
              step: "STEP 2",
              desc: "상품명 가공",
              detail: "G열 상품명과 I열 옵션을 정리해서 하나의 상품명으로 합칩니다.",
            },
            {
              step: "STEP 3",
              desc: "원가베이스 매칭",
              detail: "가공된 상품명을 원가베이스 I열과 비교해 A열 상품코드를 찾습니다.",
            },
            {
              step: "STEP 4",
              desc: "동일 상품코드 합치기",
              detail: "상품코드가 같으면 한 줄만 남기고 수량을 모두 더해서 출력합니다.",
            },
            {
              step: "STEP 5",
              desc: "가공본 다운로드",
              detail: "선택한 열만 포함한 XLS 파일로 바로 다운로드합니다.",
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
