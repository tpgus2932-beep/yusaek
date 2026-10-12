import { useCallback, useEffect, useState } from "react";
import { useEzadminSession } from "../../lib/EzadminSessionContext";
import pageStyles from "./BarcodePage.module.css";
import { LOCAL_API_BASE as API, getAuthHeaders, handleUnauthorized } from "../../lib/api";

function todayStr() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fmtTime(iso) {
  return iso ? iso.slice(11, 19) : "-";
}

function fmtDuration(startIso, endIso) {
  if (!startIso || !endIso) return "-";
  const sec = Math.round((new Date(endIso) - new Date(startIso)) / 1000);
  if (!Number.isFinite(sec) || sec < 0) return "-";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}시간 ${m}분` : `${m}분`;
}

function fmtRate(sec) {
  return sec == null ? "기록 없음" : `${sec.toFixed(1)}초/건`;
}

// 단계 버튼: 앞 단계가 기록돼 있고 자기 단계는 비어 있을 때만 활성화된다.
const STEPS = [
  { event: "pack_start", label: "포장시작(대량)", column: "bulk_start", prev: null },
  { event: "bulk_end", label: "대량종료", column: "bulk_end", prev: "bulk_start" },
  { event: "single_start", label: "개별시작", column: "single_start", prev: "bulk_end" },
  { event: "single_end", label: "개별종료", column: "single_end", prev: "single_start" },
];

export default function ShippingEtaPage({ headerExtra = null }) {
  const [date, setDate] = useState(todayStr());
  const [numbers, setNumbers] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [counts, setCounts] = useState(null);
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const { openModal: openEzadminModal } = useEzadminSession();

  const request = useCallback(async (path, options = {}) => {
    const res = await fetch(`${API}/shipping-eta${path}`, {
      ...options,
      headers: { "Content-Type": "application/json", ...getAuthHeaders() },
    });
    if (handleUnauthorized(res)) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.detail || "요청 실패");
    return data;
  }, []);

  const loadState = useCallback(async () => {
    try {
      const data = await request(`/state?date=${date}`);
      if (data) setState(data);
    } catch (err) {
      setMessage(err.message || "기록 조회 실패");
    }
  }, [request, date]);

  useEffect(() => {
    setCounts(null);
    loadState();
  }, [loadState]);

  const handleLoadNumbers = useCallback(async () => {
    setBusy(true);
    setMessage("");
    try {
      const data = await request(`/number-list?date=${date}`);
      if (!data) return;
      if (data.need_session) {
        openEzadminModal(handleLoadNumbers);
        return;
      }
      setNumbers(data.numbers || []);
      setSelected(new Set());
      if (!data.numbers?.length) setMessage(`${date} 출력차수가 없습니다.`);
    } catch (err) {
      setMessage(err.message || "출력차수 조회 실패");
    } finally {
      setBusy(false);
    }
  }, [request, date, openEzadminModal]);

  const handleClassify = useCallback(async () => {
    if (selected.size === 0) { setMessage("불러올 출력차수를 선택해 주세요."); return; }
    setBusy(true);
    setMessage("");
    try {
      const data = await request("/classify", {
        method: "POST",
        body: JSON.stringify({ date, print_nums: [...selected] }),
      });
      if (!data) return;
      if (data.need_session) {
        openEzadminModal(handleClassify);
        return;
      }
      setCounts(data.totals);
      setState({ log: data.log, estimate: data.estimate });
    } catch (err) {
      setMessage(err.message || "분류 실패");
    } finally {
      setBusy(false);
    }
  }, [request, date, selected, openEzadminModal]);

  const handleEvent = useCallback(async (event) => {
    setMessage("");
    try {
      const data = await request("/event", { method: "POST", body: JSON.stringify({ date, event }) });
      if (data) setState(data);
    } catch (err) {
      setMessage(err.message || "기록 실패");
    }
  }, [request, date]);

  const toggleNumber = (num) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(num)) next.delete(num); else next.add(num);
      return next;
    });
  };

  const log = state?.log;
  const est = state?.estimate;
  const shown = counts || (log ? { bulk: log.bulk_count, single: log.single_count, combo: log.combo_count } : null);

  return (
    <div className={pageStyles.page}>
      <div className={pageStyles.pageHeader}>
        <div>
          <h2 className={pageStyles.title}>출고예상</h2>
          <p className={pageStyles.subtitle}>출력차수 불러오기 · 대량/개별 포장시간 기록 · 종료 예상시간</p>
        </div>
        {headerExtra}
      </div>

      <div className={pageStyles.stack}>
        <section className={pageStyles.card}>
          <div className={pageStyles.cardHeader}>
            <h3 className={pageStyles.cardTitle}>출력차수 불러오기</h3>
            <div className={pageStyles.headerActions}>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              <button className={pageStyles.secondaryBtn} onClick={handleLoadNumbers} disabled={busy}>
                {busy ? "불러오는 중..." : "차수 목록 불러오기"}
              </button>
              <button className={pageStyles.primaryBtn} onClick={handleClassify} disabled={busy || selected.size === 0}>
                선택 차수 분류 ({selected.size})
              </button>
            </div>
          </div>
          {message && <div className={pageStyles.statusMsg}>{message}</div>}
          {numbers.length > 0 && (
            <div className={pageStyles.tableWrap}>
              <table className={pageStyles.table}>
                <thead>
                  <tr><th>선택</th><th>차수</th><th>출력시각</th><th>건수</th></tr>
                </thead>
                <tbody>
                  {numbers.map((n) => (
                    <tr key={n.print_num}>
                      <td><input type="checkbox" checked={selected.has(n.print_num)} onChange={() => toggleNumber(n.print_num)} /></td>
                      <td>{n.print_num}차</td>
                      <td>{n.time || "-"}</td>
                      <td>{n.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className={pageStyles.card}>
          <div className={pageStyles.cardHeader}>
            <h3 className={pageStyles.cardTitle}>출고 건수</h3>
            <div className={pageStyles.headerActions}>
              <span className={pageStyles.pill}>대량 {shown?.bulk ?? 0}</span>
              <span className={pageStyles.pill}>개별 {shown?.single ?? 0}</span>
              <span className={pageStyles.pill}>합포 {shown?.combo ?? 0}</span>
            </div>
          </div>
        </section>

        <section className={pageStyles.card}>
          <div className={pageStyles.cardHeader}>
            <h3 className={pageStyles.cardTitle}>{date} 포장 기록</h3>
            <div className={pageStyles.headerActions}>
              {STEPS.map((step) => (
                <button
                  key={step.event}
                  className={pageStyles.secondaryBtn}
                  onClick={() => handleEvent(step.event)}
                  disabled={!log || Boolean(log[step.column]) || (step.prev && !log[step.prev])}
                >
                  {step.label}
                </button>
              ))}
              <button className={pageStyles.secondaryBtn} onClick={() => handleEvent("undo")} disabled={!log || !log.bulk_start}>
                마지막 기록 취소
              </button>
            </div>
          </div>
          {log && (
            <div className={pageStyles.tableWrap}>
              <table className={pageStyles.table}>
                <thead>
                  <tr><th>구분</th><th>시작</th><th>종료</th><th>소요</th><th>건수</th></tr>
                </thead>
                <tbody>
                  <tr>
                    <td>대량</td><td>{fmtTime(log.bulk_start)}</td><td>{fmtTime(log.bulk_end)}</td>
                    <td>{fmtDuration(log.bulk_start, log.bulk_end)}</td><td>{log.bulk_count}</td>
                  </tr>
                  <tr>
                    <td>개별(합포 포함)</td><td>{fmtTime(log.single_start)}</td><td>{fmtTime(log.single_end)}</td>
                    <td>{fmtDuration(log.single_start, log.single_end)}</td><td>{log.single_count + log.combo_count}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className={pageStyles.card}>
          <div className={pageStyles.cardHeader}>
            <h3 className={pageStyles.cardTitle}>종료 예상</h3>
            <div className={pageStyles.headerActions}>
              <span className={pageStyles.pill}>
                {est?.eta ? `예상 종료 ${fmtTime(est.eta)}` : "예상 불가"}
              </span>
            </div>
          </div>
          {est && (
            <p className={pageStyles.subtitle}>
              대량 {fmtRate(est.bulk_rate_sec)} (최근 {est.history_bulk_days}일 평균) · 개별 {fmtRate(est.single_rate_sec)} (최근 {est.history_single_days}일 평균)
              {est.bulk_end_est && ` · 대량 종료 예상 ${fmtTime(est.bulk_end_est)}`}
              {est.single_end_est && ` · 개별 종료 예상 ${fmtTime(est.single_end_est)}`}
              {!est.eta && " · 과거 기록이 없거나 건수를 아직 불러오지 않았습니다."}
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
