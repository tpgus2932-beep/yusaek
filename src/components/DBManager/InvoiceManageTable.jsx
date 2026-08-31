import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileText, Filter, RefreshCw, Search } from "lucide-react";
import styles from "./DBManager.module.css";
import { LOCAL_API_BASE as API, getAuthHeaders } from "../../lib/api";

const FLAG_COLS = [
  { key: "입금완료", label: "입금완료" },
  { key: "계산서발행완료", label: "계산서 발행완료" },
  { key: "이월발행", label: "이월발행" },
];

const FILTERABLE_COLS = [
  { key: "거래처명", label: "거래처명", getValue: (r) => String(r.거래처명 || "").trim() || "(빈값)" },
  { key: "부가세거래처", label: "부가세거래처", getValue: (r) => (Number(r.부가세거래처) === 1 ? "부가세 거래처" : "일반") },
  ...FLAG_COLS.map((f) => ({
    key: f.key,
    label: f.label,
    getValue: (r) => (Number(r[f.key]) === 1 ? "완료" : "미완료"),
  })),
];

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

// 헤더 클릭 시 뜨는 엑셀 스타일 체크리스트 필터. 여러 컬럼에 동시에 걸어도(이중필터)
// AND 조건으로 결합되도록, 옵션 목록은 "다른 컬럼에 이미 걸린 필터"를 통과한 행 기준으로 계산한다.
function ColumnFilterHeader({ col, center, filters, rowsForOptions, onApply, onClear }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState(null);

  const options = useMemo(() => {
    const counts = new Map();
    for (const row of rowsForOptions) {
      const v = col.getValue(row);
      counts.set(v, (counts.get(v) || 0) + 1);
    }
    return Array.from(counts.entries())
      .sort((a, b) => a[0].localeCompare(b[0], "ko"))
      .map(([value, count]) => ({ value, count }));
  }, [rowsForOptions, col]);

  const isActive = Boolean(filters[col.key]);

  const handleOpen = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setPos({ top: rect.bottom + 4, left: Math.min(rect.left, window.innerWidth - 246) });
    setDraft(new Set(filters[col.key] ? [...filters[col.key]] : options.map((o) => o.value)));
    setSearch("");
    setOpen(true);
  };

  const close = () => setOpen(false);

  const visibleOptions = search.trim()
    ? options.filter((o) => o.value.toLowerCase().includes(search.trim().toLowerCase()))
    : options;

  const toggleValue = (v) => {
    setDraft((prev) => {
      const next = new Set(prev);
      if (next.has(v)) next.delete(v);
      else next.add(v);
      return next;
    });
  };

  const selectAll = () => setDraft(new Set(options.map((o) => o.value)));
  const clearAll = () => setDraft(new Set());

  const apply = () => {
    if (draft.size === options.length) onClear(col.key);
    else onApply(col.key, draft);
    setOpen(false);
  };

  return (
    <div className={`${styles.thFilterWrap} ${center ? styles.thFilterCenter : ""}`}>
      <span>{col.label}</span>
      <button
        type="button"
        className={`${styles.filterBtn} ${isActive ? styles.filterBtnActive : ""}`}
        onClick={handleOpen}
        title={`${col.label} 필터`}
      >
        <Filter size={12} />
      </button>
      {open && (
        <>
          <div className={styles.filterOverlay} onClick={close} />
          <div className={styles.filterPopover} style={{ top: pos.top, left: pos.left }}>
            <input
              className={styles.filterSearchInput}
              placeholder="검색"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              autoFocus
            />
            <div className={styles.filterQuickActions}>
              <button type="button" onClick={selectAll}>전체 선택</button>
              <button type="button" onClick={clearAll}>전체 해제</button>
            </div>
            <div className={styles.filterList}>
              {visibleOptions.length ? (
                visibleOptions.map((o) => (
                  <label key={o.value} className={styles.filterOption}>
                    <input
                      type="checkbox"
                      checked={draft.has(o.value)}
                      onChange={() => toggleValue(o.value)}
                    />
                    <span className={styles.filterOptionLabel}>{o.value}</span>
                    <span className={styles.filterOptionCount}>{o.count}</span>
                  </label>
                ))
              ) : (
                <div className={styles.filterEmpty}>일치하는 값이 없습니다.</div>
              )}
            </div>
            <div className={styles.filterActions}>
              <button type="button" onClick={close}>취소</button>
              <button type="button" className={styles.filterActionPrimary} onClick={apply}>확인</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default function InvoiceManageTable() {
  const [months, setMonths] = useState([]);
  const [month, setMonth] = useState(currentMonth());
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [filters, setFilters] = useState({}); // { [colKey]: Set<string> }
  const [search, setSearch] = useState("");
  const [searchedQuery, setSearchedQuery] = useState("");
  const [matchIndex, setMatchIndex] = useState(0);
  const [presetCol, setPresetCol] = useState(FLAG_COLS[0].key);
  const [selectedRowId, setSelectedRowId] = useState(null);
  const searchInputRef = useRef(null);

  const fetchMonths = useCallback(async () => {
    try {
      const res = await fetch(`${API}/wonbe/invoice-manage/months`, { headers: getAuthHeaders() });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        setMonths(data.months || []);
        if (data.months?.length) {
          setMonth((prev) => (data.months.includes(prev) ? prev : data.months[0]));
        }
      }
    } catch { /* ignore */ }
  }, []);

  const fetchRows = useCallback(async (m) => {
    if (!m) return;
    setLoading(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/wonbe/invoice-manage/rows?month=${encodeURIComponent(m)}`, {
        headers: getAuthHeaders(),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "조회 실패");
      setRows(data.rows || []);
    } catch (err) {
      setMessage(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchMonths();
  }, [fetchMonths]);

  useEffect(() => {
    setFilters({});
    setSearch("");
    setSearchedQuery("");
    setMatchIndex(0);
    fetchRows(month);
  }, [month, fetchRows]);

  const handleMonthChange = (e) => setMonth(e.target.value);

  const handleLoadInvoice = async () => {
    if (!month) return;
    setLoading(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/wonbe/invoice-manage/load`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ month }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "불러오기 실패");
      setRows(data.rows || []);
      setMessage(`${month} 이체파일에서 거래처 ${data.loaded}건을 불러왔습니다.`);
      fetchMonths();
    } catch (err) {
      setMessage(err.message);
    } finally {
      setLoading(false);
    }
  };

  const toggleFlag = async (row, col) => {
    const nextValue = !row[col];
    setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, [col]: nextValue ? 1 : 0 } : r)));
    try {
      const res = await fetch(`${API}/wonbe/invoice-manage/row`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ id: row.id, col, value: nextValue }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "수정 실패");
      setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, ...data.row } : r)));
    } catch (err) {
      setMessage(err.message);
      fetchRows(month);
    }
  };

  // 컬럼별 옵션 목록은 "다른 컬럼에 걸린 필터"만 통과한 행 기준으로 계산해 이중(다중) 필터를 지원한다.
  const rowsForColumn = useCallback(
    (excludeKey) =>
      rows.filter((row) =>
        FILTERABLE_COLS.every((c) => {
          if (c.key === excludeKey) return true;
          const set = filters[c.key];
          if (!set) return true;
          return set.has(c.getValue(row));
        })
      ),
    [rows, filters]
  );

  const filteredRows = useMemo(
    () =>
      rows.filter((row) =>
        FILTERABLE_COLS.every((c) => {
          const set = filters[c.key];
          if (!set) return true;
          return set.has(c.getValue(row));
        })
      ),
    [rows, filters]
  );

  const applyFilter = (key, valueSet) => setFilters((prev) => ({ ...prev, [key]: valueSet }));
  const clearFilter = (key) => setFilters((prev) => { const next = { ...prev }; delete next[key]; return next; });
  const clearAllFilters = () => setFilters({});
  const activeFilterCount = Object.keys(filters).length;

  const totalAmount = filteredRows.reduce((sum, r) => sum + (Number(r.입금액) || 0), 0);
  const doneCount = (col) => filteredRows.filter((r) => Number(r[col]) === 1).length;

  // ── 거래처명 검색 (Ctrl+F 포커스 이동, Enter로 다음 결과로 스크롤, Space로 사전 설정한 열 체크) ──
  const matches = useMemo(() => {
    const q = searchedQuery.trim().toLowerCase();
    if (!q) return [];
    return filteredRows.filter((r) => String(r.거래처명 || "").toLowerCase().includes(q));
  }, [filteredRows, searchedQuery]);

  const currentMatch = matches.length ? matches[Math.min(matchIndex, matches.length - 1)] : null;

  useEffect(() => {
    if (!currentMatch) return;
    const el = document.getElementById(`invoice-row-${currentMatch.id}`);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [currentMatch]);

  useEffect(() => {
    const handleGlobalKeyDown = (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, []);

  // ── 행 선택 후 Ctrl+C: 부가세 안내 문구를 클립보드에 복사 ──
  useEffect(() => {
    const handleCopy = (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "c") return;
      if (!selectedRowId) return;
      if (window.getSelection && window.getSelection().toString()) return; // 일반 텍스트 선택 복사는 그대로 둔다
      const row = rows.find((r) => r.id === selectedRowId);
      if (!row) return;
      e.preventDefault();
      const monthNum = parseInt(String(month).split("-")[1], 10);
      const monthLabel = Number.isFinite(monthNum) ? `${monthNum}월` : month;
      const amount = (Number(row.입금액) || 0).toLocaleString();
      const text = `안녕하세요 사장님! 부가세 보내드리려 하는데 ${monthLabel} 입금액 ${amount}원 맞을까요?`;
      navigator.clipboard?.writeText(text).catch(() => {});
    };
    window.addEventListener("keydown", handleCopy);
    return () => window.removeEventListener("keydown", handleCopy);
  }, [selectedRowId, rows, month]);

  const handleSearchKeyDown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const q = search.trim();
      if (!q) return;
      if (q !== searchedQuery) {
        setSearchedQuery(q);
        setMatchIndex(0);
      } else if (matches.length) {
        setMatchIndex((prev) => (prev + 1) % matches.length);
      }
    } else if (e.key === " " || e.code === "Space") {
      // 검색을 마친(엔터를 누른) 직후 값 변경 없이 스페이스바를 누르면, 검색으로 찾은 행의 사전 설정한 열을 체크한다.
      // 입력 중(검색어와 다른 값)에는 그대로 공백 입력을 허용한다.
      if (search === searchedQuery && currentMatch) {
        e.preventDefault();
        toggleFlag(currentMatch, presetCol);
      }
    }
  };

  return (
    <>
      <div className={styles.header}>
        <div>
          <div className={styles.title}>계산서 관리</div>
          <div className={styles.subtitle}>
            이체파일에서 월별 거래처를 유니크하게 뽑아 입금금액을 합산 · 부가세 거래처 여부는 노예김승일 부가세 거래처 목록 기준 · 헤더의 깔때기 아이콘으로 엑셀처럼 필터링
          </div>
        </div>
        <span className={styles.pill}>{filteredRows.length}/{rows.length}개 거래처</span>
      </div>

      <div className={styles.controls}>
        {months.length > 0 ? (
          <select className={styles.dateInput} value={month} onChange={handleMonthChange} style={{ minWidth: "9rem" }}>
            {!months.includes(month) && month && <option value={month}>{month}</option>}
            {months.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        ) : (
          <input
            type="month"
            className={styles.dateInput}
            value={month}
            onChange={handleMonthChange}
          />
        )}
        <button
          className={`${styles.btn} ${styles.btnPrimary}`}
          onClick={handleLoadInvoice}
          disabled={!month || loading}
          title="이체파일에서 해당 월 거래처를 다시 불러와 입금액을 갱신합니다 (체크 상태는 유지됩니다)"
        >
          <FileText size={13} />계산서 불러오기
        </button>
        <button
          className={`${styles.btn} ${styles.btnSecondary}`}
          onClick={() => fetchRows(month)}
          disabled={!month || loading}
        >
          <RefreshCw size={13} />새로고침
        </button>
        {activeFilterCount > 0 && (
          <button className={`${styles.btn} ${styles.btnSecondary}`} onClick={clearAllFilters}>
            필터 초기화 ({activeFilterCount})
          </button>
        )}
        {rows.length > 0 && (
          <span style={{ marginLeft: "auto", fontSize: "0.78rem", color: "var(--text-muted)" }}>
            합계: {totalAmount.toLocaleString()}원 · 입금완료 {doneCount("입금완료")}/{filteredRows.length}
            · 계산서 발행완료 {doneCount("계산서발행완료")}/{filteredRows.length}
            · 이월발행 {doneCount("이월발행")}/{filteredRows.length}
          </span>
        )}
      </div>

      <div className={styles.controls}>
        <div className={styles.searchBox}>
          <Search size={13} aria-hidden="true" />
          <input
            ref={searchInputRef}
            className={styles.searchInput}
            placeholder="거래처명 검색 (Ctrl+F, Enter로 다음 결과)"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            aria-label="계산서 관리 거래처명 검색"
          />
        </div>
        {searchedQuery && (
          <span style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>
            {matches.length ? `${matchIndex + 1} / ${matches.length}건` : "검색 결과 없음"}
          </span>
        )}
        <span style={{ fontSize: "0.78rem", color: "var(--text-muted)", marginLeft: "0.5rem" }}>
          스페이스바로 체크할 열
        </span>
        <select
          className={styles.dateInput}
          value={presetCol}
          onChange={(e) => setPresetCol(e.target.value)}
        >
          {FLAG_COLS.map((f) => (
            <option key={f.key} value={f.key}>{f.label}</option>
          ))}
        </select>
      </div>

      {message && <div className={styles.message}>{message}</div>}

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>
                <ColumnFilterHeader
                  col={FILTERABLE_COLS[0]}
                  filters={filters}
                  rowsForOptions={rowsForColumn("거래처명")}
                  onApply={applyFilter}
                  onClear={clearFilter}
                />
              </th>
              <th>입금액</th>
              <th>
                <ColumnFilterHeader
                  col={FILTERABLE_COLS[1]}
                  filters={filters}
                  rowsForOptions={rowsForColumn("부가세거래처")}
                  onApply={applyFilter}
                  onClear={clearFilter}
                />
              </th>
              {FLAG_COLS.map((f) => (
                <th key={f.key} style={{ textAlign: "center" }}>
                  <ColumnFilterHeader
                    col={FILTERABLE_COLS.find((c) => c.key === f.key)}
                    center
                    filters={filters}
                    rowsForOptions={rowsForColumn(f.key)}
                    onApply={applyFilter}
                    onClear={clearFilter}
                  />
                </th>
              ))}
              <th>수정일시</th>
            </tr>
          </thead>
          <tbody>
            {filteredRows.map((row) => (
              <tr
                key={row.id}
                id={`invoice-row-${row.id}`}
                onClick={() => setSelectedRowId(row.id)}
                style={{ cursor: "pointer" }}
                className={
                  currentMatch?.id === row.id
                    ? styles.rowHighlight
                    : selectedRowId === row.id
                      ? styles.rowSelected
                      : undefined
                }
              >
                <td>{row.거래처명}</td>
                <td>{(Number(row.입금액) || 0).toLocaleString()}원</td>
                <td>
                  {Number(row.부가세거래처) === 1 ? (
                    <span className={`${styles.badge} ${styles.badgeVat}`}>부가세 거래처</span>
                  ) : (
                    <span className={`${styles.badge} ${styles.badgeNormal}`}>일반</span>
                  )}
                </td>
                {FLAG_COLS.map((f) => (
                  <td key={f.key} className={styles.checkboxCell}>
                    <input
                      type="checkbox"
                      checked={Number(row[f.key]) === 1}
                      onChange={() => toggleFlag(row, f.key)}
                    />
                  </td>
                ))}
                <td style={{ color: "var(--text-muted)", fontSize: "0.76rem" }}>{row.수정일시 || ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!filteredRows.length && !loading && (
          <div className={styles.empty}>
            {!rows.length
              ? (month ? `${month} 계산서 데이터가 없습니다. "계산서 불러오기"를 눌러 이체파일에서 불러오세요.` : "월을 선택하세요.")
              : "필터 조건에 맞는 거래처가 없습니다."}
          </div>
        )}
      </div>
    </>
  );
}
