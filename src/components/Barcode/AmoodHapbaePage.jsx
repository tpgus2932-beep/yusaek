import React, { useMemo, useState } from "react";
import styles from "./BarcodePage.module.css";

const API = `http://${window.location.hostname}:8000`;

const getAuthHeaders = () => {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
};

export default function AmoodHapbaePage({ headerExtra = null }) {
  const [file, setFile] = useState(null);
  const [skipHeader, setSkipHeader] = useState(true);
  const [headerCol1, setHeaderCol1] = useState("가공결과");
  const [headerCol2, setHeaderCol2] = useState("원가베이스유_B");
  const [headerCol3, setHeaderCol3] = useState("수량(K)");
  const [includeCol1, setIncludeCol1] = useState(true);
  const [includeCol2, setIncludeCol2] = useState(true);
  const [includeCol3, setIncludeCol3] = useState(true);
  const [loadingConflicts, setLoadingConflicts] = useState(false);
  const [loadingExport, setLoadingExport] = useState(false);
  const [message, setMessage] = useState("");
  const [sheetName, setSheetName] = useState("");
  const [conflicts, setConflicts] = useState([]);
  const [selectedC, setSelectedC] = useState("");

  const selectedConflict = useMemo(
    () => conflicts.find((item) => item.c === selectedC) || null,
    [conflicts, selectedC]
  );

  const handleUnauthorized = (res) => {
    if (res.status === 401) {
      localStorage.removeItem("token");
      window.location.reload();
      return true;
    }
    return false;
  };

  const buildFormData = () => {
    if (!file) return null;
    const formData = new FormData();
    formData.append("file", file);
    formData.append("skip_header", skipHeader ? "true" : "false");
    formData.append("header_col1", headerCol1);
    formData.append("header_col2", headerCol2);
    formData.append("header_col3", headerCol3);
    formData.append("include_col1", includeCol1 ? "true" : "false");
    formData.append("include_col2", includeCol2 ? "true" : "false");
    formData.append("include_col3", includeCol3 ? "true" : "false");
    return formData;
  };

  const handleFindConflicts = async () => {
    const formData = buildFormData();
    if (!formData) {
      setMessage("엑셀 파일을 먼저 선택하세요.");
      return;
    }
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
    if (!includeCol1 && !includeCol2 && !includeCol3) {
      setMessage("다운로드할 열을 최소 1개 선택하세요.");
      return;
    }
    const formData = buildFormData();
    if (!formData) {
      setMessage("엑셀 파일을 먼저 선택하세요.");
      return;
    }
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

      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h3 className={styles.cardTitle}>엑셀 처리</h3>
        </div>
        <div className={styles.uploadRow}>
          <label className={styles.fileInput}>
            <input type="file" accept=".xlsx,.xlsm" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            파일 선택
          </label>
          <label className={styles.checkboxItem}>
            <input
              type="checkbox"
              checked={skipHeader}
              onChange={(e) => setSkipHeader(e.target.checked)}
            />
            1행 헤더, 2행부터 조회
          </label>
          <button
            type="button"
            className={styles.secondaryBtn}
            onClick={handleFindConflicts}
            disabled={loadingConflicts || loadingExport}
          >
            {loadingConflicts ? "조회 중..." : "(1) C/D 불일치 찾기"}
          </button>
          <button
            type="button"
            className={styles.primaryBtn}
            onClick={handleExport}
            disabled={loadingConflicts || loadingExport}
          >
            {loadingExport ? "생성 중..." : "(2) H/J 가공 엑셀 생성"}
          </button>
        </div>
        <div className={styles.uploadRow}>
          <label className={styles.checkboxItem}>
            <input
              type="checkbox"
              checked={includeCol1}
              onChange={(e) => setIncludeCol1(e.target.checked)}
            />
            1열
          </label>
          <input
            type="text"
            className={styles.cellInput}
            value={headerCol1}
            onChange={(e) => setHeaderCol1(e.target.value)}
            placeholder="1열 헤더"
            disabled={!includeCol1}
          />
          <label className={styles.checkboxItem}>
            <input
              type="checkbox"
              checked={includeCol2}
              onChange={(e) => setIncludeCol2(e.target.checked)}
            />
            2열
          </label>
          <input
            type="text"
            className={styles.cellInput}
            value={headerCol2}
            onChange={(e) => setHeaderCol2(e.target.value)}
            placeholder="2열 헤더"
            disabled={!includeCol2}
          />
          <label className={styles.checkboxItem}>
            <input
              type="checkbox"
              checked={includeCol3}
              onChange={(e) => setIncludeCol3(e.target.checked)}
            />
            3열
          </label>
          <input
            type="text"
            className={styles.cellInput}
            value={headerCol3}
            onChange={(e) => setHeaderCol3(e.target.value)}
            placeholder="3열 헤더"
            disabled={!includeCol3}
          />
        </div>
        {message && (
          <div className={styles.statusMsg}>
            <strong>{message}</strong>
          </div>
        )}
      </section>

      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h3 className={styles.cardTitle}>불일치 C값 목록</h3>
          {sheetName && <span className={styles.pill}>시트: {sheetName}</span>}
        </div>
        {conflicts.length === 0 ? (
          <div className={styles.empty}>조회 결과가 없습니다.</div>
        ) : (
          <div className={styles.dualGrid}>
            <div className={styles.logBox}>
              {conflicts.map((item, idx) => (
                <button
                  key={`${item.c}-${idx}`}
                  type="button"
                  className={styles.secondaryBtn}
                  onClick={() => setSelectedC(item.c)}
                >
                  {item.c}
                </button>
              ))}
            </div>
            <div className={styles.logBox}>
              {!selectedConflict ? (
                <div className={styles.empty}>왼쪽에서 C값을 선택하세요.</div>
              ) : (
                <>
                  <div className={styles.logLine}>C값: {selectedConflict.c}</div>
                  {selectedConflict.d_values?.map((dVal, idx) => (
                    <div key={`${selectedConflict.c}-d-${idx}`} className={styles.logLine}>
                      - {dVal}
                    </div>
                  ))}
                </>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
