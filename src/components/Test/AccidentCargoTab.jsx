import React, { useState, useEffect } from "react";
import { RefreshCw, X } from "lucide-react";
import styles from "./TestTabs.module.css";
import { LOCAL_API_BASE as API, getAuthHeaders } from "../../lib/api";

function toDateStr(d) {
  return d.toISOString().slice(0, 10);
}

export default function AccidentCargoTab() {
  const today = new Date();
  const threeMonthsAgo = new Date(today);
  threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

  const [invoiceList, setInvoiceList] = useState([]);
  const [completedList, setCompletedList] = useState([]);
  const [inputValue, setInputValue] = useState("");
  const [memoValue, setMemoValue] = useState("");
  const [editingMemo, setEditingMemo] = useState(null); // invNo being edited
  const [editingMemoValue, setEditingMemoValue] = useState("");
  const [startDate, setStartDate] = useState(toDateStr(threeMonthsAgo));
  const [endDate, setEndDate] = useState(toDateStr(today));
  const [loading, setLoading] = useState(false);
  const [listLoading, setListLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [message, setMessage] = useState("");

  useEffect(() => {
    loadAll();
  }, []);

  const loadAll = async () => {
    setListLoading(true);
    try {
      const [invRes, compRes] = await Promise.all([
        fetch(`${API}/accident-cargo/invoices`, { headers: getAuthHeaders() }),
        fetch(`${API}/accident-cargo/completed`, { headers: getAuthHeaders() }),
      ]);
      const invData = await invRes.json().catch(() => ({}));
      const compData = await compRes.json().catch(() => ({}));
      if (invRes.ok) setInvoiceList(invData.items || []);
      if (compRes.ok) setCompletedList(compData.items || []);
    } catch {
      // 로드 실패는 조용히 처리
    } finally {
      setListLoading(false);
    }
  };

  const addInvoice = async () => {
    const inv = inputValue.trim();
    if (!inv) return;
    try {
      const res = await fetch(`${API}/accident-cargo/invoices`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ inv_no: inv, memo: memoValue.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "추가 실패");
      if (!invoiceList.some((i) => i.invNo === inv)) {
        setInvoiceList((prev) => [
          ...prev,
          { invNo: inv, createdAt: new Date().toISOString(), memo: memoValue.trim() },
        ]);
      }
      setInputValue("");
      setMemoValue("");
    } catch (err) {
      setMessage(err.message || "추가 실패");
    }
  };

  const saveMemo = async (invNo, memo) => {
    try {
      await fetch(`${API}/accident-cargo/invoices/${encodeURIComponent(invNo)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ memo }),
      });
      setInvoiceList((prev) =>
        prev.map((i) => (i.invNo === invNo ? { ...i, memo } : i))
      );
    } catch {
      // 실패 무시
    }
    setEditingMemo(null);
  };

  const removeInvoice = async (inv) => {
    try {
      await fetch(`${API}/accident-cargo/invoices/${encodeURIComponent(inv)}`, {
        method: "DELETE",
        headers: getAuthHeaders(),
      });
    } catch {
      // 실패해도 UI에서 제거
    }
    setInvoiceList((prev) => prev.filter((i) => i.invNo !== inv));
  };

  const fetchAccident = async () => {
    if (invoiceList.length === 0) {
      setMessage("등록된 송장번호가 없습니다.");
      return;
    }
    setLoading(true);
    setMessage("");
    setResult(null);
    try {
      const res = await fetch(`${API}/accident-cargo/fetch`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({
          date_fr: startDate.replace(/-/g, ""),
          date_to: endDate.replace(/-/g, ""),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "조회 실패");
      setResult(data);
      setMessage(
        `조회 완료 — 유색 사고 ${data.total_yusaek}건 중 완료 ${data.matched?.length ?? 0}건 매칭`
      );
      if (data.matched?.length > 0) {
        await loadAll();
      }
    } catch (err) {
      setMessage(err.message || "조회 실패");
    } finally {
      setLoading(false);
    }
  };

  const isError = message.includes("실패") || message.includes("오류");

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <div className={styles.titleArea}>
          <div className={styles.titleRow}>
            <h1 className={styles.title}>택배 사고처리</h1>
          </div>
          <p className={styles.subtitle}>
            송장번호 등록 후 llogis 사고화물 조회 — 유색 항목과 매칭된 송장을 완료목록에 표시
          </p>
        </div>
      </header>

      {/* 송장번호 등록 */}
      <section className={`${styles.section} ${styles.sectionStock}`}>
        <div className={styles.sectionHeader}>
          <div className={styles.sectionTitle}>
            송장번호 등록 {listLoading ? "" : `(${invoiceList.length}건)`}
          </div>
        </div>
        <div style={{ padding: "0.875rem 1.25rem", display: "flex", flexDirection: "column", gap: "0.75rem" }}>
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
            <input
              className={styles.searchInput}
              style={{ width: "200px" }}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addInvoice()}
              placeholder="송장번호"
            />
            <input
              className={styles.searchInput}
              style={{ width: "200px" }}
              value={memoValue}
              onChange={(e) => setMemoValue(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addInvoice()}
              placeholder="메모 (선택)"
            />
            <button
              className={styles.refreshBtn}
              onClick={addInvoice}
              disabled={!inputValue.trim()}
              type="button"
            >
              추가
            </button>
          </div>

          {invoiceList.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem" }}>
              {invoiceList.map((item) => (
                <span
                  key={item.invNo}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "0.4rem",
                    padding: "0.25rem 0.6rem",
                    background: "var(--bg-secondary)",
                    border: "1px solid var(--border-color)",
                    borderRadius: "var(--radius-sm)",
                    fontSize: "0.8rem",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {item.invNo}
                  {item.createdAt && (
                    <span style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>
                      {item.createdAt.slice(0, 10)}
                    </span>
                  )}
                  {editingMemo === item.invNo ? (
                    <input
                      autoFocus
                      style={{
                        fontSize: "0.75rem",
                        border: "1px solid var(--border-color)",
                        borderRadius: "3px",
                        padding: "1px 4px",
                        width: "120px",
                        background: "var(--bg-primary)",
                        color: "var(--text-primary)",
                      }}
                      value={editingMemoValue}
                      onChange={(e) => setEditingMemoValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") saveMemo(item.invNo, editingMemoValue);
                        if (e.key === "Escape") setEditingMemo(null);
                      }}
                      onBlur={() => saveMemo(item.invNo, editingMemoValue)}
                      onClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <span
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditingMemo(item.invNo);
                        setEditingMemoValue(item.memo || "");
                      }}
                      style={{
                        fontSize: "0.75rem",
                        color: item.memo ? "var(--text-secondary)" : "var(--text-muted)",
                        cursor: "text",
                        borderBottom: "1px dashed var(--border-color)",
                        minWidth: "30px",
                        display: "inline-block",
                      }}
                      title="클릭하여 메모 편집"
                    >
                      {item.memo || "메모"}
                    </span>
                  )}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!window.confirm(`송장번호 "${item.invNo}"를 삭제하시겠습니까?`)) return;
                      removeInvoice(item.invNo);
                    }}
                    style={{
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                      padding: 0,
                      lineHeight: 1,
                      color: "var(--text-muted)",
                      display: "flex",
                      alignItems: "center",
                    }}
                    type="button"
                  >
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
          )}

          {invoiceList.length === 0 && !listLoading && (
            <div style={{ color: "var(--text-muted)", fontSize: "0.8rem" }}>
              등록된 송장번호가 없습니다.
            </div>
          )}
        </div>
      </section>

      {/* 조회 조건 */}
      <section className={`${styles.section} ${styles.sectionNormal}`}>
        <div className={styles.sectionHeader}>
          <div className={styles.sectionTitle}>사고화물 조회</div>
        </div>
        <div style={{ padding: "0.875rem 1.25rem", display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
          <input
            type="date"
            className={styles.searchInput}
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            style={{ width: "145px" }}
          />
          <span style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>~</span>
          <input
            type="date"
            className={styles.searchInput}
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            style={{ width: "145px" }}
          />
          <button
            className={styles.refreshBtn}
            onClick={fetchAccident}
            disabled={loading}
            type="button"
          >
            <RefreshCw size={13} className={loading ? styles.spinning : undefined} />
            {loading ? "조회 중..." : "사고화물 조회"}
          </button>
        </div>
      </section>

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

      {/* 완료목록 (DB 전체) */}
      {completedList.length > 0 && (
        <section className={`${styles.section} ${styles.sectionNormal}`}>
          <div className={styles.sectionHeader}>
            <div className={styles.sectionTitle}>완료목록</div>
            <div className={styles.sectionMeta}>
              <span>{completedList.length}건</span>
            </div>
          </div>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>송장번호</th>
                  <th>수취인</th>
                  <th>상품금액</th>
                  <th>합의금액</th>
                  <th>진행상태</th>
                  <th>완료일시</th>
                </tr>
              </thead>
              <tbody>
                {completedList.map((item, i) => (
                  <tr key={i}>
                    <td style={{ fontVariantNumeric: "tabular-nums" }}>{item.invNo}</td>
                    <td>{item.acperNm || "-"}</td>
                    <td style={{ fontVariantNumeric: "tabular-nums" }}>
                      {item.gdsAmt ? Number(item.gdsAmt).toLocaleString() : "-"}
                    </td>
                    <td style={{ fontVariantNumeric: "tabular-nums" }}>
                      {item.agrAmt ? Number(item.agrAmt).toLocaleString() : "-"}
                    </td>
                    <td>{item.acdPrgsSctCd || "-"}</td>
                    <td style={{ whiteSpace: "nowrap", fontSize: "0.78rem", color: "var(--text-muted)" }}>
                      {item.completedAt ? item.completedAt.slice(0, 10) : "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* 미매칭 */}
      {result && result.unmatched && result.unmatched.length > 0 && (
        <section className={`${styles.section} ${styles.sectionStock}`}>
          <div className={styles.sectionHeader}>
            <div className={styles.sectionTitle}>미매칭 (llogis 결과에 없음)</div>
            <div className={styles.sectionMeta}>
              <span>{result.unmatched.length}건</span>
            </div>
          </div>
          <div style={{ padding: "0.875rem 1.25rem", display: "flex", flexWrap: "wrap", gap: "0.4rem" }}>
            {result.unmatched.map((inv, i) => (
              <span
                key={i}
                style={{
                  padding: "0.25rem 0.6rem",
                  background: "rgba(220,53,69,0.07)",
                  border: "1px solid rgba(220,53,69,0.3)",
                  borderRadius: "var(--radius-sm)",
                  fontSize: "0.8rem",
                  fontVariantNumeric: "tabular-nums",
                  color: "#dc2626",
                }}
              >
                {inv}
              </span>
            ))}
          </div>
        </section>
      )}

      {result && result.matched?.length === 0 && (
        <div className={styles.message}>
          조회된 유색 사고화물({result.total_yusaek}건) 중 등록된 송장번호와 매칭되는 항목이 없습니다.
        </div>
      )}
    </div>
  );
}
