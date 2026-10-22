import { Fragment, useEffect, useState } from 'react';
import styles from './CSStock.module.css';
import { LOCAL_API_BASE, getAuthHeaders, handleUnauthorized } from '../../lib/api';

const SOURCE = { live: '이지어드민 실시간', snapshot: '저장된 재고(재고대시보드)', none: '재고 데이터 없음' };

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

const fmtTime = (iso) => {
    const d = new Date(iso);
    if (!iso || Number.isNaN(d.getTime())) return '';
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const todayStr = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const shortDate = (ymd) => (ymd ? `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}` : '');

// 상품명에서 [ ] ( ) 괄호와 안의 내용을 뺀다 (제목 표시용).
const cleanTitle = (name) => String(name || '').replace(/\[[^\]]*\]|\([^)]*\)|\{[^}]*\}/g, ' ').replace(/\s+/g, ' ').trim();

// 에이블리 주문번호(13자리)는 주문 시각(밀리초 타임스탬프)이라 결제일을 바로 알 수 있다.
// 이지어드민 주문일시와 분 단위까지 일치함을 확인했다. 한국 시간 기준 'YYYY-MM-DD HH:mm'.
const paidAt = (orderNo) => {
    const text = String(orderNo || '').trim();
    if (!/^\d{13}$/.test(text)) return '';
    const kst = new Date(Number(text) + 9 * 3600 * 1000);
    const year = kst.getUTCFullYear();
    if (year < 2020 || year > 2100) return '';
    const p = (n) => String(n).padStart(2, '0');
    return `${year}-${p(kst.getUTCMonth() + 1)}-${p(kst.getUTCDate())} ${p(kst.getUTCHours())}:${p(kst.getUTCMinutes())}`;
};

// 백엔드 option_key()와 같은 규칙: 공백·/·, 로 쪼개 소문자 정렬 후 | 로 잇는다.
const tokenKey = (parts) =>
    (parts || [])
        .flatMap((p) => String(p || '').split(/[\s/,]+/))
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean)
        .sort()
        .join('|');

/**
 * 채팅방 주문정보 아래에 붙는 옵션별 재고.
 * goods: {sno, name}, asked: {options, optionNo, code} — 고객이 문의한 옵션(행 강조용)
 * orderNo: 이 문의의 에이블리 주문번호 — 대기 주문 순번 확인에 쓴다
 * title: 여러 상품을 함께 보여줄 때 구분용 제목, lookupSignal: 값이 바뀔 때마다 재고를 조회(전체 조회용)
 */
export default function CSStock({ goods, asked, orderNo, title = '', lookupSignal = 0 }) {
    const [result, setResult] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [showAll, setShowAll] = useState(false);
    const [editing, setEditing] = useState(null); // 입고 일정을 수정 중인 옵션 코드
    const [form, setForm] = useState({ date: '', note: '' });
    const [saving, setSaving] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(null); // 삭제 확인 중인 옵션 코드
    const [rank, setRank] = useState(null);
    const [rankLoading, setRankLoading] = useState(false);
    const [rankError, setRankError] = useState('');

    // 마지막으로 조회한 결과가 있으면 바로 보여준다.
    useEffect(() => {
        let cancelled = false;
        call(`/stock/${goods.sno}`)
            .then((data) => {
                if (!cancelled) setResult(data.result);
            })
            .catch(() => {});
        return () => {
            cancelled = true;
        };
    }, [goods.sno]);

    const lookup = async () => {
        setLoading(true);
        setError('');
        try {
            setResult(await call('/stock/lookup', { method: 'POST', body: { goods_sno: goods.sno, name: goods.name } }));
        } catch (e) {
            setError(e.message);
        } finally {
            setLoading(false);
        }
    };

    // '전체 재고 조회'가 눌릴 때마다 이 상품도 함께 조회한다.
    useEffect(() => {
        if (lookupSignal > 0) lookup();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [lookupSignal]);

    // 이지어드민 대기 주문(I104) 중 에이블리(유색) 기준으로 이 주문이 몇 번째인지 확인
    const checkRank = async () => {
        setRankLoading(true);
        setRankError('');
        try {
            setRank(
                await call('/order-rank', {
                    method: 'POST',
                    body: {
                        goods_sno: goods.sno,
                        name: goods.name,
                        options: asked?.options || [],
                        goods_option_sno: asked?.optionNo ?? null,
                        order_no: orderNo,
                    },
                }),
            );
        } catch (e) {
            setRank(null);
            setRankError(e.message);
        } finally {
            setRankLoading(false);
        }
    };

    const startEdit = (o) => {
        setEditing(o.code);
        setForm({ date: o.inbound?.expected_date || '', note: o.inbound?.note || '' });
        setError('');
    };

    // codes 의 입고 일정을 저장하고(clear=true 면 삭제) 화면의 값도 바로 갱신한다.
    const saveInbound = async (codes, clear = false) => {
        setSaving(true);
        setError('');
        try {
            const data = await call('/inbound', {
                method: 'PUT',
                body: { codes, expected_date: clear ? '' : form.date, note: clear ? '' : form.note },
            });
            setResult((prev) => ({
                ...prev,
                options: prev.options.map((o) => (data.codes.includes(o.code) ? { ...o, inbound: data.inbound } : o)),
            }));
            setEditing(null);
            setConfirmDelete(null);
        } catch (e) {
            setError(e.message);
        } finally {
            setSaving(false);
        }
    };

    const askedKey = tokenKey(asked?.options);
    const isAsked = (o) =>
        (asked?.code && o.code === asked.code)
        || (asked?.optionNo && o.option_no && String(o.option_no) === String(asked.optionNo))
        || (askedKey && o.key === askedKey);

    // 문의한 옵션을 찾았으면 그 옵션만 보여주고, 전체 옵션은 따로 펼쳐서 본다.
    const askedRows = result ? result.options.filter(isAsked) : [];
    const focusAsked = askedRows.length > 0 && !showAll;
    const rows = focusAsked ? askedRows : result?.options || [];

    return (
        <section className={styles.box}>
            {title && <div className={styles.title}>{cleanTitle(title)}</div>}
            <div className={styles.head}>
                <strong>옵션별 재고</strong>
                {result && (
                    <span className={styles.muted}>
                        {SOURCE[result.source]} · {fmtTime(result.fetched_at)} 기준 · 합계 {result.total_stock}개
                    </span>
                )}
                <button type="button" className={styles.btn} disabled={loading} onClick={lookup}>
                    {loading ? '조회 중…' : result ? '다시 조회' : '재고 조회'}
                </button>
            </div>
            {orderNo && (
                <div className={styles.rankBox}>
                    <div className={styles.head}>
                        <strong>내 주문 대기 순번</strong>
                        <span className={styles.muted}>
                            에이블리(유색) 기준 · 주문번호 {orderNo}
                            {paidAt(orderNo) && <> · 결제일 <b className={styles.paidAt}>{paidAt(orderNo)}</b></>}
                        </span>
                        <button type="button" className={styles.btn} disabled={rankLoading} onClick={checkRank}>
                            {rankLoading ? '확인 중…' : rank ? '다시 확인' : '순번 확인'}
                        </button>
                    </div>
                    {rankError && <div className={styles.warn}>{rankError}</div>}
                    {rank && rank.found && (
                        <div className={styles.rankLine}>
                            <b className={styles.rankNum}>{rank.rank}번째</b>
                            <span> / 대기 {rank.total}건 중</span>
                            <span className={styles.muted}>
                                {' '}· {rank.option.label} · 이 주문까지 누적 {rank.seller_cum_qty}개 (이지어드민 전체 누적 {rank.all_cum_qty}개)
                                {' '}· 현재고 {rank.stock ?? '-'}개 · {rank.deliverable === 'O' ? '배송 가능' : '재고 부족'}
                                {' '}· 발주 {rank.ordered_at}
                            </span>
                        </div>
                    )}
                    {rank && !rank.found && (
                        <div className={styles.muted}>
                            {rank.option.label} 대기 주문 {rank.total}건 중에 이 주문이 없어요. 이미 출고·취소됐거나 다른 옵션일 수 있어요.
                        </div>
                    )}
                    {rank && <div className={styles.muted}>{fmtTime(rank.fetched_at)} 이지어드민 기준</div>}
                </div>
            )}
            {error && (
                <div className={styles.warn}>
                    {error}
                    {error.includes('매칭') && ' (상품별 탭에서 원가베이스에 연결할 수 있어요)'}
                </div>
            )}
            {result?.note && <div className={styles.muted}>{result.note}</div>}
            {result && askedRows.length > 0 && (
                <div className={styles.viewToggle}>
                    <span className={styles.muted}>
                        {focusAsked ? `문의한 옵션 ${askedRows.length}개만 표시 중` : `전체 옵션 ${result.options.length}개 표시 중`}
                    </span>
                    <button type="button" className={styles.link} onClick={() => setShowAll((v) => !v)}>
                        {focusAsked ? `전체 옵션 보기 (${result.options.length})` : '문의 옵션만 보기'}
                    </button>
                </div>
            )}
            {result && (
                <div className={styles.tableWrap}>
                    <table className={styles.table}>
                        <thead>
                            <tr><th>옵션</th><th>재고</th><th>입고대기</th><th>입고 일정</th></tr>
                        </thead>
                        <tbody>
                            {rows.map((o) => (
                                <Fragment key={o.code}>
                                    <tr className={isAsked(o) ? styles.asked : ''}>
                                        <td>
                                            {o.label}
                                            {isAsked(o) && <span className={styles.askedTag}>문의 옵션</span>}
                                        </td>
                                        <td className={o.stock_qty > 0 ? styles.num : styles.zero}>{o.stock_qty > 0 ? o.stock_qty : '없음'}</td>
                                        <td>{o.stock_in_standby || '-'}</td>
                                        <td className={styles.inboundCell}>
                                            {o.inbound ? (
                                                <>
                                                    <div>
                                                        {o.inbound.expected_date && (
                                                            <b className={o.inbound.expected_date < todayStr() ? styles.zero : styles.inboundDate}>
                                                                {shortDate(o.inbound.expected_date)}
                                                                {o.inbound.expected_date < todayStr() && ' (지남)'}
                                                            </b>
                                                        )}
                                                        {o.inbound.note && <span> {o.inbound.note}</span>}
                                                    </div>
                                                    <div className={styles.muted}>
                                                        {fmtTime(o.inbound.updated_at)} 업데이트{o.inbound.updated_by ? ` · ${o.inbound.updated_by}` : ''}
                                                    </div>
                                                </>
                                            ) : (
                                                <span className={styles.muted}>-</span>
                                            )}
                                            <button type="button" className={styles.link} onClick={() => startEdit(o)}>
                                                {o.inbound ? '수정' : '입력'}
                                            </button>
                                            {o.inbound && confirmDelete !== o.code && (
                                                <button type="button" className={styles.linkDanger} onClick={() => setConfirmDelete(o.code)}>삭제</button>
                                            )}
                                            {o.inbound && confirmDelete === o.code && (
                                                <span className={styles.confirmInline}>
                                                    삭제할까요?{' '}
                                                    <button type="button" className={styles.linkDanger} disabled={saving} onClick={() => saveInbound([o.code], true)}>예</button>
                                                    <button type="button" className={styles.link} onClick={() => setConfirmDelete(null)}>아니오</button>
                                                </span>
                                            )}
                                        </td>
                                    </tr>
                                    {editing === o.code && (
                                        <tr className={styles.editRow}>
                                            <td colSpan={4}>
                                                <div className={styles.editor}>
                                                    <input type="date" value={form.date} onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))} />
                                                    <input
                                                        className={styles.noteInput}
                                                        placeholder="메모 (예: 2차 입고, 지연될 수 있음)"
                                                        maxLength={200}
                                                        value={form.note}
                                                        onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
                                                    />
                                                    <button type="button" className={styles.btnSmall} disabled={saving} onClick={() => saveInbound([o.code])}>저장</button>
                                                    <button
                                                        type="button"
                                                        className={styles.btnSmall}
                                                        disabled={saving}
                                                        title="이 상품의 모든 옵션에 같은 입고 일정을 적용해요"
                                                        onClick={() => saveInbound(result.options.map((x) => x.code))}
                                                    >
                                                        전체 옵션에 적용
                                                    </button>
                                                    <button type="button" className={styles.link} onClick={() => setEditing(null)}>취소</button>
                                                    {o.inbound && (
                                                        <button type="button" className={styles.linkDanger} disabled={saving} onClick={() => saveInbound([o.code], true)}>
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
            )}
        </section>
    );
}
