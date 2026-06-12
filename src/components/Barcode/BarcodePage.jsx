import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./BarcodePage.module.css";
import * as XLSX from "xlsx";
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
  const [log, setLog] = useState([]);
  const [items, setItems] = useState([]);
  const [nextPreview, setNextPreview] = useState(null);
  const [defectMode, setDefectMode] = useState(false);
  const [showDefectList, setShowDefectList] = useState(false);
  const [defectList, setDefectList] = useState([]);
  const [defectSearchQuery, setDefectSearchQuery] = useState("");
  const [defectSearchRows, setDefectSearchRows] = useState([]);
  const [defectSearchLoading, setDefectSearchLoading] = useState(false);
  const [defectSearchMessage, setDefectSearchMessage] = useState("");
  const [defectRecentCodes, setDefectRecentCodes] = useState([]);
  const [defectBaseHeaders, setDefectBaseHeaders] = useState(["상품코드", "상품명", "공급처", "공급처상품명", "색상 사이즈", "주소", "표시형 상품명"]);
  const [defectBaseRows, setDefectBaseRows] = useState([]);
  const [defectBasePath, setDefectBasePath] = useState("");
  const [defectBaseQuery, setDefectBaseQuery] = useState("");
  const [defectBaseLoading, setDefectBaseLoading] = useState(false);
  const [defectBaseSaving, setDefectBaseSaving] = useState(false);
  const [defectBaseMessage, setDefectBaseMessage] = useState("");
  const [showDefectBaseEditor, setShowDefectBaseEditor] = useState(false);
  const soundsRef = useRef(null);

  const pushLog = (msg) => setLog((prev) => [msg, ...prev]);
  const downloadLogExcel = () => {
    if (!log.length) { alert("로그가 없습니다."); return; }
    const rows = [["번호", "로그"], ...log.map((text, idx) => [idx + 1, text])];
    const ws = XLSX.utils.aoa_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "결과로그");
    XLSX.writeFile(wb, "barcode_result_log.xlsx");
  };

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
        setNextPreview(data.next_preview ?? null);
        if (data.current_invoice) setItems(data.items ?? []);
        else if (Array.isArray(data.items) && data.items.length > 0) setItems(data.items);
        setDefectList(data.defects ?? []);
      } else {
        setCurrentInvoice(null); setInvoiceDone(false);
        setNextPreview(null);
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
      setItems([]); setNextPreview(null); setDefectRecentCodes([]); setScanText("");
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
      setItems(data.items ?? items); setNextPreview(data.next_preview ?? null);
      setDefectList(data.defects ?? defectList);
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
      setNextPreview(data.next_preview ?? null);
      setDefectList(data.defects ?? defectList);
      setDefectRecentCodes((prev) => [data.code, ...prev.filter((itemCode) => itemCode !== data.code)]);
      setDefectSearchMessage(`불량 추가 완료: ${row.base_name || data.code}`);
      pushLog(`불량 검색 추가: ${data.code} ${row.base_name || ""}`.trim());
    } catch (err) {
      setDefectSearchMessage(err.message || "불량 추가 실패");
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
          setCurrentInvoice(null); setInvoiceDone(false); setItems([]); setNextPreview(null);
        } else {
          setCurrentInvoice(data.invoice); setInvoiceDone(false);
          setItems(data.items ?? []); setNextPreview(data.next_preview ?? null);
          setDefectList(data.defects ?? defectList);
          if (data.invoice_has_defect) playSound("invoiceDefect");
          pushLog(`송장 SET: ${data.invoice}`);
        }
      } else {
        if (data.ok === false && data.result === "NO_INVOICE") {
          pushLog("송장이 먼저 필요합니다.");
          setCurrentInvoice(null); setInvoiceDone(false); setItems([]); setNextPreview(null);
        } else if (data.result === "TRUE") {
          pushLog(`TRUE  ${data.code} (잔여 ${data.remain}) ${data.name || ""} ${data.option || ""}`.trim());
          setItems(data.items ?? []); setDefectList(data.defects ?? defectList);
          if (data.invoice_done) { playSound("invoiceDone"); pushLog(`송장 완료: ${data.invoice}`); setInvoiceDone(true); }
          else playSound("itemDone");
        } else {
          pushLog(`FALSE ${data.code} (잔여 ${data.remain}) ${data.name || ""} ${data.option || ""}`.trim());
          setDefectList(data.defects ?? defectList); playSound("bad");
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
      setDefectList(data.defects ?? []); setItems(data.items ?? items); setNextPreview(data.next_preview ?? null);
    } catch (err) { pushLog(`불량 감소 실패: ${err.message || ""}`.trim()); }
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
      setDefectList(data.defects ?? []); setItems(data.items ?? items); setNextPreview(data.next_preview ?? null);
    } catch (err) { pushLog(`불량 삭제 실패: ${err.message || ""}`.trim()); }
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

  const handleDefectXlsDownload = async () => {
    if (defectList.length === 0) {
      alert("다운로드할 불량 목록이 없습니다.");
      return;
    }
    try {
      const res = await fetch(`${API}/barcode/defect/export-xls`, { headers: getAuthHeaders() });
      if (handleUnauthorized(res)) return;
      if (!res.ok) {
        let message = "xls 다운로드 실패";
        try { const data = await res.json(); message = data?.detail || message; }
        catch { const text = await res.text(); if (text) message = text; }
        throw new Error(message);
      }
      const blob = await res.blob();
      const fallback = `defects_work_${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "")}.xls`;
      const filename = getDownloadFilename(res, fallback);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      pushLog(`불량 xls 다운로드 완료: ${filename}`);
    } catch (err) {
      alert(err.message || "xls 다운로드 실패");
      pushLog(`불량 xls 다운로드 실패: ${err.message || ""}`.trim());
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
              {loadingUpload && <span className={styles.pill}>업로드 중</span>}
              {count !== null && !loadingUpload && (
                <span className={styles.pill}>송장 {count} · 코드 {codesTotal}</span>
              )}
            </div>
            <div className={styles.uploadRow}>
              <label className={styles.fileInput} style={{ flex: 1, justifyContent: 'flex-start' }}>
                <input type="file" accept=".xls,.xlsx" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setUploadMsg(""); }} />
                {file ? file.name : "파일 선택"}
              </label>
              <button className={styles.primaryBtn} onClick={handleUpload} disabled={loadingUpload || !file}>
                업로드
              </button>
            </div>
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
              {loadingIncoming && <span className={styles.pill}>업로드 중</span>}
              {incomingCodes !== null && !loadingIncoming && (
                <span className={styles.pill}>코드 {incomingCodes} · 수량 {incomingTotal}</span>
              )}
            </div>
            <div className={styles.uploadRow}>
              <label className={styles.fileInput} style={{ flex: 1, justifyContent: 'flex-start' }}>
                <input type="file" accept=".xls,.xlsx" onChange={(e) => { setIncomingFile(e.target.files?.[0] ?? null); setIncomingMsg(""); }} />
                {incomingFile ? incomingFile.name : "파일 선택"}
              </label>
              <button className={styles.primaryBtn} onClick={handleIncomingUpload} disabled={loadingIncoming || !incomingFile}>
                업로드
              </button>
            </div>
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
              <button className={styles.secondaryBtn} onClick={downloadLogExcel} title="로그 다운로드">
                로그 다운
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

            {/* 다음 상품 */}
            <div style={{
              borderRadius: "var(--radius-md)",
              border: "1px dashed var(--border-color)",
              padding: "1.25rem 1.5rem",
              display: "flex",
              flexDirection: "column",
              gap: "0.75rem",
            }}>
              <span className={styles.infoLabel}>다음 상품</span>
              {nextPreview ? (
                <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                  <span style={{ fontWeight: 700, fontSize: "1.2rem", overflowWrap: "anywhere", color: "var(--text-secondary)" }}>
                    {renderItemLabel(nextPreview)}
                  </span>
                  <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
                    {nextPreview.run_len > 1 && <span className={styles.inlineTagRun}>연속 {nextPreview.run_len}</span>}
                    {nextPreview.incoming > 0 && <span className={styles.inlineTagIncoming}>입고 {nextPreview.incoming}</span>}
                    {nextPreview.remain >= 2 && <span className={styles.inlineMeta}>잔여 {nextPreview.remain}</span>}
                    {nextPreview.invoice && <span className={styles.inlineTag}>송장 {nextPreview.invoice}</span>}
                  </div>
                </div>
              ) : (
                <span style={{ color: "var(--text-muted)", fontSize: "1rem" }}>—</span>
              )}
            </div>
          </div>
        </section>

      </div>

      {/* 불량 리스트 모달 */}
      {showDefectList && (
        <div className={styles.modalOverlay} onClick={() => setShowDefectList(false)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <h4 className={styles.modalTitle}>불량 리스트</h4>
              <div className={styles.modalActions}>
                <button className={styles.secondaryBtn} onClick={handleDefectXlsDownload}>xls 다운로드</button>
                <button className={styles.secondaryBtn} onClick={handleDefectExport}>내보내기</button>
                <button className={styles.secondaryBtn} onClick={handleDefectPrint}>불량출력</button>
                <button className={styles.secondaryBtn} onClick={() => setShowDefectList(false)}>닫기</button>
              </div>
            </div>
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
