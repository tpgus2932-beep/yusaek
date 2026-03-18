import React, { useCallback, useEffect, useState } from "react";
import styles from "../Barcode/BarcodePage.module.css";
import { getDownloadFilename } from "../../lib/download";

import { LOCAL_API_BASE as API, getAuthHeaders, handleUnauthorized } from "../../lib/api";

const PAGE_LIMIT = 50;

export default function CostBaseManagerPage() {
  const [status, setStatus] = useState(null);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [replaceFile, setReplaceFile] = useState(null);
  const [appendFile, setAppendFile] = useState(null);
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [columns, setColumns] = useState([]);
  const [rows, setRows] = useState([]);
  const [edits, setEdits] = useState({});

  const fetchStatus = useCallback(async () => {
    const res = await fetch(`${API}/amood-hapbae/cost-base/status`, { headers: getAuthHeaders() });
    if (handleUnauthorized(res)) return;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.detail || "원가베이스 상태 조회 실패");
    setStatus(data.status || null);
  }, []);

  const fetchPreview = useCallback(async (nextOffset = 0, nextQuery = query) => {
    const res = await fetch(
      `${API}/amood-hapbae/cost-base/preview?offset=${nextOffset}&limit=${PAGE_LIMIT}&q=${encodeURIComponent(
        (nextQuery || "").trim()
      )}`,
      { headers: getAuthHeaders() }
    );
    if (handleUnauthorized(res)) return;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.detail || "원가베이스 미리보기 실패");
    setStatus(data.status || null);
    setColumns(data.columns || []);
    setRows(data.rows || []);
    setTotal(Number(data.total || 0));
    setOffset(nextOffset);
    setEdits({});
  }, [query]);

  useEffect(() => {
    (async () => {
      try {
        await fetchStatus();
        await fetchPreview(0, "");
      } catch (e) {
        setMessage(e.message || "초기 로드 실패");
      }
    })();
  }, [fetchPreview, fetchStatus]);

  const uploadReplace = async () => {
    if (!replaceFile) {
      setMessage("업로드할 원가베이스 파일을 선택하세요.");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      const formData = new FormData();
      formData.append("file", replaceFile);
      const res = await fetch(`${API}/amood-hapbae/cost-base/upload`, {
        method: "POST",
        headers: getAuthHeaders(),
        body: formData,
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "원가베이스 업로드 실패");
      setReplaceFile(null);
      setMessage("원가베이스 업로드 완료");
      await fetchPreview(0, query);
    } catch (e) {
      setMessage(e.message || "원가베이스 업로드 실패");
    } finally {
      setLoading(false);
    }
  };

  const uploadAppend = async () => {
    if (!appendFile) {
      setMessage("추가할 엑셀 파일을 선택하세요.");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      const formData = new FormData();
      formData.append("file", appendFile);
      const res = await fetch(`${API}/amood-hapbae/cost-base/append-upload`, {
        method: "POST",
        headers: getAuthHeaders(),
        body: formData,
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "원가베이스 추가 업로드 실패");
      setAppendFile(null);
      setMessage(`추가 업로드 완료: ${data.appended_count || 0}행`);
      await fetchPreview(0, query);
    } catch (e) {
      setMessage(e.message || "원가베이스 추가 업로드 실패");
    } finally {
      setLoading(false);
    }
  };

  const reloadCostBase = async () => {
    setLoading(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/amood-hapbae/cost-base/reload`, {
        method: "POST",
        headers: getAuthHeaders(),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "원가베이스 새로 로드 실패");
      setStatus(data.status || null);
      setMessage("원가베이스 새로 로드 완료");
      await fetchPreview(offset, query);
    } catch (e) {
      setMessage(e.message || "원가베이스 새로 로드 실패");
    } finally {
      setLoading(false);
    }
  };

  const downloadCostBase = async () => {
    setLoading(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/amood-hapbae/cost-base/download`, { headers: getAuthHeaders() });
      if (handleUnauthorized(res)) return;
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.detail || "원가베이스 다운로드 실패");
      }
      const blob = await res.blob();
      const filename = getDownloadFilename(res, "원가베이스.xlsx");
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setMessage(`다운로드 완료: ${filename}`);
    } catch (e) {
      setMessage(e.message || "원가베이스 다운로드 실패");
    } finally {
      setLoading(false);
    }
  };

  const handleCellChange = (rowIndex, colIndex, value) => {
    setRows((prev) =>
      prev.map((row) =>
        row.row_index === rowIndex
          ? { ...row, values: row.values.map((v, i) => (i === colIndex ? value : v)) }
          : row
      )
    );
    setEdits((prev) => ({
      ...prev,
      [`${rowIndex}:${colIndex}`]: { row_index: rowIndex, column: colIndex, value },
    }));
  };

  const saveEdits = async () => {
    const payloadEdits = Object.values(edits);
    if (!payloadEdits.length) {
      setMessage("변경된 내용이 없습니다.");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/amood-hapbae/cost-base/edit-batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ edits: payloadEdits }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "원가베이스 저장 실패");
      setStatus(data.status || null);
      setMessage("원가베이스 변경 저장 완료");
      setEdits({});
      await fetchPreview(offset, query);
    } catch (e) {
      setMessage(e.message || "원가베이스 저장 실패");
    } finally {
      setLoading(false);
    }
  };

  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + rows.length, total);

  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <div>
          <h2 className={styles.title}>원가베이스 관리</h2>
          <p className={styles.subtitle}>공용 원가베이스 편집 / 업로드 / A,B열 추가 업로드</p>
        </div>
      </div>

      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h3 className={styles.cardTitle}>파일 관리</h3>
          <span className={styles.pill}>총 {total}행</span>
        </div>
        <div className={styles.uploadRow}>
          <label className={styles.fileInput}>
            <input type="file" accept=".xls,.xlsx,.xlsm" onChange={(e) => setReplaceFile(e.target.files?.[0] ?? null)} />
            원가베이스 교체 파일 선택
          </label>
          <button className={styles.primaryBtn} onClick={uploadReplace} disabled={loading}>
            교체 업로드
          </button>
          <label className={styles.fileInput}>
            <input type="file" accept=".xls,.xlsx,.xlsm" onChange={(e) => setAppendFile(e.target.files?.[0] ?? null)} />
            추가 업로드 파일 선택
          </label>
          <button className={styles.primaryBtn} onClick={uploadAppend} disabled={loading}>
            A/B열 추가 업로드
          </button>
        </div>
        {status?.path && (
          <div className={styles.statusMsg}>
            <strong>원가베이스 경로:</strong> {status.path}
          </div>
        )}
        <div className={styles.statusMsg}>
          <strong>추가 업로드 규칙:</strong> 업로드 엑셀의 1행은 헤더로 제외하고, 2행부터 A/B열만 기존 원가베이스 하단에 붙습니다.
        </div>
        {message && (
          <div className={styles.statusMsg}>
            <strong>{message}</strong>
          </div>
        )}
      </section>

      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h3 className={styles.cardTitle}>원가베이스 편집</h3>
          <span className={styles.pill}>
            {pageStart}-{pageEnd} / {total}
          </span>
        </div>
        <div className={styles.uploadRow}>
          <button className={styles.secondaryBtn} onClick={reloadCostBase} disabled={loading}>
            새로 로드
          </button>
          <button className={styles.secondaryBtn} onClick={downloadCostBase} disabled={loading}>
            다운로드
          </button>
          <input
            className={styles.searchInput}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") fetchPreview(0, query).catch((err) => setMessage(err.message || "검색 실패"));
            }}
            placeholder="원가베이스 검색 (엔터)"
          />
          <button
            className={styles.secondaryBtn}
            onClick={() => fetchPreview(0, query).catch((e) => setMessage(e.message || "검색 실패"))}
            disabled={loading}
          >
            조회
          </button>
          <button className={styles.primaryBtn} onClick={saveEdits} disabled={loading}>
            변경 저장
          </button>
        </div>
        <div className={styles.uploadRow}>
          <button
            className={styles.secondaryBtn}
            disabled={loading || offset <= 0}
            onClick={() => fetchPreview(Math.max(0, offset - PAGE_LIMIT), query).catch((e) => setMessage(e.message || "이전 페이지 실패"))}
          >
            이전
          </button>
          <button
            className={styles.secondaryBtn}
            disabled={loading || offset + PAGE_LIMIT >= total}
            onClick={() => fetchPreview(offset + PAGE_LIMIT, query).catch((e) => setMessage(e.message || "다음 페이지 실패"))}
          >
            다음
          </button>
          <span className={styles.pill}>수정 후 `변경 저장` 클릭</span>
        </div>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>행</th>
                <th>{columns[0] || "1열(A)"}</th>
                <th>{columns[1] || "2열(B)"}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.row_index}>
                  <td>{row.row_index + 2}</td>
                  <td>
                    <input
                      className={styles.cellInput}
                      value={row.values?.[0] ?? ""}
                      onChange={(e) => handleCellChange(row.row_index, 0, e.target.value)}
                    />
                  </td>
                  <td>
                    <input
                      className={styles.cellInput}
                      value={row.values?.[1] ?? ""}
                      onChange={(e) => handleCellChange(row.row_index, 1, e.target.value)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && <div className={styles.empty}>표시할 데이터가 없습니다.</div>}
        </div>
      </section>
    </div>
  );
}
