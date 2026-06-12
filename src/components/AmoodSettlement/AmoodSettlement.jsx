import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Database, Download, Plus, Save, Trash2, Upload } from 'lucide-react';
import { LOCAL_API_BASE, getAuthHeaders, handleUnauthorized } from '../../lib/api';
import styles from './AmoodSettlement.module.css';

const API = LOCAL_API_BASE;

function fmt(n) {
  if (n == null) return '-';
  return Number(n).toLocaleString('ko-KR') + '원';
}

function fmtRate(r) {
  if (r == null) return '-';
  return r.toFixed(1) + '%';
}

// ─── 정산 조회 탭 ────────────────────────────────────────────────────────────

const SORT_COLS = [
  { key: 'product_name',        label: '상품명',     num: false },
  { key: 'order_count',         label: '주문수',     num: true  },
  { key: 'total_quantity',      label: '수량',       num: true  },
  { key: 'total_settlement_krw',label: '정산금액',   num: true  },
  { key: 'cost_price',          label: '원가/개',    num: true  },
  { key: 'total_vat',           label: '부가세',     num: true  },
  { key: 'total_extra_cost',    label: '택배+포장',  num: true  },
  { key: 'total_margin',        label: '마진',       num: true  },
  { key: 'margin_rate',         label: '마진율',     num: true  },
];

function ResultTable({ items }) {
  const [expanded, setExpanded] = useState({});
  const [sortKey, setSortKey] = useState(null);
  const [sortAsc, setSortAsc] = useState(true);

  const toggle = (name) => setExpanded((prev) => ({ ...prev, [name]: !prev[name] }));

  const handleSort = (key) => {
    if (sortKey === key) setSortAsc((v) => !v);
    else { setSortKey(key); setSortAsc(true); }
  };

  const sorted = React.useMemo(() => {
    if (!sortKey) return items;
    return [...items].sort((a, b) => {
      const av = a[sortKey] ?? (typeof a[sortKey] === 'number' ? -Infinity : '');
      const bv = b[sortKey] ?? (typeof b[sortKey] === 'number' ? -Infinity : '');
      const col = SORT_COLS.find((c) => c.key === sortKey);
      let cmp;
      if (col?.num) {
        cmp = (av === null || av === undefined ? -Infinity : av) -
              (bv === null || bv === undefined ? -Infinity : bv);
      } else {
        cmp = String(av).localeCompare(String(bv), 'ko');
      }
      return sortAsc ? cmp : -cmp;
    });
  }, [items, sortKey, sortAsc]);

  const sortIcon = (key) => {
    if (sortKey !== key) return <span className={styles.sortNeutral}>↕</span>;
    return <span className={styles.sortActive}>{sortAsc ? '↑' : '↓'}</span>;
  };

  return (
    <div className={styles.tableWrapper}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th style={{ width: 28 }} />
            {SORT_COLS.map((col) => (
              <th
                key={col.key}
                className={styles.sortable}
                onClick={() => handleSort(col.key)}
              >
                {col.label} {sortIcon(col.key)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((item) => {
            const isOpen = !!expanded[item.product_name];
            return (
              <React.Fragment key={item.product_name}>
                <tr className={!item.matched ? styles.unmatched : ''}>
                  <td>
                    <button className={styles.expandBtn} onClick={() => toggle(item.product_name)}>
                      {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </button>
                  </td>
                  <td className={styles.productName}>{item.product_name}</td>
                  <td className={styles.num}>{item.order_count}</td>
                  <td className={styles.num}>{item.total_quantity}</td>
                  <td className={styles.num}>{fmt(item.total_settlement_krw)}</td>
                  <td className={styles.num}>{item.cost_price != null ? fmt(item.cost_price) : <span className={styles.tag}>미등록</span>}</td>
                  <td className={styles.num}>{fmt(item.total_vat)}</td>
                  <td className={styles.num}>{fmt(item.total_extra_cost)}</td>
                  <td className={`${styles.num} ${item.total_margin != null ? (item.total_margin >= 0 ? styles.positive : styles.negative) : ''}`}>
                    {fmt(item.total_margin)}
                  </td>
                  <td className={`${styles.num} ${item.margin_rate != null ? (item.margin_rate >= 0 ? styles.positive : styles.negative) : ''}`}>
                    {fmtRate(item.margin_rate)}
                  </td>
                </tr>
                {isOpen && (item.orders || []).map((o) => (
                  <tr key={o.order_id} className={styles.orderRow}>
                    <td />
                    <td className={styles.orderIdCell}>
                      <span className={styles.orderIdBadge}>#{o.order_id}</span>
                    </td>
                    <td className={styles.num}>{o.quantity}개</td>
                    <td />
                    <td className={styles.num}>{fmt(o.settlement_krw)}</td>
                    <td colSpan={5} />
                  </tr>
                ))}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function toYearMonth(offset = 0) {
  const d = new Date();
  d.setMonth(d.getMonth() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

const LS = {
  get: (k, fallback) => { try { const v = localStorage.getItem(k); return v != null ? JSON.parse(v) : fallback; } catch { return fallback; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

function SettlementView() {
  const [start, setStart] = useState(() => LS.get('amood_start', toYearMonth(-12)));
  const [end, setEnd] = useState(() => LS.get('amood_end', toYearMonth(0)));
  const [histories, setHistories] = useState(() => LS.get('amood_histories', []));
  const [historiesLoading, setHistoriesLoading] = useState(false);
  const [selectedId, setSelectedId] = useState(() => LS.get('amood_selectedId', ''));
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(() => LS.get('amood_result', null));
  const [error, setError] = useState('');

  useEffect(() => { LS.set('amood_start', start); }, [start]);
  useEffect(() => { LS.set('amood_end', end); }, [end]);
  useEffect(() => { LS.set('amood_histories', histories); }, [histories]);
  useEffect(() => { LS.set('amood_selectedId', selectedId); }, [selectedId]);
  useEffect(() => { LS.set('amood_result', result); }, [result]);

  const loadHistories = async () => {
    setHistoriesLoading(true);
    setError('');
    setHistories([]);
    setSelectedId('');
    setResult(null);
    try {
      const res = await fetch(
        `${API}/amood-settlement/histories?start=${start}&end=${end}`,
        { headers: getAuthHeaders() }
      );
      if (handleUnauthorized(res)) return;
      const data = await res.json();
      if (!data.ok) throw new Error(data.detail || '목록 조회 실패');
      const list = data.histories || [];
      setHistories(list);
      const firstAvailable = list.find((h) => h.is_file_available?.settlement_detail);
      if (firstAvailable) setSelectedId(String(firstAvailable.id));
      else if (list.length > 0) setSelectedId(String(list[0].id ?? ''));
    } catch (e) {
      setError(e.message);
    } finally {
      setHistoriesLoading(false);
    }
  };

  const handleFetch = async () => {
    if (!selectedId) { setError('정산 회차를 선택하세요'); return; }
    setError('');
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch(`${API}/amood-settlement/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ history_id: selectedId }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json();
      if (!data.ok) throw new Error(data.detail || '처리 실패');
      setResult(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={styles.tabContent}>
      <div className={styles.inputSection}>
        <div className={styles.inputRow}>
          <label>조회 기간</label>
          <div className={styles.dateRangeRow}>
            <input
              className={styles.monthInput}
              type="month"
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
            <span>~</span>
            <input
              className={styles.monthInput}
              type="month"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
            />
            <button className={styles.primaryBtn} onClick={loadHistories} disabled={historiesLoading}>
              {historiesLoading ? '조회 중...' : '목록 불러오기'}
            </button>
          </div>
        </div>

        {histories.length > 0 && (
          <div className={styles.inputRow}>
            <label>정산 회차 선택</label>
            <div className={styles.selectRow}>
              <select
                className={styles.historySelect}
                value={selectedId}
                onChange={(e) => setSelectedId(e.target.value)}
              >
                {histories.map((h) => {
                  const fileOk = h.is_file_available?.settlement_detail;
                  return (
                    <option key={h.id} value={String(h.id)} disabled={!fileOk}>
                      {h.base_month} (정산일 {h.settled_date}){fileOk ? '' : ' — 파일 미준비'}
                    </option>
                  );
                })}
              </select>
            </div>
          </div>
        )}

        {histories.length > 0 && (
          <button className={styles.primaryBtn} onClick={handleFetch} disabled={loading || !selectedId}>
            <Download size={16} />
            {loading ? '처리 중...' : '마진 계산'}
          </button>
        )}
        {error && <p className={styles.error}>{error}</p>}
      </div>

      {loading && (
        <div className={styles.loadingBox}>
          <div className={styles.spinner} />
          <span>정산 CSV 다운로드 후 주문 상세 일괄 조회 중...</span>
        </div>
      )}

      {result && (
        <>
          <div className={styles.summaryCards}>
            <div className={styles.card}>
              <span className={styles.cardLabel}>총 주문 수</span>
              <span className={styles.cardValue}>{result.summary.total_orders?.toLocaleString()}</span>
            </div>
            <div className={styles.card}>
              <span className={styles.cardLabel}>총 정산금액</span>
              <span className={styles.cardValue}>{fmt(result.summary.total_settlement_krw)}</span>
            </div>
            <div className={styles.card}>
              <span className={styles.cardLabel}>총 원가</span>
              <span className={styles.cardValue}>{fmt(result.summary.total_cost)}</span>
            </div>
            <div className={styles.card}>
              <span className={styles.cardLabel}>총 마진</span>
              <span className={styles.cardValue + ' ' + (result.summary.total_margin >= 0 ? styles.positive : styles.negative)}>
                {fmt(result.summary.total_margin)}
              </span>
            </div>
            <div className={styles.card}>
              <span className={styles.cardLabel}>전체 마진율</span>
              <span className={styles.cardValue + ' ' + (result.summary.overall_margin_rate >= 0 ? styles.positive : styles.negative)}>
                {fmtRate(result.summary.overall_margin_rate)}
              </span>
            </div>
            {result.summary.unmatched_count > 0 && (
              <div className={styles.card + ' ' + styles.cardWarn}>
                <span className={styles.cardLabel}>원가 미등록</span>
                <span className={styles.cardValue}>{result.summary.unmatched_count}개 상품</span>
              </div>
            )}
          </div>

          <ResultTable items={result.items} />
        </>
      )}
    </div>
  );
}

// ─── 에이블리 정산 조회 탭 ────────────────────────────────────────────────────

function AblySettlementView() {
  const [start, setStart] = useState(() => LS.get('ably_start', toYearMonth(-12)));
  const [end, setEnd] = useState(() => LS.get('ably_end', toYearMonth(0)));
  const [histories, setHistories] = useState(() => LS.get('ably_histories', []));
  const [historiesLoading, setHistoriesLoading] = useState(false);
  const [selectedSno, setSelectedSno] = useState(() => LS.get('ably_selectedSno', ''));
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(() => LS.get('ably_result', null));
  const [error, setError] = useState('');

  useEffect(() => { LS.set('ably_start', start); }, [start]);
  useEffect(() => { LS.set('ably_end', end); }, [end]);
  useEffect(() => { LS.set('ably_histories', histories); }, [histories]);
  useEffect(() => { LS.set('ably_selectedSno', selectedSno); }, [selectedSno]);
  useEffect(() => { LS.set('ably_result', result); }, [result]);

  const loadHistories = async () => {
    setHistoriesLoading(true);
    setError('');
    setHistories([]);
    setSelectedSno('');
    setResult(null);
    try {
      const res = await fetch(
        `${API}/ably-settlement/histories?start=${start}&end=${end}`,
        { headers: getAuthHeaders() }
      );
      if (handleUnauthorized(res)) return;
      const data = await res.json();
      if (!data.ok) throw new Error(data.detail || '목록 조회 실패');
      const list = data.histories || [];
      setHistories(list);
      if (list.length > 0) setSelectedSno(String(list[0].sno ?? ''));
    } catch (e) {
      setError(e.message);
    } finally {
      setHistoriesLoading(false);
    }
  };

  const handleFetch = async () => {
    if (!selectedSno) { setError('정산 회차를 선택하세요'); return; }
    setError('');
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch(`${API}/ably-settlement/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ sno: selectedSno }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json();
      if (!data.ok) throw new Error(data.detail || '처리 실패');
      setResult(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={styles.tabContent}>
      <div className={styles.inputSection}>
        <div className={styles.inputRow}>
          <label>조회 기간</label>
          <div className={styles.dateRangeRow}>
            <input
              className={styles.monthInput}
              type="month"
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
            <span>~</span>
            <input
              className={styles.monthInput}
              type="month"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
            />
            <button className={styles.primaryBtn} onClick={loadHistories} disabled={historiesLoading}>
              {historiesLoading ? '조회 중...' : '목록 불러오기'}
            </button>
          </div>
        </div>

        {histories.length > 0 && (
          <div className={styles.inputRow}>
            <label>정산 회차 선택</label>
            <div className={styles.selectRow}>
              <select
                className={styles.historySelect}
                value={selectedSno}
                onChange={(e) => setSelectedSno(e.target.value)}
              >
                {histories.map((h) => (
                  <option key={h.sno} value={String(h.sno)}>
                    {h.scheduled_at} (정산기간 {h.settled_at}~)
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}

        {histories.length > 0 && (
          <button className={styles.primaryBtn} onClick={handleFetch} disabled={loading || !selectedSno}>
            <Download size={16} />
            {loading ? '처리 중...' : '마진 계산'}
          </button>
        )}
        {error && <p className={styles.error}>{error}</p>}
      </div>

      {loading && (
        <div className={styles.loadingBox}>
          <div className={styles.spinner} />
          <span>정산 CSV 다운로드 후 주문 상세 일괄 조회 중...</span>
        </div>
      )}

      {result && (
        <>
          <div className={styles.summaryCards}>
            <div className={styles.card}>
              <span className={styles.cardLabel}>총 주문 수</span>
              <span className={styles.cardValue}>{result.summary.total_orders?.toLocaleString()}</span>
            </div>
            <div className={styles.card}>
              <span className={styles.cardLabel}>총 정산금액</span>
              <span className={styles.cardValue}>{fmt(result.summary.total_settlement_krw)}</span>
            </div>
            <div className={styles.card}>
              <span className={styles.cardLabel}>총 원가</span>
              <span className={styles.cardValue}>{fmt(result.summary.total_cost)}</span>
            </div>
            <div className={styles.card}>
              <span className={styles.cardLabel}>총 마진</span>
              <span className={`${styles.cardValue} ${result.summary.total_margin >= 0 ? styles.positive : styles.negative}`}>
                {fmt(result.summary.total_margin)}
              </span>
            </div>
            <div className={styles.card}>
              <span className={styles.cardLabel}>전체 마진율</span>
              <span className={`${styles.cardValue} ${result.summary.overall_margin_rate >= 0 ? styles.positive : styles.negative}`}>
                {fmtRate(result.summary.overall_margin_rate)}
              </span>
            </div>
            {result.summary.unmatched_count > 0 && (
              <div className={`${styles.card} ${styles.cardWarn}`}>
                <span className={styles.cardLabel}>원가 미등록</span>
                <span className={styles.cardValue}>{result.summary.unmatched_count}개 상품</span>
              </div>
            )}
          </div>
          <ResultTable items={result.items} />
        </>
      )}
    </div>
  );
}

// ─── 원가 DB 탭 ──────────────────────────────────────────────────────────────

function CostDB() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState('');
  const [newCost, setNewCost] = useState('');
  const [editId, setEditId] = useState(null);
  const [editCost, setEditCost] = useState('');
  const [msg, setMsg] = useState('');
  const [importing, setImporting] = useState(false);
  const fileRef = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API}/amood-settlement/cost-db`, { headers: getAuthHeaders() });
      if (handleUnauthorized(res)) return;
      const data = await res.json();
      if (data.ok) setItems(data.items);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const showMsg = (m) => { setMsg(m); setTimeout(() => setMsg(''), 3000); };

  const handleAdd = async () => {
    if (!newName.trim() || !newCost) return;
    const res = await fetch(`${API}/amood-settlement/cost-db/upsert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify({ product_name: newName.trim(), cost_price: parseInt(newCost, 10) }),
    });
    if (handleUnauthorized(res)) return;
    const data = await res.json();
    if (data.ok) { setNewName(''); setNewCost(''); showMsg('저장됨'); load(); }
  };

  const handleSaveEdit = async (name) => {
    const res = await fetch(`${API}/amood-settlement/cost-db/upsert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify({ product_name: name, cost_price: parseInt(editCost, 10) }),
    });
    if (handleUnauthorized(res)) return;
    const data = await res.json();
    if (data.ok) { setEditId(null); showMsg('수정됨'); load(); }
  };

  const handleDelete = async (name) => {
    if (!confirm(`"${name}" 삭제하시겠습니까?`)) return;
    const res = await fetch(`${API}/amood-settlement/cost-db/${encodeURIComponent(name)}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
    if (handleUnauthorized(res)) return;
    const data = await res.json();
    if (data.ok) { showMsg('삭제됨'); load(); }
  };

  const handleImport = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    const form = new FormData();
    form.append('file', file);
    try {
      const res = await fetch(`${API}/amood-settlement/cost-db/import`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: form,
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json();
      if (data.ok) { showMsg(`임포트 완료: ${data.imported}개 저장, ${data.skipped}개 스킵`); load(); }
      else showMsg(data.detail || '임포트 실패');
    } finally {
      setImporting(false);
      e.target.value = '';
    }
  };

  return (
    <div className={styles.tabContent}>
      <div className={styles.toolBar}>
        <button className={styles.primaryBtn} onClick={() => fileRef.current?.click()} disabled={importing}>
          <Upload size={16} />
          {importing ? '임포트 중...' : 'Excel 임포트 (A열:상품명, B열:원가)'}
        </button>
        <input ref={fileRef} type="file" accept=".xlsx,.xls" style={{ display: 'none' }} onChange={handleImport} />
        {msg && <span className={styles.msgBadge}>{msg}</span>}
      </div>

      <div className={styles.addRow}>
        <input
          className={styles.addInput}
          type="text"
          placeholder="상품명"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
        />
        <input
          className={styles.addCostInput}
          type="number"
          placeholder="원가 (원)"
          value={newCost}
          onChange={(e) => setNewCost(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
        />
        <button className={styles.iconBtn} onClick={handleAdd} title="추가">
          <Plus size={16} />
        </button>
      </div>

      {loading ? (
        <div className={styles.loadingBox}><div className={styles.spinner} /></div>
      ) : (
        <div className={styles.tableWrapper}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>상품명</th>
                <th>원가</th>
                <th>수정일</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 && (
                <tr><td colSpan={4} className={styles.empty}>등록된 원가가 없습니다. Excel로 임포트하거나 직접 추가하세요.</td></tr>
              )}
              {items.map((item) => (
                <tr key={item.product_name}>
                  <td className={styles.productName}>{item.product_name}</td>
                  <td className={styles.num}>
                    {editId === item.product_name ? (
                      <input
                        className={styles.inlineInput}
                        type="number"
                        value={editCost}
                        onChange={(e) => setEditCost(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') handleSaveEdit(item.product_name); }}
                        autoFocus
                      />
                    ) : (
                      fmt(item.cost_price)
                    )}
                  </td>
                  <td className={styles.dateCell}>{item.updated_at?.slice(0, 10)}</td>
                  <td className={styles.actions}>
                    {editId === item.product_name ? (
                      <>
                        <button className={styles.iconBtn} onClick={() => handleSaveEdit(item.product_name)} title="저장"><Save size={14} /></button>
                        <button className={styles.iconBtn} onClick={() => setEditId(null)} title="취소">✕</button>
                      </>
                    ) : (
                      <>
                        <button className={styles.iconBtn} onClick={() => { setEditId(item.product_name); setEditCost(String(item.cost_price)); }} title="수정">✎</button>
                        <button className={styles.iconBtn + ' ' + styles.danger} onClick={() => handleDelete(item.product_name)} title="삭제"><Trash2 size={14} /></button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── 설정 탭 ─────────────────────────────────────────────────────────────────

function SettingsTab({ onSaved }) {
  const [perItemCost, setPerItemCost] = useState('1900');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    fetch(`${API}/amood-settlement/settings`, { headers: getAuthHeaders() })
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) setPerItemCost(String(d.per_item_cost || 1900));
      })
      .catch(() => {});
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch(`${API}/amood-settlement/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ per_item_cost: isNaN(parseInt(perItemCost, 10)) ? 1900 : parseInt(perItemCost, 10) }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json();
      if (data.ok) {
        setMsg('저장되었습니다');
        setTimeout(() => setMsg(''), 3000);
        onSaved({ perItemCost: isNaN(parseInt(perItemCost, 10)) ? 1900 : parseInt(perItemCost, 10) });
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={styles.tabContent}>
      <div className={styles.settingsForm}>
        <div className={styles.formGroup}>
          <label>택배비 + 포장비 (개당, 원)</label>
          <p className={styles.hint}>주문 1개당 정산금액에서 차감할 택배비와 포장비 합계</p>
          <input
            className={styles.costInput}
            type="number"
            value={perItemCost}
            onChange={(e) => setPerItemCost(e.target.value)}
            min="0"
          />
        </div>

        <button className={styles.primaryBtn} onClick={handleSave} disabled={saving}>
          <Save size={16} />
          {saving ? '저장 중...' : '설정 저장'}
        </button>
        {msg && <span className={styles.msgBadge}>{msg}</span>}
      </div>
    </div>
  );
}

// ─── 메인 컴포넌트 ────────────────────────────────────────────────────────────

const TABS = [
  { id: 'settlement', label: '아무드 정산 조회' },
  { id: 'ably', label: '에이블리 정산 조회' },
  { id: 'costdb', label: '원가 DB' },
  { id: 'settings', label: '설정' },
];

export default function AmoodSettlement() {
  const [activeTab, setActiveTab] = useState('settlement');

  return (
    <div className={styles.container}>
      <div className={styles.pageHeader}>
        <Database size={22} />
        <h2>마진 계산</h2>
        <span className={styles.subtitle}>아무드 정산 데이터 기반 상품별 마진율 분석</span>
      </div>

      <div className={styles.tabs}>
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`${styles.tabBtn} ${activeTab === t.id ? styles.tabActive : ''}`}
            onClick={() => setActiveTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div style={{ display: activeTab === 'settlement' ? 'block' : 'none' }}><SettlementView /></div>
      <div style={{ display: activeTab === 'ably' ? 'block' : 'none' }}><AblySettlementView /></div>
      <div style={{ display: activeTab === 'costdb' ? 'block' : 'none' }}><CostDB /></div>
      <div style={{ display: activeTab === 'settings' ? 'block' : 'none' }}><SettingsTab onSaved={() => {}} /></div>
    </div>
  );
}
