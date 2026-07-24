import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import JsBarcode from 'jsbarcode';
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
    const [isLoadingAllApis, setIsLoadingAllApis] = useState(false);
    const [isResolvingEzadmin, setIsResolvingEzadmin] = useState(false);
    const [isExecutingChangeProduct, setIsExecutingChangeProduct] = useState(false);
    const [isResolvingEzadminSeller, setIsResolvingEzadminSeller] = useState(false);
    const [isExecutingChangeProductSeller, setIsExecutingChangeProductSeller] = useState(false);
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
    const [selectedCustomer, setSelectedCustomer] = useState(new Set());
    const [selectedAll, setSelectedAll] = useState(new Set());
    const [selectedSeller, setSelectedSeller] = useState(new Set());
    const [selectedUnmatched, setSelectedUnmatched] = useState(new Set());
    const [selectedExchangeSeller, setSelectedExchangeSeller] = useState(new Set());
    const [selectedExchangeCustomer, setSelectedExchangeCustomer] = useState(new Set());
    const [deleteLoading, setDeleteLoading] = useState(false);
    const [csLookupLoading, setCsLookupLoading] = useState(false);
    const [csDetailModal, setCsDetailModal] = useState(null);
    const [zoomImage, setZoomImage] = useState(null);
    const [refundLoading, setRefundLoading] = useState(false);
    const [refundResults, setRefundResults] = useState(null);
    const [reasonChangeLoading, setReasonChangeLoading] = useState(false);
    const [reasonChangeResults, setReasonChangeResults] = useState(null);
    const [stockinLoading, setStockinLoading] = useState(false);
    const [stockinResults, setStockinResults] = useState(null);
    const [kimsungilSendLoading, setKimsungilSendLoading] = useState(false);
    const [regatherExecuteLoading, setRegatherExecuteLoading] = useState(false);
    const [regatherItems, setRegatherItems] = useState([]);
    const [regatherLoading, setRegatherLoading] = useState(false);
    const [labelPrintLoading, setLabelPrintLoading] = useState(false);
    const [singleCancelSno, setSingleCancelSno] = useState('');
    const [singleRefundLoading, setSingleRefundLoading] = useState(false);
    const [singleRefundResult, setSingleRefundResult] = useState(null);
    const [singleItemSno, setSingleItemSno] = useState('');
    const [singleItemLoading, setSingleItemLoading] = useState(false);
    const [singleItemResult, setSingleItemResult] = useState(null);
    const [excelRefundLoading, setExcelRefundLoading] = useState(false);
    const [excelRefundResults, setExcelRefundResults] = useState(null);
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

    const exchangeCustomerSelectedReady = useMemo(
        () => queues.exchange_customer.some((item) =>
            selectedExchangeCustomer.has(item.id) &&
            !item.change_product_done &&
            item.ezadmin_seq && item.ezadmin_prd_seq && item.old_product_id && item.new_product_id && !item.ezadmin_error
        ),
        [queues.exchange_customer, selectedExchangeCustomer]
    );

    const exchangeSellerSelectedReady = useMemo(
        () => queues.exchange_seller.some((item) =>
            selectedExchangeSeller.has(item.id) &&
            !item.change_product_done &&
            item.ezadmin_seq && item.ezadmin_prd_seq && item.old_product_id && item.new_product_id && !item.ezadmin_error
        ),
        [queues.exchange_seller, selectedExchangeSeller]
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
        if (activeTab === 'regather') fetchRegatherItems();
    }, [activeTab]);

    useEffect(() => {
        if (!soundsRef.current) {
            const pool = (src, size = 3) => Array.from({ length: size }, () => new Audio(src));
            soundsRef.current = {
                seller: pool('/sounds/bb.wav'),
                customer: pool('/sounds/zz.wav'),
                unmatched: pool('/sounds/dd.wav'),
                exchangeDefect: pool('/sounds/ww.wav'),
                exchangeNormal: pool('/sounds/tt.wav'),
                relatedNotice: pool('/sounds/ice.wav'),
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

    const fetchLotteFromApi = async () => {
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
        return `롯데 ${data.map_count}건 매핑`;
    };

    const handleExcel2Change = async (file) => {
        if (!file) return;
        await handleUpload(file, '/returns/excel2', '에이블리 엑셀');
    };

    const fetchAblyReturnApi = async () => {
        const res = await fetch(`${API}/returns/load-ably-api`, {
            method: 'POST',
            headers: getAuthHeaders(),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.detail || '에이블리 API 호출 실패');
        if (data.status) setStatus(data.status);
        return `반품 ${data.loaded}건 로드`;
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

    const handleAblyRefundSubmit = async (selectedItems) => {
        if (!selectedItems || !selectedItems.length) return;
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
            if (data?.queues) setQueues(normalizeQueues(data.queues));
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

    const [reasonChangeModalOpen, setReasonChangeModalOpen] = useState(false);
    const [reasonChangeTemplates, setReasonChangeTemplates] = useState([]);
    const [reasonChangeTemplatesLoading, setReasonChangeTemplatesLoading] = useState(false);
    const [reasonChangeSelectedTemplateId, setReasonChangeSelectedTemplateId] = useState('');
    const [reasonChangePendingItems, setReasonChangePendingItems] = useState([]);
    const [reasonChangeConfirmLoading, setReasonChangeConfirmLoading] = useState(false);

    const openReasonChangeTemplateModal = async (selectedItems) => {
        if (!selectedItems || !selectedItems.length) return;
        setReasonChangePendingItems(selectedItems);
        setReasonChangeModalOpen(true);
        setReasonChangeSelectedTemplateId('');
        setReasonChangeTemplatesLoading(true);
        try {
            const res = await fetch(`${API}/sms/templates`, { headers: getAuthHeaders() });
            const data = await res.json().catch(() => ({}));
            const list = Array.isArray(data?.templates) ? data.templates : [];
            setReasonChangeTemplates(list);
            if (list.length) setReasonChangeSelectedTemplateId(list[0].id);
        } catch {
            setReasonChangeTemplates([]);
        } finally {
            setReasonChangeTemplatesLoading(false);
        }
    };

    const closeReasonChangeTemplateModal = () => {
        setReasonChangeModalOpen(false);
        setReasonChangePendingItems([]);
        setReasonChangeSelectedTemplateId('');
    };

    const handleConfirmReasonChangeWithSms = async () => {
        const template = reasonChangeTemplates.find((t) => t.id === reasonChangeSelectedTemplateId);
        if (!template) {
            setMessage('템플릿을 선택하세요.');
            return;
        }
        const items = reasonChangePendingItems;
        setReasonChangeConfirmLoading(true);
        setMessage('');
        try {
            setReasonChangeLoading(true);
            setReasonChangeResults(null);
            const res = await fetch(`${API}/returns/ably-change-reason-submit`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
                body: JSON.stringify({ items }),
            });
            const data = await res.json().catch(() => ({}));
            if (data?.queues) setQueues(normalizeQueues(data.queues));
            if (!res.ok) throw new Error(data?.detail || '사유변경 처리 실패');
            setReasonChangeResults(data.results);
            const reasonOk = data.results.filter((r) => r.ok).length;

            let smsOk = 0;
            let smsSkipped = 0;
            let sessionExpired = false;
            for (const item of items) {
                const phone = (item.buyer_tel || '').trim();
                if (!phone) {
                    smsSkipped += 1;
                    continue;
                }
                try {
                    const smsRes = await fetch(`${API}/return-automation/reply-sms`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
                        body: JSON.stringify({ phone, msg: template.msg }),
                    });
                    const smsData = await smsRes.json().catch(() => ({}));
                    if (smsData?.need_ezdesk_session) {
                        sessionExpired = true;
                        break;
                    }
                    if (smsRes.ok && smsData?.ok !== false) {
                        smsOk += 1;
                    }
                } catch {
                    // 개별 전송 실패는 무시하고 다음 건으로 진행 (실패 건수는 smsOk와의 차이로 드러남)
                }
            }

            const smsAttempted = items.length - smsSkipped;
            let summary = `일반사유 변경 완료: ${reasonOk}/${data.results.length}건 성공. 문자 전송: ${smsOk}/${smsAttempted}건 성공`;
            if (smsSkipped) summary += ` (전화번호 없음 ${smsSkipped}건 제외)`;
            if (sessionExpired) summary += ' — 이지데스크 세션이 만료되어 이후 발송은 중단했습니다. 테스트 > 자동화 대시보드에서 세션을 재설정해주세요.';
            setMessage(summary);
            closeReasonChangeTemplateModal();
        } catch (err) {
            setMessage(err.message || '일반사유 변경 실패');
        } finally {
            setReasonChangeLoading(false);
            setReasonChangeConfirmLoading(false);
        }
    };

    const [smsComposeItem, setSmsComposeItem] = useState(null);
    const [smsComposePhone, setSmsComposePhone] = useState('');
    const [smsComposeText, setSmsComposeText] = useState('');
    const [smsSendLoading, setSmsSendLoading] = useState(false);

    const openSmsCompose = (item) => {
        setSmsComposeItem(item);
        setSmsComposePhone(item.buyer_tel || '');
        setSmsComposeText('');
    };

    const closeSmsCompose = () => {
        setSmsComposeItem(null);
        setSmsComposePhone('');
        setSmsComposeText('');
    };

    const handleSendEzdeskSms = async () => {
        const phone = smsComposePhone.trim();
        const msg = smsComposeText.trim();
        if (!phone || !msg) {
            setMessage('전화번호와 문자 내용을 입력하세요.');
            return;
        }
        setSmsSendLoading(true);
        try {
            const res = await fetch(`${API}/return-automation/reply-sms`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
                body: JSON.stringify({ phone, msg }),
            });
            const data = await res.json().catch(() => ({}));
            if (data?.need_ezdesk_session) {
                setMessage('이지데스크 세션이 만료되었습니다. 테스트 > 자동화 대시보드에서 세션을 재설정해주세요.');
                return;
            }
            if (!res.ok || data?.ok === false) throw new Error(data?.detail || '문자 전송 실패');
            setMessage('이지데스크 문자 전송 완료');
            closeSmsCompose();
        } catch (err) {
            setMessage(err.message || '이지데스크 문자 전송 실패');
        } finally {
            setSmsSendLoading(false);
        }
    };

    const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));

    const buildBarcodeSvgMarkup = (text) => {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        try {
            JsBarcode(svg, String(text), {
                format: 'CODE128',
                width: 2.3,
                height: 40,
                displayValue: false,
                margin: 0,
            });
        } catch {
            return '';
        }
        return svg.outerHTML;
    };

    // 상품명 / [옵션] / 상품코드 바코드 라벨 인쇄 (image.png 레이아웃 참고)
    const printProductLabels = (labels) => {
        const valid = labels.filter((l) => l.code);
        if (!valid.length) return;
        const cardsHtml = valid.map((l) => `
            <div class="card">
                <div class="title">${escapeHtml(l.title)}</div>
                ${l.option ? `<div class="option">${escapeHtml(l.option)}</div>` : ''}
                <div class="barcode">${buildBarcodeSvgMarkup(l.code)}</div>
            </div>
        `).join('\n');

        const win = window.open('', '_blank', 'width=900,height=700');
        win.document.write(`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<title>바코드 인쇄</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
@page { size: 40mm 30mm; margin: 0; }
body { background: #fff; font-family: sans-serif; }
.card {
  width: 40mm; height: 30mm;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  text-align: center; overflow: hidden; padding: 1.5mm;
  page-break-after: always; break-after: page;
}
.card:last-child { page-break-after: auto; break-after: auto; }
.title { font-size: 9pt; font-weight: 700; line-height: 1.2; color: #111; }
.option { font-size: 8pt; margin-top: 0.8mm; color: #111; }
.barcode { margin-top: 1.5mm; width: 100%; }
.barcode svg { width: 100%; height: 8mm; display: block; }
</style>
</head>
<body>${cardsHtml}</body>
</html>`);
        win.document.close();
        win.focus();
        setTimeout(() => { win.print(); win.close(); }, 600);
    };

    const handleEzadminReceiveStock = async (selectedItems) => {
        if (!selectedItems || !selectedItems.length) return;
        setStockinLoading(true);
        setStockinResults(null);
        setMessage('');
        try {
            const res = await fetch(`${API}/returns/ezadmin-receive-stock`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
                body: JSON.stringify({ items: selectedItems }),
            });
            const data = await res.json().catch(() => ({}));
            if (data?.queues) setQueues(normalizeQueues(data.queues));
            if (data?.need_session) {
                openEzadminModal(() => handleEzadminReceiveStock(selectedItems));
                return;
            }
            if (!res.ok || !data?.ok) throw new Error(data?.detail || '처리 실패');
            setStockinResults(data.results);
            const okResults = data.results.filter((r) => r.ok);
            setMessage(`이지어드민 입고처리 완료: ${okResults.length}/${data.results.length}건 성공`);
            const labels = okResults.map((r) => {
                const src = selectedItems.find((i) => i.id === r.id);
                return {
                    title: src?.goods_name || src?.item_text || '',
                    option: src?.option_raw ? `[${src.option_raw.replace(/\//g, '-')}]` : '',
                    code: r.product_id || '',
                };
            });
            printProductLabels(labels);
        } catch (err) {
            setMessage(err.message || '이지어드민 입고처리 실패');
        } finally {
            setStockinLoading(false);
        }
    };

    // 이미 입고처리로 상품코드가 확인된 건은 그 값을 그대로 쓰고, 아직 안 된
    // 건만 원가베이스유 매칭을 새로 요청한다 (재고 변경 없이 상품코드만 조회).
    const resolveProductCodes = async (selectedItems) => {
        const needResolve = selectedItems.filter((i) => !i.ezadmin_stockin_product_id);
        const resolvedMap = {};
        if (needResolve.length) {
            const res = await fetch(`${API}/returns/resolve-product-codes`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
                body: JSON.stringify({ items: needResolve }),
            });
            const data = await res.json().catch(() => ({}));
            (data.results || []).forEach((r) => { resolvedMap[r.id] = r.product_id; });
        }
        const codeMap = {};
        selectedItems.forEach((i) => {
            codeMap[i.id] = i.ezadmin_stockin_product_id || resolvedMap[i.id] || null;
        });
        return codeMap;
    };

    const applyItemFlags = (flagsById) => {
        setQueues((prev) => {
            const next = { ...prev };
            for (const key of Object.keys(next)) {
                next[key] = next[key].map((item) => (
                    flagsById[item.id] ? { ...item, ...flagsById[item.id] } : item
                ));
            }
            return next;
        });
    };

    const handleSendToKimsungil = async (selectedItems) => {
        if (!selectedItems || !selectedItems.length) return;
        setKimsungilSendLoading(true);
        setMessage('');
        try {
            const codeMap = await resolveProductCodes(selectedItems);
            const entries = Object.entries(codeMap).filter(([, code]) => code);
            if (!entries.length) {
                setMessage('상품코드를 찾지 못해 김승일보내기를 할 수 없습니다.');
                return;
            }
            let sent = 0;
            const flagsById = {};
            for (const [idStr, code] of entries) {
                const id = Number(idStr);
                const res = await fetch(`${API}/barcode/kimsungil/add`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
                    body: JSON.stringify({ code }),
                });
                if (res.ok) {
                    sent += 1;
                    flagsById[id] = { kimsungil_sent: true, kimsungil_error: undefined };
                } else {
                    const data = await res.json().catch(() => ({}));
                    flagsById[id] = { kimsungil_error: data?.detail || '전송 실패' };
                }
            }
            applyItemFlags(flagsById);
            setMessage(`김승일보내기 완료: ${sent}/${entries.length}건`);
        } catch (err) {
            setMessage(err.message || '김승일보내기 실패');
        } finally {
            setKimsungilSendLoading(false);
        }
    };

    const fetchRegatherItems = async () => {
        setRegatherLoading(true);
        try {
            const res = await fetch(`${API}/return-regathering/list`, { headers: getAuthHeaders() });
            const data = await res.json().catch(() => ({}));
            setRegatherItems(Array.isArray(data?.items) ? data.items : []);
        } catch {
            setRegatherItems([]);
        } finally {
            setRegatherLoading(false);
        }
    };

    const handleCompleteRegather = async (id) => {
        try {
            const res = await fetch(`${API}/return-regathering/${id}/complete`, {
                method: 'POST',
                headers: getAuthHeaders(),
            });
            if (!res.ok) throw new Error('완료처리 실패');
            setRegatherItems((prev) => prev.filter((r) => r.id !== id));
        } catch (err) {
            setMessage(err.message || '완료처리 실패');
        }
    };

    const handleRegatherExecute = async (selectedItems) => {
        if (!selectedItems || !selectedItems.length) return;
        setRegatherExecuteLoading(true);
        setMessage('');
        try {
            const res = await fetch(`${API}/return-regathering/execute`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
                body: JSON.stringify({ items: selectedItems }),
            });
            const data = await res.json().catch(() => ({}));
            if (data?.need_session) {
                openEzadminModal(() => handleRegatherExecute(selectedItems));
                return;
            }
            if (data?.queues) setQueues(normalizeQueues(data.queues));
            if (!res.ok) throw new Error(data?.detail || '오회수 처리 실패');
            const ok = (data.results || []).filter((r) => r.ok).length;
            let msg = `오회수 처리 완료: ${ok}/${data.results.length}건 성공`;
            if (data.need_ezdesk_session) msg += ' — 이지데스크 세션이 만료되어 중단했습니다. 테스트 > 자동화 대시보드에서 세션을 재설정해주세요.';
            setMessage(msg);
            fetchRegatherItems();
        } catch (err) {
            setMessage(err.message || '오회수 처리 실패');
        } finally {
            setRegatherExecuteLoading(false);
        }
    };

    const handlePrintBarcodesOnly = async (selectedItems) => {
        if (!selectedItems || !selectedItems.length) return;
        setLabelPrintLoading(true);
        setMessage('');
        try {
            const codeMap = await resolveProductCodes(selectedItems);
            const labels = selectedItems
                .map((i) => ({
                    title: i.goods_name || i.item_text || '',
                    option: i.option_raw ? `[${i.option_raw.replace(/\//g, '-')}]` : '',
                    code: codeMap[i.id] || '',
                }))
                .filter((l) => l.code);
            if (!labels.length) {
                setMessage('상품코드를 찾지 못해 바코드를 출력할 수 없습니다.');
                return;
            }
            printProductLabels(labels);
            setMessage(`바코드 출력: ${labels.length}건`);
        } catch (err) {
            setMessage(err.message || '바코드 출력 실패');
        } finally {
            setLabelPrintLoading(false);
        }
    };

    const fetchExchangeApi = async () => {
        const res = await fetch(`${API}/returns/load-exchange-api`, {
            method: 'POST',
            headers: getAuthHeaders(),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.detail || '교환 API 호출 실패');
        if (data.status) setStatus(data.status);
        return `교환 ${data.loaded}건 로드`;
    };

    const handleLoadAllApis = async () => {
        setIsLoadingAllApis(true);
        setMessage('');
        const results = [];
        for (const [label, fetchFn] of [
            ['롯데', fetchLotteFromApi],
            ['반품', fetchAblyReturnApi],
            ['교환', fetchExchangeApi],
        ]) {
            try {
                results.push(await fetchFn());
            } catch (err) {
                results.push(`${label} 실패: ${err.message || '불러오기 실패'}`);
            }
        }
        setIsLoadingAllApis(false);
        setMessage(results.join(' / '));
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

    const handleResolveExchangeEzadmin = async (queue = 'customer') => {
        const setLoading = queue === 'seller' ? setIsResolvingEzadminSeller : setIsResolvingEzadmin;
        setLoading(true);
        setMessage('');
        try {
            const res = await fetch(`${API}/returns/exchange-customer/resolve-ezadmin?queue=${queue}`, {
                method: 'POST',
                headers: getAuthHeaders(),
            });
            const data = await res.json().catch(() => ({}));
            if (data?.need_session) {
                openEzadminModal(() => handleResolveExchangeEzadmin(queue));
                return;
            }
            if (!res.ok || !data?.ok) throw new Error(data?.detail || '이지어드민 조회 실패');
            setQueues(normalizeQueues(data.queues));
            setMessage(`이지어드민 정보 ${data.resolved}건 조회 완료`);
        } catch (err) {
            setMessage(err.message || '이지어드민 조회 실패');
        } finally {
            setLoading(false);
        }
    };

    const handleExecuteExchangeChangeProduct = async (queue = 'customer', ids = []) => {
        if (!ids.length) { setMessage('선택된 항목이 없습니다.'); return; }
        if (!window.confirm('이지어드민에서 실제로 상품 교환처리를 실행할까요? 되돌리기 어려운 작업입니다.')) return;
        const setLoading = queue === 'seller' ? setIsExecutingChangeProductSeller : setIsExecutingChangeProduct;
        setLoading(true);
        setMessage('');
        try {
            const res = await fetch(`${API}/returns/exchange-customer/execute-change-product?queue=${queue}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
                body: JSON.stringify({ ids }),
            });
            const data = await res.json().catch(() => ({}));
            if (data?.need_session) {
                openEzadminModal(() => handleExecuteExchangeChangeProduct(queue, ids));
                return;
            }
            if (data?.queues) setQueues(normalizeQueues(data.queues));
            if (!res.ok || !data?.ok) throw new Error(data?.detail || '교환 실행 실패');
            const adv = data.ably_advanced || {};
            let msg = `이지어드민 교환처리 ${data.executed}건 완료 · 에이블리 수거완료 ${adv.received || 0}건, 교환상품준비중 ${adv.prepared || 0}건`;
            if (data.ably_error) msg += ` (${data.ably_error})`;
            setMessage(msg);
        } catch (err) {
            setMessage(err.message || '교환 실행 실패');
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

    const scanBarcode = async (value) => {
        const res = await fetch(`${API}/returns/scan`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
            body: JSON.stringify({ barcode: value }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.detail || '스캔 실패');
        return data;
    };

    const deleteReturnItems = async (ids) => {
        const res = await fetch(`${API}/returns/delete-items`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
            body: JSON.stringify({ ids }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.detail || '삭제 실패');
        return data;
    };

    const addRelatedItem = async (source, invoice) => {
        const res = await fetch(`${API}/returns/scan-related`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
            body: JSON.stringify({ source, invoice }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.detail || '추가 실패');
        return data;
    };

    const maybeAddRelatedExchange = async (related) => {
        if (!related || related.length === 0) return;
        playSound('relatedNotice');
        const summary = related
            .map((r) => `- ${r.invoice} (${r.item_text || ''} x${r.qty || ''})`)
            .join('\n');
        const ok = window.confirm(
            `같은 주문번호의 다른 반품/교환건이 아직 큐에 없습니다. 지금 같이 추가할까요?\n${summary}`
        );
        if (!ok) return;
        for (const r of related) {
            try {
                const data = await addRelatedItem(r.source, r.invoice);
                setQueues(normalizeQueues(data.queues || queues));
            } catch (err) {
                setMessage(err.message || '추가 실패');
            }
        }
    };

    const handleScan = async () => {
        const value = scanText.trim();
        if (!value) return;
        unlockAudio();
        try {
            const data = await scanBarcode(value);
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
            await maybeAddRelatedExchange(data.related_unscanned);
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

    const handleDeleteSelected = async (selectedIds, setSelectedIds) => {
        const ids = Array.from(selectedIds);
        if (ids.length === 0) return;
        if (!window.confirm(`선택한 ${ids.length}개 항목을 삭제할까요?`)) return;
        setDeleteLoading(true);
        try {
            const data = await deleteReturnItems(ids);
            setQueues(normalizeQueues(data.queues));
            setSelectedIds(new Set());
        } catch (err) {
            setMessage(err.message || '삭제 실패');
        } finally {
            setDeleteLoading(false);
        }
    };

    const handleCsLookup = async (selectedIds) => {
        const ids = Array.from(selectedIds);
        if (ids.length === 0) return;
        setCsLookupLoading(true);
        setMessage('');
        try {
            const res = await fetch(`${API}/returns/unmatched/lookup-cs`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
                body: JSON.stringify({ ids }),
            });
            const data = await res.json().catch(() => ({}));
            if (data?.need_session) {
                openEzadminModal(() => handleCsLookup(selectedIds));
                return;
            }
            if (!res.ok || !data?.ok) throw new Error(data?.detail || 'CS 조회 실패');
            setQueues(normalizeQueues(data.queues));
            setMessage(`CS 조회 ${data.checked}건 완료`);
        } catch (err) {
            setMessage(err.message || 'CS 조회 실패');
        } finally {
            setCsLookupLoading(false);
        }
    };

    const handleUnmatchedReceiveStock = async (selectedIds) => {
        const ids = Array.from(selectedIds);
        if (ids.length === 0) return;
        if (!window.confirm(`선택한 ${ids.length}건을 이지어드민에 입고처리할까요? (먼저 "CS 조회"로 상품코드를 확인한 항목만 처리됩니다)`)) return;
        setStockinLoading(true);
        setMessage('');
        try {
            const res = await fetch(`${API}/returns/unmatched/receive-stock`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
                body: JSON.stringify({ ids }),
            });
            const data = await res.json().catch(() => ({}));
            if (data?.queues) setQueues(normalizeQueues(data.queues));
            if (data?.need_session) {
                openEzadminModal(() => handleUnmatchedReceiveStock(selectedIds));
                return;
            }
            if (!res.ok || !data?.ok) throw new Error(data?.detail || '입고처리 실패');
            const okCount = (data.results || []).filter((r) => r.ok).length;
            setMessage(`이지어드민 입고처리 완료: ${okCount}/${data.results.length}건 성공`);
        } catch (err) {
            setMessage(err.message || '입고처리 실패');
        } finally {
            setStockinLoading(false);
        }
    };

    // 미매칭 항목은 원가베이스유 매칭이 안 돼 resolveProductCodes를 못 쓰므로,
    // CS 조회(lookup-cs)가 이미 캐싱해둔 item.cs_products로 바로 라벨을 만든다.
    const handleUnmatchedPrintBarcodes = (selectedIds) => {
        const ids = Array.from(selectedIds);
        if (ids.length === 0) return;
        const items = queues.unmatched.filter((i) => ids.includes(i.id));
        const labels = items.flatMap((item) =>
            (item.cs_products || []).map((p) => {
                const optionRaw = [p.color, p.size].filter(Boolean).join('/');
                return {
                    title: p.name || p.product_id,
                    option: optionRaw ? `[${optionRaw.replace(/\//g, '-')}]` : '',
                    code: p.product_id,
                };
            })
        );
        if (!labels.length) {
            setMessage('상품코드를 찾지 못해 바코드를 출력할 수 없습니다. 먼저 "CS 조회"를 실행하세요.');
            return;
        }
        printProductLabels(labels);
        setMessage(`바코드 출력: ${labels.length}건`);
    };

    const openCsDetail = async (phone) => {
        setCsDetailModal({ phone, loading: true, rooms: [], error: '' });
        try {
            const res = await fetch(`${API}/returns/unmatched/cs-detail`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
                body: JSON.stringify({ phone }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data?.ok) throw new Error(data?.detail || 'CS 내용 조회 실패');
            setCsDetailModal({ phone, loading: false, rooms: data.rooms || [], error: '' });
        } catch (err) {
            setCsDetailModal({ phone, loading: false, rooms: [], error: err.message || 'CS 내용 조회 실패' });
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

    const handleResetOnebe = async () => {
        if (!window.confirm('원베양식(고객대기)을 초기화할까요?')) return;
        try {
            const res = await fetch(`${API}/returns/onebe/reset`, {
                method: 'POST',
                headers: getAuthHeaders(),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.detail || '초기화 실패');
            setOnebeRows(data.onebe?.rows || []);
        } catch (err) {
            setMessage(err.message || '초기화 실패');
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
            if (!res.ok) throw new Error(data?.detail || '생성 실패');

            const consolidateRes = await fetch(`${API}/returns/onebe/consolidate`, {
                method: 'POST',
                headers: getAuthHeaders(),
            });
            const consolidateData = await consolidateRes.json().catch(() => ({}));
            if (!consolidateRes.ok) throw new Error(consolidateData?.detail || '같은수량가공 실패');

            const rows = consolidateData.onebe?.rows || [];
            setOnebeRows(rows);
            setActiveTab('onebe');
            const unmatchedCount = rows.filter((row) => row['원가베이스매칭'] === 'X').length;
            if (unmatchedCount > 0) {
                setMessage(`⚠ 상품코드 미매칭 ${unmatchedCount}건 있습니다 (원가베이스매칭 컬럼 확인)`);
                setSelectedCols((prev) => ({ ...prev, 원가베이스매칭: true }));
            } else {
                setMessage('');
            }
        } catch (err) {
            setMessage(err.message || '생성 실패');
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

    const renderTable = (items, selectedIds, onToggleOne, onToggleAll, showSmsAction) => {
        if (!items || items.length === 0) {
            return <div className={pageStyles.empty}>데이터가 없습니다.</div>;
        }
        const hasReason = items.some((item) => item.reason);
        const hasDetailReason = items.some((item) => item.detail_reason);
        const hasUserComment = items.some((item) => item.user_comment);
        const hasImages = items.some((item) => item.images && item.images.length > 0);
        const hasRefundStatus = items.some((item) => item.ably_refund_done || item.ably_refund_error);
        const hasReasonChangeStatus = items.some((item) => item.ably_reason_changed || item.ably_reason_change_error);
        const hasKimsungilStatus = items.some((item) => item.kimsungil_sent || item.kimsungil_error);
        const hasStockinStatus = items.some((item) => item.ezadmin_stockin_done || item.ezadmin_stockin_error);
        const hasEzadminInfo = items.some((item) =>
            item.ezadmin_seq || item.old_product_id || item.new_product_id || item.ezadmin_error || item.change_product_done
        );
        const hasCsLookup = items.some((item) =>
            item.cs_phone !== undefined || item.cs_ably_exists !== undefined || item.cs_error
            || item.cs_products !== undefined || item.cs_product_error
        );
        const allChecked = items.length > 0 && items.every((item) => selectedIds.has(item.id));
        return (
            <div className={pageStyles.tableWrap}>
                <table className={pageStyles.table}>
                    <thead>
                        <tr>
                            <th style={{ width: '32px', textAlign: 'center' }}>
                                <input type="checkbox" checked={allChecked} onChange={onToggleAll} />
                            </th>
                            <th>스캔송장</th>
                            <th>요청메모</th>
                            <th>가공데이터</th>
                            <th>입고수량</th>
                            <th>분류</th>
                            {hasReason && <th>사유</th>}
                            {hasDetailReason && <th>상세사유</th>}
                            {hasUserComment && <th>고객메모</th>}
                            {hasImages && <th>사진</th>}
                            {hasRefundStatus && <th>환불처리</th>}
                            {hasReasonChangeStatus && <th>사유변경</th>}
                            {hasKimsungilStatus && <th>김승일</th>}
                            {hasStockinStatus && <th>입고처리</th>}
                            {hasEzadminInfo && <th>SEQ</th>}
                            {hasEzadminInfo && <th>PRD_SEQ</th>}
                            {hasEzadminInfo && <th>기존상품코드</th>}
                            {hasEzadminInfo && <th>교환상품코드</th>}
                            {hasEzadminInfo && <th>상태</th>}
                            {hasCsLookup && <th>구매자전화번호</th>}
                            {hasCsLookup && <th>상품코드</th>}
                            {hasCsLookup && <th>에이블리CS</th>}
                            {showSmsAction && <th>문자</th>}
                        </tr>
                    </thead>
                    <tbody>
                        {items.map((item) => (
                            <tr
                                key={item.id}
                                style={item.ably_refund_done
                                    ? { background: '#e5e7eb', color: '#9ca3af' }
                                    : (selectedIds.has(item.id) ? { background: 'var(--bg-secondary)' } : undefined)}
                            >
                                <td style={{ textAlign: 'center' }}>
                                    <input
                                        type="checkbox"
                                        checked={selectedIds.has(item.id)}
                                        onChange={() => onToggleOne(item.id)}
                                    />
                                </td>
                                <td>{item.scan}</td>
                                <td>{item.match}</td>
                                <td>{item.item_text}</td>
                                <td>{item.qty}</td>
                                <td>{item.type}</td>
                                {hasReason && <td>{item.reason || ''}</td>}
                                {hasDetailReason && <td>{item.detail_reason || ''}</td>}
                                {hasUserComment && <td>{item.user_comment || ''}</td>}
                                {hasImages && (
                                    <td>
                                        {(item.images || []).length === 0 ? '' : (
                                            <div style={{ display: 'flex', gap: 4 }}>
                                                {item.images.map((src, i) => (
                                                    <img
                                                        key={i}
                                                        src={src}
                                                        alt={`사진 ${i + 1}`}
                                                        style={{ width: 36, height: 36, objectFit: 'cover', borderRadius: 4, cursor: 'zoom-in' }}
                                                        onClick={() => setZoomImage(src)}
                                                    />
                                                ))}
                                            </div>
                                        )}
                                    </td>
                                )}
                                {hasRefundStatus && (
                                    <td style={{ color: item.ably_refund_error ? '#dc2626' : '#22c55e', fontWeight: item.ably_refund_done ? 600 : 400 }}>
                                        {item.ably_refund_done ? '✓ 완료' : item.ably_refund_error || ''}
                                    </td>
                                )}
                                {hasReasonChangeStatus && (
                                    <td style={{ color: item.ably_reason_change_error ? '#dc2626' : '#22c55e', fontWeight: item.ably_reason_changed ? 600 : 400 }}>
                                        {item.ably_reason_changed ? '✓ 완료' : item.ably_reason_change_error || ''}
                                    </td>
                                )}
                                {hasKimsungilStatus && (
                                    <td style={{ color: item.kimsungil_error ? '#dc2626' : '#22c55e', fontWeight: item.kimsungil_sent ? 600 : 400 }}>
                                        {item.kimsungil_sent ? '✓ 완료' : item.kimsungil_error || ''}
                                    </td>
                                )}
                                {hasStockinStatus && (
                                    <td style={{ color: item.ezadmin_stockin_error ? '#dc2626' : '#22c55e', fontWeight: item.ezadmin_stockin_done ? 600 : 400 }}>
                                        {item.ezadmin_stockin_done ? `✓ 완료 (${item.ezadmin_stockin_product_id || ''})` : item.ezadmin_stockin_error || ''}
                                    </td>
                                )}
                                {hasEzadminInfo && <td>{item.ezadmin_seq || ''}</td>}
                                {hasEzadminInfo && <td>{item.ezadmin_prd_seq || ''}</td>}
                                {hasEzadminInfo && <td>{item.old_product_id || ''}</td>}
                                {hasEzadminInfo && <td>{item.new_product_id || ''}</td>}
                                {hasEzadminInfo && (
                                    <td style={{ color: item.ezadmin_error ? '#dc2626' : '#22c55e' }}>
                                        {item.change_product_done
                                            ? '교환처리완료'
                                            : item.ezadmin_error || (item.ezadmin_seq ? '완료' : '')}
                                    </td>
                                )}
                                {hasCsLookup && <td>{item.cs_phone || ''}</td>}
                                {hasCsLookup && (
                                    <td style={{ color: item.cs_product_error ? '#dc2626' : undefined }}>
                                        {item.cs_product_error || (item.cs_products || [])
                                            .map((p) => {
                                                const option = [p.color, p.size].filter(Boolean).join('/');
                                                const label = p.name ? `${p.name}${option ? ` [${option}]` : ''}` : p.product_id;
                                                return `${label} (${p.product_id}) x${p.qty}`;
                                            })
                                            .join(', ')}
                                    </td>
                                )}
                                {hasCsLookup && (
                                    <td style={{ color: item.cs_error ? '#dc2626' : (item.cs_ably_exists ? '#22c55e' : undefined) }}>
                                        {item.cs_error ? item.cs_error : item.cs_ably_exists === true ? (
                                            <button
                                                type="button"
                                                onClick={() => openCsDetail(item.cs_phone)}
                                                style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', color: 'inherit', textDecoration: 'underline', cursor: 'pointer' }}
                                            >
                                                있음
                                            </button>
                                        ) : item.cs_ably_exists === false ? '없음' : ''}
                                    </td>
                                )}
                                {showSmsAction && (
                                    <td>
                                        <button
                                            type="button"
                                            className={pageStyles.secondaryBtn}
                                            onClick={() => openSmsCompose(item)}
                                        >
                                            문자
                                        </button>
                                    </td>
                                )}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        );
    };

    const renderQueueTab = (items, selectedIds, setSelectedIds, extraActions, showSmsAction) => {
        const handleToggleOne = (id) => {
            setSelectedIds((prev) => {
                const next = new Set(prev);
                next.has(id) ? next.delete(id) : next.add(id);
                return next;
            });
        };
        const handleToggleAll = () => {
            const allChecked = items.length > 0 && items.every((item) => selectedIds.has(item.id));
            setSelectedIds(allChecked ? new Set() : new Set(items.map((item) => item.id)));
        };
        return (
            <>
                {items.length > 0 && (
                    <div className={`${pageStyles.uploadRow} ${styles.compactActions}`}>
                        <button
                            type="button"
                            className={pageStyles.secondaryBtn}
                            onClick={() => handleDeleteSelected(selectedIds, setSelectedIds)}
                            disabled={deleteLoading || selectedIds.size === 0}
                        >
                            선택 삭제 ({selectedIds.size})
                        </button>
                        {extraActions}
                    </div>
                )}
                {renderTable(items, selectedIds, handleToggleOne, handleToggleAll, showSmsAction)}
            </>
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
                            onClick={handleLoadAllApis}
                            disabled={isLoadingAllApis}
                        >
                            <span style={{ display: 'inline-flex', gap: 4, marginRight: 6, verticalAlign: 'middle' }}>
                                <span title="롯데" style={{
                                    display: 'inline-block',
                                    width: 8,
                                    height: 8,
                                    borderRadius: '50%',
                                    background: (status?.lotte_loaded || status?.map_lotte_count > 0) ? '#22c55e' : '#d1d5db',
                                }} />
                                <span title="반품" style={{
                                    display: 'inline-block',
                                    width: 8,
                                    height: 8,
                                    borderRadius: '50%',
                                    background: status?.excel2_loaded ? '#22c55e' : '#d1d5db',
                                }} />
                                <span title="교환" style={{
                                    display: 'inline-block',
                                    width: 8,
                                    height: 8,
                                    borderRadius: '50%',
                                    background: status?.exchange_loaded ? '#22c55e' : '#d1d5db',
                                }} />
                            </span>
                            {isLoadingAllApis ? '불러오는 중...' : '전체 API 불러오기'}
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
                        <button className={pageStyles.secondaryBtn} onClick={handleReset}>
                            초기화
                        </button>
                    </div>
                    {savedAt && <div className={pageStyles.metaLabel}>마지막 임시저장: {savedAt}</div>}

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
                                ['regather', '오회수'],
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

                    {message && (
                        <div className={pageStyles.statusMsg} style={{ marginBottom: '0.75rem' }}>
                            <strong>{message}</strong>
                        </div>
                    )}

                    {activeTab !== 'onebe' && (
                        <>
                            {activeTab === 'all' && renderQueueTab(queues.all, selectedAll, setSelectedAll)}
                            {activeTab === 'seller' && renderQueueTab(queues.seller, selectedSeller, setSelectedSeller, (
                                <>
                                    <button
                                        type="button"
                                        className={pageStyles.primaryBtn}
                                        onClick={() => handleAblyRefundSubmit(queues.seller.filter((i) => selectedSeller.has(i.id)))}
                                        disabled={refundLoading || selectedSeller.size === 0}
                                    >
                                        {refundLoading ? '처리 중...' : `에이블리 환불 요청 (${selectedSeller.size}건 선택)`}
                                    </button>
                                    <button
                                        type="button"
                                        className={pageStyles.primaryBtn}
                                        onClick={() => openReasonChangeTemplateModal(queues.seller.filter((i) => selectedSeller.has(i.id)))}
                                        disabled={reasonChangeLoading || selectedSeller.size === 0}
                                    >
                                        {reasonChangeLoading ? '처리 중...' : `일반사유로변경 (${selectedSeller.size}건 선택)`}
                                    </button>
                                    <button
                                        type="button"
                                        className={pageStyles.primaryBtn}
                                        onClick={() => handleEzadminReceiveStock(queues.seller.filter((i) => selectedSeller.has(i.id)))}
                                        disabled={stockinLoading || selectedSeller.size === 0}
                                    >
                                        {stockinLoading ? '처리 중...' : `이지어드민 입고처리 (${selectedSeller.size}건 선택)`}
                                    </button>
                                    <button
                                        type="button"
                                        className={pageStyles.primaryBtn}
                                        onClick={() => handleSendToKimsungil(queues.seller.filter((i) => selectedSeller.has(i.id)))}
                                        disabled={kimsungilSendLoading || selectedSeller.size === 0}
                                    >
                                        {kimsungilSendLoading ? '처리 중...' : `김승일보내기 (${selectedSeller.size}건 선택)`}
                                    </button>
                                    <button
                                        type="button"
                                        className={pageStyles.primaryBtn}
                                        onClick={() => handlePrintBarcodesOnly(queues.seller.filter((i) => selectedSeller.has(i.id)))}
                                        disabled={labelPrintLoading || selectedSeller.size === 0}
                                    >
                                        {labelPrintLoading ? '처리 중...' : `바코드 출력 (${selectedSeller.size}건 선택)`}
                                    </button>
                                </>
                            ), true)}
                            {activeTab === 'customer' && (() => {
                                const items = queues.customer;
                                if (!items || items.length === 0) return <div className={pageStyles.empty}>데이터가 없습니다.</div>;
                                const allChecked = items.length > 0 && items.every((i) => selectedCustomer.has(i.id));
                                const hasDetailReason = items.some((i) => i.detail_reason);
                                const hasUserComment = items.some((i) => i.user_comment);
                                const hasImages = items.some((i) => i.images && i.images.length > 0);
                                const hasRefundStatus = items.some((i) => i.ably_refund_done || i.ably_refund_error);
                                const hasStockinStatus = items.some((i) => i.ezadmin_stockin_done || i.ezadmin_stockin_error);
                                return (
                                    <>
                                        <div className={`${pageStyles.uploadRow} ${styles.compactActions}`}>
                                            <button
                                                type="button"
                                                className={pageStyles.secondaryBtn}
                                                onClick={() => handleDeleteSelected(selectedCustomer, setSelectedCustomer)}
                                                disabled={deleteLoading || selectedCustomer.size === 0}
                                            >
                                                선택 삭제 ({selectedCustomer.size})
                                            </button>
                                            <button
                                                type="button"
                                                className={pageStyles.primaryBtn}
                                                onClick={() => handleAblyRefundSubmit(items.filter((i) => selectedCustomer.has(i.id)))}
                                                disabled={refundLoading || selectedCustomer.size === 0}
                                            >
                                                {refundLoading ? '처리 중...' : `에이블리 환불 요청 (${selectedCustomer.size}건 선택)`}
                                            </button>
                                            <button
                                                type="button"
                                                className={pageStyles.primaryBtn}
                                                onClick={() => handleEzadminReceiveStock(items.filter((i) => selectedCustomer.has(i.id)))}
                                                disabled={stockinLoading || selectedCustomer.size === 0}
                                            >
                                                {stockinLoading ? '처리 중...' : `이지어드민 입고처리 (${selectedCustomer.size}건 선택)`}
                                            </button>
                                            <button
                                                type="button"
                                                className={pageStyles.primaryBtn}
                                                onClick={() => handleSendToKimsungil(items.filter((i) => selectedCustomer.has(i.id)))}
                                                disabled={kimsungilSendLoading || selectedCustomer.size === 0}
                                            >
                                                {kimsungilSendLoading ? '처리 중...' : `김승일보내기 (${selectedCustomer.size}건 선택)`}
                                            </button>
                                            <button
                                                type="button"
                                                className={pageStyles.primaryBtn}
                                                onClick={() => handlePrintBarcodesOnly(
                                                    items
                                                        .filter((i) => selectedCustomer.has(i.id))
                                                        .sort((a, b) => (b.item_text || '').localeCompare(a.item_text || '', 'ko'))
                                                )}
                                                disabled={labelPrintLoading || selectedCustomer.size === 0}
                                            >
                                                {labelPrintLoading ? '처리 중...' : `바코드 출력 (${selectedCustomer.size}건 선택)`}
                                            </button>
                                            <button
                                                type="button"
                                                className={pageStyles.primaryBtn}
                                                onClick={() => handleRegatherExecute(items.filter((i) => selectedCustomer.has(i.id)))}
                                                disabled={regatherExecuteLoading || selectedCustomer.size === 0}
                                            >
                                                {regatherExecuteLoading ? '처리 중...' : `오회수 (${selectedCustomer.size}건 선택)`}
                                            </button>
                                        </div>
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
                                                    {hasImages && <th>사진</th>}
                                                    {hasRefundStatus && <th>환불처리</th>}
                                                    {hasStockinStatus && <th>입고처리</th>}
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {items.map((item) => (
                                                    <tr
                                                        key={item.id}
                                                        style={item.ably_refund_done
                                                            ? { background: '#e5e7eb', color: '#9ca3af' }
                                                            : (selectedCustomer.has(item.id) ? { background: 'var(--bg-secondary)' } : undefined)}
                                                    >
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
                                                        {hasImages && (
                                                            <td>
                                                                {(item.images || []).length === 0 ? '' : (
                                                                    <div style={{ display: 'flex', gap: 4 }}>
                                                                        {item.images.map((src, i) => (
                                                                            <img
                                                                                key={i}
                                                                                src={src}
                                                                                alt={`사진 ${i + 1}`}
                                                                                style={{ width: 36, height: 36, objectFit: 'cover', borderRadius: 4, cursor: 'zoom-in' }}
                                                                                onClick={() => setZoomImage(src)}
                                                                            />
                                                                        ))}
                                                                    </div>
                                                                )}
                                                            </td>
                                                        )}
                                                        {hasRefundStatus && (
                                                            <td style={{ color: item.ably_refund_error ? '#dc2626' : '#22c55e', fontWeight: item.ably_refund_done ? 600 : 400 }}>
                                                                {item.ably_refund_done ? '✓ 완료' : item.ably_refund_error || ''}
                                                            </td>
                                                        )}
                                                        {hasStockinStatus && (
                                                            <td style={{ color: item.ezadmin_stockin_error ? '#dc2626' : '#22c55e', fontWeight: item.ezadmin_stockin_done ? 600 : 400 }}>
                                                                {item.ezadmin_stockin_done ? `✓ 완료 (${item.ezadmin_stockin_product_id || ''})` : item.ezadmin_stockin_error || ''}
                                                            </td>
                                                        )}
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                        </div>
                                    </>
                                );
                            })()}
                            {activeTab === 'regather' && (
                                <div className={pageStyles.tableWrap}>
                                    {regatherLoading ? (
                                        <div className={pageStyles.empty}>불러오는 중...</div>
                                    ) : regatherItems.length === 0 ? (
                                        <div className={pageStyles.empty}>오회수 처리된 건이 없습니다.</div>
                                    ) : (
                                        <table className={pageStyles.table}>
                                            <thead>
                                                <tr>
                                                    <th>송장번호</th>
                                                    <th>상품명</th>
                                                    <th>전화번호</th>
                                                    <th>신청일시</th>
                                                    <th>완료처리</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {regatherItems.map((r) => (
                                                    <tr key={r.id}>
                                                        <td>{r.invoice}</td>
                                                        <td>{r.goods_name}</td>
                                                        <td>{r.buyer_tel}</td>
                                                        <td>{r.requested_at}</td>
                                                        <td>
                                                            <button
                                                                type="button"
                                                                className={pageStyles.secondaryBtn}
                                                                onClick={() => handleCompleteRegather(r.id)}
                                                            >
                                                                완료처리
                                                            </button>
                                                        </td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    )}
                                </div>
                            )}
                            {activeTab === 'exchange_seller' && (
                                <>
                                    {renderQueueTab(queues.exchange_seller, selectedExchangeSeller, setSelectedExchangeSeller, (
                                        <>
                                            <button
                                                type="button"
                                                className={pageStyles.primaryBtn}
                                                onClick={() => handleEzadminReceiveStock(queues.exchange_seller.filter((i) => selectedExchangeSeller.has(i.id)))}
                                                disabled={stockinLoading || selectedExchangeSeller.size === 0}
                                            >
                                                {stockinLoading ? '처리 중...' : `이지어드민 입고처리 (${selectedExchangeSeller.size}건 선택)`}
                                            </button>
                                            <button
                                                type="button"
                                                className={pageStyles.primaryBtn}
                                                onClick={() => handleSendToKimsungil(queues.exchange_seller.filter((i) => selectedExchangeSeller.has(i.id)))}
                                                disabled={kimsungilSendLoading || selectedExchangeSeller.size === 0}
                                            >
                                                {kimsungilSendLoading ? '처리 중...' : `김승일보내기 (${selectedExchangeSeller.size}건 선택)`}
                                            </button>
                                            <button
                                                type="button"
                                                className={pageStyles.primaryBtn}
                                                onClick={() => handlePrintBarcodesOnly(queues.exchange_seller.filter((i) => selectedExchangeSeller.has(i.id)))}
                                                disabled={labelPrintLoading || selectedExchangeSeller.size === 0}
                                            >
                                                {labelPrintLoading ? '처리 중...' : `바코드 출력 (${selectedExchangeSeller.size}건 선택)`}
                                            </button>
                                        </>
                                    ))}
                                    {queues.exchange_seller.length > 0 && (
                                        <div className={`${pageStyles.uploadRow} ${styles.compactActions}`}>
                                            <button
                                                type="button"
                                                className={pageStyles.secondaryBtn}
                                                onClick={() => handleResolveExchangeEzadmin('seller')}
                                                disabled={isResolvingEzadminSeller}
                                            >
                                                {isResolvingEzadminSeller ? '조회 중...' : '이지어드민 정보 불러오기'}
                                            </button>
                                            <button
                                                type="button"
                                                className={pageStyles.fileInput}
                                                onClick={() => handleExecuteExchangeChangeProduct('seller', Array.from(selectedExchangeSeller))}
                                                disabled={isExecutingChangeProductSeller || !exchangeSellerSelectedReady}
                                            >
                                                {isExecutingChangeProductSeller ? '실행 중...' : `실행 (${selectedExchangeSeller.size}건 선택)`}
                                            </button>
                                        </div>
                                    )}
                                </>
                            )}
                            {activeTab === 'exchange_customer' && (
                                <>
                                    {renderQueueTab(queues.exchange_customer, selectedExchangeCustomer, setSelectedExchangeCustomer)}
                                    {queues.exchange_customer.length > 0 && (
                                        <div className={`${pageStyles.uploadRow} ${styles.compactActions}`}>
                                            <button
                                                type="button"
                                                className={pageStyles.secondaryBtn}
                                                onClick={() => handleResolveExchangeEzadmin('customer')}
                                                disabled={isResolvingEzadmin}
                                            >
                                                {isResolvingEzadmin ? '조회 중...' : '이지어드민 정보 불러오기'}
                                            </button>
                                            <button
                                                type="button"
                                                className={pageStyles.fileInput}
                                                onClick={() => handleExecuteExchangeChangeProduct('customer', Array.from(selectedExchangeCustomer))}
                                                disabled={isExecutingChangeProduct || !exchangeCustomerSelectedReady}
                                            >
                                                {isExecutingChangeProduct ? '실행 중...' : `실행 (${selectedExchangeCustomer.size}건 선택)`}
                                            </button>
                                        </div>
                                    )}
                                </>
                            )}
                            {activeTab === 'unmatched' && renderQueueTab(
                                queues.unmatched,
                                selectedUnmatched,
                                setSelectedUnmatched,
                                <>
                                    <button
                                        type="button"
                                        className={pageStyles.secondaryBtn}
                                        onClick={() => handleCsLookup(selectedUnmatched)}
                                        disabled={csLookupLoading || selectedUnmatched.size === 0}
                                    >
                                        {csLookupLoading ? '조회 중...' : `CS 조회 (${selectedUnmatched.size})`}
                                    </button>
                                    <button
                                        type="button"
                                        className={pageStyles.secondaryBtn}
                                        onClick={() => handleUnmatchedReceiveStock(selectedUnmatched)}
                                        disabled={stockinLoading || selectedUnmatched.size === 0}
                                    >
                                        {stockinLoading ? '처리 중...' : `입고처리 (${selectedUnmatched.size})`}
                                    </button>
                                    <button
                                        type="button"
                                        className={pageStyles.secondaryBtn}
                                        onClick={() => handleUnmatchedPrintBarcodes(selectedUnmatched)}
                                        disabled={selectedUnmatched.size === 0}
                                    >
                                        {`바코드 출력 (${selectedUnmatched.size})`}
                                    </button>
                                </>
                            )}
                        </>
                    )}

                    {activeTab === 'onebe' && (
                        <div className={`${pageStyles.stack} ${styles.onebePanel}`}>
                            <div className={`${pageStyles.uploadRow} ${styles.onebeActions}`}>
                                <button className={pageStyles.primaryBtn} onClick={handleBuildOnebe}>
                                    생성
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
                        <button className={pageStyles.secondaryBtn} onClick={handleResetOnebe}>
                            원배양식 초기화
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
                    {stockinResults && (
                        <div style={{ padding: '0.5rem 1rem 0.75rem' }}>
                            {stockinResults.map((r, i) => (
                                <div key={i} style={{ fontSize: '0.8rem', color: r.ok ? 'var(--text-muted)' : '#ef4444', marginBottom: '2px' }}>
                                    {r.ok ? `✓ ${r.scan} (${r.product_id || ''})` : `✗ ${r.scan} — ${r.error || ''}`}
                                </div>
                            ))}
                        </div>
                    )}
                    {reasonChangeResults && (
                        <div style={{ padding: '0.5rem 1rem 0.75rem' }}>
                            {reasonChangeResults.map((r, i) => (
                                <div key={i} style={{ fontSize: '0.8rem', color: r.ok ? 'var(--text-muted)' : '#ef4444', marginBottom: '2px' }}>
                                    {r.ok ? '✓' : '✗'} {r.scan} {r.error ? `— ${r.error}` : ''}
                                </div>
                            ))}
                        </div>
                    )}
                </section>

            </div>

            {zoomImage && (
                <div
                    onClick={() => setZoomImage(null)}
                    style={{
                        position: 'fixed',
                        inset: 0,
                        background: 'rgba(0,0,0,0.85)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        zIndex: 1000,
                        cursor: 'zoom-out',
                    }}
                >
                    <img
                        src={zoomImage}
                        alt="확대 사진"
                        style={{ maxWidth: '90vw', maxHeight: '90vh', objectFit: 'contain', borderRadius: 8 }}
                    />
                </div>
            )}

            {csDetailModal && (
                <div
                    onClick={() => setCsDetailModal(null)}
                    style={{
                        position: 'fixed',
                        inset: 0,
                        background: 'rgba(0,0,0,0.5)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        zIndex: 1000,
                    }}
                >
                    <div
                        onClick={(e) => e.stopPropagation()}
                        style={{
                            background: 'var(--bg-primary, #fff)',
                            borderRadius: 8,
                            width: 'min(560px, 90vw)',
                            maxHeight: '80vh',
                            display: 'flex',
                            flexDirection: 'column',
                            overflow: 'hidden',
                        }}
                    >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', borderBottom: '1px solid var(--border-color, #e5e7eb)' }}>
                            <strong>에이블리 CS 내용 ({csDetailModal.phone})</strong>
                            <button type="button" onClick={() => setCsDetailModal(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18 }}>×</button>
                        </div>
                        <div style={{ padding: 16, overflowY: 'auto' }}>
                            {csDetailModal.loading && <div>불러오는 중...</div>}
                            {!csDetailModal.loading && csDetailModal.error && (
                                <div style={{ color: '#dc2626' }}>{csDetailModal.error}</div>
                            )}
                            {!csDetailModal.loading && !csDetailModal.error && csDetailModal.rooms.length === 0 && (
                                <div>CS문의 내용을 찾을 수 없습니다.</div>
                            )}
                            {!csDetailModal.loading && csDetailModal.rooms.map((room, i) => (
                                <div key={i} style={{ marginBottom: 20 }}>
                                    <div style={{ fontWeight: 600, marginBottom: 8 }}>
                                        {room.market_name} · {room.status_display}
                                    </div>
                                    {room.error && <div style={{ color: '#dc2626' }}>{room.error}</div>}
                                    {(room.messages || []).map((msg, j) => (
                                        <div key={j} style={{ marginBottom: 10, paddingLeft: 8, borderLeft: '3px solid var(--border-color, #e5e7eb)' }}>
                                            <div style={{ fontSize: 12, color: 'var(--text-secondary, #6b7280)' }}>
                                                {msg.sender} · {msg.created_at}
                                            </div>
                                            <div style={{ whiteSpace: 'pre-wrap' }}>{msg.content}</div>
                                        </div>
                                    ))}
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            )}

            {smsComposeItem && (
                <div
                    onClick={closeSmsCompose}
                    style={{
                        position: 'fixed',
                        inset: 0,
                        background: 'rgba(0,0,0,0.5)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        zIndex: 1000,
                    }}
                >
                    <div
                        onClick={(e) => e.stopPropagation()}
                        style={{
                            background: 'var(--bg-primary, #fff)',
                            borderRadius: 8,
                            width: 'min(420px, 90vw)',
                            display: 'flex',
                            flexDirection: 'column',
                        }}
                    >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', borderBottom: '1px solid var(--border-color, #e5e7eb)' }}>
                            <strong>이지데스크 문자 보내기</strong>
                            <button type="button" onClick={closeSmsCompose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18 }}>×</button>
                        </div>
                        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
                            <input
                                value={smsComposePhone}
                                onChange={(e) => setSmsComposePhone(e.target.value)}
                                placeholder="수신 전화번호"
                                style={{ padding: '8px 10px', border: '1px solid var(--border-color, #e5e7eb)', borderRadius: 6 }}
                            />
                            <textarea
                                value={smsComposeText}
                                onChange={(e) => setSmsComposeText(e.target.value)}
                                placeholder="문자 내용을 입력하세요"
                                rows={4}
                                style={{ padding: '8px 10px', border: '1px solid var(--border-color, #e5e7eb)', borderRadius: 6, resize: 'vertical', font: 'inherit' }}
                            />
                            <button
                                type="button"
                                className={pageStyles.primaryBtn}
                                onClick={handleSendEzdeskSms}
                                disabled={smsSendLoading}
                            >
                                {smsSendLoading ? '전송 중...' : '전송'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {reasonChangeModalOpen && (
                <div
                    onClick={closeReasonChangeTemplateModal}
                    style={{
                        position: 'fixed',
                        inset: 0,
                        background: 'rgba(0,0,0,0.5)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        zIndex: 1000,
                    }}
                >
                    <div
                        onClick={(e) => e.stopPropagation()}
                        style={{
                            background: 'var(--bg-primary, #fff)',
                            borderRadius: 8,
                            width: 'min(480px, 90vw)',
                            display: 'flex',
                            flexDirection: 'column',
                        }}
                    >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', borderBottom: '1px solid var(--border-color, #e5e7eb)' }}>
                            <strong>일반사유로변경 — 문자 템플릿 선택 ({reasonChangePendingItems.length}건)</strong>
                            <button type="button" onClick={closeReasonChangeTemplateModal} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18 }}>×</button>
                        </div>
                        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
                            {reasonChangeTemplatesLoading ? (
                                <div>템플릿 불러오는 중...</div>
                            ) : reasonChangeTemplates.length === 0 ? (
                                <div>등록된 템플릿이 없습니다. 사이드메뉴 "문자 발송"에서 템플릿을 먼저 만들어주세요.</div>
                            ) : (
                                <>
                                    <select
                                        value={reasonChangeSelectedTemplateId}
                                        onChange={(e) => setReasonChangeSelectedTemplateId(e.target.value)}
                                        style={{ padding: '8px 10px', border: '1px solid var(--border-color, #e5e7eb)', borderRadius: 6 }}
                                    >
                                        {reasonChangeTemplates.map((t) => (
                                            <option key={t.id} value={t.id}>{t.name}</option>
                                        ))}
                                    </select>
                                    <div style={{ whiteSpace: 'pre-wrap', fontSize: '0.85rem', color: 'var(--text-secondary, #6b7280)', border: '1px solid var(--border-color, #e5e7eb)', borderRadius: 6, padding: 10, minHeight: 60 }}>
                                        {reasonChangeTemplates.find((t) => t.id === reasonChangeSelectedTemplateId)?.msg || ''}
                                    </div>
                                </>
                            )}
                            <button
                                type="button"
                                className={pageStyles.primaryBtn}
                                onClick={handleConfirmReasonChangeWithSms}
                                disabled={reasonChangeConfirmLoading || reasonChangeTemplatesLoading || !reasonChangeSelectedTemplateId}
                            >
                                {reasonChangeConfirmLoading ? '처리 중...' : '진행'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default ReturnsPage;
