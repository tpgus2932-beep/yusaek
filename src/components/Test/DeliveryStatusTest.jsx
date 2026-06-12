import React, { useState, useEffect } from "react";
import { RefreshCw, Search } from "lucide-react";
import styles from "./TestTabs.module.css";
import { LOCAL_API_BASE as API, getAuthHeaders } from "../../lib/api";

function formatScanDate(raw) {
  if (!raw) return "-";
  const s = String(raw).replace(/\D/g, "");
  if (s.length < 8) return raw;
  const month = parseInt(s.slice(4, 6), 10);
  const day = parseInt(s.slice(6, 8), 10);
  return `${month}월 ${day}일`;
}

function formatSentDate(raw) {
  if (!raw) return "-";
  const s = String(raw).slice(0, 10);
  return s;
}

const LS = {
  get: (k, fb) => { try { const v = localStorage.getItem(k); return v != null ? JSON.parse(v) : fb; } catch { return fb; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

export default function DeliveryStatusTest() {
  const [items, setItems] = useState(() => LS.get("dstat_items", []));
  const [llogisResults, setLlogisResults] = useState(() => LS.get("dstat_llogis", {}));
  const [loading, setLoading] = useState(false);
  const [llogisLoading, setLlogisLoading] = useState(false);
  const [message, setMessage] = useState(() => LS.get("dstat_message", ""));
  const [singleInvNo, setSingleInvNo] = useState(() => LS.get("dstat_singleInv", ""));
  const [singleResult, setSingleResult] = useState(() => LS.get("dstat_singleResult", null));
  const [singleLoading, setSingleLoading] = useState(false);

  useEffect(() => { LS.set("dstat_items", items); }, [items]);
  useEffect(() => { LS.set("dstat_llogis", llogisResults); }, [llogisResults]);
  useEffect(() => { LS.set("dstat_message", message); }, [message]);
  useEffect(() => { LS.set("dstat_singleInv", singleInvNo); }, [singleInvNo]);
  useEffect(() => { LS.set("dstat_singleResult", singleResult); }, [singleResult]);

  const fetchAbly = async () => {
    setLoading(true);
    setMessage("");
    setItems([]);
    setLlogisResults({});
    try {
      const res = await fetch(`${API}/return-shipping/ably-shipping`, {
        headers: getAuthHeaders(),
      });
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
      setMessage("송장번호가 있는 항목이 없습니다.");
      return;
    }
    setLlogisLoading(true);
    setLlogisResults({});
    setMessage(`llogis 조회 중... (0 / ${invoiceNos.length})`);

    let done = 0;
    await Promise.allSettled(
      invoiceNos.map(async (inv) => {
        try {
          const res = await fetch(`${API}/return-shipping/llogis-check`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...getAuthHeaders() },
            body: JSON.stringify({ invoice_nos: [inv] }),
          });
          const data = await res.json().catch(() => ({}));
          const result = res.ok
            ? (data.results?.[inv] ?? { status: "-", location: "-", scan_date: "-", error: "결과 없음" })
            : { status: "-", location: "-", scan_date: "-", error: data?.detail || "조회 실패" };
          setLlogisResults((prev) => ({ ...prev, [inv]: result }));
        } catch (e) {
          setLlogisResults((prev) => ({ ...prev, [inv]: { status: "-", location: "-", scan_date: "-", error: e.message } }));
        } finally {
          done += 1;
          setMessage(`llogis 조회 중... (${done} / ${invoiceNos.length})`);
        }
      })
    );

    setLlogisLoading(false);
    setMessage(`llogis 조회 완료 (${invoiceNos.length}건)`);
  };

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

  const hasInvoice = items.some((i) => i["송장번호"]);

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <div className={styles.titleArea}>
          <div className={styles.titleRow}>
            <h1 className={styles.title}>배송 현황 조회</h1>
            <span className={styles.badge}>BETA</span>
          </div>
          <p className={styles.subtitle}>
            에이블리 배송중 주문 목록 조회 후 llogis(롯데택배) 배송 상태 확인
          </p>
        </div>

        <div className={styles.controls}>
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
        </div>
      </header>

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
                <div style={{ display: "flex", gap: "1.5rem", flexWrap: "wrap", padding: "0.5rem 0.75rem", background: "var(--bg-secondary)", border: "1px solid var(--border-color)", borderRadius: "var(--radius-sm)" }}>
                  <span style={{ color: "var(--text-muted)", fontVariantNumeric: "tabular-nums" }}>{singleResult.inv_no}</span>
                  <span><b>수취인:</b> {singleResult.inv_info?.receiver || "-"}</span>
                  <span><b>상품:</b> {singleResult.inv_info?.product || "-"}</span>
                  <span><b>발송일:</b> {singleResult.inv_info?.sent_date || "-"}</span>
                  <span><b>배달일:</b> {singleResult.inv_info?.delivered_date || "-"}</span>
                  <span><b>현재상태:</b> {singleResult.latest_status}</span>
                  <span><b>위치:</b> {singleResult.location}</span>
                </div>
              )}
            </div>
          )}
        </div>
      </section>

      {items.length > 0 && (
        <section className={`${styles.section} ${styles.sectionNormal}`}>
          <div className={styles.sectionHeader}>
            <div className={styles.sectionTitle}>배송중 목록</div>
            <div className={styles.sectionMeta}>
              <span>{items.length}건</span>
              <span>송장 {items.filter((i) => i["송장번호"]).length}건</span>
            </div>
          </div>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>주문번호</th>
                  <th>상품명</th>
                  <th>옵션</th>
                  <th>수취인</th>
                  <th>발송일</th>
                  <th>송장번호</th>
                  <th>배송상태</th>
                  <th>위치</th>
                  <th>최종스캔일</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item, idx) => {
                  const inv = item["송장번호"];
                  const lr = inv ? llogisResults[inv] : null;
                  return (
                    <tr key={idx}>
                      <td style={{ fontVariantNumeric: "tabular-nums" }}>{item["주문번호"] || "-"}</td>
                      <td>{item["상품명"] || "-"}</td>
                      <td>{item["옵션"] || "-"}</td>
                      <td>{item["수취인명"] || "-"}</td>
                      <td style={{ whiteSpace: "nowrap" }}>{formatSentDate(item["발송일"])}</td>
                      <td style={{ fontVariantNumeric: "tabular-nums" }}>{inv || "-"}</td>
                      {(() => {
                        if (!inv) return <><td>-</td><td>-</td><td>-</td></>;
                        if (llogisLoading && !lr) return <><td colSpan={3} style={{ textAlign: "center" }}>…</td></>;
                        if (!lr) return <><td>-</td><td>-</td><td>-</td></>;
                        if (lr.error) return (
                          <><td colSpan={3} title={lr.error} style={{ color: "#ef4444", cursor: "help" }}>{lr.error}</td></>
                        );
                        return (
                          <>
                            <td>{lr.status || "-"}</td>
                            <td>{lr.location || "-"}</td>
                            <td style={{ whiteSpace: "nowrap" }}>{formatScanDate(lr.scan_date)}</td>
                          </>
                        );
                      })()}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {!loading && items.length === 0 && (
        <div className={styles.message}>
          "에이블리 조회" 버튼을 눌러 배송중 주문을 불러오세요.
        </div>
      )}
    </div>
  );
}
