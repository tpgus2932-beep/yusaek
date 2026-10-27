import { useCallback, useState } from "react";
import { useEzadminSession } from "../../lib/EzadminSessionContext";
import pageStyles from "./BarcodePage.module.css";
import styles from "./ShippingEtaPage.module.css";
import { LOCAL_API_BASE as API, getAuthHeaders, handleUnauthorized } from "../../lib/api";

const PER_PERSON_PER_MIN = 2; // 한 명당 1분에 처리하는 개수

const SECTIONS = [
  { key: "bulk", label: "대량 입고전표" },
  { key: "normal", label: "대량 제외 입고전표" },
];

function parseQty(value) {
  return Number(String(value ?? "").replace(/,/g, "").trim()) || 0;
}

function fmtClock(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtDuration(min) {
  const total = Math.max(0, Math.round(min));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h}시간 ${m}분` : `${m}분`;
}

// 출근/퇴근 기록(서버 KST, 시간대 없는 ISO)으로 시각별 근무 인원을 구한다. 서버 _headcount와 같은 기준.
function buildHeadcount(attendance) {
  const firstIn = new Map();
  (attendance?.checkin || []).forEach((r) => {
    const t = new Date(r.time).getTime();
    if (Number.isFinite(t) && (!firstIn.has(r.name) || t < firstIn.get(r.name))) firstIn.set(r.name, t);
  });
  const lastOut = new Map();
  (attendance?.checkout || []).forEach((r) => {
    const t = new Date(r.time).getTime();
    if (Number.isFinite(t) && (!lastOut.has(r.name) || t > lastOut.get(r.name))) lastOut.set(r.name, t);
  });
  const edges = [...firstIn.values(), ...lastOut.values()].sort((a, b) => a - b);
  const at = (ms) => {
    let n = 0;
    firstIn.forEach((tIn, name) => {
      if (tIn <= ms && !(lastOut.has(name) && lastOut.get(name) <= ms)) n += 1;
    });
    return n;
  };
  return { at, edges, hasCheckin: firstIn.size > 0 };
}

// 지금부터 인원 변동(출근/퇴근)을 반영해 qty개를 다 처리하는 시각을 계산한다.
function estimate(qty, nowMs, attendance) {
  const { at, edges, hasCheckin } = buildHeadcount(attendance);
  if (!hasCheckin) return { status: "noAttendance" };
  const points = [nowMs, ...edges.filter((t) => t > nowMs)];
  let remaining = qty;
  for (let i = 0; i < points.length; i += 1) {
    const heads = at(points[i]);
    const rate = heads * PER_PERSON_PER_MIN; // 개/분
    const nextMs = i + 1 < points.length ? points[i + 1] : Infinity;
    if (rate > 0) {
      const needMin = remaining / rate;
      if (points[i] + needMin * 60000 <= nextMs) {
        const endMs = points[i] + needMin * 60000;
        return { status: "done", endMs, leftMin: (endMs - nowMs) / 60000, heads: at(nowMs) };
      }
      remaining -= rate * ((nextMs - points[i]) / 60000);
    }
  }
  return { status: "short", remaining: Math.ceil(remaining), heads: at(nowMs) };
}

function Section({ label, date, attendance, nowMs }) {
  const { openModal: openEzadminModal } = useEzadminSession();
  const [vouchers, setVouchers] = useState([]); // 불러온 전체 전표
  const [selected, setSelected] = useState([]); // 선택한 sheet
  const [loading, setLoading] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [message, setMessage] = useState("");
  const [applied, setApplied] = useState([]); // 확정한 전표 목록

  const handleOpen = useCallback(async () => {
    setLoading(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/barcode/incoming/ezadmin-voucher-list?date=${date}`, { headers: getAuthHeaders() });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (data?.need_session) {
        openEzadminModal(handleOpen);
        return;
      }
      if (!res.ok || !data?.ok) throw new Error(data?.detail || data?.error || "입고전표 목록 조회 실패");
      if (!data.vouchers?.length) {
        setMessage(`${date} 입고전표가 없습니다.`);
        return;
      }
      setVouchers(data.vouchers);
      setSelected(data.vouchers.map((v) => String(v.sheet)));
      setShowModal(true);
    } catch (err) {
      setMessage(err.message || "입고전표 목록 조회 실패");
    } finally {
      setLoading(false);
    }
  }, [date, openEzadminModal]);

  const handleConfirm = () => {
    setApplied(vouchers.filter((v) => selected.includes(String(v.sheet))));
    setShowModal(false);
  };

  const totalQty = applied.reduce((sum, v) => sum + parseQty(v.cell?.req_qty), 0);
  const result = applied.length > 0 && totalQty > 0 ? estimate(totalQty, nowMs, attendance) : null;

  return (
    <div className={styles.cell}>
      <div className={styles.cellStatus}>
        <span className={styles.statusTag}>{label}</span>
        <span className={styles.elapsed}>{applied.length > 0 ? `${totalQty.toLocaleString()}개` : "-"}</span>
      </div>

      {result?.status === "done" && (
        <div className={styles.cellMeta}>
          예상 종료 <b>{fmtClock(result.endMs)}</b> · 남은 시간 {fmtDuration(result.leftMin)} · 현재 {result.heads}명
        </div>
      )}
      {result?.status === "short" && (
        <div className={styles.cellMeta}>
          퇴근 전까지 처리 불가 · 퇴근 후 남는 수량 약 {result.remaining.toLocaleString()}개
        </div>
      )}
      {result?.status === "noAttendance" && (
        <div className={styles.cellMeta}>출근 인원이 없어 계산할 수 없습니다. 아래 근무 인원에서 출근을 불러오세요.</div>
      )}
      {applied.length > 0 && totalQty === 0 && <div className={styles.cellMeta}>선택한 전표의 수량이 0개입니다.</div>}
      {applied.length === 0 && <div className={styles.cellMeta}>전표를 불러오면 종료 시각을 계산합니다.</div>}

      {applied.length > 0 && (
        <div className={styles.chipRow}>
          {applied.map((v) => (
            <span key={v.sheet} className={pageStyles.pill}>
              {v.cell?.sheet_name || v.cell?.title || v.cell?.supply_name || v.sheet} · {parseQty(v.cell?.req_qty).toLocaleString()}개
            </span>
          ))}
        </div>
      )}
      {message && <div className={pageStyles.statusMsg}>{message}</div>}

      <div className={styles.cellActions}>
        <button className={`${pageStyles.secondaryBtn} ${styles.cellBtn}`} onClick={handleOpen} disabled={loading}>
          {loading ? "조회 중..." : "입고전표 불러오기"}
        </button>
        {applied.length > 0 && (
          <button className={styles.linkBtn} onClick={() => setApplied([])}>초기화</button>
        )}
      </div>

      {showModal && (
        <div className={pageStyles.modalOverlay} onClick={() => setShowModal(false)}>
          <div className={pageStyles.modal} style={{ width: "min(480px, 92vw)" }} onClick={(e) => e.stopPropagation()}>
            <div className={pageStyles.modalHeader}>
              <span className={pageStyles.modalTitle}>{label} 선택 ({date})</span>
              <button type="button" className={pageStyles.secondaryBtn} onClick={() => setShowModal(false)}>닫기</button>
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontWeight: 600, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={selected.length === vouchers.length && vouchers.length > 0}
                onChange={(e) => setSelected(e.target.checked ? vouchers.map((v) => String(v.sheet)) : [])}
              />
              전체 선택 ({selected.length}/{vouchers.length})
            </label>
            <div
              style={{
                display: "flex", flexDirection: "column", gap: "0.1rem", maxHeight: 340, overflowY: "auto",
                border: "1px solid var(--border-color)", borderRadius: "var(--radius-sm)", padding: "0.25rem",
              }}
            >
              {vouchers.map((v) => {
                const sheet = String(v.sheet);
                const checked = selected.includes(sheet);
                const c = v.cell || {};
                const subInfo = [c.crdate, c.req_qty ? `${c.req_qty}개` : null].filter(Boolean).join(" · ");
                return (
                  <label
                    key={sheet}
                    style={{ display: "flex", alignItems: "center", gap: "0.5rem", padding: "0.35rem 0.6rem", borderRadius: "var(--radius-sm)", cursor: "pointer" }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => setSelected((prev) => (checked ? prev.filter((s) => s !== sheet) : [...prev, sheet]))}
                    />
                    <span style={{ fontFamily: "monospace", fontSize: "0.82rem", color: "var(--text-muted)", minWidth: "4.5rem", flexShrink: 0 }}>{sheet}</span>
                    <span style={{ fontSize: "0.9rem", flex: 1 }}>{c.sheet_name || c.title || c.supply_name || ""}</span>
                    {subInfo && <span style={{ fontSize: "0.8rem", color: "var(--text-muted)", flexShrink: 0 }}>{subInfo}</span>}
                  </label>
                );
              })}
            </div>
            <button type="button" className={pageStyles.primaryBtn} onClick={handleConfirm} disabled={!selected.length}>
              {selected.length}건 적용
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function LeadTimeCard({ date, attendance, nowMs }) {
  return (
    <section className={pageStyles.card}>
      <div className={pageStyles.cardHeader}>
        <h3 className={pageStyles.cardTitle}>리드타임체크</h3>
        <span className={styles.etaHint}>1인당 1분 {PER_PERSON_PER_MIN}개 · 출퇴근 인원 변동 반영</span>
      </div>
      <div className={styles.board} style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}>
        {SECTIONS.map(({ key, label }) => (
          <Section key={key} label={label} date={date} attendance={attendance} nowMs={nowMs} />
        ))}
      </div>
    </section>
  );
}
