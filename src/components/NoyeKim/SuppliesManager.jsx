import React, { useCallback, useEffect, useState } from "react";
import { LOCAL_API_BASE as API, getAuthHeaders } from "../../lib/api";
import styles from "./NoyeKimPage.module.css";

export default function SuppliesManager() {
  const [items, setItems] = useState([]);
  const [draft, setDraft] = useState({});
  const [msg, setMsg] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API}/supplies/stock`, { headers: getAuthHeaders() });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "불러오기 실패");
      setItems(data.items || []);
    } catch (e) {
      setMsg(String(e.message || e));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const save = async () => {
    const stock = {};
    Object.entries(draft).forEach(([k, v]) => { if (String(v).trim() !== "") stock[k] = v; });
    if (!Object.keys(stock).length) return;
    setSaving(true);
    setMsg("");
    try {
      const res = await fetch(`${API}/supplies/stock`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ stock }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "저장 실패");
      setItems(data.items || []);
      setDraft({});
      setMsg("저장했습니다.");
    } catch (e) {
      setMsg(String(e.message || e));
    } finally {
      setSaving(false);
    }
  };

  const nameOf = (it) => `${it.label} (${it.size})`;
  const iStyle = { padding: "5px 8px", border: "1px solid var(--border-color)", borderRadius: 4, background: "var(--bg-secondary)", color: "var(--text-primary)", width: 110 };

  return (
    <>
      <section className={styles.card}>
        <h3 className={styles.cardTitle}>겉포장지 재고</h3>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
          {items.map((it) => (
            <div key={it.kind} style={{ fontSize: "1.05rem" }}>
              {nameOf(it)} : {it.qty.toLocaleString()}
              {it.today !== 0 && <span style={{ marginLeft: 8 }}>({it.today > 0 ? "+" : ""}{it.today.toLocaleString()})</span>}
            </div>
          ))}
        </div>
      </section>

      <section className={styles.card}>
        <h3 className={styles.cardTitle}>현재 재고 설정</h3>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 8, alignItems: "center" }}>
          {items.map((it) => (
            <label key={it.kind} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {nameOf(it)}
              <input
                type="number"
                style={iStyle}
                placeholder={String(it.qty)}
                value={draft[it.kind] ?? ""}
                onChange={(e) => setDraft((d) => ({ ...d, [it.kind]: e.target.value }))}
              />
            </label>
          ))}
          <button className={styles.primaryBtn} onClick={save} disabled={saving}>저장</button>
        </div>
        {msg && <div style={{ marginTop: 8 }}>{msg}</div>}
      </section>
    </>
  );
}
