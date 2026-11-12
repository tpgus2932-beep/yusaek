import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Play, Truck, X } from 'lucide-react';
import styles from './EzautoButtons.module.css';
import { LOCAL_API_BASE as API, getAuthHeaders, handleUnauthorized } from '../../lib/api';

const KINDS = {
    auto_order: { label: '자동발주', path: '/ezauto/auto-order', icon: <Play size={15} />, hint: '에이블리·아무드 신규 주문 확인 + 이지어드민 발주 입력' },
    invoice: { label: '판매처 송장등록', short: '송장등록', path: '/ezauto/register-invoices', icon: <Truck size={15} />, hint: '이지어드민에서 출고된 건의 송장을 에이블리에 전송' },
};

// 화면에 보여줄 작업. 판매처 송장등록은 구현해 두었지만 당분간 숨긴다 (다시 쓰려면 'invoice'를 추가).
const VISIBLE_KINDS = ['auto_order'];

const num = (v) => (v === null || v === undefined || v === '' ? '-' : Number(v).toLocaleString());

const FAIL_REASON = { EMPTY_EXPORT_INFO: '통관 정보 없음' };

// 판매처 한 곳의 자동발주 결과 -> 표시할 줄들 ({ text, bad })
function shopLines(s) {
    if (!s.ok) return [{ text: `${s.shop} 실패: ${s.error}`, bad: true }];
    const r = s.result || {};
    const lines = [{ text: `${s.shop}: 주문확인 ${num(r.confirmed)}건` + (r.confirm_failed ? `, 확인 실패 ${num(r.confirm_failed)}건` : '') }];
    if (r.confirm_failed && r.fail_reasons) {
        const why = Object.entries(r.fail_reasons).map(([k, v]) => `${FAIL_REASON[k] || k} ${num(v)}건`).join(', ');
        lines.push({ text: `  확인 실패 사유: ${why}`, bad: true });
    }
    if (r.uploaded === false) {
        lines.push({ text: `  ${r.message || '이지어드민에 입력할 주문이 없습니다.'}` });
        return lines;
    }
    lines.push({ text: `  준비중 주문 ${num(r.items)}건을 이지어드민으로 보냄` });
    lines.push({ text: `  이지어드민 신규 ${num(r.ez_new)}건 입력 (전체 ${num(r.ez_total)}건 중 이미 있던 주문 제외), 발주 ${num(r.ez_balju)}건` });
    return lines;
}

function resultLines(kind, r) {
    if (!r) return [];
    if (kind === 'auto_order') {
        if (Array.isArray(r.shops)) return r.shops.flatMap(shopLines);
        // 판매처 구분이 없던 예전 형식의 마지막 결과
        return shopLines({ ok: true, shop: '에이블리', result: r });
    }
    const lines = [
        `상품준비중 주문 ${num(r.checked)}건 중 이지어드민 출고처리 ${num(r.shipped)}건 확인`,
        `에이블리 송장 전송 성공 ${num(r.sent)}건` + (r.failed ? `, 실패 ${num(r.failed)}건` : ''),
    ];
    if (r.skipped_corp) lines.push(`롯데택배가 아닌 ${num(r.skipped_corp)}건은 잘못 전송하지 않도록 제외했어요`);
    if (r.errors && Object.keys(r.errors).length) lines.push(`에이블리 오류: ${Object.entries(r.errors).map(([k, v]) => `${k} ${v.length}건`).join(', ')}`);
    return lines.map((text) => ({ text }));
}

export default function EzautoButtons() {
    const [status, setStatus] = useState({});
    const [openKind, setOpenKind] = useState(null);
    const [starting, setStarting] = useState(null);
    const timer = useRef(null);

    const refresh = useCallback(async () => {
        try {
            const res = await fetch(`${API}/ezauto/status`, { headers: getAuthHeaders() });
            if (handleUnauthorized(res) || !res.ok) return null;
            const data = await res.json();
            setStatus(data);
            return data;
        } catch {
            return null;
        }
    }, []);

    useEffect(() => { refresh(); }, [refresh]);

    const anyRunning = Object.values(status).some((j) => j?.running);
    useEffect(() => {
        if (!anyRunning) return undefined;
        timer.current = setInterval(refresh, 2000);
        return () => clearInterval(timer.current);
    }, [anyRunning, refresh]);

    const start = async (kind) => {
        if (starting || status[kind]?.running) {
            setOpenKind(kind); // 이미 실행 중이면 진행 창만 보여준다
            return;
        }
        setStarting(kind);
        try {
            const res = await fetch(`${API}${KINDS[kind].path}`, { method: 'POST', headers: getAuthHeaders() });
            if (handleUnauthorized(res)) return;
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                window.alert(data.detail || `${KINDS[kind].label}을(를) 시작하지 못했습니다 (HTTP ${res.status})`);
                if (res.status === 409) setOpenKind(kind);
                await refresh();
                return;
            }
            setOpenKind(kind);
            await refresh();
        } catch {
            window.alert('서버에 연결하지 못했습니다.');
        } finally {
            setStarting(null);
        }
    };

    const job = openKind ? status[openKind] : null;
    const partial = Array.isArray(job?.result?.shops) && job.result.shops.some((x) => !x.ok);
    const state = !job ? '' : job.running ? 'running' : job.error ? 'error' : partial ? 'partial' : job.finished_at ? 'done' : 'idle';

    return (
        <>
            {VISIBLE_KINDS.map((kind) => {
                const { label, short, icon, hint } = KINDS[kind];
                const running = status[kind]?.running || starting === kind;
                return (
                    <button
                        key={kind}
                        type="button"
                        className={`${styles.btn} ${running ? styles.btnRunning : ''}`}
                        onClick={() => start(kind)}
                        title={running ? `${label} 실행 중 (눌러서 진행 상황 보기)` : `${label}: ${hint}`}
                    >
                        {running ? <Loader2 size={15} className={styles.spin} /> : icon}
                        {short || label}
                    </button>
                );
            })}

            {job && (
                <div className={styles.overlay} onClick={() => setOpenKind(null)} role="presentation">
                    <div className={styles.modal} onClick={(e) => e.stopPropagation()} role="dialog" aria-label={KINDS[openKind].label}>
                        <div className={styles.modalHead}>
                            <strong>{KINDS[openKind].label}</strong>
                            <button type="button" className={styles.close} onClick={() => setOpenKind(null)} aria-label="닫기"><X size={16} /></button>
                        </div>
                        <div className={`${styles.badge} ${styles[`badge_${state}`] || ''}`}>
                            {state === 'running' && <><Loader2 size={14} className={styles.spin} /> 실행 중...</>}
                            {state === 'done' && '완료'}
                            {state === 'partial' && '일부 실패'}
                            {state === 'error' && '실패'}
                            {state === 'idle' && '대기'}
                        </div>
                        <div className={styles.meta}>
                            {job.started_at && <>시작 {job.started_at}{job.started_by ? ` · ${job.started_by}` : ''}</>}
                            {job.finished_at && <> · 종료 {job.finished_at}</>}
                        </div>
                        {job.steps?.length > 0 && (
                            <ul className={styles.steps}>
                                {job.steps.map((s, i) => <li key={`${i}-${s}`}>{s}</li>)}
                            </ul>
                        )}
                        {job.error && <div className={styles.error}>{job.error}</div>}
                        {(state === 'done' || state === 'partial') && (
                            <ul className={styles.result}>
                                {resultLines(openKind, job.result).map((l) => <li key={l.text} className={l.bad ? styles.bad : undefined}>{l.text}</li>)}
                            </ul>
                        )}
                    </div>
                </div>
            )}
        </>
    );
}
