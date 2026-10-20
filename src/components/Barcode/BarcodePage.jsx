import { useCallback, useEffect, useRef, useState } from "react";
import { useEzadminSession } from "../../lib/EzadminSessionContext";
import styles from "./BarcodePage.module.css";
import { getDownloadFilename } from "../../lib/download";
import { LOCAL_API_BASE as API, getAuthHeaders, handleUnauthorized } from "../../lib/api";

const HANGUL_BASE = 0xac00;
const HANGUL_LAST = 0xd7a3;
const HANGUL_L = ["r","R","s","e","E","f","a","q","Q","t","T","d","w","W","c","z","x","v","g"];
const HANGUL_V = ["k","o","i","O","j","p","u","P","h","hk","ho","hl","y","n","nj","np","nl","b","m","ml","l"];
const HANGUL_T = ["","r","R","rt","s","sw","sg","e","f","fr","fa","fq","ft","fx","fv","fg","a","q","qt","t","T","d","w","c","z","x","v","g"];
const HANGUL_COMPAT = {
  ㄱ:"r",ㄲ:"R",ㄴ:"s",ㄷ:"e",ㄸ:"E",ㄹ:"f",ㅁ:"a",ㅂ:"q",ㅃ:"Q",ㅅ:"t",ㅆ:"T",
  ㅇ:"d",ㅈ:"w",ㅉ:"W",ㅊ:"c",ㅋ:"z",ㅌ:"x",ㅍ:"v",ㅎ:"g",
  ㅏ:"k",ㅐ:"o",ㅑ:"i",ㅒ:"O",ㅓ:"j",ㅔ:"p",ㅕ:"u",ㅖ:"P",ㅗ:"h",ㅘ:"hk",ㅙ:"ho",
  ㅚ:"hl",ㅛ:"y",ㅜ:"n",ㅝ:"nj",ㅞ:"np",ㅟ:"nl",ㅠ:"b",ㅡ:"m",ㅢ:"ml",ㅣ:"l",
};

const toEnglishKey = (text) => {
  if (!text) return text;
  let out = "";
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code >= HANGUL_BASE && code <= HANGUL_LAST) {
      const sIndex = code - HANGUL_BASE;
      const lIndex = Math.floor(sIndex / 588);
      const vIndex = Math.floor((sIndex % 588) / 28);
      const tIndex = sIndex % 28;
      out += `${HANGUL_L[lIndex]}${HANGUL_V[vIndex]}${HANGUL_T[tIndex]}`;
      continue;
    }
    if (HANGUL_COMPAT[ch]) { out += HANGUL_COMPAT[ch]; continue; }
    out += ch;
  }
  return out.toUpperCase();
};

const BAD_STOCK_CATEGORIES = ["상의", "하의"];
const BAD_STOCK_LETTERS = ["A", "B", "C", "D", "E"];
const badStockZoneLabel = (zone) => `${zone.slice(0, 2)} ${zone.slice(2)}구역`;

export default function BarcodePage({ title = "Barcode", headerExtra = null }) {
  const [file, setFile] = useState(null);
  const [uploadMsg, setUploadMsg] = useState("");
  const [count, setCount] = useState(null);
  const [codesTotal, setCodesTotal] = useState(null);
  const [loadingUpload, setLoadingUpload] = useState(false);
  const [incomingFile, setIncomingFile] = useState(null);
  const [incomingMsg, setIncomingMsg] = useState("");
  const [incomingCodes, setIncomingCodes] = useState(null);
  const [incomingTotal, setIncomingTotal] = useState(null);
  const [loadingIncoming, setLoadingIncoming] = useState(false);
  const [scanText, setScanText] = useState("");
  const scanRef = useRef(null);
  const [currentInvoice, setCurrentInvoice] = useState(null);
  const [invoiceDone, setInvoiceDone] = useState(false);
  const [, setLog] = useState([]);
  const [items, setItems] = useState([]);
  const [defectMode, setDefectMode] = useState(false);
  const [showDefectList, setShowDefectList] = useState(false);
  const [defectList, setDefectList] = useState([]);
  const [defectSearchQuery, setDefectSearchQuery] = useState("");
  const [defectSearchRows, setDefectSearchRows] = useState([]);
  const [defectSearchLoading, setDefectSearchLoading] = useState(false);
  const [defectSearchMessage, setDefectSearchMessage] = useState("");
  const [defectRecentCodes, setDefectRecentCodes] = useState([]);
  const [showKimsungilList, setShowKimsungilList] = useState(false);
  const [kimsungilList, setKimsungilList] = useState([]);
  const [kimsungilSearchQuery, setKimsungilSearchQuery] = useState("");
  const [kimsungilSearchRows, setKimsungilSearchRows] = useState([]);
  const [kimsungilSearchLoading, setKimsungilSearchLoading] = useState(false);
  const [kimsungilSearchMessage, setKimsungilSearchMessage] = useState("");
  const [kimsungilSummonLoading, setKimsungilSummonLoading] = useState(false);
  const [showKimsungilLog, setShowKimsungilLog] = useState(false);
  const [kimsungilLogCode, setKimsungilLogCode] = useState("");
  const [kimsungilLogRows, setKimsungilLogRows] = useState([]);
  const [kimsungilLogLoading, setKimsungilLogLoading] = useState(false);
  const [kimsungilLogMessage, setKimsungilLogMessage] = useState("");
  const [defectBaseHeaders, setDefectBaseHeaders] = useState(["상품코드", "상품명", "공급처", "공급처상품명", "색상 사이즈", "주소", "표시형 상품명"]);
  const [defectBaseRows, setDefectBaseRows] = useState([]);
  const [defectBasePath, setDefectBasePath] = useState("");
  const [defectBaseQuery, setDefectBaseQuery] = useState("");
  const [defectBaseLoading, setDefectBaseLoading] = useState(false);
  const [defectBaseSaving, setDefectBaseSaving] = useState(false);
  const [defectBaseMessage, setDefectBaseMessage] = useState("");
  const [showDefectBaseEditor, setShowDefectBaseEditor] = useState(false);
  const [showAnomalyModal, setShowAnomalyModal] = useState(false);
  const [anomalyList, setAnomalyList] = useState([]);
  const [showBadStockModal, setShowBadStockModal] = useState(false);
  const [badStockZone, setBadStockZone] = useState("상의A");
  const [badStockList, setBadStockList] = useState([]);
  const [badStockScan, setBadStockScan] = useState("");
  const [badStockQuery, setBadStockQuery] = useState("");
  const [badStockRows, setBadStockRows] = useState([]);
  const [badStockSearching, setBadStockSearching] = useState(false);
  const [badStockMessage, setBadStockMessage] = useState("");
  const [badStockChecking, setBadStockChecking] = useState(false);
  const [badStockCheck, setBadStockCheck] = useState(null);
  const [badStockSelected, setBadStockSelected] = useState([]);
  const [badStockFind, setBadStockFind] = useState("");
  const [badStockNormalizing, setBadStockNormalizing] = useState(false);
  const [anomalySearchQuery, setAnomalySearchQuery] = useState("");
  const [anomalySearchRows, setAnomalySearchRows] = useState([]);
  const [anomalySearchLoading, setAnomalySearchLoading] = useState(false);
  const [anomalyMessage, setAnomalyMessage] = useState("");
  const [anomalyForm, setAnomalyForm] = useState({
    registered_date: new Date().toLocaleDateString("sv-SE"),
    product_name: "",
    qty: 1,
    reason: "",
    normalized: false,
  });
  const [anomalyEdit, setAnomalyEdit] = useState(null);
  const [ochuulLoading, setOchuulLoading] = useState(false);
  const [ochuulResult, setOchuulResult] = useState(null);
  const [ezadminLoading, setEzadminLoading] = useState(false);
  const [ezadminMsg, setEzadminMsg] = useState("");
  const [incomingEzDate, setIncomingEzDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [incomingVoucherLoading, setIncomingVoucherLoading] = useState(false);
  const [incomingVoucherList, setIncomingVoucherList] = useState([]);
  const [showIncomingVoucherModal, setShowIncomingVoucherModal] = useState(false);
  const [selectedIncomingSheets, setSelectedIncomingSheets] = useState([]);
  const [ezadminOrdersLoading, setEzadminOrdersLoading] = useState(false);
  const [ezadminOrdersMsg, setEzadminOrdersMsg] = useState("");
  const [ezadminOrdersTiming, setEzadminOrdersTiming] = useState(null);
  const [ezadminOrdersDate, setEzadminOrdersDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [defectEzadminLoading, setDefectEzadminLoading] = useState(false);
  const [defectEzadminMsg, setDefectEzadminMsg] = useState("");
  const { openModal: openEzadminModal } = useEzadminSession();
  const soundsRef = useRef(null);

  const [showInvoiceModal, setShowInvoiceModal] = useState(false);
  const [invoiceBulkMode, setInvoiceBulkMode] = useState(false);
  const [invoiceStockOutEnabled, setInvoiceStockOutEnabled] = useState(true);
  const [invoiceStockOutMemo, setInvoiceStockOutMemo] = useState("");
  const [invoiceNoInput, setInvoiceNoInput] = useState("");
  const [invoicePreview, setInvoicePreview] = useState(null);
  const [invoicePreviewLoading, setInvoicePreviewLoading] = useState(false);
  const [invoicePreviewError, setInvoicePreviewError] = useState("");
  const [invoiceSteps, setInvoiceSteps] = useState([]);
  const [invoiceExecuting, setInvoiceExecuting] = useState(false);
  const [invoiceBulkInput, setInvoiceBulkInput] = useState("");
  const [invoiceBulkResults, setInvoiceBulkResults] = useState([]);
  const [invoiceBulkRunning, setInvoiceBulkRunning] = useState(false);
  const getInvoiceStepLabels = (includeStockOut) => (
    includeStockOut
      ? ["거래취소 · 송장번호 삭제", "재고 출고처리", "에이블리 발송관리 롤백"]
      : ["거래취소 · 송장번호 삭제", "에이블리 발송관리 롤백"]
  );

  const pushLog = (msg) => setLog((prev) => [msg, ...prev]);

  const refreshStatus = useCallback(async () => {
    try {
      const res = await fetch(`${API}/barcode/status`, { headers: getAuthHeaders() });
      if (handleUnauthorized(res)) return;
      const data = await res.json();
      if (data?.incoming_codes !== undefined) {
        setIncomingCodes(data.incoming_codes);
        setIncomingTotal(data.incoming_total ?? 0);
      }
      if (data.loaded) {
        setCurrentInvoice(data.current_invoice ?? null);
        setInvoiceDone(false);
        if (data.current_invoice) setItems(data.items ?? []);
        else if (Array.isArray(data.items) && data.items.length > 0) setItems(data.items);
        setDefectList(data.defects ?? []);
        setKimsungilList(data.kimsungil ?? []);
      } else {
        setCurrentInvoice(null); setInvoiceDone(false);
             }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { refreshStatus(); setTimeout(() => scanRef.current?.focus(), 50); }, [refreshStatus]);

  useEffect(() => {
    const makeAudio = (src) => {
      const a = new Audio(src);
      a.preload = "auto";
      return a;
    };
    soundsRef.current = {
      invoiceDone: makeAudio("/sounds/zz.wav"),
      itemDone: makeAudio("/sounds/xx.wav"),
      bad: makeAudio("/sounds/dd.wav"),
      invoiceDefect: makeAudio("/sounds/bb.wav"),
      postShipmentCancel: makeAudio("/sounds/ice.wav"),
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (e) => { if (e.key === "F2") { e.preventDefault(); setDefectMode((v) => !v); } };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const handleUpload = async () => {
    if (!file) { alert("송장 파일을 선택해 주세요."); return; }
    const formData = new FormData();
    formData.append("file", file);
    try {
      setLoadingUpload(true); setUploadMsg(""); setCount(null); setCodesTotal(null);
      const res = await fetch(`${API}/barcode/upload`, { method: "POST", headers: getAuthHeaders(), body: formData });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "업로드 실패");
      setUploadMsg("업로드 완료");
      setCount(data.invoices ?? null); setCodesTotal(data.codes_total ?? null);
      pushLog(`업로드 완료 (송장 ${data.invoices ?? "-"} / 코드 ${data.codes_total ?? "-"})`);
      setCurrentInvoice(null); setInvoiceDone(false);
      setItems([]); setDefectRecentCodes([]); setScanText("");
      setTimeout(() => scanRef.current?.focus(), 50);
    } catch (err) {
      setUploadMsg(`업로드 실패: ${err.message || ""}`.trim());
      pushLog(`업로드 실패: ${err.message || ""}`.trim());
    } finally { setLoadingUpload(false); }
  };

  const handleIncomingUpload = async () => {
    if (!incomingFile) { alert("입고 파일을 선택해 주세요."); return; }
    const formData = new FormData();
    formData.append("file", incomingFile);
    try {
      setLoadingIncoming(true); setIncomingMsg(""); setIncomingCodes(null); setIncomingTotal(null);
      const res = await fetch(`${API}/barcode/incoming/upload`, { method: "POST", headers: getAuthHeaders(), body: formData });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "입고 파일 업로드 실패");
      setIncomingMsg("입고 파일 로드 완료");
      setIncomingCodes(data.codes ?? null); setIncomingTotal(data.total_qty ?? null);
      pushLog(`입고 파일 로드 완료 (코드 ${data.codes ?? "-"} / 수량 ${data.total_qty ?? "-"})`);
      await refreshStatus();
    } catch (err) {
      setIncomingMsg(`입고 파일 업로드 실패: ${err.message || ""}`.trim());
      pushLog(`입고 파일 업로드 실패: ${err.message || ""}`.trim());
    } finally { setLoadingIncoming(false); }
  };

  const handleIncomingFromEzadmin = async (sheetList) => {
    const sheets = Array.isArray(sheetList) ? sheetList.filter(Boolean) : [];
    try {
      setEzadminLoading(true);
      setEzadminMsg(`EZAdmin에서 불러오는 중... (${incomingEzDate}${sheets.length ? `, 전표 ${sheets.length}건` : ""}, 최대 60초)`);
      setIncomingMsg(""); setIncomingCodes(null); setIncomingTotal(null);
      const res = await fetch(`${API}/barcode/incoming/upload-from-ezadmin`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ date: incomingEzDate, ...(sheets.length ? { sheet_list: sheets } : {}) }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (data?.need_session) {
        setEzadminMsg("");
        openEzadminModal(() => handleIncomingFromEzadmin(sheets));
        return;
      }
      if (!res.ok || !data?.ok) {
        const msg = data?.detail || "EZAdmin 불러오기 실패";
        setIncomingMsg(msg); pushLog(msg);
        return;
      }
      setIncomingMsg(`EZAdmin 입고 데이터 로드 완료 (${data.date ?? incomingEzDate})`);
      setIncomingCodes(data.codes ?? null); setIncomingTotal(data.total_qty ?? null);
      pushLog(`EZAdmin 입고 로드 완료 (${data.date ?? incomingEzDate} · 코드 ${data.codes ?? "-"} / 수량 ${data.total_qty ?? "-"})`);
      await refreshStatus();
    } catch (err) {
      const msg = `EZAdmin 불러오기 실패: ${err.message || ""}`.trim();
      setIncomingMsg(msg); pushLog(msg);
    } finally { setEzadminLoading(false); setEzadminMsg(""); }
  };

  const handleOpenIncomingVoucherPicker = async () => {
    setIncomingVoucherLoading(true);
    setIncomingMsg("");
    try {
      const res = await fetch(`${API}/barcode/incoming/ezadmin-voucher-list?date=${encodeURIComponent(incomingEzDate)}`, { headers: getAuthHeaders() });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (data?.need_session) {
        openEzadminModal(handleOpenIncomingVoucherPicker);
        return;
      }
      if (!res.ok || !data?.ok) throw new Error(data?.detail || data?.error || "입고전표 목록 조회 실패");
      if (!data.vouchers?.length) {
        setIncomingMsg(`${incomingEzDate} 입고전표가 없습니다.`);
        return;
      }
      setIncomingVoucherList(data.vouchers);
      setSelectedIncomingSheets(data.vouchers.map((v) => String(v.sheet)));
      setShowIncomingVoucherModal(true);
    } catch (err) {
      setIncomingMsg(err.message || "입고전표 목록 조회 실패");
    } finally {
      setIncomingVoucherLoading(false);
    }
  };

  const handleIncomingVoucherConfirm = async () => {
    if (!selectedIncomingSheets.length) return;
    setShowIncomingVoucherModal(false);
    await handleIncomingFromEzadmin(selectedIncomingSheets);
  };

  const handleUploadFromEzadminOrders = async () => {
    const startedAt = performance.now();
    try {
      setEzadminOrdersLoading(true); setEzadminOrdersMsg(`EZAdmin에서 주문 불러오는 중... (${ezadminOrdersDate})`);
      setEzadminOrdersTiming(null);
      setUploadMsg(""); setCount(null); setCodesTotal(null);
      const res = await fetch(`${API}/barcode/upload-from-ezadmin-orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ date: ezadminOrdersDate }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (data?.need_session) {
        setEzadminOrdersMsg("");
        openEzadminModal(handleUploadFromEzadminOrders);
        return;
      }
      if (!res.ok || !data?.ok) {
        const msg = data?.error || data?.detail || "EZAdmin 주문 불러오기 실패";
        setEzadminOrdersMsg(msg);
        return;
      }
      const timing = data.timings || {
        total_ms: Math.round(performance.now() - startedAt),
        fallback: true,
      };
      const timingText = timing.fallback
        ? `전체 요청 ${(timing.total_ms / 1000).toFixed(2)}초`
        : `응답 ${(timing.api_ms / 1000).toFixed(2)}초 · 가공 ${(timing.processing_ms / 1000).toFixed(2)}초 · 총 ${(timing.total_ms / 1000).toFixed(2)}초`;
      setEzadminOrdersMsg(`완료 (${data.date} · 송장 ${data.invoices} · 코드 ${data.codes_total}) · ${timingText}`);
      setEzadminOrdersTiming(timing);
      setCount(data.invoices ?? null); setCodesTotal(data.codes_total ?? null);
      setCurrentInvoice(null); setInvoiceDone(false);
      setItems([]); setDefectRecentCodes([]); setScanText("");
      setTimeout(() => scanRef.current?.focus(), 50);
    } catch (err) {
      setEzadminOrdersMsg(`실패: ${err.message || ""}`.trim());
    } finally { setEzadminOrdersLoading(false); }
  };

  const isProbablyInvoice = (s) => /^\d{10,}$/.test((s || "").trim());

  const handleDefectAdd = async () => {
    const value = toEnglishKey(scanText.trim());
    if (!value) return;
    try {
      const res = await fetch(`${API}/barcode/defect/add`, {
        method: "POST", headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ code: value }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "불량 등록 실패");
      setItems(data.items ?? items);      setDefectList(data.defects ?? defectList);
      setDefectRecentCodes((prev) => [data.code, ...prev.filter((code) => code !== data.code)]);
      pushLog(`불량 등록: ${data.code} (누적 ${data.defect_count})`);
    } catch (err) { pushLog(`불량 등록 실패: ${err.message || ""}`.trim()); }
    finally { setScanText(""); setTimeout(() => scanRef.current?.focus(), 0); }
  };

  const searchDefectBaseByName = async () => {
    const query = defectSearchQuery.trim();
    if (!query) {
      setDefectSearchRows([]);
      setDefectSearchMessage("검색어를 입력하세요.");
      return;
    }
    try {
      setDefectSearchLoading(true);
      setDefectSearchMessage("");
      const res = await fetch(`${API}/barcode/defect/search?q=${encodeURIComponent(query)}`, { headers: getAuthHeaders() });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "불량 검색 실패");
      setDefectSearchRows(data.rows || []);
      setDefectSearchMessage((data.rows || []).length ? `${data.rows.length}건 검색됨` : "검색 결과가 없습니다.");
    } catch (err) {
      setDefectSearchRows([]);
      setDefectSearchMessage(err.message || "불량 검색 실패");
    } finally {
      setDefectSearchLoading(false);
    }
  };

  const todayStr = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };

  const fetchAnomalies = async () => {
    try {
      const res = await fetch(`${API}/barcode/anomaly/list`, { headers: getAuthHeaders() });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "이상현상 불러오기 실패");
      setAnomalyList(data.items ?? []);
    } catch (err) {
      setAnomalyMessage(err.message || "이상현상 불러오기 실패");
    }
  };

  const fetchBadStock = async () => {
    try {
      const res = await fetch(`${API}/barcode/bad-stock/list`, { headers: getAuthHeaders() });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "악성재고 불러오기 실패");
      setBadStockList(data.items ?? []);
    } catch (err) {
      setBadStockMessage(err.message || "악성재고 불러오기 실패");
    }
  };

  const openBadStockModal = () => {
    setShowBadStockModal(true);
    setBadStockMessage("");
    fetchBadStock();
  };

  const callBadStockApi = async (path, body) => {
    try {
      const res = await fetch(`${API}/barcode/bad-stock/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify(body),
      });
      if (handleUnauthorized(res)) return null;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "악성재고 처리 실패");
      setBadStockList(data.items ?? []);
      return data;
    } catch (err) {
      setBadStockMessage(err.message || "악성재고 처리 실패");
      return null;
    }
  };

  const addBadStock = async (code, productName) => {
    const data = await callBadStockApi("add", { zone: badStockZone, code, product_name: productName });
    if (data) setBadStockMessage(`${badStockZoneLabel(badStockZone)} 추가: ${data.added?.product_name || code}`);
    return !!data;
  };

  const checkBadStockWithEzadmin = async () => {
    setBadStockChecking(true);
    setBadStockMessage("");
    try {
      const res = await fetch(`${API}/barcode/bad-stock/ezadmin-check`, {
        method: "POST",
        headers: getAuthHeaders(),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "이지어드민 재고 확인 실패");
      if (data.need_session) {
        setBadStockCheck(null);
        setBadStockMessage("이지어드민 세션이 만료되었거나 없습니다. PHPSESSID를 다시 등록해주세요.");
        return;
      }
      setBadStockCheck(data);
      setBadStockSelected([]);
    } catch (err) {
      setBadStockMessage(err.message || "이지어드민 재고 확인 실패");
    } finally {
      setBadStockChecking(false);
    }
  };

  // 이지어드민 정상재고가 등록 수량보다 적은 상품(부족분)만 입고처리 대상이다.
  const badStockShortItems = (badStockCheck?.items ?? []).filter((i) => i.status === "mismatch" && i.diff < 0);

  const normalizeBadStock = async (codes) => {
    const targets = codes.length ? badStockShortItems.filter((i) => codes.includes(i.code)) : badStockShortItems;
    if (!targets.length) {
      setBadStockMessage("정상화할 부족 상품이 없습니다.");
      return;
    }
    const totalQty = targets.reduce((s, i) => s + (-i.diff), 0);
    if (!window.confirm(`${targets.length}종, 합계 ${totalQty}개를 이지어드민에 입고처리하여 악성재고 등록 수량에 맞춥니다.\n\n진행하시겠습니까?`)) return;
    setBadStockNormalizing(true);
    setBadStockMessage("");
    try {
      const res = await fetch(`${API}/barcode/bad-stock/ezadmin-normalize`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ codes: targets.map((i) => i.code) }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "재고 정상화 실패");
      if (data.need_session) {
        setBadStockMessage("이지어드민 세션이 만료되었거나 없습니다. PHPSESSID를 다시 등록해주세요.");
        return;
      }
      if (data.check) setBadStockCheck(data.check);
      setBadStockSelected([]);
      const failed = (data.results ?? []).filter((r) => !r.ok);
      setBadStockMessage(
        failed.length
          ? `정상화 ${data.results.length - failed.length}건 완료, 실패 ${failed.length}건: ${failed.map((r) => r.code).join(", ")}`
          : `정상화 완료: ${data.results?.length ?? 0}종 입고처리`
      );
    } catch (err) {
      setBadStockMessage(err.message || "재고 정상화 실패");
    } finally {
      setBadStockNormalizing(false);
    }
  };

  const handleBadStockScan = async () => {
    const code = badStockScan.trim();
    if (!code) return;
    await addBadStock(code, "");
    setBadStockScan("");
  };

  const searchBadStock = async () => {
    const query = badStockQuery.trim();
    if (!query) {
      setBadStockRows([]);
      setBadStockMessage("검색어를 입력하세요.");
      return;
    }
    try {
      setBadStockSearching(true);
      setBadStockMessage("");
      const res = await fetch(`${API}/barcode/defect/search?q=${encodeURIComponent(query)}`, { headers: getAuthHeaders() });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "상품 검색 실패");
      setBadStockRows(data.rows || []);
      setBadStockMessage((data.rows || []).length ? `${data.rows.length}건 검색됨` : "검색 결과가 없습니다.");
    } catch (err) {
      setBadStockRows([]);
      setBadStockMessage(err.message || "상품 검색 실패");
    } finally {
      setBadStockSearching(false);
    }
  };

  const openAnomalyModal = () => {
    setShowAnomalyModal(true);
    setAnomalyMessage("");
    fetchAnomalies();
  };

  const searchAnomalyProducts = async () => {
    const query = anomalySearchQuery.trim();
    if (!query) {
      setAnomalySearchRows([]);
      setAnomalyMessage("검색어를 입력하세요.");
      return;
    }
    try {
      setAnomalySearchLoading(true);
      setAnomalyMessage("");
      const res = await fetch(`${API}/barcode/defect/search?q=${encodeURIComponent(query)}`, { headers: getAuthHeaders() });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "상품 검색 실패");
      setAnomalySearchRows(data.rows || []);
      setAnomalyMessage((data.rows || []).length ? `${data.rows.length}건 검색됨` : "검색 결과가 없습니다.");
    } catch (err) {
      setAnomalySearchRows([]);
      setAnomalyMessage(err.message || "상품 검색 실패");
    } finally {
      setAnomalySearchLoading(false);
    }
  };

  const pickAnomalyProduct = (row) => {
    const name = String(row.base_name || "");
    const option = String(row.base_color || "");
    setAnomalyForm((prev) => ({
      ...prev,
      product_name: option && !name.includes(option) ? `${name} ${option}` : name,
    }));
    setAnomalySearchRows([]);
  };

  const callAnomalyApi = async (path, body) => {
    try {
      const res = await fetch(`${API}/barcode/anomaly/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify(body),
      });
      if (handleUnauthorized(res)) return false;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "이상현상 처리 실패");
      setAnomalyList(data.items ?? []);
      return true;
    } catch (err) {
      setAnomalyMessage(err.message || "이상현상 처리 실패");
      return false;
    }
  };

  const addAnomaly = async () => {
    if (!anomalyForm.product_name.trim()) {
      setAnomalyMessage("상품을 검색해서 선택하세요.");
      return;
    }
    if (await callAnomalyApi("add", anomalyForm)) {
      setAnomalyForm({ registered_date: todayStr(), product_name: "", qty: 1, reason: "", normalized: false });
      setAnomalyMessage("이상현상을 등록했습니다.");
    }
  };

  const saveAnomalyEdit = async () => {
    if (!anomalyEdit) return;
    if (!anomalyEdit.product_name.trim()) {
      setAnomalyMessage("상품명은 필수입니다.");
      return;
    }
    const { id, registered_date, product_name, qty, reason } = anomalyEdit;
    if (await callAnomalyApi("update", { id, registered_date, product_name, qty, reason })) {
      setAnomalyEdit(null);
      setAnomalyMessage("수정했습니다.");
    }
  };

  const addDefectFromSearch = async (row) => {
    const code = row?.code || row?.base_code;
    if (!code) return;
    try {
      const res = await fetch(`${API}/barcode/defect/add`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ code }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "불량 추가 실패");
      setItems(data.items ?? items);
           setDefectList(data.defects ?? defectList);
      setDefectRecentCodes((prev) => [data.code, ...prev.filter((itemCode) => itemCode !== data.code)]);
      setDefectSearchMessage(`불량 추가 완료: ${row.base_name || data.code}`);
      pushLog(`불량 검색 추가: ${data.code} ${row.base_name || ""}`.trim());
    } catch (err) {
      setDefectSearchMessage(err.message || "불량 추가 실패");
    }
  };

  const fetchKimsungilList = async () => {
    try {
      const res = await fetch(`${API}/barcode/kimsungil/list`, { headers: getAuthHeaders() });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "김승일 목록 조회 실패");
      setKimsungilList(data.kimsungil ?? []);
    } catch { /* ignore */ }
  };

  const fetchKimsungilLog = async (code) => {
    try {
      setKimsungilLogLoading(true);
      setKimsungilLogMessage("");
      const qs = code ? `?code=${encodeURIComponent(code)}` : "";
      const res = await fetch(`${API}/barcode/kimsungil/log${qs}`, { headers: getAuthHeaders() });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "김승일 로그 조회 실패");
      setKimsungilLogRows(data.items ?? []);
      if (!(data.items ?? []).length) setKimsungilLogMessage("기록이 없습니다.");
    } catch (err) {
      setKimsungilLogRows([]);
      setKimsungilLogMessage(err.message || "김승일 로그 조회 실패");
    } finally {
      setKimsungilLogLoading(false);
    }
  };

  const openKimsungilLog = (code) => {
    setKimsungilLogCode(code);
    setShowKimsungilLog(true);
    fetchKimsungilLog(code);
  };

  const searchKimsungilByName = async () => {
    const query = kimsungilSearchQuery.trim();
    if (!query) {
      setKimsungilSearchRows([]);
      setKimsungilSearchMessage("검색어를 입력하세요.");
      return;
    }
    try {
      setKimsungilSearchLoading(true);
      setKimsungilSearchMessage("");
      const res = await fetch(`${API}/barcode/kimsungil/search?q=${encodeURIComponent(query)}`, { headers: getAuthHeaders() });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "김승일 검색 실패");
      setKimsungilSearchRows(data.rows || []);
      setKimsungilSearchMessage((data.rows || []).length ? `${data.rows.length}건 검색됨` : "검색 결과가 없습니다.");
    } catch (err) {
      setKimsungilSearchRows([]);
      setKimsungilSearchMessage(err.message || "김승일 검색 실패");
    } finally {
      setKimsungilSearchLoading(false);
    }
  };

  const addKimsungilFromSearch = async (row) => {
    const code = row?.code || row?.base_code;
    if (!code) return;
    try {
      const res = await fetch(`${API}/barcode/kimsungil/add`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ code }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "김승일 추가 실패");
      setItems(data.items ?? items);
           setKimsungilList(data.kimsungil ?? kimsungilList);
      setKimsungilSearchMessage(`김승일 추가 완료: ${row.base_name || data.code}`);
      pushLog(`김승일 검색 추가: ${data.code} ${row.base_name || ""}`.trim());
    } catch (err) {
      setKimsungilSearchMessage(err.message || "김승일 추가 실패");
    }
  };

  const handleScan = async () => {
    const raw = scanText.trim();
    const value = toEnglishKey(raw);
    if (!value) return;
    if (defectMode) { await handleDefectAdd(); return; }

    const toInvoice = !currentInvoice || isProbablyInvoice(value);
    const url = toInvoice ? `${API}/barcode/scan/invoice` : `${API}/barcode/scan/item`;
    const key = toInvoice ? "invoice" : "code";

    try {
      const res = await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ [key]: value }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "처리 실패");

      if (toInvoice) {
        if (data.ok === false && data.result === "NOT_FOUND") {
          pushLog(`송장 없음: ${value}`);
          setCurrentInvoice(null); setInvoiceDone(false); setItems([]);        } else {
          setCurrentInvoice(data.invoice); setInvoiceDone(false);
          setItems(data.items ?? []);          setDefectList(data.defects ?? defectList);
          setKimsungilList(data.kimsungil ?? kimsungilList);
          if (data.invoice_has_defect) playSound("invoiceDefect");
          if (data.post_shipment_cancelled) { playSound("postShipmentCancel"); pushLog(`⚠ 배송후취소 송장: ${data.invoice}`); }
          pushLog(`송장 SET: ${data.invoice}`);
        }
      } else {
        if (data.ok === false && data.result === "NO_INVOICE") {
          pushLog("송장이 먼저 필요합니다.");
          setCurrentInvoice(null); setInvoiceDone(false); setItems([]);        } else if (data.result === "TRUE") {
          pushLog(`TRUE  ${data.code} (잔여 ${data.remain}) ${data.name || ""} ${data.option || ""}`.trim());
          setItems(data.items ?? []); setDefectList(data.defects ?? defectList);
          setKimsungilList(data.kimsungil ?? kimsungilList);
          if (data.invoice_done) { playSound("invoiceDone"); pushLog(`송장 완료: ${data.invoice}`); setInvoiceDone(true); }
          else playSound("itemDone");
        } else {
          pushLog(`FALSE ${data.code} (잔여 ${data.remain}) ${data.name || ""} ${data.option || ""}`.trim());
          setDefectList(data.defects ?? defectList); setKimsungilList(data.kimsungil ?? kimsungilList); playSound("bad");
        }
      }
    } catch (err) { pushLog(`오류: ${err.message || ""}`.trim()); }
    finally { setScanText(""); setTimeout(() => scanRef.current?.focus(), 0); }
  };

  const renderItemLabel = (item) =>
    [item.name, item.option].filter(Boolean).join(" ").trim() || "(상품명 없음)";

  const renderDefectLabel = (item) =>
    [item.base_name || item.name, item.base_option || item.option].filter(Boolean).join(" ").trim()
    || item.code
    || "(상품명 없음)";

  const getDefectPreviewList = () => {
    const orderMap = new Map(defectRecentCodes.map((code, index) => [code, index]));
    return [...defectList].sort((a, b) => {
      const aOrder = orderMap.has(a.code) ? orderMap.get(a.code) : Number.MAX_SAFE_INTEGER;
      const bOrder = orderMap.has(b.code) ? orderMap.get(b.code) : Number.MAX_SAFE_INTEGER;
      if (aOrder !== bOrder) return aOrder - bOrder;
      return String(a.code || "").localeCompare(String(b.code || ""));
    });
  };

  const getDefectTotalCount = () =>
    defectList.reduce((sum, item) => sum + (Number(item.count) || 0), 0);

  // 불량 목록 중 "김승일 소환술"로 넘어온 항목이 있으면, 출고/오출/불량출력 등을
  // 실행하기 전에 그 항목까지 포함할지 물어본다. 소환술 항목이 없으면 물어볼 필요가
  // 없으니 그냥 포함(exclude=false)한다.
  const askExcludeKimsungil = () => {
    const summonedCount = defectList.filter((item) => (item.kimsungil_summon_qty || 0) > 0).length;
    if (summonedCount === 0) return false;
    return window.confirm(`불량 목록 중 김승일 소환술로 추가된 ${summonedCount}종은 이번 작업에서 제외할까요? (확인=제외, 취소=포함)`);
  };

  const getKimsungilTotalCount = () =>
    kimsungilList.reduce((sum, item) => sum + (Number(item.count) || 0), 0);

  const fetchDefectList = async () => {
    try {
      const res = await fetch(`${API}/barcode/defect/list`, { headers: getAuthHeaders() });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "불량 리스트 조회 실패");
      setDefectList(data.defects ?? []);
    } catch { /* ignore */ }
  };

  const handleDefectDec = async (code) => {
    try {
      const res = await fetch(`${API}/barcode/defect/dec`, {
        method: "POST", headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ code }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "불량 감소 실패");
      setDefectList(data.defects ?? []); setItems(data.items ?? items);    } catch (err) { pushLog(`불량 감소 실패: ${err.message || ""}`.trim()); }
  };

  const handleDefectRemove = async (code) => {
    try {
      const res = await fetch(`${API}/barcode/defect/remove`, {
        method: "POST", headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ code }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "불량 삭제 실패");
      setDefectList(data.defects ?? []); setItems(data.items ?? items);    } catch (err) { pushLog(`불량 삭제 실패: ${err.message || ""}`.trim()); }
  };

  const handleKimsungilDec = async (code) => {
    try {
      const res = await fetch(`${API}/barcode/kimsungil/dec`, {
        method: "POST", headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ code }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "김승일 감소 실패");
      setKimsungilList(data.kimsungil ?? []); setItems(data.items ?? items);    } catch (err) { pushLog(`김승일 감소 실패: ${err.message || ""}`.trim()); }
  };

  const handleKimsungilRemove = async (code) => {
    try {
      const res = await fetch(`${API}/barcode/kimsungil/remove`, {
        method: "POST", headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ code }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "김승일 삭제 실패");
      setKimsungilList(data.kimsungil ?? []); setItems(data.items ?? items);    } catch (err) { pushLog(`김승일 삭제 실패: ${err.message || ""}`.trim()); }
  };

  const handleKimsungilSummon = async () => {
    const summonable = kimsungilList.filter((i) => (i.incoming_qty || 0) > 0);
    if (summonable.length === 0) { alert("입고된(배지가 뜬) 김승일 상품이 없습니다."); return; }
    if (!window.confirm(`김승일 ${summonable.length}종을 불량 목록으로 소환하겠습니까?`)) return;
    try {
      setKimsungilSummonLoading(true);
      const res = await fetch(`${API}/barcode/kimsungil/summon-to-defect`, {
        method: "POST", headers: getAuthHeaders(),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "김승일 소환술 실패");
      setDefectList(data.defects ?? defectList);
      setKimsungilList(data.kimsungil ?? kimsungilList);
      pushLog(`김승일 소환술: ${data.moved_count}종 ${data.moved_total}개 불량 이동`);
    } catch (err) {
      alert(err.message || "김승일 소환술 실패");
      pushLog(`김승일 소환술 실패: ${err.message || ""}`.trim());
    } finally {
      setKimsungilSummonLoading(false);
    }
  };

  const handleDefectExport = async () => {
    if (defectList.length === 0) { alert("내보낼 불량 목록이 없습니다."); return; }
    try {
      const res = await fetch(`${API}/barcode/defect/export`, { headers: getAuthHeaders() });
      if (handleUnauthorized(res)) return;
      if (!res.ok) {
        let message = "불량 목록 내보내기 실패";
        try { const data = await res.json(); message = data?.detail || message; }
        catch { const text = await res.text(); if (text) message = text; }
        throw new Error(message);
      }
      const blob = await res.blob();
      const fallback = `defects_${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "")}.csv`;
      const filename = getDownloadFilename(res, fallback);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url; link.download = filename;
      document.body.appendChild(link); link.click(); link.remove();
      URL.revokeObjectURL(url);
      pushLog(`불량 목록 내보내기 완료: ${filename}`);
    } catch (err) {
      alert(err.message || "불량 목록 내보내기 실패");
      pushLog(`불량 목록 내보내기 실패: ${err.message || ""}`.trim());
    }
  };

  const fetchDefectBase = useCallback(async () => {
    try {
      setDefectBaseLoading(true);
      setDefectBaseMessage("");
      const res = await fetch(`${API}/barcode/defect/base`, { headers: getAuthHeaders() });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "불량베이스 불러오기 실패");
      setDefectBaseHeaders(data.headers ?? ["상품코드", "상품명", "공급처", "공급처상품명", "색상 사이즈", "주소", "표시형 상품명"]);
      setDefectBaseRows(data.rows ?? []);
      setDefectBasePath(data.path ?? "");
      setDefectBaseMessage(`불량베이스 ${data.rows?.length ?? 0}건 로드 완료`);
    } catch (err) {
      setDefectBaseMessage(err.message || "불량베이스 불러오기 실패");
    } finally {
      setDefectBaseLoading(false);
    }
  }, []);

  const updateDefectBaseCell = (rowIndex, colIndex, value) => {
    setDefectBaseRows((prev) =>
      prev.map((row, idx) => {
        if (idx !== rowIndex) return row;
        const nextValues = Array.isArray(row.values) ? [...row.values] : ["", "", "", "", "", "", ""];
        while (nextValues.length < 7) nextValues.push("");
        nextValues[colIndex] = value;
        return { ...row, values: nextValues };
      })
    );
  };

  const addDefectBaseRow = () => {
    setDefectBaseRows((prev) => [...prev, { row_index: null, values: ["", "", "", "", "", "", ""] }]);
    setDefectBaseMessage("새 행을 추가했습니다.");
  };

  const removeDefectBaseRow = (rowIndex) => {
    setDefectBaseRows((prev) => prev.filter((_, idx) => idx !== rowIndex));
  };

  const saveDefectBase = async () => {
    try {
      setDefectBaseSaving(true);
      setDefectBaseMessage("");
      const res = await fetch(`${API}/barcode/defect/base`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({
          rows: defectBaseRows.map((row) => ({
            values: Array.isArray(row.values) ? row.values.slice(0, 7) : ["", "", "", "", "", "", ""],
          })),
        }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "불량베이스 저장 실패");
      setDefectBaseHeaders(data.headers ?? defectBaseHeaders);
      setDefectBaseRows(data.rows ?? []);
      setDefectBasePath(data.path ?? defectBasePath);
      setDefectBaseMessage(`불량베이스 저장 완료 (${data.rows?.length ?? 0}건)`);
    } catch (err) {
      setDefectBaseMessage(err.message || "불량베이스 저장 실패");
    } finally {
      setDefectBaseSaving(false);
    }
  };

  const handleOrdersXlsDownload = async () => {
    try {
      const res = await fetch(`${API}/barcode/orders/export-xls`, { headers: getAuthHeaders() });
      if (handleUnauthorized(res)) return;
      if (!res.ok) {
        let message = "주문 목록 다운로드 실패";
        try { const data = await res.json(); message = data?.detail || message; }
        catch { const text = await res.text(); if (text) message = text; }
        throw new Error(message);
      }
      const blob = await res.blob();
      const fallback = `extended_orders_${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "")}.xls`;
      const filename = getDownloadFilename(res, fallback);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      pushLog(`확장주문검색 목록 다운로드 완료: ${filename}`);
    } catch (err) {
      alert(err.message || "주문 목록 다운로드 실패");
      pushLog(`확장주문검색 목록 다운로드 실패: ${err.message || ""}`.trim());
    }
  };

  const handleDefectPrint = async () => {
    if (defectList.length === 0) {
      alert("보낼 불량 목록이 없습니다.");
      return;
    }
    const excludeKimsungil = askExcludeKimsungil();
    try {
      const sourceList = excludeKimsungil
        ? defectList.filter((item) => !(item.kimsungil_summon_qty > 0))
        : defectList;
      const rows = sourceList
        .map((item) => {
          // 상품명 앞 접두어(첫 단어)를 괄호로 묶어 거래처상품명 앞에 붙인다. 예: (휘민)코에셔츠
          const product = String(item.base_product || "").trim();
          const prefix = String(item.base_name || "").trim().split(/\s+/)[0] || "";
          return { item, product, prefix };
        })
        .map(({ item, product, prefix }) => ({
          vendor: String(item.base_vendor || "").trim(),
          name: product && prefix ? `(${prefix})${product}` : product,
          color: String(item.base_color || "").trim(),
          qty: Number(item.count || 0),
          addr: String(item.base_addr || "").trim(),
        }))
        .filter((row) => row.vendor || row.addr || row.name);

      if (!rows.length) {
        throw new Error("불량출력으로 보낼 유효한 데이터가 없습니다.");
      }

      const res = await fetch(`${API}/noye-kimsungil/bulyang/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ rows }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "불량출력 전송 실패");

      localStorage.setItem("activeTab", "noye-kimsungil");
      localStorage.setItem(
        "noye-kimsungil-bulyang-handoff",
        JSON.stringify({
          session_id: data.session_id,
          groups: data.groups || [],
          total: data.total || 0,
          created_at: Date.now(),
        })
      );
      window.location.reload();
    } catch (err) {
      alert(err.message || "불량출력 전송 실패");
      pushLog(`불량출력 전송 실패: ${err.message || ""}`.trim());
    }
  };

  const handleDefectPurchaseManager = async () => {
    if (defectList.length === 0) {
      alert("보낼 불량 목록이 없습니다.");
      return;
    }
    const excludeKimsungil = askExcludeKimsungil();
    try {
      const res = await fetch(`${API}/barcode/defect/purchase-manager-handoff`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ exclude_kimsungil_summon: excludeKimsungil }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "매입관리 데이터 변환에 실패했습니다.");
      if (!(data.rows || []).length) {
        throw new Error(`원가베이스유에서 일치하는 상품코드를 찾지 못했습니다.${data.unmatched_codes?.length ? ` (${data.unmatched_codes.join(", ")})` : ""}`);
      }

      localStorage.setItem("activeTab", "noye-kimsungil");
      localStorage.setItem("noye-kimsungil-active-tab", "purchase");
      localStorage.setItem(
        "noye-kimsungil-purchase-handoff",
        JSON.stringify({
          rows: data.rows,
          unmatched_codes: data.unmatched_codes || [],
          created_at: Date.now(),
        })
      );
      window.location.reload();
    } catch (err) {
      alert(err.message || "매입관리 전송에 실패했습니다.");
      pushLog(`매입관리 전송 실패: ${err.message || ""}`.trim());
    }
  };

  const handleDefectExportAndOchuul = async (excludeKimsungilOverride) => {
    if (defectList.length === 0) { alert("불량 목록이 없습니다."); return; }
    const total = getDefectTotalCount();
    if (!window.confirm(`불량 목록 ${defectList.length}종 합계 ${total}개를 출고처리 후 오출 차감하겠습니까?`)) return;
    const excludeKimsungil = excludeKimsungilOverride ?? askExcludeKimsungil();

    try {
      setDefectEzadminLoading(true); setDefectEzadminMsg("EZAdmin 출고처리 중...");
      const res = await fetch(`${API}/barcode/defect/export-to-ezadmin`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ exclude_kimsungil_summon: excludeKimsungil }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (data?.need_session) {
        setDefectEzadminMsg("");
        openEzadminModal(() => handleDefectExportAndOchuul(excludeKimsungil));
        return;
      }
      if (!data?.ok) {
        setDefectEzadminMsg(data?.error || "출고처리 실패");
        return;
      }
      setDefectEzadminMsg(`출고처리 완료 (${data.count ?? 0}건)`);
    } catch (err) {
      setDefectEzadminMsg(`출고처리 실패: ${err.message || ""}`);
      return;
    } finally {
      setDefectEzadminLoading(false);
    }

    try {
      setOchuulLoading(true);
      setOchuulResult(null);
      const res = await fetch(`${API}/barcode/defect/ochuul-minus`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ exclude_kimsungil_summon: excludeKimsungil }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "오출내리기 실패");
      setOchuulResult(data);
      pushLog(`오출내리기 완료: ${data.matched}건 차감`);
    } catch (err) {
      alert(err.message || "오출내리기 실패");
      pushLog(`오출내리기 실패: ${err.message || ""}`.trim());
    } finally {
      setOchuulLoading(false);
    }
  };

  const invoicePostJson = async (url, body) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...getAuthHeaders() },
      body: JSON.stringify(body),
    });
    if (handleUnauthorized(res)) throw Object.assign(new Error("인증 만료"), { silent: true });
    const data = await res.json().catch(() => ({}));
    if (data?.need_session) throw Object.assign(new Error("이지어드민 세션 필요"), { needSession: true });
    if (!res.ok || data?.ok === false) throw new Error(data?.detail || "요청 실패");
    return data;
  };

  const fetchInvoicePreview = async (invoiceNo) => {
    const data = await invoicePostJson(`${API}/barcode/invoice/preview`, { invoice_no: invoiceNo });
    if (!data.ezadmin_found || !data.pack) throw new Error("이지어드민 주문을 찾지 못했습니다.");
    if (!data.ably_found || !(data.products || []).length) throw new Error("에이블리 주문상품 정보를 찾지 못했습니다.");
    return data;
  };

  // 조회(preview) 이후: 거래취소·송장삭제 → (선택) 재고출고 → 에이블리 롤백
  const runInvoicePipeline = async (preview, includeStockOut, stockOutMemo, onStep) => {
    onStep?.(0, "running");
    await invoicePostJson(`${API}/barcode/invoice/cancel`, { pack: preview.pack });
    onStep?.(0, "done");

    let idx = 1;
    if (includeStockOut) {
      onStep?.(idx, "running");
      const stockData = await invoicePostJson(`${API}/barcode/invoice/stock-out`, {
        products: preview.products,
        memo: stockOutMemo,
      });
      const stockOk = stockData.results?.every((r) => r.ok) ?? true;
      onStep?.(idx, stockOk ? "done" : "error", stockOk ? undefined : "일부 상품 출고 실패");
      if (!stockOk) throw new Error("일부 상품 재고 출고처리에 실패했습니다.");
      idx += 1;
    }

    onStep?.(idx, "running");
    await invoicePostJson(`${API}/barcode/invoice/rollback`, { sno_list: preview.sno_list });
    onStep?.(idx, "done");
  };

  const openInvoiceDeleteModal = () => {
    setInvoiceBulkMode(false);
    setInvoiceStockOutEnabled(true);
    setInvoiceStockOutMemo("");
    setInvoiceNoInput("");
    setInvoicePreview(null);
    setInvoicePreviewError("");
    setInvoiceSteps([]);
    setInvoiceExecuting(false);
    setInvoiceBulkInput("");
    setInvoiceBulkResults([]);
    setInvoiceBulkRunning(false);
    setShowInvoiceModal(true);
  };

  const handleInvoicePreview = async () => {
    const invoiceNo = invoiceNoInput.trim();
    if (!invoiceNo) { setInvoicePreviewError("송장번호를 입력하세요."); return; }
    setInvoicePreviewLoading(true);
    setInvoicePreviewError("");
    setInvoicePreview(null);
    setInvoiceSteps([]);
    try {
      const res = await fetch(`${API}/barcode/invoice/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ invoice_no: invoiceNo }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (data?.need_session) { openEzadminModal(handleInvoicePreview); return; }
      if (!res.ok || !data.ok) throw new Error(data?.detail || "조회 실패");
      setInvoicePreview(data);
    } catch (err) {
      setInvoicePreviewError(err.message || "조회 실패");
    } finally {
      setInvoicePreviewLoading(false);
    }
  };

  const handleInvoiceExecute = async () => {
    if (!invoicePreview) return;
    if (!window.confirm(
      `송장번호 ${invoicePreview.invoice_no}를 삭제${invoiceStockOutEnabled ? "하고 재고를 출고처리" : ""}한 뒤 발송상태를 되돌리겠습니까?`
    )) return;

    setInvoiceExecuting(true);
    const labels = getInvoiceStepLabels(invoiceStockOutEnabled);
    setInvoiceSteps(labels.map((label) => ({ label, status: "pending" })));

    const setStepStatus = (idx, status, detail) => {
      setInvoiceSteps((prev) => prev.map((s, i) => (i === idx ? { ...s, status, detail } : s)));
    };

    let failedIdx = -1;
    try {
      await runInvoicePipeline(invoicePreview, invoiceStockOutEnabled, invoiceStockOutMemo, (idx, status, detail) => {
        failedIdx = idx;
        setStepStatus(idx, status, detail);
      });
      pushLog(`송장삭제 완료: ${invoicePreview.invoice_no}`);
    } catch (err) {
      if (err.needSession) {
        openEzadminModal(handleInvoiceExecute);
      } else if (!err.silent) {
        alert(err.message || "송장삭제 처리 중 오류가 발생했습니다.");
        pushLog(`송장삭제 실패 (${invoicePreview.invoice_no}): ${err.message || ""}`.trim());
      }
      if (failedIdx >= 0) setStepStatus(failedIdx, "error", err.message);
    } finally {
      setInvoiceExecuting(false);
    }
  };

  const parseBulkInvoiceNos = (text) => {
    const seen = new Set();
    return String(text || "")
      .split(/[\s,]+/)
      .map((v) => v.trim())
      .filter((v) => v && !seen.has(v) && seen.add(v));
  };

  const handleInvoiceBulkExecute = async () => {
    const invoiceNos = parseBulkInvoiceNos(invoiceBulkInput);
    if (!invoiceNos.length) { setInvoicePreviewError("송장번호를 한 줄에 하나씩(또는 쉼표로 구분) 입력하세요."); return; }
    if (!window.confirm(
      `송장번호 ${invoiceNos.length}건을 일괄 삭제${invoiceStockOutEnabled ? "(재고 출고처리 포함)" : "(재고 출고처리 제외)"}하시겠습니까?`
    )) return;

    setInvoicePreviewError("");
    setInvoiceBulkRunning(true);
    const labels = getInvoiceStepLabels(invoiceStockOutEnabled);
    const localResults = invoiceNos.map((no) => ({
      invoice_no: no,
      status: "pending",
      steps: labels.map((label) => ({ label, status: "pending" })),
    }));
    setInvoiceBulkResults(localResults);

    const setResult = (invoiceNo, status, detail) => {
      const target = localResults.find((r) => r.invoice_no === invoiceNo);
      if (target) { target.status = status; target.detail = detail; }
      setInvoiceBulkResults([...localResults]);
    };

    const setStepResult = (invoiceNo, idx, status, detail) => {
      const target = localResults.find((r) => r.invoice_no === invoiceNo);
      if (target?.steps?.[idx]) { target.steps[idx] = { ...target.steps[idx], status, detail }; }
      setInvoiceBulkResults([...localResults]);
    };

    for (const invoiceNo of invoiceNos) {
      setResult(invoiceNo, "running");
      try {
        const preview = await fetchInvoicePreview(invoiceNo);
        await runInvoicePipeline(preview, invoiceStockOutEnabled, invoiceStockOutMemo, (idx, status, detail) => {
          setStepResult(invoiceNo, idx, status, detail);
        });
        setResult(invoiceNo, "done");
      } catch (err) {
        if (err.needSession) {
          setResult(invoiceNo, "error", "이지어드민 세션 필요");
          openEzadminModal(null);
          break;
        }
        setResult(invoiceNo, "error", err.message);
      }
    }

    const doneCount = localResults.filter((r) => r.status === "done").length;
    pushLog(`송장 일괄삭제 완료: ${doneCount}/${invoiceNos.length}건 성공`);
    setInvoiceBulkRunning(false);
  };

  const defectBaseRowsToShow = defectBaseRows
    .filter((row) => {
      const query = defectBaseQuery.trim().toLowerCase();
      if (!query) return true;
      return (row.values ?? []).some((value) => String(value || "").toLowerCase().includes(query));
    })
    .slice(0, 300);

  const playSound = (key) => {
    const audio = soundsRef.current?.[key];
    if (!audio) return;
    audio.currentTime = 0; audio.play().catch(() => {});
  };

  return (
    <div className={styles.page}>
      {/* 헤더 */}
      <div className={styles.pageHeader}>
        <div>
          <h2 className={styles.title}>{title}</h2>
          <p className={styles.subtitle}>송장 업로드 후 바코드 스캔 · F2 불량 모드 전환</p>
        </div>
        {headerExtra}
      </div>

      <div className={styles.stack}>
        {/* 파일 업로드 - 2열 그리드 */}
        <div className={styles.dualGrid}>
          {/* 송장 파일 */}
          <section className={`${styles.card} ${styles.dualCard}`}>
            <div className={styles.cardHeader}>
              <h3 className={styles.cardTitle}>확장주문검색</h3>
              {(loadingUpload || ezadminOrdersLoading) && <span className={styles.pill}>불러오는 중</span>}
              {count !== null && !loadingUpload && !ezadminOrdersLoading && (
                <span className={styles.pill}>송장 {count} · 코드 {codesTotal}</span>
              )}
            </div>
            <div className={styles.uploadRow}>
              <label className={styles.fileInput} style={{ flex: 1, justifyContent: 'flex-start' }}>
                <input type="file" accept=".xls,.xlsx" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setUploadMsg(""); setEzadminOrdersMsg(""); setEzadminOrdersTiming(null); }} />
                {file ? file.name : "파일 선택"}
              </label>
              <button className={styles.primaryBtn} onClick={handleUpload} disabled={loadingUpload || ezadminOrdersLoading || !file}>
                업로드
              </button>
            </div>
            <div className={styles.uploadRow}>
              <input
                type="date"
                className={styles.dateInput}
                value={ezadminOrdersDate}
                onChange={(e) => setEzadminOrdersDate(e.target.value)}
                disabled={loadingUpload || ezadminOrdersLoading}
              />
              <button className={styles.secondaryBtn} style={{ flex: 1 }} onClick={handleUploadFromEzadminOrders} disabled={loadingUpload || ezadminOrdersLoading}>
                {ezadminOrdersLoading ? "EZAdmin 불러오는 중..." : "EZAdmin에서 불러오기"}
              </button>
              <button className={styles.secondaryBtn} onClick={handleOrdersXlsDownload} disabled={loadingUpload || ezadminOrdersLoading || count === null}>
                다운로드
              </button>
            </div>
            {ezadminOrdersMsg && (
              <div className={styles.statusMsg}
                style={{ borderColor: ezadminOrdersMsg.includes("실패") ? "rgba(220,53,69,0.4)" : "rgba(59,130,246,0.4)", backgroundColor: ezadminOrdersMsg.includes("실패") ? "rgba(220,53,69,0.07)" : "rgba(59,130,246,0.07)" }}>
                <strong>{ezadminOrdersMsg}</strong>
              </div>
            )}
            {uploadMsg && (
              <div className={styles.statusMsg}
                style={{ borderColor: uploadMsg.includes("실패") ? "rgba(220,53,69,0.4)" : "rgba(34,197,94,0.4)", backgroundColor: uploadMsg.includes("실패") ? "rgba(220,53,69,0.07)" : "rgba(34,197,94,0.07)" }}>
                <strong>{uploadMsg}</strong>
              </div>
            )}
          </section>

          {/* 입고 파일 */}
          <section className={`${styles.card} ${styles.dualCard}`}>
            <div className={styles.cardHeader}>
              <h3 className={styles.cardTitle}>입고 파일</h3>
              {(loadingIncoming || ezadminLoading) && <span className={styles.pill}>불러오는 중</span>}
              {incomingCodes !== null && !loadingIncoming && !ezadminLoading && (
                <span className={styles.pill}>코드 {incomingCodes} · 수량 {incomingTotal}</span>
              )}
            </div>
            <div className={styles.uploadRow}>
              <label className={styles.fileInput} style={{ flex: 1, justifyContent: 'flex-start' }}>
                <input type="file" accept=".xls,.xlsx" onChange={(e) => { setIncomingFile(e.target.files?.[0] ?? null); setIncomingMsg(""); }} />
                {incomingFile ? incomingFile.name : "파일 선택"}
              </label>
              <button className={styles.primaryBtn} onClick={handleIncomingUpload} disabled={loadingIncoming || ezadminLoading || !incomingFile}>
                업로드
              </button>
            </div>
            <div className={styles.uploadRow}>
              <input
                type="date"
                className={styles.dateInput}
                value={incomingEzDate}
                onChange={(e) => setIncomingEzDate(e.target.value)}
                disabled={loadingIncoming || ezadminLoading || incomingVoucherLoading}
              />
              <button
                className={styles.secondaryBtn}
                style={{ flex: 1 }}
                onClick={handleOpenIncomingVoucherPicker}
                disabled={loadingIncoming || ezadminLoading || incomingVoucherLoading}
              >
                {ezadminLoading ? "EZAdmin 불러오는 중..." : incomingVoucherLoading ? "전표 조회 중..." : "EZAdmin에서 불러오기"}
              </button>
            </div>
            {ezadminMsg && (
              <div className={styles.statusMsg}
                style={{ borderColor: "rgba(59,130,246,0.4)", backgroundColor: "rgba(59,130,246,0.07)" }}>
                <strong>{ezadminMsg}</strong>
              </div>
            )}
            {incomingMsg && (
              <div className={styles.statusMsg}
                style={{ borderColor: incomingMsg.includes("실패") ? "rgba(220,53,69,0.4)" : "rgba(34,197,94,0.4)", backgroundColor: incomingMsg.includes("실패") ? "rgba(220,53,69,0.07)" : "rgba(34,197,94,0.07)" }}>
                <strong>{incomingMsg}</strong>
              </div>
            )}
          </section>
        </div>

        {/* 스캔 - 전체 폭 */}
        <section className={styles.card}
          style={defectMode ? { borderColor: "rgba(220,53,69,0.5)", boxShadow: "0 0 0 2px rgba(220,53,69,0.15)" } : {}}>
          <div className={styles.cardHeader}>
            <h3 className={styles.cardTitle}>스캔</h3>
            <div className={styles.headerActions}>
              <button className={styles.secondaryBtn} onClick={refreshStatus} title="새로고침">↺</button>
              <button className={styles.secondaryBtn} onClick={openInvoiceDeleteModal}>송장삭제</button>
              <button
                className={`${styles.toggleBtn} ${defectMode ? styles.toggleOn : ""}`}
                onClick={() => setDefectMode((v) => !v)}
                style={defectMode ? { background: "rgba(220,53,69,0.9)", borderColor: "rgba(220,53,69,0.9)" } : {}}
              >
                {defectMode ? "🚨 불량 모드" : "불량 모드"}
              </button>
              <button className={styles.secondaryBtn} onClick={() => { setShowDefectList(true); fetchDefectList(); fetchKimsungilList(); }}>
                불량 목록
                {defectList.length > 0 && (
                  <span className={styles.inlineTagDanger} style={{ marginLeft: "0.35rem" }}>{defectList.length}</span>
                )}
              </button>
              <button className={styles.secondaryBtn} onClick={() => { setShowKimsungilList(true); fetchKimsungilList(); }}>
                김승일
                {kimsungilList.filter(i => (i.incoming_qty || 0) > 0).length > 0 && (
                  <span className={styles.inlineTagIncoming} style={{ marginLeft: "0.35rem" }}>{kimsungilList.filter(i => (i.incoming_qty || 0) > 0).length}</span>
                )}
              </button>
              <button className={styles.secondaryBtn} onClick={openAnomalyModal}>
                이상현상
              </button>
              <button className={styles.secondaryBtn} onClick={openBadStockModal}>
                악성재고
              </button>
            </div>
          </div>

          <div style={{ display: "flex", gap: "0.75rem", alignItems: "stretch" }}>
            <input
              ref={scanRef}
              value={scanText}
              onChange={(e) => {
                if (e.nativeEvent?.isComposing) { setScanText(e.target.value); return; }
                setScanText(toEnglishKey(e.target.value));
              }}
              onCompositionEnd={(e) => setScanText(toEnglishKey(e.currentTarget.value))}
              onKeyDown={(e) => { if (e.key === "Enter") handleScan(); }}
              placeholder={defectMode ? "불량 바코드 스캔 후 Enter" : "송장 또는 상품 바코드 스캔 후 Enter"}
              className={styles.scanInput}
              style={defectMode ? { borderColor: "rgba(220,53,69,0.6)", background: "rgba(220,53,69,0.04)" } : {}}
            />
            <button className={`${styles.primaryBtn} ${styles.scanBtn}`} onClick={handleScan}
              style={defectMode ? { background: "rgba(220,53,69,0.9)" } : {}}>
              {defectMode ? "불량 추가" : "스캔 처리"}
            </button>
          </div>

        </section>

        {/* 프리뷰 - 전체 폭, 2열 내부 */}
        <section className={styles.card} style={{ background: "var(--bg-secondary)" }}>
          <div className={styles.cardHeader}>
            <h3 className={styles.cardTitle}>프리뷰</h3>
            {currentInvoice && (
              <span className={styles.pill} style={invoiceDone ? { background: "rgba(34,197,94,0.15)", color: "#15803d", border: "1px solid rgba(34,197,94,0.3)" } : {}}>
                {invoiceDone ? "✓ 완료됨" : `송장 ${currentInvoice}`}
              </span>
            )}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            {defectMode && (
              <div style={{
                borderRadius: "var(--radius-md)",
                border: "1px solid rgba(220,53,69,0.35)",
                background: "rgba(220,53,69,0.06)",
                padding: "1rem 1.25rem",
                display: "flex",
                flexDirection: "column",
                gap: "0.6rem",
              }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: "0.45rem", flexWrap: "wrap" }}>
                  <span className={styles.infoLabel}>불량 등록 카드</span>
                  <span className={styles.inlineTagDanger}>합계 {getDefectTotalCount()}</span>
                </span>
                {defectList.length > 0 ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: "0.55rem" }}>
                    {getDefectPreviewList().map((item, idx) => (
                      <span
                        key={`${item.code}-preview-defect-${idx}`}
                        style={{ display: "inline-flex", alignItems: "center", gap: "0.45rem", flexWrap: "wrap" }}
                      >
                        <span style={{ fontWeight: 800, fontSize: "1.05rem", overflowWrap: "anywhere" }}>
                          {renderDefectLabel(item)}
                        </span>
                        <span className={styles.inlineTagDanger}>불량 {item.count}</span>
                        {item.kimsungil_summon_qty > 0 && (
                          <span className={styles.inlineTagIncoming}>김승일 소환 {item.kimsungil_summon_qty}</span>
                        )}
                        {item.code && <span className={styles.inlineMeta}>{item.code}</span>}
                      </span>
                    ))}
                  </div>
                ) : (
                  <span style={{ color: "var(--text-muted)", fontSize: "0.95rem" }}>등록된 불량이 없습니다.</span>
                )}
              </div>
            )}

            {/* 현재 상품 */}
            <div style={{
              borderRadius: "var(--radius-md)",
              border: "1px solid var(--border-color)",
              background: "var(--bg-primary)",
              padding: "1.25rem 1.5rem",
              display: "flex",
              flexDirection: "column",
              gap: "0.75rem",
            }}>
              <span className={styles.infoLabel}>현재 상품</span>
              {items.length > 0 ? (
                <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
                  {items.map((item, idx) => (
                    <div key={`${item.code}-${idx}`}
                      style={{
                        paddingBottom: idx < items.length - 1 ? "0.75rem" : 0,
                        borderBottom: idx < items.length - 1 ? "1px dashed var(--border-color)" : "none",
                        opacity: item.remain === 0 ? 0.4 : 1,
                      }}>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem", flexWrap: "wrap" }}>
                        <span style={{ fontWeight: 700, fontSize: "1.2rem", overflowWrap: "anywhere" }}>
                          {renderItemLabel(item)}
                        </span>
                        {item.run_len > 1 && <span className={styles.inlineTagRun}>연속 {item.run_len}</span>}
                        {item.incoming > 0 && <span className={styles.inlineTagIncoming}>입고 {item.incoming}</span>}
                        {item.stock > 0 && <span className={styles.inlineTagStock}>재고 {item.stock}</span>}
                        {item.remain >= 2 && <span className={styles.inlineMeta}>잔여 {item.remain}</span>}
                        {item.defect > 0 && <span className={styles.inlineTagDanger}>불량 {item.defect}</span>}
                        {item.remain === 0 && <span className={styles.doneBadge}>완료</span>}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <span style={{ color: "var(--text-muted)", fontSize: "1rem" }}>
                  {currentInvoice ? "상품 없음" : "송장을 먼저 스캔하세요"}
                </span>
              )}
            </div>

          </div>
        </section>

      </div>



      {/* 불량 리스트 모달 */}
      {showInvoiceModal && (
        <div className={styles.modalOverlay} onClick={() => { if (!invoiceExecuting && !invoiceBulkRunning) setShowInvoiceModal(false); }}>
          <div className={styles.modal} style={{ width: "min(520px, 96vw)" }} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <h4 className={styles.modalTitle}>송장삭제</h4>
              <div className={styles.modalActions}>
                <button className={styles.secondaryBtn} onClick={() => setShowInvoiceModal(false)} disabled={invoiceExecuting || invoiceBulkRunning}>닫기</button>
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: "1rem", marginBottom: "0.6rem", fontSize: "0.85rem" }}>
              <label style={{ display: "flex", alignItems: "center", gap: "0.3rem", cursor: "pointer" }}>
                <input
                  type="radio"
                  checked={!invoiceBulkMode}
                  onChange={() => setInvoiceBulkMode(false)}
                  disabled={invoiceExecuting || invoiceBulkRunning}
                />
                단일
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: "0.3rem", cursor: "pointer" }}>
                <input
                  type="radio"
                  checked={invoiceBulkMode}
                  onChange={() => setInvoiceBulkMode(true)}
                  disabled={invoiceExecuting || invoiceBulkRunning}
                />
                일괄삭제
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: "0.3rem", cursor: "pointer", marginLeft: "auto" }}>
                <input
                  type="checkbox"
                  checked={invoiceStockOutEnabled}
                  onChange={(e) => setInvoiceStockOutEnabled(e.target.checked)}
                  disabled={invoiceExecuting || invoiceBulkRunning}
                />
                재고 출고처리 포함
              </label>
            </div>

            {invoiceStockOutEnabled && (
              <input
                value={invoiceStockOutMemo}
                onChange={(e) => setInvoiceStockOutMemo(e.target.value)}
                placeholder="재고 출고 메모 (선택)"
                className={styles.searchInput}
                disabled={invoiceExecuting || invoiceBulkRunning}
                style={{ width: "100%", marginBottom: "0.6rem", boxSizing: "border-box" }}
              />
            )}
            {ezadminOrdersTiming && (
              <div className={styles.statusMsg} style={{ borderColor: "rgba(100,116,139,0.3)", backgroundColor: "rgba(100,116,139,0.06)", fontSize: "0.8rem" }}>
                {ezadminOrdersTiming.fallback
                  ? `전체 요청 ${(ezadminOrdersTiming.total_ms / 1000).toFixed(2)}초 (서버 세부 측정값 없음)`
                  : `요청 응답 ${(ezadminOrdersTiming.api_ms / 1000).toFixed(2)}초 · 내부 가공 ${(ezadminOrdersTiming.processing_ms / 1000).toFixed(2)}초 · 총 ${(ezadminOrdersTiming.total_ms / 1000).toFixed(2)}초`}
              </div>
            )}

            {!invoiceBulkMode ? (
              <>
                <div className={styles.uploadRow}>
                  <input
                    value={invoiceNoInput}
                    onChange={(e) => setInvoiceNoInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") handleInvoicePreview(); }}
                    placeholder="송장번호 입력"
                    className={styles.searchInput}
                    disabled={invoicePreviewLoading || invoiceExecuting}
                  />
                  <button className={styles.primaryBtn} onClick={handleInvoicePreview} disabled={invoicePreviewLoading || invoiceExecuting}>
                    {invoicePreviewLoading ? "조회 중..." : "조회"}
                  </button>
                </div>

                {invoicePreviewError && (
                  <div className={styles.statusMsg} style={{ color: "#dc3545" }}>{invoicePreviewError}</div>
                )}

                {invoicePreview && (
                  <div style={{ marginTop: "0.75rem", fontSize: "0.85rem" }}>
                    <div style={{ marginBottom: "0.5rem" }}>송장번호 : <strong>{invoicePreview.invoice_no}</strong></div>
                    <div>{invoicePreview.ably_found ? "✔" : "✘"} 에이블리 주문 발견</div>
                    <div>{invoicePreview.ezadmin_found ? "✔" : "✘"} 이지어드민 주문 발견</div>

                    <div style={{ marginTop: "0.75rem", fontWeight: 600 }}>상품</div>
                    {(invoicePreview.products || []).length === 0 ? (
                      <div style={{ color: "#888" }}>상품 정보를 찾지 못했습니다.</div>
                    ) : (
                      invoicePreview.products.map((p) => (
                        <div key={p.product_id} style={{ padding: "0.35rem 0", borderBottom: "1px solid rgba(0,0,0,0.08)" }}>
                          <div>- {p.product_id}{p.name ? ` (${p.name})` : ""}</div>
                          <div style={{ color: "#666" }}>
                            {[p.color, p.size].filter(Boolean).join(" / ") || "옵션 정보 없음"} · 수량 {p.qty}
                          </div>
                        </div>
                      ))
                    )}

                    {invoiceSteps.length > 0 && (
                      <div style={{ marginTop: "0.75rem" }}>
                        <div style={{ fontWeight: 600, marginBottom: "0.25rem" }}>진행 상태</div>
                        {invoiceSteps.map((s) => (
                          <div key={s.label} style={{ display: "flex", alignItems: "center", gap: "0.35rem", padding: "0.15rem 0" }}>
                            <span>
                              {s.status === "done" ? "✔" : s.status === "error" ? "✘" : s.status === "running" ? "⏳" : "▫"}
                            </span>
                            <span>{s.label}</span>
                            {s.status === "error" && s.detail && (
                              <span style={{ color: "#dc3545", fontSize: "0.78rem" }}>({s.detail})</span>
                            )}
                          </div>
                        ))}
                      </div>
                    )}

                    <div className={styles.modalActions} style={{ marginTop: "1rem" }}>
                      <button className={styles.secondaryBtn} onClick={() => setShowInvoiceModal(false)} disabled={invoiceExecuting}>
                        취소
                      </button>
                      <button
                        className={styles.primaryBtn}
                        onClick={handleInvoiceExecute}
                        disabled={invoiceExecuting || !invoicePreview.ably_found || !(invoicePreview.products || []).length}
                      >
                        {invoiceExecuting ? "처리 중..." : "실행"}
                      </button>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <>
                <textarea
                  value={invoiceBulkInput}
                  onChange={(e) => setInvoiceBulkInput(e.target.value)}
                  placeholder={"송장번호를 한 줄에 하나씩(또는 쉼표로 구분) 입력"}
                  rows={6}
                  style={{ width: "100%", fontSize: "0.85rem", padding: "0.5rem", boxSizing: "border-box" }}
                  disabled={invoiceBulkRunning}
                />

                {invoicePreviewError && (
                  <div className={styles.statusMsg} style={{ color: "#dc3545" }}>{invoicePreviewError}</div>
                )}

                {invoiceBulkResults.length > 0 && (
                  <div style={{ marginTop: "0.75rem", fontSize: "0.85rem", maxHeight: "320px", overflowY: "auto" }}>
                    {invoiceBulkResults.map((r) => (
                      <div key={r.invoice_no} style={{ padding: "0.25rem 0", borderBottom: "1px solid rgba(0,0,0,0.06)" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>
                          <span>
                            {r.status === "done" ? "✔" : r.status === "error" ? "✘" : r.status === "running" ? "⏳" : "▫"}
                          </span>
                          <span>{r.invoice_no}</span>
                          {r.status === "error" && r.detail && (
                            <span style={{ color: "#dc3545", fontSize: "0.78rem" }}>({r.detail})</span>
                          )}
                        </div>
                        {r.status !== "pending" && (r.steps || []).length > 0 && (
                          <div style={{ marginLeft: "1.3rem", marginTop: "0.15rem" }}>
                            {r.steps.map((s) => (
                              <div key={s.label} style={{ display: "flex", alignItems: "center", gap: "0.3rem", fontSize: "0.78rem", color: "#666", padding: "0.05rem 0" }}>
                                <span>
                                  {s.status === "done" ? "✔" : s.status === "error" ? "✘" : s.status === "running" ? "⏳" : "▫"}
                                </span>
                                <span>{s.label}</span>
                                {s.status === "error" && s.detail && (
                                  <span style={{ color: "#dc3545" }}>({s.detail})</span>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                <div className={styles.modalActions} style={{ marginTop: "1rem" }}>
                  <button className={styles.secondaryBtn} onClick={() => setShowInvoiceModal(false)} disabled={invoiceBulkRunning}>
                    취소
                  </button>
                  <button
                    className={styles.primaryBtn}
                    onClick={handleInvoiceBulkExecute}
                    disabled={invoiceBulkRunning || !parseBulkInvoiceNos(invoiceBulkInput).length}
                  >
                    {invoiceBulkRunning ? "처리 중..." : "일괄실행"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {showBadStockModal && (
        <div className={styles.modalOverlay} onClick={() => setShowBadStockModal(false)}>
          <div className={`${styles.modal} ${styles.modalWide}`} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <h4 className={styles.modalTitle}>악성재고</h4>
              <div className={styles.modalActions}>
                <button className={styles.secondaryBtn} onClick={checkBadStockWithEzadmin} disabled={badStockChecking}>
                  {badStockChecking ? "확인 중..." : "이지어드민 재고 비교"}
                </button>
                <button className={styles.secondaryBtn} onClick={() => setShowBadStockModal(false)}>닫기</button>
              </div>
            </div>
            {BAD_STOCK_CATEGORIES.map((cat) => (
              <div key={cat} className={styles.tabRow} style={{ marginBottom: "0.5rem" }}>
                {BAD_STOCK_LETTERS.map((letter) => {
                  const zone = `${cat}${letter}`;
                  return (
                    <button
                      key={zone}
                      className={`${styles.tabBtn} ${badStockZone === zone ? styles.tabActive : ""}`}
                      onClick={() => { setBadStockZone(zone); setBadStockRows([]); setBadStockMessage(""); }}
                    >
                      {badStockZoneLabel(zone)} ({badStockList.filter((i) => i.zone === zone).reduce((s, i) => s + (Number(i.qty) || 1), 0)})
                    </button>
                  );
                })}
              </div>
            ))}
            <div className={styles.uploadRow} style={{ marginBottom: "0.5rem" }}>
              <input
                value={badStockFind}
                onChange={(e) => setBadStockFind(e.target.value)}
                placeholder="전체 구역에서 등록된 재고 찾기 (상품명 / 상품코드)"
                className={styles.searchInput}
              />
              {badStockFind && (
                <button className={styles.ghostBtn} onClick={() => setBadStockFind("")}>지우기</button>
              )}
            </div>
            {badStockFind.trim() && (() => {
              const keyword = badStockFind.trim().toLowerCase();
              const found = badStockList.filter((i) =>
                `${i.code} ${i.product_name}`.toLowerCase().includes(keyword)
              );
              return (
                <div style={{ marginBottom: "0.5rem" }}>
                  {found.length === 0 ? (
                    <div className={styles.empty}>전체 구역에 일치하는 등록 재고가 없습니다.</div>
                  ) : (
                    <table className={styles.table}>
                      <thead>
                        <tr>
                          <th>구역</th>
                          <th>상품코드</th>
                          <th>상품명</th>
                          <th>수량</th>
                          <th></th>
                        </tr>
                      </thead>
                      <tbody>
                        {found.map((item) => (
                          <tr key={`badstock-find-${item.id}`}>
                            <td style={{ fontWeight: 700 }}>{badStockZoneLabel(item.zone)}</td>
                            <td>{item.code}</td>
                            <td>{item.product_name}</td>
                            <td style={{ fontWeight: 700 }}>{item.qty ?? 1}</td>
                            <td>
                              <button
                                className={styles.ghostBtn}
                                onClick={() => { setBadStockZone(item.zone); setBadStockRows([]); setBadStockMessage(""); }}
                              >
                                해당 구역 열기
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              );
            })()}
            <div className={styles.uploadRow} style={{ marginBottom: "0.5rem" }}>
              <input
                value={badStockScan}
                onChange={(e) => setBadStockScan(toEnglishKey(e.target.value))}
                onKeyDown={(e) => { if (e.key === "Enter") handleBadStockScan(); }}
                placeholder={`${badStockZoneLabel(badStockZone)} 상품 바코드 스캔 후 Enter`}
                className={styles.searchInput}
                autoFocus
              />
              <button className={styles.primaryBtn} onClick={handleBadStockScan}>바코드 추가</button>
            </div>
            <div className={styles.uploadRow}>
              <input
                value={badStockQuery}
                onChange={(e) => setBadStockQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") searchBadStock(); }}
                placeholder="상품명 검색"
                className={styles.searchInput}
              />
              <button className={styles.secondaryBtn} onClick={searchBadStock} disabled={badStockSearching}>
                {badStockSearching ? "검색 중..." : "상품 검색"}
              </button>
            </div>
            <div className={styles.modalBody}>
              {badStockMessage && (
                <div className={styles.statusMsg}><strong>{badStockMessage}</strong></div>
              )}
              {badStockCheck && (
                <div style={{ marginBottom: "0.75rem" }}>
                  <div className={styles.statusMsg}>
                    <strong>
                      이지어드민 비교: 전체 {badStockCheck.summary.total}종 / 일치 {badStockCheck.summary.match} / 불일치 {badStockCheck.summary.mismatch} / 미검색 {badStockCheck.summary.not_found}
                    </strong>
                    <button
                      className={styles.primaryBtn}
                      style={{ marginLeft: "0.75rem" }}
                      disabled={badStockNormalizing || badStockSelected.length === 0}
                      onClick={() => normalizeBadStock(badStockSelected)}
                    >
                      {badStockNormalizing ? "처리 중..." : `선택 정상화 (${badStockSelected.length})`}
                    </button>
                    <button
                      className={styles.secondaryBtn}
                      style={{ marginLeft: "0.4rem" }}
                      disabled={badStockNormalizing || badStockShortItems.length === 0}
                      onClick={() => normalizeBadStock([])}
                    >
                      전체 정상화 ({badStockShortItems.length}종)
                    </button>
                    <button className={styles.ghostBtn} style={{ marginLeft: "0.5rem" }} onClick={() => setBadStockCheck(null)}>닫기</button>
                  </div>
                  <div className={styles.inlineMeta} style={{ margin: "0.3rem 0" }}>
                    정상화는 이지어드민 정상재고가 등록 수량보다 적은 상품(차이가 음수)을 부족분만큼 입고처리합니다. 이지어드민 재고가 더 많거나 미검색인 상품은 건드리지 않습니다.
                  </div>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th style={{ width: "2rem" }}>
                          <input
                            type="checkbox"
                            checked={badStockShortItems.length > 0 && badStockSelected.length === badStockShortItems.length}
                            disabled={badStockShortItems.length === 0}
                            onChange={(e) => setBadStockSelected(e.target.checked ? badStockShortItems.map((i) => i.code) : [])}
                          />
                        </th>
                        <th>상품코드</th>
                        <th>상품명</th>
                        <th>구역별 등록</th>
                        <th>등록 합계</th>
                        <th>이지어드민 정상재고</th>
                        <th>차이</th>
                        <th>결과</th>
                      </tr>
                    </thead>
                    <tbody>
                      {badStockCheck.items.map((item) => (
                        <tr key={`badstock-check-${item.code}`} style={item.status === "match" ? undefined : { background: "rgba(255, 90, 90, 0.12)" }}>
                          <td>
                            {item.status === "mismatch" && item.diff < 0 && (
                              <input
                                type="checkbox"
                                checked={badStockSelected.includes(item.code)}
                                onChange={(e) => setBadStockSelected((prev) => (
                                  e.target.checked ? [...prev, item.code] : prev.filter((c) => c !== item.code)
                                ))}
                              />
                            )}
                          </td>
                          <td>{item.code}</td>
                          <td>{item.product_name}</td>
                          <td>{Object.entries(item.zones).map(([z, q]) => `${badStockZoneLabel(z)} ${q}`).join(", ")}</td>
                          <td style={{ fontWeight: 700 }}>{item.registered}</td>
                          <td style={{ fontWeight: 700 }}>{item.ezadmin_stock ?? "-"}</td>
                          <td>{item.diff == null ? "-" : item.diff > 0 ? `+${item.diff}` : item.diff}</td>
                          <td>{item.status === "match" ? "일치" : item.status === "mismatch" ? "불일치" : "미검색"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {badStockRows.length > 0 && (
                <div className={styles.defectList} style={{ marginBottom: "0.75rem" }}>
                  {badStockRows.map((row, idx) => (
                    <div key={`${row.code}-badstock-${idx}`} className={styles.defectLine}>
                      <span className={styles.defectText}>
                        {row.base_name}
                        {row.base_code && <span className={styles.inlineMeta} style={{ marginLeft: "0.4rem" }}>{row.base_code}</span>}
                      </span>
                      <button className={styles.ghostBtn} onClick={() => addBadStock(row.code, row.base_name)}>
                        {badStockZoneLabel(badStockZone)}에 추가
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {badStockList.filter((i) => i.zone === badStockZone).length === 0 ? (
                <div className={styles.empty}>{badStockZoneLabel(badStockZone)}에 등록된 상품이 없습니다.</div>
              ) : (
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>상품코드</th>
                      <th>상품명</th>
                      <th>수량</th>
                      <th>등록일</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {badStockList.filter((i) => i.zone === badStockZone).map((item) => (
                      <tr key={`badstock-${item.id}`}>
                        <td>{item.code}</td>
                        <td>{item.product_name}</td>
                        <td style={{ fontWeight: 700 }}>{item.qty ?? 1}</td>
                        <td>{String(item.created_at || "").slice(0, 10)}</td>
                        <td>
                          {(item.qty ?? 1) > 1 && (
                            <button
                              className={styles.ghostBtn}
                              style={{ marginRight: "0.3rem" }}
                              onClick={() => callBadStockApi("remove", { id: item.id, decrement: true })}
                            >
                              -1
                            </button>
                          )}
                          <button
                            className={styles.ghostBtn}
                            onClick={() => { if (window.confirm("삭제하시겠습니까?")) callBadStockApi("remove", { id: item.id }); }}
                          >
                            삭제
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={2} style={{ fontWeight: 700 }}>{badStockZoneLabel(badStockZone)} 합계</td>
                      <td style={{ fontWeight: 700 }}>
                        {badStockList.filter((i) => i.zone === badStockZone).reduce((s, i) => s + (Number(i.qty) || 1), 0)}
                      </td>
                      <td colSpan={2}>
                        ({badStockList.filter((i) => i.zone === badStockZone).length}종)
                      </td>
                    </tr>
                  </tfoot>
                </table>
              )}
            </div>
          </div>
        </div>
      )}

      {showAnomalyModal && (
        <div className={styles.modalOverlay} onClick={() => setShowAnomalyModal(false)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <h4 className={styles.modalTitle}>이상현상</h4>
              <div className={styles.modalActions}>
                <button className={styles.secondaryBtn} onClick={() => setShowAnomalyModal(false)}>닫기</button>
              </div>
            </div>
            <div className={styles.uploadRow}>
              <input
                value={anomalySearchQuery}
                onChange={(e) => setAnomalySearchQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") searchAnomalyProducts(); }}
                placeholder="G열 상품명 검색"
                className={styles.searchInput}
              />
              <button className={styles.secondaryBtn} onClick={searchAnomalyProducts} disabled={anomalySearchLoading}>
                {anomalySearchLoading ? "검색 중..." : "상품 검색"}
              </button>
            </div>
            <div className={styles.modalBody}>
              {anomalyMessage && (
                <div className={styles.statusMsg}><strong>{anomalyMessage}</strong></div>
              )}
              {anomalySearchRows.length > 0 && (
                <div className={styles.defectList} style={{ marginBottom: "0.75rem" }}>
                  {anomalySearchRows.map((row, idx) => (
                    <div key={`${row.code}-anomaly-${idx}`} className={styles.defectLine}>
                      <span className={styles.defectText}>
                        {row.base_name}
                        {row.base_color && <span className={styles.inlineMeta} style={{ marginLeft: "0.4rem" }}>{row.base_color}</span>}
                        {row.base_code && <span className={styles.inlineMeta} style={{ marginLeft: "0.4rem" }}>{row.base_code}</span>}
                      </span>
                      <button className={styles.ghostBtn} onClick={() => pickAnomalyProduct(row)}>선택</button>
                    </div>
                  ))}
                </div>
              )}
              <div className={styles.uploadRow} style={{ flexWrap: "wrap", marginBottom: "0.75rem" }}>
                <input
                  type="date"
                  value={anomalyForm.registered_date}
                  onChange={(e) => setAnomalyForm((p) => ({ ...p, registered_date: e.target.value }))}
                  className={styles.searchInput}
                  style={{ flex: "0 0 auto" }}
                />
                <input
                  value={anomalyForm.product_name}
                  onChange={(e) => setAnomalyForm((p) => ({ ...p, product_name: e.target.value }))}
                  placeholder="상품명 + 옵션 (검색 후 선택)"
                  className={styles.searchInput}
                  style={{ flex: 2 }}
                />
                <input
                  type="number"
                  min="0"
                  value={anomalyForm.qty}
                  onChange={(e) => setAnomalyForm((p) => ({ ...p, qty: e.target.value }))}
                  placeholder="개수"
                  className={styles.searchInput}
                  style={{ flex: "0 0 5rem" }}
                />
                <input
                  value={anomalyForm.reason}
                  onChange={(e) => setAnomalyForm((p) => ({ ...p, reason: e.target.value }))}
                  onKeyDown={(e) => { if (e.key === "Enter") addAnomaly(); }}
                  placeholder="사유"
                  className={styles.searchInput}
                  style={{ flex: 2 }}
                />
                <label style={{ display: "flex", alignItems: "center", gap: "0.3rem" }}>
                  <input
                    type="checkbox"
                    checked={anomalyForm.normalized}
                    onChange={(e) => setAnomalyForm((p) => ({ ...p, normalized: e.target.checked }))}
                  />
                  정상화
                </label>
                <button className={styles.primaryBtn} onClick={addAnomaly}>등록</button>
              </div>
              {anomalyList.length === 0 ? (
                <div className={styles.empty}>등록된 이상현상이 없습니다.</div>
              ) : (
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>등록날짜</th>
                      <th>상품명 + 옵션</th>
                      <th>개수</th>
                      <th>사유</th>
                      <th>정상화</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {anomalyList.map((item) => {
                      const editing = anomalyEdit?.id === item.id;
                      const setEdit = (key) => (e) => setAnomalyEdit((p) => ({ ...p, [key]: e.target.value }));
                      return (
                      <tr key={`anomaly-${item.id}`}>
                        <td>
                          {editing ? (
                            <input type="date" value={anomalyEdit.registered_date} onChange={setEdit("registered_date")} className={styles.searchInput} />
                          ) : item.registered_date}
                        </td>
                        <td>
                          {editing ? (
                            <input value={anomalyEdit.product_name} onChange={setEdit("product_name")} className={styles.searchInput} />
                          ) : item.product_name}
                        </td>
                        <td>
                          {editing ? (
                            <input type="number" min="0" value={anomalyEdit.qty} onChange={setEdit("qty")} className={styles.searchInput} style={{ width: "4.5rem" }} />
                          ) : (item.qty ?? 1)}
                        </td>
                        <td>
                          {editing ? (
                            <input
                              value={anomalyEdit.reason}
                              onChange={setEdit("reason")}
                              onKeyDown={(e) => { if (e.key === "Enter") saveAnomalyEdit(); }}
                              className={styles.searchInput}
                            />
                          ) : item.reason}
                        </td>
                        <td>
                          <input
                            type="checkbox"
                            checked={!!item.normalized}
                            onChange={(e) => callAnomalyApi("update", { id: item.id, normalized: e.target.checked })}
                          />
                        </td>
                        <td>
                          {editing ? (
                            <>
                              <button className={styles.primaryBtn} onClick={saveAnomalyEdit}>저장</button>
                              <button className={styles.ghostBtn} onClick={() => setAnomalyEdit(null)}>취소</button>
                            </>
                          ) : (
                            <>
                              <button
                                className={styles.ghostBtn}
                                onClick={() => setAnomalyEdit({
                                  id: item.id,
                                  registered_date: item.registered_date,
                                  product_name: item.product_name,
                                  qty: item.qty ?? 1,
                                  reason: item.reason,
                                })}
                              >
                                수정
                              </button>
                              <button
                                className={styles.ghostBtn}
                                onClick={() => { if (window.confirm("삭제하시겠습니까?")) callAnomalyApi("remove", { id: item.id }); }}
                              >
                                삭제
                              </button>
                            </>
                          )}
                        </td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}

      {showDefectList && (
        <div className={styles.modalOverlay} onClick={() => setShowDefectList(false)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <h4 className={styles.modalTitle}>불량 리스트</h4>
              <div className={styles.modalActions}>
                <button className={styles.secondaryBtn} onClick={handleDefectExport}>내보내기</button>
                <button className={styles.secondaryBtn} onClick={handleDefectPrint}>불량출력</button>
                <button className={styles.secondaryBtn} onClick={handleDefectPurchaseManager} disabled={defectList.length === 0}>매입관리</button>
                <button
                  className={styles.secondaryBtn}
                  onClick={handleKimsungilSummon}
                  disabled={kimsungilSummonLoading || kimsungilList.filter((i) => (i.incoming_qty || 0) > 0).length === 0}
                >
                  {kimsungilSummonLoading ? "소환 중..." : "김승일 소환술"}
                </button>
                <button className={styles.secondaryBtn} onClick={() => handleDefectExportAndOchuul()} disabled={defectEzadminLoading || ochuulLoading || defectList.length === 0}>
                  {defectEzadminLoading ? "출고 중..." : ochuulLoading ? "오출 중..." : "출고+오출"}
                </button>
                <button className={styles.secondaryBtn} onClick={() => { setShowDefectList(false); setOchuulResult(null); }}>닫기</button>
              </div>
            </div>
            {defectEzadminMsg && (
              <div className={styles.statusMsg}>{defectEzadminMsg}</div>
            )}
            {ochuulResult && (
              <div className={styles.statusMsg}
                style={{ borderColor: ochuulResult.matched > 0 ? "rgba(34,197,94,0.4)" : "rgba(234,179,8,0.4)", backgroundColor: ochuulResult.matched > 0 ? "rgba(34,197,94,0.07)" : "rgba(234,179,8,0.07)" }}>
                <strong>
                  오출내리기 완료: {ochuulResult.matched}건 차감
                  {ochuulResult.message ? ` — ${ochuulResult.message}` : ""}
                </strong>
                {ochuulResult.missing_option_codes?.length > 0 && (
                  <div style={{ marginTop: "0.5rem", color: "#b45309", fontSize: "0.85rem" }}>
                    <strong>원가베이스 옵션번호(K열) 없음 {ochuulResult.missing_option_codes.length}건</strong>
                    <div>{ochuulResult.missing_option_codes.join(", ")}</div>
                  </div>
                )}
                {ochuulResult.ably_missing_codes?.length > 0 && (
                  <div style={{ marginTop: "0.5rem", color: "#b45309", fontSize: "0.85rem" }}>
                    <strong>에이블리 오늘출발 옵션 목록에 없음 {ochuulResult.ably_missing_codes.length}건</strong>
                    <div>{ochuulResult.ably_missing_codes.join(", ")}</div>
                  </div>
                )}
                {ochuulResult.details?.length > 0 && (
                  <ul style={{ margin: "0.5rem 0 0", paddingLeft: "1rem", fontSize: "0.85rem" }}>
                    {ochuulResult.details.map((d, i) => (
                      <li key={i}>{d._goods_name} {d._option_name} — {d._prev_stock} → {d.stock} ({-d._ea_minus})</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            <div className={styles.uploadRow}>
              <input
                value={defectSearchQuery}
                onChange={(e) => setDefectSearchQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") searchDefectBaseByName(); }}
                placeholder="G열 상품명 검색"
                className={styles.searchInput}
              />
              <button className={styles.secondaryBtn} onClick={searchDefectBaseByName} disabled={defectSearchLoading}>
                {defectSearchLoading ? "검색 중..." : "불량 검색"}
              </button>
            </div>
            <div className={styles.modalBody}>
            {defectSearchMessage && (
              <div className={styles.statusMsg}>
                <strong>{defectSearchMessage}</strong>
              </div>
            )}
            {defectSearchRows.length > 0 && (
              <div className={styles.defectList} style={{ marginBottom: "0.75rem" }}>
                {defectSearchRows.map((row, idx) => (
                  <div key={`${row.code}-${idx}`} className={styles.defectLine}>
                    <span className={styles.defectText}>
                      {row.base_name}
                      {row.base_color && <span className={styles.inlineMeta} style={{ marginLeft: "0.4rem" }}>{row.base_color}</span>}
                      {row.base_code && <span className={styles.inlineMeta} style={{ marginLeft: "0.4rem" }}>{row.base_code}</span>}
                    </span>
                    <button className={styles.ghostBtn} onClick={() => addDefectFromSearch(row)}>추가</button>
                  </div>
                ))}
              </div>
            )}
            {defectList.length === 0 ? (
              <div className={styles.empty}>등록된 불량이 없습니다.</div>
            ) : (
              <div className={styles.defectList}>
                {defectList.map((item, idx) => (
                  <div key={`${item.code}-defect-${idx}`} className={styles.defectLine}>
                    <span className={styles.defectText}>{renderDefectLabel(item)}</span>
                    <span className={styles.inlineTagDanger}>불량 {item.count}</span>
                    {item.kimsungil_summon_qty > 0 && (
                      <span className={styles.inlineTagIncoming}>김승일 소환 {item.kimsungil_summon_qty}</span>
                    )}
                    <div className={styles.defectActions}>
                      <button className={styles.ghostBtn} onClick={() => handleDefectDec(item.code)}>-1</button>
                      <button className={styles.ghostBtn} onClick={() => handleDefectRemove(item.code)}>삭제</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            </div>
          </div>
        </div>
      )}

      {/* 김승일 리스트 모달 */}
      {showKimsungilList && (
        <div className={styles.modalOverlay} onClick={() => setShowKimsungilList(false)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <h4 className={styles.modalTitle}>김승일 리스트</h4>
              <div className={styles.modalActions}>
                <span className={styles.pill}>합계 {getKimsungilTotalCount()}</span>
                <button className={styles.secondaryBtn} onClick={() => setShowKimsungilList(false)}>닫기</button>
              </div>
            </div>
            <div className={styles.uploadRow}>
              <input
                value={kimsungilSearchQuery}
                onChange={(e) => setKimsungilSearchQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") searchKimsungilByName(); }}
                placeholder="G열 상품명 검색"
                className={styles.searchInput}
              />
              <button className={styles.secondaryBtn} onClick={searchKimsungilByName} disabled={kimsungilSearchLoading}>
                {kimsungilSearchLoading ? "검색 중..." : "김승일 검색"}
              </button>
            </div>
            <div className={styles.modalBody}>
            {kimsungilSearchMessage && (
              <div className={styles.statusMsg}>
                <strong>{kimsungilSearchMessage}</strong>
              </div>
            )}
            {kimsungilSearchRows.length > 0 && (
              <div className={styles.defectList} style={{ marginBottom: "0.75rem" }}>
                {kimsungilSearchRows.map((row, idx) => (
                  <div key={`${row.code}-${idx}`} className={styles.defectLine}>
                    <span className={styles.defectText}>
                      {row.base_name}
                      {row.base_color && <span className={styles.inlineMeta} style={{ marginLeft: "0.4rem" }}>{row.base_color}</span>}
                      {row.base_code && <span className={styles.inlineMeta} style={{ marginLeft: "0.4rem" }}>{row.base_code}</span>}
                    </span>
                    <button className={styles.ghostBtn} onClick={() => addKimsungilFromSearch(row)}>추가</button>
                  </div>
                ))}
              </div>
            )}
            {kimsungilList.length === 0 ? (
              <div className={styles.empty}>등록된 김승일 상품이 없습니다.</div>
            ) : (
              <div className={styles.defectList}>
                {[...kimsungilList].sort((a, b) => ((b.incoming_qty || 0) > 0 ? 1 : 0) - ((a.incoming_qty || 0) > 0 ? 1 : 0)).map((item, idx) => (
                  <div key={`${item.code}-kimsungil-${idx}`} className={styles.defectLine}>
                    <span className={styles.defectText}>{renderDefectLabel(item)}</span>
                    <span style={{ fontSize:"0.75rem", fontWeight:700, padding:"0.2rem 0.5rem", borderRadius:"999px", backgroundColor:"rgba(56,182,255,0.15)", color:"#0a6fa8", border:"1px solid rgba(56,182,255,0.3)" }}>추가 {item.count}</span>
                    {(item.incoming_qty || 0) > 0 && <span className={styles.inlineTagIncoming}>입고 {item.incoming_qty}</span>}
                    <div className={styles.defectActions}>
                      <button className={styles.ghostBtn} onClick={() => openKimsungilLog(item.code)}>로그</button>
                      <button className={styles.ghostBtn} onClick={() => handleKimsungilDec(item.code)}>-1</button>
                      <button className={styles.ghostBtn} onClick={() => handleKimsungilRemove(item.code)}>삭제</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            </div>
          </div>
        </div>
      )}

      {/* 김승일 로그 모달 */}
      {showKimsungilLog && (
        <div className={styles.modalOverlay} onClick={() => setShowKimsungilLog(false)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <h4 className={styles.modalTitle}>김승일 로그 — {kimsungilLogCode}</h4>
              <div className={styles.modalActions}>
                <button className={styles.secondaryBtn} onClick={() => fetchKimsungilLog(kimsungilLogCode)} disabled={kimsungilLogLoading}>
                  {kimsungilLogLoading ? "불러오는 중..." : "새로고침"}
                </button>
                <button className={styles.secondaryBtn} onClick={() => setShowKimsungilLog(false)}>닫기</button>
              </div>
            </div>
            <div className={styles.modalBody}>
              {kimsungilLogMessage && (
                <div className={styles.statusMsg}>
                  <strong>{kimsungilLogMessage}</strong>
                </div>
              )}
              {kimsungilLogRows.length > 0 && (
                <div className={styles.tableWrap}>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th>시간</th>
                        <th>방식</th>
                        <th>상품명</th>
                        <th>처리자</th>
                      </tr>
                    </thead>
                    <tbody>
                      {kimsungilLogRows.map((row) => (
                        <tr key={row.id}>
                          <td>{row.created_at}</td>
                          <td>{row.method}</td>
                          <td>{row.name}</td>
                          <td>{row.display_name || row.username}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {showDefectBaseEditor && (
        <div className={styles.modalOverlay} onClick={() => setShowDefectBaseEditor(false)}>
          <div className={styles.modal} style={{ width: "min(1100px, 96vw)" }} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <div>
                <h4 className={styles.modalTitle}>불량베이스 편집</h4>
                <p className={styles.subtitle} style={{ marginTop: "0.25rem" }}>
                  필요할 때만 불러와서 수정합니다.
                </p>
              </div>
              <div className={styles.modalActions}>
                <button className={styles.secondaryBtn} onClick={fetchDefectBase} disabled={defectBaseLoading}>
                  {defectBaseLoading ? "불러오는 중..." : "새로고침"}
                </button>
                <button className={styles.secondaryBtn} onClick={addDefectBaseRow}>
                  행 추가
                </button>
                <button className={styles.primaryBtn} onClick={saveDefectBase} disabled={defectBaseSaving}>
                  {defectBaseSaving ? "저장 중..." : "저장"}
                </button>
                <button className={styles.secondaryBtn} onClick={() => setShowDefectBaseEditor(false)}>
                  닫기
                </button>
              </div>
            </div>

            {defectBasePath && (
              <div className={styles.statusMsg}>
                <strong>{defectBasePath}</strong>
              </div>
            )}

            <div className={styles.uploadRow}>
              <input
                value={defectBaseQuery}
                onChange={(e) => setDefectBaseQuery(e.target.value)}
                placeholder="상품코드, 상품명, 옵션 검색"
                className={styles.searchInput}
              />
              <span className={styles.pill}>전체 {defectBaseRows.length}건</span>
              <span className={styles.pill}>표시 {defectBaseRowsToShow.length}건</span>
            </div>

            {defectBaseMessage && (
              <div className={styles.statusMsg}>
                <strong>{defectBaseMessage}</strong>
              </div>
            )}

            <div className={`${styles.tableWrap} ${styles.registeredTableWrap}`}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>#</th>
                    {defectBaseHeaders.map((header, idx) => (
                      <th key={`defect-base-header-${idx}`}>{header || `${idx + 1}열`}</th>
                    ))}
                    <th>관리</th>
                  </tr>
                </thead>
                <tbody>
                  {defectBaseRowsToShow.length === 0 ? (
                    <tr>
                      <td colSpan={9} className={styles.empty}>표시할 불량베이스 데이터가 없습니다.</td>
                    </tr>
                  ) : (
                    defectBaseRowsToShow.map((row) => {
                      const actualIndex = defectBaseRows.indexOf(row);
                      const values = Array.isArray(row.values) ? row.values : ["", "", "", "", "", "", ""];
                      return (
                        <tr key={`defect-base-row-${row.row_index ?? "new"}-${actualIndex}`}>
                          <td>{row.row_index ?? "신규"}</td>
                          {Array.from({ length: 7 }).map((_, colIndex) => (
                            <td key={`defect-base-cell-${actualIndex}-${colIndex}`}>
                              <input
                                value={values[colIndex] ?? ""}
                                onChange={(e) => updateDefectBaseCell(actualIndex, colIndex, e.target.value)}
                                className={styles.cellInput}
                              />
                            </td>
                          ))}
                          <td>
                            <button className={styles.ghostBtn} onClick={() => removeDefectBaseRow(actualIndex)}>
                              삭제
                            </button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {showIncomingVoucherModal && (
        <div className={styles.modalOverlay} onClick={() => setShowIncomingVoucherModal(false)}>
          <div className={styles.modal} style={{ width: "min(480px, 92vw)" }} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <span className={styles.modalTitle}>입고전표 선택 ({incomingEzDate})</span>
              <button type="button" className={styles.secondaryBtn} onClick={() => setShowIncomingVoucherModal(false)}>
                닫기
              </button>
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontWeight: 600, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={selectedIncomingSheets.length === incomingVoucherList.length && incomingVoucherList.length > 0}
                onChange={(e) =>
                  setSelectedIncomingSheets(e.target.checked ? incomingVoucherList.map((v) => String(v.sheet)) : [])
                }
              />
              전체 선택 ({selectedIncomingSheets.length}/{incomingVoucherList.length})
            </label>
            <div
              style={{
                display: "flex", flexDirection: "column", gap: "0.1rem", maxHeight: 340, overflowY: "auto",
                border: "1px solid var(--border-color)", borderRadius: "var(--radius-sm)", padding: "0.25rem",
              }}
            >
              {incomingVoucherList.map((v) => {
                const sheet = String(v.sheet);
                const checked = selectedIncomingSheets.includes(sheet);
                const c = v.cell || {};
                const displayName = c.sheet_name || c.title || c.supply_name || "";
                const subInfo = [c.crdate, c.req_qty ? `${c.req_qty}개` : null].filter(Boolean).join(" · ");
                return (
                  <label
                    key={sheet}
                    style={{ display: "flex", alignItems: "center", gap: "0.5rem", padding: "0.35rem 0.6rem", borderRadius: "var(--radius-sm)", cursor: "pointer" }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() =>
                        setSelectedIncomingSheets((prev) => (checked ? prev.filter((s) => s !== sheet) : [...prev, sheet]))
                      }
                    />
                    <span style={{ fontFamily: "monospace", fontSize: "0.82rem", color: "var(--text-muted)", minWidth: "4.5rem", flexShrink: 0 }}>
                      {sheet}
                    </span>
                    <span style={{ fontSize: "0.9rem", flex: 1 }}>{displayName}</span>
                    {subInfo && <span style={{ fontSize: "0.8rem", color: "var(--text-muted)", flexShrink: 0 }}>{subInfo}</span>}
                  </label>
                );
              })}
            </div>
            <button
              type="button"
              className={styles.primaryBtn}
              onClick={handleIncomingVoucherConfirm}
              disabled={!selectedIncomingSheets.length}
            >
              {selectedIncomingSheets.length}건 불러오기
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
