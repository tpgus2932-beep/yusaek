import { useMemo, useState } from 'react';
import { call } from './kakaoApi';
import styles from './KakaoRefresh.module.css';

const isoDay = (offset = 0) => {
    const d = new Date();
    d.setDate(d.getDate() - offset);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const fmt = (iso) => {
    const d = new Date(iso);
    if (!iso || Number.isNaN(d.getTime())) return '';
    const h = d.getHours();
    return `${d.getMonth() + 1}월 ${d.getDate()}일 ${h < 12 ? '오전' : '오후'} ${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/**
 * 최신화: 폰의 채팅 목록에서 마지막 최신화 이후 바뀐 방을 찾아 대화를 가져온다.
 * 모달 — 바깥을 눌러도 닫히지 않고 '닫기'로만 닫힌다(진행 중이어도 작업은 계속된다).
 */
const KakaoRefresh = ({ status, connected, onClose, onNotice, onChanged }) => {
    const refresh = status?.refresh || {};
    const last = status?.lastRefresh || null;
    const lastAt = status?.lastRefreshAt || '';
    const [since, setSince] = useState('');
    const [customDate, setCustomDate] = useState(false);
    const [starting, setStarting] = useState(false);

    const first = !lastAt;
    const running = !!refresh.running;
    const result = refresh.result || (!running ? last : null);
    const percent = refresh.total ? Math.round((refresh.done / refresh.total) * 100) : 0;
    const canStart = connected && !running && !starting && (!first || !!since);

    const registered = useMemo(() => result?.registered || [], [result]);

    const start = async () => {
        if (!canStart) return;
        setStarting(true);
        try {
            const data = await call('/refresh', { method: 'POST', body: since ? { since } : {} });
            onNotice(`${data.since}부터 최신화를 시작합니다. 끝날 때까지 폰을 만지지 마세요.`);
            onChanged();
        } catch (err) {
            onNotice(err.message);
        } finally {
            setStarting(false);
        }
    };

    const cancel = async () => {
        try { await call('/refresh/cancel', { method: 'POST' }); onNotice('현재 확인 중인 방까지만 마치고 멈춥니다.'); } catch (err) { onNotice(err.message); }
    };

    const exclude = async (contact) => {
        if (!window.confirm(`'${contact.name}' 방을 목록에서 지우고, 앞으로 자동 등록하지 않을까요?`)) return;
        try {
            await call(`/contacts/${contact.id}/exclude`, { method: 'POST' });
            onNotice(`'${contact.name}' 방을 제외했습니다.`);
            onChanged();
        } catch (err) {
            onNotice(err.message);
        }
    };

    const ackAll = async () => {
        try { await call('/contacts/ack-new', { method: 'POST', body: {} }); onChanged(); } catch (err) { onNotice(err.message); }
    };

    return (
        <div className={styles.overlay}>
            <div className={styles.modal} role="dialog" aria-modal="true" aria-label="최신화">
                <header className={styles.head}>
                    <h2>최신화</h2>
                    <span>{lastAt ? `마지막 최신화 ${fmt(lastAt)}` : '아직 최신화한 적이 없습니다'}</span>
                    <button type="button" className={styles.closeBtn} onClick={onClose}>닫기</button>
                </header>

                <div className={styles.body}>
                    {!running && (
                        <section className={styles.card}>
                            <h3>폰의 새 대화 가져오기</h3>
                            <p className={styles.desc}>
                                폰 카카오톡의 채팅 목록을 읽어서 {first ? '선택한 날짜 이후' : '마지막 최신화 이후'}에 바뀐 방만 골라 들어가 대화를 가져옵니다.
                                PC 카카오톡이나 폰에서 직접 주고받은 대화도 같은 계정이면 함께 가져옵니다.
                            </p>
                            {(first || customDate) && (
                                <div className={styles.dateBox}>
                                    <b>{first ? '어느 날짜부터 가져올까요?' : '시작 날짜 직접 지정'}</b>
                                    <div className={styles.presets}>
                                        {[[0, '오늘'], [1, '어제'], [3, '3일 전'], [7, '7일 전'], [30, '30일 전']].map(([d, label]) => (
                                            <button key={label} type="button" className={since === isoDay(d) ? styles.presetOn : ''} onClick={() => setSince(isoDay(d))}>{label}</button>
                                        ))}
                                    </div>
                                    <input type="date" value={since} max={isoDay(0)} onChange={(e) => setSince(e.target.value)} />
                                </div>
                            )}
                            {!first && !customDate && (
                                <button type="button" className={styles.linkBtn} onClick={() => setCustomDate(true)}>시작 날짜를 직접 지정하기</button>
                            )}
                            <ul className={styles.notes}>
                                <li>등록되지 않은 1:1 방은 <b>새 친구로 자동 등록</b>하고 "신규" 표시를 붙입니다. (단톡방과 카카오 서비스·알림 방은 제외)</li>
                                <li>방마다 5~10초쯤 걸립니다. 읽는 동안 폰을 만지지 마세요. 끝나면 폰 화면이 잠깁니다.</li>
                                <li>전송 대기 중인 메시지가 있으면 시작할 수 없습니다.</li>
                            </ul>
                            <div className={styles.startRow}>
                                <span className={styles.hint}>
                                    {!connected ? '휴대폰이 연결되지 않았습니다. 왼쪽 아래 … 에서 먼저 연결하세요.'
                                        : first && !since ? '시작 날짜를 선택하세요.' : ''}
                                </span>
                                <button type="button" className={styles.start} disabled={!canStart} onClick={start}>
                                    {starting ? '시작하는 중…' : `최신화 시작${since && !first ? ` (${since}부터)` : ''}`}
                                </button>
                            </div>
                        </section>
                    )}

                    {running && (
                        <section className={styles.card}>
                            <h3>{refresh.phase || '진행 중'}</h3>
                            <div className={styles.bar}><i style={{ width: `${refresh.total ? percent : 8}%` }} className={refresh.total ? '' : styles.barIdle} /></div>
                            <p className={styles.progress}>
                                {refresh.total ? <>방 <b>{refresh.done}</b> / {refresh.total} 확인 중{refresh.current ? <> · <em>{refresh.current}</em></> : null}</> : '채팅 목록을 읽고 바뀐 방을 찾는 중입니다…'}
                            </p>
                            <p className={styles.desc}>이 창을 닫아도 계속 진행됩니다. 끝날 때까지 폰을 만지지 마세요.</p>
                            <div className={styles.startRow}>
                                <span className={styles.hint} />
                                <button type="button" className={styles.stop} onClick={cancel}>중단</button>
                            </div>
                        </section>
                    )}

                    {refresh.error && !running && <div className={styles.error}>{refresh.error}</div>}

                    {result && !running && (
                        <section className={styles.card}>
                            <h3>지난 결과 <small>{fmt(result.finishedAt || result.startedAt)}</small></h3>
                            <div className={styles.stats}>
                                <div><b>{result.scanned}</b><span>읽은 방</span></div>
                                <div><b>{result.candidates}</b><span>바뀐 방</span></div>
                                <div><b>{result.importedRooms}</b><span>가져온 방</span></div>
                                <div><b>{result.importedMessages}</b><span>가져온 메시지</span></div>
                            </div>
                            <p className={styles.sub}>변화 없음 {result.unchanged}개 · 단톡방 {result.groups}개 건너뜀 · {result.since}부터</p>

                            {registered.length > 0 && (
                                <div className={styles.newBox}>
                                    <div className={styles.newHead}>
                                        <b>새 친구 {registered.length}명이 자동 등록되었습니다</b>
                                        <button type="button" onClick={ackAll}>모두 확인</button>
                                    </div>
                                    <p>잘못 등록된 방이면 "제외"를 누르세요. 목록에서 지우고 다음부터 등록하지 않습니다.</p>
                                    {registered.map((c) => (
                                        <div key={c.id} className={styles.newRow}>
                                            <span className={styles.newTag}>신규</span>
                                            <span className={styles.newName}>{c.name}</span>
                                            <button type="button" onClick={() => exclude(c)}>제외</button>
                                        </div>
                                    ))}
                                </div>
                            )}

                            {result.skipped?.length > 0 && (
                                <details className={styles.skipped}>
                                    <summary>건너뛴 방 {result.skipped.length}개</summary>
                                    {result.skipped.map((s) => (
                                        <div key={`${s.name}-${s.reason}`} className={styles.skipRow}><b>{s.name}</b><span>{s.reason}</span></div>
                                    ))}
                                </details>
                            )}
                        </section>
                    )}
                </div>
            </div>
        </div>
    );
};

export default KakaoRefresh;
