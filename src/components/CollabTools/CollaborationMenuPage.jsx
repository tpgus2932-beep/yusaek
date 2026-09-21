import React, { useEffect, useMemo, useRef, useState } from 'react';
import JsBarcode from 'jsbarcode';
import styles from './CollaborationMenuPage.module.css';
import { LOCAL_API_BASE, getAuthHeaders, handleUnauthorized } from '../../lib/api';
import { useEzadminSession } from '../../lib/EzadminSessionContext';
import {
  ArrowDownToLine, CheckCircle, ChevronDown, ChevronUp, Clipboard,
  Database, Download, Eye, FileSpreadsheet, PackagePlus, Plus, RefreshCw, Save, Search, Trash2, Upload, XCircle,
} from 'lucide-react';

const TOOL_TABS = [
  { key: 'purchase-deduction', label: '날짜별이체파일 양식' },
  { key: 'simple-receiving', label: '간단입고' },
];

const DEFAULT_ACCOUNT_PATH = String.raw`C:\Users\ksh29\OneDrive\Desktop\원베\거래처계좌데이터.xlsx`;
// backend order_routes.py의 _SIMPLE_RECEIVING_SHEET_TITLE과 동일 - 전표 이름을 비워두면 이 값으로 생성된다.
const DEFAULT_SIMPLE_RECEIVING_SHEET_TITLE = '세현1';
const ACCOUNT_COLUMNS = ['A', 'B', 'C', 'D', 'E', 'F'];
const SHARED_PASTE_SLOTS = [1, 2, 3, 4, 5];
const SHARED_PASTE_SLOT_LABELS = {
  1: '세현',
  2: '병욱',
  3: '동수',
};

const getSharedPasteSlotLabel = (slot) => SHARED_PASTE_SLOT_LABELS[slot] || `${slot}번`;

const formatAmount = (value) =>
  new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2 }).format(Number(value || 0));

// DBManager/OrderHistoryTable.jsx의 isMisongPickup과 동일한 판정 기준.
function isMisongPickupRow(row) {
  return row.recommended_qty_source === 'misong_pickup' || String(row.options || '').includes('미송픽업');
}

// 미송픽업 담긴 항목은 같은 상품코드의 일반 담긴 항목과 절대 합치지 않는다 -
// 입고전표 생성 시 미송픽업분만 요청메모에 "미송픽업"을 남겨야 하기 때문에 줄을 분리해서 유지한다.
function receivingDraftKey(item) {
  return `${item.code}__${item.isMisongPickup ? 'misong' : 'normal'}`;
}

// ReturnsPage.jsx의 판매자대기/교환고객 바코드 출력과 동일한 방식 - EZAdmin 전표 없이
// 상품명/옵션/상품코드로 바로 라벨을 그려서 인쇄한다(입고전표 생성과 무관하게 독립적으로 동작).
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

function buildBarcodeSvgMarkup(text) {
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
}

function printProductLabels(labels) {
  const valid = labels.filter((l) => l.code);
  if (!valid.length) return;
  const cardsHtml = valid.map((l) => `
    <div class="card">
        <div class="title">${escapeHtml(l.title)}</div>
        <div class="option"${l.option ? '' : ' style="visibility:hidden"'}>${l.option ? escapeHtml(l.option) : '-'}</div>
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
}

// 간단입고는 전날 발주한 상품을 오늘 입고 처리하는 흐름이라, 발주내역 검색도 전날 날짜로 고정한다.
function yesterdayLocalDate() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const downloadBlob = (blob, filename) => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
};

const toExcelTextCell = (value) => {
  const text = (value ?? '').toString();
  if (!text) return '';
  return `="${text.replace(/"/g, '""')}"`;
};

const COLLAB_MENU_ACTIVE_TAB_KEY = 'collabMenuActiveTab';
const COLLAB_MENU_RECEIVING_DRAFT_KEY = 'collabMenuReceivingDraft';
const COLLAB_MENU_RECEIVING_DRAFT_SLOT_KEY = 'collabMenuReceivingDraftSlot';
const EMPTY_SET = new Set();

// 슬롯(담당자 탭)별로 완전히 분리된 입고목록을 보관한다 - { [slot]: item[] }.
// 예전 버전은 슬롯 구분 없이 배열 하나만 저장했으므로, 그 형식이면 1번 슬롯으로 옮겨 이어서 쓴다.
const loadReceivingDraftsBySlot = () => {
  try {
    const raw = localStorage.getItem(COLLAB_MENU_RECEIVING_DRAFT_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    if (Array.isArray(parsed)) return parsed.length ? { 1: parsed } : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
};

const fallbackCopyText = (text) => {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '0';
  textarea.style.left = '0';
  textarea.style.width = '1px';
  textarea.style.height = '1px';
  textarea.style.padding = '0';
  textarea.style.border = '0';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  if (!copied) throw new Error('클립보드 복사에 실패했습니다.');
};

export default function CollaborationMenuPage() {
  const [activeTab, setActiveTab] = useState(
    () => localStorage.getItem(COLLAB_MENU_ACTIVE_TAB_KEY) || 'purchase-deduction',
  );
  const [pastedText, setPastedText] = useState('');
  const [accountPath, setAccountPath] = useState(DEFAULT_ACCOUNT_PATH);
  const [skipSourceHeader, setSkipSourceHeader] = useState(false);
  const [skipAccountHeader, setSkipAccountHeader] = useState(true);
  const [processing, setProcessing] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [copying, setCopying] = useState(false);
  const [message, setMessage] = useState('');
  const [messageType, setMessageType] = useState('');
  const [result, setResult] = useState(null);
  const [sharedPasteLoading, setSharedPasteLoading] = useState(false);
  const [sharedPasteSaving, setSharedPasteSaving] = useState(false);
  const [sharedPasteSlot, setSharedPasteSlot] = useState(1);
  const [sharedPasteMeta, setSharedPasteMeta] = useState('');
  const [accountRows, setAccountRows] = useState([]);
  const [accountLoading, setAccountLoading] = useState(false);
  const [accountSaving, setAccountSaving] = useState(false);
  const [accountManagerOpen, setAccountManagerOpen] = useState(false);
  const [accountSearch, setAccountSearch] = useState('');
  const [appendText, setAppendText] = useState('');
  const [appendSkipHeader, setAppendSkipHeader] = useState(false);
  const { openModal: openEzadminModal } = useEzadminSession();
  const receivingSearchInputRef = useRef(null);
  const receivingQtyInputRefs = useRef({});
  const receivingMisongInputRefs = useRef({});
  const receivingMemoInputRefs = useRef({});
  const receivingBarcodePrintBtnRef = useRef(null);
  const [receivingSearchQuery, setReceivingSearchQuery] = useState('');
  const [receivingSearchResults, setReceivingSearchResults] = useState([]);
  const [receivingSearchQtyEdits, setReceivingSearchQtyEdits] = useState({});
  const [receivingSearchMisongEdits, setReceivingSearchMisongEdits] = useState({});
  const [receivingSearchMemoEdits, setReceivingSearchMemoEdits] = useState({});
  const [receivingSearching, setReceivingSearching] = useState(false);
  // 간단입고 입고목록은 매입차감 입력 데이터 복붙처럼 슬롯(담당자 탭)별로 완전히 분리해서 보관한다 -
  // 탭을 바꿔도 다른 탭에서 담은 상품이 섞여 보이거나 같이 수정되지 않는다.
  const [receivingDraftsBySlot, setReceivingDraftsBySlot] = useState(loadReceivingDraftsBySlot);
  const [receivingDraftSlot, setReceivingDraftSlot] = useState(() => {
    const saved = Number(localStorage.getItem(COLLAB_MENU_RECEIVING_DRAFT_SLOT_KEY));
    return SHARED_PASTE_SLOTS.includes(saved) ? saved : 1;
  });
  const receivingDraft = receivingDraftsBySlot[receivingDraftSlot] || [];
  const updateReceivingDraftForSlot = (slot, updater) => {
    setReceivingDraftsBySlot((prev) => {
      const prevForSlot = prev[slot] || [];
      const nextForSlot = typeof updater === 'function' ? updater(prevForSlot) : updater;
      return { ...prev, [slot]: nextForSlot };
    });
  };
  const [receivingDraftSlotLoading, setReceivingDraftSlotLoading] = useState(false);
  const [receivingDraftSlotSaving, setReceivingDraftSlotSaving] = useState(false);
  const [receivingDraftSlotMeta, setReceivingDraftSlotMeta] = useState('');
  // 바코드 출력은 "현재 탭에서, 이번 검색으로 담은 것"만 대상으로 한다 - 새로 검색하면 비워지고,
  // 그 검색 결과에서 담을 때만 채워진다(이전 검색에서 담아둔 건 이번 출력에서 빠짐). 슬롯별로 분리한다.
  const [receivingPrintBatchKeysBySlot, setReceivingPrintBatchKeysBySlot] = useState({});
  const receivingPrintBatchKeys = receivingPrintBatchKeysBySlot[receivingDraftSlot] || EMPTY_SET;
  const updatePrintBatchKeysForSlot = (slot, updater) => {
    setReceivingPrintBatchKeysBySlot((prev) => {
      const prevForSlot = prev[slot] || new Set();
      const nextForSlot = typeof updater === 'function' ? updater(prevForSlot) : updater;
      return { ...prev, [slot]: nextForSlot };
    });
  };
  const [receivingApplying, setReceivingApplying] = useState(false);
  const [receivingMessage, setReceivingMessage] = useState('');
  const [receivingMessageType, setReceivingMessageType] = useState('');
  const [receivingSheetTitle, setReceivingSheetTitle] = useState('');

  // 발주내역 검색과 별개로, 원가베이스유 DB에서 바로 상품을 찾아 입고목록에 담는 검색창.
  // 발주 이력이 없는 상품(추가 발주 없이 그냥 입고하는 경우 등)을 담을 때 쓴다.
  const wonbeSearchInputRef = useRef(null);
  const wonbeQtyInputRefs = useRef({});
  const wonbeMisongInputRefs = useRef({});
  const wonbeMemoInputRefs = useRef({});
  const wonbeBarcodePrintBtnRef = useRef(null);
  const [wonbeSearchQuery, setWonbeSearchQuery] = useState('');
  const [wonbeSearchResults, setWonbeSearchResults] = useState([]);
  const [wonbeSearchQtyEdits, setWonbeSearchQtyEdits] = useState({});
  const [wonbeSearchMisongEdits, setWonbeSearchMisongEdits] = useState({});
  const [wonbeSearchMemoEdits, setWonbeSearchMemoEdits] = useState({});
  const [wonbeSearching, setWonbeSearching] = useState(false);

  const summaryItems = useMemo(() => {
    if (!result?.summary) return [];
    return [
      { label: '공급처 수', value: `${result.summary.supplier_count}곳` },
      { label: '매칭', value: `${result.summary.matched_count}건` },
      { label: '미등록', value: `${result.summary.unmatched_count}건` },
      { label: '총 합계', value: `${formatAmount(result.summary.total_amount)}원` },
    ];
  }, [result]);

  const requestBody = useMemo(
    () => ({
      pasted_text: pastedText,
      account_path: accountPath,
      skip_source_header: skipSourceHeader,
      skip_account_header: skipAccountHeader,
    }),
    [pastedText, accountPath, skipSourceHeader, skipAccountHeader],
  );

  const filteredAccountRows = useMemo(() => {
    const query = accountSearch.trim().toLowerCase();
    if (!query) return accountRows;
    return accountRows.filter((row) =>
      ACCOUNT_COLUMNS.some((column) => String(row[column] || '').toLowerCase().includes(query)),
    );
  }, [accountRows, accountSearch]);

  const setFeedback = (type, nextMessage) => {
    setMessageType(type);
    setMessage(nextMessage);
  };

  const setReceivingFeedback = (type, nextMessage) => {
    setReceivingMessageType(type);
    setReceivingMessage(nextMessage);
  };

  const fetchAccountRows = async () => {
    try {
      setAccountLoading(true);
      const res = await fetch(`${LOCAL_API_BASE}/collaboration-tools/account-data`, {
        headers: getAuthHeaders(),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) {
        throw new Error(data.detail || '거래처 계좌 데이터를 불러오지 못했습니다.');
      }
      setAccountRows(Array.isArray(data.rows) ? data.rows : []);
      if (data.account_path) setAccountPath(data.account_path);
    } catch (error) {
      setFeedback('error', error.message || '거래처 계좌 데이터를 불러오지 못했습니다.');
    } finally {
      setAccountLoading(false);
    }
  };

  useEffect(() => {
    fetchAccountRows();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    localStorage.setItem(COLLAB_MENU_ACTIVE_TAB_KEY, activeTab);
  }, [activeTab]);

  useEffect(() => {
    localStorage.setItem(COLLAB_MENU_RECEIVING_DRAFT_KEY, JSON.stringify(receivingDraftsBySlot));
  }, [receivingDraftsBySlot]);

  useEffect(() => {
    localStorage.setItem(COLLAB_MENU_RECEIVING_DRAFT_SLOT_KEY, String(receivingDraftSlot));
  }, [receivingDraftSlot]);

  // 간단입고 탭에서 Ctrl/Cmd+F는 브라우저 찾기 대신 발주내역 검색창으로 포커스를 보낸다.
  useEffect(() => {
    if (activeTab !== 'simple-receiving') return;
    const handleKeyDown = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        receivingSearchInputRef.current?.focus();
        receivingSearchInputRef.current?.select();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeTab]);

  const handleLoadSharedPaste = async () => {
    try {
      setSharedPasteLoading(true);
      const res = await fetch(`${LOCAL_API_BASE}/collaboration-tools/purchase-deduction/shared-paste?slot=${sharedPasteSlot}`, {
        headers: getAuthHeaders(),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) {
        throw new Error(data.detail || '공용 복붙 데이터를 불러오지 못했습니다.');
      }
      setPastedText(data.pasted_text || '');
      const slotLabel = getSharedPasteSlotLabel(sharedPasteSlot);
      setSharedPasteMeta(data.updated_by ? `${slotLabel} 최근 저장: ${data.updated_by}` : `${slotLabel} 공용 데이터 없음`);
      setFeedback('ok', `${slotLabel} 공용 복붙 데이터를 불러왔습니다.`);
    } catch (error) {
      setFeedback('error', error.message || '공용 복붙 데이터를 불러오지 못했습니다.');
    } finally {
      setSharedPasteLoading(false);
    }
  };

  const handleSaveSharedPaste = async () => {
    try {
      setSharedPasteSaving(true);
      const res = await fetch(`${LOCAL_API_BASE}/collaboration-tools/purchase-deduction/shared-paste?slot=${sharedPasteSlot}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ pasted_text: pastedText }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) {
        throw new Error(data.detail || '공용 복붙 데이터 저장에 실패했습니다.');
      }
      const slotLabel = getSharedPasteSlotLabel(sharedPasteSlot);
      setSharedPasteMeta(data.updated_by ? `${slotLabel} 최근 저장: ${data.updated_by}` : '');
      setFeedback('ok', `${slotLabel} 공용 복붙 데이터를 저장했습니다.`);
    } catch (error) {
      setFeedback('error', error.message || '공용 복붙 데이터 저장에 실패했습니다.');
    } finally {
      setSharedPasteSaving(false);
    }
  };

  const handlePreview = async () => {
    if (!pastedText.trim()) {
      setFeedback('error', '엑셀 데이터를 그대로 붙여넣으세요.');
      return;
    }
    try {
      setProcessing(true);
      setFeedback('', '');
      const res = await fetch(`${LOCAL_API_BASE}/collaboration-tools/purchase-deduction/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify(requestBody),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) {
        throw new Error(data.detail || '매입차감 미리보기에 실패했습니다.');
      }
      setResult(data);
      setFeedback('ok', `가공 완료: ${data.summary.matched_count}건 매칭, ${data.summary.unmatched_count}건 미등록`);
    } catch (error) {
      setResult(null);
      setFeedback('error', error.message || '매입차감 미리보기에 실패했습니다.');
    } finally {
      setProcessing(false);
    }
  };

  const handleDownload = async () => {
    if (!pastedText.trim()) {
      setFeedback('error', '엑셀 데이터를 먼저 붙여넣으세요.');
      return;
    }
    try {
      setDownloading(true);
      setFeedback('', '');
      const res = await fetch(`${LOCAL_API_BASE}/collaboration-tools/purchase-deduction/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify(requestBody),
      });
      if (handleUnauthorized(res)) return;
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.detail || '매입차감 결과 다운로드에 실패했습니다.');
      }
      const blob = await res.blob();
      downloadBlob(blob, '매입차감_결과.xlsx');
      setFeedback('ok', '결과 파일 다운로드가 완료되었습니다.');
    } catch (error) {
      setFeedback('error', error.message || '매입차감 결과 다운로드에 실패했습니다.');
    } finally {
      setDownloading(false);
    }
  };

  const handleCopyResult = async () => {
    if (!result?.matched?.length) {
      setFeedback('error', '복사할 결과가 없습니다.');
      return;
    }
    try {
      setCopying(true);
      const lines = [
        ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].join('\t'),
        ...result.matched.map((row) =>
          [toExcelTextCell(row.A), toExcelTextCell(row.B), row.C, row.D, row.E, row.F, row.G, row.H]
            .map((value) => (value ?? '').toString())
            .join('\t'),
        ),
      ];
      const copyText = lines.join('\n');
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(copyText);
        } else {
          fallbackCopyText(copyText);
        }
      } catch {
        fallbackCopyText(copyText);
      }
      setFeedback('ok', '결과를 클립보드에 복사했습니다.');
    } catch (error) {
      setFeedback('error', error.message || '결과 복사에 실패했습니다.');
    } finally {
      setCopying(false);
    }
  };

  const handleAccountCellChange = (rowIndex, key, value) => {
    setAccountRows((prev) =>
      prev.map((row, index) => (index === rowIndex ? { ...row, [key]: value } : row)),
    );
  };

  const handleAddAccountRow = () => {
    setAccountRows((prev) => [
      ...prev,
      { row_index: `new_${Date.now()}`, A: '', B: '', C: '', D: '', E: '', F: '' },
    ]);
  };

  const handleDeleteAccountRow = (rowIndex) => {
    setAccountRows((prev) => prev.filter((_, index) => index !== rowIndex));
  };

  const handleSaveAccountRows = async () => {
    try {
      setAccountSaving(true);
      setFeedback('', '');
      const res = await fetch(`${LOCAL_API_BASE}/collaboration-tools/account-data/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ rows: accountRows }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) {
        throw new Error(data.detail || '거래처 계좌 데이터 저장에 실패했습니다.');
      }
      setFeedback('ok', `${data.saved_count}행 저장 완료`);
      await fetchAccountRows();
    } catch (error) {
      setFeedback('error', error.message || '거래처 계좌 데이터 저장에 실패했습니다.');
    } finally {
      setAccountSaving(false);
    }
  };

  const handleAppendAccountRows = async () => {
    if (!appendText.trim()) {
      setFeedback('error', '추가할 데이터를 붙여넣으세요.');
      return;
    }
    try {
      setAccountSaving(true);
      setFeedback('', '');
      const res = await fetch(`${LOCAL_API_BASE}/collaboration-tools/account-data/append-paste`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({
          pasted_text: appendText,
          skip_header: appendSkipHeader,
        }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) {
        throw new Error(data.detail || '거래처 계좌 데이터 추가에 실패했습니다.');
      }
      setAppendText('');
      setAccountRows(Array.isArray(data.rows) ? data.rows : []);
      setFeedback('ok', `${data.added_count}행 추가 완료`);
    } catch (error) {
      setFeedback('error', error.message || '거래처 계좌 데이터 추가에 실패했습니다.');
    } finally {
      setAccountSaving(false);
    }
  };

  const searchOrderHistoryForReceiving = async () => {
    if (!receivingSearchQuery.trim()) {
      setReceivingFeedback('error', '검색어를 입력하세요.');
      return;
    }
    try {
      setReceivingSearching(true);
      setReceivingFeedback('', '');
      const targetDate = yesterdayLocalDate();
      const params = new URLSearchParams({
        q: receivingSearchQuery.trim(),
        limit: '100',
        offset: '0',
        date_from: targetDate,
        date_to: targetDate,
      });
      const res = await fetch(`${LOCAL_API_BASE}/order/main-order/history?${params}`, {
        headers: getAuthHeaders(),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) throw new Error(data.detail || '발주내역 검색에 실패했습니다.');
      const sortedRows = [...(data.rows || [])].sort((a, b) => {
        const misongDiff = Number(isMisongPickupRow(a)) - Number(isMisongPickupRow(b));
        if (misongDiff !== 0) return misongDiff;
        const nameDiff = (a.product_name || a.supply_product_name || '').localeCompare(
          b.product_name || b.supply_product_name || '',
          'ko',
        );
        if (nameDiff !== 0) return nameDiff;
        return (a.store_name || '').localeCompare(b.store_name || '', 'ko');
      });
      setReceivingSearchResults(sortedRows);
      setReceivingSearchQtyEdits({});
      setReceivingSearchMisongEdits({});
      updatePrintBatchKeysForSlot(receivingDraftSlot, new Set());
      if (!data.rows?.length) setReceivingFeedback('error', '검색 결과가 없습니다.');
    } catch (error) {
      setReceivingSearchResults([]);
      setReceivingFeedback('error', error.message || '발주내역 검색에 실패했습니다.');
    } finally {
      setReceivingSearching(false);
    }
  };

  const updateReceivingSearchQty = (rowId, qty) => {
    setReceivingSearchQtyEdits((prev) => ({ ...prev, [rowId]: qty }));
  };

  const updateReceivingSearchMisong = (rowId, misongQty) => {
    setReceivingSearchMisongEdits((prev) => ({ ...prev, [rowId]: misongQty }));
  };

  const swapReceivingSearchQtyMisong = (index) => {
    const row = receivingSearchResults[index];
    if (!row) return;
    const qtyValue = receivingSearchQtyEdits[row.id] ?? row.request_qty ?? 1;
    const misongValue = receivingSearchMisongEdits[row.id] ?? 0;
    updateReceivingSearchQty(row.id, misongValue);
    updateReceivingSearchMisong(row.id, qtyValue);
  };

  // 검색창/담을 수량 칸 사이를 화살표 위·아래로 오가며 수량을 바로 수정할 수 있게 한다.
  // 이미 담긴 행(입력칸 disabled)은 건너뛰고, 맨 위에서 더 올라가면 검색창으로 돌아간다.
  const focusReceivingQtyInputAt = (index, step) => {
    let i = index;
    while (i >= 0 && i < receivingSearchResults.length) {
      const row = receivingSearchResults[i];
      const el = receivingQtyInputRefs.current[row.id];
      if (el && !el.disabled) {
        el.focus();
        el.select();
        return true;
      }
      i += step;
    }
    return false;
  };

  const handleSearchInputKeyDown = (e) => {
    if (e.key === 'Enter') {
      searchOrderHistoryForReceiving();
    } else if (e.key === 'ArrowDown' && e.ctrlKey) {
      e.preventDefault();
      focusReceivingBarcodePrintBtn();
    } else if (e.key === 'ArrowDown' && receivingSearchResults.length > 0) {
      e.preventDefault();
      focusReceivingQtyInputAt(0, 1);
    }
  };

  // 마지막 행에서 더 내려가면 바코드 출력 버튼으로 포커스를 넘긴다 (버튼이 비활성화면 아무 것도 안 함).
  const focusReceivingBarcodePrintBtn = () => {
    const btn = receivingBarcodePrintBtnRef.current;
    if (btn && !btn.disabled) {
      btn.focus();
      return true;
    }
    return false;
  };

  const handleQtyInputKeyDown = (e, index) => {
    if (e.key === 'ArrowDown' && e.ctrlKey) {
      e.preventDefault();
      focusReceivingBarcodePrintBtn();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!focusReceivingQtyInputAt(index + 1, 1)) focusReceivingBarcodePrintBtn();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (index === 0 || !focusReceivingQtyInputAt(index - 1, -1)) {
        receivingSearchInputRef.current?.focus();
        receivingSearchInputRef.current?.select();
      }
    } else if (e.key === 'ArrowRight') {
      const row = receivingSearchResults[index];
      const el = row && receivingMisongInputRefs.current[row.id];
      if (el) {
        e.preventDefault();
        el.focus();
        el.select();
      }
    } else if (e.key === 'Tab') {
      // Tab은 포커스 이동이 아니라, 이 행의 담을 수량<->미송 값 자체를 맞바꾼다.
      e.preventDefault();
      swapReceivingSearchQtyMisong(index);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      triggerAddToReceivingDraft(index);
    }
  };

  // 담을 수량과 동일하게, 미송 칸도 위/아래 화살표는 숫자 증감이 아니라 행 이동으로 쓴다.
  const focusReceivingMisongInputAt = (index, step) => {
    let i = index;
    while (i >= 0 && i < receivingSearchResults.length) {
      const row = receivingSearchResults[i];
      const el = receivingMisongInputRefs.current[row.id];
      if (el && !el.disabled) {
        el.focus();
        el.select();
        return true;
      }
      i += step;
    }
    return false;
  };

  const handleMisongInputKeyDown = (e, index) => {
    if (e.key === 'ArrowLeft') {
      const row = receivingSearchResults[index];
      const el = row && receivingQtyInputRefs.current[row.id];
      if (el) {
        e.preventDefault();
        el.focus();
        el.select();
      }
    } else if (e.key === 'ArrowRight') {
      const row = receivingSearchResults[index];
      const el = row && receivingMemoInputRefs.current[row.id];
      if (el) {
        e.preventDefault();
        el.focus();
        el.select();
      }
    } else if (e.key === 'Tab') {
      // Tab은 포커스 이동이 아니라, 이 행의 담을 수량<->미송 값 자체를 맞바꾼다.
      e.preventDefault();
      swapReceivingSearchQtyMisong(index);
    } else if (e.key === 'ArrowDown' && e.ctrlKey) {
      e.preventDefault();
      focusReceivingBarcodePrintBtn();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!focusReceivingMisongInputAt(index + 1, 1)) focusReceivingBarcodePrintBtn();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (index === 0 || !focusReceivingMisongInputAt(index - 1, -1)) {
        receivingSearchInputRef.current?.focus();
        receivingSearchInputRef.current?.select();
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      triggerAddToReceivingDraft(index);
    }
  };

  // 미송과 동일하게, 요청메모 칸도 위/아래 화살표는 행 이동으로 쓴다.
  const focusReceivingMemoInputAt = (index, step) => {
    let i = index;
    while (i >= 0 && i < receivingSearchResults.length) {
      const row = receivingSearchResults[i];
      const el = receivingMemoInputRefs.current[row.id];
      if (el && !el.disabled) {
        el.focus();
        el.select();
        return true;
      }
      i += step;
    }
    return false;
  };

  const handleMemoInputKeyDown = (e, index) => {
    if (e.key === 'ArrowLeft') {
      const row = receivingSearchResults[index];
      const el = row && receivingMisongInputRefs.current[row.id];
      if (el) {
        e.preventDefault();
        el.focus();
        el.select();
      }
    } else if (e.key === 'ArrowDown' && e.ctrlKey) {
      e.preventDefault();
      focusReceivingBarcodePrintBtn();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!focusReceivingMemoInputAt(index + 1, 1)) focusReceivingBarcodePrintBtn();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (index === 0 || !focusReceivingMemoInputAt(index - 1, -1)) {
        receivingSearchInputRef.current?.focus();
        receivingSearchInputRef.current?.select();
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      triggerAddToReceivingDraft(index);
    }
  };

  // 같은 상품코드를 다시 담으면 막지 않고 기존 담긴 수량에 더한다 - 계속 담기 흐름이 끊기지 않게.
  // 요청메모는 수량과 달리 합산하지 않고, 새로 입력한 값이 있으면 덮어쓴다(없으면 기존 값 유지).
  const addToReceivingDraft = (row, qty, misongQty, index, memo) => {
    const finalQty = Number(qty) || 0;
    const finalMisong = Number(misongQty) || 0;
    if (finalQty <= 0 && finalMisong <= 0) {
      setReceivingFeedback('error', '담을 수량 또는 미송 수량을 1 이상 입력하세요.');
      return;
    }
    const finalMemo = (memo ?? '').trim();
    const rowIsMisongPickup = isMisongPickupRow(row);
    const key = receivingDraftKey({ code: row.product_code, isMisongPickup: rowIsMisongPickup });
    updateReceivingDraftForSlot(receivingDraftSlot, (prev) => {
      const existingIndex = prev.findIndex((item) => receivingDraftKey(item) === key);
      if (existingIndex >= 0) {
        const next = [...prev];
        const existing = next[existingIndex];
        next[existingIndex] = {
          ...existing,
          qty: (Number(existing.qty) || 0) + finalQty,
          misongQty: (Number(existing.misongQty) || 0) + finalMisong,
          memo: finalMemo || existing.memo || '',
        };
        return next;
      }
      return [
        ...prev,
        {
          code: row.product_code,
          name: row.product_name || row.supply_product_name || '',
          clientProductName: row.client_product_name || '',
          options: row.options || '',
          storeName: row.store_name || '',
          qty: finalQty,
          misongQty: finalMisong,
          memo: finalMemo,
          isMisongPickup: rowIsMisongPickup,
        },
      ];
    });
    updatePrintBatchKeysForSlot(receivingDraftSlot, (prev) => new Set(prev).add(key));
    // 담기 후에도 화살표로 계속 다음 행으로 이동할 수 있게 포커스를 넘긴다.
    if (typeof index === 'number' && !focusReceivingQtyInputAt(index + 1, 1)) {
      receivingSearchInputRef.current?.focus();
      receivingSearchInputRef.current?.select();
    }
  };

  // 담을 수량/미송/요청메모 칸에서 엔터를 누르면 그 행을 바로 담는다.
  // 엔터로 담을 때는 다음 행으로 포커스를 넘기지 않는다 (버튼 클릭/화살표 흐름과 달리 제자리 유지).
  const triggerAddToReceivingDraft = (index) => {
    const row = receivingSearchResults[index];
    if (!row || !row.product_code) return;
    const qtyValue = receivingSearchQtyEdits[row.id] ?? row.request_qty ?? 1;
    const misongValue = receivingSearchMisongEdits[row.id] ?? 0;
    const memoValue = receivingSearchMemoEdits[row.id] ?? '';
    addToReceivingDraft(row, qtyValue, misongValue, undefined, memoValue);
  };

  const updateReceivingSearchMemo = (rowId, memo) => {
    setReceivingSearchMemoEdits((prev) => ({ ...prev, [rowId]: memo }));
  };

  const updateReceivingDraftQty = (key, qty) => {
    updateReceivingDraftForSlot(receivingDraftSlot, (prev) =>
      prev.map((item) => (receivingDraftKey(item) === key ? { ...item, qty } : item)));
  };

  const updateReceivingDraftMisongQty = (key, misongQty) => {
    updateReceivingDraftForSlot(receivingDraftSlot, (prev) =>
      prev.map((item) => (receivingDraftKey(item) === key ? { ...item, misongQty } : item)));
  };

  // 입고 목록에서도 검색 결과와 동일하게, 포커스가 있는 행에서 Tab을 누르면
  // 포커스 이동이 아니라 그 행의 담을 수량<->미송 값 자체를 맞바꾼다.
  const swapDraftQtyMisong = (key) => {
    updateReceivingDraftForSlot(receivingDraftSlot, (prev) =>
      prev.map((item) => (receivingDraftKey(item) === key
        ? { ...item, qty: item.misongQty || 0, misongQty: item.qty || 0 }
        : item)));
  };

  const handleDraftQtyInputKeyDown = (e, key) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      swapDraftQtyMisong(key);
    }
  };

  const handleDraftMisongInputKeyDown = (e, key) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      swapDraftQtyMisong(key);
    }
  };

  const updateReceivingDraftMemo = (key, memo) => {
    updateReceivingDraftForSlot(receivingDraftSlot, (prev) =>
      prev.map((item) => (receivingDraftKey(item) === key ? { ...item, memo } : item)));
  };

  const removeReceivingDraftItem = (key) => {
    updateReceivingDraftForSlot(receivingDraftSlot, (prev) => prev.filter((item) => receivingDraftKey(item) !== key));
  };

  const handleLoadSharedReceivingDraft = async () => {
    try {
      setReceivingDraftSlotLoading(true);
      setReceivingFeedback('', '');
      const res = await fetch(`${LOCAL_API_BASE}/collaboration-tools/simple-receiving/shared-draft?slot=${receivingDraftSlot}`, {
        headers: getAuthHeaders(),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) {
        throw new Error(data.detail || '공용 입고목록을 불러오지 못했습니다.');
      }
      updateReceivingDraftForSlot(receivingDraftSlot, () => (Array.isArray(data.items) ? data.items : []));
      updatePrintBatchKeysForSlot(receivingDraftSlot, new Set());
      const slotLabel = getSharedPasteSlotLabel(receivingDraftSlot);
      setReceivingDraftSlotMeta(data.updated_by ? `${slotLabel} 최근 저장: ${data.updated_by}` : `${slotLabel} 공용 데이터 없음`);
      setReceivingFeedback('ok', `${slotLabel} 공용 입고목록을 불러왔습니다.`);
    } catch (error) {
      setReceivingFeedback('error', error.message || '공용 입고목록을 불러오지 못했습니다.');
    } finally {
      setReceivingDraftSlotLoading(false);
    }
  };

  const handleSaveSharedReceivingDraft = async () => {
    try {
      setReceivingDraftSlotSaving(true);
      setReceivingFeedback('', '');
      const res = await fetch(`${LOCAL_API_BASE}/collaboration-tools/simple-receiving/shared-draft?slot=${receivingDraftSlot}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ items: receivingDraft }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) {
        throw new Error(data.detail || '공용 입고목록 저장에 실패했습니다.');
      }
      const slotLabel = getSharedPasteSlotLabel(receivingDraftSlot);
      setReceivingDraftSlotMeta(data.updated_by ? `${slotLabel} 최근 저장: ${data.updated_by}` : '');
      setReceivingFeedback('ok', `${slotLabel} 공용 입고목록을 저장했습니다.`);
    } catch (error) {
      setReceivingFeedback('error', error.message || '공용 입고목록 저장에 실패했습니다.');
    } finally {
      setReceivingDraftSlotSaving(false);
    }
  };

  const applyReceiving = async () => {
    const items = receivingDraft
      .map((item) => ({
        code: item.code,
        qty: Number(item.qty) || 0,
        misongQty: Number(item.misongQty) || 0,
        isMisongPickup: Boolean(item.isMisongPickup),
        memo: (item.memo || '').trim(),
      }))
      .filter((item) => item.code && (item.qty > 0 || item.misongQty > 0));
    if (!items.length) {
      setReceivingFeedback('error', '입고할 상품과 수량을 확인하세요.');
      return;
    }
    try {
      setReceivingApplying(true);
      setReceivingFeedback('', '');
      const res = await fetch(`${LOCAL_API_BASE}/order/simple-receiving/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ items, sheetTitle: receivingSheetTitle.trim() }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (data?.need_session) {
        openEzadminModal(applyReceiving);
        return;
      }
      if (!res.ok || data.ok === false) {
        const doneCount = data.vouchers?.length || 0;
        const donePrefix = doneCount > 0 ? `전표 ${doneCount}장은 생성됐지만, ` : '';
        throw new Error(`${donePrefix}${data.detail || data.error || '입고 처리에 실패했습니다.'}`);
      }
      const voucherCount = data.vouchers?.length || 0;
      const voucherSummary = voucherCount > 1
        ? `전표 ${voucherCount}장 (같은 상품코드가 겹쳐 나눠 생성됨)`
        : `전표: ${data.vouchers?.[0]?.sheet_title || ''}`;
      setReceivingFeedback('ok', `입고전표 생성 완료 (${voucherSummary}, 총 ${data.count}건)`);
      updateReceivingDraftForSlot(receivingDraftSlot, () => []);
    } catch (error) {
      setReceivingFeedback('error', error.message || '입고 처리에 실패했습니다.');
    } finally {
      setReceivingApplying(false);
    }
  };

  // 판매자대기/교환고객처럼 EZAdmin 전표 없이 라벨을 바로 인쇄한다.
  // 대상은 "이번 검색에서 담은 것"만(receivingPrintBatchKeys) - 예전 검색에서 담아둔 건 빠진다.
  // 상품명은 원가베이스유에서 상품코드로 다시 찾은 순수 상품명을 쓴다 - 미송픽업 검색결과는
  // product_name/거래처상품명 칸에 실제 상품명이 아니라 미송관리 표시용 값이 들어있기 때문.
  const handleSimpleReceivingBarcodePrint = async () => {
    const batchItems = receivingDraft.filter(
      (item) => item.code && receivingPrintBatchKeys.has(receivingDraftKey(item)),
    );
    if (!batchItems.length) {
      setReceivingFeedback('error', '이번 검색에서 담은 상품이 없습니다.');
      return;
    }
    let nameByCode = {};
    try {
      const res = await fetch(`${LOCAL_API_BASE}/order/simple-receiving/resolve-product-names`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ codes: [...new Set(batchItems.map((item) => item.code))] }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (res.ok && data?.ok) nameByCode = data.names || {};
    } catch {
      // 상품명 조회에 실패해도 출력 자체는 막지 않는다 - 아래에서 담긴 목록의 이름으로 대체한다.
    }
    const labels = batchItems.flatMap((item) => {
      const qty = Number(item.qty) || 0;
      if (qty <= 0) return [];
      const title = nameByCode[item.code] || item.clientProductName || item.name || '';
      // 라벨은 미송픽업 여부와 상관없이 일반 상품과 똑같이 나가야 하므로 "(미송픽업)" 표시는 지운다.
      const option = (item.options || '').replace(/\(?미송픽업\)?/g, '').replace(/\s+/g, ' ').trim();
      return Array.from({ length: qty }, () => ({ title, option, code: item.code }));
    });
    printProductLabels(labels);
  };

  // 원가베이스유 검색 결과 행을 발주내역 검색 행과 같은 모양으로 맞춰서
  // addToReceivingDraft/isMisongPickupRow가 그대로 재사용되게 한다.
  const wonbeRowToDraftRow = (row) => ({
    product_code: row['상품코드'] || '',
    product_name: row['상품명'] || row['상품명합'] || '',
    supply_product_name: '',
    client_product_name: row['거래처상품명'] || '',
    options: [row['색상'], row['사이즈']].filter(Boolean).join(' '),
    store_name: '',
  });

  const searchWonbeForReceiving = async () => {
    if (!wonbeSearchQuery.trim()) {
      setReceivingFeedback('error', '검색어를 입력하세요.');
      return;
    }
    try {
      setWonbeSearching(true);
      setReceivingFeedback('', '');
      const params = new URLSearchParams({ q: wonbeSearchQuery.trim(), limit: '100' });
      const res = await fetch(`${LOCAL_API_BASE}/wonbe/search?${params}`, {
        headers: getAuthHeaders(),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) throw new Error(data.detail || '원가베이스유 검색에 실패했습니다.');
      setWonbeSearchResults(data.rows || []);
      setWonbeSearchQtyEdits({});
      setWonbeSearchMisongEdits({});
      if (!data.rows?.length) setReceivingFeedback('error', '검색 결과가 없습니다.');
    } catch (error) {
      setWonbeSearchResults([]);
      setReceivingFeedback('error', error.message || '원가베이스유 검색에 실패했습니다.');
    } finally {
      setWonbeSearching(false);
    }
  };

  const updateWonbeSearchQty = (code, qty) => {
    setWonbeSearchQtyEdits((prev) => ({ ...prev, [code]: qty }));
  };

  const updateWonbeSearchMisong = (code, misongQty) => {
    setWonbeSearchMisongEdits((prev) => ({ ...prev, [code]: misongQty }));
  };

  const swapWonbeSearchQtyMisong = (index) => {
    const row = wonbeSearchResults[index];
    const code = row && row['상품코드'];
    if (!code) return;
    const qtyValue = wonbeSearchQtyEdits[code] ?? 1;
    const misongValue = wonbeSearchMisongEdits[code] ?? 0;
    updateWonbeSearchQty(code, misongValue);
    updateWonbeSearchMisong(code, qtyValue);
  };

  const updateWonbeSearchMemo = (code, memo) => {
    setWonbeSearchMemoEdits((prev) => ({ ...prev, [code]: memo }));
  };

  const focusWonbeQtyInputAt = (index, step) => {
    let i = index;
    while (i >= 0 && i < wonbeSearchResults.length) {
      const row = wonbeSearchResults[i];
      const el = wonbeQtyInputRefs.current[row['상품코드']];
      if (el && !el.disabled) {
        el.focus();
        el.select();
        return true;
      }
      i += step;
    }
    return false;
  };

  const focusWonbeMisongInputAt = (index, step) => {
    let i = index;
    while (i >= 0 && i < wonbeSearchResults.length) {
      const row = wonbeSearchResults[i];
      const el = wonbeMisongInputRefs.current[row['상품코드']];
      if (el && !el.disabled) {
        el.focus();
        el.select();
        return true;
      }
      i += step;
    }
    return false;
  };

  const focusWonbeMemoInputAt = (index, step) => {
    let i = index;
    while (i >= 0 && i < wonbeSearchResults.length) {
      const row = wonbeSearchResults[i];
      const el = wonbeMemoInputRefs.current[row['상품코드']];
      if (el && !el.disabled) {
        el.focus();
        el.select();
        return true;
      }
      i += step;
    }
    return false;
  };

  const triggerAddWonbeRow = (index) => {
    const row = wonbeSearchResults[index];
    if (!row || !row['상품코드']) return;
    const code = row['상품코드'];
    const qtyValue = wonbeSearchQtyEdits[code] ?? 1;
    const misongValue = wonbeSearchMisongEdits[code] ?? 0;
    const memoValue = wonbeSearchMemoEdits[code] ?? '';
    addToReceivingDraft(wonbeRowToDraftRow(row), qtyValue, misongValue, undefined, memoValue);
  };

  // 발주내역 검색 테이블과 달리 포커스 이동은 이 테이블 안에서만(원가베이스유 검색창 <-> 바코드 출력 버튼) 오간다.
  const addWonbeRowToDraft = (row, qty, misongQty, index, memo) => {
    addToReceivingDraft(wonbeRowToDraftRow(row), qty, misongQty, undefined, memo);
    if (typeof index === 'number' && !focusWonbeQtyInputAt(index + 1, 1)) {
      wonbeSearchInputRef.current?.focus();
      wonbeSearchInputRef.current?.select();
    }
  };

  // 원가베이스유 검색 섹션 전용 바코드 출력 버튼 - 발주내역 검색과 별개로 이 섹션 안에서 바로 포커스가 넘어간다.
  const focusWonbeBarcodePrintBtn = () => {
    const btn = wonbeBarcodePrintBtnRef.current;
    if (btn && !btn.disabled) {
      btn.focus();
      return true;
    }
    return false;
  };

  const handleWonbeSearchInputKeyDown = (e) => {
    if (e.key === 'Enter') {
      searchWonbeForReceiving();
    } else if (e.key === 'ArrowDown' && e.ctrlKey) {
      e.preventDefault();
      focusWonbeBarcodePrintBtn();
    } else if (e.key === 'ArrowDown' && wonbeSearchResults.length > 0) {
      e.preventDefault();
      focusWonbeQtyInputAt(0, 1);
    }
  };

  const handleWonbeQtyInputKeyDown = (e, index) => {
    if (e.key === 'ArrowDown' && e.ctrlKey) {
      e.preventDefault();
      focusWonbeBarcodePrintBtn();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!focusWonbeQtyInputAt(index + 1, 1)) focusWonbeBarcodePrintBtn();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (index === 0 || !focusWonbeQtyInputAt(index - 1, -1)) {
        wonbeSearchInputRef.current?.focus();
        wonbeSearchInputRef.current?.select();
      }
    } else if (e.key === 'ArrowRight') {
      const row = wonbeSearchResults[index];
      const el = row && wonbeMisongInputRefs.current[row['상품코드']];
      if (el) {
        e.preventDefault();
        el.focus();
        el.select();
      }
    } else if (e.key === 'Tab') {
      // Tab은 포커스 이동이 아니라, 이 행의 담을 수량<->미송 값 자체를 맞바꾼다.
      e.preventDefault();
      swapWonbeSearchQtyMisong(index);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      triggerAddWonbeRow(index);
    }
  };

  const handleWonbeMisongInputKeyDown = (e, index) => {
    if (e.key === 'ArrowLeft') {
      const row = wonbeSearchResults[index];
      const el = row && wonbeQtyInputRefs.current[row['상품코드']];
      if (el) {
        e.preventDefault();
        el.focus();
        el.select();
      }
    } else if (e.key === 'ArrowRight') {
      const row = wonbeSearchResults[index];
      const el = row && wonbeMemoInputRefs.current[row['상품코드']];
      if (el) {
        e.preventDefault();
        el.focus();
        el.select();
      }
    } else if (e.key === 'Tab') {
      // Tab은 포커스 이동이 아니라, 이 행의 담을 수량<->미송 값 자체를 맞바꾼다.
      e.preventDefault();
      swapWonbeSearchQtyMisong(index);
    } else if (e.key === 'ArrowDown' && e.ctrlKey) {
      e.preventDefault();
      focusWonbeBarcodePrintBtn();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!focusWonbeMisongInputAt(index + 1, 1)) focusWonbeBarcodePrintBtn();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (index === 0 || !focusWonbeMisongInputAt(index - 1, -1)) {
        wonbeSearchInputRef.current?.focus();
        wonbeSearchInputRef.current?.select();
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      triggerAddWonbeRow(index);
    }
  };

  const handleWonbeMemoInputKeyDown = (e, index) => {
    if (e.key === 'ArrowLeft') {
      const row = wonbeSearchResults[index];
      const el = row && wonbeMisongInputRefs.current[row['상품코드']];
      if (el) {
        e.preventDefault();
        el.focus();
        el.select();
      }
    } else if (e.key === 'ArrowDown' && e.ctrlKey) {
      e.preventDefault();
      focusWonbeBarcodePrintBtn();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!focusWonbeMemoInputAt(index + 1, 1)) focusWonbeBarcodePrintBtn();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (index === 0 || !focusWonbeMemoInputAt(index - 1, -1)) {
        wonbeSearchInputRef.current?.focus();
        wonbeSearchInputRef.current?.select();
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      triggerAddWonbeRow(index);
    }
  };

  const renderPurchaseDeduction = () => (
    <div className={styles.stack}>
      <section className={styles.hero}>
        <div className={styles.heroText}>
          <h2 className={styles.title}>협업메뉴</h2>
          <p className={styles.subtitle}>입력 데이터는 엑셀 복붙으로 받고, 거래처 계좌 파일은 로컬 고정 경로에서 읽습니다.</p>
        </div>
        <div className={styles.heroIcon}><FileSpreadsheet size={26} /></div>
      </section>

      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <div>
            <div className={styles.cardTitleRow}>
              <div className={`${styles.cardIcon} ${styles.cardIconBlue}`}><ArrowDownToLine size={16} /></div>
              <h3 className={styles.cardTitle}>매입차감 가공</h3>
            </div>
            <p className={styles.cardHint}>입력 데이터 A열 공급처, C열 금액을 집계해서 거래처 계좌 데이터에 매핑합니다.</p>
          </div>
          <div className={styles.headerActions}>
            <button type="button" className={styles.primaryBtn} onClick={handlePreview} disabled={processing}>
              <Eye size={14} />{processing ? '가공 중...' : '미리보기'}
            </button>
            <button type="button" className={styles.secondaryBtn} onClick={handleLoadSharedPaste} disabled={sharedPasteLoading}>
              <Download size={14} />{sharedPasteLoading ? '불러오는 중...' : '공용 불러오기'}
            </button>
            <button type="button" className={styles.secondaryBtn} onClick={handleSaveSharedPaste} disabled={sharedPasteSaving}>
              <Upload size={14} />{sharedPasteSaving ? '저장 중...' : '공용 저장'}
            </button>
            <button type="button" className={styles.secondaryBtn} onClick={handleCopyResult} disabled={copying || !result?.matched?.length}>
              <Clipboard size={14} />{copying ? '복사 중...' : '결과 복사'}
            </button>
            <button type="button" className={styles.secondaryBtn} onClick={handleDownload} disabled={downloading}>
              <ArrowDownToLine size={14} />{downloading ? '다운로드 중...' : '결과 다운로드'}
            </button>
          </div>
        </div>

        <div className={styles.formGrid}>
          <label className={styles.field}>
            <span className={styles.inputLabel}>거래처 계좌 파일 경로</span>
            <input className={styles.textInput} value={accountPath} onChange={(e) => setAccountPath(e.target.value)} />
          </label>
          <div className={styles.optionGrid}>
            <label className={styles.checkboxRow}>
              <input type="checkbox" checked={skipSourceHeader} onChange={(e) => setSkipSourceHeader(e.target.checked)} />
              입력 데이터 첫 행 제외
            </label>
            <label className={styles.checkboxRow}>
              <input type="checkbox" checked={skipAccountHeader} onChange={(e) => setSkipAccountHeader(e.target.checked)} />
              거래처 파일 첫 행 제외
            </label>
          </div>
        </div>

        <label className={styles.field}>
          <div className={styles.inputLabelRow}>
            <span className={styles.inputLabel}>입력 데이터 복붙</span>
            <div className={styles.slotTabs} aria-label="공용 저장 슬롯">
              {SHARED_PASTE_SLOTS.map((slot) => (
                <button
                  key={slot}
                  type="button"
                  className={`${styles.slotTab} ${sharedPasteSlot === slot ? styles.slotTabActive : ''}`}
                  onClick={() => {
                    setSharedPasteSlot(slot);
                    setSharedPasteMeta('');
                  }}
                >
                  {getSharedPasteSlotLabel(slot)}
                </button>
              ))}
            </div>
          </div>
          <textarea
            className={styles.textarea}
            value={pastedText}
            onChange={(e) => setPastedText(e.target.value)}
            placeholder={'엑셀에서 범위를 복사해서 여기에 그대로 붙여넣으세요.\nA열: 공급처, C열: 금액'}
            rows={12}
          />
        </label>
        {sharedPasteMeta && <div className={styles.sharedMeta}>{sharedPasteMeta}</div>}

        <div className={styles.ruleBox}>
          {['입력 데이터 A열 공급처 unique 추출', 'C열 금액 숫자만 합산', '거래처 파일 A열 매칭', '미등록도 결과 시트에 포함'].map((text, i) => (
            <div key={i} className={styles.ruleItem}>
              <span className={styles.ruleNum}>{i + 1}</span>
              {text}
            </div>
          ))}
        </div>
      </section>

      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <div>
            <div className={styles.cardTitleRow}>
              <div className={`${styles.cardIcon} ${styles.cardIconGreen}`}><Database size={16} /></div>
              <h3 className={styles.cardTitle}>거래처계좌데이터 관리</h3>
            </div>
            <p className={styles.cardHint}>표에서 직접 수정하고 저장할 수 있습니다. 추가는 아래 복붙 영역으로 넣습니다.</p>
          </div>
          <div className={styles.headerActions}>
            <button
              type="button"
              className={styles.secondaryBtn}
              onClick={() => setAccountManagerOpen((prev) => !prev)}
            >
              {accountManagerOpen ? <><ChevronUp size={14} /> 접기</> : <><ChevronDown size={14} /> 펼치기</>}
            </button>
            <button type="button" className={styles.secondaryBtn} onClick={fetchAccountRows} disabled={accountLoading}>
              <RefreshCw size={14} />{accountLoading ? '불러오는 중...' : '새로고침'}
            </button>
            <button type="button" className={styles.primaryBtn} onClick={handleSaveAccountRows} disabled={accountSaving}>
              <Save size={14} />{accountSaving ? '저장 중...' : '수정 저장'}
            </button>
          </div>
        </div>

        {accountManagerOpen && (
          <>
            <div className={styles.formGrid}>
              <label className={styles.field}>
                <span className={styles.inputLabel}>검색</span>
                <input
                  className={styles.textInput}
                  value={accountSearch}
                  onChange={(e) => setAccountSearch(e.target.value)}
                  placeholder="A~F 전체 검색"
                />
              </label>
              <div className={styles.searchMeta}>
                <span className={styles.searchCount}>전체 {accountRows.length}행</span>
                <span className={styles.searchCount}>검색 결과 {filteredAccountRows.length}행</span>
              </div>
            </div>

            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th style={{ width: '32px' }} />
                    {ACCOUNT_COLUMNS.map((column) => (
                      <th key={column}>{column}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredAccountRows.map((row) => {
                    const rowIndex = accountRows.findIndex((item) => item.row_index === row.row_index);
                    return (
                      <tr key={row.row_index ?? rowIndex}>
                        <td style={{ textAlign: 'center', padding: '0 4px' }}>
                          <button
                            type="button"
                            title="행 삭제"
                            onClick={() => handleDeleteAccountRow(rowIndex)}
                            style={{
                              background: 'none', border: 'none', cursor: 'pointer',
                              color: 'var(--text-muted)', padding: '2px', lineHeight: 1,
                              display: 'inline-flex', alignItems: 'center',
                            }}
                          >
                            <Trash2 size={13} />
                          </button>
                        </td>
                        {ACCOUNT_COLUMNS.map((column) => (
                          <td key={`${row.row_index ?? rowIndex}-${column}`}>
                            <input
                              className={styles.cellInput}
                              value={row[column] || ''}
                              onChange={(e) => handleAccountCellChange(rowIndex, column, e.target.value)}
                            />
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div style={{ padding: '0.5rem 0 0.25rem' }}>
              <button type="button" className={styles.secondaryBtn} onClick={handleAddAccountRow}>
                <Plus size={13} /> 행 추가
              </button>
            </div>
          </>
        )}

        <label className={styles.field}>
          <span className={styles.inputLabel}>추가 데이터 복붙</span>
          <textarea
            className={styles.textarea}
            value={appendText}
            onChange={(e) => setAppendText(e.target.value)}
            placeholder={'엑셀 복붙 기준 매핑\nA -> 결과 B\nB -> 결과 C\nD -> 결과 A\nE -> 결과 D\nF -> 결과 E\nH -> 결과 F'}
            rows={8}
          />
        </label>

        <div className={styles.optionGrid}>
          <label className={styles.checkboxRow}>
            <input type="checkbox" checked={appendSkipHeader} onChange={(e) => setAppendSkipHeader(e.target.checked)} />
            추가 데이터 첫 행 제외
          </label>
          <button type="button" className={styles.secondaryBtn} onClick={handleAppendAccountRows} disabled={accountSaving}>
            복붙 데이터 추가
          </button>
        </div>

        <div className={styles.ruleBox}>
          {['D → A', 'A → B', 'B → C', 'E → D · F → E · H → F'].map((text, i) => (
            <div key={i} className={styles.ruleItem}>
              <span className={styles.ruleNum}>{i + 1}</span>
              추가 매핑: {text}
            </div>
          ))}
        </div>

        {message && (
          <div className={`${styles.messageBox} ${messageType === 'error' ? styles.messageError : styles.messageOk}`}>
            {messageType === 'error' ? <XCircle size={15} /> : <CheckCircle size={15} />}
            {message}
          </div>
        )}
      </section>

      {summaryItems.length > 0 && (
        <section className={styles.summaryGrid}>
          {summaryItems.map((item) => (
            <article key={item.label} className={styles.summaryCard}>
              <span className={styles.summaryLabel}>{item.label}</span>
              <strong className={styles.summaryValue}>{item.value}</strong>
            </article>
          ))}
        </section>
      )}

      {result && (
        <div className={styles.previewGrid}>
          <section className={styles.card}>
            <div className={styles.cardHeader}>
              <div className={styles.cardTitleRow}>
                <div className={`${styles.cardIcon} ${styles.cardIconBlue}`}><Eye size={16} /></div>
                <h3 className={styles.cardTitle}>결과 미리보기</h3>
              </div>
              <span className={styles.badgeSuccess}>{result.matched.length}건</span>
            </div>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>A</th>
                    <th>B</th>
                    <th>C</th>
                    <th>D</th>
                    <th>E</th>
                    <th>F</th>
                    <th>G</th>
                    <th>H</th>
                    <th>상태</th>
                  </tr>
                </thead>
                <tbody>
                  {result.matched.map((row, index) => (
                    <tr key={`${row.A}-${index}`}>
                      <td>{row.A}</td>
                      <td>{row.B}</td>
                      <td>{formatAmount(row.C)}</td>
                      <td>{row.D}</td>
                      <td>{row.E}</td>
                      <td>{row.F}</td>
                      <td>{row.G}</td>
                      <td>{row.H}</td>
                      <td>{row.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className={styles.card}>
            <div className={styles.cardHeader}>
              <div className={styles.cardTitleRow}>
                <div className={`${styles.cardIcon} ${styles.cardIconAmber}`}><XCircle size={16} /></div>
                <h3 className={styles.cardTitle}>미등록 공급처</h3>
              </div>
              <span className={styles.badgeDanger}>{result.unmatched.length}건</span>
            </div>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>공급처</th>
                    <th>합계금액</th>
                    <th>상태</th>
                  </tr>
                </thead>
                <tbody>
                  {result.unmatched.length ? (
                    result.unmatched.map((row) => (
                      <tr key={row.supplier}>
                        <td>{row.supplier}</td>
                        <td>{formatAmount(row.total_amount)}</td>
                        <td>{row.status}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={3} className={styles.emptyCell}>미등록 공급처가 없습니다.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}
    </div>
  );

  const renderSimpleReceiving = () => (
    <div className={styles.stack}>
      <section className={styles.hero}>
        <div className={styles.heroText}>
          <h2 className={styles.title}>간단입고</h2>
          <p className={styles.subtitle}>발주내역에서 상품을 검색해 담고, 수량을 수정한 뒤 이지어드민 실입고 전표로 바로 처리합니다.</p>
        </div>
        <div className={styles.heroIcon}><PackagePlus size={26} /></div>
      </section>

      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <div>
            <div className={styles.cardTitleRow}>
              <div className={`${styles.cardIcon} ${styles.cardIconBlue}`}><Search size={16} /></div>
              <h3 className={styles.cardTitle}>발주내역 상품 검색</h3>
            </div>
            <p className={styles.cardHint}>
              상품코드, 상품명, 매장명으로 전날({yesterdayLocalDate()}) 발주내역을 검색합니다.
            </p>
          </div>
        </div>

        <label className={styles.field}>
          <span className={styles.inputLabel}>검색어</span>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <input
              ref={receivingSearchInputRef}
              className={styles.textInput}
              value={receivingSearchQuery}
              onChange={(e) => setReceivingSearchQuery(e.target.value)}
              onKeyDown={handleSearchInputKeyDown}
              placeholder="상품코드 / 상품명 / 매장명"
            />
            <button
              type="button"
              className={styles.primaryBtn}
              onClick={searchOrderHistoryForReceiving}
              disabled={receivingSearching}
            >
              <Search size={14} />{receivingSearching ? '검색 중...' : '검색'}
            </button>
          </div>
        </label>

        {receivingSearchResults.length > 0 && (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>상품코드</th>
                  <th>상품명</th>
                  <th>거래처상품명</th>
                  <th>옵션</th>
                  <th>매장</th>
                  <th>담을 수량</th>
                  <th>미송</th>
                  <th>요청메모</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {receivingSearchResults.map((row, index) => {
                  const rowKey = receivingDraftKey({ code: row.product_code, isMisongPickup: isMisongPickupRow(row) });
                  const draftItem = receivingDraft.find((item) => receivingDraftKey(item) === rowKey);
                  const qtyValue = receivingSearchQtyEdits[row.id] ?? row.request_qty ?? 1;
                  const misongValue = receivingSearchMisongEdits[row.id] ?? 0;
                  const memoValue = receivingSearchMemoEdits[row.id] ?? '';
                  return (
                    <tr key={row.id}>
                      <td>{row.product_code || '-'}</td>
                      <td>{row.product_name || row.supply_product_name || '-'}</td>
                      <td>{row.client_product_name || '-'}</td>
                      <td>{row.options || '-'}</td>
                      <td>{row.store_name || '-'}</td>
                      <td>
                        <input
                          ref={(el) => { receivingQtyInputRefs.current[row.id] = el; }}
                          className={styles.cellInput}
                          type="number"
                          min="0"
                          value={qtyValue}
                          onChange={(e) => updateReceivingSearchQty(row.id, e.target.value)}
                          onKeyDown={(e) => handleQtyInputKeyDown(e, index)}
                          style={{ width: '80px' }}
                        />
                      </td>
                      <td>
                        <input
                          ref={(el) => { receivingMisongInputRefs.current[row.id] = el; }}
                          className={styles.cellInput}
                          type="number"
                          min="0"
                          value={misongValue}
                          onChange={(e) => updateReceivingSearchMisong(row.id, e.target.value)}
                          onKeyDown={(e) => handleMisongInputKeyDown(e, index)}
                          style={{ width: '80px' }}
                        />
                      </td>
                      <td>
                        <input
                          ref={(el) => { receivingMemoInputRefs.current[row.id] = el; }}
                          className={styles.cellInput}
                          value={memoValue}
                          onChange={(e) => updateReceivingSearchMemo(row.id, e.target.value)}
                          onKeyDown={(e) => handleMemoInputKeyDown(e, index)}
                          placeholder="요청메모"
                          style={{ width: '120px' }}
                        />
                      </td>
                      <td>
                        <button
                          type="button"
                          className={styles.secondaryBtn}
                          disabled={!row.product_code}
                          onClick={() => addToReceivingDraft(row, qtyValue, misongValue, index, memoValue)}
                        >
                          {draftItem ? `담기 (담김 ${draftItem.qty})` : '담기'}
                        </button>
                        {draftItem && (
                          <button
                            type="button"
                            className={styles.dangerBtn}
                            title="담긴 목록에서 빼기"
                            onClick={() => removeReceivingDraftItem(rowKey)}
                            style={{ marginLeft: '0.25rem' }}
                          >
                            <Trash2 size={13} />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className={styles.headerActions} style={{ marginTop: '0.5rem' }}>
          <button
            ref={receivingBarcodePrintBtnRef}
            type="button"
            className={styles.secondaryBtn}
            disabled={receivingPrintBatchKeys.size === 0}
            onClick={handleSimpleReceivingBarcodePrint}
            onKeyDown={(e) => {
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                if (!focusReceivingQtyInputAt(receivingSearchResults.length - 1, -1)) {
                  receivingSearchInputRef.current?.focus();
                  receivingSearchInputRef.current?.select();
                }
              }
            }}
          >
            {`바코드 출력${receivingPrintBatchKeys.size ? ` (${receivingPrintBatchKeys.size}건)` : ''}`}
          </button>
          {receivingPrintBatchKeys.size === 0 && (
            <span className={styles.cardHint}>이번 검색에서 담은 상품이 있어야 바코드 출력을 쓸 수 있습니다.</span>
          )}
        </div>
      </section>

      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <div>
            <div className={styles.cardTitleRow}>
              <div className={`${styles.cardIcon} ${styles.cardIconGreen}`}><Database size={16} /></div>
              <h3 className={styles.cardTitle}>원가베이스유 상품 검색</h3>
            </div>
            <p className={styles.cardHint}>
              발주내역과 상관없이 원가베이스유 DB에서 상품코드/상품명/거래처로 바로 검색해 담습니다.
            </p>
          </div>
        </div>

        <label className={styles.field}>
          <span className={styles.inputLabel}>검색어</span>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <input
              ref={wonbeSearchInputRef}
              className={styles.textInput}
              value={wonbeSearchQuery}
              onChange={(e) => setWonbeSearchQuery(e.target.value)}
              onKeyDown={handleWonbeSearchInputKeyDown}
              placeholder="상품코드 / 상품명 / 거래처"
            />
            <button
              type="button"
              className={styles.primaryBtn}
              onClick={searchWonbeForReceiving}
              disabled={wonbeSearching}
            >
              <Search size={14} />{wonbeSearching ? '검색 중...' : '검색'}
            </button>
          </div>
        </label>

        {wonbeSearchResults.length > 0 && (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>상품코드</th>
                  <th>상품명</th>
                  <th>거래처상품명</th>
                  <th>옵션</th>
                  <th>거래처</th>
                  <th>담을 수량</th>
                  <th>미송</th>
                  <th>요청메모</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {wonbeSearchResults.map((row, index) => {
                  const code = row['상품코드'] || '';
                  const rowKey = receivingDraftKey({ code, isMisongPickup: false });
                  const draftItem = receivingDraft.find((item) => receivingDraftKey(item) === rowKey);
                  const qtyValue = wonbeSearchQtyEdits[code] ?? 1;
                  const misongValue = wonbeSearchMisongEdits[code] ?? 0;
                  const memoValue = wonbeSearchMemoEdits[code] ?? '';
                  const option = [row['색상'], row['사이즈']].filter(Boolean).join(' ');
                  return (
                    <tr key={code || index}>
                      <td>{code || '-'}</td>
                      <td>{row['상품명'] || row['상품명합'] || '-'}</td>
                      <td>{row['거래처상품명'] || '-'}</td>
                      <td>{option || '-'}</td>
                      <td>{row['거래처'] || '-'}</td>
                      <td>
                        <input
                          ref={(el) => { wonbeQtyInputRefs.current[code] = el; }}
                          className={styles.cellInput}
                          type="number"
                          min="0"
                          value={qtyValue}
                          onChange={(e) => updateWonbeSearchQty(code, e.target.value)}
                          onKeyDown={(e) => handleWonbeQtyInputKeyDown(e, index)}
                          style={{ width: '80px' }}
                        />
                      </td>
                      <td>
                        <input
                          ref={(el) => { wonbeMisongInputRefs.current[code] = el; }}
                          className={styles.cellInput}
                          type="number"
                          min="0"
                          value={misongValue}
                          onChange={(e) => updateWonbeSearchMisong(code, e.target.value)}
                          onKeyDown={(e) => handleWonbeMisongInputKeyDown(e, index)}
                          style={{ width: '80px' }}
                        />
                      </td>
                      <td>
                        <input
                          ref={(el) => { wonbeMemoInputRefs.current[code] = el; }}
                          className={styles.cellInput}
                          value={memoValue}
                          onChange={(e) => updateWonbeSearchMemo(code, e.target.value)}
                          onKeyDown={(e) => handleWonbeMemoInputKeyDown(e, index)}
                          placeholder="요청메모"
                          style={{ width: '120px' }}
                        />
                      </td>
                      <td>
                        <button
                          type="button"
                          className={styles.secondaryBtn}
                          disabled={!code}
                          onClick={() => addWonbeRowToDraft(row, qtyValue, misongValue, index, memoValue)}
                        >
                          {draftItem ? `담기 (담김 ${draftItem.qty})` : '담기'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className={styles.headerActions} style={{ marginTop: '0.5rem' }}>
          <button
            ref={wonbeBarcodePrintBtnRef}
            type="button"
            className={styles.secondaryBtn}
            disabled={receivingPrintBatchKeys.size === 0}
            onClick={handleSimpleReceivingBarcodePrint}
            onKeyDown={(e) => {
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                if (!focusWonbeQtyInputAt(wonbeSearchResults.length - 1, -1)) {
                  wonbeSearchInputRef.current?.focus();
                  wonbeSearchInputRef.current?.select();
                }
              }
            }}
          >
            {`바코드 출력${receivingPrintBatchKeys.size ? ` (${receivingPrintBatchKeys.size}건)` : ''}`}
          </button>
          {receivingPrintBatchKeys.size === 0 && (
            <span className={styles.cardHint}>이번 검색에서 담은 상품이 있어야 바코드 출력을 쓸 수 있습니다.</span>
          )}
        </div>
      </section>

      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <div>
            <div className={styles.cardTitleRow}>
              <div className={`${styles.cardIcon} ${styles.cardIconGreen}`}><PackagePlus size={16} /></div>
              <h3 className={styles.cardTitle}>입고 목록</h3>
            </div>
            <p className={styles.cardHint}>
              수량을 수정한 뒤 입고전표 생성을 누르면 이지어드민에 실입고로 반영됩니다.
              미송 수량은 전표의 요청수량으로, 담을 수량은 입고수량으로 들어갑니다.
              담당자 탭을 나눠서 저장/불러오기하면 여러 명이 동시에 각자 목록을 채울 수 있습니다.
            </p>
          </div>
          <div className={styles.headerActions}>
            <input
              className={styles.textInput}
              value={receivingSheetTitle}
              onChange={(e) => setReceivingSheetTitle(e.target.value)}
              placeholder={`전표 이름 (미입력 시 "${DEFAULT_SIMPLE_RECEIVING_SHEET_TITLE}")`}
              style={{ width: '160px' }}
            />
            <button
              type="button"
              className={styles.primaryBtn}
              onClick={applyReceiving}
              disabled={receivingApplying || receivingDraft.length === 0}
            >
              <ArrowDownToLine size={14} />
              {receivingApplying ? '입고 처리 중...' : `입고전표 생성 (${receivingDraft.length}건)`}
            </button>
          </div>
        </div>

        <div className={styles.inputLabelRow}>
          <span className={styles.inputLabel}>담당자 탭</span>
          <div className={styles.slotTabs} aria-label="공용 입고목록 슬롯">
            {SHARED_PASTE_SLOTS.map((slot) => (
              <button
                key={slot}
                type="button"
                className={`${styles.slotTab} ${receivingDraftSlot === slot ? styles.slotTabActive : ''}`}
                onClick={() => {
                  setReceivingDraftSlot(slot);
                  setReceivingDraftSlotMeta('');
                }}
              >
                {getSharedPasteSlotLabel(slot)}
              </button>
            ))}
          </div>
        </div>
        <div className={styles.headerActions} style={{ marginBottom: '0.5rem' }}>
          <button
            type="button"
            className={styles.secondaryBtn}
            onClick={handleLoadSharedReceivingDraft}
            disabled={receivingDraftSlotLoading}
          >
            <Download size={14} />{receivingDraftSlotLoading ? '불러오는 중...' : '공용 불러오기'}
          </button>
          <button
            type="button"
            className={styles.secondaryBtn}
            onClick={handleSaveSharedReceivingDraft}
            disabled={receivingDraftSlotSaving}
          >
            <Upload size={14} />{receivingDraftSlotSaving ? '저장 중...' : '공용 저장'}
          </button>
          {receivingDraftSlotMeta && <span className={styles.sharedMeta}>{receivingDraftSlotMeta}</span>}
        </div>

        {receivingDraft.length === 0 ? (
          <p className={styles.cardHint}>담은 상품이 없습니다. 위에서 검색 후 담아주세요.</p>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>상품코드</th>
                  <th>상품명</th>
                  <th>거래처상품명</th>
                  <th>매장</th>
                  <th>수량</th>
                  <th>미송</th>
                  <th>요청메모</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {receivingDraft.map((item) => (
                  <tr key={receivingDraftKey(item)}>
                    <td>{item.code}</td>
                    <td>
                      {item.name || '-'}{item.options ? ` (${item.options})` : ''}
                      {item.isMisongPickup && (
                        <span className={styles.badgeSuccess} style={{ marginLeft: '0.35rem' }}>
                          미송픽업
                        </span>
                      )}
                    </td>
                    <td>{item.clientProductName || '-'}</td>
                    <td>{item.storeName || '-'}</td>
                    <td>
                      <input
                        className={styles.cellInput}
                        type="number"
                        min="0"
                        value={item.qty}
                        onChange={(e) => updateReceivingDraftQty(receivingDraftKey(item), e.target.value)}
                        onKeyDown={(e) => handleDraftQtyInputKeyDown(e, receivingDraftKey(item))}
                        style={{ width: '80px' }}
                      />
                    </td>
                    <td>
                      <input
                        className={styles.cellInput}
                        type="number"
                        min="0"
                        value={item.misongQty || 0}
                        onChange={(e) => updateReceivingDraftMisongQty(receivingDraftKey(item), e.target.value)}
                        onKeyDown={(e) => handleDraftMisongInputKeyDown(e, receivingDraftKey(item))}
                        style={{ width: '80px' }}
                      />
                    </td>
                    <td>
                      <input
                        className={styles.cellInput}
                        value={item.memo || ''}
                        onChange={(e) => updateReceivingDraftMemo(receivingDraftKey(item), e.target.value)}
                        placeholder="요청메모"
                        style={{ width: '120px' }}
                      />
                    </td>
                    <td>
                      <button
                        type="button"
                        className={styles.dangerBtn}
                        title="목록에서 제거"
                        onClick={() => removeReceivingDraftItem(receivingDraftKey(item))}
                      >
                        <Trash2 size={13} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {receivingMessage && (
          <div className={`${styles.messageBox} ${receivingMessageType === 'error' ? styles.messageError : styles.messageOk}`}>
            {receivingMessageType === 'error' ? <XCircle size={15} /> : <CheckCircle size={15} />}
            {receivingMessage}
          </div>
        )}
      </section>
    </div>
  );

  return (
    <div className={styles.page}>
      <div className={styles.tabs}>
        {TOOL_TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            className={`${styles.tabBtn} ${activeTab === tab.key ? styles.tabActive : ''}`}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'purchase-deduction' && renderPurchaseDeduction()}
      {activeTab === 'simple-receiving' && renderSimpleReceiving()}
    </div>
  );
}
