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
    if (!originalQty && !requestQty) continue;

    // 요청수량(D열)으로 들어온 건은 미송 자체의 입고이므로, 미송픽업 문구가 없어도 미송픽업과 동일하게 취급해 제외 대상으로 본다.
    const isMisongIncoming = hasMisongPickupMarker(pickupText) || requestQty > 0;
    const prev = codeInfo.get(code);
    codeInfo.set(code, {
      hasPickup: Boolean(prev?.hasPickup) || isMisongIncoming,
      productName: prev?.productName || supplierProductName,
      qty: (prev?.qty || 0) + originalQty, // 일반주문(원래수량)만 집계 - 요청수량은 미송 입고라 제외
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
  const [manualForm, setManualForm] = useState({ invoice_no: "" });
  const [manualSaving, setManualSaving] = useState(false);
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

  const [stockSmsLogs, setStockSmsLogs] = useState([]);
  const [stockSmsLogsLoading, setStockSmsLogsLoading] = useState(false);
  const [repliesChecking, setRepliesChecking] = useState(false);
  const [repliesMessage, setRepliesMessage] = useState("");
  const [closingSno, setClosingSno] = useState(null);
  const [withdrawingSno, setWithdrawingSno] = useState(null);
  const [withdrawRow, setWithdrawRow] = useState(null); // 취소철회 대상 발송내역 (주문 선택 모달)
  const [withdrawPhone, setWithdrawPhone] = useState("");
  const [withdrawPacks, setWithdrawPacks] = useState(null);
  const [withdrawPack, setWithdrawPack] = useState(null);
  const [withdrawLoading, setWithdrawLoading] = useState(false);
  const [withdrawError, setWithdrawError] = useState("");
  const [closeErrors, setCloseErrors] = useState({});
  const [deletingSno, setDeletingSno] = useState(null);
  const [replyDrafts, setReplyDrafts] = useState({});
  const [replyingSno, setReplyingSno] = useState(null);
  const [replyModalRow, setReplyModalRow] = useState(null);
  // 에이블리 '취소 조회' / '취소진행' / '보류'
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [shipLookup, setShipLookup] = useState({}); // id -> 조회 결과
  const [shipBusy, setShipBusy] = useState(() => new Set());
  const [shipDone, setShipDone] = useState(() => new Set());
  const [shipErrors, setShipErrors] = useState({}); // id -> 취소진행 실패 메시지

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
      setSelectedIds(new Set());
      setShipLookup({});
      setShipDone(new Set());
      setShipErrors({});
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
      const flaggedCodes = new Set(); // 같은 상품이 미송관리에 여러 건 있어도 한 번만 표시
      misongItems.forEach((item) => {
        const code = normalizeProductCode(item.originalF);
        if (!code || flaggedCodes.has(code)) return;
        const info = codeInfo.get(code);
        if (!info || info.hasPickup) return;
        flaggedCodes.add(code);
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

  // 발송내역(문자 보냈던 리스트) - action='sms_sent' 이면서 완료 처리 안 된 건만 보여준다.
  // "완료" 버튼을 누르기 전까지는 로컬 DB에 그대로 남아 목록에서 지워지지 않는다.
  const loadStockSmsLogs = useCallback(async () => {
    setStockSmsLogsLoading(true);
    try {
      const res = await fetch(`${API}/post-shipment-cancel-stock-sms/logs?limit=200`, { headers: getAuthHeaders() });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "발송내역 조회 실패");
      // withdrawn = 에이블리 철회까지만 끝나고 이지어드민 단계가 남은 건 (같은 버튼으로 이어서 재시도)
      setStockSmsLogs((data.items ?? []).filter((item) => ["sms_sent", "withdrawn"].includes(item.action) && !item.closed_at));
    } catch (err) {
      setRepliesMessage(err.message || "발송내역 조회 실패");
    } finally {
      setStockSmsLogsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStockSmsLogs();
  }, [loadStockSmsLogs]);

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
      loadStockSmsLogs();
    } catch (err) {
      setStockSmsMessage(err.message || "문자 보내기 실패");
    } finally {
      setStockSmsSending(false);
    }
  }, [stockSmsPreview, loadStockSmsLogs]);

  // 수신확인 버튼 - 문자 보냈던 리스트를 이지데스크에서 다시 조회해 수신된 답장을 긁어온다.
  const handleCheckReplies = useCallback(async () => {
    setRepliesChecking(true);
    setRepliesMessage("");
    try {
      const res = await fetch(`${API}/post-shipment-cancel-stock-sms/check-replies`, {
        method: "POST",
        headers: getAuthHeaders(),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "수신확인 실패");
      setRepliesMessage(
        data.need_ezdesk_session
          ? "EZDesk 세션이 만료되었습니다. 세션을 다시 붙여넣고 수신확인을 다시 눌러주세요."
          : data.checked === 0
          ? "확인할 발송내역이 없습니다."
          : `수신확인 완료: ${data.checked}건 중 새 답장 ${data.updated.length}건`
      );
      await loadStockSmsLogs();
    } catch (err) {
      setRepliesMessage(err.message || "수신확인 실패");
    } finally {
      setRepliesChecking(false);
    }
  }, [loadStockSmsLogs]);

  // 완료 버튼 - 에이블리에서 실제 취소 승인을 실행하고, 성공해야 목록에서 지운다.
  // 승인 전까지는 로컬 DB에 그대로 남아 목록에서 지워지지 않는다.
  const handleCloseSentSms = useCallback(async (cancelSno) => {
    if (!window.confirm("에이블리에서 이 주문의 취소를 승인 처리합니다. 되돌리기 어려운 작업입니다.\n\n진행하시겠습니까?")) return;
    setClosingSno(cancelSno);
    setRepliesMessage("");
    setCloseErrors((prev) => {
      const next = { ...prev };
      delete next[cancelSno];
      return next;
    });
    try {
      const res = await fetch(`${API}/post-shipment-cancel-stock-sms/close`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ cancel_sno: cancelSno }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "완료 처리 실패");
      setStockSmsLogs((prev) => prev.filter((row) => row.cancel_sno !== cancelSno));
    } catch (err) {
      const msg = err.message || "완료 처리 실패";
      setRepliesMessage(msg);
      setCloseErrors((prev) => ({ ...prev, [cancelSno]: msg }));
    } finally {
      setClosingSno(null);
    }
  }, []);

  // 취소철회 및 송장출력 - 구매자 전화번호로 이지어드민 C/S 주문 목록을 불러와, 사용자가 고른 주문만 처리한다.
  // 에이블리 취소철회 → 이지어드민 보류해제·전체정상복귀 → 송장출력 → 배송확인.
  const searchWithdrawCandidates = useCallback(async (cancelSno, phone) => {
    setWithdrawLoading(true);
    setWithdrawError("");
    setWithdrawPack(null);
    try {
      const res = await fetch(`${API}/post-shipment-cancel-stock-sms/withdraw/candidates`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ cancel_sno: cancelSno, phone }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (data.need_ezadmin_session) {
        setWithdrawRow(null);
        openEzadminModal();
        throw new Error("이지어드민 세션이 필요합니다. 세션을 등록한 뒤 다시 눌러주세요.");
      }
      if (!res.ok || !data.ok) throw new Error(data?.detail || "이지어드민 주문 조회 실패");
      setWithdrawPacks(data.packs || []);
      if ((data.packs || []).length === 1) setWithdrawPack(data.packs[0].pack);
    } catch (err) {
      setWithdrawPacks(null);
      setWithdrawError(err.message || "이지어드민 주문 조회 실패");
    } finally {
      setWithdrawLoading(false);
    }
  }, [openEzadminModal]);

  const openWithdraw = useCallback((row) => {
    setWithdrawRow(row);
    setWithdrawPhone(row.buyer_tel || "");
    setWithdrawPacks(null);
    setWithdrawError("");
    searchWithdrawCandidates(row.cancel_sno, row.buyer_tel || "");
  }, [searchWithdrawCandidates]);

  const handleWithdraw = useCallback(async () => {
    if (!withdrawRow || !withdrawPack) return;
    const cancelSno = withdrawRow.cancel_sno;
    const picked = (withdrawPacks || []).find((p) => p.pack === withdrawPack);
    if (!window.confirm(`주문번호 ${picked?.order_id ?? ""} (${picked?.recv_name ?? ""})으로 에이블리 취소를 철회하고, 이지어드민 정상복귀 → 송장출력 → 배송확인까지 진행합니다. 되돌리기 어려운 작업입니다.\n\n진행하시겠습니까?`)) return;
    // 팝업 차단을 피하려고 클릭 직후 동기적으로 인쇄 창을 먼저 연다 (서버 응답 뒤에 열면 차단된다).
    const win = window.open("", "_blank");
    if (!win) {
      setWithdrawError("팝업이 차단되었습니다. 이 사이트의 팝업을 허용한 뒤 다시 시도해 주세요.");
      return;
    }
    win.document.write("<p style='font-family:sans-serif'>취소철회 및 송장 출력 처리 중...</p>");
    setWithdrawingSno(cancelSno);
    setWithdrawError("");
    setRepliesMessage("");
    setCloseErrors((prev) => {
      const next = { ...prev };
      delete next[cancelSno];
      return next;
    });
    try {
      const res = await fetch(`${API}/post-shipment-cancel-stock-sms/withdraw`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ cancel_sno: cancelSno, pack: withdrawPack, phone: withdrawPhone }),
      });
      if (handleUnauthorized(res)) { win.close(); return; }
      const data = await res.json().catch(() => ({}));
      if (data.need_ezadmin_session) {
        win.close();
        setWithdrawRow(null);
        openEzadminModal();
        throw new Error("이지어드민 세션이 필요합니다. 세션을 등록한 뒤 다시 눌러주세요.");
      }
      if (!res.ok || !data.ok) throw new Error(data?.detail || "취소철회 실패");
      setWithdrawRow(null);
      // 취소 접수번호가 새 번호로 바뀐 건도 있어서 서버 기준으로 목록을 다시 읽는다.
      setStockSmsLogs((prev) => prev.filter((row) => row.cancel_sno !== cancelSno && row.cancel_sno !== data.cancel_sno));
      loadStockSmsLogs();
      const minusNote = data.stock_minus_error
        ? ` · 오늘출발 재고 차감 실패(직접 확인 필요): ${data.stock_minus_error}`
        : (data.stock_minus || []).length
        ? ` · 오늘출발 재고 차감 ${data.stock_minus.map((m) => `${m.code} ${m.prev}→${m.stock}`).join(", ")}`
        : "";
      setRepliesMessage(`취소철회 완료 (${data.steps.join(" → ")}) · ${data.trans_corp} ${data.trans_no}${minusNote}`);
      win.document.open();
      win.document.write(data.html);
      win.document.close();
      setTimeout(() => win.print(), 1000);
      // 오늘출발 재고 차감 결과 알림 (인쇄 창이 뜬 뒤 표시)
      const okLines = (data.stock_minus || []).map((m) => `✅ ${m.code}: ${m.prev} → ${m.stock} (-${m.ea})`);
      const failLines = (data.stock_skipped || []).map((s) => `❌ ${s.code ? `${s.code}: ` : ""}${s.reason}`);
      if (data.stock_minus_error) failLines.push(`❌ 재고 차감 요청 실패: ${data.stock_minus_error}`);
      const minusAlert = `오늘출발 재고 차감 - ${failLines.length ? (okLines.length ? "일부 실패" : "실패") : "성공"}\n${[...okLines, ...failLines].join("\n")}`;
      setTimeout(() => window.alert(`취소철회 및 송장출력 완료\n\n${minusAlert}`), 1500);
    } catch (err) {
      win.close();
      const msg = err.message || "취소철회 실패";
      setWithdrawError(msg);
      // 에이블리 철회 이후 단계에서 실패한 건은 취소 접수번호가 바뀌었을 수 있어, 목록을 새로 읽고 모달을 닫는다.
      if (msg.includes("이어서 재시도")) setWithdrawRow(null);
      setRepliesMessage(msg);
      setCloseErrors((prev) => ({ ...prev, [cancelSno]: msg }));
      loadStockSmsLogs();
    } finally {
      setWithdrawingSno(null);
    }
  }, [withdrawRow, withdrawPack, withdrawPacks, withdrawPhone, openEzadminModal, loadStockSmsLogs]);

  // 승인할 주문상품 정보가 없어 자동 완료가 불가능한 건을, 에이블리에서 직접 처리했다는 전제로
  // 발송내역 목록에서만 지운다 (에이블리 취소 승인 자체는 여기서 실행하지 않음).
  const handleDeleteSentSms = useCallback(async (cancelSno) => {
    if (!window.confirm("이 발송내역을 목록에서 삭제할까요? (에이블리 취소 승인은 직접 처리했다는 전제입니다)")) return;
    setDeletingSno(cancelSno);
    setRepliesMessage("");
    try {
      const res = await fetch(`${API}/post-shipment-cancel-stock-sms/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ cancel_sno: cancelSno }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "삭제 실패");
      setStockSmsLogs((prev) => prev.filter((row) => row.cancel_sno !== cancelSno));
      setCloseErrors((prev) => {
        const next = { ...prev };
        delete next[cancelSno];
        return next;
      });
    } catch (err) {
      setRepliesMessage(err.message || "삭제 실패");
    } finally {
      setDeletingSno(null);
    }
  }, []);

  // 발송내역 목록에서 고객에게 바로 답장 문자를 보낸다.
  const handleSendReply = useCallback(async (cancelSno) => {
    const message = (replyDrafts[cancelSno] || "").trim();
    if (!message) return;
    setReplyingSno(cancelSno);
    setRepliesMessage("");
    try {
      const res = await fetch(`${API}/post-shipment-cancel-stock-sms/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ cancel_sno: cancelSno, message }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        throw new Error(
          data?.need_ezdesk_session
            ? "EZDesk 세션이 만료되었습니다. 세션을 다시 붙여넣고 답장을 다시 보내주세요."
            : data?.detail || "답장 발송 실패"
        );
      }
      setReplyDrafts((prev) => {
        const next = { ...prev };
        delete next[cancelSno];
        return next;
      });
      setReplyModalRow(null);
      setRepliesMessage("답장을 보냈습니다.");
    } catch (err) {
      setRepliesMessage(err.message || "답장 발송 실패");
    } finally {
      setReplyingSno(null);
    }
  }, [replyDrafts]);

  const handleManualAdd = useCallback(async () => {
    const invoice_no = manualForm.invoice_no.trim();
    if (!invoice_no) return;
    setManualSaving(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/barcode/post-shipment-cancel/add`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify(manualForm),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "수동 추가 실패");
      setItems(data.items ?? []);
      setDate(data.date ?? "");
      setManualForm({ invoice_no: "" });
      setMessage(`${invoice_no} 수동 추가 완료`);
    } catch (err) {
      setMessage(err.message || "수동 추가 실패");
    } finally {
      setManualSaving(false);
    }
  }, [manualForm]);

  const handleManualDelete = useCallback(async (id) => {
    if (!window.confirm("수동 추가한 이 건을 목록에서 삭제할까요?")) return;
    try {
      const res = await fetch(`${API}/barcode/post-shipment-cancel/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ id }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "삭제 실패");
      setItems(data.items ?? []);
    } catch (err) {
      setMessage(err.message || "삭제 실패");
    }
  }, []);

  const setBusy = (ids, on) =>
    setShipBusy((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => (on ? next.add(id) : next.delete(id)));
      return next;
    });

  // 같은 송장번호(합포장)인 행은 하나만 눌러도 함께 처리한다.
  const withSameInvoice = useCallback((ids) => {
    const invoices = new Set(items.filter((it) => ids.includes(it.id)).map((it) => it.invoice_no));
    return items.filter((it) => ids.includes(it.id) || invoices.has(it.invoice_no)).map((it) => it.id);
  }, [items]);

  const toggleSelected = (id) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // 취소 조회 - 에이블리 취소목록 / 배송중에서 주문번호로 검색한다.
  const handleShipLookup = useCallback(async (ids) => {
    const targets = withSameInvoice(ids).filter((id) => !items.find((it) => it.id === id)?.held);
    if (!targets.length) return;
    setBusy(targets, true);
    setMessage("");
    try {
      const res = await fetch(`${API}/barcode/post-shipment-cancel/ably-lookup`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ ids: targets }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (data?.need_session) {
        openEzadminModal(() => handleShipLookup(targets));
        return;
      }
      if (!res.ok || !data.ok) throw new Error(data?.detail || "취소 조회 실패");
      setShipLookup((prev) => {
        const next = { ...prev };
        (data.results || []).forEach((r) => { next[r.id] = r; });
        return next;
      });
    } catch (err) {
      setMessage(err.message || "취소 조회 실패");
    } finally {
      setBusy(targets, false);
    }
  }, [items, openEzadminModal, withSameInvoice]);

  // 취소진행 - 이지어드민 C/S창 배송취소 > 송장삭제 > 전체취소. 한 건씩 순서대로 처리한다.
  const handleShipCancel = useCallback(async (ids) => {
    const targets = withSameInvoice(ids).filter((id) => shipLookup[id]?.in_cancel && !shipDone.has(id));
    if (!targets.length) return;
    if (!window.confirm(`${targets.length}건을 이지어드민에서 배송취소 → 송장삭제 → 전체취소 처리합니다. 되돌리기 어려운 작업입니다.\n\n진행하시겠습니까?`)) return;
    setMessage("");
    let okCount = 0;
    for (const id of targets) {
      setBusy([id], true);
      try {
        const res = await fetch(`${API}/barcode/post-shipment-cancel/ship-cancel`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...getAuthHeaders() },
          body: JSON.stringify({ id }),
        });
        if (handleUnauthorized(res)) return;
        const data = await res.json().catch(() => ({}));
        if (data?.need_session) {
          openEzadminModal(() => handleShipCancel(targets.filter((t) => !shipDone.has(t))));
          setBusy([id], false);
          return;
        }
        if (!res.ok || !data.ok) throw new Error(data?.detail || "취소진행 실패");
        okCount += 1;
        setShipDone((prev) => new Set(prev).add(id));
        setShipErrors((prev) => { const next = { ...prev }; delete next[id]; return next; });
      } catch (err) {
        setShipErrors((prev) => ({ ...prev, [id]: err.message || "취소진행 실패" }));
      } finally {
        setBusy([id], false);
      }
    }
    setMessage(`취소진행 ${okCount}/${targets.length}건 완료`);
  }, [shipLookup, shipDone, openEzadminModal, withSameInvoice]);

  // 보류 - 확인했다는 표시. 해당 건의 '취소 조회' 버튼을 비활성화한다.
  const handleShipHold = useCallback(async (ids) => {
    const targets = withSameInvoice(ids).filter((id) => shipLookup[id]?.in_shipping && !items.find((it) => it.id === id)?.held);
    for (const id of targets) {
      try {
        const res = await fetch(`${API}/barcode/post-shipment-cancel/hold`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...getAuthHeaders() },
          body: JSON.stringify({ id }),
        });
        if (handleUnauthorized(res)) return;
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error(data?.detail || "보류 실패");
        setItems((prev) => prev.map((it) => (it.id === id ? { ...it, held: 1 } : it)));
      } catch (err) {
        setMessage(err.message || "보류 실패");
      }
    }
  }, [shipLookup, items, withSameInvoice]);

  const allSelected = items.length > 0 && items.every((it) => selectedIds.has(it.id));
  const selectedList = items.filter((it) => selectedIds.has(it.id)).map((it) => it.id);

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

          <div className={pageStyles.headerActions} style={{ flexWrap: "wrap", gap: "0.5rem" }}>
            <span className={pageStyles.pill}>선택 {selectedList.length}건</span>
            <button
              className={pageStyles.secondaryBtn}
              onClick={() => handleShipLookup(selectedList)}
              disabled={!selectedList.length || selectedList.some((id) => shipBusy.has(id))}
            >
              선택 취소 조회
            </button>
            <button
              className={pageStyles.secondaryBtn}
              onClick={() => handleShipCancel(selectedList)}
              disabled={!selectedList.some((id) => shipLookup[id]?.in_cancel && !shipDone.has(id)) || shipBusy.size > 0}
            >
              선택 취소진행
            </button>
            <button
              className={pageStyles.secondaryBtn}
              onClick={() => handleShipHold(selectedList)}
              disabled={!selectedList.some((id) => shipLookup[id]?.in_shipping && !items.find((it) => it.id === id)?.held)}
            >
              선택 보류
            </button>
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

          <div className={pageStyles.scanRow} style={{ gap: "0.5rem", flexWrap: "wrap" }}>
            <input
              className={pageStyles.scanInput}
              placeholder="송장번호만 입력해서 수동 추가"
              value={manualForm.invoice_no}
              onChange={(e) => setManualForm((prev) => ({ ...prev, invoice_no: e.target.value }))}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleManualAdd(); } }}
            />
            <button
              className={pageStyles.primaryBtn}
              onClick={handleManualAdd}
              disabled={manualSaving || !manualForm.invoice_no.trim()}
            >
              {manualSaving ? "추가 중..." : "수동 추가"}
            </button>
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
                  <th>
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={() => setSelectedIds(allSelected ? new Set() : new Set(items.map((it) => it.id)))}
                    />
                  </th>
                  <th>송장번호</th>
                  <th>쇼핑몰</th>
                  <th>담당자</th>
                  <th>상품명</th>
                  <th>택배사</th>
                  <th>발송시각</th>
                  <th>취소시각</th>
                  <th>취소 조회</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr
                    key={item.id || item.seq || item.invoice_no}
                    className={matchedInvoices.has(item.invoice_no) ? pageStyles.checkedTableRow : ""}
                  >
                    <td>
                      <input type="checkbox" checked={selectedIds.has(item.id)} onChange={() => toggleSelected(item.id)} />
                    </td>
                    <td>{item.invoice_no}</td>
                    <td>{item.shop}</td>
                    <td>{item.manager}</td>
                    <td>{item.product_name}</td>
                    <td>{item.carrier}</td>
                    <td>{item.ship_time}</td>
                    <td>{item.cancel_time}</td>
                    <td>
                      {(() => {
                        const r = shipLookup[item.id];
                        const busy = shipBusy.has(item.id);
                        const done = shipDone.has(item.id);
                        return (
                          <div style={{ display: "flex", gap: "0.35rem", alignItems: "center", flexWrap: "wrap" }}>
                            <button
                              className={pageStyles.secondaryBtn}
                              onClick={() => handleShipLookup([item.id])}
                              disabled={busy || done || !!item.held}
                            >
                              {busy ? "처리 중..." : "취소 조회"}
                            </button>
                            {item.held ? <span className={pageStyles.pill}>보류됨</span> : null}
                            {done ? <span className={pageStyles.pill}>취소진행 완료</span> : null}
                            {!done && r && !r.ok && <span style={{ color: "#dc3545" }}>{r.message}</span>}
                            {!done && r && r.ok && !r.in_cancel && !r.in_shipping && (
                              <span style={{ color: "#dc3545" }}>목록안뜸 확인필요</span>
                            )}
                            {!done && r && r.ok && r.in_refund && <span className={pageStyles.pill}>취소환불요청</span>}
                            {!done && r && r.ok && r.in_cancel && (
                              <button className={pageStyles.primaryBtn} onClick={() => handleShipCancel([item.id])} disabled={busy}>
                                취소진행
                              </button>
                            )}
                            {!done && r && r.ok && r.in_shipping && !item.held && (
                              <button className={pageStyles.secondaryBtn} onClick={() => handleShipHold([item.id])} disabled={busy}>
                                보류
                              </button>
                            )}
                            {shipErrors[item.id] && <span style={{ color: "#dc3545" }}>{shipErrors[item.id]}</span>}
                          </div>
                        );
                      })()}
                    </td>
                    <td>
                      {item.manual ? (
                        <button className={pageStyles.secondaryBtn} onClick={() => handleManualDelete(item.id)}>
                          수동·삭제
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
                {items.length === 0 && !loading && (
                  <tr>
                    <td colSpan={10}>저장된 배송후취소 목록이 없습니다. 새로고침을 눌러주세요.</td>
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

        <section className={pageStyles.card}>
          <div className={pageStyles.cardHeader}>
            <h3 className={pageStyles.cardTitle}>확인문자 발송내역 · 수신확인</h3>
            <div className={pageStyles.headerActions}>
              <span className={pageStyles.pill}>{stockSmsLogs.length}건</span>
              <button className={pageStyles.primaryBtn} onClick={handleCheckReplies} disabled={repliesChecking || stockSmsLogsLoading}>
                {repliesChecking ? "수신확인 중..." : "수신확인"}
              </button>
            </div>
          </div>
          <p className={pageStyles.subtitle}>
            위에서 발송한 "재고있는 취소주문 확인문자" 목록입니다. "수신확인"을 누르면 이지데스크에서
            각 연락처의 대화 내역을 다시 조회해, 문자 발송 이후 온 고객 답장을 가져와 표시합니다.
            이 목록은 로컬 DB에 저장되며, 답장을 확인한 뒤 건별로 처리합니다. "취소실행"은 에이블리 취소를 승인하고,
            "취소철회 및 송장출력"은 취소를 철회한 뒤 이지어드민 정상복귀 → 송장출력 → 배송확인까지 진행합니다.
            처리되기 전까지는 목록에 계속 남아있습니다.
          </p>

          {repliesMessage && (
            <div
              className={pageStyles.statusMsg}
              style={{
                borderColor: repliesMessage.includes("실패") || repliesMessage.includes("만료") ? "rgba(220,53,69,0.4)" : "rgba(34,197,94,0.4)",
                backgroundColor: repliesMessage.includes("실패") || repliesMessage.includes("만료") ? "rgba(220,53,69,0.07)" : "rgba(34,197,94,0.07)",
              }}
            >
              <strong>{repliesMessage}</strong>
            </div>
          )}

          <div className={pageStyles.tableWrap}>
            <table className={pageStyles.table}>
              <thead>
                <tr>
                  <th>발송시각</th>
                  <th>주문번호</th>
                  <th>연락처</th>
                  <th>상품명</th>
                  <th>고객 답장</th>
                  <th>답장시각</th>
                  <th>답장하기</th>
                  <th>완료 / 삭제</th>
                </tr>
              </thead>
              <tbody>
                {stockSmsLogs.map((row) => (
                  <tr key={row.id}>
                    <td>{row.created_at}</td>
                    <td>{row.order_sno}</td>
                    <td>{row.buyer_tel}</td>
                    <td>{(row.product_names || []).join(", ")}</td>
                    <td style={{ whiteSpace: "pre-wrap" }}>{row.reply_content || "-"}</td>
                    <td>{row.reply_at || "-"}</td>
                    <td>
                      <button
                        className={pageStyles.secondaryBtn}
                        onClick={() => setReplyModalRow(row)}
                      >
                        답장하기
                      </button>
                    </td>
                    <td>
                      <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem", alignItems: "flex-start" }}>
                        <button
                          className={pageStyles.secondaryBtn}
                          onClick={() => handleCloseSentSms(row.cancel_sno)}
                          disabled={closingSno === row.cancel_sno || withdrawingSno === row.cancel_sno || row.action === "withdrawn"}
                        >
                          {closingSno === row.cancel_sno ? "처리 중..." : "취소실행"}
                        </button>
                        <button
                          className={pageStyles.primaryBtn}
                          onClick={() => openWithdraw(row)}
                          disabled={withdrawingSno === row.cancel_sno || closingSno === row.cancel_sno}
                        >
                          {withdrawingSno === row.cancel_sno ? "처리 중..." : "취소철회 및 송장출력"}
                        </button>
                        {closeErrors[row.cancel_sno] && (
                          <span style={{ fontSize: "0.78rem", color: "rgba(220,53,69,0.85)" }}>
                            {closeErrors[row.cancel_sno]}
                          </span>
                        )}
                        <button
                          className={pageStyles.secondaryBtn}
                          style={{ borderColor: "rgba(220,53,69,0.4)", color: "rgba(220,53,69,0.9)" }}
                          onClick={() => handleDeleteSentSms(row.cancel_sno)}
                          disabled={deletingSno === row.cancel_sno}
                        >
                          {deletingSno === row.cancel_sno ? "삭제 중..." : "삭제"}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {stockSmsLogs.length === 0 && !stockSmsLogsLoading && (
                  <tr>
                    <td colSpan={8}>발송된 확인문자가 없습니다.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      {withdrawRow && (
        <div className={pageStyles.modalOverlay} onClick={() => { if (!withdrawingSno) setWithdrawRow(null); }}>
          <div className={pageStyles.modal} style={{ width: "min(560px, 94vw)" }} onClick={(e) => e.stopPropagation()}>
            <div className={pageStyles.modalHeader}>
              <span className={pageStyles.modalTitle}>취소철회 및 송장출력 - 주문 선택</span>
              <button type="button" className={pageStyles.secondaryBtn} onClick={() => setWithdrawRow(null)} disabled={Boolean(withdrawingSno)}>
                닫기
              </button>
            </div>
            <p className={pageStyles.subtitle}>
              이지어드민 C/S 창에서 전화번호로 검색한 주문입니다 (최근 30일). 철회할 주문을 직접 선택하세요.
            </p>
            <div style={{ display: "flex", gap: "0.4rem", marginBottom: "0.6rem" }}>
              <input
                value={withdrawPhone}
                placeholder="010-1234-5678"
                onChange={(e) => setWithdrawPhone(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !withdrawLoading && searchWithdrawCandidates(withdrawRow.cancel_sno, withdrawPhone)}
                style={{ flex: 1 }}
              />
              <button
                className={pageStyles.secondaryBtn}
                disabled={withdrawLoading || Boolean(withdrawingSno) || !withdrawPhone.trim()}
                onClick={() => searchWithdrawCandidates(withdrawRow.cancel_sno, withdrawPhone)}
              >
                {withdrawLoading ? "조회 중..." : "검색"}
              </button>
            </div>
            {withdrawError && <div style={{ color: "rgba(220,53,69,0.9)", fontSize: "0.85rem", marginBottom: "0.5rem" }}>{withdrawError}</div>}
            {withdrawPacks && withdrawPacks.length === 0 && <div>이 번호로 검색된 주문이 없습니다.</div>}
            <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem", maxHeight: "50vh", overflowY: "auto" }}>
              {(withdrawPacks || []).map((p) => {
                const cs = String(p.order_cs || "0").split(",")[0];
                const tags = [p.hold !== "0" && "보류", cs !== "0" && (cs === "1" ? "취소" : `CS(${cs})`)].filter(Boolean);
                return (
                  <button
                    type="button"
                    key={p.pack}
                    className={pageStyles.secondaryBtn}
                    style={{
                      textAlign: "left",
                      borderColor: withdrawPack === p.pack ? "rgba(59,130,246,0.9)" : undefined,
                      backgroundColor: withdrawPack === p.pack ? "rgba(59,130,246,0.1)" : undefined,
                    }}
                    onClick={() => setWithdrawPack(p.pack)}
                    disabled={Boolean(withdrawingSno)}
                  >
                    <div>
                      <strong>{p.recv_name || "-"}</strong> · {p.collect_date} · {p.shop_name} · 주문번호 {p.order_id}{" "}
                      [{tags.length ? tags.join("·") : "정상"}]
                    </div>
                    <div style={{ fontSize: "0.8rem", opacity: 0.8 }}>
                      {p.items.map((i) => `${i.name}${i.options ? ` ${i.options}` : ""} x${i.qty}`).join(" / ")}
                    </div>
                    {p.trans_no && <div style={{ fontSize: "0.8rem", opacity: 0.8 }}>{p.trans_corp} {p.trans_no}</div>}
                  </button>
                );
              })}
            </div>
            <div style={{ marginTop: "0.8rem", textAlign: "right" }}>
              <button className={pageStyles.primaryBtn} onClick={handleWithdraw} disabled={!withdrawPack || Boolean(withdrawingSno)}>
                {withdrawingSno ? "처리 중..." : "선택한 주문 취소철회 및 송장출력"}
              </button>
            </div>
          </div>
        </div>
      )}

      {replyModalRow && (
        <div className={pageStyles.modalOverlay} onClick={() => { if (replyingSno !== replyModalRow.cancel_sno) setReplyModalRow(null); }}>
          <div className={pageStyles.modal} style={{ width: "min(420px, 92vw)" }} onClick={(e) => e.stopPropagation()}>
            <div className={pageStyles.modalHeader}>
              <span className={pageStyles.modalTitle}>답장 보내기</span>
              <button
                type="button"
                className={pageStyles.secondaryBtn}
                onClick={() => setReplyModalRow(null)}
                disabled={replyingSno === replyModalRow.cancel_sno}
              >
                닫기
              </button>
            </div>
            <p className={pageStyles.subtitle}>
              {replyModalRow.buyer_tel} ({(replyModalRow.product_names || []).join(", ")})
            </p>
            <textarea
              value={replyDrafts[replyModalRow.cancel_sno] || ""}
              onChange={(e) => setReplyDrafts((prev) => ({ ...prev, [replyModalRow.cancel_sno]: e.target.value }))}
              placeholder="답장 내용 입력"
              rows={5}
              style={{ width: "100%", fontSize: "0.85rem", padding: "0.5rem", boxSizing: "border-box" }}
              autoFocus
            />
            <div className={pageStyles.modalActions} style={{ marginTop: "1rem" }}>
              <button className={pageStyles.secondaryBtn} onClick={() => setReplyModalRow(null)} disabled={replyingSno === replyModalRow.cancel_sno}>
                취소
              </button>
              <button
                className={pageStyles.primaryBtn}
                onClick={() => handleSendReply(replyModalRow.cancel_sno)}
                disabled={replyingSno === replyModalRow.cancel_sno || !(replyDrafts[replyModalRow.cancel_sno] || "").trim()}
              >
                {replyingSno === replyModalRow.cancel_sno ? "전송 중..." : "답장 보내기"}
              </button>
            </div>
          </div>
        </div>
      )}

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
