import { useEffect, useRef, useState } from "react";
import styles from "./DefectMatch.module.css";

const RESULT_LABEL = {
  next: ["다음", styles.flashNext],
  done: ["완료", styles.flashDone],
  over: ["초과 — 이미 수량을 다 채운 상품입니다", styles.flashOver],
  unknown: ["이 탭 불러온 목록에 없는 상품입니다", styles.flashUnknown],
};
const RESULT_SHORT = { next: "다음", done: "완료", over: "초과", unknown: "없음" };
const RECENT_SHOW = 5;

const SOUND_SRC = {
  next: "/sounds/xx.wav",
  done: "/sounds/zz.wav",
  unknown: "/sounds/dd.wav",
  over: "/sounds/bb.wav",
};

// 서버 normalize_code 와 같은 규칙: YUSAS+5자리 / S+5자리 → S00000
const normalizeCode = (text) => {
  const s = String(text || "");
  const yusas = s.match(/YUSAS(\d{5})/i);
  if (yusas) return `S${yusas[1]}`;
  const s5 = s.match(/S(\d{5})/i);
  if (s5) return `S${s5[1]}`;
  return "";
};

// 상품 한 줄의 상태: 미확인(0개) / 부분(일부만) / 완료
const rowState = (n, total) => (n >= total ? "done" : n > 0 ? "partial" : "todo");
const STATE_ORDER = { partial: 0, todo: 1, done: 2 };

// 불량 불러오기 직후 실물 이중체크 (반품입고 매칭과 같은 방식).
// session: { tabs, rowsByTab: { 탭: [{ key, tab, code, label, total }] }, scanned: { key: 개수 }, doneTabs, activeTab }
//   탭마다 따로 매칭하고 탭마다 완료 처리한다. 바뀔 때마다 onChange(session)로 저장 → 닫아도 이어서 할 수 있다.
//   모든 탭이 끝나면 onChange(null)로 저장분을 지운다.
// allTabs: 위 탭 줄에 보여줄 전체 탭(A·B·C…). 아직 안 불러온 탭은 summonCounts[탭]={kinds,total} 를 보고
//   누르면 onSummonTab(탭) 으로 그 자리에서 불러와 바로 매칭한다.
// onRemove(tab, code, qty): 실물이 없는 불량을 그 탭 불량 목록에서도 지운다 (Promise).
// onMatch(tab, code, delta): 찍을 때 +1, 취소할 때 -1 → 서버에 "매칭된 수량" 저장 (출력·매입관리 기준)
export default function DefectMatchModal({ session, onChange, toKey, onRemove, onClose, allTabs = [], summonCounts = {}, onSummonTab, onMatch }) {
  const tabs = session.tabs ?? [];
  const rowsByTab = session.rowsByTab ?? {};
  const scanned = session.scanned ?? {};
  const doneTabs = session.doneTabs ?? {};
  const activeTab = tabs.includes(session.activeTab) ? session.activeTab : tabs[0];
  const barTabs = [...allTabs, ...tabs.filter((t) => !allTabs.includes(t))];
  // 비동기(삭제) 뒤에도 최신 저장분 위에 덮어쓰도록 ref 로 들고 있는다.
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const update = (patch) => {
    const next = { ...sessionRef.current, ...patch };
    sessionRef.current = next;
    onChange(next);
  };

  const [text, setText] = useState("");
  const [flash, setFlash] = useState(null);
  const [errors, setErrors] = useState([]);
  const [recent, setRecent] = useState([]); // 방금 찍은 목록 (위가 최신)
  const [hideDone, setHideDone] = useState(false);
  const [removing, setRemoving] = useState("");
  const [summoning, setSummoning] = useState("");
  const inputRef = useRef(null);

  const rows = rowsByTab[activeTab] ?? [];
  const tabDone = Boolean(doneTabs[activeTab]);

  const focusInput = () => setTimeout(() => inputRef.current?.focus(), 50);
  useEffect(() => {
    const timer = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(timer);
  }, [activeTab]);

  // 바코드 메뉴와 동일: 다음(xx) / 완료(zz) / 목록없음(dd) / 초과(bb)
  const playSound = (key) => {
    const src = SOUND_SRC[key];
    if (!src) return;
    new Audio(src).play().catch(() => {});
  };

  const tabStats = (tab) => {
    const list = rowsByTab[tab] ?? [];
    const total = list.reduce((sum, r) => sum + r.total, 0);
    const got = list.reduce((sum, r) => sum + Math.min(r.total, scanned[r.key] || 0), 0);
    const doneKinds = list.filter((r) => (scanned[r.key] || 0) >= r.total).length;
    return { total, got, remain: total - got, kinds: list.length, doneKinds, unmatchedKinds: list.length - doneKinds };
  };
  const st = tabStats(activeTab);
  const partialKinds = rows.filter((r) => rowState(scanned[r.key] || 0, r.total) === "partial").length;
  const progress = st.total > 0 ? Math.round((st.got / st.total) * 100) : 0;

  // 지금 고른 탭의 목록하고만 매칭한다.
  const handleScan = () => {
    const raw = text.trim();
    setText("");
    setTimeout(() => inputRef.current?.focus(), 0);
    if (!raw || tabDone) return;
    const keyed = toKey ? toKey(raw) : raw.toUpperCase();
    const code = normalizeCode(keyed) || keyed;
    const sameCode = rows.filter((r) => r.code === code);
    const latest = sessionRef.current.scanned ?? {}; // 빠르게 연속으로 찍어도 앞 스캔을 놓치지 않게
    const target = sameCode.find((r) => (latest[r.key] || 0) < r.total);
    let result;
    let left = 0;
    if (target) {
      const nextScanned = { ...latest, [target.key]: (latest[target.key] || 0) + 1 };
      update({ scanned: nextScanned });
      onMatch?.(target.tab, target.code, 1);
      const allDone = rows.every((r) => (nextScanned[r.key] || 0) >= r.total);
      result = allDone ? "done" : "next";
      left = target.total - nextScanned[target.key];
      setFlash({ result, code, label: target.label, left });
    } else {
      result = sameCode.length > 0 ? "over" : "unknown";
      setFlash({ result, code, label: sameCode[0]?.label || "", left: 0 });
      setErrors((prev) => [{ id: Date.now() + Math.random(), type: result, code, at: new Date().toLocaleTimeString("ko-KR") }, ...prev]);
    }
    const name = target?.label || sameCode[0]?.label || code;
    setRecent((prev) => [{ id: Date.now() + Math.random(), result, code, name, left, rowTotal: target?.total }, ...prev].slice(0, 30));
    playSound(result);
  };

  const undoRow = (row) => {
    const n = scanned[row.key] || 0;
    if (n <= 0) return;
    if (!window.confirm(`${row.label || row.code}\n마지막으로 찍은 1개를 취소할까요?`)) { focusInput(); return; }
    update({ scanned: { ...scanned, [row.key]: n - 1 } });
    onMatch?.(row.tab, row.code, -1);
    focusInput();
  };

  // 실물이 없는(매칭 안 된) 수량만 불량 목록에서 지운다. 일부만 매칭됐으면 매칭된 수량은 남긴다.
  const removeRow = async (row) => {
    const got = Math.min(row.total, scanned[row.key] || 0);
    const missing = row.total - got;
    if (missing <= 0 || removing) return;
    const name = row.label || row.code;
    const msg = got > 0
      ? `[${row.tab}탭] ${name}\n실물이 없는 ${missing}개를 불량 목록에서 삭제할까요?\n(매칭된 ${got}개는 그대로 남습니다)`
      : `[${row.tab}탭] ${name}\n${missing}개를 불량 목록에서 삭제할까요?`;
    if (!window.confirm(msg)) { focusInput(); return; }
    try {
      setRemoving(row.key);
      if (onRemove) await onRemove(row.tab, row.code, missing);
      const cur = sessionRef.current;
      update({
        rowsByTab: {
          ...cur.rowsByTab,
          [row.tab]: (cur.rowsByTab?.[row.tab] ?? [])
            .map((r) => (r.key === row.key ? { ...r, total: got } : r))
            .filter((r) => r.total > 0),
        },
      });
      window.alert(`${name} ${missing}개를 불량 목록에서 삭제했습니다.`);
    } catch (err) {
      window.alert(err?.message || "불량 삭제 실패");
    } finally {
      setRemoving("");
      focusInput();
    }
  };

  const visibleRows = [...rows]
    .filter((r) => !hideDone || (scanned[r.key] || 0) < r.total)
    .sort((a, b) => {
      const sa = STATE_ORDER[rowState(scanned[a.key] || 0, a.total)];
      const sb = STATE_ORDER[rowState(scanned[b.key] || 0, b.total)];
      if (sa !== sb) return sa - sb;
      return String(a.label).localeCompare(String(b.label));
    });

  const switchTab = (tab, patch = {}) => {
    update({ ...patch, activeTab: tab });
    setFlash(null);
    setErrors([]);
    setRecent([]);
    setText("");
  };

  const summonable = (tab) => {
    const c = summonCounts[tab];
    return c && c !== "?" && c.kinds > 0 ? c : null;
  };

  // 아직 안 불러온 탭을 그 자리에서 불러와 매칭 시작
  const summonTab = async (tab) => {
    const c = summonable(tab);
    if (!c || !onSummonTab || summoning) return;
    if (!window.confirm(`${tab}탭 ${c.kinds}종 ${c.total}개를 불러와서 매칭할까요?\n(케이디지 상품은 KDG 탭으로 갑니다)`)) { focusInput(); return; }
    try {
      setSummoning(tab);
      await onSummonTab(tab);
      setFlash(null);
      setErrors([]);
      setRecent([]);
    } catch (err) {
      window.alert(err?.message || "불러오기 실패");
    } finally {
      setSummoning("");
      focusInput();
    }
  };

  const clickTab = (tab) => {
    if (tabs.includes(tab)) { switchTab(tab); return; }
    summonTab(tab);
  };

  // 현재 탭 완료 처리 → 남은 탭으로 넘어가거나, 아직 안 불러온 탭이 있으면 불러올지 묻는다.
  const completeTab = async () => {
    if (st.unmatchedKinds > 0) {
      window.alert(`${activeTab}탭에 매칭되지 않은 불량이 ${st.unmatchedKinds}종 ${st.remain}개 있습니다.\n실물을 찍어 매칭하거나, 실물이 없으면 [삭제]를 눌러 주세요.`);
      focusInput();
      return;
    }
    if (!window.confirm(`${activeTab}탭 매칭을 완료 처리할까요?`)) { focusInput(); return; }
    const nextDone = { ...doneTabs, [activeTab]: true };
    const nextTab = barTabs.find((t) => tabs.includes(t) && !nextDone[t]);
    if (nextTab) {
      window.alert(`${activeTab}탭 완료. ${nextTab}탭 매칭을 시작합니다.`);
      switchTab(nextTab, { doneTabs: nextDone });
      return;
    }
    update({ doneTabs: nextDone });
    const nextSummon = barTabs.find((t) => !tabs.includes(t) && summonable(t));
    if (nextSummon) {
      await summonTab(nextSummon);
      return;
    }
    onChange(null); // 전부 끝났으니 저장분 삭제
    window.alert("모든 탭 매칭이 완료되었습니다.");
    onClose();
  };

  const handleClose = () => {
    const pending = tabs.filter((t) => !doneTabs[t]);
    if (pending.length > 0 && !window.confirm(`아직 완료 처리하지 않은 탭이 있습니다: ${pending.join(", ")}\n지금까지 찍은 기록은 저장되며, 해당 탭을 누르면 이어서 할 수 있습니다.\n닫을까요?`)) return;
    onClose();
  };

  const flashInfo = flash ? RESULT_LABEL[flash.result] : null;

  const tabLabel = (tab) => {
    if (tabs.includes(tab)) {
      const s = tabStats(tab);
      if (doneTabs[tab]) return { sub: "완료", cls: styles.tabDone };
      if (s.got === 0) return { sub: `미확인 ${s.total}`, cls: styles.tabTodo };
      return { sub: `${s.got}/${s.total}`, cls: s.got >= s.total ? styles.tabReady : styles.tabPartial };
    }
    if (summoning === tab) return { sub: "불러오는 중", cls: styles.tabEmpty };
    const c = summonCounts[tab];
    if (c === null || c === undefined) return { sub: "조회 중", cls: styles.tabEmpty };
    if (summonable(tab)) return { sub: `불러오기 ${c.total}`, cls: styles.tabSummon };
    return { sub: "없음", cls: styles.tabEmpty };
  };

  return (
    <div className={styles.overlay}>
      <div className={styles.modal}>
        <div className={styles.header}>
          <h4 className={styles.title}>불량 불러오기 — 실물 확인</h4>
          <button type="button" className={styles.closeBtn} onClick={handleClose}>닫기</button>
        </div>

        <div className={styles.tabBar}>
          {barTabs.map((tab) => {
            const { sub, cls } = tabLabel(tab);
            const inSession = tabs.includes(tab);
            return (
              <button
                key={tab}
                type="button"
                className={`${styles.tabBtn} ${cls} ${tab === activeTab ? styles.tabActive : ""}`}
                onClick={() => clickTab(tab)}
                disabled={Boolean(summoning) || (!inSession && !summonable(tab))}
              >
                <span className={styles.tabName}>{tab.endsWith("불량") ? tab : `${tab}탭`}</span>
                <span className={styles.tabSub}>{sub}</span>
              </button>
            );
          })}
        </div>

        <div className={styles.scanArea}>
          <div className={styles.summaryLine}>
            <span><strong>{st.doneKinds}</strong> / {st.kinds} 상품 완료</span>
            <span> · 총 <strong>{st.got}</strong> / {st.total}개</span>
            {partialKinds > 0 && <span className={styles.partialSum}> · 부분 {partialKinds}</span>}
            {tabDone && <span className={styles.doneSum}> · 완료 처리됨</span>}
          </div>
          <div className={styles.progress}>
            <div className={styles.progressBar} style={{ width: `${progress}%` }} />
          </div>
          <input
            ref={inputRef}
            className={styles.scanInput}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) handleScan(); }}
            placeholder={tabDone ? `${activeTab}탭은 완료 처리되었습니다` : `${activeTab}탭 불량 실물 바코드 스캔`}
            disabled={tabDone}
            autoComplete="off"
          />
          {flashInfo && (
            <div className={`${styles.flash} ${flashInfo[1]}`}>
              <strong>{flashInfo[0]}{flash.result === "next" ? ` · 남은 ${flash.left}` : ""}</strong>
              <span>{flash.code}{flash.label ? ` · ${flash.label}` : ""}</span>
            </div>
          )}
        </div>

        {recent.length > 0 && (
          <div className={styles.recent}>
            <div className={styles.recentHead}>
              <span>방금 찍은 목록 (위가 최신)</span>
              <button type="button" className={styles.clearBtn} onClick={() => setRecent([])}>비우기</button>
            </div>
            {recent.slice(0, RECENT_SHOW).map((r, idx) => (
              <div key={r.id} className={`${styles.recentRow} ${idx === 0 ? styles.recentLatest : ""}`}>
                <span className={`${styles.recentTag} ${styles[`tag_${r.result}`]}`}>{RESULT_SHORT[r.result]}</span>
                <span className={styles.recentName}>{r.name}</span>
                {(r.result === "next" || r.result === "done") && r.rowTotal != null && (
                  <span className={styles.recentLeft}>{r.left > 0 ? `남은 ${r.left}` : "완료"}</span>
                )}
              </div>
            ))}
          </div>
        )}

        {errors.length > 0 && (
          <div className={styles.errorBox}>
            <div className={styles.errorTitle}>스캔 오류 {errors.length}건</div>
            {errors.map((err) => (
              <div key={err.id} className={styles.errorRow}>
                <span className={styles.errorTag}>{err.type === "over" ? "초과" : "목록 없음"}</span>
                <span>{err.code}</span>
                <span className={styles.errorTime}>{err.at}</span>
              </div>
            ))}
            <button type="button" className={styles.clearBtn} onClick={() => setErrors([])}>오류 비우기</button>
          </div>
        )}

        {st.doneKinds > 0 && (
          <label className={styles.hideDone}>
            <input type="checkbox" checked={hideDone} onChange={(e) => setHideDone(e.target.checked)} />
            완료된 상품 숨기기 ({st.doneKinds}개)
          </label>
        )}

        <div className={styles.list}>
          {rows.length === 0 && <div className={styles.empty}>{activeTab ? `${activeTab}탭에 매칭할 불량이 없습니다.` : "매칭할 불량이 없습니다."}</div>}
          {visibleRows.map((row) => {
            const n = Math.min(row.total, scanned[row.key] || 0);
            const state = rowState(n, row.total);
            return (
              <div
                key={row.key}
                className={`${styles.row} ${state === "done" ? styles.rowDone : state === "partial" ? styles.rowPartial : styles.rowPending}`}
              >
                <span className={`${styles.lamp} ${state === "done" ? styles.lampOff : styles.lampOn}`} />
                <div className={styles.rowMain}>
                  <div className={styles.rowName}>
                    {row.label || row.code}
                    {state === "partial" && <span className={styles.partialBadge}>부분</span>}
                  </div>
                  <div className={styles.rowMeta}>{row.code}</div>
                </div>
                <div className={styles.rowCount}>
                  <span><strong>{n}</strong> / {row.total}</span>
                  {state === "done" ? <small className={styles.okTag}>완료</small> : <small className={styles.missTag}>남은 {row.total - n}</small>}
                </div>
                <div className={styles.rowBtns}>
                  <button type="button" className={styles.undoBtn} onClick={() => undoRow(row)} disabled={n === 0 || tabDone}>−1</button>
                  {state !== "done" && !tabDone && (
                    <button type="button" className={styles.removeBtn} onClick={() => removeRow(row)} disabled={Boolean(removing)}>
                      {removing === row.key ? "삭제 중" : "삭제"}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {!tabDone && rows.length > 0 && (
          <button type="button" className={styles.completeBtn} onClick={completeTab}>
            {activeTab}탭 완료 처리
          </button>
        )}
      </div>
    </div>
  );
}
