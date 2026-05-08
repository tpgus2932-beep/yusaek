import React, { useEffect, useMemo, useState } from 'react';
import styles from './CollaborationMenuPage.module.css';
import { LOCAL_API_BASE, getAuthHeaders, handleUnauthorized } from '../../lib/api';
import {
  ArrowDownToLine, CheckCircle, ChevronDown, ChevronUp, Clipboard,
  Database, Download, Eye, FileSpreadsheet, RefreshCw, Save, Upload, XCircle,
} from 'lucide-react';

const TOOL_TABS = [
  { key: 'purchase-deduction', label: '날짜별이체파일 양식' },
  { key: 'vendor-tsv', label: 'TSV Process' },
];

const DEFAULT_ACCOUNT_PATH = String.raw`C:\Users\ksh29\OneDrive\Desktop\원베\거래처계좌데이터.xlsx`;
const ACCOUNT_COLUMNS = ['A', 'B', 'C', 'D', 'E', 'F'];

const formatAmount = (value) =>
  new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2 }).format(Number(value || 0));

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

const TSV_CHUNK_SIZE = 9;

const parseLooseNumber = (value) => {
  const normalized = String(value ?? '')
    .replace(/,/g, '')
    .replace(/[^\d.-]/g, '')
    .trim();
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
};

const parseVendorRows = (text) => {
  const normalized = String(text || '').replace(/\r/g, '').trim();
  if (!normalized) return [];

  const lines = normalized
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  if (!lines.length) return [];

  if (lines.some((line) => line.includes('\t'))) {
    return lines
      .map((line) => line.split('\t').map((cell) => cell.trim()))
      .filter((row) => row.some((cell) => cell));
  }

  const rows = [];
  for (let i = 0; i < lines.length; i += TSV_CHUNK_SIZE) {
    rows.push(lines.slice(i, i + TSV_CHUNK_SIZE));
  }
  return rows;
};

const buildVendorSummaryRows = (text) => {
  const rows = parseVendorRows(text);
  if (!rows.length) {
    throw new Error('붙여넣은 데이터가 없습니다.');
  }

  const invalidRowIndex = rows.findIndex((row) => row.length < 8);
  if (invalidRowIndex >= 0) {
    throw new Error(`${invalidRowIndex + 1}번째 줄 묶음의 컬럼 수가 부족합니다.`);
  }

  const grouped = new Map();

  rows.forEach((row) => {
    const vendor = String(row[3] || '').trim();
    if (!vendor) return;

    const current = grouped.get(vendor) || {
      A: vendor,
      B: 0,
      C: String(row[7] || '').trim(),
      D: String(row[1] || '').trim(),
      E: String(row[5] || '').trim(),
    };

    current.B += parseLooseNumber(row[2]);
    if (!current.C && row[7]) current.C = String(row[7]).trim();
    if (!current.D && row[1]) current.D = String(row[1]).trim();
    if (!current.E && row[5]) current.E = String(row[5]).trim();

    grouped.set(vendor, current);
  });

  return Array.from(grouped.values());
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
  const [activeTab, setActiveTab] = useState('purchase-deduction');
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
  const [sharedPasteMeta, setSharedPasteMeta] = useState('');
  const [accountRows, setAccountRows] = useState([]);
  const [accountLoading, setAccountLoading] = useState(false);
  const [accountSaving, setAccountSaving] = useState(false);
  const [accountManagerOpen, setAccountManagerOpen] = useState(false);
  const [accountSearch, setAccountSearch] = useState('');
  const [appendText, setAppendText] = useState('');
  const [appendSkipHeader, setAppendSkipHeader] = useState(false);
  const [vendorText, setVendorText] = useState('');
  const [vendorRows, setVendorRows] = useState([]);
  const [vendorCopying, setVendorCopying] = useState(false);
  const [vendorMessage, setVendorMessage] = useState('');
  const [vendorMessageType, setVendorMessageType] = useState('');

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

  const vendorSummary = useMemo(() => {
    const totalAmount = vendorRows.reduce((sum, row) => sum + Number(row.B || 0), 0);
    return {
      rowCount: vendorRows.length,
      totalAmount,
    };
  }, [vendorRows]);

  const vendorCopyText = useMemo(() => {
    if (!vendorRows.length) return '';
    const lines = vendorRows.map((row) => [
        toExcelTextCell(row.A),
        String(row.B),
        toExcelTextCell(row.C),
        toExcelTextCell(row.D),
        toExcelTextCell(row.E),
      ].join('\t'));
    return lines.join('\n');
  }, [vendorRows]);

  const setFeedback = (type, nextMessage) => {
    setMessageType(type);
    setMessage(nextMessage);
  };

  const setVendorFeedback = (type, nextMessage) => {
    setVendorMessageType(type);
    setVendorMessage(nextMessage);
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

  const handleLoadSharedPaste = async () => {
    try {
      setSharedPasteLoading(true);
      const res = await fetch(`${LOCAL_API_BASE}/collaboration-tools/purchase-deduction/shared-paste`, {
        headers: getAuthHeaders(),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) {
        throw new Error(data.detail || '공용 복붙 데이터를 불러오지 못했습니다.');
      }
      setPastedText(data.pasted_text || '');
      setSharedPasteMeta(data.updated_by ? `최근 저장: ${data.updated_by}` : '공용 데이터 없음');
      setFeedback('ok', '공용 복붙 데이터를 불러왔습니다.');
    } catch (error) {
      setFeedback('error', error.message || '공용 복붙 데이터를 불러오지 못했습니다.');
    } finally {
      setSharedPasteLoading(false);
    }
  };

  const handleSaveSharedPaste = async () => {
    try {
      setSharedPasteSaving(true);
      const res = await fetch(`${LOCAL_API_BASE}/collaboration-tools/purchase-deduction/shared-paste`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ pasted_text: pastedText }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) {
        throw new Error(data.detail || '공용 복붙 데이터 저장에 실패했습니다.');
      }
      setSharedPasteMeta(data.updated_by ? `최근 저장: ${data.updated_by}` : '');
      setFeedback('ok', '공용 복붙 데이터를 저장했습니다.');
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
      } catch (_) {
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

  const handleVendorProcess = () => {
    try {
      const nextRows = buildVendorSummaryRows(vendorText);
      setVendorRows(nextRows);
      setVendorFeedback('ok', `${nextRows.length}건의 고유 D값으로 가공했습니다.`);
    } catch (error) {
      setVendorRows([]);
      setVendorFeedback('error', error.message || 'TSV 가공에 실패했습니다.');
    }
  };

  const handleVendorCopy = async () => {
    if (!vendorCopyText) {
      setVendorFeedback('error', '먼저 가공을 실행해주세요.');
      return;
    }
    try {
      setVendorCopying(true);
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(vendorCopyText);
        } else {
          fallbackCopyText(vendorCopyText);
        }
      } catch (_) {
        fallbackCopyText(vendorCopyText);
      }
      setVendorFeedback('ok', '가공 결과를 클립보드에 복사했습니다.');
    } catch (error) {
      setVendorFeedback('error', error.message || '가공 결과 복사에 실패했습니다.');
    } finally {
      setVendorCopying(false);
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
          <span className={styles.inputLabel}>입력 데이터 복붙</span>
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

  const renderVendorTsv = () => (
    <div className={styles.stack}>
      <section className={styles.hero}>
        <div className={styles.heroText}>
          <h2 className={styles.title}>TSV 가공</h2>
          <p className={styles.subtitle}>D열을 기준으로 C열을 합산하고, H/B/F 열을 지정 순서로 재배치해서 바로 복사할 수 있게 만듭니다.</p>
        </div>
        <div className={styles.heroIcon}><Clipboard size={26} /></div>
      </section>

      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <div>
            <div className={styles.cardTitleRow}>
              <div className={`${styles.cardIcon} ${styles.cardIconBlue}`}><FileSpreadsheet size={16} /></div>
              <h3 className={styles.cardTitle}>붙여넣기 데이터 가공</h3>
            </div>
            <p className={styles.cardHint}>TSV 붙여넣기와 9줄 반복 붙여넣기를 모두 지원합니다. 같은 D열 값은 한 줄로 합쳐집니다.</p>
          </div>
          <div className={styles.headerActions}>
            <button type="button" className={styles.primaryBtn} onClick={handleVendorProcess}>
              <Eye size={14} />가공
            </button>
            <button
              type="button"
              className={styles.secondaryBtn}
              onClick={handleVendorCopy}
              disabled={vendorCopying || !vendorRows.length}
            >
              <Clipboard size={14} />{vendorCopying ? '복사 중...' : '결과 복사'}
            </button>
          </div>
        </div>

        <label className={styles.field}>
          <span className={styles.inputLabel}>TSV / 9줄 묶음 원본</span>
          <textarea
            className={styles.textarea}
            value={vendorText}
            onChange={(e) => setVendorText(e.target.value)}
            placeholder={'020\t1005504775443\t71000\t히피스\t우리\t이도영(히피스)\tㅇ\tX\t12월 01일\n...\n\n탭 없이 셀값이 한 줄씩 내려오는 9줄 반복도 가능합니다.'}
            rows={12}
          />
        </label>

        <div className={styles.ruleBox}>
          {[
            '같은 D열 데이터는 하나로 합칩니다.',
            '출력 A열은 고유한 D열 값입니다.',
            '출력 B열은 D별 C열 합계입니다.',
            '출력 C/D/E열은 H/B/F열 순서로 채웁니다.',
          ].map((text, i) => (
            <div key={i} className={styles.ruleItem}>
              <span className={styles.ruleNum}>{i + 1}</span>
              {text}
            </div>
          ))}
        </div>

        {vendorMessage && (
          <div className={`${styles.messageBox} ${vendorMessageType === 'error' ? styles.messageError : styles.messageOk}`}>
            {vendorMessageType === 'error' ? <XCircle size={15} /> : <CheckCircle size={15} />}
            {vendorMessage}
          </div>
        )}
      </section>

      {vendorRows.length > 0 && (
        <>
          <section className={styles.summaryGrid}>
            <article className={styles.summaryCard}>
              <span className={styles.summaryLabel}>UNIQUE D</span>
              <strong className={styles.summaryValue}>{vendorSummary.rowCount}건</strong>
            </article>
            <article className={styles.summaryCard}>
              <span className={styles.summaryLabel}>SUM C</span>
              <strong className={styles.summaryValue}>{formatAmount(vendorSummary.totalAmount)}원</strong>
            </article>
          </section>

          <section className={styles.card}>
            <div className={styles.cardHeader}>
              <div>
                <div className={styles.cardTitleRow}>
                  <div className={`${styles.cardIcon} ${styles.cardIconGreen}`}><Eye size={16} /></div>
                  <h3 className={styles.cardTitle}>가공 결과</h3>
                </div>
                <p className={styles.cardHint}>A=unique D, B=sum C, C=H, D=B, E=F</p>
              </div>
              <span className={styles.badgeSuccess}>{vendorRows.length}건</span>
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
                  </tr>
                </thead>
                <tbody>
                  {vendorRows.map((row, index) => (
                    <tr key={`${row.A}-${index}`}>
                      <td>{row.A}</td>
                      <td>{formatAmount(row.B)}</td>
                      <td>{row.C}</td>
                      <td>{row.D}</td>
                      <td>{row.E}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className={styles.card}>
            <div className={styles.cardHeader}>
              <div>
                <div className={styles.cardTitleRow}>
                  <div className={`${styles.cardIcon} ${styles.cardIconAmber}`}><Clipboard size={16} /></div>
                  <h3 className={styles.cardTitle}>복사용 텍스트</h3>
                </div>
                <p className={styles.cardHint}>엑셀에 바로 붙여넣을 수 있는 TSV 결과입니다.</p>
              </div>
            </div>
            <textarea className={styles.textarea} value={vendorCopyText} readOnly rows={8} />
          </section>
        </>
      )}
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
      {activeTab === 'vendor-tsv' && renderVendorTsv()}
    </div>
  );
}
