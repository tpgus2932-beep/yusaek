import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import pageStyles from './BarcodePage.module.css';
import styles from './ReturnInspectionTab.module.css';
import { LOCAL_API_BASE as API, getAuthHeaders } from '../../lib/api';
import { toEnglishKey } from './BarcodePage';

const IDS_KEY = 'returnInspectionSnapshotIds';
const RECENT_KEY = 'returnInspectionRecentScans';
const SCROLL_KEY = 'returnInspectionScrollY';
const RECENT_SHOW = 5;
const RECENT_MORE = 20;
const RESULT_SHORT = { next: '다음', done: '완료', over: '초과', unknown: '없음' };

// 이 기기에서 방금 찍은 목록 (새로고침해도 유지)
const readRecent = () => {
    try {
        const parsed = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
};

const readSavedIds = () => {
    try {
        const parsed = JSON.parse(localStorage.getItem(IDS_KEY) || '[]');
        return Array.isArray(parsed) ? parsed.map(Number).filter(Number.isFinite) : [];
    } catch {
        return [];
    }
};

const saveIds = (ids) => {
    try {
        localStorage.setItem(IDS_KEY, JSON.stringify(ids));
    } catch {
        // 저장 실패는 무시
    }
};

// 저장 시각은 UTC ISO로 내려오므로 KST(HH:mm)로 변환해서 표시
const formatKstTime = (iso) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false });
};

const RESULT_LABEL = {
    next: ['다음', styles.flashNext],
    done: ['완료', styles.flashDone],
    over: ['초과 — 이미 수량을 다 채운 상품입니다', styles.flashOver],
    unknown: ['리스트에 없는 상품입니다', styles.flashUnknown],
};

// mobile: 모바일 전용 화면(/bacode)에서 쓸 때 — 스캔칸 상단 고정, 진행 막대, 큰 터치 버튼, 완료 숨기기
const ReturnInspectionTab = ({ mobile = false }) => {
    const [dates, setDates] = useState([]);
    const [selectedIds, setSelectedIds] = useState(readSavedIds);
    const [panelOpen, setPanelOpen] = useState(false);
    const [data, setData] = useState(null);
    const [scanText, setScanText] = useState('');
    const [flash, setFlash] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [hideDone, setHideDone] = useState(false);
    const [errorsOpen, setErrorsOpen] = useState(!mobile);
    const [recent, setRecent] = useState(readRecent);
    const [defectMode, setDefectMode] = useState(false);
    const [recentMore, setRecentMore] = useState(false);
    const [editId, setEditId] = useState(null); // 방금 찍은 목록에서 수정 화면을 연 줄
    const [minusQty, setMinusQty] = useState(1);
    const [openCode, setOpenCode] = useState('');
    const [itemLogs, setItemLogs] = useState({ code: '', logs: [], loading: false });
    const scanRef = useRef(null);
    const soundsRef = useRef(null);

    // preventScroll: 포커스 때문에 화면이 위아래로 튀지 않게 한다.
    const focusScan = () => setTimeout(() => scanRef.current?.focus({ preventScroll: true }), 0);

    const pushRecent = (updater) => {
        setRecent((prev) => {
            const next = updater(prev).slice(0, 20);
            try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* ignore */ }
            return next;
        });
    };

    // 데이터를 다시 받아도 보던 스크롤 위치 그대로 유지
    const keepScroll = (fn) => {
        const y = window.scrollY;
        fn();
        requestAnimationFrame(() => requestAnimationFrame(() => window.scrollTo(0, y)));
    };

    // 페이지 새로고침 후에도 보던 위치로 돌아가도록 스크롤 위치를 저장
    const restoredRef = useRef(false);
    useEffect(() => {
        let t = null;
        const onScroll = () => {
            clearTimeout(t);
            t = setTimeout(() => {
                try { sessionStorage.setItem(SCROLL_KEY, String(window.scrollY)); } catch { /* ignore */ }
            }, 150);
        };
        window.addEventListener('scroll', onScroll, { passive: true });
        return () => { clearTimeout(t); window.removeEventListener('scroll', onScroll); };
    }, []);
    useEffect(() => {
        if (restoredRef.current || !data) return;
        restoredRef.current = true;
        let y = 0;
        try { y = Number(sessionStorage.getItem(SCROLL_KEY) || 0); } catch { /* ignore */ }
        if (y > 0) requestAnimationFrame(() => requestAnimationFrame(() => window.scrollTo(0, y)));
    }, [data]);

    useEffect(() => {
        const makeAudio = (src) => {
            const a = new Audio(src);
            a.preload = 'auto';
            return a;
        };
        // 바코드 메뉴와 동일: 다음(xx) / 완료(zz) / 오류(dd)
        soundsRef.current = {
            next: makeAudio('/sounds/xx.wav'),
            done: makeAudio('/sounds/zz.wav'),
            unknown: makeAudio('/sounds/dd.wav'),
            over: makeAudio('/sounds/bb.wav'),
        };
    }, []);

    const playSound = (key) => {
        const audio = soundsRef.current?.[key];
        if (!audio) return;
        audio.currentTime = 0;
        audio.play().catch(() => {});
    };

    const request = useCallback(async (path, body) => {
        const res = await fetch(`${API}/returns/inspection${path}`, {
            method: body ? 'POST' : 'GET',
            headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
            body: body ? JSON.stringify(body) : undefined,
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json?.detail || '처리 실패');
        return json;
    }, []);

    const loadSnapshots = useCallback(async (ids, opts = {}) => {
        if (!ids.length) return;
        setLoading(true);
        setError('');
        try {
            const json = await request('/load', { snapshot_ids: ids, ...opts });
            keepScroll(() => setData(json));
            setFlash(null);
            saveIds(json.snapshot_ids || ids);
        } catch (err) {
            setData(null);
            setError(err.message || '불러오기 실패');
        } finally {
            setLoading(false);
            focusScan();
        }
    }, [request]);

    useEffect(() => {
        (async () => {
            try {
                const json = await request('/dates');
                setDates(json.dates || []);
                const existing = new Set((json.dates || []).flatMap((d) => d.snapshots.map((s) => s.id)));
                const saved = readSavedIds().filter((id) => existing.has(id));
                const latest = json.dates?.[0]?.snapshots?.[0]?.id;
                const initial = saved.length ? saved : latest != null ? [latest] : [];
                if (initial.length) {
                    setSelectedIds(initial);
                    loadSnapshots(initial);
                }
            } catch (err) {
                setError(err.message || '날짜 목록 조회 실패');
            }
        })();
        focusScan();
    }, [request, loadSnapshots]);

    // 모든 날짜의 임시저장 기록을 최신순으로 펼친 목록 (✓ = 해당 날짜 검수 시작됨)
    const snapshotOptions = useMemo(
        () => dates.flatMap((d) => d.snapshots.map((s) => ({ ...s, date: d.date }))),
        [dates],
    );

    const toggleSnapshot = (id) => {
        setSelectedIds((prev) => (prev.includes(id) ? prev.filter((v) => v !== id) : [...prev, id]));
    };

    const handleLoadSelected = () => {
        setPanelOpen(false);
        loadSnapshots(selectedIds);
    };

    // 현재 화면에 불러온 임시저장본 (선택만 하고 아직 조회 안 한 상태와 구분)
    const activeIds = data?.snapshot_ids || [];

    const handleScan = async () => {
        const value = toEnglishKey(scanText.trim());
        setScanText('');
        if (!value || !activeIds.length) {
            focusScan();
            return;
        }
        try {
            const json = await request('/scan', { snapshot_ids: activeIds, code: value, defect: defectMode });
            keepScroll(() => setData(json));
            setFlash({ result: json.result, code: json.code, defect: !!json.defect });
            playSound(json.result);
            const item = (json.items || []).find((i) => i.code === json.code);
            pushRecent((prev) => [{
                id: Date.now(),
                code: json.code,
                name: item?.name || '',
                result: json.result,
                defect: !!json.defect,
                logId: json.log_id ?? null,
                scanned: item?.scanned,
                total: item?.total,
                at: new Date().toLocaleTimeString('ko-KR', { hour12: false }),
            }, ...prev]);
        } catch (err) {
            setError(err.message || '스캔 실패');
        } finally {
            focusScan();
        }
    };

    const loadItemLogs = async (code) => {
        setItemLogs({ code, logs: [], loading: true });
        try {
            const json = await request('/item-logs', { snapshot_ids: activeIds, code });
            setItemLogs({ code, logs: json.logs || [], loading: false });
        } catch (err) {
            setItemLogs({ code, logs: [], loading: false });
            setError(err.message || '기록 조회 실패');
        }
    };

    // 상품 줄을 누르면 그 상품의 스캔 기록을 펼친다 (기록별 취소 / 정상↔불량 전환)
    const toggleItemOpen = (code) => {
        if (openCode === code) {
            setOpenCode('');
            return;
        }
        setOpenCode(code);
        loadItemLogs(code);
    };

    // opts: { code } 상품 -1 / { logId } 기록 1건 / { mine: true } 내 마지막 스캔
    const handleUndo = async (opts = {}) => {
        setError('');
        try {
            const json = await request('/undo', {
                snapshot_ids: activeIds,
                code: opts.code || undefined,
                log_id: opts.logId ?? undefined,
                count: opts.count || undefined,
                mine: opts.mine || undefined,
            });
            keepScroll(() => setData(json));
            setFlash(null);
            const u = json.undone;
            if (u) {
                const undoneIds = new Set(u.log_ids || [u.log_id]);
                pushRecent((prev) => {
                    if (prev.some((r) => r.logId != null && undoneIds.has(r.logId))) {
                        return prev.map((r) => (r.logId != null && undoneIds.has(r.logId) ? { ...r, cancelled: true } : r));
                    }
                    const idx = prev.findIndex((r) => r.logId == null && r.code === u.code && !r.cancelled && !!r.defect === !!u.defect);
                    return idx < 0 ? prev : prev.map((r, i) => (i === idx ? { ...r, cancelled: true } : r));
                });
                if (openCode && openCode === u.code) loadItemLogs(u.code);
            }
        } catch (err) {
            setError(err.message || '취소 실패');
        } finally {
            focusScan();
        }
    };

    const handleToggleDefect = async (logId) => {
        setError('');
        try {
            const json = await request('/toggle-defect', { snapshot_ids: activeIds, log_id: logId });
            keepScroll(() => setData(json));
            const t = json.toggled;
            if (t) {
                pushRecent((prev) => prev.map((r) => (r.logId === t.log_id ? { ...r, defect: t.defect } : r)));
                if (openCode && openCode === t.code) loadItemLogs(t.code);
            }
        } catch (err) {
            setError(err.message || '변경 실패');
        } finally {
            focusScan();
        }
    };

    const openEdit = (r) => {
        if (editId === r.id) {
            setEditId(null);
            return;
        }
        setEditId(r.id);
        setMinusQty(1);
    };

    const closeEdit = () => {
        setEditId(null);
        focusScan();
    };

    const confirmCancel = (desc, run) => {
        if (window.confirm(`이 스캔을 취소할까요?\n${desc}`)) run();
        else focusScan();
    };

    const confirmToggle = (desc, toDefect, run) => {
        if (window.confirm(`${desc}\n→ ${toDefect ? '불량' : '정상'}으로 바꿀까요? (수량은 그대로)`)) run();
        else focusScan();
    };

    const handleReset = async () => {
        if (!window.confirm('이 임시저장본의 검수 진행(스캔 수량·오류 기록)을 모두 초기화할까요? 상품 리스트는 그대로 유지됩니다.')) {
            focusScan();
            return;
        }
        try {
            const json = await request('/reset', { snapshot_ids: activeIds });
            keepScroll(() => setData(json));
            pushRecent(() => []);
            setFlash(null);
            setError('');
        } catch (err) {
            setError(err.message || '초기화 실패');
        } finally {
            focusScan();
        }
    };

    const handleClearErrors = async () => {
        try {
            const json = await request('/clear-errors', { snapshot_ids: activeIds });
            keepScroll(() => setData(json));
        } catch (err) {
            setError(err.message || '처리 실패');
        } finally {
            focusScan();
        }
    };

    // 미완료 먼저, 완료는 하단. 같은 그룹 안에서는 상품명 순
    const sortedItems = useMemo(() => {
        const list = [...(data?.items || [])];
        const isDone = (i) => i.total > 0 && i.scanned >= i.total;
        return list.sort((a, b) => Number(isDone(a)) - Number(isDone(b)) || a.name.localeCompare(b.name, 'ko'));
    }, [data]);

    const summary = data?.summary || { done: 0, total: 0 };
    const qtySummary = useMemo(
        () => (data?.items || []).reduce(
            (acc, i) => ({ scanned: acc.scanned + Math.min(i.scanned, i.total), total: acc.total + i.total }),
            { scanned: 0, total: 0 },
        ),
        [data],
    );
    const flashInfo = flash ? RESULT_LABEL[flash.result] : null;
    const doneCount = sortedItems.filter((i) => i.total > 0 && i.scanned >= i.total).length;
    const visibleItems = hideDone ? sortedItems.filter((i) => !(i.total > 0 && i.scanned >= i.total)) : sortedItems;
    const progress = qtySummary.total ? Math.round((qtySummary.scanned / qtySummary.total) * 100) : 0;
    const itemByCode = useMemo(
        () => Object.fromEntries((data?.items || []).map((i) => [i.code, i])),
        [data],
    );

    return (
        <div className={`${styles.wrap} ${mobile ? styles.mobile : ''}`}>
            <div className={styles.controlRow}>
                <div className={styles.field}>
                    {!mobile && '임시저장 불러오기 (여러 개 선택 시 합산)'}
                    <button
                        type="button"
                        className={`${styles.select} ${styles.pickerBtn}`}
                        onClick={() => setPanelOpen((v) => !v)}
                    >
                        {mobile
                            ? '반품입고 매칭 불러오기(임시저장 파일)'
                            : selectedIds.length
                                ? `${selectedIds.length}개 선택됨${activeIds.length ? ` (조회 중 ${activeIds.length}개)` : ''}`
                                : snapshotOptions.length === 0 ? '임시저장 기록 없음' : '임시저장을 선택하세요'}
                        <span className={styles.pickerArrow}>{panelOpen ? '▲' : '▼'}</span>
                    </button>
                    {panelOpen && (
                        <div className={styles.pickerPanel}>
                            <div className={styles.pickerList}>
                                {snapshotOptions.map((s) => (
                                    <label key={s.id} className={styles.pickerItem}>
                                        <input
                                            type="checkbox"
                                            checked={selectedIds.includes(s.id)}
                                            onChange={() => toggleSnapshot(s.id)}
                                        />
                                        <span>
                                            {s.date} {formatKstTime(s.saved_at)} · #{s.id} {s.name || ''}{s.started ? ' ✓' : ''}
                                        </span>
                                    </label>
                                ))}
                            </div>
                            <div className={styles.pickerActions}>
                                <button
                                    type="button"
                                    className={pageStyles.secondaryBtn}
                                    onClick={() => setSelectedIds([])}
                                    disabled={!selectedIds.length}
                                >
                                    선택 해제
                                </button>
                                <button
                                    type="button"
                                    className={pageStyles.secondaryBtn}
                                    onClick={handleLoadSelected}
                                    disabled={!selectedIds.length || loading}
                                >
                                    조회
                                </button>
                            </div>
                        </div>
                    )}
                </div>
                <button
                    type="button"
                    className={pageStyles.secondaryBtn}
                    disabled={!activeIds.length || loading}
                    onClick={() => {
                        if (!window.confirm('리스트를 새로고침할까요?\n(다른 사람이 찍은 수량까지 최신으로 반영되며, 찍은 수량은 그대로 유지됩니다)')) {
                            focusScan();
                            return;
                        }
                        loadSnapshots(activeIds, { refresh: true });
                    }}
                    title="임시저장 기록을 다시 읽어 수량을 갱신합니다 (찍은 수량은 유지)"
                >
                    리스트 새로고침
                </button>
                <button
                    type="button"
                    className={pageStyles.secondaryBtn}
                    disabled={!activeIds.length || loading}
                    onClick={() => {
                        const last = recent.find((r) => !r.cancelled);
                        const desc = last ? `\n${last.name || last.code} (${last.code}) · ${last.at}${last.defect ? ' · 불량' : ''}` : '';
                        if (!window.confirm(`내가 마지막으로 찍은 스캔 1건을 취소할까요?${desc}\n(다른 사람이 찍은 스캔은 취소되지 않습니다)`)) {
                            focusScan();
                            return;
                        }
                        handleUndo({ mine: true });
                    }}
                >
                    내 마지막 스캔 취소
                </button>
                <button
                    type="button"
                    className={pageStyles.secondaryBtn}
                    disabled={!activeIds.length || loading}
                    onClick={handleReset}
                    title="조회 중인 임시저장본의 검수 진행을 모두 0으로 되돌립니다"
                >
                    초기화
                </button>
            </div>

            <button
                type="button"
                className={`${styles.defectBtn} ${defectMode ? styles.defectBtnOn : ''}`}
                disabled={!activeIds.length}
                onClick={() => {
                    setDefectMode((v) => !v);
                    focusScan();
                }}
            >
                {defectMode ? '불량 모드 켜짐 — 찍는 상품은 불량으로 처리 (누르면 끄기)' : '불량등록'}
            </button>

            <div className={`${styles.scanArea} ${defectMode ? styles.scanAreaDefect : ''}`}>
            {defectMode && <div className={styles.defectBanner}>불량 모드 — 찍으면 불량으로 완료 처리됩니다</div>}
            <div className={styles.scanBox}>
                <input
                    ref={scanRef}
                    value={scanText}
                    onChange={(e) => {
                        if (e.nativeEvent?.isComposing) {
                            setScanText(e.target.value);
                            return;
                        }
                        setScanText(toEnglishKey(e.target.value));
                    }}
                    onCompositionEnd={(e) => setScanText(toEnglishKey(e.currentTarget.value))}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') handleScan();
                    }}
                    placeholder={defectMode ? '불량 상품코드 스캔' : mobile ? '상품코드 스캔' : '상품 바코드(상품코드) 스캔 후 Enter'}
                    className={`${pageStyles.scanInput} ${defectMode ? styles.scanInputDefect : ''}`}
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="characters"
                    spellCheck={false}
                    enterKeyHint="done"
                    disabled={!activeIds.length}
                />
                <div className={styles.summary}>
                    <strong>{summary.done}</strong> / {summary.total} 상품 완료
                    <span> · 총 <strong>{qtySummary.scanned}</strong> / {qtySummary.total}개</span>
                    {summary.defect > 0 && <span className={styles.defectSum}> · 불량 {summary.defect}</span>}
                </div>
                {mobile && data && (
                    <div className={styles.progress}>
                        <div className={styles.progressBar} style={{ width: `${progress}%` }} />
                    </div>
                )}
            </div>

            {recent.length > 0 && data && (
                <div className={styles.recent}>
                    <div className={styles.recentHead}>
                        <span>방금 찍은 목록 (위가 최신)</span>
                        <span className={styles.recentHeadBtns}>
                            {recent.length > RECENT_SHOW && (
                                <button type="button" className={styles.recentClear} onClick={() => setRecentMore((v) => !v)}>
                                    {recentMore ? '접기' : `더보기 (${Math.min(recent.length, RECENT_MORE)})`}
                                </button>
                            )}
                            <button type="button" className={styles.recentClear} onClick={() => pushRecent(() => [])}>목록 비우기</button>
                        </span>
                    </div>
                    <div className={recentMore ? styles.recentScroll : ''}>
                    {recent.slice(0, recentMore ? RECENT_MORE : RECENT_SHOW).map((r, idx) => {
                        const canEdit = r.logId != null && !r.cancelled;
                        const counted = r.result === 'next' || r.result === 'done';
                        const live = itemByCode[r.code];
                        const [label, cls] = RESULT_LABEL[r.result] || ['', ''];
                        const isEditing = editId === r.id && canEdit;
                        const maxMinus = Math.max(live?.scanned || 1, 1);
                        const qty = Math.min(Math.max(minusQty, 1), maxMinus);
                        const name = r.name || r.code;
                        return (
                            <React.Fragment key={r.id}>
                            <div
                                className={`${styles.recentRow} ${idx === 0 ? `${styles.recentLatest} ${cls}` : ''} ${r.cancelled ? styles.recentCancelled : ''} ${canEdit ? styles.rowClickable : ''} ${isEditing ? styles.recentEditing : ''}`}
                                onClick={() => canEdit && openEdit(r)}
                            >
                                <span className={styles.recentTag}>{r.cancelled ? '취소됨' : label.split(' — ')[0]}</span>
                                {r.defect && <span className={styles.defectBadge}>불량</span>}
                                <div className={styles.recentMain}>
                                    <div className={styles.recentName}>{r.name || '(리스트에 없음)'}</div>
                                    <div className={styles.recentCode}>{r.code} · {r.at}</div>
                                </div>
                                {live && <span className={styles.recentQty}>{live.scanned}/{live.total}</span>}
                                {canEdit && <span className={styles.editHint}>{isEditing ? '▲' : '수정'}</span>}
                            </div>
                            {isEditing && (
                                <div className={styles.editPanel}>
                                    {counted ? (
                                        <>
                                            <div className={styles.editLine}>
                                                <button
                                                    type="button"
                                                    className={`${styles.editBtn} ${styles.editBtnMinus}`}
                                                    onClick={() => {
                                                        if (!window.confirm(`${name} (${r.code})\n${qty}개를 차감할까요?\n(${live ? `${live.scanned}/${live.total} → ${live.scanned - qty}/${live.total}` : ''})`)) {
                                                            focusScan();
                                                            return;
                                                        }
                                                        setEditId(null);
                                                        handleUndo({ logId: r.logId, count: qty });
                                                    }}
                                                >
                                                    갯수 차감하기
                                                </button>
                                                <div className={styles.stepper}>
                                                    <button type="button" disabled={qty <= 1} onClick={() => setMinusQty(qty - 1)}>−</button>
                                                    <span>{qty}개</span>
                                                    <button type="button" disabled={qty >= maxMinus} onClick={() => setMinusQty(qty + 1)}>+</button>
                                                </div>
                                            </div>
                                            <button
                                                type="button"
                                                className={`${styles.editBtn} ${r.defect ? '' : styles.editBtnDefect}`}
                                                onClick={() => confirmToggle(`${name} (${r.code}) · ${r.at}`, !r.defect, () => {
                                                    setEditId(null);
                                                    handleToggleDefect(r.logId);
                                                })}
                                            >
                                                {r.defect ? '정상으로 되돌리기' : '불량으로 보내기'}
                                            </button>
                                        </>
                                    ) : (
                                        <button
                                            type="button"
                                            className={styles.editBtn}
                                            onClick={() => confirmCancel(`${name} · ${r.at} (${label.split(' — ')[0]} 기록, 수량에는 영향 없음)`, () => {
                                                setEditId(null);
                                                handleUndo({ logId: r.logId });
                                            })}
                                        >
                                            기록 지우기
                                        </button>
                                    )}
                                    <button type="button" className={`${styles.editBtn} ${styles.editBtnClose}`} onClick={closeEdit}>
                                        닫기
                                    </button>
                                </div>
                            )}
                            </React.Fragment>
                        );
                    })}
                    </div>
                </div>
            )}
            {flashInfo && !mobile && (
                <div className={`${styles.flash} ${flashInfo[1]}`}>
                    <strong>
                        {flash.defect ? '[불량] ' : ''}{flashInfo[0]}
                        {flash.result === 'next' && itemByCode[flash.code]
                            ? ` · 남은 ${Math.max(itemByCode[flash.code].total - itemByCode[flash.code].scanned, 0)}개`
                            : ''}
                    </strong>
                    <span>{flash.code}{itemByCode[flash.code] ? ` · ${itemByCode[flash.code].name}` : ''}</span>
                </div>
            )}
            {error && <div className={`${styles.flash} ${styles.flashUnknown}`}>{error}</div>}
            </div>

            {data?.errors?.length > 0 && (
                <div className={styles.errorBox}>
                    <div className={styles.errorHead}>
                        <button type="button" className={styles.errorToggle} onClick={() => setErrorsOpen((v) => !v)}>
                            <strong>스캔 오류 {data.errors.length}건</strong>
                            {mobile && <span>{errorsOpen ? ' ▲ 접기' : ' ▼ 펼치기'}</span>}
                        </button>
                        <button type="button" className={pageStyles.secondaryBtn} onClick={handleClearErrors}>
                            오류 기록 지우기
                        </button>
                    </div>
                    {errorsOpen && data.errors.map((e) => (
                        <div key={e.id} className={styles.errorRow}>
                            <span className={e.result === 'over' ? styles.tagOver : styles.tagUnknown}>
                                {e.result === 'over' ? '초과' : '리스트 없음'}
                            </span>
                            <span>{e.product_code}</span>
                            <span className={styles.time}>{e.created_at?.slice(11, 19)}</span>
                        </div>
                    ))}
                </div>
            )}

            {mobile && doneCount > 0 && (
                <label className={styles.hideDone}>
                    <input type="checkbox" checked={hideDone} onChange={(e) => setHideDone(e.target.checked)} />
                    완료된 상품 숨기기 ({doneCount}개)
                </label>
            )}

            <div className={styles.list}>
                {!data && !loading && !error && <div className={styles.empty}>임시저장본을 선택하고 조회를 누르세요.</div>}
                {data && sortedItems.length === 0 && (
                    <div className={styles.empty}>선택한 임시저장본에 고객대기/교환정상 입고 항목이 없습니다.</div>
                )}
                {visibleItems.map((item) => {
                    const complete = item.total > 0 && item.scanned >= item.total;
                    const isOpen = openCode === item.code;
                    return (
                        <React.Fragment key={item.code}>
                        <div
                            className={`${styles.row} ${complete ? styles.rowDone : styles.rowPending} ${isOpen ? styles.rowOpen : ''}`}
                        >
                            <span className={`${styles.lamp} ${complete ? styles.lampOff : styles.lampOn}`} />
                            <div
                                className={`${styles.rowMain} ${styles.rowClickable}`}
                                onClick={() => item.scanned > 0 && toggleItemOpen(item.code)}
                                title={item.scanned > 0 ? '눌러서 스캔 기록 보기·수정' : ''}
                            >
                                <div className={styles.name}>
                                    {item.name || '(상품명 없음)'}
                                    {item.defect > 0 && <span className={styles.defectBadge}>불량 {item.defect}</span>}
                                </div>
                                <div className={styles.code}>
                                    {item.unresolved ? '⚠ 상품코드 확인 불가 (스캔 불가)' : item.code}
                                    {item.scanned > 0 && <span className={styles.editHint}>{isOpen ? ' ▲ 기록 닫기' : ' ▼ 기록·수정'}</span>}
                                </div>
                            </div>
                            <div className={styles.count}>
                                <strong>{item.scanned}</strong> / {item.total}
                                {!complete && <small>남은 {item.total - item.scanned}</small>}
                                {complete && <small>완료</small>}
                                {item.defect > 0 && <small className={styles.defectSmall}>정상 {item.scanned - item.defect} · 불량 {item.defect}</small>}
                            </div>
                            <button
                                type="button"
                                className={styles.minusBtn}
                                disabled={item.scanned <= 0}
                                onClick={() => confirmCancel(`${item.name || item.code} (${item.code})의 마지막 스캔 1개`, () => handleUndo({ code: item.code }))}
                                title="이 상품 1개 취소"
                            >
                                −1
                            </button>
                        </div>
                        {isOpen && (
                            <div className={styles.logPanel}>
                                {itemLogs.loading && <div className={styles.logEmpty}>불러오는 중...</div>}
                                {!itemLogs.loading && itemLogs.code === item.code && itemLogs.logs.length === 0 && (
                                    <div className={styles.logEmpty}>스캔 기록이 없습니다.</div>
                                )}
                                {!itemLogs.loading && itemLogs.code === item.code && itemLogs.logs.map((l) => {
                                    const counted = l.result === 'next' || l.result === 'done';
                                    const at = formatKstTime(l.created_at) || l.created_at?.slice(11, 16);
                                    const desc = `${item.name || item.code} (${item.code}) · ${at} · ${l.username}${l.defect ? ' · 불량' : ''}`;
                                    return (
                                        <div key={l.id} className={styles.logRow}>
                                            <span className={counted ? (l.defect ? styles.defectBadge : styles.okBadge) : styles.tagOver}>
                                                {counted ? (l.defect ? '불량' : '정상') : RESULT_SHORT[l.result] || l.result}
                                            </span>
                                            <span className={styles.logMeta}>{at} · {l.username}</span>
                                            {counted && (
                                                <button
                                                    type="button"
                                                    className={`${styles.miniBtn} ${l.defect ? '' : styles.miniBtnDefect}`}
                                                    onClick={() => confirmToggle(desc, !l.defect, () => handleToggleDefect(l.id))}
                                                >
                                                    {l.defect ? '정상으로' : '불량으로'}
                                                </button>
                                            )}
                                            <button
                                                type="button"
                                                className={styles.miniBtn}
                                                onClick={() => confirmCancel(desc, () => handleUndo({ logId: l.id }))}
                                            >
                                                {counted ? '취소' : '지우기'}
                                            </button>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                        </React.Fragment>
                    );
                })}
            </div>
        </div>
    );
};

export default ReturnInspectionTab;
