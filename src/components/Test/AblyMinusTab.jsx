import React, { useState } from "react";
import { RefreshCw } from "lucide-react";
import styles from "./TestTabs.module.css";
import { LOCAL_API_BASE as API, getAuthHeaders } from "../../lib/api";

export default function AblyMinusTab() {
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [result, setResult] = useState(null);

  const run = async () => {
    if (
      !window.confirm(
        "오출 주문 수량만큼 오늘배송 옵션 재고를 차감합니다.\n\n진행하시겠습니까?"
      )
    )
      return;

    setLoading(true);
    setMessage("");
    setResult(null);

    try {
      const res = await fetch(`${API}/ably-minus/run`, {
        method: "POST",
        headers: getAuthHeaders(),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "실행 실패");
      setResult(data);
      setMessage(
        data.message ||
          `완료: 오출 품목 ${data.sync_map_size ?? 0}종 / 재고 차감 ${data.matched ?? 0}건`
      );
    } catch (err) {
      setMessage(err.message || "실행 실패");
    } finally {
      setLoading(false);
    }
  };

  const isError = message.includes("실패") || message.includes("오류");

  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <div className={styles.titleArea}>
          <h1 className={styles.title}>오출마이너스</h1>
          <p className={styles.subtitle}>
            오출 주문(processing_status=1) 수량만큼 에이블리 오늘배송 옵션 재고를 자동 차감합니다.
          </p>
        </div>
        <div className={styles.controls}>
          <button
            className={styles.refreshBtn}
            onClick={run}
            disabled={loading}
          >
            <RefreshCw size={14} className={loading ? styles.spinning : ""} />
            {loading ? "실행 중..." : "오출 재고 차감 실행"}
          </button>
        </div>
      </div>

      {message && (
        <div
          className={styles.message}
          style={
            isError
              ? { borderColor: "rgba(220,53,69,0.4)", background: "rgba(220,53,69,0.07)", color: "#dc2626" }
              : { borderColor: "rgba(34,197,94,0.4)", background: "rgba(34,197,94,0.07)", color: "#15803d" }
          }
        >
          {message}
        </div>
      )}

      {result && result.details && result.details.length > 0 && (
        <section className={styles.section}>
          <div className={styles.statsStrip} style={{ marginBottom: "0.75rem" }}>
            <div className={styles.statItem}>
              <span className={styles.statLabel}>오출 품목 수</span>
              <span className={styles.statValue}>{result.sync_map_size ?? 0}종</span>
            </div>
            <div className={styles.statDivider} />
            <div className={styles.statItem}>
              <span className={styles.statLabel}>재고 차감 처리</span>
              <span className={styles.statValue}>{result.matched ?? 0}건</span>
            </div>
          </div>

          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>상품명</th>
                  <th>옵션</th>
                  <th>Sync Code</th>
                  <th>차감 수량</th>
                  <th>이전 재고</th>
                  <th>새 재고</th>
                </tr>
              </thead>
              <tbody>
                {result.details.map((d, i) => (
                  <tr key={i}>
                    <td style={{ maxWidth: "260px", wordBreak: "break-word" }}>
                      {d._goods_name || "-"}
                    </td>
                    <td>{d._option_name || "-"}</td>
                    <td style={{ fontFamily: "monospace", fontSize: "0.78rem" }}>
                      {d.stock_sync_code}
                    </td>
                    <td style={{ color: "#dc2626", fontWeight: 700 }}>
                      -{d._ea_minus}
                    </td>
                    <td style={{ color: "var(--text-muted)" }}>{d._prev_stock}</td>
                    <td style={{ fontWeight: 700 }}>{d.stock}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {result && result.details && result.details.length === 0 && !result.message && (
        <div className={styles.message}>
          오출 주문과 매칭되는 오늘배송 옵션이 없습니다.
        </div>
      )}
    </div>
  );
}
