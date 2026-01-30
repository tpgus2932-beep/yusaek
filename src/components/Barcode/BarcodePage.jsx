import { useEffect, useRef, useState } from "react";
import styles from "./BarcodePage.module.css";
const API = `http://${window.location.hostname}:8000`;

const getAuthHeaders = () => {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
};
export default function BarcodePage() {
  // 엑셀 업로드
  const [file, setFile] = useState(null);
  const [uploadMsg, setUploadMsg] = useState("");
  const [count, setCount] = useState(null);
  const [codesTotal, setCodesTotal] = useState(null);
  const [loadingUpload, setLoadingUpload] = useState(false);
  // 스캔 입력
  const [scanText, setScanText] = useState("");
  const scanRef = useRef(null);
  const [currentInvoice, setCurrentInvoice] = useState(null);
  // UI 결과
  const [log, setLog] = useState([]);
  const [items, setItems] = useState([]);
  const [nextPreview, setNextPreview] = useState(null);
  const [defectMode, setDefectMode] = useState(false);
  const [showDefectList, setShowDefectList] = useState(false);
  const [defectList, setDefectList] = useState([]);
  const soundsRef = useRef(null);
  const pushLog = (msg) => {
    setLog((prev) => [msg, ...prev].slice(0, 12));
  };

  const handleUnauthorized = (res) => {
    if (res.status === 401) {
      localStorage.removeItem("token");
      window.location.reload();
      return true;
    }
    return false;
  };
  // 서버 상태 확인
  const refreshStatus = async () => {
    try {
      const res = await fetch(`${API}/barcode/status`, { headers: getAuthHeaders() });
      if (handleUnauthorized(res)) return;
      const data = await res.json();
      if (data.loaded) {
        setCurrentInvoice(data.current_invoice ?? null);
        setNextPreview(data.next_preview ?? null);
        setItems(data.items ?? items);
        setDefectList(data.defects ?? defectList);
      } else {
        setCurrentInvoice(null);
        setNextPreview(null);
      }
    } catch {
      // 무시
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
        invoiceDefect: new Audio("/sounds/bb.wav"),
      };
    }
  }, []);
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === "F2") {
        event.preventDefault();
        setDefectMode((v) => !v);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  // 1) 엑셀 업로드
  const handleUpload = async () => {
    if (!file) {
      alert("엑셀 파일을 선택해주세요.");
      return;
    }
    const formData = new FormData();
    formData.append("file", file);
    try {
      setLoadingUpload(true);
      setUploadMsg("");
      setCount(null);
      setCodesTotal(null);
      const res = await fetch(`${API}/barcode/upload`, {
        method: "POST",
        headers: getAuthHeaders(),
        body: formData,
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "업로드 실패");
      setUploadMsg("업로드 완료");
      setCount(data.invoices ?? null);
      setCodesTotal(data.codes_total ?? null);
      pushLog(`업로드 완료 (송장 ${data.invoices ?? "-"} / 코드 ${data.codes_total ?? "-"})`);
      // 업로드 후 초기화
      setCurrentInvoice(null);
      setItems([]);
      setNextPreview(null);
      setScanText("");
      setTimeout(() => scanRef.current?.focus(), 50);
    } catch (err) {
      setUploadMsg(`업로드 실패: ${err.message || ""}`.trim());
      pushLog(`업로드 실패: ${err.message || ""}`.trim());
    } finally {
      setLoadingUpload(false);
    }
  };
  const isProbablyInvoice = (s) => {
    const t = (s || "").trim();
    return /^\d{10,}$/.test(t);
  };
  const handleDefectAdd = async () => {
    const value = scanText.trim();
    if (!value) return;
    try {
      const res = await fetch(`${API}/barcode/defect/add`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ code: value }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "불량 등록 실패");
      setItems(data.items ?? items);
      setNextPreview(data.next_preview ?? null);
      setDefectList(data.defects ?? defectList);
      pushLog(`불량 등록: ${data.code} (누적 ${data.defect_count})`);
    } catch (err) {
      pushLog(`불량 등록 실패: ${err.message || ""}`.trim());
    } finally {
      setScanText("");
      setTimeout(() => scanRef.current?.focus(), 0);
    }
  };
  // 2) 스캔 처리(Enter)
  // 2) ?? ??(Enter)
  // 2) ?? ??(Enter)
  const handleScan = async () => {
    const value = scanText.trim();
    if (!value) return;

    if (defectMode) {
      await handleDefectAdd();
      return;
    }

    const toInvoice = !currentInvoice || isProbablyInvoice(value);
    const url = toInvoice
      ? `${API}/barcode/scan/invoice`
      : `${API}/barcode/scan/item`;
    const key = toInvoice ? "invoice" : "code";

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ [key]: value }),
      });
      if (handleUnauthorized(res)) return;

      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "?? ??");

      if (toInvoice) {
        if (data.ok === false && data.result === "NOT_FOUND") {
          pushLog(`?? ??: ${value}`);
          setCurrentInvoice(null);
          setItems([]);
          setNextPreview(null);
        } else {
          setCurrentInvoice(data.invoice);
          setItems(data.items ?? []);
          setNextPreview(data.next_preview ?? null);
          setDefectList(data.defects ?? defectList);
          if (data.invoice_has_defect) {
            playSound("invoiceDefect");
          }
          pushLog(`?? SET: ${data.invoice}`);
        }
      } else {
        if (data.ok === false && data.result === "NO_INVOICE") {
          pushLog("?? ??? ???? ???.");
          setCurrentInvoice(null);
          setItems([]);
          setNextPreview(null);
        } else if (data.result === "TRUE") {
          pushLog(
            `TRUE  ${data.code} (?? ${data.remain}) ${data.name || ""} ${data.option || ""}`.trim()
          );
          setItems(data.items ?? []);
          setNextPreview(data.next_preview ?? null);
          setDefectList(data.defects ?? defectList);

          if (data.invoice_done) {
            playSound("invoiceDone");
            pushLog(`?? ??: ${data.invoice}`);
            setCurrentInvoice(null);
            setItems([]);
            setNextPreview(null);
          } else if (data.remain === 0) {
            playSound("itemDone");
          }
        } else {
          pushLog(
            `FALSE ${data.code} (?? ${data.remain}) ${data.name || ""} ${data.option || ""}`.trim()
          );
          setNextPreview(data.next_preview ?? null);
          setDefectList(data.defects ?? defectList);
          playSound("bad");
        }
      }
    } catch (err) {
      pushLog(`??: ${err.message || ""}`.trim());
    } finally {
      setScanText("");
      setTimeout(() => scanRef.current?.focus(), 0);
    }
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
    } catch {
      // 무시
    }
  };
  const handleDefectDec = async (code) => {
    try {
      const res = await fetch(`${API}/barcode/defect/dec`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ code }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "불량 감소 실패");
      setDefectList(data.defects ?? []);
      setItems(data.items ?? items);
      setNextPreview(data.next_preview ?? null);
    } catch (err) {
      pushLog(`불량 감소 실패: ${err.message || ""}`.trim());
    }
  };
  const handleDefectRemove = async (code) => {
    try {
      const res = await fetch(`${API}/barcode/defect/remove`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ code }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "불량 삭제 실패");
      setDefectList(data.defects ?? []);
      setItems(data.items ?? items);
      setNextPreview(data.next_preview ?? null);
    } catch (err) {
      pushLog(`불량 삭제 실패: ${err.message || ""}`.trim());
    }
  };
  const playSound = (key) => {
    const audio = soundsRef.current?.[key];
    if (!audio) return;
    audio.currentTime = 0;
    audio.play().catch(() => {});
  };
  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <div>
          <h2 className={styles.title}>Barcode</h2>
          <p className={styles.subtitle}>엑셀 업로드 후 송장/상품 스캔(Enter)</p>
        </div>
      </div>
      <div className={styles.stack}>
        <section className={styles.card}>
          <div className={styles.cardHeader}>
            <h3 className={styles.cardTitle}>1) 엑셀 업로드</h3>
            {loadingUpload && <span className={styles.pill}>업로드 중</span>}
          </div>
          <div className={styles.uploadRow}>
            <label className={styles.fileInput}>
              <input
                type="file"
                accept=".xls,.xlsx"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
              파일 선택
            </label>
            <button className={styles.primaryBtn} onClick={handleUpload} disabled={loadingUpload}>
              {loadingUpload ? "업로드 중.." : "업로드"}
            </button>
          </div>
          {uploadMsg && (
            <div className={styles.statusMsg}>
              <strong>{uploadMsg}</strong>
            </div>
          )}
          {(count !== null || codesTotal !== null) && (
            <div className={styles.metaGrid}>
              {count !== null && (
                <div className={styles.metaItem}>
                  <span className={styles.metaLabel}>송장 수</span>
                  <span className={styles.metaValue}>{count}</span>
                </div>
              )}
              {codesTotal !== null && (
                <div className={styles.metaItem}>
                  <span className={styles.metaLabel}>전체 코드 수</span>
                  <span className={styles.metaValue}>{codesTotal}</span>
                </div>
              )}
            </div>
          )}
        </section>
        <section className={styles.card}>
          <div className={styles.cardHeader}>
            <h3 className={styles.cardTitle}>2) 스캔</h3>
            <div className={styles.headerActions}>
              <button className={styles.secondaryBtn} onClick={refreshStatus}>
                상태 새로고침
              </button>
              <button
                className={`${styles.toggleBtn} ${defectMode ? styles.toggleOn : ""}`}
                onClick={() => setDefectMode((v) => !v)}
              >
                {defectMode ? "불량 모드 ON" : "불량 모드 OFF"}
              </button>
              <button
                className={styles.secondaryBtn}
                onClick={() => {
                  setShowDefectList(true);
                  fetchDefectList();
                }}
              >
                불량 리스트 보기
              </button>
            </div>
          </div>
          <div className={styles.scanRow}>
            <input
              ref={scanRef}
              value={scanText}
              onChange={(e) => setScanText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleScan();
              }}
              placeholder="송장 또는 상품 바코드 스캔 후 Enter"
              className={styles.scanInput}
            />
            <button className={`${styles.primaryBtn} ${styles.scanBtn}`} onClick={handleScan}>
              {defectMode ? "불량 추가" : "스캔 처리"}
            </button>
          </div>
          <div className={styles.infoStack}>
            <div className={styles.infoItem}>
              <span className={styles.infoLabel}>현재 송장</span>
              <span className={styles.infoValue}>{currentInvoice || "-"}</span>
            </div>
            <div className={styles.infoItem}>
              <span className={styles.infoLabel}>남은 상품</span>
              {items.length === 0 ? (
                <span className={styles.infoValue}>-</span>
              ) : (
                <div className={styles.infoList}>
                  {items.map((item, idx) => (
                    <div
                      key={`${item.code ?? "item"}-${idx}`}
                      className={`${styles.infoLine} ${
                        item.remain <= 0 ? styles.infoLineDone : ""
                      }`}
                    >
                      <span className={styles.infoText}>
                        {renderItemLabel(item)} {`(남음 ${item.remain})`}
                      </span>
                      {item.run_len > 1 && (
                        <span className={styles.inlineTag}>연속 {item.run_len}개</span>
                      )}
                      {item.defect > 0 && (
                        <span className={styles.inlineTagDanger}>불량 {item.defect}</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className={styles.infoItem}>
              <span className={styles.infoLabel}>다음 상품</span>
              {nextPreview ? (
                <div className={styles.infoValue}>
                  {`${renderItemLabel(nextPreview)} (남음 ${nextPreview.remain})`}
                  {nextPreview.run_len > 1 && (
                    <span className={styles.inlineTag}>연속상품 {nextPreview.run_len}개</span>
                  )}
                  {nextPreview.invoice && (
                    <span className={styles.inlineTag}>송장 {nextPreview.invoice}</span>
                  )}
                </div>
              ) : (
                <span className={styles.infoValue}>-</span>
              )}
            </div>
          </div>
        </section>
      </div>
      {showDefectList && (
        <div className={styles.modalOverlay} onClick={() => setShowDefectList(false)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <h4 className={styles.modalTitle}>불량 리스트</h4>
              <button className={styles.secondaryBtn} onClick={() => setShowDefectList(false)}>
                닫기
              </button>
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
                      <button
                        className={styles.ghostBtn}
                        onClick={() => handleDefectDec(item.code)}
                      >
                        -1
                      </button>
                      <button
                        className={styles.ghostBtn}
                        onClick={() => handleDefectRemove(item.code)}
                      >
                        삭제
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
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
  );
}
