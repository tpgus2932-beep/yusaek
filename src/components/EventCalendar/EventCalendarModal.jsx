import { useEffect, useMemo, useState } from 'react';
import { CalendarDays, Check, ChevronLeft, ChevronRight, Eye, EyeOff, Plus, Trash2, X } from 'lucide-react';
import styles from './EventCalendarModal.module.css';

const STORAGE_KEY = 'shopping-events-v1';
const TABS = [
    { id: 'korea', label: '한국' },
    { id: 'japan', label: '일본' },
    { id: 'all', label: '통합' },
];
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
const COLORS = ['blue', 'mint', 'pink', 'purple', 'amber'];

const toDateKey = (date) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
};

const parseDate = (value) => {
    const [year, month, day] = value.split('-').map(Number);
    return new Date(year, month - 1, day);
};

const formatPeriod = (startDate, endDate) => {
    const format = (value) => {
        const date = parseDate(value);
        return `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, '0')}.${String(date.getDate()).padStart(2, '0')}`;
    };
    return `${format(startDate)} – ${format(endDate)}`;
};

const loadEvents = () => {
    try {
        const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
        return Array.isArray(stored) ? stored : [];
    } catch {
        return [];
    }
};

const EventCalendarModal = ({ onClose }) => {
    const today = new Date();
    const [activeTab, setActiveTab] = useState('korea');
    const [viewDate, setViewDate] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1));
    const [events, setEvents] = useState(loadEvents);
    const [selectedEventIds, setSelectedEventIds] = useState(() => new Set());
    const [focusedEventIds, setFocusedEventIds] = useState(() => new Set());
    const [showForm, setShowForm] = useState(false);
    const [detailEvent, setDetailEvent] = useState(null);
    const [highlightedEventId, setHighlightedEventId] = useState(null);
    const [formError, setFormError] = useState('');
    const [form, setForm] = useState({
        region: 'korea',
        title: '',
        content: '',
        md: '',
        startDate: '',
        endDate: '',
    });

    useEffect(() => {
        const handleKeyDown = (event) => {
            if (event.key === 'Escape') onClose();
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [onClose]);

    const calendarDays = useMemo(() => {
        const year = viewDate.getFullYear();
        const month = viewDate.getMonth();
        const firstDay = new Date(year, month, 1);
        const gridStart = new Date(year, month, 1 - firstDay.getDay());
        const lastDay = new Date(year, month + 1, 0);
        const totalCells = Math.ceil((firstDay.getDay() + lastDay.getDate()) / 7) * 7;

        return Array.from({ length: totalCells }, (_, index) => {
            const date = new Date(gridStart);
            date.setDate(gridStart.getDate() + index);
            return date;
        });
    }, [viewDate]);
    const calendarWeeks = useMemo(
        () => Array.from(
            { length: calendarDays.length / 7 },
            (_, weekIndex) => calendarDays.slice(weekIndex * 7, weekIndex * 7 + 7),
        ),
        [calendarDays],
    );

    const visibleEvents = useMemo(
        () => events
            .filter((event) => activeTab === 'all' || event.region === activeTab)
            .sort((a, b) => b.startDate.localeCompare(a.startDate)),
        [activeTab, events],
    );
    const calendarEvents = useMemo(
        () => focusedEventIds.size === 0
            ? visibleEvents
            : visibleEvents.filter((event) => focusedEventIds.has(event.id)),
        [focusedEventIds, visibleEvents],
    );
    const eventLayout = useMemo(() => {
        const laneEnds = [];
        const laneByEventId = new Map();
        const sortedEvents = [...calendarEvents].sort(
            (a, b) => a.startDate.localeCompare(b.startDate)
                || a.endDate.localeCompare(b.endDate)
                || a.id.localeCompare(b.id),
        );

        sortedEvents.forEach((event) => {
            let lane = laneEnds.findIndex((endDate) => endDate < event.startDate);
            if (lane === -1) lane = laneEnds.length;
            laneEnds[lane] = event.endDate;
            laneByEventId.set(event.id, lane);
        });

        return { laneByEventId, laneCount: laneEnds.length };
    }, [calendarEvents]);

    const changeMonth = (offset) => {
        setViewDate((current) => new Date(current.getFullYear(), current.getMonth() + offset, 1));
    };

    const changeTab = (tabId) => {
        setActiveTab(tabId);
        setSelectedEventIds(new Set());
        setFocusedEventIds(new Set());
    };

    const openForm = () => {
        setForm((current) => ({
            ...current,
            region: activeTab === 'all' ? 'korea' : activeTab,
        }));
        setFormError('');
        setShowForm(true);
    };

    const submitEvent = (event) => {
        event.preventDefault();
        const title = form.title.trim();
        const content = form.content.trim();
        const md = form.md.trim();

        if (!title || !content || !md || !form.startDate || !form.endDate) {
            setFormError('모든 항목을 입력해 주세요.');
            return;
        }
        if (form.endDate < form.startDate) {
            setFormError('종료일은 시작일보다 빠를 수 없습니다.');
            return;
        }

        const newEvent = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            ...form,
            title,
            content,
            md,
            color: COLORS[events.length % COLORS.length],
            createdAt: new Date().toISOString(),
        };
        const nextEvents = [...events, newEvent];
        setEvents(nextEvents);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(nextEvents));
        setViewDate(parseDate(form.startDate));
        setActiveTab(form.region);
        setForm({
            region: form.region,
            title: '',
            content: '',
            md: '',
            startDate: '',
            endDate: '',
        });
        setFormError('');
        setShowForm(false);
    };

    const toggleSelectedEvent = (eventId) => {
        setSelectedEventIds((current) => {
            const next = new Set(current);
            if (next.has(eventId)) next.delete(eventId);
            else next.add(eventId);
            return next;
        });
    };

    const toggleFocusedEvent = (eventId) => {
        setFocusedEventIds((current) => {
            const next = new Set(current);
            if (next.has(eventId)) next.delete(eventId);
            else next.add(eventId);
            return next;
        });
    };

    const deleteSelectedEvents = () => {
        if (selectedEventIds.size === 0) return;
        if (!window.confirm(`선택한 행사 ${selectedEventIds.size}개를 삭제하시겠습니까?`)) return;

        const nextEvents = events.filter((event) => !selectedEventIds.has(event.id));
        setEvents(nextEvents);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(nextEvents));
        setFocusedEventIds((current) => {
            const next = new Set(current);
            selectedEventIds.forEach((eventId) => next.delete(eventId));
            return next;
        });
        setSelectedEventIds(new Set());
    };

    return (
        <div className={styles.overlay} onMouseDown={(event) => {
            if (event.target === event.currentTarget) onClose();
        }}>
            <section className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="event-calendar-title">
                <header className={styles.header}>
                    <div>
                        <p className={styles.eyebrow}>SHOP EVENT</p>
                        <h2 id="event-calendar-title">행사 일정</h2>
                    </div>
                    <div className={styles.headerActions}>
                        <button type="button" className={styles.addButton} onClick={openForm}>
                            <Plus size={17} /> 행사 추가
                        </button>
                        <button type="button" className={styles.iconButton} onClick={onClose} aria-label="행사 일정 닫기">
                            <X size={21} />
                        </button>
                    </div>
                </header>

                <div className={styles.tabs} role="tablist" aria-label="국가별 행사">
                    {TABS.map((tab) => (
                        <button
                            key={tab.id}
                            type="button"
                            role="tab"
                            aria-selected={activeTab === tab.id}
                            className={activeTab === tab.id ? styles.activeTab : ''}
                            onClick={() => changeTab(tab.id)}
                        >
                            {tab.label}
                        </button>
                    ))}
                </div>

                <div className={styles.content}>
                    <div className={styles.calendarPanel}>
                        <div className={styles.monthHeader}>
                            <button type="button" className={styles.iconButton} onClick={() => changeMonth(-1)} aria-label="이전 달">
                                <ChevronLeft size={21} />
                            </button>
                            <div>
                                <strong>{viewDate.getMonth() + 1}월</strong>
                                <span>{viewDate.getFullYear()}</span>
                            </div>
                            <button type="button" className={styles.iconButton} onClick={() => changeMonth(1)} aria-label="다음 달">
                                <ChevronRight size={21} />
                            </button>
                        </div>

                        <div className={styles.weekdays}>
                            {WEEKDAYS.map((day, index) => (
                                <div key={day} className={index === 0 ? styles.sunday : index === 6 ? styles.saturday : ''}>{day}</div>
                            ))}
                        </div>
                        <div className={styles.calendarGrid}>
                            {calendarWeeks.map((week) => {
                                const weekStartKey = toDateKey(week[0]);
                                const weekEndKey = toDateKey(week[6]);
                                const weekEvents = calendarEvents.filter(
                                    (item) => item.startDate <= weekEndKey
                                        && item.endDate >= weekStartKey
                                        && eventLayout.laneByEventId.get(item.id) < 5,
                                );
                                return (
                                    <div key={weekStartKey} className={styles.calendarWeek}>
                                        {week.map((date, dayIndex) => {
                                            const dateKey = toDateKey(date);
                                            const isCurrentMonth = date.getMonth() === viewDate.getMonth();
                                            const isToday = dateKey === toDateKey(today);
                                            return (
                                                <div key={dateKey} className={`${styles.dayCell} ${!isCurrentMonth ? styles.outsideMonth : ''}`}>
                                                    <span className={`${styles.dayNumber} ${isToday ? styles.today : ''} ${dayIndex === 0 ? styles.sunday : dayIndex === 6 ? styles.saturday : ''}`}>
                                                        {date.getDate()}
                                                    </span>
                                                </div>
                                            );
                                        })}
                                        <div className={styles.weekEvents}>
                                            {weekEvents.map((item) => {
                                                const segmentStart = item.startDate > weekStartKey ? parseDate(item.startDate) : week[0];
                                                const segmentEnd = item.endDate < weekEndKey ? parseDate(item.endDate) : week[6];
                                                const startColumn = Math.round((segmentStart - week[0]) / 86400000) + 1;
                                                const endColumn = Math.round((segmentEnd - week[0]) / 86400000) + 2;
                                                return (
                                                    <button
                                                        type="button"
                                                        key={item.id}
                                                        className={`${styles.eventBar} ${styles.weekEventBar} ${styles[item.color]} ${highlightedEventId === item.id ? styles.eventBarHighlighted : ''}`}
                                                        style={{
                                                            gridColumn: `${startColumn} / ${endColumn}`,
                                                            gridRow: eventLayout.laneByEventId.get(item.id) + 1,
                                                        }}
                                                        onClick={() => setDetailEvent(item)}
                                                        onMouseEnter={() => setHighlightedEventId(item.id)}
                                                        onMouseLeave={() => setHighlightedEventId(null)}
                                                        onFocus={() => setHighlightedEventId(item.id)}
                                                        onBlur={() => setHighlightedEventId(null)}
                                                        aria-label={`${item.title} 상세 내용 보기`}
                                                        title="클릭하여 행사 내용 보기"
                                                    >
                                                        {item.title}
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>

                    <aside className={styles.listPanel}>
                        <div className={styles.listHeader}>
                            <div>
                                <span>{TABS.find((tab) => tab.id === activeTab)?.label}</span>
                                <h3>행사 목록</h3>
                            </div>
                            <strong>{visibleEvents.length}</strong>
                        </div>
                        <div className={styles.listTools}>
                            <span>
                                {focusedEventIds.size === 0
                                    ? '전체 행사 표시 중'
                                    : `${focusedEventIds.size}개 행사만 표시 중`}
                            </span>
                            <div>
                                {focusedEventIds.size > 0 ? (
                                    <button
                                        type="button"
                                        className={styles.showAllButton}
                                        onClick={() => setFocusedEventIds(new Set())}
                                    >
                                        <Eye size={14} /> 전체 표시
                                    </button>
                                ) : null}
                                <button
                                    type="button"
                                    className={styles.deleteButton}
                                    onClick={deleteSelectedEvents}
                                    disabled={selectedEventIds.size === 0}
                                >
                                    <Trash2 size={14} />
                                    {selectedEventIds.size > 0 ? `${selectedEventIds.size}개 삭제` : '선택 삭제'}
                                </button>
                            </div>
                        </div>
                        <div className={styles.eventList}>
                            {visibleEvents.length === 0 ? (
                                <div className={styles.empty}>
                                    <CalendarDays size={28} />
                                    <p>등록된 행사가 없습니다.</p>
                                    <span>행사 추가 버튼으로 첫 일정을 등록해 보세요.</span>
                                </div>
                            ) : visibleEvents.map((item) => (
                                <article
                                    key={item.id}
                                    className={`${styles.listItem} ${selectedEventIds.has(item.id) ? styles.selectedListItem : ''}`}
                                >
                                    <button
                                        type="button"
                                        className={`${styles.selectButton} ${selectedEventIds.has(item.id) ? styles.selectButtonActive : ''}`}
                                        onClick={() => toggleSelectedEvent(item.id)}
                                        aria-label={`${item.title} 선택`}
                                        aria-pressed={selectedEventIds.has(item.id)}
                                    >
                                        {selectedEventIds.has(item.id) ? <Check size={13} /> : null}
                                    </button>
                                    <span className={`${styles.listDot} ${styles[item.color]}`} />
                                    <button
                                        type="button"
                                        className={styles.listContentButton}
                                        onClick={() => setDetailEvent(item)}
                                        aria-label={`${item.title} 상세 내용 보기`}
                                    >
                                        <h4>{item.title}</h4>
                                        <p>{formatPeriod(item.startDate, item.endDate)}</p>
                                    </button>
                                    <div className={styles.itemActions}>
                                        <button
                                            type="button"
                                            className={`${styles.eyeButton} ${focusedEventIds.has(item.id) ? styles.eyeButtonActive : ''}`}
                                            onClick={() => toggleFocusedEvent(item.id)}
                                            aria-label={`${item.title} ${focusedEventIds.has(item.id) ? '단독 표시 해제' : '달력에 선택 표시'}`}
                                            aria-pressed={focusedEventIds.has(item.id)}
                                            title={focusedEventIds.has(item.id) ? '이 행사만 보기에서 제외' : '이 행사만 달력에 보기'}
                                        >
                                            {focusedEventIds.has(item.id) ? <Eye size={16} /> : <EyeOff size={16} />}
                                        </button>
                                        <span className={styles.regionBadge}>{item.region === 'korea' ? '한국' : '일본'}</span>
                                    </div>
                                </article>
                            ))}
                        </div>
                    </aside>
                </div>

                {showForm ? (
                    <div className={styles.formOverlay}>
                        <form className={styles.eventForm} onSubmit={submitEvent}>
                            <div className={styles.formHeader}>
                                <div>
                                    <span>NEW EVENT</span>
                                    <h3>행사 추가</h3>
                                </div>
                                <button type="button" className={styles.iconButton} onClick={() => setShowForm(false)} aria-label="행사 추가 닫기">
                                    <X size={20} />
                                </button>
                            </div>
                            <label>
                                구분
                                <select value={form.region} onChange={(event) => setForm({ ...form, region: event.target.value })}>
                                    <option value="korea">한국</option>
                                    <option value="japan">일본</option>
                                </select>
                            </label>
                            <label>
                                행사 제목
                                <input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder="예: 여름 시즌 프로모션" autoFocus />
                            </label>
                            <label>
                                행사 내용
                                <textarea value={form.content} onChange={(event) => setForm({ ...form, content: event.target.value })} placeholder="행사 내용을 입력해 주세요." rows={3} />
                            </label>
                            <label>
                                전달 MD
                                <input value={form.md} onChange={(event) => setForm({ ...form, md: event.target.value })} placeholder="담당자 이름" />
                            </label>
                            <div className={styles.dateFields}>
                                <label>
                                    시작일
                                    <input type="date" value={form.startDate} onChange={(event) => setForm({ ...form, startDate: event.target.value })} />
                                </label>
                                <label>
                                    종료일
                                    <input type="date" min={form.startDate} value={form.endDate} onChange={(event) => setForm({ ...form, endDate: event.target.value })} />
                                </label>
                            </div>
                            {formError ? <p className={styles.formError}>{formError}</p> : null}
                            <div className={styles.formActions}>
                                <button type="button" className={styles.cancelButton} onClick={() => setShowForm(false)}>취소</button>
                                <button type="submit" className={styles.saveButton}>행사 등록</button>
                            </div>
                        </form>
                    </div>
                ) : null}
                {detailEvent ? (
                    <div className={styles.formOverlay} onMouseDown={(event) => {
                        if (event.target === event.currentTarget) setDetailEvent(null);
                    }}>
                        <article className={styles.detailCard}>
                            <div className={styles.formHeader}>
                                <div>
                                    <span>EVENT DETAIL</span>
                                    <h3>{detailEvent.title}</h3>
                                </div>
                                <button
                                    type="button"
                                    className={styles.iconButton}
                                    onClick={() => setDetailEvent(null)}
                                    aria-label="행사 내용 닫기"
                                >
                                    <X size={20} />
                                </button>
                            </div>
                            <div className={styles.detailMeta}>
                                <span>{detailEvent.region === 'korea' ? '한국' : '일본'}</span>
                                <span>{formatPeriod(detailEvent.startDate, detailEvent.endDate)}</span>
                            </div>
                            <section className={styles.detailSection}>
                                <h4>행사 내용</h4>
                                <p>{detailEvent.content}</p>
                            </section>
                            <section className={styles.detailSection}>
                                <h4>전달 MD</h4>
                                <p>{detailEvent.md}</p>
                            </section>
                            <button type="button" className={styles.detailCloseButton} onClick={() => setDetailEvent(null)}>
                                확인
                            </button>
                        </article>
                    </div>
                ) : null}
            </section>
        </div>
    );
};

export default EventCalendarModal;
