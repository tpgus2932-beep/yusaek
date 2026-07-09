import React, { useCallback, useEffect, useRef, useState } from "react";
import { Clipboard, RefreshCw, Trash2 } from "lucide-react";
import styles from "./DBManager.module.css";
import { LOCAL_API_BASE as API, getAuthHeaders } from "../../lib/api";

const COLS      = ["날짜", "A", "B", "C", "D", "E", "F", "상태"];
const COL_LABELS = {
  날짜: "날짜",
  A: "은행코드",
  B: "계좌번호",
  C: "입금금액",
  D: "거래처명",
  E: "거래처가 보는 메모",
  F: "우리가 보는 메모",
  상태: "상태",
};
const EDITABLE = new Set(["E", "F"]);

export default function IchaeTable() {
  const [rows, setRows]           = useState([]);
  const [dates, setDates]         = useState([]);
  const [dateFilter, setDateFilter] = useState("");
  const [loading, setLoading]     = useState(false);
  const [message, setMessage]     = useState("");
  const [total, setTotal]         = useState(0);
  const [editing, setEditing]     = useState(null); // { id, col, value }
  const inputRef = useRef(null);

  const fetchDates = useCallback(async () => {
    try {
      const res = await fetch(`${API}/wonbe/ichae/dates`, { headers: getAuthHeaders() });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) setDates(data.dates || []);
    } catch { /* ignore */ }
  }, []);

  const fetchRows = useCallback(async (date) => {
    setLoading(true);
    setMessage("");
    try {
      const params = date ? `?date=${encodeURIComponent(date)}` : "";
      const res = await fetch(`${API}/wonbe/ichae/search${params}`, { headers: getAuthHeaders() });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "조회 실패");
      setRows(data.rows || []);
      setTotal(data.total ?? 0);
    } catch (err) {
      setMessage(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDates();
    fetchRows("");
  }, [fetchDates, fetchRows]);

  const handleDateChange = (e) => {
    const d = e.target.value;
    setDateFilter(d);
    fetchRows(d);
  };

  const handleDeleteByDate = async () => {
    if (!dateFilter) return;
    if (!window.confirm(`${dateFilter} 날짜의 이체파일 데이터를 모두 삭제하시겠습니까?`)) return;
    setMessage("");
    try {
      const res = await fetch(`${API}/wonbe/ichae/by-date`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ 날짜: dateFilter }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "삭제 실패");
      setMessage(`${data.deleted}행 삭제됨`);
      setRows([]);
      setTotal(0);
      await fetchDates();
    } catch (err) {
      setMessage(err.message);
    }
  };

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
      const res = await fetch(`${API}/wonbe/ichae/row`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ id, col, value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "수정 실패");
      setRows((prev) => prev.map((r) => r.id === id ? { ...r, ...data.row } : r));
    } catch (err) {
      setMessage(err.message);
      fetchRows(dateFilter);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter") commitEdit();
    if (e.key === "Escape") setEditing(null);
  };

  const totalAmount = rows.reduce((sum, r) => sum + (typeof r.C === "number" ? r.C : 0), 0);

  const handleCopyExcel = async () => {
    if (!rows.length) return;
    const COPY_COLS = ["A", "B", "C", "D", "E", "F"];
    const tsv = rows
      .map((r) => COPY_COLS.map((col) => {
        const v = r[col];
        return v == null ? "" : String(v);
      }).join("\t"))
      .join("\n");
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(tsv);
      } else {
        const ta = document.createElement("textarea");
        ta.value = tsv;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
      }
      setMessage(`${rows.length}행 복사됨 — 엑셀에 붙여넣기 하세요`);
    } catch {
      setMessage("클립보드 복사 실패 (브라우저 권한 확인)");
    }
  };

  return (
    <>
      <div className={styles.header}>
        <div>
          <div className={styles.title}>이체파일</div>
          <div className={styles.subtitle}>
            거래처별 합산 이체 데이터 | A=은행코드 · B=계좌번호 · C=입금금액 · D=거래처명 · E·F 클릭 수정
          </div>
        </div>
        <span className={styles.pill}>{total}행</span>
      </div>

      <div className={styles.controls}>
        <select
          className={styles.dateInput}
          value={dateFilter}
          onChange={handleDateChange}
          style={{ minWidth: "9rem" }}
        >
          <option value="">전체 날짜</option>
          {dates.map((d) => (
            <option key={d} value={d}>{d}</option>
          ))}
        </select>
        <button className={`${styles.btn} ${styles.btnSecondary}`} onClick={() => fetchRows(dateFilter)} disabled={loading}>
          <RefreshCw size={13} />새로고침
        </button>
        <button
          className={`${styles.btn} ${styles.btnPrimary}`}
          onClick={handleCopyExcel}
          disabled={!dateFilter || !rows.length || loading}
          title={!dateFilter ? "날짜를 먼저 선택하세요" : "A~F열 데이터를 엑셀용으로 복사"}
        >
          <Clipboard size={13} />엑셀 복사
        </button>
        <button
          className={`${styles.btn} ${styles.btnDanger}`}
          onClick={handleDeleteByDate}
          disabled={!dateFilter || loading}
        >
          <Trash2 size={13} />날짜별 삭제
        </button>
        {rows.length > 0 && (
          <span style={{ marginLeft: "auto", fontSize: "0.78rem", color: "var(--text-muted)" }}>
            합계: {totalAmount.toLocaleString()}원
          </span>
        )}
      </div>

      {message && <div className={styles.message}>{message}</div>}

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              {COLS.map((col) => (
                <th key={col}>
                  {COL_LABELS[col]}
                  {EDITABLE.has(col) && (
                    <span style={{ fontWeight: 400, fontSize: "0.72rem", opacity: 0.55, marginLeft: "0.3rem" }}>✎</span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.id}
                style={row.상태 === "미등록" ? { color: "#b91c1c", background: "#fff5f5" } : undefined}
              >
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
                  if (EDITABLE.has(col)) {
                    return (
                      <td
                        key={col}
                        className={styles.editableCell}
                        onClick={() => startEdit(row.id, col, row[col] ?? "")}
                        title="클릭하여 수정"
                      >
                        {row[col] ?? ""}
                      </td>
                    );
                  }
                  return (
                    <td key={col}>
                      {col === "C"
                        ? (typeof row[col] === "number" ? row[col].toLocaleString() : row[col])
                        : (row[col] ?? "")}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && !loading && (
          <div className={styles.empty}>
            {dateFilter ? `${dateFilter} 날짜의 이체파일 데이터가 없습니다.` : "이체파일 데이터가 없습니다."}
          </div>
        )}
      </div>
    </>
  );
}
