import { useState } from "react";
import { PackageX, Search, Unlock } from "lucide-react";
import styles from "./NoyeKimPage.module.css";
import { LOCAL_API_BASE as API, getAuthHeaders } from "../../lib/api";
import { useEzadminSession } from "../../lib/EzadminSessionContext";

// 관리페이지(승일방)에 있던 부분취소 화면을 옮겨온 것.
// 이지어드민 최근 3개월 · C/S 부분취소 · 보류 주문을 찾아 한 번에 보류해제한다.
const OrderTable = ({ title, orders }) => (
  <section className={styles.card}>
    <div className={styles.cardHeader}>
      <div className={styles.cardTitleRow}>
        <h3 className={styles.cardTitle}>{title}</h3>
      </div>
      <span className={styles.pill}>{orders.length}건</span>
    </div>
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>주문번호</th><th>판매처</th><th>수령자</th><th>상품명</th><th>옵션</th><th>수량</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => (
            <tr key={o.seq}>
              <td>{o.orderSeq}</td><td>{o.shop}</td><td>{o.recvName}</td>
              <td>{o.name}</td><td>{o.option}</td><td>{o.qty}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </section>
);

export default function PartialCancelManager() {
  const { openModal: openEzadminModal } = useEzadminSession();
  const [busy, setBusy] = useState(false);
  const [orders, setOrders] = useState(null);
  const [processed, setProcessed] = useState(null);
  const [message, setMessage] = useState("");

  const call = async (path, options, retry) => {
    setBusy(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/partial-cancel${path}`, {
        ...options,
        headers: { ...getAuthHeaders(), ...(options?.headers || {}) },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.detail === "session_expired") {
          setMessage("이지어드민 세션이 없거나 만료되었습니다. PHPSESSID를 다시 등록해주세요.");
          openEzadminModal(retry);
          return null;
        }
        throw new Error(data.detail || "요청에 실패했습니다.");
      }
      return data;
    } catch (err) {
      setMessage(err.message || "요청에 실패했습니다.");
      return null;
    } finally {
      setBusy(false);
    }
  };

  const handlePreview = async () => {
    const data = await call("/preview", undefined, handlePreview);
    if (data) {
      setProcessed(null);
      setOrders(data.orders || []);
      setMessage(`보류 상태의 부분취소 주문 ${data.count}건`);
    }
  };

  const handleRun = async () => {
    if (!orders?.length) return;
    if (!window.confirm(`부분취소 보류 주문 ${orders.length}건을 보류해제합니다. 계속하시겠습니까?`)) return;
    const data = await call("/run", { method: "POST" }, handleRun);
    if (data) {
      setMessage(`${data.count}건 중 ${data.released ?? 0}건 보류해제 완료`);
      setProcessed(data.orders || []);
      setOrders(null);
    }
  };

  return (
    <>
      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <div className={styles.cardTitleRow}>
            <div className={`${styles.cardIcon} ${styles.cardIconSlate}`}><PackageX size={15} /></div>
            <h3 className={styles.cardTitle}>부분취소</h3>
          </div>
        </div>
        <div className={styles.statusMsg}>
          이지어드민 확장자주문검색2에서 최근 3개월 · C/S 부분취소 · 보류 주문을 모두 찾아 보류해제합니다.
        </div>
        <div className={styles.uploadRow}>
          <button className={styles.secondaryBtn} onClick={handlePreview} disabled={busy}>
            <Search size={13} />{busy ? "처리 중..." : "대상 조회"}
          </button>
          <button
            className={styles.primaryBtn}
            onClick={handleRun}
            disabled={busy || !orders || orders.length === 0}
          >
            <Unlock size={14} />보류해제 실행
          </button>
        </div>
        {message && <div className={styles.statusMsg}>{message}</div>}
      </section>

      {orders && orders.length > 0 && <OrderTable title="대상 주문" orders={orders} />}
      {processed && processed.length > 0 && <OrderTable title="처리 완료" orders={processed} />}
    </>
  );
}
