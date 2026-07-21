import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import pageStyles from './BarcodePage.module.css';
import styles from './ReturnsPage.module.css';
import { getDownloadFilename } from '../../lib/download';
import { useEzadminSession } from '../../lib/EzadminSessionContext';

import { LOCAL_API_BASE as API, getAuthHeaders } from '../../lib/api';

const getTodayMmDd = () => {
    const now = new Date();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    return `${mm}-${dd}`;
};

const DEFAULT_COLUMNS = [
    '상품코드',
    '요청수량',
    '입고수량',
    '가공데이터',
    '스캔송장',
    '요청메모',
    '분류',
    '원가베이스매칭',
];

const EMPTY_QUEUES = {
    seller: [],
    customer: [],
    unmatched: [],
    exchange_seller: [],
    exchange_customer: [],
    exchange: [],
    all: [],
};

const normalizeQueues = (queues) => ({ ...EMPTY_QUEUES, ...(queues || {}) });

const ReturnsPage = () => {
    const [message, setMessage] = useState('');
    const [status, setStatus] = useState(null);
    const [savedAt, setSavedAt] = useState('');
    const [queues, setQueues] = useState(EMPTY_QUEUES);
    const [onebeRows, setOnebeRows] = useState([]);
    const [activeTab, setActiveTab] = useState('all');
    const [loading, setLoading] = useState(false);
    const [ezadminSheetLoading, setEzadminSheetLoading] = useState(false);
    const [lastSheetSeq, setLastSheetSeq] = useState(null);
    const [barcodePrintLoading, setBarcodePrintLoading] = useState(false);
    const [isLoadingAbly, setIsLoadingAbly] = useState(false);
    const [isLoadingExchange, setIsLoadingExchange] = useState(false);
    const [lotteDateFr, setLotteDateFr] = useState(
        new Date(Date.now() - 30 * 86400 * 1000).toISOString().slice(0, 10)
    );
    const [lotteDateTo, setLotteDateTo] = useState(new Date().toISOString().slice(0, 10));
    const [lotteAccount, setLotteAccount] = useState('348867');
    const [scanText, setScanText] = useState('');
    const [lastType, setLastType] = useState('-');
    const [onebeFormat, setOnebeFormat] = useState('xls');
    const [exportFormat, setExportFormat] = useState('xlsx');
    const [onebeHeaders, setOnebeHeaders] = useState(() => ({}));
    const [showCostEditor, setShowCostEditor] = useState(false);
    const [costColumns, setCostColumns] = useState([]);
    const [costRows, setCostRows] = useState([]);
    const [costTotal, setCostTotal] = useState(0);
    const [costOffset, setCostOffset] = useState(0);
    const [costQuery, setCostQuery] = useState('');
    const costLimit = 50;
    const [costEdits, setCostEdits] = useState({});
    const [costAddName, setCostAddName] = useState('');
    const [costAddCode, setCostAddCode] = useState('');
    const [costBatchOpen, setCostBatchOpen] = useState(false);
    const [costBatchText, setCostBatchText] = useState('');
    const [selectedCustomer, setSelectedCustomer] = useState(new Set());
    const [refundLoading, setRefundLoading] = useState(false);
    const [refundResults, setRefundResults] = useState(null);
    const [singleCancelSno, setSingleCancelSno] = useState('');
    const [singleRefundLoading, setSingleRefundLoading] = useState(false);
    const [singleRefundResult, setSingleRefundResult] = useState(null);
    const [singleItemSno, setSingleItemSno] = useState('');
    const [singleItemLoading, setSingleItemLoading] = useState(false);
    const [singleItemResult, setSingleItemResult] = useState(null);
    const [excelRefundLoading, setExcelRefundLoading] = useState(false);
    const [excelRefundResults, setExcelRefundResults] = useState(null);
    const searchTimer = useRef(null);
    const [selectedCols, setSelectedCols] = useState(() => ({
        상품코드: true,
        요청수량: true,
        입고수량: true,
        가공데이터: false,
        스캔송장: false,
        요청메모: false,
        분류: false,
        원가베이스매칭: false,
    }));
    const isAdmin = useMemo(() => localStorage.getItem('isAdmin') === 'true', []);
    const scanRef = useRef(null);
    const soundsRef = useRef(null);
    const soundIndexRef = useRef({ seller: 0, customer: 0, unmatched: 0 });
    const audioUnlockedRef = useRef(false);
    const hasLoadedRef = useRef(false);
    const lastTypeRef = useRef('-');
    const { openModal: openEzadminModal } = useEzadminSession();

    const queueSummary = useMemo(
        () => [
            { key: 'all', label: '전체 대기', count: queues.all.length },
            { key: 'seller', label: '판매처 대기', count: queues.seller.length },
            { key: 'customer', label: '고객 대기', count: queues.customer.length },
            { key: 'exchange_seller', label: '교환판매자', count: queues.exchange_seller.length },
            { key: 'exchange_customer', label: '교환고객', count: queues.exchange_customer.length },
            { key: 'unmatched', label: '미매칭', count: queues.unmatched.length },
            { key: 'onebe', label: '원베 행', count: onebeRows.length },
        ],
        [queues, onebeRows]
    );

    const playSound = useCallback((key) => {
        const pool = soundsRef.current?.[key];
        if (!pool || !pool.length) return;
        const idx = soundIndexRef.current[key] || 0;
        const audio = pool[idx % pool.length];
        soundIndexRef.current[key] = (idx + 1) % pool.length;
        audio.currentTime = 0;
        audio.play().catch(() => {});
    }, []);

    const tabForType = (type) => {
        const norm = String(type || '');
        if (norm.includes('교환판매자')) return 'exchange_seller';
        if (norm.includes('교환고객')) return 'exchange_customer';
        if (norm.includes('판매자') || norm.toLowerCase().includes('seller')) return 'seller';
        if (norm.includes('고객') || norm.toLowerCase().includes('customer')) return 'customer';
        if (norm.includes('미매칭') || norm.toLowerCase().includes('unmatched')) return 'unmatched';
        return '';
    };

    const playTypeSound = useCallback((type, soundType = '') => {
        const norm = String(type || '');
        if (soundType === '교환불량') {
            playSound('exchangeDefect');
            return;
        }
        if (soundType === '교환정상') {
            playSound('exchangeNormal');
            return;
        }
        if (norm.includes('판매자') || norm.toLowerCase().includes('seller')) playSound('seller');
        if (norm.includes('고객') || norm.toLowerCase().includes('customer')) playSound('customer');
        if (norm.includes('미매칭') || norm.toLowerCase().includes('unmatched')) playSound('unmatched');
    }, [playSound]);

    const refreshState = useCallback(async () => {
        try {
            const res = await fetch(`${API}/returns/state`, { headers: getAuthHeaders() });
            if (!res.ok) return;
            const data = await res.json();
            setStatus(data.status || null);
            setQueues(normalizeQueues(data.queues));
            setOnebeRows(data.onebe?.rows || []);
            setSavedAt(data.saved_at || '');
            const nextType = data.last_type || '-';
            setLastType(nextType);
            const prevType = lastTypeRef.current;
            lastTypeRef.current = nextType;
            if (hasLoadedRef.current && nextType !== prevType) {
                playTypeSound(nextType);
            }
        } catch {
            // ignore
        } finally {
            hasLoadedRef.current = true;
        }
    }, [playTypeSound]);

    useEffect(() => {
        refreshState();
        setTimeout(() => scanRef.current?.focus(), 50);
    }, [refreshState]);

    useEffect(() => {
        if (!soundsRef.current) {
            const pool = (src, size = 3) => Array.from({ length: size }, () => new Audio(src));
            soundsRef.current = {
                seller: pool('/sounds/bb.wav'),
                customer: pool('/sounds/zz.wav'),
                unmatched: pool('/sounds/dd.wav'),
                exchangeDefect: pool('/sounds/ww.wav'),
                exchangeNormal: pool('/sounds/tt.wav'),
            };
        }
    }, []);

    const unlockAudio = () => {
        if (audioUnlockedRef.current || !soundsRef.current) return;
        audioUnlockedRef.current = true;
        Object.values(soundsRef.current).flat().forEach((audio) => {
            try {
                const prevMuted = audio.muted;
                audio.muted = true;
                audio.currentTime = 0;
                const p = audio.play();
                if (p && typeof p.then === 'function') {
                    p.then(() => {
                        audio.pause();
                        audio.currentTime = 0;
                        audio.muted = prevMuted;
                    }).catch(() => {});
                }
            } catch {
                // ignore
            }
        });
    };

    useEffect(() => {
        const onUnlock = () => unlockAudio();
        window.addEventListener('keydown', onUnlock, { once: true });
        window.addEventListener('pointerdown', onUnlock, { once: true });
        return () => {
            window.removeEventListener('keydown', onUnlock);
            window.removeEventListener('pointerdown', onUnlock);
        };
    }, []);

    const handleUpload = async (file, endpoint, label) => {
        if (!file) {
            setMessage(`${label} 파일을 선택해 주세요.`);
            return;
        }
        setLoading(true);
        setMessage('');
        try {
            const formData = new FormData();
            formData.append('file', file);
            const res = await fetch(`${API}${endpoint}`, {
                method: 'POST',
                headers: getAuthHeaders(),
                body: formData,
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.detail || '업로드 실패');
            setStatus(data.status || status);
            await refreshState();
            setMessage(`${label} 업로드 완료`);
        } catch (err) {
            setMessage(err.message || '업로드 실패');
        } finally {
            setLoading(false);
        }
    };

    const handleExcel1Change = async (file) => {
        if (!file) return;
        await handleUpload(file, '/returns/excel1', 'CJ 엑셀');
    };

    const handleLotteExcelChange = async (file) => {
        if (!file) return;
        await handleUpload(file, '/returns/excel_lotte', '롯데택배 엑셀');
    };

    const handleLotteFromApi = async () => {
        setLoading(true);
        setMessage('');
        try {
            const res = await fetch(`${API}/returns/lotte-from-api`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
                body: JSON.stringify({
                    date_fr: lotteDateFr.replace(/-/g, ''),
                    date_to: lotteDateTo.replace(/-/g, ''),
                    account: lotteAccount,
                }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.detail || '불러오기 실패');
            setStatus(data.status || status);
            await refreshState();
            setMessage(`롯데 API 불러오기 완료 — ${data.map_count}건 매핑`);
        } catch (err) {
            setMessage(err.message || '불러오기 실패');
        } finally {
            setLoading(false);
        }
    };

    const handleExcel2Change = async (file) => {
        if (!file) return;
        await handleUpload(file, '/returns/excel2', '에이블리 엑셀');
    };

    const handleLoadAblyApi = async () => {
        setIsLoadingAbly(true);
        setMessage('');
        try {
            const res = await fetch(`${API}/returns/load-ably-api`, {
                method: 'POST',
                headers: getAuthHeaders(),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.detail || '에이블리 API 호출 실패');
            if (data.status) setStatus(data.status);
            setMessage(`에이블리 반품 ${data.loaded}건 로드 완료`);
        } catch (err) {
            setMessage(err.message || '에이블리 API 호출 실패');
        } finally {
            setIsLoadingAbly(false);
        }
    };

    const handleSingleRefund = async () => {
        const sno = singleCancelSno.trim();
        if (!sno) return;
        setSingleRefundLoading(true);
        setSingleRefundResult(null);
        try {
            const res = await fetch(`${API}/returns/ably-refund-single`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
                body: JSON.stringify({ cancel_sno: sno }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.detail || '처리 실패');
            setSingleRefundResult({ ok: true, ...data });
        } catch (err) {
            setSingleRefundResult({ ok: false, error: err.message });
        } finally {
            setSingleRefundLoading(false);
        }
    };

    const handleSingleItemConfirm = async () => {
        const sno = singleItemSno.trim();
        if (!sno) return;
        setSingleItemLoading(true);
        setSingleItemResult(null);
        try {
            const res = await fetch(`${API}/returns/ably-confirm-by-item-sno`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
                body: JSON.stringify({ item_sno: sno }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.detail || '처리 실패');
            setSingleItemResult({ ok: true, ...data });
        } catch (err) {
            setSingleItemResult({ ok: false, error: err.message });
        } finally {
            setSingleItemLoading(false);
        }
    };

    const handleExcelRefund = async (file) => {
        if (!file) return;
        setExcelRefundLoading(true);
        setExcelRefundResults(null);
        setMessage('');
        try {
            const formData = new FormData();
            formData.append('file', file);
            const res = await fetch(`${API}/returns/ably-refund-from-excel`, {
                method: 'POST',
                headers: getAuthHeaders(),
                body: formData,
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.detail || '처리 실패');
            setExcelRefundResults(data.results);
            setMessage(`엑셀 환불 완료: ${data.success}/${data.total}건 성공`);
        } catch (err) {
            setMessage(err.message || '엑셀 환불 처리 실패');
        } finally {
            setExcelRefundLoading(false);
        }
    };

    const handleAblyRefundSubmit = async () => {
        const selectedItems = queues.customer.filter((item) => selectedCustomer.has(item.id));
        if (!selectedItems.length) return;
        setRefundLoading(true);
        setRefundResults(null);
        setMessage('');
        try {
            const res = await fetch(`${API}/returns/ably-refund-submit`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
                body: JSON.stringify({ items: selectedItems }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.detail || '처리 실패');
            setRefundResults(data.results);
            const ok = data.results.filter((r) => r.ok).length;
            setMessage(`에이블리 반품 넘기기 완료: ${ok}/${data.results.length}건 성공`);
        } catch (err) {
            setMessage(err.message || '에이블리 반품 넘기기 실패');
        } finally {
            setRefundLoading(false);
        }
    };

    const handleLoadExchangeApi = async () => {
        setIsLoadingExchange(true);
        setMessage('');
        try {
            const res = await fetch(`${API}/returns/load-exchange-api`, {
                method: 'POST',
                headers: getAuthHeaders(),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.detail || '교환 API 호출 실패');
            if (data.status) setStatus(data.status);
            setMessage(`교환 ${data.loaded}건 로드 완료`);
        } catch (err) {
            setMessage(err.message || '교환 API 호출 실패');
        } finally {
            setIsLoadingExchange(false);
        }
    };

    const handleExchangeExcelChange = async (files) => {
        if (!files || files.length === 0) return;
        setLoading(true);
        setMessage('');
        try {
            const formData = new FormData();
            Array.from(files).forEach((f) => formData.append('files', f));
            const res = await fetch(`${API}/returns/exchange`, {
                method: 'POST',
                headers: getAuthHeaders(),
                body: formData,
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.detail || '업로드 실패');
            setStatus(data.status || status);
            await refreshState();
            setMessage(`교환 엑셀 업로드 완료 (${files.length}개)`);
        } catch (err) {
            setMessage(err.message || '업로드 실패');
        } finally {
            setLoading(false);
        }
    };

    const handleCostReload = async () => {
        setLoading(true);
        setMessage('');
        try {
            const res = await fetch(`${API}/returns/cost-base/reload`, {
                method: 'POST',
                headers: getAuthHeaders(),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.detail || '원가베이스 로드 실패');
            setStatus(data.status || status);
            await refreshState();
            setMessage('원가베이스 로드 완료');
        } catch (err) {
            setMessage(err.message || '원가베이스 로드 실패');
        } finally {
            setLoading(false);
        }
    };

    const fetchCostPreview = async (offset = 0, query = costQuery) => {
        const q = (query || '').trim();
        try {
            const res = await fetch(
                `${API}/returns/cost-base/preview?offset=${offset}&limit=${costLimit}&q=${encodeURIComponent(q)}`,
                { headers: getAuthHeaders() }
            );
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.detail || '원가베이스 미리보기 실패');
            setCostColumns(data.columns || []);
            setCostRows(data.rows || []);
            setCostTotal(data.total || 0);
            setCostOffset(offset);
            setCostEdits({});
        } catch (err) {
            setMessage(err.message || '원가베이스 미리보기 실패');
        }
    };

    const openCostEditor = async () => {
        setShowCostEditor(true);
        await fetchCostPreview(0, '');
    };

    const handleCostCellChange = (rowIndex, colIndex, value) => {
        setCostRows((prev) =>
            prev.map((row) =>
                row.row_index === rowIndex
                    ? { ...row, values: row.values.map((v, i) => (i === colIndex ? value : v)) }
                    : row
            )
        );
        setCostEdits((prev) => {
            const key = `${rowIndex}:${colIndex}`;
            return { ...prev, [key]: { row_index: rowIndex, column: colIndex, value } };
        });
    };

    const handleCostCellCommit = async () => {
        const edits = Object.values(costEdits);
        if (!edits.length) {
            setMessage('변경된 내용이 없습니다.');
            return;
        }
        try {
            const res = await fetch(`${API}/returns/cost-base/edit-batch`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
                body: JSON.stringify({ edits }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.detail || '원가베이스 수정 실패');
            setMessage('원가베이스 변경 적용 완료');
            setCostEdits({});
        } catch (err) {
            setMessage(err.message || '원가베이스 수정 실패');
            await fetchCostPreview(costOffset, costQuery);
        }
    };

    const handleCostBaseAddSingle = async () => {
        const name = (costAddName || '').trim();
        const code = (costAddCode || '').trim();
        if (!name && !code) {
            setMessage('A열 또는 I열 값을 입력하세요.');
            return;
        }
        try {
            const res = await fetch(`${API}/returns/cost-base/add-row`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
                body: JSON.stringify({ name, code }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.detail || '개별상품추가 실패');
            setStatus(data.status || status);
            setCostAddName('');
            setCostAddCode('');
            setMessage('개별상품추가 완료');
            await refreshState();
            if (showCostEditor) {
                await fetchCostPreview(0, '');
            }
        } catch (err) {
            setMessage(err.message || '개별상품추가 실패');
        }
    };

    const handleCostBaseAppendBatch = async () => {
        const text = costBatchText.trim();
        if (!text) { setMessage('추가할 데이터를 붙여넣으세요.'); return; }
        try {
            const res = await fetch(`${API}/returns/cost-base/append-rows`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
                body: JSON.stringify({ text }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.detail || '원가베이스 추가 실패');
            setCostBatchText('');
            setCostBatchOpen(false);
            setMessage(`원가베이스 ${data.appended || 0}행 추가 완료`);
            await refreshState();
            if (showCostEditor) await fetchCostPreview(0, '');
        } catch (err) { setMessage(err.message || '원가베이스 추가 실패'); }
    };

    const handleScan = async () => {
        const value = scanText.trim();
        if (!value) return;
        unlockAudio();
        try {
            const res = await fetch(`${API}/returns/scan`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
                body: JSON.stringify({ barcode: value }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.detail || '스캔 실패');
            setQueues(normalizeQueues(data.queues || queues));
            const nextType = data.last_type || '-';
            setLastType(nextType);
            lastTypeRef.current = nextType;
            const nextTab = tabForType(nextType);
            if (nextTab) setActiveTab(nextTab);
            const shouldPlay = nextType !== '-' && nextType !== '' && nextType !== '중복';
            if (shouldPlay) {
                playTypeSound(nextType, String(data.sound_type || ''));
            }
        } catch (err) {
            setMessage(err.message || '스캔 실패');
        } finally {
            setScanText('');
            setTimeout(() => scanRef.current?.focus(), 0);
        }
    };

    const handleUndo = async () => {
        try {
            const res = await fetch(`${API}/returns/undo`, {
                method: 'POST',
                headers: getAuthHeaders(),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.detail || '삭제 실패');
            setQueues(normalizeQueues(data.queues || queues));
            setLastType(data.last_type || '-');
        } catch (err) {
            setMessage(err.message || '삭제 실패');
        }
    };

    const handleSaveSnapshot = async () => {
        try {
            const res = await fetch(`${API}/returns/save`, {
                method: 'POST',
                headers: getAuthHeaders(),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.detail || '임시저장 실패');
            setSavedAt(data.saved_at || '');
            setMessage('반품 스캔 상태를 임시저장했습니다.');
        } catch (err) {
            setMessage(err.message || '임시저장 실패');
        }
    };

    const handleLoadSnapshot = async () => {
        try {
            const res = await fetch(`${API}/returns/load`, {
                method: 'POST',
                headers: getAuthHeaders(),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.detail || '불러오기 실패');
            setStatus(data.status || null);
            setQueues(normalizeQueues(data.queues));
            setOnebeRows(data.onebe?.rows || []);
            setSavedAt(data.saved_at || '');
            setLastType(data.last_type || '-');
            lastTypeRef.current = data.last_type || '-';
            setMessage('임시저장된 반품 스캔 상태를 불러왔습니다.');
        } catch (err) {
            setMessage(err.message || '불러오기 실패');
        }
    };

    const handleReset = async () => {
        if (!window.confirm('대기 리스트를 초기화할까요?')) return;
        try {
            const res = await fetch(`${API}/returns/reset`, {
                method: 'POST',
                headers: getAuthHeaders(),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.detail || '초기화 실패');
            await refreshState();
        } catch (err) {
            setMessage(err.message || '초기화 실패');
        }
    };

    const handleCopyPreview = async () => {
        if (!onebeRows.length) {
            setMessage('먼저 원베양식을 생성하세요.');
            return;
        }
        const cols = selectedColumnList.length ? selectedColumnList : ['상품코드', '요청수량', '입고수량'];
        const headers = cols.map((c) => (onebeHeaders[c] ?? c).trim() || c);
        const header = headers.join('\t');
        const body = onebeRows
            .map((row) => cols.map((c) => (row?.[c] ?? '')).join('\t'))
            .join('\n');
        try {
            await navigator.clipboard.writeText(`${header}\n${body}`);
            setMessage('미리보기 복사 완료');
        } catch {
            setMessage('복사 실패');
        }
    };

    const handleConsolidate = async () => {
        try {
            const res = await fetch(`${API}/returns/onebe/consolidate`, {
                method: 'POST',
                headers: getAuthHeaders(),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.detail || '같은수량가공 실패');
            setOnebeRows(data.onebe?.rows || []);
        } catch (err) {
            setMessage(err.message || '같은수량가공 실패');
        }
    };

    const handleBuildOnebe = async () => {
        const source = 'customer';
        try {
            const res = await fetch(`${API}/returns/onebe/build`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
                body: JSON.stringify({ source }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.detail || '원베양식 생성 실패');
            setOnebeRows(data.onebe?.rows || []);
            setActiveTab('onebe');
        } catch (err) {
            setMessage(err.message || '원베양식 생성 실패');
        }
    };

    const handleCreateEzadminSheet = async () => {
        try {
            setEzadminSheetLoading(true);
            setMessage('');
            const res = await fetch(`${API}/returns/onebe/create-ezadmin-sheet`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
                body: JSON.stringify({}),
            });
            const data = await res.json().catch(() => ({}));
            if (data?.need_session) {
                openEzadminModal(handleCreateEzadminSheet);
                return;
            }
            if (!res.ok || !data?.ok) {
                throw new Error(data?.detail || data?.error || '전표 생성 실패');
            }
            setLastSheetSeq(data.sheet_seq);
            setMessage(`반품 바코드 전표 생성 및 상품 일괄추가 완료 (${data.uploaded_count ?? 0}건)`);
        } catch (err) {
            setMessage(err.message || '전표 생성 실패');
        } finally {
            setEzadminSheetLoading(false);
        }
    };

    const handleBarcodePrint = async () => {
        if (!lastSheetSeq || !onebeRows.length) return;
        setBarcodePrintLoading(true);
        try {
            const products = onebeRows
                .filter(r => r['상품코드'])
                .sort((a, b) => (b['가공데이터'] || '').localeCompare(a['가공데이터'] || '', 'ko'))
                .flatMap(r => {
                    const qty = Number(r['입고수량']) || Number(r['요청수량']) || 1;
                    return Array.from({ length: qty }, () => ({
                        code: r['상품코드'],
                        name: r['가공데이터'] || '',
                        option: '',
                        qty: 1,
                    }));
                });
            const res = await fetch(`${API}/returns/onebe/barcode-print`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
                body: JSON.stringify({ sheet_seq: lastSheetSeq, products }),
            });
            const data = await res.json().catch(() => ({}));
            if (data?.need_session) { openEzadminModal(handleBarcodePrint); return; }
            if (!data?.ok) { setMessage(`바코드 출력 오류: ${data?.error || '알 수 없는 오류'}`); return; }
            const win = window.open('', '_blank', 'width=900,height=700');
            win.document.write(data.html);
            win.document.close();
            win.focus();
            setTimeout(() => win.print(), 800);
        } catch (err) {
            setMessage(`바코드 출력 오류: ${err.message}`);
        } finally {
            setBarcodePrintLoading(false);
        }
    };

    const getOnebeDisplayValue = (row, column) => {
        if (!row) return '';
        if (column === '입고수량' && row['입고수량'] === undefined && row['수량'] !== undefined) {
            return row['수량'];
        }
        if (column === '요청메모' && row['요청메모'] === undefined && row['매칭송장'] !== undefined) {
            return row['매칭송장'];
        }
        return row?.[column] ?? '';
    };

    const mapOnebeEditColumn = (row, column) => {
        if (!row) return column;
        if (column === '입고수량' && row['입고수량'] === undefined && row['수량'] !== undefined) return '수량';
        if (column === '요청메모' && row['요청메모'] === undefined && row['매칭송장'] !== undefined) return '매칭송장';
        return column;
    };

    const updateOnebeCell = (rowIndex, column, value) => {
        const nextRows = [...onebeRows];
        if (!nextRows[rowIndex]) return;
        const actualColumn = mapOnebeEditColumn(nextRows[rowIndex], column);
        nextRows[rowIndex] = { ...nextRows[rowIndex], [actualColumn]: value };
        setOnebeRows(nextRows);
    };

    const commitOnebeCell = async (rowIndex, column, value) => {
        const row = onebeRows[rowIndex];
        const actualColumn = mapOnebeEditColumn(row, column);
        try {
            const res = await fetch(`${API}/returns/onebe/edit`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
                body: JSON.stringify({ row_index: rowIndex, column: actualColumn, value }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.detail || '수정 실패');
        } catch (err) {
            setMessage(err.message || '수정 실패');
            await refreshState();
        }
    };

    const selectedColumnList = DEFAULT_COLUMNS.filter((c) => selectedCols[c]);

    const handleDownload = async (endpoint, filenameFallback, payload) => {
        try {
            const res = await fetch(`${API}${endpoint}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
                body: JSON.stringify(payload || {}),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data?.detail || '다운로드 실패');
            }
            const blob = await res.blob();
            const filename = getDownloadFilename(res, filenameFallback);
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            a.remove();
            window.URL.revokeObjectURL(url);
        } catch (err) {
            setMessage(err.message || '다운로드 실패');
        }
    };

    const renderTable = (items) => {
        if (!items || items.length === 0) {
            return <div className={pageStyles.empty}>데이터가 없습니다.</div>;
        }
        const hasReason = items.some((item) => item.reason);
        const hasDetailReason = items.some((item) => item.detail_reason);
        const hasUserComment = items.some((item) => item.user_comment);
        return (
            <div className={pageStyles.tableWrap}>
                <table className={pageStyles.table}>
                    <thead>
                        <tr>
                            <th>스캔송장</th>
                            <th>요청메모</th>
                            <th>가공데이터</th>
                            <th>입고수량</th>
                            <th>분류</th>
                            {hasReason && <th>사유</th>}
                            {hasDetailReason && <th>상세사유</th>}
                            {hasUserComment && <th>고객메모</th>}
                        </tr>
                    </thead>
                    <tbody>
                        {items.map((item) => (
                            <tr key={item.id}>
                                <td>{item.scan}</td>
                                <td>{item.match}</td>
                                <td>{item.item_text}</td>
                                <td>{item.qty}</td>
                                <td>{item.type}</td>
                                {hasReason && <td>{item.reason || ''}</td>}
                                {hasDetailReason && <td>{item.detail_reason || ''}</td>}
                                {hasUserComment && <td>{item.user_comment || ''}</td>}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        );
    };

    return (
        <div className={`${pageStyles.page} ${styles.page}`}>
            <div className={`${pageStyles.pageHeader} ${styles.hero}`}>
                <div>
                    <h2 className={pageStyles.title}>반품</h2>
                    <p className={pageStyles.subtitle}>반품 송장 매칭 / 대기 / 추출 + 원베양식 생성</p>
                </div>
                <div className={styles.summaryStrip}>
                    {queueSummary.map((item) => (
                        <div
                            key={item.key}
                            className={`${styles.summaryCard} ${activeTab === item.key ? styles.summaryCardActive : ''}`}
                        >
                            <span className={styles.summaryLabel}>{item.label}</span>
                            <strong className={styles.summaryValue}>{item.count}</strong>
                        </div>
                    ))}
                </div>
            </div>

            <div className={`${pageStyles.stack} ${styles.layout}`}>
                <section className={`${pageStyles.card} ${styles.setupCard}`}>
                    <div className={pageStyles.cardHeader}>
                        <h3 className={pageStyles.cardTitle}>엑셀 업로드</h3>
                        {loading && <span className={pageStyles.pill}>처리 중</span>}
                    </div>
                    <div className={`${pageStyles.uploadRow} ${styles.fileRow}`}>
                        <label className={pageStyles.fileInput}>
                            <input
                                type="file"
                                accept=".xls,.xlsx,.xlsm"
                                onChange={(e) => handleExcel1Change(e.target.files?.[0] ?? null)}
                            />
                            CJ 엑셀 선택
                        </label>
                        <select
                            value={lotteAccount}
                            onChange={(e) => setLotteAccount(e.target.value)}
                            disabled={loading}
                            style={{ width: 'auto' }}
                        >
                            <option value="348867">영신디앤아이 (348867)</option>
                            <option value="331595">바브 (331595)</option>
                        </select>
                        <button
                            type="button"
                            className={pageStyles.fileInput}
                            onClick={handleLotteFromApi}
                            disabled={loading}
                        >
                            <span style={{
                                display: 'inline-block',
                                width: 8,
                                height: 8,
                                borderRadius: '50%',
                                background: (status?.lotte_loaded || status?.map_lotte_count > 0) ? '#22c55e' : '#d1d5db',
                                marginRight: 6,
                                verticalAlign: 'middle',
                                flexShrink: 0,
                            }} />
                            롯데 API 불러오기
                        </button>
                        <button
                            type="button"
                            className={pageStyles.fileInput}
                            onClick={handleLoadAblyApi}
                            disabled={isLoadingAbly}
                        >
                            <span style={{
                                display: 'inline-block',
                                width: 8,
                                height: 8,
                                borderRadius: '50%',
                                background: status?.excel2_loaded ? '#22c55e' : '#d1d5db',
                                marginRight: 6,
                                verticalAlign: 'middle',
                                flexShrink: 0,
                            }} />
                            {isLoadingAbly ? '불러오는 중...' : '반품 API 불러오기'}
                        </button>
                        <button
                            type="button"
                            className={pageStyles.fileInput}
                            onClick={handleLoadExchangeApi}
                            disabled={isLoadingExchange}
                        >
                            <span style={{
                                display: 'inline-block',
                                width: 8,
                                height: 8,
                                borderRadius: '50%',
                                background: status?.exchange_loaded ? '#22c55e' : '#d1d5db',
                                marginRight: 6,
                                verticalAlign: 'middle',
                                flexShrink: 0,
                            }} />
                            {isLoadingExchange ? '불러오는 중...' : '교환 API 불러오기'}
                        </button>
                    </div>
                    <div className={`${pageStyles.uploadRow} ${styles.compactActions}`}>
                        <button className={pageStyles.secondaryBtn} onClick={handleCostReload} disabled={loading}>
                            새로 로드
                        </button>
                        <button className={pageStyles.secondaryBtn} onClick={handleSaveSnapshot} disabled={loading}>
                            임시저장
                        </button>
                        <button className={pageStyles.secondaryBtn} onClick={handleLoadSnapshot} disabled={loading}>
                            불러오기
                        </button>
                        <button className={pageStyles.secondaryBtn} onClick={openCostEditor}>
                            원가베이스 편집
                        </button>
                    </div>
                    {savedAt && <div className={pageStyles.metaLabel}>마지막 임시저장: {savedAt}</div>}
                    {isAdmin && (
                        <div className={`${pageStyles.uploadRow} ${styles.adminRow}`}>
                            <input
                                className={pageStyles.cellInput}
                                style={{ maxWidth: 220 }}
                                value={costAddCode}
                                onChange={(e) => setCostAddCode(e.target.value)}
                                placeholder="A열 상품코드"
                            />
                            <input
                                className={pageStyles.searchInput}
                                value={costAddName}
                                onChange={(e) => setCostAddName(e.target.value)}
                                placeholder="I열 상품명 색상 사이즈"
                            />
                            <button className={pageStyles.primaryBtn} onClick={handleCostBaseAddSingle}>
                                개별상품추가
                            </button>
                            <button className={pageStyles.primaryBtn} onClick={() => setCostBatchOpen(true)}>
                                원가베이스 추가
                            </button>
                        </div>
                    )}

                    {message && (
                        <div className={pageStyles.statusMsg}>
                            <strong>{message}</strong>
                        </div>
                    )}
                </section>

                <section className={`${pageStyles.card} ${styles.scanCard}`}>
                    <div className={pageStyles.cardHeader}>
                        <h3 className={pageStyles.cardTitle}>바코드 스캔</h3>
                        <div className={pageStyles.headerActions}>
                            <span className={pageStyles.pill}>최근 분류: {lastType}</span>
                            <button className={pageStyles.secondaryBtn} onClick={handleUndo}>
                                방금 찍은거 삭제
                            </button>
                        </div>
                    </div>
                    <div className={`${pageStyles.scanRow} ${styles.scanRow}`}>
                        <input
                            ref={scanRef}
                            className={pageStyles.scanInput}
                            value={scanText}
                            onChange={(e) => setScanText(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                    unlockAudio();
                                    handleScan();
                                }
                            }}
                            placeholder="반품 송장 바코드를 입력 후 Enter"
                        />
                        <div className={`${pageStyles.uploadRow} ${styles.scanActions}`}>
                            <button className={pageStyles.primaryBtn} onClick={handleScan}>
                                매칭/대기
                            </button>
                        </div>
                    </div>
                </section>

                <section className={`${pageStyles.card} ${styles.queueCard}`}>
                    <div className={pageStyles.cardHeader}>
                        <h3 className={pageStyles.cardTitle}>대기/원베</h3>
                        <div className={`${pageStyles.tabRow} ${styles.tabRow}`}>
                            {[
                                ['all', '전체 대기'],
                                ['seller', '판매자 대기'],
                                ['customer', '고객 대기'],
                                ['exchange_seller', '교환판매자'],
                                ['exchange_customer', '교환고객'],
                                ['unmatched', '미매칭 대기'],
                                ['onebe', '원베양식(고객대기)'],
                            ].map(([key, label]) => (
                                <button
                                    key={key}
                                    className={`${pageStyles.tabBtn} ${
                                        activeTab === key ? pageStyles.tabActive : ''
                                    }`}
                                    onClick={() => setActiveTab(key)}
                                >
                                    {label}
                                </button>
                            ))}
                        </div>
                    </div>

                    {activeTab !== 'onebe' && (
                        <>
                            {activeTab === 'all' && renderTable(queues.all)}
                            {activeTab === 'seller' && renderTable(queues.seller)}
                            {activeTab === 'customer' && (() => {
                                const items = queues.customer;
                                if (!items || items.length === 0) return <div className={pageStyles.empty}>데이터가 없습니다.</div>;
                                const allChecked = items.length > 0 && items.every((i) => selectedCustomer.has(i.id));
                                const hasDetailReason = items.some((i) => i.detail_reason);
                                const hasUserComment = items.some((i) => i.user_comment);
                                return (
                                    <div className={pageStyles.tableWrap}>
                                        <table className={pageStyles.table}>
                                            <thead>
                                                <tr>
                                                    <th style={{ width: '32px', textAlign: 'center' }}>
                                                        <input
                                                            type="checkbox"
                                                            checked={allChecked}
                                                            onChange={() => {
                                                                if (allChecked) {
                                                                    setSelectedCustomer(new Set());
                                                                } else {
                                                                    setSelectedCustomer(new Set(items.map((i) => i.id)));
                                                                }
                                                            }}
                                                        />
                                                    </th>
                                                    <th>스캔송장</th>
                                                    <th>요청메모</th>
                                                    <th>가공데이터</th>
                                                    <th>입고수량</th>
                                                    <th>분류</th>
                                                    {hasDetailReason && <th>상세사유</th>}
                                                    {hasUserComment && <th>고객메모</th>}
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {items.map((item) => (
                                                    <tr key={item.id} style={selectedCustomer.has(item.id) ? { background: 'var(--bg-secondary)' } : undefined}>
                                                        <td style={{ textAlign: 'center' }}>
                                                            <input
                                                                type="checkbox"
                                                                checked={selectedCustomer.has(item.id)}
                                                                onChange={() => {
                                                                    setSelectedCustomer((prev) => {
                                                                        const next = new Set(prev);
                                                                        next.has(item.id) ? next.delete(item.id) : next.add(item.id);
                                                                        return next;
                                                                    });
                                                                }}
                                                            />
                                                        </td>
                                                        <td>{item.scan}</td>
                                                        <td>{item.match}</td>
                                                        <td>{item.item_text}</td>
                                                        <td>{item.qty}</td>
                                                        <td>{item.type}</td>
                                                        {hasDetailReason && <td>{item.detail_reason || ''}</td>}
                                                        {hasUserComment && <td>{item.user_comment || ''}</td>}
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                );
                            })()}
                            {activeTab === 'exchange_seller' && renderTable(queues.exchange_seller)}
                            {activeTab === 'exchange_customer' && renderTable(queues.exchange_customer)}
                            {activeTab === 'unmatched' && renderTable(queues.unmatched)}
                        </>
                    )}

                    {activeTab === 'onebe' && (
                        <div className={`${pageStyles.stack} ${styles.onebePanel}`}>
                            <div className={`${pageStyles.uploadRow} ${styles.onebeActions}`}>
                                <button className={pageStyles.primaryBtn} onClick={handleBuildOnebe}>
                                    고객대기 → 원베양식 생성
                                </button>
                                <button className={pageStyles.secondaryBtn} onClick={handleCopyPreview}>
                                    미리보기 복사(엑셀 붙여넣기)
                                </button>
                                <button className={pageStyles.secondaryBtn} onClick={handleConsolidate}>
                                    같은수량가공
                                </button>
                                <button
                                    className={pageStyles.secondaryBtn}
                                    onClick={handleCreateEzadminSheet}
                                    disabled={ezadminSheetLoading}
                                >
                                    {ezadminSheetLoading ? '전표/상품 처리 중...' : '전표생성+상품일괄추가'}
                                </button>
                                <button
                                    className={pageStyles.secondaryBtn}
                                    onClick={handleBarcodePrint}
                                    disabled={barcodePrintLoading || !lastSheetSeq || !onebeRows.length}
                                    title={lastSheetSeq ? `전표 ${lastSheetSeq} 바코드 출력` : '전표 생성 후 활성화'}
                                >
                                    {barcodePrintLoading ? '출력 중...' : `바코드 출력${lastSheetSeq ? ` (${lastSheetSeq})` : ''}`}
                                </button>
                                <button
                                    className={pageStyles.secondaryBtn}
                                    onClick={() =>
                                        handleDownload('/returns/download/onebe', `${getTodayMmDd()} 이지어드민 반품.${onebeFormat}`, {
                                            columns: selectedColumnList,
                                            format: onebeFormat,
                                            header_map: onebeHeaders,
                                        })
                                    }
                                >
                                    원베양식 저장
                                </button>
                            </div>
                            <div className={`${pageStyles.uploadRow} ${styles.formatRow}`}>
                                <span className={styles.formatLabel}>파일 형식:</span>
                                <label className={pageStyles.radioItem}>
                                    <input
                                        type="radio"
                                        name="onebeFormat"
                                        value="xlsx"
                                        checked={onebeFormat === 'xlsx'}
                                        onChange={() => setOnebeFormat('xlsx')}
                                    />
                                    xlsx
                                </label>
                                <label className={pageStyles.radioItem}>
                                    <input
                                        type="radio"
                                        name="onebeFormat"
                                        value="xls"
                                        checked={onebeFormat === 'xls'}
                                        onChange={() => setOnebeFormat('xls')}
                                    />
                                    xls
                                </label>
                            </div>
                            <div className={`${pageStyles.checkboxRow} ${styles.checkboxRow}`}>
                                {DEFAULT_COLUMNS.map((col) => (
                                    <label key={col} className={pageStyles.checkboxItem}>
                                        <input
                                            type="checkbox"
                                            checked={!!selectedCols[col]}
                                            onChange={(e) =>
                                                setSelectedCols((prev) => ({ ...prev, [col]: e.target.checked }))
                                            }
                                        />
                                        {col}
                                    </label>
                                ))}
                            </div>
                            <div className={pageStyles.tableWrap}>
                                <table className={pageStyles.table}>
                                    <thead>
                                        <tr>
                                            {selectedColumnList.map((col) => (
                                                <th key={col}>
                                                    <input
                                                        className={pageStyles.cellInput}
                                                        value={onebeHeaders[col] ?? col}
                                                        onChange={(e) =>
                                                            setOnebeHeaders((prev) => ({
                                                                ...prev,
                                                                [col]: e.target.value,
                                                            }))
                                                        }
                                                    />
                                                </th>
                                            ))}
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {onebeRows.map((row, rowIndex) => (
                                            <tr key={`${rowIndex}-${row['상품코드'] || ''}`}>
                                                {selectedColumnList.map((col) => (
                                                    <td key={col}>
                                                        <input
                                                            className={pageStyles.cellInput}
                                                            value={getOnebeDisplayValue(row, col)}
                                                            onChange={(e) =>
                                                                updateOnebeCell(rowIndex, col, e.target.value)
                                                            }
                                                            onBlur={(e) =>
                                                                commitOnebeCell(rowIndex, col, e.target.value)
                                                            }
                                                            onKeyDown={(e) => {
                                                                if (e.key === 'Enter') {
                                                                    e.currentTarget.blur();
                                                                }
                                                            }}
                                                        />
                                                    </td>
                                                ))}
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                                {!onebeRows.length && (
                                    <div className={pageStyles.empty}>원베양식 데이터가 없습니다.</div>
                                )}
                            </div>
                        </div>
                    )}
                </section>

                <section className={pageStyles.card}>
                    <div className={pageStyles.cardHeader}>
                        <h3 className={pageStyles.cardTitle}>판매자/고객/미매칭 추출</h3>
                    </div>
                    <div className={pageStyles.uploadRow}>
                        <span>파일 형식:</span>
                        <label className={pageStyles.radioItem}>
                            <input
                                type="radio"
                                name="exportFormat"
                                value="xlsx"
                                checked={exportFormat === 'xlsx'}
                                onChange={() => setExportFormat('xlsx')}
                            />
                            xlsx
                        </label>
                        <label className={pageStyles.radioItem}>
                            <input
                                type="radio"
                                name="exportFormat"
                                value="xls"
                                checked={exportFormat === 'xls'}
                                onChange={() => setExportFormat('xls')}
                            />
                            xls
                        </label>
                        <button
                            className={pageStyles.primaryBtn}
                            onClick={() =>
                                handleDownload('/returns/download/queues', `${getTodayMmDd()} 에이블리 반품.${exportFormat}`, {
                                    format: exportFormat,
                                })
                            }
                        >
                            추출 저장
                        </button>
                        <button className={pageStyles.secondaryBtn} onClick={handleReset}>
                            대기 리스트 초기화
                        </button>
                    </div>
                </section>

                <section className={pageStyles.card}>
                    <div className={pageStyles.cardHeader}>
                        <h3 className={pageStyles.cardTitle}>에이블리 반품 넘기기</h3>
                    </div>

                    {/* item_sno 직접 확정 */}
                    <div className={pageStyles.uploadRow} style={{ borderBottom: '1px solid var(--border-color)', paddingBottom: '0.75rem', marginBottom: '0.5rem' }}>
                        <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>item_sno 직접 입력</span>
                        <input
                            className={pageStyles.searchInput}
                            style={{ width: '180px' }}
                            value={singleItemSno}
                            onChange={(e) => { setSingleItemSno(e.target.value); setSingleItemResult(null); }}
                            onKeyDown={(e) => e.key === 'Enter' && handleSingleItemConfirm()}
                            placeholder="item_sno 입력"
                        />
                        <button
                            className={pageStyles.primaryBtn}
                            onClick={handleSingleItemConfirm}
                            disabled={singleItemLoading || !singleItemSno.trim()}
                        >
                            {singleItemLoading ? '처리 중...' : '반품 확정'}
                        </button>
                        {singleItemResult && (
                            <span style={{ fontSize: '0.82rem', color: singleItemResult.ok ? '#22c55e' : '#ef4444' }}>
                                {singleItemResult.ok
                                    ? `✓ 성공 (item_sno:${singleItemResult.item_sno})`
                                    : `✗ ${singleItemResult.error}`}
                            </span>
                        )}
                    </div>

                    {/* 단건 테스트 */}
                    <div className={pageStyles.uploadRow} style={{ borderBottom: '1px solid var(--border-color)', paddingBottom: '0.75rem', marginBottom: '0.5rem' }}>
                        <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>반품요청번호 직접 입력</span>
                        <input
                            className={pageStyles.searchInput}
                            style={{ width: '180px' }}
                            value={singleCancelSno}
                            onChange={(e) => { setSingleCancelSno(e.target.value); setSingleRefundResult(null); }}
                            onKeyDown={(e) => e.key === 'Enter' && handleSingleRefund()}
                            placeholder="cancel_sno 입력"
                        />
                        <button
                            className={pageStyles.primaryBtn}
                            onClick={handleSingleRefund}
                            disabled={singleRefundLoading || !singleCancelSno.trim()}
                        >
                            {singleRefundLoading ? '처리 중...' : '환불 요청'}
                        </button>
                        {singleRefundResult && (
                            <span style={{ fontSize: '0.82rem', color: singleRefundResult.ok ? '#22c55e' : '#ef4444' }}>
                                {singleRefundResult.ok
                                    ? `✓ 성공 (cancel:${singleRefundResult.cancel_sno} / item:${singleRefundResult.item_sno})`
                                    : `✗ ${singleRefundResult.error}`}
                            </span>
                        )}
                    </div>

                    {/* 일괄 처리 */}
                    <div className={pageStyles.uploadRow}>
                        <button
                            className={pageStyles.primaryBtn}
                            onClick={handleAblyRefundSubmit}
                            disabled={refundLoading || selectedCustomer.size === 0}
                        >
                            {refundLoading ? '처리 중...' : `에이블리 환불 요청 (${selectedCustomer.size}건 선택)`}
                        </button>
                        <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                            고객 대기 탭에서 항목을 체크 후 클릭하세요
                        </span>
                    </div>

                    {/* 엑셀 파일로 환불 */}
                    <div className={pageStyles.uploadRow} style={{ borderTop: '1px solid var(--border-color)', paddingTop: '0.75rem', marginTop: '0.25rem' }}>
                        <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>추출 엑셀로 넘기기</span>
                        <label className={pageStyles.fileInput} style={{ opacity: excelRefundLoading ? 0.5 : 1, pointerEvents: excelRefundLoading ? 'none' : 'auto' }}>
                            <input
                                type="file"
                                accept=".xls,.xlsx,.xlsm"
                                onChange={(e) => handleExcelRefund(e.target.files?.[0] ?? null)}
                            />
                            {excelRefundLoading ? '처리 중...' : '엑셀 선택'}
                        </label>
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                            추출 파일의 2번째 시트(고객) H열 반품요청번호 기준
                        </span>
                    </div>
                    {excelRefundResults && (
                        <div style={{ padding: '0.5rem 1rem 0.75rem' }}>
                            {excelRefundResults.map((r, i) => (
                                <div key={i} style={{ fontSize: '0.8rem', color: r.ok ? 'var(--text-muted)' : '#ef4444', marginBottom: '2px' }}>
                                    {r.ok ? '✓' : '✗'} {r.cancel_sno} {r.error ? `— ${r.error}` : ''}
                                </div>
                            ))}
                        </div>
                    )}
                    {refundResults && (
                        <div style={{ padding: '0.5rem 1rem 0.75rem' }}>
                            {refundResults.map((r, i) => (
                                <div key={i} style={{ fontSize: '0.8rem', color: r.ok ? 'var(--text-muted)' : '#ef4444', marginBottom: '2px' }}>
                                    {r.ok ? '✓' : '✗'} {r.scan} {r.error ? `— ${r.error}` : ''}
                                </div>
                            ))}
                        </div>
                    )}
                </section>

            </div>

            {showCostEditor && (
                <div className={pageStyles.modalOverlay} onClick={() => setShowCostEditor(false)}>
                    <div className={pageStyles.modal} onClick={(e) => e.stopPropagation()}>
                        <div className={pageStyles.modalHeader}>
                            <h3 className={pageStyles.modalTitle}>원가베이스 편집</h3>
                            <div className={pageStyles.modalActions}>
                                <input
                                    className={pageStyles.searchInput}
                                    value={costQuery}
                                    onChange={(e) => {
                                        const val = e.target.value;
                                        setCostQuery(val);
                                        if (searchTimer.current) clearTimeout(searchTimer.current);
                                        searchTimer.current = setTimeout(() => {
                                            fetchCostPreview(0, val);
                                        }, 300);
                                    }}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') {
                                            fetchCostPreview(0, costQuery);
                                        }
                                    }}
                                    placeholder="검색어 입력"
                                />

                                <button className={pageStyles.primaryBtn} onClick={handleCostCellCommit}>
                                    변경 적용
                                </button>
                                <button
                                    className={pageStyles.secondaryBtn}
                                    onClick={() => setShowCostEditor(false)}
                                >
                                    닫기
                                </button>
                            </div>
                        </div>
                        <div className={pageStyles.tableWrap}>
                            <table className={pageStyles.table}>
                                <thead>
                                    <tr>
                                        <th>#</th>
                                        {costColumns.map((col) => (
                                            <th key={col}>{col}</th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody>
                                    {costRows.map((row) => (
                                        <tr key={row.row_index}>
                                            <td>{row.row_index + 1}</td>
                                            {row.values.map((val, idx) => (
                                                <td key={`${row.row_index}-${idx}`}>
                                                    <input
                                                        className={pageStyles.cellInput}
                                                        value={val ?? ''}
                                                        onChange={(e) =>
                                                            handleCostCellChange(row.row_index, idx, e.target.value)
                                                        }
                                                    />
                                                </td>
                                            ))}
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                            {!costRows.length && (
                                <div className={pageStyles.empty}>표시할 데이터가 없습니다.</div>
                            )}
                        </div>
                        <div className={pageStyles.uploadRow}>
                            <button
                                className={pageStyles.secondaryBtn}
                                onClick={() => fetchCostPreview(Math.max(0, costOffset - costLimit), costQuery)}
                                disabled={costOffset === 0}
                            >
                                이전
                            </button>
                            <button
                                className={pageStyles.secondaryBtn}
                                onClick={() =>
                                    fetchCostPreview(
                                        Math.min(costOffset + costLimit, Math.max(costTotal - costLimit, 0)),
                                        costQuery
                                    )
                                }
                                disabled={costOffset + costLimit >= costTotal}
                            >
                                다음
                            </button>
                            <span className={pageStyles.metaLabel}>
                                {costTotal ? `${costOffset + 1}-${Math.min(costOffset + costLimit, costTotal)} / ${costTotal}` : '0'}
                            </span>
                        </div>
                    </div>
                </div>
            )}

            {costBatchOpen && (
                <div className={pageStyles.modalOverlay} onClick={() => setCostBatchOpen(false)}>
                    <div className={pageStyles.modal} onClick={(e) => e.stopPropagation()}>
                        <div className={pageStyles.modalHeader}>
                            <h3 className={pageStyles.modalTitle}>원가베이스 추가</h3>
                            <button className={pageStyles.secondaryBtn} onClick={() => setCostBatchOpen(false)}>
                                닫기
                            </button>
                        </div>
                        <div className={pageStyles.tableWrap}>
                            <textarea
                                className={pageStyles.scanInput}
                                value={costBatchText}
                                onChange={(e) => setCostBatchText(e.target.value)}
                                placeholder="상품코드\t상품명 색상 사이즈 형식으로 붙여넣으세요"
                                rows={10}
                                style={{ width: '100%', resize: 'vertical' }}
                            />
                            <div className={pageStyles.metaLabel}>
                                A열 상품코드 / I열 상품명 색상 사이즈
                            </div>
                        </div>
                        <div className={pageStyles.uploadRow}>
                            <button className={pageStyles.primaryBtn} onClick={handleCostBaseAppendBatch}>
                                추가
                            </button>
                            <button className={pageStyles.secondaryBtn} onClick={() => setCostBatchOpen(false)}>
                                취소
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default ReturnsPage;
