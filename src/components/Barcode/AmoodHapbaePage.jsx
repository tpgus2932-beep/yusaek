import React, { useCallback, useEffect, useMemo, useState } from "react";
import styles from "./BarcodePage.module.css";

import { LOCAL_API_BASE as API, getAuthHeaders, handleUnauthorized } from "../../lib/api";

export default function AmoodHapbaePage({ headerExtra = null, transferredFile = null }) {
  const [file, setFile] = useState(null);
  const [lastFileInfo, setLastFileInfo] = useState(null);
  const [skipHeader, setSkipHeader] = useState(true);
  const [headerCol1, setHeaderCol1] = useState("상품명");
  const [headerCol2, setHeaderCol2] = useState("상품코드");
  const [headerCol3, setHeaderCol3] = useState("작업수량");
  const [headerCol4, setHeaderCol4] = useState("메모");
  const [includeCol1, setIncludeCol1] = useState(true);
  const [includeCol2, setIncludeCol2] = useState(true);
  const [includeCol3, setIncludeCol3] = useState(true);
  const [includeCol4, setIncludeCol4] = useState(true);
  const [loadingConflicts, setLoadingConflicts] = useState(false);
  const [loadingExport, setLoadingExport] = useState(false);
  const [loadingEzadmin, setLoadingEzadmin] = useState(false);
  const [ezadminMsg, setEzadminMsg] = useState("");
  const [ezadminLog, setEzadminLog] = useState([]);
  const [message, setMessage] = useState("");
  const [sheetName, setSheetName] = useState("");
  const [conflicts, setConflicts] = useState([]);
  const [selectedC, setSelectedC] = useState("");
  const [unmatchedProducts, setUnmatchedProducts] = useState([]);
  const [unmatchedRowCount, setUnmatchedRowCount] = useState(0);
  const [costBaseExists, setCostBaseExists] = useState(true);

  const selectedConflict = useMemo(
    () => conflicts.find((item) => item.c === selectedC) || null,
    [conflicts, selectedC]
  );

  useEffect(() => {
    if (!transferredFile?.file) return;
    setFile(transferredFile.file);
    setMessage(`합배송 파일 전달됨: ${transferredFile.file.name}`);
  }, [transferredFile]);

  const buildFormData = () => {
    const formData = new FormData();
    if (file) formData.append("file", file);
    formData.append("skip_header", skipHeader ? "true" : "false");
    formData.append("header_col1", headerCol1);
    formData.append("header_col2", headerCol2);
    formData.append("header_col3", headerCol3);
    formData.append("header_col4", headerCol4);
    formData.append("include_col1", includeCol1 ? "true" : "false");
    formData.append("include_col2", includeCol2 ? "true" : "false");
    formData.append("include_col3", includeCol3 ? "true" : "false");
    formData.append("include_col4", includeCol4 ? "true" : "false");
    return formData;
  };

  const fetchEzadminLog = useCallback(async () => {
    try {
      const res = await fetch(`${API}/amood-hapbae/ezadmin-log`, { headers: getAuthHeaders() });
      if (!res.ok) return;
      const data = await res.json().catch(() => ({}));
      setEzadminLog(Array.isArray(data.log) ? data.log : []);
    } catch {
      // ignore
    }
  }, []);

  const handleSendToEzadmin = async (direction) => {
    if (!file && !lastFileInfo) { setEzadminMsg("엑셀 파일을 먼저 선택하세요."); return; }
    setLoadingEzadmin(true);
    setEzadminMsg("");
    try {
      const formData = new FormData();
      if (file) formData.append("file", file);
      formData.append("direction", direction);
      formData.append("skip_header", skipHeader ? "true" : "false");
      const res = await fetch(`${API}/amood-hapbae/send-to-ezadmin`, {
        method: "POST",
        headers: getAuthHeaders(),
        body: formData,
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (data?.need_session) { setEzadminMsg("EZAdmin 세션이 없습니다. 설정에서 PHPSESSID를 입력하세요."); return; }
      if (!res.ok || !data?.ok) throw new Error(data?.detail || data?.error || "EZAdmin 처리 실패");
      const label = direction === "out" ? "출고" : "입고";
      setEzadminMsg(`${label} 처리 완료 (${data.count ?? 0}건)`);
      await fetchEzadminLog();
    } catch (err) {
      setEzadminMsg(err.message || "EZAdmin 처리 실패");
    } finally {
      setLoadingEzadmin(false);
    }
  };

  React.useEffect(() => {
    fetchEzadminLog();
    fetch(`${API}/amood-hapbae/last-file/info`, { headers: getAuthHeaders() })
      .then((r) => r.json())
      .then((d) => { if (d.file) setLastFileInfo(d.file); })
      .catch(() => {});
  }, [fetchEzadminLog]);

  const handleFindConflicts = async () => {
    if (!file && !lastFileInfo) {
      setMessage("엑셀 파일을 먼저 선택하세요.");
      return;
    }
    const formData = buildFormData();
    setLoadingConflicts(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/amood-hapbae/conflicts`, {
        method: "POST",
        headers: getAuthHeaders(),
        body: formData,
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "불일치 조회 실패");

      setSheetName(data.sheet || "");
      setConflicts(Array.isArray(data.conflicts) ? data.conflicts : []);
      setSelectedC(data.conflicts?.[0]?.c || "");
      setUnmatchedProducts(Array.isArray(data.unmatched_products) ? data.unmatched_products : []);
      setUnmatchedRowCount(Number(data.unmatched_row_count || 0));
      setCostBaseExists(data.cost_base_exists !== false);
      setMessage(
        (data.conflict_count || 0) > 0
          ? `사용 시트: ${data.sheet} / ${data.conflict_count}건 발견`
          : `사용 시트: ${data.sheet} / 결과 없음`
      );
    } catch (err) {
      setMessage(err.message || "불일치 조회 실패");
      setConflicts([]);
      setSelectedC("");
      setSheetName("");
      setUnmatchedProducts([]);
      setUnmatchedRowCount(0);
      setCostBaseExists(true);
    } finally {
      setLoadingConflicts(false);
    }
  };

  const getDownloadFilename = (res) => {
    const disposition = res.headers.get("content-disposition") || "";
    const match = disposition.match(/filename\*?=(?:UTF-8''|"?)([^";]+)/i);
    if (match?.[1]) {
      return decodeURIComponent(match[1].replace(/"/g, ""));
    }
    const base = file?.name ? file.name.replace(/\.[^.]+$/, "") : "아무드합배";
    return `${base}_가공본.xls`;
  };

  const handleExport = async () => {
    if (!includeCol1 && !includeCol2 && !includeCol3 && !includeCol4) {
      setMessage("다운로드할 열을 최소 1개 선택하세요.");
      return;
    }
    if (!file && !lastFileInfo) {
      setMessage("엑셀 파일을 먼저 선택하세요.");
      return;
    }
    const formData = buildFormData();
    setLoadingExport(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/amood-hapbae/export`, {
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
      const filename = getDownloadFilename(res);
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
      setLoadingExport(false);
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <div>
          <h2 className={styles.title}>아무드합배</h2>
          <p className={styles.subtitle}>두 번째 시트 기준 C/D 불일치 확인 및 H/J 가공본 생성</p>
        </div>
        {headerExtra}
      </div>

      {/* 엑셀 처리 */}
      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h3 className={styles.cardTitle}>엑셀 처리</h3>
        </div>
        <div className={styles.uploadRow}>
          <label className={styles.fileInput} style={{ flex: 1, justifyContent: "flex-start" }}>
            <input
              type="file"
              accept=".xlsx,.xlsm"
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                setFile(f);
                if (f) setLastFileInfo({ filename: f.name, uploaded_at: new Date().toISOString() });
              }}
            />
            {file
              ? file.name
              : lastFileInfo
              ? `이전 파일: ${lastFileInfo.filename} (${new Date(lastFileInfo.uploaded_at).toLocaleString("ko-KR")})`
              : "파일 선택"}
          </label>
          <label className={styles.checkboxItem}>
            <input type="checkbox" checked={skipHeader} onChange={(e) => setSkipHeader(e.target.checked)} />
            1행 헤더
          </label>
          <button
            type="button"
            className={styles.secondaryBtn}
            onClick={handleFindConflicts}
            disabled={loadingConflicts || loadingExport}
          >
            {loadingConflicts ? "조회 중..." : "C/D 불일치 찾기"}
          </button>
          <button
            type="button"
            className={styles.primaryBtn}
            onClick={handleExport}
            disabled={loadingConflicts || loadingExport}
          >
            {loadingExport ? "생성 중..." : "H/J 가공 엑셀 생성"}
          </button>
          <button
            type="button"
            className={styles.secondaryBtn}
            onClick={() => handleSendToEzadmin("out")}
            disabled={loadingEzadmin || loadingConflicts || loadingExport}
          >
            {loadingEzadmin ? "처리 중..." : "EZAdmin 출고"}
          </button>
          <button
            type="button"
            className={styles.secondaryBtn}
            onClick={() => handleSendToEzadmin("in")}
            disabled={loadingEzadmin || loadingConflicts || loadingExport}
          >
            {loadingEzadmin ? "처리 중..." : "EZAdmin 입고"}
          </button>
        </div>

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

        {/* 열 설정 */}
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
          gap: "0.6rem",
          padding: "0.9rem 1rem",
          background: "var(--bg-secondary)",
          borderRadius: "var(--radius-md)",
          border: "1px solid var(--border-color)",
        }}>
          {[
            { n: 1, checked: includeCol1, setChecked: setIncludeCol1, val: headerCol1, setVal: setHeaderCol1 },
            { n: 2, checked: includeCol2, setChecked: setIncludeCol2, val: headerCol2, setVal: setHeaderCol2 },
            { n: 3, checked: includeCol3, setChecked: setIncludeCol3, val: headerCol3, setVal: setHeaderCol3 },
            { n: 4, checked: includeCol4, setChecked: setIncludeCol4, val: headerCol4, setVal: setHeaderCol4 },
          ].map(({ n, checked, setChecked, val, setVal }) => (
            <div key={n} style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <label className={styles.checkboxItem} style={{ flexShrink: 0 }}>
                <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
                {n}열
              </label>
              <input
                type="text"
                className={styles.cellInput}
                value={val}
                onChange={(e) => setVal(e.target.value)}
                placeholder={`${n}열 헤더`}
                disabled={!checked}
                style={{ opacity: checked ? 1 : 0.45 }}
              />
            </div>
          ))}
        </div>

        {message && (
          <div className={styles.statusMsg} style={{
            borderColor: message.includes("실패") || message.includes("없음") ? "rgba(220,53,69,0.4)" : "rgba(34,197,94,0.4)",
            backgroundColor: message.includes("실패") || message.includes("없음") ? "rgba(220,53,69,0.07)" : "rgba(34,197,94,0.07)",
          }}>
            <strong>{message}</strong>
          </div>
        )}
      </section>

      {/* 불일치 C값 목록 */}
      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h3 className={styles.cardTitle}>불일치 C값 목록</h3>
          {sheetName && <span className={styles.pill}>시트: {sheetName}</span>}
        </div>
        {!costBaseExists && (
          <div className={styles.statusMsg} style={{ borderColor: "rgba(220,53,69,0.3)", backgroundColor: "rgba(220,53,69,0.05)" }}>
            원가베이스 파일이 없어 A열 상품코드 매칭 점검을 생략했습니다.
          </div>
        )}
        {costBaseExists && unmatchedRowCount > 0 && (
          <div className={styles.statusMsg} style={{ borderColor: "rgba(245,158,11,0.4)", backgroundColor: "rgba(245,158,11,0.07)" }}>
            <strong>매칭 안된 상품 {unmatchedProducts.length}건 (행 {unmatchedRowCount}건)</strong>
            {unmatchedProducts.length > 0 && (
              <div style={{ marginTop: "0.5rem", display: "flex", flexDirection: "column", gap: "0.2rem" }}>
                {unmatchedProducts.map((name, idx) => (
                  <span key={`${name}-${idx}`} style={{ fontSize: "0.85rem", color: "var(--text-secondary)" }}>
                    · {name}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
        {conflicts.length === 0 ? (
          <div className={styles.empty}>조회 결과가 없습니다.</div>
        ) : (
          <div className={styles.dualGrid}>
            {/* C값 목록 */}
            <div style={{ display: "flex", flexDirection: "column", gap: "0.35rem", maxHeight: "320px", overflowY: "auto" }}>
              {conflicts.map((item, idx) => (
                <button
                  key={`${item.c}-${idx}`}
                  type="button"
                  onClick={() => setSelectedC(item.c)}
                  style={{
                    textAlign: "left",
                    padding: "0.6rem 0.85rem",
                    borderRadius: "var(--radius-sm)",
                    border: selectedC === item.c ? "1px solid var(--accent-black)" : "1px solid var(--border-color)",
                    background: selectedC === item.c ? "var(--accent-black)" : "var(--bg-secondary)",
                    color: selectedC === item.c ? "var(--accent-white)" : "var(--text-primary)",
                    fontWeight: 600,
                    cursor: "pointer",
                    fontSize: "0.9rem",
                    transition: "background 0.15s, border-color 0.15s",
                  }}
                >
                  {item.c}
                </button>
              ))}
            </div>
            {/* 선택된 C값 상세 */}
            <div style={{
              background: "var(--bg-secondary)",
              border: "1px solid var(--border-color)",
              borderRadius: "var(--radius-md)",
              padding: "0.9rem 1rem",
              maxHeight: "320px",
              overflowY: "auto",
            }}>
              {!selectedConflict ? (
                <div className={styles.empty}>왼쪽에서 C값을 선택하세요.</div>
              ) : (
                <>
                  <div style={{ fontWeight: 700, marginBottom: "0.6rem" }}>{selectedConflict.c}</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
                    {selectedConflict.d_values?.map((dVal, idx) => (
                      <span key={`${selectedConflict.c}-d-${idx}`} style={{ fontSize: "0.875rem", color: "var(--text-secondary)", paddingLeft: "0.5rem", borderLeft: "2px solid var(--border-color)" }}>
                        {dVal}
                      </span>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
