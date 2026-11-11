import { useCallback, useEffect, useState } from "react";
import pageStyles from "./BarcodePage.module.css";
import styles from "./StockCheckPage.module.css";
import { LOCAL_API_BASE as API, getAuthHeaders, handleUnauthorized } from "../../lib/api";

import usePersistentState from "../../lib/usePersistentState";
const TABS = [
  { key: "regress", label: "어제 일치 → 오늘 불일치" },
  { key: "ranking", label: "정상화 상품 순위" },
  { key: "zones", label: "구역별 정확도" },
  { key: "log", label: "정상화 이력 검색" },
  { key: "scan", label: "스캔 이력 검색" },
];
const STATUS_LABEL = { more: "많음", less: "적음", none: "없음" };
const RESULT_LABEL = { ok: "일치", more: "많음", less: "적음", none: "없음" };

const pct = (ok, total) => (total ? `${Math.round((ok / total) * 1000) / 10}%` : "-");
const thisMonth = () => new Date().toLocaleDateString("sv-SE").slice(0, 7);

async function getJson(path, params = {}) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== "" && v != null));
  const res = await fetch(`${API}/stock-check${path}${qs.toString() ? `?${qs}` : ""}`, { headers: getAuthHeaders() });
  if (handleUnauthorized(res)) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data?.detail || "조회 실패");
  return data;
}

// 재고체크 이력·분석: 일별로 저장된 조회 결과와 정상화 내역을 이용한다.
export default function StockCheckHistory({ onOpenLog }) {
  const [tab, setTab] = usePersistentState("stockCheckHistoryTab", "regress");
  const [month, setMonth] = useState(thisMonth);
  const [report, setReport] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [logRows, setLogRows] = useState(null);
  const [logLoading, setLogLoading] = useState(false);
  const [sq, setSq] = useState("");
  const [sStatus, setSStatus] = useState("");
  const [sFrom, setSFrom] = useState("");
  const [sTo, setSTo] = useState("");
  const [scanRows, setScanRows] = useState(null);
  const [scanLoading, setScanLoading] = useState(false);

  const loadReport = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await getJson("/history/report", { month });
      if (data) setReport(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [month]);

  useEffect(() => { loadReport(); }, [loadReport]);

  const searchLog = useCallback(async () => {
    setLogLoading(true);
    setError("");
    try {
      const data = await getJson("/history/normalize-log", { q: q.trim(), date_from: dateFrom, date_to: dateTo });
      if (data) setLogRows(data.rows);
    } catch (err) {
      setError(err.message);
    } finally {
      setLogLoading(false);
    }
  }, [q, dateFrom, dateTo]);

  useEffect(() => { if (tab === "log" && logRows === null) searchLog(); }, [tab, logRows, searchLog]);

  const searchScan = useCallback(async () => {
    setScanLoading(true);
    setError("");
    try {
      const data = await getJson("/history/scan-log", { q: sq.trim(), status: sStatus, date_from: sFrom, date_to: sTo });
      if (data) setScanRows(data.rows);
    } catch (err) {
      setError(err.message);
    } finally {
      setScanLoading(false);
    }
  }, [sq, sStatus, sFrom, sTo]);

  useEffect(() => { if (tab === "scan" && scanRows === null) searchScan(); }, [tab, scanRows, searchScan]);

  const sm = report?.summary;

  return (
    <section className={pageStyles.card}>
      <div className={pageStyles.cardHeader}>
        <h3 className={pageStyles.cardTitle}>재고체크 이력·분석</h3>
        <div className={pageStyles.headerActions}>
          <input type="month" className={pageStyles.searchInput} style={{ minWidth: 0 }} value={month} onChange={(e) => setMonth(e.target.value || thisMonth())} />
          <button className={pageStyles.secondaryBtn} onClick={loadReport} disabled={loading}>{loading ? "불러오는 중..." : "새로고침"}</button>
        </div>
      </div>

      {sm && (
        <div className={pageStyles.statusMsg}>
          <strong>{report.month} 정상화 {sm.entries}건</strong> · {sm.products}종 · 입고 {sm.in_count}건({sm.in_qty}개) / 출고 {sm.out_count}건({sm.out_qty}개) · 스캔보정 {sm.scan_fix_count || 0}건({sm.scan_fix_products || 0}종)
        </div>
      )}
      {error && <div className={pageStyles.statusMsg}><strong>{error}</strong></div>}

      <div className={pageStyles.tabRow} style={{ margin: "0.5rem 0" }}>
        {TABS.map((t) => (
          <button key={t.key} className={`${pageStyles.tabBtn} ${tab === t.key ? pageStyles.tabActive : ""}`} onClick={() => setTab(t.key)}>{t.label}</button>
        ))}
      </div>

      {tab === "regress" && report && (
        <>
          <p className={pageStyles.subtitle}>
            {report.prev_day
              ? `${report.prev_day}에는 일치였는데 ${report.latest_day}에는 차이가 난 상품입니다. "로그"로 그 사이 입출고 내역을 확인하세요.`
              : "비교할 이전 조회일이 없습니다. 조회를 하루 이상 쌓아야 나옵니다."}
          </p>
          {report.prev_day && (
            <table className={styles.table}>
              <thead><tr><th>구역</th><th>상품코드</th><th>상품명</th><th>옵션</th><th>재고</th><th>스캔</th><th>결과</th><th /></tr></thead>
              <tbody>
                {report.regress.length === 0 && <tr><td colSpan={8}>어제 일치했다가 틀어진 상품이 없습니다.</td></tr>}
                {report.regress.map((r) => (
                  <tr key={r.code} className={styles[`row_${r.status}`]}>
                    <td>{r.zone}</td><td>{r.code}</td><td>{r.name || "-"}</td><td>{r.option}</td>
                    <td>{r.system_qty}</td><td>{r.scan_qty}</td><td>{STATUS_LABEL[r.status] || r.status}</td>
                    <td><button className={styles.linkBtn} onClick={() => onOpenLog?.(r.code)}>로그</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      {tab === "ranking" && report && (
        <>
          <p className={pageStyles.subtitle}>최근 {report.ranking_days}일 동안 정상화를 많이 한 상품입니다. 같은 상품이 반복되면 반품 입고 누락·오출고 같은 원인을 의심해 보세요.</p>
          <table className={styles.table}>
            <thead><tr><th>#</th><th>구역</th><th>상품코드</th><th>상품명</th><th>옵션</th><th>정상화 횟수</th><th>입고</th><th>출고</th><th>마지막</th><th /></tr></thead>
            <tbody>
              {report.ranking.length === 0 && <tr><td colSpan={10}>정상화 기록이 없습니다.</td></tr>}
              {report.ranking.map((r, i) => (
                <tr key={r.code}>
                  <td>{i + 1}</td><td>{r.zone}</td><td>{r.code}</td><td>{r.name || "-"}</td><td>{r.option}</td>
                  <td><strong>{r.times}</strong></td><td>{r.in_qty}</td><td>{r.out_qty}</td><td>{(r.last || "").slice(0, 16)}</td>
                  <td><button className={styles.linkBtn} onClick={() => onOpenLog?.(r.code)}>로그</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {tab === "zones" && report && (
        <>
          <p className={pageStyles.subtitle}>{report.month} 구역별 정확도 = 조회된 상품 중 스캔과 재고가 일치한 비율입니다. (같은 날 여러 번 조회하면 마지막 결과 기준)</p>
          <table className={styles.table}>
            <thead><tr><th>구역</th><th>최근 조회일</th><th>최근 정확도</th><th>이번달 누적 정확도</th><th>조회일수</th><th>일별 추이</th></tr></thead>
            <tbody>
              {report.zones.length === 0 && <tr><td colSpan={6}>이 달에 저장된 조회 결과가 없습니다.</td></tr>}
              {report.zones.map((z) => (
                <tr key={z.zone}>
                  <td>{z.zone}</td><td>{z.last_day}</td>
                  <td>{pct(z.last_ok, z.last_total)} ({z.last_ok}/{z.last_total})</td>
                  <td><strong>{pct(z.ok, z.total)}</strong> ({z.ok}/{z.total})</td>
                  <td>{z.days.length}</td>
                  <td>{z.days.map((d) => `${d.day.slice(8)}일 ${pct(d.ok, d.total)}`).join(" · ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {tab === "log" && (
        <>
          <div className={pageStyles.uploadRow}>
            <input
              className={pageStyles.searchInput}
              placeholder="상품코드 / 상품명 / 구역 / 처리자 (공백으로 여러 단어)"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") searchLog(); }}
            />
            <input type="date" className={pageStyles.searchInput} style={{ minWidth: 0 }} value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
            <span>~</span>
            <input type="date" className={pageStyles.searchInput} style={{ minWidth: 0 }} value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
            <button className={pageStyles.primaryBtn} onClick={searchLog} disabled={logLoading}>{logLoading ? "검색 중..." : "검색"}</button>
          </div>
          <table className={styles.table}>
            <thead><tr><th>일시</th><th>처리자</th><th>구역</th><th>상품코드</th><th>상품명</th><th>옵션</th><th>구분</th><th>수량</th><th>스캔</th><th>처리 전 재고</th><th /></tr></thead>
            <tbody>
              {logRows && logRows.length === 0 && <tr><td colSpan={11}>검색 결과가 없습니다.</td></tr>}
              {(logRows || []).map((r, i) => (
                <tr key={`${r.ts}-${r.code}-${i}`}>
                  <td>{r.ts}</td><td>{r.username}</td><td>{r.zone}</td><td>{r.code}</td><td>{r.name || "-"}</td><td>{r.option}</td>
                  <td>{r.type === "in" ? "입고" : r.type === "out" ? "출고" : "스캔보정"}</td><td>{r.qty}</td><td>{r.scan_qty}</td><td>{r.system_qty}</td>
                  <td><button className={styles.linkBtn} onClick={() => onOpenLog?.(r.code)}>로그</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {tab === "scan" && (
        <>
          <p className={pageStyles.subtitle}>"조회"를 눌렀을 때 저장된 날짜별 스캔 내역입니다. 같은 날 여러 번 조회하면 마지막 조회 기준이고, 스캔 수량이 1개 이상인 상품만 나옵니다.</p>
          <div className={pageStyles.uploadRow}>
            <input
              className={pageStyles.searchInput}
              placeholder="상품코드 / 상품명 / 구역 / 처리자 (공백으로 여러 단어)"
              value={sq}
              onChange={(e) => setSq(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") searchScan(); }}
            />
            <select className={pageStyles.searchInput} style={{ minWidth: 0 }} value={sStatus} onChange={(e) => setSStatus(e.target.value)}>
              <option value="">결과 전체</option>
              {Object.entries(RESULT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <input type="date" className={pageStyles.searchInput} style={{ minWidth: 0 }} value={sFrom} onChange={(e) => setSFrom(e.target.value)} />
            <span>~</span>
            <input type="date" className={pageStyles.searchInput} style={{ minWidth: 0 }} value={sTo} onChange={(e) => setSTo(e.target.value)} />
            <button className={pageStyles.primaryBtn} onClick={searchScan} disabled={scanLoading}>{scanLoading ? "검색 중..." : "검색"}</button>
          </div>
          <table className={styles.table}>
            <thead><tr><th>조회일</th><th>처리자</th><th>구역</th><th>상품코드</th><th>상품명</th><th>옵션</th><th>스캔</th><th>재고</th><th>결과</th><th /></tr></thead>
            <tbody>
              {scanRows && scanRows.length === 0 && <tr><td colSpan={10}>검색 결과가 없습니다.</td></tr>}
              {(scanRows || []).map((r) => (
                <tr key={`${r.day}-${r.code}`} className={styles[`row_${r.status}`]}>
                  <td>{r.day}</td><td>{r.username}</td><td>{r.zone}</td><td>{r.code}</td><td>{r.name || "-"}</td><td>{r.option}</td>
                  <td>{r.scan_qty}</td><td>{r.system_qty}</td><td>{RESULT_LABEL[r.status] || r.status}</td>
                  <td><button className={styles.linkBtn} onClick={() => onOpenLog?.(r.code)}>로그</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
