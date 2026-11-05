import { useEffect, useMemo, useRef, useState } from "react";
import styles from "./DefectMatch.module.css";

const RESULT_LABEL = {
  next: ["다음", styles.flashNext],
  done: ["완료", styles.flashDone],
  over: ["초과 — 이미 수량을 다 채운 상품입니다", styles.flashOver],
  unknown: ["불러온 목록에 없는 상품입니다", styles.flashUnknown],
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
// groups: [{ tab, rows: [{ code, label, total }] }] — 불러온 목록. 바코드를 찍어 목록과 하나씩 매칭한다.
export default function DefectMatchModal({ groups, toKey, onClose }) {
  const rows = useMemo(
    () =>
      groups.flatMap((g) =>
        g.rows.map((row) => ({ key: `${g.tab}|${row.code}`, tab: g.tab, code: row.code, label: row.label, total: row.total })),
      ),
    [groups],
  );
  const [scanned, setScanned] = useState({});
  const [text, setText] = useState("");
  const [flash, setFlash] = useState(null);
  const [errors, setErrors] = useState([]);
  const inputRef = useRef(null);

  useEffect(() => {
    const timer = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(timer);
  }, []);

  // 바코드 메뉴와 동일: 다음(xx) / 완료(zz) / 목록없음(dd) / 초과(bb)
  const playSound = (key) => {
    const src = SOUND_SRC[key];
    if (!src) return;
    new Audio(src).play().catch(() => {});
  };

  const totalQty = rows.reduce((sum, r) => sum + r.total, 0);
  const scannedQty = rows.reduce((sum, r) => sum + (scanned[r.key] || 0), 0);
  const remainQty = totalQty - scannedQty;
  const unmatchedKinds = rows.filter((r) => (scanned[r.key] || 0) < r.total).length;

  const handleScan = () => {
    const raw = text.trim();
    setText("");
    setTimeout(() => inputRef.current?.focus(), 0);
    if (!raw) return;
    const keyed = toKey ? toKey(raw) : raw.toUpperCase();
    const code = normalizeCode(keyed) || keyed;
    const sameCode = rows.filter((r) => r.code === code);
    const target = sameCode.find((r) => (scanned[r.key] || 0) < r.total);
    let result;
    if (target) {
      const nextScanned = { ...scanned, [target.key]: (scanned[target.key] || 0) + 1 };
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

  const undoRow = (key) => setScanned((prev) => ({ ...prev, [key]: Math.max(0, (prev[key] || 0) - 1) }));

  const sortedRows = [...rows].sort((a, b) => {
    const aDone = (scanned[a.key] || 0) >= a.total;
    const bDone = (scanned[b.key] || 0) >= b.total;
    if (aDone !== bDone) return aDone ? 1 : -1;
    return String(a.label).localeCompare(String(b.label));
  });

  const handleClose = () => {
    if (unmatchedKinds > 0 && !window.confirm(`아직 매칭되지 않은 불량이 ${unmatchedKinds}종 ${remainQty}개 있습니다.\n그래도 닫을까요?`)) return;
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

        <div className={`${styles.summary} ${unmatchedKinds > 0 ? styles.summaryWarn : styles.summaryOk}`}>
          {unmatchedKinds > 0
            ? `미확인 ${unmatchedKinds}종 · 남은 ${remainQty}개 (확인 ${scannedQty} / ${totalQty})`
            : `전체 매칭 완료 (${totalQty}개)`}
        </div>

        <input
          ref={inputRef}
          className={styles.scanInput}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) handleScan(); }}
          placeholder="불량 실물 바코드 스캔"
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
          {rows.length === 0 && <div className={styles.empty}>불러온 불량이 없습니다.</div>}
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
                <button type="button" className={styles.undoBtn} onClick={() => undoRow(row.key)} disabled={n === 0}>−1</button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
