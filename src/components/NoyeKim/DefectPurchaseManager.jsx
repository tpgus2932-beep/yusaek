import { useCallback, useEffect, useState } from "react";
import { LOCAL_API_BASE as API, getAuthHeaders, handleUnauthorized } from "../../lib/api";
import styles from "./DefectPurchaseManager.module.css";

const HANDOFF_KEY = "noye-kimsungil-defect-purchase-handoff";
const won = (n) => `${Math.round(Number(n) || 0).toLocaleString("ko-KR")}원`;
const signed = (n) => `${n > 0 ? "+" : n < 0 ? "-" : ""}${Math.abs(Math.round(Number(n) || 0)).toLocaleString("ko-KR")}원`;
const KIND_LABEL = { add: "불량 잡힘", deduct: "차감", restore: "재매입", manual: "직접입력", delete: "삭제" };
const todayStr = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" });
const formatDateTime = (iso) => (iso ? String(iso).slice(0, 16).replace("T", " ") : "");
const jsonHeaders = () => ({ ...getAuthHeaders(), "Content-Type": "application/json" });
const optionOf = (x) => [x.color, x.size].filter(Boolean).join(" ");

// 빨간 휴지통 아이콘 (이모지는 색을 바꿀 수 없어 SVG 사용)
function TrashIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 6h18" />
      <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}

// 거래처 불량 매입 관리: 거래처(잡힌 금액) → [변동 로그 | 날짜별 매입 목록]. 📷 = 사진·사유 바로 보기.
export default function DefectPurchaseManager() {
  const [vendors, setVendors] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [openVendor, setOpenVendor] = useState({}); // 거래처 → 열림
  const [subTab, setSubTab] = useState({}); // 거래처 → "log" | "date"
  const [logsByVendor, setLogsByVendor] = useState({});
  const [photoCache, setPhotoCache] = useState({});
  const [detail, setDetail] = useState(null); // { title, records }
  const [zoom, setZoom] = useState("");
  const [searchOpen, setSearchOpen] = useState(false); // 거래처별 로그 확인
  const [searchText, setSearchText] = useState("");
  const [searchVendor, setSearchVendor] = useState("");
  const [logVendors, setLogVendors] = useState([]); // 로그가 남은 모든 거래처 (현재 목록에 없어도 포함)
  const [listQuery, setListQuery] = useState(""); // 현재 목록 검색
  // 항목추가 (상품추가 / 직접입력)
  const [addOpen, setAddOpen] = useState(false);
  const [addTab, setAddTab] = useState("product");
  const [pq, setPq] = useState("");
  const [presults, setPresults] = useState([]);
  const [psearching, setPsearching] = useState(false);
  const [picked, setPicked] = useState(null);
  const [pQty, setPQty] = useState("1");
  const [pDate, setPDate] = useState(todayStr());
  const [mVendor, setMVendor] = useState("");
  const [mAmount, setMAmount] = useState("");
  const [mMemo, setMMemo] = useState("");
  const [addBusy, setAddBusy] = useState(false);
  const [addMsg, setAddMsg] = useState("");

  const loadList = useCallback(async () => {
    const res = await fetch(`${API}/noye-kimsungil/defect-purchase/list`, { headers: getAuthHeaders() });
    if (handleUnauthorized(res)) return;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.detail || "목록 조회 실패");
    setVendors(data.vendors || []);
  }, []);

  const loadLogVendors = useCallback(async () => {
    const res = await fetch(`${API}/noye-kimsungil/defect-purchase/log-vendors`, { headers: getAuthHeaders() });
    if (handleUnauthorized(res)) return;
    const data = await res.json().catch(() => ({}));
    if (res.ok) setLogVendors(data.vendors || []);
  }, []);

  const loadVendorLogs = useCallback(async (vendor) => {
    const params = new URLSearchParams({ vendor, limit: "1000" });
    const res = await fetch(`${API}/noye-kimsungil/defect-purchase/logs?${params}`, { headers: getAuthHeaders() });
    if (handleUnauthorized(res)) return;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.detail || "로그 조회 실패");
    setLogsByVendor((prev) => ({ ...prev, [vendor]: data.logs || [] }));
  }, []);

  const refresh = useCallback(async (keepError = false) => {
    setLoading(true);
    if (!keepError) setError("");
    try {
      await loadList();
    } catch (err) {
      setError(err.message || "조회 실패");
    } finally {
      setLoading(false);
    }
  }, [loadList]);

  // 바코드에서 넘긴 이동분이 남아 있으면 등록한 뒤 목록을 불러온다 (바코드 화면에서 직접 등록하므로 보통은 비어 있음).
  useEffect(() => {
    (async () => {
      let handoff = null;
      try {
        handoff = JSON.parse(localStorage.getItem(HANDOFF_KEY) || "null");
      } catch {
        handoff = null;
      }
      if (handoff && Array.isArray(handoff.rows)) {
        localStorage.removeItem(HANDOFF_KEY);
        try {
          const res = await fetch(`${API}/noye-kimsungil/defect-purchase/add`, {
            method: "POST",
            headers: jsonHeaders(),
            body: JSON.stringify({ rows: handoff.rows }),
          });
          if (handleUnauthorized(res)) return;
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data?.detail || "등록 실패");
          setError(`등록 ${data.added ?? 0}건${data.skipped ? ` / 이미 등록 ${data.skipped}건 건너뜀` : ""}`);
        } catch (err) {
          setError(err.message || "등록 실패");
        }
      }
      refresh(true);
    })();
    // 최초 1회만
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 상품추가: 원가베이스 검색 (/wonbe/search — 상품명·옵션(색상/사이즈)·거래처 단어를 공백으로 나눠 모두 포함)
  useEffect(() => {
    const q = pq.trim();
    if (!addOpen || addTab !== "product" || picked || !q) {
      setPresults([]);
      return undefined;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      setPsearching(true);
      try {
        const params = new URLSearchParams({ q, limit: "15" });
        const res = await fetch(`${API}/wonbe/search?${params}`, { headers: getAuthHeaders() });
        if (handleUnauthorized(res)) return;
        const data = await res.json().catch(() => ({}));
        if (!cancelled) setPresults(res.ok ? data.rows || [] : []);
      } catch {
        if (!cancelled) setPresults([]);
      } finally {
        if (!cancelled) setPsearching(false);
      }
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [pq, addOpen, addTab, picked]);

  const closeAdd = () => {
    setAddOpen(false);
    setPicked(null);
    setPq("");
    setPresults([]);
    setAddMsg("");
  };

  const submitProduct = async () => {
    if (!picked) return;
    const qty = Math.max(parseInt(pQty, 10) || 0, 0);
    if (qty <= 0) { setAddMsg("수량을 1 이상으로 입력해 주세요."); return; }
    setAddBusy(true);
    setAddMsg("");
    try {
      const res = await fetch(`${API}/noye-kimsungil/defect-purchase/add`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({
          manual: true,
          rows: [{
            code: String(picked["상품코드"] || ""),
            vendor: String(picked["거래처"] || "").trim(),
            productName: String(picked["거래처상품명"] || "").trim(),
            ownName: String(picked["상품명"] || "").trim(),
            color: String(picked["색상"] || "").trim(),
            size: String(picked["사이즈"] || "").trim(),
            cost: picked["원가"],
            qty,
            defectDate: pDate,
          }],
        }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "등록 실패");
      if (!data.added) throw new Error("등록되지 않았습니다.");
      closeAdd();
      setError(`✅ ${picked["거래처상품명"] || picked["상품명"]} ${qty}개를 ${picked["거래처"] || "거래처"}에 등록했습니다.`);
      await refresh(true);
    } catch (err) {
      setAddMsg(err.message || "등록 실패");
    } finally {
      setAddBusy(false);
    }
  };

  const submitManual = async () => {
    setAddBusy(true);
    setAddMsg("");
    try {
      const res = await fetch(`${API}/noye-kimsungil/defect-purchase/manual`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ vendor: mVendor, amount: mAmount, memo: mMemo }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "등록 실패");
      const vendorName = mVendor.trim();
      setMVendor(""); setMAmount(""); setMMemo("");
      closeAdd();
      setError(`✅ ${vendorName} 직접입력이 등록되었습니다. (거래처 현재 잔액 ${won(data.vendor_balance)})`);
      setLogsByVendor((prev) => { const next = { ...prev }; delete next[vendorName]; return next; });
      await refresh(true);
    } catch (err) {
      setAddMsg(err.message || "등록 실패");
    } finally {
      setAddBusy(false);
    }
  };

  const toggleVendor = (name) => {
    const next = !openVendor[name];
    setOpenVendor((prev) => ({ ...prev, [name]: next }));
    if (next) loadVendorLogs(name).catch((err) => setError(err.message || "로그 조회 실패"));
  };

  const changeStatus = async (vendorName, itemIds, status) => {
    const label = status === "deducted" ? "차감 완료" : "재매입(금액 복구)";
    if (!window.confirm(`${itemIds.length}건을 ${label} 처리할까요?`)) return;
    try {
      const res = await fetch(`${API}/noye-kimsungil/defect-purchase/status`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ item_ids: itemIds, status }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "처리 실패");
      await Promise.all([loadList(), loadVendorLogs(vendorName)]);
    } catch (err) {
      setError(err.message || "처리 실패");
    }
  };

  const callDelete = async (itemId) => {
    const res = await fetch(`${API}/noye-kimsungil/defect-purchase/delete`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ item_id: itemId }),
    });
    if (handleUnauthorized(res)) return false;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.detail || "삭제 실패");
    return true;
  };

  // 항목 삭제 — 항상 확인 팝업을 먼저 띄운다 (목록·로그 공통)
  const deleteItem = async (vendorName, item) => {
    const name = item.source === "manual" ? (item.memo || "직접입력") : (item.product_name || item.code || "항목");
    const note = item.status === "held" ? `
잡혀 있던 ${won(item.amount)}이 거래처 금액에서 빠집니다.` : "";
    if (!window.confirm(`"${name}" 항목을 삭제할까요?${note}

삭제하면 되돌릴 수 없습니다.`)) return;
    try {
      await callDelete(item.id);
      await Promise.all([loadList(), loadVendorLogs(vendorName)]);
    } catch (err) {
      setError(err.message || "삭제 실패");
    }
  };

  // 거래처 전체 삭제 — 거래처 안의 모든 항목을 한 번에 삭제 (강한 확인 팝업)
  const deleteVendor = async (vendor) => {
    const count = vendor.items.length;
    if (!window.confirm(`"${vendor.vendor}" 거래처의 항목 ${count}건을 모두 삭제할까요?
잡혀 있던 ${won(vendor.held_amount)}이 모두 빠지고, 되돌릴 수 없습니다.`)) return;
    try {
      for (const item of vendor.items) await callDelete(item.id);
      await Promise.all([loadList(), loadVendorLogs(vendor.vendor)]);
    } catch (err) {
      setError(err.message || "삭제 실패");
      loadList().catch(() => {});
    }
  };

  const openDetail = async (title, records) => {
    setDetail({ title, records });
    const ids = records.flatMap((rec) => rec.photo_ids || []).filter((id) => !photoCache[id]);
    if (ids.length === 0) return;
    const results = await Promise.all(
      ids.map(async (id) => {
        try {
          const res = await fetch(`${API}/barcode/defect/record/photo/${id}`, { headers: getAuthHeaders() });
          const data = await res.json().catch(() => ({}));
          return [id, data?.data_url || ""];
        } catch {
          return [id, ""];
        }
      }),
    );
    setPhotoCache((prev) => ({ ...prev, ...Object.fromEntries(results) }));
  };

  // 남은 매입금액이 없는 거래처는 목록에서 숨긴다 (로그 확인 검색에서는 계속 찾을 수 있음)
  const listKeyword = listQuery.trim().toLowerCase();
  const visibleVendors = vendors
    .filter((v) => v.held_amount > 0)
    .filter((v) => !listKeyword
      || v.vendor.toLowerCase().includes(listKeyword)
      || v.items.some((i) => [i.product_name, i.own_name, i.memo, i.code].some((t) => String(t || "").toLowerCase().includes(listKeyword))));
  const totalHeld = vendors.reduce((sum, v) => sum + v.held_amount, 0);
  const keyword = searchText.trim();
  const candidates = keyword ? logVendors.filter((v) => v.vendor.includes(keyword)).slice(0, 12) : [];

  const pickSearchVendor = (name) => {
    setSearchVendor(name);
    setSearchText(name);
    loadVendorLogs(name).catch((err) => setError(err.message || "로그 조회 실패"));
  };

  const cameraBtn = (title, records) => (
    <button
      type="button"
      className={styles.iconBtn}
      title="사진·사유 보기"
      disabled={!records || records.length === 0}
      onClick={() => openDetail(title, records)}
    >
      📷
    </button>
  );

  // 로그와 날짜별 목록이 같은 형태로 보이도록 공통 사용: 공급처 상품명(위) + 원가베이스 상품명(아래)
  const productCell = (x) =>
    x.source === "manual" ? (
      <>
        <div className={styles.productMain}>{x.memo || x.product_name || "(사유 없음)"}</div>
        <div className={styles.productSub}>직접입력</div>
      </>
    ) : (
      <>
        <div className={styles.productMain}>{x.product_name || x.code}</div>
        {x.own_name ? <div className={styles.productSub}>{x.own_name}</div> : null}
      </>
    );

  const KIND_BADGE = { add: styles.badgeAdd, deduct: styles.badgeDeduct, restore: styles.badgeRestore, manual: styles.badgeManual, delete: styles.badgeDeduct };

  const renderLogTable = (logs) =>
    logs.length === 0 ? (
      <div className={styles.empty}>변동 내역이 없습니다.</div>
    ) : (
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>상품명</th><th>옵션</th><th className={styles.right}>수량</th>
              <th>일시</th><th>구분</th>
              <th className={styles.right}>증감</th><th className={styles.right}>잔액</th><th></th>
            </tr>
          </thead>
          <tbody>
            {logs.map((log) => (
              <tr key={log.id}>
                <td>{productCell(log)}</td>
                <td>{optionOf(log)}</td>
                <td className={styles.right}>{log.source === "manual" ? "" : (log.qty ?? "")}</td>
                <td className={styles.time}>{formatDateTime(log.created_at)}</td>
                <td><span className={`${styles.badge} ${KIND_BADGE[log.kind] || ""}`}>{KIND_LABEL[log.kind] || log.kind}</span></td>
                <td className={`${styles.right} ${styles.nowrap} ${log.delta < 0 ? styles.minus : styles.plus}`}>{signed(log.delta)}</td>
                <td className={`${styles.right} ${styles.nowrap} ${styles.balance}`}>{won(log.vendor_balance_after)}</td>
                <td className={styles.right}>
                  <div className={styles.rowActions}>
                    {cameraBtn(`${log.product_name} ${optionOf(log)}`, log.records)}
                    <button
                      type="button"
                      className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                      title={log.item_status === "deleted" ? "이미 삭제된 항목" : "이 항목 삭제"}
                      disabled={!log.item_id || log.item_status === "deleted"}
                      onClick={() => deleteItem(log.vendor, { id: log.item_id, status: log.item_status, amount: log.item_amount, source: log.source, memo: log.memo, product_name: log.product_name })}
                    >
                      <TrashIcon />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );

  return (
    <div className={styles.root}>
      <div className={styles.summary}>
        <input
          className={styles.listSearch}
          value={listQuery}
          onChange={(e) => setListQuery(e.target.value)}
          placeholder="🔍 거래처 · 상품 검색"
        />
        <div>
          <div className={styles.summaryLabel}>현재 잡힌 매입 금액</div>
          <div className={styles.summaryAmount}>{won(totalHeld)}</div>
        </div>
        <div className={styles.summaryActions}>
          <button type="button" className={styles.btn} onClick={() => refresh()} disabled={loading}>{loading ? "불러오는 중…" : "새로고침"}</button>
          <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => { setAddOpen(true); setAddMsg(""); }}>＋ 항목추가</button>
          <button type="button" className={`${styles.btn} ${searchOpen ? styles.btnPrimary : ""}`} onClick={() => { const next = !searchOpen; setSearchOpen(next); if (next) loadLogVendors().catch(() => {}); }}>
            📜 거래처별 로그 확인
          </button>
        </div>
      </div>

      {searchOpen && (
        <div className={styles.searchPanel}>
          <input
            className={styles.searchInput}
            value={searchText}
            onChange={(e) => { setSearchText(e.target.value); setSearchVendor(""); }}
            onKeyDown={(e) => { if (e.key === "Enter" && candidates.length > 0) pickSearchVendor(candidates.find((v) => v.vendor === keyword)?.vendor || candidates[0].vendor); }}
            placeholder="거래처 이름으로 검색 (목록에 없는 거래처도 로그가 있으면 찾을 수 있어요)"
            autoFocus
          />
          {!searchVendor && candidates.length > 0 && (
            <div className={styles.chips}>
              {candidates.map((v) => (
                <button key={v.vendor} type="button" className={styles.chip} onClick={() => pickSearchVendor(v.vendor)}>
                  {v.vendor}<span className={styles.chipAmount}>{won(v.held_amount)}</span>
                </button>
              ))}
            </div>
          )}
          {!searchVendor && keyword && candidates.length === 0 && <div className={styles.empty}>로그가 있는 거래처 중 일치하는 곳이 없습니다.</div>}
          {searchVendor && (
            <>
              <div className={styles.searchHead}>
                {searchVendor}
                <span className={styles.searchHeadSub}>
                  현재 {won(logVendors.find((v) => v.vendor === searchVendor)?.held_amount)} · 전체 로그 {(logsByVendor[searchVendor] || []).length}건
                </span>
              </div>
              {renderLogTable(logsByVendor[searchVendor] || [])}
            </>
          )}
        </div>
      )}

      {error && <div className={styles.notice}>{error}</div>}
      {visibleVendors.length === 0 && !loading && <div className={styles.empty}>남은 매입금액이 있는 거래처가 없습니다.</div>}

      {visibleVendors.map((vendor) => {
        const isOpen = !!openVendor[vendor.vendor];
        const tab = subTab[vendor.vendor] || "log";
        const logs = logsByVendor[vendor.vendor] || [];
        // 날짜별 정리
        const byDate = {};
        vendor.items.forEach((item) => { (byDate[item.defect_date || "날짜 없음"] ||= []).push(item); });
        const dates = Object.keys(byDate).sort().reverse();

        return (
          <div key={vendor.vendor} className={styles.vendorCard}>
            <div className={styles.vendorBar} onClick={() => toggleVendor(vendor.vendor)}>
              <span className={styles.vendorName}>{vendor.vendor}</span>
              <span className={styles.vendorAmount}>{won(vendor.held_amount)}</span>
              <span className={styles.countPill}>상품 {vendor.items.length}건</span>
              <span className={styles.barRight} onClick={(e) => e.stopPropagation()}>
                <button type="button" className={`${styles.iconBtn} ${styles.iconBtnDanger}`} title="거래처 전체 삭제" onClick={() => deleteVendor(vendor)}><TrashIcon /></button>
                <span className={`${styles.chevron} ${isOpen ? styles.chevronOpen : ""}`} onClick={() => toggleVendor(vendor.vendor)}>▾</span>
              </span>
            </div>

            {isOpen && (
              <div className={styles.vendorBody}>
                <div className={styles.tabs}>
                  <button type="button" className={`${styles.tab} ${tab === "log" ? styles.tabActive : ""}`} onClick={() => setSubTab((p) => ({ ...p, [vendor.vendor]: "log" }))}>변동 로그</button>
                  <button type="button" className={`${styles.tab} ${tab === "date" ? styles.tabActive : ""}`} onClick={() => setSubTab((p) => ({ ...p, [vendor.vendor]: "date" }))}>날짜별 매입 목록</button>
                </div>

                {tab === "log" && renderLogTable(logs)}

                {tab === "date" && dates.map((date) => {
                  const dayHeld = byDate[date].filter((i) => i.status === "held").reduce((sum, i) => sum + i.amount, 0);
                  return (
                    <div key={date} className={styles.dateGroup}>
                      <div className={styles.dateHead}>
                        {date}<span className={styles.dateSub}>{won(dayHeld)}</span>
                      </div>
                      <div className={styles.tableWrap}>
                        <table className={styles.table}>
                          <thead>
                            <tr>
                              <th>상품명</th><th>옵션</th><th className={styles.right}>수량</th>
                              <th className={styles.right}>금액</th><th></th>
                            </tr>
                          </thead>
                          <tbody>
                            {byDate[date].map((item) => {
                              const deducted = item.status === "deducted";
                              return (
                                <tr key={item.id} className={deducted ? styles.rowDone : ""}>
                                  <td>{productCell(item)}</td>
                                  <td>{optionOf(item)}</td>
                                  <td className={styles.right}>{item.source === "manual" ? "" : item.qty}</td>
                                  <td className={`${styles.right} ${styles.nowrap}`}>{won(item.amount)}</td>
                                  <td>
                                    <div className={styles.rowActions}>
                                      {cameraBtn(`${item.product_name} ${optionOf(item)}`, item.records)}
                                      {item.source === "manual" ? null : deducted ? (
                                        <button type="button" className={`${styles.btn} ${styles.btnGood}`} onClick={() => changeStatus(vendor.vendor, [item.id], "held")}>재매입</button>
                                      ) : (
                                        <button type="button" className={`${styles.btn} ${styles.btnDanger}`} onClick={() => changeStatus(vendor.vendor, [item.id], "deducted")}>차감완료</button>
                                      )}
                                      <button type="button" className={`${styles.iconBtn} ${styles.iconBtnDanger}`} title="삭제" onClick={() => deleteItem(vendor.vendor, item)}><TrashIcon /></button>
                                    </div>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      {addOpen && (
        <div className={styles.overlay} onClick={closeAdd}>
          <div className={styles.sheet} onClick={(e) => e.stopPropagation()}>
            <div className={styles.sheetHead}>
              <div className={styles.sheetTitle}>항목추가</div>
              <button type="button" className={styles.btn} onClick={closeAdd}>닫기</button>
            </div>
            <div className={styles.tabs} style={{ marginTop: 0 }}>
              <button type="button" className={`${styles.tab} ${addTab === "product" ? styles.tabActive : ""}`} onClick={() => { setAddTab("product"); setAddMsg(""); }}>상품추가</button>
              <button type="button" className={`${styles.tab} ${addTab === "manual" ? styles.tabActive : ""}`} onClick={() => { setAddTab("manual"); setAddMsg(""); }}>직접입력</button>
            </div>

            {addTab === "product" && (
              picked ? (
                <div>
                  <div className={styles.recordCard}>
                    <div className={styles.productMain}>{picked["거래처상품명"] || picked["상품명"]}</div>
                    <div className={styles.productSub}>{picked["상품명"]}</div>
                    <div className={styles.productSub}>
                      {picked["거래처"]} · {[picked["색상"], picked["사이즈"]].filter(Boolean).join(" ")} · 원가 {won(String(picked["원가"] || "").replace(/[^\d.-]/g, ""))}
                    </div>
                  </div>
                  <div className={styles.formRow}>
                    <label className={styles.formLabel}>수량
                      <input className={styles.searchInput} type="number" min={1} value={pQty} onChange={(e) => setPQty(e.target.value)} />
                    </label>
                    <label className={styles.formLabel}>불량 날짜
                      <input className={styles.searchInput} type="date" value={pDate} onChange={(e) => setPDate(e.target.value)} />
                    </label>
                  </div>
                  <div className={styles.formActions}>
                    <button type="button" className={styles.btn} onClick={() => setPicked(null)} disabled={addBusy}>다시 검색</button>
                    <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={submitProduct} disabled={addBusy}>{addBusy ? "등록 중…" : "등록"}</button>
                  </div>
                </div>
              ) : (
                <div>
                  <input
                    className={styles.searchInput}
                    value={pq}
                    onChange={(e) => setPq(e.target.value)}
                    placeholder="상품명 + 옵션으로 검색 (예: 글로우 검정)"
                    autoFocus
                  />
                  {psearching && <div className={styles.hintText}>검색 중…</div>}
                  {!psearching && pq.trim() && presults.length === 0 && <div className={styles.empty}>검색 결과가 없습니다.</div>}
                  <div className={styles.suggestList}>
                    {presults.map((row) => (
                      <button key={row["상품코드"]} type="button" className={styles.suggestItem} onClick={() => { setPicked(row); setPQty("1"); setPDate(todayStr()); setAddMsg(""); }}>
                        <div className={styles.productMain}>{row["거래처상품명"] || row["상품명"]}</div>
                        <div className={styles.productSub}>
                          {row["상품명"]} · {[row["색상"], row["사이즈"]].filter(Boolean).join(" ")}
                        </div>
                        <div className={styles.productSub}>{row["거래처"]} · {row["상품코드"]}</div>
                      </button>
                    ))}
                  </div>
                </div>
              )
            )}

            {addTab === "manual" && (
              <div>
                <label className={styles.formLabel}>거래처
                  <input className={styles.searchInput} value={mVendor} onChange={(e) => setMVendor(e.target.value)} list="dp-vendor-list" placeholder="예: 필앤마조" />
                </label>
                <datalist id="dp-vendor-list">
                  {vendors.map((v) => <option key={v.vendor} value={v.vendor} />)}
                </datalist>
                <label className={styles.formLabel}>금액 <span className={styles.hintText}>(+ 매입 잡힘 / − 차감)</span>
                  <input className={styles.searchInput} value={mAmount} onChange={(e) => setMAmount(e.target.value)} placeholder="예: -23000" inputMode="text" />
                </label>
                <label className={styles.formLabel}>사유
                  <input className={styles.searchInput} value={mMemo} onChange={(e) => setMMemo(e.target.value)} placeholder="예: 오이체로 인한 매입잡음" />
                </label>
                <div className={styles.formActions}>
                  <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={submitManual} disabled={addBusy}>{addBusy ? "등록 중…" : "등록"}</button>
                </div>
              </div>
            )}

            {addMsg && <div className={styles.notice} style={{ marginTop: "0.7rem", marginBottom: 0 }}>{addMsg}</div>}
          </div>
        </div>
      )}

      {detail && (
        <div className={styles.overlay} onClick={() => setDetail(null)}>
          <div className={styles.sheet} onClick={(e) => e.stopPropagation()}>
            <div className={styles.sheetHead}>
              <div className={styles.sheetTitle}>📷 {detail.title}</div>
              <button type="button" className={styles.btn} onClick={() => setDetail(null)}>닫기</button>
            </div>
            {detail.records.map((rec, idx) => (
              <div key={rec.id} className={styles.recordCard}>
                <div className={styles.recordMeta}>#{idx + 1} · 수량 {rec.qty} · {formatDateTime(rec.created_at)}</div>
                <div className={styles.photos}>
                  {(rec.photo_ids || []).length === 0 && <div className={styles.recordMeta}>사진 없음</div>}
                  {(rec.photo_ids || []).map((id) =>
                    photoCache[id] ? (
                      <img key={id} src={photoCache[id]} alt="불량 사진" className={styles.photo} onClick={() => setZoom(photoCache[id])} />
                    ) : (
                      <div key={id} className={styles.photoLoading}>불러오는 중…</div>
                    ),
                  )}
                </div>
                <div className={styles.reason}>{rec.reason || "(사유 없음)"}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {zoom && (
        <div className={styles.zoomOverlay} onClick={() => setZoom("")}>
          <img src={zoom} alt="확대" className={styles.zoomImg} />
        </div>
      )}
    </div>
  );
}
