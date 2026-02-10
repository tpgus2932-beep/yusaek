import React, { useEffect, useRef, useState } from "react";
import styles from "./BarcodePage.module.css";

const API = `http://${window.location.hostname}:8000`;

const getAuthHeaders = () => {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
};

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
  return out;
};

const getDownloadFilename = (res, fallback) => {
  const disposition = res.headers.get("content-disposition") || "";
  const match = disposition.match(/filename\\*?=(?:UTF-8''|\"?)([^\";]+)/i);
  if (match?.[1]) {
    return decodeURIComponent(match[1].replace(/\"/g, ""));
  }
  return fallback;
};

export default function AmoodBarcodePage({ headerExtra = null }) {
  const [file1, setFile1] = useState(null);
  const [file2, setFile2] = useState(null);
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
  const [log, setLog] = useState([]);
  const scanRef = useRef(null);
  const soundsRef = useRef(null);
  const [fileInputKey, setFileInputKey] = useState(0);

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
    setTimeout(() => scanRef.current?.focus(), 50);
  }, []);

  useEffect(() => {
    if (!soundsRef.current) {
      soundsRef.current = {
        invoiceDone: new Audio("/sounds/zz.wav"),
        itemDone: new Audio("/sounds/xx.wav"),
        bad: new Audio("/sounds/dd.wav"),
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
      setInvoiceDone(false);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    refreshScanStatus();
  }, []);

  const uploadExcel1 = async () => {
    if (!file1) {
      setMessage("아무드 엑셀을 선택해 주세요.");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      const formData = new FormData();
      formData.append("file", file1);
      const res = await fetch(`${API}/amood/excel1`, {
        method: "POST",
        headers: getAuthHeaders(),
        body: formData,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "아무드 엑셀 업로드 실패");
      setMessage("아무드 엑셀 업로드 완료");
      await refreshStatus();
    } catch (err) {
      setMessage(err.message || "아무드 엑셀 업로드 실패");
    } finally {
      setLoading(false);
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

  const downloadProcessed = async (which) => {
    try {
      const res = await fetch(`${API}/amood/download/${which}`, { headers: getAuthHeaders() });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.detail || "다운로드 실패");
      }
      const blob = await res.blob();
      const fallback = which === 1 ? "excel1_processed.xlsx" : "excel2_processed.xlsx";
      const filename = getDownloadFilename(res, fallback);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setMessage(err.message || "다운로드 실패");
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
        if (data.ok === false && data.result === "NOT_FOUND") {
          pushLog(`송장 없음: ${value}`);
          setCurrentInvoice(null);
          setItems([]);
          setCurrentNext(null);
          setInvoiceDone(false);
        } else {
          setCurrentInvoice(data.invoice);
          setItems(data.items ?? []);
          setCurrentNext(data.current_next ?? null);
          setInvoiceDone(false);
          pushLog(`송장 SET: ${data.invoice}`);
        }
      } else {
        if (data.ok === false && data.result === "NO_INVOICE") {
          pushLog("송장을 먼저 스캔하세요.");
          setCurrentInvoice(null);
          setItems([]);
          setCurrentNext(null);
          setInvoiceDone(false);
        } else if (data.result === "TRUE") {
          setItems(data.items ?? []);
          setCurrentNext(data.current_next ?? null);
          if (data.invoice_done) {
            setInvoiceDone(true);
            playSound("invoiceDone");
            pushLog(`송장 완료: ${currentInvoice || ""}`.trim());
          } else if (data.remain === 0) {
            playSound("itemDone");
          }
          pushLog(`TRUE ${data.code} (잔여 ${data.remain})`);
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

  const renderItemLabel = (item) =>
    [item.name, item.option].filter(Boolean).join(" ").trim() || "(상품명 없음)";

  const exportShipping = async () => {
    setProcessing(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/amood/export-shipping`, {
        method: "POST",
        headers: getAuthHeaders(),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.detail || "선적바코드 추출 실패");
      }
      const blob = await res.blob();
      const filename = getDownloadFilename(res, "선적바코드_추출.xlsx");
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setMessage("선적바코드 추출 완료");
    } catch (err) {
      setMessage(err.message || "선적바코드 추출 실패");
    } finally {
      setProcessing(false);
    }
  };

  const processedReady = !!status?.processed;

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
      setFile1(null);
      setFile2(null);
      setScanText("");
      setCurrentInvoice(null);
      setItems([]);
      setCurrentNext(null);
      setInvoiceDone(false);
      setLog([]);
      setIncomingFile(null);
      setIncomingMsg("");
      setIncomingCodes(null);
      setIncomingTotal(null);
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
      <div className={styles.pageHeader}>
        <div>
          <h2 className={styles.title}>아무드</h2>
          <p className={styles.subtitle}>아무드/이지어드민 엑셀 업로드 후 전처리 가공 실행</p>
        </div>
        {headerExtra}
      </div>
      <div className={styles.uploadRow}>
        <button type="button" className={styles.secondaryBtn} onClick={resetUploads} disabled={resetting}>
          {resetting ? "초기화 중..." : "업로드 초기화"}
        </button>
      </div>
      <div className={styles.stack}>
        <section className={`${styles.card} ${styles.dualCard}`}>
          <div className={styles.dualGrid}>
            <div className={styles.dualItem}>
              <div className={styles.cardHeader}>
                <h3 className={styles.cardTitle}>아무드 엑셀</h3>
              </div>
              <div className={styles.uploadRow}>
                <label className={styles.fileInput}>
                  <input
                    key={`file1-${fileInputKey}`}
                    type="file"
                    accept=".xlsx,.xlsm"
                    onChange={(e) => setFile1(e.target.files?.[0] ?? null)}
                  />
                  파일 선택
                </label>
                <button type="button" className={styles.primaryBtn} onClick={uploadExcel1} disabled={loading}>
                  업로드
                </button>
              </div>
              {status?.excel1_loaded && <div className={styles.statusMsg}>업로드 완료</div>}
            </div>
            <div className={styles.dualItem}>
              <div className={styles.cardHeader}>
                <h3 className={styles.cardTitle}>이지어드민 엑셀</h3>
              </div>
              <div className={styles.uploadRow}>
                <label className={styles.fileInput}>
                  <input
                    key={`file2-${fileInputKey}`}
                    type="file"
                    accept=".xlsx,.xls,.xlsm,.htm,.html"
                    onChange={(e) => setFile2(e.target.files?.[0] ?? null)}
                  />
                  파일 선택
                </label>
                <button type="button" className={styles.primaryBtn} onClick={uploadExcel2} disabled={loading}>
                  업로드
                </button>
              </div>
              {status?.excel2_loaded && <div className={styles.statusMsg}>업로드 완료</div>}
            </div>
          </div>
        </section>

        <section className={styles.card}>
          <div className={styles.cardHeader}>
            <h3 className={styles.cardTitle}>입고 파일 업로드</h3>
          </div>
          <div className={styles.uploadRow}>
            <label className={styles.fileInput}>
              <input
                key={`incoming-${fileInputKey}`}
                type="file"
                accept=".xls,.xlsx"
                onChange={(e) => setIncomingFile(e.target.files?.[0] ?? null)}
              />
              입고 파일 선택
            </label>
            <button type="button" className={styles.primaryBtn} onClick={uploadIncoming} disabled={loadingIncoming}>
              {loadingIncoming ? "업로드 중..." : "업로드"}
            </button>
          </div>
          {incomingMsg && (
            <div className={styles.statusMsg}>
              <strong>{incomingMsg}</strong>
            </div>
          )}
          {(incomingCodes !== null || incomingTotal !== null) && (
            <div className={styles.metaGrid}>
              {incomingCodes !== null && (
                <div className={styles.metaItem}>
                  <span className={styles.metaLabel}>입고 코드 수</span>
                  <span className={styles.metaValue}>{incomingCodes}</span>
                </div>
              )}
              {incomingTotal !== null && (
                <div className={styles.metaItem}>
                  <span className={styles.metaLabel}>입고 수량</span>
                  <span className={styles.metaValue}>{incomingTotal}</span>
                </div>
              )}
            </div>
          )}
        </section>

        <section className={styles.card}>
          <div className={styles.cardHeader}>
            <h3 className={styles.cardTitle}>3) 전처리 가공 / 선적바코드 추출</h3>
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
              {processing ? "추출 중..." : "선적바코드 추출"}
            </button>
            {processedReady && (
              <>
                <button type="button" className={styles.secondaryBtn} onClick={() => downloadProcessed(1)}>
                  첫번째 결과 다운로드
                </button>
                <button type="button" className={styles.secondaryBtn} onClick={() => downloadProcessed(2)}>
                  두번째 결과 다운로드
                </button>
              </>
            )}
          </div>
        </section>

        <section className={styles.card}>
          <div className={styles.cardHeader}>
            <h3 className={styles.cardTitle}>5) 스캔</h3>
          </div>
          <div className={styles.scanRow}>
            <input
              ref={scanRef}
              value={scanText}
              onChange={(e) => setScanText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleScan();
              }}
              placeholder="송장(SB...) 또는 상품 바코드를 스캔 후 Enter"
              className={styles.scanInput}
            />
            <button className={`${styles.primaryBtn} ${styles.scanBtn}`} onClick={handleScan}>
              스캔 처리
            </button>
          </div>
          <div className={styles.infoStack}>
            <div className={styles.infoItem}>
              <span className={`${styles.infoLabel} ${styles.infoLabelMuted}`}>현재 송장</span>
              <span className={`${styles.infoValue} ${styles.infoValueMuted}`}>
                {currentInvoice || "-"}
                {invoiceDone && <span className={styles.doneBadge}>완료됨</span>}
              </span>
            </div>
            <div className={`${styles.infoItem} ${styles.infoItemLarge} ${styles.infoItemCurrent}`}>
              <span className={styles.infoLabel}>현재 상품</span>
              {items.length > 0 ? (
                <div className={`${styles.infoValue} ${styles.infoValueLarge} ${styles.infoValueCurrent}`}>
                  <div className={`${styles.infoList} ${styles.infoListLarge} ${styles.infoListCurrent}`}>
                    {items.map((item, idx) => (
                      <div
                        key={`${item.code}-${idx}`}
                        className={`${styles.infoLine} ${item.remain === 0 ? styles.infoLineDone : ""}`}
                      >
                        <span className={`${styles.infoText} ${styles.infoTextLarge} ${styles.infoTextCurrent}`}>
                          {renderItemLabel(item)}
                        </span>
                        {item.incoming > 0 && (
                          <span className={styles.inlineTagIncoming}>입고 {item.incoming}</span>
                        )}
                        {item.remain >= 2 && (
                          <span className={styles.inlineMeta}>(잔여 {item.remain})</span>
                        )}
                        {item.remain === 0 && <span className={styles.doneBadge}>완료됨</span>}
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <span className={`${styles.infoValue} ${styles.infoValueLarge} ${styles.infoValueCurrent}`}>
                  -
                </span>
              )}
            </div>
            <div className={`${styles.infoItem} ${styles.infoItemLarge}`}>
              <span className={`${styles.infoLabel} ${styles.infoLabelMuted}`}>다음 상품</span>
              {currentNext ? (
                <div className={`${styles.infoValue} ${styles.infoValueLarge} ${styles.infoValueMuted}`}>
                  {renderItemLabel(currentNext)}
                  {currentNext.incoming > 0 && (
                    <span className={styles.inlineTagIncoming}>입고 {currentNext.incoming}</span>
                  )}
                  {currentNext.remain >= 2 && (
                    <span className={styles.inlineMeta}>(잔여 {currentNext.remain})</span>
                  )}
                </div>
              ) : (
                <span className={`${styles.infoValue} ${styles.infoValueLarge} ${styles.infoValueMuted}`}>-</span>
              )}
            </div>
          </div>
        </section>

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
                <div key={i} className={styles.logLine}>
                  {l}
                </div>
              ))
            )}
          </div>
        </section>
      </div>
      {message && (
        <div className={styles.statusMsg}>
          <strong>{message}</strong>
        </div>
      )}
    </div>
  );
}
