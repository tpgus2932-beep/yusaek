import { useState } from "react";
import { useEzadminSession } from "../../lib/EzadminSessionContext";
import styles from "./BarcodePage.module.css";
import { LOCAL_API_BASE as API, getAuthHeaders } from "../../lib/api";

export default function AmoodUnpackCard() {
  const { openModal: openEzadminModal } = useEzadminSession();
  const [orderId, setOrderId] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);

  const run = async () => {
    const id = orderId.trim();
    if (!id) {
      setResult({ ok: false, error: "주문번호를 입력해주세요.", steps: [] });
      return;
    }
    if (!window.confirm(`주문번호 ${id}를 배송취소 후 합포에서 제외하고, 남은 합포를 보류해제/배송처리합니다. 진행할까요?`)) return;
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch(`${API}/amood-unpack/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ order_id: id }),
      });
      const data = await res.json().catch(() => ({}));
      if (data?.need_ezadmin_session) {
        openEzadminModal(run);
        return;
      }
      if (!res.ok) throw new Error(data?.detail || "처리 실패");
      setResult(data);
      if (data.ok) setOrderId("");
    } catch (err) {
      setResult({ ok: false, error: err.message || "처리 실패", steps: [] });
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className={styles.card}>
      <div className={styles.cardHeader}>
        <h3 className={styles.cardTitle}>합포제외 후 배송처리</h3>
      </div>
      <div className={styles.uploadRow}>
        <input
          className={styles.scanInput}
          style={{ maxWidth: "260px" }}
          value={orderId}
          onChange={(e) => setOrderId(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !loading) run(); }}
          placeholder="주문번호"
          disabled={loading}
        />
        <button type="button" className={styles.primaryBtn} onClick={run} disabled={loading}>
          {loading ? "처리 중..." : "배송취소 · 합포제외 · 배송처리"}
        </button>
      </div>
      {result && (
        <div style={{ marginTop: "0.75rem", fontSize: "0.85rem", display: "flex", flexDirection: "column", gap: "0.25rem" }}>
          <strong style={{ color: result.ok ? "#15803d" : "#dc2626" }}>
            {result.ok ? `완료 (주문번호 ${result.order_id}, 남은 합포 ${result.pack})` : result.error}
          </strong>
          {(result.steps || []).map((s, i) => (
            <span key={i} style={{ color: s.ok ? "#15803d" : "#dc2626" }}>
              {s.ok ? "✔" : "✖"} {s.step} - {s.detail}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}
