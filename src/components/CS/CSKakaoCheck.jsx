import { useState } from 'react';
import { LOCAL_API_BASE, getAuthHeaders, handleUnauthorized } from '../../lib/api';
import { call as kakaoCall } from '../KakaoTalk/kakaoApi';
import KakaoTalkPage from '../KakaoTalk/KakaoTalkPage';
import styles from './CSStock.module.css';

// 거래처 ↔ 카카오톡 친구 매칭은 바코드 불량 목록 카톡 전송과 같은 저장소를 쓴다 (한쪽에서 잡으면 양쪽에 적용).
const MAP_URL = `${LOCAL_API_BASE}/barcode/defect/kakao-vendor-map`;

/**
 * 재고 옵션 아래의 "카카오톡 확인" 버튼.
 * 화면(탭)을 넘기지 않고 모달로 이 상품 거래처의 카톡 대화방을 연다. 매칭이 없으면 친구를 직접 골라 매칭한 뒤 연다.
 */
export default function CSKakaoCheck({ vendor }) {
    const name = String(vendor || '').trim();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [contacts, setContacts] = useState(null); // null = 아직 안 불러옴
    const [mapped, setMapped] = useState(null); // 매칭된 contact
    const [picking, setPicking] = useState(false);
    const [filter, setFilter] = useState('');
    const [pick, setPick] = useState('');

    const [chat, setChat] = useState({ id: null, n: 0 }); // 모달로 열 대화방
    const openChat = (contactId) => setChat((c) => ({ id: contactId, n: c.n + 1 }));

    const load = async () => {
        const [mapRes, kakao] = await Promise.all([fetch(MAP_URL, { headers: getAuthHeaders() }), kakaoCall('/contacts')]);
        if (handleUnauthorized(mapRes)) throw new Error('로그인이 만료되었습니다.');
        const mapData = await mapRes.json().catch(() => ({}));
        const list = kakao.contacts || [];
        setContacts(list);
        const found = list.find((c) => c.id === (mapData.map || {})[name]) || null;
        setMapped(found);
        return found;
    };

    const onCheck = async () => {
        if (!name) return;
        setBusy(true);
        setError('');
        try {
            const found = await load();
            if (found) openChat(found.id);
            else setPicking(true);
        } catch (e) {
            setError(e.message || '카카오톡 정보를 불러오지 못했어요.');
        } finally {
            setBusy(false);
        }
    };

    const saveAndOpen = async () => {
        const contactId = Number(pick);
        if (!contactId) { setError('카카오톡 친구를 선택하세요.'); return; }
        setBusy(true);
        setError('');
        try {
            const res = await fetch(MAP_URL, {
                method: 'POST',
                headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ vendor: name, contact_id: contactId }),
            });
            if (handleUnauthorized(res)) return;
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.detail || '매칭 저장 실패');
            setMapped(contacts.find((c) => c.id === contactId) || null);
            setPicking(false);
            openChat(contactId);
        } catch (e) {
            setError(e.message || '매칭 저장 실패');
        } finally {
            setBusy(false);
        }
    };

    const kw = filter.trim().toLowerCase();
    const options = (contacts || []).filter((c) => !kw || c.name.toLowerCase().includes(kw)).slice(0, 60);

    return (
        <div className={styles.editor} style={{ width: '100%', marginTop: 8 }}>
            <button type="button" className={styles.kakaoBtn} disabled={busy || !name} onClick={onCheck} title={name ? '' : '거래처 정보가 없어요'}>
                {busy ? '확인 중…' : `카카오톡 확인 · ${name || '거래처 없음'}${mapped ? ` → ${mapped.name}` : ''}`}
            </button>
            {mapped && !picking && (
                <button type="button" className={styles.link} onClick={() => { setPick(String(mapped.id)); setPicking(true); }}>매칭 변경</button>
            )}
            {picking && (
                <div style={{ width: '100%', display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                    <span className={styles.warn} style={{ margin: 0 }}>
                        {mapped ? '매칭할 카카오톡 친구를 바꿉니다.' : '이 거래처는 아직 카톡 매칭이 없어요. 친구를 직접 골라 매칭하세요.'}
                    </span>
                    <input placeholder="카톡 친구 검색" value={filter} onChange={(e) => setFilter(e.target.value)} />
                    <select value={pick} onChange={(e) => setPick(e.target.value)}>
                        <option value="">친구 선택 ({options.length}명)</option>
                        {options.map((c) => <option key={c.id} value={c.id}>{c.kind === 'group' ? `[단톡] ${c.name}` : c.name}</option>)}
                    </select>
                    <button type="button" className={styles.btnSmall} disabled={busy} onClick={saveAndOpen}>매칭하고 열기</button>
                    <button type="button" className={styles.link} onClick={() => setPicking(false)}>취소</button>
                </div>
            )}
            {error && <div className={styles.warn} style={{ width: '100%' }}>{error}</div>}
            {chat.id && (
                <div
                    style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
                    onClick={() => setChat({ id: null, n: chat.n })}
                >
                    <div
                        style={{ width: 'min(1100px, 96vw)', height: 'min(86vh, 900px)', display: 'flex', flexDirection: 'column', background: '#fff', borderRadius: 16, overflow: 'hidden' }}
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 14px', background: '#fee500', color: '#3c1e1e', fontWeight: 700 }}>
                            <span>카카오톡 · {name}{mapped ? ` → ${mapped.name}` : ''}</span>
                            <button type="button" onClick={() => setChat({ id: null, n: chat.n })} style={{ border: 'none', background: 'transparent', fontSize: 20, cursor: 'pointer', color: '#3c1e1e' }} aria-label="닫기">×</button>
                        </div>
                        <KakaoTalkPage openContactId={chat.id} openNonce={chat.n} />
                    </div>
                </div>
            )}
        </div>
    );
}
