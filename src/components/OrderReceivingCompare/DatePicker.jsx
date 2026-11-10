import { useEffect, useRef, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import styles from "./DatePicker.module.css";

const pad2 = (n) => String(n).padStart(2, "0");
const fmt = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const parse = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
};
const DOW = ["일", "월", "화", "수", "목", "금", "토"];
const label = (s) => {
  const d = parse(s);
  return d ? `${s} (${DOW[d.getDay()]})` : "날짜 선택";
};
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

// 팝업 바깥을 누르거나 Esc 를 누르면 닫는다.
function useDismiss(ref, open, close) {
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) close(); };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [ref, open, close]);
}

// 한 달 달력. getState(str) → { selected, inRange, start, end }
function Calendar({ view, setView, marks, getState, onPick, onHover }) {
  const first = new Date(view.y, view.m, 1);
  const startDate = addDays(first, -first.getDay());
  const today = fmt(new Date());
  const cells = Array.from({ length: 42 }, (_, i) => {
    const d = addDays(startDate, i);
    return { d, str: fmt(d), inMonth: d.getMonth() === view.m };
  });
  const nav = (delta) => {
    const d = new Date(view.y, view.m + delta, 1);
    setView({ y: d.getFullYear(), m: d.getMonth() });
  };
  return (
    <div>
      <div className={styles.head}>
        <button type="button" className={styles.nav} onClick={() => nav(-12)} title="이전 해">«</button>
        <button type="button" className={styles.nav} onClick={() => nav(-1)} title="이전 달"><ChevronLeft size={16} /></button>
        <div className={styles.title}>{view.y}년 {view.m + 1}월</div>
        <button type="button" className={styles.nav} onClick={() => nav(1)} title="다음 달"><ChevronRight size={16} /></button>
        <button type="button" className={styles.nav} onClick={() => nav(12)} title="다음 해">»</button>
      </div>
      <div className={styles.dow}>
        {DOW.map((w, i) => <span key={w} className={i === 0 ? styles.sun : i === 6 ? styles.sat : ""}>{w}</span>)}
      </div>
      <div className={styles.grid} onMouseLeave={() => onHover?.(null)}>
        {cells.map((c) => {
          const st = getState(c.str);
          const dow = c.d.getDay();
          const cls = [
            styles.day,
            !c.inMonth && styles.out,
            dow === 0 && styles.sun,
            dow === 6 && styles.sat,
            c.str === today && styles.today,
            st.inRange && styles.inRange,
            st.start && styles.rangeStart,
            st.end && styles.rangeEnd,
            st.selected && styles.sel,
          ].filter(Boolean).join(" ");
          return (
            <button
              key={c.str}
              type="button"
              className={cls}
              onClick={() => onPick(c.str)}
              onMouseEnter={() => onHover?.(c.str)}
            >
              <span>{c.d.getDate()}</span>
              {marks?.has(c.str) && <i className={styles.dot} title="저장된 매칭 있음" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

const viewOf = (s) => {
  const d = parse(s) || new Date();
  return { y: d.getFullYear(), m: d.getMonth() };
};

// 날짜 하나 선택. marks: 점으로 표시할 날짜(Set)
export function DatePicker({ value, onChange, disabled, marks, title, iconOnly, popRight }) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState(() => viewOf(value));
  const ref = useRef(null);
  useDismiss(ref, open, () => setOpen(false));
  const toggle = () => {
    if (disabled) return;
    if (!open) setView(viewOf(value));
    setOpen((o) => !o);
  };
  const choose = (s) => { onChange(s); setOpen(false); };
  return (
    <span className={styles.wrap} ref={ref}>
      <button type="button" className={`${styles.trigger} ${iconOnly ? styles.iconTrigger : ""}`} onClick={toggle} disabled={disabled} title={title}>
        <CalendarDays size={15} />
        {!iconOnly && <span>{label(value)}</span>}
      </button>
      {open && (
        <div className={`${styles.pop} ${popRight ? styles.popRight : ""}`}>
          <Calendar view={view} setView={setView} marks={marks} getState={(s) => ({ selected: s === value })} onPick={choose} />
          <div className={styles.foot}>
            <button type="button" className={styles.quick} onClick={() => choose(fmt(new Date()))}>오늘</button>
            <button type="button" className={styles.quick} onClick={() => choose(fmt(addDays(new Date(), -1)))}>어제</button>
            {marks && <span className={styles.legend}><i className={styles.dot} /> 저장된 매칭</span>}
          </div>
        </div>
      )}
    </span>
  );
}

// 기간 선택: 시작일 → 종료일 순서로 두 번 누른다 (거꾸로 눌러도 자동으로 정렬)
export function DateRangePicker({ from, to, onChange, marks }) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState(() => viewOf(from));
  const [anchor, setAnchor] = useState(null); // 시작일만 찍은 상태
  const [hover, setHover] = useState(null);
  const ref = useRef(null);
  const close = () => { setOpen(false); setAnchor(null); setHover(null); };
  useDismiss(ref, open, close);
  const toggle = () => {
    if (!open) setView(viewOf(from));
    setAnchor(null);
    setOpen((o) => !o);
  };
  const apply = (a, b) => { onChange(a <= b ? a : b, a <= b ? b : a); close(); };
  const pick = (s) => {
    if (!anchor) { setAnchor(s); return; }
    apply(anchor, s);
  };
  const lo = anchor ? (hover && hover < anchor ? hover : anchor) : from;
  const hi = anchor ? (hover && hover > anchor ? hover : anchor) : to;
  const getState = (s) => ({
    inRange: s > lo && s < hi,
    start: s === lo,
    end: s === hi,
    selected: false,
  });
  const preset = (kind) => {
    const now = new Date();
    const today = fmt(now);
    if (kind === "today") apply(today, today);
    if (kind === "yesterday") { const y = fmt(addDays(now, -1)); apply(y, y); }
    if (kind === "week") apply(fmt(addDays(now, -6)), today);
    if (kind === "month") apply(fmt(new Date(now.getFullYear(), now.getMonth(), 1)), fmt(new Date(now.getFullYear(), now.getMonth() + 1, 0)));
    if (kind === "lastmonth") apply(fmt(new Date(now.getFullYear(), now.getMonth() - 1, 1)), fmt(new Date(now.getFullYear(), now.getMonth(), 0)));
  };
  return (
    <span className={styles.wrap} ref={ref}>
      <button type="button" className={styles.trigger} onClick={toggle}>
        <CalendarDays size={15} />
        <span>{from === to ? label(from) : `${from} ~ ${to}`}</span>
      </button>
      {open && (
        <div className={styles.pop}>
          <div className={styles.hint}>{anchor ? `시작 ${anchor} · 종료일을 선택하세요` : "시작일을 선택하세요"}</div>
          <Calendar view={view} setView={setView} marks={marks} getState={getState} onPick={pick} onHover={anchor ? setHover : undefined} />
          <div className={styles.foot}>
            <button type="button" className={styles.quick} onClick={() => preset("today")}>오늘</button>
            <button type="button" className={styles.quick} onClick={() => preset("yesterday")}>어제</button>
            <button type="button" className={styles.quick} onClick={() => preset("week")}>최근 7일</button>
            <button type="button" className={styles.quick} onClick={() => preset("month")}>이번달</button>
            <button type="button" className={styles.quick} onClick={() => preset("lastmonth")}>지난달</button>
          </div>
        </div>
      )}
    </span>
  );
}
