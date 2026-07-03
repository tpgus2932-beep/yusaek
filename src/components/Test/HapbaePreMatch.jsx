import React, { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, TrendingUp, Package, Archive, Zap, Download, ChevronDown, ChevronRight, Star, X } from "lucide-react";
import styles from "./TestTabs.module.css";
import { LOCAL_API_BASE as API, getAuthHeaders } from "../../lib/api";

export default function HapbaePreMatch() {
  const [rows, setRows] = useState([]);
  const [stockRows, setStockRows] = useState([]);
  const [todayBulkRows, setTodayBulkRows] = useState([]);
  const [stockBulkRows, setStockBulkRows] = useState(() => {
    try { return JSON.parse(localStorage.getItem("hapbae_stock_bulk_rows") || "[]"); } catch { return []; }
  });
  const [stockBulkFetchedAt, setStockBulkFetchedAt] = useState(() => {
    try { return localStorage.getItem("hapbae_stock_bulk_fetched_at") || ""; } catch { return ""; }
  });
  const [stockBulkLoading, setStockBulkLoading] = useState(false);
  const [checkedRows, setCheckedRows] = useState({});
  const [stats, setStats] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [incomingLoaded, setIncomingLoaded] = useState(false);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedSections, setExpandedSections] = useState(() => {
    try { return JSON.parse(localStorage.getItem("hapbae_expanded_sections") || "{}"); } catch { return {}; }
  });
  const [registeredProducts, setRegisteredProducts] = useState([]);
  const [registeredMatches, setRegisteredMatches] = useState([]);
  const [productSearch, setProductSearch] = useState("");
  const [productResults, setProductResults] = useState([]);
  const [productSearchLoading, setProductSearchLoading] = useState(false);

  const isExpanded = (key) => !!expandedSections[key];
  const toggleSection = (key) =>
    setExpandedSections((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      localStorage.setItem("hapbae_expanded_sections", JSON.stringify(next));
      return next;
    });

  const filterRows = useCallback((targetRows) => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return targetRows;
    return targetRows.filter((row) =>
      [row.productName, row.optionName].some((value) =>
        String(value || "").toLowerCase().includes(query)
      )
    );
  }, [searchQuery]);

  const todayBulkKeySet = useMemo(() => {
    const set = new Set();
    todayBulkRows.forEach((row) => {
      set.add(`${row.productName}::${row.optionName}`);
    });
    return set;
  }, [todayBulkRows]);

  const registeredCodeSet = useMemo(
    () => new Set(registeredProducts.map((item) => item.code)),
    [registeredProducts]
  );

  const highIncomingRows = useMemo(
    () => filterRows(rows.filter((row) => todayBulkKeySet.has(`${row.productName}::${row.optionName}`))),
    [filterRows, rows, todayBulkKeySet]
  );
  const normalIncomingRows = useMemo(
    () => filterRows(rows.filter((row) =>
      !todayBulkKeySet.has(`${row.productName}::${row.optionName}`) && (Number(row.incomingQty) || 0) > 0
    )),
    [filterRows, rows, todayBulkKeySet]
  );
  const noIncomingRows = useMemo(
    () => {
      const noIncomingFromRows = rows.filter((row) => (Number(row.incomingQty) || 0) <= 0);
      const fallbackStockRows = noIncomingFromRows.length ? [] : stockRows;
      return filterRows([...noIncomingFromRows, ...fallbackStockRows]);
    },
    [filterRows, rows, stockRows]
  );

  const sumOrderQty = (targetRows) =>
    targetRows.reduce((sum, row) => sum + (Number(row.orderQty) || 0), 0);

  const getRowKey = (row, sectionKey) =>
    `${sectionKey}::${row.productName || ""}::${row.optionName || ""}`;

  const sortCheckedRowsToBottom = (targetRows, sectionKey) =>
    [...targetRows].sort((a, b) => {
      const aChecked = checkedRows[getRowKey(a, sectionKey)] ? 1 : 0;
      const bChecked = checkedRows[getRowKey(b, sectionKey)] ? 1 : 0;
      return aChecked - bChecked;
    });

  const checkedCount = (targetRows, sectionKey) =>
    targetRows.reduce(
      (sum, row) => sum + (checkedRows[getRowKey(row, sectionKey)] ? 1 : 0),
      0
    );

  const loadRows = async () => {
    setLoading(true);
    setMessage("");
    try {
      const [rowsRes, checkedRes] = await Promise.all([
        fetch(`${API}/barcode/hapbae-pre-match`, { headers: getAuthHeaders() }),
        fetch(`${API}/barcode/hapbae-pre-match/checked`, { headers: getAuthHeaders() }),
      ]);
      const data = await rowsRes.json().catch(() => ({}));
      if (!rowsRes.ok) throw new Error(data?.detail || "합배 구성 선매칭 조회 실패");
      const checkedData = await checkedRes.json().catch(() => ({}));
      if (checkedRes.ok && checkedData && typeof checkedData.checked_rows === "object") {
        setCheckedRows(checkedData.checked_rows || {});
      }
      setRows(data.rows || []);
      setStockRows(data.stock_rows || []);
      setTodayBulkRows(data.today_bulk_rows || []);
      setRegisteredMatches(data.registered_rows || []);
      setStats(data.stats || null);
      setLoaded(!!data.loaded);
      setIncomingLoaded(!!data.incoming_loaded);
      if (!data.loaded) {
        setMessage("사이드메뉴 바코드에서 확장주문검색 엑셀을 먼저 업로드하세요.");
      } else if (!data.incoming_loaded) {
        setMessage("사이드메뉴 바코드에서 입고 파일 엑셀을 업로드하면 입고된 데이터가 표시됩니다.");
      } else {
        const responseRows = data.rows || [];
        const responseNoIncomingCount = responseRows.filter((row) => (Number(row.incomingQty) || 0) <= 0).length || (data.stock_rows || []).length;
        setMessage(`조회 완료: 주문 ${responseRows.length}건 / 입고없음 ${responseNoIncomingCount}건`);
      }
    } catch (err) {
      setRows([]);
      setStockRows([]);
      setStats(null);
      setMessage(err.message || "합배 구성 선매칭 조회 실패");
    } finally {
      setLoading(false);
    }
  };

  const loadStockBulk = async () => {
    setStockBulkLoading(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/barcode/stock-bulk-fetch`, {
        method: "POST",
        headers: getAuthHeaders(),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "재고대량 불러오기 실패");
      if (data.need_session) { setMessage("이지어드민 세션이 없습니다. 설정에서 PHPSESSID를 입력하세요."); return; }
      setStockBulkRows(data.rows || []);
      localStorage.setItem("hapbae_stock_bulk_rows", JSON.stringify(data.rows || []));
      const fetchedAt = new Date().toISOString();
      setStockBulkFetchedAt(fetchedAt);
      localStorage.setItem("hapbae_stock_bulk_fetched_at", fetchedAt);
      setMessage(`재고대량 조회 완료: 10개 이상 ${(data.rows || []).length}건 (전체 주문 ${data.total ?? 0}건)`);
    } catch (err) {
      setMessage(err.message || "재고대량 불러오기 실패");
    } finally {
      setStockBulkLoading(false);
    }
  };

  const loadRegisteredProducts = async () => {
    try {
      const res = await fetch(`${API}/barcode/hapbae-pre-match/registered`, { headers: getAuthHeaders() });
      const data = await res.json().catch(() => ({}));
      if (res.ok && Array.isArray(data.registered)) setRegisteredProducts(data.registered);
    } catch {
      /* silent - registration list is non-critical */
    }
  };

  const registerProduct = async (wonbeRow) => {
    const code = String(wonbeRow.상품코드 || "").trim();
    if (!code) return;
    const label = [wonbeRow.거래처, wonbeRow.상품명합 || wonbeRow.거래처상품명].filter(Boolean).join(" / ");
    try {
      const res = await fetch(`${API}/barcode/hapbae-pre-match/registered`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ code, label }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "등록 실패");
      setRegisteredProducts(data.registered || []);
      setProductSearch("");
      setProductResults([]);
      loadRows();
    } catch (err) {
      setMessage(err.message || "등록 실패");
    }
  };

  const unregisterProduct = async (code) => {
    try {
      const res = await fetch(`${API}/barcode/hapbae-pre-match/registered`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ code }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "등록 해제 실패");
      setRegisteredProducts(data.registered || []);
      loadRows();
    } catch (err) {
      setMessage(err.message || "등록 해제 실패");
    }
  };

  useEffect(() => {
    loadRows();
    loadRegisteredProducts();
  }, []);

  useEffect(() => {
    const q = productSearch.trim();
    if (!q) { setProductResults([]); return; }
    const timer = setTimeout(async () => {
      setProductSearchLoading(true);
      try {
        const params = new URLSearchParams({ q, limit: 20 });
        const res = await fetch(`${API}/wonbe/search?${params}`, { headers: getAuthHeaders() });
        const data = await res.json().catch(() => ({}));
        setProductResults(data.rows || []);
      } catch {
        setProductResults([]);
      } finally {
        setProductSearchLoading(false);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [productSearch]);

  const toggleRowChecked = async (row, sectionKey) => {
    const key = getRowKey(row, sectionKey);
    const checked = !checkedRows[key];
    const label = [row.productName, row.optionName].filter(Boolean).join(" / ");
    if (!window.confirm(`"${label}" 항목을 ${checked ? "체크" : "체크 해제"}하시겠습니까?`)) return;
    const previous = checkedRows;
    setCheckedRows((prev) => {
      const next = { ...prev };
      if (checked) {
        next[key] = true;
      } else {
        delete next[key];
      }
      return next;
    });
    try {
      const res = await fetch(`${API}/barcode/hapbae-pre-match/checked`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ key, checked }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "체크 저장 실패");
      if (data && typeof data.checked_rows === "object") {
        setCheckedRows(data.checked_rows || {});
      }
    } catch (err) {
      setCheckedRows(previous);
      setMessage(err.message || "체크 저장 실패");
    }
  };

  const renderTable = (targetRows, sectionKey) => (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>확인</th>
            <th>상품명</th>
            <th>옵션명</th>
            <th>주문수량</th>
            <th>입고수량</th>
          </tr>
        </thead>
        <tbody>
          {sortCheckedRowsToBottom(targetRows, sectionKey).map((row) => {
            const rowKey = getRowKey(row, sectionKey);
            const isChecked = !!checkedRows[rowKey];
            return (
              <tr key={rowKey} className={isChecked ? styles.checkedRow : ""}>
                <td>
                  <label className={styles.checkLabel}>
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={() => toggleRowChecked(row, sectionKey)}
                    />
                    <span>체크</span>
                  </label>
                </td>
                <td>{row.productName}</td>
                <td>{row.optionName}</td>
                <td>{row.orderQty}</td>
                <td>{row.incomingQty || 0}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!targetRows.length && (
        <div className={styles.empty}>조건에 맞는 데이터가 없습니다.</div>
      )}
    </div>
  );

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <div className={styles.titleArea}>
          <div className={styles.titleRow}>
            <h1 className={styles.title}>합배 구성 선매칭</h1>
            <span className={styles.badge}>BETA</span>
          </div>
          <p className={styles.subtitle}>
            바코드 메뉴의 확장주문검색/입고파일 업로드 상태 기반 합배 구성 선매칭
          </p>
        </div>

        <div className={styles.controls}>
          <input
            className={styles.searchInput}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="상품명 또는 옵션 검색"
          />
          <div className={styles.statusChips}>
            <span
              className={`${styles.statusChip} ${loaded ? styles.statusOk : styles.statusOff}`}
            >
              <span className={styles.statusDot} />
              확장주문검색
            </span>
            <span
              className={`${styles.statusChip} ${incomingLoaded ? styles.statusOk : styles.statusOff}`}
            >
              <span className={styles.statusDot} />
              입고파일
            </span>
          </div>
          <button
            className={styles.refreshBtn}
            onClick={loadRows}
            disabled={loading}
            type="button"
          >
            <RefreshCw size={13} className={loading ? styles.spinning : undefined} />
            새로고침
          </button>
        </div>
      </header>

      {message && <div className={styles.message}>{message}</div>}

      {stats && (
        <div className={styles.statsStrip}>
          <div className={styles.statItem}>
            <span className={styles.statLabel}>전체</span>
            <span className={styles.statValue}>{stats.totalRows}</span>
          </div>
          <div className={styles.statDivider} />
          <div className={styles.statItem}>
            <span className={styles.statLabel}>에이블리(유색)</span>
            <span className={styles.statValue}>{stats.targetRows}</span>
          </div>
          <div className={styles.statDivider} />
          <div className={styles.statItem}>
            <span className={styles.statLabel}>M열 중복</span>
            <span className={styles.statValue}>{stats.duplicateRows}</span>
          </div>
          <div className={styles.statDivider} />
          <div className={styles.statItem}>
            <span className={styles.statLabel}>입고</span>
            <span className={styles.statValue}>{rows.length}</span>
          </div>
          <div className={styles.statDivider} />
          <div className={styles.statItem}>
            <span className={styles.statLabel}>입고없음</span>
            <span className={styles.statValue}>{noIncomingRows.length}</span>
          </div>
          {searchQuery.trim() && (
            <>
              <div className={styles.statDivider} />
              <div className={styles.statItem}>
                <span className={styles.statLabel}>검색결과</span>
                <span className={styles.statValue}>
                  {highIncomingRows.length + normalIncomingRows.length + noIncomingRows.length}
                </span>
              </div>
            </>
          )}
        </div>
      )}

      <div className={styles.sections}>
        <section className={`${styles.section} ${styles.sectionHigh}`}>
          <div
            className={styles.sectionHeader}
            onClick={() => toggleSection("high")}
            style={{ cursor: "pointer" }}
          >
            <div className={styles.sectionTitle}>
              <TrendingUp size={15} />
              대량합포
            </div>
            <div className={styles.sectionMeta}>
              <span>{highIncomingRows.length}건</span>
              <span>수량 {sumOrderQty(highIncomingRows)}</span>
              <span>체크 {checkedCount(highIncomingRows, "high")}</span>
              {isExpanded("high") ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
            </div>
          </div>
          {isExpanded("high") && renderTable(highIncomingRows, "high")}
        </section>

        <section className={`${styles.section} ${styles.sectionNormal}`}>
          <div
            className={styles.sectionHeader}
            onClick={() => toggleSection("normal")}
            style={{ cursor: "pointer" }}
          >
            <div className={styles.sectionTitle}>
              <Package size={15} />
              짤합포
            </div>
            <div className={styles.sectionMeta}>
              <span>{normalIncomingRows.length}건</span>
              <span>수량 {sumOrderQty(normalIncomingRows)}</span>
              <span>체크 {checkedCount(normalIncomingRows, "normal")}</span>
              {isExpanded("normal") ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
            </div>
          </div>
          {isExpanded("normal") && renderTable(normalIncomingRows, "normal")}
        </section>

        <section className={`${styles.section} ${styles.sectionStock}`}>
          <div
            className={styles.sectionHeader}
            onClick={() => toggleSection("stock")}
            style={{ cursor: "pointer" }}
          >
            <div className={styles.sectionTitle}>
              <Archive size={15} />
              입고 없음
            </div>
            <div className={styles.sectionMeta}>
              <span>{noIncomingRows.length}건</span>
              <span>수량 {sumOrderQty(noIncomingRows)}</span>
              <span>체크 {checkedCount(noIncomingRows, "stock")}</span>
              {isExpanded("stock") ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
            </div>
          </div>
          {isExpanded("stock") && renderTable(noIncomingRows, "stock")}
        </section>

        <section className={`${styles.section} ${styles.sectionStock}`}>
          <div
            className={styles.sectionHeader}
            onClick={() => toggleSection("stockbulk")}
            style={{ cursor: "pointer" }}
          >
            <div className={styles.sectionTitle}>
              <Archive size={15} />
              재고대량
              <button
                type="button"
                className={styles.refreshBtn}
                onClick={(e) => { e.stopPropagation(); loadStockBulk(); }}
                disabled={stockBulkLoading}
                style={{ marginLeft: "0.5rem", fontSize: "0.75rem", padding: "0.2rem 0.55rem" }}
              >
                <Download size={12} className={stockBulkLoading ? styles.spinning : undefined} />
                {stockBulkLoading ? "불러오는 중..." : "불러오기"}
              </button>
              {stockBulkFetchedAt && (
                <span style={{ marginLeft: "0.5rem", fontSize: "0.75rem", fontWeight: 400, color: "var(--text-muted)" }}>
                  마지막 조회: {new Date(stockBulkFetchedAt).toLocaleString("ko-KR", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}
                </span>
              )}
            </div>
            <div className={styles.sectionMeta}>
              <span>{stockBulkRows.length}건</span>
              <span>체크 {checkedCount(stockBulkRows.map((r) => ({ productName: r.productName, optionName: r.optionName })), "stockbulk")}</span>
              {isExpanded("stockbulk") ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
            </div>
          </div>
          {isExpanded("stockbulk") && (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>확인</th>
                  <th>상품코드</th>
                  <th>상품명</th>
                  <th>옵션명</th>
                  <th>수량</th>
                </tr>
              </thead>
              <tbody>
                {sortCheckedRowsToBottom(
                  stockBulkRows.map((r) => ({ ...r, productName: r.productName, optionName: r.optionName })),
                  "stockbulk"
                ).map((row) => {
                  const rowKey = getRowKey(row, "stockbulk");
                  const isChecked = !!checkedRows[rowKey];
                  return (
                    <tr key={rowKey} className={isChecked ? styles.checkedRow : ""}>
                      <td>
                        <label className={styles.checkLabel}>
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() => toggleRowChecked(row, "stockbulk")}
                          />
                          <span>체크</span>
                        </label>
                      </td>
                      <td style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>{row.code}</td>
                      <td>{row.productName}</td>
                      <td>{row.optionName}</td>
                      <td style={{ fontWeight: 700, color: "#1d4ed8" }}>{row.qty}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!stockBulkRows.length && !stockBulkLoading && (
              <div className={styles.empty}>불러오기 버튼을 눌러 오늘 재고대량 주문을 조회하세요 (10개 이상 제품만 표시)</div>
            )}
          </div>
          )}
        </section>

        <section className={`${styles.section} ${styles.sectionHigh}`}>
          <div
            className={styles.sectionHeader}
            onClick={() => toggleSection("today")}
            style={{ cursor: "pointer" }}
          >
            <div className={styles.sectionTitle}>
              <Zap size={15} />
              TODAY 대량
            </div>
            <div className={styles.sectionMeta}>
              <span>{todayBulkRows.length}건</span>
              <span>입고 {todayBulkRows.reduce((s, r) => s + (Number(r.incomingQty) || 0), 0)}</span>
              <span>체크 {checkedCount(todayBulkRows, "today")}</span>
              {isExpanded("today") ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
            </div>
          </div>
          {isExpanded("today") && (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>확인</th>
                  <th>상품명</th>
                  <th>옵션명</th>
                  <th>연속건수</th>
                  <th>입고수량</th>
                </tr>
              </thead>
              <tbody>
                {sortCheckedRowsToBottom(
                  [...todayBulkRows].sort((a, b) =>
                    (a.productName || "").localeCompare(b.productName || "", "ko")
                  ),
                  "today"
                ).map((row) => {
                  const rowKey = getRowKey(row, "today");
                  const isChecked = !!checkedRows[rowKey];
                  return (
                    <tr key={rowKey} className={isChecked ? styles.checkedRow : ""}>
                      <td>
                        <label className={styles.checkLabel}>
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() => toggleRowChecked(row, "today")}
                          />
                          <span>체크</span>
                        </label>
                      </td>
                      <td>{row.productName}</td>
                      <td>{row.optionName}</td>
                      <td>{row.runLen}</td>
                      <td>{row.incomingQty ?? 0}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!todayBulkRows.length && (
              <div className={styles.empty}>조건에 맞는 데이터가 없습니다.</div>
            )}
          </div>
          )}
        </section>

        <section className={`${styles.section} ${styles.sectionNormal}`}>
          <div
            className={styles.sectionHeader}
            onClick={() => toggleSection("registered")}
            style={{ cursor: "pointer" }}
          >
            <div className={styles.sectionTitle}>
              <Star size={15} />
              등록상품 매칭
            </div>
            <div className={styles.sectionMeta}>
              <span>매칭 {registeredMatches.length}건</span>
              <span>등록 {registeredProducts.length}개</span>
              {isExpanded("registered") ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
            </div>
          </div>
          {isExpanded("registered") && (
            <div style={{ padding: "0.75rem 1rem" }}>
              <div style={{ position: "relative", maxWidth: "360px" }}>
                <input
                  className={styles.searchInput}
                  value={productSearch}
                  onChange={(e) => setProductSearch(e.target.value)}
                  placeholder="상품코드/상품명/거래처 검색"
                  style={{ width: "100%" }}
                />
                {productSearch.trim() && (
                  <div
                    style={{
                      position: "absolute", top: "100%", left: 0, right: 0, zIndex: 10,
                      background: "var(--surface, #fff)", border: "1px solid var(--border, #e5e7eb)",
                      borderRadius: "6px", boxShadow: "0 6px 16px rgba(0,0,0,0.12)",
                      maxHeight: "260px", overflowY: "auto", marginTop: "0.25rem",
                    }}
                  >
                    {productSearchLoading ? (
                      <div style={{ padding: "0.6rem", fontSize: "0.8rem", color: "var(--text-muted)" }}>검색 중...</div>
                    ) : productResults.length === 0 ? (
                      <div style={{ padding: "0.6rem", fontSize: "0.8rem", color: "var(--text-muted)" }}>검색 결과가 없습니다.</div>
                    ) : (
                      productResults.map((row, i) => {
                        const isRegistered = registeredCodeSet.has(String(row["상품코드"] || "").trim());
                        return (
                          <div
                            key={i}
                            onClick={isRegistered ? undefined : () => registerProduct(row)}
                            style={{
                              display: "flex", alignItems: "center", justifyContent: "space-between",
                              padding: "0.5rem 0.6rem", cursor: isRegistered ? "default" : "pointer",
                              fontSize: "0.8rem", borderBottom: "1px solid var(--border, #f0f0f0)",
                              opacity: isRegistered ? 0.55 : 1,
                            }}
                            onMouseEnter={(e) => { if (!isRegistered) e.currentTarget.style.background = "#f5f3ff"; }}
                            onMouseLeave={(e) => e.currentTarget.style.background = ""}
                          >
                            <span>
                              <strong>{row["거래처합"] ?? row["상품코드"] ?? ""}</strong>
                              <span style={{ marginLeft: "0.4rem", color: "var(--text-muted)" }}>{row["상품명합"] ?? ""}</span>
                            </span>
                            {isRegistered && (
                              <span style={{ fontSize: "0.7rem", fontWeight: 600, color: "#7c3aed", whiteSpace: "nowrap", marginLeft: "0.5rem" }}>
                                등록됨
                              </span>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>
                )}
              </div>

              <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem", marginTop: "0.75rem", maxHeight: "120px", overflowY: "auto", padding: "0.15rem" }}>
                {registeredProducts.map((item) => (
                  <span
                    key={item.code}
                    style={{
                      display: "inline-flex", alignItems: "center", gap: "0.3rem",
                      padding: "0.2rem 0.5rem", borderRadius: "999px",
                      background: "var(--bg-card, #f3f4f6)", border: "1px solid var(--border, #e5e7eb)",
                      fontSize: "0.78rem",
                    }}
                  >
                    {item.label || item.code}
                    <button
                      type="button"
                      onClick={() => unregisterProduct(item.code)}
                      style={{ background: "none", border: "none", cursor: "pointer", padding: 0, lineHeight: 1, color: "var(--text-muted)" }}
                      title="등록 해제"
                    >
                      <X size={12} />
                    </button>
                  </span>
                ))}
                {!registeredProducts.length && (
                  <span style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>등록된 상품이 없습니다.</span>
                )}
              </div>

              <div style={{ marginTop: "0.75rem" }}>
                {renderTable(registeredMatches, "registered")}
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
