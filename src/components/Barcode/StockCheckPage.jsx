import { useCallback, useEffect, useRef, useState } from "react";
import { useEzadminSession } from "../../lib/EzadminSessionContext";
import pageStyles from "./BarcodePage.module.css";
import styles from "./StockCheckPage.module.css";
import { LOCAL_API_BASE as API, getAuthHeaders, handleUnauthorized } from "../../lib/api";
import { koreanToEnglish } from "../../lib/koreanToEnglish";
import StockLogModal from "./StockLogModal";
import StockCheckHistory from "./StockCheckHistory";

const STORAGE_KEY = "stockCheckScans";
const INFO_KEY = "stockCheckInfo";
const OTHER_ZONE = "기타";

// 예전에 브라우저에만 저장하던 스캔 (서버 저장으로 옮기면서 한 번 올리고 지운다)
function readLegacy(key) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

// 스캔 수량(실물)과 이지어드민 재고(시스템)를 비교한다.
// 악성재고 상품은 비교에서 빼고 "악성재고" 행으로 따로 표시한다.
function compareZone(scanned, systemItems, isBad) {
  const rows = [];
  const seen = new Set();
  for (const it of systemItems) {
    seen.add(it.code);
    const qty = scanned[it.code] || 0;
    const status = qty === 0 ? "none" : qty > it.stock_qty ? "more" : qty < it.stock_qty ? "less" : "ok";
    rows.push({ ...it, scanQty: qty, status });
  }
  for (const [code, qty] of Object.entries(scanned)) {
    if (isBad(code)) {
      rows.push({ code, product_name: "", options: "", stock_qty: 0, scanQty: qty, status: "bad" });
    } else if (!seen.has(code)) {
      rows.push({ code, product_name: "", options: "", stock_qty: 0, scanQty: qty, status: "more", notInSystem: true });
    }
  }
  return rows;
}

// 정상화로 맞출 수 있는 행: 많음(스캔 > 재고)은 부족분만큼 입고, 없음(스캔 0, 재고 있음)은 재고만큼 출고.
// 적음, 악성재고는 대상이 아니다.
function normalizeAction(r) {
  if (r.status === "more") {
    const qty = r.scanQty - (r.stock_qty || 0);
    return qty > 0 ? { type: "in", qty, scan_qty: r.scanQty, system_qty: r.stock_qty || 0 } : null;
  }
  if (r.status === "none" && r.stock_qty > 0) return { type: "out", qty: r.stock_qty, scan_qty: r.scanQty, system_qty: r.stock_qty };
  return null;
}

// 스캔 정상화로 맞출 수 있는 행: 적음/없음처럼 스캔이 재고보다 적은 상품 (스캔을 놓친 경우).
function scanFixAction(r) {
  if ((r.status === "less" || r.status === "none") && r.stock_qty > r.scanQty) {
    return { qty: r.stock_qty, scan_qty: r.scanQty, system_qty: r.stock_qty };
  }
  return null;
}

const STATUS_LABEL = { ok: "일치", more: "많음", less: "적음", none: "없음", bad: "악성재고" };

export default function StockCheckPage({ headerExtra = null }) {
  const [scans, setScans] = useState({}); // { 구역: { 상품코드: 수량 } } - 계정별로 서버에 저장되어 폰/PC에서 같이 보인다
  const [results, setResults] = useState({}); // { 구역: [이지어드민 재고 상품] }
  const [info, setInfo] = useState({}); // { 상품코드: {name, option} }
  const scansRef = useRef(scans);
  const infoRef = useRef(info);
  scansRef.current = scans;
  infoRef.current = info;
  const [lastScan, setLastScan] = useState(null);
  const [codeInput, setCodeInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [onlyDiff, setOnlyDiff] = useState(true);
  const [normSel, setNormSel] = useState({}); // { "구역|상품코드": {zone, code, type, qty} } 정상화 선택
  const [normBusy, setNormBusy] = useState(false);
  const [scanFixBusy, setScanFixBusy] = useState(false);
  const [lastIn, setLastIn] = useState({}); // { 상품코드: "YYYY-MM-DD" | "" } 마지막 입고일 (조회 후 채운다)
  const [lastInFailed, setLastInFailed] = useState(false); // 마지막 입고일 조회가 실패했는지 (서버 미재시작/세션 만료 등)
  const lastInRef = useRef({});
  lastInRef.current = lastIn;
  const [showHistory, setShowHistory] = useState(false);
  const [moveSel, setMoveSel] = useState({}); // 구역 이동을 위해 체크한 상품코드 { 코드: true }
  const [moveTo, setMoveTo] = useState("");
  const [logCode, setLogCode] = useState(null); // 로그 확인 모달로 조회할 상품코드 (null이면 닫힘)
  const inputRef = useRef(null);
  const { openModal: openEzadminModal } = useEzadminSession();

  const post = useCallback(async (path, body) => {
    const res = await fetch(`${API}/stock-check${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...getAuthHeaders() },
      body: JSON.stringify(body),
    });
    if (handleUnauthorized(res)) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.detail || "요청 실패");
    return data;
  }, []);

  // 서버에 저장된 이 계정의 스캔 상태를 받아온다. 다른 기기(폰/PC)에서 찍은 것도 여기서 들어온다.
  const applyServerState = useCallback((data) => {
    setScans((prev) => (JSON.stringify(prev) === JSON.stringify(data.scans || {}) ? prev : data.scans || {}));
    setInfo((prev) => {
      const next = {};
      for (const [code, v] of Object.entries(data.info || {})) next[code] = { name: v.name || "", option: v.option || "", bad: Boolean(prev[code]?.bad) };
      return JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
    });
  }, []);

  const loadState = useCallback(async () => {
    const res = await fetch(`${API}/stock-check/state`, { headers: getAuthHeaders() });
    if (handleUnauthorized(res)) return;
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok) applyServerState(data);
  }, [applyServerState]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // 예전 브라우저 저장분이 있고 서버에 아직 아무것도 없으면 한 번 올린다.
        const legacyScans = readLegacy(STORAGE_KEY);
        if (Object.keys(legacyScans).length > 0) {
          const res = await fetch(`${API}/stock-check/import`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...getAuthHeaders() },
            body: JSON.stringify({ scans: legacyScans, info: readLegacy(INFO_KEY) }),
          });
          const data = await res.json().catch(() => ({}));
          if (res.ok && data.ok) {
            localStorage.removeItem(STORAGE_KEY);
            localStorage.removeItem(INFO_KEY);
            if (!cancelled) applyServerState(data);
            return;
          }
        }
        if (!cancelled) await loadState();
      } catch { /* 네트워크 오류는 다음 새로고침 주기에 다시 시도 */ }
    })();
    // 다른 기기에서 찍은 스캔이 몇 초 안에 보이도록 주기적으로 갱신한다.
    const timer = setInterval(() => { loadState().catch(() => {}); }, 4000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [applyServerState, loadState]);

  // 바코드 탭과 같은 소리: 스캔 성공 = 합포 부분 완료음(xx.wav), 실패 = 불량음(dd.wav)
  const soundsRef = useRef(null);
  useEffect(() => {
    soundsRef.current = {
      itemDone: new Audio("/sounds/xx.wav"),
      bad: new Audio("/sounds/dd.wav"),
      badStock: new Audio("/sounds/bb.wav"), // 악성재고 상품 스캔 (바코드 탭의 불량 송장음)
    };
    Object.values(soundsRef.current).forEach((a) => { a.preload = "auto"; });
  }, []);
  const playSound = useCallback((key) => {
    const audio = soundsRef.current?.[key];
    if (!audio) return;
    audio.currentTime = 0;
    audio.play().catch(() => {});
  }, []);

  const handleScan = useCallback(async () => {
    const raw = codeInput.trim();
    if (!raw) return;
    setCodeInput("");
    try {
      const data = await post("/resolve", { code: raw, record: true });
      if (!data) return;
      if (!data.ok) {
        setLastScan(null);
        setMessage(`⚠ ${data.message || "스캔 실패"}`);
        playSound("bad");
        return;
      }
      playSound(data.bad_stock ? "badStock" : "itemDone");
      const nextQty = data.qty || (scans[data.zone]?.[data.code] || 0) + 1;
      setScans((prev) => ({ ...prev, [data.zone]: { ...(prev[data.zone] || {}), [data.code]: nextQty } }));
      setInfo((prev) => ({ ...prev, [data.code]: { name: data.name || "", option: data.option || "", bad: Boolean(data.bad_stock) } }));
      setLastScan({ code: data.code, zone: data.zone, name: data.name, option: data.option, qty: nextQty, bad: Boolean(data.bad_stock) });
      setMessage("");
    } catch (err) {
      setLastScan(null);
      setMessage(`⚠ ${err.message || "구역 조회 실패"}`);
      playSound("bad");
    } finally {
      inputRef.current?.focus();
    }
  }, [codeInput, post, scans, playSound]);

  const query = useCallback(async (zones) => {
    if (zones.length === 0) { setMessage("조회할 구역이 없습니다. 상품코드를 먼저 찍어주세요."); return; }
    setBusy(true);
    setMessage("이지어드민 재고를 조회하는 중입니다.");
    try {
      // 스캔한 상품코드를 같이 보내, 상품명에 구역 접두어가 아직 없는 상품도 코드로 찾아 재고를 채운다.
      const extra = Object.fromEntries(zones.map((z) => [z, Object.keys(scansRef.current[z] || {})]));
      const data = await post("/query", { zones, extra });
      if (!data) return;
      if (data.need_session) {
        openEzadminModal(() => query(zones));
        return;
      }
      setResults((prev) => ({ ...prev, ...data.zones }));
      // 마지막 입고일은 상품마다 재고내역을 읽어야 해서 조회 결과를 먼저 보여준 뒤 뒤에서 채운다.
      (async () => {
        const all = new Set();
        for (const [z, items] of Object.entries(data.zones || {})) {
          (items || []).forEach((it) => all.add(it.code));
          Object.keys(scansRef.current[z] || {}).forEach((c) => all.add(c));
        }
        const todo = [...all].filter((c) => !(c in lastInRef.current));
        setLastInFailed(false);
        for (let i = 0; i < todo.length; i += 20) {
          try {
            const r = await post("/last-in", { codes: todo.slice(i, i + 20) });
            if (!r || !r.ok) { setLastInFailed(true); break; }
            setLastIn((prev) => ({ ...prev, ...r.last_in }));
          } catch { setLastInFailed(true); break; }
        }
      })();
      // 조회 결과를 오늘 날짜로 저장해 둔다 (어제 일치 → 오늘 불일치 찾기, 구역 정확도 등에 쓴다).
      try {
        const badNow = new Set(data.bad_codes || []);
        const snapshot = Object.entries(data.zones || {}).flatMap(([zone, items]) =>
          compareZone(scansRef.current[zone] || {}, items, (c) => badNow.has(c))
            .filter((r) => r.status !== "bad")
            .map((r) => ({
              zone, code: r.code, scan_qty: r.scanQty, system_qty: r.stock_qty || 0, status: r.status,
              name: r.product_name || infoRef.current[r.code]?.name || "", option: r.options || infoRef.current[r.code]?.option || "",
            }))
        );
        if (snapshot.length) post("/history/save", { rows: snapshot }).catch(() => {});
      } catch { /* 이력 저장 실패는 조회 자체를 막지 않는다 */ }
      // 스캔 이후 악성재고에 추가/삭제됐을 수 있으니 최신 목록으로 표시를 갱신한다.
      const badSet = new Set(data.bad_codes || []);
      setInfo((prev) => Object.fromEntries(Object.entries(prev).map(([c, v]) => [c, { ...v, bad: badSet.has(c) }])));
      setMessage("");
      return data;
    } catch (err) {
      setMessage(err.message || "재고 조회 실패");
    } finally {
      setBusy(false);
    }
  }, [post, openEzadminModal]);

  const resetZone = async (zone) => {
    if (!window.confirm(`${zone} 구역 스캔 기록을 지웁니다.`)) return;
    try {
      await post("/reset-zone", { zone });
    } catch (err) {
      setMessage(err.message || "삭제 실패");
      return;
    }
    setScans((prev) => { const next = { ...prev }; delete next[zone]; return next; });
    setResults((prev) => { const next = { ...prev }; delete next[zone]; return next; });
  };

  // 모든 구역의 스캔 기록을 한 번에 지운다 (서버에 저장된 분량 포함).
  const resetAll = async () => {
    const total = Object.values(scans).reduce((sum, z) => sum + Object.values(z).reduce((a, b) => a + b, 0), 0);
    if (!window.confirm(`모든 구역(${Object.keys(scans).length}개)의 스캔 기록 ${total}개를 전부 지웁니다.
(폰/PC에 저장된 기록도 함께 지워지며 되돌릴 수 없습니다)
진행하시겠습니까?`)) return;
    try {
      await post("/reset-all", {});
    } catch (err) {
      setMessage(err.message || "전체 초기화 실패");
      return;
    }
    setScans({});
    setResults({});
    setInfo({});
    setLastScan(null);
    setNormSel({});
    setMoveSel({});
    setMessage("전체 초기화 완료");
    inputRef.current?.focus();
  };

  // 기타 등에 모인 스캔을 체크해서 다른 구역(AD, AB…)으로 옮긴다.
  const moveScans = async (fromZone, codes) => {
    const to = moveTo.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(to)) { setMessage("이동할 구역을 영문 대문자 2글자로 입력하세요. (예: AD)"); return; }
    if (codes.length === 0) { setMessage("옮길 상품을 체크하세요."); return; }
    try {
      const data = await post("/move", { from_zone: fromZone, to_zone: to, codes });
      if (!data) return;
      applyServerState(data);
      setResults((prev) => { const next = { ...prev }; delete next[fromZone]; delete next[to]; return next; }); // 수량이 바뀐 구역은 다시 조회하게 비운다
      setMoveSel({});
      setMessage(`${fromZone} → ${to} ${data.moved}종 이동했습니다. ${to} 구역은 다시 조회해주세요.`);
    } catch (err) {
      setMessage(err.message || "이동 실패");
    }
  };

  const removeCode = async (zone, code) => {
    try {
      await post("/remove-code", { zone, code });
    } catch (err) {
      setMessage(err.message || "삭제 실패");
      return;
    }
    setScans((prev) => {
      const z = { ...(prev[zone] || {}) };
      delete z[code];
      const next = { ...prev, [zone]: z };
      if (Object.keys(z).length === 0) delete next[zone];
      return next;
    });
  };

  const toggleNorm = (zone, code, action) => {
    const key = `${zone}|${code}`;
    setNormSel((prev) => {
      const next = { ...prev };
      if (next[key]) delete next[key]; else next[key] = { zone, code, ...action };
      return next;
    });
  };

  const toggleNormZone = (zone, actionable) => {
    setNormSel((prev) => {
      const next = { ...prev };
      const allOn = actionable.every((a) => next[`${zone}|${a.code}`]);
      for (const a of actionable) {
        if (allOn) delete next[`${zone}|${a.code}`]; else next[`${zone}|${a.code}`] = { zone, ...a };
      }
      return next;
    });
  };

  const normalize = async () => {
    const picked = Object.values(normSel);
    if (picked.length === 0) { setMessage("정상화할 상품을 선택하세요."); return; }
    const ins = picked.filter((p) => p.type === "in");
    const outs = picked.filter((p) => p.type === "out");
    if (!window.confirm(
      `선택한 ${picked.length}종을 이지어드민 재고에 실제로 반영합니다.\n입고 ${ins.length}종(${ins.reduce((a, b) => a + b.qty, 0)}개) / 출고 ${outs.length}종(${outs.reduce((a, b) => a + b.qty, 0)}개)\n진행하시겠습니까?`
    )) return;
    setNormBusy(true);
    setMessage("정상화 처리 중입니다.");
    try {
      const data = await post("/normalize", { items: picked.map(({ zone, code, type, qty, scan_qty, system_qty }) => ({ zone, code, type, qty, scan_qty, system_qty, name: infoRef.current[code]?.name || "", option: infoRef.current[code]?.option || "" })) });
      if (!data) return;
      if (data.need_session) { openEzadminModal(normalize); return; }
      const zonesDone = [...new Set(picked.map((p) => p.zone))].filter((z) => z !== OTHER_ZONE);
      setNormSel({});
      setMessage(`정상화 완료: 입고 ${data.in_count}종 / 출고 ${data.out_count}종`);
      await query(zonesDone);
    } catch (err) {
      setMessage(err.message || "정상화 실패");
    } finally {
      setNormBusy(false);
    }
  };

  // 스캔 정상화: 실물을 다시 확인해 보니 스캔을 놓친 거였을 때, 스캔 수량을 이지어드민 재고에 맞춘다 (재고는 안 바뀐다).
  const fixScan = async (zone, code, fix) => {
    const add = fix.qty - fix.scan_qty;
    if (!window.confirm(
      `${code}의 스캔 수량을 ${fix.scan_qty}개 → ${fix.qty}개(이지어드민 재고)로 맞춥니다. (+${add}개)\n실물을 다시 확인해 스캔을 놓친 것이 맞을 때만 진행하세요. 이지어드민 재고는 바뀌지 않습니다.\n진행하시겠습니까?`
    )) return;
    setScanFixBusy(true);
    try {
      const hit = (results[zone] || []).find((i) => i.code === code);
      const item = { zone, code, qty: fix.qty, system_qty: fix.system_qty, name: hit?.product_name || infoRef.current[code]?.name || "", option: hit?.options || infoRef.current[code]?.option || "" };
      const data = await post("/set-scan", { items: [item] });
      if (!data) return;
      applyServerState(data);
      // 보정으로 일치가 된 상태를 오늘 조회 이력에도 반영한다.
      post("/history/save", { rows: [{ zone, code, scan_qty: item.qty, system_qty: item.system_qty, status: "ok", name: item.name, option: item.option }] }).catch(() => {});
      setMessage(`스캔 정상화 완료: ${code} ${fix.scan_qty}개 → ${fix.qty}개`);
    } catch (err) {
      setMessage(err.message || "스캔 정상화 실패");
    } finally {
      setScanFixBusy(false);
    }
  };

  // 기타(구역을 못 찾은 상품)는 이지어드민에서 검색할 구역명이 없어 조회 대상에서 뺀다. 카드는 맨 뒤에 둔다.
  const zones = Object.keys(scans).sort((a, b) => (a === OTHER_ZONE) - (b === OTHER_ZONE) || a.localeCompare(b));
  const queryableZones = zones.filter((z) => z !== OTHER_ZONE);

  return (
    <div className={pageStyles.page}>
      <div className={pageStyles.pageHeader}>
        <div>
          <h2 className={pageStyles.title}>재고체크</h2>
          <p className={pageStyles.subtitle}>상품코드를 찍어 구역(AA·AB…)별로 모으고, 이지어드민 재고(상품명 구역 + 재고 1개 이상)와 비교</p>
        </div>
        {headerExtra}
      </div>

      <div className={pageStyles.stack}>
        <section className={pageStyles.card}>
          <div className={pageStyles.cardHeader}>
            <h3 className={pageStyles.cardTitle}>상품코드 스캔</h3>
            <div className={pageStyles.headerActions}>
              <label className={styles.checkLabel}>
                <input type="checkbox" checked={onlyDiff} onChange={(e) => setOnlyDiff(e.target.checked)} />
                차이만 보기
              </label>
              <button className={pageStyles.primaryBtn} onClick={() => query(queryableZones)} disabled={busy || queryableZones.length === 0}>
                {busy ? "조회 중..." : `전체 조회 (${queryableZones.length})`}
              </button>
              <button
                className={pageStyles.primaryBtn}
                onClick={normalize}
                disabled={normBusy || busy || Object.keys(normSel).length === 0}
                title="선택한 많음(부족분 입고) / 없음(재고 출고)을 이지어드민에 반영합니다"
              >
                {normBusy ? "정상화 중..." : `정상화 (${Object.keys(normSel).length})`}
              </button>
              <button className={pageStyles.secondaryBtn} onClick={resetAll} disabled={busy || normBusy || zones.length === 0}>
                전체 초기화
              </button>
              <button className={pageStyles.secondaryBtn} onClick={() => setShowHistory((v) => !v)}>
                {showHistory ? "이력·분석 닫기" : "이력·분석"}
              </button>
            </div>
          </div>
          <input
            ref={inputRef}
            className={pageStyles.scanInput}
            value={codeInput}
            placeholder="상품코드를 스캔하세요"
            onChange={(e) => setCodeInput(koreanToEnglish(e.target.value).toUpperCase())}
            onKeyDown={(e) => { if (e.key === "Enter") handleScan(); }}
            autoFocus
          />
          {lastScan && (
            <div className={styles.lastScan}>
              <span className={styles.lastZone}>{lastScan.zone}</span>
              <span className={styles.lastName}>{lastScan.name || lastScan.code}</span>
              <span className={styles.lastOption}>{lastScan.option || "-"}</span>
              {lastScan.bad && <span className={styles.badTag}>악성재고</span>}
              <span className={styles.lastQty}>{lastScan.qty}개</span>
            </div>
          )}
          {message && <div className={pageStyles.statusMsg}>{message}</div>}
        </section>

        {showHistory && <StockCheckHistory onOpenLog={setLogCode} />}

        {zones.map((zone) => {
          const scanned = scans[zone];
          const total = Object.values(scanned).reduce((a, b) => a + b, 0);
          const system = results[zone];
          const rows = system ? compareZone(scanned, system, (c) => Boolean(info[c]?.bad)) : null;
          const shown = rows ? (onlyDiff ? rows.filter((r) => r.status !== "ok") : rows) : null;
          const count = (s) => rows?.filter((r) => r.status === s).length ?? 0;
          const actionable = (shown || []).map((r) => ({ code: r.code, ...normalizeAction(r) })).filter((a) => a.type);
          return (
            <section key={zone} className={pageStyles.card}>
              <div className={pageStyles.cardHeader}>
                <h3 className={pageStyles.cardTitle}>{zone} · 스캔 {total}개 ({Object.keys(scanned).length}종)</h3>
                <div className={pageStyles.headerActions}>
                  {rows && (
                    <>
                      <span className={pageStyles.pill}>많음 {count("more")}</span>
                      <span className={pageStyles.pill}>적음 {count("less")}</span>
                      <span className={pageStyles.pill}>없음 {count("none")}</span>
                      {count("bad") > 0 && <span className={pageStyles.pill}>악성재고 {count("bad")}</span>}
                    </>
                  )}
                  {zone === OTHER_ZONE && (
                    <>
                      <input
                        className={pageStyles.searchInput}
                        style={{ minWidth: 0, width: "7rem" }}
                        placeholder="이동할 구역 (AD)"
                        maxLength={2}
                        value={moveTo}
                        onChange={(e) => setMoveTo(e.target.value.toUpperCase())}
                      />
                      <button
                        className={pageStyles.primaryBtn}
                        onClick={() => moveScans(zone, Object.keys(moveSel).filter((c) => scanned[c] !== undefined))}
                        disabled={Object.keys(moveSel).length === 0}
                      >
                        선택 이동 ({Object.keys(moveSel).filter((c) => scanned[c] !== undefined).length})
                      </button>
                    </>
                  )}
                  {zone !== OTHER_ZONE && (
                    <button className={pageStyles.secondaryBtn} onClick={() => query([zone])} disabled={busy}>조회</button>
                  )}
                  <button className={pageStyles.secondaryBtn} onClick={() => resetZone(zone)}>초기화</button>
                </div>
              </div>
              <div className={styles.tableScroll}>
              {shown ? (
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>
                        {actionable.length > 0 && (
                          <input
                            type="checkbox"
                            title="이 구역의 정상화 가능한 상품 전체 선택"
                            checked={actionable.every((a) => normSel[`${zone}|${a.code}`])}
                            onChange={() => toggleNormZone(zone, actionable)}
                          />
                        )}
                      </th>
                      <th>상품코드</th><th>상품명</th><th>옵션</th><th>재고</th><th>스캔</th><th>결과</th><th>마지막 입고일</th><th />
                    </tr>
                  </thead>
                  <tbody>
                    {shown.length === 0 && <tr><td colSpan={9}>차이가 없습니다.</td></tr>}
                    {shown.map((r) => (
                      <tr key={r.code} className={styles[`row_${r.status}`]}>
                        <td>
                          {(() => {
                            const act = normalizeAction(r);
                            return act ? (
                              <input
                                type="checkbox"
                                checked={Boolean(normSel[`${zone}|${r.code}`])}
                                onChange={() => toggleNorm(zone, r.code, act)}
                                title={act.type === "in" ? `${act.qty}개 입고` : `${act.qty}개 출고`}
                              />
                            ) : null;
                          })()}
                        </td>
                        <td>{r.code}</td>
                        <td>{r.product_name || info[r.code]?.name || "-"}</td>
                        <td>{r.options || info[r.code]?.option || ""}</td>
                        <td>{r.stock_qty}</td>
                        <td>{r.scanQty}</td>
                        <td>{r.notInSystem ? "많음 (재고 목록에 없음)" : r.status === "bad" ? "악성재고 (비교 제외)" : STATUS_LABEL[r.status]}{(() => { const a = normalizeAction(r); return a ? ` → ${a.type === "in" ? "입고" : "출고"} ${a.qty}` : ""; })()}</td>
                        <td>{r.code in lastIn ? (lastIn[r.code] || "한 달 이상") : lastInFailed ? "확인 실패" : "…"}</td>
                        <td>{(() => { const fix = scanFixAction(r); return fix ? <button className={styles.linkBtn} disabled={scanFixBusy} onClick={() => fixScan(zone, r.code, fix)} title={`스캔 ${r.scanQty}개 → ${fix.qty}개로 보정`}>스캔맞춤</button> : null; })()}<button className={styles.linkBtn} onClick={() => setLogCode(r.code)}>로그</button>{r.scanQty > 0 && <button className={styles.linkBtn} onClick={() => removeCode(zone, r.code)}>스캔삭제</button>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <table className={styles.table}>
                  <thead>
                    <tr>
                      {zone === OTHER_ZONE && (
                        <th>
                          <input
                            type="checkbox"
                            title="전체 선택"
                            checked={Object.keys(scanned).length > 0 && Object.keys(scanned).every((c) => moveSel[c])}
                            onChange={(e) => setMoveSel(e.target.checked ? Object.fromEntries(Object.keys(scanned).map((c) => [c, true])) : {})}
                          />
                        </th>
                      )}
                      <th>상품코드</th><th>상품명</th><th>옵션</th><th>수량</th><th />
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(scanned).map(([code, qty]) => (
                      <tr key={code}>
                        {zone === OTHER_ZONE && (
                          <td>
                            <input
                              type="checkbox"
                              checked={Boolean(moveSel[code])}
                              onChange={() => setMoveSel((prev) => { const next = { ...prev }; if (next[code]) delete next[code]; else next[code] = true; return next; })}
                            />
                          </td>
                        )}
                        <td>{code}</td>
                        <td>{info[code]?.name || "-"}{info[code]?.bad && <span className={styles.badTag}>악성재고</span>}</td>
                        <td>{info[code]?.option || "-"}</td>
                        <td>{qty}</td>
                        <td><button className={styles.linkBtn} onClick={() => setLogCode(code)}>로그</button><button className={styles.linkBtn} onClick={() => removeCode(zone, code)}>스캔삭제</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              </div>
            </section>
          );
        })}
      </div>
      <StockLogModal open={Boolean(logCode)} initialCode={logCode || ""} onClose={() => setLogCode(null)} />
    </div>
  );
}
