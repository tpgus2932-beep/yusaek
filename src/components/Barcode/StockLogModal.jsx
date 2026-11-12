import { useEffect, useState } from "react";
import { useEzadminSession } from "../../lib/EzadminSessionContext";
import styles from "./BarcodePage.module.css";
import { LOCAL_API_BASE as API, getAuthHeaders, handleUnauthorized } from "../../lib/api";
import { printProductLabels } from "../../lib/printProductLabels";
import { withBigNumber } from "../../lib/decorateLabels";

// 바코드 사이드메뉴 "로그 확인" 모달 (EZAdmin 재고내역 조회 + 입고/출고처리 + 라벨 출력).
// 재고체크 등 다른 화면에서도 쓸 수 있게 따로 뺐다. open이 true가 될 때 initialCode가 있으면 바로 그 상품을 조회한다.
export default function StockLogModal({ open: showStockLog, onClose, initialCode = "" }) {
  const { openModal: openEzadminModal } = useEzadminSession();
  const [stockLogCode, setStockLogCode] = useState("");
  const [stockLogStart, setStockLogStart] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 7);
    return d.toLocaleDateString("sv-SE");
  });
  const [stockLogEnd, setStockLogEnd] = useState(() => new Date().toLocaleDateString("sv-SE"));
  const [stockLogReason, setStockLogReason] = useState("");
  const [stockLogType, setStockLogType] = useState("");
  const [stockLogLoading, setStockLogLoading] = useState(false);
  const [stockLogError, setStockLogError] = useState("");
  const [stockLogResult, setStockLogResult] = useState(null);
  const [stockLogCandidates, setStockLogCandidates] = useState([]);
  const [stockAdjQty, setStockAdjQty] = useState("1");
  const [stockAdjMemo, setStockAdjMemo] = useState("");
  const [stockAdjBusy, setStockAdjBusy] = useState(false);
  const [stockAdjMsg, setStockAdjMsg] = useState("");

  // 모달이 떠 있는 동안 뒤의 페이지가 같이 스크롤되지 않게 잠근다.
  useEffect(() => {
    if (!showStockLog) return undefined;
    const prevBody = document.body.style.overflow;
    const prevHtml = document.documentElement.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevBody;
      document.documentElement.style.overflow = prevHtml;
    };
  }, [showStockLog]);

  // "입고요청전표2 자동입고: (2262 : 승일)" 형식은 입고전표, 그 외 숫자가 들어간 사유는 반품입고로 묶는다.
  const stockLogReasonGroup = (reason) => {
    const r = (reason || "").trim();
    if (/^입고요청전표\d*\s*자동입고\s*:\s*\(\s*\d+\s*:/.test(r)) return "입고전표";
    if (/\d/.test(r)) return "반품입고";
    return r;
  };
  const stockLogFiltered = (stockLogResult?.logs || []).filter(
    (l) => (!stockLogReason || stockLogReasonGroup(l.사유) === stockLogReason) && (!stockLogType || l.구분 === stockLogType)
  );

  // 상품코드 형태(S09888 등)가 아니면 원가베이스유에서 상품을 검색해 후보를 보여준다.
  // 로그 확인에서 고른 상품의 라벨을 수량만큼 출력한다 (라벨 재출력 화면과 같은 접두어/거래처상품명 규칙).
  const handleStockLabelPrint = async () => {
    const code = stockLogResult?.product_code;
    const qty = parseInt(stockAdjQty, 10);
    if (!code) return;
    if (!(qty >= 1)) { setStockAdjMsg("수량을 1 이상으로 입력하세요."); return; }
    setStockAdjBusy(true);
    setStockAdjMsg("");
    try {
      const sres = await fetch(`${API}/wonbe/search?${new URLSearchParams({ q: code, limit: "20" })}`, { headers: getAuthHeaders() });
      if (handleUnauthorized(sres)) return;
      const sdata = await sres.json().catch(() => ({}));
      const row = (sdata.rows || []).find((r) => String(r["상품코드"] || "").trim().toLowerCase() === code.toLowerCase());
      if (!row) throw new Error(`상품코드(${code})를 원가베이스유에서 찾을 수 없습니다.`);
      let deco = {};
      try {
        const dres = await fetch(`${API}/order/label-decorations`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...getAuthHeaders() },
          body: JSON.stringify({ codes: [code] }),
        });
        const ddata = await dres.json().catch(() => ({}));
        if (dres.ok && ddata?.ok) deco = (ddata.decorations || {})[code] || {};
      } catch { /* 꾸밈 정보 조회 실패해도 출력은 진행 */ }
      const name = row["상품명"] || row["상품명합"] || "";
      const title = withBigNumber(deco.prefix ? `${deco.prefix} ${name}` : name, deco.bigNumber);
      const option = [row["색상"], row["사이즈"]].filter(Boolean).join(" ");
      const labels = Array.from({ length: qty }, () => ({ code, title, option, clientLine: deco.clientLine || "" }));
      if (!printProductLabels(labels)) throw new Error("팝업이 차단되었거나 출력할 라벨이 없습니다.");
      setStockAdjMsg(`${code} 라벨 ${qty}장 출력`);
    } catch (err) {
      setStockAdjMsg(err.message || "라벨 출력 실패");
    } finally {
      setStockAdjBusy(false);
    }
  };

  // 한글 입력 상태에서 상품코드를 칠 때(예: "ㄴ00821" → "S00821") 숫자 바로 앞의 낱자 자음/모음을 같은 키의 영문으로 바꾼다.
  // 상품명을 한글로 칠 때는 숫자가 뒤따르지 않으므로 영향이 없다.
  const KO_KEY = "ㅂq ㅈw ㄷe ㄱr ㅅt ㅛy ㅕu ㅑi ㅐo ㅔp ㅁa ㄴs ㅇd ㄹf ㅎg ㅗh ㅓj ㅏk ㅣl ㅋz ㅌx ㅊc ㅍv ㅠb ㅜn ㅡm ㅃQ ㅉW ㄸE ㄲR ㅆT ㅒO ㅖP".split(" ").reduce((m, p) => { m[p[0]] = p[1]; return m; }, {});
  const normalizeStockLogCode = (v) => v.replace(/([ㄱ-ㅣ])(?=\d)/g, (c) => (KO_KEY[c] ? KO_KEY[c].toUpperCase() : c));

  const handleStockAdjust = async (type) => {
    const code = stockLogResult?.product_code;
    const qty = parseInt(stockAdjQty, 10);
    if (!code) return;
    if (!(qty >= 1)) { setStockAdjMsg("수량을 1 이상으로 입력하세요."); return; }
    const label = type === "in" ? "입고" : "출고";
    if (!window.confirm(`${code} 상품을 ${qty}개 ${label}처리합니다. (EZAdmin 재고가 실제로 ${type === "in" ? "늘어납니다" : "줄어듭니다"})
진행하시겠습니까?`)) return;
    setStockAdjBusy(true);
    setStockAdjMsg("");
    try {
      const res = await fetch(`${API}/barcode/stock-adjust`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ product_code: code, qty, type, memo: stockAdjMemo.trim() }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (data?.need_session) { openEzadminModal(() => handleStockAdjust(type)); return; }
      if (!res.ok || !data.ok) throw new Error(data?.detail || `${label}처리 실패`);
      setStockAdjMsg(`${code} ${qty}개 ${label}처리 완료`);
      setStockAdjMemo("");
      await handleStockLogSearch(code);
    } catch (err) {
      setStockAdjMsg(err.message || "처리 실패");
    } finally {
      setStockAdjBusy(false);
    }
  };

  const handleStockLogSearch = async (codeOverride) => {
    const code = (typeof codeOverride === "string" ? codeOverride : stockLogCode).trim();
    if (!code) { setStockLogError("상품코드 또는 상품명을 입력하세요."); return; }
    setStockLogLoading(true);
    setStockLogError("");
    try {
      if (!/^[A-Za-z]?\d+$/.test(code)) {
        setStockLogCandidates([]);
        const params = new URLSearchParams({ q: code, limit: "50" });
        const sres = await fetch(`${API}/wonbe/search?${params}`, { headers: getAuthHeaders() });
        if (handleUnauthorized(sres)) return;
        const sdata = await sres.json().catch(() => ({}));
        if (!sres.ok || sdata.ok === false) throw new Error(sdata?.detail || "상품 검색 실패");
        const found = sdata.rows || [];
        if (!found.length) { setStockLogResult(null); setStockLogError("원가베이스유에서 검색된 상품이 없습니다."); return; }
        setStockLogResult(null);
        setStockLogCandidates(found);
        return;
      }
      setStockLogCandidates([]);
      const res = await fetch(`${API}/barcode/stock-log`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ product_code: code, start_date: stockLogStart, end_date: stockLogEnd }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (data?.need_session) { openEzadminModal(handleStockLogSearch); return; }
      if (!res.ok) throw new Error(data?.detail || "로그 조회 실패");
      setStockLogResult(data);
    } catch (err) {
      setStockLogResult(null);
      setStockLogError(err.message || "로그 조회 실패");
    } finally {
      setStockLogLoading(false);
    }
  };

  // 다른 화면에서 상품코드를 넘겨 열면 바로 그 상품의 로그를 조회한다.
  useEffect(() => {
    if (!showStockLog || !initialCode) return;
    setStockLogCode(initialCode);
    setStockLogResult(null);
    setStockLogCandidates([]);
    setStockAdjMsg("");
    handleStockLogSearch(initialCode);
  }, [showStockLog, initialCode]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      {showStockLog && (
        <div className={styles.modalOverlay} onClick={() => onClose()}>
          <div className={`${styles.modal} ${styles.modalWide} ${styles.stockLogModal}`} style={{ height: "90vh" }} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <h4 className={styles.modalTitle}>로그 확인</h4>
              <div className={styles.modalActions}>
                <button className={styles.secondaryBtn} onClick={() => onClose()}>닫기</button>
              </div>
            </div>
            <div className={`${styles.uploadRow} ${styles.stockLogSearchRow}`}>
              <input
                value={stockLogCode}
                onChange={(e) => setStockLogCode(normalizeStockLogCode(e.target.value))}
                onKeyDown={(e) => { if (e.key === "Enter") handleStockLogSearch(); }}
                placeholder="상품코드 또는 상품명 검색 (예: S09888 / 글로우 검정)"
                className={styles.searchInput}
                disabled={stockLogLoading}
                autoFocus
              />
              <input type="date" className={styles.searchInput} style={{ maxWidth: "11rem" }} value={stockLogStart} max={stockLogEnd} onChange={(e) => setStockLogStart(e.target.value)} disabled={stockLogLoading} />
              <span className={styles.stockLogTilde}>~</span>
              <input type="date" className={styles.searchInput} style={{ maxWidth: "11rem" }} value={stockLogEnd} min={stockLogStart} onChange={(e) => setStockLogEnd(e.target.value)} disabled={stockLogLoading} />
              <button className={styles.primaryBtn} onClick={() => handleStockLogSearch()} disabled={stockLogLoading}>
                {stockLogLoading ? "조회 중..." : "로그 조회"}
              </button>
              <select
                value={stockLogType}
                onChange={(e) => setStockLogType(e.target.value)}
                className={styles.searchInput}
                style={{ maxWidth: "9rem" }}
              >
                <option value="">구분 전체</option>
                {[...new Set((stockLogResult?.logs || []).map((l) => l.구분).filter(Boolean))].map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
              <select
                value={stockLogReason}
                onChange={(e) => setStockLogReason(e.target.value)}
                className={styles.searchInput}
                style={{ maxWidth: "16rem" }}
              >
                <option value="">사유 전체</option>
                {[...new Set((stockLogResult?.logs || []).map((l) => stockLogReasonGroup(l.사유)).filter(Boolean))].map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
              {stockLogResult && (
                <span className={styles.metaLabel}>
                  {stockLogResult.product_code} · {stockLogResult.start_date} ~ {stockLogResult.end_date} ·{" "}
                  {stockLogReason || stockLogType ? `${stockLogFiltered.length} / ` : ""}{stockLogResult.count}건
                </span>
              )}
            </div>
            {stockLogResult && (
              <div className={`${styles.uploadRow} ${styles.stockAdjRow}`}>
                <strong>{stockLogResult.product_code}</strong>
                <input type="number" min="1" max="9999" className={styles.searchInput} style={{ maxWidth: "6rem" }} value={stockAdjQty} onChange={(e) => setStockAdjQty(e.target.value)} disabled={stockAdjBusy} />
                <span>개</span>
                <input className={styles.searchInput} style={{ maxWidth: "18rem" }} placeholder="재고 메모 (선택)" maxLength={100} value={stockAdjMemo} onChange={(e) => setStockAdjMemo(e.target.value)} disabled={stockAdjBusy} />
                <button className={styles.primaryBtn} onClick={() => handleStockAdjust("in")} disabled={stockAdjBusy}>입고처리</button>
                <button className={styles.secondaryBtn} onClick={() => handleStockAdjust("out")} disabled={stockAdjBusy}>출고처리</button>
                <button className={styles.secondaryBtn} onClick={handleStockLabelPrint} disabled={stockAdjBusy}>라벨 출력</button>
                {stockAdjBusy && <span className={styles.metaLabel}>처리 중...</span>}
                {stockAdjMsg && <span className={styles.metaLabel}>{stockAdjMsg}</span>}
              </div>
            )}
            {stockLogError && (
              <div className={styles.statusMsg} style={{ borderColor: "rgba(220,53,69,0.4)", backgroundColor: "rgba(220,53,69,0.07)" }}>
                <strong>{stockLogError}</strong>
              </div>
            )}
            {stockLogCandidates.length > 0 && (
              <div className={`${styles.tableWrap} ${styles.stockLogCandWrap}`} style={{ maxHeight: "40%", overflowY: "auto" }}>
                <table className={`${styles.table} ${styles.stockLogCandTable}`}>
                  <thead>
                    <tr>{["상품코드", "상품명", "색상", "사이즈", "거래처"].map((h) => <th key={h} style={{ position: "sticky", top: 0 }}>{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {stockLogCandidates.map((c) => (
                      <tr key={c["상품코드"]} style={{ cursor: "pointer" }} onClick={() => { setStockLogCode(c["상품코드"]); handleStockLogSearch(c["상품코드"]); }}>
                        <td data-label="상품코드">{c["상품코드"]}</td><td data-label="상품명">{c["상품명"]}</td><td data-label="색상">{c["색상"]}</td><td data-label="사이즈">{c["사이즈"]}</td><td data-label="거래처">{c["거래처"]}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className={styles.tableWrap} style={{ flex: 1, minHeight: 0, overflowX: "hidden" }}>
              <table className={`${styles.table} ${styles.stockLogTable}`}>
                <thead>
                  <tr>
                    {["일시", "구분", "수량", "재고", "수령자", "주문자", "사유"].map((h) => (
                      <th key={h} style={{ position: "sticky", top: 0 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {stockLogFiltered.map((l, i) => (
                    <tr key={i}>
                      <td data-label="일시" style={{ whiteSpace: "nowrap" }}>{l.일시}</td>
                      <td data-label="구분">{l.구분}</td>
                      <td data-label="수량">{l.수량}</td>
                      <td data-label="재고">{l.재고}</td>
                      <td data-label="수령자">{l.수령자}</td>
                      <td data-label="주문자">{l.주문자}</td>
                      <td data-label="사유">{l.사유}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {stockLogResult && stockLogFiltered.length === 0 && (
                <div style={{ padding: "1.5rem", textAlign: "center" }}>조회된 로그가 없습니다.</div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
