import React, { useCallback, useEffect, useRef, useState } from "react";
import { Clipboard, Download, History, RefreshCw, Trash2, X } from "lucide-react";
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
const EDITABLE = new Set(["C", "E", "F"]);

export default function IchaeTable() {
  const [rows, setRows]           = useState([]);
  const [dates, setDates]         = useState([]);
  const [dateFilter, setDateFilter] = useState("");
  const [loading, setLoading]     = useState(false);
  const [message, setMessage]     = useState("");
  const [total, setTotal]         = useState(0);
  const [editing, setEditing]     = useState(null); // { id, col, value }
  const [exportMonth, setExportMonth] = useState("");
  const [showLogs, setShowLogs] = useState(false);
  const [logs, setLogs] = useState([]);
  const [logsLoading, setLogsLoading] = useState(false);
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

  const fetchLogs = useCallback(async (date) => {
    setLogsLoading(true);
    try {
      const params = date ? `?날짜=${encodeURIComponent(date)}` : "";
      const res = await fetch(`${API}/wonbe/janggi/to-ichae/logs${params}`, { headers: getAuthHeaders() });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) setLogs(data.logs || []);
    } catch { /* ignore */ } finally {
      setLogsLoading(false);
    }
  }, []);

  const openLogs = () => {
    setShowLogs(true);
    fetchLogs(dateFilter);
  };

  const totalAmount = rows.reduce((sum, r) => sum + (typeof r.C === "number" ? r.C : 0), 0);

  const handleExportMonth = () => {
    const params = exportMonth ? `?month=${encodeURIComponent(exportMonth)}` : "";
    fetch(`${API}/wonbe/ichae/export${params}`, { headers: getAuthHeaders() })
      .then((r) => r.blob())
      .then((blob) => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `이체파일_${exportMonth || "전체"}.xls`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(a.href);
      })
      .catch(() => setMessage("다운로드 실패"));
  };

  const handleCopyExcel = async () => {
    if (!rows.length) return;
    const COPY_COLS = ["A", "B", "C", "D", "E", "F"];
    const copyRows = rows.filter((r) => Number(r.C) !== 0);
    if (!copyRows.length) {
      setMessage("입금금액이 0원이 아닌 행이 없습니다.");
      return;
    }
    const tsv = copyRows
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
      const skipped = rows.length - copyRows.length;
      setMessage(`${copyRows.length}행 복사됨${skipped ? ` (0원 ${skipped}행 제외)` : ""} — 엑셀에 붙여넣기 하세요`);
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
            거래처별 합산 이체 데이터 | A=은행코드 · B=계좌번호 · C=입금금액 · D=거래처명 · C·E·F 클릭 수정
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
        <button
          className={`${styles.btn} ${styles.btnSecondary}`}
          onClick={openLogs}
          title={dateFilter ? `${dateFilter} 날짜의 이체파일 전환 로그` : "전체 날짜의 이체파일 전환 로그"}
        >
          <History size={13} />갱신로그
        </button>
        <input
          type="month"
          className={styles.dateInput}
          value={exportMonth}
          onChange={(e) => setExportMonth(e.target.value)}
          title="비워두면 전체 기간을 내려받습니다"
        />
        <button
          className={`${styles.btn} ${styles.btnSecondary}`}
          onClick={handleExportMonth}
          title={exportMonth ? `${exportMonth} 데이터를 엑셀로 다운로드` : "전체 데이터를 엑셀로 다운로드"}
        >
          <Download size={13} />엑셀 다운로드
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
                        {col === "C"
                          ? (typeof row[col] === "number" ? row[col].toLocaleString() : row[col])
                          : (row[col] ?? "")}
                      </td>
                    );
                  }
                  if (col === "D") {
                    return (
                      <td key={col}>
                        {row.D}
                        {row.최근변경 === "신규" && (
                          <span className={`${styles.badge} ${styles.badgeNew}`} style={{ marginLeft: "0.4rem" }}>신규</span>
                        )}
                        {row.최근변경 === "갱신" && (
                          <span className={`${styles.badge} ${styles.badgeUpdated}`} style={{ marginLeft: "0.4rem" }}>갱신</span>
                        )}
                      </td>
                    );
                  }
                  return <td key={col}>{row[col] ?? ""}</td>;
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

      {showLogs && (
        <div
          onClick={() => setShowLogs(false)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 1000, display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: "5vh" }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ background: "var(--surface, #fff)", borderRadius: "10px", boxShadow: "0 8px 32px rgba(0,0,0,0.22)", width: "min(760px, 95vw)", maxHeight: "80vh", display: "flex", flexDirection: "column", overflow: "hidden" }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", padding: "0.9rem 1rem", borderBottom: "1px solid var(--border, #e5e7eb)" }}>
              <History size={16} style={{ flexShrink: 0 }} />
              <span style={{ fontWeight: 700, fontSize: "0.95rem" }}>
                이체파일 전환 로그{dateFilter ? ` — ${dateFilter}` : " (전체 날짜, 최근 50건)"}
              </span>
              <button onClick={() => setShowLogs(false)} style={{ marginLeft: "auto", background: "none", border: "none", cursor: "pointer", color: "var(--text-muted, #888)", padding: "0.2rem", lineHeight: 1 }}>
                <X size={16} />
              </button>
            </div>
            <div style={{ overflowY: "auto", flex: 1 }}>
              {logsLoading ? (
                <div style={{ padding: "2rem", textAlign: "center", color: "var(--text-muted, #888)", fontSize: "0.85rem" }}>불러오는 중…</div>
              ) : logs.length === 0 ? (
                <div style={{ padding: "2rem", textAlign: "center", color: "var(--text-muted, #888)", fontSize: "0.85rem" }}>전환 로그가 없습니다.</div>
              ) : (
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8rem" }}>
                  <thead>
                    <tr style={{ background: "var(--table-header, #f3f4f6)", position: "sticky", top: 0 }}>
                      {["실행일시", "실행자", "날짜", "총거래처", "신규", "갱신", "삭제", "매칭", "미등록", "일괄이체"].map((h) => (
                        <th key={h} style={{ padding: "0.45rem 0.6rem", textAlign: "left", fontWeight: 600, borderBottom: "1px solid var(--border, #e5e7eb)", whiteSpace: "nowrap" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {logs.map((log) => (
                      <tr key={log.id} style={{ borderBottom: "1px solid var(--border, #f0f0f0)" }}>
                        <td style={{ padding: "0.4rem 0.6rem", whiteSpace: "nowrap" }}>{log.실행일시}</td>
                        <td style={{ padding: "0.4rem 0.6rem" }}>{log.실행자}</td>
                        <td style={{ padding: "0.4rem 0.6rem" }}>{log.날짜}</td>
                        <td style={{ padding: "0.4rem 0.6rem" }}>{log.총거래처}</td>
                        <td style={{ padding: "0.4rem 0.6rem", color: "#166534", fontWeight: 600 }}>{log.신규}</td>
                        <td style={{ padding: "0.4rem 0.6rem", color: "#1e40af", fontWeight: 600 }}>{log.갱신}</td>
                        <td style={{ padding: "0.4rem 0.6rem", color: log.삭제 ? "#b91c1c" : undefined, fontWeight: log.삭제 ? 600 : undefined }}>{log.삭제}</td>
                        <td style={{ padding: "0.4rem 0.6rem" }}>{log.매칭}</td>
                        <td style={{ padding: "0.4rem 0.6rem" }}>{log.미등록}</td>
                        <td style={{ padding: "0.4rem 0.6rem" }}>{log.일괄이체포함 ? "포함" : ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
