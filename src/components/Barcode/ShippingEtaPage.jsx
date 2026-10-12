import { useCallback, useEffect, useState } from "react";
import { useEzadminSession } from "../../lib/EzadminSessionContext";
import pageStyles from "./BarcodePage.module.css";
import styles from "./ShippingEtaPage.module.css";
import { LOCAL_API_BASE as API, getAuthHeaders, handleUnauthorized } from "../../lib/api";

function todayStr() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fmtClock(iso) {
  return iso ? iso.slice(11, 16) : "-";
}

function fmtSpan(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "-";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

// 서버 시각(KST, 시간대 없는 ISO)끼리 비교한다. 브라우저 시간대에 영향받지 않도록 같은 방식으로 파싱.
function diffSec(fromIso, toIso) {
  return (new Date(toIso) - new Date(fromIso)) / 1000;
}

const KINDS = [
  { kind: "bulk", label: "대량" },
  { kind: "single", label: "개별" },
  { kind: "combo", label: "합배" },
];
const PHASES = [
  { phase: "pack", label: "포장" },
  { phase: "ship", label: "출고" },
];

export default function ShippingEtaPage({ headerExtra = null }) {
  const [date, setDate] = useState(todayStr());
  const [numbers, setNumbers] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [state, setState] = useState(null);
  const [serverOffset, setServerOffset] = useState(0); // 서버 시각 - 브라우저 시각 (초)
  const [tick, setTick] = useState(0);
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

  const applyState = useCallback((data) => {
    setState({ log: data.log, estimate: data.estimate });
    // 진행 중 경과시간을 서버 기준으로 맞추기 위해 서버-브라우저 시각 차이를 저장한다.
    setServerOffset((new Date(data.estimate.now) - new Date()) / 1000);
  }, []);

  const loadState = useCallback(async () => {
    try {
      const data = await request(`/state?date=${date}`);
      if (data) applyState(data);
    } catch (err) {
      setMessage(err.message || "기록 조회 실패");
    }
  }, [request, date, applyState]);

  useEffect(() => {
    loadState();
  }, [loadState]);

  const log = state?.log;
  const est = state?.estimate;
  const anyRunning = Boolean(
    log && KINDS.some(({ kind }) => PHASES.some(({ phase }) => log[`${kind}_${phase}_start`] && !log[`${kind}_${phase}_end`]))
  );

  useEffect(() => {
    if (!anyRunning) return undefined;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [anyRunning]);

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
    setMessage("선택한 차수의 주문을 조회하는 중입니다. 건수가 많으면 1~2분 걸릴 수 있습니다.");
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
      applyState(data);
      setMessage("");
    } catch (err) {
      setMessage(err.message || "분류 실패");
    } finally {
      setBusy(false);
    }
  }, [request, date, selected, openEzadminModal, applyState]);

  const handleEvent = useCallback(async (stage, action) => {
    setMessage("");
    try {
      const data = await request("/event", { method: "POST", body: JSON.stringify({ date, stage, action }) });
      if (data) applyState(data);
    } catch (err) {
      setMessage(err.message || "기록 실패");
    }
  }, [request, date, applyState]);

  const toggleNumber = (num) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(num)) next.delete(num); else next.add(num);
      return next;
    });
  };

  // 서버 기준 현재 시각 (tick으로 매초 갱신)
  const serverNowMs = Date.now() + serverOffset * 1000 + 0 * tick;

  const renderCell = ({ kind, label: kindLabel }, { phase, label: phaseLabel }) => {
    const key = `${kind}_${phase}`;
    const count = log?.[`${kind}_count`] ?? 0;
    const start = log?.[`${key}_start`] || "";
    const end = log?.[`${key}_end`] || "";
    const stage = est?.stages?.[key];
    const basisText = stage?.basis?.length
      ? `유사일 ${stage.basis.map((b) => `${b.date.slice(5).replace("-", "/")}(${b.count.toLocaleString()}건)`).join(" · ")}`
      : "";
    if (!log || count === 0) {
      return <div key={key} className={`${styles.cell} ${styles.cellOff}`}>해당 없음</div>;
    }
    if (end) {
      return (
        <div key={key} className={`${styles.cell} ${styles.cellDone}`}>
          <div className={styles.cellStatus}>
            <span className={styles.statusTag}>완료</span>
            <span className={styles.elapsed}>{fmtSpan(diffSec(start, end))}</span>
          </div>
          <div className={styles.cellActions}>
            <span className={styles.cellMeta}>
              {fmtClock(start)} → {fmtClock(end)} · 건당 {(diffSec(start, end) / count).toFixed(1)}초
            </span>
            <button className={styles.linkBtn} onClick={() => handleEvent(key, "undo")}>종료 취소</button>
          </div>
        </div>
      );
    }
    if (start) {
      const elapsed = (serverNowMs - new Date(start).getTime()) / 1000;
      return (
        <div key={key} className={`${styles.cell} ${styles.cellRunning}`}>
          <div className={styles.cellStatus}>
            <span className={`${styles.statusTag} ${styles.statusTagRunning}`}>진행 중 · {fmtClock(start)} 시작</span>
            <span className={styles.elapsed}>{fmtSpan(elapsed)}</span>
          </div>
          <div className={styles.cellMeta}>
            {stage?.end_est ? `예상 종료 ${fmtClock(stage.end_est)}` : "예상 불가 (과거 기록 없음)"}
            {basisText && <span className={styles.basis}>{basisText}</span>}
          </div>
          <div className={styles.cellActions}>
            <button className={`${pageStyles.primaryBtn} ${styles.cellBtn}`} onClick={() => handleEvent(key, "end")}>
              {phaseLabel} 종료
            </button>
            <button className={styles.linkBtn} onClick={() => handleEvent(key, "undo")}>시작 취소</button>
          </div>
        </div>
      );
    }
    return (
      <div key={key} className={styles.cell}>
        <div className={styles.cellStatus}>
          <span className={styles.statusTag}>대기</span>
          <span className={styles.endEst}>{stage?.end_est ? `종료 예상 ${fmtClock(stage.end_est)}` : "예상 불가"}</span>
        </div>
        <div className={styles.cellMeta}>
          {stage?.pred_sec != null ? `소요 예상 ${fmtSpan(stage.pred_sec)}` : "과거 기록 없음"}
          {basisText && <span className={styles.basis}>{basisText}</span>}
        </div>
        <div className={styles.cellActions}>
          <button className={`${pageStyles.secondaryBtn} ${styles.cellBtn}`} onClick={() => handleEvent(key, "start")}>
            {kindLabel} {phaseLabel} 시작
          </button>
        </div>
      </div>
    );
  };

  const counts = { bulk: log?.bulk_count ?? 0, single: log?.single_count ?? 0, combo: log?.combo_count ?? 0 };
  const noCounts = counts.bulk + counts.single + counts.combo === 0;

  return (
    <div className={pageStyles.page}>
      <div className={pageStyles.pageHeader}>
        <div>
          <h2 className={pageStyles.title}>출고예상</h2>
          <p className={pageStyles.subtitle}>출력차수 불러오기 · 대량/개별/합배 포장·출고 시간 기록 · 종료 예상</p>
        </div>
        {headerExtra}
      </div>

      <div className={pageStyles.stack}>
        <section className={pageStyles.card}>
          <div className={pageStyles.cardHeader}>
            <h3 className={pageStyles.cardTitle}>{date} 구간별 종료</h3>
            <div className={styles.countRow}>
              {KINDS.map(({ kind, label }) => (
                <span key={kind} className={pageStyles.pill}>{label} {counts[kind].toLocaleString()}건</span>
              ))}
            </div>
          </div>
          {noCounts ? (
            <span className={styles.etaHint}>출력차수를 불러와 분류하면 구간별 종료 시각이 표시됩니다.</span>
          ) : (
            <div className={styles.stageStrip}>
              {KINDS.flatMap((k) => PHASES.map((p) => {
                const key = `${k.kind}_${p.phase}`;
                const stage = est?.stages?.[key];
                const done = Boolean(log?.[`${key}_end`]);
                const running = Boolean(log?.[`${key}_start`]) && !done;
                if (counts[k.kind] === 0) return null;
                return (
                  <div key={key} className={`${styles.stageItem} ${done ? styles.stageDone : ""} ${running ? styles.stageRunning : ""}`}>
                    <span className={styles.stageName}>{k.label} {p.label}{done ? " 완료" : running ? " 진행" : ""}</span>
                    <span className={stage?.end_est ? styles.stageTime : styles.stageTimeMuted}>
                      {stage?.end_est ? fmtClock(stage.end_est) : "예상 불가"}
                    </span>
                  </div>
                );
              }))}
            </div>
          )}
        </section>

        <section className={pageStyles.card}>
          <div className={pageStyles.cardHeader}>
            <h3 className={pageStyles.cardTitle}>출력차수 불러오기</h3>
            <div className={pageStyles.headerActions}>
              <input className={pageStyles.dateInput} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              <button className={pageStyles.secondaryBtn} onClick={handleLoadNumbers} disabled={busy}>
                차수 목록 불러오기
              </button>
              <button className={pageStyles.primaryBtn} onClick={handleClassify} disabled={busy || selected.size === 0}>
                {busy ? "조회 중..." : `선택 차수 분류 (${selected.size})`}
              </button>
            </div>
          </div>
          {numbers.length > 0 && (
            <div className={styles.chipRow}>
              {numbers.map((n) => (
                <button
                  key={n.print_num}
                  className={`${styles.chip} ${selected.has(n.print_num) ? styles.chipOn : ""}`}
                  onClick={() => toggleNumber(n.print_num)}
                >
                  <span className={styles.chipName}>{n.print_num}차</span>
                  <span className={styles.chipMeta}>{n.time.slice(0, 5)} · {n.count.toLocaleString()}건</span>
                </button>
              ))}
            </div>
          )}
          {message && <div className={pageStyles.statusMsg}>{message}</div>}
        </section>

        <section className={pageStyles.card}>
          <div className={pageStyles.cardHeader}>
            <h3 className={pageStyles.cardTitle}>포장 · 출고 기록</h3>
          </div>
          <div className={styles.board}>
            <span className={styles.boardCorner} />
            {PHASES.map(({ phase, label }) => (
              <span key={phase} className={styles.boardHead}>{label}</span>
            ))}
            {KINDS.map((k) => (
              <KindRow key={k.kind} kind={k} count={counts[k.kind]} renderCell={renderCell} />
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function KindRow({ kind, count, renderCell }) {
  return (
    <>
      <div className={styles.rowHead}>
        <span className={styles.rowName}>{kind.label}</span>
        <span className={styles.rowCount}>{count.toLocaleString()}건</span>
      </div>
      {PHASES.map((phase) => renderCell(kind, phase))}
    </>
  );
}
