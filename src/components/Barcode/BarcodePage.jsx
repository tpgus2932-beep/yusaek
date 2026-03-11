import { useEffect, useRef, useState } from "react";
import styles from "./BarcodePage.module.css";
import * as XLSX from "xlsx";
const API = `http://${window.location.hostname}:8000`;

const getAuthHeaders = () => {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
};

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
  return out;
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
  const [currentNext, setCurrentNext] = useState(null);
  const [log, setLog] = useState([]);
  const [items, setItems] = useState([]);
  const [nextPreview, setNextPreview] = useState(null);
  const [defectMode, setDefectMode] = useState(false);
  const [showDefectList, setShowDefectList] = useState(false);
  const [defectList, setDefectList] = useState([]);
  const soundsRef = useRef(null);

  const pushLog = (msg) => setLog((prev) => [msg, ...prev]);
  const displayLog = log.slice(0, 12);

  const downloadLogExcel = () => {
    if (!log.length) { alert("로그가 없습니다."); return; }
    const rows = [["번호", "로그"], ...log.map((text, idx) => [idx + 1, text])];
    const ws = XLSX.utils.aoa_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "결과로그");
    XLSX.writeFile(wb, "barcode_result_log.xlsx");
  };

  const handleUnauthorized = (res) => {
    if (res.status === 401) { localStorage.removeItem("token"); window.location.reload(); return true; }
    return false;
  };

  const refreshStatus = async () => {
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
        setCurrentNext(data.current_next ?? null);
        setNextPreview(data.next_preview ?? null);
        if (data.current_invoice) setItems(data.items ?? []);
        else if (Array.isArray(data.items) && data.items.length > 0) setItems(data.items);
        setDefectList(data.defects ?? defectList);
      } else {
        setCurrentInvoice(null); setInvoiceDone(false);
        setCurrentNext(null); setNextPreview(null);
      }
    } catch { /* ignore */ }
  };

  useEffect(() => { refreshStatus(); setTimeout(() => scanRef.current?.focus(), 50); }, []);

  useEffect(() => {
    if (!soundsRef.current) {
      soundsRef.current = {
        invoiceDone: new Audio("/sounds/zz.wav"),
        itemDone: new Audio("/sounds/xx.wav"),
        bad: new Audio("/sounds/dd.wav"),
        invoiceDefect: new Audio("/sounds/bb.wav"),
      };
    }
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
      setCurrentInvoice(null); setInvoiceDone(false); setCurrentNext(null);
      setItems([]); setNextPreview(null); setScanText("");
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
      pushLog(`불량 등록: ${data.code} (누적 ${data.defect_count})`);
    } catch (err) { pushLog(`불량 등록 실패: ${err.message || ""}`.trim()); }
    finally { setScanText(""); setTimeout(() => scanRef.current?.focus(), 0); }
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

      if (Object.prototype.hasOwnProperty.call(data, "current_next")) setCurrentNext(data.current_next ?? null);

      if (toInvoice) {
        if (data.ok === false && data.result === "NOT_FOUND") {
          pushLog(`송장 없음: ${value}`);
          setCurrentInvoice(null); setInvoiceDone(false); setCurrentNext(null); setItems([]); setNextPreview(null);
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
          setCurrentInvoice(null); setInvoiceDone(false); setCurrentNext(null); setItems([]); setNextPreview(null);
        } else if (data.result === "TRUE") {
          pushLog(`TRUE  ${data.code} (잔여 ${data.remain}) ${data.name || ""} ${data.option || ""}`.trim());
          setItems(data.items ?? []); setDefectList(data.defects ?? defectList);
          if (data.invoice_done) { playSound("invoiceDone"); pushLog(`송장 완료: ${data.invoice}`); setInvoiceDone(true); }
          else if (data.remain === 0) playSound("itemDone");
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

  const getDownloadFilename = (res) => {
    const disposition = res.headers.get("content-disposition") || "";
    const match = disposition.match(/filename\\*?=(?:UTF-8''|\"?)([^\";]+)/i);
    if (match?.[1]) return decodeURIComponent(match[1].replace(/\"/g, ""));
    return `defects_${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "")}.csv`;
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
      const filename = getDownloadFilename(res);
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

        {/* 스캔 + 프리뷰 - 2열 */}
        <div className={styles.dualGrid}>
          {/* 스캔 컨트롤 */}
          <section className={`${styles.card} ${styles.dualCard}`}
            style={defectMode ? { borderColor: "rgba(220,53,69,0.5)", boxShadow: "0 0 0 2px rgba(220,53,69,0.15)" } : {}}>
            <div className={styles.cardHeader}>
              <h3 className={styles.cardTitle}>스캔</h3>
              <div className={styles.headerActions}>
                <button className={styles.secondaryBtn} onClick={refreshStatus} title="새로고침">↺</button>
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
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
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

            {/* 최근 로그 (스캔 카드 내 미니) */}
            {log.length > 0 && (
              <div style={{ marginTop: "0.25rem" }}>
                <div className={styles.logBox} style={{ maxHeight: "160px" }}>
                  {displayLog.map((l, i) => (
                    <div key={i} className={styles.logLine}
                      style={{
                        color: i === 0
                          ? l.startsWith("FALSE") ? "#b42318"
                            : l.startsWith("TRUE") ? "#15803d"
                              : l.startsWith("불량") ? "#8a5b00"
                                : "inherit"
                          : "var(--text-secondary)",
                        fontWeight: i === 0 ? 700 : 400,
                      }}>
                      {l}
                    </div>
                  ))}
                </div>
                <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "0.4rem" }}>
                  <button className={styles.secondaryBtn} onClick={downloadLogExcel} style={{ fontSize: "0.8rem", padding: "0.35rem 0.7rem" }}>
                    엑셀 다운로드
                  </button>
                </div>
              </div>
            )}
          </section>

          {/* 프리뷰 패널 */}
          <section className={`${styles.card} ${styles.dualCard}`}
            style={{ background: "var(--bg-secondary)" }}>
            <div className={styles.cardHeader}>
              <h3 className={styles.cardTitle}>프리뷰</h3>
              {currentInvoice && (
                <span className={styles.pill} style={invoiceDone ? { background: "rgba(34,197,94,0.15)", color: "#15803d", border: "1px solid rgba(34,197,94,0.3)" } : {}}>
                  {invoiceDone ? "✓ 완료됨" : `송장 ${currentInvoice}`}
                </span>
              )}
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
              {/* 현재 상품 */}
              <div style={{
                borderRadius: "var(--radius-md)",
                border: "1px solid var(--border-color)",
                background: "var(--bg-primary)",
                padding: "1rem 1.25rem",
                minHeight: "120px",
                display: "flex",
                flexDirection: "column",
                gap: "0.5rem",
              }}>
                <span className={styles.infoLabel}>현재 상품</span>
                {items.length > 0 ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
                    {items.map((item, idx) => (
                      <div key={`${item.code}-${idx}`}
                        style={{
                          display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap",
                          paddingBottom: idx < items.length - 1 ? "0.6rem" : 0,
                          borderBottom: idx < items.length - 1 ? "1px dashed var(--border-color)" : "none",
                          opacity: item.remain === 0 ? 0.45 : 1,
                        }}>
                        <span style={{ fontWeight: 700, fontSize: "1.05rem", flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>
                          {renderItemLabel(item)}
                        </span>
                        {item.run_len > 1 && <span className={styles.inlineTagRun}>연속 {item.run_len}</span>}
                        {item.incoming > 0 && <span className={styles.inlineTagIncoming}>입고 {item.incoming}</span>}
                        {item.remain >= 2 && <span className={styles.inlineMeta}>잔여 {item.remain}</span>}
                        {item.defect > 0 && <span className={styles.inlineTagDanger}>불량 {item.defect}</span>}
                        {item.remain === 0 && <span className={styles.doneBadge}>완료</span>}
                      </div>
                    ))}
                  </div>
                ) : (
                  <span style={{ color: "var(--text-muted)", fontSize: "0.95rem" }}>
                    {currentInvoice ? "상품 없음" : "송장을 먼저 스캔하세요"}
                  </span>
                )}
              </div>

              {/* 다음 상품 */}
              <div style={{
                borderRadius: "var(--radius-md)",
                border: "1px dashed var(--border-color)",
                padding: "0.85rem 1.25rem",
                display: "flex",
                flexDirection: "column",
                gap: "0.35rem",
              }}>
                <span className={styles.infoLabel}>다음 상품</span>
                {nextPreview ? (
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                    <span style={{ fontWeight: 600, color: "var(--text-secondary)", flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>
                      {renderItemLabel(nextPreview)}
                    </span>
                    {nextPreview.run_len > 1 && <span className={styles.inlineTagRun}>연속 {nextPreview.run_len}</span>}
                    {nextPreview.incoming > 0 && <span className={styles.inlineTagIncoming}>입고 {nextPreview.incoming}</span>}
                    {nextPreview.remain >= 2 && <span className={styles.inlineMeta}>잔여 {nextPreview.remain}</span>}
                    {nextPreview.invoice && <span className={styles.inlineTag}>송장 {nextPreview.invoice}</span>}
                  </div>
                ) : (
                  <span style={{ color: "var(--text-muted)", fontSize: "0.9rem" }}>—</span>
                )}
              </div>
            </div>
          </section>
        </div>
      </div>

      {/* 불량 리스트 모달 */}
      {showDefectList && (
        <div className={styles.modalOverlay} onClick={() => setShowDefectList(false)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <h4 className={styles.modalTitle}>불량 리스트</h4>
              <div className={styles.modalActions}>
                <button className={styles.secondaryBtn} onClick={handleDefectExport}>내보내기</button>
                <button className={styles.secondaryBtn} onClick={() => setShowDefectList(false)}>닫기</button>
              </div>
            </div>
            {defectList.length === 0 ? (
              <div className={styles.empty}>등록된 불량이 없습니다.</div>
            ) : (
              <div className={styles.defectList}>
                {defectList.map((item, idx) => (
                  <div key={`${item.code}-defect-${idx}`} className={styles.defectLine}>
                    <span className={styles.defectText}>{renderItemLabel(item)}</span>
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
      )}
    </div>
  );
}
