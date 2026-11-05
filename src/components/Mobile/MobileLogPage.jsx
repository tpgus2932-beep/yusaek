import { useMemo, useState } from "react";
import { LOCAL_API_BASE as API, getAuthHeaders, handleUnauthorized } from "../../lib/api";
import { useEzadminSession } from "../../lib/EzadminSessionContext";
import BarcodePage from "../Barcode/BarcodePage";
import StockCheckPage from "../Barcode/StockCheckPage";
import MobileInvoiceDelete from "./MobileInvoiceDelete";
import styles from "./MobileLogPage.module.css";

const TABS = [
  { key: "barcode", label: "바코드" },
  { key: "log", label: "로그 확인" },
  { key: "stock-check", label: "재고체크" },
  { key: "invoice-delete", label: "송장삭제" },
  { key: "receipt", label: "입고확인" },
];

const request = async (path, body) => {
  const res = await fetch(`${API}${path}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json", ...getAuthHeaders() } : getAuthHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (handleUnauthorized(res)) throw new Error("로그인이 만료되었습니다.");
  const data = await res.json().catch(() => ({}));
  return { res, data };
};

const today = () => new Date().toLocaleDateString("sv-SE");
const weekAgo = () => {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return d.toLocaleDateString("sv-SE");
};

// 한글 입력 상태에서 친 상품코드("ㄴ00821" → "S00821") 보정 (재고 로그 모달과 동일 규칙)
const KO_KEY = "ㅂq ㅈw ㄷe ㄱr ㅅt ㅛy ㅕu ㅑi ㅐo ㅔp ㅁa ㄴs ㅇd ㄹf ㅎg ㅗh ㅓj ㅏk ㅣl ㅋz ㅌx ㅊc ㅍv ㅠb ㅜn ㅡm".split(" ").reduce((m, p) => { m[p[0]] = p[1]; return m; }, {});
const fixCode = (v) => v.replace(/([ㄱ-ㅣ])(?=\d)/g, (c) => (KO_KEY[c] ? KO_KEY[c].toUpperCase() : c));

function StockLog() {
  const { openModal } = useEzadminSession();
  const [code, setCode] = useState("");
  const [start, setStart] = useState(weekAgo);
  const [end, setEnd] = useState(today);
  const [type, setType] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [candidates, setCandidates] = useState([]);
  const [result, setResult] = useState(null);

  const search = async (override) => {
    const q = (typeof override === "string" ? override : code).trim();
    if (!q) { setError("상품코드 또는 상품명을 입력하세요."); return; }
    setBusy(true);
    setError("");
    try {
      if (!/^[A-Za-z]?\d+$/.test(q)) {
        const { res, data } = await request(`/wonbe/search?${new URLSearchParams({ q, limit: "50" })}`);
        if (!res.ok || data.ok === false) throw new Error(data?.detail || "상품 검색 실패");
        setResult(null);
        setCandidates(data.rows || []);
        if (!(data.rows || []).length) setError("검색된 상품이 없습니다.");
        return;
      }
      setCandidates([]);
      const { res, data } = await request("/barcode/stock-log", { product_code: q, start_date: start, end_date: end });
      if (data?.need_session) { openModal(search); return; }
      if (!res.ok) throw new Error(data?.detail || "로그 조회 실패");
      setResult(data);
    } catch (e) {
      setResult(null);
      setError(e.message || "로그 조회 실패");
    } finally {
      setBusy(false);
    }
  };

  const logs = (result?.logs || []).filter((l) => !type || l.구분 === type);
  const types = [...new Set((result?.logs || []).map((l) => l.구분).filter(Boolean))];

  return (
    <>
      <div className={styles.form}>
        <input
          className={styles.input}
          value={code}
          placeholder="상품코드 또는 상품명 (S09888)"
          onChange={(e) => setCode(fixCode(e.target.value))}
          onKeyDown={(e) => e.key === "Enter" && !busy && search()}
        />
        <div className={styles.row}>
          <input type="date" className={styles.input} value={start} max={end} onChange={(e) => setStart(e.target.value)} />
          <span>~</span>
          <input type="date" className={styles.input} value={end} min={start} onChange={(e) => setEnd(e.target.value)} />
        </div>
        <button type="button" className={styles.primary} disabled={busy} onClick={() => search()}>{busy ? "조회 중..." : "조회"}</button>
      </div>
      {error && <div className={styles.error}>{error}</div>}
      {candidates.map((c) => (
        <button type="button" key={c["상품코드"]} className={styles.card} onClick={() => { setCode(c["상품코드"]); setCandidates([]); search(c["상품코드"]); }}>
          <strong>{c["상품코드"]}</strong> {c["상품명"]}
          <div className={styles.muted}>{[c["색상"], c["사이즈"], c["거래처"]].filter(Boolean).join(" · ")}</div>
        </button>
      ))}
      {result && (
        <>
          <div className={styles.summary}>
            <span><strong>{result.product_code}</strong> · {result.count}건</span>
            {types.length > 0 && (
              <select className={styles.select} value={type} onChange={(e) => setType(e.target.value)}>
                <option value="">구분 전체</option>
                {types.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            )}
          </div>
          {logs.length === 0 && <div className={styles.muted}>조회된 로그가 없습니다.</div>}
          {logs.map((l, i) => (
            <div key={i} className={styles.card}>
              <div className={styles.cardTop}>
                <span className={styles.tag}>{l.구분}</span>
                <span className={styles.muted}>{l.일시}</span>
              </div>
              <div>수량 <strong>{l.수량}</strong> · 재고 <strong>{l.재고}</strong></div>
              {(l.수령자 || l.주문자) && <div className={styles.muted}>{[l.수령자 && `수령 ${l.수령자}`, l.주문자 && `주문 ${l.주문자}`].filter(Boolean).join(" / ")}</div>}
              {l.사유 && <div className={styles.muted}>{l.사유}</div>}
            </div>
          ))}
        </>
      )}
    </>
  );
}

const RECEIPT_KEY = "bacode-receipt-check";

// 오늘 입고요청 전표를 불러와 거래처/상품명으로 검색하며 입고 수량을 확인한다.
function ReceiptCheck() {
  const { openModal } = useEzadminSession();
  // 페이지를 껐다 켜도 불러온 입고전표가 남도록 localStorage에 보관
  const [data, setData] = useState(() => {
    try { return JSON.parse(localStorage.getItem(RECEIPT_KEY) || "null"); } catch { return null; }
  });
  const [q, setQ] = useState(() => localStorage.getItem(`${RECEIPT_KEY}:q`) || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = async (refresh = false) => {
    setBusy(true);
    setError("");
    try {
      const { res, data: d } = await request(`/order-receiving/today-receipts?refresh=${refresh}`);
      if (d?.need_session) { openModal(() => load(refresh)); return; }
      if (!res.ok || d.ok === false) throw new Error(d?.detail || "입고전표 불러오기 실패");
      setData(d);
      try { localStorage.setItem(RECEIPT_KEY, JSON.stringify({ ...d, loaded_at: new Date().toLocaleString("sv-SE") })); } catch { /* 용량 초과 등은 무시 */ }
    } catch (e) {
      setError(e.message || "입고전표 불러오기 실패");
    } finally {
      setBusy(false);
    }
  };

  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const items = useMemo(() => {
    if (!data) return [];
    return data.items.filter((it) => {
      const hay = `${it.name} ${it.product_name} ${it.client} ${it.color} ${it.size} ${it.option} ${it.code}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [data, q]); // eslint-disable-line react-hooks/exhaustive-deps
  const sum = (k) => items.reduce((s, it) => s + it[k], 0);

  return (
    <>
      <div className={styles.form}>
        <button type="button" className={styles.primary} disabled={busy} onClick={() => load(!!data)}>
          {busy ? "불러오는 중... (최대 1분)" : data ? "다시 불러오기" : "오늘 입고전표 불러오기"}
        </button>
        {data && (
          <input
            className={styles.input}
            value={q}
            placeholder="거래처 / 상품명 / 옵션 / 상품코드 검색"
            onChange={(e) => { setQ(e.target.value); localStorage.setItem(`${RECEIPT_KEY}:q`, e.target.value); }}
          />
        )}
      </div>
      {error && <div className={styles.error}>{error}</div>}
      {data && (
        <>
          <div className={styles.summary}>
            <span>{data.date} · 전표 {data.voucher_count}장{data.loaded_at && <div className={styles.muted}>불러온 시각 {data.loaded_at.slice(5, 16)}</div>}</span>
            <span><strong>입고 {sum("normal")}</strong>{sum("misong") > 0 && ` · 미송 ${sum("misong")}`}{sum("pickup") > 0 && ` · 픽업 ${sum("pickup")}`}</span>
          </div>
          {items.length === 0 && <div className={styles.muted}>{data.items.length ? "검색 결과가 없습니다." : "오늘 입고된 내역이 없습니다."}</div>}
          {items.slice(0, 300).map((it, i) => (
            <div key={i} className={styles.card}>
              <div className={styles.cardTop}>
                <strong>{it.product_name || it.name}</strong>
                <span className={styles.tag}>입고 {it.normal}</span>
              </div>
              <div className={styles.muted}>
                {[it.client, it.color, it.size, it.product_name ? "" : it.option, it.code].filter(Boolean).join(" · ")}
                {it.misong > 0 && ` · 미송 ${it.misong}`}
                {it.pickup > 0 && ` · 미송픽업 ${it.pickup}`}
              </div>
            </div>
          ))}
          {items.length > 300 && <div className={styles.muted}>검색어를 더 입력하세요 (상위 300건만 표시)</div>}
        </>
      )}
    </>
  );
}

// 모바일 전용 페이지 (/bacode): 바코드 / 로그 확인 / 재고체크 / 송장삭제.
// 바코드·재고체크는 PC 화면과 같은 컴포넌트를 그대로 쓰고, 로그 확인은 조회 전용 모바일 화면이다.
export default function MobileLogPage() {
  const [tab, setTab] = useState("barcode");
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <nav className={styles.tabs}>
          {TABS.map((t) => (
            <button key={t.key} type="button" className={`${styles.tab} ${tab === t.key ? styles.tabOn : ""}`} onClick={() => setTab(t.key)}>
              {t.label}
            </button>
          ))}
        </nav>
      </header>
      {tab === "barcode" && <BarcodePage title="Barcode" mobileLite />}
      {tab === "log" && <main className={styles.main}><StockLog /></main>}
      {tab === "stock-check" && <StockCheckPage />}
      {tab === "invoice-delete" && <main className={styles.main}><MobileInvoiceDelete /></main>}
      {tab === "receipt" && <main className={styles.main}><ReceiptCheck /></main>}
    </div>
  );
}
