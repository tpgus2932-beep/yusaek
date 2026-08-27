import React, { useEffect, useMemo, useState } from 'react';
import pageStyles from '../Barcode/BarcodePage.module.css';
import { LOCAL_API_BASE as API, getAuthHeaders } from '../../lib/api';
import { useZigzagBulkUpload } from '../../lib/ZigzagBulkUploadContext';

const jsonHeaders = () => ({ 'Content-Type': 'application/json', ...getAuthHeaders() });

const ZigzagUploadPage = () => {
    const bulkUpload = useZigzagBulkUpload();

    const [page, setPage] = useState(1);
    const [maxPage, setMaxPage] = useState(1);
    const [totalCount, setTotalCount] = useState(0);
    const [items, setItems] = useState([]);
    const [loading, setLoading] = useState(false);
    const [message, setMessage] = useState(null); // { type, text }
    const [queryInput, setQueryInput] = useState('');
    const [query, setQuery] = useState('');
    const [dateFrom, setDateFrom] = useState('');
    const [dateTo, setDateTo] = useState('');
    const [syncedAt, setSyncedAt] = useState(null);
    const [syncing, setSyncing] = useState(false);
    const [uploadingSno, setUploadingSno] = useState(null);
    const [selectedSnos, setSelectedSnos] = useState(() => new Set());

    const [mappingModal, setMappingModal] = useState(null); // { sno, ably_category_sno, ably_category_name }
    const [categories, setCategories] = useState(null);
    const [categoriesLoading, setCategoriesLoading] = useState(false);
    const [categoryFilter, setCategoryFilter] = useState('');
    const [mappingList, setMappingList] = useState([]);
    const [showMappingList, setShowMappingList] = useState(false);

    const fetchProducts = async (p, q, df, dt) => {
        setLoading(true);
        try {
            const params = new URLSearchParams({
                page: String(p),
                per_page: '30',
                q: q || '',
                date_from: df || '',
                date_to: dt || '',
            });
            const res = await fetch(`${API}/zigzag/ably-products?${params}`, {
                headers: getAuthHeaders(),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.ok) throw new Error(data?.detail || '상품 목록 조회 실패');
            setItems(data.items || []);
            setMaxPage(data.max_page || 1);
            setTotalCount(data.total_count || 0);
            setPage(data.page || p);
            setSyncedAt(data.synced_at || null);
            if (data.syncing) {
                setMessage({ type: 'success', text: '최초 동기화를 백그라운드에서 시작했습니다. 완료까지 최대 1분 정도 걸립니다.' });
                pollSyncStatus(p, q, df, dt);
            }
        } catch (err) {
            setMessage({ type: 'error', text: err.message || '상품 목록 조회 실패' });
        } finally {
            setLoading(false);
        }
    };

    // 동기화는 백그라운드 태스크로 도는 오래 걸리는 작업(1990건 기준 약 1분)이라
    // 완료될 때까지 상태를 주기적으로 확인한다.
    const pollSyncStatus = async (p, q, df, dt) => {
        setSyncing(true);
        for (let attempt = 0; attempt < 40; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 3000));
            try {
                const res = await fetch(`${API}/zigzag/ably-products/sync-status`, { headers: getAuthHeaders() });
                const data = await res.json().catch(() => ({}));
                if (data?.status === 'done') {
                    setMessage({ type: 'success', text: `동기화 완료: ${data.count || 0}개` });
                    setSyncing(false);
                    await fetchProducts(p, q, df, dt);
                    return;
                }
                if (data?.status === 'error') {
                    setMessage({ type: 'error', text: data.error || '동기화 실패' });
                    setSyncing(false);
                    return;
                }
            } catch {
                // 상태 확인 실패는 무시하고 계속 재시도
            }
        }
        setSyncing(false);
        setMessage({ type: 'error', text: '동기화 상태 확인 시간이 초과됐습니다 (백그라운드에서는 계속 진행 중일 수 있습니다).' });
    };

    // 검색어 입력 디바운스 (전체 상품 캐시에 대한 서버 검색이라 매 타이핑마다 요청하지 않음)
    useEffect(() => {
        const timer = setTimeout(() => setQuery(queryInput), 400);
        return () => clearTimeout(timer);
    }, [queryInput]);

    useEffect(() => {
        fetchProducts(1, query, dateFrom, dateTo);
        setSelectedSnos(new Set());
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [query, dateFrom, dateTo]);

    useEffect(() => {
        fetchMappingList();
    }, []);

    const runSync = async () => {
        setMessage(null);
        setSyncing(true);
        try {
            const res = await fetch(`${API}/zigzag/ably-products/sync`, {
                method: 'POST',
                headers: getAuthHeaders(),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.ok) throw new Error(data?.detail || '동기화 실패');
            setMessage({
                type: 'success',
                text: data.already_running
                    ? '이미 동기화가 진행 중입니다.'
                    : '동기화를 시작했습니다. 완료까지 최대 1분 정도 걸립니다.',
            });
            await pollSyncStatus(page, query, dateFrom, dateTo);
        } catch (err) {
            setSyncing(false);
            setMessage({ type: 'error', text: err.message || '동기화 실패' });
        }
    };

    const fetchMappingList = async () => {
        try {
            const res = await fetch(`${API}/zigzag/category-mapping`, { headers: getAuthHeaders() });
            const data = await res.json().catch(() => ({}));
            if (data?.ok) setMappingList(data.items || []);
        } catch { /* 조용히 실패 */ }
    };

    const ensureCategories = async () => {
        if (categories) return categories;
        setCategoriesLoading(true);
        try {
            const res = await fetch(`${API}/zigzag/categories`, { headers: getAuthHeaders() });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.ok) throw new Error(data?.detail || '지그재그 카테고리 조회 실패');
            setCategories(data.items || []);
            return data.items || [];
        } catch (err) {
            setMessage({ type: 'error', text: err.message || '지그재그 카테고리 조회 실패' });
            return [];
        } finally {
            setCategoriesLoading(false);
        }
    };

    const runUpload = async (sno) => {
        setUploadingSno(sno);
        setMessage(null);
        try {
            const res = await fetch(`${API}/zigzag/upload`, {
                method: 'POST',
                headers: jsonHeaders(),
                body: JSON.stringify({ ably_goods_sno: sno }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.detail || '업로드 실패');

            if (data.need_mapping) {
                await ensureCategories();
                setMappingModal({
                    sno,
                    ably_category_sno: data.ably_category_sno,
                    ably_category_name: data.ably_category_name,
                });
                setUploadingSno(null);
                return;
            }

            if (!data.ok) throw new Error('업로드 실패');

            setMessage({ type: 'success', text: `업로드 완료 (지그재그 상품ID: ${data.zigzag_product_id})` });
            setItems((prev) => prev.map((it) => (
                it.sno === sno ? { ...it, zigzag_product_id: data.zigzag_product_id, category_mapped: true } : it
            )));
        } catch (err) {
            setMessage({ type: 'error', text: err.message || '업로드 실패' });
        } finally {
            setUploadingSno(null);
        }
    };

    // 일괄 업로드는 앱 최상단에 마운트된 ZigzagBulkUploadProvider(전역 큐)가 처리한다.
    // 이 페이지를 벗어나거나 새로고침하지 않는 한, 다른 탭으로 이동해도 계속 진행된다.
    const startBulkUpload = () => {
        const targets = items.filter((it) => selectedSnos.has(it.sno));
        bulkUpload?.startBulkUpload(targets);
    };

    const toggleSelect = (sno) => {
        setSelectedSnos((prev) => {
            const next = new Set(prev);
            if (next.has(sno)) next.delete(sno);
            else next.add(sno);
            return next;
        });
    };

    const allOnPageSelected = items.length > 0 && items.every((it) => selectedSnos.has(it.sno));
    const toggleSelectAllOnPage = () => {
        setSelectedSnos((prev) => {
            const next = new Set(prev);
            if (allOnPageSelected) {
                items.forEach((it) => next.delete(it.sno));
            } else {
                items.forEach((it) => next.add(it.sno));
            }
            return next;
        });
    };

    const handleCategoryPick = async (cat) => {
        if (!mappingModal) return;
        setCategoriesLoading(true);
        try {
            const res = await fetch(`${API}/zigzag/category-mapping`, {
                method: 'POST',
                headers: jsonHeaders(),
                body: JSON.stringify({
                    ably_category_sno: mappingModal.ably_category_sno,
                    ably_category_name: mappingModal.ably_category_name,
                    zigzag_category_id: cat.id,
                    zigzag_category_name: cat.name,
                    zigzag_category_path: cat.full_path,
                }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.ok) throw new Error(data?.detail || '카테고리 매칭 저장 실패');
            const sno = mappingModal.sno;
            setMappingModal(null);
            setCategoryFilter('');
            await fetchMappingList();
            await runUpload(sno);
        } catch (err) {
            setMessage({ type: 'error', text: err.message || '카테고리 매칭 저장 실패' });
        } finally {
            setCategoriesLoading(false);
        }
    };

    const deleteMapping = async (ablyCategorySno) => {
        if (!window.confirm('이 카테고리 매칭을 삭제하시겠습니까? 다음 업로드 시 다시 선택해야 합니다.')) return;
        try {
            const res = await fetch(`${API}/zigzag/category-mapping/${ablyCategorySno}`, {
                method: 'DELETE',
                headers: getAuthHeaders(),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.ok) throw new Error(data?.detail || '삭제 실패');
            await fetchMappingList();
        } catch (err) {
            setMessage({ type: 'error', text: err.message || '삭제 실패' });
        }
    };

    const filteredCategories = useMemo(() => {
        if (!categories) return [];
        const q = categoryFilter.trim().toLowerCase();
        if (!q) return categories.slice(0, 200);
        return categories.filter((c) => c.full_path.toLowerCase().includes(q)).slice(0, 200);
    }, [categories, categoryFilter]);

    return (
        <div className={pageStyles.page}>
            <div className={pageStyles.pageHeader}>
                <div>
                    <h2 className={pageStyles.title}>지그재그 업로드</h2>
                    <p className={pageStyles.subtitle}>에이블리 상품을 지그재그(카카오스타일 파트너센터)로 등록</p>
                </div>
                <div className={pageStyles.headerActions}>
                    <button className={pageStyles.secondaryBtn} onClick={() => bulkUpload?.setShowModal(true)}>
                        일괄 업로드 진행상황
                    </button>
                    <button className={pageStyles.secondaryBtn} onClick={() => setShowMappingList((v) => !v)}>
                        카테고리 매칭 목록 ({mappingList.length})
                    </button>
                </div>
            </div>

            <div className={pageStyles.stack}>
                {showMappingList && (
                    <section className={pageStyles.card}>
                        <h3 className={pageStyles.cardTitle}>저장된 카테고리 매칭</h3>
                        {mappingList.length === 0 ? (
                            <div className={pageStyles.empty}>아직 매칭된 카테고리가 없습니다.</div>
                        ) : (
                            <div className={pageStyles.tableWrap}>
                                <table className={pageStyles.table}>
                                    <thead>
                                        <tr>
                                            <th>에이블리 카테고리</th>
                                            <th>지그재그 카테고리</th>
                                            <th></th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {mappingList.map((m) => (
                                            <tr key={m.ably_category_sno}>
                                                <td>{m.ably_category_name}</td>
                                                <td>{m.zigzag_category_path || m.zigzag_category_name}</td>
                                                <td>
                                                    <button
                                                        className={pageStyles.ghostBtn}
                                                        onClick={() => deleteMapping(m.ably_category_sno)}
                                                    >
                                                        삭제
                                                    </button>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </section>
                )}

                <section className={pageStyles.card}>
                    <div className={pageStyles.cardHeader}>
                        <h3 className={pageStyles.cardTitle}>에이블리 상품 목록</h3>
                        {loading && <span className={pageStyles.pill}>불러오는 중</span>}
                    </div>

                    <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
                        <input
                            className={pageStyles.searchInput}
                            placeholder="전체 상품(캐시)에서 상품명/코드/카테고리 검색"
                            value={queryInput}
                            onChange={(e) => setQueryInput(e.target.value)}
                        />
                        <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                            등록일
                            <input
                                type="date"
                                className={pageStyles.searchInput}
                                style={{ minWidth: 'auto' }}
                                value={dateFrom}
                                onChange={(e) => setDateFrom(e.target.value)}
                            />
                        </label>
                        <span style={{ color: 'var(--text-muted)' }}>~</span>
                        <input
                            type="date"
                            className={pageStyles.searchInput}
                            style={{ minWidth: 'auto' }}
                            value={dateTo}
                            onChange={(e) => setDateTo(e.target.value)}
                        />
                        {(dateFrom || dateTo) && (
                            <button
                                className={pageStyles.ghostBtn}
                                onClick={() => { setDateFrom(''); setDateTo(''); }}
                            >
                                날짜 초기화
                            </button>
                        )}
                        <button className={pageStyles.secondaryBtn} onClick={runSync} disabled={syncing}>
                            {syncing ? '동기화 중...' : '에이블리 상품 동기화'}
                        </button>
                        {syncedAt && (
                            <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                                마지막 동기화: {new Date(syncedAt + 'Z').toLocaleString('ko-KR')}
                            </span>
                        )}
                    </div>

                    {message && (
                        <div
                            className={pageStyles.statusMsg}
                            style={{
                                borderColor: message.type === 'success' ? 'rgba(34,197,94,0.4)' : 'rgba(220,53,69,0.4)',
                                backgroundColor: message.type === 'success' ? 'rgba(34,197,94,0.07)' : 'rgba(220,53,69,0.07)',
                            }}
                        >
                            {message.text}
                        </div>
                    )}

                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                        <button
                            className={pageStyles.primaryBtn}
                            disabled={selectedSnos.size === 0 || bulkUpload?.running}
                            onClick={startBulkUpload}
                        >
                            선택 업로드 ({selectedSnos.size})
                        </button>
                        {selectedSnos.size > 0 && (
                            <button className={pageStyles.ghostBtn} onClick={() => setSelectedSnos(new Set())}>
                                선택 해제
                            </button>
                        )}
                        {bulkUpload?.running && (
                            <span className={pageStyles.pill}>일괄 업로드 진행 중 (다른 페이지로 이동해도 계속됩니다)</span>
                        )}
                    </div>

                    <div className={pageStyles.tableWrap}>
                        <table className={pageStyles.table}>
                            <thead>
                                <tr>
                                    <th>
                                        <input
                                            type="checkbox"
                                            checked={allOnPageSelected}
                                            onChange={toggleSelectAllOnPage}
                                        />
                                    </th>
                                    <th>상품</th>
                                    <th>상품코드</th>
                                    <th>가격</th>
                                    <th>등록일</th>
                                    <th>카테고리</th>
                                    <th>상태</th>
                                    <th></th>
                                </tr>
                            </thead>
                            <tbody>
                                {items.map((it) => (
                                    <tr key={it.sno}>
                                        <td>
                                            <input
                                                type="checkbox"
                                                checked={selectedSnos.has(it.sno)}
                                                onChange={() => toggleSelect(it.sno)}
                                            />
                                        </td>
                                        <td>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                                {it.image && (
                                                    <img
                                                        src={it.image}
                                                        alt=""
                                                        style={{ width: 40, height: 40, objectFit: 'cover', borderRadius: 6 }}
                                                    />
                                                )}
                                                <span>{it.name}</span>
                                            </div>
                                        </td>
                                        <td>{it.custom_code}</td>
                                        <td>{(it.price || 0).toLocaleString()}원</td>
                                        <td style={{ whiteSpace: 'nowrap', fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                                            {it.registered_at ? it.registered_at.slice(0, 10) : ''}
                                        </td>
                                        <td>
                                            {it.category_path}
                                            {!it.category_mapped && (
                                                <span className={pageStyles.inlineTagDanger} style={{ marginLeft: 6 }}>
                                                    미매칭
                                                </span>
                                            )}
                                        </td>
                                        <td>
                                            {it.zigzag_product_id ? (
                                                <span className={pageStyles.doneBadge}>업로드 완료</span>
                                            ) : it.is_soldout ? (
                                                <span className={pageStyles.inlineTagDanger}>품절</span>
                                            ) : (
                                                <span className={pageStyles.inlineTag}>미업로드</span>
                                            )}
                                        </td>
                                        <td>
                                            <button
                                                className={pageStyles.primaryBtn}
                                                disabled={uploadingSno === it.sno}
                                                onClick={() => runUpload(it.sno)}
                                            >
                                                {uploadingSno === it.sno
                                                    ? '처리 중...'
                                                    : it.zigzag_product_id
                                                        ? '다시 업로드'
                                                        : '지그재그로 업로드'}
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                                {items.length === 0 && !loading && (
                                    <tr>
                                        <td colSpan={8} className={pageStyles.empty}>표시할 상품이 없습니다.</td>
                                    </tr>
                                )}
                            </tbody>
                        </table>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                        <button
                            className={pageStyles.secondaryBtn}
                            disabled={loading || page <= 1}
                            onClick={() => fetchProducts(page - 1, query, dateFrom, dateTo)}
                        >
                            이전
                        </button>
                        <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                            {page} / {maxPage} 페이지 (전체 {totalCount.toLocaleString()}개)
                        </span>
                        <button
                            className={pageStyles.secondaryBtn}
                            disabled={loading || page >= maxPage}
                            onClick={() => fetchProducts(page + 1, query, dateFrom, dateTo)}
                        >
                            다음
                        </button>
                    </div>
                </section>
            </div>

            {mappingModal && (
                <div className={pageStyles.modalOverlay} onClick={() => setMappingModal(null)}>
                    <div className={pageStyles.modal} onClick={(e) => e.stopPropagation()}>
                        <div className={pageStyles.modalHeader}>
                            <span className={pageStyles.modalTitle}>지그재그 카테고리 매칭</span>
                            <button className={pageStyles.ghostBtn} onClick={() => setMappingModal(null)}>닫기</button>
                        </div>
                        <div className={pageStyles.modalBody}>
                            <div style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
                                에이블리 카테고리 <strong>{mappingModal.ably_category_name}</strong>에 매칭할 지그재그
                                카테고리를 선택하세요. 한 번 선택하면 같은 에이블리 카테고리 상품은 계속 이 카테고리로
                                매칭됩니다.
                            </div>
                            <input
                                className={pageStyles.searchInput}
                                placeholder="지그재그 카테고리 검색 (예: 반소매티셔츠)"
                                value={categoryFilter}
                                onChange={(e) => setCategoryFilter(e.target.value)}
                                autoFocus
                            />
                            {categoriesLoading && <div className={pageStyles.pill}>불러오는 중</div>}
                            <div className={pageStyles.sharedList}>
                                {filteredCategories.map((c) => (
                                    <div
                                        key={c.id}
                                        className={pageStyles.sharedItem}
                                        style={{ cursor: 'pointer' }}
                                        onClick={() => handleCategoryPick(c)}
                                    >
                                        <div className={pageStyles.sharedMeta}>
                                            <span className={pageStyles.sharedName}>{c.name}</span>
                                            <span className={pageStyles.sharedSub}>{c.full_path}</span>
                                        </div>
                                    </div>
                                ))}
                                {categories && filteredCategories.length === 0 && !categoriesLoading && (
                                    <div className={pageStyles.empty}>검색 결과가 없습니다.</div>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default ZigzagUploadPage;
