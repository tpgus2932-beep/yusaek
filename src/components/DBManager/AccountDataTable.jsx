import React, { useCallback, useEffect, useRef, useState } from "react";
import { Plus, RefreshCw, Search, X } from "lucide-react";
import styles from "./DBManager.module.css";
import { LOCAL_API_BASE as API, getAuthHeaders } from "../../lib/api";

const COLS = ["A", "B", "C", "D", "E", "F"];
const COL_HINTS = ["거래처명(매핑키)", "은행코드", "계좌번호", "은행명", "예금주", "부가세 유무"];

export default function AccountDataTable() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [editing, setEditing] = useState(null); // { id, col, value }
  const [search, setSearch] = useState("");
  const inputRef = useRef(null);

  const fetchRows = useCallback(async () => {
    setLoading(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/wonbe/account/rows`, { headers: getAuthHeaders() });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "조회 실패");
      setRows(data.rows || []);
    } catch (err) {
      setMessage(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchRows(); }, [fetchRows]);

  const startEdit = (id, col, val) => {
    setEditing({ id, col, value: val ?? "" });
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const commitEdit = async () => {
    if (!editing) return;
    const { id, col, value } = editing;
    const original = rows.find((r) => r.id === id)?.[col] ?? "";
    setEditing(null);
    if (value === String(original ?? "")) return;
    try {
      const res = await fetch(`${API}/wonbe/account/row`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ id, col, value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "수정 실패");
      setRows((prev) => prev.map((r) => r.id === id ? { ...r, ...data.row } : r));
    } catch (err) {
      setMessage(err.message);
      fetchRows();
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter") commitEdit();
    if (e.key === "Escape") setEditing(null);
  };

  const handleAddRow = async () => {
    try {
      const res = await fetch(`${API}/wonbe/account/row`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "행 추가 실패");
      setRows((prev) => [data.row, ...prev]);
    } catch (err) {
      setMessage(err.message);
    }
  };

  const handleDeleteRow = async (id) => {
    if (!window.confirm("이 행을 삭제하시겠습니까?")) return;
    try {
      const res = await fetch(`${API}/wonbe/account/row`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "삭제 실패");
      setRows((prev) => prev.filter((r) => r.id !== id));
    } catch (err) {
      setMessage(err.message);
    }
  };

  const normalizedSearch = search.trim().toLowerCase();
  const filteredRows = normalizedSearch
    ? rows.filter((row) => COLS.some((col) => String(row[col] ?? "").toLowerCase().includes(normalizedSearch)))
    : rows;

  return (
    <>
      <div className={styles.header}>
        <div>
          <div className={styles.title}>거래처계좌데이터</div>
          <div className={styles.subtitle}>
            A=거래처명(매핑키) · B=은행코드 · C=계좌번호 · D=은행명 · E=예금주 · F=부가세 유무 | 셀 클릭 → 수정
          </div>
        </div>
        <span className={styles.pill}>{normalizedSearch ? `${filteredRows.length} / ${rows.length}` : rows.length}행</span>
      </div>

      <div className={styles.controls}>
        <div className={styles.searchBox}>
          <Search size={14} aria-hidden="true" />
          <input
            className={styles.searchInput}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="거래처명, 계좌번호, 예금주 검색"
            aria-label="거래처계좌데이터 검색"
          />
          {search && (
            <button className={styles.searchClear} onClick={() => setSearch("")} aria-label="검색어 지우기">
              <X size={13} />
            </button>
          )}
        </div>
        <button className={`${styles.btn} ${styles.btnSecondary}`} onClick={fetchRows} disabled={loading}>
          <RefreshCw size={13} />새로고침
        </button>
        <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={handleAddRow} disabled={loading}>
          <Plus size={13} />행 추가
        </button>
      </div>

      {message && <div className={styles.message}>{message}</div>}

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th style={{ width: "2rem" }} />
              {COLS.map((col, i) => (
                <th key={col}>{col} <span style={{ fontWeight: 400, opacity: 0.6 }}>({COL_HINTS[i]})</span></th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filteredRows.map((row) => (
              <tr key={row.id}>
                <td style={{ textAlign: "center", padding: "0.25rem" }}>
                  <button
                    onClick={() => handleDeleteRow(row.id)}
                    style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", padding: "0.15rem", lineHeight: 1 }}
                    title="행 삭제"
                    onMouseEnter={(e) => e.currentTarget.style.color = "#b91c1c"}
                    onMouseLeave={(e) => e.currentTarget.style.color = "var(--text-muted)"}
                  >
                    <X size={12} />
                  </button>
                </td>
                {COLS.map((col) => {
                  const isEditing = editing?.id === row.id && editing?.col === col;
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
                      onClick={() => startEdit(row.id, col, row[col] ?? "")}
                      title="클릭하여 수정"
                    >
                      {row[col] || ""}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {!filteredRows.length && !loading && (
          <div className={styles.empty}>
            {normalizedSearch ? "검색 결과가 없습니다." : "데이터가 없습니다. 행 추가 또는 xlsx import를 사용하세요."}
          </div>
        )}
      </div>
    </>
  );
}
