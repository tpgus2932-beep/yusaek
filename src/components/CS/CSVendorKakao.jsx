import { useEffect, useMemo, useState } from 'react';
import { COLLAB_API_BASE as API, LOCAL_API_BASE, getAuthHeaders, handleUnauthorized } from '../../lib/api';
import { useEzadminSession } from '../../lib/EzadminSessionContext';
import { call, newRequestId } from '../KakaoTalk/kakaoApi';
import {
    DEFAULT_PREFIX,
    DEFAULT_SUFFIX,
    buildSheet1AndSheet2,
    formatInputDate,
    parseExcludedClients,
    preprocessBaseSheet,
} from '../../lib/clientSchedule';

const box = { border: '1px solid var(--border-color, #e5e7eb)', borderRadius: 8, padding: '10px 12px', marginBottom: 10 };
const input = { padding: '5px 8px', border: '1px solid var(--border-color, #d1d5db)', borderRadius: 6, font: 'inherit', background: 'var(--bg-primary, #fff)', color: 'inherit' };
const btn = { padding: '5px 12px', border: '1px solid var(--border-color, #d1d5db)', borderRadius: 6, background: 'var(--bg-secondary, #f3f4f6)', cursor: 'pointer', font: 'inherit', color: 'inherit' };
const btnPrimary = { ...btn, background: '#2563eb', borderColor: '#2563eb', color: '#fff' };

const jsonFetch = async (url, options) => {
    const res = await fetch(url, options);
    if (handleUnauthorized(res)) throw new Error('로그인이 만료되었습니다.');
    const data = await res.json().catch(() => ({}));
    return { res, data };
};

/**
 * 재고부족요청 거래처 카톡: 거래처 일정(사이드메뉴 '거래처')의 EZAdmin 불러오기·자동 실행과 같은 계산으로
 * 거래처별 문자(Sheet1)를 만들고, 거래처에 맞춰 둔 카카오톡 친구에게 카톡으로 보낸다.
 * 입고전표로 행을 지우는 단계는 하지 않고, 거래처 일정에 적은 날짜 대신 CS 입고일정(옵션별 입고 예정일)이
 * 잡힌 상품을 문자 대상에서 뺀다. 문자 시작/마무리·제외 거래처는 거래처 일정과 같은 값을 공유한다.
 * 처음 보는 거래처는 카카오톡 친구를 직접 골라 매칭하고(서버에 저장), 다음부터는 자동으로 쓴다.
 */
export default function CSVendorKakao({ onClose }) {
    const { openModal } = useEzadminSession();
    const [prefix, setPrefix] = useState(DEFAULT_PREFIX);
    const [suffix, setSuffix] = useState(DEFAULT_SUFFIX);
    const [excluded, setExcluded] = useState([]);
    const [exInput, setExInput] = useState('');
    const [start, setStart] = useState(() => formatInputDate(new Date(Date.now() - 90 * 86400000)));
    const [end, setEnd] = useState(() => formatInputDate());
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState('');
    const [noteBad, setNoteBad] = useState(false);
    const [processed, setProcessed] = useState(null); // 불러오기·가공이 끝난 행들 (제외/문구가 바뀌면 이걸로 다시 만든다)

    const [contacts, setContacts] = useState([]);
    const [vendorMap, setVendorMap] = useState({});
    const [picks, setPicks] = useState({});
    const [filters, setFilters] = useState({});
    const [editing, setEditing] = useState({});
    const [status, setStatus] = useState({}); // { 거래처: {busy, ok, msg} }
    const [bulkBusy, setBulkBusy] = useState(false);
    const [removed, setRemoved] = useState(() => new Set()); // 이번 목록에서만 뺀 거래처 (제외 거래처와 달리 저장하지 않음, 다시 불러오면 돌아옴)
    const [texts, setTexts] = useState({}); // 직접 고친 전송 문구 { 거래처: text } (없으면 자동 문구)
    const textOf = (g) => (texts[g.vendor] !== undefined ? texts[g.vendor] : g.message);

    // 문구·제외 거래처·카톡 친구/매칭을 처음에 한 번 읽는다.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const [defaults, ex, map, kakao] = await Promise.all([
                    jsonFetch(`${API}/client-schedule/message-defaults`, { headers: getAuthHeaders() }),
                    jsonFetch(`${API}/client-schedule/excluded`, { headers: getAuthHeaders() }),
                    jsonFetch(`${LOCAL_API_BASE}/barcode/defect/kakao-vendor-map`, { headers: getAuthHeaders() }),
                    call('/contacts'),
                ]);
                if (cancelled) return;
                if (typeof defaults.data.prefix === 'string') setPrefix(defaults.data.prefix);
                if (typeof defaults.data.suffix === 'string') setSuffix(defaults.data.suffix);
                setExcluded(ex.data.items || []);
                setVendorMap(map.data.map || {});
                setContacts(kakao.contacts || []);
            } catch (e) {
                if (!cancelled) { setNote(e.message || '설정을 불러오지 못했습니다.'); setNoteBad(true); }
            }
        })();
        return () => { cancelled = true; };
    }, []);

    const saveExcluded = async (items) => {
        setExcluded(items);
        try {
            await jsonFetch(`${API}/client-schedule/excluded`, {
                method: 'PUT',
                headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ items }),
            });
        } catch { /* 저장 실패는 화면 동작에 영향 없음 */ }
    };
    const addExcluded = () => {
        const add = parseExcludedClients(exInput);
        if (!add.length) return;
        saveExcluded([...new Set([...excluded, ...add])]);
        setExInput('');
    };

    const saveDefaults = async () => {
        try {
            const { res, data } = await jsonFetch(`${API}/client-schedule/message-defaults`, {
                method: 'PUT',
                headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ prefix, suffix }),
            });
            if (!res.ok) throw new Error(data?.detail || '저장 실패');
            setNote('문자 시작/마무리 기본문구를 저장했습니다. (거래처 일정 화면과 같이 씁니다)');
            setNoteBad(false);
        } catch (e) { setNote(e.message || '저장 실패'); setNoteBad(true); }
    };

    // EZAdmin 불러오기 · 자동 실행 (입고전표 불러오기/제외 단계는 하지 않는다)
    const run = async () => {
        setBusy(true);
        setNoteBad(false);
        setNote('EZAdmin에서 기준 데이터를 불러오는 중...');
        try {
            const { res, data } = await jsonFetch(`${LOCAL_API_BASE}/barcode/base-file-from-ezadmin`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
                body: JSON.stringify({ start_date: start, end_date: end }),
            });
            if (data?.need_session) { openModal(run); setNote('이지어드민 로그인이 필요해요. 로그인하면 자동으로 다시 불러옵니다.'); return; }
            if (!res.ok || !data?.ok || !Array.isArray(data.rows)) throw new Error(data?.error || 'EZAdmin 기준 데이터 불러오기 실패');

            let rows = preprocessBaseSheet(data.rows);
            // CS 입고일정(옵션 상품코드별 입고 예정일)이 잡힌 상품은 일정(D)을 채워 문자 대상에서 뺀다.
            const { res: inRes, data: inData } = await jsonFetch(`${LOCAL_API_BASE}/cs/delay-schedules/codes`, { headers: getAuthHeaders() });
            if (!inRes.ok) throw new Error(inData?.detail || 'CS 입고일정을 읽지 못했습니다.');
            const dates = inData.dates || {};
            let scheduled = 0;
            rows = rows.map((row) => {
                const date = dates[String(row.productCode || '').trim()];
                if (!date) return { ...row, D: '' };
                scheduled += 1;
                return { ...row, D: date };
            });
            setProcessed(rows);
            setStatus({});
            setTexts({});
            setRemoved(new Set());
            setNote(`불러오기 완료: ${rows.length}행 · CS 입고일정이 잡힌 ${scheduled}행은 문자 대상에서 제외`);
        } catch (e) {
            setNote(`불러오기 실패: ${e.message || ''}`);
            setNoteBad(true);
        } finally {
            setBusy(false);
        }
    };

    const built = useMemo(() => {
        if (!processed) return null;
        const result = buildSheet1AndSheet2(processed, prefix, suffix, excluded);
        return {
            groups: result.sheet1Rows.slice(1).map(([vendor, message]) => ({ vendor, message })).filter((g) => !removed.has(g.vendor)),
            excludedHit: result.excludedMatchedClients,
        };
    }, [processed, prefix, suffix, excluded, removed]);

    const contactById = useMemo(() => new Map(contacts.map((c) => [c.id, c])), [contacts]);
    const setSt = (vendor, patch) => setStatus((p) => ({ ...p, [vendor]: { ...p[vendor], ...patch } }));

    const saveMatch = async (vendor) => {
        const contactId = Number(picks[vendor]);
        if (!contactId) { setSt(vendor, { msg: '카카오톡 친구를 선택하세요.', ok: false }); return; }
        try {
            const { res, data } = await jsonFetch(`${LOCAL_API_BASE}/barcode/defect/kakao-vendor-map`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
                body: JSON.stringify({ vendor, contact_id: contactId }),
            });
            if (!res.ok) throw new Error(data?.detail || '매칭 저장 실패');
            setVendorMap((p) => ({ ...p, [vendor]: contactId }));
            setEditing((p) => ({ ...p, [vendor]: false }));
            setSt(vendor, { msg: '', ok: undefined });
        } catch (e) { setSt(vendor, { msg: e.message || '매칭 저장 실패', ok: false }); }
    };

    const send = async (g, skipConfirm = false) => {
        const contact = contactById.get(vendorMap[g.vendor]);
        if (!contact) return;
        if (!skipConfirm && !window.confirm(`${g.vendor} → 카카오톡 "${contact.name}"에게 보낼까요?`)) return;
        const text = textOf(g).trim();
        if (!text) { setSt(g.vendor, { busy: false, ok: false, msg: '전송 문구가 비어 있습니다.' }); return; }
        setSt(g.vendor, { busy: true, msg: '전송 요청 중...', ok: undefined });
        try {
            await call('/send', { method: 'POST', body: { contact_id: contact.id, text, request_id: newRequestId() } });
            setSt(g.vendor, { busy: false, ok: true, msg: '전송 요청됨' });
            return true;
        } catch (e) {
            setSt(g.vendor, { busy: false, ok: false, msg: e.message || '전송 실패' });
            return false;
        }
    };

    const removeVendor = (vendor) => {
        if (!window.confirm(`'${vendor}' 거래처를 이번 목록에서 뺄까요?
(저장되지 않아요. EZAdmin을 다시 불러오면 돌아옵니다)`)) return;
        setRemoved((p) => new Set(p).add(vendor));
    };

    const groups = built?.groups || [];
    const sendable = groups.filter((g) => contactById.get(vendorMap[g.vendor]) && !editing[g.vendor] && !status[g.vendor]?.busy && !status[g.vendor]?.ok);
    const unmatched = groups.filter((g) => !contactById.get(vendorMap[g.vendor])).length;
    const sendAll = async () => {
        if (bulkBusy || sendable.length === 0) return;
        const names = sendable.map((g) => `${g.vendor} → ${contactById.get(vendorMap[g.vendor]).name}`).join('\n');
        const skipped = unmatched > 0 ? `\n\n(카톡 매칭이 안 된 ${unmatched}곳은 제외됩니다)` : '';
        if (!window.confirm(`${sendable.length}곳에 카톡으로 보낼까요?\n\n${names}${skipped}`)) return;
        setBulkBusy(true);
        try {
            const sentIds = [];
            for (const g of sendable) {
                if (await send(g, true)) sentIds.push(vendorMap[g.vendor]);
            }
            // 보낸 거래처들을 상단메뉴 CS > 카카오톡 탭의 '리스트'로 묶어 둔다.
            if (sentIds.length > 0) {
                const d = new Date();
                const p2 = (n) => String(n).padStart(2, '0');
                const name = `거래처 카톡 ${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
                try {
                    await call('/lists', { method: 'POST', body: { name, contact_ids: sentIds } });
                    setNote(`전송 요청 ${sentIds.length}곳 · 카카오톡 탭 리스트 '${name}'에 묶었습니다.`);
                    setNoteBad(false);
                } catch (e) {
                    setNote(`전송은 요청했지만 리스트를 만들지 못했습니다: ${e.message || ''}`);
                    setNoteBad(true);
                }
            }
        } finally {
            setBulkBusy(false);
        }
    };

    return (
        <div
            style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
            onClick={onClose}
        >
            <div
                style={{ background: 'var(--bg-primary, #fff)', color: 'var(--text-primary, inherit)', borderRadius: 10, width: 'min(860px, 96vw)', maxHeight: '90vh', display: 'flex', flexDirection: 'column', boxShadow: '0 10px 30px rgba(0,0,0,0.25)' }}
                onClick={(e) => e.stopPropagation()}
            >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--border-color, #e5e7eb)' }}>
                    <strong style={{ marginRight: 'auto' }}>거래처 카톡 보내기</strong>
                    <button type="button" style={btnPrimary} onClick={sendAll} disabled={bulkBusy || sendable.length === 0}>
                        {bulkBusy ? '전체 전송 중...' : `전체 전송 (${sendable.length})`}
                    </button>
                    <button type="button" style={btn} onClick={onClose}>닫기</button>
                </div>

                <div style={{ padding: 16, overflowY: 'auto' }}>
                    <div style={box}>
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                            <span>기준 기간</span>
                            <input type="date" style={input} value={start} max={end} onChange={(e) => setStart(e.target.value)} />
                            <span>~</span>
                            <input type="date" style={input} value={end} min={start} onChange={(e) => setEnd(e.target.value)} />
                            <button type="button" style={btnPrimary} disabled={busy} onClick={run}>
                                {busy ? '불러오는 중...' : 'EZAdmin 불러오기 · 자동 실행'}
                            </button>
                        </div>
                        <div style={{ marginTop: 6, fontSize: 12, color: '#6b7280' }}>
                            거래처 일정과 같은 계산으로 거래처별 문자를 만듭니다. CS 입고일정(옵션별 입고 예정일)이 잡힌 상품은 문자에서 빠지고, 입고전표 불러오기/제외 단계는 하지 않습니다.
                        </div>
                    </div>

                    <div style={box}>
                        <div style={{ display: 'grid', gridTemplateColumns: '5.5rem 1fr', gap: 6, alignItems: 'center' }}>
                            <span>문자 시작</span>
                            <input style={input} value={prefix} onChange={(e) => setPrefix(e.target.value)} />
                            <span>문자 마무리</span>
                            <input style={input} value={suffix} onChange={(e) => setSuffix(e.target.value)} />
                        </div>
                        <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                            <button type="button" style={btn} onClick={saveDefaults}>기본문구로 저장</button>
                            <span style={{ fontSize: 12, color: '#6b7280' }}>거래처 일정 화면의 문자 시작/마무리와 같은 값을 씁니다.</span>
                        </div>
                        <div style={{ marginTop: 10 }}>
                            <div style={{ marginBottom: 4 }}>제외 거래처 <span style={{ fontSize: 12, color: '#6b7280' }}>(이름에 포함되면 제외 · 거래처 일정과 공유)</span></div>
                            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                                {excluded.map((x) => (
                                    <span key={x} style={{ background: '#fef3c7', color: '#92400e', border: '1px solid #fcd34d', borderRadius: 12, padding: '2px 8px', fontSize: 13 }}>
                                        {x}{' '}
                                        <button
                                            type="button"
                                            title="제외 해제"
                                            onClick={() => saveExcluded(excluded.filter((v) => v !== x))}
                                            style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'inherit', padding: 0 }}
                                        >
                                            ×
                                        </button>
                                    </span>
                                ))}
                                <input
                                    style={{ ...input, minWidth: 180 }}
                                    placeholder="거래처 이름(포함) 입력 후 Enter"
                                    value={exInput}
                                    onChange={(e) => setExInput(e.target.value)}
                                    onKeyDown={(e) => {
                                        if ((e.key === 'Enter' || e.key === ',') && !e.nativeEvent.isComposing) { e.preventDefault(); addExcluded(); }
                                    }}
                                />
                            </div>
                        </div>
                    </div>

                    {note && <div style={{ marginBottom: 10, color: noteBad ? '#dc2626' : '#15803d' }}>{note}</div>}

                    {built && (
                        <div style={{ marginBottom: 8, color: '#374151' }}>
                            문자 대상 <b>{groups.length}</b>곳
                            {built.excludedHit.length > 0 && <> · 제외된 거래처 {built.excludedHit.length}곳</>}
                            {unmatched > 0 && <> · 카톡 매칭 필요 {unmatched}곳</>}
                        </div>
                    )}
                    {built && groups.length === 0 && <div style={{ color: '#9ca3af', padding: 16, textAlign: 'center' }}>문자를 보낼 거래처가 없습니다.</div>}

                    {groups.map((g) => {
                        const st = status[g.vendor] || {};
                        const contact = contactById.get(vendorMap[g.vendor]);
                        const matched = Boolean(contact) && !editing[g.vendor];
                        const kw = (filters[g.vendor] || '').trim().toLowerCase();
                        const options = contacts.filter((c) => !kw || c.name.toLowerCase().includes(kw)).slice(0, 60);
                        return (
                            <div key={g.vendor} style={{ borderTop: '1px solid var(--border-color, #e5e7eb)', padding: '10px 0' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                    <strong style={{ marginRight: 'auto' }}>{g.vendor}</strong>
                                    <button type="button" style={btn} disabled={st.busy} onClick={() => removeVendor(g.vendor)} title="이번 목록에서 이 거래처를 뺍니다 (저장 안 됨)">
                                        목록에서 제거 ✕
                                    </button>
                                </div>
                                <textarea
                                    value={textOf(g)}
                                    disabled={st.busy}
                                    onChange={(e) => setTexts((p) => ({ ...p, [g.vendor]: e.target.value }))}
                                    rows={Math.min(14, Math.max(3, textOf(g).split('\n').length + 1))}
                                    style={{ ...input, width: '100%', boxSizing: 'border-box', margin: '6px 0', fontSize: '0.9em', background: 'var(--bg-secondary, #f3f4f6)', resize: 'vertical' }}
                                />
                                {texts[g.vendor] !== undefined && (
                                    <button
                                        type="button"
                                        style={{ ...btn, marginBottom: 6 }}
                                        disabled={st.busy}
                                        onClick={() => setTexts((p) => { const n = { ...p }; delete n[g.vendor]; return n; })}
                                    >
                                        문구 원래대로
                                    </button>
                                )}
                                {matched ? (
                                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                                        <span style={{ background: '#fef9c3', borderRadius: 10, padding: '2px 8px', fontSize: 13 }}>카톡: {contact.name}</span>
                                        <button type="button" style={btnPrimary} disabled={st.busy} onClick={() => send(g)}>
                                            {st.busy ? '처리 중...' : st.ok ? '다시 전송' : '카톡 전송'}
                                        </button>
                                        <button
                                            type="button"
                                            style={btn}
                                            disabled={st.busy}
                                            onClick={() => { setEditing((p) => ({ ...p, [g.vendor]: true })); setPicks((p) => ({ ...p, [g.vendor]: String(contact.id) })); }}
                                        >
                                            매칭 변경
                                        </button>
                                        <button type="button" style={btn} disabled={st.busy} onClick={() => saveExcluded([...new Set([...excluded, g.vendor])])} title="이 거래처를 제외 거래처에 추가">
                                            제외
                                        </button>
                                    </div>
                                ) : (
                                    <div>
                                        <div style={{ color: '#b45309', marginBottom: 4 }}>
                                            {contact ? '매칭된 카톡을 바꿉니다.' : '처음 보내는 거래처입니다. 카카오톡 친구를 직접 골라 매칭하세요. (한 번 저장하면 다음부터 자동)'}
                                        </div>
                                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                                            <input
                                                style={input}
                                                placeholder="카톡 친구 검색"
                                                value={filters[g.vendor] || ''}
                                                onChange={(e) => setFilters((p) => ({ ...p, [g.vendor]: e.target.value }))}
                                            />
                                            <select style={input} value={picks[g.vendor] || ''} onChange={(e) => setPicks((p) => ({ ...p, [g.vendor]: e.target.value }))}>
                                                <option value="">친구 선택 ({options.length}명)</option>
                                                {options.map((c) => <option key={c.id} value={c.id}>{c.kind === 'group' ? `[단톡] ${c.name}` : c.name}</option>)}
                                            </select>
                                            <button type="button" style={btnPrimary} onClick={() => saveMatch(g.vendor)}>매칭 저장</button>
                                            {contact && <button type="button" style={btn} onClick={() => setEditing((p) => ({ ...p, [g.vendor]: false }))}>취소</button>}
                                            <button type="button" style={btn} onClick={() => saveExcluded([...new Set([...excluded, g.vendor])])} title="이 거래처를 제외 거래처에 추가">제외</button>
                                        </div>
                                    </div>
                                )}
                                {st.msg && <div style={{ marginTop: 4, color: st.ok === false ? '#dc2626' : '#15803d' }}>{st.msg}</div>}
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}
