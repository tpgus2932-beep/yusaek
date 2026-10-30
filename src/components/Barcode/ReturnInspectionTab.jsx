import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import pageStyles from './BarcodePage.module.css';
import styles from './ReturnInspectionTab.module.css';
import { LOCAL_API_BASE as API, getAuthHeaders } from '../../lib/api';
import { toEnglishKey } from './BarcodePage';

const IDS_KEY = 'returnInspectionSnapshotIds';

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

const ReturnInspectionTab = () => {
    const [dates, setDates] = useState([]);
    const [selectedIds, setSelectedIds] = useState(readSavedIds);
    const [panelOpen, setPanelOpen] = useState(false);
    const [data, setData] = useState(null);
    const [scanText, setScanText] = useState('');
    const [flash, setFlash] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const scanRef = useRef(null);
    const soundsRef = useRef(null);

    const focusScan = () => setTimeout(() => scanRef.current?.focus(), 0);

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
            setData(json);
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
            const json = await request('/scan', { snapshot_ids: activeIds, code: value });
            setData(json);
            setFlash({ result: json.result, code: json.code });
            playSound(json.result);
        } catch (err) {
            setError(err.message || '스캔 실패');
        } finally {
            focusScan();
        }
    };

    const handleUndo = async (code) => {
        try {
            const json = await request('/undo', { snapshot_ids: activeIds, code: code || undefined });
            setData(json);
            setFlash(null);
        } catch (err) {
            setError(err.message || '취소 실패');
        } finally {
            focusScan();
        }
    };

    const handleClearErrors = async () => {
        try {
            setData(await request('/clear-errors', { snapshot_ids: activeIds }));
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
    const itemByCode = useMemo(
        () => Object.fromEntries((data?.items || []).map((i) => [i.code, i])),
        [data],
    );

    return (
        <div className={styles.wrap}>
            <div className={styles.controlRow}>
                <div className={styles.field}>
                    임시저장 불러오기 (여러 개 선택 시 합산)
                    <button
                        type="button"
                        className={`${styles.select} ${styles.pickerBtn}`}
                        onClick={() => setPanelOpen((v) => !v)}
                    >
                        {selectedIds.length
                            ? `${selectedIds.length}개 선택됨${activeIds.length ? ` (조회 중 ${activeIds.length}개)` : ''}`
                            : snapshotOptions.length === 0 ? '임시저장 기록 없음' : '임시저장을 선택하세요'}
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
                    onClick={() => loadSnapshots(activeIds, { refresh: true })}
                    title="임시저장 기록을 다시 읽어 수량을 갱신합니다 (찍은 수량은 유지)"
                >
                    리스트 새로고침
                </button>
                <button
                    type="button"
                    className={pageStyles.secondaryBtn}
                    disabled={!activeIds.length || loading}
                    onClick={() => handleUndo()}
                >
                    마지막 스캔 취소
                </button>
            </div>

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
                    placeholder="상품 바코드(상품코드) 스캔 후 Enter"
                    className={pageStyles.scanInput}
                    disabled={!activeIds.length}
                />
                <div className={styles.summary}>
                    <strong>{summary.done}</strong> / {summary.total} 상품 완료
                    <span> · 총 <strong>{qtySummary.scanned}</strong> / {qtySummary.total}개</span>
                </div>
            </div>

            {flashInfo && (
                <div className={`${styles.flash} ${flashInfo[1]}`}>
                    <strong>{flashInfo[0]}</strong>
                    <span>{flash.code}{itemByCode[flash.code] ? ` · ${itemByCode[flash.code].name}` : ''}</span>
                </div>
            )}
            {error && <div className={`${styles.flash} ${styles.flashUnknown}`}>{error}</div>}

            {data?.errors?.length > 0 && (
                <div className={styles.errorBox}>
                    <div className={styles.errorHead}>
                        <strong>스캔 오류 {data.errors.length}건</strong>
                        <button type="button" className={pageStyles.secondaryBtn} onClick={handleClearErrors}>
                            오류 기록 지우기
                        </button>
                    </div>
                    {data.errors.map((e) => (
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

            <div className={styles.list}>
                {!data && !loading && !error && <div className={styles.empty}>임시저장본을 선택하고 조회를 누르세요.</div>}
                {data && sortedItems.length === 0 && (
                    <div className={styles.empty}>선택한 임시저장본에 고객대기/교환정상 입고 항목이 없습니다.</div>
                )}
                {sortedItems.map((item) => {
                    const complete = item.total > 0 && item.scanned >= item.total;
                    return (
                        <div
                            key={item.code}
                            className={`${styles.row} ${complete ? styles.rowDone : styles.rowPending}`}
                        >
                            <span className={`${styles.lamp} ${complete ? styles.lampOff : styles.lampOn}`} />
                            <div className={styles.rowMain}>
                                <div className={styles.name}>{item.name || '(상품명 없음)'}</div>
                                <div className={styles.code}>
                                    {item.unresolved ? '⚠ 상품코드 확인 불가 (스캔 불가)' : item.code}
                                </div>
                            </div>
                            <div className={styles.count}>
                                <strong>{item.scanned}</strong> / {item.total}
                                {!complete && <small>남은 {item.total - item.scanned}</small>}
                                {complete && <small>완료</small>}
                            </div>
                            <button
                                type="button"
                                className={styles.minusBtn}
                                disabled={item.scanned <= 0}
                                onClick={() => handleUndo(item.code)}
                                title="이 상품 1개 취소"
                            >
                                −1
                            </button>
                        </div>
                    );
                })}
            </div>
        </div>
    );
};

export default ReturnInspectionTab;
