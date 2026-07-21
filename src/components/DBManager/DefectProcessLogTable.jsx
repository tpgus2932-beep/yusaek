import React, { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import styles from "./DBManager.module.css";
import { LOCAL_API_BASE as API, getAuthHeaders } from "../../lib/api";

const PAGE_SIZE = 50;

const PROCESS_LABELS = {
  ezadmin_stock_out: "출고처리",
  ably_ochuul_minus: "오출내리기",
};

const STATUS_LABELS = {
  completed: "완료",
  matched: "차감 완료",
  unmatched: "미매칭",
  missing_option_number: "옵션번호 없음",
  not_in_ably_today: "에이블리 오늘출발 목록 없음",
};

export default function DefectProcessLogTable() {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [filters, setFilters] = useState({ dateFrom: "", dateTo: "", processType: "", q: "" });
  const [appliedFilters, setAppliedFilters] = useState(filters);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");

  const fetchRows = useCallback(async (activeFilters, activeOffset) => {
    setLoading(true);
    setMessage("");
    try {
      const params = new URLSearchParams({ offset: String(activeOffset), limit: String(PAGE_SIZE) });
      if (activeFilters.dateFrom) params.set("date_from", activeFilters.dateFrom);
      if (activeFilters.dateTo) params.set("date_to", activeFilters.dateTo);
      if (activeFilters.processType) params.set("process_type", activeFilters.processType);
      if (activeFilters.q) params.set("q", activeFilters.q);
      const res = await fetch(`${API}/wonbe/defect-process-logs?${params}`, { headers: getAuthHeaders() });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "로그 조회에 실패했습니다.");
      setRows(data.rows || []);
      setTotal(data.total || 0);
    } catch (err) {
      setMessage(err.message || "로그 조회에 실패했습니다.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchRows(appliedFilters, offset); }, [appliedFilters, fetchRows, offset]);

  const applyFilters = (event) => {
    event.preventDefault();
    setOffset(0);
    setAppliedFilters({ ...filters, q: filters.q.trim() });
  };

  const updateFilter = (key, value) => setFilters((current) => ({ ...current, [key]: value }));
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  return (
    <>
      <div className={styles.header}>
        <div>
          <div className={styles.title}>불량처리로그</div>
          <div className={styles.subtitle}>불량 목록 출고처리와 오출내리기 실행 이력입니다.</div>
        </div>
        <span className={styles.pill}>{total.toLocaleString()}건</span>
      </div>

      <div className={styles.controls}>
        <form onSubmit={applyFilters} style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
          <input className={styles.searchInput} style={{ width: "150px" }} type="date" value={filters.dateFrom} onChange={(e) => updateFilter("dateFrom", e.target.value)} aria-label="시작 날짜" />
          <input className={styles.searchInput} style={{ width: "150px" }} type="date" value={filters.dateTo} onChange={(e) => updateFilter("dateTo", e.target.value)} aria-label="종료 날짜" />
          <select className={styles.searchInput} style={{ width: "130px" }} value={filters.processType} onChange={(e) => updateFilter("processType", e.target.value)} aria-label="처리 유형">
            <option value="">전체 처리</option>
            <option value="ezadmin_stock_out">출고처리</option>
            <option value="ably_ochuul_minus">오출내리기</option>
          </select>
          <input className={styles.searchInput} value={filters.q} onChange={(e) => updateFilter("q", e.target.value)} placeholder="상품코드, 상품명, 계정" />
          <button className={`${styles.btn} ${styles.btnPrimary}`} type="submit" disabled={loading}>검색</button>
        </form>
        <button className={`${styles.btn} ${styles.btnSecondary}`} onClick={() => fetchRows(appliedFilters, offset)} disabled={loading} title="새로고침">
          <RefreshCw size={13} />새로고침
        </button>
      </div>

      {message && <div className={styles.message}>{message}</div>}

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>처리일시</th>
              <th>처리</th>
              <th>상품코드</th>
              <th>상품정보</th>
              <th>거래처</th>
              <th>요청 수량</th>
              <th>결과</th>
              <th>처리 계정</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>{row.processed_at}</td>
                <td>{PROCESS_LABELS[row.process_type] || row.process_type}</td>
                <td>{row.product_code}</td>
                <td>{[row.product_name, row.product_option].filter(Boolean).join(" / ") || "-"}</td>
                <td>{[row.vendor, row.vendor_product].filter(Boolean).join(" / ") || "-"}</td>
                <td>{row.requested_qty}</td>
                <td>
                  {STATUS_LABELS[row.result_status] || row.result_status}
                  {row.process_type === "ably_ochuul_minus" && row.result_status === "matched" ? ` (${row.applied_qty}개)` : ""}
                </td>
                <td>{row.processed_by_display_name || row.processed_by_username}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && !loading && <div className={styles.empty}>조회된 처리 로그가 없습니다.</div>}
      </div>

      {totalPages > 1 && (
        <div className={styles.pagination}>
          <button className={`${styles.btn} ${styles.btnSecondary}`} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} disabled={offset === 0 || loading}>이전</button>
          <span>{currentPage} / {totalPages}</span>
          <button className={`${styles.btn} ${styles.btnSecondary}`} onClick={() => setOffset(offset + PAGE_SIZE)} disabled={currentPage >= totalPages || loading}>다음</button>
        </div>
      )}
    </>
  );
}
