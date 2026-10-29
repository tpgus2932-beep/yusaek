import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEzadminSession } from "../../lib/EzadminSessionContext";
import pageStyles from "./BarcodePage.module.css";
import styles from "./LeadTimePage.module.css";
import { LOCAL_API_BASE as API, getAuthHeaders, handleUnauthorized } from "../../lib/api";

const DEFAULT_RATE = 2; // 1인 1분 처리 개수
const HEADCOUNT_KINDS = [["pack", "포장"]]; // 시간대별 근무 인원 입력 구분 (대량출고/개별출고 인원은 출고 박스에서 설정)
const DEFAULT_BREAK_MIN = 10; // 포장 종료 후 출고 시작까지 쉬는시간(분) 기본값
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
  const total = Math.round(min);
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

function fmtDuration(min) {
  const total = Math.max(0, Math.round(min));
  const h = Math.floor(total / 60);
  return h > 0 ? `${h}시간 ${total % 60}분` : `${total}분`;
}

// startMin부터 시간대별 인원으로 qty개를 처리했을 때 끝나는 시각(분)을 구한다. 인원 0명 구간은 건너뛴다.
// 마지막 슬롯까지 다 못 끝내면 마지막으로 일한 슬롯의 인원이 계속 일한다고 보고 이어서 계산한다(over: true).
// 근무 인원이 하나도 없으면 endMin이 null이다.
function runQueue(qty, startMin, slots, rate) {
  if (qty <= 0) return { endMin: startMin, over: false };
  let remaining = qty;
  let lastCalc = 0;
  let lastEnd = startMin;
  for (const s of slots) {
    const slotStart = toMin(s.slot);
    const slotEnd = slotStart + 30;
    if (s.calc > 0) { lastCalc = s.calc; lastEnd = slotEnd; }
    const from = Math.max(startMin, slotStart);
    if (from >= slotEnd || s.calc <= 0) continue;
    const perMin = s.calc * rate;
    const capacity = perMin * (slotEnd - from);
    if (capacity >= remaining) return { endMin: from + remaining / perMin, over: false };
    remaining -= capacity;
  }
  if (lastCalc <= 0) return { endMin: null, over: false };
  return { endMin: Math.max(startMin, lastEnd) + remaining / (lastCalc * rate), over: true };
}

// runQueue와 같되, joinMin 이후에는 helperSlots 인원(다른 작업을 마친 인원)이 같은 처리 속도로 함께 일한다.
function runQueueWithHelp(qty, startMin, slots, helperSlots, rate, joinMin) {
  if (qty <= 0) return { endMin: startMin, over: false };
  let remaining = qty;
  let lastCalc = 0;
  let lastHelp = 0;
  let lastEnd = startMin;
  for (let i = 0; i < slots.length; i += 1) {
    const slotStart = toMin(slots[i].slot);
    const slotEnd = slotStart + 30;
    const help = helperSlots[i]?.calc || 0;
    if (slots[i].calc > 0) lastCalc = slots[i].calc;
    if (help > 0) lastHelp = help;
    if (slots[i].calc > 0 || help > 0) lastEnd = slotEnd;
    const from = Math.max(startMin, slotStart);
    if (from >= slotEnd) continue;
    const splitAt = Math.min(Math.max(joinMin, from), slotEnd);
    for (const [a, b, heads] of [[from, splitAt, slots[i].calc], [splitAt, slotEnd, slots[i].calc + help]]) {
      if (b <= a || heads <= 0) continue;
      const perMin = heads * rate;
      const capacity = perMin * (b - a);
      if (capacity >= remaining) return { endMin: a + remaining / perMin, over: false };
      remaining -= capacity;
    }
  }
  const extStart = Math.max(startMin, lastEnd, joinMin);
  const heads = lastCalc + lastHelp;
  if (heads <= 0) return { endMin: null, over: false };
  return { endMin: extStart + remaining / (heads * rate), over: true };
}

export default function LeadTimePage({ headerExtra = null }) {
  const [date, setDate] = useState(todayStr());
  const [packRate, setPackRate] = useState(DEFAULT_RATE);
  const [shipBulkRate, setShipBulkRate] = useState(DEFAULT_RATE);
  const [shipSingleRate, setShipSingleRate] = useState(DEFAULT_RATE);
  const [joinBulk, setJoinBulk] = useState(false); // 개별출고가 먼저 끝나면 그 인원이 대량출고에 합류
  const [joinCount, setJoinCount] = useState(""); // 합류 인원 수 (빈칸이면 개별출고 인원 전부)
  const [starts, setStarts] = useState({ pack: "", ship: "" }); // 시작 시각 직접 지정 ("HH:MM"). 빈칸이면 자동(포장: 첫 근무 시간대, 출고: 포장 종료 + 쉬는시간)
  const [editingStart, setEditingStart] = useState(null); // 시작 시각을 누르면 "pack" | "ship" 수정칸으로 바뀐다
  const [shipBulkHead, setShipBulkHead] = useState(""); // 대량출고 인원 (빈칸이면 시간대별 근무 인원을 따름)
  const [shipSingleHead, setShipSingleHead] = useState(""); // 개별출고 인원 (빈칸이면 시간대별 근무 인원을 따름)
  const [packEdit, setPackEdit] = useState(null); // 포장 수량 직접 입력값 (null이면 불러온 수량)
  const [shipEdit, setShipEdit] = useState(null); // 출고 수량 직접 입력값 (null이면 불러온 수량)
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
      const [hc, snap, sup, st] = await Promise.all([
        request(`/headcount?date=${date}`),
        request(`/snapshot?date=${date}`),
        request("/suppliers"),
        request(`/settings?date=${date}`).catch(() => null), // 저장된 처리량/개수. 못 불러와도 나머지는 보여준다
      ]);
      if (hc) { setSlots(hc.slots); setDraft({}); setShowUntil(DEFAULT_SHOW_UNTIL); }
      if (snap) { setPack(snap.pack); setShip(snap.ship); }
      setPackEdit(st?.qty?.pack != null ? String(st.qty.pack) : null);
      setShipEdit(st?.qty?.ship != null ? String(st.qty.ship) : null);
      if (st?.rates?.pack > 0) setPackRate(st.rates.pack);
      // 예전에 출고 하나로 저장해 둔 값(ship)이 있으면 대량/개별의 처음 값으로 쓴다.
      const legacyShip = st?.rates?.ship > 0 ? st.rates.ship : null;
      const bulkRate = st?.rates?.ship_bulk > 0 ? st.rates.ship_bulk : legacyShip;
      const singleRate = st?.rates?.ship_single > 0 ? st.rates.ship_single : legacyShip;
      setJoinBulk(Boolean(st?.options?.join_bulk));
      setJoinCount(st?.options?.join_count != null ? String(st.options.join_count) : "");
      setStarts({ pack: st?.options?.pack_start || "", ship: st?.options?.ship_start || "" });
      setShipBulkHead(st?.options?.bulk_head != null ? String(st.options.bulk_head) : "");
      setShipSingleHead(st?.options?.single_head != null ? String(st.options.single_head) : "");
      if (bulkRate) setShipBulkRate(bulkRate);
      if (singleRate) setShipSingleRate(singleRate);
      if (sup) setSuppliers(sup.suppliers);
    } catch (err) {
      setMessage(err.message || "조회 실패");
    }
  }, [request, date]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  // 바꾸는 즉시 저장한다. 연속 입력은 잠깐 모아서(디바운스) 한 번에 보낸다.
  const headcountTimers = useRef({});
  const settingsPending = useRef({});
  const settingsTimer = useRef(null);

  const saveHeadcount = async (kind, slot, raw) => {
    const value = raw.trim() === "" ? null : Number(raw);
    if (value !== null && (!Number.isInteger(value) || value < 0)) { setMessage("인원은 0 이상의 정수로 입력해 주세요."); return; }
    const key = `${kind}:${slot}`;
    try {
      const data = await request("/headcount", { method: "PUT", body: JSON.stringify({ date, kind, slots: { [slot]: value } }) });
      if (data) {
        setSlots(data.slots);
        // 저장하는 사이 더 입력한 값이 있으면 그 입력은 남겨 둔다.
        setDraft((d) => { if (d[key] !== raw) return d; const { [key]: _drop, ...rest } = d; return rest; });
      }
    } catch (err) {
      setMessage(err.message || "인원 저장 실패");
    }
  };

  const changeHeadcount = (kind, slot, raw) => {
    const key = `${kind}:${slot}`;
    setDraft((d) => ({ ...d, [key]: raw }));
    clearTimeout(headcountTimers.current[key]);
    const n = Number(raw);
    // 비우는 것(예정 인원으로 복귀)은 입력 도중 값이 튀지 않게 칸을 벗어날 때 저장한다.
    if (raw.trim() !== "" && Number.isInteger(n) && n >= 0) {
      headcountTimers.current[key] = setTimeout(() => saveHeadcount(kind, slot, raw), 500);
    }
  };

  const blurHeadcount = (kind, slot, raw) => {
    const key = `${kind}:${slot}`;
    clearTimeout(headcountTimers.current[key]);
    if (draft[key] !== undefined) saveHeadcount(kind, slot, raw);
  };

  const flushSettings = useCallback(async () => {
    clearTimeout(settingsTimer.current);
    const body = settingsPending.current;
    settingsPending.current = {};
    if (!body.date) return;
    try {
      await request("/settings", { method: "PUT", body: JSON.stringify(body) });
    } catch (err) {
      setMessage(err.message || "설정 저장 실패");
    }
  }, [request]);

  // rates: 1인 1분 처리 개수(공통), qty: 직접 입력한 포장/출고 개수(날짜별)
  const persistSettings = useCallback((patch) => {
    if (settingsPending.current.date && settingsPending.current.date !== date) flushSettings();
    const cur = settingsPending.current;
    settingsPending.current = {
      date,
      rates: { ...cur.rates, ...patch.rates },
      qty: { ...cur.qty, ...patch.qty },
      options: { ...cur.options, ...patch.options },
    };
    clearTimeout(settingsTimer.current);
    settingsTimer.current = setTimeout(flushSettings, 500);
  }, [date, flushSettings]);

  const changeRate = (kind, raw) => {
    const n = Math.max(Number(raw) || DEFAULT_RATE, 0.1);
    ({ pack: setPackRate, ship_bulk: setShipBulkRate, ship_single: setShipSingleRate })[kind](n);
    persistSettings({ rates: { [kind]: n } });
  };

  const changeJoinBulk = (on) => {
    setJoinBulk(on);
    persistSettings({ options: { join_bulk: on } });
  };

  // 빈칸이면 null(해제), 0 이상의 정수면 그 값을 저장한다. 그 밖의 입력 도중 값은 저장하지 않는다.
  const persistCount = (option, raw) => {
    if (raw.trim() === "") persistSettings({ options: { [option]: null } });
    else if (Number.isInteger(Number(raw)) && Number(raw) >= 0) persistSettings({ options: { [option]: Number(raw) } });
  };

  const changeJoinCount = (raw) => {
    setJoinCount(raw);
    persistCount("join_count", raw);
  };

  // kind: "pack" | "ship". 빈 값이면 직접 지정을 해제하고 자동 시작으로 돌아간다.
  const changeStart = (kind, raw) => {
    setStarts((s) => ({ ...s, [kind]: raw }));
    persistSettings({ options: { [`${kind}_start`]: raw || null } });
  };

  const changeShipHead = (kind, raw) => {
    (kind === "ship_bulk" ? setShipBulkHead : setShipSingleHead)(raw);
    persistCount(kind === "ship_bulk" ? "bulk_head" : "single_head", raw);
  };

  const changeQty = (kind, raw) => {
    (kind === "pack" ? setPackEdit : setShipEdit)(raw);
    if (raw === null || raw.trim() === "") persistSettings({ qty: { [kind]: null } });
    else if (Number.isInteger(Number(raw)) && Number(raw) >= 0) persistSettings({ qty: { [kind]: Number(raw) } });
  };

  // 화면을 떠나거나 새로고침하기 직전에 아직 못 보낸 값을 보낸다.
  useEffect(() => () => { flushSettings(); }, [flushSettings]);

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
      // 새로 불러오면 직접 입력한 개수는 지우고 불러온 수량을 쓴다
      if (kind === "pack") setPackEdit(null); else setShipEdit(null);
      persistSettings({ qty: { [kind]: null } });
      setMessage("");
    } catch (err) {
      setMessage(err.message || "조회 실패");
    } finally {
      setBusy("");
    }
  }, [request, date, openEzadminModal, persistSettings]);

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
  const lastManualMin = slots.reduce((max, s) => (HEADCOUNT_KINDS.some(([kind]) => s[kind].manual != null) ? Math.max(max, toMin(s.slot)) : max), 0);
  const visibleSlots = slots.filter((s) => toMin(s.slot) <= Math.max(showUntil, lastManualMin));
  const canAddSlot = visibleSlots.length < slots.length;

  const loadedPackQty = (pack?.bulk?.qty || 0) + (pack?.single?.qty || 0);
  // 출고 대량 = 본송장+재고송장의 대량, 개별 = 그 나머지(개별 + 합포).
  const loadedShipParts = useMemo(() => {
    const sumOf = (keys) => INVOICE_TABS.reduce(
      (sum, inv) => sum + keys.reduce((s, k) => s + (ship?.totals?.[inv.key]?.[k]?.pieces || 0), 0),
      0,
    );
    return { bulk: sumOf(["bulk"]), single: sumOf(["single", "combo"]) };
  }, [ship]);
  const loadedShipPieces = loadedShipParts.bulk + loadedShipParts.single;
  // 직접 입력한 수량이 있으면 그 값으로 시간을 계산한다. 비우면 불러온 수량으로 돌아간다.
  const editedQty = (raw, loaded) => {
    if (raw === null || raw.trim() === "") return loaded;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : loaded;
  };
  const packQty = editedQty(packEdit, loadedPackQty);
  const shipPieces = editedQty(shipEdit, loadedShipPieces);

  // 현재 시각과 상관없이 시간대별 인원 입력값 전체로 계산한다. 입력 중인 값(draft)도 바로 반영한다.
  // 시간대별 근무 인원(draft 포함)을 계산용 슬롯으로 바꾼다. 화면에서는 포장(kind="pack")만 입력받는다.
  const kindSlots = useCallback((kind) => slots.map((s) => {
    const raw = draft[`${kind}:${s.slot}`];
    if (raw !== undefined && raw.trim() !== "") {
      const n = Number(raw);
      if (Number.isInteger(n) && n >= 0) return { slot: s.slot, calc: n };
    }
    return { slot: s.slot, calc: s[kind].calc };
  }), [slots, draft]);

  const estimate = useMemo(() => {
    if (!slots.length) return null;
    // notBefore: 이 시각 전에는 시작하지 않는다. 그 구분의 인원이 처음 생기는 시간대와 비교해 더 늦은 쪽에서 시작한다.
    // 시간대별 근무 인원은 포장만 입력받는다. 대량출고/개별출고 인원은 출고 박스에서 숫자 하나로 정하고,
    // 비우면 시간대별 근무 인원을 그대로 따르고, 넣으면 근무 인원이 있는 시간대마다 그 인원이 일한다.
    const packSlots = kindSlots("pack");
    const fixedSlots = (raw) => {
      const n = raw.trim() !== "" && Number.isInteger(Number(raw)) && Number(raw) >= 0 ? Number(raw) : null;
      return n == null ? packSlots : packSlots.map((p) => ({ ...p, calc: p.calc > 0 ? n : 0 }));
    };
    const bulkSlots = fixedSlots(shipBulkHead);
    const singleSlots = fixedSlots(shipSingleHead);
    const run = (ks, qty, rate, notBefore = 0) => {
      const first = ks.find((s) => s.calc > 0) ?? ks[0];
      const startMin = Math.max(toMin(first.slot), notBefore);
      return { qty, startMin, afterBreak: notBefore > 0 && notBefore >= toMin(first.slot), ...runQueue(qty, startMin, ks, rate) };
    };
    const parseStart = (raw) => (/^\d{1,2}:\d{2}$/.test(raw) ? toMin(raw) : null);
    const packManual = parseStart(starts.pack);
    const packBase = run(packSlots, packQty, packRate, packManual ?? 0);
    const packRes = { ...packBase, afterBreak: false, manualStart: packManual != null && packBase.afterBreak };
    // 대량 → 개별 순서로 이어서 처리한다고 보고 구간을 나눈다. 포장 개수를 직접 고쳤으면 불러온 대량:개별 비율로 나눈다.
    const loadedBulk = pack?.bulk?.qty || 0;
    const loadedSingle = pack?.single?.qty || 0;
    let packDetail = null;
    if (loadedBulk + loadedSingle > 0 && packRes.endMin != null) {
      const bulkQty = Math.round(packQty * (loadedBulk / (loadedBulk + loadedSingle)));
      const bulk = { qty: bulkQty, startMin: packRes.startMin, ...runQueue(bulkQty, packRes.startMin, packSlots, packRate) };
      const singleStart = bulk.endMin ?? packRes.startMin;
      const single = { qty: packQty - bulkQty, startMin: singleStart, ...runQueue(packQty - bulkQty, singleStart, packSlots, packRate) };
      packDetail = { bulk, single };
    }
    // 출고 시작: 시각을 직접 지정했으면 그 시각, 아니면 포장 종료 + 쉬는시간.
    const manualStart = parseStart(starts.ship);
    const shipNotBefore = manualStart ?? (packQty > 0 && packRes.endMin != null ? packRes.endMin + DEFAULT_BREAK_MIN : 0);
    // 대량출고와 개별출고는 동시에 진행한다. 각자 자기 인원/처리 개수로 같은 시작 기준에서 따로 계산하고,
    // 전체는 먼저 시작한 쪽부터 늦게 끝나는 쪽까지다. 직접 고친 개수는 불러온 비율로 나눈다.
    const shipBulkQty = loadedShipPieces > 0 ? Math.round(shipPieces * (loadedShipParts.bulk / loadedShipPieces)) : 0;
    const shipSingleQty = shipPieces - shipBulkQty;
    const bulkAlone = run(bulkSlots, shipBulkQty, shipBulkRate, shipNotBefore);
    const single = run(singleSlots, shipSingleQty, shipSingleRate, shipNotBefore);
    // 설정을 켰고 개별출고가 대량출고보다 먼저 끝나면, 끝난 시점부터 개별출고 인원이 대량출고(대량 처리 속도)에 합류한다.
    let bulk = bulkAlone;
    let joined = null;
    // 대량출고 인원이 없어서(0명) 혼자서는 끝낼 수 없는 경우도 합류 인원만으로 진행한다.
    const bulkNoStaff = shipBulkQty > 0 && bulkAlone.endMin == null;
    if (joinBulk && shipBulkQty > 0 && single.endMin != null && (bulkNoStaff || (bulkAlone.endMin != null && single.endMin < bulkAlone.endMin))) {
      // 합류 인원: 비우면 그 시간대 개별출고 인원 전부, 숫자를 넣으면 그 인원(개별출고 인원이 더 적은 시간대는 그 인원까지)
      const limit = joinCount.trim() !== "" && Number.isInteger(Number(joinCount)) && Number(joinCount) >= 0 ? Number(joinCount) : null;
      const helpers = singleSlots.map((s) => ({ ...s, calc: limit == null ? s.calc : Math.min(limit, s.calc) }));
      const helped = runQueueWithHelp(shipBulkQty, bulkAlone.startMin, bulkSlots, helpers, shipBulkRate, single.endMin);
      if (helped.endMin != null && (bulkNoStaff || helped.endMin < bulkAlone.endMin)) {
        // 대량출고 인원이 없던 경우 대량출고는 합류 시점에 시작한다.
        bulk = { ...bulkAlone, ...helped, ...(bulkNoStaff ? { startMin: single.endMin, afterBreak: false } : {}) };
        joined = { fromMin: single.endMin, savedMin: bulkNoStaff ? null : bulkAlone.endMin - helped.endMin };
      }
    }
    const parts = [bulk, single].filter((p) => p.qty > 0);
    const shipRes = {
      startMin: parts.length ? Math.min(...parts.map((p) => p.startMin)) : bulk.startMin,
      afterBreak: manualStart == null && parts.length > 0 && parts.every((p) => p.afterBreak),
      manualStart: manualStart != null && parts.length > 0 && parts.every((p) => p.afterBreak),
      over: parts.some((p) => p.over),
      endMin: parts.length === 0 || parts.some((p) => p.endMin == null) ? null : Math.max(...parts.map((p) => p.endMin)),
    };
    return { packRes, packDetail, shipRes, shipDetail: { bulk, single, joined } };
  }, [slots, kindSlots, pack, packQty, shipPieces, loadedShipPieces, loadedShipParts, packRate, shipBulkRate, shipSingleRate, shipBulkHead, shipSingleHead, joinBulk, joinCount, starts]);

  const renderDetailRow = (label, part) => (
    <li className={styles.detailRow}>
      <span className={styles.detailLabel}>{label} {part.qty.toLocaleString()}개</span>
      {part.qty > 0 && part.endMin != null ? (
        <span>
          <b>{fmtDuration(part.endMin - part.startMin)}</b>
          <span className={styles.muted}> · {fmtMin(part.startMin)} → {fmtMin(part.endMin)}</span>
        </span>
      ) : <span className={styles.muted}>-</span>}
    </li>
  );

  // 시작 시각은 눌러서 바로 고칠 수 있다(포장/출고 공통). 수정칸을 비우면 자동 시작으로 돌아간다.
  const renderStart = (kind, startMin, res) => (
    <>
      {editingStart === kind ? (
        <input
          type="time" autoFocus className={`${styles.input} ${styles.startInput}`}
          value={starts[kind] || fmtMin(startMin)}
          onChange={(e) => changeStart(kind, e.target.value)}
          onBlur={() => setEditingStart(null)}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === "Escape") setEditingStart(null); }}
        />
      ) : (
        <button type="button" className={styles.startBtn} title="눌러서 시작 시각 수정" onClick={() => setEditingStart(kind)}>
          {fmtMin(startMin)}
        </button>
      )}
      {" 시작"}
      {res.afterBreak ? ` (포장 종료 후 ${DEFAULT_BREAK_MIN}분 쉬는시간 뒤로 계산)` : ""}
    </>
  );

  const renderEnd = (res, qty, kind) => {
    const startMin = res.startMin;
    if (qty <= 0) return <span className={styles.endEmpty}>-</span>;
    if (res.endMin == null) return <span className={styles.endFail}>근무 인원이 없어 계산할 수 없습니다</span>;
    return (
      <>
        <span className={styles.endTime}>{fmtDuration(res.endMin - startMin)}<small>소요</small></span>
        <span className={styles.muted}>
          {renderStart(kind, startMin, res)} → {fmtMin(res.endMin)} 종료 예상{res.over ? " (근무 인원 시간대 초과분 포함)" : ""}
        </span>
      </>
    );
  };

  const renderQtyInput = (label, kind, edit, loaded, current) => (
    <span className={styles.summaryTitle}>
      {label}
      <input
        type="number" min="0" className={`${styles.input} ${styles.qtyInput}`}
        value={edit ?? String(loaded)}
        onChange={(e) => changeQty(kind, e.target.value)}
      />
      개
      {edit !== null && current !== loaded && (
        <>
          <small> (불러온 수량 {loaded.toLocaleString()}개)</small>
          <button type="button" className={styles.removeBtn} onClick={() => changeQty(kind, null)}>되돌리기</button>
        </>
      )}
    </span>
  );

  // 출고는 같은 줄에서 인원(head)도 같이 설정한다. 인원을 비우면 시간대별 근무 인원을 따른다.
  const renderRateInput = (kind, value, label = "", head = null) => (
    <label className={styles.rateLabel}>
      {label}
      {head && (
        <>
          {" 인원"}
          <input
            type="number" min="0" className={`${styles.input} ${styles.rateInput}`}
            value={head.value} placeholder="자동"
            onChange={(e) => changeShipHead(kind, e.target.value)}
          />
          명 ×
        </>
      )}
      {" 1인 1분"}
      <input
        type="number" min="1" className={`${styles.input} ${styles.rateInput}`} value={value}
        onChange={(e) => changeRate(kind, e.target.value)}
      />
      개 처리
    </label>
  );

  return (
    <div className={pageStyles.page}>
      <div className={pageStyles.pageHeader}>
        <div>
          <h2 className={pageStyles.title}>리드타임</h2>
          <p className={pageStyles.subtitle}>입고요청·출력차수 수량과 시간대별 근무 인원으로 포장·출고 각각의 소요 시간 예상</p>
        </div>
        {headerExtra}
      </div>

      <div className={pageStyles.stack}>
        <section className={pageStyles.card}>
          <div className={pageStyles.cardHeader}>
            <h3 className={pageStyles.cardTitle}>예상 종료</h3>
            <div className={styles.controls}>
              <input type="date" className={styles.input} value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
          </div>
          <div className={styles.summary}>
            <div className={`${styles.summaryCell} ${styles.summaryMain}`}>
              {renderQtyInput("포장", "pack", packEdit, loadedPackQty, packQty)}
              {estimate ? renderEnd(estimate.packRes, packQty, "pack") : <span className={styles.endEmpty}>-</span>}
              {estimate?.packDetail ? (
                <div className={styles.breakdown}>
                  <ul className={styles.detailList}>
                    {renderDetailRow("대량", estimate.packDetail.bulk)}
                    {renderDetailRow("개별", estimate.packDetail.single)}
                  </ul>
                  <span className={styles.muted}>
                    대량 → 개별 순서로 이어서 포장한다고 보고 계산{packEdit !== null && packQty !== loadedPackQty ? " · 직접 입력한 개수는 불러온 대량:개별 비율로 나눔" : ""}
                  </span>
                </div>
              ) : <span className={styles.muted}>포장을 불러오면 대량/개별 시간이 표시됩니다.</span>}
              <details className={styles.detail}>
                <summary>상세보기 (1인 1분 처리 개수)</summary>
                {renderRateInput("pack", packRate)}
              </details>
            </div>
            <div className={`${styles.summaryCell} ${styles.summaryMain}`}>
              {renderQtyInput("출고", "ship", shipEdit, loadedShipPieces, shipPieces)}
              {estimate ? renderEnd(estimate.shipRes, shipPieces, "ship") : <span className={styles.endEmpty}>-</span>}
              {estimate && loadedShipPieces > 0 ? (
                <div className={styles.breakdown}>
                  <ul className={styles.detailList}>
                    {renderDetailRow("대량출고", estimate.shipDetail.bulk)}
                    {renderDetailRow("개별출고", estimate.shipDetail.single)}
                  </ul>
                  {joinBulk && (
                    <p className={styles.joinNote}>
                      {estimate.shipDetail.joined
                        ? `개별출고가 ${fmtMin(estimate.shipDetail.joined.fromMin)}에 끝나 그 인원이 대량출고에 합류${estimate.shipDetail.joined.savedMin == null ? " (대량출고 인원 없음 → 합류 인원만으로 진행)" : ` → 대량출고 ${fmtDuration(estimate.shipDetail.joined.savedMin)} 단축`}`
                        : "합류 설정 켬 · 개별출고가 대량출고보다 먼저 끝나지 않아 적용되지 않음"}
                    </p>
                  )}
                  <span className={styles.muted}>
                    대량 = 본송장+재고송장 대량 {loadedShipParts.bulk.toLocaleString()}개 · 개별 = 나머지(개별+합포) {loadedShipParts.single.toLocaleString()}개
                    <br />
                    대량출고와 개별출고는 동시에 진행하는 것으로 보고 각자 계산, 전체는 늦게 끝나는 쪽 기준{shipEdit !== null && shipPieces !== loadedShipPieces ? " · 직접 입력한 개수는 불러온 비율로 나눔" : ""}
                  </span>
                </div>
              ) : <span className={styles.muted}>출고를 불러오면 대량/개별 시간이 표시됩니다.</span>}
              <details className={styles.detail}>
                <summary>상세보기 (인원 · 1인 1분 처리 개수 · 합류)</summary>
                {renderRateInput("ship_bulk", shipBulkRate, "대량출고", { value: shipBulkHead })}
                {renderRateInput("ship_single", shipSingleRate, "개별출고", { value: shipSingleHead })}
                <span className={styles.muted}>인원을 비우면(자동) 시간대별 근무 인원을 따르고, 숫자를 넣으면 근무 시간대마다 그 인원이 일합니다.</span>
                <label className={styles.joinLabel}>
                  <input type="checkbox" checked={joinBulk} onChange={(e) => changeJoinBulk(e.target.checked)} />
                  개별출고가 먼저 끝나면 그 인원이 대량출고에 합류
                </label>
                {joinBulk && (
                  <label className={styles.rateLabel}>
                    합류 인원
                    <input
                      type="number" min="0" className={`${styles.input} ${styles.rateInput}`}
                      value={joinCount} placeholder="전부"
                      onChange={(e) => changeJoinCount(e.target.value)}
                    />
                    명 <span className={styles.muted}>(비우면 개별출고 인원 전부)</span>
                  </label>
                )}
              </details>
            </div>
          </div>
          {message && <div className={pageStyles.statusMsg}>{message}</div>}
        </section>

        <section className={pageStyles.card}>
          <div className={pageStyles.cardHeader}>
            <h3 className={pageStyles.cardTitle}>시간대별 근무 인원</h3>
            <span className={styles.muted}>포장 근무 인원 · 스케줄관리 예정 인원이 기본, 칸을 수정하면 바로 이 날짜에 저장 (비우면 예정 인원으로 복귀) · 대량/개별출고 인원은 출고 박스에서 설정</span>
          </div>
          <div className={styles.slotGrid}>
            {visibleSlots.map((s) => (
              <div key={s.slot} className={styles.slot}>
                <span className={styles.slotTime}>{s.slot}</span>
                {HEADCOUNT_KINDS.map(([kind, label]) => {
                  const key = `${kind}:${s.slot}`;
                  return (
                    <label key={kind} className={`${styles.slotInput} ${s[kind].manual != null ? styles.slotManual : ""}`}>
                      <span className={styles.slotKind}>{label}</span>
                      <input
                        type="number" min="0" className={styles.slotNumber}
                        value={draft[key] ?? String(s[kind].headcount)}
                        onChange={(e) => changeHeadcount(kind, s.slot, e.target.value)}
                        onBlur={(e) => blurHeadcount(kind, s.slot, e.target.value)}
                      />
                      명
                    </label>
                  );
                })}
                {HEADCOUNT_KINDS.some(([kind]) => s[kind].manual != null) && <span className={styles.slotNote}>예정 {s.scheduled}명</span>}
              </div>
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
