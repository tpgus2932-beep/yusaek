import React, { useEffect, useRef } from "react";
import purchaseManagerHtml from "./purchase-manager.html?raw";
import { LOCAL_API_BASE, getAuthHeaders } from "../../lib/api";

function normalizeCell(value) {
  return String(value ?? "").trim();
}

function formatExcelDate(value, XLSX) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const offset = value.getTimezoneOffset() * 60000;
    return new Date(value.getTime() - offset).toISOString().slice(0, 10);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    try {
      return XLSX.SSF.format("yyyy-mm-dd", value);
    } catch {
      return "";
    }
  }
  return normalizeCell(value);
}

function parseQty(value) {
  const qty = Number(String(value ?? "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(qty) ? qty : 0;
}

function parsePrice(value) {
  const price = Number(String(value ?? "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(price) ? price : 0;
}

function looksLikeHeader(row) {
  const text = row.map((cell) => normalizeCell(cell)).join(" ");
  return text.includes("거래처") && (text.includes("상품명") || text.includes("거래처상품명"));
}

export default function PurchaseManager() {
  const iframeRef = useRef(null);
  const fileInputRef = useRef(null);
  const saveQueueRef = useRef(Promise.resolve());

  useEffect(() => {
    const handleMessage = async (event) => {
      if (event.source !== iframeRef.current?.contentWindow) return;

      if (event.data?.type === "purchase-manager-open-excel") {
        fileInputRef.current?.click();
        return;
      }
      if (event.data?.type === "purchase-manager-load-state") {
        try {
          const res = await fetch(`${LOCAL_API_BASE}/noye-kimsungil/purchase-manager/state`, {
            headers: getAuthHeaders(),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.detail || "매입관리 데이터를 불러오지 못했습니다.");
          event.source?.postMessage({ type: "purchase-manager-state", state: data.state }, "*");
        } catch (error) {
          event.source?.postMessage({
            type: "purchase-manager-state-error",
            message: error.message || "매입관리 데이터를 불러오지 못했습니다.",
          }, "*");
        }
        return;
      }
      if (event.data?.type === "purchase-manager-save-state") {
        const state = event.data.state;
        saveQueueRef.current = saveQueueRef.current
          .catch(() => undefined)
          .then(async () => {
            const res = await fetch(`${LOCAL_API_BASE}/noye-kimsungil/purchase-manager/state`, {
              method: "PUT",
              headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
              body: JSON.stringify({ state }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.detail || "매입관리 데이터를 저장하지 못했습니다.");
          })
          .catch((error) => {
            event.source?.postMessage({
              type: "purchase-manager-state-error",
              message: error.message || "매입관리 데이터를 저장하지 못했습니다.",
            }, "*");
          });
        return;
      }
      if (event.data?.type !== "purchase-manager-request-today-janggi-vendors") return;

      try {
        const today = new Intl.DateTimeFormat("en-CA", {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          timeZone: "Asia/Seoul",
        }).format(new Date());
        const params = new URLSearchParams({ date: today, offset: "0", limit: "10000" });
        const res = await fetch(`${LOCAL_API_BASE}/wonbe/janggi/search?${params}`, {
          headers: getAuthHeaders(),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.detail || "오늘 날짜별장끼 목록을 불러오지 못했습니다.");
        const vendors = [...new Set((data.rows || []).map((row) => String(row["거래처"] || "").trim()).filter(Boolean))];
        event.source?.postMessage({
          type: "purchase-manager-today-janggi-vendors",
          date: today,
          vendors,
        }, "*");
      } catch (error) {
        event.source?.postMessage({
          type: "purchase-manager-today-janggi-error",
          message: error.message || "오늘 날짜별장끼 목록을 불러오지 못했습니다.",
        }, "*");
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  const sendToFrame = (payload) => {
    iframeRef.current?.contentWindow?.postMessage(payload, "*");
  };

  const handleFileChange = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    try {
      const XLSX = await import("xlsx");
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: "array", cellDates: true });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      if (!sheet) throw new Error("엑셀 시트를 찾을 수 없습니다.");

      const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
      const dataRows = rawRows.slice(looksLikeHeader(rawRows[0] || []) ? 1 : 0);
      const rows = dataRows
        .map((row, index) => ({
          rowNumber: index + (looksLikeHeader(rawRows[0] || []) ? 2 : 1),
          vendor: normalizeCell(row[0]),
          product: normalizeCell(row[1]),
          option: normalizeCell(row[2]),
          qty: parseQty(row[3]),
          price: parsePrice(row[4]),
          unitPrice: parseQty(row[3]) ? parsePrice(row[4]) / parseQty(row[3]) : parsePrice(row[4]),
          date: formatExcelDate(row[5], XLSX),
          note: normalizeCell(row[6]),
        }))
        .filter((row) => row.vendor || row.product || row.option || row.qty || row.price || row.date || row.note);

      if (!rows.length) throw new Error("등록할 행이 없습니다.");
      sendToFrame({ type: "purchase-manager-excel-rows", fileName: file.name, rows });
    } catch (error) {
      sendToFrame({
        type: "purchase-manager-excel-error",
        message: error.message || "엑셀 파일을 읽지 못했습니다.",
      });
    }
  };

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept=".xlsx,.xls,.csv"
        hidden
        onChange={handleFileChange}
      />
      <iframe
        ref={iframeRef}
        title="매입관리"
        srcDoc={purchaseManagerHtml}
        style={{
          width: "100%",
          minHeight: "calc(100vh - 220px)",
          height: "760px",
          border: 0,
          borderRadius: 8,
          background: "#f5f7fb",
        }}
      />
    </>
  );
}
