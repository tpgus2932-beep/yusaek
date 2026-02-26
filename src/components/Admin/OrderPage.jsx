import React, { useEffect, useMemo, useRef, useState } from "react";
import styles from "../Barcode/BarcodePage.module.css";
import * as XLSX from "xlsx";

const API = `http://${window.location.hostname}:8000`;

const getAuthHeaders = () => {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
};

const getDownloadFilename = (res, fallback) => {
  const disposition = res.headers.get("content-disposition") || "";
  const match = disposition.match(/filename\*?=(?:UTF-8''|\"?)([^\";]+)/i);
  if (match?.[1]) {
    return decodeURIComponent(match[1].replace(/\"/g, ""));
  }
  return fallback;
};

export default function OrderPage() {
  const [activeSubTab, setActiveSubTab] = useState("order-check");
  const [status, setStatus] = useState(null);
  const [registered, setRegistered] = useState([]);
  const [registeredQuery, setRegisteredQuery] = useState("");
  const [message, setMessage] = useState("");
  const [costMessage, setCostMessage] = useState("");
  const [loading, setLoading] = useState(false);

  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState([]);
  const [selected, setSelected] = useState(null);
  const [qty, setQty] = useState("0");
  const searchTimer = useRef(null);

  const [showCostEditor, setShowCostEditor] = useState(false);
  const [costColumns, setCostColumns] = useState([]);
  const [costRows, setCostRows] = useState([]);
  const [costTotal, setCostTotal] = useState(0);
  const [costOffset, setCostOffset] = useState(0);
  const [costQuery, setCostQuery] = useState("");
  const [costEdits, setCostEdits] = useState({});
  const [costAddName, setCostAddName] = useState("");
  const [costAddCode, setCostAddCode] = useState("");
  const costLimit = 50;

  const [excelFile, setExcelFile] = useState(null);
  const [checkResults, setCheckResults] = useState([]);
  const [dailyFile, setDailyFile] = useState(null);
  const [dailyLoading, setDailyLoading] = useState(false);
  const [dailyMessage, setDailyMessage] = useState("");
  const [dailySkipHeader, setDailySkipHeader] = useState(true);
  const [dailyHeaderCol1, setDailyHeaderCol1] = useState("상품명");
  const [dailyHeaderCol2, setDailyHeaderCol2] = useState("상품코드");
  const [dailyHeaderCol3, setDailyHeaderCol3] = useState("옵션추가항목8");
  const [dailyIncludeCol1, setDailyIncludeCol1] = useState(true);
  const [dailyIncludeCol2, setDailyIncludeCol2] = useState(true);
  const [dailyIncludeCol3, setDailyIncludeCol3] = useState(true);
  const [dailyUnmatchedProducts, setDailyUnmatchedProducts] = useState([]);
  const [dailyUnmatchedRowCount, setDailyUnmatchedRowCount] = useState(0);

  const filteredRegistered = useMemo(() => {
    const q = (registeredQuery || "").trim().toLowerCase();
    if (!q) return registered;
    return registered.filter((it) => {
      const name = String(it?.name || "").toLowerCase();
      const code = String(it?.code || "").toLowerCase();
      const qty = String(it?.qty ?? "").toLowerCase();
      return name.includes(q) || code.includes(q) || qty.includes(q);
    });
  }, [registered, registeredQuery]);

  const handleUnauthorized = (res) => {
    if (res.status === 401) {
      localStorage.removeItem("token");
      window.location.reload();
      return true;
    }
    return false;
  };

  const fetchStatus = async () => {
    const res = await fetch(`${API}/order/status`, { headers: getAuthHeaders() });
    if (handleUnauthorized(res)) return;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.detail || "발주 상태 조회 실패");
    setStatus(data);
  };

  const fetchRegistered = async () => {
    const res = await fetch(`${API}/order/registered/list`, { headers: getAuthHeaders() });
    if (handleUnauthorized(res)) return;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.detail || "등록코드 조회 실패");
    setRegistered(data.items || []);
  };

  const fetchCostPreview = async (offset = 0, q = costQuery) => {
    const res = await fetch(
      `${API}/amood-hapbae/cost-base/preview?offset=${offset}&limit=${costLimit}&q=${encodeURIComponent(
        (q || "").trim()
      )}`,
      { headers: getAuthHeaders() }
    );
    if (handleUnauthorized(res)) return;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.detail || "원가베이스 미리보기 실패");
    setCostColumns(data.columns || []);
    setCostRows(data.rows || []);
    setCostTotal(data.total || 0);
    setCostOffset(offset);
    setCostEdits({});
  };

  useEffect(() => {
    (async () => {
      try {
        await fetchStatus();
        await fetchRegistered();
      } catch (err) {
        setMessage(err.message || "초기 로드 실패");
      }
    })();
  }, []);

  const searchSuggestion = async (q) => {
    const v = (q || "").trim();
    if (!v) {
      setSuggestions([]);
      return;
    }
    const res = await fetch(`${API}/order/cost-base/search?q=${encodeURIComponent(v)}&limit=20`, {
      headers: getAuthHeaders(),
    });
    if (handleUnauthorized(res)) return;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.detail || "검색 실패");
    setSuggestions(data.items || []);
  };

  const handleAddRegistered = async () => {
    if (!selected?.code) {
      setMessage("원가베이스 검색에서 항목을 선택하세요.");
      window.alert("원가베이스 검색에서 항목을 먼저 선택하세요.");
      return;
    }
    if (registered.some((it) => String(it.code || "").trim().toUpperCase() === String(selected.code || "").trim().toUpperCase())) {
      setMessage("이미 등록된 코드입니다.");
      window.alert(`이미 등록된 코드입니다: ${selected.code}`);
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/order/registered/add`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ code: selected.code, qty }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const detail = data?.detail || "등록코드 저장 실패";
        if (res.status === 409) {
          window.alert(`중복 등록 불가: ${selected.code}`);
        } else {
          window.alert(detail);
        }
        throw new Error(detail);
      }
      await fetchRegistered();
      await fetchStatus();
      setMessage(`${selected.name || selected.code} 저장 완료`);
      setQuery("");
      setSuggestions([]);
      setSelected(null);
      setQty("0");
    } catch (err) {
      setMessage(err.message || "등록코드 저장 실패");
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (code) => {
    if (!window.confirm(`${code}를 삭제할까요?`)) return;
    try {
      const res = await fetch(`${API}/order/registered?code=${encodeURIComponent(code)}`, {
        method: "DELETE",
        headers: getAuthHeaders(),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "삭제 실패");
      await fetchRegistered();
      await fetchStatus();
    } catch (err) {
      setMessage(err.message || "삭제 실패");
    }
  };

  const handleEditQty = async (code, currentQty) => {
    const next = window.prompt(`${code} 기준개수 수정`, String(currentQty ?? 0));
    if (next === null) return;
    const val = String(next).trim();
    if (!val) {
      setMessage("기준개수를 입력하세요.");
      return;
    }
    try {
      const res = await fetch(`${API}/order/registered/upsert`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ code, qty: val }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "수정 실패");
      await fetchRegistered();
      await fetchStatus();
      setMessage(`${code} 기준개수 수정 완료`);
    } catch (err) {
      setMessage(err.message || "수정 실패");
    }
  };

  const handleCheckExcel = async () => {
    if (!excelFile) {
      setMessage("검사할 엑셀(.xlsx)을 선택하세요.");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      const formData = new FormData();
      formData.append("file", excelFile);
      const res = await fetch(`${API}/order/check`, {
        method: "POST",
        headers: getAuthHeaders(),
        body: formData,
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "엑셀 검사 실패");
      setCheckResults(data.results || []);
      setMessage(`검사 완료: ${data.count || 0}건`);
    } catch (err) {
      setMessage(err.message || "엑셀 검사 실패");
    } finally {
      setLoading(false);
    }
  };

  const handleDownloadCheckResult = () => {
    if (!checkResults.length) {
      setMessage("다운로드할 검사 결과가 없습니다.");
      return;
    }
    const rows = checkResults.map((r) => ({
      상품명: r.name || "",
      코드: r.code || "",
      접수: r.received_qty ?? "",
      기준개수: r.need_qty ?? "",
      실제개수: r.actual_qty ?? "",
      부족수량: r.shortage ?? "",
      결과: r.text || "",
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "발주검사결과");
    XLSX.writeFile(wb, `발주_검사결과_${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "")}.xlsx`);
  };

  const buildDailyFormData = () => {
    if (!dailyFile) return null;
    const formData = new FormData();
    formData.append("file", dailyFile);
    formData.append("skip_header", dailySkipHeader ? "true" : "false");
    formData.append("header_col1", dailyHeaderCol1);
    formData.append("header_col2", dailyHeaderCol2);
    formData.append("header_col3", dailyHeaderCol3);
    formData.append("include_col1", dailyIncludeCol1 ? "true" : "false");
    formData.append("include_col2", dailyIncludeCol2 ? "true" : "false");
    formData.append("include_col3", dailyIncludeCol3 ? "true" : "false");
    return formData;
  };

  const handleDailyPreview = async () => {
    if (!dailyFile) {
      setDailyMessage("가공할 엑셀(.xlsx/.xlsm)을 선택하세요.");
      return;
    }
    setDailyLoading(true);
    setDailyMessage("");
    try {
      const formData = buildDailyFormData();
      const res = await fetch(`${API}/order/daily-sales/preview`, {
        method: "POST",
        headers: getAuthHeaders(),
        body: formData,
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "미리보기 실패");
      setDailyUnmatchedProducts(Array.isArray(data.unmatched_products) ? data.unmatched_products : []);
      setDailyUnmatchedRowCount(Number(data.unmatched_row_count || 0));
      if ((data.unmatched_row_count || 0) > 0) {
        setDailyMessage(`B열(상품코드) 공란 ${data.unmatched_row_count}건 / 상품 ${data.unmatched_product_count || 0}건`);
      } else {
        setDailyMessage("B열(상품코드) 공란 데이터가 없습니다.");
      }
    } catch (err) {
      setDailyMessage(err.message || "미리보기 실패");
      setDailyUnmatchedProducts([]);
      setDailyUnmatchedRowCount(0);
    } finally {
      setDailyLoading(false);
    }
  };

  const handleDailyExport = async () => {
    if (!dailyIncludeCol1 && !dailyIncludeCol2 && !dailyIncludeCol3) {
      setDailyMessage("다운로드할 열을 최소 1개 선택하세요.");
      return;
    }
    if (!dailyFile) {
      setDailyMessage("가공할 엑셀(.xlsx/.xlsm)을 선택하세요.");
      return;
    }
    setDailyLoading(true);
    setDailyMessage("");
    try {
      const formData = buildDailyFormData();
      const res = await fetch(`${API}/order/daily-sales/export`, {
        method: "POST",
        headers: getAuthHeaders(),
        body: formData,
      });
      if (handleUnauthorized(res)) return;
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.detail || "일일판매량 XLS 다운로드 실패");
      }
      const blob = await res.blob();
      const fallbackBase = (dailyFile?.name || "일일판매량").replace(/\.[^.]+$/, "");
      const filename = getDownloadFilename(res, `${fallbackBase}_일일판매량_가공본.xls`);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setDailyMessage(`다운로드 완료: ${filename}`);
    } catch (err) {
      setDailyMessage(err.message || "일일판매량 XLS 다운로드 실패");
    } finally {
      setDailyLoading(false);
    }
  };

  const handleCostBaseReload = async () => {
    try {
      const res = await fetch(`${API}/amood-hapbae/cost-base/reload`, {
        method: "POST",
        headers: getAuthHeaders(),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "원가베이스 로드 실패");
      setCostMessage("원가베이스 로드 완료");
      await fetchStatus();
    } catch (err) {
      setCostMessage(err.message || "원가베이스 로드 실패");
    }
  };

  const handleCostBaseAddSingle = async () => {
    const name = (costAddName || "").trim();
    const code = (costAddCode || "").trim();
    if (!name && !code) {
      setCostMessage("A열 또는 B열 값을 입력하세요.");
      return;
    }
    try {
      const res = await fetch(`${API}/amood-hapbae/cost-base/add-row`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ name, code }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "개별상품추가 실패");
      setCostMessage("개별상품추가 완료");
      setCostAddName("");
      setCostAddCode("");
      await fetchStatus();
      await fetchRegistered();
      if (showCostEditor) {
        await fetchCostPreview(0, "").catch(() => {});
      }
    } catch (err) {
      setCostMessage(err.message || "개별상품추가 실패");
    }
  };

  const handleCostCellChange = (rowIndex, colIndex, value) => {
    setCostRows((prev) =>
      prev.map((row) =>
        row.row_index === rowIndex
          ? { ...row, values: row.values.map((v, i) => (i === colIndex ? value : v)) }
          : row
      )
    );
    setCostEdits((prev) => {
      const key = `${rowIndex}:${colIndex}`;
      return { ...prev, [key]: { row_index: rowIndex, column: colIndex, value } };
    });
  };

  const handleCostCellCommit = async () => {
    const edits = Object.values(costEdits);
    if (!edits.length) {
      setCostMessage("변경된 내용이 없습니다.");
      return;
    }
    try {
      const res = await fetch(`${API}/amood-hapbae/cost-base/edit-batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ edits }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "원가베이스 수정 실패");
      setCostMessage("원가베이스 변경 적용 완료");
      setCostEdits({});
      await fetchRegistered();
    } catch (err) {
      setCostMessage(err.message || "원가베이스 수정 실패");
      await fetchCostPreview(costOffset, costQuery).catch(() => {});
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <div>
          <h2 className={styles.title}>발주</h2>
          <p className={styles.subtitle}>관리자 전용: 등록코드 기준 부족 항목 검사</p>
        </div>
      </div>
      <div className={styles.tabRow}>
        <button
          className={`${styles.tabBtn} ${activeSubTab === "order-check" ? styles.tabActive : ""}`}
          onClick={() => setActiveSubTab("order-check")}
        >
          발주검사
        </button>
        <button
          className={`${styles.tabBtn} ${activeSubTab === "daily-sales" ? styles.tabActive : ""}`}
          onClick={() => setActiveSubTab("daily-sales")}
        >
          일일판매량
        </button>
      </div>

      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h3 className={styles.cardTitle}>원가베이스 관리</h3>
        </div>
        <div className={styles.uploadRow}>
          <button className={styles.secondaryBtn} onClick={handleCostBaseReload}>새로 로드</button>
          <button
            className={styles.secondaryBtn}
            onClick={async () => {
              setShowCostEditor(true);
              await fetchCostPreview(0, "").catch((e) => setCostMessage(e.message || "원가베이스 미리보기 실패"));
            }}
          >
            원가베이스 편집
          </button>
        </div>
        <div className={styles.uploadRow}>
          <input
            className={styles.searchInput}
            value={costAddName}
            onChange={(e) => setCostAddName(e.target.value)}
            placeholder="A열 데이터 (상품명)"
          />
          <input
            className={styles.cellInput}
            style={{ maxWidth: 220 }}
            value={costAddCode}
            onChange={(e) => setCostAddCode(e.target.value)}
            placeholder="B열 데이터 (상품코드)"
          />
          <button className={styles.primaryBtn} onClick={handleCostBaseAddSingle}>
            개별상품추가
          </button>
        </div>
        {costMessage && (
          <div className={styles.statusMsg}>
            <strong>{costMessage}</strong>
          </div>
        )}
      </section>

      {activeSubTab === "order-check" && (
        <>
          <section className={styles.card}>
            <div className={styles.cardHeader}>
              <h3 className={styles.cardTitle}>등록코드 관리</h3>
              <span className={styles.pill}>등록 {status?.registered_count ?? 0}개</span>
            </div>
            <div className={styles.uploadRow}>
              <input
                className={styles.searchInput}
                value={query}
                onChange={(e) => {
                  const v = e.target.value;
                  setQuery(v);
                  setSelected(null);
                  if (searchTimer.current) clearTimeout(searchTimer.current);
                  searchTimer.current = setTimeout(() => {
                    searchSuggestion(v).catch(() => {});
                  }, 200);
                }}
                placeholder="A열 상품명 검색 (자동완성)"
              />
              <input
                className={styles.cellInput}
                style={{ maxWidth: 120 }}
                value={qty}
                onChange={(e) => setQty(e.target.value)}
                placeholder="기준개수"
              />
              <button className={styles.primaryBtn} onClick={handleAddRegistered} disabled={loading}>
                등록코드 추가
              </button>
            </div>
            <div className={styles.uploadRow}>
              <input
                className={styles.searchInput}
                value={registeredQuery}
                onChange={(e) => setRegisteredQuery(e.target.value)}
                placeholder="등록된 코드 검색 (상품명/코드/기준개수)"
              />
              <span className={styles.pill}>검색결과 {filteredRegistered.length}개</span>
            </div>
            {selected && (
              <div className={styles.statusMsg}>
                <strong>선택:</strong> {selected.name || "(이름없음)"} / 코드 {selected.code}
              </div>
            )}
            {suggestions.length > 0 && (
              <div className={styles.logBox}>
                {suggestions.map((it, idx) => (
                  <button
                    key={`${it.code}-${idx}`}
                    className={styles.secondaryBtn}
                    onClick={() => {
                      setSelected(it);
                      setQuery(`${it.name} (${it.code})`);
                      setSuggestions([]);
                    }}
                  >
                    {it.name || "(이름없음)"} / {it.code}
                  </button>
                ))}
              </div>
            )}
            <div className={`${styles.tableWrap} ${styles.registeredTableWrap}`}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>상품명(A)</th>
                    <th>코드(B)</th>
                    <th>기준개수</th>
                    <th>관리</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRegistered.map((it) => (
                    <tr key={it.code}>
                      <td>{it.name || "-"}</td>
                      <td>{it.code}</td>
                      <td>{it.qty}</td>
                      <td>
                        <button className={styles.ghostBtn} onClick={() => handleEditQty(it.code, it.qty)}>
                          수정
                        </button>
                        <button className={styles.ghostBtn} onClick={() => handleDelete(it.code)}>
                          삭제
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {registered.length === 0 && <div className={styles.empty}>등록된 코드가 없습니다.</div>}
              {registered.length > 0 && filteredRegistered.length === 0 && (
                <div className={styles.empty}>검색 결과가 없습니다.</div>
              )}
            </div>
          </section>

          <section className={styles.card}>
            <div className={styles.cardHeader}>
              <h3 className={styles.cardTitle}>엑셀 검사 (XLS/XLSX)</h3>
            </div>
            <div className={styles.uploadRow}>
              <label className={styles.fileInput}>
                <input type="file" accept=".xls,.xlsx,.xlsm" onChange={(e) => setExcelFile(e.target.files?.[0] ?? null)} />
                검사할 엑셀 선택
              </label>
              <button className={styles.primaryBtn} onClick={handleCheckExcel} disabled={loading}>
                {loading ? "검사 중..." : "검사 실행"}
              </button>
              <button className={styles.secondaryBtn} onClick={handleDownloadCheckResult}>
                검사결과 엑셀 다운로드
              </button>
            </div>
            {message && (
              <div className={styles.statusMsg}>
                <strong>{message}</strong>
              </div>
            )}
            <div className={styles.logBox}>
              {checkResults.length === 0 ? (
                <div className={styles.empty}>부족/미등록 항목 없음</div>
              ) : (
                checkResults.map((r, idx) => (
                  <div key={`${r.code}-${idx}`} className={styles.logLine}>
                    {r.text} / 접수 {r.received_qty ?? 0}
                  </div>
                ))
              )}
            </div>
          </section>
        </>
      )}

      {activeSubTab === "daily-sales" && (
        <section className={styles.card}>
          <div className={styles.cardHeader}>
            <h3 className={styles.cardTitle}>일일판매량 가공</h3>
          </div>
          <div className={styles.uploadRow}>
            <label className={styles.fileInput}>
              <input type="file" accept=".xlsx,.xlsm" onChange={(e) => setDailyFile(e.target.files?.[0] ?? null)} />
              가공할 엑셀 선택
            </label>
            <label className={styles.checkboxItem}>
              <input
                type="checkbox"
                checked={dailySkipHeader}
                onChange={(e) => setDailySkipHeader(e.target.checked)}
              />
              1행 헤더, 2행부터 처리
            </label>
            <button className={styles.secondaryBtn} onClick={handleDailyPreview} disabled={dailyLoading}>
              {dailyLoading ? "조회 중..." : "B열 공란 조회"}
            </button>
            <button className={styles.primaryBtn} onClick={handleDailyExport} disabled={dailyLoading}>
              {dailyLoading ? "다운로드 중..." : "XLS 다운로드"}
            </button>
          </div>
          <div className={styles.uploadRow}>
            <label className={styles.checkboxItem}>
              <input
                type="checkbox"
                checked={dailyIncludeCol1}
                onChange={(e) => setDailyIncludeCol1(e.target.checked)}
              />
              A열
            </label>
            <input
              className={styles.cellInput}
              value={dailyHeaderCol1}
              onChange={(e) => setDailyHeaderCol1(e.target.value)}
              placeholder="A열 헤더"
              disabled={!dailyIncludeCol1}
            />
            <label className={styles.checkboxItem}>
              <input
                type="checkbox"
                checked={dailyIncludeCol2}
                onChange={(e) => setDailyIncludeCol2(e.target.checked)}
              />
              B열
            </label>
            <input
              className={styles.cellInput}
              value={dailyHeaderCol2}
              onChange={(e) => setDailyHeaderCol2(e.target.value)}
              placeholder="B열 헤더"
              disabled={!dailyIncludeCol2}
            />
            <label className={styles.checkboxItem}>
              <input
                type="checkbox"
                checked={dailyIncludeCol3}
                onChange={(e) => setDailyIncludeCol3(e.target.checked)}
              />
              C열
            </label>
            <input
              className={styles.cellInput}
              value={dailyHeaderCol3}
              onChange={(e) => setDailyHeaderCol3(e.target.value)}
              placeholder="C열 헤더"
              disabled={!dailyIncludeCol3}
            />
          </div>
          <div className={styles.statusMsg}>
            <strong>입력 기준:</strong> A열 상품명, B열 옵션, D열 수량 (2행부터 처리)
          </div>
          {dailyUnmatchedRowCount > 0 && (
            <div className={styles.statusMsg}>
              <strong>B열(상품코드) 공란:</strong> 행 {dailyUnmatchedRowCount}건 / 상품 {dailyUnmatchedProducts.length}건
              {dailyUnmatchedProducts.length > 0 && (
                <div className={styles.logBox}>
                  {dailyUnmatchedProducts.map((name, idx) => (
                    <div key={`${name}-${idx}`} className={styles.logLine}>
                      - {name}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {dailyMessage && (
            <div className={styles.statusMsg}>
              <strong>{dailyMessage}</strong>
            </div>
          )}
        </section>
      )}

      {showCostEditor && (
        <div className={styles.modalOverlay} onClick={() => setShowCostEditor(false)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <h3 className={styles.modalTitle}>원가베이스 편집</h3>
              <div className={styles.modalActions}>
                <input
                  className={styles.searchInput}
                  value={costQuery}
                  onChange={(e) => setCostQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") fetchCostPreview(0, costQuery).catch(() => {});
                  }}
                  placeholder="검색어 입력"
                />
                <button className={styles.secondaryBtn} onClick={() => fetchCostPreview(0, costQuery).catch(() => {})}>
                  검색
                </button>
                <button className={styles.secondaryBtn} onClick={() => fetchCostPreview(costOffset, costQuery).catch(() => {})}>
                  새로고침
                </button>
                <button className={styles.primaryBtn} onClick={handleCostCellCommit}>변경 적용</button>
                <button className={styles.secondaryBtn} onClick={() => setShowCostEditor(false)}>닫기</button>
              </div>
            </div>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>#</th>
                    {costColumns.map((c) => <th key={c}>{c}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {costRows.map((row) => (
                    <tr key={row.row_index}>
                      <td>{row.row_index + 1}</td>
                      {row.values.map((v, idx) => (
                        <td key={`${row.row_index}-${idx}`}>
                          <input
                            className={styles.cellInput}
                            value={v ?? ""}
                            onChange={(e) => handleCostCellChange(row.row_index, idx, e.target.value)}
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className={styles.uploadRow}>
              <button
                className={styles.secondaryBtn}
                onClick={() => fetchCostPreview(Math.max(0, costOffset - costLimit), costQuery).catch(() => {})}
                disabled={costOffset === 0}
              >
                이전
              </button>
              <button
                className={styles.secondaryBtn}
                onClick={() =>
                  fetchCostPreview(Math.min(costOffset + costLimit, Math.max(costTotal - costLimit, 0)), costQuery).catch(() => {})
                }
                disabled={costOffset + costLimit >= costTotal}
              >
                다음
              </button>
              <span className={styles.metaLabel}>
                {costTotal ? `${costOffset + 1}-${Math.min(costOffset + costLimit, costTotal)} / ${costTotal}` : "0"}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
