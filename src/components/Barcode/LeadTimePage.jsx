import { useCallback, useEffect, useMemo, useState } from "react";
import { useEzadminSession } from "../../lib/EzadminSessionContext";
import pageStyles from "./BarcodePage.module.css";
import styles from "./LeadTimePage.module.css";
import { LOCAL_API_BASE as API, getAuthHeaders, handleUnauthorized } from "../../lib/api";

const DEFAULT_RATE = 2; // 1인 1분 처리 개수
const DAY_END_MIN = 22 * 60;
const DEFAULT_SHOW_UNTIL = 15 * 60; // 시간대별 인원은 기본 15:00까지만 보여주고 나머지는 추가해서 쓴다
const PACK_TABS = [
  { key: "bulk", label: "대량" },
  { key: "single", label: "개별" },
  { key: "unchecked", label: "미검수" },
];
const SHIP_TABS = [
  { key: "bulk", label: "대량" },
  { key: "single", label: "개별" },
  { key: "combo", label: "합포" },
];
const INVOICE_TABS = [
  { key: "main", label: "본송장" },
  { key: "stock", label: "재고송장" },
];

function todayStr() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function toMin(slot) {
  const [h, m] = slot.split(":").map(Number);
  return h * 60 + m;
}

function fmtMin(min) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(Math.floor(min / 60))}:${pad(Math.round(min % 60))}`;
}

function fmtDuration(min) {
  const total = Math.max(0, Math.round(min));
  const h = Math.floor(total / 60);
  return h > 0 ? `${h}시간 ${total % 60}분` : `${total}분`;
}

// startMin부터 시간대별 인원으로 qty개를 처리했을 때 끝나는 시각(분)을 구한다. 인원 0명 구간은 건너뛴다.
function runQueue(qty, startMin, slots, rate) {
  if (qty <= 0) return { endMin: startMin, left: 0 };
  let remaining = qty;
  for (const s of slots) {
    const slotStart = toMin(s.slot);
    const slotEnd = slotStart + 30;
    const from = Math.max(startMin, slotStart);
    if (from >= slotEnd || s.calc <= 0) continue;
    const perMin = s.calc * rate;
    const capacity = perMin * (slotEnd - from);
    if (capacity >= remaining) return { endMin: from + remaining / perMin, left: 0 };
    remaining -= capacity;
  }
  return { endMin: null, left: Math.ceil(remaining) };
}

export default function LeadTimePage({ headerExtra = null }) {
  const [date, setDate] = useState(todayStr());
  const [rate, setRate] = useState(DEFAULT_RATE);
  const [slots, setSlots] = useState([]);
  const [draft, setDraft] = useState({}); // 입력 중인 인원 (slot -> 문자열)
  const [pack, setPack] = useState(null);
  const [ship, setShip] = useState(null);
  const [suppliers, setSuppliers] = useState([]);
  const [newSupplier, setNewSupplier] = useState("");
  const [phase, setPhase] = useState("pack");
  const [packTab, setPackTab] = useState("bulk");
  const [shipTab, setShipTab] = useState("bulk");
  const [invoiceTab, setInvoiceTab] = useState("main");
  const [showUntil, setShowUntil] = useState(DEFAULT_SHOW_UNTIL);
  const [showAssign, setShowAssign] = useState(false);
  const [showPackAssign, setShowPackAssign] = useState(false);
  const [packVouchers, setPackVouchers] = useState([]); // 조회한 입고요청 전표
  const [bulkSheets, setBulkSheets] = useState([]); // 대량으로 지정한 전표(sheet)
  const [checkSheets, setCheckSheets] = useState([]); // 미검수 확인할 전표(sheet)
  const [numbers, setNumbers] = useState([]); // 조회한 출력차수 목록
  const [assign, setAssign] = useState({}); // print_num -> "main" | "stock" (미지정은 없음)
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const { openModal: openEzadminModal } = useEzadminSession();

  const request = useCallback(async (path, options = {}) => {
    const res = await fetch(`${API}/lead-time${path}`, {
      ...options,
      headers: { "Content-Type": "application/json", ...getAuthHeaders() },
    });
    if (handleUnauthorized(res)) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.detail || "요청 실패");
    return data;
  }, []);

  const loadAll = useCallback(async () => {
    setMessage("");
    try {
      const [hc, snap, sup] = await Promise.all([
        request(`/headcount?date=${date}`),
        request(`/snapshot?date=${date}`),
        request("/suppliers"),
      ]);
      if (hc) { setSlots(hc.slots); setDraft({}); setShowUntil(DEFAULT_SHOW_UNTIL); }
      if (snap) { setPack(snap.pack); setShip(snap.ship); }
      if (sup) setSuppliers(sup.suppliers);
    } catch (err) {
      setMessage(err.message || "조회 실패");
    }
  }, [request, date]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const saveHeadcount = async (slot, raw) => {
    const value = raw.trim() === "" ? null : Number(raw);
    if (value !== null && (!Number.isInteger(value) || value < 0)) { setMessage("인원은 0 이상의 정수로 입력해 주세요."); return; }
    try {
      const data = await request("/headcount", { method: "PUT", body: JSON.stringify({ date, slots: { [slot]: value } }) });
      if (data) { setSlots(data.slots); setDraft((d) => { const { [slot]: _drop, ...rest } = d; return rest; }); }
    } catch (err) {
      setMessage(err.message || "인원 저장 실패");
    }
  };

  const runLoad = useCallback(async (kind) => {
    setBusy(kind);
    setMessage(kind === "ship" ? "출력차수 주문을 조회하는 중입니다. 건수가 많으면 몇 분 걸릴 수 있습니다." : "입고요청 전표를 조회하는 중입니다. 전표가 많으면 몇 분 걸릴 수 있습니다.");
    try {
      const data = await request(`/${kind}/load`, { method: "POST", body: JSON.stringify({ date }) });
      if (!data) return;
      if (data.need_session) {
        openEzadminModal(() => runLoad(kind));
        return;
      }
      if (kind === "pack") setPack(data.pack); else setShip(data.ship);
      setMessage("");
    } catch (err) {
      setMessage(err.message || "조회 실패");
    } finally {
      setBusy("");
    }
  }, [request, date, openEzadminModal]);

  const loadNumbers = useCallback(async () => {
    setBusy("numbers");
    setMessage("");
    try {
      const data = await request(`/ship/numbers?date=${date}`);
      if (!data) return;
      if (data.need_session) {
        openEzadminModal(loadNumbers);
        return;
      }
      setNumbers(data.numbers || []);
      setAssign(data.assigned || {});
      if (!data.numbers?.length) setMessage(`${date} 출력차수가 없습니다.`);
    } catch (err) {
      setMessage(err.message || "출력차수 조회 실패");
    } finally {
      setBusy("");
    }
  }, [request, date, openEzadminModal]);

  const loadPackVouchers = useCallback(async () => {
    setBusy("vouchers");
    setMessage("");
    try {
      const data = await request(`/pack/vouchers?date=${date}`);
      if (!data) return;
      if (data.need_session) {
        openEzadminModal(loadPackVouchers);
        return;
      }
      setPackVouchers(data.vouchers || []);
      setBulkSheets(data.bulk || []);
      setCheckSheets(data.check || []);
      if (!data.vouchers?.length) setMessage(`${date} 입고요청 전표가 없습니다.`);
    } catch (err) {
      setMessage(err.message || "입고요청 전표 조회 실패");
    } finally {
      setBusy("");
    }
  }, [request, date, openEzadminModal]);

  const savePackAssign = async () => {
    try {
      const data = await request("/pack/assign", { method: "PUT", body: JSON.stringify({ date, bulk: bulkSheets, check: checkSheets }) });
      if (data) { setBulkSheets(data.bulk); setCheckSheets(data.check); setMessage("전표 지정을 저장했습니다. '입고요청 불러오기'를 누르면 반영됩니다."); }
    } catch (err) {
      setMessage(err.message || "지정 저장 실패");
    }
  };

  const saveAssign = async () => {
    const pick = (kind) => Object.keys(assign).filter((n) => assign[n] === kind);
    try {
      const data = await request("/ship/assign", { method: "PUT", body: JSON.stringify({ date, main: pick("main"), stock: pick("stock") }) });
      if (data) { setAssign(data.assigned); setMessage("출력차수 지정을 저장했습니다. '출력차수 불러오기'를 누르면 반영됩니다."); }
    } catch (err) {
      setMessage(err.message || "지정 저장 실패");
    }
  };

  const setKind = (num, kind) => setAssign((prev) => {
    const next = { ...prev };
    if (kind) next[num] = kind; else delete next[num];
    return next;
  });

  const changeSuppliers = async (path, options) => {
    try {
      const data = await request(path, options);
      if (data) setSuppliers(data.suppliers);
    } catch (err) {
      setMessage(err.message || "거래처 저장 실패");
    }
  };

  // 기본 15:00까지, 그 뒤 시간은 추가한 만큼 + 인원을 직접 넣어 둔 시간대까지 보여준다.
  const lastManualMin = slots.reduce((max, s) => (s.manual != null ? Math.max(max, toMin(s.slot)) : max), 0);
  const visibleSlots = slots.filter((s) => toMin(s.slot) <= Math.max(showUntil, lastManualMin));
  const canAddSlot = visibleSlots.length < slots.length;

  const packQty = (pack?.bulk?.qty || 0) + (pack?.single?.qty || 0);
  const shipPieces = useMemo(() => {
    if (!ship) return 0;
    return INVOICE_TABS.reduce(
      (sum, inv) => sum + SHIP_TABS.reduce((s, t) => s + (ship.totals?.[inv.key]?.[t.key]?.pieces || 0), 0),
      0,
    );
  }, [ship]);

  const estimate = useMemo(() => {
    if (!slots.length) return null;
    const now = new Date();
    const isToday = date === todayStr();
    const startMin = isToday ? Math.max(toMin(slots[0].slot), now.getHours() * 60 + now.getMinutes()) : toMin(slots[0].slot);
    const packRes = runQueue(packQty, startMin, slots, rate);
    const shipStart = packRes.endMin ?? DAY_END_MIN;
    const shipRes = packRes.endMin == null ? { endMin: null, left: shipPieces } : runQueue(shipPieces, shipStart, slots, rate);
    return { startMin, packRes, shipRes };
  }, [slots, packQty, shipPieces, rate, date]);

  const renderEnd = (res, qty) => {
    if (qty <= 0) return "-";
    if (res.endMin == null) return `근무시간 내 처리 불가 (남는 수량 약 ${res.left.toLocaleString()}개)`;
    return `${fmtMin(res.endMin)} 종료 예상`;
  };

  return (
    <div className={pageStyles.page}>
      <div className={pageStyles.pageHeader}>
        <div>
          <h2 className={pageStyles.title}>리드타임</h2>
          <p className={pageStyles.subtitle}>입고요청·출력차수 수량과 시간대별 근무 인원으로 포장 → 출고 종료 시각 예상</p>
        </div>
        {headerExtra}
      </div>

      <div className={pageStyles.stack}>
        <section className={pageStyles.card}>
          <div className={pageStyles.cardHeader}>
            <h3 className={pageStyles.cardTitle}>예상 종료</h3>
            <div className={styles.controls}>
              <input type="date" className={styles.input} value={date} onChange={(e) => setDate(e.target.value)} />
              <label className={styles.rateLabel}>
                1인 1분
                <input
                  type="number" min="1" className={`${styles.input} ${styles.rateInput}`} value={rate}
                  onChange={(e) => setRate(Math.max(Number(e.target.value) || DEFAULT_RATE, 0.1))}
                />
                개
              </label>
            </div>
          </div>
          <div className={styles.summary}>
            <div className={styles.summaryCell}>
              <span className={styles.summaryLabel}>포장 {packQty.toLocaleString()}개</span>
              <b>{estimate ? renderEnd(estimate.packRes, packQty) : "-"}</b>
              {estimate && estimate.packRes.endMin != null && packQty > 0 && (
                <span className={styles.muted}>소요 {fmtDuration(estimate.packRes.endMin - estimate.startMin)}</span>
              )}
            </div>
            <div className={styles.summaryCell}>
              <span className={styles.summaryLabel}>출고 {shipPieces.toLocaleString()}개 (포장 후 이어서)</span>
              <b>{estimate ? renderEnd(estimate.shipRes, shipPieces) : "-"}</b>
              {estimate && estimate.shipRes.endMin != null && shipPieces > 0 && (
                <span className={styles.muted}>전체 소요 {fmtDuration(estimate.shipRes.endMin - estimate.startMin)}</span>
              )}
            </div>
          </div>
          {message && <div className={pageStyles.statusMsg}>{message}</div>}
        </section>

        <section className={pageStyles.card}>
          <div className={pageStyles.cardHeader}>
            <h3 className={pageStyles.cardTitle}>시간대별 근무 인원</h3>
            <span className={styles.muted}>스케줄관리 예정 인원 · 칸을 수정하면 이 날짜에 저장 (비우면 예정 인원으로 복귀)</span>
          </div>
          <div className={styles.slotGrid}>
            {visibleSlots.map((s) => (
              <label key={s.slot} className={`${styles.slot} ${s.manual != null ? styles.slotManual : ""}`}>
                <span className={styles.slotTime}>{s.slot}</span>
                <span className={styles.slotInput}>
                  <input
                    type="number" min="0" className={styles.slotNumber}
                    value={draft[s.slot] ?? String(s.headcount)}
                    onChange={(e) => setDraft((d) => ({ ...d, [s.slot]: e.target.value }))}
                    onBlur={(e) => { if (draft[s.slot] !== undefined) saveHeadcount(s.slot, e.target.value); }}
                  />
                  명
                </span>
                {s.manual != null && <span className={styles.slotNote}>예정 {s.scheduled}명</span>}
              </label>
            ))}
            {canAddSlot && (
              <button
                type="button"
                className={`${pageStyles.secondaryBtn} ${styles.slotAdd}`}
                onClick={() => setShowUntil(Math.max(showUntil, lastManualMin) + 30)}
              >
                + 시간대 추가
              </button>
            )}
          </div>
        </section>

        <section className={pageStyles.card}>
          <div className={pageStyles.cardHeader}>
            <div className={pageStyles.tabRow}>
              <button className={`${pageStyles.tabBtn} ${phase === "pack" ? pageStyles.tabActive : ""}`} onClick={() => setPhase("pack")}>포장</button>
              <button className={`${pageStyles.tabBtn} ${phase === "ship" ? pageStyles.tabActive : ""}`} onClick={() => setPhase("ship")}>출고</button>
            </div>
            <button
              className={pageStyles.secondaryBtn}
              onClick={() => runLoad(phase)}
              disabled={Boolean(busy)}
            >
              {busy ? "조회 중..." : phase === "pack" ? "입고요청 불러오기" : "출력차수 불러오기"}
            </button>
          </div>

          {phase === "pack" && (
            <>
              <div className={styles.addRow}>
                <button
                  className={pageStyles.secondaryBtn}
                  onClick={() => { setShowPackAssign((v) => !v); if (!packVouchers.length) loadPackVouchers(); }}
                  disabled={busy === "vouchers"}
                >
                  {busy === "vouchers" ? "조회 중..." : showPackAssign ? "대량 전표 지정 닫기" : "대량 전표 지정"}
                </button>
                <span className={styles.muted}>지정 안 한 전표는 개별로 계산합니다.</span>
              </div>
              {showPackAssign && (
                <div className={styles.uncheckedBox}>
                  <p className={styles.muted}>대량으로 처리할 전표는 '대량', 미검수 거래처 상품이 들어 있을 수 있는 전표는 '미검수 확인'을 체크하고 저장하세요. 미검수 확인을 한 전표만 세부목록을 조회합니다.</p>
                  <ul className={styles.list}>
                    {packVouchers.map((v) => (
                      <li key={v.sheet} className={styles.listRow}>
                        <label>
                          <input
                            type="checkbox"
                            checked={bulkSheets.includes(v.sheet)}
                            onChange={() => setBulkSheets((prev) => (prev.includes(v.sheet) ? prev.filter((s) => s !== v.sheet) : [...prev, v.sheet]))}
                          />{" "}
                          대량
                        </label>
                        <label>
                          <input
                            type="checkbox"
                            checked={checkSheets.includes(v.sheet)}
                            onChange={() => setCheckSheets((prev) => (prev.includes(v.sheet) ? prev.filter((s) => s !== v.sheet) : [...prev, v.sheet]))}
                          />{" "}
                          미검수 확인
                        </label>
                        <span style={{ flex: 1 }}>{v.name}</span>
                        <span>{v.qty.toLocaleString()}개</span>
                      </li>
                    ))}
                  </ul>
                  <div className={styles.addRow}>
                    <button className={pageStyles.primaryBtn} onClick={savePackAssign} disabled={!packVouchers.length}>지정 저장</button>
                  </div>
                </div>
              )}
              <div className={pageStyles.tabRow}>
                {PACK_TABS.map((t) => (
                  <button key={t.key} className={`${pageStyles.tabBtn} ${packTab === t.key ? pageStyles.tabActive : ""}`} onClick={() => setPackTab(t.key)}>
                    {t.label} {(pack?.[t.key]?.qty || 0).toLocaleString()}개
                  </button>
                ))}
              </div>
              {!pack && <div className={styles.muted}>입고요청을 불러오면 표시됩니다.</div>}
              {pack && packTab !== "unchecked" && (
                <ul className={styles.list}>
                  {pack[packTab].vouchers.length === 0 && <li className={styles.muted}>해당 전표가 없습니다.</li>}
                  {pack[packTab].vouchers.map((v) => (
                    <li key={v.sheet} className={styles.listRow}>
                      <span>{v.name}</span>
                      <span>
                        {Math.max(v.total - v.unchecked, 0).toLocaleString()}개
                        {v.unchecked > 0 && <span className={styles.muted}> (미검수 {v.unchecked.toLocaleString()}개 제외)</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {pack && packTab === "unchecked" && (
                <div className={styles.uncheckedBox}>
                  <p className={styles.muted}>미검수 거래처 상품은 검수·포장을 하지 않아 포장 수량에서 제외됩니다. (시간 계산은 추후)</p>
                  <ul className={styles.list}>
                    {suppliers.map((name) => (
                      <li key={name} className={styles.listRow}>
                        <span>{name}</span>
                        <span>
                          {(pack.unchecked.by_supplier?.[name] || 0).toLocaleString()}개
                          <button
                            className={styles.removeBtn}
                            onClick={() => changeSuppliers(`/suppliers?name=${encodeURIComponent(name)}`, { method: "DELETE" })}
                          >삭제</button>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {phase === "pack" && packTab === "unchecked" && (
                <form
                  className={styles.addRow}
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!newSupplier.trim()) return;
                    changeSuppliers("/suppliers", { method: "POST", body: JSON.stringify({ name: newSupplier }) });
                    setNewSupplier("");
                  }}
                >
                  <input className={styles.input} placeholder="미검수 거래처 이름" value={newSupplier} onChange={(e) => setNewSupplier(e.target.value)} />
                  <button type="submit" className={pageStyles.secondaryBtn}>거래처 추가</button>
                  <span className={styles.muted}>추가한 거래처는 다음 입고요청 불러오기부터 반영됩니다.</span>
                </form>
              )}
            </>
          )}

          {phase === "ship" && (
            <>
              <div className={styles.addRow}>
                <button
                  className={pageStyles.secondaryBtn}
                  onClick={() => { setShowAssign((v) => !v); if (!numbers.length) loadNumbers(); }}
                  disabled={busy === "numbers"}
                >
                  {busy === "numbers" ? "조회 중..." : showAssign ? "출력차수 지정 닫기" : "출력차수 지정 (본송장/재고송장)"}
                </button>
                <span className={styles.muted}>
                  지정됨: 본송장 {Object.values(assign).filter((k) => k === "main").length}개 · 재고송장 {Object.values(assign).filter((k) => k === "stock").length}개 차수
                </span>
              </div>
              {showAssign && (
                <div className={styles.uncheckedBox}>
                  <p className={styles.muted}>차수마다 본송장/재고송장을 고르고 저장하세요. 여러 차수를 지정할 수 있고, 지정한 차수만 불러옵니다.</p>
                  <ul className={styles.list}>
                    {numbers.map((n) => (
                      <li key={n.print_num} className={styles.listRow}>
                        <span>{n.print_num}차 {n.time && `(${n.time})`} · {n.count.toLocaleString()}건</span>
                        <select className={styles.input} value={assign[n.print_num] || ""} onChange={(e) => setKind(n.print_num, e.target.value)}>
                          <option value="">미지정</option>
                          <option value="main">본송장</option>
                          <option value="stock">재고송장</option>
                        </select>
                      </li>
                    ))}
                  </ul>
                  <div className={styles.addRow}>
                    <button className={pageStyles.primaryBtn} onClick={saveAssign} disabled={!numbers.length}>지정 저장</button>
                  </div>
                </div>
              )}
              <div className={pageStyles.tabRow}>
                {INVOICE_TABS.map((t) => (
                  <button key={t.key} className={`${pageStyles.tabBtn} ${invoiceTab === t.key ? pageStyles.tabActive : ""}`} onClick={() => setInvoiceTab(t.key)}>
                    {t.label}
                  </button>
                ))}
              </div>
              <div className={pageStyles.tabRow}>
                {SHIP_TABS.map((t) => (
                  <button key={t.key} className={`${pageStyles.tabBtn} ${shipTab === t.key ? pageStyles.tabActive : ""}`} onClick={() => setShipTab(t.key)}>
                    {t.label} {(ship?.totals?.[invoiceTab]?.[t.key]?.pieces || 0).toLocaleString()}개
                  </button>
                ))}
              </div>
              {!ship && <div className={styles.muted}>출력차수를 불러오면 표시됩니다.</div>}
              {ship && (
                <>
                  <div className={styles.bigNumber}>
                    {(ship.totals?.[invoiceTab]?.[shipTab]?.pieces || 0).toLocaleString()}개
                    <span className={styles.muted}> · 주문 {(ship.totals?.[invoiceTab]?.[shipTab]?.orders || 0).toLocaleString()}건</span>
                  </div>
                  <ul className={styles.list}>
                    {ship.per_number.filter((n) => n.kind === invoiceTab).map((n) => (
                      <li key={n.print_num} className={styles.listRow}>
                        <span>{n.print_num}차</span>
                        <span>{(n[shipTab]?.pieces || 0).toLocaleString()}개</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
