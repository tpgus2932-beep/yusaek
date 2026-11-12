import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, RefreshCw, RefreshCcw, PencilLine, Check, X, SlidersHorizontal, Trash2, CloudUpload } from "lucide-react";
import styles from "./DBManager.module.css";
import { LOCAL_API_BASE as API, getAuthHeaders } from "../../lib/api";

const DEFAULT_PAGE_SIZE = 50;
const PAGE_SIZE_OPTIONS = [50, 100, 200, 500];
const EDITABLE_COLS = ["색상", "상품명합", "거래처합", "거래처", "거래처상품명", "원가", "거래처주소", "옵션번호", "등록일", "이벤트전 할인가", "이벤트 할인가", "판매가", "태그"];
const ALL_COLS = ["상품코드", "상품명", "태그", "색상", "사이즈", "원가", "거래처", "거래처상품명", "거래처합", "상품명합", "거래처주소", "옵션번호", "에이블리상품번호", "등록일", "진열상태", "품절상태", "이벤트전 할인가", "이벤트 할인가", "판매가", "아이디", "대표상품코드", "카테고리"];
const NEW_COLS = ["태그"]; // 새로 생긴 칸은 예전에 저장된 '열 선택'에도 보이도록 한 번 추가해준다
const NEW_COLS_STORAGE_KEY = "wonbe_new_cols_seen";
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
  const [repCodeSyncing, setRepCodeSyncing] = useState(false);
  const [catOpen, setCatOpen] = useState(false);
  const [catItems, setCatItems] = useState([]);
  const [catSaving, setCatSaving] = useState(false);
  const [catIdx, setCatIdx] = useState(0);
  const [catReverse, setCatReverse] = useState(false);
  const [rnOpen, setRnOpen] = useState(false);
  const [rnPlan, setRnPlan] = useState(null);
  const [rnBusy, setRnBusy] = useState(false);
  const [rnProgress, setRnProgress] = useState(null); // { done, total }
  const [rnForce, setRnForce] = useState(false); // true면 이미 올린 상품도 전부 다시 올린다
  const [rnCheckMsg, setRnCheckMsg] = useState(""); // 전체 재조회 진행 문구
  const [rnCheck, setRnCheck] = useState(null); // 전체 재조회 결과 { checked, same, diff, unknown, diff_items }
  const [rnCats, setRnCats] = useState(["상의", "하의", "아우터", "악세사리"]);
  const [regDateSyncing, setRegDateSyncing] = useState(false);
  const [message, setMessage] = useState("");
  const [rawUnexpected, setRawUnexpected] = useState(null);
  const [tagGroups, setTagGroups] = useState(null); // 동기화 직후 대형태그/번호 지정 리스트
  const [tagManual, setTagManual] = useState(false); // true = [대형 수정] 버튼으로 연 리스트 (완료 기록 없이 적용만)
  const [tagApplying, setTagApplying] = useState(false);
  const [bigLoading, setBigLoading] = useState(false);
  const [tagOnlyUnnumbered, setTagOnlyUnnumbered] = useState(false); // [대형 수정] 목록에서 번호 없는 상품만 보기
  const [tagResult, setTagResult] = useState(""); // 대형 목록 패널 안에 보여줄 적용 결과
  // 대형 추천 키워드 (서버에 저장, 상품명에 들어 있으면 대형 목록 맨 위로)
  const [bigKeywords, setBigKeywords] = useState(["자켓", "패딩", "뽀글이", "점퍼"]);
  const [savedKeywords, setSavedKeywords] = useState(null);
  const [keywordInput, setKeywordInput] = useState("");
  const [kwSaving, setKwSaving] = useState(false);
  const kwDirty = savedKeywords !== null && JSON.stringify(savedKeywords) !== JSON.stringify(bigKeywords);
  useEffect(() => {
    fetch(`${API}/wonbe/big-keywords`, { headers: getAuthHeaders() })
      .then((r) => r.json())
      .then((d) => { if (d?.ok && Array.isArray(d.keywords)) { setBigKeywords(d.keywords); setSavedKeywords(d.keywords); } })
      .catch(() => {});
  }, []);
  const matchBigKeyword = (name) => bigKeywords.find((k) => k && String(name || "").includes(k)) || "";
  const addBigKeyword = () => {
    const k = keywordInput.trim();
    if (!k) return;
    setBigKeywords((p) => (p.includes(k) ? p : [...p, k]));
    setKeywordInput("");
  };
  const saveBigKeywords = async () => {
    setKwSaving(true);
    try {
      const res = await fetch(`${API}/wonbe/big-keywords`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ keywords: bigKeywords }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || !d.ok) throw new Error(d?.detail || "키워드 저장 실패");
      setBigKeywords(d.keywords);
      setSavedKeywords(d.keywords);
    } catch (err) {
      setTagResult(err.message);
    } finally {
      setKwSaving(false);
    }
  };
  // 이지어드민 동기화 기간: 직접 입력 없이 최근 3일 / 7일 / 한달(30일) 중에서 고른다 (오늘 포함).
  const SYNC_PERIODS = [
    { days: 3, label: "3일" },
    { days: 7, label: "7일" },
    { days: 30, label: "한달" },
  ];
  const [syncMenu, setSyncMenu] = useState(null); // 열려 있는 드롭다운: "sync" | "delete" | null
  const syncMenuRef = useRef(null);
  const [fillMenuOpen, setFillMenuOpen] = useState(false);
  const [ablyPriceMenuOpen, setAblyPriceMenuOpen] = useState(false);
  const ablyPriceMenuRef = useRef(null);
  useEffect(() => {
    if (!ablyPriceMenuOpen) return undefined;
    const onClickOutside = (e) => {
      if (ablyPriceMenuRef.current && !ablyPriceMenuRef.current.contains(e.target)) setAblyPriceMenuOpen(false);
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [ablyPriceMenuOpen]);
  const fillMenuRef = useRef(null);
  useEffect(() => {
    if (!fillMenuOpen) return undefined;
    const onClickOutside = (e) => {
      if (fillMenuRef.current && !fillMenuRef.current.contains(e.target)) setFillMenuOpen(false);
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [fillMenuOpen]);
  useEffect(() => {
    if (!syncMenu) return undefined;
    const onClickOutside = (e) => {
      if (syncMenuRef.current && !syncMenuRef.current.contains(e.target)) setSyncMenu(null);
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [syncMenu]);
  const fmtDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  // 동기화 '직접설정': 달력으로 시작일~종료일 지정
  const [syncCustomOpen, setSyncCustomOpen] = useState(false);
  const [syncCustomStart, setSyncCustomStart] = useState(() => fmtDate(new Date()));
  const [syncCustomEnd, setSyncCustomEnd] = useState(() => fmtDate(new Date()));
  // days: 숫자(최근 N일) 또는 { start, end } (직접설정)
  const syncRange = (days) => {
    if (days && typeof days === "object") return { start: days.start, end: days.end };
    const fmt = fmtDate;
    const end = new Date();
    const start = new Date();
    start.setDate(end.getDate() - (days - 1));
    return { start: fmt(start), end: fmt(end) };
  };
  const [lastSync, setLastSync] = useState(null);
  const [editing, setEditing] = useState(null); // { code, col, value }
  const [editLogOpen, setEditLogOpen] = useState(false); // 수정 로그 보기
  const [editLogs, setEditLogs] = useState([]);
  const [editLogQuery, setEditLogQuery] = useState("");
  const [editLogLoading, setEditLogLoading] = useState(false);
  const inputRef = useRef(null);
  const [sortCol, setSortCol] = useState(null);
  const [sortDir, setSortDir] = useState("asc");
  const [selectedCodes, setSelectedCodes] = useState(new Set());
  // 상품명 일괄변경 계획의 code는 대표상품코드라서, 체크한 행(상품코드)의 대표상품코드로 바꿔 비교한다.
  const selectedReps = useMemo(() => new Set(rows.filter((r) => selectedCodes.has(r["상품코드"])).map((r) => String(r["대표상품코드"] ?? "").trim()).filter(Boolean)), [rows, selectedCodes]);
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
        const set = new Set(saved.filter((c) => ALL_COLS.includes(c)));
        const seen = JSON.parse(localStorage.getItem(NEW_COLS_STORAGE_KEY) || "[]");
        NEW_COLS.forEach((c) => { if (!seen.includes(c)) set.add(c); });
        localStorage.setItem(NEW_COLS_STORAGE_KEY, JSON.stringify(NEW_COLS));
        return set;
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

  // 판매가 설정(원가기준)에서 쓰는 택배비 설정값
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

  // 카테고리 매칭 창은 현재 위치 근처만 그려서 수천 개 상품명에서도 가볍게 유지한다.
  const catCur = Math.min(catIdx, Math.max(catItems.length - 1, 0));
  const catWinStart = Math.max(0, catCur - 5);
  const catWinEnd = Math.min(catItems.length, catCur + 40);
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

  const loadEditLogs = async (q = editLogQuery) => {
    setEditLogLoading(true);
    try {
      const res = await fetch(`${API}/wonbe/edit-log?q=${encodeURIComponent(q.trim())}&limit=300`, { headers: getAuthHeaders() });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "수정 로그 조회 실패");
      setEditLogs(data.logs || []);
    } catch (err) {
      setMessage(err.message);
    } finally {
      setEditLogLoading(false);
    }
  };

  const toggleEditLog = () => {
    const next = !editLogOpen;
    setEditLogOpen(next);
    if (next) loadEditLogs();
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
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && editing) {
      // 방향키: 지금 칸을 저장하고 같은 열의 아래/위 행 칸을 바로 수정 상태로 연다
      const idx = sortedRows.findIndex((r) => r["상품코드"] === editing.code);
      const next = sortedRows[idx + (e.key === "ArrowDown" ? 1 : -1)];
      if (idx < 0 || !next) return;
      e.preventDefault();
      const col = editing.col;
      commitEdit();
      startEdit(next["상품코드"], col, next[col]);
    }
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
      "35"
    );
    if (marginInput === null) return;
    const marginPercent = marginInput.trim() === "" ? 35 : Number(marginInput);
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

  const [pricePushLoading, setPricePushLoading] = useState(false);

  // priceSource: "이벤트전 할인가"(= 판매가) | "이벤트 할인가"(= 이벤트 판매가) - 드롭다운에서 고른 항목
  const handlePushPriceToAbly = async (priceSource) => {
    setAblyPriceMenuOpen(false);
    const codes = Array.from(selectedCodes);
    const label = codes.length ? `체크한 ${codes.length}건` : (query ? `"${query}" 검색 결과` : "전체");
    const sourceName = priceSource === "이벤트 할인가" ? "이벤트 판매가" : "판매가";
    if (!window.confirm(
      `${label} 상품을 [${sourceName}] 기준으로 에이블리 실제 상품가로 변경합니다.\n` +
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
        `[${sourceName}] 기준 에이블리 상품가 변경 완료: 성공 ${data.success_row_count}건 / 실패 ${data.error_row_count}건 ` +
        `(요청 ${data.requested}건, 제외 - 값이상 ${data.skipped_invalid}건 · 중복상품 ${data.skipped_duplicate}건 · 제외그룹 ${data.skipped_group_excluded ?? 0}건)`
      );
    } catch (err) {
      setMessage(err.message);
    } finally {
      setPricePushLoading(false);
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

  const handleSyncEzadmin = async (days) => {
    setSyncMenu(null);
    const range = syncRange(days);
    setSyncing(true);
    setMessage("");
    setRawUnexpected(null);
    try {
      const res = await fetch(`${API}/wonbe/sync-from-ezadmin`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ start_date: range.start, end_date: range.end }),
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
      if (Array.isArray(data.groups) && data.groups.length) {
        setTagManual(false);
        setTagGroups(data.groups.map((g) => ({ ...g, checked: false, number: 1 })));
      }
      // 동기화가 끝난 뒤 이어서 배포앱(Turso)으로 자동 전송 (동기화 실패 시에는 여기까지 오지 않는다)
      const syncMsg = `동기화 완료: ${data.fetched}개 조회 → ${data.inserted}개 신규 등록` +
        (data.backfilled ? ` · 기존 상품 아이디 ${data.backfilled}건 채움` : "");
      setMessage(`${syncMsg} · 배포앱 전송 중...`);
      try {
        setMessage(`${syncMsg} · ${await runPushToDeploy()}`);
      } catch (pushErr) {
        setMessage(`${syncMsg} · 배포앱전송 실패: ${pushErr.message} (배포앱전송 버튼으로 다시 시도하세요)`);
      }
    } catch (err) {
      setMessage(err.message);
    } finally {
      setSyncing(false);
    }
  };

  // [대형 수정] 체크한 상품이 있으면 그 상품, 없으면 현재 검색 결과 전체를 상품명별로 묶어 번호/대형태그 리스트를 연다.
  // 동기화 때 이미 처리 완료된 상품도 다시 고칠 수 있다.
  const handleOpenBigEdit = async () => {
    const codes = [...selectedCodes];
    if (!codes.length && !query) { setMessage("상품명을 먼저 검색하거나 상품을 체크해주세요."); return; }
    setBigLoading(true);
    try {
      const res = await fetch(`${API}/wonbe/big-groups`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ codes, q: query, empty_col: emptyCol, group_id: activeGroupId || 0 }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "대형 수정 목록 조회 실패");
      if (!data.groups?.length) { setMessage("대상 상품이 없습니다."); return; }
      setTagManual(true);
      setTagOnlyUnnumbered(false);
      setTagResult("");
      setTagGroups(data.groups.map((g) => ({ ...g, checked: true, number: g.current_number || 1 })));
      setMessage(`대형 수정: ${codes.length ? `체크한 ${codes.length}개` : `"${query}" 검색 결과`} → ${data.groups.length}개 상품명. 번호 고른 뒤 [선택 적용]을 누르세요.`);
    } catch (err) {
      setMessage(err.message);
    } finally {
      setBigLoading(false);
    }
  };

  // 체크한 상품을 이지어드민에 반영. 전부 성공하면 true (fromComplete: 완료 버튼에서 호출 시 목록을 닫지 않고 결과만 반환)
  const handleApplyTagGroups = async (fromComplete = false) => {
    const sent = (tagGroups || [])
      .map((g, gi) => ({ g, gi }))
      .filter(({ g }) => g.checked && !(tagManual && tagOnlyUnnumbered && g.current_number)); // 필터로 숨긴 상품은 적용하지 않는다
    const items = sent.map(({ g }) => ({ name: g.name, codes: g.codes, ids: g.ids, number: g.number }));
    if (!items.length) { setTagResult("적용할 상품을 선택해주세요."); setMessage("적용할 상품을 선택해주세요."); return false; }
    setTagApplying(true);
    setTagResult(`이지어드민에 반영 중... (${items.length}개 상품, 상품마다 저장 후 다시 확인하느라 시간이 걸립니다)`);
    setRawUnexpected(null);
    const report = (text) => { setTagResult(text); setMessage(text); };
    try {
      const res = await fetch(`${API}/wonbe/ezadmin-apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ items }),
      });
      const data = await res.json().catch(() => ({}));
      if (data?.need_session) { report("이지어드민 세션이 없거나 만료되었습니다. EZAdmin 설정에서 PHPSESSID를 다시 등록해주세요."); return false; }
      if (!res.ok) throw new Error(data?.detail || `적용 실패 (서버 응답 ${res.status})`);
      const failed = data.failed || [];
      report(
        `결과: 상품명 변경 ${data.renamed ?? 0}건 · 이미 같은 번호 ${data.same ?? 0}건` +
        (failed.length ? ` · 실패 ${failed.length}건` : "") +
        (data.unresolved ? ` · 이지어드민 아이디 못 찾은 코드 ${data.unresolved}건` : "") +
        (data.detail ? ` · ${data.detail}` : ` · 대형태그 ${data.tag_applied ?? 0}건` + (data.tag_failed ? ` (태그 실패 ${data.tag_failed})` : ""))
      );
      if (failed.length) setRawUnexpected({ 실패목록: failed });
      // 성공한 상품은 목록에서 '현재 N번'으로 바로 갱신
      const okByGroup = new Map();
      (data.items || []).forEach((r) => { if (r.ok && sent[r.index]) okByGroup.set(sent[r.index].gi, r.number); });
      if (okByGroup.size) {
        setTagGroups((p) => (p ? p.map((x, j) => (okByGroup.has(j) ? { ...x, current_number: okByGroup.get(j), checked: false } : x)) : p));
      }
      if (data.ok && !fromComplete && !tagManual) setTagGroups(null);
      return !!data.ok;
    } catch (err) {
      report(err.message);
      return false;
    } finally {
      setTagApplying(false);
    }
  };

  // 완료 = 체크한 상품 선택 적용 + 목록 전체 처리 완료 기록 → 다음 동기화부터 목록에 뜨지 않음
  const handleCompleteTagGroups = async () => {
    const codes = (tagGroups || []).flatMap((g) => g.codes || []);
    if (!codes.length) { setTagGroups(null); return; }
    if ((tagGroups || []).some((g) => g.checked)) {
      const applied = await handleApplyTagGroups(true);
      if (!applied) return; // 반영 실패 시 완료 처리하지 않고 목록 유지 (메시지는 위에서 표시됨)
    }
    setTagApplying(true);
    try {
      const res = await fetch(`${API}/wonbe/tag-done`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ codes }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "완료 처리 실패");
      setMessage(`완료 처리: ${data.marked}개 상품코드 (선택 상품은 이지어드민 반영 포함) — 다음 동기화부터 목록에 나타나지 않습니다.`);
      setTagGroups(null);
    } catch (err) {
      setMessage(err.message);
    } finally {
      setTagApplying(false);
    }
  };

  const handleDeleteByRegisteredDate = async (days) => {
    setSyncMenu(null);
    const range = syncRange(days);
    if (!window.confirm(`"${range.start} ~ ${range.end}" 범위의 등록일 데이터를 삭제합니다.\n진행하시겠습니까?`)) return;
    setDeletingByDate(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/wonbe/by-registered-date`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ start: range.start, end: range.end }),
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

  const handleFillRepCode = async () => {
    const codes = Array.from(selectedCodes);
    setRepCodeSyncing(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/wonbe/fill-rep-code`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify(codes.length ? { codes } : {}),
      });
      const data = await res.json().catch(() => ({}));
      if (data?.need_session) { setMessage("이지어드민 세션이 없습니다. EZAdmin 설정에서 PHPSESSID를 먼저 등록해주세요."); return; }
      if (!res.ok || !data.ok) throw new Error(data?.detail || "대표상품코드 채우기 실패");
      const scopeNote = codes.length ? ` (체크한 ${codes.length}건 대상)` : "";
      let st = data;
      while (st.running) {
        setMessage(`대표상품코드 채우는 중${scopeNote}: ${st.done}/${st.total} (${Math.round((st.done / Math.max(st.total, 1)) * 100)}%) · 채움 ${st.filled} · 미조회 ${st.not_found} · 중복 ${st.ambiguous}`);
        await new Promise((r) => setTimeout(r, 1000));
        const sr = await fetch(`${API}/wonbe/fill-rep-code/status`, { headers: getAuthHeaders() });
        st = await sr.json().catch(() => ({ running: false }));
      }
      if (st.error) throw new Error(`대표상품코드 채우기 오류: ${st.error}`);
      setMessage(
        `대표상품코드 채우기 완료${scopeNote}: ${st.total}건 중 ${st.filled}건 채움 · 미조회 ${st.not_found} · 중복 ${st.ambiguous}` +
        (st.session_expired ? " · 세션 만료로 중단됨(PHPSESSID 재등록 필요)" : "")
      );
      await fetchRows(query, offset, emptyCol);
    } catch (err) {
      setMessage(err.message);
    } finally {
      setRepCodeSyncing(false);
    }
  };

  const loadCategoryItems = async (reverse) => {
    const res = await fetch(`${API}/wonbe/category-match/names`, { headers: getAuthHeaders() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data?.detail || "상품명 목록 조회 실패");
    setCatItems(reverse ? [...data.items].reverse() : data.items);
    setCatIdx(0);
  };

  const openCategoryMatch = async () => {
    setMessage("");
    try {
      // 마지막 단어 규칙으로 정해지는 상품명은 먼저 자동 저장하고, 사람이 골라야 할 것만 목록에 띄운다.
      await fetch(`${API}/wonbe/category-match/auto-apply`, { method: "POST", headers: getAuthHeaders() });
      await loadCategoryItems(catReverse);
      setCatOpen(true);
    } catch (err) {
      setMessage(err.message);
    }
  };

  // 다른 사람이 이미 매칭한 상품명을 빼고 목록을 다시 불러온다 (동시 작업용).
  const refreshCategoryItems = async (reverse = catReverse) => {
    try {
      await loadCategoryItems(reverse);
    } catch (err) {
      setMessage(err.message);
    }
  };

  const setCatOf = (name, category) =>
    setCatItems((prev) => prev.map((it) => (it.name === name ? { ...it, category: it.category === category ? "" : category } : it)));

  const applyCategoryMatch = useCallback(async () => {
    const idx = Math.min(catIdx, catItems.length - 1);
    const cur = catItems[idx];
    if (!cur) { setCatOpen(false); return; }
    if (!cur.category) { setMessage(`"${cur.name}"의 카테고리를 먼저 선택해주세요.`); return; }
    setCatSaving(true);
    try {
      const res = await fetch(`${API}/wonbe/category-match/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ items: [{ name: cur.name, category: cur.category }] }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "카테고리 매칭 실패");
      setMessage(data.rows ? `카테고리 매칭: "${cur.name}" → ${cur.category} (${data.rows}행 반영)` : `"${cur.name}"은(는) 이미 다른 곳에서 매칭돼 건너뜁니다.`);
      const rest = catItems.filter((it) => it.name !== cur.name);
      setCatItems(rest);
      setCatIdx(Math.min(idx, Math.max(rest.length - 1, 0)));
      if (!rest.length) {
        setCatOpen(false);
        await fetchRows(query, offset, emptyCol);
      }
    } catch (err) {
      setMessage(err.message);
    } finally {
      setCatSaving(false);
    }
  }, [catItems, catIdx, fetchRows, query, offset, emptyCol]);

  const closeCategoryMatch = () => {
    setCatOpen(false);
    fetchRows(query, offset, emptyCol);
  };

  useEffect(() => {
    if (!catOpen) return undefined;
    const onKey = (e) => {
      if (e.key === "F9") { e.preventDefault(); if (!catSaving) applyCategoryMatch(); }
      else if (e.key === "Escape") closeCategoryMatch();
      else if (e.key === "ArrowDown") { e.preventDefault(); setCatIdx((i) => Math.min(i + 1, Math.max(catItems.length - 1, 0))); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setCatIdx((i) => Math.max(i - 1, 0)); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [catOpen, catSaving, applyCategoryMatch, catItems.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadRenamePlan = async (cats = rnCats, force = rnForce) => {
    const res = await fetch(`${API}/wonbe/name-rename/plan?categories=${encodeURIComponent(cats.join(","))}&force=${force}`, { headers: getAuthHeaders() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data?.detail || "상품명 변경 계산 실패");
    setRnPlan(data);
  };

  const openRename = async () => {
    setMessage("");
    try {
      await loadRenamePlan();
      setRnOpen(true);
    } catch (err) {
      setMessage(err.message);
    }
  };

  const toggleRnCat = async (cat) => {
    const next = rnCats.includes(cat) ? rnCats.filter((c) => c !== cat) : [...rnCats, cat];
    setRnCats(next);
    if (!next.length) return;
    setRnBusy(true);
    try {
      await loadRenamePlan(next);
    } catch (err) {
      setMessage(err.message);
    } finally {
      setRnBusy(false);
    }
  };

  const toggleRnForce = async () => {
    const next = !rnForce;
    setRnForce(next);
    setRnBusy(true);
    try {
      await loadRenamePlan(rnCats, next);
    } catch (err) {
      setMessage(err.message);
    } finally {
      setRnBusy(false);
    }
  };

  // 이지어드민의 현재 상품명을 전부 읽어 계획과 비교한다. "이미 올림" 기록만 믿지 않고 실제 이름으로 다시 확인한다.
  const recheckRename = async () => {
    setRnBusy(true);
    setRnCheck(null);
    setRnCheckMsg("이지어드민 상품명 읽는 중...");
    try {
      const res = await fetch(`${API}/wonbe/name-rename/recheck`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ categories: rnCats }),
      });
      let st = await res.json().catch(() => ({}));
      if (st?.need_session) { setMessage("이지어드민 세션이 없거나 만료됐습니다. EZAdmin 설정에서 PHPSESSID를 등록해주세요."); return; }
      if (!res.ok || !st.ok) throw new Error(st?.detail || "전체 재조회 실패");
      while (st.running) {
        setRnCheckMsg(st.pages ? `이지어드민 상품명 읽는 중... (${st.page}/${st.pages}쪽)` : "이지어드민 상품명 읽는 중... (몇 분 걸릴 수 있어요)");
        await new Promise((r) => setTimeout(r, 1500));
        const sr = await fetch(`${API}/wonbe/name-rename/recheck/status`, { headers: getAuthHeaders() });
        st = await sr.json().catch(() => ({ running: false, error: "상태 조회 실패" }));
      }
      if (st.session_expired) { setMessage("재조회 중 이지어드민 세션이 만료됐습니다. PHPSESSID를 다시 등록해주세요."); return; }
      if (st.error) throw new Error(`전체 재조회 오류: ${st.error}`);
      setRnCheck(st);
      setRnForce(false);
      await loadRenamePlan(rnCats, false); // 기록이 바로잡혔으니 실제로 다른 상품만 변경 대상에 나온다
    } catch (err) {
      setMessage(err.message);
    } finally {
      setRnCheckMsg("");
      setRnBusy(false);
    }
  };

  const setColorLetter = async (category, color, letter) => {
    setRnBusy(true);
    try {
      const res = await fetch(`${API}/wonbe/name-rename/color-map`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ category, color, letter }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "컬러 매칭 저장 실패");
      await loadRenamePlan();
    } catch (err) {
      setMessage(err.message);
    } finally {
      setRnBusy(false);
    }
  };

  const uploadRename = async () => {
    const targets = selectedCodes.size ? rnPlan?.items?.filter((it) => selectedReps.has(it.code)) : rnPlan?.items;
    if (!targets?.length) return;
    if (!window.confirm(`[${rnCats.join(", ")}] ${selectedCodes.size ? "체크한 " : ""}EZAdmin 상품 ${targets.length}개의 상품명을 변경합니다. (실제 상품명이 바뀝니다)
진행하시겠습니까?`)) return;
    setRnBusy(true);
    const codes = targets.map((it) => it.code);
    const chunkSize = 200;
    let uploaded = 0;
    let errCnt = 0;
    setRnProgress({ done: 0, total: codes.length });
    try {
      for (let i = 0; i < codes.length; i += chunkSize) {
        const res = await fetch(`${API}/wonbe/name-rename/upload`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...getAuthHeaders() },
          body: JSON.stringify({ categories: rnCats, codes: codes.slice(i, i + chunkSize), force: rnForce }),
        });
        const data = await res.json().catch(() => ({}));
        if (data?.need_session) {
          setMessage(`이지어드민 세션이 없거나 만료됐습니다. EZAdmin 설정에서 PHPSESSID를 등록해주세요. (${uploaded}/${codes.length}개 업로드됨)`);
          return;
        }
        if (!res.ok) throw new Error(`${data?.detail || "상품명 일괄변경 실패"} (${uploaded}/${codes.length}개 업로드됨)`);
        uploaded += data.uploaded || 0;
        errCnt += data.err_cnt || 0;
        setRnProgress({ done: Math.min(i + chunkSize, codes.length), total: codes.length });
      }
      setMessage(errCnt === 0
        ? `상품명 일괄변경 완료: ${uploaded}개 업로드 · EZAdmin 오류 0건`
        : `상품명 일괄변경 업로드됨(${uploaded}개) · EZAdmin 오류 ${errCnt}건 — C620 화면에서 확인해주세요`);
      if (errCnt === 0) setRnOpen(false);
    } catch (err) {
      setMessage(err.message);
    } finally {
      setRnBusy(false);
      setRnProgress(null);
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

  const [deploySyncing, setDeploySyncing] = useState(false);

  // 로컬 원가베이스유를 Turso로 전송. 성공 시 결과 문구, 실패 시 예외를 던진다.
  const runPushToDeploy = async () => {
    setDeploySyncing(true);
    try {
      const res = await fetch(`${API}/wonbe/push-to-deploy`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "배포앱전송 실패");
      return `배포앱전송 완료: ${data.pushed}/${data.total_local}건`;
    } finally {
      setDeploySyncing(false);
    }
  };

  const handlePushToDeploy = async () => {
    if (!window.confirm(`로컬 원가베이스유(${total.toLocaleString()}행)를 Turso로 전송해 배포앱에서 읽을 수 있게 합니다.
진행하시겠습니까?`)) return;
    setMessage("");
    try {
      setMessage(await runPushToDeploy());
    } catch (err) {
      setMessage(err.message);
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
            placeholder="상품코드 / 상품명합 / 거래처합 / 거래처 / 태그"
          />
          <button className={`${styles.btn} ${styles.btnPrimary}`} type="submit" disabled={loading}>
            검색
          </button>
        </form>
        <button
          className={`${styles.btn} ${styles.btnSecondary}`}
          onClick={handleOpenBigEdit}
          disabled={loading || bigLoading || tagApplying || (!query && !selectedCodes.size)}
          title="체크한 상품(없으면 검색된 상품 전체)의 이지어드민 상품명 앞에 번호(1·2·3…)를 붙이고 대형태그를 겁니다. 동기화 때 처리 끝난 상품도 다시 고칠 수 있습니다."
        >
          {bigLoading ? "불러오는 중..." : `대형 수정${selectedCodes.size ? ` (${selectedCodes.size})` : ""}`}
        </button>
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
        <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "0.5rem", width: "100%" }}>
          <span style={{ fontSize: "0.72rem", fontWeight: 700, color: "#6b7280", minWidth: "84px" }}>가격 설정</span>
        <button
          className={`${styles.btn} ${styles.btnPrimary}`}
          onClick={handleFillEventPreDiscountPrice}
          disabled={loading || preDiscountPriceLoading}
          title="원가로 P = (원가×1.10 + 택배비) ÷ (1 − 수수료율 8.756% − 목표순마진율)을 역산해 이벤트전 할인가를 채웁니다 (10원 단위 올림)"
        >
          <RefreshCcw size={13} />{preDiscountPriceLoading ? "설정 중..." : "판매가 설정"}
        </button>
        <button
          className={`${styles.btn} ${styles.btnPrimary}`}
          onClick={handleFillEventDiscount}
          disabled={loading || eventDiscountLoading}
          title="이벤트전 할인가에 퍼센트를 올린 값을 이벤트 할인가에 채웁니다"
        >
          <RefreshCcw size={13} />{eventDiscountLoading ? "설정 중..." : "이벤트 판매가 설정"}
        </button>
        <button
          className={`${styles.btn} ${styles.btnPrimary}`}
          onClick={handleFillSalePrice}
          disabled={loading || salePriceLoading}
          title="원가 구간별 배수(3000~5500원 5배 / 5600~7500원 4배 / 7600원~ 3배)로 판매가를 채웁니다 (일괄제외 그룹 상품은 제외)"
        >
          <RefreshCcw size={13} />{salePriceLoading ? "채우는 중..." : "판매가 채우기"}
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
            title="이벤트 판매가 설정 / 판매가 설정에서 제외할 에이블리상품번호"
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
                에이블리상품번호를 한 줄에 하나씩(또는 콤마로 구분) 입력하세요. 이벤트 판매가 설정 / 판매가 설정에서 제외됩니다.
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
        </div>
        <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "0.5rem", width: "100%" }}>
          <span style={{ fontSize: "0.72rem", fontWeight: 700, color: "#6b7280", minWidth: "84px" }}>상품가 변경</span>
        <div style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>
          <div ref={ablyPriceMenuRef} style={{ position: "relative" }}>
            <button
              className={`${styles.btn} ${styles.btnDanger}`}
              onClick={() => setAblyPriceMenuOpen((v) => !v)}
              disabled={loading || pricePushLoading}
              title="누르면 판매가 / 이벤트 판매가 중 하나를 골라 에이블리 실제 상품가로 일괄 변경합니다 (일괄제외 그룹 상품은 제외)"
            >
              <RefreshCcw size={13} />{pricePushLoading ? "변경 중..." : "에이블리 상품가 변경 ▾"}
            </button>
            {ablyPriceMenuOpen && (
              <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 20, background: "#fff", border: "1px solid #d1d5db", borderRadius: "6px", padding: "4px", boxShadow: "0 4px 12px rgba(0,0,0,0.12)", display: "flex", flexDirection: "column", gap: "2px", minWidth: "150px" }}>
                <button type="button" style={{ textAlign: "left", padding: "6px 10px", fontSize: "0.82rem", border: "none", background: "transparent", cursor: "pointer", borderRadius: "4px", whiteSpace: "nowrap" }} onClick={() => handlePushPriceToAbly("이벤트전 할인가")}>판매가로 변경</button>
                <button type="button" style={{ textAlign: "left", padding: "6px 10px", fontSize: "0.82rem", border: "none", background: "transparent", cursor: "pointer", borderRadius: "4px", whiteSpace: "nowrap" }} onClick={() => handlePushPriceToAbly("이벤트 할인가")}>이벤트 판매가로 변경</button>
              </div>
            )}
          </div>
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
        </div>
        <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "0.5rem", width: "100%" }}>
          <span style={{ fontSize: "0.72rem", fontWeight: 700, color: "#6b7280", minWidth: "84px" }}>데이터 채우기</span>
        <div ref={fillMenuRef} style={{ position: "relative" }}>
          <button
            className={`${styles.btn} ${styles.btnPrimary}`}
            onClick={() => setFillMenuOpen((v) => !v)}
            disabled={loading || snoSyncing || repCodeSyncing || regDateSyncing}
            title={selectedCodes.size ? `체크한 ${selectedCodes.size}건만 채웁니다` : "누르면 채울 항목을 골라 전체 상품을 대상으로 채웁니다 (체크하면 체크한 건만 진행)"}
          >
            <RefreshCcw size={13} />{snoSyncing || repCodeSyncing || regDateSyncing ? "채우는 중..." : "채우기 ▾"}
          </button>
          {fillMenuOpen && (
            <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 20, background: "#fff", border: "1px solid #d1d5db", borderRadius: "6px", padding: "4px", boxShadow: "0 4px 12px rgba(0,0,0,0.12)", display: "flex", flexDirection: "column", gap: "2px", minWidth: "170px" }}>
              <button type="button" style={{ textAlign: "left", padding: "6px 10px", fontSize: "0.82rem", border: "none", background: "transparent", cursor: "pointer", borderRadius: "4px", whiteSpace: "nowrap" }} onClick={() => { setFillMenuOpen(false); handleSyncAblySno(); }}>에이블리상품번호 채우기</button>
              <button type="button" style={{ textAlign: "left", padding: "6px 10px", fontSize: "0.82rem", border: "none", background: "transparent", cursor: "pointer", borderRadius: "4px", whiteSpace: "nowrap" }} onClick={() => { setFillMenuOpen(false); handleFillRepCode(); }}>대표상품코드 채우기</button>
              <button type="button" style={{ textAlign: "left", padding: "6px 10px", fontSize: "0.82rem", border: "none", background: "transparent", cursor: "pointer", borderRadius: "4px", whiteSpace: "nowrap" }} onClick={() => { setFillMenuOpen(false); handleSyncRegistrationDate(); }}>등록일 채우기</button>
            </div>
          )}
        </div>
        <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={openRename} disabled={loading} title="카테고리(상의 A/하의 B/아우터 C)+컬러 글자를 상품명 앞에 붙여 EZAdmin 상품명을 일괄 변경합니다">
          상품명 일괄변경
        </button>
        <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={openCategoryMatch} disabled={loading} title="유니크한 상품명을 상의/하의/아우터로 분류해 카테고리를 채웁니다 (F9로 적용)">
          카테고리 매칭
        </button>
        </div>
        <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "0.5rem", width: "100%" }}>
          <span style={{ fontSize: "0.72rem", fontWeight: 700, color: "#6b7280", minWidth: "84px" }}>동기화 · 내보내기</span>
        <div ref={syncMenuRef} style={{ display: "flex", alignItems: "center", gap: "0.5rem", position: "relative" }}>
          <div style={{ position: "relative" }}>
            <button
              className={`${styles.btn} ${styles.btnPrimary}`}
              onClick={() => setSyncMenu((v) => (v === "sync" ? null : "sync"))}
              disabled={loading || syncing}
              title="누르면 기간(3일 / 7일 / 한달 / 직접설정)을 골라 동기화합니다"
            >
              <RefreshCcw size={13} />{syncing ? "동기화 중..." : "이지어드민 동기화 ▾"}
            </button>
            {syncMenu === "sync" && (
              <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 20, background: "#fff", border: "1px solid #d1d5db", borderRadius: "6px", padding: "4px", boxShadow: "0 4px 12px rgba(0,0,0,0.12)", display: "flex", flexDirection: "column", gap: "2px", minWidth: "120px" }}>
                {SYNC_PERIODS.map((p) => (
                  <button key={p.days} type="button" style={{ textAlign: "left", padding: "6px 10px", fontSize: "0.82rem", border: "none", background: "transparent", cursor: "pointer", borderRadius: "4px" }} onClick={() => handleSyncEzadmin(p.days)} title={`오늘 포함 최근 ${p.days}일`}>
                    최근 {p.label}
                  </button>
                ))}
                <div style={{ borderTop: "1px solid #e5e7eb", marginTop: "2px", paddingTop: "2px" }}>
                  <button type="button" style={{ width: "100%", textAlign: "left", padding: "6px 10px", fontSize: "0.82rem", border: "none", background: "transparent", cursor: "pointer", borderRadius: "4px" }} onClick={() => setSyncCustomOpen((v) => !v)} title="달력으로 기간을 직접 골라 동기화합니다">
                    직접설정 {syncCustomOpen ? "▴" : "▾"}
                  </button>
                  {syncCustomOpen && (
                    <div style={{ display: "flex", flexDirection: "column", gap: "4px", padding: "4px 10px 6px", fontSize: "0.8rem" }}>
                      <label style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                        시작
                        <input type="date" value={syncCustomStart} max={syncCustomEnd} onChange={(e) => setSyncCustomStart(e.target.value)} />
                      </label>
                      <label style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                        종료
                        <input type="date" value={syncCustomEnd} min={syncCustomStart} onChange={(e) => setSyncCustomEnd(e.target.value)} />
                      </label>
                      <button
                        type="button"
                        className={`${styles.btn} ${styles.btnPrimary}`}
                        disabled={!syncCustomStart || !syncCustomEnd || syncCustomStart > syncCustomEnd}
                        onClick={() => handleSyncEzadmin({ start: syncCustomStart, end: syncCustomEnd })}
                      >
                        이 기간으로 동기화
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
          <div style={{ position: "relative" }}>
            <button
              className={`${styles.btn} ${styles.btnSecondary}`}
              onClick={() => setSyncMenu((v) => (v === "delete" ? null : "delete"))}
              disabled={loading || deletingByDate}
              title="등록일이 선택한 기간에 속하는 데이터를 삭제합니다"
            >
              <Trash2 size={13} />{deletingByDate ? "삭제 중..." : "등록일 삭제 ▾"}
            </button>
            {syncMenu === "delete" && (
              <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 20, background: "#fff", border: "1px solid #d1d5db", borderRadius: "6px", padding: "4px", boxShadow: "0 4px 12px rgba(0,0,0,0.12)", display: "flex", flexDirection: "column", gap: "2px", minWidth: "120px" }}>
                {SYNC_PERIODS.map((p) => (
                  <button key={p.days} type="button" style={{ textAlign: "left", padding: "6px 10px", fontSize: "0.82rem", border: "none", background: "transparent", cursor: "pointer", borderRadius: "4px" }} onClick={() => handleDeleteByRegisteredDate(p.days)} title={`오늘 포함 최근 ${p.days}일`}>
                    최근 {p.label} 삭제
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        <button className={`${styles.btn} ${styles.btnSecondary}`} onClick={handleExport} disabled={loading}>
          <Download size={13} />xls 내보내기
        </button>
        <button className={`${styles.btn} ${styles.btnSecondary}`} onClick={toggleEditLog} title="원가베이스유를 수정·삭제한 내역 (누가, 언제, 무엇을)">
          수정 로그
        </button>
        <button
          className={`${styles.btn} ${styles.btnPrimary}`}
          onClick={handlePushToDeploy}
          disabled={loading || deploySyncing}
          title="로컬 원가베이스유를 Turso로 전송해 배포앱(발주추천 등)에서 읽을 수 있게 합니다"
        >
          <CloudUpload size={13} />{deploySyncing ? "전송 중..." : "배포앱전송"}
        </button>
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
      </div>

      {message && <div className={styles.message}>{message}</div>}
      {rawUnexpected && (
        <pre className={styles.rawBlock}>{JSON.stringify(rawUnexpected, null, 2)}</pre>
      )}
      {editLogOpen && (
        <div style={{ border: "1px solid #ccc", borderRadius: 6, padding: 12, margin: "8px 0", maxHeight: 360, overflow: "auto", background: "#fff" }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8, flexWrap: "wrap" }}>
            <strong>원가베이스유 수정 로그 ({editLogs.length}건, 최신순)</strong>
            <input
              value={editLogQuery}
              onChange={(e) => setEditLogQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") loadEditLogs(); }}
              placeholder="상품코드·상품명·칸·수정자 검색"
              style={{ width: 220 }}
            />
            <button onClick={() => loadEditLogs()} disabled={editLogLoading}>{editLogLoading ? "조회 중..." : "검색"}</button>
            <button onClick={() => setEditLogOpen(false)}>닫기</button>
          </div>
          {editLogs.length === 0 && !editLogLoading ? (
            <div style={{ color: "#888", fontSize: 13 }}>수정 로그가 없습니다.</div>
          ) : (
            <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
                  <th>일시</th><th>수정자</th><th>구분</th><th>상품코드</th><th>상품</th><th>칸</th><th>이전 값</th><th>변경 값</th><th>비고</th>
                </tr>
              </thead>
              <tbody>
                {editLogs.map((l) => (
                  <tr key={l.id} style={{ borderBottom: "1px solid #f0f0f0" }}>
                    <td style={{ whiteSpace: "nowrap" }}>{l.created_at}</td>
                    <td>{l.username}</td>
                    <td>{l.action === "edit" ? "수정" : l.action === "bulk-edit" ? "일괄수정" : l.action === "delete" ? "삭제" : l.action}</td>
                    <td>{l["상품코드"]}</td>
                    <td>{l["상품명"]}</td>
                    <td>{l.col}</td>
                    <td style={{ color: "#b91c1c" }}>{l.old_value}</td>
                    <td style={{ color: "#15803d" }}>{l.new_value}</td>
                    <td style={{ color: "#666" }}>{l.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      {tagGroups && (
        <div style={{ border: "1px solid #ccc", borderRadius: 6, padding: 12, margin: "8px 0", maxHeight: 360, overflow: "auto" }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
            <strong>{tagManual ? "대형 수정" : "이지어드민 대형태그 / 상품명 번호"} ({tagGroups.length}개 상품)</strong>
            <span>
              <button onClick={() => handleApplyTagGroups()} disabled={tagApplying}>{tagApplying ? "적용 중..." : "선택 적용"}</button>{" "}
              {!tagManual && <><button onClick={handleCompleteTagGroups} disabled={tagApplying} title="체크한 상품은 이지어드민에 반영한 뒤, 목록 전체를 처리 완료로 기록 — 다음 동기화부터 안 뜸">완료</button>{" "}</>}
              <button onClick={() => { setTagGroups(null); setTagResult(""); }} disabled={tagApplying}>닫기</button>
            </span>
          </div>
          {tagResult && (
            <div style={{ padding: "6px 8px", marginBottom: 6, background: "#f3f4f6", borderRadius: 4, fontSize: 13, fontWeight: 600 }}>
              {tagResult}
            </div>
          )}
          {(() => {
            // 지금 화면에 보이는 목록(필터 적용 후) 전체에 한 번에 적용
            const isVisible = (g) => !(tagManual && tagOnlyUnnumbered && g.current_number);
            const visible = tagGroups.filter(isVisible);
            const allChecked = visible.length > 0 && visible.every((g) => g.checked);
            return (
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 6, paddingBottom: 6, borderBottom: "1px solid #eee", fontSize: 13 }}>
                <label style={{ display: "flex", gap: 4, alignItems: "center", cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={allChecked}
                    onChange={(e) => setTagGroups((p) => p.map((x) => (isVisible(x) ? { ...x, checked: e.target.checked } : x)))}
                  />
                  전체 선택 ({visible.filter((g) => g.checked).length}/{visible.length})
                </label>
                <span style={{ marginLeft: 8 }}>전체 번호:</span>
                {[1, 2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    disabled={tagApplying}
                    onClick={() => setTagGroups((p) => p.map((x) => (isVisible(x) ? { ...x, number: n } : x)))}
                    style={{ minWidth: 28 }}
                  >
                    {n}
                  </button>
                ))}
              </div>
            );
          })()}
          {tagManual && (
            <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 6, fontSize: 13 }}>
              <label style={{ display: "flex", gap: 4, alignItems: "center", cursor: "pointer" }}>
                <input type="checkbox" checked={tagOnlyUnnumbered} onChange={(e) => setTagOnlyUnnumbered(e.target.checked)} />
                번호(1·2·3) 없는 상품만
              </label>
              <span style={{ color: "#888" }}>
                번호 있음 {tagGroups.filter((g) => g.current_number).length} · 번호 없음 {tagGroups.filter((g) => !g.current_number).length}
              </span>
            </div>
          )}
          {/* 대형 추천 키워드: 상품명에 들어 있으면 맨 위로 추천 (추가/삭제 후 저장) */}
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 6, fontSize: 13 }}>
            <span style={{ fontWeight: 600 }}>대형 추천 키워드:</span>
            {bigKeywords.map((k) => (
              <span key={k} style={{ display: "inline-flex", alignItems: "center", gap: 2, padding: "1px 6px", background: "#fef3c7", borderRadius: 10 }}>
                {k}
                <button type="button" onClick={() => setBigKeywords((p) => p.filter((x) => x !== k))} style={{ border: "none", background: "transparent", cursor: "pointer", padding: 0, color: "#92400e" }} title="키워드 빼기">×</button>
              </span>
            ))}
            <input
              value={keywordInput}
              onChange={(e) => setKeywordInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addBigKeyword(); } }}
              placeholder="키워드 추가"
              style={{ width: 90 }}
            />
            <button type="button" onClick={addBigKeyword} disabled={!keywordInput.trim()}>추가</button>
            <button type="button" onClick={saveBigKeywords} disabled={kwSaving || !kwDirty}>{kwSaving ? "저장 중..." : kwDirty ? "키워드 저장" : "저장됨"}</button>
            <span style={{ color: "#888" }}>추천 {tagGroups.filter((g) => matchBigKeyword(g.name)).length}개</span>
          </div>
          {tagGroups.map((g, i) => ({ g, i, kw: matchBigKeyword(g.name) }))
            .filter(({ g }) => !(tagManual && tagOnlyUnnumbered && g.current_number))
            .sort((a, b) => (a.kw ? 0 : 1) - (b.kw ? 0 : 1) || a.i - b.i) // 키워드 상품을 위로, 나머지는 원래 순서
            .map(({ g, i, kw }) => (
            <div key={g.name + i} style={{ display: "flex", gap: 8, alignItems: "center", padding: "2px 0", background: kw ? "#fffbeb" : undefined }}>
              <input
                type="checkbox"
                checked={g.checked}
                onChange={(e) => setTagGroups((p) => p.map((x, j) => (j === i ? { ...x, checked: e.target.checked } : x)))}
              />
              <select
                value={g.number}
                onChange={(e) => setTagGroups((p) => p.map((x, j) => (j === i ? { ...x, number: Number(e.target.value) } : x)))}
              >
                {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
              {kw && <span style={{ color: "#fff", background: "#d97706", borderRadius: 4, padding: "0 5px", fontSize: 11 }} title={`상품명에 '${kw}' 포함`}>추천 · {kw}</span>}
              <span>{g.name}</span>
              <span style={{ color: "#888" }}>({g.count}코드)</span>
              {tagManual && (g.current_number
                ? <span style={{ color: "#2563eb", fontSize: 12 }}>현재 {g.current_number}번</span>
                : <span style={{ color: "#d97706", fontSize: 12 }}>번호 없음</span>)}
            </div>
          ))}
        </div>
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
      {catOpen && (
        <div className={styles.catOverlay} onClick={closeCategoryMatch}>
          <div className={styles.catModal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.catHeader}>
              <strong>카테고리 매칭</strong>
              <span>남은 상품명 {catItems.length}개 · 체크 후 F9 = 적용하고 다음 상품으로 · ↑↓ 이동 · Esc 닫기</span>
              <span>
                <label><input type="checkbox" checked={catReverse} onChange={(e) => { setCatReverse(e.target.checked); refreshCategoryItems(e.target.checked); }} /> 밑에서부터(역순)</label>
                {" "}<button className={`${styles.btn} ${styles.btnSecondary}`} onClick={() => refreshCategoryItems()}>새로고침</button>
              </span>
            </div>
            <div className={styles.catList}>
              {catItems.length === 0 && <div className={styles.catEmpty}>매칭할 상품명이 없습니다.</div>}
              {catWinStart > 0 && <div className={styles.catEmpty}>위에 {catWinStart}개 더 있음 (↑로 이동)</div>}
              {catItems.slice(catWinStart, catWinEnd).map((it, k) => {
                const i = catWinStart + k;
                return (
                <div key={it.name} className={`${styles.catRow} ${i === catCur ? styles.catRowCur : ""}`} onClick={() => setCatIdx(i)} ref={i === catCur ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}>
                  <span className={styles.catName}>{it.name} <em>({it.count})</em></span>
                  {["상의", "하의", "아우터", "악세사리"].map((c) => (
                    <label key={c} className={styles.catOpt}>
                      <input type="checkbox" checked={it.category === c} onChange={() => setCatOf(it.name, c)} />{c}
                    </label>
                  ))}
                </div>
                );
              })}
              {catWinEnd < catItems.length && <div className={styles.catEmpty}>아래에 {catItems.length - catWinEnd}개 더 있음 (↓로 이동)</div>}
            </div>
            <div className={styles.catFooter}>
              <button className={`${styles.btn} ${styles.btnSecondary}`} onClick={closeCategoryMatch}>닫기</button>
              <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={applyCategoryMatch} disabled={catSaving}>
                {catSaving ? "적용 중..." : "적용하고 다음 (F9)"}
              </button>
            </div>
          </div>
        </div>
      )}
      {rnOpen && rnPlan && (
        <div className={styles.catOverlay} onClick={() => setRnOpen(false)}>
          <div className={styles.catModal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.catHeader}>
              <strong>상품명 일괄변경</strong>
              <span>
                변경할 카테고리:{" "}
                {["상의", "하의", "아우터", "악세사리"].map((c) => (
                  <label key={c} style={{ marginRight: 10 }}>
                    <input type="checkbox" checked={rnCats.includes(c)} disabled={rnBusy} onChange={() => toggleRnCat(c)} /> {c}
                  </label>
                ))}
              </span>
              <label>
                <input type="checkbox" checked={rnForce} disabled={rnBusy} onChange={toggleRnForce} /> 이미 올린 상품도 전부 다시 올리기
              </label>
              <span>
                <button
                  className={`${styles.btn} ${styles.btnSecondary}`}
                  onClick={recheckRename}
                  disabled={rnBusy || !rnCats.length}
                  title="이지어드민의 현재 상품명을 전부 읽어서, 계획과 실제로 다른 상품만 변경 대상으로 다시 올립니다"
                >
                  전체 재조회
                </button>
                {rnCheckMsg && <span style={{ marginLeft: 8 }}>{rnCheckMsg}</span>}
              </span>
              {rnCheck && (
                <span>
                  재조회 결과: 확인 {rnCheck.checked}개 중 일치 {rnCheck.same} · <strong>다름 {rnCheck.diff}</strong> · 이지어드민에서 못 찾음 {rnCheck.unknown}
                  {rnCheck.diff_items?.length > 0 && (
                    <> (예: {rnCheck.diff_items.slice(0, 3).map((d) => `${d.actual} → ${d.new}`).join(" / ")})</>
                  )}
                </span>
              )}
              <span>
                변경 대상 {rnPlan.items.length}개{selectedCodes.size > 0 && ` (체크한 ${rnPlan.items.filter((it) => selectedReps.has(it.code)).length}개만 변경${rnPlan.conflicts.filter((c) => selectedReps.has(c)).length ? ` · 체크한 것 중 충돌 ${rnPlan.conflicts.filter((c) => selectedReps.has(c)).length}개 제외: ${rnPlan.conflicts.filter((c) => selectedReps.has(c)).join(", ")}` : ""})`} · 이미 반영 {rnPlan.already_applied || 0}개 제외 · 컬러 미매칭 {rnPlan.unmatched_colors.length}개 · 충돌 {rnPlan.conflicts.length}개 ·
                제외(대표상품코드/카테고리 없음) {rnPlan.skipped_no_rep_or_category}행
              </span>
            </div>
            <div className={styles.catList}>
              {rnPlan.unmatched_colors.length > 0 ? (
                <>
                  <div className={styles.catEmpty}>매칭 안 된 컬러를 먼저 A~D로 지정해주세요. 카테고리별로 따로 지정하며, 한 번 지정하면 같은 카테고리의 같은 컬러는 모두 같은 글자가 됩니다.</div>
                  {rnPlan.unmatched_colors.map((u) => (
                    <div key={`${u.category}|${u.color}`} className={styles.catRow}>
                      <span className={styles.catName}>[{u.category}] {u.color}</span>
                      {rnPlan.color_letters.map((l) => (
                        <button key={l} className={`${styles.btn} ${styles.btnSecondary}`} disabled={rnBusy} onClick={() => setColorLetter(u.category, u.color, l)}>{l}</button>
                      ))}
                    </div>
                  ))}
                </>
              ) : (
                <>
                  {rnPlan.items.length === 0 && <div className={styles.catEmpty}>{rnPlan.already_applied > 0 ? "변경·신규 상품이 없습니다. (모두 이미 반영됨)" : "변경할 상품이 없습니다. (대표상품코드/카테고리를 먼저 채워주세요)"}</div>}
                  {rnPlan.items.slice(0, 200).map((it) => (
                    <div key={it.code} className={styles.catRow}>
                      <span className={styles.catName}>{it.code} · {it.old} → <strong>{it.new}</strong></span>
                    </div>
                  ))}
                  {rnPlan.items.length > 200 && <div className={styles.catEmpty}>... 외 {rnPlan.items.length - 200}개</div>}
                </>
              )}
            </div>
            <div className={styles.catFooter}>
              {rnProgress && (
                <div style={{ flex: 1, minWidth: 160 }}>
                  <div style={{ fontSize: 12, marginBottom: 4 }}>
                    업로드 중 {rnProgress.done} / {rnProgress.total}개 ({Math.round((rnProgress.done / rnProgress.total) * 100)}%)
                  </div>
                  <div style={{ height: 8, borderRadius: 4, background: "rgba(128,128,128,0.25)", overflow: "hidden" }}>
                    <div style={{ width: `${(rnProgress.done / rnProgress.total) * 100}%`, height: "100%", background: "#2563eb", transition: "width 0.3s" }} />
                  </div>
                </div>
              )}
              <button className={`${styles.btn} ${styles.btnSecondary}`} onClick={() => setRnOpen(false)} disabled={rnBusy}>닫기</button>
              <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={uploadRename} disabled={rnBusy || !rnCats.length || rnPlan.unmatched_colors.length > 0 || rnPlan.items.length === 0 || (selectedCodes.size > 0 && !rnPlan.items.some((it) => selectedReps.has(it.code)))}>
                {rnBusy ? "처리 중..." : selectedCodes.size ? `체크한 ${rnPlan.items.filter((it) => selectedReps.has(it.code)).length}개만 EZAdmin에 업로드` : "EZAdmin에 업로드"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
