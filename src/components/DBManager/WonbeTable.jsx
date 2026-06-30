import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, RefreshCw, Upload, FileSpreadsheet, RefreshCcw, PencilLine } from "lucide-react";
import styles from "./DBManager.module.css";
import { LOCAL_API_BASE as API, getAuthHeaders } from "../../lib/api";

const PAGE_SIZE = 50;
const EDITABLE_COLS = ["상품명합", "거래처합", "원가", "거래처주소"];
const ALL_COLS = ["상품코드", "상품명", "색상", "사이즈", "원가", "거래처", "거래처상품명", "거래처합", "상품명합", "거래처주소", "옵션번호"];

export default function WonbeTable() {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [query, setQuery] = useState("");
  const [inputQuery, setInputQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState("");
  const todayStr = new Date().toISOString().slice(0, 10);
  const [syncStartDate, setSyncStartDate] = useState(todayStr);
  const [syncEndDate, setSyncEndDate] = useState(todayStr);
  const [lastSync, setLastSync] = useState(null); // { at, count, fetched }
  const [editing, setEditing] = useState(null); // { code, col, value }
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
    return [...rows].sort((a, b) => {
      const av = a[sortCol] ?? "";
      const bv = b[sortCol] ?? "";
      const cmp = String(av).localeCompare(String(bv), "ko", { numeric: true });
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [rows, sortCol, sortDir]);
  const [showBulkCost, setShowBulkCost] = useState(false);
  const [bulkCostValue, setBulkCostValue] = useState("");
  const [bulkCostLoading, setBulkCostLoading] = useState(false);
  const bulkCostRef = useRef(null);

  const fetchRows = useCallback(async (q, off) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ q, offset: off, limit: PAGE_SIZE });
      const res = await fetch(`${API}/wonbe/search?${params}`, { headers: getAuthHeaders() });
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
    fetch(`${API}/wonbe/stats`, { headers: getAuthHeaders() })
      .then((r) => r.json())
      .then((d) => {
        if (d.ok && d.last_sync_at) {
          setLastSync({ at: d.last_sync_at, count: d.last_sync_count, fetched: d.last_sync_fetched });
        }
      })
      .catch(() => {});
  }, []);

  const handleSearch = (e) => {
    e.preventDefault();
    setOffset(0);
    setQuery(inputQuery.trim());
  };

  const startEdit = (code, col, currentValue) => {
    setEditing({ code, col, value: currentValue || "" });
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const commitEdit = async () => {
    if (!editing) return;
    const { code, col, value } = editing;
    setEditing(null);
    const original = rows.find((r) => r["상품코드"] === code)?.[col] || "";
    if (value === original) return;
    try {
      const res = await fetch(`${API}/wonbe/row`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ 상품코드: code, [col]: value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "수정 실패");
      setRows((prev) => prev.map((r) => r["상품코드"] === code ? { ...r, ...data.row } : r));
      setMessage(`수정 완료: ${code}`);
    } catch (err) {
      setMessage(err.message);
      fetchRows(query, offset);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter") commitEdit();
    if (e.key === "Escape") setEditing(null);
  };

  const handleImportFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    setLoading(true);
    setMessage("");
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(`${API}/wonbe/import`, {
        method: "POST",
        headers: getAuthHeaders(),
        body: form,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "임포트 실패");
      setMessage(`임포트 완료: ${data.count}행`);
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

  const handleInitDefault = async () => {
    if (!window.confirm("서버의 원가베이스유.xlsx 파일로 DB를 초기화합니다. 기존 데이터는 모두 덮어씌워집니다.")) return;
    setLoading(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/wonbe/init-from-default`, {
        method: "POST",
        headers: getAuthHeaders(),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "초기화 실패");
      setMessage(`초기화 완료: ${data.count}행`);
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

  const handleSyncEzadmin = async () => {
    setSyncing(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/wonbe/sync-from-ezadmin`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ start_date: syncStartDate, end_date: syncEndDate }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        if (data?.need_session) { setMessage("이지어드민 세션이 없습니다. EZAdmin 설정에서 PHPSESSID를 먼저 등록해주세요."); return; }
        throw new Error(data?.detail || "동기화 실패");
      }
      setLastSync({ at: data.synced_at, count: String(data.inserted), fetched: String(data.fetched) });
      setMessage(`동기화 완료: ${data.fetched}개 조회 → ${data.inserted}개 신규 등록`);
      setOffset(0);
      setQuery("");
      setInputQuery("");
      await fetchRows("", 0);
    } catch (err) {
      setMessage(err.message);
    } finally {
      setSyncing(false);
    }
  };

  const handleBulkUpdateCost = async () => {
    const cost = bulkCostValue.trim();
    if (cost === "") { setMessage("원가 값을 입력해주세요."); return; }
    const label = query ? `"${query}" 검색 결과 ${total.toLocaleString()}건` : `전체 ${total.toLocaleString()}건`;
    if (!window.confirm(`${label}의 원가를 "${cost}"로 일괄 수정합니다.\n\n진행하시겠습니까?`)) return;
    setBulkCostLoading(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/wonbe/bulk-update-cost`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ q: query, 원가: cost }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "일괄수정 실패");
      setMessage(`원가 일괄수정 완료: ${data.count}건`);
      setShowBulkCost(false);
      setBulkCostValue("");
      await fetchRows(query, offset);
    } catch (err) {
      setMessage(err.message);
    } finally {
      setBulkCostLoading(false);
    }
  };

  const handleExport = () => {
    const url = `${API}/wonbe/export`;
    const a = document.createElement("a");
    a.href = url;
    const headers = getAuthHeaders();
    fetch(url, { headers })
      .then((res) => res.blob())
      .then((blob) => {
        const href = URL.createObjectURL(blob);
        a.href = href;
        a.download = "원가베이스유.xls";
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(href);
      })
      .catch(() => setMessage("엑셀 다운로드 실패"));
  };

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  return (
    <>
      <div className={styles.header}>
        <div>
          <div className={styles.title}>원가베이스유</div>
          <div className={styles.subtitle}>상품코드 · 상품명합 · 거래처합 검색 / 상품명합, 거래처합, 원가 수정</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          {lastSync && (
            <span className={styles.syncInfo}>
              마지막 동기화 {lastSync.at} · 신규 {lastSync.count}개
            </span>
          )}
          <span className={styles.pill}>{total.toLocaleString()}행</span>
        </div>
      </div>

      <div className={styles.controls}>
        <form onSubmit={handleSearch} style={{ display: "flex", gap: "0.5rem" }}>
          <input
            className={styles.searchInput}
            value={inputQuery}
            onChange={(e) => setInputQuery(e.target.value)}
            placeholder="상품코드 / 상품명합 / 거래처합"
          />
          <button className={`${styles.btn} ${styles.btnPrimary}`} type="submit" disabled={loading}>
            검색
          </button>
        </form>
        <button className={`${styles.btn} ${styles.btnSecondary}`} onClick={() => fetchRows(query, offset)} disabled={loading || syncing}>
          <RefreshCw size={13} />새로고침
        </button>
        <div className={styles.syncDateGroup}>
          <span className={styles.syncDateLabel}>등록일</span>
          <input
            type="date"
            className={styles.syncDateInput}
            value={syncStartDate}
            onChange={(e) => setSyncStartDate(e.target.value)}
            disabled={syncing}
          />
          <span className={styles.syncDateSep}>~</span>
          <input
            type="date"
            className={styles.syncDateInput}
            value={syncEndDate}
            onChange={(e) => setSyncEndDate(e.target.value)}
            disabled={syncing}
          />
          <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={handleSyncEzadmin} disabled={loading || syncing}>
            <RefreshCcw size={13} />{syncing ? "동기화 중..." : "이지어드민 동기화"}
          </button>
        </div>
        <button className={`${styles.btn} ${styles.btnSecondary}`} onClick={handleInitDefault} disabled={loading}>
          <FileSpreadsheet size={13} />기본파일로 초기화
        </button>
        <label className={styles.fileLabel}>
          <input type="file" accept=".xlsx,.xls,.xlsm" onChange={handleImportFile} disabled={loading} />
          <Upload size={13} />xlsx 임포트
        </label>
        <button className={`${styles.btn} ${styles.btnSecondary}`} onClick={handleExport} disabled={loading}>
          <Download size={13} />xls 내보내기
        </button>
        <button
          className={`${styles.btn} ${styles.btnSecondary}`}
          onClick={() => { setShowBulkCost((v) => !v); setBulkCostValue(""); setTimeout(() => bulkCostRef.current?.focus(), 0); }}
          disabled={loading || bulkCostLoading}
        >
          <PencilLine size={13} />원가 일괄수정
        </button>
        {showBulkCost && (
          <div className={styles.syncDateGroup}>
            <span className={styles.syncDateLabel}>새 원가</span>
            <input
              ref={bulkCostRef}
              className={styles.syncDateInput}
              style={{ width: "90px" }}
              value={bulkCostValue}
              onChange={(e) => setBulkCostValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleBulkUpdateCost(); if (e.key === "Escape") setShowBulkCost(false); }}
              placeholder="예: 15000"
              disabled={bulkCostLoading}
            />
            <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={handleBulkUpdateCost} disabled={bulkCostLoading}>
              {bulkCostLoading ? "수정 중..." : "적용"}
            </button>
            <button className={`${styles.btn} ${styles.btnSecondary}`} onClick={() => setShowBulkCost(false)} disabled={bulkCostLoading}>
              취소
            </button>
          </div>
        )}
      </div>

      {message && <div className={styles.message}>{message}</div>}

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              {ALL_COLS.map((col) => (
                <th key={col} className={styles.sortableHeader} onClick={() => handleSort(col)}>
                  {col}{EDITABLE_COLS.includes(col) ? " ✎" : ""}{sortCol === col ? <span className={styles.sortIcon}>{sortDir === "asc" ? "▲" : "▼"}</span> : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((row) => {
              const code = row["상품코드"];
              return (
                <tr key={code}>
                  {ALL_COLS.map((col) => {
                    const isEditing = editing?.code === code && editing?.col === col;
                    const isEditable = EDITABLE_COLS.includes(col);
                    if (isEditing) {
                      return (
                        <td key={col}>
                          <input
                            ref={inputRef}
                            className={styles.inlineInput}
                            value={editing.value}
                            onChange={(e) => setEditing((prev) => ({ ...prev, value: e.target.value }))}
                            onBlur={commitEdit}
                            onKeyDown={handleKeyDown}
                          />
                        </td>
                      );
                    }
                    return (
                      <td
                        key={col}
                        className={isEditable ? styles.editableCell : ""}
                        onClick={isEditable ? () => startEdit(code, col, row[col]) : undefined}
                        title={isEditable ? "클릭하여 수정" : undefined}
                      >
                        {row[col] || ""}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
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
