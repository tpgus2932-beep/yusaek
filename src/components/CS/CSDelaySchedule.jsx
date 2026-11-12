import { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, Download, RefreshCw, Search } from 'lucide-react';
import styles from './CSDashboard.module.css';
import { LOCAL_API_BASE, getAuthHeaders, handleUnauthorized } from '../../lib/api';
import { useEzadminSession } from '../../lib/EzadminSessionContext';
import CSVendorKakao from './CSVendorKakao';

const OPTION_PREVIEW = 5; // 상품마다 먼저 보여줄 옵션 줄 수 (나머지는 펼쳐 보기)
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

// 탭을 오가도 마지막으로 불러온 목록이 남도록 모듈에 보관한다 (새로고침하면 사라짐).
let loadedCache = null; // { data, loadedAt }

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayStr = () => ymd(new Date());
const monthOf = (dateStr) => dateStr.slice(0, 7);
const shiftMonth = (month, delta) => {
    const [y, m] = month.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
};
const mdLabel = (dateStr) => `${Number(dateStr.slice(5, 7))}/${Number(dateStr.slice(8, 10))}`;
const daysAgo = (s) => {
    const d = new Date(String(s).replace(' ', 'T'));
    if (!s || Number.isNaN(d.getTime())) return null;
    return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000));
};
// 오래된 주문일수록 눈에 띄게: 7일 이상 경고, 3일 이상 주의
const ageTone = (age) => (age == null ? styles.ageCool : age >= 7 ? styles.ageHot : age >= 3 ? styles.ageWarm : styles.ageCool);

const request = async (path, options) => {
    const res = await fetch(`${LOCAL_API_BASE}/cs${path}`, {
        ...options,
        headers: { ...getAuthHeaders(), ...(options?.body ? { 'Content-Type': 'application/json' } : {}) },
    });
    if (handleUnauthorized(res)) throw new Error('로그인이 만료되었습니다.');
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.detail || '요청 실패');
    return data;
};

/**
 * 배송지연 일정: 왼쪽 카드는 재고부족요청(이지어드민)과 에이블리 상품준비중 주문을 '불러오기'로 맞춰서
 * 검색한 상품만 오래된 주문 순으로 보여주고(검색 전에는 목록을 띄우지 않음), 옵션마다 입고 예정일·메모를 적는다.
 * 오른쪽 카드는 입고 예정일이 잡힌 옵션을 달력으로 보여주고, 날짜를 누르면 그날 입고 예정 옵션이 뜬다.
 */
export default function CSDelaySchedule() {
    const { openModal } = useEzadminSession();
    const [data, setData] = useState(loadedCache?.data || null);
    const [loadedAt, setLoadedAt] = useState(loadedCache?.loadedAt || '');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [q, setQ] = useState('');
    const [drafts, setDrafts] = useState({}); // 옵션 상품코드 -> { date, memo } 입력 중인 값
    const [saving, setSaving] = useState('');
    const [expanded, setExpanded] = useState(() => new Set()); // 옵션을 모두 펼친 상품
    const [vendorKakaoOpen, setVendorKakaoOpen] = useState(false); // 거래처 카톡 보내기 창

    const [month, setMonth] = useState(monthOf(todayStr()));
    const [selectedDate, setSelectedDate] = useState(todayStr());
    const [calendar, setCalendar] = useState([]); // 해당 월에 입고 예정일이 잡힌 옵션들
    const [calendarTick, setCalendarTick] = useState(0);

    // ---- 재고부족요청 불러오기 (버튼을 눌렀을 때만 이지어드민/에이블리를 조회) ----
    const load = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            const res = await request('/delay-schedules?all=true');
            if (res.need_session) {
                openModal(() => load());
                setError('이지어드민 로그인이 필요해요. 로그인하면 자동으로 다시 불러옵니다.');
                return;
            }
            const at = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
            loadedCache = { data: res, loadedAt: at };
            setData(res);
            setLoadedAt(at);
            setDrafts({});
        } catch (e) {
            setError(e.message || '불러오기 실패');
        } finally {
            setLoading(false);
        }
    }, [openModal]);

    // ---- 달력: 저장된 입고 예정일은 불러오기 없이도 항상 보인다 ----
    useEffect(() => {
        let cancelled = false;
        request(`/delay-schedules/calendar?month=${month}`)
            .then((res) => { if (!cancelled) setCalendar(res.items || []); })
            .catch((e) => { if (!cancelled) setError(e.message || '달력 조회 실패'); });
        return () => { cancelled = true; };
    }, [month, calendarTick]);

    // ---- 접수상태 업데이트: 달력에 등록된 옵션의 이지어드민 접수 수량을 채운다 ----
    const [pending, setPending] = useState({}); // 상품코드 -> { pending, stock }
    const [pendingAt, setPendingAt] = useState('');
    const [pendingLoading, setPendingLoading] = useState(false);
    const updatePending = useCallback(async () => {
        setPendingLoading(true);
        setError('');
        try {
            const res = await request(`/delay-schedules/pending?month=${month}`);
            if (res.need_session) {
                openModal(() => updatePending());
                setError('이지어드민 로그인이 필요해요. 로그인하면 자동으로 다시 조회합니다.');
                return;
            }
            setPending((prev) => ({ ...prev, ...res.counts }));
            setPendingAt(new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }));
            if (res.missing?.length) setError(`이지어드민에서 찾지 못한 상품코드 ${res.missing.length}개: ${res.missing.slice(0, 5).join(', ')}${res.missing.length > 5 ? ' …' : ''}`);
        } catch (e) {
            setError(e.message || '접수 조회 실패');
        } finally {
            setPendingLoading(false);
        }
    }, [month, openModal]);

    // 불러온 목록의 한 옵션 값만 바꾼다 (캐시도 같이 갱신)
    const patchOption = (code, patch) =>
        setData((prev) => {
            if (!prev) return prev;
            const nextData = {
                ...prev,
                items: prev.items.map((it) => ({ ...it, options: it.options.map((o) => (o.code === code ? { ...o, ...patch } : o)) })),
            };
            loadedCache = { data: nextData, loadedAt };
            return nextData;
        });

    const save = async (option, next) => {
        setSaving(option.code);
        setError('');
        try {
            const res = await request('/delay-schedules', {
                method: 'PUT',
                body: JSON.stringify({
                    code: option.code,
                    expected_date: next.date,
                    schedule: next.memo,
                }),
            });
            patchOption(option.code, { schedule: res.schedule, expected_date: res.expected_date, updated_by: res.updated_by, updated_at: res.updated_at });
            setDrafts((prev) => {
                const rest = { ...prev };
                delete rest[option.code];
                return rest;
            });
            setCalendarTick((t) => t + 1);
            if (res.expected_date) {
                setMonth(monthOf(res.expected_date));
                setSelectedDate(res.expected_date);
            }
        } catch (e) {
            setError(e.message || '저장 실패');
        } finally {
            setSaving('');
        }
    };

    // 달력에서 옵션 일정을 지운다 (불러온 목록에 없는 옵션도 지울 수 있게 달력 쪽에서 직접 호출).
    const clearFromCalendar = async (entry) => {
        if (!window.confirm(`'${entry.goods_name || entry.code} ${entry.option_label || ''}'의 입고 예정 일정을 지울까요?`)) return;
        setError('');
        try {
            await request('/delay-schedules', { method: 'PUT', body: JSON.stringify({ code: entry.code, expected_date: '', schedule: '' }) });
            patchOption(entry.code, { schedule: '', expected_date: '', updated_by: '', updated_at: '' });
            setCalendarTick((t) => t + 1);
        } catch (e) {
            setError(e.message || '삭제 실패');
        }
    };

    // 선택한 날짜에 잡힌 일정을 한꺼번에 지운다 (CS 재고/상품별 탭의 입고 일정에서도 사라진다).
    const clearDate = async (date, entries) => {
        if (!window.confirm(`${mdLabel(date)} 입고 예정 ${entries.length}개를 모두 삭제할까요?\nCS 재고/상품별 탭의 입고 일정에서도 함께 지워집니다.`)) return;
        setError('');
        try {
            await request(`/delay-schedules/by-date?${new URLSearchParams({ date })}`, { method: 'DELETE' });
            const codes = new Set(entries.map((e) => e.code));
            setData((prev) => {
                if (!prev) return prev;
                const nextData = {
                    ...prev,
                    items: prev.items.map((it) => ({
                        ...it,
                        options: it.options.map((o) => (codes.has(o.code) ? { ...o, schedule: '', expected_date: '', updated_by: '', updated_at: '' } : o)),
                    })),
                };
                loadedCache = { data: nextData, loadedAt };
                return nextData;
            });
            setCalendarTick((t) => t + 1);
        } catch (e) {
            setError(e.message || '삭제 실패');
        }
    };

    const toggleExpand = (sno) =>
        setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(sno)) next.delete(sno);
            else next.add(sno);
            return next;
        });

    // ---- 목록: 검색해야 보인다 (일치하는 상품 전부, 오래된 주문 순) ----
    const all = useMemo(() => data?.items || [], [data]);
    const shown = useMemo(() => {
        const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
        if (terms.length === 0) return [];
        // 검색하면 개수 제한 없이 일치하는 상품을 모두 보여준다 (거래처명으로 검색하면 그 거래처 상품이 전부 나온다)
        return all.filter((it) => {
            const hay = [it.goods_name, it.supplier, it.supplier_product, ...it.options.map((o) => `${o.label} ${o.code}`)].join(' ').toLowerCase();
            return terms.every((t) => hay.includes(t));
        });
    }, [all, q]);
    const searching = q.trim() !== '';

    // ---- 달력 칸 계산 ----
    const byDate = useMemo(() => {
        const map = {};
        for (const c of calendar) (map[c.expected_date] ||= []).push(c);
        return map;
    }, [calendar]);
    const cells = useMemo(() => {
        const [y, m] = month.split('-').map(Number);
        const first = new Date(y, m - 1, 1);
        const lastDay = new Date(y, m, 0).getDate();
        const list = Array(first.getDay()).fill(null);
        for (let d = 1; d <= lastDay; d += 1) list.push(`${month}-${pad(d)}`);
        while (list.length % 7 !== 0) list.push(null);
        return list;
    }, [month]);
    const dayEntries = byDate[selectedDate] || [];
    const today = todayStr();

    return (
        <div className={styles.delayWrap}>
            {vendorKakaoOpen && <CSVendorKakao onClose={() => setVendorKakaoOpen(false)} />}
            {/* ===== 왼쪽: 재고부족요청 × 에이블리 ===== */}
            <section className={styles.card}>
                <h3>
                    재고부족 상품
                    <span className={styles.cardHint}>이지어드민 재고부족요청 × 에이블리 상품준비중 · 오래된 주문 순</span>
                </h3>

                <div className={styles.delayBar}>
                    <button type="button" className={styles.delayLoad} disabled={loading} onClick={load}>
                        <Download size={15} />
                        {loading ? '불러오는 중...' : data ? '다시 불러오기' : '재고부족요청 불러오기'}
                    </button>
                    <button type="button" className={styles.delayLoad} onClick={() => setVendorKakaoOpen(true)} title="거래처 일정의 EZAdmin 불러오기·자동 실행과 같은 계산으로 거래처별 문자를 만들어 카톡으로 보냅니다">
                        거래처 카톡 보내기
                    </button>
                    {data && <span className={styles.delayLoaded}>{loadedAt} 기준 · 상품 {data.total_products}개 · 주문 {data.matched_orders}건</span>}
                </div>

                {error && <div className={styles.error}>{error}</div>}

                {!data && !loading && (
                    <div className={styles.delayEmpty}>
                        <b>불러오기</b>를 누르면 이지어드민 재고부족요청과 에이블리 상품준비중 주문을 맞춰서
                        <br />상품명이나 거래처로 검색하면 일치하는 상품이 오래된 주문 순으로 떠요.
                    </div>
                )}
                {loading && !data && <div className={styles.delayEmpty}>이지어드민과 에이블리를 맞춰보는 중이에요... (몇 초 걸려요)</div>}

                {data && (
                    <>
                        <label className={styles.delaySearch}>
                            <Search size={15} />
                            <input value={q} placeholder="상품명 · 거래처 · 거래처상품명 · 옵션 · 상품코드 검색" onChange={(e) => setQ(e.target.value)} />
                            <em>{searching ? `${shown.length}개 검색됨` : `전체 ${all.length}개`}</em>
                        </label>

                        {shown.length === 0 && (
                            <div className={styles.delayEmpty}>
                                {searching
                                    ? '검색된 상품이 없어요'
                                    : all.length === 0
                                        ? '재고부족요청이 걸린 상품준비중 주문이 없어요 🎉'
                                        : '상품명 · 거래처 · 옵션으로 검색하면 상품이 나와요'}
                            </div>
                        )}

                        <div className={styles.delayRows}>
                            {shown.map((it, idx) => {
                                const age = daysAgo(it.oldest_ordered_at);
                                const open = expanded.has(it.goods_sno);
                                const options = open ? it.options : it.options.slice(0, OPTION_PREVIEW);
                                return (
                                    <div key={it.goods_sno} className={styles.delayRow}>
                                        <div className={styles.delayHead}>
                                            <div className={styles.delayRank}>{idx + 1}</div>
                                            <div className={styles.delayInfo}>
                                                <div className={styles.delayName}>{it.goods_name}</div>
                                                <div className={styles.delaySupplier}>
                                                    <span>거래처</span><b>{it.supplier || '-'}</b>
                                                    <span className={styles.delaySupplierGap}>거래처상품명</span>{it.supplier_product || '-'}
                                                </div>
                                            </div>
                                            <div className={`${styles.delayAge} ${ageTone(age)}`} title={`가장 오래된 주문 ${it.oldest_ordered_at || '-'}`}>
                                                <b>{age != null ? `${age}일` : '-'}</b>
                                                <span>{it.oldest_ordered_at ? `${mdLabel(it.oldest_ordered_at)} 주문` : ''}</span>
                                            </div>
                                        </div>

                                        <div className={styles.delayOptRows}>
                                            {options.map((o) => {
                                                const draft = drafts[o.code];
                                                const date = draft?.date ?? o.expected_date ?? '';
                                                const memo = draft?.memo ?? o.schedule ?? '';
                                                const dirty = draft !== undefined && (date !== (o.expected_date || '') || memo.trim() !== (o.schedule || ''));
                                                const setDraft = (patch) => setDrafts((prev) => ({ ...prev, [o.code]: { date, memo, ...prev[o.code], ...patch } }));
                                                const submit = () => dirty && !saving && save(o, { date, memo: memo.trim() });
                                                return (
                                                    <div key={o.code} className={`${styles.delayOptRow} ${o.expected_date || o.schedule ? styles.delayOptSaved : ''}`}>
                                                        <div className={styles.delayOptName}>
                                                            <b>{o.label || o.code}</b>
                                                            <span>
                                                                주문 {o.orders}
                                                                {o.request_qty > 0 && <em className={styles.delayNeed}> · 요청 {o.request_qty}</em>}
                                                                <i> · 재고 {o.stock_qty}</i>
                                                            </span>
                                                        </div>
                                                        <input type="date" className={styles.delayDate} value={date} onChange={(e) => setDraft({ date: e.target.value })} />
                                                        <input
                                                            type="text"
                                                            className={styles.delayMemo}
                                                            value={memo}
                                                            maxLength={200}
                                                            placeholder="메모 (예: 오전 입고 후 당일 발송)"
                                                            onChange={(e) => setDraft({ memo: e.target.value })}
                                                            onKeyDown={(e) => e.key === 'Enter' && submit()}
                                                        />
                                                        <button type="button" className={styles.delaySaveBtn} disabled={!dirty || Boolean(saving)} onClick={submit}>
                                                            {saving === o.code ? '저장 중' : '저장'}
                                                        </button>
                                                        {o.updated_at && !dirty && (
                                                            <div className={styles.delayStamp}>{o.updated_by} · {o.updated_at.slice(5, 16).replace('T', ' ')}</div>
                                                        )}
                                                    </div>
                                                );
                                            })}
                                            {it.options.length > OPTION_PREVIEW && (
                                                <button type="button" className={styles.delayMore} onClick={() => toggleExpand(it.goods_sno)}>
                                                    {open ? '옵션 접기' : `옵션 ${it.options.length - OPTION_PREVIEW}개 더 보기`}
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </>
                )}
            </section>

            {/* ===== 오른쪽: 입고 예정 달력 ===== */}
            <section className={styles.card}>
                <h3>
                    <CalendarDays size={16} /> 입고 예정 달력
                    <span className={styles.cardHint}>날짜를 누르면 그날 입고 예정 옵션이 떠요 · 지난 일정은 자동 삭제</span>
                </h3>

                <div className={styles.calHead}>
                    <button type="button" onClick={() => setMonth(shiftMonth(month, -1))} aria-label="이전 달"><ChevronLeft size={16} /></button>
                    <strong>{month.slice(0, 4)}년 {Number(month.slice(5))}월</strong>
                    <button type="button" onClick={() => setMonth(shiftMonth(month, 1))} aria-label="다음 달"><ChevronRight size={16} /></button>
                    <button type="button" className={styles.calToday} onClick={() => { setMonth(monthOf(today)); setSelectedDate(today); }}>오늘</button>
                    <button type="button" className={styles.calPendingBtn} disabled={pendingLoading || calendar.length === 0} onClick={updatePending}>
                        <RefreshCw size={13} className={pendingLoading ? styles.spin : ''} />
                        {pendingLoading ? '조회 중...' : '접수상태 업데이트'}
                    </button>
                    {pendingAt && <span className={styles.calPendingAt}>{pendingAt} 기준</span>}
                </div>

                <div className={styles.calGrid}>
                    {WEEKDAYS.map((w, i) => (
                        <div key={w} className={`${styles.calWeek} ${i === 0 ? styles.calSun : i === 6 ? styles.calSat : ''}`}>{w}</div>
                    ))}
                    {cells.map((d, i) => {
                        if (!d) return <div key={`e${i}`} className={styles.calEmpty} />;
                        const count = (byDate[d] || []).length;
                        return (
                            <button
                                type="button"
                                key={d}
                                className={`${styles.calDay} ${d === selectedDate ? styles.calSelected : ''} ${d === today ? styles.calIsToday : ''}`}
                                onClick={() => setSelectedDate(d)}
                            >
                                <span>{Number(d.slice(8))}</span>
                                {count > 0 && <em>{count}</em>}
                            </button>
                        );
                    })}
                </div>

                <div className={styles.calDetail}>
                    <div className={styles.calDetailHead}>
                        <span>
                            <b>{mdLabel(selectedDate)} ({WEEKDAYS[new Date(`${selectedDate}T00:00:00`).getDay()]})</b> 입고 예정 {dayEntries.length}개
                        </span>
                        {dayEntries.length > 0 && (
                            <button type="button" className={styles.calClearDate} onClick={() => clearDate(selectedDate, dayEntries)}>
                                이 날짜 일괄 삭제
                            </button>
                        )}
                    </div>
                    {dayEntries.length === 0 && <div className={styles.calNone}>이 날 입고 예정인 옵션이 없어요</div>}
                    {dayEntries.map((e) => (
                        <div key={e.code} className={styles.calItem}>
                            <div className={styles.calItemMain}>
                                <div className={styles.calItemName}>{e.goods_name || e.code}</div>
                                {e.option_label && <div className={styles.calItemOpt}>{e.option_label}</div>}
                                {(e.supplier || e.supplier_product) && (
                                    <div className={styles.calItemSub}>{[e.supplier && `거래처 ${e.supplier}`, e.supplier_product].filter(Boolean).join(' · ')}</div>
                                )}
                                {e.schedule && <div className={styles.calItemMemo}>{e.schedule}</div>}
                                {pending[e.code] && (
                                    <div className={styles.calItemPending}>
                                        접수 <b>{pending[e.code].pending}</b>개 · 재고 {pending[e.code].stock}개
                                    </div>
                                )}
                            </div>
                            <button type="button" className={styles.calItemDel} onClick={() => clearFromCalendar(e)}>삭제</button>
                        </div>
                    ))}
                </div>
            </section>
        </div>
    );
}
