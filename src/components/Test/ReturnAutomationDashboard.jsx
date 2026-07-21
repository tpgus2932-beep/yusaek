import React, { useEffect, useRef, useState } from "react";
import { MessageSquare } from "lucide-react";
import { LOCAL_API_BASE as API, getAuthHeaders, handleUnauthorized } from "../../lib/api";
import { useEzadminSession } from "../../lib/EzadminSessionContext";
import styles from "./ReturnAutomationDashboard.module.css";

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
  EZADMIN_CS_HISTORY: "EZAdmin CS이력조회",
};

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


export default function ReturnAutomationDashboard() {
  const [run, setRun] = useState(() => loadStored(RUN_STORAGE_KEY, null));
  const [selected, setSelected] = useState(() => loadStored(SELECTED_STORAGE_KEY, {}));
  const [template, setTemplate] = useState(() => loadStored(TEMPLATE_STORAGE_KEY, null));
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

  const applyPreviewResult = (result) => {
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
  };

  // If a preview started before this component was last unmounted (e.g. the
  // user switched to another sidebar tab mid-scan) is still running, resume
  // showing the busy state and pick up its result live instead of leaving
  // the screen looking idle until the next manual "최근 30일 조회" click.
  useEffect(() => {
    if (!activePreviewJob) return undefined;
    const job = activePreviewJob;
    setBusy(true);
    setMessageIsError(false);
    setMessage("최근 30일 반품 조회 → LOGIS 조회 → CS 조회 중... (다른 메뉴에 다녀와도 계속 진행됩니다)");
    job.listeners.add(applyPreviewResult);
    return () => job.listeners.delete(applyPreviewResult);
  }, []);

  const passCount = run ? run.items.filter((x) => x.elapsed_status === "PASS").length : 0;
  const errorCount = run ? run.items.filter((x) => x.elapsed_status === "ERROR").length : 0;

  // 조회 대상 전체(run.items)는 통계 카드에서 그대로 보여주되, 표에는 아직
  // 실행 불가능한 대기중/기타 상태 행을 노출하지 않고 실행가능(eligible) 행만 표시한다.
  const visibleItems = run ? run.items.filter((x) => x.eligible) : [];

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

  const setSelectedForInvoices = (invoices, checked) => {
    setSelected((prev) => {
      const next = { ...prev };
      invoices.forEach((inv) => {
        if (checked) next[inv] = true;
        else delete next[inv];
      });
      return next;
    });
  };

  const toggleAll = (checked) => {
    setSelected(checked ? Object.fromEntries(visibleItems.map((x) => [x.invoice_no, true])) : {});
  };

  const toggleStatus = (invoices, checked) => setSelectedForInvoices(invoices, checked);

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
    setMessage("최근 30일 반품 조회 → LOGIS 조회 → CS 조회 중... (다른 메뉴에 다녀와도 계속 진행됩니다)");
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
    const targets = (run.items || []).filter((x) => (x.sms_sent_count || 0) >= 2 && x.phone);
    if (!targets.length) {
      setMessageIsError(true);
      setMessage("문자 2회 이상 발송된 건이 없습니다.");
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

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h2 className={styles.title}>반품 자동화 대시보드</h2>
        <p className={styles.subtitle}>
          최근 30일 반품 중 반송장이 아직 없는 건을 찾아, 고객 CS 이력을 확인해 문자 발송 + 반품회수 접수를 자동으로 진행합니다.
        </p>
      </div>

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
        </div>
      )}

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
                        checked={visibleItems.length > 0 && visibleItems.every((x) => selected[x.invoice_no])}
                        onChange={(e) => toggleAll(e.target.checked)}
                      />
                      전체
                    </label>
                  </th>
                  <th style={{ width: "28px" }}></th>
                  <th>주문/송장</th>
                  <th>전화번호</th>
                  <th>반품신청일</th>
                  <th>반송장</th>
                  <th>원송장 LOGIS</th>
                  <th>CS 등록일시</th>
                  <th>상태</th>
                  <th>실행결과</th>
                  <th>마지막 문자</th>
                  <th>수신 내용 / 오류</th>
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
                        {item.order_no}
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
                      <td><StatusBadge status={item.elapsed_status} stage={item.error_stage} /></td>
                      <td>
                        {item.executeError ? (
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
                            style={{ marginLeft: "0.4rem" }}
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
