import React, { useState } from 'react';
import styles from '../Layout/Layout.module.css';
import pageStyles from './BarcodePage.module.css';

const ProductUploadPage = () => {
    const API = `http://${window.location.hostname}:8000`;
    const [file, setFile] = useState(null);
    const [loading, setLoading] = useState(false);
    const [message, setMessage] = useState('');

    const getAuthHeaders = () => {
        const token = localStorage.getItem('token');
        return token ? { Authorization: `Bearer ${token}` } : {};
    };

    const getDownloadFilename = (res) => {
        const disposition = res.headers.get('content-disposition') || '';
        const match = disposition.match(/filename\\*?=(?:UTF-8''|\"?)([^\";]+)/i);
        if (match?.[1]) {
            return decodeURIComponent(match[1].replace(/\"/g, ''));
        }
        const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
        return `easyadmin_products_${stamp}.xls`;
    };

    const handleUpload = async () => {
        if (!file) {
            setMessage('파일을 선택해 주세요.');
            return;
        }
        setLoading(true);
        setMessage('');
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
            const filename = getDownloadFilename(res);
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = filename;
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
            setMessage(`완료: ${filename}`);
        } catch (err) {
            setMessage(err.message || '업로드 실패');
        } finally {
            setLoading(false);
        }
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
                <section className={pageStyles.card}>
                    <div className={pageStyles.cardHeader}>
                        <h3 className={pageStyles.cardTitle}>엑셀/CSV 업로드</h3>
                        {loading && <span className={pageStyles.pill}>처리 중</span>}
                    </div>
                    <div className={pageStyles.uploadRow}>
                        <label className={pageStyles.fileInput}>
                            <input
                                type="file"
                                accept=".xls,.xlsx,.csv"
                                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                            />
                            파일 선택
                        </label>
                        <button
                            className={pageStyles.primaryBtn}
                            onClick={handleUpload}
                            disabled={loading}
                        >
                            {loading ? '처리 중...' : '가공 시작'}
                        </button>
                    </div>
                    {message && (
                        <div className={pageStyles.statusMsg}>
                            <strong>{message}</strong>
                        </div>
                    )}
                    <div className={pageStyles.cardTitle}>가공 규칙</div>
                    <div className={pageStyles.infoStack}>
                        <div className={pageStyles.infoItem}>
                            <span className={pageStyles.infoLabel}>A</span>
                            <span className={pageStyles.infoValue}>원본 C열 (대괄호 제거)</span>
                        </div>
                        <div className={pageStyles.infoItem}>
                            <span className={pageStyles.infoLabel}>B</span>
                            <span className={pageStyles.infoValue}>유색 고정</span>
                        </div>
                        <div className={pageStyles.infoItem}>
                            <span className={pageStyles.infoLabel}>C/H</span>
                            <span className={pageStyles.infoValue}>원본 B열 공백 분리</span>
                        </div>
                        <div className={pageStyles.infoItem}>
                            <span className={pageStyles.infoLabel}>L/M/N</span>
                            <span className={pageStyles.infoValue}>원본 L열 쉼표 분할</span>
                        </div>
                        <div className={pageStyles.infoItem}>
                            <span className={pageStyles.infoLabel}>O</span>
                            <span className={pageStyles.infoValue}>1 고정</span>
                        </div>
                        <div className={pageStyles.infoItem}>
                            <span className={pageStyles.infoLabel}>BG</span>
                            <span className={pageStyles.infoValue}>원본 H열</span>
                        </div>
                    </div>
                </section>
            </div>
        </div>
    );
};

export default ProductUploadPage;
