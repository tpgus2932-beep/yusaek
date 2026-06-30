import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw, Trash2, GitCompare, SlidersHorizontal } from "lucide-react";
import styles from "./DBManager.module.css";
import topStyles from "./JanggiTop.module.css";
import { LOCAL_API_BASE as API, getAuthHeaders } from "../../lib/api";

const PAGE_SIZE = 50;
const COLS = ["거래처", "거래처상품명", "가격", "옵션", "사이즈", "개수", "날짜", "미송체크", "상품코드", "메모", "거래처합산"];

/* ── 목록 탭 ─────────────────────────────────────────────────── */
function JanggiListView() {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [query, setQuery] = useState("");
  const [inputQuery, setInputQuery] = useState("");
  const [dateFilter, setDateFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [editing, setEditing] = useState(null);
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

  const fetchRows = useCallback(async (q, date, off) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ q, date, offset: off, limit: PAGE_SIZE });
      const res = await fetch(`${API}/wonbe/janggi/search?${params}`, { headers: getAuthHeaders() });
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

  useEffect(() => { fetchRows(query, dateFilter, offset); }, [fetchRows, query, dateFilter, offset]);

  const handleSearch = (e) => {
    e.preventDefault();
    setOffset(0);
    setQuery(inputQuery.trim());
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
      const res = await fetch(`${API}/wonbe/janggi/row`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ id, column: col, value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "수정 실패");
      setRows((prev) => prev.map((r) => r.id === id ? { ...r, ...data.row } : r));
    } catch (err) {
      setMessage(err.message);
      fetchRows(query, dateFilter, offset);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter") commitEdit();
    if (e.key === "Escape") setEditing(null);
  };

  const handleDeleteByDate = async () => {
    const dateStr = dateFilter || window.prompt("삭제할 날짜를 입력하세요 (예: 2025-06-26)");
    if (!dateStr) return;
    if (!window.confirm(`"${dateStr}" 날짜의 데이터를 모두 삭제합니다.`)) return;
    setLoading(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/wonbe/janggi/by-date`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ 날짜: dateStr }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "삭제 실패");
      setMessage(`삭제 완료: ${data.deleted}건`);
      setOffset(0);
      await fetchRows(query, dateFilter, 0);
    } catch (err) {
      setMessage(err.message);
    } finally {
      setLoading(false);
    }
  };

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  return (
    <>
      <div className={styles.controls}>
        <form onSubmit={handleSearch} style={{ display: "flex", gap: "0.5rem" }}>
          <input
            className={styles.searchInput}
            value={inputQuery}
            onChange={(e) => setInputQuery(e.target.value)}
            placeholder="거래처 / 거래처상품명 / 상품코드"
          />
          <button className={`${styles.btn} ${styles.btnPrimary}`} type="submit" disabled={loading}>검색</button>
        </form>
        <input
          type="date"
          className={styles.syncDateInput}
          value={dateFilter}
          onChange={(e) => { setDateFilter(e.target.value); setOffset(0); }}
          disabled={loading}
        />
        {(query || dateFilter) && (
          <button className={`${styles.btn} ${styles.btnSecondary}`} onClick={() => { setInputQuery(""); setQuery(""); setDateFilter(""); setOffset(0); }} disabled={loading}>
            필터 초기화
          </button>
        )}
        <button className={`${styles.btn} ${styles.btnSecondary}`} onClick={() => fetchRows(query, dateFilter, offset)} disabled={loading}>
          <RefreshCw size={13} />새로고침
        </button>
        <button className={`${styles.btn} ${styles.btnDanger}`} onClick={handleDeleteByDate} disabled={loading}>
          <Trash2 size={13} />날짜별 삭제
        </button>
        <span className={styles.pill}>{total.toLocaleString()}행</span>
      </div>

      {message && <div className={styles.message}>{message}</div>}

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>{COLS.map((col) => (
              <th key={col} className={styles.sortableHeader} onClick={() => handleSort(col)}>
                {col} ✎{sortCol === col ? <span className={styles.sortIcon}>{sortDir === "asc" ? "▲" : "▼"}</span> : ""}
              </th>
            ))}</tr>
          </thead>
          <tbody>
            {sortedRows.map((row) => (
              <tr key={row.id}>
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
                    <td key={col} className={styles.editableCell} onClick={() => startEdit(row.id, col, row[col] ?? "")} title="클릭하여 수정">
                      {row[col] ?? ""}
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
          <button className={`${styles.btn} ${styles.btnSecondary}`} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} disabled={offset === 0 || loading}>이전</button>
          <span>{currentPage} / {totalPages}</span>
          <button className={`${styles.btn} ${styles.btnSecondary}`} onClick={() => setOffset(offset + PAGE_SIZE)} disabled={currentPage >= totalPages || loading}>다음</button>
        </div>
      )}
    </>
  );
}

/* ── TOP비교 탭 ──────────────────────────────────────────────── */
function JanggiTopComparison() {
  const [dbDate, setDbDate] = useState(() => {
    try { return JSON.parse(localStorage.getItem("janggi_top_cache") || "{}").dbDate || null; } catch { return null; }
  });
  const [dbRows, setDbRows] = useState(() => {
    try { return JSON.parse(localStorage.getItem("janggi_top_cache") || "{}").dbRows || []; } catch { return []; }
  });
  const [topDate, setTopDate] = useState(() => {
    try { return JSON.parse(localStorage.getItem("janggi_top_cache") || "{}").topDate || null; } catch { return null; }
  });
  const [topShops, setTopShops] = useState(() => {
    try { return JSON.parse(localStorage.getItem("janggi_top_cache") || "{}").topShops || []; } catch { return []; }
  });
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [loaded, setLoaded] = useState(() => {
    try { return !!JSON.parse(localStorage.getItem("janggi_top_cache") || "{}").loaded; } catch { return false; }
  });
  const [dismissed, setDismissed] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem("janggi_top_dismissed") || "[]")); } catch { return new Set(); }
  });
  const [aliasMap, setAliasMap] = useState(() => {
    try { return JSON.parse(localStorage.getItem("janggi_top_aliases") || "{}"); } catch { return {}; }
  });
  const [showAliasPanel, setShowAliasPanel] = useState(false);
  const [aliasLeft, setAliasLeft] = useState("");
  const [aliasRight, setAliasRight] = useState("");

  const saveAliases = (map) => {
    setAliasMap(map);
    localStorage.setItem("janggi_top_aliases", JSON.stringify(map));
  };

  const addAlias = () => {
    const k = aliasLeft.trim();
    const v = aliasRight.trim();
    if (!k || !v) return;
    saveAliases({ ...aliasMap, [k]: v });
    setAliasLeft("");
    setAliasRight("");
  };

  const removeAlias = (key) => {
    const next = { ...aliasMap };
    delete next[key];
    saveAliases(next);
  };

  const load = async () => {
    setLoading(true);
    setMessage("조회 중...");
    setLoaded(false);
    setDismissed(new Set());
    localStorage.removeItem("janggi_top_dismissed");
    try {
      const [dbRes, topRes] = await Promise.all([
        fetch(`${API}/wonbe/janggi/recent-summary`, { headers: getAuthHeaders() }),
        fetch(`${API}/wonbe/janggi/top-shops`, { headers: getAuthHeaders() }),
      ]);
      const dbData = await dbRes.json().catch(() => ({}));
      const topData = await topRes.json().catch(() => ({}));
      if (!dbRes.ok || !dbData.ok) throw new Error(dbData?.detail || "DB 조회 실패");
      if (!topRes.ok || !topData.ok) throw new Error(topData?.detail || "TOP90 조회 실패");
      const newDbDate = dbData.date;
      const newDbRows = dbData.rows || [];
      const newTopDate = topData.date;
      const newTopShops = topData.shops || [];
      setDbDate(newDbDate);
      setDbRows(newDbRows);
      setTopDate(newTopDate);
      setTopShops(newTopShops);
      setLoaded(true);
      setMessage("");
      localStorage.setItem("janggi_top_cache", JSON.stringify({
        dbDate: newDbDate,
        dbRows: newDbRows,
        topDate: newTopDate,
        topShops: newTopShops,
        loaded: true,
      }));
    } catch (err) {
      setMessage(err.message || "조회 실패");
    } finally {
      setLoading(false);
    }
  };

  const dbSet = new Set(dbRows.map((r) => r.거래처));
  const topSet = new Set(topShops);

  // 별칭 포함 양방향 매칭
  const dbMatchesTop = (dbName) =>
    topSet.has(dbName) ||
    (aliasMap[dbName] && topSet.has(aliasMap[dbName])) ||
    Object.entries(aliasMap).some(([k, v]) => v === dbName && topSet.has(k));

  const topMatchesDb = (shopName) =>
    dbSet.has(shopName) ||
    (aliasMap[shopName] && dbSet.has(aliasMap[shopName])) ||
    Object.entries(aliasMap).some(([k, v]) => v === shopName && dbSet.has(k));

  const dismiss = (panel, name) => setDismissed((prev) => {
    const next = new Set([...prev, `${panel}:${name}`]);
    localStorage.setItem("janggi_top_dismissed", JSON.stringify([...next]));
    return next;
  });

  const visibleDbRows = dbRows
    .filter((r) => !dismissed.has(`db:${r.거래처}`))
    .sort((a, b) => (a.거래처 || "").localeCompare(b.거래처 || "", "ko"));
  const visibleTopShops = topShops
    .filter((s) => !dismissed.has(`top:${s}`))
    .sort((a, b) => (a || "").localeCompare(b || "", "ko"));

  const matchCount = visibleDbRows.filter((r) => dbMatchesTop(r.거래처)).length;
  const dbOnlyCount = visibleDbRows.filter((r) => !dbMatchesTop(r.거래처)).length;
  const topOnlyCount = visibleTopShops.filter((s) => !topMatchesDb(s)).length;

  return (
    <div className={topStyles.root}>
      <div className={topStyles.toolbar}>
        <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={load} disabled={loading}>
          <GitCompare size={13} />{loading ? "조회 중..." : "조회"}
        </button>
        <button
          className={`${styles.btn} ${showAliasPanel ? styles.btnPrimary : styles.btnSecondary}`}
          onClick={() => setShowAliasPanel((v) => !v)}
        >
          <SlidersHorizontal size={13} />
          거래처 별칭{Object.keys(aliasMap).length > 0 ? ` (${Object.keys(aliasMap).length})` : ""}
        </button>
        {loaded && (
          <div className={topStyles.summary}>
            <span className={topStyles.badgeGreen}>일치 {matchCount}건</span>
            {dbOnlyCount > 0 && <span className={topStyles.badgeOrange}>DB만 {dbOnlyCount}건</span>}
            {topOnlyCount > 0 && <span className={topStyles.badgeBlue}>TOP만 {topOnlyCount}건</span>}
          </div>
        )}
      </div>

      {showAliasPanel && (
        <div className={topStyles.aliasPanel}>
          <div className={topStyles.aliasPanelHeader}>거래처 별칭 매핑 (양방향 자동 일치)</div>
          <div className={topStyles.aliasAddRow}>
            <input
              className={topStyles.aliasInput}
              placeholder="TOP 이름 (예: KDG)"
              value={aliasLeft}
              onChange={(e) => setAliasLeft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addAlias()}
            />
            <span className={topStyles.aliasSep}>↔</span>
            <input
              className={topStyles.aliasInput}
              placeholder="DB 이름 (예: 케이디지)"
              value={aliasRight}
              onChange={(e) => setAliasRight(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addAlias()}
            />
            <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={addAlias}>추가</button>
          </div>
          <div className={topStyles.aliasList}>
            {Object.entries(aliasMap).map(([k, v]) => (
              <div key={k} className={topStyles.aliasItem}>
                <span className={topStyles.aliasName}>{k}</span>
                <span className={topStyles.aliasSep}>↔</span>
                <span className={topStyles.aliasName}>{v}</span>
                <button className={`${styles.btn} ${styles.btnDanger}`} style={{ padding: "0.15rem 0.5rem", fontSize: "0.75rem" }} onClick={() => removeAlias(k)}>삭제</button>
              </div>
            ))}
            {!Object.keys(aliasMap).length && <div className={topStyles.aliasEmpty}>등록된 별칭 없음</div>}
          </div>
        </div>
      )}

      {message && <div className={styles.message}>{message}</div>}

      {loaded && (
        <div className={topStyles.panels}>
          {/* DB 패널 */}
          <div className={topStyles.panel}>
            <div className={topStyles.panelHeader}>
              DB 날짜별장끼정리
              <span className={topStyles.panelDate}>{dbDate}</span>
            </div>
            <table className={topStyles.table}>
              <thead>
                <tr>
                  <th>거래처</th>
                  <th>합산</th>
                  <th>상태</th>
                </tr>
              </thead>
              <tbody>
                {visibleDbRows.map((r) => {
                  const matched = dbMatchesTop(r.거래처);
                  return (
                    <tr key={r.거래처} className={matched ? topStyles.rowMatch : topStyles.rowDbOnly}>
                      <td>{r.거래처}</td>
                      <td style={{ textAlign: "right" }}>{r.합산 != null ? Math.round(r.합산).toLocaleString() : ""}</td>
                      <td>
                        {matched ? "✓ 일치" : (
                          <span style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                            ⚠ DB만
                            <button className={topStyles.confirmBtn} onClick={() => dismiss("db", r.거래처)}>확인</button>
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {!visibleDbRows.length && !dbRows.length && <tr><td colSpan={3} style={{ textAlign: "center", color: "var(--text-muted)", padding: "1rem" }}>데이터 없음</td></tr>}
              </tbody>
            </table>
          </div>

          {/* TOP 패널 */}
          <div className={topStyles.panel}>
            <div className={topStyles.panelHeader}>
              TOP90 완료 매장
              <span className={topStyles.panelDate}>{topDate}</span>
            </div>
            <table className={topStyles.table}>
              <thead>
                <tr>
                  <th>매장명</th>
                  <th>상태</th>
                </tr>
              </thead>
              <tbody>
                {visibleTopShops.map((s) => {
                  const matched = topMatchesDb(s);
                  return (
                    <tr key={s} className={matched ? topStyles.rowMatch : topStyles.rowTopOnly}>
                      <td>{s}</td>
                      <td>
                        {matched ? "✓ 일치" : (
                          <span style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                            ◆ TOP만
                            <button className={topStyles.confirmBtn} onClick={() => dismiss("top", s)}>확인</button>
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {!visibleTopShops.length && !topShops.length && <tr><td colSpan={2} style={{ textAlign: "center", color: "var(--text-muted)", padding: "1rem" }}>데이터 없음</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── 메인 컴포넌트 ────────────────────────────────────────────── */
export default function JanggiTable() {
  const [tab, setTab] = useState("list");

  return (
    <>
      <div className={styles.header}>
        <div>
          <div className={styles.title}>날짜별장끼정리</div>
          <div className={styles.subtitle}>
            {tab === "list" ? "셀 클릭하여 수정 · Enter 저장 · Esc 취소" : "DB 최근날짜 거래처 vs TOP90 오늘 완료 매장 비교"}
          </div>
        </div>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <button
            className={`${styles.btn} ${tab === "list" ? styles.btnPrimary : styles.btnSecondary}`}
            onClick={() => setTab("list")}
          >
            목록
          </button>
          <button
            className={`${styles.btn} ${tab === "top" ? styles.btnPrimary : styles.btnSecondary}`}
            onClick={() => setTab("top")}
          >
            <GitCompare size={13} />TOP비교
          </button>
        </div>
      </div>

      {tab === "list" && <JanggiListView />}
      {tab === "top" && <JanggiTopComparison />}
    </>
  );
}
