import { useState } from "react";
import { RefreshCw, Warehouse } from "lucide-react";
import styles from "./InventoryDashboardPage.module.css";
import { LOCAL_API_BASE as API, getAuthHeaders } from "../../lib/api";
import { useEzadminSession } from "../../lib/EzadminSessionContext";

function TodayStockCheckCard() {
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [result, setResult] = useState(null);
  const [showRaw, setShowRaw] = useState(false);
  const { openModal } = useEzadminSession();

  const run = async () => {
    setLoading(true);
    setMessage("");
    setResult(null);
    try {
      // 1) 입고파일 이지어드민에서 새로 불러오기 (사이드메뉴 바코드의 기존 기능 재사용)
      const incomingRes = await fetch(`${API}/barcode/incoming/upload-from-ezadmin`, {
        method: "POST",
        headers: getAuthHeaders(),
      });
      const incomingData = await incomingRes.json().catch(() => ({}));
      if (incomingData.need_session) {
        openModal(run);
        setMessage("이지어드민 세션이 없습니다. 설정 후 다시 시도해주세요.");
        return;
      }
      if (!incomingRes.ok) throw new Error(incomingData?.detail || "입고파일 불러오기 실패");

      // 2) 오늘 재고체크 (BX00) 호출 후, 입고파일에 있는 상품코드만 필터링
      const stockRes = await fetch(`${API}/inventory-dashboard/today-stock-check`, {
        method: "POST",
        headers: getAuthHeaders(),
      });
      const stockData = await stockRes.json().catch(() => ({}));
      if (stockData.need_session) {
        openModal(run);
        setMessage("이지어드민 세션이 없습니다. 설정 후 다시 시도해주세요.");
        return;
      }
      if (!stockRes.ok || !stockData.ok) throw new Error(stockData?.detail || "재고체크 조회 실패");

      setResult(stockData);
      setMessage(
        `조회 완료: 재고 전체 ${stockData.total_rows}건 중 입고파일과 일치 ${stockData.matched.length}건 (입고코드 ${stockData.incoming_codes}개)`
      );
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
        <button className={styles.primaryBtn} onClick={run} disabled={loading}>
          <RefreshCw size={13} className={loading ? styles.spinning : undefined} />
          {loading ? "조회 중..." : "조회"}
        </button>
      </div>
      <p className={styles.cardDesc}>
        오늘 날짜 기준 이지어드민 재고 목록을 불러온 뒤, 사이드메뉴 바코드의 입고파일(이지어드민)에
        있는 상품코드만 남겨서 보여줍니다.
      </p>

      {message && <div className={styles.message}>{message}</div>}

      {result && (
        <>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>상품코드</th>
                  <th>상품명</th>
                  <th>재고수량</th>
                  <th>입고수량</th>
                </tr>
              </thead>
              <tbody>
                {result.matched.map((row) => (
                  <tr key={row.code}>
                    <td>{row.code}</td>
                    <td>{row.productName}</td>
                    <td>{row.stockQty}</td>
                    <td>{row.incomingQty}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!result.matched.length && (
              <div className={styles.empty}>일치하는 상품이 없습니다.</div>
            )}
          </div>

          {result.matched.length > 0 && (
            <div className={styles.rawToggle}>
              <button className={styles.linkBtn} onClick={() => setShowRaw((v) => !v)}>
                {showRaw ? "원본 필드 숨기기 ▲" : "원본 필드 보기 (필드명 확인용) ▼"}
              </button>
              {showRaw && (
                <pre className={styles.rawBlock}>
                  {JSON.stringify(result.matched[0].raw, null, 2)}
                </pre>
              )}
            </div>
          )}
        </>
      )}
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
