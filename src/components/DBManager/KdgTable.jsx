import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, RefreshCw, Upload } from "lucide-react";
import styles from "./DBManager.module.css";
import { LOCAL_API_BASE as API, getAuthHeaders } from "../../lib/api";

const PAGE_SIZE = 50;
const COLS = ["변환품명", "상품코드"];

export default function KdgTable() {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [query, setQuery] = useState("");
  const [inputQuery, setInputQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [editing, setEditing] = useState(null); // { rowId, col, value }
  const inputRef = useRef(null);
  const [sortCol, setSortCol] = useState(null);
  const [sortDir, setSortDir] = useState("asc");

  const handleSort = (col) => {
    if (sortCol === col) {
      if (sortDir === "asc") setSortDir("desc");
      else { setSortCol(null); setSortDir("asc"); }
    } else {
      setSortCol(col);
      setSortDir("asc");
    }
  };

  const sortedRows = useMemo(() => {
    if (!sortCol) return rows;
    const colIdx = COLS.indexOf(sortCol);
    return [...rows].sort((a, b) => {
      const av = a.values?.[colIdx] ?? "";
      const bv = b.values?.[colIdx] ?? "";
      const cmp = String(av).localeCompare(String(bv), "ko", { numeric: true });
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [rows, sortCol, sortDir]);

  const fetchRows = useCallback(async (q, off) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ offset: off, limit: PAGE_SIZE });
      if (q) params.set("q", q);
      const res = await fetch(`${API}/noye-kimsungil/kdg/base/preview?${params}`, { headers: getAuthHeaders() });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "조회 실패");
      setRows(data.rows || []);
      setTotal(data.total || 0);
    } catch (err) {
      setMessage(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchRows(query, offset); }, [fetchRows, query, offset]);

  const handleSearch = (e) => {
    e.preventDefault();
    setOffset(0);
    setQuery(inputQuery.trim());
  };

  const startEdit = (rowId, colIdx, currentValue) => {
    setEditing({ rowId, colIdx, value: currentValue || "" });
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const commitEdit = async () => {
    if (!editing) return;
    const { rowId, colIdx, value } = editing;
    setEditing(null);
    const original = rows.find((r) => r.row_index === rowId)?.values?.[colIdx] || "";
    if (value === original) return;
    try {
      const res = await fetch(`${API}/noye-kimsungil/kdg/base/edit-batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ edits: [{ row_index: rowId, column: colIdx, value }] }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "수정 실패");
      setRows((prev) =>
        prev.map((r) => {
          if (r.row_index !== rowId) return r;
          const newVals = [...(r.values || [])];
          newVals[colIdx] = value;
          return { ...r, values: newVals };
        })
      );
    } catch (err) {
      setMessage(err.message);
      fetchRows(query, offset);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter") commitEdit();
    if (e.key === "Escape") setEditing(null);
  };

  const handleUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    setLoading(true);
    setMessage("");
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(`${API}/noye-kimsungil/kdg/base/upload`, {
        method: "POST",
        headers: getAuthHeaders(),
        body: form,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "업로드 실패");
      setMessage(`업로드 완료: ${data.total}행`);
      setOffset(0);
      setQuery("");
      setInputQuery("");
      await fetchRows("", 0);
    } catch (err) {
      setMessage(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleDownload = () => {
    fetch(`${API}/noye-kimsungil/kdg/base/download`, { headers: getAuthHeaders() })
      .then((r) => r.blob())
      .then((blob) => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "케이디지원가베이스.xls";
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(a.href);
      })
      .catch(() => setMessage("다운로드 실패"));
  };

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  return (
    <>
      <div className={styles.header}>
        <div>
          <div className={styles.title}>케이디지원가베이스</div>
          <div className={styles.subtitle}>변환품명 → 상품코드 매핑</div>
        </div>
        <span className={styles.pill}>{total.toLocaleString()}행</span>
      </div>

      <div className={styles.controls}>
        <form onSubmit={handleSearch} style={{ display: "flex", gap: "0.5rem" }}>
          <input
            className={styles.searchInput}
            value={inputQuery}
            onChange={(e) => setInputQuery(e.target.value)}
            placeholder="변환품명 / 상품코드"
          />
          <button className={`${styles.btn} ${styles.btnPrimary}`} type="submit" disabled={loading}>
            검색
          </button>
        </form>
        <button className={`${styles.btn} ${styles.btnSecondary}`} onClick={() => fetchRows(query, offset)} disabled={loading}>
          <RefreshCw size={13} />새로고침
        </button>
        <label className={styles.fileLabel}>
          <input type="file" accept=".xlsx,.xls,.xlsm" onChange={handleUpload} disabled={loading} />
          <Upload size={13} />xlsx 임포트
        </label>
        <button className={`${styles.btn} ${styles.btnSecondary}`} onClick={handleDownload} disabled={loading}>
          <Download size={13} />xls 내보내기
        </button>
      </div>

      {message && <div className={styles.message}>{message}</div>}

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              {COLS.map((col) => (
                <th key={col} className={styles.sortableHeader} onClick={() => handleSort(col)}>
                  {col} ✎{sortCol === col ? <span className={styles.sortIcon}>{sortDir === "asc" ? "▲" : "▼"}</span> : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((row) => (
              <tr key={row.row_index}>
                {COLS.map((col, colIdx) => {
                  const isEditing = editing?.rowId === row.row_index && editing?.colIdx === colIdx;
                  if (isEditing) {
                    return (
                      <td key={col}>
                        <input
                          ref={inputRef}
                          className={styles.inlineInput}
                          value={editing.value}
                          onChange={(e) => setEditing((p) => ({ ...p, value: e.target.value }))}
                          onBlur={commitEdit}
                          onKeyDown={handleKeyDown}
                        />
                      </td>
                    );
                  }
                  return (
                    <td
                      key={col}
                      className={styles.editableCell}
                      onClick={() => startEdit(row.row_index, colIdx, row.values?.[colIdx])}
                      title="클릭하여 수정"
                    >
                      {row.values?.[colIdx] || ""}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && !loading && <div className={styles.empty}>조회된 데이터가 없습니다.</div>}
      </div>

      {totalPages > 1 && (
        <div className={styles.pagination}>
          <button
            className={`${styles.btn} ${styles.btnSecondary}`}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            disabled={offset === 0 || loading}
          >이전</button>
          <span>{currentPage} / {totalPages}</span>
          <button
            className={`${styles.btn} ${styles.btnSecondary}`}
            onClick={() => setOffset(offset + PAGE_SIZE)}
            disabled={currentPage >= totalPages || loading}
          >다음</button>
        </div>
      )}
    </>
  );
}
