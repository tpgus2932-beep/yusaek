import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Copy, Download, FileText, Filter, Link2, RefreshCw, Search, Trash2, Unlink } from "lucide-react";
import styles from "./DBManager.module.css";
import { LOCAL_API_BASE as API, getAuthHeaders } from "../../lib/api";

const FLAG_COLS = [
  { key: "금액체크", label: "금액체크" },
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

// http://IP 접속처럼 보안 컨텍스트가 아니면 navigator.clipboard가 막히므로 textarea + execCommand로 대체한다.
async function copyText(text) {
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch { /* 아래 대체 방식 시도 */ }
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand("copy");
  ta.remove();
  if (!ok) throw new Error("copy failed");
}

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

const vendorName = (r) => String(r.거래처명 || "").trim();
const groupsStorageKey = (m) => `invoice-manage-groups-${m}`;

function loadGroups(m) {
  try {
    const parsed = JSON.parse(localStorage.getItem(groupsStorageKey(m)) || "[]");
    return Array.isArray(parsed) ? parsed.filter((g) => Array.isArray(g) && g.length >= 2) : [];
  } catch {
    return [];
  }
}

// 헤더 클릭 시 뜨는 엑셀 스타일 체크리스트 필터. 여러 컬럼에 동시에 걸어도(이중필터)
// AND 조건으로 결합되도록, 옵션 목록은 "다른 컬럼에 이미 걸린 필터"를 통과한 행 기준으로 계산한다.
function ColumnFilterHeader({ col, center, filters, rowsForOptions, onApply, onClear, bulk }) {
  const [open, setOpen] = useState(false);
  const [pendingBulk, setPendingBulk] = useState(null); // true=일괄 체크, false=일괄 해제 (확인 대기)
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState(null);

  const options = useMemo(() => {
    const counts = new Map();
    const aliases = new Map(); // 묶인 거래처명도 필터 검색에 걸리도록 대표 값에 붙여둔다
    for (const row of rowsForOptions) {
      const v = col.getValue(row);
      counts.set(v, (counts.get(v) || 0) + 1);
      if (col.key === "거래처명" && row._all) {
        aliases.set(v, row._all.map((x) => String(x.거래처명 || "")).join(" "));
      }
    }
    return Array.from(counts.entries())
      .sort((a, b) => a[0].localeCompare(b[0], "ko"))
      .map(([value, count]) => ({ value, count, alias: aliases.get(value) || "" }));
  }, [rowsForOptions, col]);

  const isActive = Boolean(filters[col.key]);

  const handleOpen = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setPos({ top: rect.bottom + 4, left: Math.min(rect.left, window.innerWidth - 246) });
    setDraft(new Set(filters[col.key] ? [...filters[col.key]] : options.map((o) => o.value)));
    setSearch("");
    setPendingBulk(null);
    setOpen(true);
  };

  const close = () => setOpen(false);

  const visibleOptions = search.trim()
    ? options.filter((o) => `${o.value} ${o.alias}`.toLowerCase().includes(search.trim().toLowerCase()))
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
            {bulk && (
              <div style={{ borderTop: "1px solid var(--border, #e5e7eb)", padding: "0.5rem 0.25rem 0.25rem", fontSize: "0.78rem" }}>
                <div style={{ fontWeight: 600, marginBottom: "0.35rem" }}>
                  조회된 {bulk.total}건 일괄 처리
                </div>
                {pendingBulk === null ? (
                  <div style={{ display: "flex", gap: "0.35rem" }}>
                    <button
                      type="button"
                      className={`${styles.btn} ${styles.btnSecondary}`}
                      disabled={!bulk.unchecked}
                      onClick={() => setPendingBulk(true)}
                    >
                      전체 체크 ({bulk.unchecked})
                    </button>
                    <button
                      type="button"
                      className={`${styles.btn} ${styles.btnSecondary}`}
                      disabled={!bulk.checked}
                      onClick={() => setPendingBulk(false)}
                    >
                      전체 해제 ({bulk.checked})
                    </button>
                  </div>
                ) : (
                  <div>
                    <div style={{ marginBottom: "0.35rem" }}>
                      {col.label} <b>{pendingBulk ? bulk.unchecked : bulk.checked}건</b>을 {pendingBulk ? "체크" : "해제"}합니다.
                    </div>
                    <div style={{ display: "flex", gap: "0.35rem" }}>
                      <button
                        type="button"
                        className={`${styles.btn} ${styles.btnPrimary}`}
                        onClick={() => { const v = pendingBulk; setPendingBulk(null); setOpen(false); bulk.onRun(v); }}
                      >
                        실행
                      </button>
                      <button type="button" className={`${styles.btn} ${styles.btnSecondary}`} onClick={() => setPendingBulk(null)}>
                        취소
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
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
  const [editingMemo, setEditingMemo] = useState(null); // { id, value }
  const [loadDiff, setLoadDiff] = useState(null); // { new: Set<거래처명>, updated: Set<거래처명> }
  const [accountMap, setAccountMap] = useState({}); // { 거래처명: { B: 은행코드, C: 계좌번호 } }
  const [groups, setGroups] = useState([]); // [[대표 거래처명, ...묶인 거래처명]] — 월별로 localStorage에 저장
  const [carryRows, setCarryRows] = useState([]); // 전월 이월발행 체크된 행
  const [historySortByAmount, setHistorySortByAmount] = useState(false); // true면 금액 내림차순
  const [history, setHistory] = useState(null); // { title, loading, error, rows: [{날짜, 거래처명, 금액, 건수}] }
  const [binding, setBinding] = useState(false);
  const [bindSearch, setBindSearch] = useState("");
  const [bindPicked, setBindPicked] = useState([]); // 먼저 추가한 거래처가 대표(계좌정보 기준)
  const searchInputRef = useRef(null);
  const memoInputRef = useRef(null);

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

  const fetchAccountMap = useCallback(async () => {
    try {
      const res = await fetch(`${API}/wonbe/account/rows`, { headers: getAuthHeaders() });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) return;
      const map = {};
      for (const r of data.rows || []) {
        const key = String(r.A || "").trim();
        if (key && !map[key]) map[key] = r;
      }
      setAccountMap(map);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    fetchMonths();
    fetchAccountMap();
  }, [fetchMonths, fetchAccountMap]);

  // 전월에 이월발행 체크된 거래처를 불러와 현재 월 표 아래 카드로 보여준다.
  const prevMonth = useMemo(() => {
    const [y, m] = String(month || "").split("-").map(Number);
    if (!y || !m) return "";
    const d = new Date(y, m - 2, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  }, [month]);

  useEffect(() => {
    let cancelled = false;
    setCarryRows([]);
    if (!prevMonth) return undefined;
    (async () => {
      try {
        const res = await fetch(`${API}/wonbe/invoice-manage/rows?month=${encodeURIComponent(prevMonth)}`, {
          headers: getAuthHeaders(),
        });
        const data = await res.json().catch(() => ({}));
        if (!cancelled && res.ok && data.ok) {
          setCarryRows((data.rows || []).filter((r) => Number(r.이월발행) === 1));
        }
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [prevMonth]);

  // 이월발행 거래처명 집합 - 현재 월 표에서 배지로 표시
  const carryNames = useMemo(() => {
    const m = new Map();
    for (const r of carryRows) {
      const k = String(r.거래처명 || "").trim();
      m.set(k, (m.get(k) || 0) + (Number(r.입금액) || 0));
    }
    return m;
  }, [carryRows]);

  // 이월발행 카드는 표 위/아래 두 곳에 같이 보여준다.
  const renderCarryCard = (position) => carryRows.length > 0 && (
    <div
      style={{
        [position === "top" ? "marginBottom" : "marginTop"]: "1rem",
        border: "1px solid #fcd34d",
        background: "#fffbeb",
        borderRadius: "10px",
        padding: "0.8rem 1rem",
      }}
    >
      <div style={{ fontWeight: 700, fontSize: "0.9rem", marginBottom: "0.5rem", color: "#92400e" }}>
        이월발행 ({prevMonth} → {month}) · {carryRows.length}개 거래처 ·{" "}
        {carryRows.reduce((s, r) => s + (Number(r.입금액) || 0), 0).toLocaleString()}원
      </div>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>거래처명</th>
            <th>입금액</th>
            <th>예금주</th>
            <th>메모</th>
          </tr>
        </thead>
        <tbody>
          {carryRows.map((r) => (
            <tr key={r.id}>
              <td>{r.거래처명}</td>
              <td>{(Number(r.입금액) || 0).toLocaleString()}원</td>
              <td>{accountMap[String(r.거래처명 || "").trim()]?.E || "-"}</td>
              <td>{r.메모 || ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  useEffect(() => {
    setFilters({});
    setSearch("");
    setSearchedQuery("");
    setMatchIndex(0);
    setLoadDiff(null);
    setGroups(loadGroups(month));
    setBinding(false);
    setBindSearch("");
    setBindPicked([]);
    fetchRows(month);
  }, [month, fetchRows]);

  const saveGroups = (next) => {
    setGroups(next);
    try { localStorage.setItem(groupsStorageKey(month), JSON.stringify(next)); } catch { /* ignore */ }
  };

  // 묶음의 대표 행(첫 번째 거래처)에 입금액을 합산하고, 나머지 행은 표에서 숨긴다.
  const displayRows = useMemo(() => {
    const byName = new Map(rows.map((r) => [vendorName(r), r]));
    const hidden = new Set();
    const primaries = new Map();
    for (const g of groups) {
      const present = g.filter((n) => byName.has(n));
      if (present.length < 2) continue;
      primaries.set(present[0], present.map((n) => byName.get(n)));
      present.slice(1).forEach((n) => hidden.add(n));
    }
    return rows
      .filter((r) => !hidden.has(vendorName(r)))
      .map((r) => {
        const all = primaries.get(vendorName(r));
        if (!all) return r;
        const merged = { ...r, 입금액: all.reduce((sum, x) => sum + (Number(x.입금액) || 0), 0), _all: all };
        for (const f of FLAG_COLS) merged[f.key] = all.every((x) => Number(x[f.key]) === 1) ? 1 : 0;
        return merged;
      });
  }, [rows, groups]);

  const groupedNames = useMemo(() => new Set(groups.flat()), [groups]);

  const bindCandidates = useMemo(() => {
    const q = bindSearch.trim().toLowerCase();
    if (!q) return [];
    return rows
      .filter((r) => {
        const n = vendorName(r);
        return n && !groupedNames.has(n) && !bindPicked.includes(n) && n.toLowerCase().includes(q);
      })
      .slice(0, 20);
  }, [rows, bindSearch, groupedNames, bindPicked]);

  const confirmBind = () => {
    if (bindPicked.length < 2) return;
    saveGroups([...groups, bindPicked]);
    setBinding(false);
    setBindSearch("");
    setBindPicked([]);
    setMessage(`${bindPicked.join(", ")} 거래처를 묶었습니다. (대표: ${bindPicked[0]})`);
  };

  const unbind = (primaryName) => saveGroups(groups.filter((g) => g[0] !== primaryName));

  const handleMonthChange = (e) => setMonth(e.target.value);

  // 거래처의 해당 월 이체파일 일자별 내역을 모달로 조회한다 (묶음이면 묶인 거래처 전체).
  const openHistory = async (row) => {
    const names = (row._all || [row]).map((t) => vendorName(t));
    const title = `${names.join(", ")} · ${month} 이체내역`;
    setHistorySortByAmount(false);
    setHistory({ title, loading: true, error: "", rows: [] });
    try {
      const results = await Promise.all(
        names.map(async (name) => {
          const params = new URLSearchParams({ vendor: name, start: `${month}-01`, end: `${month}-31` });
          const res = await fetch(`${API}/wonbe/ichae/vendor-history?${params}`, { headers: getAuthHeaders() });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || !data.ok) throw new Error(data?.detail || "조회 실패");
          // 부분일치로 딸려온 다른 거래처는 제외하고 정확히 같은 이름만 남긴다.
          return (data.rows || []).filter((r) => String(r.거래처명 || "").trim() === name);
        })
      );
      const merged = results.flat().sort((a, b) =>
        String(a.날짜).localeCompare(String(b.날짜)) || String(a.거래처명).localeCompare(String(b.거래처명), "ko")
      );
      setHistory({ title, loading: false, error: "", rows: merged });
    } catch (err) {
      setHistory({ title, loading: false, error: err.message, rows: [] });
    }
  };

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
      const newVendors = data.new_vendors || [];
      const updatedVendors = data.updated_vendors || [];
      setLoadDiff({ new: new Set(newVendors), updated: new Set(updatedVendors) });
      setMessage(
        `${month} 이체파일에서 거래처 ${data.loaded}건을 불러왔습니다. `
        + `(신규 ${newVendors.length}건 · 금액갱신 ${updatedVendors.length}건 · 변동없음 ${data.loaded - newVendors.length - updatedVendors.length}건)`
      );
      fetchMonths();
    } catch (err) {
      setMessage(err.message);
    } finally {
      setLoading(false);
    }
  };

  // 선택한 행 하나를 삭제한다 (묶음 대표 행이면 묶인 거래처도 함께 삭제).
  const handleDeleteRow = async (row) => {
    const targets = row._all || [row];
    const ids = targets.map((t) => t.id);
    const names = targets.map((t) => t.거래처명).join(", ");
    if (!window.confirm(`'${names}' ${ids.length}건을 삭제합니다.\n삭제 후에는 복구할 수 없습니다. 계속할까요?`)) return;
    setLoading(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/wonbe/invoice-manage/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ ids }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "삭제 실패");
      setSelectedRowId(null);
      setLoadDiff(null);
      await fetchRows(month);
      fetchMonths();
      setMessage(`${data.deleted}건을 삭제했습니다.`);
    } catch (err) {
      setMessage(err.message);
      window.alert(`삭제에 실패했습니다: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  // 체크 컬럼 헤더 필터 팝오버의 "조회목록 일괄 체크/해제"용 정보.
  // 현재 조회(필터 적용)된 목록 기준이며, 묶음 행은 묶인 거래처 전체가 대상이다.
  const bulkFor = (colKey) => {
    const checked = filteredRows.filter((r) => Number(r[colKey]) === 1).length;
    return {
      total: filteredRows.length,
      unchecked: filteredRows.length - checked,
      checked,
      onRun: (value) => runBulkFlag(colKey, value),
    };
  };

  const runBulkFlag = async (colKey, value) => {
    const label = FLAG_COLS.find((f) => f.key === colKey)?.label || colKey;
    const targets = filteredRows.filter((r) => (Number(r[colKey]) === 1) !== value);
    if (!targets.length) {
      setMessage(`조회된 목록이 모두 이미 ${label} ${value ? "체크" : "해제"} 상태입니다.`);
      return;
    }
    const ids = targets.flatMap((r) => (r._all || [r]).map((t) => t.id));
    const total = filteredRows.length;
    setLoading(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/wonbe/invoice-manage/bulk-flag`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ ids, col: colKey, value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "일괄 처리 실패");
      await fetchRows(month);
      setMessage(
        `${label} ${targets.length}건을 일괄 ${value ? "체크" : "해제"}했습니다. `
        + `(조회 ${total}건 중, 이미 ${value ? "체크된" : "해제된"} ${total - targets.length}건 제외)`
      );
    } catch (err) {
      setMessage(`일괄 처리 실패: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleExport = () => {
    if (!month) return;
    fetch(`${API}/wonbe/invoice-manage/export?month=${encodeURIComponent(month)}`, { headers: getAuthHeaders() })
      .then((r) => r.blob())
      .then((blob) => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `계산서관리_${month}.xls`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(a.href);
      })
      .catch(() => setMessage("다운로드 실패"));
  };

  const toggleFlag = async (row, col) => {
    const nextValue = Number(row[col]) !== 1;
    const targets = row._all || [row]; // 묶음이면 묶인 거래처 전체에 적용
    const ids = new Set(targets.map((t) => t.id));
    setRows((prev) => prev.map((r) => (ids.has(r.id) ? { ...r, [col]: nextValue ? 1 : 0 } : r)));
    try {
      const results = await Promise.all(
        targets.map(async (t) => {
          const res = await fetch(`${API}/wonbe/invoice-manage/row`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", ...getAuthHeaders() },
            body: JSON.stringify({ id: t.id, col, value: nextValue }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || !data.ok) throw new Error(data?.detail || "수정 실패");
          return data.row;
        })
      );
      setRows((prev) => prev.map((r) => {
        const updated = results.find((u) => u?.id === r.id);
        return updated ? { ...r, ...updated } : r;
      }));
    } catch (err) {
      setMessage(err.message);
      fetchRows(month);
    }
  };

  const startEditMemo = (id, value) => {
    setEditingMemo({ id, value: value ?? "" });
    setTimeout(() => memoInputRef.current?.focus(), 0);
  };

  const commitMemo = async () => {
    if (!editingMemo) return;
    const { id, value } = editingMemo;
    const original = rows.find((r) => r.id === id)?.메모 ?? "";
    setEditingMemo(null);
    if (value === String(original ?? "")) return;
    try {
      const res = await fetch(`${API}/wonbe/invoice-manage/row`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ id, col: "메모", value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "수정 실패");
      setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...data.row } : r)));
    } catch (err) {
      setMessage(err.message);
      fetchRows(month);
    }
  };

  const handleMemoKeyDown = (e) => {
    if (e.key === "Enter") commitMemo();
    if (e.key === "Escape") setEditingMemo(null);
  };

  // 컬럼별 옵션 목록은 "다른 컬럼에 걸린 필터"만 통과한 행 기준으로 계산해 이중(다중) 필터를 지원한다.
  const rowsForColumn = useCallback(
    (excludeKey) =>
      displayRows.filter((row) =>
        FILTERABLE_COLS.every((c) => {
          if (c.key === excludeKey) return true;
          const set = filters[c.key];
          if (!set) return true;
          return set.has(c.getValue(row));
        })
      ),
    [displayRows, filters]
  );

  const filteredRows = useMemo(
    () =>
      displayRows.filter((row) =>
        FILTERABLE_COLS.every((c) => {
          const set = filters[c.key];
          if (!set) return true;
          return set.has(c.getValue(row));
        })
      ),
    [displayRows, filters]
  );

  const applyFilter = (key, valueSet) => setFilters((prev) => ({ ...prev, [key]: valueSet }));
  const clearFilter = (key) => setFilters((prev) => { const next = { ...prev }; delete next[key]; return next; });
  const clearAllFilters = () => setFilters({});

  // ── 표에서 셀을 드래그 선택해 Ctrl+C로 복사할 때, 입금액처럼 data-raw-value를 가진
  // 셀은 화면 표시값("1,234,567원") 대신 콤마/단위 없는 순수 숫자를 클립보드에 넣는다.
  const handleTableCopy = (e) => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;
    const table = e.currentTarget;
    const lines = [];
    let touchedRaw = false;
    for (const tr of table.querySelectorAll("tr")) {
      const selectedCells = Array.from(tr.children).filter((cell) => selection.containsNode(cell, true));
      if (selectedCells.length === 0) continue;
      lines.push(
        selectedCells
          .map((cell) => {
            if (cell.dataset.rawValue !== undefined) {
              touchedRaw = true;
              return cell.dataset.rawValue;
            }
            return cell.textContent || "";
          })
          .join("\t")
      );
    }
    if (!touchedRaw || lines.length === 0) return; // 콤마 정리할 셀이 없으면 기본 복사 동작 그대로 둔다
    e.preventDefault();
    e.clipboardData.setData("text/plain", lines.join("\n"));
  };

  // ── 일괄복사: 현재 필터로 보이는 행들을 거래처계좌데이터와 매칭해 이체 붙여넣기용 탭/줄 구분 텍스트로 클립보드에 복사 ──
  const handleBulkCopy = async () => {
    if (!filteredRows.length) return;
    const monthNum = parseInt(String(month).split("-")[1], 10);
    const monthLabel = Number.isFinite(monthNum) ? `유색${monthNum}월세액` : "유색세액";
    let unmatched = 0;
    const lines = filteredRows.map((row) => {
      const vendor = String(row.거래처명 || "").trim();
      const acc = accountMap[vendor];
      if (!acc) unmatched += 1;
      const vatAmount = Math.round((Number(row.입금액) || 0) * 0.1);
      return [acc?.B || "", acc?.C || "", vatAmount, vendor, monthLabel].join("\t");
    });
    try {
      await copyText(lines.join("\n"));
      setMessage(
        unmatched
          ? `${filteredRows.length}건 일괄복사 완료 (계좌 정보 없는 거래처 ${unmatched}건 포함)`
          : `${filteredRows.length}건 일괄복사 완료`
      );
    } catch {
      setMessage("복사 실패");
    }
  };
  const activeFilterCount = Object.keys(filters).length;

  const totalAmount = filteredRows.reduce((sum, r) => sum + (Number(r.입금액) || 0), 0);
  const doneCount = (col) => filteredRows.filter((r) => Number(r[col]) === 1).length;
  const completedRows = filteredRows.filter((r) => Number(r.입금완료) === 1);
  const remainingRows = filteredRows.filter((r) => Number(r.입금완료) !== 1);
  const completedAmount = completedRows.reduce((sum, r) => sum + (Number(r.입금액) || 0), 0);
  const remainingAmount = remainingRows.reduce((sum, r) => sum + (Number(r.입금액) || 0), 0);
  const completedCount = completedRows.length;
  const remainingCount = remainingRows.length;

  // ── 거래처명/입금액 검색 (Ctrl+F 포커스 이동, Enter로 다음 결과로 스크롤, Space로 사전 설정한 열 체크) ──
  // 입금액은 "95000"과 "95,000" 둘 다로 검색되도록 쉼표를 제거한 숫자 문자열끼리 비교한다.
  const matches = useMemo(() => {
    const raw = searchedQuery.trim();
    if (!raw) return [];
    const q = raw.toLowerCase();
    const qDigits = raw.replace(/,/g, "");
    return filteredRows.filter((r) => {
      if ((r._all || [r]).some((x) => String(x.거래처명 || "").toLowerCase().includes(q))) return true;
      if (qDigits && /^\d+$/.test(qDigits)) {
        return String(Number(r.입금액) || 0).includes(qDigits);
      }
      return false;
    });
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
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return; // 메모/검색창 등 입력 중엔 원래 복사 동작 유지
      if (!selectedRowId) return;
      if (window.getSelection && window.getSelection().toString()) return; // 일반 텍스트 선택 복사는 그대로 둔다
      const row = displayRows.find((r) => r.id === selectedRowId);
      if (!row) return;
      e.preventDefault();
      const monthNum = parseInt(String(month).split("-")[1], 10);
      const monthLabel = Number.isFinite(monthNum) ? `${monthNum}월` : month;
      const amount = (Number(row.입금액) || 0).toLocaleString();
      const text = `안녕하세요 사장님! 부가세 보내드리려 하는데\n${monthLabel} 입금액 ${amount}원 맞을까요?`;
      copyText(text).catch(() => {});
    };
    window.addEventListener("keydown", handleCopy);
    return () => window.removeEventListener("keydown", handleCopy);
  }, [selectedRowId, displayRows, month]);

  // ── 행 선택 후 위/아래 화살표로 다음/이전 행 선택 ──
  useEffect(() => {
    const handleArrowNav = (e) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return; // 검색창 등 입력 중엔 무시
      if (!filteredRows.length) return;
      e.preventDefault();
      const currentIndex = filteredRows.findIndex((r) => r.id === selectedRowId);
      let nextIndex;
      if (currentIndex === -1) {
        nextIndex = 0;
      } else if (e.key === "ArrowDown") {
        nextIndex = Math.min(currentIndex + 1, filteredRows.length - 1);
      } else {
        nextIndex = Math.max(currentIndex - 1, 0);
      }
      const nextRow = filteredRows[nextIndex];
      setSelectedRowId(nextRow.id);
      document.getElementById(`invoice-row-${nextRow.id}`)?.scrollIntoView({ block: "nearest" });
    };
    window.addEventListener("keydown", handleArrowNav);
    return () => window.removeEventListener("keydown", handleArrowNav);
  }, [selectedRowId, filteredRows]);

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
        <span className={styles.pill}>{filteredRows.length}/{displayRows.length}개 거래처</span>
      </div>

      {displayRows.length > 0 && (
        <div style={{ display: "flex", gap: "0.6rem", marginBottom: "0.6rem" }}>
          <span className={`${styles.badge} ${styles.badgeNew}`} style={{ fontSize: "0.82rem", padding: "0.35rem 0.7rem" }}>
            완료금액 {completedAmount.toLocaleString()}원 ({completedCount}개 거래처)
          </span>
          <span className={`${styles.badge} ${styles.badgeUpdated}`} style={{ fontSize: "0.82rem", padding: "0.35rem 0.7rem", background: "#fee2e2", color: "#991b1b" }}>
            남은금액 {remainingAmount.toLocaleString()}원 ({remainingCount}개 거래처)
          </span>
        </div>
      )}

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
          onClick={() => { setLoadDiff(null); fetchRows(month); }}
          disabled={!month || loading}
        >
          <RefreshCw size={13} />새로고침
        </button>
        <button
          className={`${styles.btn} ${styles.btnSecondary}`}
          onClick={handleExport}
          disabled={!month || loading || !rows.length}
          title="현재 월의 계산서 관리 데이터를 엑셀로 다운로드"
        >
          <Download size={13} />엑셀 다운로드
        </button>
        <button
          className={`${styles.btn} ${styles.btnSecondary}`}
          onClick={handleBulkCopy}
          disabled={!filteredRows.length}
          title="현재 필터로 보이는 거래처들의 은행코드/계좌번호/입금액의 10%(부가세)/거래처명/해당월세액을 거래처계좌데이터와 매칭해 줄바꿈으로 구분된 텍스트로 복사"
        >
          <Copy size={13} />이체 일괄복사
        </button>
        <button
          className={`${styles.btn} ${styles.btnSecondary}`}
          onClick={() => { setBinding((v) => !v); setBindSearch(""); setBindPicked([]); }}
          disabled={!rows.length}
          title="여러 거래처를 하나로 묶어 입금액을 합산합니다 (계좌정보는 먼저 추가한 거래처 기준)"
        >
          <Link2 size={13} />묶기
        </button>
        {activeFilterCount > 0 && (
          <button className={`${styles.btn} ${styles.btnSecondary}`} onClick={clearAllFilters}>
            필터 초기화 ({activeFilterCount})
          </button>
        )}
        {rows.length > 0 && (
          <span style={{ marginLeft: "auto", fontSize: "0.78rem", color: "var(--text-muted)" }}>
            합계: {totalAmount.toLocaleString()}원 · 금액체크 {doneCount("금액체크")}/{filteredRows.length}
            · 입금완료 {doneCount("입금완료")}/{filteredRows.length}
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
            placeholder="거래처명/입금액 검색 (Ctrl+F, Enter로 다음 결과)"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            aria-label="계산서 관리 거래처명/입금액 검색"
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

      {binding && (
        <div className={styles.controls} style={{ flexDirection: "column", alignItems: "stretch", gap: "0.4rem" }}>
          <div className={styles.searchBox}>
            <Search size={13} aria-hidden="true" />
            <input
              className={styles.searchInput}
              placeholder="묶을 거래처명 검색 후 클릭해서 추가 (먼저 추가한 거래처가 대표)"
              value={bindSearch}
              onChange={(e) => setBindSearch(e.target.value)}
              autoFocus
              aria-label="묶을 거래처 검색"
            />
          </div>
          {bindCandidates.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.3rem" }}>
              {bindCandidates.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  className={`${styles.btn} ${styles.btnSecondary}`}
                  onClick={() => { setBindPicked((p) => [...p, vendorName(r)]); setBindSearch(""); }}
                >
                  {vendorName(r)} ({(Number(r.입금액) || 0).toLocaleString()}원)
                </button>
              ))}
            </div>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap", fontSize: "0.8rem" }}>
            <span>선택됨:</span>
            {bindPicked.length === 0 && <span style={{ color: "var(--text-muted)" }}>없음</span>}
            {bindPicked.map((n, i) => (
              <span key={n} className={`${styles.badge} ${styles.badgeNew}`}>
                {i === 0 ? "대표 · " : ""}{n}
                <button
                  type="button"
                  onClick={() => setBindPicked((p) => p.filter((x) => x !== n))}
                  style={{ marginLeft: "0.3rem", border: "none", background: "none", cursor: "pointer" }}
                  aria-label={`${n} 제거`}
                >×</button>
              </span>
            ))}
            <button
              type="button"
              className={`${styles.btn} ${styles.btnPrimary}`}
              onClick={confirmBind}
              disabled={bindPicked.length < 2}
            >
              묶기 확인
            </button>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnSecondary}`}
              onClick={() => { setBinding(false); setBindSearch(""); setBindPicked([]); }}
            >
              취소
            </button>
          </div>
        </div>
      )}

      {message && <div className={styles.message}>{message}</div>}

      <div className={styles.tableWrap}>
        <table className={styles.table} onCopy={handleTableCopy}>
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
              <th>예금주</th>
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
                    bulk={bulkFor(f.key)}
                  />
                </th>
              ))}
              <th style={{ textAlign: "center" }}>이체내역</th>
              <th>메모</th>
              <th>수정일시</th>
              <th style={{ textAlign: "center" }}>삭제</th>
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
                <td>
                  {row.거래처명}
                  {row._all && (
                    <>
                      <span className={`${styles.badge} ${styles.badgeVat}`} style={{ marginLeft: "0.4rem" }}>
                        묶음 +{row._all.slice(1).map((x) => x.거래처명).join(", ")}
                      </span>
                      <button
                        type="button"
                        title="묶기 해제"
                        onClick={(e) => { e.stopPropagation(); unbind(vendorName(row)); }}
                        style={{ marginLeft: "0.3rem", border: "none", background: "none", cursor: "pointer", verticalAlign: "middle" }}
                      >
                        <Unlink size={12} />
                      </button>
                    </>
                  )}
                  {carryNames.has(String(row.거래처명 || "").trim()) && (
                    <span
                      className={styles.badge}
                      style={{ marginLeft: "0.4rem", background: "#fef3c7", color: "#92400e", border: "1px solid #fcd34d" }}
                      title={`${prevMonth}에서 이월발행으로 넘어온 거래처`}
                    >
                      이월 {carryNames.get(String(row.거래처명 || "").trim()).toLocaleString()}원
                    </span>
                  )}
                  {loadDiff?.new.has(row.거래처명) && (
                    <span className={`${styles.badge} ${styles.badgeNew}`} style={{ marginLeft: "0.4rem" }}>신규</span>
                  )}
                  {loadDiff?.updated.has(row.거래처명) && (
                    <span className={`${styles.badge} ${styles.badgeUpdated}`} style={{ marginLeft: "0.4rem" }}>금액갱신</span>
                  )}
                </td>
                <td data-raw-value={Number(row.입금액) || 0}>{(Number(row.입금액) || 0).toLocaleString()}원</td>
                <td>{accountMap[String(row.거래처명 || "").trim()]?.E || "-"}</td>
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
                <td style={{ textAlign: "center" }}>
                  <button
                    type="button"
                    className={`${styles.btn} ${styles.btnSecondary}`}
                    onClick={(e) => { e.stopPropagation(); openHistory(row); }}
                    title={`${month} 이체파일 일자별 조회`}
                  >
                    이체내역 조회
                  </button>
                </td>
                {editingMemo?.id === row.id ? (
                  <td onClick={(e) => e.stopPropagation()}>
                    <input
                      ref={memoInputRef}
                      className={styles.inlineInput}
                      value={editingMemo.value}
                      onChange={(e) => setEditingMemo((p) => ({ ...p, value: e.target.value }))}
                      onBlur={commitMemo}
                      onKeyDown={handleMemoKeyDown}
                    />
                  </td>
                ) : (
                  <td
                    className={styles.editableCell}
                    onClick={(e) => { e.stopPropagation(); startEditMemo(row.id, row.메모); }}
                    title="클릭하여 메모 수정"
                  >
                    {row.메모 || ""}
                  </td>
                )}
                <td style={{ color: "var(--text-muted)", fontSize: "0.76rem" }}>{row.수정일시 || ""}</td>
                <td style={{ textAlign: "center" }}>
                  <button
                    type="button"
                    title="이 거래처 삭제"
                    disabled={loading}
                    onClick={(e) => { e.stopPropagation(); handleDeleteRow(row); }}
                    style={{ border: "none", background: "none", cursor: "pointer", color: "#b91c1c" }}
                  >
                    <Trash2 size={14} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!filteredRows.length && !loading && (
          <div className={styles.empty}>
            {!displayRows.length
              ? (month ? `${month} 계산서 데이터가 없습니다. "계산서 불러오기"를 눌러 이체파일에서 불러오세요.` : "월을 선택하세요.")
              : "필터 조건에 맞는 거래처가 없습니다."}
          </div>
        )}
      </div>

      {history && (
        <div className={styles.catOverlay} onClick={() => setHistory(null)}>
          <div className={styles.catModal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.catHeader}>
              <strong>{history.title}</strong>
              {!history.loading && !history.error && (
                <span>
                  {history.rows.length}건
                </span>
              )}
              {!history.loading && !history.error && history.rows.length > 1 && (
                <span>
                  <button
                    type="button"
                    className={`${styles.btn} ${historySortByAmount ? styles.btnPrimary : styles.btnSecondary}`}
                    onClick={() => setHistorySortByAmount((v) => !v)}
                    title="금액이 큰 순서 / 날짜순 전환"
                  >
                    {historySortByAmount ? "금액 내림차순 (클릭: 날짜순)" : "금액 내림차순으로 보기"}
                  </button>
                </span>
              )}
            </div>
            <div className={styles.catList}>
              {history.loading && <div className={styles.catEmpty}>조회 중...</div>}
              {history.error && <div className={styles.catEmpty}>{history.error}</div>}
              {!history.loading && !history.error && history.rows.length === 0 && (
                <div className={styles.catEmpty}>해당 월 이체 내역이 없습니다.</div>
              )}
              {(historySortByAmount
                ? [...history.rows].sort((a, b) => (Number(b.금액) || 0) - (Number(a.금액) || 0))
                : history.rows
              ).map((r) => (
                <div key={`${r.날짜}-${r.거래처명}`} className={styles.catRow}>
                  <span style={{ width: "6.5rem" }}>{r.날짜}</span>
                  <span className={styles.catName}>{r.거래처명}</span>
                  <span style={{ textAlign: "right" }}>{(Number(r.금액) || 0).toLocaleString()}원</span>
                </div>
              ))}
            </div>
            <div className={styles.catFooter}>
              {!history.loading && !history.error && (
                <strong style={{ marginRight: "auto" }}>
                  합계 {history.rows.reduce((s, r) => s + (Number(r.금액) || 0), 0).toLocaleString()}원
                </strong>
              )}
              <button className={`${styles.btn} ${styles.btnSecondary}`} onClick={() => setHistory(null)}>닫기</button>
            </div>
          </div>
        </div>
      )}

      {renderCarryCard("bottom")}
    </>
  );
}
