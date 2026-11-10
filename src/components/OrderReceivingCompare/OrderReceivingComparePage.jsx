import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays, ChevronDown, ChevronRight, MessageCircle, PackageCheck, PackageMinus, Pencil, Trash2, Wallet } from "lucide-react";
import styles from "./OrderReceivingCompare.module.css";
import { LOCAL_API_BASE as API, getAuthHeaders } from "../../lib/api";
import { clientDeduction } from "../../lib/soDeduct";
import { DatePicker, DateRangePicker } from "./DatePicker";
import SoCsModal from "./SoCsModal";
import SoDashboard from "./SoDashboard";
import ClientHistoryModal from "./ClientHistoryModal";
import { loadInquiryStats, getMalignantSnapshot, onMalignantSnapshot, normCode } from "../../lib/csFollow";

const csTime = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : `${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

const NEED_SESSION_MSG = "이지어드민 세션이 없거나 만료되었습니다. 바코드 탭에서 세션을 다시 입력하세요.";

const pad2 = (n) => String(n).padStart(2, "0");
const fmt = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const shiftDay = (dateStr, days) => {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + days);
  return fmt(d);
};
const todayStr = () => fmt(new Date());
async function api(path, options) {
  const res = await fetch(`${API}/order-receiving${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...getAuthHeaders(), ...(options?.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.detail || "요청에 실패했습니다.");
  return data;
}

// 상세 목록 구분(우선순위 순): 입고전부옴 > 일부옴 > 안옴 > 미송잡힘 > 미송일부 > 미송픽업 > 발주없는 입고
// 불 색: 전부옴=초록, 일부옴=노랑, 안옴=빨강, 발주없는데 온 것=보라 (미송/미송픽업은 파랑/주황)
// 파스텔 톤 팔레트: dot=불/막대, bg=배경, fg=글자
const TONES = {
  green: { key: "green", dot: "#7ccfa0", bg: "#e3f6ec", fg: "#2f7d57" },
  yellow: { key: "yellow", dot: "#f3d47a", bg: "#fdf4d6", fg: "#8a6a12" },
  red: { key: "red", dot: "#f2a0a0", bg: "#fde8e8", fg: "#b04a50" },
  purple: { key: "purple", dot: "#bba3ea", bg: "#efe8fb", fg: "#6d4fb3" },
  blue: { key: "blue", dot: "#8dbcf2", bg: "#e4effd", fg: "#3b6fb5" },
  sky: { key: "sky", dot: "#bcd7f6", bg: "#eef5fd", fg: "#5b84b8" },
  orange: { key: "orange", dot: "#f5bd8c", bg: "#fdeedd", fg: "#a8641f" },
  grey: { key: "grey", dot: "#cdd5e1", bg: "#eef1f6", fg: "#7b8aa6" },
  cyan: { key: "cyan", dot: "#5fc6d4", bg: "#dcf4f8", fg: "#0c7487" },
};
const RANKS = [
  { key: "full", label: "전량 입고", tone: TONES.green },
  { key: "partial", label: "일부 입고", tone: TONES.yellow },
  { key: "missing", label: "미입고", tone: TONES.red },
  { key: "misong", label: "미송 잡힘", tone: TONES.blue },
  { key: "misong_part", label: "미송 일부만 잡힘", tone: TONES.sky },
  { key: "pickup", label: "미송픽업", tone: TONES.orange },
  { key: "other", label: "미발주 입고", tone: TONES.purple },
];
const RANK_INDEX = Object.fromEntries(RANKS.map((r, i) => [r.key, i]));

function rankOf(i) {
  if (i.ordered > 0) {
    if (i.received >= i.ordered) return "full";
    if (i.received > 0) return "partial";
    if (i.misong <= 0) return "missing";
    return i.misong >= i.ordered ? "misong" : "misong_part";
  }
  if (i.ordered_pickup > 0 || i.pickup > 0) return "pickup";
  return "other";
}

// 미송픽업은 발주 대비 전부 오면 초록, 일부만 오면 노랑, 안 오면 빨강
function pickupTone(i) {
  if (i.pickup >= i.ordered_pickup && i.pickup > 0) return TONES.green;
  if (i.pickup > 0) return TONES.yellow;
  return TONES.red;
}

// 세부목록 표시용 줄 나누기 (데이터는 상품코드당 한 줄 그대로, 화면에서만 나눈다)
//  - main:   일반입고·미송 (발주 / 입고 / 미송, 금액)
//  - pickup: 미송픽업 (같은 상품코드라도 별도 줄, 0원)
//  - deduct: 예전 매칭처럼 상품 줄에 붙어 있던 매입차감을 별도 '매입차감' 줄로 (새 매칭은 서버에서 DEDUCT- 줄로 따로 만든다)
const isExtraRow = (i) => /^(DEDUCT|FEE)-/.test(String(i.code));
function splitRows(items) {
  const rows = [];
  items.forEach((i) => {
    if (isExtraRow(i)) { rows.push({ ...i, _part: "extra", _src: i }); return; }
    const hasMain = (i.ordered || 0) + (i.received || 0) + (i.misong || 0) + (i.exchange || 0) > 0;
    const hasPickup = (i.ordered_pickup || 0) + (i.pickup || 0) > 0;
    if (hasMain || !hasPickup) {
      const r = { ...i, ordered_pickup: 0, pickup: 0, deduct: 0, _part: "main", _src: i, _solo: !hasPickup };
      rows.push({ ...r, _rank: RANK_INDEX[rankOf(r)] });
    }
    if (hasPickup) {
      const r = { ...i, ordered: 0, received: 0, misong: 0, amount: 0, ordered_amount: 0, deduct: 0, _part: "pickup", _src: i, _solo: !hasMain };
      rows.push({ ...r, _rank: RANK_INDEX.pickup });
    }
    if ((Number(i.deduct) || 0) < 0) {
      rows.push({
        code: `${i.code}#deduct`, name: "매입차감", option: "", client: i.client,
        ordered: 0, ordered_pickup: 0, received: 0, misong: 0, pickup: 0, amount: 0, ordered_amount: 0, cost: 0,
        deduct: i.deduct, _part: "legacy_deduct", _src: i, _rank: RANK_INDEX.other,
      });
    }
  });
  return rows;
}

// 핵심 표시: 입고 N / 발주 M + 진행 막대 + 모자란 개수(빨강) / 초과(보라)
function Count({ item }) {
  if (item._part === "pickup") {
    // 미송픽업 줄: 미송픽업 입고 / 미송픽업 발주
    const tone = pickupTone(item);
    const pct = item.ordered_pickup > 0 ? Math.min(100, Math.round((item.pickup / item.ordered_pickup) * 100)) : 100;
    const lack = item.ordered_pickup - item.pickup;
    return (
      <span className={styles.count}>
        <span className={styles.big} style={{ color: tone.fg }}>{item.pickup}</span>
        <span className={styles.of}>/ {item.ordered_pickup}</span>
        <span className={styles.bar}><span style={{ width: `${pct}%`, background: tone.dot }} /></span>
        {lack > 0 && <span className={styles.lack}>{lack}개 안 옴</span>}
        {lack === 0 && item.ordered_pickup > 0 && <span className={styles.done}>완료</span>}
        {lack < 0 && <span className={styles.extra}>+{-lack} 초과</span>}
      </span>
    );
  }
  const { ordered, received } = item;
  if (!ordered && !received) return <span className={styles.muted}>-</span>;
  const tone = RANKS[item._rank].tone;
  const pct = ordered > 0 ? Math.min(100, Math.round((received / ordered) * 100)) : 100;
  const lack = ordered - received;
  return (
    <span className={styles.count}>
      <span className={styles.big} style={{ color: tone.fg }}>{received}</span>
      <span className={styles.of}>/ {ordered}</span>
      <span className={styles.bar}><span style={{ width: `${pct}%`, background: tone.dot }} /></span>
      {lack > 0 && <span className={styles.lack}>{lack}개 안 옴</span>}
      {lack === 0 && ordered > 0 && <span className={styles.done}>완료</span>}
      {lack < 0 && <span className={styles.extra}>+{-lack} 초과</span>}
    </span>
  );
}

function Dot({ item }) {
  const r = RANKS[item._rank];
  const tone = r.key === "pickup" ? pickupTone(item) : r.tone;
  const label = r.key === "pickup"
    ? `미송픽업 ${item.pickup}/${item.ordered_pickup} ${tone.key === "green" ? "전부 옴" : tone.key === "yellow" ? "일부 옴" : "안 옴"}`
    : r.label;
  return <span className={styles.dot} style={{ background: tone.dot }} title={label} aria-label={label} />;
}

// 필터(다중 선택): 하나라도 해당되면 포함. metric은 거래처 자동 정렬 기준.
// C/S 오래된 정도(시간): 가장 오래된 문의/지연 주문 기준, C/S 가 없으면 0
const csAgeHours = (cs) => {
  const t = cs?.oldest ? Date.parse(cs.oldest) : NaN;
  return Number.isNaN(t) ? 0 : Math.max(0, (Date.now() - t) / 36e5);
};
const FILTERS = [
  { key: "cs", label: "C/S", tone: TONES.cyan, hint: "C/S 많은 순", test: (i) => (i.cs?.total || 0) > 0, metric: (i) => i.cs?.total || 0 },
  { key: "received", label: "입고 목록", tone: TONES.green, hint: "입고 많은 순", test: (i) => i.received > 0, metric: (i) => i.received },
  { key: "partial", label: "일부입고", tone: TONES.yellow, hint: "입고 많은 순", test: (i) => i.ordered > 0 && i.received > 0 && i.received < i.ordered, metric: (i) => i.received },
  { key: "missing", label: "미입고 목록", tone: TONES.red, hint: "미입고 많은 순", test: (i) => i.ordered > 0 && i.received < i.ordered, metric: (i) => Math.max(i.ordered - i.received - i.misong, 0) },
  { key: "misong", label: "미송", tone: TONES.blue, hint: "미송 많이 잡힌 순", test: (i) => i.misong > 0, metric: (i) => i.misong },
  { key: "pickup", label: "미송픽업", tone: TONES.orange, hint: "미송픽업 많이 온 순", test: (i) => i.ordered_pickup > 0 || i.pickup > 0, metric: (i) => i.pickup },
  { key: "other", label: "발주없는 입고", tone: TONES.purple, hint: "입고 많은 순", test: (i) => rankOf(i) === "other", metric: (i) => i.received },
];

const won = (n) => `${Math.round(Number(n) || 0).toLocaleString("ko-KR")}원`;
const costOf = (i) => Number(i.cost) || 0;
// 금액 계산 대상은 일반입고 + 미송 두 가지뿐. 미송픽업은 0원으로 처리한다.
const amountQty = (i) => (i.received || 0) + (i.misong || 0);
const amountOf = (i) => (i.amount != null ? Number(i.amount) : amountQty(i) * costOf(i));
const orderedAmountOf = (i) => (i.ordered_amount != null ? Number(i.ordered_amount) : (i.ordered || 0) * costOf(i));
const VAT_RATE = 0.1; // 부가세 거래처는 합산 금액에 10% 추가 (부가세 표시는 세부목록에서만)
const withVat = (supply, vat) => supply + (vat ? Math.round(supply * VAT_RATE) : 0);

// 정렬 기준: 거래처 순서는 항목 지표의 합 기준. 같은 구분 안의 상품 순서도 이 지표를 따른다.
const SORTS = [
  { key: "auto", label: "자동 (선택한 필터 기준)" },
  { key: "cs_many", label: "C/S 많은 순", metric: (i) => i.cs?.total || 0 },
  { key: "cs_old", label: "C/S 오래된 순", agg: "max", metric: (i) => csAgeHours(i.cs) },
  { key: "received", label: "입고 많은 순", metric: (i) => i.received },
  { key: "missing", label: "미입고 많은 순", metric: (i) => Math.max(i.ordered - i.received - i.misong, 0) },
  { key: "ordered", label: "발주 많은 순", metric: (i) => i.ordered },
  { key: "misong", label: "미송 많이 잡힌 순", metric: (i) => i.misong },
  { key: "pickup", label: "미송픽업 많이 온 순", metric: (i) => i.pickup },
  { key: "amount_received", label: "입고 금액 높은 순", metric: (i) => amountOf(i) },
  { key: "amount_missing", label: "미입고 금액 높은 순", metric: (i) => Math.max(i.ordered - i.received - i.misong, 0) * costOf(i) },
  { key: "name", label: "거래처명 가나다순" },
];

// N/N 배지 톤: 전부 왔으면 초록, 일부면 노랑, 하나도 안 왔으면 빨강, 발주 없이 왔으면 보라
function ratioTone(got, total) {
  if (total <= 0) return got > 0 ? TONES.purple : TONES.grey;
  if (got >= total) return TONES.green;
  if (got > 0) return TONES.yellow;
  return TONES.red;
}

// 거래처 요약 불
function ClientDot({ t }) {
  const tone = ratioTone(t.received, t.ordered);
  const label = t.ordered <= 0 ? "미발주 입고" : tone.key === "green" ? "전량 입고" : tone.key === "yellow" ? `일부 입고 (${t.received}/${t.ordered})` : "미입고 (하나도 안 옴)";
  return <span className={styles.dot} style={{ background: tone.dot, marginLeft: "0.4rem" }} title={label} aria-label={label} />;
}

// 요약 알약: [●] 라벨  N/N  + 얇은 진행 막대
function Ratio({ label, got, total, tone, title, noBar }) {
  const pct = total > 0 ? Math.min(100, Math.round((got / total) * 100)) : (got > 0 ? 100 : 0);
  return (
    <span className={styles.ratio} style={{ background: tone.bg, color: tone.fg }} title={title}>
      <span className={styles.ratioDot} style={{ background: tone.dot }} />
      <span className={styles.ratioLabel}>{label}</span>
      <b className={styles.ratioNum}>{got}{total !== undefined && <span className={styles.ratioOf}>/{total}</span>}</b>
      {!noBar && total !== undefined && <span className={styles.ratioBar}><span style={{ width: `${pct}%`, background: tone.dot }} /></span>}
    </span>
  );
}

// C/S 건수: 상품별 문의(진행 중) + 악성지연 주문. 옵션(상품코드) 단위로 센다.
function CsChip({ item, onOpen }) {
  const c = item.cs;
  if (!c || !c.total) return null;
  // 세부 내역은 마우스를 올렸을 때만 보인다
  const title = `문의 ${c.inq}건${c.wait ? ` (미답변 ${c.wait})` : ""} · 악성지연 주문 ${c.delay}건${c.delayQty ? ` (수량 ${c.delayQty}개)` : ""}`;
  return (
    <button type="button" className={styles.csBadge} title={`${title} · 눌러서 보기`} onClick={onOpen}>
      <MessageCircle size={12} strokeWidth={2.4} />
      <b>{c.total}</b>
    </button>
  );
}

function ResultView({ result: rawResult, cs, onOpenCs, lookupSlot, editable, onEditItem, onDeleteItem, onAddProduct, onAddDeduct, onAddFee, onEditVat, onJanggiCheck, noHist }) {
  const [picked, setPicked] = useState(new Set()); // 비어 있으면 전체
  const [histClient, setHistClient] = useState(null); // 거래처 옆 달력 뱃지로 연 일자별 매칭
  const [expanded, setExpanded] = useState(new Set()); // 기본: 전부 닫힘
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState(noHist ? "name" : "missing"); // 기본: 미입고가 상단 (거래처별 일자 창은 날짜순)

  // 각 상품 줄에 C/S 정보 붙이기 (원가베이스 상품코드 기준)
  const result = useMemo(() => {
    if (!rawResult) return rawResult;
    const csOf = (code) => {
      const key = normCode(code);
      const a = cs?.inq?.[key];
      const b = cs?.delay?.[key];
      const inq = a?.count || 0;
      const delay = b?.orders || 0;
      const oldest = !a?.oldest ? (b?.oldest || "") : (!b?.oldest ? a.oldest : (a.oldest < b.oldest ? a.oldest : b.oldest));
      return { inq, wait: a?.waiting || 0, delay, delayQty: b?.qty || 0, total: inq + delay, oldest };
    };
    return { ...rawResult, clients: (rawResult.clients || []).map((c) => ({ ...c, items: c.items.map((i) => ({ ...i, cs: csOf(i.code) })) })) };
  }, [rawResult, cs]);

  const toggleFilter = (key) => setPicked((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const tokens = useMemo(() => {
    const norm = (v) => String(v || "").toLowerCase().replace(/\s+/g, "");
    return search.trim().split(/\s+/).map(norm).filter(Boolean);
  }, [search]);

  const clients = useMemo(() => {
    const active = FILTERS.filter((f) => picked.has(f.key));
    const sortDef = SORTS.find((x) => x.key === sortKey);
    const metrics = sortDef?.metric
      ? [sortDef.metric]
      : (active.length ? active.map((f) => f.metric) : [(i) => i.received]);
    // 검색: 공백으로 나눈 단어가 모두 (거래처 + 상품명 + 옵션) 안에 있으면 매칭.
    //  - 단어가 전부 거래처명에 있으면 → 그 거래처의 목록을 전부 보여줌
    //  - 아니면 → 해당 상품만 보여줌 (예: "노다 그레이시진청" = 거래처 노다 + 옵션 그레이시진청)
    const norm = (v) => String(v || "").toLowerCase().replace(/\s+/g, "");
    // 미입고 기준 정렬이면 거래처 안에서도 미입고 → 일부입고 → 미송 … → 전량입고 순으로 미입고가 위로 온다.
    const missingFirst = sortKey === "missing" || sortKey === "amount_missing";
    const csFirst = sortKey === "cs_many" || sortKey === "cs_old";
    const rankPos = missingFirst ? [6, 1, 0, 3, 2, 4, 5] : [0, 1, 2, 3, 4, 5, 6];
    const out = (result?.clients || []).map((c) => {
      const clientAll = tokens.length > 0 && tokens.every((t) => norm(c.client).includes(t));
      const itemMetric = (i) => metrics.reduce((s, m) => s + m(i), 0);
      const items = c.items
        .filter((i) => !tokens.length || clientAll || tokens.every((t) => norm(`${c.client}${i.name}${i.option}`).includes(t)))
        .filter((i) => !active.length || active.some((f) => f.test(i)))
        .map((i) => ({ ...i, _rank: RANK_INDEX[rankOf(i)] }))
        .sort((a, b) => (csFirst ? 0 : rankPos[a._rank] - rankPos[b._rank]) || itemMetric(b) - itemMetric(a) || b.received - a.received);
      const score = sortDef?.agg === "max"
        ? items.reduce((m, i) => Math.max(m, itemMetric(i)), 0)
        : items.reduce((sum, i) => sum + itemMetric(i), 0);
      const sum = (k) => items.reduce((s, i) => s + (i[k] || 0), 0);
      const totals = {
        ordered: sum("ordered"), received: sum("received"), misong: sum("misong"),
        ordered_pickup: sum("ordered_pickup"), pickup: sum("pickup"),
        orderedAmt: items.reduce((s, i) => s + orderedAmountOf(i), 0),
        receivedAmt: items.reduce((s, i) => s + amountOf(i), 0),
      };
      totals.vatAmt = c.vat_override != null ? c.vat_override : c.vat ? Math.round(totals.receivedAmt * VAT_RATE) : 0;
      // 매입차감: 요청메모의 음수 금액. 상품금액(+부가세)을 넘으면 넘는 만큼은 "남음"으로 따로 표시
      const dd = clientDeduction(items, totals.receivedAmt, c.vat);
      totals.deductRaw = dd.raw;
      totals.deduct = dd.applied;
      totals.deductLeft = dd.leftover;
      totals.receivedTotal = totals.receivedAmt + totals.vatAmt - totals.deduct;
      totals.orderedTotal = withVat(totals.orderedAmt, c.vat);
      return { ...c, items, score, totals };
    }).filter((c) => c.items.length);
    return out.sort((a, b) => (sortKey === "name"
      ? (noHist ? b.client.localeCompare(a.client, "ko") : a.client.localeCompare(b.client, "ko"))
      : b.score - a.score || a.client.localeCompare(b.client, "ko")));
  }, [result, picked, tokens, sortKey, noHist]);

  const toggleClient = (name) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(name)) next.delete(name); else next.add(name);
    return next;
  });
  const allOpen = clients.length > 0 && clients.every((c) => expanded.has(c.client));
  const toggleAllOpen = () => setExpanded(allOpen ? new Set() : new Set(clients.map((c) => c.client)));

  // 상단 요약 카드 / 필터 개수 (검색·필터와 무관한 전체 기준)
  const { overall, counts } = useMemo(() => {
    const o = { ordered: 0, received: 0, misong: 0, ordered_pickup: 0, pickup: 0, products: 0, orderedAmt: 0, receivedAmt: 0 };
    const cnt = Object.fromEntries(FILTERS.map((f) => [f.key, 0]));
    (result?.clients || []).forEach((c) => c.items.forEach((i) => {
      o.products += 1;
      ["ordered", "received", "misong", "ordered_pickup", "pickup"].forEach((k) => { o[k] += i[k] || 0; });
      o.orderedAmt += orderedAmountOf(i);
      o.receivedAmt += amountOf(i);
      FILTERS.forEach((f) => { if (f.test(i)) cnt[f.key] += 1; });
    }));
    (result?.clients || []).forEach((c) => {
      const supplyRecv = c.items.reduce((s, i) => s + amountOf(i), 0);
      const supplyOrd = c.items.reduce((s, i) => s + orderedAmountOf(i), 0);
      o.receivedAmt += (c.vat_override != null ? c.vat_override : withVat(supplyRecv, c.vat) - supplyRecv) - clientDeduction(c.items, supplyRecv, c.vat).applied;
      o.orderedAmt += withVat(supplyOrd, c.vat) - supplyOrd;
    });
    cnt.all = o.products;
    return { overall: o, counts: cnt };
  }, [result]);
  const lackTotal = Math.max(overall.ordered - overall.received, 0);
  const rate = overall.ordered > 0 ? Math.round((overall.received / overall.ordered) * 100) : 0;

  const sortHint = sortKey !== "auto"
    ? SORTS.find((x) => x.key === sortKey)?.label
    : (picked.size ? FILTERS.filter((f) => picked.has(f.key)).map((f) => f.hint).join(" + ") : "입고 많이 온 순");

  return (
    <>
      <div className={styles.stats}>
        <div className={styles.stat}>
          <span className={`${styles.statIcon} ${styles.siGreen}`}><PackageCheck size={18} /></span>
          <div>
            <div className={styles.statLabel}>입고 / 발주</div>
            <div className={styles.statNum}>{overall.received}<span className={styles.statSlash}> / {overall.ordered}</span></div>
            <div className={`${styles.statSub} ${styles.up}`}>입고율 {rate}% · 상품 {overall.products}종</div>
          </div>
        </div>
        <div className={styles.stat}>
          <span className={`${styles.statIcon} ${styles.siRed}`}><PackageMinus size={18} /></span>
          <div><div className={styles.statLabel}>미입고</div><div className={styles.statNum}>{lackTotal}</div><div className={styles.statSub}>발주 − 입고</div></div>
        </div>
        <div className={`${styles.stat} ${styles.statDuo}`}>
          <div className={styles.duoCol}>
            <div className={styles.duoLabel} style={{ color: TONES.blue.fg }}>미송</div>
            <div className={styles.duoNum} style={{ color: TONES.blue.fg }}>{overall.misong}<span className={styles.duoUnit}>개</span></div>
          </div>
          <span className={styles.duoSep} />
          <div className={styles.duoCol}>
            <div className={styles.duoLabel} style={{ color: TONES.orange.fg }}>미송픽업</div>
            <div className={styles.duoNum} style={{ color: TONES.orange.fg }}>
              {overall.pickup}<span className={styles.duoUnit}>개</span>
              {overall.ordered_pickup > 0 && <span className={styles.duoOf}> / {overall.ordered_pickup}</span>}
            </div>
          </div>
        </div>
        <div className={`${styles.stat} ${styles.statMoney}`}>
          <span className={`${styles.statIcon} ${styles.siBlue}`}><Wallet size={18} /></span>
          <div>
            <div className={styles.statLabel}>총 합산 금액 (입고+미송, 부가세 포함)</div>
            <div className={styles.statNum}>{won(overall.receivedAmt)}</div>
            <div className={styles.statSub}>발주 {won(overall.orderedAmt)} · 미송픽업 제외</div>
          </div>
        </div>
      </div>
      {lookupSlot}
      <section className={styles.panel}>
      <div className={styles.result}>
      <div className={styles.legend}>
        {[0, 1, 2, 6].map((i) => (
          <span key={i}><span className={styles.dot} style={{ background: RANKS[i].tone.dot }} /> {RANKS[i].label}</span>
        ))}
      </div>
      {(cs?.inqError || !cs?.delayAt) && (
        <div className={styles.muted} style={{ marginBottom: "0.4rem" }}>
          {cs?.inqError ? `C/S 문의를 읽지 못했어요: ${cs.inqError}` : "악성지연 건수는 C/S > 악성지연 메뉴를 한 번 열면 반영돼요"}
        </div>
      )}
      <div className={styles.actions}>
        <input
          className={styles.text}
          type="search"
          placeholder="거래처 / 상품명 / 옵션 검색"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select className={styles.sortSel} value={sortKey} onChange={(e) => setSortKey(e.target.value)} title="정렬 기준">
          {SORTS.map((x) => <option key={x.key} value={x.key}>정렬: {x.label}</option>)}
        </select>
        <button className={`${styles.btn} ${picked.size === 0 ? styles.btnPrimary : ""}`} onClick={() => setPicked(new Set())}>{picked.size === 0 ? "✓ " : ""}전체 ({counts.all})</button>
        {FILTERS.map((f) => (
          <button
            key={f.key}
            className={`${styles.fbtn} ${picked.has(f.key) ? styles.fbtnOn : (picked.size > 0 ? styles.fbtnDim : "")}`}
            aria-pressed={picked.has(f.key)}
            title={f.key === "cs"
              ? `문의 ${csTime(cs?.inqAt) || "-"} 기준 ${cs?.inqMatched ?? 0}건${cs?.inqUnmatched ? ` (원가베이스 미연결 ${cs.inqUnmatched}건 제외)` : ""} · 악성지연 ${cs?.delayAt ? `${csTime(cs.delayAt)} 기준 ${cs.delayTotal}건` : "미반영"}`
              : undefined}
            style={{ "--fbg": f.tone.bg, "--ffg": f.tone.fg, "--fdot": f.tone.dot }}
            onClick={() => toggleFilter(f.key)}
          >
            {picked.has(f.key) ? <span className={styles.fcheck}>✓</span> : <span className={styles.fdot} />}
            {f.label} ({counts[f.key]})
          </button>
        ))}
        <button className={styles.btn} onClick={toggleAllOpen}>{allOpen ? "전체 접기" : "전체 펼치기"}</button>
        <span className={styles.muted}>
          거래처 {clients.length}곳 · 정렬: {sortHint}
          {result?.unclassified?.length > 0 && ` · 상품코드 없는 전표 줄 ${result.unclassified.length}건`}
        </span>
        {editable && (
          <span style={{ marginLeft: "auto", display: "inline-flex", gap: "0.4rem" }}>
            <button className={styles.btn} onClick={onJanggiCheck} title="날짜별장끼정리 DB와 대조해 빠진 매입차감/상품이 있는지 확인">장끼 점검</button>
            <button className={styles.btn} onClick={onAddProduct} title="원가베이스유에서 검색해 상품 추가 (해당 거래처로 자동 배정)">+ 제품추가</button>
            <button className={styles.btn} onClick={onAddDeduct} title="거래처에 매입차감 금액 추가">+ 매입추가</button>
            <button className={styles.btn} onClick={onAddFee} title="택배비 같은 변수 항목을 이름과 금액으로 추가 (부가세 대상)">+ 항목추가</button>
          </span>
        )}
      </div>
      {clients.map((c) => {
        const open = tokens.length > 0 || expanded.has(c.client); // 검색 중에는 자동으로 펼침
        const t = c.totals;
        return (
          <div key={c.client} className={styles.client}>
            <button className={styles.clientHead} onClick={() => toggleClient(c.client)}>
              {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <b>{c.client}</b>
              {!noHist && <span
                role="button"
                tabIndex={0}
                className={styles.histBadge}
                title="과거 일자별 매칭 보기"
                onClick={(e) => { e.stopPropagation(); setHistClient(String(c.client).split(" · ")[0]); }}
                onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); setHistClient(String(c.client).split(" · ")[0]); } }}
              ><CalendarDays size={13} /></span>}
              <span className={styles.sumRow}>
                <Ratio label="입고" got={t.received} total={t.ordered} tone={ratioTone(t.received, t.ordered)} title="입고 / 발주" />
                <Ratio label="미송" got={t.misong} tone={t.misong > 0 ? TONES.blue : TONES.grey} title="전표에 미송으로 잡힌 수량" noBar />
                <Ratio label="미송픽업" got={t.pickup} total={t.ordered_pickup} tone={ratioTone(t.pickup, t.ordered_pickup)} title="미송픽업 입고 / 발주" />
              </span>
              <span className={styles.amount} title={`발주 금액 ${won(t.orderedTotal)}`}>{won(t.receivedTotal)}</span>
              <ClientDot t={t} />
            </button>
            {open && (
              <table className={styles.table}>
                <colgroup>
                  <col style={{ width: 30 }} /><col style={{ width: "24%" }} /><col style={{ width: "15%" }} /><col style={{ width: "13%" }} /><col style={{ width: "21%" }} /><col style={{ width: 100 }} /><col style={{ width: 140 }} /><col style={{ width: 86 }} />
                </colgroup>
                <thead>
                  <tr>
                    <th style={{ width: 28 }}></th><th>상품명</th><th>거래처상품명</th><th>옵션</th><th>입고 / 발주</th><th>C/S</th><th className={styles.numR}>금액</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {splitRows(c.items).map((i) => {
                    const src = i._src;
                    const isDeduct = i._part === "legacy_deduct" || (i._part === "extra" && String(i.code).startsWith("DEDUCT-"));
                    return (
                    <tr key={`${i.code}#${i._part}`} style={isDeduct ? { background: TONES.red.bg } : undefined}>
                      <td>{isDeduct ? <span className={styles.dot} style={{ background: TONES.red.dot }} title="매입차감" aria-label="매입차감" /> : <Dot item={i} />}</td>
                      <td>
                        {isDeduct ? <b style={{ color: TONES.red.fg }}>매입차감</b> : i.name}
                        {i._part === "main" && i.misong > 0 && (
                          <span className={styles.tag} style={{ background: TONES.blue.bg, color: TONES.blue.fg }} title="이 전표에 미송으로 잡힌 수량">미송 {i.misong}</span>
                        )}
                        {i._part === "pickup" && (
                          <span className={styles.tag} style={{ background: pickupTone(i).bg, color: pickupTone(i).fg }} title="미송픽업 입고/발주 (같은 상품코드의 미송픽업분)">
                            미송픽업 {i.pickup}/{i.ordered_pickup}
                          </span>
                        )}
                        {String(i.code).startsWith("FEE-") && (
                          <span className={styles.tag} style={{ background: TONES.orange.bg, color: TONES.orange.fg }} title="상품 외 추가 금액 (부가세 대상)">추가금액</span>
                        )}
                        {!isDeduct && i.edited && <span className={styles.tag} style={{ background: TONES.grey.bg, color: TONES.grey.fg }} title="직접 수정한 줄">수정됨</span>}
                        {i.from_janggi && <span className={styles.tag} style={{ background: TONES.grey.bg, color: TONES.grey.fg }} title="장끼정리 DB 점검에서 반영한 줄">장끼반영</span>}
                      </td>
                      <td className={styles.supName} title={isDeduct ? "" : i.supplier_name || ""}>{!isDeduct && i.supplier_name ? i.supplier_name : <span className={styles.muted}>-</span>}</td>
                      <td>{isDeduct ? "" : i.option}</td>
                      <td className={styles.num}>{isDeduct ? <span className={styles.muted}>-</span> : <Count item={i} />}</td>
                      <td>{!isDeduct && <CsChip item={i} onOpen={() => onOpenCs?.(i)} />}</td>
                      <td
                        className={styles.numR}
                        title={isDeduct ? "입고요청전표 요청메모의 음수 금액 / 직접 추가한 매입차감"
                          : i._part === "pickup" ? "미송픽업은 금액 0원"
                          : costOf(i) ? `원가 ${won(costOf(i))} × (입고 ${i.received} + 미송 ${i.misong}) · 미송픽업 제외` : "원가 없음"}
                      >
                        {isDeduct ? <span style={{ color: TONES.red.fg }}>{Number(i.deduct || 0).toLocaleString("ko-KR")}원</span>
                          : i._part === "pickup" ? <span className={styles.muted}>0원</span>
                          : String(i.code).startsWith("FEE-") ? won(amountOf(i))
                          : costOf(i) ? won(amountOf(i)) : <span className={styles.muted}>원가없음</span>}
                      </td>
                      <td className={styles.rowActions}>
                        {editable && i._part !== "legacy_deduct" && (
                          <>
                            <button className={styles.rowBtn} title="수정 (수량 변경 · 상품 변경)" onClick={() => onEditItem(c.client, src)}><Pencil size={14} /></button>
                            {/* 일반/미송 줄과 미송픽업 줄은 같은 상품 데이터라, 둘 다 있을 땐 일반 줄 삭제 = 상품 전체 삭제 */}
                            {(i._part !== "pickup" || i._solo) && (
                              <button
                                className={`${styles.rowBtn} ${styles.rowBtnDel}`}
                                title={i._part === "main" && !i._solo ? "삭제 (미송픽업 줄까지 상품 전체 삭제)" : "삭제"}
                                onClick={() => onDeleteItem(c.client, src)}
                              ><Trash2 size={14} /></button>
                            )}
                          </>
                        )}
                        {editable && i._part === "legacy_deduct" && (
                          <span className={styles.muted} style={{ fontSize: "0.72rem" }} title="예전 매칭 데이터라 상품 줄에 붙어 있는 차감입니다. 상품 수정 창에서 고치거나, 재매칭하면 별도 매입차감 줄로 저장됩니다.">상품연동</span>
                        )}
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className={styles.totalRow}>
                    <td></td>
                    <td colSpan={3}>{c.vat ? `${c.client} 공급가 합계` : `${c.client} 합계`}</td>
                    <td className={styles.num}>
                      <span className={styles.count}>
                        <span className={styles.big}>{t.received}</span>
                        <span className={styles.of}>/ {t.ordered}</span>
                        {t.ordered - t.received > 0 && <span className={styles.lack}>{t.ordered - t.received}개 안 옴</span>}
                      </span>
                    </td>
                    <td></td>
                    <td className={styles.numR}><b>{won(t.receivedAmt)}</b></td>
                    <td></td>
                  </tr>
                  {c.vat && (
                    <tr className={styles.vatRow}>
                      <td></td>
                      <td colSpan={5}>{c.vat_override != null ? "부가세 (직접 수정)" : "부가세 10%"}</td>
                      <td className={styles.numR}>+ {won(t.vatAmt)}</td>
                      <td className={styles.rowActions}>
                        {editable && <button className={styles.rowBtn} title="부가세 금액 수정 (비우면 자동 10%)" onClick={() => onEditVat(c.client, t.vatAmt, c.vat_override != null)}><Pencil size={14} /></button>}
                      </td>
                    </tr>
                  )}
                  {t.deductRaw > 0 && (
                    <tr className={styles.vatRow}>
                      <td></td>
                      <td colSpan={5}>
                        매입차감
                        {t.deductLeft > 0 && <span style={{ marginLeft: "0.5rem", color: TONES.orange.fg }}>(매입금액 {won(t.deductLeft)} 남음 · 상품금액 초과분은 차감 제외)</span>}
                      </td>
                      <td className={styles.numR} style={{ color: TONES.red.fg }}>- {won(t.deduct)}</td>
                      <td></td>
                    </tr>
                  )}
                  {(c.vat || t.deductRaw > 0) && (
                    <tr className={styles.totalRow}>
                      <td></td>
                      <td colSpan={5}>{c.client} 합계{c.vat ? " (부가세 포함)" : ""}{t.deductRaw > 0 ? " · 매입차감 반영" : ""}</td>
                      <td className={styles.numR}><b>{won(t.receivedTotal)}</b></td>
                      <td></td>
                    </tr>
                  )}
                </tfoot>
              </table>
            )}
          </div>
        );
      })}
      {!clients.length && <div className={styles.muted}>조건에 맞는 상품이 없습니다.</div>}
      </div>
      </section>
      {histClient && (
        <ClientHistoryModal
          client={histClient}
          onClose={() => setHistClient(null)}
          render={(res) => <ResultView result={res} cs={cs} onOpenCs={onOpenCs} editable={false} noHist />}
        />
      )}
    </>
  );
}

export default function OrderReceivingComparePage() {
  // 기본값: 발주내역은 전날, 입고요청 전표는 오늘 (오늘이 11/4면 발주 11/3 · 전표 11/4)
  const [orderDate, setOrderDate] = useState(() => shiftDay(todayStr(), -1));
  const [voucherDate, setVoucherDate] = useState(todayStr);

  // 매칭 버튼 → 전표 선택 단계
  const [selecting, setSelecting] = useState(false);
  const [voucherList, setVoucherList] = useState([]);          // [{date, sheet, name, qty}]
  const [picked, setPicked] = useState({});                    // "date|sheet" -> {date,sheet,name}
  const [title, setTitle] = useState("");
  const [memo, setMemo] = useState("");
  const [editingId, setEditingId] = useState(null);

  const [records, setRecords] = useState([]);
  const [lookupDate, setLookupDate] = useState(todayStr); // 일자별 조회 (매칭일 = 입고요청 전표 날짜), 빈 값이면 전체
  const [viewRecord, setViewRecord] = useState(null);

  // 세부목록 수정 (연필): 수량 수정 + 원가베이스유 검색으로 상품 변경
  const [itemEdit, setItemEdit] = useState(null); // {client, item, form:{ordered,received,misong,ordered_pickup,pickup}, newProduct}
  const [prodQuery, setProdQuery] = useState("");
  // 세부목록 추가: { type: "product", product, form } | { type: "deduct", client, amount, memo }
  const [addModal, setAddModal] = useState(null);
  const [jVat, setJVat] = useState({}); // 장끼 점검 창에서 고치는 부가세 입력값 {거래처: 문자열}
  const [jCheck, setJCheck] = useState(null); // 장끼 점검 결과 { recordId, ...api result }
  const [jBusy, setJBusy] = useState(false);
  const [prodResults, setProdResults] = useState([]);
  const [prodLoading, setProdLoading] = useState(false);

  // 거래처별 기간 조회 (예: 더원트레이더스 10월 전체)
  const [clientNames, setClientNames] = useState([]);
  const [clientQuery, setClientQuery] = useState("");
  const [lookupTo, setLookupTo] = useState(todayStr); // 조회 종료일 (시작일은 lookupDate)
  const [lookupMode, setLookupMode] = useState("day"); // "day": 일자별(날짜 하나) / "range": 기간별(시작~종료)
  // C/S 메뉴 정보 (읽기 전용): inq/delay = 상품코드별 건수
  const [cs, setCs] = useState(() => {
    const m = getMalignantSnapshot();
    return { inq: {}, inqAt: "", inqError: "", inqMatched: 0, inqUnmatched: 0, delay: m?.byCode || {}, delayAt: m?.fetchedAt || "", delayTotal: m?.total || 0 };
  });
  const csFetchedAt = useRef(0);
  const [dashClient, setDashClient] = useState(""); // 대시보드가 따라가는 조회 거래처 (입력이 멈추면 반영)
  const [csModal, setCsModal] = useState(null); // 상품 줄의 C/S 칩을 누르면 뜨는 작은 처리 창 { code, name, option }
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");

  const keyOf = (v) => `${v.date}|${v.sheet}`;
  const pickAll = (list) => Object.fromEntries(list.map((v) => [keyOf(v), { date: v.date, sheet: v.sheet, name: v.name }]));

  const LAST_KEY = "soPlusLastRecordId";
  const rememberLast = (rec) => {
    try {
      if (rec?.id) localStorage.setItem(LAST_KEY, String(rec.id));
    } catch { /* 저장소를 못 쓰는 환경은 무시 */ }
  };

  const loadRecords = useCallback(async () => {
    try {
      const data = await api("/records");
      setRecords(data.records || []);
    } catch (err) {
      setMessage(err.message);
    }
  }, []);

  const initialized = useRef(false);
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    loadRecords();
    api("/clients").then((data) => setClientNames((data.clients || []).map((x) => x.client))).catch(() => {});
    // 새로고침해도 마지막으로 보던 매칭 결과를 다시 연다 (매칭 내용은 DB에 저장되어 있다)
    let lastId = null;
    try { lastId = localStorage.getItem("soPlusLastRecordId"); } catch { lastId = null; }
    if (lastId) {
      api(`/records/${lastId}`).then((data) => setViewRecord(data.record)).catch(() => {});
    } else {
      api("/records").then(async (data) => {
        const list = data.records || [];
        const today = todayStr();
        const hit = list.find((x) => x.vouchers.some((v) => v.date === today));
        if (hit) {
          const full = await api(`/records/${hit.id}`);
          setViewRecord(full.record);
        }
      }).catch(() => {});
    }
  }, [loadRecords]);

  useEffect(() => { rememberLast(viewRecord); });

  useEffect(() => {
    const t = setTimeout(() => setDashClient(clientQuery.trim()), 350);
    return () => clearTimeout(t);
  }, [clientQuery]);

  // C/S 상품별 문의: 열 때와, 다른 매칭을 열 때(1분 이상 지났으면) 다시 읽는다. 에이블리·최신화는 건드리지 않는다.
  const loadCs = useCallback(async (force) => {
    if (!force && Date.now() - csFetchedAt.current < 60000) return;
    csFetchedAt.current = Date.now();
    try {
      const data = await loadInquiryStats();
      setCs((prev) => ({ ...prev, ...data }));
    } catch (err) {
      setCs((prev) => ({ ...prev, inqError: err.message }));
    }
  }, []);
  useEffect(() => { loadCs(true); }, [loadCs]);
  useEffect(() => { if (viewRecord?.id) loadCs(false); }, [viewRecord?.id, loadCs]);
  // 악성지연: C/S 악성지연 탭이 불러온 결과를 따라 읽는다
  useEffect(() => onMalignantSnapshot(() => {
    const m = getMalignantSnapshot();
    setCs((prev) => ({ ...prev, delay: m?.byCode || {}, delayAt: m?.fetchedAt || "", delayTotal: m?.total || 0 }));
  }), []);

  // 일자별 조회: 매칭일(입고요청 전표 날짜) 기준으로 저장된 매칭 리스트를 거른다.
  const dayChips = useMemo(() => {
    const map = new Map();
    records.forEach((x) => new Set(x.vouchers.map((v) => v.date)).forEach((d) => map.set(d, (map.get(d) || 0) + 1)));
    return [...map.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, 12);
  }, [records]);

  const markDates = useMemo(() => new Set(records.flatMap((x) => x.vouchers.map((v) => v.date))), [records]);

  const dayMode = !clientQuery.trim() && lookupMode === "day";

  const pickLookupDate = async (date) => {
    setLookupMode("day");
    setLookupDate(date);
    setLookupTo(date);
    setClientQuery("");
    setSelecting(false);
    const latest = records.find((x) => (date ? x.vouchers.some((v) => v.date === date) : true));
    if (latest) {
      try {
        const data = await api(`/records/${latest.id}`);
        setViewRecord(data.record);
        setMessage("");
      } catch (err) {
        setMessage(err.message);
      }
    } else {
      setViewRecord(null);
      setMessage(date ? `${date} 에 저장된 매칭이 없습니다.` : "");
    }
  };
  const runClientReport = async (from = lookupDate, to = lookupTo, name = clientQuery.trim()) => {
    setLoading(true);
    setMessage("");
    setSelecting(false);
    try {
      const params = new URLSearchParams({ client: name, date_from: from, date_to: to, split_days: "true" });
      const data = await api(`/client-report?${params}`);
      const label = name || "전체 거래처";
      if (!data.result?.clients?.length) {
        setViewRecord(null);
        setMessage(`${label}: ${from} ~ ${to} 저장된 매칭이 없습니다.`);
        return;
      }
      setViewRecord({
        id: null, title: `${label} · ${from} ~ ${to}`, order_dates: data.days, result: data.result,
        updated_at: `${label}|${from}|${to}|${Date.now()}`, isClientReport: true,
      });
    } catch (err) {
      setMessage(err.message);
    } finally {
      setLoading(false);
    }
  };

  // 조회: 일자별 모드 + 거래처 없음 → 그날 저장된 매칭(수정/삭제 가능), 기간별 모드나 거래처가 있으면 합산 조회
  const runLookup = (from = lookupDate, to = lookupTo, name = clientQuery.trim(), mode = lookupMode) => {
    const end = mode === "day" ? from : to;
    if (!from || !end) { setMessage("조회 날짜를 선택하세요."); return; }
    if (from > end) { setMessage("시작일이 종료일보다 늦습니다."); return; }
    if (!name && mode === "day") pickLookupDate(from);
    else runClientReport(from, end, name);
  };
  // 일자별 ↔ 기간별 전환 (날짜는 그대로 가져간다)
  const switchLookupMode = (mode) => {
    if (mode === lookupMode) return;
    setLookupMode(mode);
    if (mode === "day") {
      setLookupTo(lookupDate);
      runLookup(lookupDate, lookupDate, clientQuery.trim(), "day");
    }
  };
  const setPreset = (kind) => {
    const d = new Date();
    let from = todayStr();
    let to = from;
    if (kind === "yesterday") { from = shiftDay(from, -1); to = from; }
    if (kind === "month") { from = fmt(new Date(d.getFullYear(), d.getMonth(), 1)); to = fmt(new Date(d.getFullYear(), d.getMonth() + 1, 0)); }
    if (kind === "lastmonth") { from = fmt(new Date(d.getFullYear(), d.getMonth() - 1, 1)); to = fmt(new Date(d.getFullYear(), d.getMonth(), 0)); }
    const mode = kind === "month" || kind === "lastmonth" ? "range" : "day";
    setLookupMode(mode);
    setLookupDate(from);
    setLookupTo(to);
    runLookup(from, to, clientQuery.trim(), mode);
  };

  const hasEdits = (rec) => !!rec?.result?.clients?.some((c) => c.items.some((i) => i.edited));

  const openItemEdit = (client, item) => {
    setItemEdit({
      client, item, newProduct: null,
      form: { ordered: item.ordered, received: item.received, misong: item.misong, ordered_pickup: item.ordered_pickup, pickup: item.pickup },
    });
    setProdQuery("");
    setProdResults([]);
  };
  const closeItemEdit = () => { setItemEdit(null); setProdQuery(""); setProdResults([]); };

  // 원가베이스유 상품 검색 (입력이 멈추면 조회)
  useEffect(() => {
    if (!itemEdit && addModal?.type !== "product") return undefined;
    const q = prodQuery.trim();
    if (!q) { setProdResults([]); return undefined; }
    const timer = setTimeout(async () => {
      setProdLoading(true);
      try {
        const data = await api(`/products/search?q=${encodeURIComponent(q)}`);
        setProdResults(data.products || []);
      } catch (err) {
        setMessage(err.message);
      } finally {
        setProdLoading(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [prodQuery, itemEdit, addModal?.type]);

  const saveItemEdit = async () => {
    if (!viewRecord?.id || !itemEdit) return;
    setLoading(true);
    setMessage("");
    try {
      const body = { client: itemEdit.client, code: itemEdit.item.code, ...itemEdit.form };
      if (itemEdit.newProduct) body.new_code = itemEdit.newProduct.code;
      const data = await api(`/records/${viewRecord.id}/items`, { method: "PUT", body: JSON.stringify(body) });
      setViewRecord(data.record);
      setMessage(itemEdit.newProduct ? `상품을 ${itemEdit.newProduct.name}(으)로 변경했습니다.` : "세부목록을 수정했습니다.");
      closeItemEdit();
      await loadRecords();
    } catch (err) {
      setMessage(err.message);
    } finally {
      setLoading(false);
    }
  };

  // 날짜별장끼정리 DB를 한 번 돌아 매입차감/누락 상품을 확인. silent: 매칭 직후 자동 실행(비었거나 일치하면 조용히 넘어감)
  // 반영/삭제/PASS/부가세 수정으로 처리한 항목은 서버에 '처리 완료'로 기록되어 다음 점검부터 목록에 나오지 않는다.
  const diffCount = (d) => (d.deductions?.length || 0) + (d.products?.length || 0) + (d.so_only?.length || 0) + (d.qty_diffs?.length || 0) + (d.fees?.length || 0) + (d.vats?.length || 0);
  const runJanggiCheck = async (recordId, silent) => {
    if (!recordId) return;
    try {
      const data = await api(`/records/${recordId}/janggi-check`);
      if (data.empty) { if (!silent) setMessage("날짜별장끼정리 DB에 해당 날짜 내역이 없어 점검을 건너뜁니다."); return; }
      // 처리 완료한 항목이 있으면, 남은 게 없어도 창을 열어 '처리 기록 초기화'를 할 수 있게 한다 (자동 실행 때는 제외)
      if (!diffCount(data) && (silent || !data.resolved_count)) { if (!silent) setMessage("장끼 DB와 비교했을 때 상이한 부분이 없습니다."); return; }
      setJCheck({ recordId, ...data });
    } catch (err) {
      if (!silent) setMessage(err.message);
    }
  };

  // 처리 후 서버가 돌려준 남은 차이로 점검 창을 갱신한다 (남은 항목이 없으면 닫음)
  const showJanggiLeft = (recordId, d) => {
    setJCheck(!d || d.empty || !diffCount(d) ? null : { recordId, ...d });
  };

  // 장끼 점검 처리 공통: 요청 → 기록 갱신 → 남은 점검 목록 표시
  const janggiAction = async (path, body, doneMsg) => {
    if (!jCheck) return;
    const recordId = jCheck.recordId;
    setJBusy(true);
    setMessage("");
    try {
      const data = await api(`/records/${recordId}/${path}`, { method: "POST", body: JSON.stringify(body) });
      if (data.record) setViewRecord(data.record);
      setMessage(typeof doneMsg === "function" ? doneMsg(data) : doneMsg);
      await loadRecords();
      showJanggiLeft(recordId, data.diff);
    } catch (err) {
      setMessage(err.message);
    } finally {
      setJBusy(false);
    }
  };

  // 사용자가 고른 항목만 반영 (deductions: 거래처 이름들, products: 상품코드들). 반영한 항목은 점검 목록에서 빠진다.
  const applyJanggi = ({ deductions = [], products = [], qtyDiffs = [], fees = [] }) => {
    if (!deductions.length && !products.length && !qtyDiffs.length && !fees.length) return;
    return janggiAction("janggi-apply", { deductions, products, qty_diffs: qtyDiffs, fees }, (data) => `장끼 DB 기준으로 ${data.applied?.length || 0}건을 반영했습니다.`);
  };

  // [삭제]: SO+ 세부목록에서 실제로 지우고, 점검 목록에서도 뺀다.
  const removeFromSo = (body, label) => {
    if (!window.confirm(`SO+ 세부목록에서 실제로 삭제합니다.\n${label}\n진행하시겠습니까?`)) return;
    return janggiAction("janggi-remove", body, "SO+ 세부목록에서 삭제했습니다.");
  };

  // [PASS]: SO+는 그대로 두고 '처리 완료'로 기록해 점검 목록에서 뺀다.
  const passJanggi = (key) => janggiAction("janggi-resolve", { keys: [key] }, "PASS 처리했습니다.");

  // 처리 완료 기록을 모두 지워 점검 목록을 처음 상태로 되돌린다 (SO+ 세부목록은 그대로).
  const resetJanggiResolved = () => {
    if (!window.confirm("처리(반영·삭제·PASS)한 점검 항목을 다시 목록에 표시합니다.\nSO+ 세부목록은 바뀌지 않습니다. 진행하시겠습니까?")) return;
    return janggiAction("janggi-resolve", { reset: true }, "처리 기록을 초기화했습니다.");
  };

  // 장끼 점검 창에서 바로 부가세 금액을 고친다 (고친 거래처는 처리 완료로 점검 목록에서 빠진다)
  const applyVat = async (client, amount) => {
    if (!jCheck) return;
    const recordId = jCheck.recordId;
    setJBusy(true);
    setMessage("");
    try {
      await api(`/records/${recordId}/vat`, { method: "POST", body: JSON.stringify({ client, amount }) });
      const data = await api(`/records/${recordId}/janggi-resolve`, { method: "POST", body: JSON.stringify({ keys: [`v:${client}`] }) });
      setViewRecord(data.record);
      await loadRecords();
      showJanggiLeft(recordId, data.diff);
      setMessage(`${client} 부가세를 수정했습니다.`);
    } catch (err) {
      setMessage(err.message);
    } finally {
      setJBusy(false);
    }
  };

  const openAddProduct = () => {
    setAddModal({ type: "product", product: null, form: { received: 1, misong: "", ordered: "", ordered_pickup: "", pickup: "" } });
    setProdQuery("");
    setProdResults([]);
  };
  const openAddDeduct = () => setAddModal({ type: "deduct", client: "", amount: "", memo: "" });
  const openAddFee = () => setAddModal({ type: "fee", client: "", label: "택배비", amount: "", memo: "" });
  const closeAdd = () => { setAddModal(null); setProdQuery(""); setProdResults([]); };

  const saveAdd = async () => {
    if (!viewRecord?.id || !addModal) return;
    setLoading(true);
    setMessage("");
    try {
      if (addModal.type === "product") {
        if (!addModal.product) throw new Error("추가할 상품을 검색해서 선택하세요.");
        const data = await api(`/records/${viewRecord.id}/items`, {
          method: "POST",
          body: JSON.stringify({ code: addModal.product.code, ...addModal.form }),
        });
        setViewRecord(data.record);
        setMessage(`${addModal.product.name} 상품을 ${data.client}에 추가했습니다.`);
      } else if (addModal.type === "fee") {
        const data = await api(`/records/${viewRecord.id}/fees`, {
          method: "POST",
          body: JSON.stringify({ client: addModal.client, label: addModal.label, amount: addModal.amount }),
        });
        setViewRecord(data.record);
        setMessage(`${addModal.client}에 ${addModal.label} 항목을 추가했습니다.`);
      } else {
        const data = await api(`/records/${viewRecord.id}/deductions`, {
          method: "POST",
          body: JSON.stringify({ client: addModal.client, amount: addModal.amount, memo: addModal.memo }),
        });
        setViewRecord(data.record);
        setMessage(`${addModal.client} 매입차감을 추가했습니다.`);
      }
      closeAdd();
      await loadRecords();
    } catch (err) {
      setMessage(err.message);
    } finally {
      setLoading(false);
    }
  };

  const editVat = async (client, current, fixed) => {
    if (!viewRecord?.id) return;
    const input = window.prompt(`${client} 부가세 금액을 입력하세요.${fixed ? "\n(비우고 확인하면 자동 10%로 되돌아갑니다)" : ""}`, String(current));
    if (input === null) return;
    setLoading(true);
    setMessage("");
    try {
      const data = await api(`/records/${viewRecord.id}/vat`, { method: "POST", body: JSON.stringify({ client, amount: input }) });
      setViewRecord(data.record);
      await loadRecords();
    } catch (err) {
      setMessage(err.message);
    } finally {
      setLoading(false);
    }
  };

  const deleteItem = async (client, item) => {
    if (!viewRecord?.id) return;
    if (!window.confirm(`세부목록에서 삭제합니다.\n${client} · ${item.name} ${item.option}\n진행하시겠습니까?`)) return;
    setLoading(true);
    setMessage("");
    try {
      const params = new URLSearchParams({ client, code: item.code });
      const data = await api(`/records/${viewRecord.id}/items?${params}`, { method: "DELETE" });
      setViewRecord(data.record);
      setMessage("세부목록에서 삭제했습니다.");
      await loadRecords();
    } catch (err) {
      setMessage(err.message);
    } finally {
      setLoading(false);
    }
  };


  const resetForm = () => { setSelecting(false); setEditingId(null); setTitle(""); setMemo(""); setVoucherList([]); setPicked({}); };

  // [매칭] : 입고요청일의 전표 목록을 불러와 체크박스(전체선택 기본)로 보여준다.
  const startMatch = async () => {
    setLoading(true);
    setMessage("");
    try {
      const data = await api(`/vouchers?date=${voucherDate}`);
      if (data.need_session) { setMessage(NEED_SESSION_MSG); return; }
      const list = (data.vouchers || []).map((v) => ({ ...v, date: voucherDate }));
      if (!list.length) { setMessage(`${voucherDate} 입고요청 전표가 없습니다.`); return; }
      setEditingId(null);
      setTitle("");
      setMemo("");
      setVoucherList(list);
      setPicked(pickAll(list));
      setSelecting(true);
    } catch (err) {
      setMessage(err.message);
    } finally {
      setLoading(false);
    }
  };

  const togglePick = (v) => setPicked((prev) => {
    const next = { ...prev };
    if (next[keyOf(v)]) delete next[keyOf(v)]; else next[keyOf(v)] = { date: v.date, sheet: v.sheet, name: v.name };
    return next;
  });
  const pickedCount = Object.keys(picked).length;
  const allPicked = voucherList.length > 0 && pickedCount === voucherList.length;
  const toggleAll = () => setPicked(allPicked ? {} : pickAll(voucherList));

  // [매칭 완료] : 선택한 전표로 대조하고 저장 → 발주매칭내역에 올라간다.
  const finishMatch = async () => {
    if (editingId && viewRecord?.id === editingId && hasEdits(viewRecord)
      && !window.confirm("직접 수정/삭제한 세부목록이 있습니다.\n수정 저장(재매칭)하면 전표 기준으로 초기화됩니다. 진행하시겠습니까?")) return;
    setLoading(true);
    setMessage("");
    try {
      const body = { order_dates: [orderDate], vouchers: Object.values(picked), title, memo, refresh: true };
      const data = editingId
        ? await api(`/records/${editingId}`, { method: "PUT", body: JSON.stringify(body) })
        : await api("/records", { method: "POST", body: JSON.stringify(body) });
      if (data.need_session) { setMessage(NEED_SESSION_MSG); return; }
      setViewRecord(data.record);
      setMessage(editingId ? "수정되었습니다." : "매칭이 완료되어 발주매칭내역에 저장되었습니다.");
      resetForm();
      await loadRecords();
      runJanggiCheck(data.record?.id, true);
    } catch (err) {
      setMessage(err.message);
    } finally {
      setLoading(false);
    }
  };

  // 수정: 저장된 날짜/전표 선택을 다시 채워 전표 선택 단계로 들어간다.
  const startEdit = async (rec) => {
    const dates = rec.order_dates?.length ? rec.order_dates : [rec.order_date];
    const saved = rec.vouchers || [];
    const vDate = saved[0]?.date || voucherDate;
    setOrderDate(dates[0]);
    setVoucherDate(vDate);
    setLoading(true);
    setMessage("");
    try {
      let fresh = [];
      const data = await api(`/vouchers?date=${vDate}`);
      if (data.need_session) setMessage(NEED_SESSION_MSG);
      else fresh = (data.vouchers || []).map((v) => ({ ...v, date: vDate }));
      const merged = [...fresh];
      saved.forEach((s) => { if (!merged.some((m) => keyOf(m) === keyOf(s))) merged.push({ ...s, qty: 0 }); });
      setVoucherList(merged);
      setPicked(Object.fromEntries(saved.map((s) => [keyOf(s), s])));
      setEditingId(rec.id);
      setTitle(rec.title || "");
      setMemo(rec.memo || "");
      setSelecting(true);
    } catch (err) {
      setMessage(err.message);
    } finally {
      setLoading(false);
    }
  };

  const rematch = async (rec) => {
    if (hasEdits(viewRecord) && !window.confirm("직접 수정/삭제한 세부목록이 있습니다.\n다시 매칭하면 전표 기준으로 초기화(덮어쓰기)되고, 이어서 장끼 DB 점검 목록이 표시됩니다. 진행하시겠습니까?")) return;
    setLoading(true);
    setMessage("");
    try {
      const data = await api(`/records/${rec.id}`, { method: "PUT", body: JSON.stringify({ rematch: true, refresh: true }) });
      if (data.need_session) { setMessage(NEED_SESSION_MSG); return; }
      setViewRecord(data.record);
      setMessage("전표를 다시 받아 재매칭했습니다.");
      await loadRecords();
      runJanggiCheck(rec.id, true);
    } catch (err) {
      setMessage(err.message);
    } finally {
      setLoading(false);
    }
  };

  const remove = async (rec) => {
    if (!window.confirm(`저장된 매칭 "${rec.title || `#${rec.id}`}"를 삭제합니다.\n진행하시겠습니까?`)) return;
    try {
      await api(`/records/${rec.id}`, { method: "DELETE" });
      if (viewRecord?.id === rec.id) {
        setViewRecord(null);
        try { localStorage.removeItem(LAST_KEY); } catch { /* 무시 */ }
      }
      if (editingId === rec.id) resetForm();
      setMessage("삭제되었습니다.");
      await loadRecords();
    } catch (err) {
      setMessage(err.message);
    }
  };

  // 일자별 조회: 저장된 매칭 날짜를 최근순 리스트로 (조회 중인 날짜는 항상 포함)
  const dayListDates = [...new Set([...dayChips.map(([d]) => d), ...(lookupDate ? [lookupDate] : [])])].sort().reverse();
  const dayLabel = (d) => `${d} (${["일", "월", "화", "수", "목", "금", "토"][new Date(`${d}T00:00:00`).getDay()]})`;

  const lookupPanel = (
      <section className={styles.panel}>
        <div className={styles.row}>
          <span className={styles.chips} style={{ margin: 0 }}>
            <button className={`${styles.chip} ${lookupMode === "day" ? styles.chipOn : ""}`} onClick={() => switchLookupMode("day")}>일자별</button>
            <button className={`${styles.chip} ${lookupMode === "range" ? styles.chipOn : ""}`} onClick={() => switchLookupMode("range")}>기간별</button>
          </span>
          {lookupMode === "day" ? (
            null
          ) : (
            <>
              <DateRangePicker
                from={lookupDate}
                to={lookupTo}
                marks={markDates}
                onChange={(a, b) => { setLookupDate(a); setLookupTo(b); runLookup(a, b, clientQuery.trim(), "range"); }}
              />
            </>
          )}
          <input
            className={styles.text}
            list="so-client-names"
            placeholder="거래처 (선택, 예: 더원트레이더스)"
            value={clientQuery}
            onChange={(e) => {
              const v = e.target.value;
              setClientQuery(v);
              // 목록에서 거래처를 고르면(정확히 일치) 바로 조회한다
              if (v.trim() && clientNames.includes(v.trim())) runLookup(lookupDate, lookupTo, v.trim());
            }}
            onKeyDown={(e) => { if (e.key === "Enter") runLookup(); }}
          />
          <datalist id="so-client-names">
            {clientNames.map((n) => <option key={n} value={n} />)}
          </datalist>
          <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => runLookup()} disabled={loading}>조회</button>
        </div>
        {lookupMode === "day" && (
          <div className={styles.dayList}>
            {dayListDates.map((d) => (
              <button
                key={d}
                className={`${styles.dayItem} ${d === lookupDate ? styles.dayItemOn : ""}`}
                onClick={() => { setLookupDate(d); setLookupTo(d); runLookup(d, d, clientQuery.trim(), "day"); }}
              >
                {dayLabel(d)}
              </button>
            ))}
            <div className={styles.dayCal}>
              <DatePicker
                iconOnly
                popRight
                value={lookupDate}
                marks={markDates}
                onChange={(v) => { setLookupDate(v); setLookupTo(v); runLookup(v, v, clientQuery.trim(), "day"); }}
                title="달력에서 날짜 선택 (선택하면 바로 조회)"
              />
            </div>
          </div>
        )}
        {lookupMode !== "day" && <div className={styles.chips}>
          <button className={styles.chip} onClick={() => setPreset("today")}>오늘</button>
          <button className={styles.chip} onClick={() => setPreset("yesterday")}>어제</button>
          <button className={styles.chip} onClick={() => setPreset("month")}>이번달</button>
          <button className={styles.chip} onClick={() => setPreset("lastmonth")}>지난달</button>
          {dayChips.length > 0 && <span className={styles.chipSep} />}
          {dayChips.map(([d]) => (
            <button
              key={d}
              className={`${styles.chip} ${dayMode && d === lookupDate ? styles.chipOn : ""}`}
              onClick={() => pickLookupDate(d)}
              title="이 날짜에 저장된 매칭"
            >
              {d.slice(5)}
            </button>
          ))}
        </div>}
        {!dayMode && <div className={styles.muted} style={{ marginTop: "0.5rem" }}>
          {`${lookupMode === "day" ? lookupDate : `${lookupDate} ~ ${lookupTo}`} 일자별 조회${clientQuery.trim() ? ` · ${clientQuery.trim()}` : " · 전체 거래처"}`}
        </div>}
      </section>
  );

  return (
    <div className={styles.page}>
      <div className={styles.title}>SO+ <span className={styles.sub}>발주내역 ↔ 입고요청 전표 대조 (거래처별)</span></div>

      {message && <div className={styles.message}>{message}</div>}

      <section className={styles.panel}>
        <div className={styles.row}>
          <div className={styles.field}>
            <span>발주내역 날짜</span>
            <DatePicker value={orderDate} onChange={setOrderDate} disabled={selecting} />
          </div>
          <div className={styles.field}>
            <span>입고요청 날짜</span>
            <DatePicker value={voucherDate} onChange={setVoucherDate} disabled={selecting} marks={markDates} />
          </div>
          <button
            className={`${styles.btn} ${styles.btnPrimary}`}
            onClick={startMatch}
            disabled={loading || selecting || !orderDate || !voucherDate}
          >
            {loading && !selecting ? "전표 불러오는 중..." : "매칭"}
          </button>
          {viewRecord && !viewRecord.isClientReport && viewRecord.id && (
            <>
              <button className={styles.btn} onClick={() => rematch(viewRecord)} disabled={loading} title="저장된 전표를 이지어드민에서 다시 받아 재매칭">
                다시 매칭
              </button>
              <button className={styles.btn} onClick={() => startEdit(viewRecord)} disabled={loading}><Pencil size={13} /> 수정</button>
              <button className={styles.btn} onClick={() => remove(viewRecord)} disabled={loading}><Trash2 size={13} /> 삭제</button>
            </>
          )}
        </div>

        {selecting && (
          <div className={styles.selectBox}>
            <h3>{editingId ? `매칭 #${editingId} 수정 — ` : ""}매칭할 입고요청 전표 선택 ({voucherDate})</h3>
            <label className={styles.item}>
              <input type="checkbox" checked={allPicked} onChange={toggleAll} />
              <b>전체 선택</b>
              <span className={styles.muted}>{pickedCount}/{voucherList.length}개 전표</span>
            </label>
            <div className={styles.list}>
              {voucherList.map((v) => (
                <label key={keyOf(v)} className={styles.item}>
                  <input type="checkbox" checked={!!picked[keyOf(v)]} onChange={() => togglePick(v)} />
                  <span>{v.date !== voucherDate ? `${v.date.slice(5)} · ` : ""}{v.name}</span>
                  <span className={styles.muted}>{v.qty ? `${v.qty}개` : ""}</span>
                </label>
              ))}
            </div>
            <div className={styles.row} style={{ marginTop: "0.6rem" }}>
              <input className={styles.text} placeholder="제목 (선택)" value={title} onChange={(e) => setTitle(e.target.value)} />
              <input className={styles.text} placeholder="메모 (선택)" value={memo} onChange={(e) => setMemo(e.target.value)} />
              <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={finishMatch} disabled={loading || !pickedCount}>
                {loading ? "매칭 중... (전표 다운로드 최대 1분)" : `매칭 완료 (전표 ${pickedCount})`}
              </button>
              <button className={styles.btn} onClick={resetForm} disabled={loading}>취소</button>
            </div>
          </div>
        )}
      </section>

      <SoDashboard refreshSig={records.map((r) => `${r.id}:${r.updated_at}`).join(",")} client={dashClient} onClearClient={() => setClientQuery("")} />

      {csModal && (
        <SoCsModal
          title={csModal.name}
          option={csModal.option}
          rooms={cs.inq?.[csModal.code]?.rooms || []}
          delays={cs.delay?.[csModal.code]?.list || []}
          onClose={() => setCsModal(null)}
          onChanged={() => loadCs(true)}
        />
      )}
      {viewRecord ? (
          <ResultView
            key={viewRecord.id ?? viewRecord.updated_at /* 같은 매칭을 수정/삭제해도 다시 마운트하지 않아 펼침·검색·정렬·스크롤이 유지됨 */}
            result={viewRecord.result}
            cs={cs}
            onOpenCs={(i) => setCsModal({ code: normCode(i.code), name: i.name, option: i.option })}
            editable={!viewRecord.isClientReport && !!viewRecord.id}
            onEditItem={openItemEdit}
            onDeleteItem={deleteItem}
            onAddProduct={openAddProduct}
            onAddDeduct={openAddDeduct}
            onAddFee={openAddFee}
            onEditVat={editVat}
            onJanggiCheck={() => runJanggiCheck(viewRecord.id, false)}
            lookupSlot={lookupPanel}
          />
      ) : lookupPanel}
      {jCheck && (() => {
        // 처리(반영·삭제·PASS·부가세 수정)한 항목은 서버가 점검 목록에서 빼고 돌려준다.
        const passed = {};
        const rowStyle = () => ({ padding: "0.35rem 0", borderBottom: "1px solid rgba(0,0,0,0.06)" });
        // real: SO+ 세부목록에서 실제로 지울 때의 {body, label}. 없으면(장끼에만 있는 상품·부가세) SO+에 지울 게 없어 삭제 버튼을 두지 않는다.
        const PassBtn = ({ k, real }) => (
          <>
            <button className={styles.btn} disabled={jBusy} onClick={() => passJanggi(k)} title="SO+는 그대로 두고 처리 완료로 표시해 목록에서 뺍니다">PASS</button>
            {real && (
              <button className={styles.btn} disabled={jBusy} onClick={() => removeFromSo(real.body, real.label)} title="SO+ 세부목록에서 실제로 삭제하고 목록에서 뺍니다">삭제</button>
            )}
          </>
        );
        const Reason = ({ children }) => <div className={styles.muted} style={{ fontSize: "0.78rem", marginTop: 2 }}>사유 · {children}</div>;
        const kinds = (x) => [x.received && `입고 ${x.received}`, x.misong && `미송 ${x.misong}`, x.pickup && `미송픽업 ${x.pickup}`].filter(Boolean).join(" · ");
        const selDed = (jCheck.deductions || []).filter((d) => d.diff > 0 && !passed[`d:${d.client}`]);
        const selProd = (jCheck.products || []).filter((p) => p.in_wonbe && !passed[`p:${p.code}`]);
        const hasAdd = (q) => Object.values(q.add || {}).some((v) => v > 0);
        const selQty = (jCheck.qty_diffs || []).filter((q) => hasAdd(q) && !passed[`q:${q.code}`]);
        const selFee = (jCheck.fees || []).filter((f) => f.diff > 0 && !passed[`f:${f.client}:${f.label}`]);
        return (
          <div className={styles.modalBack} onClick={() => !jBusy && setJCheck(null)}>
            <div className={styles.modal} style={{ maxWidth: 820, width: "95vw", maxHeight: "86vh", overflow: "auto" }} onClick={(e) => e.stopPropagation()}>
              <h3>장끼 DB 점검 <span className={styles.muted} style={{ fontSize: "0.8rem" }}>{jCheck.dates?.join(", ")} · 장끼 {jCheck.janggi_rows}행 기준</span></h3>
              <div className={styles.muted}>날짜별장끼정리 DB와 이 매칭을 비교해 다른 부분을 보여줍니다. 항목마다 [반영]·[삭제]·[PASS] 중 하나로 처리하면 목록에서 빠집니다. 아무것도 누르지 않으면 SO+ 매칭은 그대로입니다.</div>
              {jCheck.resolved_count > 0 && (
                <div className={styles.row} style={{ alignItems: "center", gap: "0.5rem", marginTop: "0.4rem" }}>
                  <span className={styles.muted}>처리 완료되어 숨긴 항목 {jCheck.resolved_count}개</span>
                  <button className={styles.btn} disabled={jBusy} onClick={resetJanggiResolved}>다시 보기 (처리 기록 초기화)</button>
                </div>
              )}
              {diffCount(jCheck) === 0 && <div className={styles.muted} style={{ marginTop: "0.6rem" }}>남은 점검 항목이 없습니다.</div>}

              {jCheck.deductions?.length > 0 && (
                <div className={styles.modalSec}>
                  <div className={styles.modalLabel}>매입차감 상이 ({jCheck.deductions.length}곳)</div>
                  {jCheck.deductions.map((d) => (
                    <div key={d.client} style={rowStyle(`d:${d.client}`)}>
                      <div className={styles.row} style={{ alignItems: "center", gap: "0.6rem" }}>
                        <b style={{ minWidth: 120 }}>{d.client}</b>
                        <span className={styles.muted}>장끼 -{won(d.janggi)} · SO+ -{won(d.so)}</span>
                        <span style={{ flex: 1 }} />
                        {d.diff > 0 && <button className={`${styles.btn} ${styles.btnPrimary}`} disabled={jBusy || passed[`d:${d.client}`]} onClick={() => applyJanggi({ deductions: [d.client] })}>반영 (-{won(d.diff)})</button>}
                        <PassBtn k={`d:${d.client}`} real={d.so > 0 ? { body: { kind: "deduct", client: d.client }, label: `${d.client} 매입차감 (-${won(d.so)})` } : null} />
                      </div>
                      <Reason>{d.reason}</Reason>
                    </div>
                  ))}
                </div>
              )}

              {jCheck.fees?.length > 0 && (
                <div className={styles.modalSec}>
                  <div className={styles.modalLabel}>추가 금액 상이 ({jCheck.fees.length}건) · 택배비 등 상품 외 금액</div>
                  {jCheck.fees.map((f) => {
                    const k = `f:${f.client}:${f.label}`;
                    return (
                      <div key={k} style={rowStyle(k)}>
                        <div className={styles.row} style={{ alignItems: "center", gap: "0.6rem" }}>
                          <b style={{ minWidth: 120 }}>{f.client}</b>
                          <span>{f.label}</span>
                          <span className={styles.muted}>장끼 {won(f.janggi)} · SO+ {won(f.so)}</span>
                          <span style={{ flex: 1 }} />
                          {f.diff > 0 && <button className={`${styles.btn} ${styles.btnPrimary}`} disabled={jBusy || passed[k]} onClick={() => applyJanggi({ fees: [{ client: f.client, label: f.label }] })}>{f.label} +{won(f.diff)} 추가</button>}
                          <PassBtn k={k} real={f.so ? { body: { kind: "fee", client: f.client, label: f.label }, label: `${f.client} ${f.label} (${won(f.so)})` } : null} />
                        </div>
                        <Reason>{f.reason}</Reason>
                      </div>
                    );
                  })}
                </div>
              )}

              {jCheck.vats?.length > 0 && (
                <div className={styles.modalSec}>
                  <div className={styles.modalLabel}>부가세 상이 ({jCheck.vats.length}곳)</div>
                  {jCheck.vats.map((v) => (
                    <div key={v.client} style={rowStyle(`v:${v.client}`)}>
                      <div className={styles.row} style={{ alignItems: "center", gap: "0.6rem" }}>
                        <b style={{ minWidth: 120 }}>{v.client}</b>
                        <span className={styles.muted}>장끼 {won(v.janggi)} · SO+ {won(v.so)}</span>
                        <span style={{ flex: 1 }} />
                        <input
                          className={styles.numInput}
                          style={{ width: 96, textAlign: "right" }}
                          inputMode="numeric"
                          value={jVat[v.client] ?? String(v.janggi)}
                          onChange={(e) => setJVat((m) => ({ ...m, [v.client]: e.target.value }))}
                          disabled={jBusy}
                          aria-label={`${v.client} 부가세 금액`}
                        />
                        <button className={`${styles.btn} ${styles.btnPrimary}`} disabled={jBusy || passed[`v:${v.client}`]} onClick={() => applyVat(v.client, jVat[v.client] ?? String(v.janggi))}>부가세 수정</button>
                        <PassBtn k={`v:${v.client}`} />
                      </div>
                      <Reason>{v.reason}</Reason>
                    </div>
                  ))}
                </div>
              )}

              {jCheck.products?.length > 0 && (
                <div className={styles.modalSec}>
                  <div className={styles.modalLabel}>장끼정리에만 있는 상품 ({jCheck.products.length}개) · SO+ 에 없음</div>
                  {jCheck.products.map((p) => (
                    <div key={p.code} style={rowStyle(`p:${p.code}`)}>
                      <div className={styles.row} style={{ alignItems: "center", gap: "0.6rem" }}>
                        <b style={{ minWidth: 110 }}>{p.client || "(거래처 미확인)"}</b>
                        <span>{p.name} <span className={styles.muted}>{p.option} · {p.code}</span></span>
                        <b style={{ color: TONES.red.fg }}>{kinds(p)}</b>
                        <span style={{ flex: 1 }} />
                        {p.in_wonbe
                          ? <button className={`${styles.btn} ${styles.btnPrimary}`} disabled={jBusy || passed[`p:${p.code}`]} onClick={() => applyJanggi({ products: [p.code] })}>SO+에 추가</button>
                          : <span style={{ color: TONES.red.fg }}>원가베이스유에 없음</span>}
                        <PassBtn k={`p:${p.code}`} />
                      </div>
                      <Reason>{p.reason}</Reason>
                    </div>
                  ))}
                </div>
              )}

              {jCheck.so_only?.length > 0 && (
                <div className={styles.modalSec}>
                  <div className={styles.modalLabel}>SO+ 에만 있는 상품 ({jCheck.so_only.length}개) · 장끼정리에 없음</div>
                  {jCheck.so_only.map((x) => (
                    <div key={x.code} style={rowStyle(`s:${x.code}`)}>
                      <div className={styles.row} style={{ alignItems: "center", gap: "0.6rem" }}>
                        <b style={{ minWidth: 110 }}>{x.client}</b>
                        <span>{x.name} <span className={styles.muted}>{x.option} · {x.code}</span></span>
                        <b style={{ color: TONES.purple?.fg || TONES.orange.fg }}>{kinds(x)}</b>
                        <span style={{ flex: 1 }} />
                        <PassBtn k={`s:${x.code}`} real={{ body: { kind: "item", client: x.client, code: x.code }, label: `${x.client} · ${x.name} ${x.option}` }} />
                      </div>
                      <Reason>{x.reason}</Reason>
                    </div>
                  ))}
                </div>
              )}

              {jCheck.qty_diffs?.length > 0 && (
                <div className={styles.modalSec}>
                  <div className={styles.modalLabel}>수량·구분 상이 ({jCheck.qty_diffs.length}개) · SO+에 목록은 있으나 수량이 다름</div>
                  {jCheck.qty_diffs.map((q) => (
                    <div key={q.code} style={rowStyle(`q:${q.code}`)}>
                      <div className={styles.row} style={{ alignItems: "center", gap: "0.6rem" }}>
                        <b style={{ minWidth: 110 }}>{q.client}</b>
                        <span>{q.name} <span className={styles.muted}>{q.option} · {q.code}</span></span>
                        <span className={styles.muted}>장끼 {q.janggi}개 · SO+ {q.so}개</span>
                        <span style={{ flex: 1 }} />
                        {hasAdd(q) && (
                          <button className={`${styles.btn} ${styles.btnPrimary}`} disabled={jBusy || passed[`q:${q.code}`]} onClick={() => applyJanggi({ qtyDiffs: [q.code] })}>
                            {kinds(q.add)} 추가
                          </button>
                        )}
                        <PassBtn k={`q:${q.code}`} real={{ body: { kind: "item", client: q.client, code: q.code }, label: `${q.client} · ${q.name} ${q.option}` }} />
                      </div>
                      <Reason>{q.reason}</Reason>
                    </div>
                  ))}
                </div>
              )}

              <div className={styles.row} style={{ justifyContent: "flex-end", marginTop: "0.9rem", gap: "0.5rem" }}>
                <button className={styles.btn} onClick={() => setJCheck(null)} disabled={jBusy}>닫기</button>
                {(selDed.length > 0 || selProd.length > 0 || selQty.length > 0 || selFee.length > 0) && (
                  <button
                    className={`${styles.btn} ${styles.btnPrimary}`}
                    disabled={jBusy}
                    onClick={() => applyJanggi({ deductions: selDed.map((d) => d.client), products: selProd.map((x) => x.code), qtyDiffs: selQty.map((x) => x.code), fees: selFee.map((f) => ({ client: f.client, label: f.label })) })}
                  >
                    {jBusy ? "반영 중..." : `PASS 안 한 항목 모두 반영 (${selDed.length + selProd.length + selQty.length + selFee.length}건)`}
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      })()}
      {addModal?.type === "product" && (
        <div className={styles.modalBack} onClick={closeAdd}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h3>제품 추가</h3>
            <div className={styles.modalSec}>
              <div className={styles.modalLabel}>상품 검색 <span className={styles.muted}>(원가베이스유 · 선택하면 해당 거래처로 자동 배정)</span></div>
              <input
                className={styles.text}
                style={{ width: "100%" }}
                autoFocus
                placeholder="상품코드 / 상품명 / 색상 / 사이즈 / 거래처"
                value={prodQuery}
                onChange={(e) => setProdQuery(e.target.value)}
              />
              {addModal.product && (
                <div className={styles.picked}>
                  <b>추가할 상품</b> {addModal.product.name} {addModal.product.color}/{addModal.product.size}
                  <span className={styles.muted}> · 거래처 <b>{addModal.product.client || "(미확인)"}</b> · {addModal.product.code} · 원가 {won(addModal.product.cost)}</span>
                  <button className={styles.rowBtn} title="선택 취소" onClick={() => setAddModal((cur) => ({ ...cur, product: null }))}>✕</button>
                </div>
              )}
              <div className={styles.prodList}>
                {prodLoading && <div className={styles.muted}>검색 중...</div>}
                {!prodLoading && prodQuery.trim() && !prodResults.length && <div className={styles.muted}>검색 결과가 없습니다.</div>}
                {prodResults.map((x) => (
                  <button
                    key={x.code}
                    className={`${styles.prodRow} ${addModal.product?.code === x.code ? styles.prodRowOn : ""}`}
                    onClick={() => setAddModal((cur) => ({ ...cur, product: x }))}
                  >
                    <span className={styles.prodName}>{x.name} <span className={styles.muted}>{x.color}/{x.size}</span></span>
                    <span className={styles.muted}>{x.client}</span>
                    <span className={styles.muted}>{x.code}</span>
                    <span className={styles.prodCost}>{x.cost ? won(x.cost) : "원가없음"}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className={styles.modalSec}>
              <div className={styles.modalLabel}>수량</div>
              <div className={styles.qtyGrid}>
                {[["received", "입고"], ["misong", "미송"], ["ordered", "발주"], ["ordered_pickup", "미송픽업 발주"], ["pickup", "미송픽업 입고"]].map(([k, label]) => (
                  <label key={k} className={styles.field}>
                    <span>{label}</span>
                    <input
                      type="number"
                      min="0"
                      className={styles.numInput}
                      value={addModal.form[k]}
                      onChange={(e) => setAddModal((cur) => ({ ...cur, form: { ...cur.form, [k]: e.target.value } }))}
                    />
                  </label>
                ))}
              </div>
              <div className={styles.muted} style={{ marginTop: "0.3rem" }}>
                금액은 (입고+미송) × 원가로 계산됩니다. 부가세 거래처는 추가된 상품까지 포함한 금액 기준으로 부가세가 다시 계산됩니다.
              </div>
            </div>
            <div className={styles.row} style={{ justifyContent: "flex-end", marginTop: "0.9rem" }}>
              <button className={styles.btn} onClick={closeAdd} disabled={loading}>취소</button>
              <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={saveAdd} disabled={loading || !addModal.product}>{loading ? "추가 중..." : "추가"}</button>
            </div>
          </div>
        </div>
      )}
      {(addModal?.type === "deduct" || addModal?.type === "fee") && (
        <div className={styles.modalBack} onClick={closeAdd}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h3>{addModal.type === "fee" ? "항목 추가 (택배비 등)" : "매입차감 추가"}</h3>
            <div className={styles.modalSec}>
              <label className={styles.field}>
                <span>거래처</span>
                <input
                  className={styles.text}
                  style={{ width: "100%" }}
                  autoFocus
                  list="so-deduct-clients"
                  placeholder="거래처 (목록에서 선택하거나 입력)"
                  value={addModal.client}
                  onChange={(e) => setAddModal((cur) => ({ ...cur, client: e.target.value }))}
                />
                <datalist id="so-deduct-clients">
                  {[...new Set([...(viewRecord?.result?.clients || []).map((c) => c.client), ...clientNames])].map((n) => <option key={n} value={n} />)}
                </datalist>
              </label>
              {addModal.type === "fee" && (
                <label className={styles.field} style={{ marginTop: "0.5rem" }}>
                  <span>항목 이름</span>
                  <input
                    className={styles.text}
                    style={{ width: "100%" }}
                    list="so-fee-labels"
                    placeholder="예: 택배비"
                    value={addModal.label}
                    onChange={(e) => setAddModal((cur) => ({ ...cur, label: e.target.value }))}
                  />
                  <datalist id="so-fee-labels">
                    {["택배비", "포장비", "배송비", "기타"].map((n) => <option key={n} value={n} />)}
                  </datalist>
                </label>
              )}
              <label className={styles.field} style={{ marginTop: "0.5rem" }}>
                <span>금액 {addModal.type === "fee"
                  ? <span className={styles.muted}>(3000 → +3,000원이 상품금액에 더해지고, 부가세 거래처면 부가세도 같이 계산)</span>
                  : <span className={styles.muted}>(50050 또는 -50050 → 매입차감 -50,050원)</span>}</span>
                <input
                  className={styles.text}
                  style={{ width: "100%" }}
                  inputMode="numeric"
                  placeholder="금액"
                  value={addModal.amount}
                  onChange={(e) => setAddModal((cur) => ({ ...cur, amount: e.target.value }))}
                  onKeyDown={(e) => { if (e.key === "Enter") saveAdd(); }}
                />
              </label>
              {addModal.type === "deduct" && (
                <>
                  <label className={styles.field} style={{ marginTop: "0.5rem" }}>
                    <span>메모 (선택)</span>
                    <input
                      className={styles.text}
                      style={{ width: "100%" }}
                      value={addModal.memo}
                      onChange={(e) => setAddModal((cur) => ({ ...cur, memo: e.target.value }))}
                    />
                  </label>
                  <div className={styles.muted} style={{ marginTop: "0.4rem" }}>
                    차감은 거래처 상품금액(부가세 포함)을 넘지 않는 범위까지만 합계에 반영되고, 넘는 금액은 "매입금액 N원 남음"으로 표시됩니다.
                  </div>
                </>
              )}
            </div>
            <div className={styles.row} style={{ justifyContent: "flex-end", marginTop: "0.9rem" }}>
              <button className={styles.btn} onClick={closeAdd} disabled={loading}>취소</button>
              <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={saveAdd} disabled={loading || !addModal.client.trim() || !String(addModal.amount).trim() || (addModal.type === "fee" && !String(addModal.label).trim())}>{loading ? "추가 중..." : "추가"}</button>
            </div>
          </div>
        </div>
      )}
      {itemEdit && (
        <div className={styles.modalBack} onClick={closeItemEdit}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h3>세부목록 수정</h3>
            <div className={styles.modalNow}>
              <span className={styles.muted}>현재 상품</span>
              <b>{itemEdit.item.name}</b> {itemEdit.item.option}
              <span className={styles.muted}> · {itemEdit.client} · {itemEdit.item.code}</span>
            </div>

            <div className={styles.modalSec}>
              <div className={styles.modalLabel}>수량 수정</div>
              <div className={styles.qtyGrid}>
                {[["ordered", "발주"], ["received", "입고"], ["misong", "미송"], ["ordered_pickup", "미송픽업 발주"], ["pickup", "미송픽업 입고"]].map(([k, label]) => (
                  <label key={k} className={styles.field}>
                    <span>{label}</span>
                    <input
                      type="number"
                      min="0"
                      className={styles.numInput}
                      value={itemEdit.form[k]}
                      onChange={(e) => setItemEdit((cur) => ({ ...cur, form: { ...cur.form, [k]: e.target.value } }))}
                    />
                  </label>
                ))}
              </div>
            </div>

            <div className={styles.modalSec}>
              <div className={styles.modalLabel}>상품 변경 <span className={styles.muted}>(전표에 잘못 들어간 상품일 때 · 원가베이스유에서 검색)</span></div>
              <input
                className={styles.text}
                style={{ width: "100%" }}
                placeholder="상품코드 / 상품명 / 색상 / 사이즈 / 거래처 (예: 와이드 그레이)"
                value={prodQuery}
                onChange={(e) => setProdQuery(e.target.value)}
              />
              {itemEdit.newProduct && (
                <div className={styles.picked}>
                  <b>변경될 상품</b> {itemEdit.newProduct.name} {itemEdit.newProduct.color}/{itemEdit.newProduct.size}
                  <span className={styles.muted}> · {itemEdit.newProduct.client} · {itemEdit.newProduct.code} · 원가 {won(itemEdit.newProduct.cost)}</span>
                  <button className={styles.rowBtn} title="변경 취소" onClick={() => setItemEdit((cur) => ({ ...cur, newProduct: null }))}>✕</button>
                </div>
              )}
              <div className={styles.prodList}>
                {prodLoading && <div className={styles.muted}>검색 중...</div>}
                {!prodLoading && prodQuery.trim() && !prodResults.length && <div className={styles.muted}>검색 결과가 없습니다.</div>}
                {prodResults.map((x) => (
                  <button
                    key={x.code}
                    className={`${styles.prodRow} ${itemEdit.newProduct?.code === x.code ? styles.prodRowOn : ""}`}
                    onClick={() => setItemEdit((cur) => ({ ...cur, newProduct: x }))}
                  >
                    <span className={styles.prodName}>{x.name} <span className={styles.muted}>{x.color}/{x.size}</span></span>
                    <span className={styles.muted}>{x.client}</span>
                    <span className={styles.muted}>{x.code}</span>
                    <span className={styles.prodCost}>{x.cost ? won(x.cost) : "원가없음"}</span>
                  </button>
                ))}
              </div>
              <div className={styles.muted} style={{ marginTop: "0.3rem" }}>
                상품을 바꾸면 상품명·옵션·거래처·원가가 새 상품 기준으로 바뀌고, 거래처가 다르면 해당 거래처로 옮겨집니다.
              </div>
            </div>

            <div className={styles.row} style={{ justifyContent: "flex-end", marginTop: "0.9rem" }}>
              <button className={styles.btn} onClick={closeItemEdit} disabled={loading}>취소</button>
              <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={saveItemEdit} disabled={loading}>
                {loading ? "저장 중..." : itemEdit.newProduct ? "상품 변경 + 저장" : "저장"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
