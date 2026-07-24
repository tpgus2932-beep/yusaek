import React, { useEffect, useRef, useState } from "react";
import * as XLSX from "xlsx";
import styles from "./BarcodePage.module.css";
import { getDownloadFilename } from "../../lib/download";
import { LOCAL_API_BASE as API, getAuthHeaders } from "../../lib/api";

const HANGUL_BASE = 0xac00;
const HANGUL_LAST = 0xd7a3;
const HANGUL_L = [
  "r",
  "R",
  "s",
  "e",
  "E",
  "f",
  "a",
  "q",
  "Q",
  "t",
  "T",
  "d",
  "w",
  "W",
  "c",
  "z",
  "x",
  "v",
  "g",
];
const HANGUL_V = [
  "k",
  "o",
  "i",
  "O",
  "j",
  "p",
  "u",
  "P",
  "h",
  "hk",
  "ho",
  "hl",
  "y",
  "n",
  "nj",
  "np",
  "nl",
  "b",
  "m",
  "ml",
  "l",
];
const HANGUL_T = [
  "",
  "r",
  "R",
  "rt",
  "s",
  "sw",
  "sg",
  "e",
  "f",
  "fr",
  "fa",
  "fq",
  "ft",
  "fx",
  "fv",
  "fg",
  "a",
  "q",
  "qt",
  "t",
  "T",
  "d",
  "w",
  "c",
  "z",
  "x",
  "v",
  "g",
];
const HANGUL_COMPAT = {
  ㄱ: "r",
  ㄲ: "R",
  ㄴ: "s",
  ㄷ: "e",
  ㄸ: "E",
  ㄹ: "f",
  ㅁ: "a",
  ㅂ: "q",
  ㅃ: "Q",
  ㅅ: "t",
  ㅆ: "T",
  ㅇ: "d",
  ㅈ: "w",
  ㅉ: "W",
  ㅊ: "c",
  ㅋ: "z",
  ㅌ: "x",
  ㅍ: "v",
  ㅎ: "g",
  ㅏ: "k",
  ㅐ: "o",
  ㅑ: "i",
  ㅒ: "O",
  ㅓ: "j",
  ㅔ: "p",
  ㅕ: "u",
  ㅖ: "P",
  ㅗ: "h",
  ㅘ: "hk",
  ㅙ: "ho",
  ㅚ: "hl",
  ㅛ: "y",
  ㅜ: "n",
  ㅝ: "nj",
  ㅞ: "np",
  ㅟ: "nl",
  ㅠ: "b",
  ㅡ: "m",
  ㅢ: "ml",
  ㅣ: "l",
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
    if (HANGUL_COMPAT[ch]) {
      out += HANGUL_COMPAT[ch];
      continue;
    }
    out += ch;
  }
  return out.toUpperCase();
};

const formatSavedAt = (value) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("ko-KR", {
    hour12: false,
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
};

export default function AmoodBarcodePage({ headerExtra = null, onOpenTestTab = null, onTransferAmoodHapbae = null }) {
  const [file2, setFile2] = useState(null);
  const [loadingApi, setLoadingApi] = useState(false);
  const [loadingShippingApi, setLoadingShippingApi] = useState(false);
  const [apiCount, setApiCount] = useState(null);
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [incomingFile, setIncomingFile] = useState(null);
  const [incomingMsg, setIncomingMsg] = useState("");
  const [incomingCodes, setIncomingCodes] = useState(null);
  const [incomingTotal, setIncomingTotal] = useState(null);
  const [loadingIncoming, setLoadingIncoming] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [scanText, setScanText] = useState("");
  const [currentInvoice, setCurrentInvoice] = useState(null);
  const [items, setItems] = useState([]);
  const [currentNext, setCurrentNext] = useState(null);
  const [invoiceDone, setInvoiceDone] = useState(false);
  const [invoiceHasDefect, setInvoiceHasDefect] = useState(false);
  const [log, setLog] = useState([]);
  const scanRef = useRef(null);
  const soundsRef = useRef(null);
  const [fileInputKey, setFileInputKey] = useState(0);
  const [easyadminBPreviewOpen, setEasyadminBPreviewOpen] = useState(false);
  const [easyadminBPreviewText, setEasyadminBPreviewText] = useState("");
  const [easyadminBCopyMessage, setEasyadminBCopyMessage] = useState("");
  const [hblLoading, setHblLoading] = useState(false);
  const [hblResult, setHblResult] = useState(null);
  const [loadingEzadmin, setLoadingEzadmin] = useState(false);
  const [mgmtNumbers, setMgmtNumbers] = useState([]);
  const [packLoading, setPackLoading] = useState(false);
  const [ezadminHistory, setEzadminHistory] = useState([]);
  const [restoringId, setRestoringId] = useState(null);

  const refreshEzadminHistory = async () => {
    try {
      const res = await fetch(`${API}/amood/ezadmin-history`, { headers: getAuthHeaders() });
      if (!res.ok) return;
      const data = await res.json();
      setEzadminHistory(data.history || []);
    } catch {
      // ignore
    }
  };

  const restoreEzadminHistory = async (id) => {
    if (!window.confirm("현재 이지어드민 엑셀을 이 이력으로 되돌리시겠습니까?")) return;
    setRestoringId(id);
    setMessage("");
    try {
      const res = await fetch(`${API}/amood/ezadmin-history/${id}/restore`, {
        method: "POST",
        headers: getAuthHeaders(),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "이력 복원 실패");
      setMessage("이지어드민 엑셀을 이력으로 복원했습니다.");
      await refreshStatus();
    } catch (err) {
      setMessage(err.message || "이력 복원 실패");
    } finally {
      setRestoringId(null);
    }
  };

  const refreshStatus = async () => {
    try {
      const res = await fetch(`${API}/amood/status`, { headers: getAuthHeaders() });
      if (!res.ok) return;
      const data = await res.json();
      setStatus(data.status || null);
      if (data?.status?.incoming_codes !== undefined) {
        setIncomingCodes(data.status.incoming_codes);
        setIncomingTotal(data.status.incoming_total ?? 0);
      }
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    refreshStatus();
    refreshEzadminHistory();
    setTimeout(() => scanRef.current?.focus(), 50);
  }, []);

  useEffect(() => {
    if (!soundsRef.current) {
      soundsRef.current = {
        invoiceDone: new Audio("/sounds/zz.wav"),
        itemDone: new Audio("/sounds/xx.wav"),
        bad: new Audio("/sounds/dd.wav"),
        invoiceDefect: new Audio("/sounds/bb.wav"),
        scanOk: new Audio("/sounds/tt.wav"),
      };
    }
  }, []);

  const pushLog = (msg) => {
    setLog((prev) => [msg, ...prev].slice(0, 12));
  };

  const playSound = (key) => {
    const audio = soundsRef.current?.[key];
    if (!audio) return;
    audio.currentTime = 0;
    audio.play().catch(() => {});
  };

  const refreshScanStatus = async () => {
    try {
      const res = await fetch(`${API}/amood/scan/status`, { headers: getAuthHeaders() });
      if (!res.ok) return;
      const data = await res.json();
      setCurrentInvoice(data.current_invoice ?? null);
      setItems(data.items ?? []);
      setCurrentNext(data.current_next ?? null);
      setInvoiceHasDefect(!!data.invoice_has_defect);
      setInvoiceDone(false);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    refreshScanStatus();
  }, []);

  const extractEasyadminColumnBText = async (file) => {
    if (!file) return "";

    const lowerName = (file.name || "").toLowerCase();
    const workbook = lowerName.endsWith(".htm") || lowerName.endsWith(".html")
      ? XLSX.read(await file.text(), { type: "string" })
      : XLSX.read(await file.arrayBuffer(), { type: "array" });

    const firstSheetName = workbook.SheetNames?.[0];
    const sheet = firstSheetName ? workbook.Sheets[firstSheetName] : null;
    if (!sheet) return "";

    const rows = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      raw: false,
      defval: "",
    });
    const values = [];

    for (const row of rows.slice(1)) {
      const columnB = row?.[1];
      if (columnB == null || columnB === "") continue;
      const parts = String(columnB)
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
      values.push(...parts);
    }

    return values.join(", ");
  };

  const showEasyadminBPreview = async (file) => {
    try {
      const text = await extractEasyadminColumnBText(file);
      setEasyadminBPreviewText(text);
      setEasyadminBCopyMessage("");
      setEasyadminBPreviewOpen(true);
    } catch {
      setEasyadminBPreviewText("");
      setEasyadminBCopyMessage("");
      setEasyadminBPreviewOpen(false);
    }
  };

  const copyEasyadminBPreview = async () => {
    if (!easyadminBPreviewText) {
      setEasyadminBCopyMessage("복사할 값이 없습니다.");
      return;
    }

    try {
      await navigator.clipboard.writeText(easyadminBPreviewText);
      setEasyadminBCopyMessage("복사 완료");
    } catch {
      setEasyadminBCopyMessage("복사 실패");
    }
  };

  const loadFromApi = async () => {
    setLoadingApi(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/amood/load-from-pastelco`, {
        method: "POST",
        headers: getAuthHeaders(),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "API 불러오기 실패");
      setApiCount(data.count ?? null);
      setMessage(`아무드 주문 ${data.count ?? 0}건 불러옴`);
      await refreshStatus();
    } catch (err) {
      setMessage(err.message || "API 불러오기 실패");
    } finally {
      setLoadingApi(false);
    }
  };

  const loadFromShippingProcessingToday = async () => {
    setLoadingShippingApi(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/amood/load-from-pastelco-shipping-processing-today`, {
        method: "POST",
        headers: getAuthHeaders(),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "배송중 불러오기 실패");
      setApiCount(data.count ?? null);
      setMessage(`배송중 주문 ${data.count ?? 0}건 불러옴 (${data.date || ""})`);
      await refreshStatus();
    } catch (err) {
      setMessage(err.message || "배송중 불러오기 실패");
    } finally {
      setLoadingShippingApi(false);
    }
  };

  const loadFromEzadmin = async () => {
    setLoadingEzadmin(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/amood/load-from-ezadmin`, {
        method: "POST",
        headers: getAuthHeaders(),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "이지어드민 불러오기 실패");
      setMessage(`이지어드민 ${data.count ?? 0}행 불러옴`);
      if (data.management_numbers?.length) {
        setMgmtNumbers(data.management_numbers);
        setEasyadminBPreviewText(data.management_numbers.join(", "));
        setEasyadminBCopyMessage("");
        setEasyadminBPreviewOpen(true);
      }
      await refreshStatus();
      await refreshEzadminHistory();
    } catch (err) {
      setMessage(err.message || "이지어드민 불러오기 실패");
    } finally {
      setLoadingEzadmin(false);
    }
  };

  const createHapbaePack = async () => {
    if (mgmtNumbers.length < 2) {
      setMessage("합포할 관리번호가 2개 이상 필요합니다.");
      return;
    }
    setPackLoading(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/amood/hapbae-pack`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ management_numbers: mgmtNumbers }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "합포만들기 실패");
      if (data.ok === false) throw new Error(JSON.stringify(data.result) || "합포만들기 실패");
      setMessage(`합포만들기 완료 (seq: ${data.seq})`);
    } catch (err) {
      setMessage(err.message || "합포만들기 실패");
    } finally {
      setPackLoading(false);
    }
  };

  const uploadExcel2 = async () => {
    if (!file2) {
      setMessage("이지어드민 엑셀을 선택해 주세요.");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      const formData = new FormData();
      formData.append("file", file2);
      const res = await fetch(`${API}/amood/excel2`, {
        method: "POST",
        headers: getAuthHeaders(),
        body: formData,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "이지어드민 엑셀 업로드 실패");
      setMessage("이지어드민 엑셀 업로드 완료");
      const bText = await extractEasyadminColumnBText(file2);
      const nums = bText.split(",").map((s) => s.trim()).filter(Boolean);
      setMgmtNumbers(nums);
      setEasyadminBPreviewText(bText);
      setEasyadminBCopyMessage("");
      setEasyadminBPreviewOpen(true);
      await refreshStatus();
    } catch (err) {
      setMessage(err.message || "이지어드민 엑셀 업로드 실패");
    } finally {
      setLoading(false);
    }
  };

  const uploadIncoming = async () => {
    if (!incomingFile) {
      setIncomingMsg("입고 파일을 선택해 주세요.");
      return;
    }
    setLoadingIncoming(true);
    setIncomingMsg("");
    try {
      const formData = new FormData();
      formData.append("file", incomingFile);
      const res = await fetch(`${API}/amood/incoming/upload`, {
        method: "POST",
        headers: getAuthHeaders(),
        body: formData,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "입고 파일 업로드 실패");
      setIncomingMsg("입고 파일 업로드 완료");
      setIncomingCodes(data.codes ?? null);
      setIncomingTotal(data.total_qty ?? null);
      await refreshStatus();
    } catch (err) {
      setIncomingMsg(err.message || "입고 파일 업로드 실패");
    } finally {
      setLoadingIncoming(false);
    }
  };

  const runPreprocess = async () => {
    setProcessing(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/amood/preprocess`, {
        method: "POST",
        headers: getAuthHeaders(),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "전처리 가공 실패");
      setMessage("전처리 가공 완료");
      await refreshStatus();
    } catch (err) {
      setMessage(err.message || "전처리 가공 실패");
    } finally {
      setProcessing(false);
    }
  };

  const isInvoiceBarcode = (s) => {
    const t = (s || "").toString().toUpperCase().replace(/\s+/g, "");
    return /^SB\d{10,}$/.test(t);
  };

  const handleScan = async () => {
    const raw = scanText.trim();
    const value = toEnglishKey(raw);
    if (!value) return;
    const toInvoice = !currentInvoice || isInvoiceBarcode(value);
    const url = toInvoice ? `${API}/amood/scan/invoice` : `${API}/amood/scan/item`;
    const key = toInvoice ? "invoice" : "code";

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ [key]: value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "스캔 실패");

      if (toInvoice) {
        if (data.ok === false) {
          const reason = data.result === "NO_ORDER_KEY"
            ? "주문번호 없음 (엑셀1 C열 확인)"
            : data.result === "NO_ITEMS"
            ? "주문번호는 찾았지만 엑셀2에 매칭되는 상품 없음"
            : "송장 없음";
          pushLog(`${reason}: ${value}`);
          setCurrentInvoice(null);
          setItems([]);
          setCurrentNext(null);
          setInvoiceHasDefect(false);
          setInvoiceDone(false);
        } else {
          setCurrentInvoice(data.invoice);
          setItems(data.items ?? []);
          setCurrentNext(data.current_next ?? null);
          setInvoiceHasDefect(!!data.invoice_has_defect);
          setInvoiceDone(!!data.invoice_done);
          if (data.invoice_has_defect) {
            playSound("invoiceDefect");
          }
          pushLog(`송장 SET: ${data.invoice}`);
        }
      } else {
        if (data.ok === false && data.result === "NO_INVOICE") {
          pushLog("송장을 먼저 스캔하세요.");
          setCurrentInvoice(null);
          setItems([]);
          setCurrentNext(null);
          setInvoiceHasDefect(false);
          setInvoiceDone(false);
        } else if (data.result === "TRUE") {
          setItems(data.items ?? []);
          setCurrentNext(data.current_next ?? null);
          setInvoiceHasDefect(!!data.invoice_has_defect);
          if (data.invoice_done) {
            setInvoiceDone(true);
            playSound("invoiceDone");
            pushLog(`송장 완료: ${currentInvoice || ""}`.trim());
          } else if (data.remain === 0) {
            playSound("itemDone");
          } else {
            playSound("scanOk");
          }
          pushLog(`${data.item_has_defect ? "[불량] " : ""}TRUE ${data.code} (잔여 ${data.remain})`);
        } else {
          playSound("bad");
          pushLog(`FALSE ${data.code} (잔여 ${data.remain})`);
        }
      }
    } catch (err) {
      pushLog(`오류: ${err.message || ""}`.trim());
    } finally {
      setScanText("");
      setTimeout(() => scanRef.current?.focus(), 0);
    }
  };

  const renderItemLabel = (item) => {
    const name = (item.name || "").trim();
    const opt = (item.option || "").trim();
    if (!name && !opt) return "(상품명 없음)";

    // 합배송: 이지어드민이 " / "로 옵션을 합친 경우 이름도 분리해서 페어링
    if (opt.includes(" / ")) {
      const optParts = opt.split(" / ").map((s) => s.trim()).filter(Boolean);
      const nameParts = name.includes("/")
        ? name.split("/").map((s) => s.trim()).filter(Boolean)
        : name.split(" ").filter(Boolean);
      if (nameParts.length === optParts.length) {
        return nameParts.map((n, i) => `${n} ${optParts[i]}`).join(" / ");
      }
    }

    // 합배송: pd.read_html이 <br>을 \n으로 변환한 경우 - 줄바꿈 기준으로 이름·옵션 분리 후 페어링
    const nameLines = name.split("\n").map((s) => s.trim()).filter(Boolean);
    const optLines = opt.split("\n").map((s) => s.trim()).filter(Boolean);
    if (nameLines.length > 1 || optLines.length > 1) {
      if (nameLines.length === optLines.length) {
        return nameLines.map((n, i) => `${n} ${optLines[i]}`).join(" / ");
      }
      if (optLines.length > 1) {
        return [nameLines.join(" / "), optLines.join(" / ")].filter(Boolean).join(" ").trim() || "(상품명 없음)";
      }
      return [nameLines.join(" / "), opt].filter(Boolean).join(" ").trim() || "(상품명 없음)";
    }

    // 합배송: 옵션이 [X] [Y] [Z] 형태로 공백 구분된 경우 (이지어드민 일부 케이스)
    const bracketParts = opt.match(/\[[^\]]+\]/g);
    if (bracketParts && bracketParts.length > 1) {
      return [name, bracketParts.join(" / ")].filter(Boolean).join(" ").trim() || "(상품명 없음)";
    }

    // 이지어드민 합배송: J열(option)이 이미 "상품명 [옵션]" 형태로 이름을 포함한 경우 중복 방지
    if (name && opt.startsWith(name)) {
      return opt.trim() || "(상품명 없음)";
    }

    return [name, opt].filter(Boolean).join(" ").trim() || "(상품명 없음)";
  };

  const exportShipping = async () => {
    setProcessing(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/amood/export-shipping?format=json`, {
        method: "POST",
        headers: getAuthHeaders(),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "선적바코드 인쇄 데이터 생성 실패");
      const items = (data.rows || []).map((row) => ({
        title: String(row.Title ?? "").trim(),
        description: String(row.Description ?? "").trim(),
        barcodeText: String(row.Code ?? "").trim(),
      })).filter((item) => item.title || item.description || item.barcodeText);
      if (!items.length) throw new Error("인쇄할 선적바코드 데이터가 없습니다.");
      localStorage.setItem("amoodBarcodePrintItems", JSON.stringify({
        items,
        fileName: data.filename || "선적바코드_인쇄",
        createdAt: Date.now(),
      }));
      localStorage.setItem("testActiveTab", "amood-barcode");
      setMessage("선적바코드 인쇄 데이터 전달 완료");
      if (onOpenTestTab) onOpenTestTab();
    } catch (err) {
      setMessage(err.message || "선적바코드 인쇄 준비 실패");
    } finally {
      setProcessing(false);
    }
  };

  const transferHapbaeRemaining = async () => {
    setProcessing(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/amood/hapbae-remaining`, {
        method: "POST",
        headers: getAuthHeaders(),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.detail || "합배송 넘기기 실패");
      }
      const blob = await res.blob();
      const filename = getDownloadFilename(res, "아무드_합배송.xlsx");
      const file = new File([blob], filename, {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      if (onTransferAmoodHapbae) {
        onTransferAmoodHapbae(file);
      }
      const deletedRows = res.headers.get("x-deleted-rows");
      const remainingRows = res.headers.get("x-remaining-rows");
      setMessage(`합배송관리로 전달 완료${deletedRows ? ` (삭제 ${deletedRows}행` : ""}${remainingRows ? ` / 남은 ${remainingRows}행` : ""}${deletedRows || remainingRows ? ")" : ""}`);
    } catch (err) {
      setMessage(err.message || "합배송 넘기기 실패");
    } finally {
      setProcessing(false);
    }
  };

  const issueHbl = async () => {
    if (!window.confirm("SHIPPING_READYING 주문의 선적바코드를 일괄 발급합니다.\n(바코드 없는 주문에만 발급, 중복 충돌 시 삭제 후 재발급)\n\n진행하시겠습니까?")) return;
    setHblLoading(true);
    setHblResult(null);
    try {
      const res = await fetch(`${API}/pastelco/issue-hbl`, {
        method: "POST",
        headers: getAuthHeaders(),
      });
      const data = await res.json().catch(() => ({}));
      setHblResult(data);
    } catch (err) {
      setHblResult({ ok: false, error: err.message });
    } finally {
      setHblLoading(false);
    }
  };

  const resetUploads = async () => {
    setResetting(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/amood/reset`, {
        method: "POST",
        headers: getAuthHeaders(),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "초기화 실패");
      setStatus(data.status || null);
      setFile2(null);
      setApiCount(null);
      setScanText("");
      setCurrentInvoice(null);
      setItems([]);
      setCurrentNext(null);
      setInvoiceHasDefect(false);
      setInvoiceDone(false);
      setLog([]);
      setIncomingFile(null);
      setIncomingMsg("");
      setIncomingCodes(null);
      setIncomingTotal(null);
      setEasyadminBPreviewOpen(false);
      setEasyadminBPreviewText("");
      setEasyadminBCopyMessage("");
      setFileInputKey((v) => v + 1);
      setMessage("업로드 초기화 완료");
    } catch (err) {
      setMessage(err.message || "초기화 실패");
    } finally {
      setResetting(false);
    }
  };

  return (
    <div className={styles.page}>
      {easyadminBPreviewOpen && (
        <div className={styles.modalOverlay} onClick={() => setEasyadminBPreviewOpen(false)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <div>
                <h3 className={styles.modalTitle}>이지어드민 B열 목록</h3>
                <p className={styles.subtitle} style={{ marginTop: "0.25rem" }}>
                  업로드한 파일의 B열을 쉼표 기준으로 나눈 값입니다.
                </p>
              </div>
              <div className={styles.modalActions}>
                <button type="button" className={styles.secondaryBtn} onClick={copyEasyadminBPreview}>
                  복사
                </button>
                <button type="button" className={styles.secondaryBtn} onClick={() => setEasyadminBPreviewOpen(false)}>
                  닫기
                </button>
              </div>
            </div>
            {easyadminBCopyMessage && (
              <div className={styles.statusMsg}>
                <strong>{easyadminBCopyMessage}</strong>
              </div>
            )}
            <textarea
              readOnly
              value={easyadminBPreviewText}
              placeholder="표시할 B열 값이 없습니다."
              className={styles.scanInput}
              style={{ minHeight: "360px", resize: "vertical", lineHeight: 1.5 }}
            />
          </div>
        </div>
      )}
      <div className={styles.pageHeader}>
        <div>
          <h2 className={styles.title}>아무드</h2>
          <p className={styles.subtitle}>아무드 API 불러오기 + 이지어드민 엑셀 업로드 후 전처리 가공 실행</p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
          {headerExtra}
          <button type="button" className={styles.secondaryBtn} onClick={resetUploads} disabled={resetting}>
            {resetting ? "초기화 중..." : "업로드 초기화"}
          </button>
        </div>
      </div>
      <div className={styles.stack}>
        {/* 선적바코드 발급 */}
        <section className={styles.card}>
          <div className={styles.cardHeader}>
            <h3 className={styles.cardTitle}>선적바코드 발급</h3>
          </div>
          <div className={styles.uploadRow}>
            <button
              type="button"
              className={styles.primaryBtn}
              onClick={issueHbl}
              disabled={hblLoading}
            >
              {hblLoading ? "발급 중..." : "선적바코드 발급"}
            </button>
            {hblResult && (
              <span style={{ fontSize: "0.85rem", color: hblResult.ok ? "#15803d" : hblResult.issued > 0 ? "#b45309" : "#dc2626" }}>
                {hblResult.error && !hblResult.issued
                  ? `오류: ${hblResult.error}`
                  : `발급 ${hblResult.issued ?? 0}건 / 스킵 ${hblResult.skipped ?? 0}건 / 삭제 ${hblResult.deleted ?? 0}건`}
                {hblResult.errors?.length > 0 && (
                  <span style={{ color: "#dc2626", marginLeft: "0.5rem" }}
                    title={hblResult.errors.join("\n")}>
                    (오류 {hblResult.errors.length}건 ⚠)
                  </span>
                )}
              </span>
            )}
          </div>
        </section>

        {/* ① ② 엑셀 업로드 */}
        <section className={`${styles.card} ${styles.dualCard}`}>
          <div className={styles.dualGrid}>
            <div className={styles.dualItem}>
              <div className={styles.cardHeader}>
                <h3 className={styles.cardTitle}>① 아무드 (Pastelco API 자동)</h3>
                {status?.excel1_loaded && (
                  <span className={styles.pill} style={{ background: "rgba(34,197,94,0.12)", color: "#15803d" }}>불러옴</span>
                )}
                {apiCount !== null && !loadingApi && !loadingShippingApi && (
                  <span className={styles.pill}>{apiCount}건</span>
                )}
              </div>
              <div className={styles.uploadRow}>
                <button type="button" className={styles.primaryBtn} onClick={loadFromApi} disabled={loadingApi || loadingShippingApi}>
                  {loadingApi ? "불러오는 중..." : "API에서 불러오기"}
                </button>
                <button
                  type="button"
                  className={styles.primaryBtn}
                  onClick={loadFromShippingProcessingToday}
                  disabled={loadingApi || loadingShippingApi}
                >
                  {loadingShippingApi ? "불러오는 중..." : "배송중에서 불러오기"}
                </button>
              </div>
            </div>
            <div className={styles.dualItem}>
              <div className={styles.cardHeader}>
                <h3 className={styles.cardTitle}>② 이지어드민 엑셀</h3>
                {status?.excel2_loaded && (
                  <span className={styles.pill} style={{ background: "rgba(34,197,94,0.12)", color: "#15803d" }}>업로드됨</span>
                )}
              </div>
              <div className={styles.uploadRow}>
                <button
                  type="button"
                  className={styles.primaryBtn}
                  onClick={loadFromEzadmin}
                  disabled={loadingEzadmin || loading}
                >
                  {loadingEzadmin ? "불러오는 중..." : "API로 불러오기"}
                </button>
                {status?.ezadmin_saved_at && (
                  <span style={{ fontSize: "0.78rem", color: "var(--text-secondary)" }}>
                    저장 일시: {formatSavedAt(status.ezadmin_saved_at)}
                  </span>
                )}
              </div>
              {ezadminHistory.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem", marginTop: "0.4rem" }}>
                  <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>최근 불러온 이력</span>
                  {ezadminHistory.map((h) => (
                    <div
                      key={h.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "0.5rem",
                        fontSize: "0.78rem",
                        padding: "0.3rem 0.5rem",
                        border: "1px solid var(--border-color)",
                        borderRadius: "6px",
                      }}
                    >
                      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {h.file_name}
                      </span>
                      <span style={{ color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                        {formatSavedAt(h.saved_at)}
                      </span>
                      <button
                        type="button"
                        className={styles.secondaryBtn}
                        onClick={() => restoreEzadminHistory(h.id)}
                        disabled={restoringId === h.id}
                      >
                        {restoringId === h.id ? "복원 중..." : "복원"}
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className={styles.uploadRow}>
                <label className={styles.fileInput} style={{ flex: 1, justifyContent: "flex-start" }}>
                  <input
                    key={`file2-${fileInputKey}`}
                    type="file"
                    accept=".xlsx,.xls,.xlsm,.htm,.html"
                    onChange={(e) => setFile2(e.target.files?.[0] ?? null)}
                  />
                  {file2 ? file2.name : "파일 선택 (직접 업로드)"}
                </label>
                <button type="button" className={styles.primaryBtn} onClick={uploadExcel2} disabled={loading}>
                  업로드
                </button>
              </div>
              {mgmtNumbers.length >= 2 && (
                <div className={styles.uploadRow}>
                  <button
                    type="button"
                    className={styles.primaryBtn}
                    onClick={createHapbaePack}
                    disabled={packLoading}
                  >
                    {packLoading ? "합포 중..." : "합포만들기"}
                  </button>
                  <span style={{ fontSize: "0.82rem", color: "var(--text-muted)" }}>
                    seq: {mgmtNumbers[0]} / pack_seq: {mgmtNumbers.slice(1).join(", ")}
                  </span>
                </div>
              )}
            </div>
          </div>
        </section>

        {/* ③ 입고 파일 */}
        <section className={`${styles.card} ${styles.dualCard}`}>
          <div className={styles.cardHeader}>
            <h3 className={styles.cardTitle}>③ 입고 파일</h3>
            {loadingIncoming && <span className={styles.pill}>업로드 중...</span>}
            {incomingCodes !== null && !loadingIncoming && (
              <span className={styles.pill}>코드 {incomingCodes} · 수량 {incomingTotal ?? 0}</span>
            )}
          </div>
          <div className={styles.uploadRow}>
            <label className={styles.fileInput} style={{ flex: 1, justifyContent: "flex-start" }}>
              <input
                key={`incoming-${fileInputKey}`}
                type="file"
                accept=".xls,.xlsx"
                onChange={(e) => setIncomingFile(e.target.files?.[0] ?? null)}
              />
              {incomingFile ? incomingFile.name : "입고 파일 선택"}
            </label>
            <button type="button" className={styles.primaryBtn} onClick={uploadIncoming} disabled={loadingIncoming}>
              {loadingIncoming ? "업로드 중..." : "업로드"}
            </button>
          </div>
          {incomingMsg && (
            <div className={styles.statusMsg} style={{
              borderColor: incomingMsg.includes("실패") ? "rgba(220,53,69,0.4)" : "rgba(34,197,94,0.4)",
              backgroundColor: incomingMsg.includes("실패") ? "rgba(220,53,69,0.07)" : "rgba(34,197,94,0.07)",
            }}>
              <strong>{incomingMsg}</strong>
            </div>
          )}
        </section>

        {/* ④ 전처리 가공 */}
        <section className={styles.card}>
          <div className={styles.cardHeader}>
            <h3 className={styles.cardTitle}>④ 전처리 가공 / 선적바코드 인쇄</h3>
          </div>
          <div className={styles.uploadRow}>
            <button
              type="button"
              className={styles.primaryBtn}
              onClick={runPreprocess}
              disabled={processing || !status?.excel1_loaded || !status?.excel2_loaded}
            >
              {processing ? "전처리 중..." : "전처리 가공 실행"}
            </button>
            <button
              type="button"
              className={styles.secondaryBtn}
              onClick={exportShipping}
              disabled={processing || !status?.excel1_loaded || !status?.excel2_loaded}
            >
              {processing ? "인쇄 준비 중..." : "선적바코드 인쇄"}
            </button>
            <button
              type="button"
              className={styles.secondaryBtn}
              onClick={transferHapbaeRemaining}
              disabled={processing || !status?.excel1_loaded || !status?.excel2_loaded}
            >
              {processing ? "넘기는 중..." : "합배송 넘기기"}
            </button>
          </div>
          {message && (
            <div className={styles.statusMsg} style={{
              borderColor: message.includes("실패") ? "rgba(220,53,69,0.4)" : "rgba(34,197,94,0.4)",
              backgroundColor: message.includes("실패") ? "rgba(220,53,69,0.07)" : "rgba(34,197,94,0.07)",
            }}>
              <strong>{message}</strong>
            </div>
          )}
        </section>

        {/* ⑤ 스캔 */}
        <section className={styles.card}>
          <div className={styles.cardHeader}>
            <h3 className={styles.cardTitle}>⑤ 스캔</h3>
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
              placeholder="송장(SB...) 또는 상품 바코드를 스캔 후 Enter"
              className={styles.scanInput}
            />
            <button className={`${styles.primaryBtn} ${styles.scanBtn}`} onClick={handleScan}>
              스캔 처리
            </button>
          </div>
        </section>

        {/* 프리뷰 */}
        <section className={styles.card} style={{ background: "var(--bg-secondary)" }}>
          <div className={styles.cardHeader}>
            <h3 className={styles.cardTitle}>프리뷰</h3>
            {currentInvoice && (
              <span className={styles.pill} style={invoiceDone
                ? { background: "rgba(34,197,94,0.15)", color: "#15803d", border: "1px solid rgba(34,197,94,0.3)" }
                : {}}>
                {invoiceDone ? "✓ 완료됨" : `송장 ${currentInvoice}`}
              </span>
            )}
            {currentInvoice && invoiceHasDefect && (
              <span className={styles.inlineTagDanger}>불량 포함</span>
            )}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            {/* 현재 상품 */}
            <div style={{
              borderRadius: "var(--radius-md)",
              border: invoiceDone ? "1px solid rgba(34,197,94,0.4)" : "1px solid var(--border-color)",
              background: "var(--bg-primary)",
              padding: "1.9rem 1.8rem",
              minHeight: "170px",
              display: "flex",
              flexDirection: "column",
              gap: "0.5rem",
              justifyContent: "center",
            }}>
              <span className={styles.infoLabel} style={{ fontSize: "1.05rem", letterSpacing: "0.06em" }}>현재 상품</span>
              {items.length > 0 ? (
                <div style={{ display: "flex", flexDirection: "column", gap: "0.85rem" }}>
                  {items.map((item, idx) => (
                    <div key={`${item.code}-${idx}`} style={{
                      paddingBottom: idx < items.length - 1 ? "0.75rem" : 0,
                      borderBottom: idx < items.length - 1 ? "1px dashed var(--border-color)" : "none",
                      opacity: item.remain === 0 ? 0.4 : 1,
                    }}>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem", flexWrap: "wrap" }}>
                        <span style={{ fontWeight: 700, fontSize: "1.95rem", lineHeight: 1.4, overflowWrap: "anywhere" }}>
                          {renderItemLabel(item)}
                        </span>
                        {item.incoming > 0 && (
                          <span className={styles.inlineTagIncoming} style={{ fontSize: "1.05rem", padding: "0.36rem 0.8rem" }}>
                            입고 {item.incoming}
                          </span>
                        )}
                        {item.defect > 0 && (
                          <span className={styles.inlineTagDanger} style={{ fontSize: "1.05rem", padding: "0.36rem 0.8rem" }}>
                            불량 {item.defect}
                          </span>
                        )}
                        {item.remain >= 2 && (
                          <span className={styles.inlineMeta} style={{ fontSize: "1.15rem" }}>잔여 {item.remain}</span>
                        )}
                        {item.remain === 0 && (
                          <span className={styles.doneBadge} style={{ fontSize: "1.05rem", padding: "0.36rem 0.8rem" }}>완료</span>
                        )}
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
              gap: "0.5rem",
            }}>
              <span className={`${styles.infoLabel} ${styles.infoLabelMuted}`}>다음 상품</span>
              {currentNext ? (
                <span style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem", flexWrap: "wrap" }}>
                  <span style={{ fontWeight: 700, fontSize: "1.2rem", overflowWrap: "anywhere", color: "var(--text-secondary)" }}>
                    {renderItemLabel(currentNext)}
                  </span>
                  {currentNext.incoming > 0 && (
                    <span className={styles.inlineTagIncoming}>입고 {currentNext.incoming}</span>
                  )}
                  {currentNext.defect > 0 && (
                    <span className={styles.inlineTagDanger}>불량 {currentNext.defect}</span>
                  )}
                  {currentNext.remain >= 2 && (
                    <span className={styles.inlineMeta}>잔여 {currentNext.remain}</span>
                  )}
                </span>
              ) : (
                <span style={{ color: "var(--text-muted)", fontSize: "1rem" }}>-</span>
              )}
            </div>
          </div>
        </section>

        {/* 결과 로그 */}
        <section className={styles.card}>
          <div className={styles.cardHeader}>
            <h3 className={styles.cardTitle}>결과 로그</h3>
            <span className={styles.pill}>최근 {Math.min(log.length, 12)}개</span>
          </div>
          <div className={styles.logBox}>
            {log.length === 0 ? (
              <div className={styles.empty}>아직 없음</div>
            ) : (
              log.map((l, i) => (
                <div key={i} className={styles.logLine}>{l}</div>
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
