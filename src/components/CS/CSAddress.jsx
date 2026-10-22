import { useEffect, useState } from 'react';
import { Search } from 'lucide-react';
import styles from './CSAddress.module.css';
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

/**
 * 주문번호로 이지어드민 주문을 검색하고 배송지(주소·우편번호)를 바꾼다.
 * initialOrderNo 가 있으면 열릴 때 바로 검색한다.
 */
export default function CSAddress({ initialOrderNo = '' }) {
    const [orderNo, setOrderNo] = useState(String(initialOrderNo || ''));
    const [searching, setSearching] = useState(false);
    const [error, setError] = useState('');
    const [packs, setPacks] = useState(null);
    const [selectedPack, setSelectedPack] = useState(null);

    const [query, setQuery] = useState('');
    const [lookup, setLookup] = useState(null);
    const [lookingUp, setLookingUp] = useState(false);
    const [address, setAddress] = useState('');
    const [zip, setZip] = useState('');
    const [detail, setDetail] = useState('');

    const [confirming, setConfirming] = useState(false);
    const [allowShipped, setAllowShipped] = useState(false);
    const [changing, setChanging] = useState(false);
    const [result, setResult] = useState(null);

    const search = async (value = orderNo) => {
        const keyword = String(value || '').trim();
        if (!keyword) return;
        setSearching(true);
        setError('');
        setResult(null);
        setPacks(null);
        setSelectedPack(null);
        try {
            const data = await call('/address/search', { method: 'POST', body: { order_no: keyword } });
            setPacks(data.packs);
            // 한 건이면 바로 선택해서 변경 단계로 넘어간다.
            if (data.packs.length === 1) selectPack(data.packs[0]);
        } catch (e) {
            setError(e.message);
        } finally {
            setSearching(false);
        }
    };

    // 채팅방에서 넘어온 주문번호는 열리자마자 검색
    useEffect(() => {
        if (initialOrderNo) search(String(initialOrderNo));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [initialOrderNo]);

    const selectPack = (pack) => {
        setSelectedPack(pack);
        setQuery('');
        setLookup(null);
        setAddress('');
        setZip('');
        setDetail('');
        setConfirming(false);
        setAllowShipped(false);
        setResult(null);
    };

    const searchAddress = async () => {
        if (query.trim().length < 2) return;
        setLookingUp(true);
        setError('');
        try {
            setLookup(await call(`/address/lookup?q=${encodeURIComponent(query.trim())}`));
        } catch (e) {
            setError(e.message);
        } finally {
            setLookingUp(false);
        }
    };

    const pickAddress = (item, a) => {
        setZip(item.zonecode);
        setAddress(a.short);
    };

    const finalAddress = [address.trim(), detail.trim()].filter(Boolean).join(' ');
    const canChange = selectedPack && /^\d{5}$/.test(zip) && address.trim().length > 0;
    const shipped = !!selectedPack?.trans_no;

    const change = async () => {
        setChanging(true);
        setError('');
        try {
            const data = await call('/address/change', {
                method: 'POST',
                body: {
                    pack: selectedPack.pack,
                    address: finalAddress,
                    zip,
                    expected_address: selectedPack.address,
                    expected_zip: selectedPack.zip,
                    allow_shipped: allowShipped,
                },
            });
            setResult(data);
            setConfirming(false);
            // 화면의 현재 주소도 새 값으로 갱신
            const updated = { ...selectedPack, address: data.after.address, zip: data.after.zip };
            setSelectedPack(updated);
            setPacks((prev) => prev.map((p) => (p.pack === updated.pack ? updated : p)));
            setAddress('');
            setZip('');
            setDetail('');
            setLookup(null);
        } catch (e) {
            setError(e.message);
            setConfirming(false);
        } finally {
            setChanging(false);
        }
    };

    return (
        <div className={styles.wrap}>
            <section className={styles.card}>
                <h3>주문번호로 검색</h3>
                <div className={styles.row}>
                    <input
                        className={styles.grow}
                        placeholder="주문번호 (예: 1791445987849)"
                        value={orderNo}
                        onChange={(e) => setOrderNo(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && search()}
                    />
                    <button type="button" className={styles.primary} disabled={searching || !orderNo.trim()} onClick={() => search()}>
                        <Search size={14} /> {searching ? '검색 중…' : '검색'}
                    </button>
                </div>
                <div className={styles.muted}>이지어드민에 있는 최근 90일 주문에서 찾아요. 변경은 이지어드민에만 반영되고, 에이블리 주문 정보는 바뀌지 않아요.</div>
                {error && <div className={styles.warn}>{error}</div>}
            </section>

            {packs && packs.length === 0 && <div className={styles.empty}>검색된 주문이 없어요. 주문번호를 다시 확인해 주세요.</div>}

            {packs && packs.length > 0 && (
                <section className={styles.card}>
                    <h3>
                        검색 결과 {packs.length}건
                        {packs.length > 1 && <span className={styles.hint}> · 변경할 주문을 선택하세요</span>}
                    </h3>
                    {packs.map((p) => (
                        <button
                            type="button"
                            key={p.pack}
                            className={`${styles.pack} ${selectedPack?.pack === p.pack ? styles.packOn : ''}`}
                            onClick={() => selectPack(p)}
                        >
                            <span className={styles.packTop}>
                                <span className={styles.shop}>{p.shop_name || '-'}</span>
                                <strong>{p.order_id}</strong>
                                {!p.exact && <span className={styles.tag}>주문번호 불일치</span>}
                                {p.trans_no && <span className={styles.tagWarn}>송장 발행됨</span>}
                                <span className={styles.muted}>수집 {p.collect_date} · 합포 {p.pack} · 상태 {p.status}</span>
                            </span>
                            <span className={styles.packBody}>
                                <span>{p.recv_name || '-'}{p.tel_tail ? ` (연락처 ****${p.tel_tail})` : ''}</span>
                                <span className={styles.addr}>[{p.zip || '-'}] {p.address || '-'}</span>
                                <span className={styles.muted}>
                                    {p.items.map((i) => `${i.name} ${i.options} ×${i.qty}`).join(' / ')}
                                </span>
                            </span>
                        </button>
                    ))}
                </section>
            )}

            {selectedPack && (
                <section className={styles.card}>
                    <h3>새 주소</h3>
                    <div className={styles.current}>
                        <span className={styles.muted}>현재</span> [{selectedPack.zip || '-'}] {selectedPack.address}
                    </div>

                    <div className={styles.row}>
                        <input
                            className={styles.grow}
                            placeholder="도로명/지번 검색 (예: 테헤란로 152, 암사동 502-13)"
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && searchAddress()}
                        />
                        <button type="button" className={styles.secondary} disabled={lookingUp || query.trim().length < 2} onClick={searchAddress}>
                            {lookingUp ? '검색 중…' : '주소 검색'}
                        </button>
                    </div>
                    {lookup && lookup.items.length === 0 && (
                        <div className={styles.muted}>검색 결과가 없어요. 도로명+번호 또는 동+지번으로 다시 검색하거나 아래에 직접 입력하세요.</div>
                    )}
                    {lookup && lookup.items.length > 0 && (
                        <div className={styles.results}>
                            {lookup.total > lookup.items.length && (
                                <div className={styles.muted}>검색 결과가 많아요. 더 구체적으로 검색해 주세요. (상위 {lookup.items.length}건 표시)</div>
                            )}
                            {lookup.items.map((item) =>
                                item.addresses.map((a) => (
                                    <button type="button" key={`${item.zonecode}-${a.type}-${a.address}`} className={styles.result} onClick={() => pickAddress(item, a)}>
                                        <span className={styles.zip}>{item.zonecode}</span>
                                        <span className={styles.tag}>{a.type === 'road' ? '도로명' : '지번'}</span>
                                        <span>{a.short}{a.building ? ` (${a.building})` : ''}</span>
                                    </button>
                                )),
                            )}
                        </div>
                    )}

                    <div className={styles.form}>
                        <label>
                            우편번호
                            <input value={zip} maxLength={5} onChange={(e) => setZip(e.target.value.replace(/\D/g, ''))} placeholder="5자리" />
                        </label>
                        <label className={styles.grow}>
                            주소 (선택하면 채워져요, 직접 고쳐도 돼요)
                            <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="예: 서울 강남구 테헤란로 152" />
                        </label>
                        <label className={styles.grow}>
                            상세주소
                            <input value={detail} onChange={(e) => setDetail(e.target.value)} placeholder="예: 101동 1202호" />
                        </label>
                    </div>

                    {canChange && (
                        <div className={styles.preview}>
                            <div><span className={styles.muted}>변경 전</span> [{selectedPack.zip || '-'}] {selectedPack.address}</div>
                            <div><span className={styles.muted}>변경 후</span> <b>[{zip}] {finalAddress}</b></div>
                        </div>
                    )}

                    {!confirming && (
                        <button type="button" className={styles.primary} disabled={!canChange || changing} onClick={() => setConfirming(true)}>
                            주소 변경
                        </button>
                    )}
                    {confirming && (
                        <div className={styles.confirm}>
                            <div>
                                <b>{selectedPack.recv_name}</b>님 주문 <b>{selectedPack.order_id}</b>의 배송지를 위 주소로 변경할까요?
                                <div className={styles.muted}>이지어드민에 바로 반영되고, 에이블리 주문 정보는 바뀌지 않아요.</div>
                            </div>
                            {shipped && (
                                <label className={styles.check}>
                                    <input type="checkbox" checked={allowShipped} onChange={(e) => setAllowShipped(e.target.checked)} />
                                    이미 송장({selectedPack.trans_corp} {selectedPack.trans_no})이 발행된 주문이에요. 그래도 변경합니다.
                                </label>
                            )}
                            <div className={styles.row}>
                                <button type="button" className={styles.danger} disabled={changing || (shipped && !allowShipped)} onClick={change}>
                                    {changing ? '변경 중…' : '확인, 변경합니다'}
                                </button>
                                <button type="button" className={styles.secondary} disabled={changing} onClick={() => setConfirming(false)}>취소</button>
                            </div>
                        </div>
                    )}

                    {result && (
                        <div className={result.verified ? styles.done : styles.warn}>
                            {result.verified ? '변경 완료' : '변경 요청은 보냈지만 이지어드민에서 새 주소가 확인되지 않아요. 직접 확인해 주세요.'}
                            <div>변경 전 [{result.before.zip}] {result.before.address}</div>
                            <div>변경 후 [{result.after.zip}] {result.after.address}</div>
                        </div>
                    )}
                </section>
            )}
        </div>
    );
}
