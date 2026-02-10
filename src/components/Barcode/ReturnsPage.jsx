import React, { useEffect, useMemo, useRef, useState } from 'react';
import pageStyles from './BarcodePage.module.css';

const API = `http://${window.location.hostname}:8000`;

const getAuthHeaders = () => {
    const token = localStorage.getItem('token');
    return token ? { Authorization: `Bearer ${token}` } : {};
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

const ReturnsPage = () => {
    const [costBase, setCostBase] = useState(null);
    const [message, setMessage] = useState('');
    const [status, setStatus] = useState(null);
    const [queues, setQueues] = useState({ seller: [], customer: [], unmatched: [], all: [] });
    const [onebeRows, setOnebeRows] = useState([]);
    const [activeTab, setActiveTab] = useState('all');
    const [loading, setLoading] = useState(false);
    const [scanText, setScanText] = useState('');
    const [lastType, setLastType] = useState('-');
    const [exportFormat, setExportFormat] = useState('xlsx');
    const [onebeFormat, setOnebeFormat] = useState('xls');
    const [onebeHeaders, setOnebeHeaders] = useState(() => ({}));
    const [showCostEditor, setShowCostEditor] = useState(false);
    const [costColumns, setCostColumns] = useState([]);
    const [costRows, setCostRows] = useState([]);
    const [costTotal, setCostTotal] = useState(0);
    const [costOffset, setCostOffset] = useState(0);
    const [costQuery, setCostQuery] = useState('');
    const costLimit = 50;
    const [costEdits, setCostEdits] = useState({});
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

    const refreshState = async () => {
        try {
            const res = await fetch(`${API}/returns/state`, { headers: getAuthHeaders() });
            if (!res.ok) return;
            const data = await res.json();
            setStatus(data.status || null);
            setQueues(data.queues || { seller: [], customer: [], unmatched: [], all: [] });
            setOnebeRows(data.onebe?.rows || []);
            const nextType = data.last_type || '-';
            setLastType(nextType);
            const prevType = lastTypeRef.current;
            lastTypeRef.current = nextType;
            if (hasLoadedRef.current && nextType !== prevType) {
                const norm = String(nextType);
                if (norm.includes('판매자') || norm.toLowerCase().includes('seller')) playSound('seller');
                if (norm.includes('고객') || norm.toLowerCase().includes('customer')) playSound('customer');
                if (norm.includes('미매칭') || norm.toLowerCase().includes('unmatched')) playSound('unmatched');
            }
        } catch {
            // ignore
        } finally {
            hasLoadedRef.current = true;
        }
    };

    const getDownloadFilename = (res, fallback) => {
        const disposition = res.headers.get('content-disposition') || '';
        const match = disposition.match(/filename\*?=(?:UTF-8''|\"?)([^\";]+)/i);
        if (match?.[1]) {
            try {
                return decodeURIComponent(match[1].replace(/\"/g, ''));
            } catch {
                return match[1].replace(/\"/g, '');
            }
        }
        return fallback;
    };

    const handleCostBaseDownload = async () => {
        try {
            const res = await fetch(`${API}/returns/cost-base/download`, { headers: getAuthHeaders() });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data?.detail || '다운로드 실패');
            }
            const blob = await res.blob();
            const filename = getDownloadFilename(res, '원가베이스.xlsx');
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

    useEffect(() => {
        refreshState();
        setTimeout(() => scanRef.current?.focus(), 50);
    }, []);

    useEffect(() => {
        if (!soundsRef.current) {
            const pool = (src, size = 3) => Array.from({ length: size }, () => new Audio(src));
            soundsRef.current = {
                seller: pool('/sounds/bb.wav'),
                customer: pool('/sounds/zz.wav'),
                unmatched: pool('/sounds/dd.wav'),
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

    const playSound = (key) => {
        const pool = soundsRef.current?.[key];
        if (!pool || !pool.length) return;
        const idx = soundIndexRef.current[key] || 0;
        const audio = pool[idx % pool.length];
        soundIndexRef.current[key] = (idx + 1) % pool.length;
        audio.currentTime = 0;
        audio.play().catch(() => {});
    };

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

    const handleExcel2Change = async (file) => {
        if (!file) return;
        await handleUpload(file, '/returns/excel2', '에이블리 엑셀');
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
            setQueues(data.queues || queues);
            const nextType = data.last_type || '-';
            setLastType(nextType);
            const prevType = lastTypeRef.current;
            lastTypeRef.current = nextType;
            const shouldPlay = nextType !== '-' && nextType !== '';
            if (shouldPlay) {
                const norm = String(nextType);
                if (norm.includes('판매자') || norm.toLowerCase().includes('seller')) playSound('seller');
                if (norm.includes('고객') || norm.toLowerCase().includes('customer')) playSound('customer');
                if (norm.includes('미매칭') || norm.toLowerCase().includes('unmatched')) playSound('unmatched');
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
            setQueues(data.queues || queues);
            setLastType(data.last_type || '-');
        } catch (err) {
            setMessage(err.message || '삭제 실패');
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

    const handleBuildOnebe = async () => {
        const source = onebeRows.length ? 'all' : 'customer';
        try {
            const res = await fetch(`${API}/returns/onebe/build`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
                body: JSON.stringify({ source }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.detail || '원베양식 생성 실패');
            setOnebeRows(data.onebe?.rows || []);
            if (source === 'all') setMessage('전체 대기에서 다시 불러왔습니다.');
            setActiveTab('onebe');
        } catch (err) {
            setMessage(err.message || '원베양식 생성 실패');
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
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filenameFallback;
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
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        );
    };

    return (
        <div className={pageStyles.page}>
            <div className={pageStyles.pageHeader}>
                <div>
                    <h2 className={pageStyles.title}>반품</h2>
                    <p className={pageStyles.subtitle}>반품 송장 매칭 / 대기 / 추출 + 원베양식 생성</p>
                </div>
            </div>

            <div className={pageStyles.stack}>
                <section className={pageStyles.card}>
                    <div className={pageStyles.cardHeader}>
                        <h3 className={pageStyles.cardTitle}>엑셀 업로드</h3>
                        {loading && <span className={pageStyles.pill}>처리 중</span>}
                    </div>
                    <div className={pageStyles.uploadRow}>
                        <label className={pageStyles.fileInput}>
                            <input
                                type="file"
                                accept=".xls,.xlsx,.xlsm"
                                onChange={(e) => handleExcel1Change(e.target.files?.[0] ?? null)}
                            />
                            CJ 엑셀 선택
                        </label>
                        <label className={pageStyles.fileInput}>
                            <input
                                type="file"
                                accept=".xls,.xlsx,.xlsm"
                                onChange={(e) => handleExcel2Change(e.target.files?.[0] ?? null)}
                            />
                            에이블리 엑셀 선택
                        </label>
                    </div>
                    <div className={pageStyles.uploadRow}>
                        <button className={pageStyles.secondaryBtn} onClick={handleCostReload} disabled={loading}>
                            원가베이스 불러오기
                        </button>
                        {isAdmin && (
                            <label className={pageStyles.fileInput}>
                                <input
                                    type="file"
                                    accept=".xls,.xlsx,.xlsm"
                                    onChange={(e) =>
                                        handleUpload(e.target.files?.[0] ?? null, '/returns/cost-base/upload', '원가베이스')
                                    }
                                />
                                원가베이스 업로드
                            </label>
                        )}
                        {isAdmin && (
                            <button className={pageStyles.secondaryBtn} onClick={handleCostBaseDownload}>
                                원가베이스 편집본 다운로드
                            </button>
                        )}
                        <button className={pageStyles.secondaryBtn} onClick={openCostEditor}>
                            원가베이스 편집
                        </button>
                    </div>
                    {status && (
                        <div className={pageStyles.metaGrid}>
                            <div className={pageStyles.metaItem}>
                                <span className={pageStyles.metaLabel}>CJ 엑셀</span>
                                <strong className={pageStyles.metaValue}>
                                    {status.excel1_loaded ? 'O' : 'X'} ({status.map_count ?? 0})
                                </strong>
                            </div>
                            <div className={pageStyles.metaItem}>
                                <span className={pageStyles.metaLabel}>에이블리 엑셀</span>
                                <strong className={pageStyles.metaValue}>
                                    {status.excel2_loaded ? 'O' : 'X'} ({status.index_count ?? 0})
                                </strong>
                            </div>
                            <div className={pageStyles.metaItem}>
                                <span className={pageStyles.metaLabel}>원가베이스</span>
                                <strong className={pageStyles.metaValue}>
                                    {status.cost_loaded ? 'O' : 'X'} ({status.cost_count ?? 0})
                                </strong>
                            </div>
                        </div>
                    )}
                    {status?.cost_base_path && (
                        <div className={pageStyles.statusMsg}>
                            <strong>원가베이스 경로:</strong> {status.cost_base_path}
                            {status.cost_base_mtime ? ` (수정: ${status.cost_base_mtime})` : ''}
                        </div>
                    )}
                    {message && (
                        <div className={pageStyles.statusMsg}>
                            <strong>{message}</strong>
                        </div>
                    )}
                </section>

                <section className={pageStyles.card}>
                    <div className={pageStyles.cardHeader}>
                        <h3 className={pageStyles.cardTitle}>바코드 스캔</h3>
                        <div className={pageStyles.headerActions}>
                            <span className={pageStyles.pill}>최근 분류: {lastType}</span>
                            <button className={pageStyles.secondaryBtn} onClick={handleUndo}>
                                방금 찍은거 삭제
                            </button>
                        </div>
                    </div>
                    <div className={pageStyles.scanRow}>
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
                        <div className={pageStyles.uploadRow}>
                            <button className={pageStyles.primaryBtn} onClick={handleScan}>
                                매칭/대기
                            </button>
                            <button className={pageStyles.secondaryBtn} onClick={() => setScanText('')}>
                                입력칸 비우기
                            </button>
                        </div>
                    </div>
                </section>

                <section className={pageStyles.card}>
                    <div className={pageStyles.cardHeader}>
                        <h3 className={pageStyles.cardTitle}>대기/원베</h3>
                        <div className={pageStyles.tabRow}>
                            {[
                                ['all', '전체 대기'],
                                ['seller', '판매자 대기'],
                                ['customer', '고객 대기'],
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
                            {activeTab === 'customer' && renderTable(queues.customer)}
                            {activeTab === 'unmatched' && renderTable(queues.unmatched)}
                        </>
                    )}

                    {activeTab === 'onebe' && (
                        <div className={pageStyles.stack}>
                            <div className={pageStyles.uploadRow}>
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
                                    onClick={() =>
                                        handleDownload('/returns/download/onebe', `원베_고객대기_추출.${onebeFormat}`, {
                                            columns: selectedColumnList,
                                            format: onebeFormat,
                                            header_map: onebeHeaders,
                                        })
                                    }
                                >
                                    원베양식 저장
                                </button>
                            </div>
                            <div className={pageStyles.uploadRow}>
                                <span>파일 형식:</span>
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
                            <div className={pageStyles.checkboxRow}>
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
                        <h3 className={pageStyles.cardTitle}>(기존) 판매자/고객/미매칭 추출</h3>
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
                                handleDownload('/returns/download/queues', `반품대기_추출.${exportFormat}`, {
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
                                <button
                                    className={pageStyles.secondaryBtn}
                                    onClick={() => fetchCostPreview(0, costQuery)}
                                >
                                    검색
                                </button>
                                <button
                                    className={pageStyles.secondaryBtn}
                                    onClick={() => fetchCostPreview(costOffset, costQuery)}
                                >
                                    새로고침
                                </button>
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
        </div>
    );
};

export default ReturnsPage;
