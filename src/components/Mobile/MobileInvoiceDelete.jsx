import { useState } from "react";
import { LOCAL_API_BASE as API, getAuthHeaders, handleUnauthorized } from "../../lib/api";
import { useEzadminSession } from "../../lib/EzadminSessionContext";
import styles from "./MobileLogPage.module.css";

// 모바일 송장삭제 탭. 바코드 화면의 송장삭제 모달과 같은 API·순서로 동작한다.
// 거래취소·송장번호 삭제 → (선택) 주문 취소처리 → (선택) 재고 출고처리 → 에이블리 발송관리 롤백

const stepLabels = (stockOut, cancelProcess) => [
  "거래취소 · 송장번호 삭제",
  ...(cancelProcess ? ["주문 취소처리"] : []),
  ...(stockOut ? ["재고 출고처리"] : []),
  "에이블리 발송관리 롤백",
];

const icon = (status) => (status === "done" ? "✔" : status === "error" ? "✘" : status === "running" ? "⏳" : "▫");

const postJson = async (path, body) => {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getAuthHeaders() },
    body: JSON.stringify(body),
  });
  if (handleUnauthorized(res)) throw Object.assign(new Error("인증 만료"), { silent: true });
  const data = await res.json().catch(() => ({}));
  if (data?.need_session) throw Object.assign(new Error("이지어드민 세션 필요"), { needSession: true });
  if (!res.ok || data?.ok === false) throw new Error(data?.detail || "요청 실패");
  return data;
};

const fetchPreview = async (invoiceNo) => {
  const data = await postJson("/barcode/invoice/preview", { invoice_no: invoiceNo });
  if (!data.ezadmin_found || !data.pack) throw new Error("이지어드민 주문을 찾지 못했습니다.");
  if (!data.ably_found || !(data.products || []).length) throw new Error("에이블리 주문상품 정보를 찾지 못했습니다.");
  return data;
};

const runPipeline = async (preview, { stockOut, memo, cancelProcess }, onStep) => {
  onStep(0, "running");
  await postJson("/barcode/invoice/cancel", { pack: preview.pack });
  onStep(0, "done");
  let idx = 1;
  if (cancelProcess) {
    onStep(idx, "running");
    await postJson("/barcode/invoice/cancel-pack", { pack: preview.pack, prd_seqs: preview.prd_seqs || [] });
    onStep(idx, "done");
    idx += 1;
  }
  if (stockOut) {
    onStep(idx, "running");
    const stock = await postJson("/barcode/invoice/stock-out", { products: preview.products, invoice_no: preview.invoice_no, memo });
    const ok = stock.results?.every((r) => r.ok) ?? true;
    onStep(idx, ok ? "done" : "error", ok ? undefined : "일부 상품 출고 실패");
    if (!ok) throw new Error("일부 상품 재고 출고처리에 실패했습니다.");
    idx += 1;
  }
  onStep(idx, "running");
  await postJson("/barcode/invoice/rollback", { sno_list: preview.sno_list });
  onStep(idx, "done");
};

const parseNos = (text) => {
  const seen = new Set();
  return String(text || "").split(/[\s,]+/).map((v) => v.trim()).filter((v) => v && !seen.has(v) && seen.add(v));
};

export default function MobileInvoiceDelete() {
  const { openModal } = useEzadminSession();
  const [bulk, setBulk] = useState(false);
  const [stockOut, setStockOut] = useState(true);
  const [memo, setMemo] = useState("");
  const [cancelProcess, setCancelProcess] = useState(false);
  const [invoiceNo, setInvoiceNo] = useState("");
  const [bulkInput, setBulkInput] = useState("");
  const [preview, setPreview] = useState(null);
  const [steps, setSteps] = useState([]);
  const [bulkResults, setBulkResults] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const locked = loading || running;
  const opts = { stockOut, memo, cancelProcess };

  const handlePreview = async () => {
    const no = invoiceNo.trim();
    if (!no) { setError("송장번호를 입력하세요."); return; }
    setLoading(true);
    setError("");
    setPreview(null);
    setSteps([]);
    try {
      const data = await postJson("/barcode/invoice/preview", { invoice_no: no });
      setPreview(data);
    } catch (e) {
      if (e.needSession) openModal(handlePreview);
      else if (!e.silent) setError(e.message || "조회 실패");
    } finally {
      setLoading(false);
    }
  };

  const handleExecute = async () => {
    if (!preview) return;
    if (!window.confirm(`송장번호 ${preview.invoice_no}를 삭제${cancelProcess ? "하고 주문을 취소처리" : ""}${stockOut ? "하고 재고를 출고처리" : ""}한 뒤 발송상태를 되돌리겠습니까?`)) return;
    setRunning(true);
    setError("");
    setSteps(stepLabels(stockOut, cancelProcess).map((label) => ({ label, status: "pending" })));
    let failedIdx = -1;
    const setStep = (idx, status, detail) => setSteps((prev) => prev.map((s, i) => (i === idx ? { ...s, status, detail } : s)));
    try {
      await runPipeline(preview, opts, (idx, status, detail) => { failedIdx = idx; setStep(idx, status, detail); });
    } catch (e) {
      if (e.needSession) openModal(handleExecute);
      else if (!e.silent) setError(e.message || "송장삭제 처리 중 오류가 발생했습니다.");
      if (failedIdx >= 0) setStep(failedIdx, "error", e.message);
    } finally {
      setRunning(false);
    }
  };

  const handleBulk = async () => {
    const nos = parseNos(bulkInput);
    if (!nos.length) { setError("송장번호를 한 줄에 하나씩(또는 쉼표로 구분) 입력하세요."); return; }
    if (!window.confirm(`송장번호 ${nos.length}건을 일괄 삭제${stockOut ? "(재고 출고처리 포함)" : "(재고 출고처리 제외)"}${cancelProcess ? "(취소처리 포함)" : ""}하시겠습니까?`)) return;
    setError("");
    setRunning(true);
    const labels = stepLabels(stockOut, cancelProcess);
    const results = nos.map((no) => ({ invoice_no: no, status: "pending", steps: labels.map((label) => ({ label, status: "pending" })) }));
    setBulkResults(results);
    const refresh = () => setBulkResults([...results]);
    for (const r of results) {
      r.status = "running";
      refresh();
      try {
        const pv = await fetchPreview(r.invoice_no);
        await runPipeline(pv, opts, (idx, status, detail) => { r.steps[idx] = { ...r.steps[idx], status, detail }; refresh(); });
        r.status = "done";
      } catch (e) {
        r.status = "error";
        r.detail = e.needSession ? "이지어드민 세션 필요" : e.message;
        refresh();
        if (e.needSession) { openModal(null); break; }
        continue;
      }
      refresh();
    }
    setRunning(false);
  };

  return (
    <>
      <div className={styles.row}>
        <label className={styles.check}><input type="radio" checked={!bulk} onChange={() => setBulk(false)} disabled={locked} /> 단일</label>
        <label className={styles.check}><input type="radio" checked={bulk} onChange={() => setBulk(true)} disabled={locked} /> 일괄삭제</label>
      </div>
      <div className={styles.row}>
        <label className={styles.check}><input type="checkbox" checked={stockOut} onChange={(e) => setStockOut(e.target.checked)} disabled={locked} /> 재고 출고처리 포함</label>
        <label className={styles.check}><input type="checkbox" checked={cancelProcess} onChange={(e) => setCancelProcess(e.target.checked)} disabled={locked} /> 취소처리</label>
      </div>
      {stockOut && (
        <input className={styles.input} value={memo} placeholder="재고 출고 메모 (선택)" onChange={(e) => setMemo(e.target.value)} disabled={locked} />
      )}

      {!bulk ? (
        <>
          <div className={styles.form}>
            <input
              className={styles.input}
              inputMode="numeric"
              value={invoiceNo}
              placeholder="송장번호 입력"
              onChange={(e) => setInvoiceNo(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !locked && handlePreview()}
              disabled={locked}
            />
            <button type="button" className={styles.primary} disabled={locked} onClick={handlePreview}>{loading ? "조회 중..." : "조회"}</button>
          </div>
          {error && <div className={styles.error}>{error}</div>}
          {preview && (
            <div className={styles.card}>
              <div>송장번호 <strong>{preview.invoice_no}</strong></div>
              <div className={styles.muted}>{preview.ably_found ? "✔" : "✘"} 에이블리 주문 · {preview.ezadmin_found ? "✔" : "✘"} 이지어드민 주문</div>
              {(preview.products || []).length === 0 && <div className={styles.muted}>상품 정보를 찾지 못했습니다.</div>}
              {(preview.products || []).map((p) => (
                <div key={p.product_id} className={styles.cardLine}>
                  <div>{p.product_id}{p.name ? ` (${p.name})` : ""}</div>
                  <div className={styles.muted}>{[p.color, p.size].filter(Boolean).join(" / ") || "옵션 정보 없음"} · 수량 {p.qty}</div>
                </div>
              ))}
              {steps.length > 0 && (
                <div className={styles.cardLine}>
                  {steps.map((s) => (
                    <div key={s.label}>{icon(s.status)} {s.label}{s.status === "error" && s.detail ? <span className={styles.errText}> ({s.detail})</span> : null}</div>
                  ))}
                </div>
              )}
              <button
                type="button"
                className={`${styles.primary} ${styles.danger}`}
                style={{ marginTop: 10, width: "100%" }}
                disabled={locked || !preview.ably_found || !(preview.products || []).length}
                onClick={handleExecute}
              >
                {running ? "처리 중..." : "송장삭제 실행"}
              </button>
            </div>
          )}
        </>
      ) : (
        <>
          <textarea
            className={styles.input}
            rows={6}
            value={bulkInput}
            placeholder="송장번호를 한 줄에 하나씩(또는 쉼표로 구분) 입력"
            onChange={(e) => setBulkInput(e.target.value)}
            disabled={running}
          />
          {error && <div className={styles.error}>{error}</div>}
          <button type="button" className={`${styles.primary} ${styles.danger}`} disabled={running || !parseNos(bulkInput).length} onClick={handleBulk}>
            {running ? "처리 중..." : `일괄실행 (${parseNos(bulkInput).length}건)`}
          </button>
          {bulkResults.map((r) => (
            <div key={r.invoice_no} className={styles.card}>
              <div>{icon(r.status)} <strong>{r.invoice_no}</strong>{r.status === "error" && r.detail ? <span className={styles.errText}> ({r.detail})</span> : null}</div>
              {r.status !== "pending" && r.steps.map((s) => (
                <div key={s.label} className={styles.muted}>{icon(s.status)} {s.label}{s.status === "error" && s.detail ? ` (${s.detail})` : ""}</div>
              ))}
            </div>
          ))}
        </>
      )}
    </>
  );
}
