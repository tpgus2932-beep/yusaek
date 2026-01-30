// src/components/Barcode/BarcodePage.jsx
import { useEffect, useRef, useState } from "react";

const API = "http://127.0.0.1:8000";

export default function BarcodePage() {
  // 업로드
  const [file, setFile] = useState(null);
  const [uploadMsg, setUploadMsg] = useState("");
  const [count, setCount] = useState(null);
  const [codesTotal, setCodesTotal] = useState(null);
  const [loadingUpload, setLoadingUpload] = useState(false);

  // 스캔(입력창 1개)
  const [scanText, setScanText] = useState("");
  const scanRef = useRef(null);
  const [currentInvoice, setCurrentInvoice] = useState(null);

  // UI 결과
  const [log, setLog] = useState([]);
  const [nextItem, setNextItem] = useState(null);

  const pushLog = (msg) => {
    setLog((prev) => [msg, ...prev].slice(0, 12));
  };

  // 서버 상태 확인
  const refreshStatus = async () => {
    try {
      const res = await fetch(`${API}/barcode/status`);
      const data = await res.json();
      if (data.loaded) {
        setCurrentInvoice(data.current_invoice ?? null);
      } else {
        setCurrentInvoice(null);
      }
    } catch {
      // 무시
    }
  };

  useEffect(() => {
    refreshStatus();
    setTimeout(() => scanRef.current?.focus(), 50);
  }, []);

  // 1) 엑셀 업로드
  const handleUpload = async () => {
    if (!file) {
      alert("엑셀 파일을 선택하세요");
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
        body: formData,
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "업로드 실패");

      setUploadMsg("업로드 완료");
      setCount(data.invoices ?? null);
      setCodesTotal(data.codes_total ?? null);
      pushLog(`✅ 업로드 완료 (송장 ${data.invoices ?? "-"} / 코드 ${data.codes_total ?? "-"})`);

      // 업로드 후 초기화
      setCurrentInvoice(null);
      setNextItem(null);
      setScanText("");
      setTimeout(() => scanRef.current?.focus(), 50);
    } catch (err) {
      setUploadMsg(`업로드 실패: ${err.message || ""}`.trim());
      pushLog(`❌ 업로드 실패: ${err.message || ""}`.trim());
    } finally {
      setLoadingUpload(false);
    }
  };

  // 송장처럼 보이는지(규칙은 필요하면 바꿔줄게)
  const isProbablyInvoice = (s) => {
    const t = (s || "").trim();
    return /^\d{10,}$/.test(t);
  };

  // 2) 스캔 처리(Enter)
  const handleScan = async () => {
    const value = scanText.trim();
    if (!value) return;

    // 현재 송장이 없으면 무조건 송장
    // 송장이 있으면: 긴 숫자면 송장 / 아니면 상품
    const toInvoice = !currentInvoice || isProbablyInvoice(value);

    const url = toInvoice
      ? `${API}/barcode/scan/invoice`
      : `${API}/barcode/scan/item`;

    const key = toInvoice ? "invoice" : "code";

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: value }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "처리 실패");

      // --- 송장 처리 ---
      if (toInvoice) {
        if (data.ok === false && data.result === "NOT_FOUND") {
          pushLog(`❌ 송장 없음: ${value}`);
          setCurrentInvoice(null);
          setNextItem(null);
        } else {
          setCurrentInvoice(data.invoice);
          setNextItem(data.next_item ?? null);
          pushLog(`📦 송장 SET: ${data.invoice}`);
        }
      }
      // --- 상품 처리 ---
      else {
        if (data.ok === false && data.result === "NO_INVOICE") {
          pushLog("⚠️ 먼저 송장을 스캔해야 함");
          setCurrentInvoice(null);
          setNextItem(null);
        } else if (data.result === "TRUE") {
          pushLog(
            `✅ TRUE  ${data.code} (남음 ${data.remain}) ${data.name || ""} ${data.option || ""}`.trim()
          );
          setNextItem(data.next_item ?? null);

          if (data.invoice_done) {
            pushLog(`🎉 송장 완료: ${data.invoice}`);
            setCurrentInvoice(null);
            setNextItem(null);
          }
        } else {
          pushLog(
            `❌ FALSE ${data.code} (남음 ${data.remain}) ${data.name || ""} ${data.option || ""}`.trim()
          );
        }
      }
    } catch (err) {
      pushLog(`❌ 오류: ${err.message || ""}`.trim());
    } finally {
      setScanText("");
      setTimeout(() => scanRef.current?.focus(), 0);
    }
  };

  return (
    <div style={{ maxWidth: 760 }}>
      <h2>Barcode</h2>
      <p>엑셀 업로드 → 송장/상품 스캔(Enter)</p>

      {/* 업로드 */}
      <div style={{ marginTop: 12, padding: 12, border: "1px solid #eee", borderRadius: 8 }}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>1) 엑셀 업로드</div>
        <input
          type="file"
          accept=".xls,.xlsx"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
        <button onClick={handleUpload} disabled={loadingUpload} style={{ marginLeft: 8 }}>
          {loadingUpload ? "업로드 중..." : "업로드"}
        </button>

        {uploadMsg && (
          <div style={{ marginTop: 8 }}>
            <strong>{uploadMsg}</strong>
          </div>
        )}
        {(count !== null || codesTotal !== null) && (
          <div style={{ marginTop: 8 }}>
            {count !== null && <div>송장 수: {count}</div>}
            {codesTotal !== null && <div>전체 코드 수: {codesTotal}</div>}
          </div>
        )}
      </div>

      {/* 스캔 */}
      <div style={{ marginTop: 12, padding: 12, border: "1px solid #eee", borderRadius: 8 }}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>2) 스캔</div>

        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <input
            ref={scanRef}
            value={scanText}
            onChange={(e) => setScanText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleScan();
            }}
            placeholder="송장 또는 상품 바코드 스캔 후 Enter"
            style={{ width: 420, padding: 8 }}
          />

          <button onClick={refreshStatus}>상태 새로고침</button>
        </div>

        <div style={{ marginTop: 10 }}>
          <div>
            <strong>현재 송장:</strong> {currentInvoice || "-"}
          </div>
          <div style={{ marginTop: 6 }}>
            <strong>다음 찍을 상품:</strong>{" "}
            {nextItem
              ? `${nextItem.code} (남음 ${nextItem.remain}) ${nextItem.name || ""} ${nextItem.option || ""}`.trim()
              : "-"}
          </div>
        </div>
      </div>

      {/* 로그 */}
      <div style={{ marginTop: 12, padding: 12, border: "1px solid #eee", borderRadius: 8 }}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>결과 로그</div>
        <div style={{ fontFamily: "monospace", fontSize: 13, whiteSpace: "pre-wrap" }}>
          {log.length === 0 ? "아직 없음" : log.map((l, i) => <div key={i}>{l}</div>)}
        </div>
      </div>
    </div>
  );
}
