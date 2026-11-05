import { useEffect, useMemo, useState } from "react";
import { Bar, Cell, ComposedChart, LabelList, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ClipboardList, Minus, PackageCheck, PackageMinus, TrendingDown, TrendingUp, Wallet } from "lucide-react";
import styles from "./SoDashboard.module.css";
import { LOCAL_API_BASE, getAuthHeaders, handleUnauthorized } from "../../lib/api";

// 색: dataviz 검증(validate_palette)을 통과한 조합. 한 차트에는 최대 2계열만 둔다
//  - 발주 파랑 #2f6fd0 / 입고 초록 #1fcf93 / 미입고 빨강 #f0483e / 금액 보라 #7c3aed / 악성 거래처 탭 마젠타 #be185d (5색 모두 통과, 초록↔빨강 CVD ΔE 12.5)
const C = { blue: "#2f6fd0", green: "#1fcf93", red: "#f0483e", violet: "#7c3aed", pink: "#be185d", ink: "#1e2a44", sub: "#7b8aa6", line: "#e6edf7", trend: "#7b8aa6" };

// 입고(초록)·미입고(빨강)는 모든 그래프에서 같은 색 (밝고 화사한 초록 / 선명한 빨강, 색약 분리도 ΔE 12.5)
const CLI = { green: C.green, red: C.red };

const pad2 = (n) => String(n).padStart(2, "0");
const fmt = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const parse = (s) => { const [y, m, d] = String(s).split("-").map(Number); return new Date(y, (m || 1) - 1, d || 1); };
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const mondayOf = (d) => addDays(d, -((d.getDay() + 6) % 7));

const MODES = {
  day: { label: "일별", unit: "일", opts: [14, 30, 60] },
  week: { label: "주간별", unit: "주", opts: [8, 12, 26] },
  month: { label: "월별", unit: "개월", opts: [6, 12] },
};

// 조회 범위 [from, to] (입고요청일 기준)
function rangeOf(mode, n) {
  const today = new Date();
  if (mode === "day") return [fmt(addDays(today, -(n - 1))), fmt(today)];
  if (mode === "week") return [fmt(addDays(mondayOf(today), -(n - 1) * 7)), fmt(today)];
  return [fmt(new Date(today.getFullYear(), today.getMonth() - (n - 1), 1)), fmt(today)];
}
// 막대 하나(일/주/월)가 덮는 날짜 범위
function bucketRange(mode, key) {
  if (mode === "day") return [key, key];
  if (mode === "week") return [key, fmt(addDays(parse(key), 6))];
  const d = parse(`${key}-01`);
  return [fmt(d), fmt(new Date(d.getFullYear(), d.getMonth() + 1, 0))];
}

const won = (n) => `${Math.round(Number(n) || 0).toLocaleString("ko-KR")}원`;
const compact = (n) => {
  const v = Math.abs(n);
  if (v >= 1e8) return `${(n / 1e8).toFixed(1)}억`;
  if (v >= 1e4) return `${Math.round(n / 1e4).toLocaleString("ko-KR")}만`;
  return String(Math.round(n));
};
const num = (n) => Math.round(Number(n) || 0).toLocaleString("ko-KR");

// 일/주/월 묶음으로 합친다. 미입고는 날짜별 (발주−입고, 0 미만은 0)을 합산한다.
function bucketize(days, mode) {
  const map = new Map();
  days.forEach((d) => {
    const date = parse(d.date);
    let key; let label;
    if (mode === "day") { key = d.date; label = `${pad2(date.getMonth() + 1)}/${pad2(date.getDate())}`; }
    else if (mode === "week") { const m = mondayOf(date); key = fmt(m); label = `${pad2(m.getMonth() + 1)}/${pad2(m.getDate())}~`; }
    else { key = d.date.slice(0, 7); label = `${date.getMonth() + 1}월`; }
    const b = map.get(key) || { key, label, amount: 0, ordered: 0, received: 0, lack: 0 };
    b.amount += d.amount || 0;
    b.ordered += d.ordered || 0;
    b.received += d.received || 0;
    b.lack += Math.max((d.ordered || 0) - (d.received || 0), 0);
    map.set(key, b);
  });
  return [...map.values()].sort((a, b) => (a.key < b.key ? -1 : 1)).map((b) => ({ ...b, rate: b.ordered > 0 ? (b.received / b.ordered) * 100 : 0 }));
}

// 추세: 최소제곱 직선. 평균 대비 (끝−시작) 변화율로 우상향/우하향/보합을 가른다 (±5%).
function trendOf(values) {
  const n = values.length;
  if (n < 3) return { ok: false, fitted: values.map(() => null), pct: 0, dir: "none" };
  const xm = (n - 1) / 2;
  const ym = values.reduce((s, v) => s + v, 0) / n;
  let sxy = 0; let sxx = 0;
  values.forEach((v, x) => { sxy += (x - xm) * (v - ym); sxx += (x - xm) ** 2; });
  const slope = sxx ? sxy / sxx : 0;
  const fitted = values.map((_, x) => ym + slope * (x - xm));
  const pct = Math.abs(ym) > 1e-9 ? ((slope * (n - 1)) / Math.abs(ym)) * 100 : 0;
  return { ok: true, fitted, pct, dir: pct > 5 ? "up" : pct < -5 ? "down" : "flat" };
}

// 방향 배지. goodUp=false 면 (미입고처럼) 올라가는 쪽이 나쁨
function TrendBadge({ t, goodUp = true, label }) {
  if (!t.ok) return <span className={`${styles.badge} ${styles.bNone}`}>데이터 부족</span>;
  const good = t.dir === "flat" ? null : (t.dir === "up") === goodUp;
  const cls = t.dir === "flat" ? styles.bFlat : good ? styles.bGood : styles.bBad;
  const Icon = t.dir === "up" ? TrendingUp : t.dir === "down" ? TrendingDown : Minus;
  const word = t.dir === "up" ? "우상향" : t.dir === "down" ? "우하향" : "보합";
  return (
    <span className={`${styles.badge} ${cls}`} title="추세선 기준, 기간 처음 대비 마지막의 변화율">
      {label && <span className={styles.badgeLabel}>{label}</span>}
      <Icon size={13} strokeWidth={2.4} />
      {word}
      {t.dir !== "flat" && <b>{t.pct > 0 ? "+" : ""}{t.pct.toFixed(0)}%</b>}
    </span>
  );
}

function Tip({ active, payload, label, money }) {
  if (!active || !payload?.length) return null;
  return (
    <div className={styles.tip}>
      <div className={styles.tipLabel}>{label}</div>
      {payload.map((p) => (
        <div key={p.dataKey} className={styles.tipRow}>
          <i style={{ background: p.dataKey.startsWith("trend") ? "transparent" : p.color, borderTop: p.dataKey.startsWith("trend") ? `2px dashed ${C.trend}` : "none" }} />
          <b>{money ? won(p.value) : `${num(p.value)}개`}</b>
          <span>{p.name}</span>
        </div>
      ))}
    </div>
  );
}

const QTY_SET = ["ordered", "received", "lack"]; // 발주·입고·미입고는 하나의 세트(수량 그래프)
const SERIES = [
  { key: "ordered", label: "발주", color: C.blue },
  { key: "received", label: "입고", color: C.green },
  { key: "lack", label: "미입고", color: C.red },
  { key: "amount", label: "금액", color: C.violet },
  { key: "clients", label: "악성 거래처", color: C.pink },
];

const xAxis = { dataKey: "label", tick: { fontSize: 11, fill: C.sub }, axisLine: false, tickLine: false, interval: "preserveStartEnd", minTickGap: 14 };

// 막대 위 숫자 (참고 디자인처럼 눈금 대신 값을 막대 위에). 막대가 많으면 가장 큰 값과 마지막 값만 쓴다.
const barLabel = (formatter, total, maxIdx, fontSize = 10.5, limit = 20) => function BarLabel({ x, y, width, value, index }) {
  if (value == null || (total > limit && index !== maxIdx && index !== total - 1)) return null;
  return <text x={x + width / 2} y={y - 6} textAnchor="middle" fontSize={fontSize} fontWeight={600} fill={C.sub}>{formatter(value)}</text>;
};

// 악성 거래처 정렬 기준 (중복 선택 가능, 여러 개면 기준별 순위를 더해 두루 부합하는 거래처가 앞)
const CSORTS = [
  { key: "ordered", label: "발주 많은 순" },
  { key: "received", label: "입고량 많은 순" },
  { key: "lack", label: "미입고 많은 순" },
];

const rateTone = (r) => (r < 50 ? "#d63a30" : r < 80 ? "#a16207" : "#12a373"); // 글자라 대비를 위해 진한 톤

// X축 눈금: 거래처 이름 아래에 입고율을 크게
function ClientTick({ x, y, payload, rates, many }) {
  const name = String(payload.value);
  const max = many ? 4 : 6; // 거래처가 많으면 이름을 짧게 (막대 간격이 좁아서)
  const short = name.length > max ? `${name.slice(0, max)}…` : name;
  const rate = rates[name] ?? 0;
  return (
    <g transform={`translate(${x},${y})`}>
      <text textAnchor="middle" dy={14} fontSize={many ? 10 : 11} fontWeight={600} fill={C.sub}>{short}</text>
      <text textAnchor="middle" dy={31} fontSize={many ? 12 : 13} fontWeight={800} fill={rateTone(rate)}>{rate.toFixed(0)}%</text>
    </g>
  );
}

function ClientTip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className={styles.tip}>
      <div className={styles.tipLabel}>{d.label}</div>
      <div className={styles.tipRow}><i style={{ background: C.sub }} /><b>{num(d.ordered)}개</b><span>발주</span></div>
      <div className={styles.tipRow}><i style={{ background: CLI.green }} /><b>{num(d.received)}개</b><span>입고</span></div>
      <div className={styles.tipRow}><i style={{ background: CLI.red }} /><b>{num(Math.max(d.ordered - d.received, 0))}개</b><span>미입고</span></div>
      <div className={styles.tipRow}><i style={{ background: "transparent" }} /><b>{d.rate.toFixed(1)}%</b><span>입고율</span></div>
    </div>
  );
}

export default function SoDashboard({ refreshSig, client = "", onClearClient }) {
  const [mode, setMode] = useState("day");
  const [count, setCount] = useState({ day: 14, week: 12, month: 6 });
  const [days, setDays] = useState([]);
  const [error, setError] = useState("");
  const [doneKey, setDoneKey] = useState(""); // 마지막으로 끝난 요청 (현재 요청과 다르면 불러오는 중)
  const expanded = false; // "자세히" 버튼은 일단 제거: 지표·요약·상품 순위가 있는 펼침 영역은 숨김 (코드는 남겨 둠)
  const [picked, setPicked] = useState(() => new Set()); // 비어 있으면 발주·입고·미입고 전체
  const isOn = (k) => picked.size === 0 || picked.has(k);
  const toggleSeries = (k) => setPicked((prev) => {
    const next = new Set(prev);
    if (next.has(k)) next.delete(k); else next.add(k);
    return next;
  });
  const [selKey, setSelKey] = useState(null); // 막대를 눌러 고른 일/주/월 (순위가 그 기간으로 좁혀진다)
  const [rankSort, setRankSort] = useState("rate"); // rate: 입고율 낮은 순 / lack: 밀린 수량 많은 순
  const [rank, setRank] = useState({ items: [], total: 0, failed: false });
  const [cRank, setCRank] = useState({ items: [], total: 0, failed: false }); // 악성 거래처
  const [cSort, setCSort] = useState(() => new Set(["ordered", "lack"])); // 기본: 발주 많고 미입고 많은 거래처
  const toggleCSort = (k) => setCSort((prev) => {
    if (prev.has(k) && prev.size === 1) return prev; // 하나는 항상 남긴다
    const next = new Set(prev);
    if (next.has(k)) next.delete(k); else next.add(k);
    return next;
  });
  const cSortKey = CSORTS.filter((c) => cSort.has(c.key)).map((c) => c.key).join(",");
  const n = count[mode];
  const reqKey = `${mode}|${n}|${refreshSig}|${client}`;
  const loading = doneKey !== reqKey;

  const changeMode = (k) => { setMode(k); setSelKey(null); };
  const changeCount = (v) => { setCount((c) => ({ ...c, [mode]: v })); setSelKey(null); };
  const toggleSel = (key) => setSelKey((cur) => (cur === key ? null : key));

  useEffect(() => {
    let cancelled = false;
    const [from, to] = rangeOf(mode, n);
    fetch(`${LOCAL_API_BASE}/order-receiving/daily-summary?${new URLSearchParams({ date_from: from, date_to: to, client })}`, { headers: getAuthHeaders() })
      .then(async (res) => {
        if (handleUnauthorized(res)) throw new Error("로그인이 만료되었습니다.");
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.detail || "대시보드 데이터를 읽지 못했습니다.");
        if (!cancelled) { setDays(data.days || []); setError(""); }
      })
      .catch((e) => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setDoneKey(reqKey); });
    return () => { cancelled = true; };
  }, [mode, n, refreshSig, reqKey, client]);

  // 입고율 낮은 상품 순위: 막대를 골랐으면 그 기간, 아니면 전체 조회 기간
  useEffect(() => {
    if (!expanded) return undefined;
    let cancelled = false;
    const [from, to] = selKey ? bucketRange(mode, selKey) : rangeOf(mode, n);
    fetch(`${LOCAL_API_BASE}/order-receiving/product-ranking?${new URLSearchParams({ date_from: from, date_to: to, sort: rankSort, limit: "10", client })}`, { headers: getAuthHeaders() })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((data) => { if (!cancelled) setRank({ items: data.items || [], total: data.total || 0, failed: false }); })
      .catch(() => { if (!cancelled) setRank({ items: [], total: 0, failed: true }); });
    return () => { cancelled = true; };
  }, [mode, n, selKey, rankSort, refreshSig, expanded, client]);

  const cliWanted = picked.size === 0 || picked.has("clients");

  const data = useMemo(() => {
    const rows = bucketize(days, mode);
    const tAmt = trendOf(rows.map((r) => r.amount));
    const tOrd = trendOf(rows.map((r) => r.ordered));
    const tRcv = trendOf(rows.map((r) => r.received));
    const tLack = trendOf(rows.map((r) => r.lack));
    const points = rows.map((r, i) => ({ ...r, trendAmount: tAmt.fitted[i] }));
    const sum = (k) => rows.reduce((s, r) => s + r[k], 0);
    const ordered = sum("ordered");
    const received = sum("received");
    const idxMax = (k) => rows.reduce((m, r, i) => (r[k] > rows[m][k] ? i : m), 0);
    const idxMin = (k) => rows.reduce((m, r, i) => (r[k] < rows[m][k] ? i : m), 0);
    const rated = rows.filter((r) => r.ordered > 0);
    const worst = rated.length ? rated.reduce((m, r) => (r.rate < m.rate ? r : m), rated[0]) : null;
    return {
      rows, points, tAmt, tOrd, tRcv, tLack,
      total: { amount: sum("amount"), ordered, received, lack: sum("lack"), rate: ordered > 0 ? (received / ordered) * 100 : 0 },
      stats: rows.length ? {
        avgAmount: sum("amount") / rows.length,
        avgOrdered: ordered / rows.length,
        avgReceived: received / rows.length,
        bestAmount: rows[idxMax("amount")],
        worstRate: worst,
        mostLack: rows[idxMax("lack")],
        fewestLack: rows[idxMin("lack")],
      } : null,
      maxIdx: { amount: idxMax("amount"), ordered: idxMax("ordered"), received: idxMax("received"), lack: idxMax("lack") },
    };
  }, [days, mode]);

  // 거래처 카드도 수량·금액 그래프와 같은 단위(일/주/월)를 따른다: 고른 막대, 없으면 가장 최근 일/주/월 하나
  const lastKey = data.rows.length ? data.rows[data.rows.length - 1].key : null;
  const cKey = selKey || lastKey;
  const cRow = cKey ? data.rows.find((r) => r.key === cKey) : null;
  const cScope = cRow ? `${cRow.label} · ${MODES[mode].label}` : "";
  useEffect(() => {
    if (!cliWanted || !cKey) return undefined;
    let cancelled = false;
    const [from, to] = bucketRange(mode, cKey);
    fetch(`${LOCAL_API_BASE}/order-receiving/client-ranking?${new URLSearchParams({ date_from: from, date_to: to, limit: "10", client, sort: cSortKey })}`, { headers: getAuthHeaders() })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((d) => { if (!cancelled) setCRank({ items: d.items || [], total: d.total || 0, failed: false }); })
      .catch(() => { if (!cancelled) setCRank({ items: [], total: 0, failed: true }); });
    return () => { cancelled = true; };
  }, [mode, cKey, refreshSig, client, cliWanted, cSortKey]);

  const cPoints = (cKey ? cRank.items : []).map((it) => ({ label: it.client, ordered: it.ordered, received: it.received, lack: Math.max(it.ordered - it.received, 0), rate: it.rate }));
  const cRates = Object.fromEntries(cPoints.map((c) => [c.label, c.rate]));
  const hasData = data.points.length > 0;
  const total = data.points.length;
  const unit = MODES[mode].label === "월별" ? "월" : mode === "week" ? "주" : "일";
  const selRow = selKey ? data.rows.find((r) => r.key === selKey) : null;
  const dim = (key) => (selKey && selKey !== key ? 0.3 : 1);

  const qtyKeys = ["ordered", "received", "lack"].filter(isOn);
  const qtyOn = qtyKeys.length > 0;
  const amtOn = isOn("amount");
  const cliOn = isOn("clients");
  const areaCount = [qtyOn, amtOn, cliOn].filter(Boolean).length;
  const qLimit = areaCount >= 3 ? 6 : areaCount === 2 ? 10 : 20; // 막대 3개씩이라 좁으면 숫자가 겹친다
  const aLimit = areaCount >= 3 ? 10 : areaCount === 2 ? 18 : 30;
  const barW = qtyKeys.length === 1 ? 52 : qtyKeys.length === 2 ? 34 : 24;
  const qtyChart = (
    <ResponsiveContainer width="100%" height={230}>
      <ComposedChart data={data.points} margin={{ top: 22, right: 4, left: 4, bottom: 0 }} barGap={3} barCategoryGap="10%">
        <XAxis {...xAxis} />
        <YAxis hide domain={[0, "auto"]} />
        <Tooltip content={<Tip />} cursor={{ fill: "rgba(47,111,208,0.06)" }} />
        {isOn("ordered") && (
          <Bar dataKey="ordered" name="발주" fill="url(#soGBlue)" radius={[7, 7, 7, 7]} maxBarSize={barW} style={{ cursor: "pointer" }} onClick={(d) => toggleSel(d?.key ?? d?.payload?.key)}>
            {data.points.map((p) => <Cell key={p.key} fillOpacity={dim(p.key)} />)}
            <LabelList dataKey="ordered" content={barLabel(num, total, data.maxIdx.ordered, 9.5, qLimit)} />
          </Bar>
        )}
        {isOn("received") && (
          <Bar dataKey="received" name="입고" fill="url(#soGGreen)" radius={[7, 7, 7, 7]} maxBarSize={barW} style={{ cursor: "pointer" }} onClick={(d) => toggleSel(d?.key ?? d?.payload?.key)}>
            {data.points.map((p) => <Cell key={p.key} fillOpacity={dim(p.key)} />)}
            <LabelList dataKey="received" content={barLabel(num, total, data.maxIdx.received, 9.5, qLimit)} />
          </Bar>
        )}
        {isOn("lack") && (
          <Bar dataKey="lack" name="미입고" fill="url(#soGRed)" radius={[7, 7, 7, 7]} maxBarSize={barW} style={{ cursor: "pointer" }} onClick={(d) => toggleSel(d?.key ?? d?.payload?.key)}>
            {data.points.map((p) => <Cell key={p.key} fillOpacity={dim(p.key)} />)}
            <LabelList dataKey="lack" content={barLabel(num, total, data.maxIdx.lack, 9.5, qLimit)} />
          </Bar>
        )}
      </ComposedChart>
    </ResponsiveContainer>
  );

  // 입고 수: 막대 안에서 초록이 시작되는 곳(경계) 바로 아래에 흰 글씨로. 초록 영역이 낮으면 생략(툴팁에 있음)
  const receivedLabel = ({ x, y, width, height, index }) => {
    const c = cPoints[index];
    if (!c || c.ordered <= 0 || c.received <= 0) return null;
    const greenTop = y + height * (c.lack / c.ordered);
    if (y + height - greenTop < 28) return null;
    return <text x={x + width / 2} y={greenTop + 20} textAnchor="middle" fontSize={10} fontWeight={700} fill="#fff">{num(c.received)}</text>;
  };

  const renderSer = (x) => (
    <button
                  key={x.key}
                  type="button"
                  className={`${styles.ser} ${isOn(x.key) ? styles.serOn : ""}`}
                  style={{ "--c": x.color }}
                  aria-pressed={isOn(x.key)}
                  onClick={() => toggleSeries(x.key)}
                  title={picked.size === 0 ? `${x.label}만 보기` : picked.has(x.key) ? "다시 누르면 해제" : `${x.label}도 같이 보기`}
                >
                  <span className={styles.led} />
                  {x.label}
                </button>
  );

  const amtChart = (
    <ResponsiveContainer width="100%" height={230}>
      <ComposedChart data={data.points} margin={{ top: 22, right: 4, left: 4, bottom: 0 }} barCategoryGap="8%">
        <XAxis {...xAxis} />
        <YAxis hide domain={[0, "auto"]} />
        <Tooltip content={<Tip money />} cursor={{ fill: "rgba(124,58,237,0.06)" }} />
        <Bar dataKey="amount" name="합산 금액" fill="url(#soGViolet)" radius={[8, 8, 8, 8]} maxBarSize={52} style={{ cursor: "pointer" }} onClick={(d) => toggleSel(d?.key ?? d?.payload?.key)}>
          {data.points.map((p) => <Cell key={p.key} fillOpacity={dim(p.key)} />)}
          <LabelList dataKey="amount" content={barLabel(compact, total, data.maxIdx.amount, 10.5, aLimit)} />
        </Bar>
        <Line type="linear" dataKey="trendAmount" name="추세" stroke={C.trend} strokeWidth={1.5} strokeDasharray="5 4" dot={false} activeDot={false} isAnimationActive={false} />
      </ComposedChart>
    </ResponsiveContainer>
  );

  return (
    <section className={`${styles.panel} ${expanded ? "" : styles.compact}`}>
      {/* 막대 그라데이션 (위가 진하고 아래로 옅어짐) */}
      <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
        <defs>
          {[["soGBlue", C.blue], ["soGGreen", C.green], ["soGRed", C.red], ["soGViolet", C.violet]].map(([id, c]) => (
            <linearGradient key={id} id={id} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={c} stopOpacity={0.92} />
              <stop offset="100%" stopColor={c} stopOpacity={0.14} />
            </linearGradient>
          ))}
          {cPoints.map((c, i) => {
            const b = c.ordered > 0 ? (c.lack / c.ordered) * 100 : 0; // 위에서부터 미입고가 차지하는 비율(%)
            const lo = Math.max(0, b - 8);
            const hi = Math.min(100, b + 8);
            return (
              <linearGradient key={`cg${c.label}`} id={`soCli${i}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={CLI.red} stopOpacity={0.96} />
                <stop offset={`${lo}%`} stopColor={CLI.red} stopOpacity={0.9} />
                <stop offset={`${hi}%`} stopColor={CLI.green} stopOpacity={0.9} />
                <stop offset="100%" stopColor={CLI.green} stopOpacity={0.5} />
              </linearGradient>
            );
          })}
        </defs>
      </svg>

      <div className={styles.controls}>
        <span className={styles.seg}>
          {Object.entries(MODES).map(([k, m]) => (
            <button key={k} type="button" className={`${styles.segBtn} ${mode === k ? styles.segOn : ""}`} onClick={() => changeMode(k)}>{m.label}</button>
          ))}
        </span>
        <select className={styles.sel} value={n} onChange={(e) => changeCount(Number(e.target.value))} title="조회 기간 (입고요청일 기준)">
          {MODES[mode].opts.map((v) => <option key={v} value={v}>최근 {v}{MODES[mode].unit}</option>)}
        </select>
        {client && (
          <span className={styles.scope} title="조회 카드의 거래처 기준으로 집계 중">
            거래처 <b>{client}</b>
            {onClearClient && <button type="button" onClick={onClearClient} aria-label="거래처 조건 해제">✕</button>}
          </span>
        )}
        {hasData && (
          <>
            <span className={styles.sers}>
              <span className={styles.serSet}>
                {SERIES.filter((x) => QTY_SET.includes(x.key)).map(renderSer)}
              </span>
              {SERIES.filter((x) => !QTY_SET.includes(x.key)).map(renderSer)}
            </span>
          </>
        )}
        <span className={styles.spacer} />
        {loading && <span className={styles.note}>불러오는 중…</span>}
      </div>

      {error && <div className={styles.error}>{error}</div>}
      {!error && !hasData && !loading && <div className={styles.empty}>{client ? `이 기간에 ${client}의 저장된 매칭이 없어요` : "이 기간에 저장된 매칭이 없어요"}</div>}

      {hasData && (
        <div className={`${styles.areas} ${areaCount === 3 ? styles.three : areaCount === 2 ? styles.two : ""}`}>
          {qtyOn && (
            <div className={styles.area}>
              <div className={styles.areaHead}>
                <b>수량</b>
                <TrendBadge t={data.tRcv} label="입고" />
                <TrendBadge t={data.tLack} goodUp={false} label="미입고" />
              </div>
              {qtyChart}
            </div>
          )}
          {amtOn && (
            <div className={styles.area}>
              <div className={styles.areaHead}>
                <b>금액</b>
                <TrendBadge t={data.tAmt} />
              </div>
              {amtChart}
            </div>
          )}
          {cliOn && (
            <div className={styles.area}>
              <div className={styles.areaHead}>
                <b>악성 거래처</b>
                <span className={styles.areaSub}>{cScope}</span>
                <span className={styles.cats}>
                  {CSORTS.map((c) => (
                    <button key={c.key} type="button" className={`${styles.cat} ${cSort.has(c.key) ? styles.catOn : ""}`} aria-pressed={cSort.has(c.key)} onClick={() => toggleCSort(c.key)}>{c.label}</button>
                  ))}
                </span>
              </div>
              {cRank.failed && <div className={styles.error}>거래처 순위를 불러오지 못했어요. 서버가 최신 버전인지(재시작) 확인해 주세요.</div>}
              {!cRank.failed && cPoints.length === 0 && <div className={styles.empty}>악성 거래처가 없어요</div>}
              {cPoints.length > 0 && (
                <ResponsiveContainer width="100%" height={230}>
                  <ComposedChart data={cPoints} margin={{ top: 22, right: 4, left: 4, bottom: 0 }} barCategoryGap="8%">
                    <XAxis dataKey="label" axisLine={false} tickLine={false} interval={0} height={46} tick={(props) => <ClientTick {...props} rates={cRates} many={cPoints.length > 6} />} />
                    <YAxis hide domain={[0, "auto"]} />
                    <Tooltip content={<ClientTip />} cursor={{ fill: "rgba(47,111,208,0.06)" }} />
                    <Bar dataKey="ordered" name="발주" radius={[8, 8, 8, 8]} maxBarSize={46}>
                      {cPoints.map((c, i) => <Cell key={c.label} fill={`url(#soCli${i})`} />)}
                      <LabelList dataKey="ordered" content={barLabel(num, cPoints.length, -1, cPoints.length > 6 ? 9.5 : 10.5, 99)} />
                      <LabelList dataKey="received" content={receivedLabel} />
                    </Bar>
                  </ComposedChart>
                </ResponsiveContainer>
              )}
            </div>
          )}
        </div>
      )}

      {hasData && expanded && (
        <>
          <div className={styles.kpis}>
            <div className={styles.kpi}>
              <span className={`${styles.kIcon} ${styles.kBlue}`}><Wallet size={17} /></span>
              <div>
                <div className={styles.kLabel}>합산 금액</div>
                <div className={styles.kNum}>{won(data.total.amount)}</div>
                <TrendBadge t={data.tAmt} />
              </div>
            </div>
            <div className={styles.kpi}>
              <span className={`${styles.kIcon} ${styles.kBlue}`}><ClipboardList size={17} /></span>
              <div>
                <div className={styles.kLabel}>발주</div>
                <div className={styles.kNum}>{num(data.total.ordered)}<small>개</small></div>
                <TrendBadge t={data.tOrd} />
              </div>
            </div>
            <div className={styles.kpi}>
              <span className={`${styles.kIcon} ${styles.kGreen}`}><PackageCheck size={17} /></span>
              <div>
                <div className={styles.kLabel}>입고 <span>입고율 {data.total.rate.toFixed(0)}%</span></div>
                <div className={styles.kNum}>{num(data.total.received)}<small>개</small></div>
                <TrendBadge t={data.tRcv} />
              </div>
            </div>
            <div className={styles.kpi}>
              <span className={`${styles.kIcon} ${styles.kRed}`}><PackageMinus size={17} /></span>
              <div>
                <div className={styles.kLabel}>미입고</div>
                <div className={styles.kNum}>{num(data.total.lack)}<small>개</small></div>
                <TrendBadge t={data.tLack} goodUp={false} />
              </div>
            </div>
          </div>

          {data.stats && (
            <div className={styles.stats}>
              <div className={styles.stat}><span>{unit}평균 금액</span><b>{won(data.stats.avgAmount)}</b></div>
              <div className={styles.stat}><span>{unit}평균 발주 · 입고</span><b>{num(data.stats.avgOrdered)} · {num(data.stats.avgReceived)}개</b></div>
              <div className={styles.stat}><span>금액 최고</span><b>{data.stats.bestAmount.label}<em>{compact(data.stats.bestAmount.amount)}원</em></b></div>
              <div className={styles.stat}><span>입고율 최저</span><b>{data.stats.worstRate ? <>{data.stats.worstRate.label}<em>{data.stats.worstRate.rate.toFixed(0)}%</em></> : "-"}</b></div>
              <div className={styles.stat}><span>미입고 최다</span><b>{data.stats.mostLack.label}<em>{num(data.stats.mostLack.lack)}개</em></b></div>
              <div className={styles.stat}><span>미입고 최소</span><b>{data.stats.fewestLack.label}<em>{num(data.stats.fewestLack.lack)}개</em></b></div>
            </div>
          )}

          <div className={styles.rank}>
            <div className={styles.rankHead}>
              <b>입고율 낮은 상품 순위</b>
              <span className={styles.rankScope}>
                {selRow ? `${selRow.label} 기준` : `최근 ${n}${MODES[mode].unit} 전체`}
                {selRow && <button type="button" className={styles.rankClear} onClick={() => setSelKey(null)}>전체 보기</button>}
                {!selRow && <span>· 위 막대를 누르면 그 {unit}만 봐요</span>}
              </span>
              <span className={styles.seg} style={{ marginLeft: "auto" }}>
                <button type="button" className={`${styles.segBtn} ${rankSort === "rate" ? styles.segOn : ""}`} onClick={() => setRankSort("rate")}>입고율 낮은 순</button>
                <button type="button" className={`${styles.segBtn} ${rankSort === "lack" ? styles.segOn : ""}`} onClick={() => setRankSort("lack")}>밀린 수량 많은 순</button>
              </span>
            </div>
            {rank.failed && <div className={styles.error}>상품 순위를 불러오지 못했어요. 서버가 최신 버전인지(재시작) 확인해 주세요.</div>}
            {!rank.failed && rank.items.length === 0 && <div className={styles.empty}>밀린 상품이 없어요</div>}
            {rank.items.map((it, i) => (
              <div key={`${it.client}|${it.code}`} className={styles.rankRow} title={`발주 ${it.ordered} · 입고 ${it.received} · 밀린 ${it.lack} · ${it.days_short}일 밀림`}>
                <span className={styles.rankNo}>{i + 1}</span>
                <span className={styles.rankName}>
                  <b>{it.name}</b>
                  <em>{[it.option, it.client].filter(Boolean).join(" · ")}</em>
                </span>
                <span className={styles.rankQty}>입고 <b>{num(it.received)}</b> / 발주 {num(it.ordered)}</span>
                <span className={styles.rankLack}>밀린 {num(it.lack)}</span>
                <span className={styles.rankBar} aria-hidden="true"><i style={{ width: `${Math.max(2, it.rate)}%` }} /></span>
                <span className={styles.rankRate}>{it.rate.toFixed(0)}%</span>
              </div>
            ))}
            {rank.total > rank.items.length && <div className={styles.rankMore}>외 {rank.total - rank.items.length}개 상품 더 있어요</div>}
          </div>
        </>
      )}
    </section>
  );
}
