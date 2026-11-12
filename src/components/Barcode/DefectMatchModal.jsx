import { useEffect, useRef, useState } from "react";
import styles from "./DefectMatch.module.css";

const RESULT_LABEL = {
  next: ["다음", styles.flashNext],
  done: ["완료", styles.flashDone],
  over: ["초과 — 이미 수량을 다 채운 상품입니다", styles.flashOver],
  unknown: ["이 탭 불러온 목록에 없는 상품입니다", styles.flashUnknown],
};

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

// 불량 불러오기 직후 실물 이중체크.
// session: { tabs, rowsByTab: { 탭: [{ key, tab, code, label, total }] }, scanned: { key: 개수 }, doneTabs, activeTab }
//   A·B·C 탭을 각각 따로 매칭하고 탭마다 완료 처리한다. 바뀔 때마다 onChange(session)로 저장 → 창을 닫아도 이어서 할 수 있다.
//   모든 탭이 끝나면 onChange(null)로 저장분을 지운다.
// onRemove(tab, code, qty): 실물이 없는 불량을 그 탭 불량 목록에서도 지운다 (Promise).
export default function DefectMatchModal({ session, onChange, toKey, onRemove, onClose }) {
  const tabs = session.tabs ?? [];
  const rowsByTab = session.rowsByTab ?? {};
  const scanned = session.scanned ?? {};
  const doneTabs = session.doneTabs ?? {};
  const activeTab = tabs.includes(session.activeTab) ? session.activeTab : tabs[0];
  // 비동기(삭제) 뒤에도 최신 저장분 위에 덮어쓰도록 ref 로 들고 있는다.
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const update = (patch) => {
    const next = { ...sessionRef.current, ...patch };
    sessionRef.current = next;
    onChange(next);
  };
  const setScanned = (next) => update({ scanned: next });

  const [text, setText] = useState("");
  const [flash, setFlash] = useState(null);
  const [errors, setErrors] = useState([]);
  const [removing, setRemoving] = useState("");
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
    const unmatchedKinds = list.filter((r) => (scanned[r.key] || 0) < r.total).length;
    return { total, got, remain: total - got, unmatchedKinds };
  };
  const { total: totalQty, got: scannedQty, remain: remainQty, unmatchedKinds } = tabStats(activeTab);

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
    if (target) {
      const nextScanned = { ...latest, [target.key]: (latest[target.key] || 0) + 1 };
      setScanned(nextScanned);
      const allDone = rows.every((r) => (nextScanned[r.key] || 0) >= r.total);
      result = allDone ? "done" : "next";
      setFlash({ result, code, label: target.label, left: target.total - nextScanned[target.key] });
    } else {
      result = sameCode.length > 0 ? "over" : "unknown";
      setFlash({ result, code, label: sameCode[0]?.label || "", left: 0 });
      setErrors((prev) => [{ id: Date.now() + Math.random(), type: result, code, at: new Date().toLocaleTimeString("ko-KR") }, ...prev]);
    }
    playSound(result);
  };

  const undoRow = (key) => setScanned({ ...scanned, [key]: Math.max(0, (scanned[key] || 0) - 1) });

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

  const sortedRows = [...rows].sort((a, b) => {
    const aDone = (scanned[a.key] || 0) >= a.total;
    const bDone = (scanned[b.key] || 0) >= b.total;
    if (aDone !== bDone) return aDone ? 1 : -1;
    return String(a.label).localeCompare(String(b.label));
  });

  const switchTab = (tab, patch = {}) => {
    update({ ...patch, activeTab: tab });
    setFlash(null);
    setErrors([]);
    setText("");
  };

  // 현재 탭 완료 처리 → 남은 탭이 있으면 그 탭으로 넘어가고, 없으면 닫는다.
  const completeTab = () => {
    if (unmatchedKinds > 0) {
      window.alert(`${activeTab}탭에 매칭되지 않은 불량이 ${unmatchedKinds}종 ${remainQty}개 있습니다.\n실물을 찍어 매칭하거나, 실물이 없으면 [삭제]를 눌러 주세요.`);
      focusInput();
      return;
    }
    if (!window.confirm(`${activeTab}탭 매칭을 완료 처리할까요?`)) { focusInput(); return; }
    const nextDone = { ...doneTabs, [activeTab]: true };
    const nextTab = tabs.find((t) => !nextDone[t]);
    if (!nextTab) {
      onChange(null); // 전부 끝났으니 저장분 삭제
      window.alert("모든 탭 매칭이 완료되었습니다.");
      onClose();
      return;
    }
    window.alert(`${activeTab}탭 완료. ${nextTab}탭 매칭을 시작합니다.`);
    switchTab(nextTab, { doneTabs: nextDone });
  };

  const handleClose = () => {
    const pending = tabs.filter((t) => !doneTabs[t]);
    if (pending.length > 0 && !window.confirm(`아직 완료 처리하지 않은 탭이 있습니다: ${pending.join(", ")}\n지금까지 찍은 기록은 저장되며, 불량 목록의 [매칭 이어하기]로 다시 열 수 있습니다.\n닫을까요?`)) return;
    onClose();
  };

  const flashInfo = flash ? RESULT_LABEL[flash.result] : null;

  return (
    <div className={styles.overlay}>
      <div className={styles.modal}>
        <div className={styles.header}>
          <h4 className={styles.title}>불량 불러오기 — 실물 확인</h4>
          <button type="button" className={styles.closeBtn} onClick={handleClose}>닫기</button>
        </div>

        {tabs.length > 0 && (
          <div className={styles.tabBar}>
            {tabs.map((tab) => {
              const st = tabStats(tab);
              const done = Boolean(doneTabs[tab]);
              return (
                <button
                  key={tab}
                  type="button"
                  className={`${styles.tabBtn} ${tab === activeTab ? styles.tabActive : ""} ${done ? styles.tabDone : ""}`}
                  onClick={() => switchTab(tab)}
                >
                  {tab}탭 {done ? "완료" : `${st.got}/${st.total}`}
                </button>
              );
            })}
          </div>
        )}

        <div className={`${styles.summary} ${tabDone || unmatchedKinds === 0 ? styles.summaryOk : styles.summaryWarn}`}>
          {tabDone
            ? `${activeTab}탭 완료 처리됨 (${totalQty}개)`
            : unmatchedKinds > 0
              ? `${activeTab}탭 미확인 ${unmatchedKinds}종 · 남은 ${remainQty}개 (확인 ${scannedQty} / ${totalQty})`
              : `${activeTab}탭 전체 매칭 완료 (${totalQty}개) — 아래 [완료 처리]를 눌러 주세요`}
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

        <div className={styles.list}>
          {rows.length === 0 && <div className={styles.empty}>{activeTab}탭에 매칭할 불량이 없습니다.</div>}
          {sortedRows.map((row) => {
            const n = scanned[row.key] || 0;
            const done = n >= row.total;
            return (
              <div key={row.key} className={`${styles.row} ${done ? styles.rowDone : styles.rowPending}`}>
                <span className={`${styles.lamp} ${done ? styles.lampOn : styles.lampOff}`} />
                <div className={styles.rowMain}>
                  <div className={styles.rowName}>{row.label || row.code}</div>
                  <div className={styles.rowMeta}>{row.code} · {row.tab}탭</div>
                </div>
                <div className={styles.rowCount}>
                  <strong>{n} / {row.total}</strong>
                  {done ? <span className={styles.okTag}>완료</span> : <span className={styles.missTag}>미확인 {row.total - n}</span>}
                </div>
                <button type="button" className={styles.undoBtn} onClick={() => undoRow(row.key)} disabled={n === 0 || tabDone}>−1</button>
                {!done && !tabDone && (
                  <button type="button" className={styles.removeBtn} onClick={() => removeRow(row)} disabled={Boolean(removing)}>
                    {removing === row.key ? "삭제 중" : "삭제"}
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {!tabDone && (
          <button type="button" className={styles.completeBtn} onClick={completeTab}>
            {activeTab}탭 완료 처리
          </button>
        )}
      </div>
    </div>
  );
}
