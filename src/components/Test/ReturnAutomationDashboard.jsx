import React, { useCallback, useEffect, useRef, useState } from "react";
import { MessageSquare } from "lucide-react";
import { LOCAL_API_BASE as API, getAuthHeaders, handleUnauthorized } from "../../lib/api";
import { useEzadminSession } from "../../lib/EzadminSessionContext";
import styles from "./ReturnAutomationDashboard.module.css";

import usePersistentState from "../../lib/usePersistentState";
// Preview results and selection survive a page refresh - a preview can take a
// while (30-day Ably scan + per-item LOGIS/EZAdmin calls), so losing it on an
// accidental reload would mean re-running the whole scan.
const RUN_STORAGE_KEY = "returnAutomation.run";
const SELECTED_STORAGE_KEY = "returnAutomation.selected";
const TEMPLATE_STORAGE_KEY = "returnAutomation.template";
const DEFAULT_TEMPLATE_ID_STORAGE_KEY = "returnAutomation.defaultTemplateId";

function loadStored(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function saveStored(key, value) {
  try {
    if (value === null || value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // localStorage full/unavailable - just skip persisting this write
  }
}

// "최근 30일 조회" is a slow multi-step scan (Ably + per-item LOGIS/EZAdmin
// calls). Switching to another sidebar tab unmounts this component (see
// TestTabs.jsx), which would normally discard whatever the in-flight fetch
// eventually resolves to. Running the job at module scope - outside any
// component instance - means the fetch and its localStorage write keep going
// regardless of mount state; a component that remounts later either finds
// the job still in progress (and subscribes to be notified) or finds the
// result already persisted in localStorage from when it finished unattended.
let activePreviewJob = null; // { listeners: Set<(result) => void> }

function startPreviewJob() {
  const listeners = new Set();
  const job = { listeners };
  activePreviewJob = job;

  (async () => {
    let result;
    try {
      const res = await fetch(`${API}/return-automation/preview`, {
        method: "POST",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
      });
      if (handleUnauthorized(res)) return; // triggers a full reload - nothing left to notify
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || "조회 실패");
      saveStored(RUN_STORAGE_KEY, data);
      saveStored(
        SELECTED_STORAGE_KEY,
        Object.fromEntries((data.items || []).filter((x) => x.eligible).map((x) => [x.invoice_no, true]))
      );
      if (data.templates?.[0]) saveStored(TEMPLATE_STORAGE_KEY, data.templates[0]);
      result = { ok: true, data };
    } catch (err) {
      result = { ok: false, error: err };
    }
    if (activePreviewJob === job) activePreviewJob = null;
    listeners.forEach((fn) => fn(result));
  })();

  return job;
}

const STATUS_META = {
  PASS: { label: "실행가능", className: styles.badgePass },
  WAIT: { label: "대기중", className: styles.badgeWait },
  CS_EMPTY: { label: "상담이력없음", className: styles.badgeNeutral },
  CS_SEQ_MISSING: { label: "주문매칭실패", className: styles.badgeNeutral },
  RETURN_WAIT: { label: "반품대기", className: styles.badgeNeutral },
  NO_RETURN_INVOICE: { label: "확인중", className: styles.badgeNeutral },
  ERROR: { label: "오류", className: styles.badgeError },
};

// Matches the `stage` values set in backend/api/return_automation_routes.py
// right before each external call, so an ERROR row can say *where* it failed.
const STAGE_LABELS = {
  LLOGIS_RETURN_STATUS: "LLogis 반송장조회",
  EZADMIN_ORDER_SEARCH: "EZAdmin 주문번호검색",
  EZADMIN_TAKEBACK: "EZAdmin 회수여부조회",
  EZADMIN_CS_HISTORY: "EZAdmin CS이력조회",
};

// 조회(30일치)는 건마다 이지어드민에서 회수 여부를 확인하느라 오래 걸려서, 서버가 알려주는 진행상황을 폴링해 보여준다.
function PreviewProgress({ active }) {
  const [p, setP] = useState(null);
  useEffect(() => {
    if (!active) return undefined;
    let stop = false;
    const tick = async () => {
      try {
        const res = await fetch(`${API}/return-automation/preview/progress`, { headers: getAuthHeaders() });
        const data = await res.json().catch(() => null);
        if (!stop && data) setP(data);
      } catch { /* 일시적인 실패는 다음 폴링에서 다시 */ }
    };
    tick();
    const id = setInterval(tick, 700);
    return () => { stop = true; clearInterval(id); };
  }, [active]);
  if (!active || !p || !p.running) return null;
  const pct = p.total ? Math.min(100, Math.round((p.done / p.total) * 100)) : 0;
  return (
    <div style={{ margin: "0.5rem 0" }}>
      <div style={{ display: "flex", gap: "0.75rem", alignItems: "center", fontSize: "0.82rem" }}>
        <strong>{p.phase || "조회 중"}</strong>
        <span>{p.done}/{p.total || "?"} ({pct}%)</span>
        {p.returned > 0 && <span>· 이미 회수 접수 {p.returned}건 제외</span>}
        {p.current && <span style={{ opacity: 0.6 }}>· 현재 {p.current}</span>}
      </div>
      <div style={{ height: 6, background: "#e5e7eb", borderRadius: 999, overflow: "hidden", marginTop: 4 }}>
        <div style={{ width: `${pct}%`, height: "100%", background: "#7c3aed", transition: "width 0.3s ease" }} />
      </div>
    </div>
  );
}

function StatusBadge({ status, stage }) {
  const meta = STATUS_META[status] || { label: status || "-", className: styles.badgeNeutral };
  const stageLabel = status === "ERROR" ? STAGE_LABELS[stage] : null;
  return (
    <span className={`${styles.badge} ${meta.className}`} title={stageLabel ? `${stageLabel} 단계에서 실패` : undefined}>
      {meta.label}{stageLabel ? ` · ${stageLabel}` : ""}
    </span>
  );
}

function directionLabel(direction) {
  if (direction === "received") return "수신";
  if (direction === "sent") return "발송";
  return "-";
}

// 백엔드가 "2026-07-09 10:23:00" 같은 원본 문자열을 그대로 내려주므로,
// "7월 9일"처럼 짧게 보여주기 위해 앞 10자(YYYY-MM-DD)만 파싱한다.
function formatShortDate(value) {
  if (!value) return null;
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return value;
  const [, , month, day] = match;
  return `${Number(month)}월 ${Number(day)}일`;
}

// 수신 내용/오류 셀에 원본 줄바꿈이 그대로 표시되면 행이 지나치게 길어지므로,
// 앞 두 줄만 유지하고 나머지 줄은 공백으로 이어붙여 줄바꿈이 최대 2번만 나오게 한다.
function limitLineBreaks(text) {
  if (!text) return text;
  const lines = String(text).split(/\r?\n+/).filter((line) => line.trim() !== "");
  if (lines.length <= 2) return lines.join("\n");
  return `${lines[0]}\n${lines[1]}\n${lines.slice(2).join(" ")}`;
}


const SORT_GETTERS = {
  order: (x) => x.cancel_sno || x.order_no || "",
  phone: (x) => x.phone || "",
  returnDate: (x) => x.return_date || "",
  returnInvoice: (x) => x.return_invoice_no || "",
  logis: (x) => x.logis?.llogis_status || "",
  inputTime: (x) => x.input_time || "",
  status: (x) => x.elapsed_status || "",
  result: (x) =>
    x.rejectError ? "거부실패"
    : x.rejected ? "반품거부됨"
    : x.executeError ? "실행오류"
    : x.groupedWith ? "묶음처리"
    : x.skipped ? "이미처리됨"
    : x.executed ? "처리완료"
    : "",
  lastDirection: (x) => directionLabel(x.last_direction) || "",
  content: (x) => x.error || x.received_content || "",
};

export default function ReturnAutomationDashboard() {
  const [run, setRun] = useState(() => loadStored(RUN_STORAGE_KEY, null));
  const [selected, setSelected] = useState(() => loadStored(SELECTED_STORAGE_KEY, {}));
  // 마지막으로 선택했던 템플릿(TEMPLATE_STORAGE_KEY)이 아니라, 사용자가 저장해둔
  // 기본 템플릿(DEFAULT_TEMPLATE_ID_STORAGE_KEY)이 있으면 메뉴에 들어올 때마다
  // 그것이 먼저 선택되어 있어야 한다.
  const [template, setTemplate] = useState(() => {
    const storedDefaultId = loadStored(DEFAULT_TEMPLATE_ID_STORAGE_KEY, null);
    const storedRun = loadStored(RUN_STORAGE_KEY, null);
    const preferredTemplate = storedDefaultId != null
      ? (storedRun?.templates || []).find((x) => String(x.id) === String(storedDefaultId))
      : null;
    return preferredTemplate || loadStored(TEMPLATE_STORAGE_KEY, null);
  });
  // 조회할 때마다 템플릿 선택이 첫 번째 항목으로 초기화되지 않도록, 사용자가
  // 지정한 기본 템플릿의 id를 별도로 기억해뒀다가 새 조회 결과에 다시 적용한다.
  const [defaultTemplateId, setDefaultTemplateId] = useState(() => loadStored(DEFAULT_TEMPLATE_ID_STORAGE_KEY, null));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [messageIsError, setMessageIsError] = useState(false);
  const [showEzdeskSettings, setShowEzdeskSettings] = useState(false);
  const [ezdeskInput, setEzdeskInput] = useState("");
  const [ezdeskHasSession, setEzdeskHasSession] = useState(false);
  const [ezdeskMsg, setEzdeskMsg] = useState("");
  const [ezdeskLoading, setEzdeskLoading] = useState(false);
  const [smsPreview, setSmsPreview] = useState(null);
  const [memos, setMemos] = useState({});
  const [draftMemos, setDraftMemos] = useState({});
  const [expandedMemos, setExpandedMemos] = useState(new Set());
  const [draftReplies, setDraftReplies] = useState({});
  const [expandedReplies, setExpandedReplies] = useState(new Set());
  const [replySending, setReplySending] = useState({});
  const [csChecking, setCsChecking] = useState(false);
  const [csDetail, setCsDetail] = useState(null);
  // 주문매칭실패 건 수동 매칭: { item, keyword, loading, candidates, error, applying }
  const [matchModal, setMatchModal] = useState(null);
  const [rejecting, setRejecting] = useState(false);
  const [subTab, setSubTab] = usePersistentState("returnAutomationSubTab", "scan"); // "scan" | "manual"
  const [manualInvoices, setManualInvoices] = useState([]);
  const [manualInvoiceInput, setManualInvoiceInput] = useState("");
  const [manualReasonInput, setManualReasonInput] = useState("");
  const [manualBusy, setManualBusy] = useState(false);
  const [manualStatusItems, setManualStatusItems] = useState(null);
  const [manualStatusLoading, setManualStatusLoading] = useState(false);
  const [manualStatusMessage, setManualStatusMessage] = useState("");
  const [manualStatusMessageIsError, setManualStatusMessageIsError] = useState(false);
  const [specialNoteSyncing, setSpecialNoteSyncing] = useState(false);
  const [sortConfig, setSortConfig] = useState({ key: null, dir: "asc" });
  const ezdeskRetryRef = useRef(null);
  const { openModal: openEzadminModal } = useEzadminSession();

  useEffect(() => saveStored(RUN_STORAGE_KEY, run), [run]);
  useEffect(() => saveStored(SELECTED_STORAGE_KEY, selected), [selected]);
  useEffect(() => saveStored(TEMPLATE_STORAGE_KEY, template), [template]);
  useEffect(() => saveStored(DEFAULT_TEMPLATE_ID_STORAGE_KEY, defaultTemplateId), [defaultTemplateId]);

  // 반품배송 테스트/배송 현황 조회와 같은 delivery_memos 테이블(송장번호 기준)을
  // 공유한다 - 같은 송장이면 어느 탭에서 남긴 메모든 여기서도 보인다.
  useEffect(() => {
    fetch(`${API}/return-shipping/memos`, { headers: getAuthHeaders() })
      .then((r) => (r.ok ? r.json() : null))
      .then((serverMemos) => {
        if (!serverMemos) return;
        const stripped = {};
        Object.entries(serverMemos).forEach(([k, v]) => {
          stripped[k] = typeof v === "object" ? v.memo ?? "" : v;
        });
        setMemos(stripped);
      })
      .catch(() => {});
  }, []);

  const toggleMemo = (inv) => {
    setExpandedMemos((prev) => {
      const next = new Set(prev);
      if (next.has(inv)) {
        next.delete(inv);
      } else {
        next.add(inv);
        setDraftMemos((d) => ({ ...d, [inv]: memos[inv] || "" }));
      }
      return next;
    });
  };

  const saveMemo = (inv) => {
    const val = draftMemos[inv] ?? memos[inv] ?? "";
    setMemos((prev) => {
      if (!val) {
        const next = { ...prev };
        delete next[inv];
        return next;
      }
      return { ...prev, [inv]: val };
    });
    fetch(`${API}/return-shipping/memo`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...getAuthHeaders() },
      body: JSON.stringify({ invoice_no: inv, memo: val }),
    }).catch(() => {});
  };

  const toggleReply = (inv) => {
    setExpandedReplies((prev) => {
      const next = new Set(prev);
      if (next.has(inv)) next.delete(inv);
      else {
        next.add(inv);
        setDraftReplies((d) => ({ ...d, [inv]: d[inv] ?? "" }));
      }
      return next;
    });
  };

  // execute()가 템플릿 문자를 보내는 것과 별개로, 수신 내용을 보고 그 자리에서
  // 바로 자유 문구로 답장할 수 있게 한다. EZDesk 세션은 execute()/runExecute와
  // 같은 need_ezdesk_session 재시도 패턴을 그대로 쓴다.
  const sendReply = async (item) => {
    const inv = item.invoice_no;
    const msg = (draftReplies[inv] || "").trim();
    if (!msg) return;
    const phone = String(item.phone || "").trim();
    if (!phone) {
      setMessageIsError(true);
      setMessage(`${inv}: 전화번호를 찾을 수 없어 답장을 보낼 수 없습니다.`);
      return;
    }
    setReplySending((s) => ({ ...s, [inv]: true }));
    try {
      const res = await fetch(`${API}/return-automation/reply-sms`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ phone, msg }),
      });
      const data = await res.json().catch(() => ({}));
      if (data?.need_ezdesk_session) {
        setMessageIsError(true);
        setMessage("EZDesk 세션이 만료되었습니다. 세션을 다시 입력하면 답장을 이어서 보냅니다.");
        ezdeskRetryRef.current = () => sendReply(item);
        openEzdeskSettings();
        return;
      }
      if (!res.ok || !data.ok) throw new Error(data.detail || "답장 전송 실패");
      setRun((prev) => {
        if (!prev) return prev;
        const nextItems = prev.items.map((x) =>
          x.invoice_no === inv
            ? {
                ...x,
                last_direction: "sent",
                sms_sent_count: (x.sms_sent_count || 0) + 1,
                sms_sent_history: [
                  ...(x.sms_sent_history || []),
                  { input_time: new Date().toISOString(), content: msg, direction: "sent" },
                ],
              }
            : x
        );
        return { ...prev, items: nextItems, smsSentTotal: (prev.smsSentTotal || 0) + 1 };
      });
      setDraftReplies((d) => ({ ...d, [inv]: "" }));
      setExpandedReplies((prev) => {
        const next = new Set(prev);
        next.delete(inv);
        return next;
      });
      setMessageIsError(false);
      setMessage(`${inv}: 답장을 보냈습니다.`);
    } catch (err) {
      setMessageIsError(true);
      setMessage(err.message);
    } finally {
      setReplySending((s) => ({ ...s, [inv]: false }));
    }
  };

  // So the toolbar button can say "(미설정)" right away instead of only after
  // the settings modal has been opened once.
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`${API}/return-automation/ezdesk-session`, { headers: getAuthHeaders() });
        const data = await res.json().catch(() => ({}));
        setEzdeskHasSession(!!data?.has_session);
      } catch {
        // ignore - button just shows the unconfigured state until retried
      }
    })();
  }, []);

  const loadManualInvoices = () => {
    fetch(`${API}/return-automation/manual-invoices`, { headers: getAuthHeaders() })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => setManualInvoices(data?.invoices || []))
      .catch(() => {});
  };

  useEffect(() => {
    loadManualInvoices();
  }, []);

  const addManualInvoice = async () => {
    const invoiceNo = manualInvoiceInput.trim();
    if (!invoiceNo) return;
    const reason = manualReasonInput.trim();
    setManualBusy(true);
    try {
      const res = await fetch(`${API}/return-automation/manual-invoices`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ invoice_no: invoiceNo, reason }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.detail || "추가 실패");
      setManualInvoiceInput("");
      setManualReasonInput("");
      loadManualInvoices();
      setManualStatusMessageIsError(false);
      setManualStatusMessage(`${invoiceNo}: 개별 추가되었습니다. "상태 조회"를 누르면 진행 상황이 반영됩니다.`);
    } catch (err) {
      setManualStatusMessageIsError(true);
      setManualStatusMessage(err.message);
    } finally {
      setManualBusy(false);
    }
  };

  const removeManualInvoice = async (invoiceNo) => {
    setManualInvoices((prev) => prev.filter((x) => x.invoice_no !== invoiceNo));
    setManualStatusItems((prev) => (prev ? prev.filter((x) => x.invoice_no !== invoiceNo) : prev));
    try {
      await fetch(`${API}/return-automation/manual-invoices/${encodeURIComponent(invoiceNo)}`, {
        method: "DELETE",
        headers: getAuthHeaders(),
      });
    } catch {
      // ignore - loadManualInvoices() on next visit will resync if this failed silently
    }
  };

  const loadManualStatus = async () => {
    setManualStatusLoading(true);
    setManualStatusMessageIsError(false);
    setManualStatusMessage("개별 추가 건 상태 조회 중...");
    try {
      const res = await fetch(`${API}/return-automation/manual-invoices/status`, {
        method: "POST",
        headers: getAuthHeaders(),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.detail || "조회 실패");
      setManualStatusItems(data.items || []);
      if (data.resolved_invoices?.length) loadManualInvoices();
      const resolvedNote = data.resolved_invoices?.length ? ` · 반송장 확인되어 ${data.resolved_invoices.length}건 목록에서 제외됨` : "";
      setManualStatusMessage(`${data.items?.length || 0}건 조회 완료${resolvedNote}`);
    } catch (err) {
      setManualStatusMessageIsError(true);
      setManualStatusMessage(err.message);
    } finally {
      setManualStatusLoading(false);
    }
  };

  // 반품 특이사항(송장번호+내용)을 개별 추가 현황 목록으로 가져온다 - 반품
  // 특이사항에 먼저 등록해둔 건을 여기서도 자동추적하고 싶을 때 쓴다.
  const syncSpecialNotes = async () => {
    setSpecialNoteSyncing(true);
    try {
      const res = await fetch(`${API}/return-automation/manual-invoices/sync-special-notes`, {
        method: "POST",
        headers: getAuthHeaders(),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.detail || "동기화 실패");
      loadManualInvoices();
      setManualStatusMessageIsError(false);
      setManualStatusMessage(`반품 특이사항에서 ${data.synced_count}건을 가져왔습니다.`);
    } catch (err) {
      setManualStatusMessageIsError(true);
      setManualStatusMessage(err.message);
    } finally {
      setSpecialNoteSyncing(false);
    }
  };

  const applyPreviewResult = useCallback((result) => {
    setBusy(false);
    if (!result.ok) {
      setMessageIsError(true);
      setMessage(result.error?.message || "조회 실패");
      return;
    }
    const data = result.data;
    setRun(data);
    const templates = data.templates || [];
    const preferredTemplate = defaultTemplateId != null
      ? templates.find((x) => String(x.id) === String(defaultTemplateId))
      : null;
    setTemplate(preferredTemplate || templates[0] || null);
    setSelected(
      Object.fromEntries((data.items || []).filter((x) => x.eligible).map((x) => [x.invoice_no, true]))
    );
    const errorNote = data.error_count ? ` · 오류 ${data.error_count}건 (개별 항목 오류 - 아래 표에서 확인)` : "";
    setMessage(
      `에이블리 ${data.source_item_count || 0}건 조회, ${data.excluded_recent_count || 0}건 제외, 대상 ${data.items?.length || 0}건${errorNote}`
    );
  }, [defaultTemplateId]);

  // If a preview started before this component was last unmounted (e.g. the
  // user switched to another sidebar tab mid-scan) is still running, resume
  // showing the busy state and pick up its result live instead of leaving
  // the screen looking idle until the next manual "최근 30일 조회" click.
  useEffect(() => {
    if (!activePreviewJob) return undefined;
    const job = activePreviewJob;
    setBusy(true);
    setMessageIsError(false);
    setMessage("최근 30일 반품 조회 → 이지어드민 회수 확인 → CS 조회 중... (다른 메뉴에 다녀와도 계속 진행됩니다)");
    job.listeners.add(applyPreviewResult);
    return () => job.listeners.delete(applyPreviewResult);
  }, [applyPreviewResult]);

  const passCount = run ? run.items.filter((x) => x.elapsed_status === "PASS").length : 0;
  const errorCount = run ? run.items.filter((x) => x.elapsed_status === "ERROR").length : 0;

  // 조회 대상 전체(run.items)는 통계 카드에서 그대로 보여주되, 표에는 기본적으로
  // 실행가능(eligible) 행만 표시한다. 다만 "상태별 선택"에서 대기중/오류 등 다른
  // 상태 칩을 체크하면 그 상태의 항목들이 selected에 추가되므로, 그것도 함께
  // 표에 노출해 사용자가 체크한 대상을 눈으로 확인할 수 있게 한다.
  const filteredItems = run ? run.items.filter((x) => x.eligible || selected[x.invoice_no]) : [];
  const visibleItems = (() => {
    if (!sortConfig.key) return filteredItems;
    const getter = SORT_GETTERS[sortConfig.key];
    const dir = sortConfig.dir === "asc" ? 1 : -1;
    return filteredItems
      .map((item, idx) => ({ item, idx, v: getter(item) }))
      .sort((a, b) => {
        const aEmpty = a.v === "" || a.v == null;
        const bEmpty = b.v === "" || b.v == null;
        if (aEmpty !== bEmpty) return aEmpty ? 1 : -1; // 빈 값은 항상 뒤로
        const c = typeof a.v === "number" && typeof b.v === "number"
          ? a.v - b.v
          : String(a.v).localeCompare(String(b.v), "ko", { numeric: true });
        return c * dir || a.idx - b.idx;
      })
      .map((x) => x.item);
  })();
  const toggleSort = (key) =>
    setSortConfig((prev) =>
      prev.key !== key ? { key, dir: "asc" } : prev.dir === "asc" ? { key, dir: "desc" } : { key: null, dir: "asc" }
    );
  const sortableTh = (key, label) => (
    <th onClick={() => toggleSort(key)} style={{ cursor: "pointer", userSelect: "none" }} title="클릭: 오름차순 → 내림차순 → 해제">
      {label}
      {sortConfig.key === key ? (sortConfig.dir === "asc" ? " ▲" : " ▼") : <span style={{ opacity: 0.3 }}> ↕</span>}
    </th>
  );

  // Groups invoice numbers by status so the status-filter chips can show a
  // count and know which rows to toggle without re-scanning run.items.
  const statusGroups = run
    ? Object.entries(
        run.items.reduce((acc, x) => {
          (acc[x.elapsed_status] ||= []).push(x.invoice_no);
          return acc;
        }, {})
      )
    : [];

  // A return split across multiple invoices under the same order_no is
  // executed as one unit on the backend (one SMS + one pickup - see
  // execute()'s order_no grouping in return_automation_routes.py), so the
  // checkboxes for those rows are kept in sync here: checking/unchecking one
  // invoice does the same to every other invoice sharing its order_no.
  const invoicesByOrder = run
    ? run.items.reduce((acc, x) => {
        const key = x.order_no || `__invoice__${x.invoice_no}`;
        (acc[key] ||= []).push(x.invoice_no);
        return acc;
      }, {})
    : {};
  const orderGroupKeyByInvoice = run
    ? Object.fromEntries(run.items.map((x) => [x.invoice_no, x.order_no || `__invoice__${x.invoice_no}`]))
    : {};

  const itemByInvoice = run ? Object.fromEntries(run.items.map((x) => [x.invoice_no, x])) : {};

  // 이미 반품거부 처리된 건은 어떤 경로로 선택을 걸어도(체크박스/전체/상태칩)
  // selected에 들어가지 않게 여기서 한 번에 걸러낸다.
  const setSelectedForInvoices = (invoices, checked) => {
    setSelected((prev) => {
      const next = { ...prev };
      invoices.forEach((inv) => {
        if (itemByInvoice[inv]?.rejected) return;
        if (checked) next[inv] = true;
        else delete next[inv];
      });
      return next;
    });
  };

  const selectableVisibleItems = visibleItems.filter((x) => !x.rejected);

  const toggleAll = (checked) => {
    if (checked) setSelectedForInvoices(selectableVisibleItems.map((x) => x.invoice_no), true);
    else setSelected({});
  };

  const toggleStatus = (invoices, checked) => setSelectedForInvoices(invoices, checked);

  const smsSent2PlusInvoices = run
    ? run.items.filter((x) => (x.sms_sent_count || 0) >= 2).map((x) => x.invoice_no)
    : [];

  const toggleInvoiceGroup = (invoiceNo, checked) => {
    const groupKey = orderGroupKeyByInvoice[invoiceNo];
    setSelectedForInvoices(invoicesByOrder[groupKey] || [invoiceNo], checked);
  };

  const openEzdeskSettings = async () => {
    setShowEzdeskSettings(true);
    setEzdeskMsg("");
    try {
      const res = await fetch(`${API}/return-automation/ezdesk-session`, { headers: getAuthHeaders() });
      const data = await res.json().catch(() => ({}));
      setEzdeskInput(data?.phpsessid || "");
      setEzdeskHasSession(!!data?.has_session);
    } catch {
      // Fetching the current value failed - user can still paste a fresh one.
    }
  };

  const saveEzdeskSettings = async () => {
    const phpsessid = ezdeskInput.trim();
    if (!phpsessid) {
      setEzdeskMsg("PHPSESSID를 입력해주세요.");
      return;
    }
    setEzdeskLoading(true);
    setEzdeskMsg("저장 중...");
    try {
      const res = await fetch(`${API}/return-automation/ezdesk-session`, {
        method: "POST",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ phpsessid }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) throw new Error(data?.detail || "저장 실패");
      setEzdeskHasSession(true);
      setEzdeskMsg("저장되었습니다.");
      setShowEzdeskSettings(false);
      // If this save was triggered by a mid-execute session-expiry prompt,
      // resume the exact same selection instead of making the user click
      // "선택 건 실행" again.
      const retry = ezdeskRetryRef.current;
      ezdeskRetryRef.current = null;
      if (retry) await retry();
    } catch (err) {
      setEzdeskMsg(err.message);
    } finally {
      setEzdeskLoading(false);
    }
  };

  const preview = () => {
    if (activePreviewJob) return; // already running - the mount effect above is already subscribed
    setBusy(true);
    setMessageIsError(false);
    setMessage("최근 30일 반품 조회 → 이지어드민 회수 확인 → CS 조회 중... (다른 메뉴에 다녀와도 계속 진행됩니다)");
    const job = startPreviewJob();
    job.listeners.add(applyPreviewResult);
  };

  // Separated from execute() so a mid-run EZAdmin session expiry can retry
  // with the exact same selection after the user re-pastes PHPSESSID, instead
  // of re-showing the confirm() dialog.
  const runExecute = async (items) => {
    setBusy(true);
    try {
      const res = await fetch(`${API}/return-automation/execute`, {
        method: "POST",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ run_id: run.run_id, items }),
      });
      const data = await res.json();
      if (data?.need_session) {
        setMessageIsError(true);
        setMessage("EZAdmin 세션이 만료되었습니다. 세션을 다시 입력하면 나머지 선택 건을 이어서 실행합니다.");
        openEzadminModal(() => runExecute(items));
        return;
      }
      // EZDesk(문자 발송)는 메인 EZAdmin과 로그인이 별개라 PHPSESSID도 따로
      // 저장해야 한다 - 같은 재시도 패턴이지만 다른 쿠키/엔드포인트를 쓴다.
      if (data?.need_ezdesk_session) {
        setMessageIsError(true);
        setMessage("EZDesk 세션이 만료되었습니다. 세션을 다시 입력하면 나머지 선택 건을 이어서 실행합니다.");
        ezdeskRetryRef.current = () => runExecute(items);
        openEzdeskSettings();
        return;
      }
      if (!res.ok) throw new Error(data.detail || "실행 실패");

      // Reflect this batch's outcome on the rows immediately (실행결과 배지 +
      // 문자 발송 총 횟수) instead of requiring another "최근 30일 조회" to
      // see anything changed. sms_sent_count/sms_sent_history start out as
      // whatever preview() pulled from EZDesk's own history for this phone
      // number (total sent to them, not "which number in this run") - a
      // successful send here just bumps that same running total by one
      // instead of resetting/replacing it. run.smsSentTotal is a separate,
      // simpler "how many sends did this dashboard session make" counter.
      const resultByInvoice = Object.fromEntries((data.results || []).map((r) => [r.invoice_no, r]));
      const sentItemByInvoice = Object.fromEntries(items.map((it) => [it.invoice_no, it]));
      setRun((prev) => {
        if (!prev) return prev;
        let smsCounter = prev.smsSentTotal || 0;
        const nextItems = prev.items.map((item) => {
          const r = resultByInvoice[item.invoice_no];
          if (!r) return item;
          const smsSent = !!(r.sms && !r.sms.error);
          let smsSentCount = item.sms_sent_count || 0;
          let smsSentHistory = item.sms_sent_history || [];
          if (smsSent) {
            smsCounter += 1;
            smsSentCount += 1;
            smsSentHistory = [
              ...smsSentHistory,
              { input_time: new Date().toISOString(), content: sentItemByInvoice[item.invoice_no]?.template?.msg || "", direction: "sent" },
            ];
          }
          return {
            ...item,
            executed: !r.error && !r.skipped && !r.grouped_with,
            executeError: r.error || null,
            skipped: !!r.skipped,
            groupedWith: r.grouped_with || null,
            smsSent,
            sms_sent_count: smsSentCount,
            sms_sent_history: smsSentHistory,
          };
        });
        return { ...prev, items: nextItems, smsSentTotal: smsCounter };
      });

      const failures = (data.results || []).filter((x) => x.error);
      setMessageIsError(failures.length > 0);
      setMessage(
        failures.length
          ? `실패 ${failures.length}건: ${failures.map((x) => `${x.invoice_no} - ${x.error}`).join(" | ")}`
          : `선택 건 실행 완료 (${(data.results || []).length}건)`
      );
    } catch (err) {
      setMessageIsError(true);
      setMessage(err.message);
    } finally {
      setBusy(false);
    }
  };

  const checkCs = async () => {
    // 조회 대상 전체(전화번호가 있는 건)를 확인한다. 문자 발송 횟수와 무관.
    const targets = (run.items || []).filter((x) => x.phone);
    if (!targets.length) {
      setMessageIsError(true);
      setMessage("전화번호가 확인된 건이 없어 CS를 조회할 수 없습니다.");
      return;
    }
    setCsChecking(true);
    setMessageIsError(false);
    setMessage("CS 문의 확인 중...");
    try {
      const res = await fetch(`${API}/return-automation/check-cs`, {
        method: "POST",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          items: targets.map((x) => ({ invoice_no: x.invoice_no, phone: x.phone })),
          start_date: run.start_date,
          end_date: run.end_date,
        }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.detail || "CS 확인 실패");
      const results = data.results || {};
      setRun((prev) => {
        if (!prev) return prev;
        return { ...prev, items: prev.items.map((x) => (results[x.phone] ? { ...x, csCheck: results[x.phone] } : x)) };
      });
      setMessage(`CS 확인 완료 (${targets.length}건 조회)`);
    } catch (err) {
      setMessageIsError(true);
      setMessage(err.message);
    } finally {
      setCsChecking(false);
    }
  };

  // ---- 주문매칭실패 건 수동 매칭 ----
  const openMatch = (item) => {
    setMatchModal({ item, keyword: String(item.phone || "").replace(/\D/g, ""), loading: false, candidates: null, error: "", applying: false });
  };

  const searchMatch = async () => {
    if (!matchModal) return;
    const keyword = matchModal.keyword.trim();
    if (!keyword) return;
    setMatchModal((m) => ({ ...m, loading: true, error: "", candidates: null }));
    try {
      const res = await fetch(`${API}/return-automation/match/search`, {
        method: "POST",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ keyword }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || "검색 실패");
      setMatchModal((m) => (m ? { ...m, loading: false, candidates: data.candidates || [] } : m));
    } catch (err) {
      setMatchModal((m) => (m ? { ...m, loading: false, error: err.message || "검색 실패" } : m));
    }
  };

  const applyMatch = async (cand) => {
    if (!matchModal) return;
    const { item } = matchModal;
    setMatchModal((m) => ({ ...m, applying: true, error: "" }));
    try {
      const res = await fetch(`${API}/return-automation/match/apply`, {
        method: "POST",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ invoice_no: item.invoice_no, pack: cand.pack, ez_invoice: cand.ez_invoice, item }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || "매칭 실패");
      setRun((prev) => {
        if (!prev) return prev;
        if (data.returned) return { ...prev, items: prev.items.filter((x) => x.invoice_no !== item.invoice_no) };
        return { ...prev, items: prev.items.map((x) => (x.invoice_no === item.invoice_no ? data.item : x)) };
      });
      setMessageIsError(false);
      setMessage(
        data.returned
          ? `송장 ${item.invoice_no}: 이지어드민에 이미 회수(반송장 ${(data.takebacks || []).join(", ")})가 접수돼 있어 목록에서 뺐습니다.`
          : `송장 ${item.invoice_no}: 이지어드민 주문(관리번호 ${cand.pack})과 매칭했습니다.`
      );
      setMatchModal(null);
    } catch (err) {
      setMatchModal((m) => (m ? { ...m, applying: false, error: err.message || "매칭 실패" } : m));
    }
  };

  const removeMatch = async (item) => {
    if (!window.confirm(`송장 ${item.invoice_no}의 수동 매칭을 해제할까요? 다음 조회부터 다시 주문매칭실패로 표시됩니다.`)) return;
    try {
      const res = await fetch(`${API}/return-automation/match/${encodeURIComponent(item.invoice_no)}`, {
        method: "DELETE",
        headers: getAuthHeaders(),
      });
      if (handleUnauthorized(res)) return;
      if (!res.ok) throw new Error("해제 실패");
      setRun((prev) => (prev ? {
        ...prev,
        items: prev.items.map((x) => (x.invoice_no === item.invoice_no
          ? { ...x, matched_manually: false, ez_invoice_no: "", elapsed_status: "CS_SEQ_MISSING", eligible: false }
          : x)),
      } : prev));
    } catch (err) {
      setMessageIsError(true);
      setMessage(err.message || "해제 실패");
    }
  };

  const openCsDetail = async (phone) => {
    setCsDetail({ phone, loading: true, rooms: [], error: "" });
    try {
      const res = await fetch(`${API}/returns/unmatched/cs-detail`, {
        method: "POST",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ phone }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.detail || "CS 내용 조회 실패");
      setCsDetail({ phone, loading: false, rooms: data.rooms || [], error: "" });
    } catch (err) {
      setCsDetail({ phone, loading: false, rooms: [], error: err.message || "CS 내용 조회 실패" });
    }
  };

  const execute = async () => {
    const items = (run.items || [])
      .filter((x) => selected[x.invoice_no])
      .map((x) => ({ ...x, template }));
    if (!items.length) {
      setMessageIsError(true);
      setMessage("실행할 건을 선택하세요.");
      return;
    }
    if (!confirm(`${items.length}건을 실행할까요? EZAdmin 문자/반품회수접수가 수행됩니다.`)) return;
    await runExecute(items);
  };

  // 반품거부는 에이블리 반품요청(cancel_sno) 단위로 처리되므로 실행결과와
  // 별개 API를 호출한다. 거부사유는 고정 문구("문자 3통 답변 x 물건 회수 x")로
  // 백엔드에서 채운다 - 프론트는 대상만 넘긴다.
  const rejectSelected = async () => {
    const items = (run.items || [])
      .filter((x) => selected[x.invoice_no])
      .map((x) => ({ invoice_no: x.invoice_no, cancel_sno: x.cancel_sno }));
    if (!items.length) {
      setMessageIsError(true);
      setMessage("거부할 건을 선택하세요.");
      return;
    }
    if (!confirm(`${items.length}건을 반품거부 처리할까요? 에이블리에 반품 거부 요청이 전송됩니다.`)) return;
    setRejecting(true);
    try {
      const res = await fetch(`${API}/return-automation/reject`, {
        method: "POST",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ items }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || "반품거부 실패");
      const resultByInvoice = Object.fromEntries((data.results || []).map((r) => [r.invoice_no, r]));
      setRun((prev) => {
        if (!prev) return prev;
        const nextItems = prev.items.map((item) => {
          const r = resultByInvoice[item.invoice_no];
          if (!r) return item;
          return { ...item, rejected: !r.error, rejectError: r.error || null };
        });
        return { ...prev, items: nextItems };
      });
      // 거부 성공한 건은 체크박스가 잠기므로 선택 상태도 같이 지워, 다음
      // "전체" 토글이 잔여 selected 때문에 어긋나지 않게 한다.
      setSelected((prev) => {
        const next = { ...prev };
        (data.results || []).forEach((r) => {
          if (!r.error) delete next[r.invoice_no];
        });
        return next;
      });
      const failures = (data.results || []).filter((x) => x.error);
      setMessageIsError(failures.length > 0);
      setMessage(
        failures.length
          ? `반품거부 실패 ${failures.length}건: ${failures.map((x) => `${x.invoice_no} - ${x.error}`).join(" | ")}`
          : `반품거부 완료 (${(data.results || []).length}건)`
      );
    } catch (err) {
      setMessageIsError(true);
      setMessage(err.message);
    } finally {
      setRejecting(false);
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h2 className={styles.title}>반품 자동화 대시보드</h2>
        <p className={styles.subtitle}>
          최근 30일 반품 중 반송장이 아직 없는 건을 찾아, 고객 CS 이력을 확인해 문자 발송 + 반품회수 접수를 자동으로 진행합니다.
        </p>
      </div>

      <div className={styles.subTabBar}>
        <button
          type="button"
          className={`${styles.subTabBtn} ${subTab === "scan" ? styles.subTabActive : ""}`}
          onClick={() => setSubTab("scan")}
        >
          자동 스캔
        </button>
        <button
          type="button"
          className={`${styles.subTabBtn} ${subTab === "manual" ? styles.subTabActive : ""}`}
          onClick={() => setSubTab("manual")}
        >
          개별 추가 현황{manualInvoices.length > 0 ? ` (${manualInvoices.length})` : ""}
        </button>
      </div>

      {subTab === "scan" && (
      <>
      <div className={styles.toolbar}>
        <button type="button" className={styles.btn} onClick={preview} disabled={busy}>
          {busy ? "처리 중…" : "최근 30일 조회"}
        </button>
        <button type="button" className={styles.btn} onClick={openEzdeskSettings}>
          이지데스크 설정{ezdeskHasSession ? "" : " (미설정)"}
        </button>
        {run && (
          <>
            <select
              className={styles.select}
              value={template?.id || ""}
              onChange={(e) => setTemplate(run.templates.find((x) => String(x.id) === e.target.value) || null)}
            >
              <option value="">문자 템플릿 선택</option>
              {run.templates?.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}{String(x.id) === String(defaultTemplateId) ? " ★ 기본값" : ""}
                </option>
              ))}
            </select>
            <button
              type="button"
              className={styles.btn}
              disabled={!template}
              title="다음 조회부터 이 템플릿이 자동으로 선택됩니다"
              onClick={() =>
                setDefaultTemplateId((prev) =>
                  prev != null && String(prev) === String(template?.id) ? null : template?.id ?? null
                )
              }
            >
              {template && String(template.id) === String(defaultTemplateId) ? "기본값 해제" : "기본값으로 저장"}
            </button>
            <button type="button" className={`${styles.btn} ${styles.primaryBtn}`} onClick={execute} disabled={busy}>
              선택 건 실행
            </button>
            <button type="button" className={styles.btn} onClick={rejectSelected} disabled={rejecting}>
              {rejecting ? "거부 처리 중…" : "반품거부"}
            </button>
            <button type="button" className={styles.btn} onClick={checkCs} disabled={csChecking}>
              {csChecking ? "CS 확인 중…" : "CS확인"}
            </button>
          </>
        )}
      </div>

      {run && statusGroups.length > 0 && (
        <div className={styles.statusFilters}>
          <span className={styles.statusFiltersLabel}>상태별 선택</span>
          {statusGroups.map(([status, invoices]) => {
            const meta = STATUS_META[status] || { label: status || "-" };
            const allChecked = invoices.every((inv) => selected[inv]);
            return (
              <label key={status} className={styles.statusFilterChip}>
                <input
                  type="checkbox"
                  checked={allChecked}
                  onChange={(e) => toggleStatus(invoices, e.target.checked)}
                />
                {meta.label} ({invoices.length})
              </label>
            );
          })}
          {smsSent2PlusInvoices.length > 0 && (
            <label className={styles.statusFilterChip}>
              <input
                type="checkbox"
                checked={smsSent2PlusInvoices.every((inv) => selected[inv])}
                onChange={(e) => toggleStatus(smsSent2PlusInvoices, e.target.checked)}
              />
              문자발송 2회 이상 ({smsSent2PlusInvoices.length})
            </label>
          )}
        </div>
      )}

      <PreviewProgress active={busy} />
      {message && (
        <p className={`${styles.message} ${messageIsError ? styles.messageError : ""}`}>{message}</p>
      )}

      {run && (
        <>
          <div className={styles.stats}>
            <div className={styles.stat}>
              <span className={styles.statLabel}>조회 대상</span>
              <span className={styles.statValue}>{run.items.length}</span>
            </div>
            <div className={styles.stat}>
              <span className={styles.statLabel}>실행가능</span>
              <span className={`${styles.statValue} ${styles.statValuePass}`}>{passCount}</span>
            </div>
            <div className={styles.stat}>
              <span className={styles.statLabel}>오류</span>
              <span className={`${styles.statValue} ${errorCount ? styles.statValueError : ""}`}>{errorCount}</span>
            </div>
            <div className={styles.stat}>
              <span className={styles.statLabel}>제외(최근접수)</span>
              <span className={styles.statValue}>{run.excluded_recent_count || 0}</span>
            </div>
            <div className={styles.stat}>
              <span className={styles.statLabel}>이번 실행 발송</span>
              <span className={styles.statValue}>{run.smsSentTotal || 0}통</span>
            </div>
          </div>

          <p className={styles.runMeta}>
            실행 ID: {run.run_id} · 기간: {run.start_date} ~ {run.end_date}
          </p>

          <div className={styles.preview}>
            <table>
              <thead>
                <tr>
                  <th>
                    <label className={styles.selectAllLabel}>
                      <input
                        type="checkbox"
                        checked={selectableVisibleItems.length > 0 && selectableVisibleItems.every((x) => selected[x.invoice_no])}
                        onChange={(e) => toggleAll(e.target.checked)}
                      />
                      전체
                    </label>
                  </th>
                  <th style={{ width: "28px" }}></th>
                  {sortableTh("order", "주문/송장")}
                  {sortableTh("phone", "전화번호")}
                  {sortableTh("returnDate", "반품신청일")}
                  {sortableTh("returnInvoice", "반송장")}
                  {sortableTh("logis", "원송장 LOGIS")}
                  {sortableTh("inputTime", "CS 등록일시")}
                  {sortableTh("status", "상태")}
                  {sortableTh("result", "실행결과")}
                  {sortableTh("lastDirection", "마지막 문자")}
                  {sortableTh("content", "수신 내용 / 오류")}
                  <th>문자 발송</th>
                </tr>
              </thead>
              <tbody>
                {visibleItems.length === 0 ? (
                  <tr>
                    <td colSpan={13} className={styles.empty}>실행 가능한 대상이 없습니다.</td>
                  </tr>
                ) : (
                  visibleItems.map((item) => {
                    const groupKey = orderGroupKeyByInvoice[item.invoice_no];
                    const groupSize = (invoicesByOrder[groupKey] || []).length;
                    const inv = item.invoice_no;
                    const hasMemo = inv && !!memos[inv];
                    const isMemoExpanded = inv && expandedMemos.has(inv);
                    const isReplyExpanded = inv && expandedReplies.has(inv);
                    return (
                    <React.Fragment key={item.invoice_no}>
                    <tr className={item.elapsed_status === "ERROR" ? styles.rowError : ""}>
                      <td>
                        <input
                          type="checkbox"
                          checked={!!selected[item.invoice_no]}
                          disabled={!!item.rejected}
                          title={item.rejected ? "이미 반품거부 처리된 건입니다" : undefined}
                          onChange={(e) => toggleInvoiceGroup(item.invoice_no, e.target.checked)}
                        />
                      </td>
                      <td style={{ textAlign: "center", padding: "0 4px" }}>
                        {inv ? (
                          <button
                            type="button"
                            onClick={() => toggleMemo(inv)}
                            title={hasMemo ? memos[inv] : "메모 추가"}
                            style={{
                              background: "none",
                              border: "none",
                              cursor: "pointer",
                              padding: "2px",
                              color: hasMemo ? "var(--accent-blue, #3b82f6)" : "var(--text-muted)",
                              opacity: hasMemo ? 1 : 0.45,
                              display: "flex",
                              alignItems: "center",
                            }}
                          >
                            <MessageSquare size={14} fill={hasMemo ? "currentColor" : "none"} />
                          </button>
                        ) : null}
                      </td>
                      <td>
                        {item.kind === "exchange" && (
                          <span className={`${styles.badge} ${styles.badgeNeutral}`} title="교환반품(교환수거중) - 반품과 동일하게 문자발송+회수신청을 실행합니다. 에이블리 반품송장 등록은 교환반품 테스트 탭에서 처리합니다" style={{ marginRight: "0.3rem" }}>교환</span>
                        )}
                        {item.manual && (
                          <span className={`${styles.badge} ${styles.badgeNeutral}`} title="개별 추가한 송장번호입니다 - 반품거부는 지원되지 않습니다" style={{ marginRight: "0.3rem" }}>개별추가</span>
                        )}
                        {item.cancel_sno || item.order_no}
                        {groupSize > 1 && <span className={styles.groupHint} title="같은 주문번호 - 체크박스가 함께 작동하고 문자/회수접수도 한 번만 실행됩니다">동일주문 {groupSize}건</span>}
                        <br />
                        {item.invoice_no}
                      </td>
                      <td>{item.phone || "-"}</td>
                      <td>{formatShortDate(item.return_date) || "-"}</td>
                      <td>{item.return_invoice_no || "없음"}</td>
                      <td>
                        {item.logis_found ? "조회됨" : "없음"}
                        <br />
                        {item.logis?.llogis_status || "-"}
                      </td>
                      <td>{item.input_time || "-"}</td>
                      <td>
                        <StatusBadge status={item.elapsed_status} stage={item.error_stage} />
                        {item.matched_manually && (
                          <span className={`${styles.badge} ${styles.badgeNeutral}`} style={{ marginLeft: "0.3rem" }} title={`이지어드민 송장 ${item.ez_invoice_no || "-"}로 수동 매칭됨`}>수동매칭</span>
                        )}
                        {item.elapsed_status === "CS_SEQ_MISSING" && (
                          <button type="button" className={styles.smsIndexBtn} style={{ marginLeft: "0.4rem" }} onClick={() => openMatch(item)} title="구매자 전화번호로 이지어드민 주문을 찾아 직접 매칭합니다">
                            수동 매칭
                          </button>
                        )}
                        {item.matched_manually && (
                          <button type="button" className={styles.smsIndexBtn} style={{ marginLeft: "0.3rem" }} onClick={() => removeMatch(item)}>해제</button>
                        )}
                      </td>
                      <td>
                        {item.rejectError ? (
                          <span className={`${styles.badge} ${styles.badgeError}`} title={item.rejectError}>거부실패</span>
                        ) : item.rejected ? (
                          <span className={`${styles.badge} ${styles.badgeNeutral}`}>반품거부됨</span>
                        ) : item.executeError ? (
                          <span className={`${styles.badge} ${styles.badgeError}`} title={item.executeError}>실행오류</span>
                        ) : item.groupedWith ? (
                          <span className={`${styles.badge} ${styles.badgeNeutral}`} title={`송장 ${item.groupedWith}과(와) 같은 주문으로 묶여 처리됨`}>묶음처리</span>
                        ) : item.skipped ? (
                          <span className={`${styles.badge} ${styles.badgeNeutral}`}>이미처리됨</span>
                        ) : item.executed ? (
                          <span className={`${styles.badge} ${styles.badgePass}`}>처리완료</span>
                        ) : (
                          "-"
                        )}
                      </td>
                      <td>
                        {directionLabel(item.last_direction)}
                        {item.csCheck && (
                          <span
                            className={`${styles.badge} ${item.csCheck.has_contact ? styles.badgePass : styles.badgeNeutral}`}
                            style={{ marginLeft: "0.4rem", cursor: item.csCheck.has_contact ? "pointer" : undefined }}
                            onClick={item.csCheck.has_contact ? () => openCsDetail(item.phone) : undefined}
                            title={
                              item.csCheck.has_contact
                                ? `[${item.csCheck.status_display || "-"}] ${item.csCheck.latest_message || ""} (${item.csCheck.latest_message_at || ""})`
                                : undefined
                            }
                          >
                            {item.csCheck.has_contact ? `CS문의 있음(${item.csCheck.count})` : "CS문의 없음"}
                          </span>
                        )}
                      </td>
                      <td className={item.error ? styles.errorText : styles.content}>
                        {limitLineBreaks(item.error || item.received_content) || "-"}
                        {inv && item.phone && (
                          <button
                            type="button"
                            className={styles.smsIndexBtn}
                            style={{ marginLeft: "0.5rem" }}
                            onClick={() => toggleReply(inv)}
                          >
                            답장
                          </button>
                        )}
                      </td>
                      <td>
                        {item.sms_sent_count > 0 ? (
                          <button
                            type="button"
                            className={styles.smsIndexBtn}
                            onClick={() => setSmsPreview({
                              invoiceNo: item.invoice_no,
                              history: item.sms_sent_history || [],
                            })}
                          >
                            총 {item.sms_sent_count}회
                          </button>
                        ) : (
                          "-"
                        )}
                      </td>
                    </tr>
                    {isMemoExpanded && (
                      <tr style={{ background: "var(--bg-secondary)" }}>
                        <td colSpan={12} style={{ padding: "0.5rem 1rem 0.75rem 2.5rem" }}>
                          <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginBottom: "0.3rem" }}>
                            메모 — {inv}
                          </div>
                          <div style={{ display: "flex", gap: "0.5rem", alignItems: "flex-start", maxWidth: "620px" }}>
                            <textarea
                              value={draftMemos[inv] ?? ""}
                              onChange={(e) => setDraftMemos((d) => ({ ...d, [inv]: e.target.value }))}
                              placeholder="메모를 입력하세요..."
                              rows={2}
                              style={{
                                flex: 1,
                                fontSize: "0.85rem",
                                padding: "0.4rem 0.6rem",
                                border: "1px solid var(--border-color)",
                                borderRadius: "var(--radius-sm)",
                                background: "var(--bg-primary)",
                                color: "var(--text-primary)",
                                resize: "vertical",
                                outline: "none",
                                lineHeight: 1.5,
                              }}
                              onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) saveMemo(inv); }}
                              autoFocus
                            />
                            <button type="button" onClick={() => saveMemo(inv)} className={styles.btn} style={{ whiteSpace: "nowrap", alignSelf: "flex-end" }}>
                              저장
                            </button>
                          </div>
                        </td>
                      </tr>
                    )}
                    {isReplyExpanded && (
                      <tr style={{ background: "var(--bg-secondary)" }}>
                        <td colSpan={12} style={{ padding: "0.5rem 1rem 0.75rem 2.5rem" }}>
                          <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginBottom: "0.3rem" }}>
                            답장 — {inv} ({item.phone || "전화번호 없음"})
                          </div>
                          <div style={{ display: "flex", gap: "0.5rem", alignItems: "flex-start", maxWidth: "620px" }}>
                            <textarea
                              value={draftReplies[inv] ?? ""}
                              onChange={(e) => setDraftReplies((d) => ({ ...d, [inv]: e.target.value }))}
                              placeholder="답장 내용을 입력하세요..."
                              rows={3}
                              style={{
                                flex: 1,
                                fontSize: "0.85rem",
                                padding: "0.4rem 0.6rem",
                                border: "1px solid var(--border-color)",
                                borderRadius: "var(--radius-sm)",
                                background: "var(--bg-primary)",
                                color: "var(--text-primary)",
                                resize: "vertical",
                                outline: "none",
                                lineHeight: 1.5,
                              }}
                              onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) sendReply(item); }}
                              autoFocus
                            />
                            <button
                              type="button"
                              onClick={() => sendReply(item)}
                              disabled={!!replySending[inv] || !(draftReplies[inv] || "").trim()}
                              className={styles.btn}
                              style={{ whiteSpace: "nowrap", alignSelf: "flex-end" }}
                            >
                              {replySending[inv] ? "전송 중..." : "전송"}
                            </button>
                          </div>
                        </td>
                      </tr>
                    )}
                    </React.Fragment>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
      </>
      )}

      {subTab === "manual" && (
        <div className={styles.manualTabContent}>
          <div className={styles.manualAddRow}>
            <input
              type="text"
              className={styles.manualInput}
              value={manualInvoiceInput}
              onChange={(e) => setManualInvoiceInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") addManualInvoice(); }}
              placeholder="송장번호"
            />
            <input
              type="text"
              className={styles.manualReasonInput}
              value={manualReasonInput}
              onChange={(e) => setManualReasonInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") addManualInvoice(); }}
              placeholder="사유 (선택)"
            />
            <button type="button" className={styles.btn} onClick={addManualInvoice} disabled={manualBusy || !manualInvoiceInput.trim()}>
              추가
            </button>
            <button type="button" className={`${styles.btn} ${styles.primaryBtn}`} onClick={loadManualStatus} disabled={manualStatusLoading || manualInvoices.length === 0}>
              {manualStatusLoading ? "조회 중…" : "상태 조회"}
            </button>
            <button
              type="button"
              className={styles.btn}
              onClick={syncSpecialNotes}
              disabled={specialNoteSyncing}
              title="반품 특이사항에 등록된 송장번호+내용을 이 목록으로 가져옵니다"
            >
              {specialNoteSyncing ? "동기화 중…" : "특이사항 동기화"}
            </button>
          </div>

          {manualStatusMessage && (
            <p className={`${styles.message} ${manualStatusMessageIsError ? styles.messageError : ""}`}>{manualStatusMessage}</p>
          )}

          {manualInvoices.length === 0 ? (
            <p className={styles.empty}>개별 추가된 주문이 없습니다.</p>
          ) : (
            <div className={styles.preview}>
              <table>
                <thead>
                  <tr>
                    <th>송장번호</th>
                    <th>사유</th>
                    <th>추가일시</th>
                    <th>전화번호</th>
                    <th>반송장</th>
                    <th>CS 등록일시</th>
                    <th>상태</th>
                    <th>수신 내용 / 오류</th>
                    <th>문자 발송</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {manualInvoices.map((row) => {
                    const statusItem = manualStatusItems?.find((x) => x.invoice_no === row.invoice_no);
                    return (
                      <tr key={row.invoice_no}>
                        <td>{row.invoice_no}</td>
                        <td className={styles.content}>{row.reason || "-"}</td>
                        <td>{formatShortDate(row.added_at) || "-"}</td>
                        <td>{statusItem?.phone || "-"}</td>
                        <td>{statusItem ? (statusItem.return_invoice_no || "없음") : "-"}</td>
                        <td>{statusItem?.input_time || "-"}</td>
                        <td>
                          {statusItem ? (
                            <StatusBadge status={statusItem.elapsed_status} stage={statusItem.error_stage} />
                          ) : (
                            <span className={`${styles.badge} ${styles.badgeNeutral}`}>미조회</span>
                          )}
                        </td>
                        <td className={statusItem?.error ? styles.errorText : styles.content}>
                          {statusItem ? (limitLineBreaks(statusItem.error || statusItem.received_content) || "-") : "-"}
                        </td>
                        <td>{statusItem?.sms_sent_count > 0 ? `총 ${statusItem.sms_sent_count}회` : "-"}</td>
                        <td>
                          <button type="button" className={styles.smsIndexBtn} onClick={() => removeManualInvoice(row.invoice_no)}>
                            삭제
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {showEzdeskSettings && (
        <div className={styles.modalOverlay} onClick={() => setShowEzdeskSettings(false)}>
          <div className={styles.modalBox} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <span>이지데스크 설정</span>
              <button type="button" className={styles.modalCloseBtn} onClick={() => setShowEzdeskSettings(false)}>닫기</button>
            </div>
            <p className={styles.modalHint}>
              ezdesk.ezadmin.co.kr에 로그인 후 개발자 도구(F12) → 쿠키에서 PHPSESSID 값을 복사해 입력하세요.
              다시 입력하기 전까지 계속 저장되어 사용됩니다{ezdeskHasSession ? " (현재 설정되어 있음)" : ""}.
            </p>
            <input
              className={styles.modalInput}
              value={ezdeskInput}
              onChange={(e) => setEzdeskInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") saveEzdeskSettings(); }}
              placeholder="PHPSESSID 값 붙여넣기"
              autoFocus
            />
            {ezdeskMsg && <p className={styles.modalMsg}>{ezdeskMsg}</p>}
            <button
              type="button"
              className={`${styles.btn} ${styles.primaryBtn}`}
              onClick={saveEzdeskSettings}
              disabled={ezdeskLoading}
            >
              {ezdeskLoading ? "저장 중..." : "저장"}
            </button>
          </div>
        </div>
      )}

      {csDetail && (
        <div className={styles.modalOverlay} onClick={() => setCsDetail(null)}>
          <div className={styles.modalBox} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <span>에이블리 CS 내용 · {csDetail.phone}</span>
              <button type="button" className={styles.modalCloseBtn} onClick={() => setCsDetail(null)}>닫기</button>
            </div>
            <div className={styles.smsHistoryList}>
              {csDetail.loading && <p className={styles.modalSmsContent}>불러오는 중...</p>}
              {!csDetail.loading && csDetail.error && <p className={styles.modalSmsContent}>{csDetail.error}</p>}
              {!csDetail.loading && !csDetail.error && csDetail.rooms.length === 0 && (
                <p className={styles.modalSmsContent}>CS문의 내용을 찾을 수 없습니다.</p>
              )}
              {!csDetail.loading && csDetail.rooms.map((room, i) => (
                <div key={i} className={styles.smsHistoryItem}>
                  <span className={styles.smsHistoryMeta}>{room.market_name} · {room.status_display}</span>
                  {room.error && <p className={styles.modalSmsContent}>{room.error}</p>}
                  {(room.messages || []).map((msg, j) => (
                    <div key={j}>
                      <span className={styles.smsHistoryMeta}>{msg.sender} · {msg.created_at}</span>
                      <p className={styles.modalSmsContent}>{limitLineBreaks(msg.content) || "(내용 없음)"}</p>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {matchModal && (
        <div className={styles.modalOverlay} onClick={() => setMatchModal(null)}>
          <div className={styles.modalBox} style={{ width: "min(860px, 94vw)" }} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <span>주문 수동 매칭 · 에이블리 송장 {matchModal.item.invoice_no}</span>
              <button type="button" className={styles.modalCloseBtn} onClick={() => setMatchModal(null)}>닫기</button>
            </div>
            <p className={styles.modalHint}>
              {[matchModal.item.goods_name, matchModal.item.option_info, matchModal.item.buyer_name].filter(Boolean).join(" · ") || "반품 상품 정보 없음"}
              {" — 구매자 전화번호로 이지어드민 주문을 검색해, 같은 건을 골라 주세요."}
            </p>
            <div style={{ display: "flex", gap: "0.5rem", margin: "0.5rem 0" }}>
              <input
                className={styles.modalInput}
                value={matchModal.keyword}
                placeholder="전화번호 (이름·주문번호도 가능)"
                onChange={(e) => setMatchModal((m) => ({ ...m, keyword: e.target.value }))}
                onKeyDown={(e) => e.key === "Enter" && searchMatch()}
              />
              <button type="button" className={styles.btn} onClick={searchMatch} disabled={matchModal.loading}>
                {matchModal.loading ? "검색 중…" : "검색"}
              </button>
            </div>
            {matchModal.error && <p className={styles.modalSmsContent} style={{ color: "#dc2626" }}>{matchModal.error}</p>}
            {matchModal.candidates && matchModal.candidates.length === 0 && (
              <p className={styles.modalSmsContent}>이지어드민에서 찾은 주문이 없습니다. 다른 번호나 이름으로 검색해 보세요.</p>
            )}
            {matchModal.candidates && matchModal.candidates.length > 0 && (
              <div style={{ maxHeight: "50vh", overflow: "auto" }}>
                <table className={styles.manualTable || undefined} style={{ width: "100%", fontSize: "0.8rem" }}>
                  <thead>
                    <tr><th>주문일</th><th>판매처</th><th>상품명</th><th>옵션</th><th>수량</th><th>수령자</th><th>이지어드민 송장</th><th>기존 회수</th><th></th></tr>
                  </thead>
                  <tbody>
                    {matchModal.candidates.map((c, i) => (
                      <tr key={`${c.pack}-${c.ez_invoice}-${i}`}>
                        <td>{c.order_date}</td>
                        <td>{c.shop_name}</td>
                        <td>{c.product_name}</td>
                        <td>{c.options}</td>
                        <td>{c.qty}</td>
                        <td>{c.recv_name}</td>
                        <td>{c.ez_invoice || "-"}</td>
                        <td>{c.takeback_count > 0 ? `${c.takeback_count}건 접수됨` : "없음"}</td>
                        <td>
                          <button type="button" className={styles.smsIndexBtn} disabled={matchModal.applying} onClick={() => applyMatch(c)}>
                            이 주문으로 매칭
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {smsPreview && (
        <div className={styles.modalOverlay} onClick={() => setSmsPreview(null)}>
          <div className={styles.modalBox} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <span>발송 문자 내역 ({smsPreview.history.length}건) · {smsPreview.invoiceNo}</span>
              <button type="button" className={styles.modalCloseBtn} onClick={() => setSmsPreview(null)}>닫기</button>
            </div>
            <div className={styles.smsHistoryList}>
              {smsPreview.history.length === 0 ? (
                <p className={styles.modalSmsContent}>(내용 없음)</p>
              ) : (
                smsPreview.history.map((msg, i) => (
                  <div key={i} className={styles.smsHistoryItem}>
                    <span className={styles.smsHistoryMeta}>{i + 1}번째 · {msg.input_time || "-"}</span>
                    <p className={styles.modalSmsContent}>{limitLineBreaks(msg.content) || "(내용 없음)"}</p>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
