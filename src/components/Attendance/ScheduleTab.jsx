import { useCallback, useEffect, useMemo, useState } from "react";
import { addDays, format, startOfWeek } from "date-fns";
import styles from "./ScheduleTab.module.css";
import { COLLAB_API_BASE } from "../../lib/api";

const API = COLLAB_API_BASE;

const DAY_NAMES = ["월", "화", "수", "목", "금"];
const WEEKDAYS = [1, 2, 3, 4, 5];

const KOREAN_HOLIDAYS = [
  { date: "2026-01-01", name: "신정" },
  { date: "2026-02-16", name: "설날 연휴" },
  { date: "2026-02-17", name: "설날" },
  { date: "2026-02-18", name: "설날 연휴" },
  { date: "2026-03-02", name: "삼일절 대체공휴일" },
  { date: "2026-05-05", name: "어린이날" },
  { date: "2026-05-25", name: "부처님오신날 대체공휴일" },
  { date: "2026-06-03", name: "지방선거일" },
  { date: "2026-08-17", name: "광복절 대체공휴일" },
  { date: "2026-09-24", name: "추석 연휴" },
  { date: "2026-09-25", name: "추석" },
  { date: "2026-10-05", name: "개천절 대체공휴일" },
  { date: "2026-10-09", name: "한글날" },
  { date: "2026-12-25", name: "성탄절" },
  { date: "2027-01-01", name: "신정" },
  { date: "2027-02-05", name: "설날 연휴" },
  { date: "2027-02-08", name: "설날 대체공휴일" },
  { date: "2027-03-01", name: "삼일절" },
  { date: "2027-05-05", name: "어린이날" },
  { date: "2027-05-13", name: "부처님오신날" },
  { date: "2027-08-16", name: "광복절 대체공휴일" },
  { date: "2027-09-14", name: "추석 연휴" },
  { date: "2027-09-15", name: "추석" },
  { date: "2027-09-16", name: "추석 연휴" },
  { date: "2027-10-04", name: "개천절 대체공휴일" },
  { date: "2027-10-11", name: "한글날 대체공휴일" },
  { date: "2027-12-27", name: "성탄절 대체공휴일" },
  { date: "2028-01-25", name: "설날 연휴" },
  { date: "2028-01-26", name: "설날" },
  { date: "2028-01-27", name: "설날 연휴" },
  { date: "2028-03-01", name: "삼일절" },
  { date: "2028-05-02", name: "부처님오신날" },
  { date: "2028-05-05", name: "어린이날" },
  { date: "2028-06-06", name: "현충일" },
  { date: "2028-08-15", name: "광복절" },
  { date: "2028-10-02", name: "추석 연휴" },
  { date: "2028-10-03", name: "추석/개천절" },
  { date: "2028-10-04", name: "추석 연휴" },
  { date: "2028-10-05", name: "추석 대체공휴일" },
  { date: "2028-10-09", name: "한글날" },
  { date: "2028-12-25", name: "성탄절" },
  { date: "2029-01-01", name: "신정" },
  { date: "2029-02-12", name: "설날 연휴" },
  { date: "2029-02-13", name: "설날" },
  { date: "2029-02-14", name: "설날 연휴" },
  { date: "2029-03-01", name: "삼일절" },
  { date: "2029-05-07", name: "어린이날 대체공휴일" },
  { date: "2029-05-21", name: "부처님오신날 대체공휴일" },
  { date: "2029-06-06", name: "현충일" },
  { date: "2029-08-15", name: "광복절" },
  { date: "2029-09-21", name: "추석 연휴" },
  { date: "2029-09-24", name: "추석 대체공휴일" },
  { date: "2029-10-03", name: "개천절" },
  { date: "2029-10-09", name: "한글날" },
  { date: "2029-12-25", name: "성탄절" },
  { date: "2030-01-01", name: "신정" },
  { date: "2030-02-04", name: "설날" },
  { date: "2030-02-05", name: "설날 연휴" },
  { date: "2030-02-06", name: "설날 대체공휴일" },
  { date: "2030-03-01", name: "삼일절" },
  { date: "2030-05-06", name: "어린이날 대체공휴일" },
  { date: "2030-05-09", name: "부처님오신날" },
  { date: "2030-06-06", name: "현충일" },
  { date: "2030-08-15", name: "광복절" },
  { date: "2030-09-11", name: "추석 연휴" },
  { date: "2030-09-12", name: "추석" },
  { date: "2030-09-13", name: "추석 연휴" },
  { date: "2030-10-03", name: "개천절" },
  { date: "2030-10-09", name: "한글날" },
  { date: "2030-12-25", name: "성탄절" },
];

const TIME_OPTIONS = Array.from({ length: 29 }, (_, index) => {
  const totalMinutes = 8 * 60 + index * 30;
  const hour = String(Math.floor(totalMinutes / 60)).padStart(2, "0");
  const minute = String(totalMinutes % 60).padStart(2, "0");
  return `${hour}:${minute}`;
});

function getHours(start, end) {
  const [startHour, startMinute] = start.split(":").map(Number);
  const [endHour, endMinute] = end.split(":").map(Number);
  return endHour + endMinute / 60 - (startHour + startMinute / 60);
}

function formatHours(value) {
  return `${value.toFixed(1)}h`;
}

function getHoliday(date) {
  return KOREAN_HOLIDAYS.find((holiday) => holiday.date === date) ?? null;
}

export default function ScheduleTab({ pin, members }) {
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date(), { weekStartsOn: 1 }));
  const [fixedRules, setFixedRules] = useState([]);
  const [overrides, setOverrides] = useState([]);
  const [memos, setMemos] = useState([]);
  const [loading, setLoading] = useState(false);
  const [scheduleError, setScheduleError] = useState("");

  const [selected, setSelected] = useState(null);
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("14:00");
  const [copiedShift, setCopiedShift] = useState(null);
  const [showTimes, setShowTimes] = useState(false);
  const [showFixedDateManager, setShowFixedDateManager] = useState(false);
  const [showFixedTimeManager, setShowFixedTimeManager] = useState(false);
  const [showCalendarView, setShowCalendarView] = useState(false);
  const [selectedFixedMemberId, setSelectedFixedMemberId] = useState(null);
  const [editingFixedDays, setEditingFixedDays] = useState(null);
  const [selectedFixedTimeMemberId, setSelectedFixedTimeMemberId] = useState(null);
  const [selectedFixedTimeWeekday, setSelectedFixedTimeWeekday] = useState(null);
  const [fixedTimeStart, setFixedTimeStart] = useState("09:00");
  const [fixedTimeEnd, setFixedTimeEnd] = useState("14:00");
  const [selectedCalendarMemberIds, setSelectedCalendarMemberIds] = useState([]);
  const [calendarMonth, setCalendarMonth] = useState(() => format(new Date(), "yyyy-MM"));
  const [showCalendarTimes, setShowCalendarTimes] = useState(false);
  const [editorTab, setEditorTab] = useState("shift");
  const [memoDraft, setMemoDraft] = useState("");
  const [dayContextMenu, setDayContextMenu] = useState(null);

  const loadSchedule = useCallback(async () => {
    setLoading(true);
    setScheduleError("");
    try {
      const params = new URLSearchParams({ pin });
      const res = await fetch(`${API}/attendance/schedule?${params}`);
      if (!res.ok) throw new Error("스케줄 데이터를 불러오지 못했습니다.");
      const data = await res.json();
      setFixedRules(data.fixedRules || []);
      setOverrides(data.overrides || []);
      setMemos(data.memos || []);
    } catch (err) {
      setScheduleError(err.message || "스케줄 데이터를 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }, [pin]);

  useEffect(() => { loadSchedule(); }, [loadSchedule]);

  useEffect(() => {
    if (!dayContextMenu) return;
    const closeMenu = () => setDayContextMenu(null);
    const closeOnEscape = (event) => { if (event.key === "Escape") closeMenu(); };
    window.addEventListener("click", closeMenu);
    window.addEventListener("scroll", closeMenu, true);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("scroll", closeMenu, true);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [dayContextMenu]);

  const weekDays = useMemo(
    () => WEEKDAYS.map((weekday, index) => {
      const date = addDays(weekStart, index);
      return {
        weekday,
        date: format(date, "yyyy-MM-dd"),
        dayName: DAY_NAMES[index],
        label: format(date, "MM/dd"),
      };
    }),
    [weekStart]
  );

  const getFixedRule = (memberId, weekday, date) => {
    const candidates = fixedRules.filter(
      (r) => r.memberId === memberId && r.weekday === weekday && r.effectiveFrom <= date
    );
    if (!candidates.length) return null;
    const best = candidates.reduce((acc, cur) => {
      if (!acc) return cur;
      if (cur.effectiveFrom !== acc.effectiveFrom) {
        return cur.effectiveFrom > acc.effectiveFrom ? cur : acc;
      }
      return cur.id > acc.id ? cur : acc;
    }, null);
    return best && best.status === "scheduled" ? best : null;
  };

  const getOverride = (memberId, date) =>
    overrides.find((o) => o.memberId === memberId && o.date === date);

  const getMemo = (memberId, date) =>
    memos.find((m) => m.memberId === memberId && m.date === date);

  const getVisibleShift = (memberId, weekday, date) => {
    const override = getOverride(memberId, date);
    if (override) {
      if (override.status === "none") return null;
      return {
        memberId, weekday, date,
        startTime: override.startTime, endTime: override.endTime,
        status: override.status, source: "override",
      };
    }
    const fixedRule = getFixedRule(memberId, weekday, date);
    if (!fixedRule) return null;
    if (getHoliday(date)) {
      return {
        memberId, weekday, date,
        startTime: fixedRule.startTime, endTime: fixedRule.endTime,
        status: "dayOff", source: "holiday",
      };
    }
    return {
      memberId, weekday, date,
      startTime: fixedRule.startTime, endTime: fixedRule.endTime,
      status: "scheduled", source: "fixed",
    };
  };

  const selectedShift = selected ? getVisibleShift(selected.memberId, selected.weekday, selected.date) : null;
  const selectedMember = members.find((m) => m.id === selected?.memberId);

  const visibleShifts = members.flatMap((member) =>
    weekDays
      .map((day) => getVisibleShift(member.id, day.weekday, day.date))
      .filter((shift) => Boolean(shift))
  );
  const activeShifts = visibleShifts.filter((shift) => shift.status !== "dayOff");

  const weeklyHours = (memberId) =>
    activeShifts
      .filter((shift) => shift.memberId === memberId)
      .reduce((total, shift) => total + getHours(shift.startTime, shift.endTime), 0);

  const dailyHours = (date) =>
    activeShifts
      .filter((shift) => shift.date === date)
      .reduce((total, shift) => total + getHours(shift.startTime, shift.endTime), 0);

  const dailyWorkerCount = (date) =>
    activeShifts.filter((shift) => shift.date === date).length;

  const totalWeeklyHours = activeShifts.reduce((total, shift) => total + getHours(shift.startTime, shift.endTime), 0);

  const selectedFixedMember = members.find((m) => m.id === selectedFixedMemberId);
  const selectedFixedTimeMember = members.find((m) => m.id === selectedFixedTimeMemberId);

  const fixedWeekdays = (memberId) =>
    weekDays.filter((day) => getFixedRule(memberId, day.weekday, day.date)).map((day) => day.weekday);

  const startFixedDateEdit = () => {
    if (!selectedFixedMemberId) return;
    setEditingFixedDays(fixedWeekdays(selectedFixedMemberId));
  };

  const toggleEditingFixedDay = (weekday) => {
    setEditingFixedDays((prev) => {
      const current = prev ?? [];
      return current.includes(weekday) ? current.filter((d) => d !== weekday) : [...current, weekday].sort();
    });
  };

  const getFallbackFixedTime = (memberId, effectiveFrom) => {
    const candidates = fixedRules.filter(
      (r) => r.memberId === memberId && r.status === "scheduled" && r.effectiveFrom <= effectiveFrom
    );
    const best = candidates.reduce((acc, cur) => {
      if (!acc) return cur;
      if (cur.effectiveFrom !== acc.effectiveFrom) return cur.effectiveFrom > acc.effectiveFrom ? cur : acc;
      return cur.id > acc.id ? cur : acc;
    }, null);
    return { startTime: best?.startTime ?? "09:00", endTime: best?.endTime ?? "14:00" };
  };

  const getFixedTimeForWeekday = (memberId, weekday, effectiveFrom) => {
    const day = weekDays.find((d) => d.weekday === weekday);
    const rule = day ? getFixedRule(memberId, weekday, day.date) : null;
    const fallback = getFallbackFixedTime(memberId, effectiveFrom);
    return { startTime: rule?.startTime ?? fallback.startTime, endTime: rule?.endTime ?? fallback.endTime };
  };

  const selectFixedTimeWeekday = (weekday) => {
    if (!selectedFixedTimeMemberId) return;
    const day = weekDays.find((d) => d.weekday === weekday);
    const rule = day ? getFixedRule(selectedFixedTimeMemberId, weekday, day.date) : null;
    if (!rule) { setScheduleError("고정날짜가 있는 요일만 고정시간을 변경할 수 있습니다."); return; }
    setScheduleError("");
    setSelectedFixedTimeWeekday(weekday);
    setFixedTimeStart(rule.startTime);
    setFixedTimeEnd(rule.endTime);
  };

  const saveBulkFixedRules = async (memberId, effectiveFrom, rules) => {
    setScheduleError("");
    try {
      const res = await fetch(`${API}/attendance/schedule/fixed-rules/bulk`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin, memberId, effectiveFrom, rules }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || "고정 스케줄 저장에 실패했습니다.");
      setFixedRules(data.fixedRules || []);
      return true;
    } catch (err) {
      setScheduleError(err.message || "고정 스케줄 저장에 실패했습니다.");
      return false;
    }
  };

  const saveFixedTimeChange = async () => {
    if (!selectedFixedTimeMemberId || !selectedFixedTimeWeekday) return;
    const memberId = selectedFixedTimeMemberId;
    const effectiveFrom = format(weekStart, "yyyy-MM-dd");

    if (getHours(fixedTimeStart, fixedTimeEnd) <= 0) {
      setScheduleError("종료 시간은 시작 시간보다 늦어야 합니다.");
      return;
    }
    const totalHours = WEEKDAYS.reduce((total, weekday) => {
      const t = getFixedTimeForWeekday(memberId, weekday, effectiveFrom);
      const start = weekday === selectedFixedTimeWeekday ? fixedTimeStart : t.startTime;
      const end = weekday === selectedFixedTimeWeekday ? fixedTimeEnd : t.endTime;
      return total + getHours(start, end);
    }, 0);
    if (totalHours > 15) {
      setScheduleError("직원별 주 15시간을 초과할 수 없습니다.");
      return;
    }

    const rules = WEEKDAYS.map((weekday) => {
      const t = getFixedTimeForWeekday(memberId, weekday, effectiveFrom);
      const isChanged = weekday === selectedFixedTimeWeekday;
      const day = weekDays.find((d) => d.weekday === weekday);
      const existingRule = day ? getFixedRule(memberId, weekday, day.date) : null;
      return {
        weekday,
        startTime: isChanged ? fixedTimeStart : t.startTime,
        endTime: isChanged ? fixedTimeEnd : t.endTime,
        status: existingRule ? "scheduled" : "none",
      };
    });
    const ok = await saveBulkFixedRules(memberId, effectiveFrom, rules);
    if (ok) setSelectedFixedTimeWeekday(null);
  };

  const saveFixedDateChange = async () => {
    if (!selectedFixedMemberId || !editingFixedDays) return;
    const memberId = selectedFixedMemberId;
    const effectiveFrom = format(weekStart, "yyyy-MM-dd");
    const totalHours = editingFixedDays.reduce((total, weekday) => {
      const t = getFixedTimeForWeekday(memberId, weekday, effectiveFrom);
      return total + getHours(t.startTime, t.endTime);
    }, 0);
    if (totalHours > 15) {
      setScheduleError("직원별 주 15시간을 초과할 수 없습니다.");
      return;
    }
    const rules = WEEKDAYS.map((weekday) => {
      const t = getFixedTimeForWeekday(memberId, weekday, effectiveFrom);
      return {
        weekday, startTime: t.startTime, endTime: t.endTime,
        status: editingFixedDays.includes(weekday) ? "scheduled" : "none",
      };
    });
    const ok = await saveBulkFixedRules(memberId, effectiveFrom, rules);
    if (ok) setEditingFixedDays(null);
  };

  const validateShift = (memberId, date, start, end) => {
    const shiftHours = getHours(start, end);
    if (shiftHours <= 0) {
      setScheduleError("종료 시간은 시작 시간보다 늦어야 합니다.");
      return false;
    }
    const current = activeShifts.find((shift) => shift.memberId === memberId && shift.date === date);
    const currentHours = current ? getHours(current.startTime, current.endTime) : 0;
    const total = weeklyHours(memberId) - currentHours + shiftHours;
    if (total > 15) {
      setScheduleError("직원별 주 15시간을 초과할 수 없습니다.");
      return false;
    }
    setScheduleError("");
    return true;
  };

  const upsertOverride = async (memberId, weekday, date, start, end, status) => {
    setScheduleError("");
    try {
      const res = await fetch(`${API}/attendance/schedule/overrides`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin, memberId, weekday, date, startTime: start, endTime: end, status }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || "저장에 실패했습니다.");
      setOverrides(data.overrides || []);
      return true;
    } catch (err) {
      setScheduleError(err.message || "저장에 실패했습니다.");
      return false;
    }
  };

  const openDayContextMenu = (event, day) => {
    event.preventDefault();
    setDayContextMenu({
      weekday: day.weekday, date: day.date, dayName: day.dayName, label: day.label,
      x: event.clientX, y: event.clientY,
    });
  };

  const markDateOff = async () => {
    if (!dayContextMenu) return;
    const { weekday, date } = dayContextMenu;
    setScheduleError("");
    let lastOverrides = overrides;
    try {
      for (const member of members) {
        const shift = getVisibleShift(member.id, weekday, date);
        const res = await fetch(`${API}/attendance/schedule/overrides`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            pin, memberId: member.id, weekday, date,
            startTime: shift?.startTime ?? "09:00",
            endTime: shift?.endTime ?? "14:00",
            status: "dayOff",
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.detail || "휴무 지정에 실패했습니다.");
        lastOverrides = data.overrides || lastOverrides;
      }
      setOverrides(lastOverrides);
    } catch (err) {
      setScheduleError(err.message || "휴무 지정에 실패했습니다.");
    }
    setSelected(null);
    setIsEditorOpen(false);
    setDayContextMenu(null);
  };

  const saveShift = async () => {
    if (!selected) return;
    if (!validateShift(selected.memberId, selected.date, startTime, endTime)) return;
    const ok = await upsertOverride(selected.memberId, selected.weekday, selected.date, startTime, endTime, "scheduled");
    if (ok) setSelected(null);
  };

  const copySelectedShift = () => {
    if (!selectedShift || selectedShift.status === "dayOff") return;
    setCopiedShift({ startTime: selectedShift.startTime, endTime: selectedShift.endTime });
  };

  const pasteCopiedShift = async () => {
    if (!selected || !copiedShift) return;
    if (!validateShift(selected.memberId, selected.date, copiedShift.startTime, copiedShift.endTime)) return;
    const ok = await upsertOverride(selected.memberId, selected.weekday, selected.date, copiedShift.startTime, copiedShift.endTime, "scheduled");
    if (ok) setSelected(null);
  };

  const deleteShift = async () => {
    if (!selected) return;
    const ok = await upsertOverride(
      selected.memberId, selected.weekday, selected.date,
      selectedShift?.startTime ?? startTime, selectedShift?.endTime ?? endTime, "none"
    );
    if (ok) setSelected(null);
  };

  const markDayOff = async () => {
    if (!selected || !selectedShift) return;
    const ok = await upsertOverride(selected.memberId, selected.weekday, selected.date, selectedShift.startTime, selectedShift.endTime, "dayOff");
    if (ok) setSelected(null);
  };

  const restoreDate = async () => {
    if (!selected) return;
    setScheduleError("");
    try {
      const res = await fetch(`${API}/attendance/schedule/overrides`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin, memberId: selected.memberId, date: selected.date }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || "예외 해제에 실패했습니다.");
      setOverrides(data.overrides || []);
      setSelected(null);
    } catch (err) {
      setScheduleError(err.message || "예외 해제에 실패했습니다.");
    }
  };

  const openCell = (memberId, weekday, date, shift, shouldOpenEditor, tab = "shift") => {
    setSelected({ memberId, weekday, date });
    setIsEditorOpen(shouldOpenEditor);
    setEditorTab(tab);
    setStartTime(shift?.startTime ?? copiedShift?.startTime ?? "09:00");
    setEndTime(shift?.endTime ?? copiedShift?.endTime ?? "14:00");
    setMemoDraft(getMemo(memberId, date)?.content ?? "");
  };

  const saveMemo = async () => {
    if (!selected) return;
    const content = memoDraft.trim();
    setScheduleError("");
    try {
      const res = await fetch(`${API}/attendance/schedule/memos`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin, memberId: selected.memberId, date: selected.date, content }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || "메모 저장에 실패했습니다.");
      setMemos(data.memos || []);
      setIsEditorOpen(false);
    } catch (err) {
      setScheduleError(err.message || "메모 저장에 실패했습니다.");
    }
  };

  const deleteMemo = async () => {
    if (!selected) return;
    setScheduleError("");
    try {
      const res = await fetch(`${API}/attendance/schedule/memos`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin, memberId: selected.memberId, date: selected.date }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || "메모 삭제에 실패했습니다.");
      setMemos(data.memos || []);
      setMemoDraft("");
      setIsEditorOpen(false);
    } catch (err) {
      setScheduleError(err.message || "메모 삭제에 실패했습니다.");
    }
  };

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (!selected) return;
      const tagName = event.target?.tagName?.toLowerCase();
      if (tagName === "input" || tagName === "select" || tagName === "textarea") return;
      if (event.ctrlKey && event.key.toLowerCase() === "c") { event.preventDefault(); copySelectedShift(); }
      if (event.ctrlKey && event.key.toLowerCase() === "v") { event.preventDefault(); pasteCopiedShift(); }
      if (event.key === "Delete") { event.preventDefault(); deleteShift(); }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  const toggleCalendarMember = (memberId) => {
    setSelectedCalendarMemberIds((prev) =>
      prev.includes(memberId) ? prev.filter((id) => id !== memberId) : [...prev, memberId]
    );
  };

  const calendarDays = useMemo(() => {
    const [year, month] = calendarMonth.split("-").map(Number);
    const monthStart = new Date(year, month - 1, 1);
    const firstCalendarIndex = (monthStart.getDay() + 6) % 7;
    const calendarStart = addDays(monthStart, -firstCalendarIndex);
    return Array.from({ length: 30 }, (_, index) => {
      const weekIndex = Math.floor(index / 5);
      const weekdayIndex = index % 5;
      const date = addDays(calendarStart, weekIndex * 7 + weekdayIndex);
      return {
        date: format(date, "yyyy-MM-dd"),
        day: format(date, "d"),
        weekday: weekdayIndex + 1,
        isCurrentMonth: date.getMonth() === monthStart.getMonth(),
        isNextMonth: date > monthStart && date.getMonth() !== monthStart.getMonth(),
      };
    });
  }, [calendarMonth]);

  const calendarMonthTitle = useMemo(() => {
    const [, month] = calendarMonth.split("-");
    return `${Number(month)}월`;
  }, [calendarMonth]);

  const calendarMemberNames = selectedCalendarMemberIds
    .map((id) => members.find((m) => m.id === id))
    .filter(Boolean);

  return (
    <div className={styles.root}>
      {scheduleError && <div className={styles.errorBanner}>{scheduleError}</div>}
      {loading && <div className={styles.errorBanner} style={{ background: "#eff6ff", borderColor: "#bfdbfe", color: "#1d4ed8" }}>불러오는 중...</div>}

      <header className={styles.toolbar}>
        <button onClick={() => setWeekStart(addDays(weekStart, -7))}>이전 주</button>
        <div className={styles.titleArea}>
          <h1>근무표</h1>
          <label className={styles.datePicker}>
            주차 이동
            <input
              type="date"
              value={format(weekStart, "yyyy-MM-dd")}
              onChange={(event) => setWeekStart(startOfWeek(new Date(event.target.value), { weekStartsOn: 1 }))}
            />
          </label>
          <p className={styles.copyStatus}>
            {format(weekStart, "yyyy.MM.dd")} 주차 · Ctrl+C / Ctrl+V / Delete
          </p>
          {copiedShift && <p className={styles.copyStatus}>복사됨: {copiedShift.startTime}-{copiedShift.endTime}</p>}
        </div>
        <button onClick={() => setWeekStart(addDays(weekStart, 7))}>다음 주</button>
      </header>

      <section className={styles.employeePanel}>
        <div>
          <h2>근무표 관리</h2>
          <p>휴무와 날짜별 수정은 표에서, 고정 요일 변경은 직원별로 관리합니다.</p>
        </div>
        <div className={styles.employeeForm}>
          <button onClick={() => setShowTimes((prev) => !prev)}>
            {showTimes ? "시간대 숨기기 ▲" : "시간대 보기 ▼"}
          </button>
          <button
            className={showFixedDateManager ? `${styles.modeButton} ${styles.active}` : styles.modeButton}
            onClick={() => { setShowFixedDateManager((prev) => !prev); setEditingFixedDays(null); }}
          >
            {showFixedDateManager ? "고정날짜 닫기" : "고정날짜 변경"}
          </button>
          <button
            className={showFixedTimeManager ? `${styles.modeButton} ${styles.active}` : styles.modeButton}
            onClick={() => { setShowFixedTimeManager((prev) => !prev); setSelectedFixedTimeWeekday(null); }}
          >
            {showFixedTimeManager ? "고정시간 닫기" : "고정시간 변경"}
          </button>
          <button
            className={showCalendarView ? `${styles.modeButton} ${styles.active}` : styles.modeButton}
            onClick={() => setShowCalendarView((prev) => !prev)}
          >
            {showCalendarView ? "캘린더 닫기" : "캘린더 보기"}
          </button>
        </div>
      </section>

      {showFixedDateManager && (
        <section className={`${styles.employeePanel} ${styles.fixedDatePanel}`}>
          <div>
            <h2>고정날짜 변경</h2>
            <p>{format(weekStart, "yyyy.MM.dd")} 주차부터 이후 주차의 고정 요일이 변경됩니다.</p>
          </div>
          <div className={styles.fixedEmployeeList}>
            {members.map((member) => (
              <button
                className={selectedFixedMemberId === member.id ? `${styles.fixedEmployee} ${styles.active}` : styles.fixedEmployee}
                key={member.id}
                onClick={() => { setSelectedFixedMemberId(member.id); setEditingFixedDays(null); }}
              >
                {member.name}
              </button>
            ))}
          </div>
          <div className={styles.fixedDateActions}>
            <strong>{selectedFixedMember ? `${selectedFixedMember.name} 고정날짜` : "직원을 선택해주세요"}</strong>
            <button onClick={startFixedDateEdit} disabled={!selectedFixedMemberId}>수정</button>
          </div>
          {selectedFixedMemberId && (
            <div className={styles.weekdayToggleGroup}>
              {weekDays.map((day) => {
                const activeDays = editingFixedDays ?? fixedWeekdays(selectedFixedMemberId);
                const isActive = activeDays.includes(day.weekday);
                return (
                  <button
                    className={isActive ? `${styles.weekdayToggle} ${styles.active}` : styles.weekdayToggle}
                    disabled={!editingFixedDays}
                    key={day.weekday}
                    onClick={() => toggleEditingFixedDay(day.weekday)}
                  >
                    <span>{day.dayName}</span>
                  </button>
                );
              })}
            </div>
          )}
          {editingFixedDays && (
            <div className={styles.fixedDateSaveRow}>
              <button onClick={saveFixedDateChange}>저장</button>
              <button onClick={() => setEditingFixedDays(null)}>취소</button>
            </div>
          )}
        </section>
      )}

      {showFixedTimeManager && (
        <section className={`${styles.employeePanel} ${styles.fixedDatePanel}`}>
          <div>
            <h2>고정시간 변경</h2>
            <p>{format(weekStart, "yyyy.MM.dd")} 주차부터 이후 주차의 고정 시간이 변경됩니다.</p>
          </div>
          <div className={styles.fixedEmployeeList}>
            {members.map((member) => (
              <button
                className={selectedFixedTimeMemberId === member.id ? `${styles.fixedEmployee} ${styles.active}` : styles.fixedEmployee}
                key={member.id}
                onClick={() => { setSelectedFixedTimeMemberId(member.id); setSelectedFixedTimeWeekday(null); }}
              >
                {member.name}
              </button>
            ))}
          </div>
          <div className={styles.fixedDateActions}>
            <strong>{selectedFixedTimeMember ? `${selectedFixedTimeMember.name} 고정시간` : "직원을 선택해주세요"}</strong>
          </div>
          {selectedFixedTimeMemberId && (
            <div className={styles.weekdayToggleGroup}>
              {weekDays.map((day) => {
                const rule = getFixedRule(selectedFixedTimeMemberId, day.weekday, day.date);
                const isSelected = selectedFixedTimeWeekday === day.weekday;
                return (
                  <button
                    className={isSelected ? `${styles.weekdayToggle} ${styles.active}` : styles.weekdayToggle}
                    key={day.weekday}
                    onClick={() => selectFixedTimeWeekday(day.weekday)}
                  >
                    <span>{day.dayName}</span>
                    {rule ? <em>{rule.startTime}-{rule.endTime}</em> : <em>고정 없음</em>}
                  </button>
                );
              })}
            </div>
          )}
          {selectedFixedTimeMemberId && selectedFixedTimeWeekday && (
            <div className={styles.fixedTimeEditor}>
              <label>
                시작 시간
                <select value={fixedTimeStart} onChange={(e) => setFixedTimeStart(e.target.value)}>
                  {TIME_OPTIONS.map((time) => <option key={time} value={time}>{time}</option>)}
                </select>
              </label>
              <label>
                종료 시간
                <select value={fixedTimeEnd} onChange={(e) => setFixedTimeEnd(e.target.value)}>
                  {TIME_OPTIONS.map((time) => <option key={time} value={time}>{time}</option>)}
                </select>
              </label>
              <p className={styles.modalSummary}>표시: {formatHours(Math.max(0, getHours(fixedTimeStart, fixedTimeEnd)))}</p>
              <div className={styles.fixedDateSaveRow}>
                <button onClick={saveFixedTimeChange}>저장</button>
                <button onClick={() => setSelectedFixedTimeWeekday(null)}>취소</button>
              </div>
            </div>
          )}
        </section>
      )}

      {showCalendarView && (
        <section className={`${styles.employeePanel} ${styles.calendarPanel}`}>
          <div>
            <h2>캘린더 보기</h2>
            <p>직원과 년/월을 선택하면 해당 월의 근무일이 달력에 표시됩니다.</p>
          </div>
          <div className={styles.calendarControls}>
            <div className={styles.calendarControlGroup}>
              <label>
                년도 + 월
                <input type="month" value={calendarMonth} onChange={(e) => setCalendarMonth(e.target.value)} />
              </label>
              <label className={styles.calendarTimeToggle}>
                <input type="checkbox" checked={showCalendarTimes} onChange={(e) => setShowCalendarTimes(e.target.checked)} />
                출근시간대 표기
              </label>
            </div>
            <div className={styles.calendarSelectionSummary}>
              {calendarMemberNames.length > 0 ? calendarMemberNames.map((m) => m.name).join(", ") : "직원을 선택해주세요"}
            </div>
          </div>
          <div className={styles.fixedEmployeeList}>
            {members.map((member) => (
              <button
                className={selectedCalendarMemberIds.includes(member.id) ? `${styles.fixedEmployee} ${styles.active}` : styles.fixedEmployee}
                key={member.id}
                onClick={() => toggleCalendarMember(member.id)}
              >
                {member.name}
              </button>
            ))}
          </div>
          <div className={styles.calendarMonthTitle}>{calendarMonthTitle}</div>
          <div className={styles.monthlyCalendar}>
            {DAY_NAMES.map((dayName) => <div className={styles.calendarWeekday} key={dayName}>{dayName}</div>)}
            {calendarDays.map((day) => {
              if (day.isNextMonth) return <div className={`${styles.calendarDay} ${styles.empty}`} key={day.date} />;
              const holiday = getHoliday(day.date);
              const dayWorkers = calendarMemberNames
                .map((member) => ({ member, shift: getVisibleShift(member.id, day.weekday, day.date) }))
                .filter(({ shift }) => Boolean(shift));
              return (
                <div
                  className={`${styles.calendarDay} ${holiday ? styles.holiday : ""} ${day.isCurrentMonth ? "" : styles.outsideMonth}`}
                  key={day.date}
                >
                  <div className={styles.calendarDateHeader}>
                    <span className={styles.calendarDateNumber}>{day.day}</span>
                    {holiday && <span className={styles.holidayBadge}>{holiday.name}</span>}
                  </div>
                  <div className={`${styles.calendarNameList} ${dayWorkers.length >= 4 ? styles.dense : ""}`}>
                    {dayWorkers.map(({ member, shift }) => (
                      <span className={`${styles.calendarNameBadge} ${shift?.status === "dayOff" ? styles.dayOff : ""}`} key={member.id}>
                        <span>{member.name}</span>
                        {shift?.status === "dayOff" && <span>휴무</span>}
                        {showCalendarTimes && shift?.status !== "dayOff" && <small>{shift?.startTime}-{shift?.endTime}</small>}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <section className={styles.table}>
        <div className={`${styles.row} ${styles.header}`}>
          <div className={`${styles.cell} ${styles.name}`}>직원</div>
          {weekDays.map((day) => {
            const holiday = getHoliday(day.date);
            return (
              <div
                className={`${styles.cell} ${styles.dayHeader} ${holiday ? styles.holiday : ""}`}
                key={day.weekday}
                onContextMenu={(event) => openDayContextMenu(event, day)}
              >
                <strong>{day.dayName}</strong>
                <span>{day.label}</span>
                {holiday && <em>{holiday.name}</em>}
              </div>
            );
          })}
          <div className={`${styles.cell} ${styles.total}`}>주간합계</div>
        </div>

        {members.map((member) => (
          <div className={styles.row} key={member.id}>
            <div className={`${styles.cell} ${styles.name}`}>{member.name}</div>
            {weekDays.map((day) => {
              const shift = getVisibleShift(member.id, day.weekday, day.date);
              const holiday = getHoliday(day.date);
              const memo = getMemo(member.id, day.date);
              const isDayOff = shift?.status === "dayOff";
              const shiftHours = shift && !isDayOff ? getHours(shift.startTime, shift.endTime) : 0;
              const isSelected = selected?.memberId === member.id && selected?.weekday === day.weekday && selected?.date === day.date;

              return (
                <div
                  className={`${styles.cell} ${styles.shift} ${shift ? styles.filled : ""} ${isDayOff ? styles.dayOff : ""} ${shift?.source === "override" ? styles.override : ""} ${isSelected ? styles.selected : ""}`}
                  key={day.weekday}
                  role="button"
                  tabIndex={0}
                  onClick={() => openCell(member.id, day.weekday, day.date, shift, false)}
                  onDoubleClick={() => openCell(member.id, day.weekday, day.date, shift, true)}
                  onKeyDown={(event) => { if (event.key === "Enter") openCell(member.id, day.weekday, day.date, shift, true); }}
                >
                  {memo && (
                    <button
                      className={styles.memoBadge}
                      title={memo.content}
                      onClick={(event) => { event.stopPropagation(); openCell(member.id, day.weekday, day.date, shift, true, "memo"); }}
                    >
                      📝
                    </button>
                  )}
                  {!shift && <span>+</span>}
                  {shift && isDayOff && (
                    <>
                      <strong>{shift.source === "holiday" ? "공휴일" : "휴무"}</strong>
                      {shift.source === "holiday" && holiday && <em>{holiday.name}</em>}
                      {showTimes && <em>기존 {shift.startTime}-{shift.endTime}</em>}
                    </>
                  )}
                  {shift && !isDayOff && (
                    <>
                      <strong>{formatHours(shiftHours)}</strong>
                      {showTimes && <em>{shift.startTime}-{shift.endTime}</em>}
                    </>
                  )}
                </div>
              );
            })}
            <div className={`${styles.cell} ${styles.total}`}>{formatHours(weeklyHours(member.id))}</div>
          </div>
        ))}

        <div className={`${styles.row} ${styles.footer} ${styles.hoursFooter}`}>
          <div className={`${styles.cell} ${styles.name}`}>일 총 근무시간</div>
          {weekDays.map((day) => (
            <div className={`${styles.cell} ${styles.total}`} key={day.weekday}>{formatHours(dailyHours(day.date))}</div>
          ))}
          <div className={`${styles.cell} ${styles.total}`}>{formatHours(totalWeeklyHours)}</div>
        </div>

        <div className={`${styles.row} ${styles.footer} ${styles.peopleFooter}`}>
          <div className={`${styles.cell} ${styles.name}`}>출근 인원</div>
          {weekDays.map((day) => (
            <div className={`${styles.cell} ${styles.total}`} key={day.weekday}>{dailyWorkerCount(day.date)}명</div>
          ))}
          <div className={`${styles.cell} ${styles.total}`}>-</div>
        </div>
      </section>

      {dayContextMenu && (
        <div
          className={styles.dayContextMenu}
          onClick={(event) => event.stopPropagation()}
          style={{ left: dayContextMenu.x, top: dayContextMenu.y }}
        >
          <strong>{dayContextMenu.dayName} {dayContextMenu.label}</strong>
          <button onClick={markDateOff}>휴무일 지정</button>
        </div>
      )}

      {selected && isEditorOpen && (
        <div className={styles.modalBackdrop}>
          <div className={styles.modal}>
            <h2>{selectedMember?.name} 날짜별 근무 수정</h2>
            <p>{selected.date} · {DAY_NAMES[selected.weekday - 1]}요일</p>

            <div className={styles.modalTabs}>
              <button className={editorTab === "shift" ? styles.active : ""} onClick={() => setEditorTab("shift")}>근무</button>
              <button className={editorTab === "memo" ? styles.active : ""} onClick={() => setEditorTab("memo")}>메모</button>
            </div>

            {editorTab === "shift" && (
              <>
                <label>
                  시작 시간
                  <select value={startTime} onChange={(e) => setStartTime(e.target.value)}>
                    {TIME_OPTIONS.map((time) => <option key={time} value={time}>{time}</option>)}
                  </select>
                </label>
                <label>
                  종료 시간
                  <select value={endTime} onChange={(e) => setEndTime(e.target.value)}>
                    {TIME_OPTIONS.map((time) => <option key={time} value={time}>{time}</option>)}
                  </select>
                </label>
                <p className={styles.modalSummary}>표시: {formatHours(Math.max(0, getHours(startTime, endTime)))}</p>
                <div className={styles.shortcutHint}>셀 선택 후 Ctrl+C 복사 · Ctrl+V 붙여넣기 · Delete 삭제</div>
                <div className={styles.actions}>
                  <button onClick={saveShift}>이 날짜만 저장</button>
                  {selectedShift && selectedShift.status !== "dayOff" && <button onClick={markDayOff}>이 날짜만 휴무</button>}
                  {selectedShift?.source === "override" && <button onClick={restoreDate}>날짜 예외 해제</button>}
                  {selectedShift && <button onClick={deleteShift}>삭제</button>}
                  <button onClick={() => setIsEditorOpen(false)}>닫기</button>
                </div>
              </>
            )}

            {editorTab === "memo" && (
              <>
                <label>
                  메모
                  <textarea
                    placeholder="예: 30분 일찍 퇴근, 10시에 출근"
                    value={memoDraft}
                    onChange={(e) => setMemoDraft(e.target.value)}
                  />
                </label>
                <div className={styles.actions}>
                  <button onClick={saveMemo}>메모 저장</button>
                  {getMemo(selected.memberId, selected.date) && <button onClick={deleteMemo}>메모 삭제</button>}
                  <button onClick={() => setIsEditorOpen(false)}>닫기</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
