import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEzadminSession } from "../../lib/EzadminSessionContext";
import pageStyles from "./BarcodePage.module.css";
import { LOCAL_API_BASE as API, getAuthHeaders, handleUnauthorized } from "../../lib/api";

function parseNumberSafe(value) {
  return Number(String(value ?? "").replace(/,/g, "").trim()) || 0;
}

function normalizePickupText(value) {
  return String(value || "").replace(/\s+/g, "").trim();
}

function hasMisongPickupMarker(value) {
  const normalized = normalizePickupText(value);
  return normalized.includes("미송픽업") || (normalized.includes("미송") && normalized.includes("픽업"));
}

function normalizeProductCode(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

// 이지어드민 입고전표(원본 엑셀) 행을 상품코드별로 모아, 미송픽업 마크가 하나라도 있었는지 판단한다.
function buildIncomingCodeInfo(rawData) {
  const dataRows = Array.isArray(rawData) ? rawData.slice(1) : [];
  const codeInfo = new Map();
  for (const row of dataRows) {
    const supplierProductName = String(row?.[0] ?? "").trim();
    const optionCell = String(row?.[1] ?? "").trim();
    const originalQty = parseNumberSafe(row?.[2]);
    const requestQty = parseNumberSafe(row?.[3]);
    const pickupText = String(row?.[4] ?? "").trim();
    const code = normalizeProductCode(row?.[5]);

    if (!supplierProductName && !optionCell && !originalQty && !requestQty && !pickupText) continue;
    if (/합\s*계/.test(supplierProductName)) continue;
    if (!code) continue;
    const qty = originalQty + requestQty;
    if (!qty) continue;

    const isPickup = hasMisongPickupMarker(pickupText);
    const prev = codeInfo.get(code);
    codeInfo.set(code, {
      hasPickup: Boolean(prev?.hasPickup) || isPickup,
      productName: prev?.productName || supplierProductName,
      qty: (prev?.qty || 0) + qty,
    });
  }
  return codeInfo;
}

export default function PostShipmentCancelPage({ headerExtra = null }) {
  const [items, setItems] = useState([]);
  const [date, setDate] = useState("");
  const [fetchedAt, setFetchedAt] = useState("");
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState("");
  const [scanText, setScanText] = useState("");
  const [matchedInvoices, setMatchedInvoices] = useState(new Set());
  const [lastScan, setLastScan] = useState(null);
  const scanRef = useRef(null);
  const soundRef = useRef(null);
  const { openModal: openEzadminModal } = useEzadminSession();

  const [verifyLoading, setVerifyLoading] = useState(false);
  const [verifyMessage, setVerifyMessage] = useState("");
  const [verifyResult, setVerifyResult] = useState(null);

  const [orderVerifyLoading, setOrderVerifyLoading] = useState(false);
  const [orderVerifyMessage, setOrderVerifyMessage] = useState("");
  const [orderVerifyResult, setOrderVerifyResult] = useState(null);

  const [misongVoucherLoading, setMisongVoucherLoading] = useState(false);
  const [misongVoucherList, setMisongVoucherList] = useState([]);
  const [showMisongVoucherModal, setShowMisongVoucherModal] = useState(false);
  const [selectedMisongSheets, setSelectedMisongSheets] = useState([]);
  const [misongCheckLoading, setMisongCheckLoading] = useState(false);
  const [misongCheckMessage, setMisongCheckMessage] = useState("");
  const [misongCheckResult, setMisongCheckResult] = useState(null);

  const [stockSmsLoading, setStockSmsLoading] = useState(false);
  const [stockSmsSending, setStockSmsSending] = useState(false);
  const [stockSmsMessage, setStockSmsMessage] = useState("");
  const [stockSmsPreview, setStockSmsPreview] = useState(null);
  const [stockSmsResult, setStockSmsResult] = useState(null);

  useEffect(() => {
    const pool = Array.from({ length: 3 }, () => new Audio("/sounds/ice.wav"));
    soundRef.current = pool;
  }, []);

  const playAlertSound = () => {
    const pool = soundRef.current;
    if (!pool || !pool.length) return;
    const audio = pool.find((a) => a.paused) || pool[0];
    audio.currentTime = 0;
    audio.play().catch(() => {});
  };

  const invoiceSet = useMemo(() => new Set(items.map((item) => item.invoice_no)), [items]);

  // DB에 저장된 목록만 읽어온다 - EZAdmin은 호출하지 않는다 (탭 진입 시).
  const loadSavedList = useCallback(async () => {
    setLoading(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/barcode/post-shipment-cancel/list`, { headers: getAuthHeaders() });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "배송후취소 목록 조회 실패");
      setItems(data.items ?? []);
      setDate(data.date ?? "");
      setFetchedAt(data.fetched_at ?? "");
      setMatchedInvoices(new Set());
      setLastScan(null);
    } catch (err) {
      setMessage(err.message || "배송후취소 목록 조회 실패");
    } finally {
      setLoading(false);
      setTimeout(() => scanRef.current?.focus(), 50);
    }
  }, []);

  useEffect(() => {
    loadSavedList();
  }, [loadSavedList]);

  // 새로고침 버튼 - 여기서만 실제 EZAdmin 조회 + 로컬 DB 저장이 일어난다.
  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/barcode/post-shipment-cancel/refresh`, {
        method: "POST",
        headers: getAuthHeaders(),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (data?.need_session) {
        openEzadminModal(handleRefresh);
        return;
      }
      if (!res.ok || !data.ok) throw new Error(data?.detail || "배송후취소 목록 조회 실패");
      setItems(data.items ?? []);
      setDate(data.date ?? "");
      setFetchedAt(data.fetched_at ?? "");
      setMatchedInvoices(new Set());
      setLastScan(null);
      setMessage(`${data.date ?? ""} 배송후취소 ${data.count ?? 0}건 조회 · 저장 완료`);
    } catch (err) {
      setMessage(err.message || "배송후취소 목록 조회 실패");
    } finally {
      setRefreshing(false);
      setTimeout(() => scanRef.current?.focus(), 50);
    }
  }, [openEzadminModal]);

  const handleVerifyIncoming = useCallback(async () => {
    setVerifyLoading(true);
    setVerifyMessage("");
    try {
      const res = await fetch(`${API}/barcode/incoming/verify-trans-in`, {
        method: "POST",
        headers: getAuthHeaders(),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (data?.need_session) {
        openEzadminModal(handleVerifyIncoming);
        return;
      }
      if (!res.ok || !data.ok) throw new Error(data?.detail || "입고파일 대조 실패");
      setVerifyResult(data);
      setVerifyMessage(
        `대조 완료: 입고파일 ${data.incoming_codes}건 중 이지어드민 입고 미확인 ${data.missing.length}건`
      );
    } catch (err) {
      setVerifyResult(null);
      setVerifyMessage(err.message || "입고파일 대조 실패");
    } finally {
      setVerifyLoading(false);
    }
  }, [openEzadminModal]);

  const handleVerifyOrderHistory = useCallback(async () => {
    setOrderVerifyLoading(true);
    setOrderVerifyMessage("");
    try {
      const res = await fetch(`${API}/barcode/incoming/verify-order-history`, {
        method: "POST",
        headers: getAuthHeaders(),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "발주내역 대조 실패");
      setOrderVerifyResult(data);
      setOrderVerifyMessage(
        `대조 완료: 입고파일 ${data.incoming_codes}건 중 ${data.date} 발주내역 미확인 ${data.missing.length}건`
      );
    } catch (err) {
      setOrderVerifyResult(null);
      setOrderVerifyMessage(err.message || "발주내역 대조 실패");
    } finally {
      setOrderVerifyLoading(false);
    }
  }, []);

  const handleOpenMisongVoucherPicker = useCallback(async () => {
    setMisongVoucherLoading(true);
    setMisongCheckMessage("");
    try {
      const res = await fetch(`${API}/barcode/incoming/ezadmin-voucher-list`, { headers: getAuthHeaders() });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (data?.need_session) {
        openEzadminModal(handleOpenMisongVoucherPicker);
        return;
      }
      if (!res.ok || !data?.ok) throw new Error(data?.detail || data?.error || "입고전표 목록 조회 실패");
      if (!data.vouchers?.length) {
        setMisongCheckMessage("오늘 입고전표가 없습니다.");
        return;
      }
      setMisongVoucherList(data.vouchers);
      setSelectedMisongSheets(data.vouchers.map((v) => String(v.sheet)));
      setShowMisongVoucherModal(true);
    } catch (err) {
      setMisongCheckMessage(err.message || "입고전표 목록 조회 실패");
    } finally {
      setMisongVoucherLoading(false);
    }
  }, [openEzadminModal]);

  const handleMisongVoucherConfirm = useCallback(async () => {
    if (!selectedMisongSheets.length) return;
    setShowMisongVoucherModal(false);
    setMisongCheckLoading(true);
    setMisongCheckMessage("입고전표 불러오는 중... (최대 60초)");
    setMisongCheckResult(null);
    try {
      const res = await fetch(`${API}/barcode/incoming/raw-file-from-ezadmin`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ sheet_list: selectedMisongSheets, page_code: "IM10_file" }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (data?.need_session) {
          openEzadminModal(handleOpenMisongVoucherPicker);
          return;
        }
        throw new Error(data?.error || data?.detail || "입고전표 다운로드 실패");
      }
      const arrayBuffer = await res.arrayBuffer();
      const XLSX = await import("xlsx");
      const workbook = XLSX.read(arrayBuffer, { type: "array" });
      const sheetName = workbook.SheetNames.find((name) => workbook.Sheets[name]?.["!ref"]) || workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const rawData = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
      const codeInfo = buildIncomingCodeInfo(rawData);

      const misongRes = await fetch(`${API}/noye-kimsungil/misong/items`, { headers: getAuthHeaders() });
      if (handleUnauthorized(misongRes)) return;
      const misongData = await misongRes.json().catch(() => ({}));
      if (!misongRes.ok || !misongData?.ok) throw new Error(misongData?.detail || "미송관리 목록 조회 실패");
      const misongItems = misongData.items || [];

      const flagged = [];
      misongItems.forEach((item) => {
        const code = normalizeProductCode(item.originalF);
        if (!code) return;
        const info = codeInfo.get(code);
        if (!info || info.hasPickup) return;
        flagged.push({
          code,
          supplier: item.A,
          productName: item.B || info.productName,
          color: item.D,
          size: item.E,
          misongQty: item.F,
          incomingQty: info.qty,
        });
      });

      setMisongCheckResult({ flagged, misongTotal: misongItems.length, incomingCodeCount: codeInfo.size });
      setMisongCheckMessage(
        `대조 완료(${selectedMisongSheets.length}개 전표): 미송관리 ${misongItems.length}건 중 미송픽업 없이 일반주문으로만 입고된 항목 ${flagged.length}건`
      );
    } catch (err) {
      setMisongCheckResult(null);
      setMisongCheckMessage(err.message || "미송 일반주문 대조 실패");
    } finally {
      setMisongCheckLoading(false);
    }
  }, [selectedMisongSheets, openEzadminModal, handleOpenMisongVoucherPicker]);

  const handleCheckStockSms = useCallback(async () => {
    setStockSmsLoading(true);
    setStockSmsMessage("");
    setStockSmsResult(null);
    try {
      const res = await fetch(`${API}/post-shipment-cancel-stock-sms/check`, {
        method: "POST",
        headers: getAuthHeaders(),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (data?.need_ezadmin_session) {
        openEzadminModal(handleCheckStockSms);
        return;
      }
      if (!res.ok || !data.ok) throw new Error(data?.detail || "조회 실패");
      setStockSmsPreview(data);
      setStockSmsMessage(
        data.checked_orders === 0
          ? "새로 확인할 배송후취소 주문이 없습니다."
          : `확인 ${data.checked_orders}건 · 재고있음(문자발송대상) ${data.with_stock.length}건 · 재고없음(취소완료대상) ${data.no_stock.length}건`
      );
    } catch (err) {
      setStockSmsPreview(null);
      setStockSmsMessage(err.message || "조회 실패");
    } finally {
      setStockSmsLoading(false);
    }
  }, [openEzadminModal]);

  const handleSendStockSms = useCallback(async () => {
    if (!stockSmsPreview) return;
    setStockSmsSending(true);
    setStockSmsMessage("");
    try {
      const res = await fetch(`${API}/post-shipment-cancel-stock-sms/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({
          with_stock: stockSmsPreview.with_stock,
          no_stock: stockSmsPreview.no_stock,
        }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "문자 보내기 실패");
      setStockSmsResult(data);
      setStockSmsPreview(null);
      setStockSmsMessage(
        `문자발송 ${data.sms_sent.length}건 · 취소완료처리 ${data.completed.length}건 · 실패 ${data.failed.length}건`
      );
    } catch (err) {
      setStockSmsMessage(err.message || "문자 보내기 실패");
    } finally {
      setStockSmsSending(false);
    }
  }, [stockSmsPreview]);

  const handleScan = () => {
    const value = scanText.trim();
    if (!value) return;
    const isMatch = invoiceSet.has(value);
    setLastScan({ invoice: value, matched: isMatch, at: new Date().toLocaleTimeString() });
    if (isMatch) {
      playAlertSound();
      setMatchedInvoices((prev) => new Set(prev).add(value));
    }
    setScanText("");
    setTimeout(() => scanRef.current?.focus(), 0);
  };

  return (
    <div className={pageStyles.page}>
      <div className={pageStyles.pageHeader}>
        <div>
          <h2 className={pageStyles.title}>배송후취소</h2>
          <p className={pageStyles.subtitle}>새로고침으로 EZAdmin 조회 · 로컬 DB 저장 · 바코드탭 송장 스캔 시 경고음 재생</p>
        </div>
        {headerExtra}
      </div>

      <div className={pageStyles.stack}>
        <section className={pageStyles.card}>
          <div className={pageStyles.cardHeader}>
            <h3 className={pageStyles.cardTitle}>{date ? `${date} 배송후취소 목록` : "배송후취소 목록"}</h3>
            <div className={pageStyles.headerActions}>
              <span className={pageStyles.pill}>{items.length}건</span>
              {fetchedAt && <span className={pageStyles.pill}>{new Date(fetchedAt).toLocaleTimeString()} 저장됨</span>}
              <button className={pageStyles.secondaryBtn} onClick={handleRefresh} disabled={loading || refreshing}>
                {refreshing ? "조회 중..." : "새로고침"}
              </button>
            </div>
          </div>

          {message && (
            <div
              className={pageStyles.statusMsg}
              style={{
                borderColor: message.includes("실패") ? "rgba(220,53,69,0.4)" : "rgba(34,197,94,0.4)",
                backgroundColor: message.includes("실패") ? "rgba(220,53,69,0.07)" : "rgba(34,197,94,0.07)",
              }}
            >
              <strong>{message}</strong>
            </div>
          )}

          <div className={pageStyles.scanRow}>
            <input
              ref={scanRef}
              className={pageStyles.scanInput}
              placeholder="송장번호 스캔 (테스트용)"
              value={scanText}
              onChange={(e) => setScanText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleScan(); } }}
              autoFocus
            />
          </div>

          {lastScan && (
            <div
              className={pageStyles.statusMsg}
              style={{
                borderColor: lastScan.matched ? "rgba(220,53,69,0.4)" : "rgba(148,163,184,0.4)",
                backgroundColor: lastScan.matched ? "rgba(220,53,69,0.07)" : "transparent",
              }}
            >
              <strong>
                {lastScan.matched
                  ? `⚠ 배송후취소 송장 감지: ${lastScan.invoice} (${lastScan.at})`
                  : `${lastScan.invoice} - 배송후취소 목록에 없음 (${lastScan.at})`}
              </strong>
            </div>
          )}

          <div className={pageStyles.tableWrap}>
            <table className={pageStyles.table}>
              <thead>
                <tr>
                  <th>송장번호</th>
                  <th>쇼핑몰</th>
                  <th>담당자</th>
                  <th>상품명</th>
                  <th>택배사</th>
                  <th>발송시각</th>
                  <th>취소시각</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr
                    key={item.seq || item.invoice_no}
                    className={matchedInvoices.has(item.invoice_no) ? pageStyles.checkedTableRow : ""}
                  >
                    <td>{item.invoice_no}</td>
                    <td>{item.shop}</td>
                    <td>{item.manager}</td>
                    <td>{item.product_name}</td>
                    <td>{item.carrier}</td>
                    <td>{item.ship_time}</td>
                    <td>{item.cancel_time}</td>
                  </tr>
                ))}
                {items.length === 0 && !loading && (
                  <tr>
                    <td colSpan={7}>저장된 배송후취소 목록이 없습니다. 새로고침을 눌러주세요.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className={pageStyles.card}>
          <div className={pageStyles.cardHeader}>
            <h3 className={pageStyles.cardTitle}>입고파일 대조 (이지어드민 미확인)</h3>
            <div className={pageStyles.headerActions}>
              {verifyResult && <span className={pageStyles.pill}>미확인 {verifyResult.missing.length}건</span>}
              <button className={pageStyles.secondaryBtn} onClick={handleVerifyIncoming} disabled={verifyLoading}>
                {verifyLoading ? "대조 중..." : "대조 실행"}
              </button>
            </div>
          </div>
          <p className={pageStyles.subtitle}>
            바코드 탭에서 불러온 입고 파일의 상품코드를, 이지어드민 오늘 입고(거래발생) 목록과 대조해
            이지어드민 쪽에서 안 잡히는 상품코드만 보여줍니다.
          </p>

          {verifyMessage && (
            <div
              className={pageStyles.statusMsg}
              style={{
                borderColor: verifyMessage.includes("실패") ? "rgba(220,53,69,0.4)" : "rgba(34,197,94,0.4)",
                backgroundColor: verifyMessage.includes("실패") ? "rgba(220,53,69,0.07)" : "rgba(34,197,94,0.07)",
              }}
            >
              <strong>{verifyMessage}</strong>
            </div>
          )}

          {verifyResult && (
            <div className={pageStyles.tableWrap}>
              <table className={pageStyles.table}>
                <thead>
                  <tr>
                    <th>상품코드</th>
                    <th>상품명</th>
                    <th>색상</th>
                    <th>사이즈</th>
                    <th>입고수량</th>
                  </tr>
                </thead>
                <tbody>
                  {verifyResult.missing.map((item) => (
                    <tr key={item.code}>
                      <td>{item.code}</td>
                      <td>{item.productName}</td>
                      <td>{item.color}</td>
                      <td>{item.size}</td>
                      <td>{item.incomingQty}</td>
                    </tr>
                  ))}
                  {verifyResult.missing.length === 0 && (
                    <tr>
                      <td colSpan={5}>입고파일의 모든 상품코드가 이지어드민 입고 목록에서 확인되었습니다.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className={pageStyles.card}>
          <div className={pageStyles.cardHeader}>
            <h3 className={pageStyles.cardTitle}>입고파일 대조 (전날 발주내역 미확인)</h3>
            <div className={pageStyles.headerActions}>
              {orderVerifyResult && <span className={pageStyles.pill}>미확인 {orderVerifyResult.missing.length}건</span>}
              <button className={pageStyles.secondaryBtn} onClick={handleVerifyOrderHistory} disabled={orderVerifyLoading}>
                {orderVerifyLoading ? "대조 중..." : "대조 실행"}
              </button>
            </div>
          </div>
          <p className={pageStyles.subtitle}>
            바코드 탭에서 불러온 입고 파일의 상품코드를, DB관리 &gt; 발주내역의 전날(어제) 등록분과 대조해
            전날 발주내역에서 안 잡히는 상품코드만 보여줍니다 (미송픽업 포함 전체 구분 기준).
          </p>

          {orderVerifyMessage && (
            <div
              className={pageStyles.statusMsg}
              style={{
                borderColor: orderVerifyMessage.includes("실패") ? "rgba(220,53,69,0.4)" : "rgba(34,197,94,0.4)",
                backgroundColor: orderVerifyMessage.includes("실패") ? "rgba(220,53,69,0.07)" : "rgba(34,197,94,0.07)",
              }}
            >
              <strong>{orderVerifyMessage}</strong>
            </div>
          )}

          {orderVerifyResult && (
            <div className={pageStyles.tableWrap}>
              <table className={pageStyles.table}>
                <thead>
                  <tr>
                    <th>상품코드</th>
                    <th>상품명</th>
                    <th>색상</th>
                    <th>사이즈</th>
                    <th>입고수량</th>
                  </tr>
                </thead>
                <tbody>
                  {orderVerifyResult.missing.map((item) => (
                    <tr key={item.code}>
                      <td>{item.code}</td>
                      <td>{item.productName}</td>
                      <td>{item.color}</td>
                      <td>{item.size}</td>
                      <td>{item.incomingQty}</td>
                    </tr>
                  ))}
                  {orderVerifyResult.missing.length === 0 && (
                    <tr>
                      <td colSpan={5}>입고파일의 모든 상품코드가 전날 발주내역에서 확인되었습니다.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className={pageStyles.card}>
          <div className={pageStyles.cardHeader}>
            <h3 className={pageStyles.cardTitle}>미송 일반주문 유입 확인</h3>
            <div className={pageStyles.headerActions}>
              {misongCheckResult && <span className={pageStyles.pill}>이상 {misongCheckResult.flagged.length}건</span>}
              <button
                className={pageStyles.secondaryBtn}
                onClick={handleOpenMisongVoucherPicker}
                disabled={misongVoucherLoading || misongCheckLoading}
              >
                {misongVoucherLoading ? "전표 조회 중..." : "이지어드민 입고전표 불러오기"}
              </button>
            </div>
          </div>
          <p className={pageStyles.subtitle}>
            이지어드민 오늘 입고전표를 불러와, 미송관리에 있는 상품이 미송픽업이 아니라 일반주문으로만 입고된 경우를 찾아냅니다
            (미송픽업이 함께 들어온 경우는 정상으로 보고 제외합니다).
          </p>

          {misongCheckMessage && (
            <div
              className={pageStyles.statusMsg}
              style={{
                borderColor: misongCheckMessage.includes("실패") ? "rgba(220,53,69,0.4)" : "rgba(34,197,94,0.4)",
                backgroundColor: misongCheckMessage.includes("실패") ? "rgba(220,53,69,0.07)" : "rgba(34,197,94,0.07)",
              }}
            >
              <strong>{misongCheckMessage}</strong>
            </div>
          )}

          {misongCheckResult && (
            <div className={pageStyles.tableWrap}>
              <table className={pageStyles.table}>
                <thead>
                  <tr>
                    <th>상품코드</th>
                    <th>공급처</th>
                    <th>상품명</th>
                    <th>색상</th>
                    <th>사이즈</th>
                    <th>미송수량</th>
                    <th>입고수량(일반)</th>
                  </tr>
                </thead>
                <tbody>
                  {misongCheckResult.flagged.map((row) => (
                    <tr key={row.code}>
                      <td>{row.code}</td>
                      <td>{row.supplier}</td>
                      <td>{row.productName}</td>
                      <td>{row.color}</td>
                      <td>{row.size}</td>
                      <td>{row.misongQty}</td>
                      <td>{row.incomingQty}</td>
                    </tr>
                  ))}
                  {misongCheckResult.flagged.length === 0 && (
                    <tr>
                      <td colSpan={7}>미송픽업 없이 일반주문으로만 들어온 항목이 없습니다.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className={pageStyles.card}>
          <div className={pageStyles.cardHeader}>
            <h3 className={pageStyles.cardTitle}>재고있는 취소주문 확인문자</h3>
            <div className={pageStyles.headerActions}>
              <button className={pageStyles.secondaryBtn} onClick={handleCheckStockSms} disabled={stockSmsLoading || stockSmsSending}>
                {stockSmsLoading ? "조회 중..." : "실행(목록 불러오기)"}
              </button>
              {stockSmsPreview && stockSmsPreview.checked_orders > 0 && (
                <button className={pageStyles.primaryBtn} onClick={handleSendStockSms} disabled={stockSmsSending}>
                  {stockSmsSending ? "처리 중..." : "문자 보내기"}
                </button>
              )}
            </div>
          </div>
          <p className={pageStyles.subtitle}>
            최근 30일간 에이블리 배송후취소 주문을 조회해, 상품코드(option_stock_sync_code)의
            이지어드민 재고(stock_normal)가 남아있는지 먼저 확인합니다. "문자 보내기"를 누르면
            재고가 남은 주문의 구매자에게 취소 여부를 묻는 문자를 발송하고, 재고가 없는 주문은 취소 완료 처리합니다.
            문자 발송/완료 처리된 주문은 다음 조회부터 자동으로 제외됩니다. (문자 템플릿: SMS 탭의 "배송후취소 확인문자")
          </p>

          {stockSmsMessage && (
            <div
              className={pageStyles.statusMsg}
              style={{
                borderColor: stockSmsMessage.includes("실패") ? "rgba(220,53,69,0.4)" : "rgba(34,197,94,0.4)",
                backgroundColor: stockSmsMessage.includes("실패") ? "rgba(220,53,69,0.07)" : "rgba(34,197,94,0.07)",
              }}
            >
              <strong>{stockSmsMessage}</strong>
            </div>
          )}

          {stockSmsResult?.need_ezdesk_session && (
            <div
              className={pageStyles.statusMsg}
              style={{ borderColor: "rgba(220,53,69,0.4)", backgroundColor: "rgba(220,53,69,0.07)" }}
            >
              <strong>EZDesk 세션이 만료되었습니다. 문자 발송이 안 된 건이 있으니 세션을 다시 붙여넣고 다시 실행 · 문자 보내기를 눌러주세요.</strong>
            </div>
          )}

          {stockSmsPreview && stockSmsPreview.checked_orders > 0 && (
            <div className={pageStyles.tableWrap}>
              <table className={pageStyles.table}>
                <thead>
                  <tr>
                    <th>주문번호</th>
                    <th>연락처</th>
                    <th>상품명</th>
                    <th>예정 처리</th>
                  </tr>
                </thead>
                <tbody>
                  {stockSmsPreview.with_stock.map((row) => (
                    <tr key={`pre-sms-${row.cancel_sno}`}>
                      <td>{row.order_sno}</td>
                      <td>{row.buyer_tel}</td>
                      <td>{row.product_names.join(", ")}</td>
                      <td>문자 발송 예정 (재고 있음)</td>
                    </tr>
                  ))}
                  {stockSmsPreview.no_stock.map((row) => (
                    <tr key={`pre-done-${row.cancel_sno}`}>
                      <td>{row.order_sno}</td>
                      <td>{row.buyer_tel}</td>
                      <td>{row.product_names.join(", ")}</td>
                      <td>취소 완료 처리 예정 (재고 없음)</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {stockSmsResult && (
            <div className={pageStyles.tableWrap}>
              <table className={pageStyles.table}>
                <thead>
                  <tr>
                    <th>주문번호</th>
                    <th>연락처</th>
                    <th>상품명</th>
                    <th>처리결과</th>
                  </tr>
                </thead>
                <tbody>
                  {stockSmsResult.sms_sent.map((row) => (
                    <tr key={`sms-${row.cancel_sno}`}>
                      <td>{row.order_sno}</td>
                      <td>{row.buyer_tel}</td>
                      <td>{row.product_names.join(", ")}</td>
                      <td>문자 발송됨 (재고 있음)</td>
                    </tr>
                  ))}
                  {stockSmsResult.completed.map((row) => (
                    <tr key={`done-${row.cancel_sno}`}>
                      <td>{row.order_sno}</td>
                      <td>{row.buyer_tel}</td>
                      <td>{row.product_names.join(", ")}</td>
                      <td>취소 완료 처리 (재고 없음)</td>
                    </tr>
                  ))}
                  {stockSmsResult.failed.map((row) => (
                    <tr key={`fail-${row.cancel_sno}`}>
                      <td>{row.order_sno}</td>
                      <td>{row.buyer_tel}</td>
                      <td>{row.product_names.join(", ")}</td>
                      <td>실패: {row.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      {showMisongVoucherModal && (
        <div className={pageStyles.modalOverlay} onClick={() => setShowMisongVoucherModal(false)}>
          <div className={pageStyles.modal} style={{ width: "min(480px, 92vw)" }} onClick={(e) => e.stopPropagation()}>
            <div className={pageStyles.modalHeader}>
              <span className={pageStyles.modalTitle}>입고전표 선택</span>
              <button type="button" className={pageStyles.secondaryBtn} onClick={() => setShowMisongVoucherModal(false)}>
                닫기
              </button>
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontWeight: 600, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={selectedMisongSheets.length === misongVoucherList.length && misongVoucherList.length > 0}
                onChange={(e) =>
                  setSelectedMisongSheets(e.target.checked ? misongVoucherList.map((v) => String(v.sheet)) : [])
                }
              />
              전체 선택 ({selectedMisongSheets.length}/{misongVoucherList.length})
            </label>
            <div
              style={{
                display: "flex", flexDirection: "column", gap: "0.1rem", maxHeight: 340, overflowY: "auto",
                border: "1px solid var(--border-color)", borderRadius: "var(--radius-sm)", padding: "0.25rem",
              }}
            >
              {misongVoucherList.map((v) => {
                const sheet = String(v.sheet);
                const checked = selectedMisongSheets.includes(sheet);
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
                        setSelectedMisongSheets((prev) => (checked ? prev.filter((s) => s !== sheet) : [...prev, sheet]))
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
              className={pageStyles.primaryBtn}
              onClick={handleMisongVoucherConfirm}
              disabled={!selectedMisongSheets.length}
            >
              {selectedMisongSheets.length}건 불러와서 대조
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
