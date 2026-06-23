import React, { useState, useEffect } from "react";
import { RefreshCw, Play, Search, Truck, PackageCheck, MessageSquare } from "lucide-react";
import styles from "./TestTabs.module.css";
import { LOCAL_API_BASE as API, getAuthHeaders } from "../../lib/api";
import { useEzadminSession } from "../../lib/EzadminSessionContext";

const LS = {
  get: (k, fb) => { try { const v = localStorage.getItem(k); return v != null ? JSON.parse(v) : fb; } catch { return fb; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export default function ExchangeReturnTest() {
  const today = new Date();
  const monthAgo = new Date(today);
  monthAgo.setDate(monthAgo.getDate() - 30);

  const [startDate, setStartDate] = useState(toDateStr(monthAgo));
  const [endDate, setEndDate] = useState(toDateStr(today));
  const [items, setItems] = useState([]);
  const [rowStatus, setRowStatus] = useState({});
  const [loading, setLoading] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [message, setMessage] = useState("");
  const [regItems, setRegItems] = useState([]);
  const [regLoading, setRegLoading] = useState(false);
  const [regMessage, setRegMessage] = useState("");
  const { openModal: openEzadminModal } = useEzadminSession();
  const [shipLoading, setShipLoading] = useState(false);
  const [shipMessage, setShipMessage] = useState("");
  const [exchangePickupLoading, setExchangePickupLoading] = useState(false);
  const [shipResults, setShipResults] = useState([]);
  const [memos, setMemos] = useState(() => LS.get('exret_memos', {}));
  const [draftMemos, setDraftMemos] = useState({});
  const [expandedMemos, setExpandedMemos] = useState(new Set());

  useEffect(() => { LS.set('exret_memos', memos); }, [memos]);

  useEffect(() => {
    fetch(`${API}/return-shipping/memos?prefix=exret`, { headers: getAuthHeaders() })
      .then((r) => r.ok ? r.json() : null)
      .then((serverMemos) => {
        if (!serverMemos) return;
        const stripped = {};
        Object.entries(serverMemos).forEach(([k, v]) => {
          if (k.startsWith("exret:")) stripped[k.slice(6)] = v;
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
      body: JSON.stringify({ invoice_no: `exret:${key}`, memo: val }),
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

  const fetchList = async () => {
    setLoading(true);
    setMessage("");
    setItems([]);
    setRowStatus({});
    try {
      const res = await fetch(
        `${API}/exchange-return/list?start_date=${startDate}&end_date=${endDate}`,
        { headers: getAuthHeaders() }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "목록 조회 실패");
      setItems(data.items || []);
      setMessage(`교환수거중 미처리 ${(data.items || []).length}건`);
    } catch (err) {
      setMessage(err.message || "목록 조회 실패");
    } finally {
      setLoading(false);
    }
  };

  const processAll = async () => {
    if (!items.length) return;
    setProcessing(true);
    let success = 0, skipped = 0, failed = 0;

    for (const item of items) {
      const sno = item.exchange_sno;
      setRowStatus((prev) => ({ ...prev, [sno]: { state: "processing" } }));
      setMessage(`처리 중... (성공 ${success} / 스킵 ${skipped} / 실패 ${failed})`);

      try {
        const res = await fetch(`${API}/exchange-return/process-one`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...getAuthHeaders() },
          body: JSON.stringify({
            exchange_sno: item.exchange_sno,
            order_item_sno: item.order_item_sno,
          }),
        });
        const data = await res.json().catch(() => ({}));

        if (data.ok) {
          success++;
          setRowStatus((prev) => ({
            ...prev,
            [sno]: { state: "success", return_invoice: data.return_invoice, origin_invoice: data.origin_invoice },
          }));
        } else if (data.skipped) {
          skipped++;
          setRowStatus((prev) => ({
            ...prev,
            [sno]: { state: "skipped", error: data.error, origin_invoice: data.origin_invoice },
          }));
        } else {
          failed++;
          setRowStatus((prev) => ({
            ...prev,
            [sno]: { state: "error", error: data.error || "처리 실패" },
          }));
        }
      } catch (err) {
        failed++;
        setRowStatus((prev) => ({
          ...prev,
          [sno]: { state: "error", error: err.message },
        }));
      }

      await sleep(300);
    }

    setProcessing(false);
    setMessage(`완료 — 성공 ${success}건 / 스킵 ${skipped}건 / 실패 ${failed}건`);
  };

  const shipPending = async () => {
    setShipLoading(true);
    setShipMessage("처리 중...");
    setShipResults([]);
    try {
      const res = await fetch(`${API}/exchange-return/ship-pending`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ start_date: startDate, end_date: endDate }),
      });
      const data = await res.json().catch(() => ({}));
      if (data?.need_session) {
        openEzadminModal(shipPending);
        return;
      }
      if (!res.ok) throw new Error(data?.detail || "처리 실패");
      setShipResults(data.results || []);
      setShipMessage(`완료 — 성공 ${data.success}건 / 스킵 ${data.skipped}건 / 실패 ${data.failed}건`);
    } catch (err) {
      setShipMessage(err.message || "처리 실패");
    } finally {
      setShipLoading(false);
    }
  };

  const processExchangePickup = async () => {
    setExchangePickupLoading(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/exchange-return/process-exchange-pickup`, {
        method: "POST",
        headers: getAuthHeaders(),
      });
      const data = await res.json().catch(() => ({}));
      if (data.need_session) {
        openEzadminModal(processExchangePickup);
      } else if (data.ok) {
        setMessage(`완료 — 교환 ${data.exchange_count}건, 송장 ${data.invoice_count}건 회수등록, 에이블리 승인 완료`);
      } else {
        setMessage(`오류: ${data.error || "알 수 없는 오류"}`);
      }
    } catch (e) {
      setMessage(`오류: ${e.message}`);
    } finally {
      setExchangePickupLoading(false);
    }
  };

  const fetchRegistered = async () => {
    setRegLoading(true);
    setRegMessage("조회 중...");
    setRegItems([]);
    try {
      const res = await fetch(
        `${API}/exchange-return/registered?start_date=${startDate}&end_date=${endDate}`,
        { headers: getAuthHeaders() }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "조회 실패");
      setRegItems(data.items || []);
      setRegMessage(`반송장 등록 완료 ${(data.items || []).length}건`);
    } catch (err) {
      setRegMessage(err.message || "조회 실패");
    } finally {
      setRegLoading(false);
    }
  };

  const statusCell = (sno) => {
    const s = rowStatus[sno];
    if (!s) return <td>-</td>;
    if (s.state === "processing") return <td style={{ color: "var(--text-muted)" }}>처리중...</td>;
    if (s.state === "success") return (
      <td style={{ color: "#16a34a", fontVariantNumeric: "tabular-nums" }}>{s.return_invoice}</td>
    );
    if (s.state === "skipped") return (
      <td style={{ color: "var(--text-muted)" }} title={s.error}>반품송장 없음</td>
    );
    if (s.state === "error") return (
      <td style={{ color: "#ef4444", cursor: "help", maxWidth: "180px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={s.error}>
        {s.error}
      </td>
    );
    return <td>-</td>;
  };

  const originCell = (sno) => {
    const s = rowStatus[sno];
    if (!s || !s.origin_invoice) return <td>-</td>;
    return <td style={{ fontVariantNumeric: "tabular-nums" }}>{s.origin_invoice}</td>;
  };

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <div className={styles.titleArea}>
          <div className={styles.titleRow}>
            <h1 className={styles.title}>교환반품 테스트</h1>
            <span className={styles.badge}>BETA</span>
          </div>
          <p className={styles.subtitle}>
            에이블리 교환수거중 목록 조회 → 원송장으로 llogis 반품송장 조회 → 에이블리에 자동 등록
          </p>
        </div>

        <div className={styles.controls}>
          <input
            type="date"
            className={styles.searchInput}
            style={{ width: "140px" }}
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
          />
          <span style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>~</span>
          <input
            type="date"
            className={styles.searchInput}
            style={{ width: "140px" }}
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
          />
          <button
            className={styles.refreshBtn}
            onClick={fetchList}
            disabled={loading || processing}
            type="button"
          >
            <RefreshCw size={13} className={loading ? styles.spinning : undefined} />
            목록 조회
          </button>
          <button
            className={styles.refreshBtn}
            onClick={processExchangePickup}
            disabled={exchangePickupLoading || loading || processing}
            type="button"
            style={{ background: "var(--accent-black)" }}
          >
            <PackageCheck size={13} className={exchangePickupLoading ? styles.spinning : undefined} />
            교환 회수접수
          </button>
          <button
            className={styles.refreshBtn}
            onClick={processAll}
            disabled={processing || !items.length}
            type="button"
          >
            <Play size={13} className={processing ? styles.spinning : undefined} />
            전체 처리
          </button>
          <button
            className={styles.refreshBtn}
            onClick={shipPending}
            disabled={shipLoading || loading || processing}
            type="button"
          >
            <Truck size={13} className={shipLoading ? styles.spinning : undefined} />
            상품준비중 송장입력
          </button>
          <button
            className={styles.refreshBtn}
            onClick={fetchRegistered}
            disabled={regLoading || loading || processing}
            type="button"
            style={{ background: "var(--accent-black)" }}
          >
            <Search size={13} className={regLoading ? styles.spinning : undefined} />
            반송장 현황 조회
          </button>
        </div>
      </header>

      {message && <div className={styles.message}>{message}</div>}

      {items.length > 0 && (
        <section className={`${styles.section} ${styles.sectionHigh}`}>
          <div className={styles.sectionHeader}>
            <div className={styles.sectionTitle}>교환수거중 미처리 목록</div>
            <div className={styles.sectionMeta}>
              <span>{items.length}건</span>
              <span>성공 {Object.values(rowStatus).filter((s) => s.state === "success").length}건</span>
              <span>스킵 {Object.values(rowStatus).filter((s) => s.state === "skipped").length}건</span>
              <span>실패 {Object.values(rowStatus).filter((s) => s.state === "error").length}건</span>
              <span>메모 {Object.values(memos).filter(Boolean).length}건</span>
            </div>
          </div>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th style={{ width: "28px" }}></th>
                  <th>교환번호</th>
                  <th>주문번호</th>
                  <th>전화번호</th>
                  <th>상품명</th>
                  <th>옵션</th>
                  <th>회원명</th>
                  <th>교환신청일</th>
                  <th>원송장번호</th>
                  <th>등록된 반품송장</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  const key = String(item.exchange_sno);
                  const hasMemo = !!memos[key];
                  const isExpanded = expandedMemos.has(key);
                  return (
                    <React.Fragment key={item.exchange_sno}>
                      <tr className={rowStatus[item.exchange_sno]?.state === "success" ? styles.checkedRow : ""}>
                        <td style={{ textAlign: "center", padding: "0 4px" }}>
                          <button
                            type="button"
                            onClick={() => toggleMemo(key)}
                            title={hasMemo ? memos[key] : "메모 추가"}
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
                        </td>
                        <td style={{ fontVariantNumeric: "tabular-nums" }}>{item.exchange_sno}</td>
                        <td style={{ fontVariantNumeric: "tabular-nums" }}>{item.order_sno || "-"}</td>
                        <td style={{ fontVariantNumeric: "tabular-nums" }}>{item.phone || "-"}</td>
                        <td>{item.goods_name}</td>
                        <td>{item.option_info || "-"}</td>
                        <td>{item.member_name}</td>
                        <td style={{ whiteSpace: "nowrap" }}>
                          {item.requested_at ? item.requested_at.slice(0, 10) : "-"}
                        </td>
                        {originCell(item.exchange_sno)}
                        {statusCell(item.exchange_sno)}
                      </tr>
                      {isExpanded && (
                        <tr style={{ background: "var(--bg-secondary)" }}>
                          <td colSpan={10} style={{ padding: "0.5rem 1rem 0.75rem 2.5rem" }}>
                            <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginBottom: "0.3rem" }}>
                              메모 — {item.exchange_sno}
                            </div>
                            <div style={{ display: "flex", gap: "0.5rem", alignItems: "flex-start", maxWidth: "620px" }}>
                              <textarea
                                value={draftMemos[key] ?? ""}
                                onChange={(e) => setDraftMemos((d) => ({ ...d, [key]: e.target.value }))}
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
                                onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) saveMemo(key); }}
                                autoFocus
                              />
                              <button
                                type="button"
                                onClick={() => saveMemo(key)}
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

      {!loading && items.length === 0 && !regItems.length && (
        <div className={styles.message}>
          날짜 범위를 선택 후 버튼을 눌러주세요.
        </div>
      )}

      {shipMessage && (
        <div className={styles.message}>{shipMessage}</div>
      )}

      {shipResults.length > 0 && (
        <section className={`${styles.section} ${styles.sectionNormal}`}>
          <div className={styles.sectionHeader}>
            <div className={styles.sectionTitle}>상품준비중 송장입력 결과</div>
            <div className={styles.sectionMeta}>
              <span>{shipResults.length}건</span>
              <span>성공 {shipResults.filter((r) => r.ok).length}건</span>
              <span>스킵 {shipResults.filter((r) => r.skipped).length}건</span>
              <span>실패 {shipResults.filter((r) => !r.ok && !r.skipped).length}건</span>
            </div>
          </div>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>교환번호</th>
                  <th>EZAdmin 송장</th>
                  <th>결과</th>
                </tr>
              </thead>
              <tbody>
                {shipResults.map((r, i) => (
                  <tr key={i} className={r.ok ? styles.checkedRow : ""}>
                    <td style={{ fontVariantNumeric: "tabular-nums" }}>{r.exchange_sno}</td>
                    <td style={{ fontVariantNumeric: "tabular-nums" }}>{r.invoice || "-"}</td>
                    <td
                      style={{ color: r.ok ? "#16a34a" : r.skipped ? "var(--text-muted)" : "#ef4444" }}
                      title={r.error || ""}
                    >
                      {r.ok ? "완료" : r.skipped ? "스킵" : (r.error || "실패")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {regMessage && (
        <div className={styles.message} style={{ marginTop: regItems.length ? 0 : undefined }}>
          {regMessage}
        </div>
      )}

      {regItems.length > 0 && (
        <section className={`${styles.section} ${styles.sectionNormal}`}>
          <div className={styles.sectionHeader}>
            <div className={styles.sectionTitle}>반품송장 등록 완료 목록</div>
            <div className={styles.sectionMeta}>
              <span>{regItems.length}건</span>
            </div>
          </div>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>교환번호</th>
                  <th>상품명</th>
                  <th>옵션</th>
                  <th>회원명</th>
                  <th>교환신청일</th>
                  <th>반품송장번호</th>
                  <th>llogis 상태</th>
                  <th>위치</th>
                  <th>최종스캔일</th>
                </tr>
              </thead>
              <tbody>
                {regItems.map((item, i) => (
                  <tr key={i}>
                    <td style={{ fontVariantNumeric: "tabular-nums" }}>{item.exchange_sno}</td>
                    <td>{item.goods_name || "-"}</td>
                    <td>{item.option_info || "-"}</td>
                    <td>{item.member_name || "-"}</td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      {item.requested_at ? item.requested_at.slice(0, 10) : "-"}
                    </td>
                    <td style={{ fontVariantNumeric: "tabular-nums", color: item.return_invoice ? undefined : "var(--text-muted, #999)" }}>
                      {item.return_invoice || "반송장 없음"}
                    </td>
                    <td>{item.return_invoice ? (item.llogis_status || "-") : "-"}</td>
                    <td>{item.return_invoice ? (item.llogis_location || "-") : "-"}</td>
                    <td style={{ whiteSpace: "nowrap" }}>{item.return_invoice ? formatScanDate(item.llogis_scan_date) : "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
