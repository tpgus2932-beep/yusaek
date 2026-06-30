import React, { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, TrendingUp, Package, Archive, Zap } from "lucide-react";
import styles from "./TestTabs.module.css";
import { LOCAL_API_BASE as API, getAuthHeaders } from "../../lib/api";

export default function HapbaePreMatch() {
  const [rows, setRows] = useState([]);
  const [stockRows, setStockRows] = useState([]);
  const [todayBulkRows, setTodayBulkRows] = useState([]);
  const [checkedRows, setCheckedRows] = useState({});
  const [stats, setStats] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [incomingLoaded, setIncomingLoaded] = useState(false);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

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

  const highIncomingRows = useMemo(
    () => filterRows(rows.filter((row) => todayBulkKeySet.has(`${row.productName}::${row.optionName}`))),
    [filterRows, rows, todayBulkKeySet]
  );
  const normalIncomingRows = useMemo(
    () => filterRows(rows.filter((row) => !todayBulkKeySet.has(`${row.productName}::${row.optionName}`))),
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

  useEffect(() => {
    loadRows();
  }, []);

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
          <div className={styles.sectionHeader}>
            <div className={styles.sectionTitle}>
              <TrendingUp size={15} />
              TODAY 대량 포함
            </div>
            <div className={styles.sectionMeta}>
              <span>{highIncomingRows.length}건</span>
              <span>수량 {sumOrderQty(highIncomingRows)}</span>
              <span>체크 {checkedCount(highIncomingRows, "high")}</span>
            </div>
          </div>
          {renderTable(highIncomingRows, "high")}
        </section>

        <section className={`${styles.section} ${styles.sectionNormal}`}>
          <div className={styles.sectionHeader}>
            <div className={styles.sectionTitle}>
              <Package size={15} />
              TODAY 대량 미포함
            </div>
            <div className={styles.sectionMeta}>
              <span>{normalIncomingRows.length}건</span>
              <span>수량 {sumOrderQty(normalIncomingRows)}</span>
              <span>체크 {checkedCount(normalIncomingRows, "normal")}</span>
            </div>
          </div>
          {renderTable(normalIncomingRows, "normal")}
        </section>

        <section className={`${styles.section} ${styles.sectionStock}`}>
          <div className={styles.sectionHeader}>
            <div className={styles.sectionTitle}>
              <Archive size={15} />
              입고 없음
            </div>
            <div className={styles.sectionMeta}>
              <span>{noIncomingRows.length}건</span>
              <span>수량 {sumOrderQty(noIncomingRows)}</span>
              <span>체크 {checkedCount(noIncomingRows, "stock")}</span>
            </div>
          </div>
          {renderTable(noIncomingRows, "stock")}
        </section>

        <section className={`${styles.section} ${styles.sectionHigh}`}>
          <div className={styles.sectionHeader}>
            <div className={styles.sectionTitle}>
              <Zap size={15} />
              TODAY 대량
            </div>
            <div className={styles.sectionMeta}>
              <span>{todayBulkRows.length}건</span>
              <span>입고 {todayBulkRows.reduce((s, r) => s + (Number(r.incomingQty) || 0), 0)}</span>
              <span>체크 {checkedCount(todayBulkRows, "today")}</span>
            </div>
          </div>
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
        </section>
      </div>
    </div>
  );
}
