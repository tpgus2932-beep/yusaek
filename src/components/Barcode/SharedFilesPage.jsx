import React, { useEffect, useMemo, useState } from 'react';
import pageStyles from './BarcodePage.module.css';
import { COLLAB_API_BASE as API, getAuthHeaders } from '../../lib/api';

const SharedFilesPage = () => {
    const [files, setFiles] = useState([]);
    const [loading, setLoading] = useState(false);
    const [message, setMessage] = useState('');
    const [list, setList] = useState([]);
    const [loadingList, setLoadingList] = useState(false);
    const [isDragging, setIsDragging] = useState(false);
    const isAdmin = useMemo(() => localStorage.getItem('isAdmin') === 'true', []);

    const getDownloadUrl = (item) => {
        const token = localStorage.getItem('token');
        const suffix = token ? `?token=${encodeURIComponent(token)}` : '';
        return `${API}${item.url}${suffix}`;
    };

    const formatFileSize = (bytes) => {
        if (!bytes && bytes !== 0) return '';
        if (bytes < 1024) return `${bytes}B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
    };

    const formatDateTime = (value) => {
        if (!value) return '';
        const hasTz = /[zZ]|[+-]\d{2}:?\d{2}$/.test(value);
        const iso = hasTz ? value : `${value}Z`;
        const date = new Date(iso);
        if (Number.isNaN(date.getTime())) return '';
        return date.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
    };

    const fetchList = async () => {
        try {
            setLoadingList(true);
            const res = await fetch(`${API}/shared-files`, { headers: getAuthHeaders() });
            if (!res.ok) throw new Error('목록 불러오기 실패');
            const data = await res.json().catch(() => ({}));
            setList(data.files || []);
        } catch (err) {
            setMessage(err.message || '목록 불러오기 실패');
        } finally {
            setLoadingList(false);
        }
    };

    const handleUpload = async () => {
        if (!files.length) {
            setMessage('파일을 선택해 주세요.');
            return;
        }
        setLoading(true);
        setMessage('');
        let successCount = 0;
        const errors = [];
        try {
            for (const f of files) {
                try {
                    const formData = new FormData();
                    formData.append('file', f);
                    const res = await fetch(`${API}/shared-files`, {
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
                        errors.push(`${f.name}: ${msg}`);
                    } else {
                        successCount++;
                    }
                } catch (err) {
                    errors.push(`${f.name}: ${err.message || '업로드 실패'}`);
                }
            }
            if (errors.length) {
                setMessage(`${successCount}개 완료, 실패: ${errors.join(' / ')}`);
            } else {
                setMessage(`${successCount}개 업로드 완료`);
            }
            setFiles([]);
            await fetchList();
        } finally {
            setLoading(false);
        }
    };

    const handleDrop = (e) => {
        e.preventDefault();
        setIsDragging(false);
        const dropped = Array.from(e.dataTransfer?.files || []);
        if (!dropped.length) return;
        const valid = dropped.filter((f) => {
            const name = (f.name || '').toLowerCase();
            return name.endsWith('.xls') || name.endsWith('.xlsx') || name.endsWith('.csv');
        });
        const invalid = dropped.length - valid.length;
        if (!valid.length) {
            setMessage('xls/xlsx/csv만 업로드 가능합니다.');
            return;
        }
        setFiles(valid);
        setMessage(`${valid.length}개 선택됨${invalid ? ` (${invalid}개 형식 오류 제외)` : ''}`);
    };

    const handleDelete = async (id) => {
        if (!window.confirm('이 파일을 삭제할까요?')) return;
        try {
            const res = await fetch(`${API}/shared-files/${id}`, {
                method: 'DELETE',
                headers: getAuthHeaders(),
            });
            if (!res.ok) throw new Error('삭제 실패');
            await fetchList();
        } catch (err) {
            setMessage(err.message || '삭제 실패');
        }
    };

    useEffect(() => {
        fetchList();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
        <div className={pageStyles.page}>
            <div className={pageStyles.pageHeader}>
                <div>
                    <h2 className={pageStyles.title}>유색 공용 파일</h2>
                    <p className={pageStyles.subtitle}>팀 공용 엑셀/CSV 파일 업로드</p>
                </div>
            </div>
            <div className={pageStyles.stack}>
                <section className={pageStyles.card}>
                    <div className={pageStyles.cardHeader}>
                        <h3 className={pageStyles.cardTitle}>파일 업로드</h3>
                        {loading && <span className={pageStyles.pill}>업로드 중</span>}
                    </div>
                    <div
                        className={`${pageStyles.dropZone} ${isDragging ? pageStyles.dropZoneActive : ''}`}
                        onDragOver={(e) => {
                            e.preventDefault();
                            setIsDragging(true);
                        }}
                        onDragLeave={() => setIsDragging(false)}
                        onDrop={handleDrop}
                    >
                        <div className={pageStyles.uploadRow}>
                            <label className={pageStyles.fileInput}>
                                <input
                                    type="file"
                                    accept=".xls,.xlsx,.csv"
                                    multiple
                                    onChange={(e) => setFiles(Array.from(e.target.files || []))}
                                />
                                {files.length > 0 ? `${files.length}개 선택됨` : '파일 선택 (다중 가능)'}
                            </label>
                            <button
                                className={pageStyles.primaryBtn}
                                onClick={handleUpload}
                                disabled={loading}
                            >
                                {loading ? '업로드 중...' : '업로드'}
                            </button>
                        </div>
                        {files.length > 0 && (
                            <div className={pageStyles.dropHint}>
                                {files.map((f) => f.name).join(', ')}
                            </div>
                        )}
                        <div className={pageStyles.dropHint}>여기에 드래그&드롭 (다중 가능)</div>
                    </div>
                    {message && (
                        <div className={pageStyles.statusMsg}>
                            <strong>{message}</strong>
                        </div>
                    )}
                </section>

                <section className={pageStyles.card}>
                    <div className={pageStyles.cardHeader}>
                        <h3 className={pageStyles.cardTitle}>업로드된 파일</h3>
                    </div>
                    {loadingList && <div className={pageStyles.empty}>불러오는 중...</div>}
                    {!loadingList && list.length === 0 && (
                        <div className={pageStyles.empty}>등록된 파일이 없습니다.</div>
                    )}
                    {!loadingList && list.length > 0 && (
                        <div className={pageStyles.sharedList}>
                            {list.map((item) => (
                                <div key={item.id} className={pageStyles.sharedItem}>
                                    <div className={pageStyles.sharedMeta}>
                                        <a
                                            className={pageStyles.sharedName}
                                            href={getDownloadUrl(item)}
                                            download
                                            target="_blank"
                                            rel="noreferrer"
                                        >
                                            {item.filename}
                                        </a>
                                        <div className={pageStyles.sharedSub}>
                                            {formatFileSize(item.size)} ·{' '}
                                            {item.uploader_display || item.uploader_username}
                                            {formatDateTime(item.created_at)
                                                ? ` · ${formatDateTime(item.created_at)}`
                                                : ''}
                                        </div>
                                    </div>
                                    <div className={pageStyles.sharedActions}>
                                        <a
                                            className={pageStyles.secondaryBtn}
                                            href={getDownloadUrl(item)}
                                            download
                                            target="_blank"
                                            rel="noreferrer"
                                        >
                                            다운로드
                                        </a>
                                        {isAdmin && (
                                            <button
                                                className={pageStyles.secondaryBtn}
                                                onClick={() => handleDelete(item.id)}
                                            >
                                                삭제
                                            </button>
                                        )}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </section>
            </div>
        </div>
    );
};

export default SharedFilesPage;
