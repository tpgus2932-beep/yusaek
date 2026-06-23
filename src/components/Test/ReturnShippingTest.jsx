import React, { useState, useEffect } from "react";
import { RefreshCw, Search, MessageSquare, PackageCheck } from "lucide-react";
import styles from "./TestTabs.module.css";
import { LOCAL_API_BASE as API, getAuthHeaders } from "../../lib/api";
import { useEzadminSession } from "../../lib/EzadminSessionContext";

function toDateStr(d) {
  return d.toISOString().slice(0, 10);
}

function formatScanDate(raw) {
  if (!raw) return "-";
  const s = String(raw).replace(/\D/g, "");
  if (s.length < 8) return raw;
  const month = parseInt(s.slice(4, 6), 10);
  const day = parseInt(s.slice(6, 8), 10);
  return `${month}월 ${day}일`;
}

const LS = {
  get: (k, fb) => { try { const v = localStorage.getItem(k); return v != null ? JSON.parse(v) : fb; } catch { return fb; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

export default function ReturnShippingTest() {
  const today = new Date();
  const monthAgo = new Date(today);
  monthAgo.setDate(monthAgo.getDate() - 30);

  const [startDate, setStartDate] = useState(() => LS.get('rship_start', toDateStr(monthAgo)));
  const [endDate, setEndDate] = useState(() => LS.get('rship_end', toDateStr(today)));
  const [items, setItems] = useState(() => LS.get('rship_items', []));
  const [llogisResults, setLlogisResults] = useState(() => LS.get('rship_llogis', {}));
  const [loading, setLoading] = useState(false);
  const [llogisLoading, setLlogisLoading] = useState(false);
  const [message, setMessage] = useState(() => LS.get('rship_message', ""));
  const [singleInvNo, setSingleInvNo] = useState(() => LS.get('rship_singleInv', ""));
  const [singleResult, setSingleResult] = useState(() => LS.get('rship_singleResult', null));
  const [singleLoading, setSingleLoading] = useState(false);
  const [memos, setMemos] = useState(() => LS.get('rship_memos', {}));
  const [draftMemos, setDraftMemos] = useState({});
  const [expandedMemos, setExpandedMemos] = useState(new Set());
  const { openModal: openEzadminModal } = useEzadminSession();
  const [pickupLoading, setPickupLoading] = useState(false);
  const [pickupMessage, setPickupMessage] = useState("");

  useEffect(() => { LS.set('rship_start', startDate); }, [startDate]);
  useEffect(() => { LS.set('rship_end', endDate); }, [endDate]);
  useEffect(() => { LS.set('rship_items', items); }, [items]);
  useEffect(() => { LS.set('rship_llogis', llogisResults); }, [llogisResults]);
  useEffect(() => { LS.set('rship_message', message); }, [message]);
  useEffect(() => { LS.set('rship_singleInv', singleInvNo); }, [singleInvNo]);
  useEffect(() => { LS.set('rship_singleResult', singleResult); }, [singleResult]);
  useEffect(() => { LS.set('rship_memos', memos); }, [memos]);

  useEffect(() => {
    fetch(`${API}/return-shipping/memos?prefix=rship`, { headers: getAuthHeaders() })
      .then((r) => r.ok ? r.json() : null)
      .then((serverMemos) => {
        if (!serverMemos) return;
        const stripped = {};
        Object.entries(serverMemos).forEach(([k, v]) => {
          if (k.startsWith("rship:")) stripped[k.slice(6)] = v;
        });
        setMemos((prev) => ({ ...prev, ...stripped }));
      })
      .catch(() => {});
  }, []);

  const saveMemo = (key) => {
    const val = draftMemos[key] ?? memos[key] ?? "";
    setMemos((prev) => {
      if (!val) { const next = { ...prev }; delete next[key]; return next; }
      return { ...prev, [key]: val };
    });
    fetch(`${API}/return-shipping/memo`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...getAuthHeaders() },
      body: JSON.stringify({ invoice_no: `rship:${key}`, memo: val }),
    }).catch(() => {});
  };

  const toggleMemo = (key) => {
    setExpandedMemos((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
        setDraftMemos((d) => ({ ...d, [key]: memos[key] || "" }));
      }
      return next;
    });
  };

  const newReturnPickup = async () => {
    setPickupLoading(true);
    setPickupMessage("처리 중...");
    try {
      const res = await fetch(`${API}/return-shipping/new-return-pickup`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ start_date: startDate, end_date: endDate }),
      });
      const data = await res.json().catch(() => ({}));
      if (data?.need_session) { openEzadminModal(newReturnPickup); return; }
      if (!res.ok) throw new Error(data?.detail || "처리 실패");
      if (!data?.ok) throw new Error(data?.error || "처리 실패");
      setPickupMessage(
        `완료 — 송장 ${data.invoice_count}건 업로드, 에이블리 반품접수 ${data.sno_count}건 (HTTP ${data.ably_status}), 문자 ${data.sms_queued ?? 0}건 발송`
      );
    } catch (err) {
      setPickupMessage(err.message || "처리 실패");
    } finally {
      setPickupLoading(false);
    }
  };

  const fetchAbly = async () => {
    setLoading(true);
    setMessage("");
    setItems([]);
    setLlogisResults({});
    try {
      const res = await fetch(
        `${API}/return-shipping/ably-returns?start_date=${startDate}&end_date=${endDate}`,
        { headers: getAuthHeaders() }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "에이블리 조회 실패");
      setItems(data.items || []);
      setMessage(`조회 완료: ${(data.items || []).length}건`);
    } catch (err) {
      setMessage(err.message || "에이블리 조회 실패");
    } finally {
      setLoading(false);
    }
  };

  const fetchLlogis = async () => {
    const invoiceNos = [...new Set(items.map((i) => i["송장번호"]).filter(Boolean))];
    if (!invoiceNos.length) {
      setMessage("원송장번호가 있는 항목이 없습니다.");
      return;
    }
    setLlogisLoading(true);
    setLlogisResults({});
    setMessage(`llogis 조회 중... (0 / ${invoiceNos.length})`);

    let done = 0;
    await Promise.allSettled(
      invoiceNos.map(async (inv) => {
        try {
          const res = await fetch(`${API}/return-shipping/llogis-check-by-origin`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...getAuthHeaders() },
            body: JSON.stringify({ invoice_nos: [inv] }),
          });
          const data = await res.json().catch(() => ({}));
          const result = res.ok
            ? (data.results?.[inv] ?? { return_invoices: [], error: "결과 없음" })
            : { return_invoices: [], error: data?.detail || "조회 실패" };
          setLlogisResults((prev) => ({ ...prev, [inv]: result }));
        } catch (e) {
          setLlogisResults((prev) => ({ ...prev, [inv]: { return_invoices: [], error: e.message } }));
        } finally {
          done += 1;
          setMessage(`llogis 조회 중... (${done} / ${invoiceNos.length})`);
        }
      })
    );

    setLlogisLoading(false);
    setMessage(`llogis 조회 완료 (${invoiceNos.length}건)`);
  };

  const hasInvoice = items.some((i) => i["송장번호"]);

  const searchSingle = async () => {
    const inv = singleInvNo.trim();
    if (!inv) return;
    setSingleLoading(true);
    setSingleResult(null);
    try {
      const res = await fetch(
        `${API}/return-shipping/llogis-detail?inv_no=${encodeURIComponent(inv)}`,
        { headers: getAuthHeaders() }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "llogis 조회 실패");
      setSingleResult(data);
    } catch (err) {
      setSingleResult({ inv_no: inv, error: err.message });
    } finally {
      setSingleLoading(false);
    }
  };

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <div className={styles.titleArea}>
          <div className={styles.titleRow}>
            <h1 className={styles.title}>반품배송 테스트</h1>
            <span className={styles.badge}>BETA</span>
          </div>
          <p className={styles.subtitle}>
            에이블리 반품 목록 조회 후 llogis(롯데택배) 배송 상태 확인
          </p>
        </div>

        <div className={styles.controls}>
          <input
            type="date"
            className={styles.searchInput}
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            style={{ width: "140px" }}
          />
          <span style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>~</span>
          <input
            type="date"
            className={styles.searchInput}
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            style={{ width: "140px" }}
          />
          <button
            className={styles.refreshBtn}
            onClick={fetchAbly}
            disabled={loading}
            type="button"
          >
            <RefreshCw size={13} className={loading ? styles.spinning : undefined} />
            에이블리 조회
          </button>
          <button
            className={styles.refreshBtn}
            onClick={fetchLlogis}
            disabled={llogisLoading || !hasInvoice}
            type="button"
            style={{ background: "var(--accent-black)", opacity: (!hasInvoice || llogisLoading) ? 0.45 : 1 }}
          >
            <Search size={13} className={llogisLoading ? styles.spinning : undefined} />
            llogis 전체조회
          </button>
          <button
            className={styles.refreshBtn}
            onClick={newReturnPickup}
            disabled={pickupLoading || loading}
            type="button"
          >
            {pickupLoading
              ? <RefreshCw size={13} className={styles.spinning} />
              : <PackageCheck size={13} />}
            신규반품 회수신청
          </button>
        </div>
      </header>

      {pickupMessage && <div className={styles.message}>{pickupMessage}</div>}
      {message && <div className={styles.message}>{message}</div>}

      <section className={`${styles.section} ${styles.sectionStock}`}>
        <div className={styles.sectionHeader}>
          <div className={styles.sectionTitle}>송장번호 개별 조회</div>
        </div>
        <div style={{ padding: "0.875rem 1.25rem", display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
          <input
            className={styles.searchInput}
            style={{ width: "220px" }}
            value={singleInvNo}
            onChange={(e) => setSingleInvNo(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && searchSingle()}
            placeholder="송장번호 입력"
          />
          <button
            className={styles.refreshBtn}
            onClick={searchSingle}
            disabled={singleLoading || !singleInvNo.trim()}
            type="button"
          >
            <Search size={13} className={singleLoading ? styles.spinning : undefined} />
            조회
          </button>
          {singleResult && (
            <div style={{ width: "100%", marginTop: "0.5rem", fontSize: "0.875rem", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
              {singleResult.error ? (
                <div style={{ color: "#ef4444" }}>{singleResult.error}</div>
              ) : (
                <>
                  <div style={{ display: "flex", gap: "1.5rem", flexWrap: "wrap", padding: "0.5rem 0.75rem", background: "var(--bg-secondary)", border: "1px solid var(--border-color)", borderRadius: "var(--radius-sm)" }}>
                    <span style={{ color: "var(--text-muted)", fontVariantNumeric: "tabular-nums" }}>{singleResult.inv_no}</span>
                    <span><b>수취인:</b> {singleResult.inv_info?.receiver || "-"}</span>
                    <span><b>상품:</b> {singleResult.inv_info?.product || "-"}</span>
                    <span><b>발송일:</b> {singleResult.inv_info?.sent_date || "-"}</span>
                    <span><b>배달일:</b> {singleResult.inv_info?.delivered_date || "-"}</span>
                    <span><b>현재상태:</b> {singleResult.latest_status}</span>
                    <span><b>위치:</b> {singleResult.location}</span>
                  </div>
                  {singleResult.returns?.length > 0 && (
                    <div>
                      <div style={{ fontSize: "0.75rem", fontWeight: 700, color: "var(--text-muted)", marginBottom: "0.3rem" }}>
                        반품 송장 {singleResult.returns.length}건
                      </div>
                      <div className={styles.tableWrap}>
                        <table className={styles.table}>
                          <thead>
                            <tr>
                              <th>반품송장번호</th>
                              <th>접수상태</th>
                              <th>현재상태</th>
                              <th>스캔위치</th>
                              <th>최종스캔일</th>
                            </tr>
                          </thead>
                          <tbody>
                            {singleResult.returns.map((r, i) => (
                              <tr key={i}>
                                <td style={{ fontVariantNumeric: "tabular-nums" }}>{r.invoice_no}</td>
                                <td>{r.status_name || "-"}</td>
                                <td style={{ color: r.error ? "#ef4444" : undefined }}>
                                  {r.error ? r.error : r.latest_status}
                                </td>
                                <td>{r.location}</td>
                                <td style={{ whiteSpace: "nowrap" }}>{formatScanDate(r.scan_date)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                  {singleResult.returns?.length === 0 && (
                    <div style={{ color: "var(--text-muted)", fontSize: "0.8rem" }}>반품 송장 없음</div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </section>

      {items.length > 0 && (
        <section className={`${styles.section} ${styles.sectionNormal}`}>
          <div className={styles.sectionHeader}>
            <div className={styles.sectionTitle}>반품 목록</div>
            <div className={styles.sectionMeta}>
              <span>{items.length}건</span>
              <span>반품송장 {items.filter((i) => i["반품송장번호"]).length}건</span>
              <span>메모 {Object.values(memos).filter(Boolean).length}건</span>
            </div>
          </div>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th style={{ width: "28px" }}></th>
                  <th>주문번호</th>
                  <th>전화번호</th>
                  <th>상품명</th>
                  <th>옵션</th>
                  <th>반품신청일</th>
                  <th>반품사유</th>
                  <th>llogis 반송장</th>
                  <th>반품진행상태</th>
                  <th>스캔위치</th>
                  <th>최종스캔일</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item, idx) => {
                  const invNo = item["반품송장번호"];
                  const lr = invNo ? llogisResults[invNo] : null;
                  const orderNo = item["주문번호"];
                  const hasMemo = orderNo && !!memos[orderNo];
                  const isExpanded = orderNo && expandedMemos.has(orderNo);
                  return (
                    <React.Fragment key={idx}>
                    <tr>
                      <td style={{ textAlign: "center", padding: "0 4px" }}>
                        {orderNo ? (
                          <button
                            type="button"
                            onClick={() => toggleMemo(orderNo)}
                            title={hasMemo ? memos[orderNo] : "메모 추가"}
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
                      <td style={{ fontVariantNumeric: "tabular-nums" }}>{item["주문번호"] || "-"}</td>
                      <td style={{ fontVariantNumeric: "tabular-nums" }}>{item["전화번호"] || "-"}</td>
                      <td>{item["상품명"]}</td>
                      <td>{item["옵션"]}</td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        {item["반품신청일시"] ? item["반품신청일시"].slice(0, 10) : "-"}
                      </td>
                      <td>{item["반품사유"]}</td>
                      {(() => {
                        const originNo = item["송장번호"];
                        const lr = originNo ? llogisResults[originNo] : null;
                        if (!originNo) return <><td>-</td><td>-</td><td>-</td><td>-</td></>;
                        if (llogisLoading && !lr) return <><td colSpan={4} style={{ textAlign: "center" }}>…</td></>;
                        if (!lr) return <><td>-</td><td>-</td><td>-</td><td>-</td></>;
                        if (lr.error) return (
                          <><td colSpan={4} title={lr.error} style={{ color: "#ef4444", cursor: "help" }}>{lr.error}</td></>
                        );
                        const returns = lr.return_invoices || [];
                        if (returns.length === 0) return (
                          <><td colSpan={4} style={{ color: "var(--text-muted)" }}>반송장 없음</td></>
                        );
                        const cell = (arr) => arr.map((v, i) => (
                          <React.Fragment key={i}>{i > 0 && <br />}{v}</React.Fragment>
                        ));
                        return (
                          <>
                            <td style={{ fontVariantNumeric: "tabular-nums" }}>{cell(returns.map(r => r.invoice_no))}</td>
                            <td>{cell(returns.map(r => r.error
                              ? <span style={{ color: "#ef4444" }} title={r.error}>{r.error}</span>
                              : <span title={r._inv_info_keys ? `invInfoList keys: ${r._inv_info_keys.join(", ")}` : undefined}>{r.status}</span>
                            ))}</td>
                            <td>{cell(returns.map(r => r.location))}</td>
                            <td style={{ whiteSpace: "nowrap" }}>{cell(returns.map(r => formatScanDate(r.scan_date)))}</td>
                          </>
                        );
                      })()}
                    </tr>
                    {isExpanded && (
                      <tr style={{ background: "var(--bg-secondary)" }}>
                        <td colSpan={11} style={{ padding: "0.5rem 1rem 0.75rem 2.5rem" }}>
                          <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginBottom: "0.3rem" }}>
                            메모 — {orderNo}
                          </div>
                          <div style={{ display: "flex", gap: "0.5rem", alignItems: "flex-start", maxWidth: "620px" }}>
                            <textarea
                              value={draftMemos[orderNo] ?? ""}
                              onChange={(e) => setDraftMemos((d) => ({ ...d, [orderNo]: e.target.value }))}
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
                              onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) saveMemo(orderNo); }}
                              autoFocus
                            />
                            <button
                              type="button"
                              onClick={() => saveMemo(orderNo)}
                              className={styles.refreshBtn}
                              style={{ whiteSpace: "nowrap", alignSelf: "flex-end" }}
                            >
                              저장
                            </button>
                          </div>
                        </td>
                      </tr>
                    )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {!loading && items.length === 0 && (
        <div className={styles.message}>
          날짜 범위를 선택 후 "에이블리 조회" 버튼을 눌러주세요.
        </div>
      )}
    </div>
  );
}
