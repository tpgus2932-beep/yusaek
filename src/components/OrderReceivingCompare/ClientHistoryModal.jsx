import React, { useEffect, useState } from "react";
import styles from "./OrderReceivingCompare.module.css";
import { LOCAL_API_BASE as API, getAuthHeaders } from "../../lib/api";

const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// 거래처 하나의 과거(오늘 포함) 일자별 매칭: 기간별 조회 + 거래처 검색과 같은 결과 화면(render)을 그대로 쓴다.
// render(result) → 결과 화면. 그룹 이름은 "거래처 · MM-DD", 최근 날짜가 위.
export default function ClientHistoryModal({ client, onClose, render }) {
  const [state, setState] = useState({ loading: true, error: "", result: null });

  useEffect(() => {
    let cancelled = false;
    const to = new Date();
    const from = new Date();
    from.setFullYear(from.getFullYear() - 1);
    const params = new URLSearchParams({ client, date_from: fmt(from), date_to: fmt(to), split_days: "true" });
    fetch(`${API}/order-receiving/client-report?${params}`, { headers: getAuthHeaders() })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`불러오지 못했어요 (${res.status})`))))
      .then((d) => {
        if (cancelled) return;
        const prefix = `${client} · `;
        const clients = (d.result?.clients || [])
          .filter((c) => String(c.client).startsWith(prefix))
          .sort((a, b) => (String(a.client) < String(b.client) ? 1 : -1)); // 최근 날짜가 위
        setState({ loading: false, error: "", result: clients.length ? { ...d.result, clients } : null });
      })
      .catch((err) => { if (!cancelled) setState({ loading: false, error: err.message, result: null }); });
    return () => { cancelled = true; };
  }, [client]);

  return (
    <div className={styles.modalBack} onClick={onClose}>
      <div className={styles.modal} style={{ maxWidth: 1180, width: "96vw", maxHeight: "88vh", overflow: "auto" }} onClick={(e) => e.stopPropagation()}>
        <div className={styles.row} style={{ alignItems: "center", justifyContent: "space-between" }}>
          <h3 style={{ margin: 0 }}>{client} <span className={styles.muted} style={{ fontSize: "0.8rem" }}>일자별 매칭</span></h3>
          <button className={styles.btn} onClick={onClose}>닫기</button>
        </div>
        {state.loading && <div className={styles.muted}>불러오는 중…</div>}
        {state.error && <div className={styles.muted}>{state.error}</div>}
        {!state.loading && !state.error && !state.result && <div className={styles.muted}>저장된 매칭이 없어요</div>}
        {state.result && render(state.result)}
      </div>
    </div>
  );
}
