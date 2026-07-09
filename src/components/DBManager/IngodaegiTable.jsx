import React, { useCallback, useEffect, useState } from "react";
import { Download, RefreshCw, PlusCircle, Trash2, RotateCcw } from "lucide-react";
import styles from "./DBManager.module.css";
import { LOCAL_API_BASE as API, getAuthHeaders } from "../../lib/api";

const PAGE_SIZE = 50;

export default function IngodaegiTable() {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [query, setQuery] = useState("");
  const [inputQuery, setInputQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [appendText, setAppendText] = useState("");
  const [appending, setAppending] = useState(false);

  const fetchRows = useCallback(async (q, off) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ offset: off, limit: PAGE_SIZE });
      if (q) params.set("q", q);
      const res = await fetch(`${API}/wonbe/ingodaegi/search?${params}`, { headers: getAuthHeaders() });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "조회 실패");
      setRows(data.rows || []);
      setTotal(data.total || 0);
    } catch (err) {
      setMessage(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchRows(query, offset); }, [fetchRows, query, offset]);

  const handleSearch = (e) => {
    e.preventDefault();
    setOffset(0);
    setQuery(inputQuery.trim());
  };

  const handleAppend = async () => {
    if (!appendText.trim()) return;
    setAppending(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/wonbe/ingodaegi/append`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ text: appendText }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "추가 실패");
      setMessage(`추가 완료: 신규 ${data.inserted}건 (요청 ${data.requested}건)`);
      setAppendText("");
      setOffset(0);
      await fetchRows(query, 0);
    } catch (err) {
      setMessage(err.message);
    } finally {
      setAppending(false);
    }
  };

  const handleDelete = async (code) => {
    if (!window.confirm(`${code}를 입고대기 목록에서 삭제할까요?`)) return;
    try {
      const res = await fetch(`${API}/wonbe/ingodaegi/row`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ 상품코드: code }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "삭제 실패");
      setRows((prev) => prev.filter((r) => r["상품코드"] !== code));
      setTotal((t) => Math.max(0, t - 1));
    } catch (err) {
      setMessage(err.message);
    }
  };

  const handleSyncFromWonbe = async () => {
    setLoading(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/wonbe/ingodaegi/sync-from-wonbe`, {
        method: "POST",
        headers: getAuthHeaders(),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "최신업데이트 실패");
      setMessage(`최신업데이트 완료: 원가베이스유 기준 신규 ${data.added}건 추가`);
      setOffset(0);
      await fetchRows(query, 0);
    } catch (err) {
      setMessage(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleDownload = () => {
    fetch(`${API}/wonbe/ingodaegi/export`, { headers: getAuthHeaders() })
      .then((r) => r.blob())
      .then((blob) => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "입고대기.xls";
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(a.href);
      })
      .catch(() => setMessage("다운로드 실패"));
  };

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  return (
    <>
      <div className={styles.header}>
        <div>
          <div className={styles.title}>입고대기</div>
          <div className={styles.subtitle}>노예김승일 입고대기설정이 참조하는 상품코드 목록</div>
        </div>
        <span className={styles.pill}>{total.toLocaleString()}행</span>
      </div>

      <div className={styles.controls}>
        <form onSubmit={handleSearch} style={{ display: "flex", gap: "0.5rem" }}>
          <input
            className={styles.searchInput}
            value={inputQuery}
            onChange={(e) => setInputQuery(e.target.value)}
            placeholder="상품코드 검색"
          />
          <button className={`${styles.btn} ${styles.btnPrimary}`} type="submit" disabled={loading}>
            검색
          </button>
        </form>
        <button className={`${styles.btn} ${styles.btnSecondary}`} onClick={() => fetchRows(query, offset)} disabled={loading}>
          <RefreshCw size={13} />새로고침
        </button>
        <button className={`${styles.btn} ${styles.btnSecondary}`} onClick={handleDownload} disabled={loading}>
          <Download size={13} />xls 내보내기
        </button>
        <button className={`${styles.btn} ${styles.btnSecondary}`} onClick={handleSyncFromWonbe} disabled={loading}>
          <RotateCcw size={13} />최신업데이트
        </button>
      </div>

      <div className={styles.controls}>
        <textarea
          value={appendText}
          onChange={(e) => setAppendText(e.target.value)}
          placeholder="추가할 상품코드를 한 줄에 하나씩 붙여넣으세요"
          rows={3}
          style={{ flex: 1, minWidth: "240px", fontFamily: "inherit", fontSize: "0.82rem", padding: "6px 8px" }}
        />
        <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={handleAppend} disabled={appending || !appendText.trim()}>
          <PlusCircle size={13} />{appending ? "추가 중..." : "추가"}
        </button>
      </div>

      {message && <div className={styles.message}>{message}</div>}

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>상품코드</th>
              <th>입고수량</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row["상품코드"]}>
                <td>{row["상품코드"]}</td>
                <td>{row["입고수량"]}</td>
                <td>
                  <button
                    className={`${styles.btn} ${styles.btnSecondary}`}
                    onClick={() => handleDelete(row["상품코드"])}
                    title="삭제"
                  >
                    <Trash2 size={12} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && !loading && <div className={styles.empty}>조회된 데이터가 없습니다.</div>}
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
