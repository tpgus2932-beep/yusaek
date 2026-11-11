import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEzadminSession } from "../../lib/EzadminSessionContext";
import pageStyles from "./BarcodePage.module.css";
import styles from "./LeadTimePage.module.css";
import { LOCAL_API_BASE as API, getAuthHeaders, handleUnauthorized } from "../../lib/api";

import usePersistentState from "../../lib/usePersistentState";
const DEFAULT_RATE = 2; // 1인 1분 처리 개수
const HEADCOUNT_KINDS = [["pack", "포장"]]; // 시간대별 근무 인원 입력 구분 (대량출고/개별출고 인원은 출고 박스에서 설정)
const DEFAULT_BREAK_MIN = 10; // 포장 종료 후 출고 시작까지 쉬는시간(분) 기본값
const DEFAULT_SHOW_UNTIL = 15 * 60; // 시간대별 인원은 기본 15:00까지만 보여주고 나머지는 추가해서 쓴다
const PACK_TABS = [
  { key: "bulk", label: "대량" },
  { key: "single", label: "개별" },
  { key: "big", label: "대형" },
  { key: "unchecked", label: "미검수" },
];
const SHIP_TABS = [
  { key: "bulk", label: "대량" },
  { key: "single", label: "개별" },
  { key: "combo", label: "합포" },
  { key: "big", label: "그중 대형" }, // 대량·개별·합포 안에 든 대형 상품 (따로 떼지 않음)
];
// 매칭작업 항목: [처리 개수 설정 키, 이름]. 위에서부터 차례로 같은 인원이 이어서 처리한다고 보고 계산한다.
const MATCH_PARTS = [
  ["match_stock", "재고매칭 (대량제외)"],
  ["match_krl", "KRL매칭"], // 출고(출력차수) 송장 중 K·R·L 상품이 든 송장 수에 KRL 처리 개수 하나로 계산 (글자별은 상세보기)
  ["match_combo", "합포빼기"],
];
// 상세 항목별 시작 시각 설정 키 (비우면 자동: 포장은 앞 항목에 이어서, 나머지는 그 작업의 시작 시각)
const PART_START_KEYS = ["pack_bulk", "pack_single", "pack_big", "ship_bulk", "ship_single", "invoice_main", "invoice_stock", "match_stock", "match_krl", "match_combo"];
const START_KEYS = ["pack", "ship", "invoice", "match", ...PART_START_KEYS];
// 시간표(타임라인)에 그릴 작업: [시작 시각 설정 키, 이름, 막대 색 클래스]
const TIMELINE_TASKS = [
  ["pack", "포장", "tlPack"],
  ["ship", "출고", "tlShip"],
  ["invoice", "송장붙이기", "tlInvoice"],
  ["match", "매칭작업", "tlMatch"],
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

function shiftDate(value, days) {
  const [y, m, d] = String(value).split("-").map(Number);
  if (!y || !m || !d) return value;
  const t = new Date(y, m - 1, d + days);
  const pad = (n) => String(n).padStart(2, "0");
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
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
  const [packBigRate, setPackBigRate] = useState(DEFAULT_RATE); // 대형 포장 1인 1분 처리 개수
  const [shipBigRate, setShipBigRate] = useState(DEFAULT_RATE); // 대형출고 1인 1분 처리 개수
  const [shipBulkRate, setShipBulkRate] = useState(DEFAULT_RATE);
  const [shipSingleRate, setShipSingleRate] = useState(DEFAULT_RATE);
  const [joinBulk, setJoinBulk] = useState(false); // 개별출고가 먼저 끝나면 그 인원이 대량출고에 합류
  const [joinCount, setJoinCount] = useState(""); // 합류 인원 수 (빈칸이면 개별출고 인원 전부)
  const [invoiceMainRate, setInvoiceMainRate] = useState(DEFAULT_RATE); // 송장붙이기 본송장 1인 1분 처리 개수
  const [invoiceStockRate, setInvoiceStockRate] = useState(DEFAULT_RATE); // 송장붙이기 재고송장 1인 1분 처리 개수
  const [invoiceMainHead, setInvoiceMainHead] = useState(""); // 본송장 인원 (빈칸이면 시간대별 근무 인원을 따름)
  const [invoiceStockHead, setInvoiceStockHead] = useState(""); // 재고송장 인원 (빈칸이면 시간대별 근무 인원을 따름)
  const [invoiceEdit, setInvoiceEdit] = useState(null); // 송장 개수 직접 입력값 (null이면 출고에서 불러온 송장 수)
  const [matchRates, setMatchRates] = useState(() => Object.fromEntries(MATCH_PARTS.map(([k]) => [k, DEFAULT_RATE]))); // 매칭작업 항목별 1인 1분 처리 개수
  const [matchHeads, setMatchHeads] = useState(() => Object.fromEntries(MATCH_PARTS.map(([k]) => [k, ""]))); // 매칭작업 항목별 인원 (빈칸이면 시간대별 근무 인원을 따름)
  const [matchEdit, setMatchEdit] = useState(null); // 매칭작업 개수 직접 입력값 (null이면 불러온 수량)
  const [starts, setStarts] = useState(() => Object.fromEntries(START_KEYS.map((k) => [k, ""]))); // 시작 시각 직접 지정 ("HH:MM"). 빈칸이면 자동(포장·송장: 첫 근무 시간대, 출고: 포장 종료 + 쉬는시간)
  const [editingStart, setEditingStart] = useState(null); // 시작 시각을 누르면 "pack" | "ship" 수정칸으로 바뀐다
  const [shipBulkHead, setShipBulkHead] = useState(""); // 대량출고 인원 (빈칸이면 시간대별 근무 인원을 따름)
  const [shipSingleHead, setShipSingleHead] = useState(""); // 개별출고 인원 (빈칸이면 시간대별 근무 인원을 따름)
  const [packEdit, setPackEdit] = useState(null); // 포장 수량 직접 입력값 (null이면 불러온 수량)
  const [shipEdit, setShipEdit] = useState(null); // 출고 수량 직접 입력값 (null이면 불러온 수량)
  const [slots, setSlots] = useState([]);
  const [scheduleError, setScheduleError] = useState(null); // 관리페이지 근무표 연결 실패 사유
  const [showNames, setShowNames] = useState(false); // 시간대별 근무자 이름. 아무 칸의 열기/닫기를 눌러도 모든 칸이 같이 열리고 닫힘 (처음엔 닫힘)
  const [draft, setDraft] = useState({}); // 입력 중인 인원 (slot -> 문자열)
  const [pack, setPack] = useState(null);
  const [ship, setShip] = useState(null);
  const [suppliers, setSuppliers] = useState([]);
  const [newSupplier, setNewSupplier] = useState("");
  const [timelineOpen, setTimelineOpen] = usePersistentState("leadTimeTimelineOpen", "0", ["0", "1"]); // 시간표 열기/닫기 (처음엔 닫힘)
  const dragRef = useRef(null); // 시간표 막대 드래그 중인 정보 (화면 그리기와 상관없는 값이라 ref)
  const [dragInfo, setDragInfo] = useState(null); // 드래그 중 말풍선: { key, min, fine }
  const [nowMin, setNowMin] = useState(() => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); }); // 시간표의 지금 시각 선
  const [phase, setPhase] = usePersistentState("leadTimePhase", "pack", ["pack", "ship"]);
  const [packTab, setPackTab] = usePersistentState("leadTimePackTab", "bulk", PACK_TABS.map((t) => t.key));
  const [shipTab, setShipTab] = usePersistentState("leadTimeShipTab", "bulk", SHIP_TABS.map((t) => t.key));
  const [invoiceTab, setInvoiceTab] = usePersistentState("leadTimeInvoiceTab", "main", INVOICE_TABS.map((t) => t.key));
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

  useEffect(() => {
    if (timelineOpen !== "1") return undefined;
    const id = setInterval(() => { const d = new Date(); setNowMin(d.getHours() * 60 + d.getMinutes()); }, 60000);
    return () => clearInterval(id);
  }, [timelineOpen]);
  const dateRef = useRef(date); // 날짜를 빨리 넘길 때 이전 날짜의 늦은 응답이 화면을 덮어쓰지 않게 한다
  dateRef.current = date;
  const loadAll = useCallback(async () => {
    setMessage("");
    try {
      // 근무표(관리페이지)는 느릴 수 있어서 따로 받는다 → 저장된 포장·출고 결과와 설정을 먼저 보여준다.
      request(`/headcount?date=${date}`)
        .then((hc) => { if (hc && dateRef.current === date) { setSlots(hc.slots); setScheduleError(hc.scheduleError || null); setDraft({}); setShowUntil(DEFAULT_SHOW_UNTIL); } })
        .catch((err) => { if (dateRef.current === date) setScheduleError(err.message || "근무표를 불러오지 못했습니다"); });
      const [snap, sup, st] = await Promise.all([
        request(`/snapshot?date=${date}`),
        request("/suppliers"),
        request(`/settings?date=${date}`).catch(() => null), // 저장된 처리량/개수. 못 불러와도 나머지는 보여준다
      ]);
      if (snap) { setPack(snap.pack); setShip(snap.ship); }
      setPackEdit(st?.qty?.pack != null ? String(st.qty.pack) : null);
      setShipEdit(st?.qty?.ship != null ? String(st.qty.ship) : null);
      setInvoiceEdit(st?.qty?.invoice != null ? String(st.qty.invoice) : null);
      setMatchEdit(st?.qty?.match != null ? String(st.qty.match) : null);
      setMatchHeads(Object.fromEntries(MATCH_PARTS.map(([k]) => [k, st?.options?.[`${k}_head`] != null ? String(st.options[`${k}_head`]) : ""])));
      setMatchRates((prev) => Object.fromEntries(MATCH_PARTS.map(([k]) => [k, st?.rates?.[k] > 0 ? st.rates[k] : prev[k]])));
      if (st?.rates?.pack > 0) setPackRate(st.rates.pack);
      if (st?.rates?.pack_big > 0) setPackBigRate(st.rates.pack_big);
      if (st?.rates?.ship_big > 0) setShipBigRate(st.rates.ship_big);
      if (st?.rates?.invoice_main > 0) setInvoiceMainRate(st.rates.invoice_main);
      if (st?.rates?.invoice_stock > 0) setInvoiceStockRate(st.rates.invoice_stock);
      setInvoiceMainHead(st?.options?.invoice_main_head != null ? String(st.options.invoice_main_head) : "");
      setInvoiceStockHead(st?.options?.invoice_stock_head != null ? String(st.options.invoice_stock_head) : "");
      // 예전에 출고 하나로 저장해 둔 값(ship)이 있으면 대량/개별의 처음 값으로 쓴다.
      const legacyShip = st?.rates?.ship > 0 ? st.rates.ship : null;
      const bulkRate = st?.rates?.ship_bulk > 0 ? st.rates.ship_bulk : legacyShip;
      const singleRate = st?.rates?.ship_single > 0 ? st.rates.ship_single : legacyShip;
      setJoinBulk(Boolean(st?.options?.join_bulk));
      setJoinCount(st?.options?.join_count != null ? String(st.options.join_count) : "");
      setStarts(Object.fromEntries(START_KEYS.map((k) => [k, st?.options?.[`${k}_start`] || ""])));
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

  // 관리페이지 근무표 인원만 다시 불러온다 (화면으로 돌아올 때 자동 + "근무표 다시 불러오기" 버튼).
  // 입력 중인 칸(draft)은 건드리지 않는다. 버튼은 서버의 잠깐 저장해 둔 값(30초)을 건너뛴다.
  const [headcountLoading, setHeadcountLoading] = useState(false);
  const refreshHeadcount = useCallback(async (fresh = false) => {
    setHeadcountLoading(true);
    try {
      const hc = await request(`/headcount?date=${date}${fresh ? "&fresh=1" : ""}`);
      if (hc) { setSlots(hc.slots); setScheduleError(hc.scheduleError || null); }
    } catch (err) {
      if (fresh) setScheduleError(err.message || "근무표를 불러오지 못했습니다");
    } finally {
      setHeadcountLoading(false);
    }
  }, [request, date]);

  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === "visible") refreshHeadcount(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refreshHeadcount]);

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
    if (kind.startsWith("match_")) setMatchRates((prev) => ({ ...prev, [kind]: n }));
    else ({ pack: setPackRate, pack_big: setPackBigRate, ship_bulk: setShipBulkRate, ship_single: setShipSingleRate, ship_big: setShipBigRate, invoice_main: setInvoiceMainRate, invoice_stock: setInvoiceStockRate })[kind](n);
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

  // kind: "pack" | "ship" | "invoice". 빈 값이면 직접 지정을 해제하고 자동 시작으로 돌아간다.
  const changeStart = (kind, raw) => {
    setStarts((s) => ({ ...s, [kind]: raw }));
    persistSettings({ options: { [`${kind}_start`]: raw || null } });
  };

  // 인원 직접 지정 (대량출고 / 개별출고 / 송장붙이기). 비우면 시간대별 근무 인원을 따른다.
  const HEAD_SETTERS = {
    ship_bulk: [setShipBulkHead, "bulk_head"],
    ship_single: [setShipSingleHead, "single_head"],
    invoice_main: [setInvoiceMainHead, "invoice_main_head"],
    invoice_stock: [setInvoiceStockHead, "invoice_stock_head"],
    ...Object.fromEntries(MATCH_PARTS.map(([k]) => [k, [(raw) => setMatchHeads((prev) => ({ ...prev, [k]: raw })), `${k}_head`]])),
  };
  const changeHead = (kind, raw) => {
    const [setter, option] = HEAD_SETTERS[kind];
    setter(raw);
    persistCount(option, raw);
  };

  const changeQty = (kind, raw) => {
    ({ pack: setPackEdit, ship: setShipEdit, invoice: setInvoiceEdit, match: setMatchEdit })[kind](raw);
    if (raw === null || raw.trim() === "") persistSettings({ qty: { [kind]: null } });
    else if (Number.isInteger(Number(raw)) && Number(raw) >= 0) persistSettings({ qty: { [kind]: Number(raw) } });
  };

  // 화면을 떠나거나 새로고침하기 직전에 아직 못 보낸 값을 보낸다.
  useEffect(() => () => { flushSettings(); }, [flushSettings]);

  // fresh: 출고에서 이미 읽어 둔 출력차수도 전부 이지어드민에서 다시 읽는다 (기본은 새 차수만 읽음).
  const runLoad = useCallback(async (kind, fresh = false) => {
    setBusy(kind);
    setMessage(kind === "ship"
      ? `출력차수 주문을 조회하는 중입니다. ${fresh ? "모든 차수를 다시 읽으므로" : "새 차수만 읽지만"} 차수 하나에 약 25초 걸립니다.`
      : "입고요청 전표를 조회하는 중입니다. 전표가 많으면 몇 분 걸릴 수 있습니다.");
    try {
      const data = await request(`/${kind}/load`, { method: "POST", body: JSON.stringify({ date, fresh }) });
      if (!data) return;
      if (data.need_session) {
        openEzadminModal(() => runLoad(kind, fresh));
        return;
      }
      if (kind === "pack") setPack(data.pack); else setShip(data.ship);
      // 새로 불러오면 직접 입력한 개수는 지우고 불러온 수량을 쓴다
      // 출고를 새로 불러오면 송장 수도 함께 새로 잡히므로 송장 직접 입력값도 지운다.
      // 매칭작업 수량도 포장(K/R/L)·출고(합포)에서 오므로 직접 입력한 매칭 총개수를 지운다.
      if (kind === "pack") setPackEdit(null); else { setShipEdit(null); setInvoiceEdit(null); }
      setMatchEdit(null);
      persistSettings({ qty: kind === "pack" ? { pack: null, match: null } : { ship: null, invoice: null, match: null } });
      const reused = data.ship?.reused || [];
      setMessage(kind === "ship" && reused.length
        ? `저장된 차수(${reused.map((n) => `${n}차`).join(", ")})는 다시 읽지 않았습니다. 내용이 바뀌었으면 '전부 다시 읽기'를 누르세요.`
        : "");
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
      if (data) { setBulkSheets(data.bulk); setCheckSheets(data.check); setMessage("전표 지정을 저장했습니다. '반영하기'를 누르면 반영됩니다."); }
    } catch (err) {
      setMessage(err.message || "지정 저장 실패");
    }
  };

  const saveAssign = async () => {
    const pick = (kind) => Object.keys(assign).filter((n) => assign[n] === kind);
    try {
      const data = await request("/ship/assign", { method: "PUT", body: JSON.stringify({ date, main: pick("main"), stock: pick("stock") }) });
      if (data) { setAssign(data.assigned); setMessage("본송장·재고송장 지정을 저장했습니다. '반영하기'를 누르면 반영됩니다."); }
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

  const loadedPackQty = (pack?.bulk?.qty || 0) + (pack?.single?.qty || 0) + (pack?.big?.qty || 0);
  // 출고는 송장 개수(주문 건수, 합포 1건 = 1개)로 센다 → 송장붙이기 개수와 같다.
  // 대량 = 본송장+재고송장의 대량, 개별 = 개별 + 합포 (송장 수). 대형은 따로 떼지 않고 대량/개별 안의 대형 주문 건수(bigBulk/bigSingle)만 센다.
  const loadedShipParts = useMemo(() => {
    const sumOf = (keys) => INVOICE_TABS.reduce(
      (sum, inv) => sum + keys.reduce((s, k) => s + (ship?.totals?.[inv.key]?.[k]?.orders || 0), 0),
      0,
    );
    const bigOf = (keys) => INVOICE_TABS.reduce(
      (sum, inv) => sum + keys.reduce((s, k) => s + (ship?.totals?.[inv.key]?.[k]?.big_orders ?? ship?.totals?.[inv.key]?.[k]?.big_pieces ?? 0), 0),
      0,
    );
    return { bulk: sumOf(["bulk"]), single: sumOf(["single", "combo"]), bigBulk: bigOf(["bulk"]), bigSingle: bigOf(["single", "combo"]) };
  }, [ship]);
  const loadedShipPieces = loadedShipParts.bulk + loadedShipParts.single;
  const loadedShipBig = loadedShipParts.bigBulk + loadedShipParts.bigSingle;
  // 직접 입력한 수량이 있으면 그 값으로 시간을 계산한다. 비우면 불러온 수량으로 돌아간다.
  const editedQty = (raw, loaded) => {
    if (raw === null || raw.trim() === "") return loaded;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : loaded;
  };
  // 송장붙이기 = 출고에서 불러온 본송장+재고송장의 주문 건수 (송장 1장 = 주문 1건, 대량·개별·합포 전부)
  const loadedInvoices = useMemo(() => {
    const ordersOf = (inv) => ["bulk", "single", "combo"].reduce((s, k) => s + (ship?.totals?.[inv]?.[k]?.orders || 0), 0);
    return { main: ordersOf("main"), stock: ordersOf("stock") };
  }, [ship]);
  const loadedInvoiceQty = loadedInvoices.main + loadedInvoices.stock;
  // 매칭작업 (모두 송장 개수 기준, 합포 1건 = 1개):
  // 재고매칭 = 재고송장으로 지정한 차수의 개별만 (대량·합포 제외) / KRL = 본송장 중 K·R·L 상품이 든 송장 수 (재고송장 제외)
  // 합포빼기 = 본송장+재고송장 합포의 상품 개수 (송장 수 아님)
  const loadedMatch = useMemo(() => ({
    match_stock: ship?.totals?.stock?.single?.orders || 0, // 재고송장 중 개별만 (대량·합포 제외)
    match_krl: ship?.totals?.main?.krl?.orders || 0, // 본송장만 (재고송장은 재고매칭에서 처리 → 중복 방지)
    match_combo: INVOICE_TABS.reduce((sum, inv) => sum + (ship?.totals?.[inv.key]?.combo?.pieces || 0), 0), // 합포빼기는 상품 개수 기준
  }), [ship]);
  const loadedMatchQty = MATCH_PARTS.reduce((sum, [k]) => sum + loadedMatch[k], 0);
  const matchQty = editedQty(matchEdit, loadedMatchQty);
  const packQty = editedQty(packEdit, loadedPackQty);
  const shipPieces = editedQty(shipEdit, loadedShipPieces);
  const invoiceQty = editedQty(invoiceEdit, loadedInvoiceQty);

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
    let packRes = { ...packBase, afterBreak: false, manualStart: packManual != null && packBase.afterBreak };
    // 대량 → 개별 → 대형 순서로 이어서 처리한다고 보고 구간을 나눈다. 대량·개별은 포장 처리 개수, 대형은 대형 처리 개수로 계산.
    // 셋은 겹치지 않는다(대형은 대량·개별 전표에서 빼낸 수량). 포장 개수를 직접 고쳤으면 불러온 비율로 나눈다.
    const loadedBulk = pack?.bulk?.qty || 0;
    const loadedSingle = pack?.single?.qty || 0;
    const loadedBig = pack?.big?.qty || 0;
    const loadedAll = loadedBulk + loadedSingle + loadedBig;
    let packDetail = null;
    if (loadedAll > 0) {
      const bulkQty = Math.round(packQty * (loadedBulk / loadedAll));
      const bigQty = Math.min(Math.round(packQty * (loadedBig / loadedAll)), packQty - bulkQty);
      const singleQty = packQty - bulkQty - bigQty;
      // 항목별 시작 시각을 직접 정했으면 그 시각부터(겹쳐서 동시에 진행 가능), 아니면 앞 항목이 끝난 뒤 이어서 시작한다.
      const partRun = (key, qty, rate, prev) => {
        const own = parseStart(starts[key]);
        if (own == null && prev && prev.endMin == null) return { qty, startMin: prev.startMin, endMin: null, over: false };
        return run(packSlots, qty, rate, own ?? (prev ? prev.endMin : packManual ?? 0));
      };
      const bulk = partRun("pack_bulk", bulkQty, packRate, null);
      const single = partRun("pack_single", singleQty, packRate, bulk);
      const big = partRun("pack_big", bigQty, packBigRate, single);
      packDetail = { bulk, single, big };
      const parts = [bulk, single, big].filter((p) => p.qty > 0);
      if (parts.length) {
        packRes = {
          ...packRes,
          startMin: Math.min(...parts.map((p) => p.startMin)),
          over: parts.some((p) => p.over),
          endMin: parts.some((p) => p.endMin == null) ? null : Math.max(...parts.map((p) => p.endMin)),
        };
      }
    }
    // 출고 시작: 시각을 직접 지정했으면 그 시각, 아니면 포장 종료 + 쉬는시간.
    const manualStart = parseStart(starts.ship);
    const shipNotBefore = manualStart ?? (packQty > 0 && packRes.endMin != null ? packRes.endMin + DEFAULT_BREAK_MIN : 0);
    // 대량출고와 개별출고는 동시에 진행한다. 각자 자기 인원/처리 개수로 같은 시작 기준에서 따로 계산하고,
    // 전체는 먼저 시작한 쪽부터 늦게 끝나는 쪽까지다. 직접 고친 개수는 불러온 비율로 나눈다.
    const shipBulkQty = loadedShipPieces > 0 ? Math.round(shipPieces * (loadedShipParts.bulk / loadedShipPieces)) : 0;
    const shipSingleQty = shipPieces - shipBulkQty;
    // 대형 상품도 대량/개별 조건대로 같은 팀이 처리하되, 대형 개수만 대형 처리 개수로 계산한다.
    // → 팀의 처리 개수 기준 "환산 개수" = 일반 개수 + 대형 개수 × (팀 처리 개수 ÷ 대형 처리 개수)
    const bigShare = (big, all) => (all > 0 ? Math.min(big / all, 1) : 0);
    const bulkBig = Math.round(shipBulkQty * bigShare(loadedShipParts.bigBulk, loadedShipParts.bulk));
    const singleBig = Math.round(shipSingleQty * bigShare(loadedShipParts.bigSingle, loadedShipParts.single));
    const effective = (qty, big, rate) => qty - big + big * (rate / shipBigRate);
    const withQty = (part, qty, big) => ({ ...part, qty, big });
    const bulkAlone = withQty(run(bulkSlots, effective(shipBulkQty, bulkBig, shipBulkRate), shipBulkRate, parseStart(starts.ship_bulk) ?? shipNotBefore), shipBulkQty, bulkBig);
    const single = withQty(run(singleSlots, effective(shipSingleQty, singleBig, shipSingleRate), shipSingleRate, parseStart(starts.ship_single) ?? shipNotBefore), shipSingleQty, singleBig);
    // 설정을 켰고 개별출고가 대량출고보다 먼저 끝나면, 끝난 시점부터 개별출고 인원이 대량출고(대량 처리 속도)에 합류한다.
    let bulk = bulkAlone;
    let joined = null;
    // 대량출고 인원이 없어서(0명) 혼자서는 끝낼 수 없는 경우도 합류 인원만으로 진행한다.
    const bulkNoStaff = shipBulkQty > 0 && bulkAlone.endMin == null;
    if (joinBulk && shipBulkQty > 0 && single.endMin != null && (bulkNoStaff || (bulkAlone.endMin != null && single.endMin < bulkAlone.endMin))) {
      // 합류 인원: 비우면 그 시간대 개별출고 인원 전부, 숫자를 넣으면 그 인원(개별출고 인원이 더 적은 시간대는 그 인원까지)
      const limit = joinCount.trim() !== "" && Number.isInteger(Number(joinCount)) && Number(joinCount) >= 0 ? Number(joinCount) : null;
      const helpers = singleSlots.map((s) => ({ ...s, calc: limit == null ? s.calc : Math.min(limit, s.calc) }));
      const helped = runQueueWithHelp(effective(shipBulkQty, bulkBig, shipBulkRate), bulkAlone.startMin, bulkSlots, helpers, shipBulkRate, single.endMin);
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
    // 송장붙이기: 포장·출고와 따로, 첫 근무 시간대(또는 직접 지정한 시각)부터 자기 인원/처리 개수로 계산한다.
    // 출고처럼 본송장과 재고송장을 동시에 진행한다. 각자 인원/처리 개수로 따로 계산하고, 전체는 늦게 끝나는 쪽 기준.
    // 직접 고친 송장 수는 불러온 본송장:재고송장 비율로 나눈다 (불러온 게 없으면 전부 본송장).
    const invoiceManual = parseStart(starts.invoice);
    const invoiceMainQty = loadedInvoiceQty > 0 ? Math.round(invoiceQty * (loadedInvoices.main / loadedInvoiceQty)) : invoiceQty;
    const invoiceMain = run(fixedSlots(invoiceMainHead), invoiceMainQty, invoiceMainRate, parseStart(starts.invoice_main) ?? invoiceManual ?? 0);
    const invoiceStock = run(fixedSlots(invoiceStockHead), invoiceQty - invoiceMainQty, invoiceStockRate, parseStart(starts.invoice_stock) ?? invoiceManual ?? 0);
    const invoiceParts = [invoiceMain, invoiceStock].filter((p) => p.qty > 0);
    const invoiceRes = {
      startMin: invoiceParts.length ? Math.min(...invoiceParts.map((p) => p.startMin)) : invoiceMain.startMin,
      afterBreak: false,
      manualStart: invoiceManual != null && invoiceParts.length > 0 && invoiceParts.every((p) => p.afterBreak),
      over: invoiceParts.some((p) => p.over),
      endMin: invoiceParts.length === 0 || invoiceParts.some((p) => p.endMin == null) ? null : Math.max(...invoiceParts.map((p) => p.endMin)),
    };
    // 매칭작업: 송장붙이기처럼 항목(재고매칭 / KRL매칭 / 합포빼기)마다 자기 인원·1분 처리 개수로 동시에 진행한다.
    // 첫 근무 시간대(또는 직접 지정한 시각)부터 시작, 전체는 늦게 끝나는 항목 기준. 직접 고친 총개수는 불러온 비율로 나눈다.
    const matchManual = parseStart(starts.match);
    const matchDetail = {};
    let assignedQty = 0;
    MATCH_PARTS.forEach(([k], i) => {
      const qty = i === MATCH_PARTS.length - 1
        ? Math.max(matchQty - assignedQty, 0)
        : (loadedMatchQty > 0 ? Math.min(Math.round(matchQty * (loadedMatch[k] / loadedMatchQty)), matchQty - assignedQty) : 0);
      assignedQty += qty;
      matchDetail[k] = run(fixedSlots(matchHeads[k]), qty, matchRates[k], parseStart(starts[k]) ?? matchManual ?? 0);
    });
    const matchParts = Object.values(matchDetail).filter((p) => p.qty > 0);
    const matchFirst = matchDetail[MATCH_PARTS[0][0]];
    const matchRes = {
      startMin: matchParts.length ? Math.min(...matchParts.map((p) => p.startMin)) : matchFirst.startMin,
      afterBreak: false,
      manualStart: matchManual != null && matchParts.length > 0 && matchParts.every((p) => p.afterBreak),
      over: matchParts.some((p) => p.over),
      endMin: matchParts.length === 0 || matchParts.some((p) => p.endMin == null) ? null : Math.max(...matchParts.map((p) => p.endMin)),
    };
    return { packRes, packDetail, shipRes, shipDetail: { bulk, single, joined }, invoiceRes, invoiceDetail: { main: invoiceMain, stock: invoiceStock }, matchRes, matchDetail };
  }, [matchHeads, matchQty, loadedMatch, loadedMatchQty, matchRates, slots, kindSlots, pack, packQty, shipPieces, loadedShipPieces, loadedShipParts, packRate, packBigRate, shipBulkRate, shipSingleRate, shipBigRate, shipBulkHead, shipSingleHead, joinBulk, joinCount, starts, invoiceQty, loadedInvoiceQty, loadedInvoices, invoiceMainRate, invoiceStockRate, invoiceMainHead, invoiceStockHead]);

  // 상세 항목의 시작 시각: 눌러서 바로 고친다. 직접 정한 시각이 있으면 "자동"을 눌러 원래 계산으로 되돌린다.
  const renderPartStart = (key, startMin) => (
    <>
      {editingStart === key ? (
        <input
          type="time" autoFocus className={`${styles.input} ${styles.startInput}`}
          value={starts[key] || fmtMin(startMin)}
          onChange={(e) => changeStart(key, e.target.value)}
          onBlur={() => setEditingStart(null)}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === "Escape") setEditingStart(null); }}
        />
      ) : (
        <button type="button" className={styles.partStartBtn} title="눌러서 이 항목의 시작 시각 수정" onClick={() => setEditingStart(key)}>
          {fmtMin(startMin)}
        </button>
      )}
      {starts[key] && editingStart !== key && (
        <button type="button" className={styles.removeBtn} title="직접 정한 시작 시각을 지우고 자동으로" onClick={() => changeStart(key, "")}>자동</button>
      )}
    </>
  );

  const renderDetailRow = (label, part, startKey = null) => (
    <li className={styles.detailRow}>
      <span className={styles.detailLabel}>{label} {part.qty.toLocaleString()}개</span>
      {part.qty > 0 && part.endMin != null ? (
        <span>
          <b>{fmtDuration(part.endMin - part.startMin)}</b>
          <span className={styles.muted}> · {startKey ? renderPartStart(startKey, part.startMin) : fmtMin(part.startMin)} → {fmtMin(part.endMin)}</span>
        </span>
      ) : part.qty > 0 && startKey ? (
        <span className={styles.muted}>{renderPartStart(startKey, part.startMin)} 시작 · 근무 인원 없음</span>
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
  // 설정 한 줄 = 이름 / 인원 / 1분 처리 개수 세 칸. rateGrid 안에서 칸이 줄마다 같은 위치에 맞춰진다
  // (이름 칸 폭 = 가장 긴 이름). 인원이 없는 줄은 인원 칸을 비워 둔다.
  const renderRateInput = (kind, value, label = "", head = null) => (
    <label className={styles.rateLabel}>
      <span className={styles.rateName}>{label}</span>
      <span className={styles.rateCell}>
        {head && (
          <>
            인원
            <input
              type="number" min="0" className={`${styles.input} ${styles.rateInput}`}
              value={head.value} placeholder="자동"
              onChange={(e) => changeHead(kind, e.target.value)}
            />
            명 ×
          </>
        )}
      </span>
      <span className={styles.rateCell}>
        1인 1분
        <input
          type="number" min="1" className={`${styles.input} ${styles.rateInput}`} value={value}
          onChange={(e) => changeRate(kind, e.target.value)}
        />
        개 처리
      </span>
    </label>
  );

  // 시간표: 작업마다 시작~종료를 막대로 그린다. 시작 시각을 바꾸면 위 계산과 함께 바로 다시 그려진다.
  // 겹치는 구간 = 동시에 진행되는 시간. 오늘 날짜면 지금 시각을 빨간 선으로 표시한다.
  const renderTimeline = () => {
    if (!estimate) return <div className={styles.muted}>근무 인원을 불러오면 시간표가 표시됩니다.</div>;
    const results = { pack: [estimate.packRes, packQty], ship: [estimate.shipRes, shipPieces], invoice: [estimate.invoiceRes, invoiceQty], match: [estimate.matchRes, matchQty] };
    const partsOf = {
      pack: estimate.packDetail ? [["pack_bulk", "대량", estimate.packDetail.bulk], ["pack_single", "개별", estimate.packDetail.single], ["pack_big", "대형", estimate.packDetail.big]] : [],
      ship: [["ship_bulk", "대량출고", estimate.shipDetail.bulk], ["ship_single", "개별출고", estimate.shipDetail.single]],
      invoice: [["invoice_main", "본송장", estimate.invoiceDetail.main], ["invoice_stock", "재고송장", estimate.invoiceDetail.stock]],
      match: MATCH_PARTS.map(([k, label]) => [k, label, estimate.matchDetail[k]]),
    };
    // 작업 하나 = 한 줄. 항목(본송장·재고송장 등)이 나뉘면 같은 줄 안에 항목별 막대를 그리고 막대에 항목 이름만 쓴다.
    // 시간이 겹치는 항목(동시에 진행)은 같은 줄 안에서 위아래 칸(lane)으로 나눠 겹쳐 보이지 않게 한다.
    const rows = TIMELINE_TASKS.map(([key, label, color]) => {
      const [res, qty] = results[key];
      const segs = partsOf[key]
        .filter(([, , part]) => part && part.qty > 0 && part.endMin != null)
        .map(([k, l, part]) => ({ key: k, label: l, startMin: part.startMin, endMin: part.endMin }))
        .sort((a, b) => a.startMin - b.startMin);
      const laneEnds = [];
      for (const seg of segs) {
        let lane = laneEnds.findIndex((end) => end <= seg.startMin);
        if (lane < 0) { lane = laneEnds.length; laneEnds.push(0); }
        laneEnds[lane] = seg.endMin;
        seg.lane = lane;
      }
      return { key, label, color, qty, startMin: res.startMin, endMin: qty > 0 ? res.endMin : null, segs: segs.length > 1 ? segs : [], lanes: Math.max(laneEnds.length, 1) };
    });
    const drawn = rows.filter((r) => r.qty > 0 && r.endMin != null);
    const from = Math.floor(Math.min(9 * 60, ...drawn.map((r) => r.startMin)) / 60) * 60;
    // 기본 09~14시를 한 화면 너비에 꽉 차게 그린다. 그보다 길어지면 그만큼 옆으로 넓어지고 가로 스크롤로 본다.
    const VIEW_MIN = 5 * 60;
    const to = Math.max(14 * 60, from + VIEW_MIN, Math.ceil(Math.max(0, ...drawn.map((r) => r.endMin)) / 60) * 60);
    const span = to - from;
    const pct = (min) => `${((Math.min(Math.max(min, from), to) - from) / span) * 100}%`;
    // 막대 드래그 → 그 작업(또는 항목)의 시작 시각을 바꾼다. 기본 30분 단위로 걸리고,
    // 드래그 중 잠깐(0.45초) 멈추면 그때부터 10분 단위로 세밀하게 옮긴다. 옮기는 즉시 계산·저장된다.
    // 왼쪽 버튼을 누르면 잡고, 떼면 놓는다. 움직임·떼기는 화면 전체(window)에서 받아서
    // 막대가 다시 그려지거나 마우스가 막대 밖으로 나가도 떼는 순간 반드시 놓아진다.
    const dragProps = (key, startMin) => ({
      onPointerDown: (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const width = e.currentTarget.parentElement.getBoundingClientRect().width || 1;
        const d = { key, x: e.clientX, orig: startMin, width, span, from, to, last: null, fine: false, timer: null };
        const onMove = (ev) => {
          if (dragRef.current !== d) return;
          if ((ev.buttons & 1) === 0) { onUp(); return; } // 버튼이 이미 떼어진 상태면 바로 놓는다
          clearTimeout(d.timer);
          if (!d.fine) {
            d.timer = setTimeout(() => {
              d.fine = true;
              setDragInfo((info) => (info && info.key === key ? { ...info, fine: true } : info));
            }, 450);
          }
          const raw = d.orig + ((ev.clientX - d.x) / d.width) * d.span;
          const step = d.fine ? 10 : 30;
          const snapped = Math.min(Math.max(Math.round(raw / step) * step, 0), 23 * 60 + 50);
          if (snapped !== d.last && (d.last !== null || snapped !== d.orig)) {
            d.last = snapped;
            changeStart(key, fmtMin(snapped));
          }
          // raw: 마우스를 그대로 따라가는 위치 (잡은 막대는 끊김 없이 이 위치에 그린다)
          setDragInfo({ key, min: d.last ?? d.orig, fine: d.fine, raw: Math.min(Math.max(raw, d.from), d.to) });
        };
        const onUp = () => {
          clearTimeout(d.timer);
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
          window.removeEventListener("pointercancel", onUp);
          window.removeEventListener("blur", onUp);
          if (dragRef.current === d) dragRef.current = null;
          setDragInfo(null);
        };
        dragRef.current?.release?.(); // 혹시 남아 있던 이전 드래그는 정리
        d.release = onUp;
        dragRef.current = d;
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
        window.addEventListener("pointercancel", onUp);
        window.addEventListener("blur", onUp);
        setDragInfo({ key, min: startMin, fine: false });
      },
    });
    // 잡고 있는 막대는 계산된 시작이 아니라 손 위치(raw)에 그려서 부드럽게 따라오게 한다.
    const barLeft = (key, startMin) => pct(dragInfo?.key === key && dragInfo.raw != null ? dragInfo.raw : startMin);
    const dragTip = (keys) => (dragInfo && keys.includes(dragInfo.key) ? (
      <span className={styles.tlDragTip} style={{ left: pct(dragInfo.min) }}>
        {fmtMin(dragInfo.min)} 시작 · {dragInfo.fine ? "10분" : "30분"} 단위
      </span>
    ) : null);
    const hours = [];
    for (let m = from; m <= to; m += 60) hours.push(m);
    const showNow = date === todayStr() && nowMin >= from && nowMin <= to;
    const lines = (
      <>
        {hours.map((m) => <span key={m} className={styles.tlTick} style={{ left: pct(m) }} />)}
        {showNow && <span className={styles.tlNow} style={{ left: pct(nowMin) }} />}
      </>
    );
    return (
      <div className={styles.timeline}>
        <div className={styles.timelineInner} style={{ "--tl-ratio": Math.max(1, (to - from) / VIEW_MIN) }}>
        <div className={styles.tlRow}>
          <span className={styles.tlLabel} />
          <div className={styles.tlAxis}>
            {hours.map((m) => <span key={m} className={styles.tlTickLabel} style={{ left: pct(m) }}>{fmtMin(m)}</span>)}
          </div>
        </div>
        {rows.map((r) => (
          <div key={r.key} className={styles.tlRow}>
            <label className={styles.tlLabel}>
              <span>
                {r.label}
                {r.qty > 0 && r.endMin != null && <small className={styles.tlRange}> {fmtMin(r.startMin)}–{fmtMin(r.endMin)}</small>}
              </span>
              <input
                type="time" className={`${styles.input} ${styles.tlStart}`} title="시작 시각 (비우면 자동)"
                value={starts[r.key] || fmtMin(r.startMin)}
                onChange={(e) => changeStart(r.key, e.target.value)}
              />
            </label>
            <div className={styles.tlTrack} style={{ height: `${0.6 + r.lanes * 1.6}rem` }}>
              {lines}
              {r.qty > 0 && r.endMin != null && r.segs.length > 0 ? (
                r.segs.map((seg) => (
                  <span
                    key={seg.key}
                    {...dragProps(seg.key, seg.startMin)}
                    className={`${styles.tlBar} ${styles.tlDraggable} ${styles[r.color]} ${dragInfo?.key === seg.key ? styles.tlDragging : ""}`}
                    style={{
                      left: barLeft(seg.key, seg.startMin), width: `max(calc(${pct(seg.endMin)} - ${pct(seg.startMin)}), 3px)`,
                      top: `${0.3 + seg.lane * 1.6}rem`, height: "1.4rem", bottom: "auto",
                    }}
                    title={`${seg.label} ${fmtMin(seg.startMin)} → ${fmtMin(seg.endMin)} (끌어서 시작 시각 이동)`}
                  >
                    {seg.label}
                  </span>
                ))
              ) : r.qty > 0 && r.endMin != null ? (
                <span
                  {...dragProps(r.key, r.startMin)}
                  className={`${styles.tlBar} ${styles.tlDraggable} ${styles[r.color]} ${dragInfo?.key === r.key ? styles.tlDragging : ""}`}
                  style={{ left: barLeft(r.key, r.startMin), width: `max(calc(${pct(r.endMin)} - ${pct(r.startMin)}), 3px)` }}
                  title={`${r.label} ${fmtMin(r.startMin)} → ${fmtMin(r.endMin)} (끌어서 시작 시각 이동)`}
                >
                  {fmtMin(r.startMin)}–{fmtMin(r.endMin)}
                </span>
              ) : (
                <span className={styles.tlEmpty}>{r.qty > 0 ? "근무 인원 없음" : "수량 없음"}</span>
              )}
              {dragTip([r.key, ...r.segs.map((seg) => seg.key)])}
            </div>
          </div>
        ))}
        </div>
      </div>
    );
  };

  return (
    <div className={pageStyles.page}>
      <div className={pageStyles.pageHeader}>
        <div>
          <h2 className={pageStyles.title}>리드타임</h2>
          <p className={pageStyles.subtitle}>입고요청·출력차수 수량과 시간대별 근무 인원으로 포장·출고·송장붙이기·매칭작업 각각의 소요 시간 예상</p>
        </div>
        {headerExtra}
      </div>

      <div className={pageStyles.stack}>
        <section className={pageStyles.card}>
          <div className={pageStyles.cardHeader}>
            <h3 className={pageStyles.cardTitle}>예상 종료</h3>
            <div className={styles.controls}>
              <div className={styles.dateNav}>
                <button type="button" className={styles.dateArrow} aria-label="전날" onClick={() => setDate((v) => shiftDate(v, -1))}>◀</button>
                <input type="date" className={styles.input} value={date} onChange={(e) => setDate(e.target.value)} />
                <button type="button" className={styles.dateArrow} aria-label="다음날" onClick={() => setDate((v) => shiftDate(v, 1))}>▶</button>
              </div>
            </div>
          </div>
          <div className={styles.summary}>
            <div className={`${styles.summaryCell} ${styles.summaryMain}`}>
              {renderQtyInput("포장", "pack", packEdit, loadedPackQty, packQty)}
              {estimate ? renderEnd(estimate.packRes, packQty, "pack") : <span className={styles.endEmpty}>-</span>}
              {estimate?.packDetail ? (
                <div className={styles.breakdown}>
                  <ul className={styles.detailList}>
                    {renderDetailRow("대량", estimate.packDetail.bulk, "pack_bulk")}
                    {renderDetailRow("개별", estimate.packDetail.single, "pack_single")}
                    {renderDetailRow("대형", estimate.packDetail.big, "pack_big")}
                  </ul>
                  <span className={styles.muted}>
                    대량 → 개별 → 대형 순서로 이어서 포장한다고 보고 계산(항목 시작 시각을 직접 정하면 그 시각부터) · 대형 = 상품명이 숫자로 시작하는 상품(대형 처리 개수로 계산){packEdit !== null && packQty !== loadedPackQty ? " · 직접 입력한 개수는 불러온 대량:개별:대형 비율로 나눔" : ""}
                  </span>
                </div>
              ) : <span className={styles.muted}>포장에서 '반영하기'를 누르면 대량/개별 시간이 표시됩니다.</span>}
              <details className={styles.detail}>
                <summary>상세보기 (1인 1분 처리 개수)</summary>
                <div className={styles.rateGrid}>
                  {renderRateInput("pack", packRate, "대량·개별")}
                  {renderRateInput("pack_big", packBigRate, "대형")}
                </div>
              </details>
            </div>
            <div className={`${styles.summaryCell} ${styles.summaryMain}`}>
              {renderQtyInput("출고", "ship", shipEdit, loadedShipPieces, shipPieces)}
              {estimate ? renderEnd(estimate.shipRes, shipPieces, "ship") : <span className={styles.endEmpty}>-</span>}
              {estimate && loadedShipPieces > 0 ? (
                <div className={styles.breakdown}>
                  <ul className={styles.detailList}>
                    {renderDetailRow(`대량출고${estimate.shipDetail.bulk.big > 0 ? ` (대형 ${estimate.shipDetail.bulk.big}개 포함)` : ""}`, estimate.shipDetail.bulk, "ship_bulk")}
                    {renderDetailRow(`개별출고${estimate.shipDetail.single.big > 0 ? ` (대형 ${estimate.shipDetail.single.big}개 포함)` : ""}`, estimate.shipDetail.single, "ship_single")}
                    <li className={styles.detailRow}>
                      <span className={styles.detailLabel}>대형출고 {(estimate.shipDetail.bulk.big + estimate.shipDetail.single.big).toLocaleString()}개</span>
                      <span className={styles.muted}>대량 {estimate.shipDetail.bulk.big.toLocaleString()} + 개별 {estimate.shipDetail.single.big.toLocaleString()} (위 개수에 포함)</span>
                    </li>
                  </ul>
                  {joinBulk && (
                    <p className={styles.joinNote}>
                      {estimate.shipDetail.joined
                        ? `개별출고가 ${fmtMin(estimate.shipDetail.joined.fromMin)}에 끝나 그 인원이 대량출고에 합류${estimate.shipDetail.joined.savedMin == null ? " (대량출고 인원 없음 → 합류 인원만으로 진행)" : ` → 대량출고 ${fmtDuration(estimate.shipDetail.joined.savedMin)} 단축`}`
                        : "합류 설정 켬 · 개별출고가 대량출고보다 먼저 끝나지 않아 적용되지 않음"}
                    </p>
                  )}
                  <span className={styles.muted}>
                    대량 = 본송장+재고송장 대량 {loadedShipParts.bulk.toLocaleString()}개 · 개별 = 나머지(개별+합포) {loadedShipParts.single.toLocaleString()}개 (송장 수 기준){loadedShipBig > 0 ? ` · 그중 대형 ${loadedShipBig.toLocaleString()}개는 대형 처리 개수로 계산` : ""}
                    <br />
                    대량출고와 개별출고는 동시에 진행하는 것으로 보고 각자 계산, 전체는 늦게 끝나는 쪽 기준{shipEdit !== null && shipPieces !== loadedShipPieces ? " · 직접 입력한 개수는 불러온 비율로 나눔" : ""}
                  </span>
                </div>
              ) : <span className={styles.muted}>출고에서 '반영하기'를 누르면 대량/개별 시간이 표시됩니다.</span>}
              <details className={styles.detail}>
                <summary>상세보기 (인원 · 1인 1분 처리 개수 · 합류)</summary>
                <div className={styles.rateGrid}>
                  {renderRateInput("ship_bulk", shipBulkRate, "대량출고", { value: shipBulkHead })}
                  {renderRateInput("ship_single", shipSingleRate, "개별출고", { value: shipSingleHead })}
                  {renderRateInput("ship_big", shipBigRate, "대형 상품 (대량·개별 안에서)")}
                </div>
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
            <div className={`${styles.summaryCell} ${styles.summaryMain}`}>
              {renderQtyInput("송장붙이기", "invoice", invoiceEdit, loadedInvoiceQty, invoiceQty)}
              {estimate ? renderEnd(estimate.invoiceRes, invoiceQty, "invoice") : <span className={styles.endEmpty}>-</span>}
              {estimate && loadedInvoiceQty > 0 ? (
                <div className={styles.breakdown}>
                  <ul className={styles.detailList}>
                    {renderDetailRow("본송장", estimate.invoiceDetail.main, "invoice_main")}
                    {renderDetailRow("재고송장", estimate.invoiceDetail.stock, "invoice_stock")}
                  </ul>
                  <span className={styles.muted}>
                    출고에서 본송장으로 지정한 차수 {loadedInvoices.main.toLocaleString()}장 · 재고송장으로 지정한 차수 {loadedInvoices.stock.toLocaleString()}장 (주문 1건 = 송장 1장)
                    <br />
                    본송장과 재고송장은 동시에 진행하는 것으로 보고 각자 계산, 전체는 늦게 끝나는 쪽 기준{invoiceEdit !== null && invoiceQty !== loadedInvoiceQty ? " · 직접 입력한 개수는 불러온 비율로 나눔" : ""}
                  </span>
                </div>
              ) : <span className={styles.muted}>출고에서 '반영하기'를 누르면 본송장/재고송장 시간이 표시됩니다.</span>}
              <details className={styles.detail}>
                <summary>상세보기 (인원 · 1인 1분 처리 개수)</summary>
                <div className={styles.rateGrid}>
                  {renderRateInput("invoice_main", invoiceMainRate, "본송장", { value: invoiceMainHead })}
                  {renderRateInput("invoice_stock", invoiceStockRate, "재고송장", { value: invoiceStockHead })}
                </div>
                <span className={styles.muted}>인원을 비우면(자동) 시간대별 근무 인원을 따르고, 숫자를 넣으면 근무 시간대마다 그 인원이 일합니다. 시작 시각은 눌러서 바꿀 수 있습니다(기본: 첫 근무 시간대).</span>
              </details>
            </div>
            <div className={`${styles.summaryCell} ${styles.summaryMain}`}>
              {renderQtyInput("매칭작업", "match", matchEdit, loadedMatchQty, matchQty)}
              {estimate ? renderEnd(estimate.matchRes, matchQty, "match") : <span className={styles.endEmpty}>-</span>}
              {estimate && (
                <div className={styles.breakdown}>
                  <ul className={styles.detailList}>
                    {MATCH_PARTS.map(([k, label]) => <Fragment key={k}>{renderDetailRow(label, estimate.matchDetail[k], k)}</Fragment>)}
                  </ul>
                  <span className={styles.muted}>
                    재고매칭(대량제외) = 재고송장 차수의 개별 송장 수(대량·합포 제외) · KRL매칭 = 본송장 중 상품명이 K·R·L로 시작하는 상품이 든 송장 수(재고송장 제외) · 합포빼기 = 본송장+재고송장 합포의 상품 개수
                    <br />
                    세 항목은 동시에 진행하는 것으로 보고 각자 인원·1분 처리 개수로 계산, 전체는 늦게 끝나는 쪽 기준{matchEdit !== null && matchQty !== loadedMatchQty ? " · 직접 입력한 개수는 불러온 비율로 나눔" : ""}
                  </span>
                </div>
              )}
              <details className={styles.detail}>
                <summary>상세보기 (KRL 수량 · 인원 · 1인 1분 처리 개수)</summary>
                <ul className={styles.detailList}>
                  {["K", "R", "L"].map((c) => (
                    <li key={c} className={styles.detailRow}>
                      <span className={styles.detailLabel}>{c}매칭</span>
                      <span>{(ship?.totals?.main?.krl?.[c] || 0).toLocaleString()}개</span>
                    </li>
                  ))}
                </ul>
                <div className={styles.rateGrid}>
                  {MATCH_PARTS.map(([k, label]) => <Fragment key={k}>{renderRateInput(k, matchRates[k], label, { value: matchHeads[k] })}</Fragment>)}
                </div>
                <span className={styles.muted}>인원을 비우면(자동) 시간대별 근무 인원을 따르고, 숫자를 넣으면 근무 시간대마다 그 인원이 일합니다. 시작 시각은 눌러서 바꿀 수 있습니다(기본: 첫 근무 시간대).</span>
              </details>
            </div>
          </div>
          <div className={styles.timelineHead}>
            <button type="button" className={pageStyles.secondaryBtn} onClick={() => setTimelineOpen((v) => (v === "1" ? "0" : "1"))}>
              {timelineOpen === "1" ? "시간표 닫기 ▲" : "시간표 열기 ▼"}
            </button>
          </div>
          {timelineOpen === "1" && renderTimeline()}
          {message && <div className={pageStyles.statusMsg}>{message}</div>}
        </section>

        <section className={pageStyles.card}>
          <div className={pageStyles.cardHeader}>
            <h3 className={pageStyles.cardTitle}>시간대별 근무 인원</h3>
            <span className={styles.muted}>포장 근무 인원 · 관리페이지 근무표(백, 오전 출근)의 예정 인원이 기본, 칸을 수정하면 바로 이 날짜에 저장 (비우면 예정 인원으로 복귀) · 대량/개별출고 인원은 출고 박스에서 설정</span>
            <button
              type="button"
              className={pageStyles.secondaryBtn}
              onClick={() => refreshHeadcount(true)}
              disabled={headcountLoading}
            >
              {headcountLoading ? "불러오는 중..." : "근무표 다시 불러오기"}
            </button>
          </div>
          {scheduleError && (
            <div className={pageStyles.statusMsg}>관리페이지 근무표를 못 불러와 예전 근무표로 계산했습니다 ({scheduleError})</div>
          )}
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
                <button type="button" className={styles.slotNamesToggle} onClick={() => setShowNames((v) => !v)}>
                  {showNames ? "닫기 ▲" : "열기 ▼"}
                </button>
                {showNames && (
                  <ul className={styles.slotNames}>
                    {(s.names || []).length > 0
                      ? s.names.map((name, i) => (
                        <li key={`${name}-${i}`} className={styles.nameChip}>
                          {name}
                        </li>
                      ))
                      : <li className={styles.slotNote}>근무표 인원 없음</li>}
                  </ul>
                )}
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
                <button
                  className={`${pageStyles.secondaryBtn} ${busy === "pack" ? styles.applyBusy : ""}`}
                  onClick={() => runLoad("pack")}
                  disabled={Boolean(busy)}
                  title="입고요청 전표를 이지어드민에서 불러와 포장 수량에 반영합니다"
                >
                  {busy === "pack" ? <><span className={styles.busyDot} />반영 중...</> : "반영하기"}
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
              {!pack && <div className={styles.muted}>'반영하기'를 누르면 표시됩니다.</div>}
              {pack && packTab === "big" && (
                <>
                  <p className={styles.muted}>
                    상품명이 숫자로 시작하는 상품 · 대량 전표에서 {(pack.big?.from_bulk || 0).toLocaleString()}개, 개별 전표에서 {(pack.big?.from_single || 0).toLocaleString()}개를 빼서 따로 계산합니다.
                  </p>
                  <ul className={styles.list}>
                    {!(pack.big?.items || []).length && <li className={styles.muted}>{pack.big ? "대형 상품이 없습니다." : "포장에서 '반영하기'를 다시 누르면 대형이 표시됩니다."}</li>}
                    {(pack.big?.items || []).map((it) => (
                      <li key={`${it.name}|${it.option}`} className={styles.listRow}>
                        <span>{it.name}{it.option && <span className={styles.muted}> {it.option}</span>}</span>
                        <span>{it.qty.toLocaleString()}개</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {pack && packTab !== "unchecked" && packTab !== "big" && (
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
                    {(pack.unchecked?.vouchers || []).map((v) => (
                        <li key={`u-${v.sheet}`} className={styles.listRow}>
                          <span>{v.name}</span>
                          <span>{v.total.toLocaleString()}개</span>
                        </li>
                      ))}
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
                  <span className={styles.muted}>추가한 거래처는 다음 '반영하기'부터 적용됩니다.</span>
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
                  {busy === "numbers" ? "조회 중..." : showAssign ? "본송장,재고송장 지정 닫기" : "본송장,재고송장 지정"}
                </button>
                <button
                  className={`${pageStyles.secondaryBtn} ${busy === "ship" ? styles.applyBusy : ""}`}
                  onClick={() => runLoad("ship")}
                  disabled={Boolean(busy)}
                  title="지정한 출력차수 주문을 이지어드민에서 불러와 출고·송장 수량에 반영합니다 (새 차수만 읽음)"
                >
                  {busy === "ship" ? <><span className={styles.busyDot} />반영 중...</> : "반영하기"}
                </button>
                <button
                  className={pageStyles.secondaryBtn}
                  onClick={() => runLoad("ship", true)}
                  disabled={Boolean(busy)}
                  title="이미 읽어 둔 출력차수도 이지어드민에서 전부 다시 읽습니다 (차수당 약 25초)"
                >
                  전부 다시 읽기
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
                    {t.label} {(ship?.totals?.[invoiceTab]?.[t.key]?.orders || 0).toLocaleString()}개
                  </button>
                ))}
              </div>
              {!ship && <div className={styles.muted}>'반영하기'를 누르면 표시됩니다.</div>}
              {ship && (
                <>
                  <div className={styles.bigNumber}>
                    송장 {(ship.totals?.[invoiceTab]?.[shipTab]?.orders || 0).toLocaleString()}개
                    <span className={styles.muted}> · 상품 {(ship.totals?.[invoiceTab]?.[shipTab]?.pieces || 0).toLocaleString()}개</span>
                  </div>
                  <ul className={styles.list}>
                    {ship.per_number.filter((n) => n.kind === invoiceTab).map((n) => (
                      <li key={n.print_num} className={styles.listRow}>
                        <span>{n.print_num}차</span>
                        <span>{(n[shipTab]?.orders || 0).toLocaleString()}개</span>
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
