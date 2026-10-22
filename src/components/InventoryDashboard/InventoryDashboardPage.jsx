import { useEffect, useMemo, useState } from "react";
import { RefreshCw, Warehouse } from "lucide-react";
import styles from "./InventoryDashboardPage.module.css";
import { LOCAL_API_BASE as API, getAuthHeaders } from "../../lib/api";
import { useEzadminSession } from "../../lib/EzadminSessionContext";

const COLUMNS = [
  { key: "code", label: "상품코드" },
  { key: "product_name", label: "상품명" },
  { key: "options", label: "옵션" },
  { key: "supply_name", label: "공급처" },
  { key: "stock_qty", label: "재고수량", numeric: true },
  { key: "stock_in_standby", label: "입고대기", numeric: true },
  { key: "before_trans", label: "전송전", numeric: true },
  { key: "trans_ready", label: "배송준비", numeric: true },
];

function TodayStockCheckCard() {
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [items, setItems] = useState([]);
  const [fetchedAt, setFetchedAt] = useState(null);
  const [canRefresh, setCanRefresh] = useState(true);
  const [rawUnexpected, setRawUnexpected] = useState(null);
  const [sort, setSort] = useState({ key: null, dir: "asc" });
  const { openModal } = useEzadminSession();

  // 같은 열을 누르면 오름차순 → 내림차순 → 원래 순서 순으로 전환
  const toggleSort = (key) =>
    setSort((prev) => {
      if (prev.key !== key) return { key, dir: "asc" };
      if (prev.dir === "asc") return { key, dir: "desc" };
      return { key: null, dir: "asc" };
    });

  const sortedItems = useMemo(() => {
    if (!sort.key) return items;
    const col = COLUMNS.find((c) => c.key === sort.key);
    const sign = sort.dir === "asc" ? 1 : -1;
    return [...items].sort((a, b) => {
      if (col.numeric) return ((Number(a[col.key]) || 0) - (Number(b[col.key]) || 0)) * sign;
      return String(a[col.key] ?? "").localeCompare(String(b[col.key] ?? ""), "ko") * sign;
    });
  }, [items, sort]);

  const loadSaved = async () => {
    try {
      const res = await fetch(`${API}/inventory-dashboard/stock`, { headers: getAuthHeaders() });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        setItems(data.items || []);
        setFetchedAt(data.fetched_at || null);
        setCanRefresh(data.can_refresh !== false);
      }
    } catch {
      /* 저장된 데이터 조회 실패는 무시 — 조회 버튼으로 다시 가져올 수 있음 */
    }
  };

  useEffect(() => {
    loadSaved();
  }, []);

  const run = async () => {
    setLoading(true);
    setMessage("");
    setRawUnexpected(null);
    try {
      // 이지어드민 재고를 새로 불러와 기존 DB 데이터를 삭제하고 다시 저장
      const res = await fetch(`${API}/inventory-dashboard/refresh`, {
        method: "POST",
        headers: getAuthHeaders(),
      });
      const data = await res.json().catch(() => ({}));
      if (data.need_session) {
        openModal(run);
        setMessage("이지어드민 세션이 없습니다. 설정 후 다시 시도해주세요.");
        return;
      }
      if (data.unexpected_response) {
        setMessage("예상과 다른 응답을 받았습니다 (세션 문제 아님) — 아래 원본을 확인해주세요.");
        setRawUnexpected(data.raw);
        return;
      }
      if (!res.ok || !data.ok) throw new Error(data?.detail || "재고 조회 실패");

      await loadSaved();
      setMessage(`조회 완료: ${data.count}건을 DB에 새로 저장했습니다.`);
    } catch (err) {
      setMessage(err.message || "조회 실패");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={styles.card}>
      <div className={styles.cardHeader}>
        <h3 className={styles.cardTitle}>오늘 재고체크</h3>
        {canRefresh && (
          <button className={styles.primaryBtn} onClick={run} disabled={loading}>
            <RefreshCw size={13} className={loading ? styles.spinning : undefined} />
            {loading ? "조회 중..." : "조회"}
          </button>
        )}
      </div>
      <p className={styles.cardDesc}>
        {canRefresh
          ? "조회 버튼을 누르면 이지어드민 재고(재고 1개 이상)를 불러와 기존 저장 데이터를 삭제하고 DB에 새로 저장합니다."
          : "로컬에서 조회해 저장한 재고 내용입니다."}
        {fetchedAt && ` · 마지막 저장: ${new Date(fetchedAt).toLocaleString("ko-KR")}`}
      </p>

      {message && <div className={styles.message}>{message}</div>}

      {rawUnexpected && (
        <pre className={styles.rawBlock}>{JSON.stringify(rawUnexpected, null, 2)}</pre>
      )}

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              {COLUMNS.map((col) => (
                <th
                  key={col.key}
                  onClick={() => toggleSort(col.key)}
                  style={{ cursor: "pointer", userSelect: "none" }}
                >
                  {col.label}
                  {sort.key === col.key && (sort.dir === "asc" ? " ▲" : " ▼")}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedItems.map((row) => (
              <tr key={row.code}>
                <td>{row.code}</td>
                <td>{row.product_name}</td>
                <td>{row.options}</td>
                <td>{row.supply_name}</td>
                <td>{row.stock_qty}</td>
                <td>{row.stock_in_standby}</td>
                <td>{row.before_trans}</td>
                <td>{row.trans_ready}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!items.length && <div className={styles.empty}>저장된 재고가 없습니다.{canRefresh && " 조회를 눌러주세요."}</div>}
      </div>
    </div>
  );
}

export default function InventoryDashboardPage() {
  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <Warehouse size={20} />
        <h2>재고 대시보드</h2>
      </header>
      <div className={styles.cardGrid}>
        <TodayStockCheckCard />
      </div>
    </div>
  );
}
