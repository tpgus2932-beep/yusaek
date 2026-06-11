import React, { useState, useRef } from 'react';
import pageStyles from './BarcodePage.module.css';
import { COLLAB_API_BASE as API, getAuthHeaders } from '../../lib/api';
import { getDownloadFilename } from '../../lib/download';

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

const ProductUploadPage = () => {
    const [file, setFile] = useState(null);
    const [loading, setLoading] = useState(false);
    const [apiLoading, setApiLoading] = useState(false);
    const [status, setStatus] = useState(null); // { type: 'success'|'error', msg: string }
    const [dragging, setDragging] = useState(false);
    const inputRef = useRef(null);
    const [startDate, setStartDate] = useState(daysAgo(30));
    const [endDate, setEndDate] = useState(today());

    const handleFile = (f) => {
        if (!f) return;
        setFile(f);
        setStatus(null);
    };

    const handleDrop = (e) => {
        e.preventDefault();
        setDragging(false);
        const f = e.dataTransfer.files?.[0];
        if (f) handleFile(f);
    };

    const handleUpload = async () => {
        if (!file) {
            setStatus({ type: 'error', msg: '파일을 선택해 주세요.' });
            return;
        }
        setLoading(true);
        setStatus(null);
        try {
            const formData = new FormData();
            formData.append('file', file);
            const res = await fetch(`${API}/barcode/product/upload`, {
                method: 'POST',
                headers: getAuthHeaders(),
                body: formData,
            });
            if (!res.ok) {
                let msg = '업로드 실패';
                try {
                    const data = await res.json();
                    msg = data?.detail || msg;
                } catch {
                    const text = await res.text();
                    if (text) msg = text;
                }
                throw new Error(msg);
            }
            const blob = await res.blob();
            const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
            const filename = getDownloadFilename(res, `easyadmin_products_${stamp}.xls`);
            const normalizedFilename = filename.toLowerCase().endsWith('.xls')
                ? filename
                : `${filename.replace(/\.[^.]+$/, '')}.xls`;
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = normalizedFilename;
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
            setStatus({ type: 'success', msg: normalizedFilename });
            setFile(null);
        } catch (err) {
            setStatus({ type: 'error', msg: err.message || '업로드 실패' });
        } finally {
            setLoading(false);
        }
    };

    const handleApiDownload = async () => {
        setApiLoading(true);
        setStatus(null);
        try {
            const res = await fetch(`${API}/barcode/product/upload-from-api`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
                body: JSON.stringify({ start_date: startDate, end_date: endDate }),
            });
            if (!res.ok) {
                let msg = 'API 호출 실패';
                try { msg = (await res.json())?.detail || msg; } catch { /* ignore */ }
                throw new Error(msg);
            }
            const blob = await res.blob();
            const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
            const filename = getDownloadFilename(res, `easyadmin_products_${stamp}.xls`);
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = filename;
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
            setStatus({ type: 'success', msg: filename });
        } catch (err) {
            setStatus({ type: 'error', msg: err.message || 'API 호출 실패' });
        } finally {
            setApiLoading(false);
        }
    };

    const formatBytes = (bytes) => {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    };

    return (
        <div className={pageStyles.page}>
            <div className={pageStyles.pageHeader}>
                <div>
                    <h2 className={pageStyles.title}>상품 업로드</h2>
                    <p className={pageStyles.subtitle}>이지어드민 상품 업로드 엑셀 가공</p>
                </div>
            </div>

            <div className={pageStyles.stack}>
                {/* API 다운로드 */}
                <section className={pageStyles.card}>
                    <div className={pageStyles.cardHeader}>
                        <h3 className={pageStyles.cardTitle}>에이블리 API로 다운로드</h3>
                        {apiLoading && <span className={pageStyles.pill}>처리 중</span>}
                    </div>
                    <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
                        <label style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>등록일</label>
                        <input
                            type="date"
                            value={startDate}
                            onChange={(e) => setStartDate(e.target.value)}
                            className={pageStyles.searchInput}
                            style={{ width: 'auto' }}
                        />
                        <span style={{ color: 'var(--text-muted)' }}>~</span>
                        <input
                            type="date"
                            value={endDate}
                            onChange={(e) => setEndDate(e.target.value)}
                            className={pageStyles.searchInput}
                            style={{ width: 'auto' }}
                        />
                        <button
                            className={pageStyles.primaryBtn}
                            onClick={handleApiDownload}
                            disabled={apiLoading}
                        >
                            {apiLoading ? '처리 중...' : 'API로 다운로드'}
                        </button>
                    </div>
                </section>

                {/* 드래그앤드롭 업로드 영역 */}
                <section className={pageStyles.card}>
                    <div className={pageStyles.cardHeader}>
                        <h3 className={pageStyles.cardTitle}>파일 업로드</h3>
                        {loading && <span className={pageStyles.pill}>처리 중</span>}
                    </div>

                    <div
                        className={`${pageStyles.dropZone} ${dragging ? pageStyles.dropZoneActive : ''}`}
                        style={{ padding: '2.5rem 1.5rem', cursor: 'pointer', textAlign: 'center' }}
                        onClick={() => inputRef.current?.click()}
                        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                        onDragLeave={() => setDragging(false)}
                        onDrop={handleDrop}
                    >
                        <input
                            ref={inputRef}
                            type="file"
                            accept=".xls,.xlsx,.csv"
                            style={{ display: 'none' }}
                            onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
                        />
                        <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>📂</div>
                        {file ? (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                                <span style={{ fontWeight: 700 }}>{file.name}</span>
                                <span className={pageStyles.dropHint}>{formatBytes(file.size)}</span>
                            </div>
                        ) : (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                                <span style={{ fontWeight: 600 }}>파일을 끌어다 놓거나 클릭해서 선택</span>
                                <span className={pageStyles.dropHint}>.xls · .xlsx · .csv 지원</span>
                            </div>
                        )}
                    </div>

                    <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                        <button
                            className={pageStyles.primaryBtn}
                            onClick={handleUpload}
                            disabled={loading || !file}
                            style={{ flex: '1 0 auto' }}
                        >
                            {loading ? '처리 중...' : '가공 시작'}
                        </button>
                        {file && (
                            <button
                                className={pageStyles.secondaryBtn}
                                onClick={() => { setFile(null); setStatus(null); }}
                                disabled={loading}
                            >
                                취소
                            </button>
                        )}
                    </div>

                    {/* 결과 상태 */}
                    {status && (
                        <div
                            className={pageStyles.statusMsg}
                            style={{
                                borderColor: status.type === 'success' ? 'rgba(34,197,94,0.4)' : 'rgba(220,53,69,0.4)',
                                backgroundColor: status.type === 'success' ? 'rgba(34,197,94,0.07)' : 'rgba(220,53,69,0.07)',
                            }}
                        >
                            <span style={{ marginRight: '0.4rem' }}>
                                {status.type === 'success' ? '✅' : '⚠️'}
                            </span>
                            <strong>
                                {status.type === 'success' ? `다운로드 완료: ${status.msg}` : status.msg}
                            </strong>
                        </div>
                    )}
                </section>

                {/* 처리 흐름 */}
                <section className={pageStyles.card}>
                    <h3 className={pageStyles.cardTitle}>처리 흐름</h3>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                        {['원본 파일 선택', '열 구조 가공', '이지어드민 XLS 다운로드'].map((step, i, arr) => (
                            <React.Fragment key={step}>
                                <div style={{
                                    display: 'flex', alignItems: 'center', gap: '0.5rem',
                                    padding: '0.5rem 0.9rem',
                                    borderRadius: '999px',
                                    border: '1px solid var(--border-color)',
                                    background: 'var(--bg-secondary)',
                                    fontSize: '0.85rem',
                                    fontWeight: 600,
                                }}>
                                    <span style={{
                                        width: '1.4rem', height: '1.4rem',
                                        background: 'var(--accent-black)',
                                        color: 'var(--accent-white)',
                                        borderRadius: '50%',
                                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                                        fontSize: '0.7rem', fontWeight: 700, flexShrink: 0,
                                    }}>{i + 1}</span>
                                    {step}
                                </div>
                                {i < arr.length - 1 && (
                                    <span style={{ color: 'var(--text-muted)', fontWeight: 700 }}>→</span>
                                )}
                            </React.Fragment>
                        ))}
                    </div>
                </section>

                {/* 지원 형식 */}
                <section className={pageStyles.card}>
                    <h3 className={pageStyles.cardTitle}>지원 형식</h3>
                    <div className={pageStyles.metaGrid}>
                        {[
                            { ext: '.xlsx', desc: 'Excel 2007+', icon: '📗' },
                            { ext: '.xls', desc: 'Excel 97-2003', icon: '📘' },
                            { ext: '.csv', desc: 'CSV (UTF-8 / CP949)', icon: '📄' },
                        ].map(({ ext, desc, icon }) => (
                            <div key={ext} className={pageStyles.metaItem}>
                                <span style={{ fontSize: '1.4rem' }}>{icon}</span>
                                <span className={pageStyles.metaLabel}>{desc}</span>
                                <span className={pageStyles.metaValue}>{ext}</span>
                            </div>
                        ))}
                    </div>
                </section>
            </div>
        </div>
    );
};

export default ProductUploadPage;
