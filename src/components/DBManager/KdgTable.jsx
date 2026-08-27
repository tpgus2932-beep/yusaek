import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, RefreshCw, RefreshCcw, Upload, Search, X } from "lucide-react";
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

  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const [wonbeSearch, setWonbeSearch] = useState("");
  const [wonbeResults, setWonbeResults] = useState([]);
  const [wonbeSearchLoading, setWonbeSearchLoading] = useState(false);
  const [selectedWonbeCodes, setSelectedWonbeCodes] = useState(new Set());
  const [importing, setImporting] = useState(false);
  const wonbeSearchRef = useRef(null);

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

  useEffect(() => {
    if (!showUpdateModal) return;
    const timer = setTimeout(async () => {
      setWonbeSearchLoading(true);
      try {
        const params = new URLSearchParams({ q: wonbeSearch.trim(), limit: 100 });
        const res = await fetch(`${API}/wonbe/search?${params}`, { headers: getAuthHeaders() });
        const data = await res.json().catch(() => ({}));
        setWonbeResults(data.rows || []);
      } catch {
        setWonbeResults([]);
      } finally {
        setWonbeSearchLoading(false);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [wonbeSearch, showUpdateModal]);

  useEffect(() => {
    if (showUpdateModal) setTimeout(() => wonbeSearchRef.current?.focus(), 50);
  }, [showUpdateModal]);

  const openUpdateModal = () => {
    setWonbeSearch("");
    setWonbeResults([]);
    setSelectedWonbeCodes(new Set());
    setShowUpdateModal(true);
  };

  const toggleWonbeSelect = (code) => {
    setSelectedWonbeCodes((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  };

  const toggleWonbeSelectAll = () => {
    setSelectedWonbeCodes((prev) => {
      if (prev.size === wonbeResults.length) return new Set();
      return new Set(wonbeResults.map((r) => r["상품코드"]));
    });
  };

  const handleImportFromWonbe = async () => {
    const selectedRows = wonbeResults.filter((r) => selectedWonbeCodes.has(r["상품코드"]));
    if (!selectedRows.length) return;
    setImporting(true);
    setMessage("");
    try {
      const text = selectedRows
        .map((r) => `${String(r["거래처합"] || "").trim()}\t${String(r["상품코드"] || "").trim()}`)
        .join("\n");
      const res = await fetch(`${API}/noye-kimsungil/kdg/base/append-tsv`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ text }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "가져오기 실패");
      setMessage(`원가베이스유에서 가져오기 완료: ${data.appended}건`);
      setShowUpdateModal(false);
      setOffset(0);
      setQuery("");
      setInputQuery("");
      await fetchRows("", 0);
    } catch (err) {
      setMessage(err.message);
    } finally {
      setImporting(false);
    }
  };

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
        <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={openUpdateModal} disabled={loading}>
          <RefreshCcw size={13} />업데이트
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

      {showUpdateModal && (
        <div
          onClick={() => setShowUpdateModal(false)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 1000, display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: "5vh" }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ background: "var(--surface, #fff)", borderRadius: "10px", boxShadow: "0 8px 32px rgba(0,0,0,0.22)", width: "min(720px, 95vw)", maxHeight: "80vh", display: "flex", flexDirection: "column", overflow: "hidden" }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", padding: "0.9rem 1rem", borderBottom: "1px solid var(--border, #e5e7eb)" }}>
              <RefreshCcw size={16} style={{ color: "#7c3aed", flexShrink: 0 }} />
              <span style={{ fontWeight: 700, fontSize: "0.95rem" }}>원가베이스유에서 가져오기</span>
              <div style={{ flex: 1, position: "relative" }}>
                <Search size={13} style={{ position: "absolute", left: "0.5rem", top: "50%", transform: "translateY(-50%)", color: "var(--text-muted, #888)", pointerEvents: "none" }} />
                <input
                  ref={wonbeSearchRef}
                  value={wonbeSearch}
                  onChange={(e) => setWonbeSearch(e.target.value)}
                  placeholder="상품코드·거래처합·거래처 검색…"
                  style={{ width: "100%", padding: "0.4rem 0.5rem 0.4rem 1.8rem", border: "1px solid var(--border, #d1d5db)", borderRadius: "6px", fontSize: "0.83rem", outline: "none", background: "var(--input-bg, #f9fafb)" }}
                />
              </div>
              <button onClick={() => setShowUpdateModal(false)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted, #888)", padding: "0.2rem", lineHeight: 1 }}>
                <X size={16} />
              </button>
            </div>
            <div style={{ overflowY: "auto", flex: 1 }}>
              {wonbeSearchLoading ? (
                <div style={{ padding: "2rem", textAlign: "center", color: "var(--text-muted, #888)", fontSize: "0.85rem" }}>검색 중…</div>
              ) : wonbeResults.length === 0 ? (
                <div style={{ padding: "2rem", textAlign: "center", color: "var(--text-muted, #888)", fontSize: "0.85rem" }}>
                  {wonbeSearch.trim() ? "검색 결과가 없습니다." : "키워드를 입력하면 원가베이스유에서 검색됩니다."}
                </div>
              ) : (
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8rem" }}>
                  <thead>
                    <tr style={{ background: "var(--table-header, #f3f4f6)", position: "sticky", top: 0 }}>
                      <th style={{ padding: "0.45rem 0.6rem", width: "28px" }}>
                        <input
                          type="checkbox"
                          checked={wonbeResults.length > 0 && selectedWonbeCodes.size === wonbeResults.length}
                          onChange={toggleWonbeSelectAll}
                        />
                      </th>
                      {["거래처합", "상품코드", "거래처", "상품명합"].map((h) => (
                        <th key={h} style={{ padding: "0.45rem 0.6rem", textAlign: "left", fontWeight: 600, borderBottom: "1px solid var(--border, #e5e7eb)", whiteSpace: "nowrap" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {wonbeResults.map((row) => {
                      const code = row["상품코드"];
                      const checked = selectedWonbeCodes.has(code);
                      return (
                        <tr
                          key={code}
                          onClick={() => toggleWonbeSelect(code)}
                          style={{ cursor: "pointer", borderBottom: "1px solid var(--border, #f0f0f0)", background: checked ? "#f5f3ff" : undefined }}
                        >
                          <td style={{ padding: "0.4rem 0.6rem" }} onClick={(e) => e.stopPropagation()}>
                            <input type="checkbox" checked={checked} onChange={() => toggleWonbeSelect(code)} />
                          </td>
                          <td style={{ padding: "0.4rem 0.6rem", fontWeight: 600 }}>{row["거래처합"] ?? ""}</td>
                          <td style={{ padding: "0.4rem 0.6rem" }}>{code ?? ""}</td>
                          <td style={{ padding: "0.4rem 0.6rem", color: "var(--text-muted, #666)" }}>{row["거래처"] ?? ""}</td>
                          <td style={{ padding: "0.4rem 0.6rem", color: "var(--text-muted, #666)" }}>{row["상품명합"] ?? ""}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.6rem", padding: "0.6rem 1rem", borderTop: "1px solid var(--border, #e5e7eb)" }}>
              <span style={{ fontSize: "0.75rem", color: "var(--text-muted, #888)" }}>
                선택 {selectedWonbeCodes.size}건 · 거래처합 → 변환품명, 상품코드 그대로 반영됩니다
              </span>
              <button
                className={`${styles.btn} ${styles.btnPrimary}`}
                onClick={handleImportFromWonbe}
                disabled={importing || !selectedWonbeCodes.size}
              >
                {importing ? "가져오는 중..." : `가져오기 (${selectedWonbeCodes.size})`}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
