import { createContext, useContext, useMemo, useRef, useState } from "react";
import { LOCAL_API_BASE as API, getAuthHeaders } from "./api";
import pageStyles from "../components/Barcode/BarcodePage.module.css";

const ZigzagBulkUploadContext = createContext(null);

const jsonHeaders = () => ({ "Content-Type": "application/json", ...getAuthHeaders() });

const STATUS_LABEL = {
    pending: "대기",
    uploading: "처리 중",
    need_mapping: "카테고리 매칭 대기",
    done: "완료",
    error: "실패",
};

// 지그재그 일괄 업로드는 페이지를 벗어나도(다른 탭으로 이동해도) 계속 진행돼야 해서
// 특정 페이지 컴포넌트가 아니라 앱 최상단(App.jsx)에 마운트되는 Provider가 큐를 들고 있는다.
// 헤더의 "작업진행목록" 버튼이 어디서든 이 진행상황 모달을 다시 열 수 있다.
export function ZigzagBulkUploadProvider({ children }) {
    const [queue, setQueue] = useState([]); // [{sno, name, status, message}]
    const [running, setRunning] = useState(false);
    const [showModal, setShowModal] = useState(false);

    const [mappingModal, setMappingModal] = useState(null); // {sno, ably_category_sno, ably_category_name, queueIndex}
    const [categories, setCategories] = useState(null);
    const [categoriesLoading, setCategoriesLoading] = useState(false);
    const [categoryFilter, setCategoryFilter] = useState("");

    const queueItemsRef = useRef([]); // [{sno, name}] - 재개 시 기준이 되는 원본 목록

    const uploadOneProduct = async (sno) => {
        const res = await fetch(`${API}/zigzag/upload`, {
            method: "POST",
            headers: jsonHeaders(),
            body: JSON.stringify({ ably_goods_sno: sno }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.detail || "업로드 실패");
        return data;
    };

    const ensureCategories = async () => {
        if (categories) return categories;
        setCategoriesLoading(true);
        try {
            const res = await fetch(`${API}/zigzag/categories`, { headers: getAuthHeaders() });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.ok) throw new Error(data?.detail || "카테고리 조회 실패");
            setCategories(data.items || []);
            return data.items || [];
        } catch {
            return [];
        } finally {
            setCategoriesLoading(false);
        }
    };

    const updateItem = (index, patch) => {
        setQueue((prev) => prev.map((q, i) => (i === index ? { ...q, ...patch } : q)));
    };

    const runQueue = async (startIndex) => {
        const items = queueItemsRef.current;
        for (let i = startIndex; i < items.length; i += 1) {
            const item = items[i];
            updateItem(i, { status: "uploading", message: "" });
            try {
                const data = await uploadOneProduct(item.sno);
                if (data.need_mapping) {
                    await ensureCategories();
                    updateItem(i, { status: "need_mapping", message: `${data.ably_category_name} 카테고리 매칭 필요` });
                    setMappingModal({
                        sno: item.sno,
                        ably_category_sno: data.ably_category_sno,
                        ably_category_name: data.ably_category_name,
                        queueIndex: i,
                    });
                    return; // 카테고리 매칭 완료/취소 시 이어서 재개
                }
                if (!data.ok) throw new Error("업로드 실패");
                updateItem(i, { status: "done", message: `상품ID ${data.zigzag_product_id}` });
            } catch (err) {
                updateItem(i, { status: "error", message: err.message || "업로드 실패" });
            }
        }
        setRunning(false);
    };

    const startBulkUpload = (targets) => {
        if (!targets || !targets.length) return;
        const items = targets.map((it) => ({ sno: it.sno, name: it.name }));
        queueItemsRef.current = items;
        setQueue(items.map((it) => ({ ...it, status: "pending", message: "" })));
        setRunning(true);
        setShowModal(true);
        runQueue(0);
    };

    const handleCategoryPick = async (cat) => {
        if (!mappingModal) return;
        setCategoriesLoading(true);
        try {
            const res = await fetch(`${API}/zigzag/category-mapping`, {
                method: "POST",
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
            if (!res.ok || !data.ok) throw new Error(data?.detail || "카테고리 매칭 저장 실패");
            const { queueIndex } = mappingModal;
            setMappingModal(null);
            setCategoryFilter("");
            setRunning(true);
            await runQueue(queueIndex);
        } catch (err) {
            updateItem(mappingModal.queueIndex, { status: "error", message: err.message || "카테고리 매칭 저장 실패" });
            setMappingModal(null);
            setRunning(false);
        } finally {
            setCategoriesLoading(false);
        }
    };

    const skipMapping = () => {
        if (!mappingModal) return;
        const { queueIndex } = mappingModal;
        updateItem(queueIndex, { status: "error", message: "카테고리 매칭 취소됨" });
        setMappingModal(null);
        runQueue(queueIndex + 1);
    };

    const filteredCategories = useMemo(() => {
        if (!categories) return [];
        const q = categoryFilter.trim().toLowerCase();
        if (!q) return categories.slice(0, 200);
        return categories.filter((c) => c.full_path.toLowerCase().includes(q)).slice(0, 200);
    }, [categories, categoryFilter]);

    const doneCount = queue.filter((q) => q.status === "done").length;
    const errorCount = queue.filter((q) => q.status === "error").length;

    return (
        <ZigzagBulkUploadContext.Provider
            value={{ queue, running, showModal, setShowModal, startBulkUpload }}
        >
            {children}

            {showModal && (
                <div className={pageStyles.modalOverlay} onClick={() => !running && setShowModal(false)}>
                    <div className={pageStyles.modal} onClick={(e) => e.stopPropagation()}>
                        <div className={pageStyles.modalHeader}>
                            <span className={pageStyles.modalTitle}>지그재그 일괄 업로드 진행상황</span>
                            <button className={pageStyles.ghostBtn} onClick={() => setShowModal(false)}>닫기</button>
                        </div>
                        <div className={pageStyles.modalBody}>
                            {queue.length === 0 ? (
                                <div className={pageStyles.empty}>진행 중인 업로드가 없습니다.</div>
                            ) : (
                                <>
                                    <div style={{ fontSize: "0.9rem", color: "var(--text-secondary)" }}>
                                        {running
                                            ? "업로드 진행 중... 창을 닫고 다른 작업을 하셔도 계속 진행됩니다."
                                            : `완료됨 - 성공 ${doneCount}건 / 실패 ${errorCount}건 (전체 ${queue.length}건)`}
                                    </div>
                                    <div className={pageStyles.tableWrap}>
                                        <table className={pageStyles.table}>
                                            <thead>
                                                <tr>
                                                    <th>상품</th>
                                                    <th>상태</th>
                                                    <th>메시지</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {queue.map((q, i) => (
                                                    <tr key={`${q.sno}-${i}`}>
                                                        <td>{q.name}</td>
                                                        <td>{STATUS_LABEL[q.status] || q.status}</td>
                                                        <td style={{ color: q.status === "error" ? "#dc3545" : "inherit" }}>{q.message}</td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                </>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {mappingModal && (
                <div className={pageStyles.modalOverlay} onClick={skipMapping}>
                    <div className={pageStyles.modal} onClick={(e) => e.stopPropagation()}>
                        <div className={pageStyles.modalHeader}>
                            <span className={pageStyles.modalTitle}>지그재그 카테고리 매칭</span>
                            <button className={pageStyles.ghostBtn} onClick={skipMapping}>닫기</button>
                        </div>
                        <div className={pageStyles.modalBody}>
                            <div style={{ fontSize: "0.9rem", color: "var(--text-secondary)" }}>
                                에이블리 카테고리 <strong>{mappingModal.ably_category_name}</strong>에 매칭할 지그재그
                                카테고리를 선택하세요. 매칭을 취소하면 이 상품만 건너뛰고 나머지를 이어서 진행합니다.
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
                                        style={{ cursor: "pointer" }}
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
        </ZigzagBulkUploadContext.Provider>
    );
}

export const useZigzagBulkUpload = () => useContext(ZigzagBulkUploadContext);
