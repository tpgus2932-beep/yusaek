import React, { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, Package, Plus, RefreshCw } from 'lucide-react';
import styles from './Dashboard.module.css';
import { COLLAB_API_BASE as API, getAuthHeaders, handleUnauthorized } from '../../lib/api';

function formatDateTime(value) {
    if (!value) return '-';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString('ko-KR', {
        hour12: false,
        timeZone: 'Asia/Seoul',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
    });
}

function todayStr() {
    return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
}

function voucherLabel(v) {
    const cell = v.cell || {};
    const extra = cell.title || cell.supply_name || cell.crdate || '';
    return extra ? `전표 ${v.sheet} · ${extra}` : `전표 ${v.sheet}`;
}

const CHANGE_TYPE_LABEL = {
    voucher: '입고전표 차감',
    manual: '수동조정',
    create: '신규등록',
};

export default function EquipmentCard() {
    const [open, setOpen] = useState(false);
    const [items, setItems] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    const [showAddForm, setShowAddForm] = useState(false);
    const [newName, setNewName] = useState('');
    const [newQty, setNewQty] = useState('');
    const [newMinStock, setNewMinStock] = useState('');
    const [submitting, setSubmitting] = useState(false);

    const [editingId, setEditingId] = useState(null);
    const [editDraft, setEditDraft] = useState({ name: '', min_stock: '' });

    const [adjustOpenId, setAdjustOpenId] = useState(null);
    const [adjustDelta, setAdjustDelta] = useState('');
    const [adjustReason, setAdjustReason] = useState('');

    const [showVoucherPanel, setShowVoucherPanel] = useState(false);
    const [voucherDate, setVoucherDate] = useState(todayStr());
    const [vouchers, setVouchers] = useState([]);
    const [selectedSheets, setSelectedSheets] = useState([]);
    const [voucherTargetId, setVoucherTargetId] = useState('');
    const [loadingVoucherList, setLoadingVoucherList] = useState(false);
    const [applyingVouchers, setApplyingVouchers] = useState(false);
    const [applyResult, setApplyResult] = useState(null);

    const [showLogs, setShowLogs] = useState(false);
    const [logs, setLogs] = useState([]);
    const [loadingLogs, setLoadingLogs] = useState(false);

    const authHeaders = getAuthHeaders();

    const fetchItems = useCallback(async () => {
        try {
            const res = await fetch(`${API}/equipment`, { headers: authHeaders });
            if (handleUnauthorized(res)) return;
            const data = await res.json().catch(() => ({}));
            if (res.ok && data.ok) setItems(data.items || []);
        } catch {
            // 조용히 무시
        } finally {
            setLoading(false);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        fetchItems();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const fetchLogs = useCallback(async () => {
        setLoadingLogs(true);
        try {
            const res = await fetch(`${API}/equipment/logs`, { headers: authHeaders });
            if (handleUnauthorized(res)) return;
            const data = await res.json().catch(() => ({}));
            if (res.ok && data.ok) setLogs(data.logs || []);
        } catch {
            // 조용히 무시
        } finally {
            setLoadingLogs(false);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const toggleLogs = () => {
        const next = !showLogs;
        setShowLogs(next);
        if (next && logs.length === 0) fetchLogs();
    };

    const handleCreate = async () => {
        const name = newName.trim();
        if (!name) return;
        setSubmitting(true);
        setError('');
        try {
            const res = await fetch(`${API}/equipment`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders },
                body: JSON.stringify({
                    name,
                    quantity: Number(newQty) || 0,
                    min_stock: Number(newMinStock) || 0,
                }),
            });
            if (handleUnauthorized(res)) return;
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.ok) throw new Error(data?.detail || '등록 실패');
            setNewName(''); setNewQty(''); setNewMinStock('');
            setShowAddForm(false);
            await fetchItems();
        } catch (err) {
            setError(err.message || '등록 실패');
        } finally {
            setSubmitting(false);
        }
    };

    const startEdit = (item) => {
        setEditingId(item.id);
        setEditDraft({ name: item.name, min_stock: String(item.min_stock) });
    };

    const saveEdit = async (id) => {
        try {
            const res = await fetch(`${API}/equipment/${id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json', ...authHeaders },
                body: JSON.stringify({
                    name: editDraft.name.trim(),
                    min_stock: Number(editDraft.min_stock) || 0,
                }),
            });
            if (handleUnauthorized(res)) return;
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.ok) throw new Error(data?.detail || '수정 실패');
            setEditingId(null);
            await fetchItems();
        } catch (err) {
            setError(err.message || '수정 실패');
        }
    };

    const handleDelete = async (id) => {
        if (!window.confirm('이 비품을 삭제할까요?')) return;
        try {
            const res = await fetch(`${API}/equipment/${id}`, { method: 'DELETE', headers: authHeaders });
            if (handleUnauthorized(res)) return;
            await fetchItems();
        } catch (err) {
            setError(err.message || '삭제 실패');
        }
    };

    const openAdjust = (id) => {
        setAdjustOpenId(id);
        setAdjustDelta('');
        setAdjustReason('');
    };

    const submitAdjust = async (id) => {
        const delta = Number(adjustDelta);
        if (!delta) return;
        try {
            const res = await fetch(`${API}/equipment/${id}/adjust`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders },
                body: JSON.stringify({ delta, reason: adjustReason.trim() }),
            });
            if (handleUnauthorized(res)) return;
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.ok) throw new Error(data?.detail || '조정 실패');
            setAdjustOpenId(null);
            await fetchItems();
            if (showLogs) await fetchLogs();
        } catch (err) {
            setError(err.message || '조정 실패');
        }
    };

    const toggleVoucherPanel = () => {
        const next = !showVoucherPanel;
        setShowVoucherPanel(next);
        setApplyResult(null);
        if (next && vouchers.length === 0) handleFetchVouchers();
    };

    const handleFetchVouchers = async () => {
        setLoadingVoucherList(true);
        setError('');
        setApplyResult(null);
        try {
            const res = await fetch(`${API}/equipment/vouchers?date=${encodeURIComponent(voucherDate)}`, {
                headers: authHeaders,
            });
            if (handleUnauthorized(res)) return;
            const data = await res.json().catch(() => ({}));
            if (data?.need_session) {
                setError('이지어드민 세션이 필요합니다. 바코드 메뉴에서 이지어드민 세션을 먼저 연결해주세요.');
                return;
            }
            if (!res.ok || !data.ok) throw new Error(data?.detail || '전표 목록 조회 실패');
            setVouchers(data.vouchers || []);
            setSelectedSheets([]);
        } catch (err) {
            setError(err.message || '전표 목록 조회 실패');
        } finally {
            setLoadingVoucherList(false);
        }
    };

    const toggleSheet = (sheet) => {
        setSelectedSheets((prev) => (
            prev.includes(sheet) ? prev.filter((s) => s !== sheet) : [...prev, sheet]
        ));
    };

    const selectableSheets = vouchers.filter((v) => !v.already_processed).map((v) => v.sheet);
    const allSelected = selectableSheets.length > 0 && selectableSheets.every((s) => selectedSheets.includes(s));

    const toggleSelectAll = () => {
        setSelectedSheets(allSelected ? [] : selectableSheets);
    };

    const handleApplyVouchers = async () => {
        if (!voucherTargetId) {
            setError('차감할 비품을 선택하세요');
            return;
        }
        if (selectedSheets.length === 0) {
            setError('전표를 선택하세요');
            return;
        }
        setApplyingVouchers(true);
        setError('');
        setApplyResult(null);
        try {
            const res = await fetch(`${API}/equipment/deduct-from-vouchers`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders },
                body: JSON.stringify({
                    equipment_id: Number(voucherTargetId),
                    vouchers: selectedSheets,
                    date: voucherDate,
                }),
            });
            if (handleUnauthorized(res)) return;
            const data = await res.json().catch(() => ({}));
            if (data?.need_session) {
                setError('이지어드민 세션이 필요합니다. 바코드 메뉴에서 이지어드민 세션을 먼저 연결해주세요.');
                return;
            }
            if (!res.ok || !data.ok) throw new Error(data?.detail || '차감 적용 실패');
            setApplyResult(data);
            await fetchItems();
            await handleFetchVouchers();
            if (showLogs) await fetchLogs();
        } catch (err) {
            setError(err.message || '차감 적용 실패');
        } finally {
            setApplyingVouchers(false);
        }
    };

    const lowStockCount = items.filter((i) => i.low_stock).length;

    return (
        <div className={styles.card}>
            <button type="button" className={styles.collapsibleHeader} onClick={() => setOpen((v) => !v)}>
                <span className={styles.collapsibleTitle}>
                    비품관리
                    <Package size={15} className={styles.cardHeaderIcon} />
                </span>
                <span className={styles.collapsibleMeta}>
                    {lowStockCount > 0 && <span className={styles.newBadge}>재고부족 {lowStockCount}</span>}
                    {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                </span>
            </button>
            {open && (
                <>
                    {error && <div className={styles.errorText}>{error}</div>}

                    <div className={styles.filterGroup} style={{ marginBottom: '1rem' }}>
                        <button type="button" className={styles.filterBtn} onClick={toggleVoucherPanel}>
                            <RefreshCw size={13} />
                            {showVoucherPanel ? '전표선택 닫기' : '입고전표 선택'}
                        </button>
                        <button
                            type="button"
                            className={styles.filterBtn}
                            onClick={() => setShowAddForm((v) => !v)}
                        >
                            <Plus size={13} />
                            {showAddForm ? '닫기' : '비품 등록'}
                        </button>
                        <button type="button" className={styles.filterBtn} onClick={toggleLogs}>
                            {showLogs ? '로그 닫기' : '차감 로그 보기'}
                        </button>
                    </div>

                    {showVoucherPanel && (
                        <div className={styles.todoRow} style={{ flexDirection: 'column', alignItems: 'stretch', marginBottom: '1rem', gap: '0.6rem' }}>
                            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
                                <input
                                    className={styles.credentialInput}
                                    type="date"
                                    value={voucherDate}
                                    onChange={(e) => setVoucherDate(e.target.value)}
                                    style={{ maxWidth: '11rem' }}
                                />
                                <button type="button" className={styles.secondaryBtn} onClick={handleFetchVouchers} disabled={loadingVoucherList}>
                                    {loadingVoucherList ? '조회 중...' : '전표 조회'}
                                </button>
                                <select
                                    className={styles.credentialInput}
                                    value={voucherTargetId}
                                    onChange={(e) => setVoucherTargetId(e.target.value)}
                                    style={{ maxWidth: '14rem' }}
                                >
                                    <option value="">차감할 비품 선택</option>
                                    {items.map((item) => (
                                        <option key={item.id} value={item.id}>{item.name}</option>
                                    ))}
                                </select>
                            </div>

                            {loadingVoucherList && <div className={styles.mutedText}>전표 목록을 불러오는 중...</div>}
                            {!loadingVoucherList && vouchers.length === 0 && (
                                <div className={styles.mutedText}>{voucherDate}에 조회된 전표가 없습니다.</div>
                            )}
                            {!loadingVoucherList && vouchers.length > 0 && (
                                <>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                        <button type="button" className={styles.secondaryBtn} onClick={toggleSelectAll} disabled={selectableSheets.length === 0}>
                                            {allSelected ? '전체 해제' : '전체 선택'}
                                        </button>
                                        <span className={styles.mutedText}>{selectedSheets.length}개 선택됨</span>
                                    </div>
                                    <div style={{ maxHeight: '14rem', overflowY: 'auto', border: '1px solid var(--border-color, #eee)', borderRadius: '6px', padding: '0.4rem' }}>
                                        {vouchers.map((v) => (
                                            <label
                                                key={v.sheet}
                                                style={{
                                                    display: 'flex', alignItems: 'center', gap: '0.5rem',
                                                    padding: '0.3rem 0.2rem',
                                                    opacity: v.already_processed ? 0.5 : 1,
                                                }}
                                            >
                                                <input
                                                    type="checkbox"
                                                    checked={selectedSheets.includes(v.sheet)}
                                                    disabled={v.already_processed}
                                                    onChange={() => toggleSheet(v.sheet)}
                                                />
                                                <span>{voucherLabel(v)}</span>
                                                {v.already_processed && <span className={styles.mutedText}>(이미 처리됨)</span>}
                                            </label>
                                        ))}
                                    </div>
                                </>
                            )}

                            <button
                                type="button"
                                className={styles.primaryBtn}
                                onClick={handleApplyVouchers}
                                disabled={applyingVouchers || selectedSheets.length === 0 || !voucherTargetId}
                                style={{ alignSelf: 'flex-start' }}
                            >
                                {applyingVouchers ? '차감 적용 중... (전표당 최대 1분)' : `선택 전표 ${selectedSheets.length}개 차감 적용`}
                            </button>

                            {applyResult && (
                                <div className={styles.mutedText}>
                                    차감 {applyResult.deductions.length}건
                                    {applyResult.skipped.length > 0 && ` · 이미 처리되어 건너뜀 ${applyResult.skipped.length}건`}
                                    {applyResult.failed.length > 0 && ` · 실패 ${applyResult.failed.length}건`}
                                    {applyResult.remaining > 0 && ` · 남은 전표 ${applyResult.remaining}건 (다시 눌러 계속 처리)`}
                                    {applyResult.deductions.length > 0 && (
                                        <ul style={{ margin: '0.4rem 0 0', paddingLeft: '1.1rem' }}>
                                            {applyResult.deductions.map((d, idx) => (
                                                <li key={idx}>
                                                    [{d.voucher_no}] {d.deducted_qty}개 차감 ({d.before_qty} → {d.after_qty})
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                    {applyResult.failed.length > 0 && (
                                        <div style={{ marginTop: '0.4rem' }}>
                                            실패: {applyResult.failed.map((f) => `${f.voucher_no}(${f.reason})`).join(', ')}
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    )}

                    {showAddForm && (
                        <div className={styles.todoRow} style={{ flexWrap: 'wrap', marginBottom: '1rem' }}>
                            <input
                                className={styles.credentialInput}
                                placeholder="비품명"
                                value={newName}
                                onChange={(e) => setNewName(e.target.value)}
                            />
                            <input
                                className={styles.credentialInput}
                                placeholder="현재 수량"
                                type="number"
                                value={newQty}
                                onChange={(e) => setNewQty(e.target.value)}
                                style={{ maxWidth: '7rem' }}
                            />
                            <input
                                className={styles.credentialInput}
                                placeholder="최소 재고 기준"
                                type="number"
                                value={newMinStock}
                                onChange={(e) => setNewMinStock(e.target.value)}
                                style={{ maxWidth: '8rem' }}
                            />
                            <button type="button" className={styles.primaryBtn} onClick={handleCreate} disabled={submitting}>
                                {submitting ? '등록 중...' : '등록'}
                            </button>
                        </div>
                    )}

                    {loading && <div className={styles.mutedText}>불러오는 중...</div>}
                    {!loading && items.length === 0 && (
                        <div className={styles.emptyState}>
                            <div className={styles.emptyStateText}>등록된 비품이 없습니다.</div>
                        </div>
                    )}

                    <div className={styles.todoList}>
                        {items.map((item) => (
                            <div key={item.id} className={styles.todoItem} style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                                {editingId === item.id ? (
                                    <div className={styles.todoRow} style={{ flexWrap: 'wrap' }}>
                                        <input
                                            className={styles.credentialInput}
                                            value={editDraft.name}
                                            onChange={(e) => setEditDraft((d) => ({ ...d, name: e.target.value }))}
                                        />
                                        <input
                                            className={styles.credentialInput}
                                            type="number"
                                            placeholder="최소 재고"
                                            value={editDraft.min_stock}
                                            onChange={(e) => setEditDraft((d) => ({ ...d, min_stock: e.target.value }))}
                                            style={{ maxWidth: '8rem' }}
                                        />
                                        <button type="button" className={styles.primaryBtn} onClick={() => saveEdit(item.id)}>저장</button>
                                        <button type="button" className={styles.secondaryBtn} onClick={() => setEditingId(null)}>취소</button>
                                    </div>
                                ) : (
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
                                        <div>
                                            <div className={styles.todoText}>
                                                {item.name}
                                                {item.low_stock && (
                                                    <span className={styles.newBadge} style={{ marginLeft: '0.4rem' }}>부족</span>
                                                )}
                                            </div>
                                            <div className={styles.todoMeta}>
                                                수량 {item.quantity}개 · 최소기준 {item.min_stock}개
                                            </div>
                                        </div>
                                        <div className={styles.todoActions}>
                                            <button type="button" className={styles.secondaryBtn} onClick={() => openAdjust(item.id)}>수량조정</button>
                                            <button type="button" className={styles.secondaryBtn} onClick={() => startEdit(item)}>수정</button>
                                            <button type="button" className={styles.dangerBtn} onClick={() => handleDelete(item.id)}>삭제</button>
                                        </div>
                                    </div>
                                )}
                                {adjustOpenId === item.id && (
                                    <div className={styles.todoInlineEditor}>
                                        <input
                                            className={styles.todoInput}
                                            type="number"
                                            placeholder="+입고 / -사용 (예: -3)"
                                            value={adjustDelta}
                                            onChange={(e) => setAdjustDelta(e.target.value)}
                                            style={{ maxWidth: '8rem' }}
                                        />
                                        <input
                                            className={styles.todoInput}
                                            placeholder="사유 (선택)"
                                            value={adjustReason}
                                            onChange={(e) => setAdjustReason(e.target.value)}
                                        />
                                        <button type="button" className={styles.primaryBtn} onClick={() => submitAdjust(item.id)}>적용</button>
                                        <button type="button" className={styles.secondaryBtn} onClick={() => setAdjustOpenId(null)}>취소</button>
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>

                    {showLogs && (
                        <div style={{ marginTop: '1rem' }}>
                            <div className={styles.cardTitle} style={{ fontSize: '0.9rem' }}>차감/조정 로그</div>
                            {loadingLogs && <div className={styles.mutedText}>불러오는 중...</div>}
                            {!loadingLogs && logs.length === 0 && (
                                <div className={styles.mutedText}>로그가 없습니다.</div>
                            )}
                            {!loadingLogs && logs.map((log) => (
                                <div key={log.id} className={styles.todoMeta} style={{ padding: '0.3rem 0', borderBottom: '1px solid var(--border-color, #eee)' }}>
                                    {formatDateTime(log.created_at)} · {log.equipment_name} · {CHANGE_TYPE_LABEL[log.change_type] || log.change_type}
                                    {' '}{log.delta > 0 ? `+${log.delta}` : log.delta} ({log.before_qty} → {log.after_qty})
                                    {log.voucher_no && ` · 전표 ${log.voucher_no}`}
                                    {log.matched_text && ` · ${log.matched_text}`}
                                    {log.reason && ` · 사유: ${log.reason}`}
                                    {' · '}{log.created_by_display || log.created_by}
                                </div>
                            ))}
                        </div>
                    )}
                </>
            )}
        </div>
    );
}
