import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw, Trash2, GitCompare, SlidersHorizontal, Plus, X, PackagePlus, Search } from "lucide-react";
import styles from "./DBManager.module.css";
import topStyles from "./JanggiTop.module.css";
import { LOCAL_API_BASE as API, getAuthHeaders } from "../../lib/api";

function _normalizePickup(v) { return String(v || "").replace(/\s+/g, "").trim(); }
function _hasPickup(v) { const n = _normalizePickup(v); return n.includes("미송픽업") || (n.includes("미송") && n.includes("픽업")); }
function _isMisong(v) { return _normalizePickup(v).includes("미송") && !_hasPickup(v); }

// 로컬(한국) 기준 오늘 날짜 - toISOString은 UTC라 오전 9시 전에는 하루 전으로 나온다
function _todayLocal() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
const PAGE_SIZE = 50;
function _parsePrice(v) { const n = parseFloat(String(v ?? "").replace(/[^\d.+-]/g, "")); return Number.isFinite(n) ? n : 0; }
const COLS = ["거래처", "거래처상품명", "가격", "옵션", "사이즈", "개수", "날짜", "미송체크", "상품코드", "메모", "거래처합산"];

/* ── 목록 탭 ─────────────────────────────────────────────────── */
function JanggiListView({ initialQuery = "", initialDate = "", syncWonbeCost = false } = {}) {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [query, setQuery] = useState(initialQuery);
  const [inputQuery, setInputQuery] = useState(initialQuery);
  const [dateFilter, setDateFilter] = useState(initialDate || _todayLocal);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [misongFilter, setMisongFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [editing, setEditing] = useState(null);
  const inputRef = useRef(null);
  const searchInputRef = useRef(null);
  const [selectedCell, setSelectedCell] = useState(null);
  const [selectedRowIds, setSelectedRowIds] = useState(() => new Set());
  const lastSelectedRowIdRef = useRef(null);
  const [sortCol, setSortCol] = useState(null);
  const [sortDir, setSortDir] = useState("asc");
  const [misongLoading, setMisongLoading] = useState(false);
  const [misongLock, setMisongLock] = useState(null);
  const [misongUnlockLoading, setMisongUnlockLoading] = useState(false);
  const [ichaeLoading, setIchaeLoading] = useState(false);
  const [ichaeConfirmMode, setIchaeConfirmMode] = useState(false);
  const [bulkMarkLoading, setBulkMarkLoading] = useState(false);
  const [purchaseMoveLoading, setPurchaseMoveLoading] = useState(false);
  const [ilgwalOnly, setIlgwalOnly] = useState(false);
  const [showProductModal, setShowProductModal] = useState(false);
  const [deductModal, setDeductModal] = useState(null); // { client, amount } | null
  const [deductSaving, setDeductSaving] = useState(false);
  const [productSearch, setProductSearch] = useState("");
  const [productResults, setProductResults] = useState([]);
  const [productSearchLoading, setProductSearchLoading] = useState(false);
  const productSearchRef = useRef(null);

  const applyGroupRecalc = (prev, recalcRows = []) => {
    const recalcMap = new Map((recalcRows || []).map((r) => [r.id, r]));
    return prev.map((r) => { const rc = recalcMap.get(r.id); return rc ? { ...r, ...rc } : r; });
  };

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

  const fetchRows = useCallback(async (q, date, off, misong = "", ilgwal = false, dFrom = "", dTo = "") => {
    setLoading(true);
    setSelectedRowIds(new Set());
    setSelectedCell(null);
    try {
      const params = new URLSearchParams({ q, date, date_from: dFrom, date_to: dTo, misong_filter: misong, ilgwal_only: ilgwal ? "Y" : "", offset: off, limit: PAGE_SIZE });
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

  useEffect(() => { fetchRows(query, dateFilter, offset, misongFilter, ilgwalOnly, dateFrom, dateTo); }, [fetchRows, query, dateFilter, offset, misongFilter, ilgwalOnly, dateFrom, dateTo]);

  const fetchMisongLock = useCallback(async (date) => {
    if (!date) { setMisongLock(null); return; }
    try {
      const res = await fetch(`${API}/noye-kimsungil/misong/move-lock?date=${encodeURIComponent(date)}`, { headers: getAuthHeaders() });
      const data = await res.json().catch(() => ({}));
      setMisongLock(res.ok ? data : null);
    } catch {
      setMisongLock(null);
    }
  }, []);

  useEffect(() => { fetchMisongLock(dateFilter); }, [fetchMisongLock, dateFilter]);

  const handleSearch = (e) => {
    e.preventDefault();
    setOffset(0);
    setQuery(inputQuery.trim());
  };

  const startEdit = (id, col, val) => {
    setEditing({ id, col, value: val ?? "" });
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const patchNum = (v) => parseFloat(String(v ?? "").replace(/[,원\s]/g, "").match(/[+-]?[0-9]+(?:\.[0-9]+)?/)?.[0] ?? "0") || 0;

  const commitEdit = async () => {
    if (!editing) return;
    const { id, col, value } = editing;
    const row = rows.find((r) => r.id === id);
    const original = row?.[col] ?? "";
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
      setRows((prev) => applyGroupRecalc(prev.map((r) => r.id === id ? { ...r, ...data.row } : r), data.recalc_rows));

      if (col === "개수" && row) {
        const oldQty = patchNum(row["개수"]);
        const oldPrice = patchNum(row["가격"]);
        const newQty = patchNum(value);
        if (oldQty > 0 && newQty > 0 && oldPrice > 0) {
          const newPrice = Math.round((oldPrice / oldQty) * newQty);
      // 거래처 모달에서 가격을 직접 고치면 원가베이스유 원가도 같이 수정 (원가 = 가격 ÷ 개수)
      if (syncWonbeCost && col === "가격") {
        const code = String(row?.["상품코드"] || "").trim();
        const price = patchNum(value);
        if (code && price > 0) {
          const qty = patchNum(row?.["개수"]) > 0 ? patchNum(row["개수"]) : 1;
          const unitCost = Math.round(price / qty);
          const wr = await fetch(`${API}/wonbe/row`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", ...getAuthHeaders() },
            body: JSON.stringify({ 상품코드: code, 원가: String(unitCost) }),
          });
          const wd = await wr.json().catch(() => ({}));
          setMessage(wr.ok && wd.ok ? `원가베이스유 원가도 ${unitCost.toLocaleString()}원으로 수정됨 (${code})` : `장끼 가격은 저장됐지만 원가베이스유 수정 실패: ${wd?.detail || "오류"}`);
        } else if (!code) {
          setMessage("상품코드가 없어 원가베이스유는 수정하지 못했습니다.");
        }
      }

          const pr = await fetch(`${API}/wonbe/janggi/row`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", ...getAuthHeaders() },
            body: JSON.stringify({ id, column: "가격", value: String(newPrice) }),
          });
          const pd = await pr.json().catch(() => ({}));
          if (pr.ok && pd.ok) setRows((prev) => applyGroupRecalc(prev.map((r) => r.id === id ? { ...r, ...pd.row } : r), pd.recalc_rows));
        }
      }
    } catch (err) {
      setMessage(err.message);
      fetchRows(query, dateFilter, offset, misongFilter, ilgwalOnly, dateFrom, dateTo);
    }
  };

  const handleKeyDown = async (e) => {
    if (e.key === "Enter") { commitEdit(); return; }
    if (e.key === "Escape") { setEditing(null); return; }
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      if (!editing) return;
      const { id, col } = editing;
      const rowIdx = sortedRows.findIndex((r) => r.id === id);
      if (rowIdx === -1) return;
      const nextRowIdx = rowIdx + (e.key === "ArrowUp" ? -1 : 1);
      if (nextRowIdx < 0 || nextRowIdx >= sortedRows.length) return;
      await commitEdit();
      const nextRow = sortedRows[nextRowIdx];
      startEdit(nextRow.id, col, nextRow[col] ?? "");
      return;
    }
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      const input = e.target;
      const atStart = input.selectionStart === 0 && input.selectionEnd === 0;
      const atEnd = input.selectionStart === input.value.length && input.selectionEnd === input.value.length;
      const movingLeft = e.key === "ArrowLeft";
      if ((movingLeft && !atStart) || (!movingLeft && !atEnd)) return; // 텍스트 커서 이동은 그대로 둔다
      if (!editing) return;
      const { id, col } = editing;
      const colIdx = COLS.indexOf(col);
      const rowIdx = sortedRows.findIndex((r) => r.id === id);
      if (colIdx === -1 || rowIdx === -1) return;
      const dir = movingLeft ? -1 : 1;
      let nextColIdx = colIdx + dir;
      let nextRowIdx = rowIdx;
      if (nextColIdx >= COLS.length) { nextColIdx = 0; nextRowIdx += 1; }
      else if (nextColIdx < 0) { nextColIdx = COLS.length - 1; nextRowIdx -= 1; }
      if (nextRowIdx < 0 || nextRowIdx >= sortedRows.length) return;
      e.preventDefault();
      await commitEdit();
      const nextRow = sortedRows[nextRowIdx];
      const nextCol = COLS[nextColIdx];
      startEdit(nextRow.id, nextCol, nextRow[nextCol] ?? "");
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      if (!editing) return;
      const { id, col } = editing;
      const colIdx = COLS.indexOf(col);
      const rowIdx = sortedRows.findIndex((r) => r.id === id);
      if (colIdx === -1 || rowIdx === -1) return;
      const dir = e.shiftKey ? -1 : 1;
      let nextColIdx = colIdx + dir;
      let nextRowIdx = rowIdx;
      if (nextColIdx >= COLS.length) { nextColIdx = 0; nextRowIdx += 1; }
      else if (nextColIdx < 0) { nextColIdx = COLS.length - 1; nextRowIdx -= 1; }
      if (nextRowIdx < 0 || nextRowIdx >= sortedRows.length) { commitEdit(); return; }
      await commitEdit();
      const nextRow = sortedRows[nextRowIdx];
      const nextCol = COLS[nextColIdx];
      startEdit(nextRow.id, nextCol, nextRow[nextCol] ?? "");
    }
  };

  // 검색창에서 아래 화살표를 누르면 표 첫 행 첫 열로 진입 (편집은 아니고 커서 선택 상태)
  const handleSearchInputKeyDown = (e) => {
    if (e.key !== "ArrowDown") return;
    if (!sortedRows.length) return;
    e.preventDefault();
    e.currentTarget.blur();
    setSelectedCell({ id: sortedRows[0].id, col: COLS[0] });
  };

  const moveSelectedCell = (key) => {
    if (!selectedCell) return;
    const colIdx = COLS.indexOf(selectedCell.col);
    const rowIdx = sortedRows.findIndex((r) => r.id === selectedCell.id);
    if (colIdx === -1 || rowIdx === -1) return;
    let nextRowIdx = rowIdx;
    let nextColIdx = colIdx;
    if (key === "ArrowUp") nextRowIdx -= 1;
    else if (key === "ArrowDown") nextRowIdx += 1;
    else if (key === "ArrowLeft") {
      nextColIdx -= 1;
      if (nextColIdx < 0) { nextColIdx = COLS.length - 1; nextRowIdx -= 1; }
    } else if (key === "ArrowRight") {
      nextColIdx += 1;
      if (nextColIdx >= COLS.length) { nextColIdx = 0; nextRowIdx += 1; }
    }
    if (nextRowIdx < 0 || nextRowIdx >= sortedRows.length) return;
    const nextRow = sortedRows[nextRowIdx];
    setSelectedCell({ id: nextRow.id, col: COLS[nextColIdx] });
    document.getElementById(`janggi-row-${nextRow.id}`)?.scrollIntoView({ block: "nearest" });
  };

  // Ctrl/Shift+클릭으로 행을 다중선택 (일반 클릭은 그대로 편집 진입)
  const toggleRowSelection = (id) => {
    setSelectedRowIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    lastSelectedRowIdRef.current = id;
  };

  const shiftSelectRange = (id) => {
    const anchor = lastSelectedRowIdRef.current;
    const ids = sortedRows.map((r) => r.id);
    const ai = ids.indexOf(anchor);
    const bi = ids.indexOf(id);
    if (anchor == null || ai === -1 || bi === -1) { toggleRowSelection(id); return; }
    const [start, end] = ai < bi ? [ai, bi] : [bi, ai];
    setSelectedRowIds(new Set(ids.slice(start, end + 1)));
  };

  const handleCellClick = (e, row, col) => {
    if (e.ctrlKey || e.metaKey) { e.preventDefault(); toggleRowSelection(row.id); return; }
    if (e.shiftKey) { e.preventDefault(); shiftSelectRange(row.id); return; }
    if (selectedRowIds.size) setSelectedRowIds(new Set());
    setSelectedCell(null);
    startEdit(row.id, col, row[col] ?? "");
  };

  // Alt+2: 다중선택된 행이 있으면 일괄삭제, 없으면 현재 편집/선택 중인 행 삭제 (둘 다 확인창 필요)
  const handleAltDeleteHotkey = () => {
    if (selectedRowIds.size > 0) {
      const ids = [...selectedRowIds];
      if (!window.confirm(`선택한 ${ids.length}개 행을 정말 삭제하시겠습니까?`)) return;
      (async () => {
        try {
          const results = await Promise.all(ids.map(async (id) => {
            const res = await fetch(`${API}/wonbe/janggi/row`, {
              method: "DELETE",
              headers: { "Content-Type": "application/json", ...getAuthHeaders() },
              body: JSON.stringify({ id }),
            });
            const data = await res.json().catch(() => ({}));
            return { id, ok: res.ok && data.ok };
          }));
          const deletedIds = new Set(results.filter((r) => r.ok).map((r) => r.id));
          const failCount = results.length - deletedIds.size;
          setRows((prev) => prev.filter((r) => !deletedIds.has(r.id)));
          setTotal((t) => t - deletedIds.size);
          setSelectedRowIds(new Set());
          setMessage(failCount ? `${deletedIds.size}건 삭제 완료 (${failCount}건 실패)` : `${deletedIds.size}건 삭제 완료`);
        } catch (err) {
          setMessage(err.message || "일괄 삭제 실패");
        }
      })();
      return;
    }
    const targetId = editing?.id ?? selectedCell?.id;
    if (!targetId) return;
    handleDeleteRow(targetId);
  };

  // Ctrl+F: 검색창 포커스 / Alt+1: 행 추가 / Alt+2: 행 삭제 / 선택 커서 상태에서 방향키·Enter·Esc
  useEffect(() => {
    const onGlobalKeyDown = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
        return;
      }
      if (e.altKey && e.key === "1") {
        e.preventDefault();
        handleAddRow();
        return;
      }
      if (e.altKey && e.key === "2") {
        e.preventDefault();
        handleAltDeleteHotkey();
        return;
      }
      if (editing || !selectedCell) return;
      if (e.key === "Escape") { e.preventDefault(); setSelectedCell(null); return; }
      if (e.key === "Enter") {
        e.preventDefault();
        const row = sortedRows.find((r) => r.id === selectedCell.id);
        if (row) startEdit(row.id, selectedCell.col, row[selectedCell.col] ?? "");
        return;
      }
      if (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        moveSelectedCell(e.key);
      }
    };
    window.addEventListener("keydown", onGlobalKeyDown);
    return () => window.removeEventListener("keydown", onGlobalKeyDown);
  });

  const handleAddRow = async () => {
    const today = new Date().toISOString().slice(0, 10);
    try {
      const res = await fetch(`${API}/wonbe/janggi/row`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ 날짜: today }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "행 추가 실패");
      setRows((prev) => applyGroupRecalc([data.row, ...prev], data.recalc_rows));
      setTotal((t) => t + 1);
    } catch (err) {
      setMessage(err.message);
    }
  };

  // 매입차감 행 추가: 금액은 부호와 상관없이 음수로 저장 (1000 -> -1000), 나머지는 거래처상품명/미송체크만 "매입차감"
  const saveDeduct = async () => {
    if (!deductModal) return;
    const client = deductModal.client.trim();
    const n = Math.abs(parseFloat(String(deductModal.amount).replace(/[,원\s-]/g, "")));
    if (!client || !Number.isFinite(n) || n <= 0) { setMessage("거래처와 금액을 확인하세요."); return; }
    setDeductSaving(true);
    try {
      const res = await fetch(`${API}/wonbe/janggi/row`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({
          거래처: client,
          거래처상품명: "매입차감",
          가격: String(-n),
          날짜: dateFilter || _todayLocal(),
          미송체크: "매입차감",
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "매입차감 추가 실패");
      setRows((prev) => applyGroupRecalc([data.row, ...prev], data.recalc_rows));
      setTotal((t) => t + 1);
      setDeductModal(null);
      setMessage("");
    } catch (err) {
      setMessage(err.message);
    } finally {
      setDeductSaving(false);
    }
  };

  const addFromProduct = async (wonbeRow) => {
    const today = dateFilter || new Date().toISOString().slice(0, 10);
    const payload = {
      거래처: wonbeRow.거래처 || "",
      거래처상품명: wonbeRow.거래처상품명 || "",
      가격: wonbeRow.원가 || "",
      옵션: wonbeRow.색상 || "",
      사이즈: wonbeRow.사이즈 || "",
      개수: "1",
      날짜: today,
      미송체크: "",
      상품코드: wonbeRow.상품코드 || "",
      메모: "",
      거래처합산: "",
    };
    try {
      const res = await fetch(`${API}/wonbe/janggi/row`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "행 추가 실패");
      setRows((prev) => applyGroupRecalc([data.row, ...prev], data.recalc_rows));
      setTotal((t) => t + 1);
      setShowProductModal(false);
    } catch (err) {
      setMessage(err.message);
    }
  };

  useEffect(() => {
    if (!showProductModal) return;
    const timer = setTimeout(async () => {
      const q = productSearch.trim();
      setProductSearchLoading(true);
      try {
  const [pricePushLoading, setPricePushLoading] = useState(false);

  // 지금 목록(거래처 모달 포함)에 보이는 행의 상품코드로 에이블리 실제 상품가 변경 - 원가베이스유 화면의 상품가 변경과 동일 API
  const pushSearchPriceToAbly = async (priceSource) => {
    // 행을 선택했으면 선택한 행만, 없으면 목록 전체
    const targetRows = selectedRowIds.size ? rows.filter((r) => selectedRowIds.has(r.id)) : rows;
    const codes = Array.from(new Set(targetRows.map((r) => String(r["상품코드"] || "").trim()).filter(Boolean)));
    if (!codes.length) { setMessage("상품코드가 있는 행이 없습니다."); return; }
    const sourceName = priceSource === "이벤트 할인가" ? "이벤트 판매가" : "판매가";
    const scopeLabel = selectedRowIds.size ? `선택한 행의 상품 ${codes.length}건` : `목록의 상품 ${codes.length}건`;
    if (!window.confirm(
      `${scopeLabel}을 [${sourceName}] 기준으로 에이블리 실제 상품가로 변경합니다.\n` +
      (syncWonbeCost ? `(먼저 장끼정리 가격 기준으로 원가베이스유 원가를 같은 에이블리상품번호의 모든 옵션에 반영합니다)\n` : "") +
      `(에이블리상품번호 기준 — 실제 판매중인 상품가가 바뀝니다)\n진행하시겠습니까?`
    )) return;
    // 이벤트가 기준이면 이벤트전 할인가를 몇 % 올릴지 먼저 받는다 (원가베이스유의 "이벤트 할인가 채우기"와 동일)
    let eventPercent = null;
    if (syncWonbeCost && priceSource === "이벤트 할인가") {
      const input = window.prompt("[이벤트전 할인가]를 몇 % 올려 [이벤트 할인가]에 채울까요? (예: 10)");
      if (input === null) return;
      eventPercent = Number(input);
      if (input.trim() === "" || !Number.isFinite(eventPercent)) { setMessage("퍼센트 값이 올바르지 않습니다."); return; }
    }
    setPricePushLoading(true);
    try {
      let costNote = "";
      if (syncWonbeCost) {
        // 원가 = 가격 ÷ 개수. 같은 상품코드가 여러 행이면 마지막 행 기준
        const costByCode = new Map();
        for (const r of targetRows) {
          const code = String(r["상품코드"] || "").trim();
          const price = patchNum(r["가격"]);
          if (!code || price <= 0) continue;
          const qty = patchNum(r["개수"]) > 0 ? patchNum(r["개수"]) : 1;
          costByCode.set(code, String(Math.round(price / qty)));
        }
        if (costByCode.size) {
          const cr = await fetch(`${API}/wonbe/update-cost-by-ably-product`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...getAuthHeaders() },
            body: JSON.stringify({ items: [...costByCode].map(([상품코드, 원가]) => ({ 상품코드, 원가 })) }),
          });
          const cd = await cr.json().catch(() => ({}));
          if (!cr.ok || !cd.ok) throw new Error(cd?.detail || "원가베이스유 원가 수정 실패 (에이블리 상품가는 변경하지 않았습니다)");
          costNote = `원가베이스유 원가 ${cd.updated}개 옵션 수정 · `;

          // 원가 기준으로 판매가(이벤트전 할인가)를 다시 계산 - 원가베이스유 "이벤트전 할인가 채우기"와 동일 (목표순마진율/택배비는 서버 기본값)
          const priceCodes = Array.isArray(cd.codes) && cd.codes.length ? cd.codes : codes;
          const pr = await fetch(`${API}/wonbe/fill-event-pre-discount-price`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...getAuthHeaders() },
            body: JSON.stringify({ codes: priceCodes }),
          });
          const pd = await pr.json().catch(() => ({}));
          if (!pr.ok || !pd.ok) throw new Error(pd?.detail || "판매가(이벤트전 할인가) 계산 실패 (에이블리 상품가는 변경하지 않았습니다)");
          costNote += `판매가 ${pd.updated}건 재계산(마진 ${pd.margin_percent}%) · `;

          if (eventPercent !== null) {
            const er = await fetch(`${API}/wonbe/fill-event-discount`, {
              method: "POST",
              headers: { "Content-Type": "application/json", ...getAuthHeaders() },
              body: JSON.stringify({ percent: eventPercent, codes: priceCodes }),
            });
            const ed = await er.json().catch(() => ({}));
            if (!er.ok || !ed.ok) throw new Error(ed?.detail || "이벤트 할인가 계산 실패 (에이블리 상품가는 변경하지 않았습니다)");
            costNote += `이벤트가 ${ed.updated}건 재계산(${ed.percent}%) · `;
          }
        }
      }
      const res = await fetch(`${API}/wonbe/push-price-to-ably`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ source: priceSource, codes }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "에이블리 상품가 변경 실패");
      setMessage(
        `${costNote}[${sourceName}] 기준 에이블리 상품가 변경 완료: 성공 ${data.success_row_count}건 / 실패 ${data.error_row_count}건 ` +
        `(요청 ${data.requested}건, 제외 - 값이상 ${data.skipped_invalid}건 · 중복상품 ${data.skipped_duplicate}건 · 제외그룹 ${data.skipped_group_excluded ?? 0}건)`
      );
    } catch (err) {
      setMessage(err.message);
    } finally {
      setPricePushLoading(false);
    }
  };

        const params = new URLSearchParams({ q, limit: 50 });
        const res = await fetch(`${API}/wonbe/search?${params}`, { headers: getAuthHeaders() });
        const data = await res.json().catch(() => ({}));
        setProductResults(data.rows || []);
      } catch {
        setProductResults([]);
      } finally {
        setProductSearchLoading(false);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [productSearch, showProductModal]);

  useEffect(() => {
    if (showProductModal) setTimeout(() => productSearchRef.current?.focus(), 50);
  }, [showProductModal]);

  const handleDeleteRow = async (id) => {
    if (!window.confirm("이 행을 삭제하시겠습니까?")) return;
    try {
      const res = await fetch(`${API}/wonbe/janggi/row`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "삭제 실패");
      setRows((prev) => prev.filter((r) => r.id !== id));
      setTotal((t) => t - 1);
      setSelectedCell((sc) => (sc?.id === id ? null : sc));
      setSelectedRowIds((prev) => (prev.has(id) ? new Set([...prev].filter((x) => x !== id)) : prev));
    } catch (err) {
      setMessage(err.message);
    }
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
      await fetchRows(query, dateFilter, 0, misongFilter, ilgwalOnly, dateFrom, dateTo);
    } catch (err) {
      setMessage(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleSendToMisong = async () => {
    if (!dateFilter) return;
    if (misongLock?.locked) {
      setMessage(`${dateFilter} 날짜는 이미 미송관리로 이동 처리되었습니다 (${misongLock.locked_by}, ${misongLock.locked_at}).`);
      return;
    }
    setMisongLoading(true);
    setMessage("");
    try {
      const params = new URLSearchParams({ q: query, date: dateFilter, offset: 0, limit: 9999 });
      const res = await fetch(`${API}/wonbe/janggi/search?${params}`, { headers: getAuthHeaders() });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "조회 실패");
      const allRows = data.rows || [];

      const misongRows = allRows.filter((r) => _isMisong(r["미송체크"]) || _hasPickup(r["미송체크"]));
      if (!misongRows.length) {
        setMessage(`${dateFilter} 날짜에 미송/미송픽업 해당 행이 없습니다.`);
        return;
      }

      const addCount = misongRows.filter((r) => _isMisong(r["미송체크"])).length;
      const pickupCount = misongRows.filter((r) => _hasPickup(r["미송체크"])).length;
      if (!window.confirm(`${dateFilter} 날짜 데이터에서 미송 ${addCount}건 / 미송픽업 ${pickupCount}건을 미송관리에 반영하시겠습니까?`)) return;

      const processRows = misongRows.map((r) => {
        const h = _hasPickup(r["미송체크"]) ? "미송픽업" : "미송";
        const code = String(r["상품코드"] || "").trim();
        return {
          A: String(r["거래처"] || "").trim(),
          B: String(r["거래처상품명"] || "").trim(),
          C: "",
          D: String(r["옵션"] || "").trim(),
          E: String(r["사이즈"] || "").trim(),
          F: String(r["개수"] || "0").trim(),
          G: String(r["날짜"] || "").trim(),
          H: h,
          I: code,
          originalF: code,
        };
      });

      const res2 = await fetch(`${API}/noye-kimsungil/misong/items/process-rows`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ rows: processRows, today: dateFilter }),
      });
      const result = await res2.json().catch(() => ({}));
      if (!res2.ok) throw new Error(result?.detail || "미송 반영 실패");

      const alertMsg = (result.new_alert_count || 0) > 0 ? ` / 알림 ${result.new_alert_count}건` : "";
      setMessage(`미송관리 반영 완료: 미송 ${addCount}건 / 미송픽업 ${pickupCount}건${alertMsg}`);
      fetchMisongLock(dateFilter);
    } catch (err) {
      setMessage(err.message || "미송 반영 실패");
    } finally {
      setMisongLoading(false);
    }
  };

  const handleUnlockMisong = async () => {
    if (!dateFilter) return;
    if (!window.confirm(`${dateFilter} 날짜의 미송관리 이동 잠금을 해제하시겠습니까? 해제하면 다시 이동을 실행할 수 있습니다.`)) return;
    setMisongUnlockLoading(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/noye-kimsungil/misong/move-lock?date=${encodeURIComponent(dateFilter)}`, {
        method: "DELETE",
        headers: getAuthHeaders(),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "잠금 해제 실패");
      setMessage(`${dateFilter} 날짜의 미송관리 이동 잠금을 해제했습니다.`);
      fetchMisongLock(dateFilter);
    } catch (err) {
      setMessage(err.message || "잠금 해제 실패");
    } finally {
      setMisongUnlockLoading(false);
    }
  };

  const doToIchae = async (includeBulk) => {
    if (!dateFilter) return;
    setIchaeConfirmMode(false);
    setIchaeLoading(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/wonbe/janggi/to-ichae`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ 날짜: dateFilter, include_bulk: includeBulk }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "이체파일 전환 실패");
      const bulkNote = includeBulk ? " (일괄이체 포함)" : "";
      setMessage(
        `이체파일 전환 완료${bulkNote}: 총 ${data.총거래처}개 거래처 → 매칭 ${data.매칭}건 / 미등록 ${data.미등록}건 `
        + `(신규 ${data.신규}건 · 갱신 ${data.갱신}건 · 삭제 ${data.삭제}건, ${data.저장행수}행 저장)`
      );
    } catch (err) {
      setMessage(err.message || "이체파일 전환 실패");
    } finally {
      setIchaeLoading(false);
    }
  };

  const handleBulkMark = async () => {
    if (!dateFilter) { setMessage("날짜를 먼저 선택하세요"); return; }
    if (!total) { setMessage("검색 결과가 없습니다"); return; }
    if (!window.confirm(`현재 검색 결과 ${total}건을 일괄이체목록으로 지정하시겠습니까?\n(이체파일 전환 시 기본 제외, 미송관리 이동은 정상 포함)`)) return;
    setBulkMarkLoading(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/wonbe/janggi/bulk-ichae-mark`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ 날짜: dateFilter, q: query, misong_filter: misongFilter }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "일괄이체 지정 실패");
      setMessage(`일괄이체목록 지정 완료: ${data.marked}건`);
      fetchRows(query, dateFilter, offset, misongFilter, ilgwalOnly, dateFrom, dateTo);
    } catch (err) {
      setMessage(err.message);
    } finally {
      setBulkMarkLoading(false);
    }
  };

  const handleBulkClear = async () => {
    if (!dateFilter) return;
    setBulkMarkLoading(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/wonbe/janggi/bulk-ichae-mark`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ 날짜: dateFilter }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "일괄이체 해제 실패");
      setMessage(`일괄이체 해제 완료: ${data.cleared}건`);
      fetchRows(query, dateFilter, offset, misongFilter, ilgwalOnly, dateFrom, dateTo);
    } catch (err) {
      setMessage(err.message);
    } finally {
      setBulkMarkLoading(false);
    }
  };

  const handleMoveToPurchaseManager = async () => {
    setPurchaseMoveLoading(true);
    setMessage("");
    try {
      const params = new URLSearchParams({
        q: query,
        date: dateFilter,
        misong_filter: "매입차감",
        offset: "0",
        limit: "10000",
      });
      const res = await fetch(`${API}/wonbe/janggi/search?${params}`, { headers: getAuthHeaders() });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "매입차감 목록 조회 실패");

      const targetMap = new Map();
      (data.rows || []).forEach((row) => {
        const vendor = String(row["거래처"] || "").trim();
        const rawAmount = Number(String(row["가격"] || "").replace(/[^\d.-]/g, "")) || 0;
        if (!vendor || rawAmount >= 0) return;
        const current = targetMap.get(vendor) || { vendor, amount: 0, memos: [], sourceCount: 0 };
        current.amount += Math.abs(rawAmount);
        const memo = String(row["메모"] || "").trim();
        if (memo && !current.memos.includes(memo)) current.memos.push(memo);
        current.sourceCount += 1;
        targetMap.set(vendor, current);
      });

      const targets = [...targetMap.values()].map((target) => ({
        vendor: target.vendor,
        amount: target.amount,
        memo: target.memos.join(" / "),
        sourceCount: target.sourceCount,
        date: dateFilter,
      }));
      if (!targets.length) throw new Error("이동할 음수 매입차감 금액이 없습니다.");

      localStorage.setItem("noye-kimsungil-purchase-deduction-handoff", JSON.stringify({
        targets,
        createdAt: new Date().toISOString(),
      }));
      localStorage.setItem("topMode", "home");
      localStorage.setItem("activeTab", "noye-kimsungil");
      localStorage.setItem("noye-kimsungil-active-tab", "purchase");
      window.location.reload();
    } catch (err) {
      setMessage(err.message || "매입관리 이동 실패");
      setPurchaseMoveLoading(false);
    }
  };

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  return (
    <>
      <div className={styles.controls}>
        <form onSubmit={handleSearch} style={{ display: "flex", gap: "0.5rem" }}>
          <input
            ref={searchInputRef}
            className={styles.searchInput}
            value={inputQuery}
            onChange={(e) => setInputQuery(e.target.value)}
            onKeyDown={handleSearchInputKeyDown}
            placeholder="거래처 / 거래처상품명 / 상품코드 (Ctrl+F, ↓로 표 진입)"
          />
          <button className={`${styles.btn} ${styles.btnPrimary}`} type="submit" disabled={loading}>검색</button>
        </form>
        <input
          type="date"
          className={styles.syncDateInput}
          value={dateFilter}
          onChange={(e) => { setDateFilter(e.target.value); setDateFrom(""); setDateTo(""); setOffset(0); setIchaeConfirmMode(false); }}
          disabled={loading}
          title="단일 날짜 (미송관리 이동/이체파일 전환 등 날짜 단위 작업에 사용)"
        />
        <span style={{ display: "flex", alignItems: "center", gap: "0.3rem" }}>
          <input
            type="date"
            className={styles.syncDateInput}
            value={dateFrom}
            onChange={(e) => { setDateFrom(e.target.value); setDateFilter(""); setOffset(0); setIchaeConfirmMode(false); }}
            disabled={loading}
            title="조회 시작일"
          />
          <span style={{ color: "var(--text-muted)", fontSize: "0.8rem" }}>~</span>
          <input
            type="date"
            className={styles.syncDateInput}
            value={dateTo}
            onChange={(e) => { setDateTo(e.target.value); setDateFilter(""); setOffset(0); setIchaeConfirmMode(false); }}
            disabled={loading}
            title="조회 종료일"
          />
        </span>
        <select
          value={misongFilter}
          onChange={(e) => { setMisongFilter(e.target.value); setOffset(0); }}
          disabled={loading}
          style={{ fontSize: "0.82rem", padding: "0.25rem 0.4rem", borderRadius: "0.3rem", border: "1px solid var(--border)", background: misongFilter ? "var(--primary-light, #eff6ff)" : "var(--bg-input, #fff)", cursor: "pointer" }}
        >
          <option value="">미송체크 전체</option>
          <option value="미송">미송만</option>
          <option value="미송픽업">미송픽업만</option>
          <option value="매입차감">매입차감만</option>
        </select>
        <button
          className={`${styles.btn} ${styles.btnSecondary}`}
          onClick={() => { setIlgwalOnly((v) => !v); setOffset(0); }}
          disabled={loading}
          style={{ background: ilgwalOnly ? "#eef2ff" : undefined, borderColor: ilgwalOnly ? "#4f46e5" : undefined, color: ilgwalOnly ? "#4f46e5" : undefined, fontWeight: ilgwalOnly ? 600 : undefined }}
          title="일괄이체 지정된 행만 보기"
        >
          일괄이체목록{ilgwalOnly ? " ✓" : ""}
        </button>
        {(query || dateFilter || dateFrom || dateTo || misongFilter || ilgwalOnly) && (
          <button className={`${styles.btn} ${styles.btnSecondary}`} onClick={() => { setInputQuery(""); setQuery(""); setDateFilter(""); setDateFrom(""); setDateTo(""); setMisongFilter(""); setIlgwalOnly(false); setOffset(0); setIchaeConfirmMode(false); }} disabled={loading}>
            필터 초기화
          </button>
        )}
        <button className={`${styles.btn} ${styles.btnSecondary}`} onClick={() => fetchRows(query, dateFilter, offset, misongFilter, ilgwalOnly, dateFrom, dateTo)} disabled={loading}>
          <RefreshCw size={13} />새로고침
        </button>
        <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={handleAddRow} disabled={loading}>
          <Plus size={13} />행 추가
        </button>
        <button className={`${styles.btn} ${styles.btnSecondary}`} onClick={() => { setProductSearch(""); setProductResults([]); setShowProductModal(true); }} disabled={loading} style={{ borderColor: "#7c3aed", color: "#7c3aed" }}>
          <PackagePlus size={13} />상품으로 추가
        </button>
        <button className={`${styles.btn} ${styles.btnSecondary}`} onClick={() => setDeductModal({ client: initialQuery || "", amount: "" })} disabled={loading} style={{ borderColor: "#dc2626", color: "#dc2626" }}>
          <Plus size={13} />매입차감 추가
        </button>
        <button className={`${styles.btn} ${styles.btnDanger}`} onClick={handleDeleteByDate} disabled={loading}>
          <Trash2 size={13} />날짜별 삭제
        </button>
        <button
          className={`${styles.btn} ${styles.btnPrimary}`}
          onClick={handleSendToMisong}
          disabled={!dateFilter || loading || misongLoading || misongLock?.locked}
          title={
            !dateFilter
              ? "날짜를 먼저 선택하세요"
              : misongLock?.locked
              ? `이미 이동 처리됨 (${misongLock.locked_by}, ${misongLock.locked_at})`
              : `${dateFilter} 미송/미송픽업 행을 미송관리에 반영`
          }
        >
          <PackagePlus size={13} />{misongLock?.locked ? "이동 완료됨" : "미송관리로 이동"}
        </button>
        {dateFilter && misongLock?.locked && (
          <button
            className={`${styles.btn} ${styles.btnSecondary}`}
            onClick={handleUnlockMisong}
            disabled={misongUnlockLoading}
            title={`${dateFilter} 날짜의 미송관리 이동 잠금 해제 (다시 실행 가능하게 함)`}
          >
            {misongUnlockLoading ? "해제 중..." : "이동 잠금 해제"}
          </button>
        )}
        <button
          className={`${styles.btn} ${styles.btnSecondary}`}
          onClick={handleBulkMark}
          disabled={!dateFilter || loading || bulkMarkLoading || !total}
          title={!dateFilter ? "날짜를 먼저 선택하세요" : "현재 검색 결과를 일괄이체목록으로 지정"}
        >
          {bulkMarkLoading ? "처리 중..." : "일괄이체목록 보내기"}
        </button>
        {dateFilter && (
          <button
            className={`${styles.btn} ${styles.btnDanger}`}
            onClick={handleBulkClear}
        {syncWonbeCost && ["이벤트전 할인가", "이벤트 할인가"].map((src) => (
          <button
            key={src}
            className={`${styles.btn} ${styles.btnSecondary}`}
            onClick={() => pushSearchPriceToAbly(src)}
            disabled={loading || pricePushLoading || rows.length === 0}
            title={`목록에 보이는 상품의 ${src === "이벤트 할인가" ? "이벤트 판매가" : "판매가"}로 에이블리 실제 상품가를 변경합니다`}
            style={{ borderColor: "#0891b2", color: "#0891b2" }}
          >
            {pricePushLoading ? "변경 중..." : `에이블리 상품가 변경 (${src === "이벤트 할인가" ? "이벤트가" : "판매가"})`}
          </button>
        ))}
            disabled={loading || bulkMarkLoading}
            title={`${dateFilter} 날짜의 일괄이체 지정 전체 해제`}
          >
            일괄이체 해제
          </button>
        )}
        {ichaeConfirmMode ? (
          <span style={{ display: "flex", gap: "0.35rem", alignItems: "center", background: "var(--bg-card, #f8fafc)", border: "1px solid var(--border)", borderRadius: "0.4rem", padding: "0.15rem 0.5rem" }}>
            <span style={{ fontSize: "0.75rem", color: "var(--text-muted)", whiteSpace: "nowrap" }}>전환 방식:</span>
            <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => doToIchae(false)} disabled={ichaeLoading} style={{ fontSize: "0.78rem" }}>
              {ichaeLoading ? "전환 중..." : "표준 전환"}
            </button>
            <button className={`${styles.btn} ${styles.btnSecondary}`} onClick={() => doToIchae(true)} disabled={ichaeLoading} style={{ fontSize: "0.78rem" }}>
              일괄이체 포함
            </button>
            <button className={`${styles.btn} ${styles.btnSecondary}`} onClick={() => setIchaeConfirmMode(false)} disabled={ichaeLoading} style={{ fontSize: "0.78rem" }}>
              취소
            </button>
          </span>
        ) : (
          <button
            className={`${styles.btn} ${styles.btnPrimary}`}
            onClick={() => { if (dateFilter && !loading && !ichaeLoading) setIchaeConfirmMode(true); }}
            disabled={!dateFilter || loading || ichaeLoading}
            title={!dateFilter ? "날짜를 먼저 선택하세요" : `${dateFilter} 데이터를 이체파일로 전환`}
          >
            이체파일 전환
          </button>
        )}
        <span className={styles.pill}>{total.toLocaleString()}행</span>
      </div>

      {message && <div className={styles.message}>{message}</div>}

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th style={{ width: "2rem" }} />
              {COLS.map((col) => (
                <th key={col} className={styles.sortableHeader} onClick={() => handleSort(col)}>
                  {col} ✎{sortCol === col ? <span className={styles.sortIcon}>{sortDir === "asc" ? "▲" : "▼"}</span> : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((row) => (
              <tr
                key={row.id}
                id={`janggi-row-${row.id}`}
                style={row["일괄이체"] === "Y" ? { background: "#eef2ff" } : undefined}
                className={selectedRowIds.has(row.id) ? styles.rowSelected : undefined}
              >
                <td style={{ textAlign: "center", padding: "0.25rem" }}>
                  <button
                    onClick={() => handleDeleteRow(row.id)}
                    style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", padding: "0.15rem", lineHeight: 1, borderRadius: "3px" }}
                    title="행 삭제"
                    onMouseEnter={(e) => e.currentTarget.style.color = "#b91c1c"}
                    onMouseLeave={(e) => e.currentTarget.style.color = "var(--text-muted)"}
                  >
                    <X size={12} />
                  </button>
                  {row["일괄이체"] === "Y" && (
                    <button
                      onClick={async () => {
                        try {
                          const res = await fetch(`${API}/wonbe/janggi/bulk-ichae-mark`, {
                            method: "DELETE",
                            headers: { "Content-Type": "application/json", ...getAuthHeaders() },
                            body: JSON.stringify({ id: row.id }),
                          });
                          const data = await res.json().catch(() => ({}));
                          if (!res.ok || !data.ok) throw new Error(data?.detail || "해제 실패");
                          setRows((prev) => prev.map((r) => r.id === row.id ? { ...r, 일괄이체: "" } : r));
                        } catch (err) {
                          setMessage(err.message);
                        }
                      }}
                      style={{ background: "none", border: "none", cursor: "pointer", fontSize: "0.6rem", color: "#4f46e5", fontWeight: 600, display: "block", lineHeight: 1, padding: "1px 0", width: "100%" }}
                      title="일괄이체 지정 해제"
                    >
                      일괄×
                    </button>
                  )}
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
                          onKeyUp={(e) => { if (e.key === "Alt") e.preventDefault(); }}
                        />
                      </td>
                    );
                  }
                  const isSelectedCell = selectedCell?.id === row.id && selectedCell?.col === col;
                  return (
                    <td
                      key={col}
                      className={`${styles.editableCell}${isSelectedCell ? ` ${styles.cellSelected}` : ""}`}
                      onClick={(e) => handleCellClick(e, row, col)}
                      title="클릭하여 수정 (Ctrl/Shift+클릭: 행 다중선택)"
                    >
                      {row[col] ?? ""}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
          {sortedRows.length > 0 && (
            <tfoot>
              <tr>
                <td style={{ position: "sticky", bottom: 0, background: "var(--surface, #f3f4f6)", borderTop: "2px solid var(--border, #d1d5db)" }} />
                {COLS.map((col) => (
                  <td
                    key={col}
                    style={{ fontWeight: 700, position: "sticky", bottom: 0, background: "var(--surface, #f3f4f6)", borderTop: "2px solid var(--border, #d1d5db)" }}
                  >
                    {col === "거래처" ? "페이지 합계" : col === "개수" ? Math.round(sortedRows.reduce((s, r) => s + _parsePrice(r.개수), 0)).toLocaleString() : col === "가격" ? Math.round(sortedRows.reduce((s, r) => s + _parsePrice(r.가격), 0)).toLocaleString() : ""}
                  </td>
                ))}
              </tr>
            </tfoot>
          )}
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

      {misongFilter === "매입차감" && (
        <button
          className={`${styles.btn} ${styles.btnPrimary}`}
          onClick={handleMoveToPurchaseManager}
          disabled={loading || purchaseMoveLoading || !total}
          style={{
            position: "fixed",
            right: "24px",
            bottom: "24px",
            zIndex: 30,
            minHeight: "44px",
            padding: "0 18px",
            boxShadow: "0 10px 28px rgba(15, 23, 42, 0.2)",
          }}
        >
          {purchaseMoveLoading ? "이동 중..." : "매입관리로 이동"}
        </button>
      )}

      {deductModal && (
        <div
          onClick={() => !deductSaving && setDeductModal(null)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 1100, display: "flex", alignItems: "center", justifyContent: "center" }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ background: "var(--surface, #fff)", color: "var(--text-primary)", borderRadius: 10, boxShadow: "0 8px 32px rgba(0,0,0,0.22)", width: "min(380px, 94vw)", padding: "1rem" }}
          >
            <div style={{ fontWeight: 700, marginBottom: "0.7rem" }}>매입차감 추가 <span style={{ fontWeight: 400, fontSize: "0.8rem", color: "var(--text-muted)" }}>· {dateFilter || _todayLocal()}</span></div>
            <label style={{ display: "block", fontSize: "0.8rem", marginBottom: "0.2rem" }}>거래처</label>
            <input
              autoFocus={!deductModal.client}
              value={deductModal.client}
              onChange={(e) => setDeductModal((m) => ({ ...m, client: e.target.value }))}
              style={{ width: "100%", boxSizing: "border-box", padding: "0.4rem 0.5rem", border: "1px solid var(--border, #d1d5db)", borderRadius: 6, background: "var(--input-bg, #f9fafb)", color: "inherit", marginBottom: "0.6rem" }}
            />
            <label style={{ display: "block", fontSize: "0.8rem", marginBottom: "0.2rem" }}>금액 <span style={{ color: "var(--text-muted)" }}>(1000 입력 → -1000으로 저장)</span></label>
            <input
              autoFocus={!!deductModal.client}
              inputMode="numeric"
              value={deductModal.amount}
              onChange={(e) => setDeductModal((m) => ({ ...m, amount: e.target.value }))}
              onKeyDown={(e) => { if (e.key === "Enter") saveDeduct(); }}
              style={{ width: "100%", boxSizing: "border-box", padding: "0.4rem 0.5rem", border: "1px solid var(--border, #d1d5db)", borderRadius: 6, background: "var(--input-bg, #f9fafb)", color: "inherit" }}
            />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem", marginTop: "0.9rem" }}>
              <button className={`${styles.btn} ${styles.btnSecondary}`} onClick={() => setDeductModal(null)} disabled={deductSaving}>취소</button>
              <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={saveDeduct} disabled={deductSaving || !deductModal.client.trim() || !String(deductModal.amount).trim()}>{deductSaving ? "저장 중..." : "확인"}</button>
            </div>
          </div>
        </div>
      )}

      {showProductModal && (
        <div
          onClick={() => setShowProductModal(false)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 1000, display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: "5vh" }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ background: "var(--surface, #fff)", borderRadius: "10px", boxShadow: "0 8px 32px rgba(0,0,0,0.22)", width: "min(720px, 95vw)", maxHeight: "80vh", display: "flex", flexDirection: "column", overflow: "hidden" }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", padding: "0.9rem 1rem", borderBottom: "1px solid var(--border, #e5e7eb)" }}>
              <PackagePlus size={16} style={{ color: "#7c3aed", flexShrink: 0 }} />
              <span style={{ fontWeight: 700, fontSize: "0.95rem" }}>원가베이스유에서 상품 추가</span>
              <div style={{ flex: 1, position: "relative" }}>
                <Search size={13} style={{ position: "absolute", left: "0.5rem", top: "50%", transform: "translateY(-50%)", color: "var(--text-muted, #888)", pointerEvents: "none" }} />
                <input
                  ref={productSearchRef}
                  value={productSearch}
                  onChange={(e) => setProductSearch(e.target.value)}
                  placeholder="거래처합·상품코드·상품명합 검색…"
                  style={{ width: "100%", padding: "0.4rem 0.5rem 0.4rem 1.8rem", border: "1px solid var(--border, #d1d5db)", borderRadius: "6px", fontSize: "0.83rem", outline: "none", background: "var(--input-bg, #f9fafb)" }}
                />
              </div>
              <button onClick={() => setShowProductModal(false)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted, #888)", padding: "0.2rem", lineHeight: 1 }}>
                <X size={16} />
              </button>
            </div>
            <div style={{ overflowY: "auto", flex: 1 }}>
              {productSearchLoading ? (
                <div style={{ padding: "2rem", textAlign: "center", color: "var(--text-muted, #888)", fontSize: "0.85rem" }}>검색 중…</div>
              ) : productResults.length === 0 ? (
                <div style={{ padding: "2rem", textAlign: "center", color: "var(--text-muted, #888)", fontSize: "0.85rem" }}>
                  {productSearch.trim() ? "검색 결과가 없습니다." : "키워드를 입력하면 거래처합·상품코드·상품명합으로 검색됩니다."}
                </div>
              ) : (
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8rem" }}>
                  <thead>
                    <tr style={{ background: "var(--table-header, #f3f4f6)", position: "sticky", top: 0 }}>
                      {["거래처합", "거래처", "색상", "사이즈", "원가"].map((h) => (
                        <th key={h} style={{ padding: "0.45rem 0.6rem", textAlign: "left", fontWeight: 600, borderBottom: "1px solid var(--border, #e5e7eb)", whiteSpace: "nowrap" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {productResults.map((row, i) => (
                      <tr
                        key={i}
                        onClick={() => addFromProduct(row)}
                        style={{ cursor: "pointer", borderBottom: "1px solid var(--border, #f0f0f0)" }}
                        onMouseEnter={(e) => e.currentTarget.style.background = "#f5f3ff"}
                        onMouseLeave={(e) => e.currentTarget.style.background = ""}
                      >
                        <td style={{ padding: "0.4rem 0.6rem", fontWeight: 600 }}>{row["거래처합"] ?? ""}</td>
                        <td style={{ padding: "0.4rem 0.6rem", color: "var(--text-muted, #666)" }}>{row["거래처"] ?? ""}</td>
                        <td style={{ padding: "0.4rem 0.6rem" }}>{row["색상"] ?? ""}</td>
                        <td style={{ padding: "0.4rem 0.6rem" }}>{row["사이즈"] ?? ""}</td>
                        <td style={{ padding: "0.4rem 0.6rem", fontWeight: 700, color: "#1d4ed8" }}>{row["원가"] ?? ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div style={{ padding: "0.5rem 1rem", borderTop: "1px solid var(--border, #e5e7eb)", fontSize: "0.75rem", color: "var(--text-muted, #888)" }}>
              행을 클릭하면 날짜 <strong>{dateFilter || "오늘"}</strong>로 장끼정리에 추가됩니다
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/* ── TOP비교 탭 ──────────────────────────────────────────────── */
function JanggiTopComparison() {
  // DB 금액은 항상 서버(DB)에서 직접 읽는다 - localStorage 캐시를 쓰면 DB와 값이 어긋난다
  const [dbDate, setDbDate] = useState(null);
  const [dbRows, setDbRows] = useState([]);
  const [topDate, setTopDate] = useState(null);
  const [topShops, setTopShops] = useState([]);
  const [topNotes, setTopNotes] = useState({});
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [dbLoaded, setDbLoaded] = useState(false);
  const [topLoaded, setTopLoaded] = useState(false);
  const [selDate, setSelDate] = useState(""); // 조회/비교 기준 날짜 (빈 값 = DB 최근날짜 / 오늘)
  const selDateRef = useRef("");
  const [clientView, setClientView] = useState(null); // { client, date, rows, loading, error } - 거래처 클릭 시 그날의 장끼 DB 행
  // 확인완료 표시는 서버에 공유 저장 (다른 PC에서 누른 것도 조회/창 복귀 시 반영)
  const [checkedRows, setCheckedRows] = useState(() => new Set());
  const [dismissed, setDismissed] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem("janggi_top_dismissed") || "[]")); } catch { return new Set(); }
  });
  const [aliasMap, setAliasMap] = useState({});
  const [showAliasPanel, setShowAliasPanel] = useState(false);
  const [aliasLeft, setAliasLeft] = useState("");
  const [aliasRight, setAliasRight] = useState("");
  const [accountSet, setAccountSet] = useState(new Set());
  const [accountLoaded, setAccountLoaded] = useState(false);
  const [addingAccountFor, setAddingAccountFor] = useState(null);
  const [accountForm, setAccountForm] = useState({ bank: "", accountNumber: "", owner: "", vatStatus: "" });
  const [accountSaving, setAccountSaving] = useState(false);
  const [colWidths, setColWidths] = useState({});
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedMatchIndex, setSelectedMatchIndex] = useState(0);
  const [scrollTrigger, setScrollTrigger] = useState(0);
  const searchInputRef = useRef(null);
  const selectedRowRef = useRef(null);

  useEffect(() => {
    if (!dbLoaded) {
      setSearchOpen(false);
      setSearchTerm("");
      return;
    }
    const onKeyDown = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        // 검색창이 이미 열려 있으면(input이 이미 DOM에 있으면) 여기서 바로
        // 포커스+전체선택 - searchOpen이 true→true라 아래 effect는 재실행되지 않는다
        if (searchInputRef.current) {
          searchInputRef.current.focus();
          searchInputRef.current.select();
        }
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dbLoaded]);

  useEffect(() => {
    if (searchOpen) {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    }
  }, [searchOpen]);

  useEffect(() => {
    setSelectedMatchIndex(0);
  }, [searchTerm]);

  useEffect(() => {
    fetch(`${API}/wonbe/janggi/top-col-widths`, { headers: getAuthHeaders() })
      .then((r) => r.json())
      .then((d) => { if (d.ok) setColWidths(d.widths || {}); })
      .catch(() => {});
  }, []);

  const saveColWidths = (widths) => {
    fetch(`${API}/wonbe/janggi/top-col-widths`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...getAuthHeaders() },
      body: JSON.stringify({ widths }),
    }).catch(() => {});
  };

  const startColResize = (colKey) => (e) => {
    e.preventDefault();
    const th = e.currentTarget.closest("th");
    const startWidth = colWidths[colKey] ?? th.getBoundingClientRect().width;
    const startX = e.clientX;
    let latest = startWidth;
    document.body.style.cursor = "ew-resize";
    document.body.style.userSelect = "none";
    const onMove = (moveEvent) => {
      latest = Math.min(500, Math.max(50, startWidth + (moveEvent.clientX - startX)));
      setColWidths((prev) => ({ ...prev, [colKey]: latest }));
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setColWidths((prev) => {
        const next = { ...prev, [colKey]: latest };
        saveColWidths(next);
        return next;
      });
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  const resizableTh = (colKey, label, extraStyle) => (
    <th className={topStyles.thResizable} style={{ width: colWidths[colKey], paddingRight: "1.1rem", ...extraStyle }}>
      {label}
      <span className={topStyles.resizeHandle} onMouseDown={startColResize(colKey)} title="드래그하여 너비 조정" />
    </th>
  );

  const resizedTdStyle = (colKey, extraStyle) => {
    const w = colWidths[colKey];
    if (w == null) return extraStyle;
    return { ...extraStyle, width: w, maxWidth: w, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
  };

  useEffect(() => {
    fetch(`${API}/wonbe/janggi/aliases`, { headers: getAuthHeaders() })
      .then((r) => r.json())
      .then((d) => { if (d.ok) setAliasMap(d.aliases || {}); })
      .catch(() => {});
  }, []);

  const fetchAccountSet = useCallback(async () => {
    try {
      const res = await fetch(`${API}/wonbe/account/rows`, { headers: getAuthHeaders() });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        setAccountSet(new Set((data.rows || []).map((r) => String(r.A || "").trim()).filter(Boolean)));
      }
    } catch {
      // 계좌 데이터 조회 실패 시 미등록 표시를 비활성화한 채로 둔다
    } finally {
      setAccountLoaded(true);
    }
  }, []);

  useEffect(() => { fetchAccountSet(); }, [fetchAccountSet]);

  const hasAccount = (name) => accountSet.has(String(name || "").trim());

  const openAccountForm = (name) => {
    setAddingAccountFor(name);
    setAccountForm({ bank: "", accountNumber: "", owner: "", vatStatus: "" });
  };

  const closeAccountForm = () => {
    setAddingAccountFor(null);
    setAccountForm({ bank: "", accountNumber: "", owner: "", vatStatus: "" });
  };

  const saveAccount = async (name) => {
    const bank = accountForm.bank.trim();
    const accountNumber = accountForm.accountNumber.trim();
    const owner = accountForm.owner.trim();
    const vatStatus = accountForm.vatStatus.trim();
    if (!bank || !accountNumber || !owner || !vatStatus) return;
    setAccountSaving(true);
    try {
      const res = await fetch(`${API}/wonbe/account/row`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ A: name, C: accountNumber, D: bank, E: owner, F: vatStatus }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "계좌 추가 실패");
      setAccountSet((prev) => new Set([...prev, String(name).trim()]));
      const bankCode = data.row?.B || "";
      setMessage(
        bankCode
          ? `계좌 등록 완료: ${name} (은행코드 ${bankCode} 자동 적용됨)`
          : `계좌 등록 완료: ${name} (은행코드 자동 매칭 실패 - 거래처계좌데이터에서 B열을 직접 입력하세요)`
      );
      closeAccountForm();
    } catch (err) {
      setMessage(err.message || "계좌 추가 실패");
    } finally {
      setAccountSaving(false);
    }
  };

  const saveAliases = (map) => {
    setAliasMap(map);
    fetch(`${API}/wonbe/janggi/aliases`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...getAuthHeaders() },
      body: JSON.stringify({ aliases: map }),
    }).catch(() => {});
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

  const loadChecked = useCallback(async () => {
    try {
      const res = await fetch(`${API}/wonbe/janggi/top-checked`, { headers: getAuthHeaders(), cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) setCheckedRows(new Set(data.names || []));
    } catch { /* 조용히 무시 */ }
  }, []);

  const toggleCheck = (name) => {
    const willCheck = !checkedRows.has(name);
    setCheckedRows((prev) => {
      const next = new Set(prev);
      if (willCheck) next.add(name);
      else next.delete(name);
      return next;
    });
    fetch(`${API}/wonbe/janggi/top-checked`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...getAuthHeaders() },
      body: JSON.stringify({ name, checked: willCheck }),
    }).catch(() => loadChecked());
  };

  const resetChecked = () => {
    if (!window.confirm("모든 거래처의 확인완료 표시를 초기화하시겠습니까? (모든 PC에 적용됩니다)")) return;
    setCheckedRows(new Set());
    fetch(`${API}/wonbe/janggi/top-checked`, { method: "DELETE", headers: getAuthHeaders() }).catch(() => loadChecked());
  };

  const handleSearchKeyDown = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setSearchOpen(false);
      setSearchTerm("");
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (!searchMatches.length) return;
      const dir = e.shiftKey ? -1 : 1;
      setSelectedMatchIndex((i) => (i + dir + searchMatches.length) % searchMatches.length);
      setScrollTrigger((t) => t + 1);
      return;
    }
    if (e.key === " ") {
      e.preventDefault();
      if (selectedMatch) toggleCheck(selectedMatch.거래처);
    }
  };

  const loadDb = async (dateArg) => {
    const useDate = typeof dateArg === "string" ? dateArg : selDate;
    setLoading(true);
    setMessage("DB 조회 중...");
    setDbLoaded(false);
    setTopLoaded(false);
    setTopShops([]);
    setTopNotes({});
    setTopDate(null);
    setDismissed(new Set());
    localStorage.removeItem("janggi_top_dismissed");
    try {
      const res = await fetch(`${API}/wonbe/janggi/recent-summary?date=${encodeURIComponent(useDate || "")}`, { headers: getAuthHeaders(), cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "DB 조회 실패");
      setDbDate(data.date);
      setDbRows(data.rows || []);
      setDbLoaded(true);
      setMessage("");
      loadChecked();
      fetchAccountSet();
      try { localStorage.removeItem("janggi_top_cache"); } catch { /* ignore */ }
    } catch (err) {
      setMessage(err.message || "조회 실패");
    } finally {
      setLoading(false);
    }
  };

  // 마운트 시 자동 조회 + 탭/창으로 돌아올 때 DB 금액만 조용히 재조회(TOP/확인 상태는 유지)
  const refreshDbQuiet = useCallback(async () => {
    try {
      const res = await fetch(`${API}/wonbe/janggi/recent-summary?date=${encodeURIComponent(selDateRef.current || "")}`, { headers: getAuthHeaders(), cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        setDbDate(data.date);
        setDbRows(data.rows || []);
        setDbLoaded(true);
      }
    } catch { /* 조용히 무시 */ }
    loadChecked();
  }, [loadChecked]);

  useEffect(() => {
    refreshDbQuiet();
    const onVisible = () => { if (document.visibilityState === "visible") refreshDbQuiet(); };
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refreshDbQuiet]);

  const openClientView = (client) => {
    const date = dbDate || selDate;
    if (!date) return;
    setClientView({ client, date });
  };
  const closeClientView = useCallback(() => {
    setClientView(null);
    refreshDbQuiet(); // 팝업에서 수정/추가/삭제한 내용을 TOP비교 합산금액에 반영
  }, [refreshDbQuiet]);

  // Esc로 팝업 닫기 (셀 수정 중이거나 입력칸/선택박스에 포커스가 있을 때의 Esc는 그쪽 취소 동작에 맡긴다)
  useEffect(() => {
    if (!clientView) return undefined;
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      closeClientView();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [clientView, closeClientView]);

  const loadTop = async () => {
    setLoading(true);
    setMessage("TOP90 조회 중...");
    try {
      const res = await fetch(`${API}/wonbe/janggi/top-shops?date=${encodeURIComponent(selDate || dbDate || "")}`, { headers: getAuthHeaders() });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "TOP90 조회 실패");
      setTopDate(data.date);
      setTopShops(data.shops || []);
      setTopNotes(data.notes || {});
      setTopLoaded(true);
      setMessage("");
    } catch (err) {
      setMessage(err.message || "TOP90 조회 실패");
    } finally {
      setLoading(false);
    }
  };

  const dbSet = new Set(dbRows.map((r) => r.거래처));
  const topSet = new Set(topShops);

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

  const sortedDbRows = [...dbRows].sort((a, b) => (a.거래처 || "").localeCompare(b.거래처 || "", "ko"));

  const normalizeSearchName = (v) => String(v || "").replace(/\s+/g, "").toLowerCase();
  const searchMatches = useMemo(() => {
    const term = normalizeSearchName(searchTerm);
    if (!term) return [];
    return sortedDbRows.filter((r) => normalizeSearchName(r.거래처).includes(term));
  }, [sortedDbRows, searchTerm]);
  const selectedMatch = searchMatches[selectedMatchIndex] || null;

  useEffect(() => {
    // 타이핑할 때마다(첫 매칭 자동 선택 포함) 스크롤이 움직이면 산만하므로,
    // Enter/Shift+Enter로 다음 매칭을 넘길 때(scrollTrigger 증가)만 이동시킨다.
    if (scrollTrigger === 0) return;
    selectedRowRef.current?.scrollIntoView({ block: "center", behavior: "instant" });
  }, [scrollTrigger]);

  const visibleTopShops = topShops
    .filter((s) => !dismissed.has(`top:${s}`))
    .sort((a, b) => (a || "").localeCompare(b || "", "ko"));

  const checkedCount = sortedDbRows.filter((r) => checkedRows.has(r.거래처)).length;
  const dbTotal = sortedDbRows.reduce((s, r) => s + (r.합산 ?? 0), 0);

  const matchCount = topLoaded ? sortedDbRows.filter((r) => dbMatchesTop(r.거래처)).length : 0;
  const dbOnlyCount = topLoaded ? sortedDbRows.filter((r) => !dbMatchesTop(r.거래처)).length : 0;
  const topOnlyCount = topLoaded ? visibleTopShops.filter((s) => !topMatchesDb(s)).length : 0;
  const accountMissingCount = accountLoaded ? sortedDbRows.filter((r) => !hasAccount(r.거래처)).length : 0;

  return (
    <div className={topStyles.root}>
      <div className={topStyles.toolbar}>
        <input
          type="date"
          value={selDate}
          max={_todayLocal()}
          onChange={(e) => { setSelDate(e.target.value); selDateRef.current = e.target.value; }}
          disabled={loading}
          title="조회/비교 기준 날짜 (비우면 DB 최근날짜 / 오늘)"
          style={{ padding: "0.3rem 0.45rem", borderRadius: "6px", border: "1px solid var(--border-color)", background: "var(--bg-secondary)", color: "var(--text-primary)", fontSize: "0.8rem" }}
        />
        {selDate && (
          <button className={`${styles.btn} ${styles.btnSecondary}`} onClick={() => { setSelDate(""); selDateRef.current = ""; loadDb(""); }} disabled={loading} title="날짜 선택 해제 (DB 최근날짜로)">최근</button>
        )}
        <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => loadDb()} disabled={loading}>
          <GitCompare size={13} />{loading && !topLoaded ? "조회 중..." : "조회"}
        </button>
        <button
          className={`${styles.btn} ${styles.btnSecondary}`}
          onClick={loadTop}
          disabled={!dbLoaded || loading}
          title={!dbLoaded ? "먼저 조회를 실행하세요" : "TOP90 완료 매장과 비교"}
        >
          <GitCompare size={13} />{loading && !dbLoaded ? "조회 중..." : "비교"}
        </button>
        <button
          className={`${styles.btn} ${showAliasPanel ? styles.btnPrimary : styles.btnSecondary}`}
          onClick={() => setShowAliasPanel((v) => !v)}
        >
          <SlidersHorizontal size={13} />
          거래처 별칭{Object.keys(aliasMap).length > 0 ? ` (${Object.keys(aliasMap).length})` : ""}
        </button>
        {dbLoaded && checkedCount > 0 && (
          <button className={`${styles.btn} ${styles.btnSecondary}`} onClick={resetChecked}>
            확인완료 초기화
          </button>
        )}
        {dbLoaded && (
          <div className={topStyles.summary}>
            <span className={topStyles.badgeOrange}>확인 {checkedCount}/{sortedDbRows.length}</span>
            {topLoaded && <span className={topStyles.badgeGreen}>일치 {matchCount}건</span>}
            {topLoaded && dbOnlyCount > 0 && <span className={topStyles.badgeOrange}>DB만 {dbOnlyCount}건</span>}
            {topLoaded && topOnlyCount > 0 && <span className={topStyles.badgeBlue}>TOP만 {topOnlyCount}건</span>}
            {accountLoaded && accountMissingCount > 0 && <span className={topStyles.badgeOrange}>계좌 미등록 {accountMissingCount}건</span>}
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

      {dbLoaded && (
        <div className={topLoaded ? topStyles.panels : undefined} style={!topLoaded ? { maxWidth: "520px" } : undefined}>
          {/* DB 패널 */}
          <div className={topStyles.panel}>
            <div className={topStyles.panelHeader}>
              DB 날짜별장끼정리
              <span className={topStyles.panelDate}>
                {dbDate}
                {dbTotal > 0 && <span style={{ marginLeft: "0.75rem", fontWeight: 700, color: "var(--text-primary)" }}>합계 {Math.round(dbTotal).toLocaleString()}원</span>}
              </span>
            </div>
            {searchOpen && (
              <div className={topStyles.searchBar}>
                <input
                  ref={searchInputRef}
                  className={topStyles.searchInput}
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  onKeyDown={handleSearchKeyDown}
                  placeholder="거래처 검색... (Esc로 닫기)"
                />
                <span className={topStyles.searchCount}>
                  {searchMatches.length ? `${selectedMatchIndex + 1}/${searchMatches.length}` : "0/0"}
                </span>
                <button
                  className={topStyles.searchClose}
                  onClick={() => { setSearchOpen(false); setSearchTerm(""); }}
                  title="검색 닫기"
                >
                  <X size={14} />
                </button>
              </div>
            )}
            <div className={topStyles.panelScroll}>
            <table className={topStyles.table}>
              <thead>
                <tr>
                  {resizableTh("거래처", "거래처")}
                  {resizableTh("합산금액", "합산금액", { textAlign: "right" })}
                  {resizableTh("확인", "확인")}
                  {resizableTh("계좌", "계좌")}
                  {topLoaded && resizableTh("TOP비교", "TOP 비교")}
                </tr>
              </thead>
              <tbody>
                {sortedDbRows.map((r) => {
                  const checked = checkedRows.has(r.거래처);
                  const matched = topLoaded && dbMatchesTop(r.거래처);
                  const accountOk = hasAccount(r.거래처);
                  const isAddingAccount = addingAccountFor === r.거래처;
                  const isSearchSelected = !!selectedMatch && r.거래처 === selectedMatch.거래처;
                  let rowClass = "";
                  if (checked) rowClass = topStyles.rowChecked;
                  else if (topLoaded) rowClass = matched ? topStyles.rowMatch : topStyles.rowDbOnly;
                  return (
                    <React.Fragment key={r.거래처}>
                      <tr
                        ref={isSearchSelected ? selectedRowRef : null}
                        className={`${rowClass}${isSearchSelected ? ` ${topStyles.rowSearchSelected}` : ""}`}
                      >
                        <td
                          style={resizedTdStyle("거래처", {
                            textDecoration: checked ? "line-through" : undefined,
                            opacity: checked ? 0.6 : 1,
                          })}
                          title={`${r.거래처} - 클릭하면 ${dbDate || ""} 장끼 DB 내역 보기`}
                          onClick={() => openClientView(r.거래처)}
                        >
                          <span style={{ cursor: "pointer" }}>{r.거래처}</span>
                        </td>
                        <td
                          style={resizedTdStyle("합산금액", { textAlign: "right", fontWeight: 600 })}
                          title={`DB ${r.건수 ?? "?"}건 합계 (일괄이체 ${Math.round(r.일괄이체 || 0).toLocaleString()}원 포함${r.파싱불가 ? `, 비정상 가격 ${r.파싱불가}건` : ""})`}
                        >
                          {r.합산 != null ? Math.round(r.합산).toLocaleString() : ""}
                          {r.파싱불가 > 0 && <span style={{ color: "#dc2626" }} title="숫자가 아닌 가격 값이 있어 합계가 달라질 수 있음"> ⚠</span>}
                        </td>
                        <td style={resizedTdStyle("확인")}>
                          <button
                            className={checked ? topStyles.confirmBtnDone : topStyles.confirmBtn}
                            onClick={() => toggleCheck(r.거래처)}
                          >
                            {checked ? "✓ 완료" : "확인완료"}
                          </button>
                        </td>
                        <td style={resizedTdStyle("계좌")}>
                          {accountOk ? "✓ 등록됨" : (
                            <span style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                              ⚠ 미등록
                              <button
                                className={topStyles.confirmBtn}
                                onClick={() => (isAddingAccount ? closeAccountForm() : openAccountForm(r.거래처))}
                              >
                                {isAddingAccount ? "닫기" : "계좌추가"}
                              </button>
                            </span>
                          )}
                        </td>
                        {topLoaded && (
                          <td style={resizedTdStyle("TOP비교")}>
                            {matched ? "✓ 일치" : (
                              <span style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                                ⚠ DB만
                                <button className={topStyles.confirmBtn} onClick={() => dismiss("db", r.거래처)}>숨기기</button>
                              </span>
                            )}
                          </td>
                        )}
                      </tr>
                      {isAddingAccount && (
                        <tr>
                          <td colSpan={topLoaded ? 5 : 4} style={{ background: "var(--bg-secondary)", padding: "0.5rem 0.75rem" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                              <input
                                className={topStyles.aliasInput}
                                style={{ width: "110px" }}
                                placeholder="은행"
                                value={accountForm.bank}
                                onChange={(e) => setAccountForm((p) => ({ ...p, bank: e.target.value }))}
                                autoFocus
                              />
                              <input
                                className={topStyles.aliasInput}
                                style={{ width: "160px" }}
                                placeholder="계좌번호"
                                value={accountForm.accountNumber}
                                onChange={(e) => setAccountForm((p) => ({ ...p, accountNumber: e.target.value }))}
                              />
                              <input
                                className={topStyles.aliasInput}
                                style={{ width: "110px" }}
                                placeholder="예금주"
                                value={accountForm.owner}
                                onChange={(e) => setAccountForm((p) => ({ ...p, owner: e.target.value }))}
                                onKeyDown={(e) => e.key === "Enter" && saveAccount(r.거래처)}
                              />
                              <select
                                className={topStyles.aliasInput}
                                style={{ width: "110px" }}
                                value={accountForm.vatStatus}
                                onChange={(e) => setAccountForm((p) => ({ ...p, vatStatus: e.target.value }))}
                                aria-label="부가세 유무"
                              >
                                <option value="">부가세 유무</option>
                                <option value="유">부가세 유</option>
                                <option value="무">부가세 무</option>
                              </select>
                              <button
                                className={`${styles.btn} ${styles.btnPrimary}`}
                                onClick={() => saveAccount(r.거래처)}
                                disabled={accountSaving || !accountForm.bank.trim() || !accountForm.accountNumber.trim() || !accountForm.owner.trim() || !accountForm.vatStatus.trim()}
                              >
                                {accountSaving ? "저장 중..." : "저장"}
                              </button>
                              <button className={`${styles.btn} ${styles.btnSecondary}`} onClick={closeAccountForm} disabled={accountSaving}>
                                취소
                              </button>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
                {!sortedDbRows.length && <tr><td colSpan={topLoaded ? 5 : 4} style={{ textAlign: "center", color: "var(--text-muted)", padding: "1rem" }}>데이터 없음</td></tr>}
              </tbody>
              {sortedDbRows.length > 0 && (
                <tfoot>
                  <tr>
                    {[
                      <td key="l" style={{ fontWeight: 700 }}>합계 ({sortedDbRows.length}개 거래처)</td>,
                      <td key="a" style={{ textAlign: "right", fontWeight: 700 }}>
                        {Math.round(sortedDbRows.reduce((s, r) => s + (Number(r.합산) || 0), 0)).toLocaleString()}
                      </td>,
                      <td key="e" colSpan={topLoaded ? 3 : 2} />,
                    ].map((cell) => React.cloneElement(cell, {
                      style: {
                        ...cell.props.style,
                        position: "sticky",
                        bottom: 0,
                        background: "var(--surface, #f3f4f6)",
                        borderTop: "2px solid var(--border, #d1d5db)",
                      },
                    }))}
                  </tr>
                </tfoot>
              )}
            </table>
            </div>
          </div>

          {/* TOP 패널 - 비교 버튼 눌렀을 때만 표시 */}
          {topLoaded && (
            <div className={topStyles.panel}>
              <div className={topStyles.panelHeader}>
                TOP90 완료 매장
                <span className={topStyles.panelDate}>{topDate}</span>
              </div>
              <div className={topStyles.panelScroll}>
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
                              <button className={topStyles.confirmBtn} onClick={() => dismiss("top", s)}>숨기기</button>
                            </span>
                          )}
                          {!matched && (topNotes[s] || []).map((n, i) => (
                            <div key={i} style={{ marginTop: "0.3rem", fontSize: "0.85em", lineHeight: 1.4 }}>
                              {n.reply && (
                                <div>
                                  <b>{n.reply}</b>
                                  <span style={{ color: "var(--text-muted)" }}> {n.time} | 매장답변</span>
                                </div>
                              )}
                              {n.question && <div style={{ color: "var(--text-muted)" }}>{n.question}</div>}
                            </div>
                          ))}
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
      )}
      {clientView && (
        <div
          onClick={closeClientView}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ background: "var(--bg-primary, var(--bg-secondary, #fff))", color: "var(--text-primary)", borderRadius: 10, padding: "0.7rem 0.8rem", width: "min(1150px, 92vw)", maxHeight: "78vh", overflow: "auto", fontSize: "0.85rem", boxShadow: "0 10px 40px rgba(0,0,0,0.3)" }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", marginBottom: "0.6rem" }}>
              <b style={{ fontSize: "1rem" }}>{clientView.client}</b>
              <span style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>{clientView.date} · 날짜별장끼정리 목록과 동일 (수정은 DB에 바로 저장)</span>
              <button className={styles.btn} style={{ marginLeft: "auto" }} onClick={closeClientView}>닫기</button>
            </div>
            <JanggiListView initialQuery={clientView.client} initialDate={clientView.date} syncWonbeCost />
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
