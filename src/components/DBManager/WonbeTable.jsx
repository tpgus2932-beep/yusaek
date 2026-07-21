import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, RefreshCw, Upload, RefreshCcw, PencilLine, Check, X, SlidersHorizontal } from "lucide-react";
import styles from "./DBManager.module.css";
import { LOCAL_API_BASE as API, getAuthHeaders } from "../../lib/api";

const PAGE_SIZE = 50;
const EDITABLE_COLS = ["상품명합", "거래처합", "원가", "거래처주소"];
const ALL_COLS = ["상품코드", "상품명", "색상", "사이즈", "원가", "거래처", "거래처상품명", "거래처합", "상품명합", "거래처주소", "옵션번호", "에이블리상품번호", "등록일", "진열상태", "품절상태", "제조국"];
const VISIBLE_COLS_STORAGE_KEY = "wonbe_visible_cols";

export default function WonbeTable() {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [query, setQuery] = useState("");
  const [inputQuery, setInputQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [snoSyncing, setSnoSyncing] = useState(false);
  const [regDateSyncing, setRegDateSyncing] = useState(false);
  const [countrySyncing, setCountrySyncing] = useState(false);
  const [countryProgress, setCountryProgress] = useState(null); // { total, done, matched }
  const countryPollRef = useRef(null);
  const [message, setMessage] = useState("");
  const [rawUnexpected, setRawUnexpected] = useState(null);
  const todayStr = new Date().toISOString().slice(0, 10);
  const [syncStartDate, setSyncStartDate] = useState(todayStr);
  const [syncEndDate, setSyncEndDate] = useState(todayStr);
  const [lastSync, setLastSync] = useState(null);
  const [editing, setEditing] = useState(null); // { code, col, value }
  const inputRef = useRef(null);
  const [sortCol, setSortCol] = useState(null);
  const [sortDir, setSortDir] = useState("asc");

  // 헤더 일괄수정
  const [bulkEditCol, setBulkEditCol] = useState(null);
  const [bulkEditValue, setBulkEditValue] = useState("");
  const [bulkEditLoading, setBulkEditLoading] = useState(false);
  const bulkEditRef = useRef(null);

  // 표시할 컬럼 선택
  const [visibleCols, setVisibleCols] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(VISIBLE_COLS_STORAGE_KEY) || "null");
      if (Array.isArray(saved) && saved.length) {
        return new Set(saved.filter((c) => ALL_COLS.includes(c)));
      }
    } catch { /* noop */ }
    return new Set(ALL_COLS);
  });
  const [colPanelOpen, setColPanelOpen] = useState(false);
  const colPanelRef = useRef(null);

  useEffect(() => {
    localStorage.setItem(VISIBLE_COLS_STORAGE_KEY, JSON.stringify(Array.from(visibleCols)));
  }, [visibleCols]);

  useEffect(() => {
    if (!colPanelOpen) return;
    const onClickOutside = (e) => {
      if (colPanelRef.current && !colPanelRef.current.contains(e.target)) setColPanelOpen(false);
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [colPanelOpen]);

  const toggleCol = (col) => {
    setVisibleCols((prev) => {
      const next = new Set(prev);
      if (next.has(col)) {
        if (next.size === 1) return next; // 최소 1개는 유지
        next.delete(col);
      } else {
        next.add(col);
      }
      return next;
    });
  };

  const displayCols = useMemo(() => ALL_COLS.filter((c) => visibleCols.has(c)), [visibleCols]);

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
          setLastSync({ at: d.last_sync_at, count: String(d.last_sync_count), fetched: String(d.last_sync_fetched) });
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

  const openBulkEdit = (col) => {
    setBulkEditCol(col);
    setBulkEditValue("");
    setTimeout(() => bulkEditRef.current?.focus(), 0);
  };

  const closeBulkEdit = () => {
    setBulkEditCol(null);
    setBulkEditValue("");
  };

  const handleBulkEdit = async () => {
    const label = query ? `"${query}" 검색 결과 ${total.toLocaleString()}건` : `전체 ${total.toLocaleString()}건`;
    if (!window.confirm(`${label}의 [${bulkEditCol}]을(를) "${bulkEditValue}"로 일괄 수정합니다.\n진행하시겠습니까?`)) return;
    setBulkEditLoading(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/wonbe/bulk-update`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ q: query, col: bulkEditCol, value: bulkEditValue }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "일괄수정 실패");
      setMessage(`[${bulkEditCol}] 일괄수정 완료: ${data.count}건`);
      closeBulkEdit();
      await fetchRows(query, offset);
    } catch (err) {
      setMessage(err.message);
    } finally {
      setBulkEditLoading(false);
    }
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

  const handleSyncEzadmin = async () => {
    setSyncing(true);
    setMessage("");
    setRawUnexpected(null);
    try {
      const res = await fetch(`${API}/wonbe/sync-from-ezadmin`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ start_date: syncStartDate, end_date: syncEndDate }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        if (data?.need_session) { setMessage("이지어드민 세션이 없습니다. EZAdmin 설정에서 PHPSESSID를 먼저 등록해주세요."); return; }
        if (data?.unexpected_response) {
          setMessage("예상과 다른 응답을 받았습니다 (세션 문제 아님) — 아래 원본을 확인해주세요.");
          setRawUnexpected(data.raw);
          return;
        }
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

  const handleSyncAblySno = async () => {
    setSnoSyncing(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/wonbe/sync-ably-sno`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "에이블리상품번호 동기화 실패");
      setMessage(`에이블리상품번호 동기화 완료: 카탈로그 ${data.fetched_goods}건 조회 · ${data.considered}건 중 ${data.matched}건 매칭 (미매칭 ${data.unmatched}건)`);
      await fetchRows(query, offset);
    } catch (err) {
      setMessage(err.message);
    } finally {
      setSnoSyncing(false);
    }
  };

  const handleSyncRegistrationDate = async () => {
    setRegDateSyncing(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/wonbe/sync-registration-date`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "등록일 채우기 실패");
      setMessage(`등록일/진열상태/품절상태 채우기 완료: 카탈로그 ${data.fetched_goods}건 조회 · ${data.considered}건 중 ${data.matched}건 채움 (미매칭 ${data.unmatched}건)`);
      await fetchRows(query, offset);
    } catch (err) {
      setMessage(err.message);
    } finally {
      setRegDateSyncing(false);
    }
  };

  const stopCountryPolling = () => {
    if (countryPollRef.current) {
      clearInterval(countryPollRef.current);
      countryPollRef.current = null;
    }
  };

  useEffect(() => stopCountryPolling, []);

  const handleSyncCountry = async () => {
    if (!window.confirm("에이블리상품번호가 있는 모든 상품의 상세정보를 개별 조회해서 제조국을 채웁니다.\n상품 수에 따라 시간이 걸릴 수 있습니다. 진행하시겠습니까?")) return;
    setCountrySyncing(true);
    setMessage("");
    setCountryProgress({ total: 0, done: 0, matched: 0 });

    stopCountryPolling();
    countryPollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`${API}/wonbe/sync-country/progress`, { headers: getAuthHeaders() });
        const data = await res.json().catch(() => null);
        if (data) setCountryProgress({ total: data.total, done: data.done, matched: data.matched });
      } catch { /* noop */ }
    }, 700);

    try {
      const res = await fetch(`${API}/wonbe/sync-country`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "제조국 채우기 실패");
      setMessage(`제조국 채우기 완료: 상품코드 ${data.considered}건 (고유 상품번호 ${data.unique_snos}건 조회) 중 ${data.matched}건 채움 (미매칭 ${data.unmatched}건)`);
      await fetchRows(query, offset);
    } catch (err) {
      setMessage(err.message);
    } finally {
      stopCountryPolling();
      setCountrySyncing(false);
      setCountryProgress(null);
    }
  };

  const handleExport = () => {
    const url = `${API}/wonbe/export`;
    fetch(url, { headers: getAuthHeaders() })
      .then((res) => res.blob())
      .then((blob) => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "원가베이스유.xls";
        document.body.appendChild(a);
        a.click();
        a.remove();
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
          <div className={styles.subtitle}>상품코드 · 상품명합 · 거래처합 · 거래처 검색 / 헤더 ✎ 버튼으로 일괄수정</div>
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
            placeholder="상품코드 / 상품명합 / 거래처합 / 거래처"
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
          <input type="date" className={styles.syncDateInput} value={syncStartDate} onChange={(e) => setSyncStartDate(e.target.value)} disabled={syncing} />
          <span className={styles.syncDateSep}>~</span>
          <input type="date" className={styles.syncDateInput} value={syncEndDate} onChange={(e) => setSyncEndDate(e.target.value)} disabled={syncing} />
          <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={handleSyncEzadmin} disabled={loading || syncing}>
            <RefreshCcw size={13} />{syncing ? "동기화 중..." : "이지어드민 동기화"}
          </button>
        </div>
        <label className={styles.fileLabel}>
          <input type="file" accept=".xlsx,.xls,.xlsm" onChange={handleImportFile} disabled={loading} />
          <Upload size={13} />xlsx 임포트
        </label>
        <button className={`${styles.btn} ${styles.btnSecondary}`} onClick={handleExport} disabled={loading}>
          <Download size={13} />xls 내보내기
        </button>
        <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={handleSyncAblySno} disabled={loading || snoSyncing}>
          <RefreshCcw size={13} />{snoSyncing ? "동기화 중..." : "에이블리상품번호 채우기"}
        </button>
        <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={handleSyncRegistrationDate} disabled={loading || regDateSyncing}>
          <RefreshCcw size={13} />{regDateSyncing ? "채우는 중..." : "등록일 채우기"}
        </button>
        <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={handleSyncCountry} disabled={loading || countrySyncing}>
          <RefreshCcw size={13} />{countrySyncing ? "채우는 중..." : "제조국 채우기"}
        </button>
        {countrySyncing && countryProgress && (
          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <div style={{ width: "100px", height: "6px", background: "#e5e7eb", borderRadius: "999px", overflow: "hidden" }}>
              <div
                style={{
                  width: countryProgress.total ? `${Math.min(100, (countryProgress.done / countryProgress.total) * 100)}%` : "0%",
                  height: "100%", background: "#7c3aed", transition: "width 0.3s ease",
                }}
              />
            </div>
            <span style={{ fontSize: "0.72rem", color: "#6b7280", whiteSpace: "nowrap" }}>
              {countryProgress.done}/{countryProgress.total || "?"} · 매칭 {countryProgress.matched}
            </span>
          </div>
        )}
        <div ref={colPanelRef} style={{ position: "relative" }}>
          <button className={`${styles.btn} ${styles.btnSecondary}`} onClick={() => setColPanelOpen((v) => !v)}>
            <SlidersHorizontal size={13} />열 선택 ({displayCols.length}/{ALL_COLS.length})
          </button>
          {colPanelOpen && (
            <div
              style={{
                position: "absolute", top: "calc(100% + 4px)", right: 0, zIndex: 20,
                background: "#fff", border: "1px solid #d1d5db", borderRadius: "6px",
                padding: "8px", boxShadow: "0 4px 12px rgba(0,0,0,0.12)",
                display: "flex", flexDirection: "column", gap: "2px", minWidth: "170px", maxHeight: "320px", overflowY: "auto",
              }}
            >
              {ALL_COLS.map((col) => (
                <label
                  key={col}
                  style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "0.78rem", cursor: "pointer", padding: "2px 4px", borderRadius: "3px" }}
                >
                  <input type="checkbox" checked={visibleCols.has(col)} onChange={() => toggleCol(col)} />
                  {col}
                </label>
              ))}
            </div>
          )}
        </div>
      </div>

      {message && <div className={styles.message}>{message}</div>}
      {rawUnexpected && (
        <pre className={styles.rawBlock}>{JSON.stringify(rawUnexpected, null, 2)}</pre>
      )}

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              {displayCols.map((col) => {
                const isEditable = EDITABLE_COLS.includes(col);
                const isBulkActive = bulkEditCol === col;
                return (
                  <th key={col} className={styles.sortableHeader} style={{ verticalAlign: "top" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.25rem", whiteSpace: "nowrap" }} onClick={() => handleSort(col)}>
                      {col}{isEditable ? " ✎" : ""}
                      {sortCol === col && <span className={styles.sortIcon}>{sortDir === "asc" ? "▲" : "▼"}</span>}
                      {isEditable && (
                        <button
                          onClick={(e) => { e.stopPropagation(); isBulkActive ? closeBulkEdit() : openBulkEdit(col); }}
                          title={`${col} 일괄수정`}
                          style={{ background: isBulkActive ? "#7c3aed" : "none", color: isBulkActive ? "#fff" : "#7c3aed", border: `1px solid #7c3aed`, borderRadius: "3px", padding: "1px 4px", cursor: "pointer", lineHeight: 1, flexShrink: 0 }}
                        >
                          <PencilLine size={10} />
                        </button>
                      )}
                    </div>
                    {isBulkActive && (
                      <div style={{ display: "flex", gap: "2px", marginTop: "4px" }} onClick={(e) => e.stopPropagation()}>
                        <input
                          ref={bulkEditRef}
                          value={bulkEditValue}
                          onChange={(e) => setBulkEditValue(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter") handleBulkEdit(); if (e.key === "Escape") closeBulkEdit(); }}
                          placeholder="새 값"
                          style={{ width: "80px", fontSize: "0.72rem", padding: "2px 4px", border: "1px solid #d1d5db", borderRadius: "3px" }}
                          disabled={bulkEditLoading}
                        />
                        <button
                          onClick={handleBulkEdit}
                          disabled={bulkEditLoading}
                          style={{ background: "#7c3aed", color: "#fff", border: "none", borderRadius: "3px", padding: "2px 5px", cursor: "pointer", lineHeight: 1 }}
                          title="적용"
                        >
                          <Check size={10} />
                        </button>
                        <button
                          onClick={closeBulkEdit}
                          disabled={bulkEditLoading}
                          style={{ background: "none", color: "#6b7280", border: "1px solid #d1d5db", borderRadius: "3px", padding: "2px 5px", cursor: "pointer", lineHeight: 1 }}
                          title="취소"
                        >
                          <X size={10} />
                        </button>
                      </div>
                    )}
                    {isBulkActive && query && (
                      <div style={{ fontSize: "0.65rem", color: "#7c3aed", marginTop: "2px", whiteSpace: "nowrap" }}>
                        검색결과 {total.toLocaleString()}건만 수정
                      </div>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((row) => {
              const code = row["상품코드"];
              return (
                <tr key={code}>
                  {displayCols.map((col) => {
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
          <button className={`${styles.btn} ${styles.btnSecondary}`} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} disabled={offset === 0 || loading}>이전</button>
          <span>{currentPage} / {totalPages}</span>
          <button className={`${styles.btn} ${styles.btnSecondary}`} onClick={() => setOffset(offset + PAGE_SIZE)} disabled={currentPage >= totalPages || loading}>다음</button>
        </div>
      )}
    </>
  );
}
