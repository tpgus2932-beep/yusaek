import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, RefreshCw, Upload, RefreshCcw, PencilLine, Check, X, SlidersHorizontal, Trash2, CloudUpload } from "lucide-react";
import styles from "./DBManager.module.css";
import { LOCAL_API_BASE as API, getAuthHeaders } from "../../lib/api";

const DEFAULT_PAGE_SIZE = 50;
const PAGE_SIZE_OPTIONS = [50, 100, 200, 500];
const EDITABLE_COLS = ["상품명합", "거래처합", "거래처", "거래처상품명", "원가", "거래처주소", "옵션번호", "등록일", "이벤트전 할인가", "이벤트 할인가", "판매가"];
const ALL_COLS = ["상품코드", "상품명", "색상", "사이즈", "원가", "거래처", "거래처상품명", "거래처합", "상품명합", "거래처주소", "옵션번호", "에이블리상품번호", "등록일", "진열상태", "품절상태", "제조국", "이벤트전 할인가", "이벤트 할인가", "판매가", "지그재그상품번호", "아이디"];
const VISIBLE_COLS_STORAGE_KEY = "wonbe_visible_cols";
const PAGE_SIZE_STORAGE_KEY = "wonbe_page_size";

export default function WonbeTable() {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [pageSize, setPageSize] = useState(() => {
    const saved = Number(localStorage.getItem(PAGE_SIZE_STORAGE_KEY));
    return PAGE_SIZE_OPTIONS.includes(saved) ? saved : DEFAULT_PAGE_SIZE;
  });
  const [query, setQuery] = useState("");
  const [inputQuery, setInputQuery] = useState("");
  const [emptyCol, setEmptyCol] = useState("");
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [deletingByDate, setDeletingByDate] = useState(false);
  const [snoSyncing, setSnoSyncing] = useState(false);
  const [zigzagSyncing, setZigzagSyncing] = useState(false);
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
  const [selectedCodes, setSelectedCodes] = useState(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);

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

  // 할인가 채우기(이벤트할인가/이벤트전할인가) 제외 에이블리상품번호
  const [excludeIds, setExcludeIds] = useState([]);
  const [excludePanelOpen, setExcludePanelOpen] = useState(false);
  const [excludeText, setExcludeText] = useState("");
  const [excludeSaving, setExcludeSaving] = useState(false);
  const excludePanelRef = useRef(null);

  // 이벤트전할인가 채우기(원가기준)에서 쓰는 택배비 설정값
  const [savedShippingFee, setSavedShippingFee] = useState(2060);

  // 그룹 (체크한 상품을 묶어서 그룹별로만 필터링해서 보기)
  const [groups, setGroups] = useState([]);
  const [activeGroupId, setActiveGroupId] = useState(0);
  const [groupPanelOpen, setGroupPanelOpen] = useState(false);
  const groupPanelRef = useRef(null);
  const [newGroupName, setNewGroupName] = useState("");
  const [groupActionLoading, setGroupActionLoading] = useState(false);

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

  useEffect(() => {
    if (!excludePanelOpen) return;
    const onClickOutside = (e) => {
      if (excludePanelRef.current && !excludePanelRef.current.contains(e.target)) setExcludePanelOpen(false);
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [excludePanelOpen]);

  useEffect(() => {
    if (!groupPanelOpen) return;
    const onClickOutside = (e) => {
      if (groupPanelRef.current && !groupPanelRef.current.contains(e.target)) setGroupPanelOpen(false);
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [groupPanelOpen]);

  const fetchGroups = useCallback(async () => {
    try {
      const res = await fetch(`${API}/wonbe/groups`, { headers: getAuthHeaders() });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) setGroups(data.groups || []);
    } catch { /* noop */ }
  }, []);

  useEffect(() => { fetchGroups(); }, [fetchGroups]);

  const handleCreateGroup = async () => {
    const name = newGroupName.trim();
    if (!name) return;
    setGroupActionLoading(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/wonbe/groups`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ name }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "그룹 생성 실패");
      setNewGroupName("");
      setMessage(`그룹 "${data.name}" 생성 완료`);
      await fetchGroups();
    } catch (err) {
      setMessage(err.message);
    } finally {
      setGroupActionLoading(false);
    }
  };

  const handleDeleteGroup = async (group) => {
    if (!window.confirm(`그룹 "${group.name}"을(를) 삭제합니다. (그룹 소속만 해제되며 원가베이스유 상품 데이터는 삭제되지 않습니다)\n진행하시겠습니까?`)) return;
    setGroupActionLoading(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/wonbe/groups`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ id: group.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "그룹 삭제 실패");
      if (activeGroupId === group.id) {
        setActiveGroupId(0);
        setOffset(0);
      }
      setMessage(`그룹 "${group.name}" 삭제 완료`);
      await fetchGroups();
    } catch (err) {
      setMessage(err.message);
    } finally {
      setGroupActionLoading(false);
    }
  };

  const handleAddSelectedToGroup = async (group) => {
    const codes = Array.from(selectedCodes);
    if (!codes.length) {
      setMessage("먼저 그룹에 추가할 상품을 체크하세요.");
      return;
    }
    setGroupActionLoading(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/wonbe/groups/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ group_id: group.id, codes }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "그룹 추가 실패");
      setMessage(`"${group.name}" 그룹에 체크한 ${data.added}건 추가 완료 (그룹 전체 ${data.count}건)`);
      await fetchGroups();
    } catch (err) {
      setMessage(err.message);
    } finally {
      setGroupActionLoading(false);
    }
  };

  const handleSelectGroupFilter = (id) => {
    setActiveGroupId(id);
    setOffset(0);
    setGroupPanelOpen(false);
  };

  const handleToggleGroupExclude = async (group) => {
    setGroupActionLoading(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/wonbe/groups`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ id: group.id, is_exclude: !group.is_exclude }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "일괄작업 제외 설정 실패");
      setMessage(`"${group.name}" 그룹 일괄작업 제외 ${data.is_exclude ? "설정" : "해제"} 완료`);
      await fetchGroups();
    } catch (err) {
      setMessage(err.message);
    } finally {
      setGroupActionLoading(false);
    }
  };

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`${API}/wonbe/discount-exclude-ably-ids`, { headers: getAuthHeaders() });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.ok) {
          setExcludeIds(data.ids || []);
          setExcludeText((data.ids || []).join("\n"));
        }
      } catch { /* noop */ }
    })();
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`${API}/wonbe/event-pre-discount-shipping-fee`, { headers: getAuthHeaders() });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.ok && Number.isFinite(data.shipping_fee)) {
          setSavedShippingFee(data.shipping_fee);
        }
      } catch { /* noop */ }
    })();
  }, []);

  const handleSaveExcludeIds = async () => {
    const ids = excludeText.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
    setExcludeSaving(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/wonbe/discount-exclude-ably-ids`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ ids }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "제외품목 저장 실패");
      setExcludeIds(data.ids || []);
      setExcludeText((data.ids || []).join("\n"));
      setMessage(`할인가 채우기 제외품목 저장 완료: ${(data.ids || []).length}건`);
      setExcludePanelOpen(false);
    } catch (err) {
      setMessage(err.message);
    } finally {
      setExcludeSaving(false);
    }
  };

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

  const fetchRows = useCallback(async (q, off, emptyColParam = "") => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ q, offset: off, limit: pageSize });
      if (emptyColParam) params.set("empty_col", emptyColParam);
      if (activeGroupId) params.set("group_id", activeGroupId);
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
  }, [activeGroupId, pageSize]);

  useEffect(() => { fetchRows(query, offset, emptyCol); }, [fetchRows, query, offset, emptyCol]);

  useEffect(() => {
    localStorage.setItem(PAGE_SIZE_STORAGE_KEY, String(pageSize));
  }, [pageSize]);

  const handlePageSizeChange = (e) => {
    setPageSize(Number(e.target.value));
    setOffset(0);
  };
  useEffect(() => { setSelectedCodes(new Set()); }, [rows]);

  const toggleSelectRow = (code) => {
    setSelectedCodes((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  };

  const toggleSelectAll = () => {
    setSelectedCodes((prev) => {
      if (prev.size === sortedRows.length) return new Set();
      return new Set(sortedRows.map((r) => r["상품코드"]));
    });
  };

  const handleDeleteSelected = async () => {
    const codes = Array.from(selectedCodes);
    if (!codes.length) return;
    if (!window.confirm(`선택한 ${codes.length}건을 삭제합니다.\n진행하시겠습니까?`)) return;
    setBulkDeleting(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/wonbe/rows`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ codes }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "삭제 실패");
      setMessage(`삭제 완료: ${data.deleted}건`);
      setSelectedCodes(new Set());
      setOffset(0);
      await fetchRows(query, 0, emptyCol);
    } catch (err) {
      setMessage(err.message);
    } finally {
      setBulkDeleting(false);
    }
  };

  const [delistOthersLoading, setDelistOthersLoading] = useState(false);

  const handleDelistOtherOptions = async () => {
    const codes = Array.from(selectedCodes);
    if (!codes.length) return;
    if (!window.confirm(
      `체크한 ${codes.length}건과 같은 에이블리상품번호를 가진 나머지 옵션들을 미진열 처리합니다.\n` +
      `(체크한 옵션 자신은 제외 — 실제 판매중인 옵션이 미진열됩니다)\n진행하시겠습니까?`
    )) return;
    setDelistOthersLoading(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/wonbe/delist-other-options-by-ably-product`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ codes }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "미진열 처리 실패");
      setMessage(
        `미진열 처리 완료: 체크 ${data.checked}건 (상품그룹 ${data.groups}개) → 나머지 옵션 ${data.delisted}개 미진열 처리` +
        (data.skipped_no_option_sno ? ` (옵션번호 없음 ${data.skipped_no_option_sno}건 제외)` : "")
      );
    } catch (err) {
      setMessage(err.message);
    } finally {
      setDelistOthersLoading(false);
    }
  };

  const handleEmptyColChange = (e) => {
    setOffset(0);
    setEmptyCol(e.target.value);
  };

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
      fetchRows(query, offset, emptyCol);
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
      await fetchRows(query, offset, emptyCol);
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

  const [fillLoading, setFillLoading] = useState(false);

  const handleFillFromExcel = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    setFillLoading(true);
    setMessage("");
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(`${API}/wonbe/fill-from-excel`, {
        method: "POST",
        headers: getAuthHeaders(),
        body: form,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "채우기 실패");
      setMessage(`[${data.match_col}] 매칭 → [${data.target_col}] 채우기 완료: ${data.matched}/${data.total}건 (미매칭 ${data.unmatched}건)`);
      await fetchRows(query, offset, emptyCol);
    } catch (err) {
      setMessage(err.message);
    } finally {
      setFillLoading(false);
    }
  };

  const [eventDiscountLoading, setEventDiscountLoading] = useState(false);

  const handleFillEventDiscount = async () => {
    const label = query ? `"${query}" 검색 결과` : "전체";
    const input = window.prompt(`${label}에 대해 [이벤트전 할인가]를 몇 % 올려 [이벤트 할인가]에 채울까요? (예: 10)`);
    if (input === null) return;
    const percent = Number(input);
    if (!Number.isFinite(percent)) {
      setMessage("퍼센트 값이 올바르지 않습니다.");
      return;
    }
    setEventDiscountLoading(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/wonbe/fill-event-discount`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ percent, q: query }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "이벤트 할인가 채우기 실패");
      setMessage(`이벤트 할인가 채우기 완료 (${data.percent}%): ${data.updated}/${data.total}건 (이벤트전 할인가 없음 ${data.skipped}건, 제외품목 ${data.excluded ?? 0}건)`);
      await fetchRows(query, offset, emptyCol);
    } catch (err) {
      setMessage(err.message);
    } finally {
      setEventDiscountLoading(false);
    }
  };

  const [salePriceLoading, setSalePriceLoading] = useState(false);

  const handleFillSalePrice = async () => {
    const label = query ? `"${query}" 검색 결과` : "전체";
    if (!window.confirm(`${label}에 대해 원가 구간별 배수(3000~5500원 5배 / 5600~7500원 4배 / 7600원~ 3배)로 판매가를 채웁니다.\n진행하시겠습니까?`)) return;
    setSalePriceLoading(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/wonbe/fill-sale-price`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ q: query }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "판매가 채우기 실패");
      setMessage(`판매가 채우기 완료: ${data.updated}/${data.total}건 (원가 없음 ${data.skipped}건, 제외그룹 ${data.excluded ?? 0}건)`);
      await fetchRows(query, offset, emptyCol);
    } catch (err) {
      setMessage(err.message);
    } finally {
      setSalePriceLoading(false);
    }
  };

  const [preDiscountPriceLoading, setPreDiscountPriceLoading] = useState(false);

  const handleFillEventPreDiscountPrice = async () => {
    const codes = Array.from(selectedCodes);
    const label = codes.length ? `체크한 ${codes.length}건` : (query ? `"${query}" 검색 결과` : "전체");
    const marginInput = window.prompt(
      `${label}에 대해 원가 기준으로 [이벤트전 할인가]를 계산해 채웁니다.\n` +
      `P = (원가×1.10 + 택배비) ÷ (1 − 수수료율 8.756% − 목표순마진율), 10원 단위 올림.\n\n` +
      `목표순마진율(%)을 입력하세요:`,
      "30"
    );
    if (marginInput === null) return;
    const marginPercent = marginInput.trim() === "" ? 30 : Number(marginInput);
    if (!Number.isFinite(marginPercent)) {
      setMessage("목표순마진율 값이 올바르지 않습니다.");
      return;
    }
    const shippingInput = window.prompt("택배비(원)를 입력하세요:", String(savedShippingFee));
    if (shippingInput === null) return;
    const shippingFee = shippingInput.trim() === "" ? savedShippingFee : Number(shippingInput);
    if (!Number.isFinite(shippingFee)) {
      setMessage("택배비 값이 올바르지 않습니다.");
      return;
    }
    setPreDiscountPriceLoading(true);
    setMessage("");
    try {
      if (shippingFee !== savedShippingFee) {
        const saveRes = await fetch(`${API}/wonbe/event-pre-discount-shipping-fee`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...getAuthHeaders() },
          body: JSON.stringify({ shipping_fee: shippingFee }),
        });
        const saveData = await saveRes.json().catch(() => ({}));
        if (saveRes.ok && saveData.ok) setSavedShippingFee(saveData.shipping_fee);
      }
      const res = await fetch(`${API}/wonbe/fill-event-pre-discount-price`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify(
          codes.length
            ? { codes, margin_percent: marginPercent, shipping_fee: shippingFee }
            : { q: query, margin_percent: marginPercent, shipping_fee: shippingFee }
        ),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "이벤트전 할인가 채우기 실패");
      setMessage(
        `이벤트전 할인가 채우기 완료 (목표순마진율 ${data.margin_percent}% / 택배비 ${data.shipping_fee}원): ` +
        `${data.updated}/${data.total}건 (원가 없음 ${data.skipped}건, 제외품목 ${data.excluded ?? 0}건)`
      );
      await fetchRows(query, offset, emptyCol);
    } catch (err) {
      setMessage(err.message);
    } finally {
      setPreDiscountPriceLoading(false);
    }
  };

  const [freeSalePriceMode, setFreeSalePriceMode] = useState(false);
  const [freeSalePriceBasis, setFreeSalePriceBasis] = useState("이벤트전 할인가");
  const [freeSalePriceLoading, setFreeSalePriceLoading] = useState(false);

  const handleFillSalePriceFromDiscount = async () => {
    const codes = Array.from(selectedCodes);
    const label = codes.length ? `체크한 ${codes.length}건` : (query ? `"${query}" 검색 결과` : "전체");
    const input = window.prompt(`${label}에 대해 [${freeSalePriceBasis}]가 판매가에서 몇 % 할인된 값인지 입력하면, 그 값으로 [판매가]를 역산해 채웁니다. (예: 10)`);
    if (input === null) return;
    const percent = Number(input);
    if (!Number.isFinite(percent) || percent >= 100) {
      setMessage("퍼센트 값이 올바르지 않습니다. (100 미만)");
      return;
    }
    setFreeSalePriceLoading(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/wonbe/fill-sale-price-from-discount`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify(
          codes.length
            ? { percent, basis: freeSalePriceBasis, codes }
            : { percent, basis: freeSalePriceBasis, q: query }
        ),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "판매가 채우기 실패");
      setMessage(
        `[${data.basis}] 기준 판매가 채우기 완료 (${data.percent}%): ` +
        `${data.updated}/${data.total}건 (${data.basis} 없음 ${data.skipped}건, 제외품목 ${data.excluded ?? 0}건)`
      );
      await fetchRows(query, offset, emptyCol);
    } catch (err) {
      setMessage(err.message);
    } finally {
      setFreeSalePriceLoading(false);
    }
  };

  const [priceSource, setPriceSource] = useState("이벤트전 할인가");
  const [pricePushLoading, setPricePushLoading] = useState(false);

  const handlePushPriceToAbly = async () => {
    const codes = Array.from(selectedCodes);
    const label = codes.length ? `체크한 ${codes.length}건` : (query ? `"${query}" 검색 결과` : "전체");
    if (!window.confirm(
      `${label} 상품의 [판매가]와 [${priceSource}]를 에이블리 실제 상품가로 변경합니다.\n` +
      `(에이블리상품번호 기준, 최대 1000개씩 배치 전송 — 실제 판매중인 상품가가 바뀝니다)\n진행하시겠습니까?`
    )) return;
    setPricePushLoading(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/wonbe/push-price-to-ably`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify(codes.length ? { source: priceSource, codes } : { source: priceSource, q: query }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "에이블리 상품가 변경 실패");
      setMessage(
        `[${data.source}] 기준 에이블리 상품가 변경 완료: 성공 ${data.success_row_count}건 / 실패 ${data.error_row_count}건 ` +
        `(요청 ${data.requested}건, 제외 - 값이상 ${data.skipped_invalid}건 · 중복상품 ${data.skipped_duplicate}건 · 제외그룹 ${data.skipped_group_excluded ?? 0}건)`
      );
    } catch (err) {
      setMessage(err.message);
    } finally {
      setPricePushLoading(false);
    }
  };

  const [zigzagPriceSource, setZigzagPriceSource] = useState("이벤트전 할인가");
  const [zigzagPricePushLoading, setZigzagPricePushLoading] = useState(false);

  const handlePushPriceToZigzag = async () => {
    const codes = Array.from(selectedCodes);
    const label = codes.length ? `체크한 ${codes.length}건` : (query ? `"${query}" 검색 결과` : "전체");
    if (!window.confirm(
      `${label} 상품의 [${zigzagPriceSource}]를 지그재그 판매가로 변경합니다.\n` +
      `(지그재그상품번호 기준, 엑셀 일괄수정 업로드 — 실제 판매중인 상품가가 바뀝니다)\n진행하시겠습니까?`
    )) return;
    setZigzagPricePushLoading(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/wonbe/push-price-to-zigzag`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify(codes.length ? { source: zigzagPriceSource, codes } : { source: zigzagPriceSource, q: query }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "지그재그 상품가 변경 실패");
      const statusLabel = data.status ? ` (지그재그 처리결과: ${data.status})` : " (처리결과 확인 전 - 지그재그 파트너센터 엑셀 업로드 내역에서 확인해주세요)";
      setMessage(
        `[${data.source}] 기준 지그재그 상품가 변경 요청 완료: ${data.requested}건${statusLabel} ` +
        `(제외 - 값이상 ${data.skipped_invalid}건 · 중복상품 ${data.skipped_duplicate}건 · 제외그룹 ${data.skipped_group_excluded ?? 0}건)`
      );
    } catch (err) {
      setMessage(err.message);
    } finally {
      setZigzagPricePushLoading(false);
    }
  };

  const [amoodPriceLoading, setAmoodPriceLoading] = useState(false);

  const handlePushPriceToAmood = async (mode) => {
    const codes = Array.from(selectedCodes);
    const label = codes.length ? `체크한 ${codes.length}건` : (query ? `"${query}" 검색 결과` : "전체");
    const actionLabel = mode === "revert" ? "되돌립니다" : "변경합니다";
    const rateInput = window.prompt("1엔당 원화 환율을 입력하세요 (예: 8.6):", "8.6");
    if (rateInput === null) return;
    const rate = Number(rateInput);
    if (!Number.isFinite(rate) || rate <= 0) {
      setMessage("환율 값이 올바르지 않습니다.");
      return;
    }
    const formulaText = mode === "revert"
      ? `할인판매가 = 이벤트전 할인가÷${rate}엔, 판매가 = 할인판매가×1.2`
      : `할인판매가 = 이벤트전 할인가×1.2÷${rate}엔, 판매가 = 할인판매가×1.2`;
    if (!window.confirm(
      `${label} 상품의 [이벤트전 할인가] 기준으로 아무드 상품가를 ${actionLabel}\n` +
      `(${formulaText}, 에이블리상품번호 기준 — 실제 판매중인 상품가가 바뀝니다)\n진행하시겠습니까?`
    )) return;
    setAmoodPriceLoading(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/wonbe/push-price-to-amood`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify(codes.length ? { rate, mode, codes } : { rate, mode, q: query }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "아무드 상품가 변경 실패");
      setMessage(
        `아무드 상품가 ${mode === "revert" ? "되돌리기" : "변경"} 완료 (환율 1엔=${data.rate}원): 요청 ${data.requested}건 ` +
        `(제외 - 값이상 ${data.skipped_invalid}건 · 중복상품 ${data.skipped_duplicate}건 · 제외그룹 ${data.skipped_group_excluded ?? 0}건)`
      );
    } catch (err) {
      setMessage(err.message);
    } finally {
      setAmoodPriceLoading(false);
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
      setMessage(
        `동기화 완료: ${data.fetched}개 조회 → ${data.inserted}개 신규 등록` +
        (data.backfilled ? ` · 기존 상품 아이디 ${data.backfilled}건 채움` : "")
      );
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

  const handleDeleteByRegisteredDate = async () => {
    if (!window.confirm(`"${syncStartDate} ~ ${syncEndDate}" 범위의 등록일 데이터를 삭제합니다.\n진행하시겠습니까?`)) return;
    setDeletingByDate(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/wonbe/by-registered-date`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ start: syncStartDate, end: syncEndDate }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "삭제 실패");
      setMessage(`삭제 완료: ${data.deleted}건`);
      setOffset(0);
      await fetchRows(query, 0, emptyCol);
    } catch (err) {
      setMessage(err.message);
    } finally {
      setDeletingByDate(false);
    }
  };

  const handleSyncAblySno = async () => {
    const codes = Array.from(selectedCodes);
    setSnoSyncing(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/wonbe/sync-ably-sno`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify(codes.length ? { codes } : {}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "에이블리상품번호 동기화 실패");
      const scopeNote = codes.length ? ` (체크한 ${codes.length}건 대상)` : "";
      setMessage(`에이블리상품번호 동기화 완료${scopeNote}: 카탈로그 ${data.fetched_goods}건 조회 · ${data.considered}건 중 ${data.matched}건 매칭 (미매칭 ${data.unmatched}건)`);
      await fetchRows(query, offset, emptyCol);
    } catch (err) {
      setMessage(err.message);
    } finally {
      setSnoSyncing(false);
    }
  };

  const handleSyncZigzagId = async () => {
    const codes = Array.from(selectedCodes);
    setZigzagSyncing(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/wonbe/sync-zigzag-id`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify(codes.length ? { codes } : {}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "지그재그상품번호 동기화 실패");
      const scopeNote = codes.length ? ` (체크한 ${codes.length}건 대상)` : "";
      setMessage(`지그재그상품번호 동기화 완료${scopeNote}: 지그재그 ${data.fetched_products}건 조회 · ${data.considered}건 중 ${data.matched}건 매칭 (미매칭 ${data.unmatched}건)`);
      await fetchRows(query, offset, emptyCol);
    } catch (err) {
      setMessage(err.message);
    } finally {
      setZigzagSyncing(false);
    }
  };

  const handleSyncRegistrationDate = async () => {
    const codes = Array.from(selectedCodes);
    setRegDateSyncing(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/wonbe/sync-registration-date`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify(codes.length ? { codes } : {}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "등록일 채우기 실패");
      const scopeNote = codes.length ? ` (체크한 ${codes.length}건 대상)` : "";
      setMessage(`등록일/진열상태/품절상태 채우기 완료${scopeNote}: 카탈로그 ${data.fetched_goods}건 조회 · ${data.considered}건 중 ${data.matched}건 채움 (미매칭 ${data.unmatched}건)`);
      await fetchRows(query, offset, emptyCol);
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
    const codes = Array.from(selectedCodes);
    const label = codes.length ? `체크한 ${codes.length}건` : "에이블리상품번호가 있는 모든 상품";
    if (!window.confirm(`${label}의 상세정보를 개별 조회해서 제조국을 채웁니다.\n상품 수에 따라 시간이 걸릴 수 있습니다. 진행하시겠습니까?`)) return;
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
        body: JSON.stringify(codes.length ? { codes } : {}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "제조국 채우기 실패");
      const scopeNote = codes.length ? ` (체크한 ${codes.length}건 대상)` : "";
      setMessage(`제조국 채우기 완료${scopeNote}: 상품코드 ${data.considered}건 (고유 상품번호 ${data.unique_snos}건 조회) 중 ${data.matched}건 채움 (미매칭 ${data.unmatched}건)`);
      await fetchRows(query, offset, emptyCol);
    } catch (err) {
      setMessage(err.message);
    } finally {
      stopCountryPolling();
      setCountrySyncing(false);
      setCountryProgress(null);
    }
  };

  const [deploySyncing, setDeploySyncing] = useState(false);

  const handlePushToDeploy = async () => {
    if (!window.confirm(`로컬 원가베이스유(${total.toLocaleString()}행)를 Turso로 전송해 배포앱에서 읽을 수 있게 합니다.\n진행하시겠습니까?`)) return;
    setDeploySyncing(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/wonbe/push-to-deploy`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "배포앱전송 실패");
      setMessage(`배포앱전송 완료: ${data.pushed}/${data.total_local}건`);
    } catch (err) {
      setMessage(err.message);
    } finally {
      setDeploySyncing(false);
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

  const totalPages = Math.ceil(total / pageSize);
  const currentPage = Math.floor(offset / pageSize) + 1;

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
        <button className={`${styles.btn} ${styles.btnSecondary}`} onClick={() => fetchRows(query, offset, emptyCol)} disabled={loading || syncing}>
          <RefreshCw size={13} />새로고침
        </button>
        <button
          className={`${styles.btn} ${styles.btnDanger}`}
          onClick={handleDeleteSelected}
          disabled={loading || bulkDeleting || !selectedCodes.size}
        >
          <Trash2 size={13} />{bulkDeleting ? "삭제 중..." : `선택 삭제 (${selectedCodes.size})`}
        </button>
        <button
          className={`${styles.btn} ${styles.btnDanger}`}
          onClick={handleDelistOtherOptions}
          disabled={loading || delistOthersLoading || !selectedCodes.size}
          title="체크한 옵션과 같은 에이블리상품번호를 가진 나머지 옵션들을 미진열 처리합니다 (체크한 옵션 자신은 제외)"
        >
          <RefreshCcw size={13} />{delistOthersLoading ? "처리 중..." : `나머지옵션 미진열처리 (${selectedCodes.size})`}
        </button>
        <div ref={groupPanelRef} style={{ position: "relative" }}>
          <button
            className={`${styles.btn} ${activeGroupId ? styles.btnPrimary : styles.btnSecondary}`}
            onClick={() => setGroupPanelOpen((v) => !v)}
            title="상품을 그룹으로 묶어서 그룹별로만 필터링해서 볼 수 있습니다"
          >
            <SlidersHorizontal size={13} />
            {activeGroupId
              ? `그룹: ${groups.find((g) => g.id === activeGroupId)?.name || activeGroupId}`
              : `그룹 (${groups.length})`}
          </button>
          {groupPanelOpen && (
            <div
              style={{
                position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 20,
                background: "#fff", border: "1px solid #d1d5db", borderRadius: "6px",
                padding: "8px", boxShadow: "0 4px 12px rgba(0,0,0,0.12)",
                display: "flex", flexDirection: "column", gap: "6px", width: "300px",
              }}
            >
              <span style={{ fontSize: "0.72rem", color: "#6b7280" }}>
                상품을 체크한 뒤 그룹의 [추가] 버튼으로 묶고, [보기]로 그 그룹만 필터링해서 볼 수 있습니다.
                [일괄제외]로 설정하면 그 그룹 상품은 판매가 채우기 / 상품가 변경 등 일괄작업에서 자동으로 제외됩니다.
              </span>
              <button
                className={`${styles.btn} ${!activeGroupId ? styles.btnPrimary : styles.btnSecondary}`}
                onClick={() => handleSelectGroupFilter(0)}
                disabled={groupActionLoading}
              >
                전체 보기 (그룹 필터 끄기)
              </button>
              <div style={{ display: "flex", flexDirection: "column", gap: "4px", maxHeight: "220px", overflowY: "auto" }}>
                {groups.length === 0 && (
                  <span style={{ fontSize: "0.72rem", color: "#9ca3af" }}>생성된 그룹이 없습니다.</span>
                )}
                {groups.map((g) => (
                  <div
                    key={g.id}
                    style={{
                      display: "flex", alignItems: "center", gap: "4px",
                      padding: "4px 6px", borderRadius: "4px",
                      background: g.is_exclude ? "#fee2e2" : (activeGroupId === g.id ? "#ede9fe" : "transparent"),
                    }}
                  >
                    <span style={{ flex: 1, fontSize: "0.78rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {g.name} <span style={{ color: "#9ca3af" }}>({g.count})</span>
                      {g.is_exclude && <span style={{ color: "#dc2626", marginLeft: "4px" }}>제외중</span>}
                    </span>
                    <button
                      onClick={() => handleToggleGroupExclude(g)}
                      disabled={groupActionLoading}
                      title="이 그룹 상품을 판매가 채우기 / 에이블리·지그재그·아무드 상품가 변경 / 헤더 일괄수정 등 일괄작업 대상에서 제외합니다"
                      style={{
                        background: g.is_exclude ? "#dc2626" : "none",
                        color: g.is_exclude ? "#fff" : "#dc2626",
                        border: "1px solid #dc2626", borderRadius: "3px", padding: "1px 5px", cursor: "pointer", fontSize: "0.7rem", flexShrink: 0,
                      }}
                    >
                      {g.is_exclude ? "제외해제" : "일괄제외"}
                    </button>
                    <button
                      onClick={() => handleSelectGroupFilter(g.id)}
                      disabled={groupActionLoading}
                      title="이 그룹만 필터링해서 보기"
                      style={{ background: "none", color: "#7c3aed", border: "1px solid #7c3aed", borderRadius: "3px", padding: "1px 5px", cursor: "pointer", fontSize: "0.7rem" }}
                    >
                      보기
                    </button>
                    <button
                      onClick={() => handleAddSelectedToGroup(g)}
                      disabled={groupActionLoading || !selectedCodes.size}
                      title="체크한 상품을 이 그룹에 추가"
                      style={{ background: "none", color: "#059669", border: "1px solid #059669", borderRadius: "3px", padding: "1px 5px", cursor: "pointer", fontSize: "0.7rem" }}
                    >
                      추가
                    </button>
                    <button
                      onClick={() => handleDeleteGroup(g)}
                      disabled={groupActionLoading}
                      title="그룹 삭제"
                      style={{ background: "none", color: "#dc2626", border: "1px solid #dc2626", borderRadius: "3px", padding: "1px 5px", cursor: "pointer", fontSize: "0.7rem" }}
                    >
                      <Trash2 size={10} />
                    </button>
                  </div>
                ))}
              </div>
              <div style={{ display: "flex", gap: "4px" }}>
                <input
                  value={newGroupName}
                  onChange={(e) => setNewGroupName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleCreateGroup(); }}
                  placeholder="새 그룹명"
                  style={{ flex: 1, fontSize: "0.78rem", padding: "4px 6px", border: "1px solid #d1d5db", borderRadius: "4px" }}
                  disabled={groupActionLoading}
                />
                <button
                  className={`${styles.btn} ${styles.btnPrimary}`}
                  onClick={handleCreateGroup}
                  disabled={groupActionLoading || !newGroupName.trim()}
                >
                  그룹 생성
                </button>
              </div>
            </div>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>
          <span style={{ fontSize: "0.78rem", color: "#6b7280", whiteSpace: "nowrap" }}>빈칸만 보기</span>
          <select
            className={styles.searchInput}
            value={emptyCol}
            onChange={handleEmptyColChange}
            style={{ minWidth: "110px" }}
          >
            <option value="">(끄기)</option>
            {ALL_COLS.map((col) => (
              <option key={col} value={col}>{col}</option>
            ))}
          </select>
        </div>
        <div className={styles.syncDateGroup}>
          <span className={styles.syncDateLabel}>등록일</span>
          <input type="date" className={styles.syncDateInput} value={syncStartDate} onChange={(e) => setSyncStartDate(e.target.value)} disabled={syncing} />
          <span className={styles.syncDateSep}>~</span>
          <input type="date" className={styles.syncDateInput} value={syncEndDate} onChange={(e) => setSyncEndDate(e.target.value)} disabled={syncing} />
          <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={handleSyncEzadmin} disabled={loading || syncing}>
            <RefreshCcw size={13} />{syncing ? "동기화 중..." : "이지어드민 동기화"}
          </button>
          <button className={`${styles.btn} ${styles.btnSecondary}`} onClick={handleDeleteByRegisteredDate} disabled={loading || deletingByDate}>
            <Trash2 size={13} />{deletingByDate ? "삭제 중..." : "삭제"}
          </button>
        </div>
        <label className={styles.fileLabel}>
          <input type="file" accept=".xlsx,.xls,.xlsm" onChange={handleImportFile} disabled={loading} />
          <Upload size={13} />xlsx 임포트 (전체 교체)
        </label>
        <label className={styles.fileLabel} title="A열 헤더=매칭 컬럼, B열 헤더=채울 컬럼 (예: A열 헤더 '상품코드' / B열 헤더 '이벤트전 할인가')">
          <input type="file" accept=".xlsx,.xls,.xlsm" onChange={handleFillFromExcel} disabled={fillLoading} />
          <Upload size={13} />{fillLoading ? "채우는 중..." : "엑셀로 값 채우기"}
        </label>
        <button className={`${styles.btn} ${styles.btnSecondary}`} onClick={handleExport} disabled={loading}>
          <Download size={13} />xls 내보내기
        </button>
        <button
          className={`${styles.btn} ${styles.btnPrimary}`}
          onClick={handlePushToDeploy}
          disabled={loading || deploySyncing}
          title="로컬 원가베이스유를 Turso로 전송해 배포앱(발주추천 등)에서 읽을 수 있게 합니다"
        >
          <CloudUpload size={13} />{deploySyncing ? "전송 중..." : "배포앱전송"}
        </button>
        <button
          className={`${styles.btn} ${styles.btnPrimary}`}
          onClick={handleFillEventDiscount}
          disabled={loading || eventDiscountLoading}
          title="이벤트전 할인가에 퍼센트를 올린 값을 이벤트 할인가에 채웁니다"
        >
          <RefreshCcw size={13} />{eventDiscountLoading ? "채우는 중..." : "이벤트할인가 채우기"}
        </button>
        <button
          className={`${styles.btn} ${styles.btnPrimary}`}
          onClick={handleFillSalePrice}
          disabled={loading || salePriceLoading}
          title="원가 구간별 배수(3000~5500원 5배 / 5600~7500원 4배 / 7600원~ 3배)로 판매가를 채웁니다 (일괄제외 그룹 상품은 제외)"
        >
          <RefreshCcw size={13} />{salePriceLoading ? "채우는 중..." : "판매가 채우기"}
        </button>
        <button
          className={`${styles.btn} ${styles.btnPrimary}`}
          onClick={handleFillEventPreDiscountPrice}
          disabled={loading || preDiscountPriceLoading}
          title="원가로 P = (원가×1.10 + 택배비) ÷ (1 − 수수료율 8.756% − 목표순마진율)을 역산해 이벤트전 할인가를 채웁니다 (10원 단위 올림)"
        >
          <RefreshCcw size={13} />{preDiscountPriceLoading ? "채우는 중..." : "이벤트전할인가 채우기(원가기준)"}
        </button>
        <div style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>
          <button
            className={`${styles.btn} ${styles.btnSecondary}`}
            onClick={() => setFreeSalePriceMode((v) => !v)}
            style={freeSalePriceMode ? { background: "#7c3aed", color: "#fff", borderColor: "#7c3aed" } : undefined}
            title="체크하면 원가식과 무관하게, 선택한 할인가를 기준으로 판매가를 역산해서 채웁니다"
          >
            {freeSalePriceMode && <Check size={13} />}판매가 자유
          </button>
          {freeSalePriceMode && (
            <>
              <select
                className={styles.searchInput}
                value={freeSalePriceBasis}
                onChange={(e) => setFreeSalePriceBasis(e.target.value)}
                style={{ minWidth: "150px" }}
                disabled={freeSalePriceLoading}
              >
                <option value="이벤트전 할인가">이벤트전 할인가 기준</option>
                <option value="이벤트 할인가">이벤트 할인가 기준</option>
              </select>
              <button
                className={`${styles.btn} ${styles.btnPrimary}`}
                onClick={handleFillSalePriceFromDiscount}
                disabled={loading || freeSalePriceLoading}
                title={selectedCodes.size ? `체크한 ${selectedCodes.size}건만 채웁니다` : "선택한 할인가가 판매가에서 입력한 퍼센트만큼 할인된 값이라고 보고, 판매가를 역산해 채웁니다 (체크하면 체크한 건만 진행)"}
              >
                <RefreshCcw size={13} />{freeSalePriceLoading ? "채우는 중..." : "판매가 채우기(할인가 기준)"}
              </button>
            </>
          )}
        </div>
        <div ref={excludePanelRef} style={{ position: "relative" }}>
          <button
            className={`${styles.btn} ${styles.btnSecondary}`}
            onClick={() => setExcludePanelOpen((v) => !v)}
            title="이벤트할인가 채우기 / 이벤트전할인가 채우기(원가기준)에서 제외할 에이블리상품번호"
          >
            <SlidersHorizontal size={13} />할인가 제외품목 ({excludeIds.length})
          </button>
          {excludePanelOpen && (
            <div
              style={{
                position: "absolute", top: "calc(100% + 4px)", right: 0, zIndex: 20,
                background: "#fff", border: "1px solid #d1d5db", borderRadius: "6px",
                padding: "8px", boxShadow: "0 4px 12px rgba(0,0,0,0.12)",
                display: "flex", flexDirection: "column", gap: "6px", width: "220px",
              }}
            >
              <span style={{ fontSize: "0.72rem", color: "#6b7280" }}>
                에이블리상품번호를 한 줄에 하나씩(또는 콤마로 구분) 입력하세요. 이벤트할인가 / 이벤트전할인가 채우기에서 제외됩니다.
              </span>
              <textarea
                value={excludeText}
                onChange={(e) => setExcludeText(e.target.value)}
                rows={8}
                style={{ fontSize: "0.78rem", padding: "4px 6px", border: "1px solid #d1d5db", borderRadius: "4px", resize: "vertical" }}
                disabled={excludeSaving}
              />
              <button
                className={`${styles.btn} ${styles.btnPrimary}`}
                onClick={handleSaveExcludeIds}
                disabled={excludeSaving}
              >
                {excludeSaving ? "저장 중..." : "저장"}
              </button>
            </div>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>
          <select
            className={styles.searchInput}
            value={priceSource}
            onChange={(e) => setPriceSource(e.target.value)}
            style={{ minWidth: "130px" }}
            disabled={pricePushLoading}
          >
            <option value="이벤트전 할인가">이벤트전 할인가로 변경</option>
            <option value="이벤트 할인가">이벤트 할인가로 변경</option>
          </select>
          <button
            className={`${styles.btn} ${styles.btnDanger}`}
            onClick={handlePushPriceToAbly}
            disabled={loading || pricePushLoading}
            title="판매가 + 선택한 할인가를 에이블리 실제 상품가로 일괄 변경합니다 (일괄제외 그룹 상품은 제외)"
          >
            <RefreshCcw size={13} />{pricePushLoading ? "변경 중..." : "에이블리 상품가 변경"}
          </button>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>
          <select
            className={styles.searchInput}
            value={zigzagPriceSource}
            onChange={(e) => setZigzagPriceSource(e.target.value)}
            style={{ minWidth: "130px" }}
            disabled={zigzagPricePushLoading}
          >
            <option value="판매가">판매가로 변경</option>
            <option value="이벤트전 할인가">이벤트전 할인가로 변경</option>
            <option value="이벤트 할인가">이벤트 할인가로 변경</option>
          </select>
          <button
            className={`${styles.btn} ${styles.btnDanger}`}
            onClick={handlePushPriceToZigzag}
            disabled={loading || zigzagPricePushLoading}
            title="선택한 가격을 지그재그 실제 상품가로 일괄 변경합니다 (엑셀 업로드, 일괄제외 그룹 상품은 제외)"
          >
            <RefreshCcw size={13} />{zigzagPricePushLoading ? "변경 중..." : "지그재그 상품가 변경"}
          </button>
        </div>
        <button
          className={`${styles.btn} ${styles.btnDanger}`}
          onClick={() => handlePushPriceToAmood("increase")}
          disabled={loading || amoodPriceLoading}
          title="이벤트전 할인가×1.2를 엔화로 환산해 할인판매가로, 그 값의 1.2배를 판매가로 삼아 아무드 실제 상품가를 일괄 변경합니다 (일괄제외 그룹 상품은 제외)"
        >
          <RefreshCcw size={13} />{amoodPriceLoading ? "변경 중..." : "아무드 상품가 변경"}
        </button>
        <button
          className={`${styles.btn} ${styles.btnDanger}`}
          onClick={() => handlePushPriceToAmood("revert")}
          disabled={loading || amoodPriceLoading}
          title="이벤트전 할인가를 그대로 엔화로 환산해 할인판매가로, 그 값의 1.2배를 판매가로 삼아 아무드 실제 상품가를 되돌립니다 (일괄제외 그룹 상품은 제외)"
        >
          <RefreshCcw size={13} />{amoodPriceLoading ? "되돌리는 중..." : "아무드 상품가 되돌리기"}
        </button>
        <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={handleSyncAblySno} disabled={loading || snoSyncing} title={selectedCodes.size ? `체크한 ${selectedCodes.size}건만 동기화합니다` : "전체 상품을 대상으로 동기화합니다 (체크하면 체크한 건만 진행)"}>
          <RefreshCcw size={13} />{snoSyncing ? "동기화 중..." : "에이블리상품번호 채우기"}
        </button>
        <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={handleSyncZigzagId} disabled={loading || zigzagSyncing} title={selectedCodes.size ? `체크한 ${selectedCodes.size}건만 동기화합니다` : "상품명으로 지그재그 상품과 매칭해 지그재그상품번호를 채웁니다 (체크하면 체크한 건만 진행)"}>
          <RefreshCcw size={13} />{zigzagSyncing ? "동기화 중..." : "지그재그상품번호 채우기"}
        </button>
        <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={handleSyncRegistrationDate} disabled={loading || regDateSyncing} title={selectedCodes.size ? `체크한 ${selectedCodes.size}건만 채웁니다` : "전체 상품을 대상으로 채웁니다 (체크하면 체크한 건만 진행)"}>
          <RefreshCcw size={13} />{regDateSyncing ? "채우는 중..." : "등록일 채우기"}
        </button>
        <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={handleSyncCountry} disabled={loading || countrySyncing} title={selectedCodes.size ? `체크한 ${selectedCodes.size}건만 채웁니다` : "전체 상품을 대상으로 채웁니다 (체크하면 체크한 건만 진행)"}>
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
              <th style={{ width: "28px" }}>
                <input
                  type="checkbox"
                  checked={sortedRows.length > 0 && selectedCodes.size === sortedRows.length}
                  onChange={toggleSelectAll}
                />
              </th>
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
                  <td>
                    <input
                      type="checkbox"
                      checked={selectedCodes.has(code)}
                      onChange={() => toggleSelectRow(code)}
                    />
                  </td>
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

      <div className={styles.pagination}>
        {totalPages > 1 && (
          <>
            <button className={`${styles.btn} ${styles.btnSecondary}`} onClick={() => setOffset(Math.max(0, offset - pageSize))} disabled={offset === 0 || loading}>이전</button>
            <span>{currentPage} / {totalPages}</span>
            <button className={`${styles.btn} ${styles.btnSecondary}`} onClick={() => setOffset(offset + pageSize)} disabled={currentPage >= totalPages || loading}>다음</button>
          </>
        )}
        <div style={{ display: "flex", alignItems: "center", gap: "0.35rem", marginLeft: totalPages > 1 ? "1rem" : 0 }}>
          <span style={{ fontSize: "0.78rem", color: "#6b7280", whiteSpace: "nowrap" }}>한 페이지에</span>
          <select
            className={styles.searchInput}
            value={pageSize}
            onChange={handlePageSizeChange}
            disabled={loading}
            style={{ minWidth: "80px" }}
          >
            {PAGE_SIZE_OPTIONS.map((size) => (
              <option key={size} value={size}>{size}개</option>
            ))}
          </select>
        </div>
      </div>
    </>
  );
}
