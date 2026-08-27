import React, { useCallback, useEffect, useState } from "react";
import { RefreshCw, Trash2 } from "lucide-react";
import styles from "./DBManager.module.css";
import { LOCAL_API_BASE as API, getAuthHeaders } from "../../lib/api";

const PAGE_SIZE = 50;

const ACTION_LABELS = {
  tsv_copy: "TSV 복사",
  order_execute: "발주 실행",
  backfill_confirmed: "확정수량 백필",
};

const RESULT_LABELS = {
  success: "성공",
  failed: "실패",
};

const RECOMMENDED_QTY_SOURCE_LABELS = {
  daily: "일별데이터(계산없음)",
  discover: "추가상품(계산없음)",
  non_ably_only: "비에이블리전용",
  misong_pickup: "미송픽업",
};

function recommendedQtyDisplay(row) {
  if (row.recommended_qty != null) return row.recommended_qty;
  const label = RECOMMENDED_QTY_SOURCE_LABELS[row.recommended_qty_source];
  return label ? `- (${label})` : "-";
}

export default function OrderHistoryTable() {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [filters, setFilters] = useState({ dateFrom: "", dateTo: "", actionType: "", q: "" });
  const [appliedFilters, setAppliedFilters] = useState(filters);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);

  const fetchRows = useCallback(async (activeFilters, activeOffset) => {
    setLoading(true);
    setMessage("");
    try {
      const params = new URLSearchParams({ offset: String(activeOffset), limit: String(PAGE_SIZE) });
      if (activeFilters.dateFrom) params.set("date_from", activeFilters.dateFrom);
      if (activeFilters.dateTo) params.set("date_to", activeFilters.dateTo);
      if (activeFilters.actionType) params.set("action_type", activeFilters.actionType);
      if (activeFilters.q) params.set("q", activeFilters.q);
      const res = await fetch(`${API}/order/main-order/history?${params}`, { headers: getAuthHeaders() });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "발주내역 조회에 실패했습니다.");
      setRows(data.rows || []);
      setTotal(data.total || 0);
    } catch (err) {
      setMessage(err.message || "발주내역 조회에 실패했습니다.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchRows(appliedFilters, offset); }, [appliedFilters, fetchRows, offset]);
  useEffect(() => { setSelectedIds(new Set()); }, [rows]);

  const applyFilters = (event) => {
    event.preventDefault();
    setOffset(0);
    setAppliedFilters({ ...filters, q: filters.q.trim() });
  };

  const updateFilter = (key, value) => setFilters((current) => ({ ...current, [key]: value }));

  const toggleSelectRow = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    setSelectedIds((prev) => {
      if (prev.size === rows.length) return new Set();
      return new Set(rows.map((r) => r.id));
    });
  };

  const handleDeleteSelected = async () => {
    const ids = Array.from(selectedIds);
    if (!ids.length) return;
    if (!window.confirm(`선택한 ${ids.length}건을 삭제합니다.\n진행하시겠습니까?`)) return;
    setBulkDeleting(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/order/main-order/history`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ ids }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "삭제 실패");
      setMessage(`삭제 완료: ${data.deleted}건`);
      setSelectedIds(new Set());
      await fetchRows(appliedFilters, offset);
    } catch (err) {
      setMessage(err.message || "삭제 실패");
    } finally {
      setBulkDeleting(false);
    }
  };
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  return (
    <>
      <div className={styles.header}>
        <div>
          <div className={styles.title}>발주내역</div>
          <div className={styles.subtitle}>선택 항목 TSV 복사 / 발주 실행 버튼을 누른 이력입니다.</div>
        </div>
        <span className={styles.pill}>{total.toLocaleString()}건</span>
      </div>

      <div className={styles.controls}>
        <form onSubmit={applyFilters} style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
          <input className={styles.searchInput} style={{ width: "150px" }} type="date" value={filters.dateFrom} onChange={(e) => updateFilter("dateFrom", e.target.value)} aria-label="시작 날짜" />
          <input className={styles.searchInput} style={{ width: "150px" }} type="date" value={filters.dateTo} onChange={(e) => updateFilter("dateTo", e.target.value)} aria-label="종료 날짜" />
          <select className={styles.searchInput} style={{ width: "130px" }} value={filters.actionType} onChange={(e) => updateFilter("actionType", e.target.value)} aria-label="구분">
            <option value="">전체 구분</option>
            <option value="tsv_copy">TSV 복사</option>
            <option value="order_execute">발주 실행</option>
            <option value="backfill_confirmed">확정수량 백필</option>
          </select>
          <input className={styles.searchInput} value={filters.q} onChange={(e) => updateFilter("q", e.target.value)} placeholder="상품코드, 상품명, 매장명, 계정" />
          <button className={`${styles.btn} ${styles.btnPrimary}`} type="submit" disabled={loading}>검색</button>
        </form>
        <button className={`${styles.btn} ${styles.btnSecondary}`} onClick={() => fetchRows(appliedFilters, offset)} disabled={loading} title="새로고침">
          <RefreshCw size={13} />새로고침
        </button>
        <button
          className={`${styles.btn} ${styles.btnDanger}`}
          onClick={handleDeleteSelected}
          disabled={loading || bulkDeleting || !selectedIds.size}
        >
          <Trash2 size={13} />{bulkDeleting ? "삭제 중..." : `선택 삭제 (${selectedIds.size})`}
        </button>
      </div>

      {message && <div className={styles.message}>{message}</div>}

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>
                <input
                  type="checkbox"
                  checked={rows.length > 0 && selectedIds.size === rows.length}
                  onChange={toggleSelectAll}
                />
              </th>
              <th>기록일시</th>
              <th>구분</th>
              <th>매장명</th>
              <th>상품코드</th>
              <th>상품정보</th>
              <th>거래처상품명</th>
              <th>옵션</th>
              <th>재고</th>
              <th>미송</th>
              <th>부족수량</th>
              <th>추천발주량</th>
              <th>요청수량</th>
              <th>결과</th>
              <th>실행 계정</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <input
                    type="checkbox"
                    checked={selectedIds.has(row.id)}
                    onChange={() => toggleSelectRow(row.id)}
                  />
                </td>
                <td>{row.recorded_at}</td>
                <td>{ACTION_LABELS[row.action_type] || row.action_type}</td>
                <td>{row.store_name || "-"}</td>
                <td>{row.product_code || "-"}</td>
                <td>{row.product_name || row.supply_product_name || "-"}</td>
                <td>{row.client_product_name || "-"}</td>
                <td>{row.options || "-"}</td>
                <td>{row.stock_qty ?? "-"}</td>
                <td>{row.incoming_qty ?? "-"}</td>
                <td>{row.lack_qty ?? "-"}</td>
                <td>{recommendedQtyDisplay(row)}</td>
                <td>{row.request_qty}</td>
                <td>
                  {row.result_status
                    ? `${RESULT_LABELS[row.result_status] || row.result_status}${row.result_reason ? ` (${row.result_reason})` : ""}`
                    : "-"}
                </td>
                <td>{row.recorded_by_display_name || row.recorded_by_username}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && !loading && <div className={styles.empty}>조회된 발주내역이 없습니다.</div>}
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
