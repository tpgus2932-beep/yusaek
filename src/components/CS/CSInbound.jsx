import { Fragment, useEffect, useMemo, useState } from 'react';
import styles from './CSInbound.module.css';
import { LOCAL_API_BASE, getAuthHeaders, handleUnauthorized } from '../../lib/api';

const call = async (path, { method = 'GET', body } = {}) => {
    const res = await fetch(`${LOCAL_API_BASE}/cs${path}`, {
        method,
        headers: { ...getAuthHeaders(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    if (handleUnauthorized(res)) throw new Error('로그인이 만료되었습니다.');
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.detail || '요청 실패');
    return data;
};

const todayStr = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const shortDate = (ymd) => (ymd ? `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}` : '');

const fmtTime = (iso) => {
    const d = new Date(iso);
    if (!iso || Number.isNaN(d.getTime())) return '';
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/**
 * 상품별 탭의 옵션별 입고 일정.
 * 원가베이스에 연결된 상품의 모든 옵션이 각각 따로 날짜·메모·업데이트 시각을 가진다.
 */
export default function CSInbound({ product }) {
    const [options, setOptions] = useState(null);
    const [open, setOpen] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [onlyRecorded, setOnlyRecorded] = useState(false);
    const [checked, setChecked] = useState(() => new Set());
    const [editing, setEditing] = useState(null); // 옵션 코드 | '__bulk__'
    const [form, setForm] = useState({ date: '', note: '' });
    const [saving, setSaving] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(null); // 삭제 확인 중인 옵션 코드 | '__bulk__'

    // 접혀 있어도 요약(기록 N/M, 마지막 업데이트)을 보여주려고 미리 불러온다.
    useEffect(() => {
        if (!product.match) return undefined;
        let cancelled = false;
        setLoading(true);
        call(`/products/${product.goods_sno}/base-options?name=${encodeURIComponent(product.name)}`)
            .then((data) => {
                if (!cancelled) setOptions(data.options || []);
            })
            .catch((e) => {
                if (!cancelled) setError(e.message);
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [product.goods_sno, product.name, product.match]);

    const recorded = useMemo(() => (options || []).filter((o) => o.inbound), [options]);
    const lastUpdated = useMemo(
        () => recorded.map((o) => o.inbound.updated_at).sort().slice(-1)[0] || '',
        [recorded],
    );
    const rows = onlyRecorded ? recorded : options || [];

    const startEdit = (target, current) => {
        setEditing(target);
        setForm({ date: current?.expected_date || '', note: current?.note || '' });
        setError('');
    };

    // clear=true 면 해당 옵션들의 입고 일정을 삭제한다.
    const save = async (codes, clear = false) => {
        setSaving(true);
        setError('');
        try {
            const data = await call('/inbound', {
                method: 'PUT',
                body: { codes, expected_date: clear ? '' : form.date, note: clear ? '' : form.note },
            });
            setOptions((prev) => prev.map((o) => (data.codes.includes(o.code) ? { ...o, inbound: data.inbound } : o)));
            setEditing(null);
            setConfirmDelete(null);
            setChecked(new Set());
        } catch (e) {
            setError(e.message);
        } finally {
            setSaving(false);
        }
    };

    const toggle = (code) =>
        setChecked((prev) => {
            const next = new Set(prev);
            if (next.has(code)) next.delete(code);
            else next.add(code);
            return next;
        });

    const toggleAll = () =>
        setChecked((prev) => (prev.size === rows.length ? new Set() : new Set(rows.map((o) => o.code))));

    if (!product.match) {
        return (
            <div className={styles.box}>
                <strong>옵션별 입고 일정</strong>{' '}
                <span className={styles.muted}>원가베이스에 연결하면 옵션마다 입고 일정을 기록할 수 있어요.</span>
            </div>
        );
    }

    return (
        <div className={styles.box}>
            <div className={styles.head}>
                <strong>옵션별 입고 일정</strong>
                {options && (
                    <span className={styles.muted}>
                        기록 {recorded.length}/{options.length}개
                        {lastUpdated && ` · 마지막 업데이트 ${fmtTime(lastUpdated)}`}
                    </span>
                )}
                {loading && <span className={styles.muted}>불러오는 중…</span>}
                <button type="button" className={styles.btn} onClick={() => setOpen((v) => !v)}>
                    {open ? '접기' : '기록·확인'}
                </button>
            </div>
            {error && <div className={styles.warn}>{error}</div>}

            {open && options && (
                <>
                    <div className={styles.tools}>
                        <label className={styles.check}>
                            <input type="checkbox" checked={onlyRecorded} onChange={(e) => { setOnlyRecorded(e.target.checked); setChecked(new Set()); }} />
                            기록된 옵션만
                        </label>
                        {checked.size > 0 && (
                            <>
                                <span className={styles.muted}>{checked.size}개 선택</span>
                                <button type="button" className={styles.btnSmall} onClick={() => startEdit('__bulk__', null)}>
                                    선택한 옵션에 같은 일정 적용
                                </button>
                                {confirmDelete !== '__bulk__' ? (
                                    <button type="button" className={styles.linkDanger} onClick={() => setConfirmDelete('__bulk__')}>선택한 일정 삭제</button>
                                ) : (
                                    <span className={styles.confirmInline}>
                                        선택한 {checked.size}개 옵션의 일정을 삭제할까요?{' '}
                                        <button type="button" className={styles.linkDanger} disabled={saving} onClick={() => save([...checked], true)}>예</button>
                                        <button type="button" className={styles.link} onClick={() => setConfirmDelete(null)}>아니오</button>
                                    </span>
                                )}
                            </>
                        )}
                    </div>

                    {editing === '__bulk__' && (
                        <div className={styles.editor}>
                            <span className={styles.muted}>선택한 {checked.size}개 옵션:</span>
                            <input type="date" value={form.date} onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))} />
                            <input
                                className={styles.noteInput}
                                placeholder="메모 (예: 2차 입고, 지연될 수 있음)"
                                maxLength={200}
                                value={form.note}
                                onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
                            />
                            <button type="button" className={styles.btnSmall} disabled={saving} onClick={() => save([...checked])}>저장</button>
                            <button type="button" className={styles.link} onClick={() => setEditing(null)}>취소</button>
                        </div>
                    )}

                    <div className={styles.tableWrap}>
                        <table className={styles.table}>
                            <thead>
                                <tr>
                                    <th><input type="checkbox" aria-label="전체 선택" checked={rows.length > 0 && checked.size === rows.length} onChange={toggleAll} /></th>
                                    <th>옵션</th>
                                    <th>입고 일정</th>
                                    <th>업데이트</th>
                                    <th />
                                </tr>
                            </thead>
                            <tbody>
                                {rows.length === 0 && (
                                    <tr><td colSpan={5} className={styles.muted}>기록된 옵션이 없어요.</td></tr>
                                )}
                                {rows.map((o) => (
                                    <Fragment key={o.code}>
                                        <tr>
                                            <td><input type="checkbox" checked={checked.has(o.code)} onChange={() => toggle(o.code)} /></td>
                                            <td>{o.label} <span className={styles.muted}>{o.code}</span></td>
                                            <td>
                                                {o.inbound ? (
                                                    <>
                                                        {o.inbound.expected_date && (
                                                            <b className={o.inbound.expected_date < todayStr() ? styles.past : styles.date}>
                                                                {shortDate(o.inbound.expected_date)}
                                                                {o.inbound.expected_date < todayStr() && ' (지남)'}
                                                            </b>
                                                        )}
                                                        {o.inbound.note && <span> {o.inbound.note}</span>}
                                                    </>
                                                ) : (
                                                    <span className={styles.muted}>-</span>
                                                )}
                                            </td>
                                            <td className={styles.muted}>
                                                {o.inbound ? `${fmtTime(o.inbound.updated_at)}${o.inbound.updated_by ? ` · ${o.inbound.updated_by}` : ''}` : ''}
                                            </td>
                                            <td>
                                                <button type="button" className={styles.link} onClick={() => startEdit(o.code, o.inbound)}>
                                                    {o.inbound ? '수정' : '입력'}
                                                </button>
                                                {o.inbound && confirmDelete !== o.code && (
                                                    <button type="button" className={styles.linkDanger} onClick={() => setConfirmDelete(o.code)}>삭제</button>
                                                )}
                                                {o.inbound && confirmDelete === o.code && (
                                                    <span className={styles.confirmInline}>
                                                        삭제할까요?{' '}
                                                        <button type="button" className={styles.linkDanger} disabled={saving} onClick={() => save([o.code], true)}>예</button>
                                                        <button type="button" className={styles.link} onClick={() => setConfirmDelete(null)}>아니오</button>
                                                    </span>
                                                )}
                                            </td>
                                        </tr>
                                        {editing === o.code && (
                                            <tr className={styles.editRow}>
                                                <td colSpan={5}>
                                                    <div className={styles.editor}>
                                                        <input type="date" value={form.date} onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))} />
                                                        <input
                                                            className={styles.noteInput}
                                                            placeholder="메모 (예: 2차 입고, 지연될 수 있음)"
                                                            maxLength={200}
                                                            value={form.note}
                                                            onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
                                                        />
                                                        <button type="button" className={styles.btnSmall} disabled={saving} onClick={() => save([o.code])}>저장</button>
                                                        <button type="button" className={styles.link} onClick={() => setEditing(null)}>취소</button>
                                                        {o.inbound && (
                                                            <button type="button" className={styles.linkDanger} disabled={saving} onClick={() => save([o.code], true)}>
                                                                이 일정 삭제
                                                            </button>
                                                        )}
                                                    </div>
                                                </td>
                                            </tr>
                                        )}
                                    </Fragment>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </>
            )}
        </div>
    );
}
