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
  const [defectBaseHeaders, setDefectBaseHeaders] = useState(["상품코드", "상품명", "공급처", "공급처상품명", "색상 사이즈", "주소", "표시형 상품명"]);
  const [defectBaseRows, setDefectBaseRows] = useState([]);
  const [defectBasePath, setDefectBasePath] = useState("");
  const [defectBaseQuery, setDefectBaseQuery] = useState("");
  const [defectBaseLoading, setDefectBaseLoading] = useState(false);
  const [defectBaseSaving, setDefectBaseSaving] = useState(false);
  const [defectBaseMessage, setDefectBaseMessage] = useState("");
  const [showDefectBaseEditor, setShowDefectBaseEditor] = useState(false);
  const [ochuulLoading, setOchuulLoading] = useState(false);
  const [ochuulResult, setOchuulResult] = useState(null);
  const [ezadminLoading, setEzadminLoading] = useState(false);
  const [ezadminMsg, setEzadminMsg] = useState("");
  const [ezadminOrdersLoading, setEzadminOrdersLoading] = useState(false);
  const [ezadminOrdersMsg, setEzadminOrdersMsg] = useState("");
  const [ezadminOrdersTiming, setEzadminOrdersTiming] = useState(null);
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

  const handleIncomingFromEzadmin = async () => {
    try {
      setEzadminLoading(true); setEzadminMsg("EZAdmin에서 불러오는 중... (최대 60초)");
      setIncomingMsg(""); setIncomingCodes(null); setIncomingTotal(null);
      const res = await fetch(`${API}/barcode/incoming/upload-from-ezadmin`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({}),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (data?.need_session) {
        setEzadminMsg("");
        openEzadminModal(handleIncomingFromEzadmin);
        return;
      }
      if (!res.ok || !data?.ok) {
        const msg = data?.detail || "EZAdmin 불러오기 실패";
        setIncomingMsg(msg); pushLog(msg);
        return;
      }
      setIncomingMsg("EZAdmin 입고 데이터 로드 완료");
      setIncomingCodes(data.codes ?? null); setIncomingTotal(data.total_qty ?? null);
      pushLog(`EZAdmin 입고 로드 완료 (코드 ${data.codes ?? "-"} / 수량 ${data.total_qty ?? "-"})`);
      await refreshStatus();
    } catch (err) {
      const msg = `EZAdmin 불러오기 실패: ${err.message || ""}`.trim();
      setIncomingMsg(msg); pushLog(msg);
    } finally { setEzadminLoading(false); setEzadminMsg(""); }
  };

  const handleUploadFromEzadminOrders = async () => {
    const startedAt = performance.now();
    try {
      setEzadminOrdersLoading(true); setEzadminOrdersMsg("EZAdmin에서 주문 불러오는 중...");
      setEzadminOrdersTiming(null);
      setUploadMsg(""); setCount(null); setCodesTotal(null);
      const res = await fetch(`${API}/barcode/upload-from-ezadmin-orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({}),
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

  const handleDefectExportToEzadmin = async () => {
    try {
      setDefectEzadminLoading(true); setDefectEzadminMsg("EZAdmin 출고처리 중...");
      const res = await fetch(`${API}/barcode/defect/export-to-ezadmin`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({}),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (data?.need_session) {
        setDefectEzadminMsg("");
        openEzadminModal(handleDefectExportToEzadmin);
        return;
      }
      if (!data?.ok) {
        setDefectEzadminMsg(data?.error || "출고처리 실패");
        return;
      }
      setDefectEzadminMsg(`출고처리 완료 (${data.count ?? 0}건)`);
    } catch (err) {
      setDefectEzadminMsg(`출고처리 실패: ${err.message || ""}`);
    } finally { setDefectEzadminLoading(false); }
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

  const handleCompletedXlsDownload = async () => {
    try {
      const res = await fetch(`${API}/barcode/completed/export-xls`, { headers: getAuthHeaders() });
      if (handleUnauthorized(res)) return;
      if (!res.ok) {
        let message = "완료목록 다운로드 실패";
        try { const data = await res.json(); message = data?.detail || message; }
        catch { const text = await res.text(); if (text) message = text; }
        throw new Error(message);
      }
      const blob = await res.blob();
      const fallback = `completed_products_${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "")}.xls`;
      const filename = getDownloadFilename(res, fallback);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      pushLog(`완료목록 다운로드 완료: ${filename}`);
    } catch (err) {
      alert(err.message || "완료목록 다운로드 실패");
      pushLog(`완료목록 다운로드 실패: ${err.message || ""}`.trim());
    }
  };

  const handleDefectPrint = async () => {
    if (defectList.length === 0) {
      alert("보낼 불량 목록이 없습니다.");
      return;
    }
    try {
      const rows = defectList
        .map((item) => ({
          vendor: String(item.base_vendor || "").trim(),
          name: String(item.base_product || "").trim(),
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
    try {
      const res = await fetch(`${API}/barcode/defect/purchase-manager-handoff`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
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

  const handleOchuulMinus = async () => {
    if (defectList.length === 0) { alert("불량 목록이 없습니다."); return; }
    const total = getDefectTotalCount();
    if (!window.confirm(`불량 목록 ${defectList.length}종 합계 ${total}개를 오출 차감하겠습니까?`)) return;
    try {
      setOchuulLoading(true);
      setOchuulResult(null);
      const res = await fetch(`${API}/barcode/defect/ochuul-minus`, {
        method: "POST",
        headers: getAuthHeaders(),
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
    const localResults = invoiceNos.map((no) => ({ invoice_no: no, status: "pending" }));
    setInvoiceBulkResults(localResults);

    const setResult = (invoiceNo, status, detail) => {
      const target = localResults.find((r) => r.invoice_no === invoiceNo);
      if (target) { target.status = status; target.detail = detail; }
      setInvoiceBulkResults([...localResults]);
    };

    for (const invoiceNo of invoiceNos) {
      setResult(invoiceNo, "running");
      try {
        const preview = await fetchInvoicePreview(invoiceNo);
        await runInvoicePipeline(preview, invoiceStockOutEnabled, invoiceStockOutMemo, () => {});
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

  const openDefectBaseEditor = async () => {
    setShowDefectBaseEditor(true);
    if (!defectBaseRows.length) {
      await fetchDefectBase();
    }
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
              <button className={styles.secondaryBtn} style={{ flex: 1 }} onClick={handleIncomingFromEzadmin} disabled={loadingIncoming || ezadminLoading}>
                {ezadminLoading ? "EZAdmin 불러오는 중..." : "EZAdmin에서 불러오기"}
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
              <button className={styles.secondaryBtn} onClick={handleCompletedXlsDownload}>
                완료목록 다운로드
              </button>
              <button
                className={`${styles.toggleBtn} ${defectMode ? styles.toggleOn : ""}`}
                onClick={() => setDefectMode((v) => !v)}
                style={defectMode ? { background: "rgba(220,53,69,0.9)", borderColor: "rgba(220,53,69,0.9)" } : {}}
              >
                {defectMode ? "🚨 불량 모드" : "불량 모드"}
              </button>
              <button className={styles.secondaryBtn} onClick={() => { setShowDefectList(true); fetchDefectList(); }}>
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
              <button className={styles.secondaryBtn} onClick={openDefectBaseEditor}>
                불량베이스 편집
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
                  <div style={{ marginTop: "0.75rem", fontSize: "0.85rem", maxHeight: "260px", overflowY: "auto" }}>
                    {invoiceBulkResults.map((r) => (
                      <div key={r.invoice_no} style={{ display: "flex", alignItems: "center", gap: "0.35rem", padding: "0.15rem 0" }}>
                        <span>
                          {r.status === "done" ? "✔" : r.status === "error" ? "✘" : r.status === "running" ? "⏳" : "▫"}
                        </span>
                        <span>{r.invoice_no}</span>
                        {r.status === "error" && r.detail && (
                          <span style={{ color: "#dc3545", fontSize: "0.78rem" }}>({r.detail})</span>
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

      {showDefectList && (
        <div className={styles.modalOverlay} onClick={() => setShowDefectList(false)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <h4 className={styles.modalTitle}>불량 리스트</h4>
              <div className={styles.modalActions}>
                <button className={styles.secondaryBtn} onClick={handleDefectExport}>내보내기</button>
                <button className={styles.secondaryBtn} onClick={handleDefectPrint}>불량출력</button>
                <button className={styles.secondaryBtn} onClick={handleDefectPurchaseManager} disabled={defectList.length === 0}>매입관리</button>
                <button className={styles.secondaryBtn} onClick={handleDefectExportToEzadmin} disabled={defectEzadminLoading || defectList.length === 0}>
                  {defectEzadminLoading ? "처리 중..." : "출고처리"}
                </button>
                <button className={styles.secondaryBtn} onClick={handleOchuulMinus} disabled={ochuulLoading || defectList.length === 0}>
                  {ochuulLoading ? "처리 중..." : "오출내리기"}
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
    </div>
  );
}
