import React, { useEffect, useMemo, useRef, useState } from "react";
import { useEzadminSession } from "../../lib/EzadminSessionContext";
import styles from "./NoyeKimPage.module.css";
import { getDownloadFilename } from "../../lib/download";
import { appendTsvToCostBase } from "../../lib/costBase";
import {
  AlertTriangle, ArrowDown, ArrowDownToLine, ArrowUp, ArrowUpDown, Calendar, Clock, Clipboard, FileSpreadsheet,
  MessageSquare, Package, Pencil, Plus, Printer, RefreshCw, Search, Shuffle, Table2, Trash2, X, Zap,
} from "lucide-react";

import { LOCAL_API_BASE as API, getAuthHeaders } from "../../lib/api";

function formatLocalDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatUtcDate(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeExcelDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return formatLocalDate(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const epoch = new Date(Date.UTC(1899, 11, 30));
    epoch.setUTCDate(epoch.getUTCDate() + Math.floor(value));
    return formatLocalDate(epoch);
  }

  const text = String(value ?? "")
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .trim();
  if (!text) return "";
  const match = text.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (match) {
    return `${match[1]}-${String(match[2]).padStart(2, "0")}-${String(match[3]).padStart(2, "0")}`;
  }
  const shortDateMatch = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2})$/);
  if (shortDateMatch) {
    return `20${shortDateMatch[3]}-${String(shortDateMatch[1]).padStart(2, "0")}-${String(shortDateMatch[2]).padStart(2, "0")}`;
  }
  const koreanMatch = text.match(/(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일/);
  if (koreanMatch) {
    return `${koreanMatch[1]}-${String(koreanMatch[2]).padStart(2, "0")}-${String(koreanMatch[3]).padStart(2, "0")}`;
  }
  return text;
}

function isExcelDateMatch(value, targetDate) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return formatLocalDate(value) === targetDate || formatUtcDate(value) === targetDate;
  }
  return normalizeExcelDate(value) === targetDate;
}

function parseNumber(value) {
  return Number(String(value || "").replace(/,/g, "").trim()) || 0;
}

function normalizePickupText(value) {
  return String(value || "").replace(/\s+/g, "").trim();
}

function hasPickupMarker(value) {
  const normalized = normalizePickupText(value);
  return normalized.includes("미송픽업") || (normalized.includes("미송") && normalized.includes("픽업"));
}

function hasExchangePickupMarker(value) {
  const normalized = normalizePickupText(value);
  return normalized.includes("교환픽업") || (normalized.includes("교환") && normalized.includes("픽업"));
}

function isMissingMarker(value) {
  const normalized = normalizePickupText(value);
  return normalized.includes("미송") && !hasPickupMarker(value);
}

const MISONG_ALERT_LABELS = {
  not_found: "항목없음",
  negative: "수량부족",
  missing_code: "코드없음",
  unmatched_add: "신규코드",
};

function getMisongAlertLabel(type) {
  return MISONG_ALERT_LABELS[type] || "알림";
}

function getMisongAlertBadgeClass(type, styles) {
  if (type === "negative") return styles.misongBadgeNegative;
  if (type === "missing_code") return styles.misongBadgeMissing;
  return styles.misongBadgeNotFound;
}

const MISONG_CHECK_REASON_LABELS = {
  qty_mismatch: "수량불일치",
  code_not_found_in_ezadmin: "코드매칭안됨",
  not_in_misong: "미송없음",
};

function getMisongCheckReasonLabel(reason) {
  return MISONG_CHECK_REASON_LABELS[reason] || "알림";
}

function getMisongCheckBadgeClass(reason, styles) {
  if (reason === "qty_mismatch") return styles.misongBadgeNegative;
  if (reason === "code_not_found_in_ezadmin") return styles.misongBadgeMissing;
  return styles.misongBadgeNotFound;
}

function extractProductName(supplierProductName) {
  const cleaned = String(supplierProductName || "").trim();
  const [head = "", ...rest] = cleaned.split(/\s+/);

  return {
    supplierPrefix: head,
    supplierSuffix: rest.join(" "),
  };
}

function extractOptionParts(optionText) {
  if (!optionText) {
    return { color: "", size: "" };
  }

  const [color = "", ...rest] = String(optionText)
    .trim()
    .split("-")
    .map((part) => part.trim())
    .filter(Boolean);

  return {
    color,
    size: rest.join(" "),
  };
}

function rowsToTsv(rows) {
  return rows.map((row) => [row.A, row.B, row.C, row.D, row.E, row.F, row.G, row.H, row.I].join("\t")).join("\n");
}

async function fillCostPrices(rows, authHeaders) {
  const codes = [...new Set(
    rows.filter((r) => r.C === "__COST__" && r.I).map((r) => r.I)
  )];
  if (!codes.length) return rows.map((r) => r.C === "__COST__" ? { ...r, C: "" } : r);

  let priceMap = {};
  try {
    const res = await fetch(`${API}/wonbe/lookup-prices`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify({ codes }),
    });
    const data = await res.json().catch(() => ({}));
    if (data.ok) priceMap = data.prices || {};
  } catch (_) {}

  return rows.map((r) => {
    if (r.C !== "__COST__") return r;
    const raw원가 = priceMap[r.I];
    if (!raw원가) return { ...r, C: "" };
    const 원가 = parseNumber(raw원가);
    const 개수 = parseNumber(r.F);
    return { ...r, C: String(Math.round(원가 * 개수)) };
  });
}

// 거래처별 상품금액(매입차감·부가세 제외 합계)을 초과하는 매입차감 음수를
// 상품금액 크기로 제한하고, 남는 차액을 해당 행의 메모에 기록한다.
function applyPurchaseDeductionCap(rows) {
  const productAmountByVendor = {};
  for (const r of rows) {
    if (r.B === "매입차감" || r.B === "부가세") continue;
    productAmountByVendor[r.A] = (productAmountByVendor[r.A] || 0) + parseNumber(r.C);
  }
  const remainingBudgetByVendor = { ...productAmountByVendor };
  return rows.map((r) => {
    if (r.B !== "매입차감") return r;
    const requested = Math.abs(parseNumber(r.C));
    const budget = Math.max(0, remainingBudgetByVendor[r.A] || 0);
    if (requested > budget) {
      const leftover = requested - budget;
      remainingBudgetByVendor[r.A] = 0;
      return { ...r, C: String(-budget), memo: `매입금액 ${leftover}원 남음` };
    }
    remainingBudgetByVendor[r.A] = budget - requested;
    return r;
  });
}

// 등록된 거래처(A열)의 상품금액(매입차감 제외 합계) * 0.1 을 부가세 행으로 추가한다.
function applyVendorVat(rows, vatVendors) {
  const vendorSet = new Set((vatVendors || []).map((v) => String(v).trim()).filter(Boolean));
  if (!vendorSet.size) return rows;

  const date = formatLocalDate();
  const normalLabel = "ㅇ";
  const productAmountByVendor = {};
  for (const r of rows) {
    if (r.B === "매입차감" || r.B === "부가세") continue;
    if (!vendorSet.has(r.A)) continue;
    productAmountByVendor[r.A] = (productAmountByVendor[r.A] || 0) + parseNumber(r.C);
  }

  const vatRows = Object.entries(productAmountByVendor)
    .filter(([, amount]) => amount > 0)
    .map(([vendor, amount]) => ({
      A: vendor,
      B: "부가세",
      C: String(Math.round(amount * 0.1)),
      D: "부가세",
      E: "부가세",
      F: "부가세",
      G: date,
      H: normalLabel,
      I: "",
      originalF: "",
    }));

  return [...rows, ...vatRows];
}

function getFirstDataSheet(workbook) {
  for (const sheetName of workbook.SheetNames || []) {
    const sheet = workbook.Sheets[sheetName];
    if (sheet?.["!ref"]) return sheet;
  }
  return workbook.Sheets?.[workbook.SheetNames?.[0]];
}

function convertCurrentReceiptExcelRowsSplitV3(rawData) {
  const rows = [];
  const dataRows = Array.isArray(rawData) ? rawData.slice(1) : [];
  const date = formatLocalDate();
  const normalCostFormula = "__COST__";
  const pickupLabel = "\uBBF8\uC1A1\uD53D\uC5C5";
  const exchangePickupLabel = "교환픽업";
  const missingLabel = "\uBBF8\uC1A1";
  const normalLabel = "\u3147";

  for (const row of dataRows) {
    const supplierProductName = String(row?.[0] ?? "").trim();
    const optionCell = String(row?.[1] ?? "").trim();
    const originalQty = parseNumber(row?.[2]);
    const requestQty = parseNumber(row?.[3]);
    const pickupText = String(row?.[4] ?? "").trim();
    const originalFVal = String(row?.[5] ?? "").trim();

    if (!supplierProductName && !optionCell && !originalQty && !requestQty && !pickupText) {
      continue;
    }
    if (/합\s*계/i.test(supplierProductName)) {
      continue;
    }

    const { supplierPrefix, supplierSuffix } = extractProductName(supplierProductName);
    const optionMatch = optionCell.match(/\[([^\]]+)\]/);
    const optionText = optionMatch ? optionMatch[1] : optionCell.replace(/^\[|\]$/g, "");
    const { color, size } = extractOptionParts(optionText);
    const isExchangePickup = hasExchangePickupMarker(pickupText);
    const isPickup = hasPickupMarker(pickupText);
    const pickupOnOriginalRow = isPickup && requestQty <= 0;
    const memoNumber = Number(pickupText);
    const isMemoNegativeNumber = pickupText !== "" && !isNaN(memoNumber) && memoNumber < 0;

    if (originalQty > 0) {
      rows.push({
        A: supplierPrefix,
        B: supplierSuffix,
        C: isExchangePickup ? exchangePickupLabel : pickupOnOriginalRow ? pickupLabel : normalCostFormula,
        D: color,
        E: size,
        F: String(originalQty),
        G: date,
        H: isExchangePickup ? exchangePickupLabel : pickupOnOriginalRow ? pickupLabel : normalLabel,
        I: originalFVal,
        originalF: originalFVal,
      });
    } else if (originalQty < 0) {
      rows.push({
        A: supplierPrefix,
        B: supplierSuffix,
        C: normalCostFormula,
        D: color,
        E: size,
        F: String(originalQty),
        G: date,
        H: normalLabel,
        I: originalFVal,
        originalF: originalFVal,
      });
      rows.push({
        A: supplierPrefix,
        B: "매입차감",
        C: String(originalQty),
        D: "매입차감",
        E: "매입차감",
        F: "매입차감",
        G: date,
        H: "매입차감",
        I: "",
        originalF: "",
      });
    }

    if (isMemoNegativeNumber) {
      rows.push({
        A: supplierPrefix,
        B: "매입차감",
        C: pickupText,
        D: "매입차감",
        E: "매입차감",
        F: "매입차감",
        G: date,
        H: "매입차감",
        I: "",
        originalF: "",
      });
    }

    if (requestQty > 0) {
      rows.push({
        A: supplierPrefix,
        B: supplierSuffix,
        C: isExchangePickup ? exchangePickupLabel : isPickup ? pickupLabel : normalCostFormula,
        D: color,
        E: size,
        F: String(requestQty),
        G: date,
        H: isExchangePickup ? exchangePickupLabel : isPickup ? pickupLabel : missingLabel,
        I: originalFVal,
        originalF: originalFVal,
      });
    }
  }

  return rows;
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const ta = document.createElement("textarea");
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  ta.remove();
}

const MISONG_SORT_COLUMNS = [
  { key: "A", label: "공급처" },
  { key: "B", label: "상품명" },
  { key: "D", label: "색상" },
  { key: "E", label: "사이즈" },
  { key: "F", label: "수량", type: "number" },
  { key: "originalF", label: "상품코드" },
  { key: "G", label: "날짜" },
];

const misongCollator = new Intl.Collator("ko-KR", {
  numeric: true,
  sensitivity: "base",
});

function compareMisongValues(a, b, column) {
  if (column.type === "number") {
    return (Number(a?.[column.key]) || 0) - (Number(b?.[column.key]) || 0);
  }
  return misongCollator.compare(String(a?.[column.key] ?? ""), String(b?.[column.key] ?? ""));
}

export default function NoyeKimPage() {
  const [activeTab, setActiveTab] = useState("kdg");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  const [kdgText, setKdgText] = useState("");
  const [kdgRows, setKdgRows] = useState([]);
  const [kdgMissing, setKdgMissing] = useState(0);
  const [kdgLastSheetSeq, setKdgLastSheetSeq] = useState(null);
  const [kdgEzadminLoading, setKdgEzadminLoading] = useState(false);
  const [kdgBarcodePrintLoading, setKdgBarcodePrintLoading] = useState(false);
  const [baseStatus, setBaseStatus] = useState(null);
  const [baseFile, setBaseFile] = useState(null);
  const [showBaseEditor, setShowBaseEditor] = useState(false);
  const [baseColumns, setBaseColumns] = useState([]);
  const [baseRows, setBaseRows] = useState([]);
  const [baseTotal, setBaseTotal] = useState(0);
  const [baseOffset, setBaseOffset] = useState(0);
  const [baseQuery, setBaseQuery] = useState("");
  const [baseEdits, setBaseEdits] = useState({});
  const baseLimit = 50;

  const [chunkFile, setChunkFile] = useState(null);

  const [janggiFile, setJanggiFile] = useState(null);
  const [janggiRows, setJanggiRows] = useState([]);

  const [todayFile, setTodayFile] = useState(null);
  const [todayRows, setTodayRows] = useState([]);
  const [todayResetLoading, setTodayResetLoading] = useState(false);
  const [todayDeliveryLoading, setTodayDeliveryLoading] = useState(false);
  const [todayEzadminLoading, setTodayEzadminLoading] = useState(false);
  const { openModal: openEzadminModal } = useEzadminSession();
  const [ablyMinusLoading, setAblyMinusLoading] = useState(false);
  const [excelSlipFile, setExcelSlipFile] = useState(null);
  const [excelSlipRows, setExcelSlipRows] = useState([]);
  const [excelSlipOutput, setExcelSlipOutput] = useState("");
  const [savingJanggi, setSavingJanggi] = useState(false);
  const [slipVoucherList, setSlipVoucherList] = useState([]);
  const [showSlipVoucherModal, setShowSlipVoucherModal] = useState(false);
  const [selectedSlipSheets, setSelectedSlipSheets] = useState([]);
  const [loadingSlipVoucherList, setLoadingSlipVoucherList] = useState(false);
  const [vatVendors, setVatVendors] = useState([]);
  const [vatVendorInput, setVatVendorInput] = useState("");

  const [misongItems, setMisongItems] = useState([]);
  const [misongAlerts, setMisongAlerts] = useState([]);
  const [misongLogItem, setMisongLogItem] = useState(null);
  const [misongLogs, setMisongLogs] = useState([]);
  const [misongLogLoading, setMisongLogLoading] = useState(false);
  const [misongLogDateFrom, setMisongLogDateFrom] = useState("");
  const [misongLogDateTo, setMisongLogDateTo] = useState("");
  const [misongEditItem, setMisongEditItem] = useState(null);
  const [misongEditForm, setMisongEditForm] = useState({});
  const [misongBaseQuery, setMisongBaseQuery] = useState("");
  const [misongBaseResults, setMisongBaseResults] = useState([]);
  const [misongBaseSearching, setMisongBaseSearching] = useState(false);
  const [misongConfirm, setMisongConfirm] = useState(null); // { message, onConfirm }
  const [misongSort, setMisongSort] = useState({ key: "A", direction: "asc" });
  const [misongLogSearchOpen, setMisongLogSearchOpen] = useState(false);
  const [misongLogSearchQuery, setMisongLogSearchQuery] = useState("");
  const [misongLogSearchResults, setMisongLogSearchResults] = useState([]);
  const [misongLogSearchLoading, setMisongLogSearchLoading] = useState(false);
  const [misongDisappearedOpen, setMisongDisappearedOpen] = useState(false);
  const [misongDisappearedItems, setMisongDisappearedItems] = useState([]);
  const [misongDisappearedLoading, setMisongDisappearedLoading] = useState(false);
  const [misongQtyEdit, setMisongQtyEdit] = useState({ id: null, value: "" });
  const [misongMemos, setMisongMemos] = useState({});
  const [misongDraftMemos, setMisongDraftMemos] = useState({});
  const [misongExpandedMemos, setMisongExpandedMemos] = useState(new Set());
  const [waitingBaseAppendOpen, setWaitingBaseAppendOpen] = useState(false);
  const [waitingBaseAppendText, setWaitingBaseAppendText] = useState("");
  const [ingodaegiLoading, setIngodaegiLoading] = useState(false);
  const [ingodaegiMsg, setIngodaegiMsg] = useState("");
  const [misongCheckLoading, setMisongCheckLoading] = useState(false);
  const [misongCheckOpen, setMisongCheckOpen] = useState(false);
  const [misongCheckResult, setMisongCheckResult] = useState(null);

  // 불량출력
  const [bulyangFile, setBulyangFile] = useState(null);
  const [bulyangSessionId, setBulyangSessionId] = useState(null);
  const [bulyangGroups, setBulyangGroups] = useState([]);
  const [bulyangIndex, setBulyangIndex] = useState(0);
  const [bulyangImgData, setBulyangImgData] = useState(null); // {src, guides}
  const [bulyangRenderedLayout, setBulyangRenderedLayout] = useState(null);
  const [bulyangLayout, setBulyangLayout] = useState({
    title: "벨류스",
    footer_text: "매입 부탁드립니다!",
    page_w_mm: 126.0, page_h_mm: 103.0,
    top_mm: 4.5, side_mm: 15.0,
    title_size_mm: 14.0, title_gap_mm: 2.5, title_line_thick_mm: 0.5,
    addr_v_size_mm: 7.0, vname_v_size_mm: 7.0,
    addr_wrap_chars: 28, info_gap_below_line_mm: 6.0, info_extra_gap_mm: 0.0,
    show_table_header: false,
    header_size_mm: 8.2, row_size_mm: 4.0, row_h_mm: 6.2,
    row_padding_mm: 6.8, row_line_factor: 0.0, two_row_extra_gap_mm: 0.0,
    col_gap_mm: 3.0, table_top_offset_mm: 19.76,
    name_ratio: 0.62, color_ratio: 0.23, qty_ratio: 0.15,
    bottom_mm: 10.0, footer_size_mm: 5.6,
    footer_show_date: true, footer_date_format: "%Y-%m-%d",
  });
  const bulyangLayoutRef = useRef(bulyangLayout);
  const bulyangSessionRef = useRef({ id: null, index: 0 });
  const bulyangDragRef = useRef(null);
  const bulyangPreviewRef = useRef(null);
  useEffect(() => { bulyangLayoutRef.current = bulyangLayout; }, [bulyangLayout]);
  useEffect(() => { bulyangSessionRef.current = { id: bulyangSessionId, index: bulyangIndex }; }, [bulyangSessionId, bulyangIndex]);

  useEffect(() => {
    (async () => {
      try {
        const [itemsRes, alertsRes] = await Promise.all([
          fetch(`${API}/noye-kimsungil/misong/items?today=${encodeURIComponent(formatLocalDate())}`, { headers: getAuthHeaders() }),
          fetch(`${API}/noye-kimsungil/misong/alerts`, { headers: getAuthHeaders() }),
        ]);
        if (itemsRes.ok) { const d = await itemsRes.json(); setMisongItems(d.items || []); }
        if (alertsRes.ok) { const d = await alertsRes.json(); setMisongAlerts(d.alerts || []); }
      } catch { /* 조용히 실패 */ }
    })();
  }, []);

  useEffect(() => {
    fetch(`${API}/noye-kimsungil/vat-vendors`, { headers: getAuthHeaders() })
      .then((r) => r.ok ? r.json() : null)
      .then((d) => { if (d?.ok) setVatVendors(d.vendors || []); })
      .catch(() => {});
  }, []);

  const saveVatVendors = async (nextVendors) => {
    setVatVendors(nextVendors);
    try {
      const res = await fetch(`${API}/noye-kimsungil/vat-vendors`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ vendors: nextVendors }),
      });
      const data = await res.json().catch(() => ({}));
      if (data?.ok) setVatVendors(data.vendors || nextVendors);
    } catch { /* 조용히 실패 */ }
  };

  const addVatVendor = () => {
    const name = vatVendorInput.trim();
    if (!name || vatVendors.includes(name)) { setVatVendorInput(""); return; }
    setVatVendorInput("");
    saveVatVendors([...vatVendors, name].sort());
  };

  const removeVatVendor = (name) => {
    setMisongConfirm({
      message: `부가세 거래처 "${name}"을(를) 정말 삭제하시겠습니까?`,
      onConfirm: () => {
        setMisongConfirm(null);
        saveVatVendors(vatVendors.filter((v) => v !== name));
      },
    });
  };

  useEffect(() => {
    fetch(`${API}/return-shipping/memos`, { headers: getAuthHeaders() })
      .then((r) => r.ok ? r.json() : null)
      .then((serverMemos) => {
        if (!serverMemos) return;
        const stripped = {};
        Object.entries(serverMemos).forEach(([k, v]) => {
          if (k.startsWith("noye_misong:")) stripped[k.slice(12)] = typeof v === "object" ? v : { memo: v, updated_at: null };
        });
        setMisongMemos((prev) => ({ ...prev, ...stripped }));
      })
      .catch(() => {});
  }, []);

  const saveMisongMemo = (key) => {
    const val = (misongDraftMemos[key] ?? misongMemos[key]?.memo ?? "").trim();
    const now = new Date().toISOString();
    setMisongMemos((prev) => {
      if (!val) { const next = { ...prev }; delete next[key]; return next; }
      return { ...prev, [key]: { memo: val, updated_at: now } };
    });
    fetch(`${API}/return-shipping/memo`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...getAuthHeaders() },
      body: JSON.stringify({ invoice_no: `noye_misong:${key}`, memo: val }),
    }).catch(() => {});
  };

  const toggleMisongMemo = (key) => {
    setMisongExpandedMemos((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
        setMisongDraftMemos((d) => ({ ...d, [key]: misongMemos[key]?.memo || "" }));
      }
      return next;
    });
  };

  const missingCodeAlerts = useMemo(
    () => misongAlerts.filter((alert) => alert.type === "missing_code"),
    [misongAlerts]
  );

  const otherMisongAlerts = useMemo(
    () => misongAlerts.filter((alert) => alert.type !== "missing_code"),
    [misongAlerts]
  );

  const sortedMisongItems = useMemo(() => {
    const column = MISONG_SORT_COLUMNS.find((item) => item.key === misongSort.key) || MISONG_SORT_COLUMNS[0];
    const direction = misongSort.direction === "desc" ? -1 : 1;
    return [...misongItems].sort((a, b) => {
      const primary = compareMisongValues(a, b, column);
      if (primary !== 0) return primary * direction;
      return misongCollator.compare(String(a?.addedAt ?? ""), String(b?.addedAt ?? ""));
    });
  }, [misongItems, misongSort]);

  const misongSupplierTotals = useMemo(() => {
    const totals = new Map();
    misongItems.forEach((item) => {
      const supplier = String(item?.A || "공급처 없음").trim() || "공급처 없음";
      const currentQty = Number(item?.F) || 0;
      const todayAddedQty = Number(item?.todayAddedQty) || 0;
      const qty = Math.max(0, currentQty - todayAddedQty);
      totals.set(supplier, (totals.get(supplier) || 0) + qty);
    });
    return Array.from(totals.entries())
      .map(([supplier, qty]) => ({ supplier, qty }))
      .sort((a, b) => {
        if (b.qty !== a.qty) return b.qty - a.qty;
        return misongCollator.compare(a.supplier, b.supplier);
      });
  }, [misongItems]);

  const misongTotalQty = useMemo(
    () => misongItems.reduce((sum, item) => sum + (Number(item?.F) || 0), 0),
    [misongItems]
  );

  const changeMisongSort = (key) => {
    setMisongSort((prev) => ({
      key,
      direction: prev.key === key && prev.direction === "asc" ? "desc" : "asc",
    }));
  };

  const renderMisongSortIcon = (key) => {
    if (misongSort.key !== key) return <ArrowUpDown size={12} />;
    return misongSort.direction === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} />;
  };

  useEffect(() => {
    const raw = localStorage.getItem("noye-kimsungil-bulyang-handoff");
    if (!raw) return;
    let handoff = null;
    try {
      handoff = JSON.parse(raw);
    } catch {
      localStorage.removeItem("noye-kimsungil-bulyang-handoff");
      return;
    }
    localStorage.removeItem("noye-kimsungil-bulyang-handoff");
    if (!handoff?.session_id) return;

    const applyHandoff = async () => {
      try {
        setActiveTab("bulyang");
        setLoading(true);
        const res = await fetch(`${API}/noye-kimsungil/bulyang/session/${handoff.session_id}`, {
          headers: getAuthHeaders(),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.detail || "불량출력 세션 불러오기 실패");
        setBulyangFile(null);
        setBulyangSessionId(data.session_id);
        setBulyangGroups(data.groups || []);
        setBulyangIndex(0);
        setMessage(`불량출력 데이터 연결 완료: ${data.total}개 거래처`);
        if ((data.total || 0) > 0) {
          await fetchBulyangPreview(data.session_id, 0, bulyangLayoutRef.current);
        }
      } catch (err) {
        setMessage(err.message || "불량출력 세션 불러오기 실패");
      } finally {
        setLoading(false);
      }
    };
    applyHandoff();
  }, []);

  const fetchBaseStatus = async () => {
    try {
      const res = await fetch(`${API}/noye-kimsungil/kdg/base/status`, { headers: getAuthHeaders() });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return;
      setBaseStatus(data);
    } catch {
      // ignore
    }
  };

  const fetchBasePreview = async (offset = 0, q = baseQuery) => {
    const res = await fetch(
      `${API}/noye-kimsungil/kdg/base/preview?offset=${offset}&limit=${baseLimit}&q=${encodeURIComponent(
        (q || "").trim()
      )}`,
      { headers: getAuthHeaders() }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.detail || "원가베이스 미리보기 실패");
    setBaseColumns(data.columns || []);
    setBaseRows(data.rows || []);
    setBaseTotal(data.total || 0);
    setBaseOffset(offset);
    setBaseEdits({});
  };

  useEffect(() => {
    fetchBaseStatus();
  }, []);

  const runKdgConvert = async () => {
    if (!kdgText.trim()) {
      setMessage("원본 텍스트를 먼저 입력하세요.");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/noye-kimsungil/kdg/convert`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ text: kdgText }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "변환 실패");
      const addedRows = data.rows || [];
      setKdgRows((prev) => [...prev, ...addedRows]);
      setKdgMissing(0);
      setMessage(`변환 완료: 이번 ${data.count || 0}건 / 누적 ${kdgRows.length + addedRows.length}건`);
    } catch (err) {
      setMessage(err.message || "변환 실패");
    } finally {
      setLoading(false);
    }
  };

  const runKdgMatch = async () => {
    if (!kdgText.trim()) {
      setMessage("원본 텍스트를 먼저 입력하세요.");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/noye-kimsungil/kdg/match`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ text: kdgText }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "원베 매칭 실패");
      const addedRows = data.rows || [];
      const addedMissing = Number(data.missing || 0);
      setKdgRows((prev) => [...prev, ...addedRows]);
      setKdgMissing((prev) => prev + addedMissing);
      setMessage(
        `매칭 완료: 이번 ${data.count || 0}건 / 미매칭 ${addedMissing}건 / 누적 ${kdgRows.length + addedRows.length}건`
      );
    } catch (err) {
      setMessage(err.message || "원베 매칭 실패");
    } finally {
      setLoading(false);
    }
  };

  const downloadKdgXls = async () => {
    if (kdgRows.length === 0 && !kdgText.trim()) {
      setMessage("원본 텍스트를 먼저 입력하세요.");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      const body = kdgRows.length > 0 ? { rows: kdgRows } : { text: kdgText, with_match: true };
      const res = await fetch(`${API}/noye-kimsungil/kdg/export-xls`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.detail || "XLS 다운로드 실패");
      }
      const blob = await res.blob();
      const filename = getDownloadFilename(res, "입고업로드.xls");
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setMessage(`다운로드 완료: ${filename}`);
    } catch (err) {
      setMessage(err.message || "XLS 다운로드 실패");
    } finally {
      setLoading(false);
    }
  };

  const handleKdgCreateEzadminSheet = async () => {
    if (!kdgRows.length) { setMessage("변환된 행이 없습니다."); return; }
    setKdgEzadminLoading(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/noye-kimsungil/kdg/create-ezadmin-sheet`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ rows: kdgRows }),
      });
      const data = await res.json().catch(() => ({}));
      if (data?.need_session) { openEzadminModal(handleKdgCreateEzadminSheet); return; }
      if (!res.ok || !data?.ok) throw new Error(data?.error || data?.detail || "전표 생성 실패");
      setKdgLastSheetSeq(data.sheet_seq);
      setMessage(`KDG 입고전표 생성 완료 (${data.uploaded_count ?? 0}건) - 전표번호: ${data.sheet_seq}`);
    } catch (err) {
      setMessage(err.message || "전표 생성 실패");
    } finally {
      setKdgEzadminLoading(false);
    }
  };

  const handleKdgBarcodePrint = async () => {
    if (!kdgLastSheetSeq || !kdgRows.length) return;
    setKdgBarcodePrintLoading(true);
    try {
      const products = kdgRows
        .filter((r) => r["원베_B"])
        .flatMap((r) => {
          const qty = Number(r["B(옵션번호)"]) || 1;
          return Array.from({ length: qty }, () => ({
            code: r["원베_B"],
            name: r["A(변환품명)"] || "",
            option: "",
            qty: 1,
          }));
        });
      const res = await fetch(`${API}/returns/onebe/barcode-print`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ sheet_seq: kdgLastSheetSeq, products }),
      });
      const data = await res.json().catch(() => ({}));
      if (data?.need_session) { openEzadminModal(handleKdgBarcodePrint); return; }
      if (!data?.ok) { setMessage(`바코드 출력 오류: ${data?.error || "알 수 없는 오류"}`); return; }
      const win = window.open("", "_blank", "width=900,height=700");
      win.document.write(data.html);
      win.document.close();
      win.focus();
      setTimeout(() => win.print(), 800);
    } catch (err) {
      setMessage(`바코드 출력 오류: ${err.message}`);
    } finally {
      setKdgBarcodePrintLoading(false);
    }
  };

  const copyKdgDate = async () => {
    if (kdgRows.length === 0 && !kdgText.trim()) {
      setMessage("원본 텍스트를 먼저 입력하세요.");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      const body = kdgRows.length > 0 ? { rows: kdgRows } : { text: kdgText };
      const res = await fetch(`${API}/noye-kimsungil/kdg/date-copy-text`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "날짜별 복사 데이터 생성 실패");
      const tsv = data?.text || "";
      if (!tsv) throw new Error("복사할 데이터가 없습니다.");
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
      setMessage(`클립보드 복사 완료: ${data?.count || 0}행`);
    } catch (err) {
      setMessage(err.message || "날짜별 복사 실패");
    } finally {
      setLoading(false);
    }
  };

  const uploadBase = async () => {
    if (!baseFile) {
      setMessage("케이디지 원가베이스 파일을 선택하세요.");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      const formData = new FormData();
      formData.append("file", baseFile);
      const res = await fetch(`${API}/noye-kimsungil/kdg/base/upload`, {
        method: "POST",
        headers: getAuthHeaders(),
        body: formData,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "원가베이스 업로드 실패");
      await fetchBaseStatus();
      setMessage("원가베이스 업로드 완료");
      setBaseFile(null);
    } catch (err) {
      setMessage(err.message || "원가베이스 업로드 실패");
    } finally {
      setLoading(false);
    }
  };

  const appendBaseFromTsv = async () => {
    if (!kdgText.trim()) {
      setMessage("\uC6D0\uBCF8 \uD14D\uC2A4\uD2B8\uB97C \uBA3C\uC800 \uC785\uB825\uD558\uC138\uC694.");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      const data = await appendTsvToCostBase({
        apiBase: API,
        endpoint: "/noye-kimsungil/kdg/base/append-tsv",
        text: kdgText,
        headers: getAuthHeaders(),
      });
      await fetchBaseStatus();
      if (showBaseEditor) {
        const nextTotal = Number(data?.total || 0);
        const nextOffset = baseQuery.trim()
          ? 0
          : Math.max(0, Math.floor(Math.max(nextTotal - 1, 0) / baseLimit) * baseLimit);
        await fetchBasePreview(nextOffset, baseQuery.trim() ? baseQuery : "");
      }
      setMessage(`\uC6D0\uAC00\uBCA0\uC774\uC2A4 \uB370\uC774\uD130 \uCD94\uAC00 \uC644\uB8CC (${data?.appended || 0}\uAC74)`);
    } catch (err) {
      setMessage(err.message || "\uC6D0\uAC00\uBCA0\uC774\uC2A4 \uB370\uC774\uD130 \uCD94\uAC00 \uC2E4\uD328");
    } finally {
      setLoading(false);
    }
  };

  const commitBaseEdits = async () => {
    const edits = Object.values(baseEdits);
    if (!edits.length) {
      setMessage("변경된 내용이 없습니다.");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/noye-kimsungil/kdg/base/edit-batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ edits }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "원가베이스 수정 실패");
      setBaseEdits({});
      await fetchBasePreview(baseOffset, baseQuery);
      await fetchBaseStatus();
      setMessage("원가베이스 변경 적용 완료");
    } catch (err) {
      setMessage(err.message || "원가베이스 수정 실패");
    } finally {
      setLoading(false);
    }
  };

  const handleBaseCellChange = (rowIndex, colIndex, value) => {
    setBaseRows((prev) =>
      prev.map((row) =>
        row.row_index === rowIndex
          ? { ...row, values: row.values.map((v, i) => (i === colIndex ? value : v)) }
          : row
      )
    );
    setBaseEdits((prev) => {
      const key = `${rowIndex}:${colIndex}`;
      return { ...prev, [key]: { row_index: rowIndex, column: colIndex, value } };
    });
  };

  const downloadBase = async () => {
    setLoading(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/noye-kimsungil/kdg/base/download`, { headers: getAuthHeaders() });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.detail || "원가베이스 다운로드 실패");
      }
      const blob = await res.blob();
      const filename = getDownloadFilename(res, "케이디지원가베이스.xlsx");
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setMessage(`다운로드 완료: ${filename}`);
    } catch (err) {
      setMessage(err.message || "원가베이스 다운로드 실패");
    } finally {
      setLoading(false);
    }
  };

  const copyDateChunk = async () => {
    if (!chunkFile) {
      setMessage("가공할 엑셀 파일을 먼저 선택하세요.");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      const formData = new FormData();
      formData.append("file", chunkFile);
      const res = await fetch(`${API}/noye-kimsungil/date-chunk/copy`, {
        method: "POST",
        headers: getAuthHeaders(),
        body: formData,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "가공 후 복사 실패");
      const tsv = data?.text || "";
      if (!tsv) throw new Error("복사할 데이터가 없습니다.");
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
      setMessage(`가공 결과 복사 완료: ${data?.rows || 0}행`);
    } catch (err) {
      setMessage(err.message || "가공 후 복사 실패");
    } finally {
      setLoading(false);
    }
  };

  const loadTodayFromEzadmin = async () => {
    try {
      setTodayEzadminLoading(true); setMessage("");
      const res = await fetch(`${API}/noye-kimsungil/today/load-from-ezadmin`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => ({}));
      if (data?.need_session) {
        openEzadminModal(loadTodayFromEzadmin);
        return;
      }
      if (!res.ok || !data?.ok) throw new Error(data?.error || data?.detail || "EZAdmin 불러오기 실패");
      setTodayRows(data.rows ?? []);
      setMessage(`EZAdmin 로드 완료: ${data.count ?? 0}행`);
    } catch (err) {
      setMessage(err.message || "EZAdmin 불러오기 실패");
    } finally { setTodayEzadminLoading(false); }
  };

  const processTodayFile = async () => {
    if (!todayFile) {
      setMessage("가공할 XLS 파일을 선택하세요.");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      const XLSX = await import("xlsx");
      const arrayBuffer = await todayFile.arrayBuffer();
      const workbook = XLSX.read(arrayBuffer, { type: "array" });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rawData = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });

      const rows = rawData.slice(1);
      const processed = rows
        .filter((row) => String(row[6] ?? "").trim() !== "")
        .map((row) => ({
          A: String(row[6] ?? ""),
          B: String(Math.max(0, Number(row[4] ?? 0))),
        }));

      setTodayRows(processed);
      setMessage(`가공 완료: ${processed.length}행 (빈 G열 제거됨)`);
    } catch (err) {
      setMessage(err.message || "가공 실패");
    } finally {
      setLoading(false);
    }
  };

  const downloadTodayFile = async () => {
    if (!todayRows.length) {
      setMessage("먼저 가공 버튼을 눌러주세요.");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      const XLSX = await import("xlsx");
      const wsData = [
        ["에이블리 옵션 번호", "재고 수량"],
        ...todayRows.map((r) => [r.A, r.B]),
      ];
      const ws = XLSX.utils.aoa_to_sheet(wsData);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
      XLSX.writeFile(wb, "오늘출발.xlsx");
      setMessage("다운로드 완료");
    } catch (err) {
      setMessage(err.message || "다운로드 실패");
    } finally {
      setLoading(false);
    }
  };

  const handleTodayResetStock = async () => {
    if (!todayRows.length) {
      setMessage("먼저 파일을 선택하고 가공 버튼을 눌러주세요.");
      return;
    }
    if (!window.confirm(`가공된 ${todayRows.length}건으로 에이블리재고변경.xlsx를 업데이트 후 초기화합니다. 계속하시겠습니까?`)) return;
    setTodayResetLoading(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/noye-kimsungil/today/reset-stock`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ rows: todayRows }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "재고 초기화 실패");
      setMessage(data.message || "오늘출발 재고 초기화 완료");
    } catch (err) {
      setMessage(err.message || "재고 초기화 실패");
    } finally {
      setTodayResetLoading(false);
    }
  };

  const handleAblyMinus = async () => {
    if (!window.confirm("오출 주문 수량만큼 오늘배송 옵션 재고를 차감합니다.\n\n진행하시겠습니까?")) return;
    setAblyMinusLoading(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/ably-minus/run`, {
        method: "POST",
        headers: getAuthHeaders(),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "실행 실패");
      setMessage(data.message || `완료: 오출 품목 ${data.sync_map_size ?? 0}종 / 재고 차감 ${data.matched ?? 0}건`);
    } catch (err) {
      setMessage(err.message || "실행 실패");
    } finally {
      setAblyMinusLoading(false);
    }
  };

  const handleTodaySetDeliveryType = async () => {
    if (!todayRows.length) {
      setMessage("먼저 파일을 선택하고 가공 버튼을 눌러주세요.");
      return;
    }
    if (!window.confirm(`매칭된 옵션번호를 오늘출발(today)로 변경합니다. 계속하시겠습니까?`)) return;
    setTodayDeliveryLoading(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/noye-kimsungil/today/set-delivery-type`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ rows: todayRows }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "오출로 변경 실패");
      setMessage(data.message || "오출로 변경 완료");
    } catch (err) {
      setMessage(err.message || "오출로 변경 실패");
    } finally {
      setTodayDeliveryLoading(false);
    }
  };

  const copyTodayFile = async () => {
    if (!todayRows.length) {
      setMessage("먼저 가공 버튼을 눌러주세요.");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      const header = "에이블리 옵션 번호\t재고 수량";
      const body = todayRows.map((r) => `${r.A}\t${r.B}`).join("\n");
      const tsv = `${header}\n${body}`;
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
      setMessage(`엑셀 복사 완료: ${todayRows.length}행`);
    } catch (err) {
      setMessage(err.message || "엑셀 복사 실패");
    } finally {
      setLoading(false);
    }
  };

  const processJanggi = async () => {
    if (!janggiFile) {
      setMessage("가공할 XLS 파일을 선택하세요.");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      const XLSX = await import("xlsx");
      const arrayBuffer = await janggiFile.arrayBuffer();
      const workbook = XLSX.read(arrayBuffer, { type: "array" });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rawData = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });

      const rows = rawData.slice(1);
      const processed = rows
        .map((row) => {
          const colB = row[1] ?? "";
          const colC = row[2] ?? "";
          const colD = row[3] ?? "";
          const colH = row[7] ?? "";
          const colJ = row[9] ?? "";

          // C열: [그레이-free] 또는 [7560블랙-롱-m] → 첫 번째 토큰=색상, 나머지=사이즈
          let parsedC = "";
          let parsedD = "";
          const bracketMatch = String(colC).match(/\[([^\]]+)\]/);
          if (bracketMatch) {
            const parts = bracketMatch[1].split("-");
            parsedC = parts[0] || "";
            parsedD = parts.slice(1).join(" ");
          } else {
            parsedC = String(colC);
          }

          // D열: "에스빈 생지백비죠포인트와이드팬츠" → 첫 단어=브랜드, 나머지=상품명
          const dStr = String(colD).trim();
          const spaceIdx = dStr.indexOf(" ");
          const parsedF = spaceIdx > -1 ? dStr.slice(0, spaceIdx) : dStr;
          const parsedG = spaceIdx > -1 ? dStr.slice(spaceIdx + 1) : "";

          return {
            A: String(colJ),
            B: String(colB),
            C: parsedC,
            D: parsedD,
            E: String(colH),
            F: parsedF,
            G: parsedG,
          };
        })
        .filter((r) => r.A || r.B || r.C || r.D || r.E || r.F || r.G);

      setJanggiRows(processed);
      setMessage(`가공 완료: ${processed.length}행`);
    } catch (err) {
      setMessage(err.message || "가공 실패");
    } finally {
      setLoading(false);
    }
  };

  const downloadJanggi = async () => {
    if (!janggiRows.length) {
      setMessage("먼저 가공 버튼을 눌러주세요.");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      const XLSX = await import("xlsx");
      const wsData = [
        ["A", "B", "C", "D", "E", "F", "G"],
        ...janggiRows.map((r) => [r.A, r.B, r.C, r.D, r.E, r.F, r.G]),
      ];
      const ws = XLSX.utils.aoa_to_sheet(wsData);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
      XLSX.writeFile(wb, "가공결과.xlsx");
      setMessage("다운로드 완료");
    } catch (err) {
      setMessage(err.message || "다운로드 실패");
    } finally {
      setLoading(false);
    }
  };

  const copyJanggi = async () => {
    if (!janggiRows.length) {
      setMessage("먼저 가공 버튼을 눌러주세요.");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      const tsv = janggiRows.map((r) => [r.A, r.B, r.C, r.D, r.E, r.F, r.G].join("\t")).join("\n");
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
      setMessage(`엑셀 복사 완료: ${janggiRows.length}행`);
    } catch (err) {
      setMessage(err.message || "엑셀 복사 실패");
    } finally {
      setLoading(false);
    }
  };

  const runExcelSlipConvert = () => {
    if (!excelSlipFile) {
      setMessage("가공할 엑셀 파일을 먼저 선택하세요.");
      return;
    }

    setLoading(true);
    setMessage("");
    (async () => {
      try {
        const XLSX = await import("xlsx");
        const arrayBuffer = await excelSlipFile.arrayBuffer();
        const workbook = XLSX.read(arrayBuffer, { type: "array" });
        const sheet = getFirstDataSheet(workbook);
        const rawData = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
        const rawRows = convertCurrentReceiptExcelRowsSplitV3(rawData);

        if (!rawRows.length) {
          setExcelSlipRows([]);
          setExcelSlipOutput("");
          setMessage("변환 가능한 행을 찾지 못했습니다.");
          return;
        }

        const rows = applyPurchaseDeductionCap(applyVendorVat(await fillCostPrices(rawRows, getAuthHeaders()), vatVendors));
        setExcelSlipRows(rows);
        setExcelSlipOutput(rowsToTsv(rows));

        setMessage(`엑셀 변환 완료: ${rows.length}건`);
      } catch (err) {
        setMessage(err.message || "엑셀 변환에 실패했습니다.");
      } finally {
        setLoading(false);
      }
    })();
  };

  const handleSlipFromEzadmin = async () => {
    try {
      setLoadingSlipVoucherList(true);
      setMessage("");
      const res = await fetch(`${API}/barcode/incoming/ezadmin-voucher-list`, {
        headers: getAuthHeaders(),
      });
      const data = await res.json().catch(() => ({}));
      if (data?.need_session) { openEzadminModal(handleSlipFromEzadmin); return; }
      if (!res.ok || !data?.ok) { setMessage(data?.detail || "EZAdmin 목록 조회 실패"); return; }
      if (!data.vouchers?.length) { setMessage("오늘 입고전표가 없습니다."); return; }
      // 첫 번째 전표의 필드 확인용 로그 (개발 참고 후 제거 가능)
      if (data.vouchers[0]) console.log("[EZAdmin IM00 cell fields]", data.vouchers[0].cell);
      setSlipVoucherList(data.vouchers);
      setSelectedSlipSheets(data.vouchers.map((v) => String(v.sheet)));
      setShowSlipVoucherModal(true);
    } catch (err) {
      setMessage(`목록 조회 실패: ${err.message || ""}`.trim());
    } finally {
      setLoadingSlipVoucherList(false);
    }
  };

  const handleSlipVoucherConfirm = async () => {
    if (!selectedSlipSheets.length) return;
    setShowSlipVoucherModal(false);
    setLoading(true);
    setMessage("EZAdmin에서 불러오는 중... (최대 60초)");
    setExcelSlipRows([]); setExcelSlipOutput("");
    try {
      const res = await fetch(`${API}/barcode/incoming/raw-file-from-ezadmin`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ sheet_list: selectedSlipSheets, page_code: "IM10_file" }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (data?.need_session) { openEzadminModal(handleSlipFromEzadmin); return; }
        throw new Error(data?.error || data?.detail || "EZAdmin 다운로드 실패");
      }
      const arrayBuffer = await res.arrayBuffer();
      const XLSX = await import("xlsx");
      const workbook = XLSX.read(arrayBuffer, { type: "array" });
      const sheet = getFirstDataSheet(workbook);
      const rawData = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
      const rawRows = convertCurrentReceiptExcelRowsSplitV3(rawData);
      if (!rawRows.length) { setMessage("변환 가능한 행을 찾지 못했습니다."); return; }
      const rows = applyPurchaseDeductionCap(applyVendorVat(await fillCostPrices(rawRows, getAuthHeaders()), vatVendors));
      setExcelSlipRows(rows);
      setExcelSlipOutput(rowsToTsv(rows));
      setMessage(`EZAdmin 입고전표 변환 완료: ${rows.length}건 (${selectedSlipSheets.length}개 전표)`);
    } catch (err) {
      setMessage(`EZAdmin 불러오기 실패: ${err.message || ""}`.trim());
    } finally {
      setLoading(false);
    }
  };

  const copyExcelSlipResult = async () => {
    if (!excelSlipOutput) {
      setMessage("\ubcc0\ud658 \uacb0\uacfc\uac00 \uc5c6\uc2b5\ub2c8\ub2e4.");
      return;
    }

    setLoading(true);
    setMessage("");
    try {
      await copyText(excelSlipOutput);
      setMessage(`\uacb0\uacfc \ubcf5\uc0ac \uc644\ub8cc: ${excelSlipRows.length}\uac74`);
    } catch (err) {
      setMessage(err.message || "\uacb0\uacfc \ubcf5\uc0ac\uc5d0 \uc2e4\ud328\ud588\uc2b5\ub2c8\ub2e4.");
    } finally {
      setLoading(false);
    }
  };

  const saveJanggiRows = async () => {
    if (!excelSlipRows.length) {
      setMessage("저장할 변환 결과가 없습니다.");
      return;
    }
    setSavingJanggi(true);
    setMessage("");
    try {
      // 거래처합산: (날짜, 거래처)별 가격 합산
      const sumMap = {};
      for (const r of excelSlipRows) {
        const key = `${r.G}|${r.A}`;
        const price = parseFloat(r.C) || 0;
        sumMap[key] = (sumMap[key] || 0) + price;
      }
      const payload = excelSlipRows.map((r) => ({
        거래처: r.A,
        거래처상품명: r.B,
        가격: r.C,
        옵션: r.D,
        사이즈: r.E,
        개수: r.F,
        날짜: r.G,
        미송체크: r.H,
        상품코드: r.I,
        메모: r.memo || "",
        거래처합산: String(sumMap[`${r.G}|${r.A}`] || ""),
      }));
      const res = await fetch(`${API}/wonbe/janggi/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ rows: payload }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "DB 저장 실패");
      setMessage(`날짜별장끼정리 DB 저장 완료: ${data.saved}건`);
    } catch (err) {
      setMessage(err.message || "DB 저장에 실패했습니다.");
    } finally {
      setSavingJanggi(false);
    }
  };

  const applyMisongRows = async (rows) => {
    setMisongConfirm(null);
    setLoading(true);
    try {
      const res = await fetch(`${API}/noye-kimsungil/misong/items/process-rows`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ rows, today: formatLocalDate() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "미송 반영 실패");
      setMisongItems(data.items || []);
      setMisongAlerts(data.alerts || []);
      const alertMsg = data.new_alert_count > 0 ? ` (알림 ${data.new_alert_count}건)` : "";
      setMessage(`미송관리 반영 완료${alertMsg}`);
      return data;
    } catch (err) {
      setMessage(err.message || "미송 반영 실패");
      return null;
    } finally {
      setLoading(false);
    }
  };

  const uploadMisongExcel = (file) => {
    if (!file) return;

    setLoading(true);
    setMessage("");
    (async () => {
      try {
        const XLSX = await import("xlsx");
        const arrayBuffer = await file.arrayBuffer();
        const workbook = XLSX.read(arrayBuffer, { type: "array", cellDates: true });
        const sheet = getFirstDataSheet(workbook);
        const rawData = XLSX.utils.sheet_to_json(sheet, {
          header: 1,
          defval: "",
          raw: false,
          dateNF: "yyyy-mm-dd",
        });
        const today = formatLocalDate();
        const parsedRows = rawData
          .map((row) => {
            const rawDate = row?.[6];
            const workDate = normalizeExcelDate(rawDate);
            const type = String(row?.[7] ?? "").trim();
            const productCode = String(row?.[8] ?? "").trim();
            return {
              A: String(row?.[0] ?? "").trim(),
              B: String(row?.[1] ?? "").trim(),
              C: "",
              D: String(row?.[3] ?? "").trim(),
              E: String(row?.[4] ?? "").trim(),
              F: row?.[5] ?? "",
              G: workDate,
              H: type,
              I: productCode,
              originalF: productCode,
              isToday: isExcelDateMatch(rawDate, today),
            };
          });
        const todayRows = parsedRows.filter((row) => row.isToday);
        const addRows = todayRows
          .filter((row) => isMissingMarker(row.H))
          .map((row) => ({ ...row, H: "미송" }));
        const pickupRows = todayRows
          .filter((row) => hasPickupMarker(row.H))
          .map((row) => ({ ...row, H: "미송픽업" }));
        const rows = [...addRows, ...pickupRows];

        if (!rows.length) {
          setMessage(`오늘 날짜 행 ${todayRows.length}건 중 미송/미송픽업 데이터를 찾지 못했습니다.`);
          return;
        }

        setMisongConfirm({
          message: `엑셀 데이터에서 미송 ${addRows.length}건 / 미송픽업 ${pickupRows.length}건을 미송관리에 반영하시겠습니까?`,
          onConfirm: async () => {
            const result = await applyMisongRows(rows);
            if (result) {
              const alertMsg = result.new_alert_count > 0 ? ` / 알림 ${result.new_alert_count}건` : "";
              setMessage(`미송 엑셀 반영 완료: 추가 ${addRows.length}건 / 차감 ${pickupRows.length}건${alertMsg}`);
            }
          },
        });
      } catch (err) {
        setMessage(err.message || "미송 엑셀 추가 실패");
      } finally {
        setLoading(false);
      }
    })();
  };

  const deleteMisongItem = (id) => {
    setMisongConfirm({
      message: "이 항목을 삭제하시겠습니까?",
      onConfirm: async () => {
        setMisongConfirm(null);
        try {
          const res = await fetch(`${API}/noye-kimsungil/misong/items/${id}`, {
            method: "DELETE", headers: getAuthHeaders(),
          });
          if (!res.ok) throw new Error("삭제 실패");
          setMisongItems((prev) => prev.filter((i) => i.id !== id));
        } catch (err) { setMessage(err.message || "삭제 실패"); }
      },
    });
  };

  const clearMisongItems = () => {
    setMisongConfirm({
      message: "미송 목록 전체를 삭제하시겠습니까?\n이 작업은 되돌릴 수 없습니다.",
      onConfirm: async () => {
        setMisongConfirm(null);
        try {
          const res = await fetch(`${API}/noye-kimsungil/misong/items`, {
            method: "DELETE", headers: getAuthHeaders(),
          });
          if (!res.ok) throw new Error("전체 삭제 실패");
          setMisongItems([]);
        } catch (err) { setMessage(err.message || "전체 삭제 실패"); }
      },
    });
  };

  const clearMisongAlerts = async () => {
    try {
      const res = await fetch(`${API}/noye-kimsungil/misong/alerts`, {
        method: "DELETE", headers: getAuthHeaders(),
      });
      if (!res.ok) throw new Error();
      setMisongAlerts([]);
    } catch { setMisongAlerts([]); }
  };

  const requestMisongMissingCodeMatch = async (alertId) => {
    const res = await fetch(`${API}/noye-kimsungil/misong/alerts/${alertId}/match-code`, {
      method: "POST",
      headers: getAuthHeaders(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.detail || "상품코드 매칭 실패");
    return data;
  };

  const applyMisongMatchResult = (data) => {
    setMisongItems(data.items || []);
    setMisongAlerts(data.alerts || []);
  };

  const matchMisongMissingCode = async (alert) => {
    if (!alert?.id) return;
    setLoading(true);
    setMessage("");
    try {
      const data = await requestMisongMissingCodeMatch(alert.id);
      applyMisongMatchResult(data);
      const alertMsg = data.new_alert_count > 0 ? ` / 추가 알림 ${data.new_alert_count}건` : "";
      setMessage(`상품코드 매칭 완료: ${data.matchedCode || "-"}${alertMsg}`);
    } catch (err) {
      setMessage(err.message || "상품코드 매칭 실패");
    } finally {
      setLoading(false);
    }
  };

  const matchAllMisongMissingCodes = async () => {
    const targets = missingCodeAlerts;
    if (!targets.length) {
      setMessage("매칭할 코드없음 알림이 없습니다.");
      return;
    }
    setLoading(true);
    setMessage("");
    let success = 0;
    let failed = 0;
    let lastData = null;
    for (const alert of targets) {
      try {
        lastData = await requestMisongMissingCodeMatch(alert.id);
        success += 1;
      } catch {
        failed += 1;
      }
    }
    if (lastData) {
      applyMisongMatchResult(lastData);
    } else {
      try {
        const res = await fetch(`${API}/noye-kimsungil/misong/alerts`, { headers: getAuthHeaders() });
        const data = await res.json().catch(() => ({}));
        if (res.ok) setMisongAlerts(data.alerts || []);
      } catch { /* ignore */ }
    }
    setMessage(`전체매칭 완료: 성공 ${success}건 / 실패 ${failed}건`);
    setLoading(false);
  };

  const loadMisongLogs = async (item, dateFrom, dateTo) => {
    if (!item?.id) return;
    setMisongLogLoading(true);
    try {
      const params = new URLSearchParams();
      if (dateFrom) params.set("date_from", dateFrom);
      if (dateTo) params.set("date_to", dateTo);
      const res = await fetch(
        `${API}/noye-kimsungil/misong/logs/${item.id}?${params}`,
        { headers: getAuthHeaders() }
      );
      const data = await res.json().catch(() => ({}));
      if (res.ok) setMisongLogs(data.logs || []);
    } catch { /* 조용히 */ }
    finally { setMisongLogLoading(false); }
  };

  const openMisongLog = (item) => {
    setMisongLogItem(item);
    setMisongLogDateFrom("");
    setMisongLogDateTo("");
    loadMisongLogs(item, "", "");
  };

  const openMisongLogSearch = () => {
    setMisongLogSearchOpen(true);
    setMisongLogSearchQuery("");
    setMisongLogSearchResults([]);
  };

  const searchMisongLogs = async () => {
    const query = misongLogSearchQuery.trim();
    if (!query) {
      setMisongLogSearchResults([]);
      return;
    }
    setMisongLogSearchLoading(true);
    try {
      const params = new URLSearchParams({ query });
      const res = await fetch(
        `${API}/noye-kimsungil/misong/logs-search?${params}`,
        { headers: getAuthHeaders() }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "로그 검색 실패");
      setMisongLogSearchResults(data.logs || []);
    } catch (err) {
      setMessage(err.message || "로그 검색 실패");
    } finally {
      setMisongLogSearchLoading(false);
    }
  };

  const loadMisongDisappearedItems = async () => {
    setMisongDisappearedLoading(true);
    try {
      const params = new URLSearchParams({ limit: "100" });
      const res = await fetch(
        `${API}/noye-kimsungil/misong/disappeared?${params}`,
        { headers: getAuthHeaders() }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "최근 사라진 상품 조회 실패");
      setMisongDisappearedItems(data.items || []);
    } catch (err) {
      setMessage(err.message || "최근 사라진 상품 조회 실패");
      setMisongDisappearedItems([]);
    } finally {
      setMisongDisappearedLoading(false);
    }
  };

  const openMisongDisappeared = () => {
    setMisongDisappearedOpen(true);
    setMisongDisappearedItems([]);
    loadMisongDisappearedItems();
  };

  const appendWaitingBaseRows = async () => {
    const text = waitingBaseAppendText.trim();
    if (!text) {
      setMessage("추가할 A열 데이터를 붙여넣으세요.");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/noye-kimsungil/misong/waiting-base/append`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ text }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "입고대기 추가 실패");
      setWaitingBaseAppendText("");
      setWaitingBaseAppendOpen(false);
      setMessage(`입고대기 ${data.appended || 0}행 추가 완료`);
    } catch (err) {
      setMessage(err.message || "입고대기 추가 실패");
    } finally {
      setLoading(false);
    }
  };

  const openMisongEdit = (item) => {
    setMisongEditForm(item ? { ...item } : { A: "", B: "", C: "", D: "", E: "", F: "", G: "", originalF: "" });
    setMisongEditItem(item || {});
    setMisongBaseQuery("");
    setMisongBaseResults([]);
  };

  const searchMisongBase = async (q) => {
    setMisongBaseQuery(q);
    if (!q.trim()) { setMisongBaseResults([]); return; }
    setMisongBaseSearching(true);
    try {
      const res = await fetch(
        `${API}/noye-kimsungil/misong/waiting-base/search?q=${encodeURIComponent(q.trim())}`,
        { headers: getAuthHeaders() }
      );
      const data = await res.json().catch(() => ({}));
      setMisongBaseResults(data.results || []);
    } catch { setMisongBaseResults([]); }
    finally { setMisongBaseSearching(false); }
  };

  const applyMisongBaseResult = (row) => {
    setMisongEditForm((prev) => ({
      ...prev,
      A: row.A || prev.A,
      B: row.B || prev.B,
      D: row.D || prev.D,
      E: row.E || prev.E,
      originalF: row.originalF || prev.originalF,
    }));
    setMisongBaseResults([]);
    setMisongBaseQuery("");
  };

  const saveMisongEdit = async () => {
    const f = {
      ...misongEditForm,
      G: misongEditForm.G?.trim() || formatLocalDate(),
    };
    setLoading(true);
    try {
      let res, data;
      if (f.id) {
        res = await fetch(`${API}/noye-kimsungil/misong/items/${f.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", ...getAuthHeaders() },
          body: JSON.stringify({ ...f, F: Number(f.F) || 0 }),
        });
        data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.detail || "수정 실패");
        setMisongItems((prev) => prev.map((i) => i.id === f.id ? data.item : i));
      } else {
        res = await fetch(`${API}/noye-kimsungil/misong/items`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...getAuthHeaders() },
          body: JSON.stringify({ ...f, F: Number(f.F) || 0 }),
        });
        data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.detail || "추가 실패");
        setMisongItems((prev) => {
          if (data.merged) {
            return prev.map((item) => item.id === data.item.id ? data.item : item);
          }
          return [...prev, data.item];
        });
      }
      setMisongEditItem(null);
    } catch (err) { setMessage(err.message || "저장 실패"); }
    finally { setLoading(false); }
  };

  const commitMisongQtyEdit = async (item) => {
    const raw = misongQtyEdit.value;
    setMisongQtyEdit({ id: null, value: "" });
    const newQty = Number(raw);
    if (isNaN(newQty) || String(raw).trim() === "" || newQty === Number(item.F)) return;
    try {
      const res = await fetch(`${API}/noye-kimsungil/misong/items/${item.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ ...item, F: newQty }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "수정 실패");
      setMisongItems((prev) => prev.map((i) => i.id === item.id ? data.item : i));
    } catch (err) {
      setMessage(err.message || "수정 실패");
    }
  };

  const downloadMisongXls = async () => {
    if (!misongItems.length) { setMessage("다운로드할 항목이 없습니다."); return; }
    setLoading(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/noye-kimsungil/misong/waiting-base/download`, {
        headers: getAuthHeaders(),
      });
      const blob = await res.blob();
      if (!res.ok) {
        let detail = "입고대기 다운로드 실패";
        try {
          const data = JSON.parse(await blob.text());
          detail = data?.detail || detail;
        } catch { /* ignore */ }
        throw new Error(detail);
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = getDownloadFilename(res, "입고대기_미송수량.xls");
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      const unmatchedCount = parseInt(res.headers.get("X-Unmatched-Count") || "0", 10);
      const unmatchedCodes = res.headers.get("X-Unmatched-Codes") || "";
      if (unmatchedCount > 0) {
        const codeList = unmatchedCodes ? `\n미매칭 코드: ${unmatchedCodes}` : "";
        setMessage(`입고대기 다운로드 완료 ⚠️ 원가베이스유에 없는 코드 ${unmatchedCount}건 누락됨${codeList}`);
      } else {
        setMessage("입고대기 다운로드 완료 (전체 매칭)");
      }
    } catch (err) {
      setMessage(err.message || "입고대기 다운로드 실패");
    } finally {
      setLoading(false);
    }
  };

  const handleIngodaegiEzadmin = async () => {
    try {
      setIngodaegiLoading(true); setIngodaegiMsg("입고대기설정 중...");
      const res = await fetch(`${API}/noye-kimsungil/misong/waiting-base/export-to-ezadmin`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => ({}));
      if (data?.need_session) {
        openEzadminModal(handleIngodaegiEzadmin);
        return;
      }
      if (!data?.ok) { setIngodaegiMsg(data?.error || "입고대기설정 실패"); return; }
      const applyInfo = data.apply_response ? ` | EZ응답: ${JSON.stringify(data.apply_response).slice(0, 100)}` : "";
      setIngodaegiMsg(`입고대기설정 완료 (${data.count ?? 0}건)${applyInfo}`);
    } catch (err) {
      setIngodaegiMsg(`입고대기설정 실패: ${err.message || ""}`);
    } finally { setIngodaegiLoading(false); }
  };

  const handleMisongCheckEzadmin = async () => {
    try {
      setMisongCheckLoading(true);
      const res = await fetch(`${API}/noye-kimsungil/misong/waiting-base/check-ezadmin`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => ({}));
      if (data?.need_session) {
        openEzadminModal(handleMisongCheckEzadmin);
        return;
      }
      if (!data?.ok) {
        setMessage(data?.error || "입고대기 체크 실패");
        return;
      }
      setMisongCheckResult(data);
      setMisongCheckOpen(true);
    } catch (err) {
      setMessage(err.message || "입고대기 체크 실패");
    } finally {
      setMisongCheckLoading(false);
    }
  };

  const setLayout = (key, val) => setBulyangLayout((prev) => ({ ...prev, [key]: val }));

  const fetchBulyangPreview = async (sessionId, index, layout) => {
    try {
      const res = await fetch(
        `${API}/noye-kimsungil/bulyang/image/${sessionId}/${index}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", ...getAuthHeaders() },
          body: JSON.stringify({ ...layout, dpi: 150 }),
        }
      );
      if (!res.ok) throw new Error("이미지 불러오기 실패");
      const data = await res.json();
      setBulyangImgData({ src: `data:image/png;base64,${data.image_b64}`, guides: data.guides });
      setBulyangRenderedLayout({ ...layout });
    } catch (err) {
      setMessage(err.message || "이미지 불러오기 실패");
    }
  };

  const uploadBulyang = async () => {
    if (!bulyangFile) { setMessage("엑셀 파일을 선택하세요."); return; }
    setLoading(true);
    setMessage("");
    try {
      const formData = new FormData();
      formData.append("file", bulyangFile);
      const res = await fetch(`${API}/noye-kimsungil/bulyang/upload`, {
        method: "POST",
        headers: getAuthHeaders(),
        body: formData,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "업로드 실패");
      setBulyangSessionId(data.session_id);
      setBulyangGroups(data.groups || []);
      setBulyangIndex(0);
      setMessage(`업로드 완료: ${data.total}개 거래처`);
      if (data.total > 0) await fetchBulyangPreview(data.session_id, 0, bulyangLayoutRef.current);
    } catch (err) {
      setMessage(err.message || "업로드 실패");
    } finally {
      setLoading(false);
    }
  };

  const moveBulyang = async (nextIndex) => {
    if (!bulyangSessionId || nextIndex < 0 || nextIndex >= bulyangGroups.length) return;
    setBulyangIndex(nextIndex);
    await fetchBulyangPreview(bulyangSessionId, nextIndex, bulyangLayoutRef.current);
  };

  const refreshBulyangPreview = async () => {
    const { id, index } = bulyangSessionRef.current;
    if (!id) return;
    await fetchBulyangPreview(id, index, bulyangLayoutRef.current);
  };

  const downloadBulyangZip = async () => {
    if (!bulyangSessionId) { setMessage("먼저 엑셀을 업로드하세요."); return; }
    setLoading(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/noye-kimsungil/bulyang/export/${bulyangSessionId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify(bulyangLayoutRef.current),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.detail || "ZIP 다운로드 실패");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url; link.download = "거래처라벨.zip";
      document.body.appendChild(link); link.click(); link.remove();
      URL.revokeObjectURL(url);
      setMessage(`ZIP 다운로드 완료 (${bulyangGroups.length}개)`);
    } catch (err) {
      setMessage(err.message || "ZIP 다운로드 실패");
    } finally {
      setLoading(false);
    }
  };

  const openPrintWindow = (images, layout) => {
    const { page_w_mm, page_h_mm } = layout;
    const html = `<!DOCTYPE html><html><head><style>
      @page { size: ${page_w_mm}mm ${page_h_mm}mm; margin: 0; }
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body { background: white; }
      .page { width: ${page_w_mm}mm; height: ${page_h_mm}mm; page-break-after: always; overflow: hidden; }
      .page:last-child { page-break-after: avoid; }
      img { width: 100%; height: 100%; display: block; }
    </style></head><body>
      ${images.map((src) => `<div class="page"><img src="${src}" /></div>`).join("")}
      <script>window.addEventListener("load", () => { window.print(); });</script>
    </body></html>`;
    const w = window.open("", "_blank");
    if (!w) { setMessage("팝업이 차단됐습니다. 팝업 허용 후 다시 시도하세요."); return; }
    w.document.open();
    w.document.write(html);
    w.document.close();
  };

  const printCurrentBulyang = () => {
    if (!bulyangImgData) return;
    openPrintWindow([bulyangImgData.src], bulyangLayoutRef.current);
  };

  const printAllBulyang = async () => {
    if (!bulyangSessionId) { setMessage("먼저 엑셀을 업로드하세요."); return; }
    setLoading(true);
    setMessage("전체 인쇄 준비 중...");
    try {
      const layout = bulyangLayoutRef.current;
      const srcs = [];
      for (let i = 0; i < bulyangGroups.length; i++) {
        const res = await fetch(
          `${API}/noye-kimsungil/bulyang/image/${bulyangSessionId}/${i}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", ...getAuthHeaders() },
            body: JSON.stringify({ ...layout, dpi: 150 }),
          }
        );
        if (!res.ok) continue;
        const data = await res.json();
        srcs.push(`data:image/png;base64,${data.image_b64}`);
      }
      if (!srcs.length) { setMessage("인쇄할 이미지가 없습니다."); return; }
      openPrintWindow(srcs, layout);
      setMessage(`인쇄 창 열림 (${srcs.length}장)`);
    } catch (err) {
      setMessage(err.message || "인쇄 준비 실패");
    } finally {
      setLoading(false);
    }
  };

  // 드래그 핸들러 (표 시작 오프셋, 열 비율)
  const onBulyangGuideDown = (e, guideType) => {
    e.preventDefault();
    e.stopPropagation();
    if (!bulyangPreviewRef.current || !bulyangImgData) return;
    const rect = bulyangPreviewRef.current.getBoundingClientRect();
    const scale = rect.width / bulyangImgData.guides.img_w;
    bulyangDragRef.current = {
      type: guideType,
      startX: e.clientX,
      startY: e.clientY,
      scale,
      startLayout: { ...bulyangLayoutRef.current },
    };

    const onMove = (e) => {
      const drag = bulyangDragRef.current;
      if (!drag) return;
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      const dxi = dx / drag.scale;
      const dyi = dy / drag.scale;
      const DPI = 150;
      const mm2px = (mm) => Math.max(1, (mm / 25.4) * DPI);
      const px2mm = (px) => (px * 25.4) / DPI;
      const sl = drag.startLayout;

      if (drag.type === "table_y") {
        const newMm = Math.max(0, sl.table_top_offset_mm + px2mm(dyi));
        setBulyangLayout((prev) => ({ ...prev, table_top_offset_mm: Math.round(newMm * 100) / 100 }));
      } else {
        const W = mm2px(sl.page_w_mm);
        const leftPx = mm2px(sl.side_mm);
        const usableW = W - leftPx * 2;
        const total = sl.name_ratio + sl.color_ratio + sl.qty_ratio;
        const nameR = sl.name_ratio / total;
        const colorR = sl.color_ratio / total;
        const qtyR = sl.qty_ratio / total;
        const nameW = usableW * nameR;
        const colorW = usableW * colorR;

        if (drag.type === "x_color") {
          const newNameW = Math.max(usableW * 0.05, Math.min(usableW * 0.9, nameW + dxi));
          const newNameR = newNameW / usableW;
          const remain = 1 - newNameR;
          const origRem = colorR + qtyR;
          setBulyangLayout((prev) => ({
            ...prev,
            name_ratio: Math.round(newNameR * 1000) / 1000,
            color_ratio: Math.round((origRem > 0 ? (remain * colorR) / origRem : remain * 0.6) * 1000) / 1000,
            qty_ratio: Math.round((origRem > 0 ? (remain * qtyR) / origRem : remain * 0.4) * 1000) / 1000,
          }));
        } else {
          const newColorW = Math.max(usableW * 0.05, Math.min(usableW * 0.9 - nameW, colorW + dxi));
          const newColorR = newColorW / usableW;
          const newQtyR = Math.max(0.05, 1 - nameR - newColorR);
          setBulyangLayout((prev) => ({
            ...prev,
            color_ratio: Math.round(newColorR * 1000) / 1000,
            qty_ratio: Math.round(newQtyR * 1000) / 1000,
          }));
        }
      }
    };

    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      bulyangDragRef.current = null;
      const { id, index } = bulyangSessionRef.current;
      if (id) fetchBulyangPreview(id, index, bulyangLayoutRef.current);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // 미리보기 위의 SVG 가이드 위치 계산 (이미지 픽셀 좌표, viewBox로 자동 스케일)
  const getBulyangGuides = () => {
    if (!bulyangImgData || !bulyangRenderedLayout) return null;
    const { guides } = bulyangImgData;
    const DPI = 150;
    const mm2px = (mm) => Math.max(1, (mm / 25.4) * DPI);
    const L = bulyangLayoutRef.current;
    const W = mm2px(L.page_w_mm);
    const leftPx = mm2px(L.side_mm);
    const usableW = W - leftPx * 2;
    const gap = mm2px(L.col_gap_mm);
    const total = Math.max(1e-6, L.name_ratio + L.color_ratio + L.qty_ratio);
    const nameW = Math.floor(usableW * (L.name_ratio / total));
    const colorW = Math.floor(usableW * (L.color_ratio / total));
    const xColor = leftPx + nameW + gap;
    const xQty = xColor + colorW + gap;
    // table_y: base + offset delta relative to rendered layout
    const deltaOffsetMm = L.table_top_offset_mm - bulyangRenderedLayout.table_top_offset_mm;
    const tableY = guides.table_y + (deltaOffsetMm / 25.4) * DPI;
    return { xColor, xQty, tableY, imgW: guides.img_w, imgH: guides.img_h };
  };

  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <div className={styles.headerText}>
          <h2 className={styles.title}>노예김승일</h2>
          <p className={styles.subtitle}>날짜별장끼정리 · 케이디지가공2 · 신상 업로드 · 오늘출발 · 입고전표 엑셀전환 · 불량출력</p>
        </div>
      </div>

      <div className={styles.tabRow}>
        {[
          { key: "date-chunk",    label: "날짜별장끼정리",          icon: <Calendar size={13} />,      badge: null },
          { key: "misong",        label: "미송관리",                icon: <Package size={13} />,       badge: misongItems.length > 0 ? misongItems.length : null },
          { key: "kdg",           label: "케이디지가공2",           icon: <Shuffle size={13} />,       badge: null },
          { key: "janggi",        label: "신상 업로드 날짜별 시트2", icon: <Table2 size={13} />,        badge: null },
          { key: "today",         label: "오늘출발",                icon: <Zap size={13} />,           badge: null },
          { key: "receipt-excel", label: "입고전표 엑셀전환",        icon: <FileSpreadsheet size={13} />, badge: null },
          { key: "bulyang",       label: "불량출력",                icon: <Printer size={13} />,       badge: null },
        ].map(({ key, label, icon, badge }) => (
          <button
            key={key}
            className={`${styles.tabBtn} ${activeTab === key ? styles.tabActive : ""}`}
            onClick={() => setActiveTab(key)}
          >
            {icon}{label}
            {badge !== null && <span className={styles.tabBadge}>{badge}</span>}
          </button>
        ))}
      </div>

      {activeTab === "misong" && (
        <>
          {missingCodeAlerts.length > 0 && (
            <section className={`${styles.misongAlertBox} ${styles.misongMatchAlertBox}`}>
              <div className={styles.misongAlertHeader}>
                <span><AlertTriangle size={14} /> 코드없음 매칭 필요 {missingCodeAlerts.length}건</span>
                <div className={styles.modalActions}>
                  <button className={styles.secondaryBtn} onClick={matchAllMisongMissingCodes} disabled={loading}>
                    <RefreshCw size={13} />전체매칭
                  </button>
                  <button className={styles.secondaryBtn} onClick={clearMisongAlerts}>
                    <X size={13} />알림 모두 지우기
                  </button>
                </div>
              </div>
              <ul className={styles.misongAlertList}>
                {missingCodeAlerts.map((a, i) => (
                  <li key={i} className={styles.misongAlertItem}>
                    <span className={getMisongAlertBadgeClass(a.type, styles)}>
                      {getMisongAlertLabel(a.type)}
                    </span>
                    <span className={styles.misongAlertCode}>{a.productCode}</span>
                    <span className={styles.misongAlertDetail}>{a.detail}</span>
                    <span className={styles.misongAlertRow}>{a.rowInfo}</span>
                    {a.type === "missing_code" && (
                      <button
                        type="button"
                        className={styles.misongAlertMatchBtn}
                        onClick={() => matchMisongMissingCode(a)}
                        disabled={loading}
                      >
                        매칭
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {otherMisongAlerts.length > 0 && (
            <section className={styles.misongAlertBox}>
              <div className={styles.misongAlertHeader}>
                <span><AlertTriangle size={14} /> 처리 알림 {otherMisongAlerts.length}건</span>
                <button className={styles.secondaryBtn} onClick={clearMisongAlerts}>
                  <X size={13} />알림 모두 지우기
                </button>
              </div>
              <ul className={styles.misongAlertList}>
                {otherMisongAlerts.map((a, i) => (
                  <li key={i} className={styles.misongAlertItem}>
                    <span className={getMisongAlertBadgeClass(a.type, styles)}>
                      {getMisongAlertLabel(a.type)}
                    </span>
                    <span className={styles.misongAlertCode}>{a.productCode}</span>
                    <span className={styles.misongAlertDetail}>{a.detail}</span>
                    <span className={styles.misongAlertRow}>{a.rowInfo}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className={styles.card}>
            <div className={styles.cardHeader}>
              <div className={styles.cardTitleRow}>
                <div className={`${styles.cardIcon} ${styles.cardIconGreen}`}><Package size={15} /></div>
                <h3 className={styles.cardTitle}>미송 목록 ({misongItems.length}건)</h3>
              </div>
              <div className={styles.uploadRow}>
                <button className={styles.primaryBtn} onClick={() => openMisongEdit(null)}>
                  <Plus size={13} />항목 추가
                </button>
                <label className={styles.fileInput}>
                  <input
                    type="file"
                    accept=".xls,.xlsx,.xlsm"
                    onChange={(e) => {
                      uploadMisongExcel(e.target.files?.[0] ?? null);
                      e.target.value = "";
                    }}
                  />
                  <FileSpreadsheet size={13} />엑셀로 미송추가
                </label>
                <button className={styles.secondaryBtn} onClick={openMisongLogSearch}>
                  <Search size={13} />로그 검색
                </button>
                <button className={styles.secondaryBtn} onClick={openMisongDisappeared}>
                  <Clock size={13} />최근 사라진 상품
                </button>
                <button className={styles.secondaryBtn} onClick={() => setWaitingBaseAppendOpen(true)}>
                  <Plus size={13} />입고대기 추가
                </button>
                <button
                  className={styles.secondaryBtn}
                  onClick={downloadMisongXls}
                  disabled={misongItems.length === 0}
                >
                  <ArrowDownToLine size={13} />입고대기 다운로드
                </button>
                <button
                  className={styles.secondaryBtn}
                  onClick={handleIngodaegiEzadmin}
                  disabled={ingodaegiLoading || misongItems.length === 0}
                >
                  {ingodaegiLoading ? "처리 중..." : "입고대기설정"}
                </button>
                <button
                  className={styles.secondaryBtn}
                  onClick={handleMisongCheckEzadmin}
                  disabled={misongCheckLoading || misongItems.length === 0}
                >
                  <Search size={13} />{misongCheckLoading ? "확인 중..." : "입고대기 체크"}
                </button>
                <button
                  className={styles.secondaryBtn}
                  onClick={clearMisongItems}
                  disabled={misongItems.length === 0}
                >
                  <Trash2 size={13} />전체 삭제
                </button>
              </div>
            </div>
            {ingodaegiMsg && (
              <div style={{ fontSize: "0.85rem", color: "var(--text-muted)", padding: "0.25rem 0" }}>
                {ingodaegiMsg}
              </div>
            )}

            {misongItems.length === 0 ? (
              <div className={styles.empty}>미송 항목이 없습니다.</div>
            ) : (
              <div className={styles.misongContentStack}>
                <div className={styles.misongSupplierSummary}>
                  <div className={styles.misongSummaryTitle}>공급처별 합계수량 (오늘 추가 제외)</div>
                  <div className={styles.misongSummaryList}>
                    {misongSupplierTotals.map((item) => (
                      <div key={item.supplier} className={styles.misongSummaryItem}>
                        <span className={styles.misongSummaryName}>{item.supplier}</span>
                        <span className={styles.misongSummaryQty}>{item.qty}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div className={styles.tableWrap}>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        {MISONG_SORT_COLUMNS.map((column) => (
                          <th key={column.key}>
                            <button
                              type="button"
                              className={styles.sortableHeader}
                              onClick={() => changeMisongSort(column.key)}
                              aria-label={`${column.label} 정렬`}
                            >
                              <span>{column.label}</span>
                              <span className={styles.sortIcon}>{renderMisongSortIcon(column.key)}</span>
                            </button>
                          </th>
                        ))}
                        <th></th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedMisongItems.map((item) => (
                        <React.Fragment key={item.id}><tr>
                          <td>{item.A}</td>
                          <td>{item.B}</td>
                          <td>{item.D}</td>
                          <td>{item.E}</td>
                          <td>
                            {misongQtyEdit.id === item.id ? (
                              <input
                                type="number"
                                autoFocus
                                value={misongQtyEdit.value}
                                onChange={(e) => setMisongQtyEdit({ id: item.id, value: e.target.value })}
                                onBlur={() => commitMisongQtyEdit(item)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") e.currentTarget.blur();
                                  if (e.key === "Escape") setMisongQtyEdit({ id: null, value: "" });
                                }}
                                style={{ width: "56px", textAlign: "center", fontSize: "0.82rem", padding: "1px 4px" }}
                              />
                            ) : (
                              <span
                                className={styles.pill}
                                style={{ cursor: "pointer" }}
                                onClick={() => setMisongQtyEdit({ id: item.id, value: String(item.F ?? "") })}
                                title="클릭하여 수량 수정"
                              >
                                {item.F}
                              </span>
                            )}
                          </td>
                          <td className={styles.misongCode}>{item.originalF}</td>
                          <td>
                            <div className={styles.misongDateCell}>
                              <span>{item.G}</span>
                              <button
                                className={styles.misongLogBtn}
                                onClick={() => openMisongLog(item)}
                                title="변동 로그"
                              >
                                <Clock size={10} />로그
                              </button>
                            </div>
                          </td>
                          <td>
                            <div className={styles.misongDateCell}>
                              <button
                                className={styles.misongEditBtn}
                                onClick={() => openMisongEdit(item)}
                                title="수정"
                              >
                                <Pencil size={12} />
                              </button>
                              <button
                                className={styles.misongDeleteBtn}
                                onClick={() => deleteMisongItem(item.id)}
                                title="삭제"
                              >
                                <X size={12} />
                              </button>
                            </div>
                          </td>
                          <td style={{ textAlign: "center", padding: "0 4px" }}>
                            {(() => {
                              const key = String(item.id);
                              const memoObj = misongMemos[key];
                              const hasMemo = !!memoObj?.memo;
                              return (
                                <button
                                  type="button"
                                  onClick={() => toggleMisongMemo(key)}
                                  title={hasMemo ? memoObj.memo : "메모 추가"}
                                  style={{
                                    background: "none", border: "none", cursor: "pointer", padding: "2px",
                                    color: hasMemo ? "var(--accent-blue, #3b82f6)" : "var(--text-muted)",
                                    opacity: hasMemo ? 1 : 0.45, display: "flex", alignItems: "center",
                                  }}
                                >
                                  <MessageSquare size={13} fill={hasMemo ? "currentColor" : "none"} />
                                </button>
                              );
                            })()}
                          </td>
                        </tr>
                        {misongExpandedMemos.has(String(item.id)) && (
                          <tr style={{ background: "var(--bg-secondary)" }}>
                            <td colSpan={9} style={{ padding: "0.5rem 1rem 0.75rem 2.5rem" }}>
                              <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginBottom: "0.3rem", display: "flex", gap: "1rem" }}>
                                <span>메모 — {item.B}</span>
                                {misongMemos[String(item.id)]?.updated_at && (
                                  <span style={{ color: "var(--text-muted)", opacity: 0.7 }}>
                                    {new Date(misongMemos[String(item.id)].updated_at).toLocaleString("ko-KR", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}
                                  </span>
                                )}
                              </div>
                              <div style={{ display: "flex", gap: "0.5rem", alignItems: "flex-start", maxWidth: "620px" }}>
                                <textarea
                                  value={misongDraftMemos[String(item.id)] ?? ""}
                                  onChange={(e) => setMisongDraftMemos((d) => ({ ...d, [String(item.id)]: e.target.value }))}
                                  placeholder="메모를 입력하세요..."
                                  rows={2}
                                  style={{
                                    flex: 1, fontSize: "0.85rem", padding: "0.4rem 0.6rem",
                                    border: "1px solid var(--border-color)", borderRadius: "var(--radius-sm)",
                                    background: "var(--bg-primary)", color: "var(--text-primary)",
                                    resize: "vertical", outline: "none", lineHeight: 1.5,
                                  }}
                                  onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) saveMisongMemo(String(item.id)); }}
                                  autoFocus
                                />
                                <button
                                  type="button"
                                  onClick={() => saveMisongMemo(String(item.id))}
                                  className={styles.secondaryBtn}
                                  style={{ whiteSpace: "nowrap", alignSelf: "flex-end" }}
                                >
                                  저장
                                </button>
                              </div>
                            </td>
                          </tr>
                        )}
                        </React.Fragment>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className={styles.misongTotalFooter}>
                  <span>총 합계수량</span>
                  <strong>{misongTotalQty}</strong>
                </div>
              </div>
            )}
          </section>

          {/* 로그 모달 */}
          {misongLogItem && (
            <div className={styles.modalOverlay} onClick={() => setMisongLogItem(null)}>
              <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
                <div className={styles.modalHeader}>
                  <span className={styles.modalTitle}>
                    [{misongLogItem.originalF}] {misongLogItem.B} 변동 로그
                  </span>
                  <button className={styles.secondaryBtn} onClick={() => setMisongLogItem(null)}>
                    <X size={13} />닫기
                  </button>
                </div>

                {/* 날짜 범위 필터 */}
                <div className={styles.misongLogFilter}>
                  <label className={styles.misongFormLabel}>기간</label>
                  <input
                    className={styles.misongFormInput}
                    type="date"
                    value={misongLogDateFrom}
                    onChange={(e) => {
                      setMisongLogDateFrom(e.target.value);
                      loadMisongLogs(misongLogItem, e.target.value, misongLogDateTo);
                    }}
                    style={{ width: 140 }}
                  />
                  <span style={{ color: "var(--text-muted)" }}>~</span>
                  <input
                    className={styles.misongFormInput}
                    type="date"
                    value={misongLogDateTo}
                    onChange={(e) => {
                      setMisongLogDateTo(e.target.value);
                      loadMisongLogs(misongLogItem, misongLogDateFrom, e.target.value);
                    }}
                    style={{ width: 140 }}
                  />
                  {(misongLogDateFrom || misongLogDateTo) && (
                    <button className={styles.secondaryBtn} onClick={() => {
                      setMisongLogDateFrom(""); setMisongLogDateTo("");
                      loadMisongLogs(misongLogItem, "", "");
                    }}>초기화</button>
                  )}
                </div>

                <div className={styles.misongLogBody}>
                  {misongLogLoading ? (
                    <div className={styles.empty}>로딩 중...</div>
                  ) : misongLogs.length === 0 ? (
                    <div className={styles.empty}>로그 없음</div>
                  ) : (
                    <>
                      {/* 헤더 */}
                      <div className={styles.misongLogHeader}>
                        <span>작업일</span>
                        <span>작업</span>
                        <span>작업개수</span>
                        <span>남은수량</span>
                        <span>메모</span>
                        <span>처리시각</span>
                      </div>
                      {misongLogs.map((entry) => (
                        <div key={entry.id} className={styles.misongLogEntry}>
                          <span className={styles.misongLogDate}>{entry.work_date}</span>
                          <span className={entry.type === "add" ? styles.misongLogBadgeAdd : styles.misongLogBadgeSub}>
                            {entry.type === "add" ? "추가" : "차감"}
                          </span>
                          <span className={styles.misongLogQty}>
                            {entry.type === "add" ? "+" : "-"}{entry.qty}
                          </span>
                          <span className={styles.misongLogRemain}>{entry.remaining_qty}</span>
                          <span className={styles.misongLogMemo}>{entry.memo || "-"}</span>
                          <span className={styles.misongLogTs}>
                            {new Date(entry.ts).toLocaleString("ko-KR")}
                          </span>
                        </div>
                      ))}
                    </>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* 로그 검색 모달 */}
          {misongLogSearchOpen && (
            <div className={styles.modalOverlay} onClick={() => setMisongLogSearchOpen(false)}>
              <div className={`${styles.modal} ${styles.wideModal}`} onClick={(e) => e.stopPropagation()}>
                <div className={styles.modalHeader}>
                  <span className={styles.modalTitle}>상품명/공급처 로그 검색</span>
                  <button className={styles.secondaryBtn} onClick={() => setMisongLogSearchOpen(false)}>
                    <X size={13} />닫기
                  </button>
                </div>
                <div className={styles.misongLogFilter}>
                  <label className={styles.misongFormLabel}>검색어</label>
                  <input
                    className={styles.misongFormInput}
                    type="text"
                    value={misongLogSearchQuery}
                    onChange={(e) => setMisongLogSearchQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") searchMisongLogs();
                    }}
                    placeholder="상품명 또는 공급처 입력"
                    style={{ minWidth: 240 }}
                  />
                  <button className={styles.primaryBtn} onClick={searchMisongLogs} disabled={misongLogSearchLoading}>
                    <Search size={13} />검색
                  </button>
                </div>
                <div className={styles.misongLogBody}>
                  {misongLogSearchLoading ? (
                    <div className={styles.empty}>검색 중...</div>
                  ) : misongLogSearchResults.length === 0 ? (
                    <div className={styles.empty}>검색 결과 없음</div>
                  ) : (
                    <>
                      <div className={styles.misongSearchHeader}>
                        <span>공급처</span>
                        <span>상품명</span>
                        <span>상품코드</span>
                        <span>색상</span>
                        <span>사이즈</span>
                        <span>작업일</span>
                        <span>작업</span>
                        <span>개수</span>
                        <span>남은수량</span>
                        <span>처리시각</span>
                      </div>
                      {misongLogSearchResults.map((entry) => (
                        <div key={entry.id} className={styles.misongSearchEntry}>
                          <span className={styles.misongSearchName}>{entry.supplier_name || "-"}</span>
                          <span className={styles.misongSearchName}>{entry.product_name || "-"}</span>
                          <span className={styles.misongCode}>{entry.product_code || "-"}</span>
                          <span className={styles.misongSearchName}>{entry.color || "-"}</span>
                          <span className={styles.misongSearchName}>{entry.size || "-"}</span>
                          <span className={styles.misongLogDate}>{entry.work_date || "-"}</span>
                          <span className={entry.type === "add" ? styles.misongLogBadgeAdd : styles.misongLogBadgeSub}>
                            {entry.type === "add" ? "추가" : "차감"}
                          </span>
                          <span className={styles.misongLogQty}>
                            {entry.type === "add" ? "+" : "-"}{entry.qty}
                          </span>
                          <span className={styles.misongLogRemain}>{entry.remaining_qty}</span>
                          <span className={styles.misongLogTs}>
                            {new Date(entry.ts).toLocaleString("ko-KR")}
                          </span>
                        </div>
                      ))}
                    </>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* 원가베이스유 Sheet2 추가 모달 */}
          {misongDisappearedOpen && (
            <div className={styles.modalOverlay} onClick={() => setMisongDisappearedOpen(false)}>
              <div className={`${styles.modal} ${styles.wideModal}`} onClick={(e) => e.stopPropagation()}>
                <div className={styles.modalHeader}>
                  <span className={styles.modalTitle}>최근 사라진 상품</span>
                  <div className={styles.modalActions}>
                    <button className={styles.secondaryBtn} onClick={loadMisongDisappearedItems} disabled={misongDisappearedLoading}>
                      <RefreshCw size={13} />새로고침
                    </button>
                    <button className={styles.secondaryBtn} onClick={() => setMisongDisappearedOpen(false)}>
                      <X size={13} />닫기
                    </button>
                  </div>
                </div>
                <div className={styles.misongLogBody}>
                  {misongDisappearedLoading ? (
                    <div className={styles.empty}>조회 중...</div>
                  ) : misongDisappearedItems.length === 0 ? (
                    <div className={styles.empty}>최근 0이 되어 사라진 상품이 없습니다.</div>
                  ) : (
                    <>
                      <div className={styles.misongSearchHeader}>
                        <span>공급처</span>
                        <span>상품명</span>
                        <span>상품코드</span>
                        <span>색상</span>
                        <span>사이즈</span>
                        <span>작업일</span>
                        <span>작업</span>
                        <span>개수</span>
                        <span>잔여수량</span>
                        <span>처리시각</span>
                      </div>
                      {misongDisappearedItems.map((entry) => (
                        <div key={entry.id} className={styles.misongSearchEntry}>
                          <span className={styles.misongSearchName}>{entry.supplier_name || "-"}</span>
                          <span className={styles.misongSearchName}>{entry.product_name || "-"}</span>
                          <span className={styles.misongCode}>{entry.product_code || "-"}</span>
                          <span className={styles.misongSearchName}>{entry.color || "-"}</span>
                          <span className={styles.misongSearchName}>{entry.size || "-"}</span>
                          <span className={styles.misongLogDate}>{entry.work_date || "-"}</span>
                          <span className={entry.type === "add" ? styles.misongLogBadgeAdd : styles.misongLogBadgeSub}>
                            {entry.type === "add" ? "추가" : "차감"}
                          </span>
                          <span className={styles.misongLogQty}>
                            {entry.type === "add" ? "+" : "-"}{entry.qty}
                          </span>
                          <span className={styles.misongLogRemain}>{entry.remaining_qty}</span>
                          <span className={styles.misongLogTs}>
                            {new Date(entry.ts).toLocaleString("ko-KR")}
                          </span>
                        </div>
                      ))}
                    </>
                  )}
                </div>
              </div>
            </div>
          )}

          {misongCheckOpen && misongCheckResult && (
            <div className={styles.modalOverlay} onClick={() => setMisongCheckOpen(false)}>
              <div className={`${styles.modal} ${styles.wideModal}`} onClick={(e) => e.stopPropagation()}>
                <div className={styles.modalHeader}>
                  <span className={styles.modalTitle}>입고대기 체크 결과</span>
                  <div className={styles.modalActions}>
                    <button className={styles.secondaryBtn} onClick={handleMisongCheckEzadmin} disabled={misongCheckLoading}>
                      <RefreshCw size={13} />다시 확인
                    </button>
                    <button className={styles.secondaryBtn} onClick={() => setMisongCheckOpen(false)}>
                      <X size={13} />닫기
                    </button>
                  </div>
                </div>
                <div className={styles.misongLogBody}>
                  <div style={{ fontSize: "0.82rem", color: "var(--text-muted)", marginBottom: "0.5rem" }}>
                    미송 {misongCheckResult.misong_code_count}건 / EZAdmin 입고대기 {misongCheckResult.ezadmin_code_count}건 확인
                  </div>
                  {misongCheckResult.mismatches.length === 0 ? (
                    <div className={styles.empty}>✅ 전체 일치</div>
                  ) : (
                    <>
                      <div style={{ fontSize: "0.85rem", fontWeight: 700, marginBottom: "0.5rem" }}>
                        ⚠️ 불일치 {misongCheckResult.mismatches.length}건
                      </div>
                      <ul className={styles.misongAlertList}>
                        {misongCheckResult.mismatches.map((m) => (
                          <li key={m.code} className={styles.misongAlertItem}>
                            <span className={getMisongCheckBadgeClass(m.reason, styles)}>
                              {getMisongCheckReasonLabel(m.reason)}
                            </span>
                            <span className={styles.misongAlertCode}>{m.code}</span>
                            <span className={styles.misongAlertDetail}>
                              미송 {m.misongQty ?? "-"} / EZAdmin {m.ezadminQty ?? "-"}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
              </div>
            </div>
          )}

          {waitingBaseAppendOpen && (
            <div className={styles.modalOverlay} onClick={() => setWaitingBaseAppendOpen(false)}>
              <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
                <div className={styles.modalHeader}>
                  <span className={styles.modalTitle}>원가베이스유 Sheet2 A열 추가</span>
                  <button className={styles.secondaryBtn} onClick={() => setWaitingBaseAppendOpen(false)}>
                    <X size={13} />닫기
                  </button>
                </div>
                <div className={styles.misongAppendBody}>
                  <textarea
                    className={styles.scanInput}
                    value={waitingBaseAppendText}
                    onChange={(e) => setWaitingBaseAppendText(e.target.value)}
                    placeholder="엑셀에서 상품코드열을 TSV로 붙여넣으세요"
                    rows={10}
                  />
                  <div className={styles.statusMsg}>
                    엑셀에서 상품코드열을 TSV로 붙여넣으세요.
                  </div>
                </div>
                <div className={styles.uploadRow} style={{ padding: "0 1.4rem 1.25rem" }}>
                  <button className={styles.primaryBtn} onClick={appendWaitingBaseRows} disabled={loading}>
                    <Plus size={13} />추가
                  </button>
                  <button className={styles.secondaryBtn} onClick={() => setWaitingBaseAppendOpen(false)}>
                    취소
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* 수정/추가 모달 */}
          {misongEditItem !== null && (
            <div className={styles.modalOverlay} onClick={() => setMisongEditItem(null)}>
              <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
                <div className={styles.modalHeader}>
                  <span className={styles.modalTitle}>
                    {misongEditForm.id ? "미송 항목 수정" : "미송 항목 추가"}
                  </span>
                  <button className={styles.secondaryBtn} onClick={() => setMisongEditItem(null)}>
                    <X size={13} />취소
                  </button>
                </div>
                {/* G열 검색 자동완성 */}
                <div className={styles.misongBaseSearch}>
                  <label className={styles.misongFormLabel}>G열(상품명) 검색 → 자동채우기</label>
                  <div className={styles.misongBaseSearchRow}>
                    <Search size={14} className={styles.misongBaseSearchIcon} />
                    <input
                      className={styles.misongFormInput}
                      type="text"
                      value={misongBaseQuery}
                      onChange={(e) => searchMisongBase(e.target.value)}
                      placeholder="상품명 입력 후 결과 클릭 시 자동 채우기"
                      style={{ paddingLeft: "2rem" }}
                    />
                    {misongBaseSearching && <span className={styles.misongBaseSpinner}><RefreshCw size={13} /></span>}
                  </div>
                  {misongBaseResults.length > 0 && (
                    <div className={styles.misongBaseDropdown}>
                      {misongBaseResults.map((row, i) => (
                        <button
                          key={i}
                          type="button"
                          className={styles.misongBaseDropdownItem}
                          onClick={() => applyMisongBaseResult(row)}
                        >
                          <span className={styles.misongBaseItemName}>{row.B}</span>
                          <span className={styles.misongBaseItemMeta}>
                            {row.A && <span>{row.A}</span>}
                            {row.D && <span>{row.D}</span>}
                            {row.E && <span>{row.E}</span>}
                            {row.originalF && <span className={styles.misongBaseItemCode}>{row.originalF}</span>}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <div className={styles.misongFormGrid}>
                  {[
                    { key: "A", label: "공급처" },
                    { key: "B", label: "상품명" },
                    { key: "D", label: "색상" },
                    { key: "E", label: "사이즈" },
                    { key: "F", label: "수량", type: "number" },
                    { key: "originalF", label: "상품코드" },
                    { key: "G", label: "날짜" },
                  ].map(({ key, label, type }) => (
                    <div key={key} className={styles.misongFormField}>
                      <label className={styles.misongFormLabel}>{label}</label>
                      <input
                        className={styles.misongFormInput}
                        type={type || "text"}
                        value={misongEditForm[key] ?? ""}
                        onChange={(e) => setMisongEditForm((prev) => ({ ...prev, [key]: e.target.value }))}
                      />
                    </div>
                  ))}
                </div>
                <div className={styles.uploadRow} style={{ padding: "0 1.4rem 1.25rem" }}>
                  <button className={styles.primaryBtn} onClick={saveMisongEdit} disabled={loading}>
                    <Plus size={13} />저장
                  </button>
                  <button className={styles.secondaryBtn} onClick={() => setMisongEditItem(null)}>
                    취소
                  </button>
                </div>
              </div>
            </div>
          )}

        </>
      )}

      {activeTab === "kdg" && (
        <>
          <section className={styles.card}>
            <div className={styles.cardHeader}>
              <div className={styles.cardTitleRow}>
                <div className={`${styles.cardIcon} ${styles.cardIconBlue}`}><Shuffle size={15} /></div>
                <h3 className={styles.cardTitle}>케이디지가공2</h3>
              </div>
            </div>
            <textarea
              className={styles.scanInput}
              style={{ minHeight: 220 }}
              value={kdgText}
              onChange={(e) => setKdgText(e.target.value)}
              placeholder="원본 텍스트를 그대로 붙여넣으세요"
            />
            <div className={styles.statusMsg}>
              <strong>TSV</strong> A/B열 데이터를 붙여넣고 <strong>원가베이스 데이터 추가</strong>를 누르면 원가베이스 마지막 행에 이어붙습니다.
            </div>
            <div className={styles.uploadRow}>
              <button className={styles.primaryBtn} onClick={runKdgConvert} disabled={loading}>
                <Shuffle size={14} />변환
              </button>
              <button className={styles.secondaryBtn} onClick={runKdgMatch} disabled={loading}>
                <Zap size={13} />이지어드민 변환(원베 매칭)
              </button>
              <button className={styles.secondaryBtn} onClick={downloadKdgXls} disabled={loading}>
                <ArrowDownToLine size={13} />XLS 저장(A=원베,B=옵션)
              </button>
              <button
                className={styles.secondaryBtn}
                onClick={handleKdgCreateEzadminSheet}
                disabled={loading || kdgEzadminLoading || !kdgRows.length}
              >
                <ArrowDownToLine size={13} />
                {kdgEzadminLoading ? "전표 생성 중..." : "이지어드민 입고전표 생성"}
              </button>
              <button
                className={styles.secondaryBtn}
                onClick={handleKdgBarcodePrint}
                disabled={loading || kdgBarcodePrintLoading || !kdgLastSheetSeq || !kdgRows.length}
                title={kdgLastSheetSeq ? `전표 ${kdgLastSheetSeq} 바코드 출력` : "전표 생성 후 활성화"}
              >
                <Zap size={13} />
                {kdgBarcodePrintLoading ? "출력 중..." : `바코드 출력${kdgLastSheetSeq ? ` (${kdgLastSheetSeq})` : ""}`}
              </button>
              <button className={styles.secondaryBtn} onClick={copyKdgDate} disabled={loading}>
                <Clipboard size={13} />날짜별 복사
              </button>
            </div>
            <div className={styles.uploadRow}>
              <label className={styles.fileInput}>
                <input type="file" accept=".xls,.xlsx,.xlsm" onChange={(e) => setBaseFile(e.target.files?.[0] ?? null)} />
                <FileSpreadsheet size={14} />케이디지 원가베이스 선택
              </label>
              <button className={styles.secondaryBtn} onClick={uploadBase} disabled={loading}>
                <ArrowDownToLine size={13} style={{ rotate: "180deg" }} />원가베이스 업로드
              </button>
              <button className={styles.secondaryBtn} onClick={appendBaseFromTsv} disabled={loading}>
                <Plus size={13} />원가베이스 데이터 추가
              </button>
              <button className={styles.secondaryBtn} onClick={downloadBase} disabled={loading}>
                <ArrowDownToLine size={13} />원가베이스 다운로드
              </button>
              <button
                className={styles.secondaryBtn}
                onClick={async () => {
                  setShowBaseEditor(true);
                  await fetchBasePreview(0, "").catch((e) => setMessage(e.message || "원가베이스 미리보기 실패"));
                }}
                disabled={loading}
              >
                원가베이스 편집
              </button>
            </div>
            {baseStatus?.path && (
              <div className={styles.statusMsg}>
                <strong>원가베이스:</strong> {baseStatus.path} {baseStatus.exists ? "" : "(없음)"}
              </div>
            )}
            {kdgMissing > 0 && (
              <div className={styles.statusMsg}>
                <strong>미매칭:</strong> {kdgMissing}건
              </div>
            )}
          </section>

          <section className={styles.card}>
            <div className={styles.cardHeader}>
              <div className={styles.cardTitleRow}>
                <div className={`${styles.cardIcon} ${styles.cardIconSlate}`}><Table2 size={15} /></div>
                <h3 className={styles.cardTitle}>결과</h3>
              </div>
              <span className={styles.pill}>{kdgRows.length}건</span>
            </div>
            <div className={`${styles.tableWrap} ${styles.registeredTableWrap}`}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>A(변환품명)</th>
                    <th>B(옵션번호)</th>
                    <th>원베_B</th>
                    <th>원본품명</th>
                  </tr>
                </thead>
                <tbody>
                  {kdgRows.map((r, i) => (
                    <tr key={`${r["원본품명"] || ""}-${i}`}>
                      <td>{r["A(변환품명)"] || ""}</td>
                      <td>{r["B(옵션번호)"] || ""}</td>
                      <td>{r["원베_B"] || ""}</td>
                      <td>{r["원본품명"] || ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {kdgRows.length === 0 && <div className={styles.empty}>변환 결과가 없습니다.</div>}
            </div>
          </section>
        </>
      )}

      {activeTab === "date-chunk" && (
        <section className={styles.card}>
          <div className={styles.cardHeader}>
            <div className={styles.cardTitleRow}>
              <div className={`${styles.cardIcon} ${styles.cardIconAmber}`}><Calendar size={15} /></div>
              <h3 className={styles.cardTitle}>날짜별장끼정리</h3>
            </div>
          </div>
          <div className={styles.uploadRow}>
            <label className={styles.fileInput}>
              <input type="file" accept=".xlsx,.xls,.xlsm" onChange={(e) => setChunkFile(e.target.files?.[0] ?? null)} />
              <FileSpreadsheet size={14} />{chunkFile ? chunkFile.name : "가공할 엑셀 선택"}
            </label>
            <button className={styles.primaryBtn} onClick={copyDateChunk} disabled={loading}>
              <Clipboard size={14} />가공 후 복사
            </button>
          </div>
          <div className={styles.statusMsg}>
            <strong>동작:</strong> 재고부족요청 엑셀 넣으면 날짜별장끼정리 시트1 양식으로 가공
          </div>
        </section>
      )}

      {activeTab === "today" && (
        <>
          <section className={styles.card}>
            <div className={styles.cardHeader}>
              <div className={styles.cardTitleRow}>
                <div className={`${styles.cardIcon} ${styles.cardIconGreen}`}><Zap size={15} /></div>
                <h3 className={styles.cardTitle}>오늘출발</h3>
              </div>
            </div>
            <div className={styles.uploadRow}>
              <label className={styles.fileInput}>
                <input
                  type="file"
                  accept=".xls,.xlsx,.xlsm"
                  onChange={(e) => {
                    setTodayFile(e.target.files?.[0] ?? null);
                    setTodayRows([]);
                  }}
                />
                <FileSpreadsheet size={14} />{todayFile ? todayFile.name : "XLS 파일 선택"}
              </label>
              <button className={styles.primaryBtn} onClick={processTodayFile} disabled={loading || todayEzadminLoading}>
                <Zap size={14} />가공
              </button>
              <button className={styles.secondaryBtn} onClick={loadTodayFromEzadmin} disabled={loading || todayEzadminLoading}>
                <RefreshCw size={14} />{todayEzadminLoading ? "불러오는 중..." : "API로 불러오기"}
              </button>

              <button className={styles.secondaryBtn} onClick={downloadTodayFile} disabled={loading || !todayRows.length}>
                <ArrowDownToLine size={13} />다운로드
              </button>
              <button className={styles.secondaryBtn} onClick={copyTodayFile} disabled={loading || !todayRows.length}>
                <Clipboard size={13} />엑셀 복사
              </button>
              <button className={styles.primaryBtn} onClick={handleTodayResetStock} disabled={todayResetLoading}>
                <RefreshCw size={14} />{todayResetLoading ? "초기화 중..." : "오늘출발 초기화"}
              </button>
              <button className={styles.secondaryBtn} onClick={handleTodaySetDeliveryType} disabled={todayDeliveryLoading}>
                <Zap size={14} />{todayDeliveryLoading ? "변경 중..." : "오출로 변경"}
              </button>
              <button className={styles.secondaryBtn} onClick={handleAblyMinus} disabled={ablyMinusLoading}>
                <RefreshCw size={14} />{ablyMinusLoading ? "실행 중..." : "오출마이너스"}
              </button>
            </div>
            <div className={styles.statusMsg}>
              <strong>설명:</strong> 이지어드민 현재고조회 다운로드항목4 파일 넣기
            </div>
          </section>

          {todayRows.length > 0 && (
            <section className={styles.card}>
              <div className={styles.cardHeader}>
                <div className={styles.cardTitleRow}>
                  <div className={`${styles.cardIcon} ${styles.cardIconSlate}`}><Table2 size={15} /></div>
                  <h3 className={styles.cardTitle}>가공 결과</h3>
                </div>
                <span className={styles.pill}>{todayRows.length}행</span>
              </div>
              <div className={`${styles.tableWrap} ${styles.registeredTableWrap}`}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>에이블리 옵션 번호 (G열)</th>
                      <th>재고 수량 (E열)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {todayRows.map((r, i) => (
                      <tr key={i}>
                        <td>{r.A}</td>
                        <td>{r.B}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

        </>
      )}

      {activeTab === "janggi" && (
        <>
          <section className={styles.card}>
            <div className={styles.cardHeader}>
              <div className={styles.cardTitleRow}>
                <div className={`${styles.cardIcon} ${styles.cardIconPurple}`}><Table2 size={15} /></div>
                <h3 className={styles.cardTitle}>신상 업로드 날짜별 시트2</h3>
              </div>
            </div>
            <div className={styles.uploadRow}>
              <label className={styles.fileInput}>
                <input
                  type="file"
                  accept=".xls,.xlsx,.xlsm"
                  onChange={(e) => {
                    setJanggiFile(e.target.files?.[0] ?? null);
                    setJanggiRows([]);
                  }}
                />
                <FileSpreadsheet size={14} />{janggiFile ? janggiFile.name : "XLS 파일 선택"}
              </label>
              <button className={styles.primaryBtn} onClick={processJanggi} disabled={loading}>
                <Zap size={14} />가공
              </button>
              <button className={styles.secondaryBtn} onClick={downloadJanggi} disabled={loading || !janggiRows.length}>
                <ArrowDownToLine size={13} />다운로드
              </button>
              <button className={styles.secondaryBtn} onClick={copyJanggi} disabled={loading || !janggiRows.length}>
                <Clipboard size={13} />엑셀 복사
              </button>
            </div>
            <div className={styles.statusMsg}>
              <strong>설명:</strong> 현재고조회 다운로드항목4 신상 다운로드 후 버튼 누르면 날짜별 시트2 양식으로 가공
            </div>
          </section>

          {janggiRows.length > 0 && (
            <section className={styles.card}>
              <div className={styles.cardHeader}>
                <div className={styles.cardTitleRow}>
                  <div className={`${styles.cardIcon} ${styles.cardIconSlate}`}><Table2 size={15} /></div>
                  <h3 className={styles.cardTitle}>가공 결과</h3>
                </div>
                <span className={styles.pill}>{janggiRows.length}행</span>
              </div>
              <div className={`${styles.tableWrap} ${styles.registeredTableWrap}`}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>A (J열)</th>
                      <th>B (B열)</th>
                      <th>C (색상)</th>
                      <th>D (사이즈)</th>
                      <th>E (H열)</th>
                      <th>F (브랜드)</th>
                      <th>G (상품명)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {janggiRows.map((r, i) => (
                      <tr key={i}>
                        <td>{r.A}</td>
                        <td>{r.B}</td>
                        <td>{r.C}</td>
                        <td>{r.D}</td>
                        <td>{r.E}</td>
                        <td>{r.F}</td>
                        <td>{r.G}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}

      {activeTab === "receipt-excel" && (
        <>
          <section className={styles.card}>
            <div className={styles.cardHeader}>
              <div className={styles.cardTitleRow}>
                <div className={`${styles.cardIcon} ${styles.cardIconBlue}`}><FileSpreadsheet size={15} /></div>
                <h3 className={styles.cardTitle}>입고전표 엑셀전환</h3>
              </div>
              <span className={styles.pill}>{excelSlipRows.length}건</span>
            </div>
            <div className={styles.statusMsg}>
              원본 엑셀 1행은 헤더로 건너뛰고, A열 공급처 상품명은 첫 띄어쓰기 기준으로 A/B, B열 옵션은 D/E, F열은 원본 C열로 옮깁니다. 원본 F열 상품코드는 I열로 옮기고, 원본 D열이 0 초과면 H열에 미송, 원본 E열에 미송픽업 또는 교환픽업이 있으면 C/H열에 해당 문구를 넣습니다.
            </div>
            <div className={styles.uploadRow}>
              <label className={styles.fileInput}>
                <input
                  type="file"
                  accept=".xls,.xlsx,.xlsm"
                  onChange={(e) => {
                    setExcelSlipFile(e.target.files?.[0] ?? null);
                    setExcelSlipRows([]);
                    setExcelSlipOutput("");
                    setMessage("");
                  }}
                />
                <FileSpreadsheet size={14} />{excelSlipFile ? excelSlipFile.name : "입고전표 엑셀 선택"}
              </label>
              <button className={styles.primaryBtn} onClick={runExcelSlipConvert} disabled={loading || !excelSlipFile}>
                <Zap size={14} />엑셀 변환
              </button>
              <button
                className={styles.secondaryBtn}
                onClick={handleSlipFromEzadmin}
                disabled={loading || loadingSlipVoucherList}
              >
                <ArrowDownToLine size={13} />{loadingSlipVoucherList ? "목록 불러오는 중..." : "EZAdmin 불러오기"}
              </button>
              <button
                className={styles.secondaryBtn}
                onClick={() => {
                  setExcelSlipFile(null);
                  setExcelSlipRows([]);
                  setExcelSlipOutput("");
                  setMessage("");
                }}
                disabled={loading}
              >
                <X size={13} />초기화
              </button>
            </div>
          </section>

          <section className={styles.card}>
            <div className={styles.cardHeader}>
              <div className={styles.cardTitleRow}>
                <div className={`${styles.cardIcon} ${styles.cardIconSlate}`}><Table2 size={15} /></div>
                <h3 className={styles.cardTitle}>부가세 거래처</h3>
              </div>
              <span className={styles.pill}>{vatVendors.length}개</span>
            </div>
            <div className={styles.statusMsg}>
              여기에 등록된 거래처(A열)는 변환 시 매입차감을 제외한 상품금액 합계 * 0.1을 부가세 행으로 자동 추가합니다.
            </div>
            <div className={styles.uploadRow}>
              <input
                className={styles.misongFormInput}
                type="text"
                value={vatVendorInput}
                onChange={(e) => setVatVendorInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") addVatVendor(); }}
                placeholder="거래처명 입력 (A열과 동일하게)"
              />
              <button className={styles.primaryBtn} onClick={addVatVendor} disabled={!vatVendorInput.trim()}>
                <Plus size={14} />등록
              </button>
            </div>
            {vatVendors.length > 0 && (
              <div className={styles.uploadRow} style={{ flexWrap: "wrap" }}>
                {vatVendors.map((vendor) => (
                  <span key={vendor} className={styles.pill} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    {vendor}
                    <X size={12} style={{ cursor: "pointer" }} onClick={() => removeVatVendor(vendor)} />
                  </span>
                ))}
              </div>
            )}
          </section>

          <section className={styles.card}>
            <div className={styles.cardHeader}>
              <div className={styles.cardTitleRow}>
                <div className={`${styles.cardIcon} ${styles.cardIconSlate}`}><Clipboard size={15} /></div>
                <h3 className={styles.cardTitle}>TSV</h3>
              </div>
            </div>
            <textarea
              className={styles.scanInput}
              style={{ minHeight: 220, width: "100%", fontSize: "0.95rem" }}
              value={excelSlipOutput}
              onChange={(e) => setExcelSlipOutput(e.target.value)}
              placeholder="변환 결과가 여기에 표시됩니다."
            />
            <div className={styles.uploadRow}>
              <button className={styles.secondaryBtn} onClick={copyExcelSlipResult} disabled={loading || !excelSlipOutput}>
                <Clipboard size={13} />결과 복사
              </button>
              <button className={styles.primaryBtn} onClick={saveJanggiRows} disabled={savingJanggi || !excelSlipRows.length}>
                <ArrowDownToLine size={13} />{savingJanggi ? "저장 중..." : "DB저장"}
              </button>
            </div>
          </section>

          {excelSlipRows.length > 0 && (
            <section className={styles.card}>
              <div className={styles.cardHeader}>
                <div className={styles.cardTitleRow}>
                  <div className={`${styles.cardIcon} ${styles.cardIconSlate}`}><Table2 size={15} /></div>
                  <h3 className={styles.cardTitle}>미리보기</h3>
                </div>
              </div>
              <div className={`${styles.tableWrap} ${styles.registeredTableWrap}`}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>A</th>
                      <th>B</th>
                      <th>C</th>
                      <th>D</th>
                      <th>E</th>
                      <th>F</th>
                      <th>G</th>
                      <th>H</th>
                      <th>I</th>
                      <th>메모</th>
                    </tr>
                  </thead>
                  <tbody>
                    {excelSlipRows.map((row, index) => (
                      <tr key={`${row.A}-${row.B}-${index}`}>
                        <td>{row.A}</td>
                        <td>{row.B}</td>
                        <td>{row.C}</td>
                        <td>{row.D}</td>
                        <td>{row.E}</td>
                        <td>{row.F}</td>
                        <td>{row.G}</td>
                        <td>{row.H}</td>
                        <td>{row.I}</td>
                        <td>{row.memo || ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}

      {activeTab === "bulyang" && (() => {
        const guides = getBulyangGuides();
        const iStyle = { padding: "3px 7px", border: "1px solid var(--border-color)", borderRadius: 4, background: "var(--bg-secondary)", color: "var(--text-primary)", fontSize: "0.82rem", width: 80 };
        return (
          <>
            {/* ── 업로드 & 설정 ── */}
            <section className={styles.card}>
              <div className={styles.cardHeader}>
                <div className={styles.cardTitleRow}>
                  <div className={`${styles.cardIcon} ${styles.cardIconBlue}`}><Printer size={15} /></div>
                  <h3 className={styles.cardTitle}>불량출력</h3>
                </div>
                {bulyangGroups.length > 0 && <span className={styles.pill}>{bulyangGroups.length}개 거래처</span>}
              </div>
              <div className={styles.statusMsg}>
                <strong>엑셀:</strong> A=거래처명 &nbsp;B=상품명 &nbsp;C=색상 &nbsp;D=수량 &nbsp;E=주소 &nbsp;(헤더 없음)
              </div>
              <div className={styles.uploadRow}>
                <label className={styles.fileInput}>
                  <input type="file" accept=".xlsx,.xls,.xlsm" onChange={(e) => {
                    setBulyangFile(e.target.files?.[0] ?? null);
                    setBulyangSessionId(null); setBulyangGroups([]); setBulyangIndex(0); setBulyangImgData(null);
                  }} />
                  <FileSpreadsheet size={14} />{bulyangFile ? bulyangFile.name : "엑셀 파일 선택"}
                </label>
                <button className={styles.primaryBtn} onClick={uploadBulyang} disabled={loading}>
                  <ArrowDownToLine size={14} style={{ rotate: "180deg" }} />업로드
                </button>
                <button className={styles.secondaryBtn} onClick={refreshBulyangPreview} disabled={loading || !bulyangSessionId}>
                  <RefreshCw size={13} />미리보기 갱신
                </button>
                <button className={styles.secondaryBtn} onClick={downloadBulyangZip} disabled={loading || !bulyangSessionId}>
                  <ArrowDownToLine size={13} />전체 ZIP 저장
                </button>
                <button className={styles.secondaryBtn} onClick={printCurrentBulyang} disabled={loading || !bulyangImgData}>
                  <Printer size={13} />현재 인쇄
                </button>
                <button className={styles.secondaryBtn} onClick={printAllBulyang} disabled={loading || !bulyangSessionId}>
                  <Printer size={13} />전체 인쇄
                </button>
              </div>

              {/* 설정: 제목·문구·2개 스피너 */}
              <div style={{ display: "flex", flexWrap: "wrap", gap: "0.6rem 1.4rem", alignItems: "flex-end" }}>
                {[
                  { label: "제목", key: "title", type: "text", w: 120 },
                  { label: "하단 우측 문구", key: "footer_text", type: "text", w: 160 },
                ].map(({ label, key, type, w }) => (
                  <label key={key} style={{ fontSize: "0.82rem", display: "flex", flexDirection: "column", gap: 2 }}>
                    <span style={{ fontWeight: 600, color: "var(--text-secondary)" }}>{label}</span>
                    <input type={type} style={{ ...iStyle, width: w }}
                      value={bulyangLayout[key]}
                      onChange={(e) => setLayout(key, e.target.value)} />
                  </label>
                ))}
                <label style={{ fontSize: "0.82rem", display: "flex", flexDirection: "column", gap: 2 }}>
                  <span style={{ fontWeight: 600, color: "var(--text-secondary)" }}>거래처명 글자(mm)</span>
                  <input type="number" step={0.2} min={2} style={iStyle}
                    value={bulyangLayout.vname_v_size_mm}
                    onChange={(e) => setLayout("vname_v_size_mm", Number(e.target.value))} />
                </label>
                <label style={{ fontSize: "0.82rem", display: "flex", flexDirection: "column", gap: 2 }}>
                  <span style={{ fontWeight: 600, color: "var(--text-secondary)" }}>각주 글자(mm)</span>
                  <input type="number" step={0.2} min={2} style={iStyle}
                    value={bulyangLayout.footer_size_mm}
                    onChange={(e) => setLayout("footer_size_mm", Number(e.target.value))} />
                </label>
              </div>
            </section>

            {/* ── 미리보기 + 드래그 가이드 ── */}
            {bulyangSessionId && bulyangGroups.length > 0 && (
              <section className={styles.card}>
                <div className={styles.cardHeader}>
                  <div className={styles.cardTitleRow}>
                    <div className={`${styles.cardIcon} ${styles.cardIconSlate}`}><Printer size={15} /></div>
                    <h3 className={styles.cardTitle}>{bulyangGroups[bulyangIndex]?.vendor || "(거래처명 없음)"}</h3>
                  </div>
                  <span className={styles.pill}>{bulyangIndex + 1} / {bulyangGroups.length}</span>
                </div>

                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <button className={styles.secondaryBtn} onClick={() => moveBulyang(bulyangIndex - 1)} disabled={loading || bulyangIndex === 0}>◀ 이전</button>
                  <select
                    style={{ fontSize: "0.82rem", padding: "4px 7px", flex: 1, maxWidth: 520, border: "1px solid var(--border-color)", borderRadius: 4, background: "var(--bg-secondary)", color: "var(--text-primary)" }}
                    value={bulyangIndex}
                    onChange={(e) => moveBulyang(Number(e.target.value))}
                  >
                    {bulyangGroups.map((g, i) => (
                      <option key={i} value={i}>{i + 1}. {g.vendor || "(거래처명 없음)"} | {(g.addr || "").slice(0, 40)}</option>
                    ))}
                  </select>
                  <button className={styles.secondaryBtn} onClick={() => moveBulyang(bulyangIndex + 1)} disabled={loading || bulyangIndex >= bulyangGroups.length - 1}>다음 ▶</button>
                </div>

                {bulyangImgData && (
                  <div ref={bulyangPreviewRef} style={{ position: "relative", display: "inline-block", width: "min(560px, 100%)", background: "#f5f5f5", borderRadius: 6, padding: 10 }}>
                    <img
                      src={bulyangImgData.src}
                      alt="라벨 미리보기"
                      style={{ display: "block", width: "100%", border: "1px solid #ddd", borderRadius: 4 }}
                    />
                    {guides && (
                      <svg
                        viewBox={`0 0 ${guides.imgW} ${guides.imgH}`}
                        style={{ position: "absolute", inset: 10, width: "calc(100% - 20px)", height: "calc(100% - 20px)", overflow: "visible", pointerEvents: "none" }}
                      >
                        {/* 색상 열 구분선 (녹색) */}
                        <g style={{ pointerEvents: "all", cursor: "ew-resize" }}
                          onMouseDown={(e) => onBulyangGuideDown(e, "x_color")}>
                          <line x1={guides.xColor} y1={0} x2={guides.xColor} y2={guides.imgH} stroke="transparent" strokeWidth={14} />
                          <line x1={guides.xColor} y1={0} x2={guides.xColor} y2={guides.imgH} stroke="#22a" strokeWidth={2} strokeDasharray="6 3" />
                          <text x={guides.xColor + 4} y={20} fill="#22a" fontSize={18} fontFamily="sans-serif">색상 열</text>
                        </g>
                        {/* 수량 열 구분선 (보라) */}
                        <g style={{ pointerEvents: "all", cursor: "ew-resize" }}
                          onMouseDown={(e) => onBulyangGuideDown(e, "x_qty")}>
                          <line x1={guides.xQty} y1={0} x2={guides.xQty} y2={guides.imgH} stroke="transparent" strokeWidth={14} />
                          <line x1={guides.xQty} y1={0} x2={guides.xQty} y2={guides.imgH} stroke="#a27" strokeWidth={2} strokeDasharray="6 3" />
                          <text x={guides.xQty + 4} y={42} fill="#a27" fontSize={18} fontFamily="sans-serif">수량 열</text>
                        </g>
                        {/* 표 시작 가로선 (파랑) */}
                        <g style={{ pointerEvents: "all", cursor: "ns-resize" }}
                          onMouseDown={(e) => onBulyangGuideDown(e, "table_y")}>
                          <line x1={0} y1={guides.tableY} x2={guides.imgW} y2={guides.tableY} stroke="transparent" strokeWidth={14} />
                          <line x1={0} y1={guides.tableY} x2={guides.imgW} y2={guides.tableY} stroke="#27a" strokeWidth={2} strokeDasharray="6 3" />
                          <text x={10} y={guides.tableY - 6} fill="#27a" fontSize={18} fontFamily="sans-serif">표 시작 (offset: {bulyangLayout.table_top_offset_mm}mm)</text>
                        </g>
                      </svg>
                    )}
                  </div>
                )}

                <div className={styles.statusMsg}>
                  <strong>주소:</strong> {bulyangGroups[bulyangIndex]?.addr || "-"} &nbsp;|&nbsp;
                  <strong>상품 수:</strong> {bulyangGroups[bulyangIndex]?.item_count ?? "-"} &nbsp;|&nbsp;
                  <strong>열 비율:</strong> {bulyangLayout.name_ratio.toFixed(2)} / {bulyangLayout.color_ratio.toFixed(2)} / {bulyangLayout.qty_ratio.toFixed(2)}
                </div>
              </section>
            )}
          </>
        );
      })()}

      {message && (
        <div className={`${styles.statusMsg} ${message.includes("실패") || message.includes("없습니다") || message.includes("선택하세요") ? styles.statusMsgError : styles.statusMsgSuccess}`}>
          <strong>{message}</strong>
        </div>
      )}

      {showBaseEditor && (
        <div className={styles.modalOverlay} onClick={() => setShowBaseEditor(false)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <h3 className={styles.modalTitle}>케이디지 원가베이스 편집</h3>
              <div className={styles.modalActions}>
                <input
                  className={styles.searchInput}
                  value={baseQuery}
                  onChange={(e) => setBaseQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") fetchBasePreview(0, baseQuery).catch(() => {});
                  }}
                  placeholder="검색어 입력"
                />
                <button className={styles.secondaryBtn} onClick={() => fetchBasePreview(0, baseQuery).catch(() => {})}>
                  검색
                </button>
                <button className={styles.secondaryBtn} onClick={() => fetchBasePreview(baseOffset, baseQuery).catch(() => {})}>
                  <RefreshCw size={13} />새로고침
                </button>
                <button className={styles.primaryBtn} onClick={commitBaseEdits} disabled={loading}>
                  변경 적용
                </button>
                <button className={styles.secondaryBtn} onClick={() => setShowBaseEditor(false)}>
                  <X size={13} />닫기
                </button>
              </div>
            </div>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>#</th>
                    {baseColumns.map((c) => (
                      <th key={c}>{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {baseRows.map((row) => (
                    <tr key={row.row_index}>
                      <td>{row.row_index + 1}</td>
                      {row.values.map((v, idx) => (
                        <td key={`${row.row_index}-${idx}`}>
                          <input
                            className={styles.cellInput}
                            value={v ?? ""}
                            onChange={(e) => handleBaseCellChange(row.row_index, idx, e.target.value)}
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className={styles.uploadRow}>
              <button
                className={styles.secondaryBtn}
                onClick={() => fetchBasePreview(Math.max(0, baseOffset - baseLimit), baseQuery).catch(() => {})}
                disabled={baseOffset === 0}
              >
                이전
              </button>
              <button
                className={styles.secondaryBtn}
                onClick={() =>
                  fetchBasePreview(Math.min(baseOffset + baseLimit, Math.max(baseTotal - baseLimit, 0)), baseQuery).catch(() => {})
                }
                disabled={baseOffset + baseLimit >= baseTotal}
              >
                다음
              </button>
              <span className={styles.metaLabel}>
                {baseTotal ? `${baseOffset + 1}-${Math.min(baseOffset + baseLimit, baseTotal)} / ${baseTotal}` : "0"}
              </span>
            </div>
          </div>
        </div>
      )}
      {/* 입고전표 선택 모달 */}
      {showSlipVoucherModal && (
        <div className={styles.modalOverlay} onClick={() => setShowSlipVoucherModal(false)}>
          <div className={styles.modal} style={{ width: "min(480px, 92vw)", padding: "1.25rem", gap: "0.75rem" }} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader} style={{ padding: 0, borderBottom: "none" }}>
              <span className={styles.modalTitle}>입고전표 선택</span>
              <button type="button" className={styles.secondaryBtn} onClick={() => setShowSlipVoucherModal(false)}>닫기</button>
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontWeight: 600, cursor: "pointer", padding: "0.3rem 0" }}>
              <input
                type="checkbox"
                checked={selectedSlipSheets.length === slipVoucherList.length && slipVoucherList.length > 0}
                onChange={(e) => setSelectedSlipSheets(
                  e.target.checked ? slipVoucherList.map((v) => String(v.sheet)) : []
                )}
              />
              전체 선택 ({selectedSlipSheets.length}/{slipVoucherList.length})
            </label>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.1rem", maxHeight: 340, overflowY: "auto", border: "1px solid var(--border-color)", borderRadius: "var(--radius-sm)", padding: "0.25rem" }}>
              {slipVoucherList.map((v) => {
                const sheet = String(v.sheet);
                const checked = selectedSlipSheets.includes(sheet);
                const c = v.cell || {};
                const displayName = c.sheet_name || c.title || c.supply_name || "";
                const subInfo = [c.crdate, c.req_qty ? `${c.req_qty}개` : null].filter(Boolean).join(" · ");
                return (
                  <label key={sheet} style={{ display: "flex", alignItems: "center", gap: "0.5rem", padding: "0.35rem 0.6rem", borderRadius: "var(--radius-sm)", cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => setSelectedSlipSheets((prev) =>
                        checked ? prev.filter((s) => s !== sheet) : [...prev, sheet]
                      )}
                    />
                    <span style={{ fontFamily: "monospace", fontSize: "0.82rem", color: "var(--text-muted)", minWidth: "4.5rem", flexShrink: 0 }}>{sheet}</span>
                    <span style={{ fontSize: "0.9rem", flex: 1 }}>{displayName}</span>
                    {subInfo && <span style={{ fontSize: "0.8rem", color: "var(--text-muted)", flexShrink: 0 }}>{subInfo}</span>}
                  </label>
                );
              })}
            </div>
            <button
              type="button"
              className={styles.primaryBtn}
              onClick={handleSlipVoucherConfirm}
              disabled={!selectedSlipSheets.length}
            >
              <ArrowDownToLine size={13} />{selectedSlipSheets.length}건 불러오기
            </button>
          </div>
        </div>
      )}

      {/* 미송 확인 팝업 — 탭에 무관하게 항상 렌더 */}
      {misongConfirm && (
        <div className={styles.modalOverlay} onClick={() => setMisongConfirm(null)}>
          <div className={styles.misongConfirmBox} onClick={(e) => e.stopPropagation()}>
            <p className={styles.misongConfirmMsg}>{misongConfirm.message}</p>
            <div className={styles.misongConfirmActions}>
              <button className={styles.primaryBtn} onClick={misongConfirm.onConfirm}>
                확인
              </button>
              <button className={styles.secondaryBtn} onClick={() => setMisongConfirm(null)}>
                취소
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
