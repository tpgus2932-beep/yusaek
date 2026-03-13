import React, { useEffect, useState } from "react";
import styles from "../Barcode/BarcodePage.module.css";
import { getDownloadFilename } from "../../lib/download";

const API = `http://${window.location.hostname}:8000`;

const getAuthHeaders = () => {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
};

export default function NoyeKimPage() {
  const [activeTab, setActiveTab] = useState("kdg");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  const [kdgText, setKdgText] = useState("");
  const [kdgRows, setKdgRows] = useState([]);
  const [kdgMissing, setKdgMissing] = useState(0);
  const [baseStatus, setBaseStatus] = useState(null);
  const [baseFile, setBaseFile] = useState(null);
  const [showBaseEditor, setShowBaseEditor] = useState(false);
  const [baseColumns, setBaseColumns] = useState([]);
  const [baseRows, setBaseRows] = useState([]);
  const [baseTotal, setBaseTotal] = useState(0);
  const [baseOffset, setBaseOffset] = useState(0);
  const [baseQuery, setBaseQuery] = useState("");
  const [baseEdits, setBaseEdits] = useState({});
  const baseLimit = 50;

  const [chunkFile, setChunkFile] = useState(null);

  const fetchBaseStatus = async () => {
    try {
      const res = await fetch(`${API}/noye-kimsungil/kdg/base/status`, { headers: getAuthHeaders() });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return;
      setBaseStatus(data);
    } catch {
      // ignore
    }
  };

  const fetchBasePreview = async (offset = 0, q = baseQuery) => {
    const res = await fetch(
      `${API}/noye-kimsungil/kdg/base/preview?offset=${offset}&limit=${baseLimit}&q=${encodeURIComponent(
        (q || "").trim()
      )}`,
      { headers: getAuthHeaders() }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.detail || "원가베이스 미리보기 실패");
    setBaseColumns(data.columns || []);
    setBaseRows(data.rows || []);
    setBaseTotal(data.total || 0);
    setBaseOffset(offset);
    setBaseEdits({});
  };

  useEffect(() => {
    fetchBaseStatus();
  }, []);

  const runKdgConvert = async () => {
    if (!kdgText.trim()) {
      setMessage("원본 텍스트를 먼저 입력하세요.");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/noye-kimsungil/kdg/convert`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ text: kdgText }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "변환 실패");
      const addedRows = data.rows || [];
      setKdgRows((prev) => [...prev, ...addedRows]);
      setKdgMissing(0);
      setMessage(`변환 완료: 이번 ${data.count || 0}건 / 누적 ${kdgRows.length + addedRows.length}건`);
    } catch (err) {
      setMessage(err.message || "변환 실패");
    } finally {
      setLoading(false);
    }
  };

  const runKdgMatch = async () => {
    if (!kdgText.trim()) {
      setMessage("원본 텍스트를 먼저 입력하세요.");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/noye-kimsungil/kdg/match`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ text: kdgText }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "원베 매칭 실패");
      const addedRows = data.rows || [];
      const addedMissing = Number(data.missing || 0);
      setKdgRows((prev) => [...prev, ...addedRows]);
      setKdgMissing((prev) => prev + addedMissing);
      setMessage(
        `매칭 완료: 이번 ${data.count || 0}건 / 미매칭 ${addedMissing}건 / 누적 ${kdgRows.length + addedRows.length}건`
      );
    } catch (err) {
      setMessage(err.message || "원베 매칭 실패");
    } finally {
      setLoading(false);
    }
  };

  const downloadKdgXls = async () => {
    if (!kdgText.trim()) {
      setMessage("원본 텍스트를 먼저 입력하세요.");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/noye-kimsungil/kdg/export-xls`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ text: kdgText, with_match: true }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.detail || "XLS 다운로드 실패");
      }
      const blob = await res.blob();
      const filename = getDownloadFilename(res, "입고업로드.xls");
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setMessage(`다운로드 완료: ${filename}`);
    } catch (err) {
      setMessage(err.message || "XLS 다운로드 실패");
    } finally {
      setLoading(false);
    }
  };

  const copyKdgDate = async () => {
    if (!kdgText.trim()) {
      setMessage("원본 텍스트를 먼저 입력하세요.");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/noye-kimsungil/kdg/date-copy-text`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ text: kdgText }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "날짜별 복사 데이터 생성 실패");
      const tsv = data?.text || "";
      if (!tsv) throw new Error("복사할 데이터가 없습니다.");
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(tsv);
      } else {
        const ta = document.createElement("textarea");
        ta.value = tsv;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
      }
      setMessage(`클립보드 복사 완료: ${data?.count || 0}행`);
    } catch (err) {
      setMessage(err.message || "날짜별 복사 실패");
    } finally {
      setLoading(false);
    }
  };

  const uploadBase = async () => {
    if (!baseFile) {
      setMessage("케이디지 원가베이스 파일을 선택하세요.");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      const formData = new FormData();
      formData.append("file", baseFile);
      const res = await fetch(`${API}/noye-kimsungil/kdg/base/upload`, {
        method: "POST",
        headers: getAuthHeaders(),
        body: formData,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "원가베이스 업로드 실패");
      await fetchBaseStatus();
      setMessage("원가베이스 업로드 완료");
      setBaseFile(null);
    } catch (err) {
      setMessage(err.message || "원가베이스 업로드 실패");
    } finally {
      setLoading(false);
    }
  };

  const commitBaseEdits = async () => {
    const edits = Object.values(baseEdits);
    if (!edits.length) {
      setMessage("변경된 내용이 없습니다.");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/noye-kimsungil/kdg/base/edit-batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ edits }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "원가베이스 수정 실패");
      setBaseEdits({});
      await fetchBasePreview(baseOffset, baseQuery);
      await fetchBaseStatus();
      setMessage("원가베이스 변경 적용 완료");
    } catch (err) {
      setMessage(err.message || "원가베이스 수정 실패");
    } finally {
      setLoading(false);
    }
  };

  const handleBaseCellChange = (rowIndex, colIndex, value) => {
    setBaseRows((prev) =>
      prev.map((row) =>
        row.row_index === rowIndex
          ? { ...row, values: row.values.map((v, i) => (i === colIndex ? value : v)) }
          : row
      )
    );
    setBaseEdits((prev) => {
      const key = `${rowIndex}:${colIndex}`;
      return { ...prev, [key]: { row_index: rowIndex, column: colIndex, value } };
    });
  };

  const downloadBase = async () => {
    setLoading(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/noye-kimsungil/kdg/base/download`, { headers: getAuthHeaders() });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.detail || "원가베이스 다운로드 실패");
      }
      const blob = await res.blob();
      const filename = getDownloadFilename(res, "케이디지원가베이스.xlsx");
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setMessage(`다운로드 완료: ${filename}`);
    } catch (err) {
      setMessage(err.message || "원가베이스 다운로드 실패");
    } finally {
      setLoading(false);
    }
  };

  const copyDateChunk = async () => {
    if (!chunkFile) {
      setMessage("가공할 엑셀 파일을 먼저 선택하세요.");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      const formData = new FormData();
      formData.append("file", chunkFile);
      const res = await fetch(`${API}/noye-kimsungil/date-chunk/copy`, {
        method: "POST",
        headers: getAuthHeaders(),
        body: formData,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "가공 후 복사 실패");
      const tsv = data?.text || "";
      if (!tsv) throw new Error("복사할 데이터가 없습니다.");
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(tsv);
      } else {
        const ta = document.createElement("textarea");
        ta.value = tsv;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
      }
      setMessage(`가공 결과 복사 완료: ${data?.rows || 0}행`);
    } catch (err) {
      setMessage(err.message || "가공 후 복사 실패");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <div>
          <h2 className={styles.title}>노예김승일</h2>
          <p className={styles.subtitle}>케이디지가공2 / 날짜별장끼정리</p>
        </div>
      </div>

      <div className={styles.tabRow}>
        <button className={`${styles.tabBtn} ${activeTab === "kdg" ? styles.tabActive : ""}`} onClick={() => setActiveTab("kdg")}>
          케이디지가공2
        </button>
        <button
          className={`${styles.tabBtn} ${activeTab === "date-chunk" ? styles.tabActive : ""}`}
          onClick={() => setActiveTab("date-chunk")}
        >
          날짜별장끼정리
        </button>
      </div>

      {activeTab === "kdg" && (
        <>
          <section className={styles.card}>
            <div className={styles.cardHeader}>
              <h3 className={styles.cardTitle}>케이디지가공2</h3>
            </div>
            <textarea
              className={styles.scanInput}
              style={{ minHeight: 220, width: "100%" }}
              value={kdgText}
              onChange={(e) => setKdgText(e.target.value)}
              placeholder="원본 텍스트를 그대로 붙여넣으세요"
            />
            <div className={styles.uploadRow}>
              <button className={styles.primaryBtn} onClick={runKdgConvert} disabled={loading}>
                변환
              </button>
              <button className={styles.secondaryBtn} onClick={runKdgMatch} disabled={loading}>
                이지어드민 변환(원베 매칭)
              </button>
              <button className={styles.secondaryBtn} onClick={downloadKdgXls} disabled={loading}>
                XLS 저장(A=원베,B=옵션)
              </button>
              <button className={styles.secondaryBtn} onClick={copyKdgDate} disabled={loading}>
                날짜별 복사
              </button>
            </div>
            <div className={styles.uploadRow}>
              <label className={styles.fileInput}>
                <input type="file" accept=".xls,.xlsx,.xlsm" onChange={(e) => setBaseFile(e.target.files?.[0] ?? null)} />
                케이디지 원가베이스 선택
              </label>
              <button className={styles.secondaryBtn} onClick={uploadBase} disabled={loading}>
                원가베이스 업로드
              </button>
              <button className={styles.secondaryBtn} onClick={downloadBase} disabled={loading}>
                원가베이스 다운로드
              </button>
              <button
                className={styles.secondaryBtn}
                onClick={async () => {
                  setShowBaseEditor(true);
                  await fetchBasePreview(0, "").catch((e) => setMessage(e.message || "원가베이스 미리보기 실패"));
                }}
                disabled={loading}
              >
                원가베이스 편집
              </button>
            </div>
            {baseStatus?.path && (
              <div className={styles.statusMsg}>
                <strong>원가베이스:</strong> {baseStatus.path} {baseStatus.exists ? "" : "(없음)"}
              </div>
            )}
            {kdgMissing > 0 && (
              <div className={styles.statusMsg}>
                <strong>미매칭:</strong> {kdgMissing}건
              </div>
            )}
          </section>

          <section className={styles.card}>
            <div className={styles.cardHeader}>
              <h3 className={styles.cardTitle}>결과</h3>
              <span className={styles.pill}>{kdgRows.length}건</span>
            </div>
            <div className={`${styles.tableWrap} ${styles.registeredTableWrap}`}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>A(변환품명)</th>
                    <th>B(옵션번호)</th>
                    <th>원베_B</th>
                    <th>원본품명</th>
                  </tr>
                </thead>
                <tbody>
                  {kdgRows.map((r, i) => (
                    <tr key={`${r["원본품명"] || ""}-${i}`}>
                      <td>{r["A(변환품명)"] || ""}</td>
                      <td>{r["B(옵션번호)"] || ""}</td>
                      <td>{r["원베_B"] || ""}</td>
                      <td>{r["원본품명"] || ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {kdgRows.length === 0 && <div className={styles.empty}>변환 결과가 없습니다.</div>}
            </div>
          </section>
        </>
      )}

      {activeTab === "date-chunk" && (
        <section className={styles.card}>
          <div className={styles.cardHeader}>
            <h3 className={styles.cardTitle}>날짜별장끼정리</h3>
          </div>
          <div className={styles.uploadRow}>
            <label className={styles.fileInput}>
              <input type="file" accept=".xlsx,.xls,.xlsm" onChange={(e) => setChunkFile(e.target.files?.[0] ?? null)} />
              가공할 엑셀 선택
            </label>
            <button className={styles.primaryBtn} onClick={copyDateChunk} disabled={loading}>
              가공 후 복사
            </button>
          </div>
          <div className={styles.statusMsg}>
            <strong>동작:</strong> A~G 가공, 마지막 행 삭제, G열 오늘 날짜 채움 후 표 형태로 클립보드 복사
          </div>
        </section>
      )}

      {message && (
        <div className={styles.statusMsg}>
          <strong>{message}</strong>
        </div>
      )}

      {showBaseEditor && (
        <div className={styles.modalOverlay} onClick={() => setShowBaseEditor(false)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <h3 className={styles.modalTitle}>케이디지 원가베이스 편집</h3>
              <div className={styles.modalActions}>
                <input
                  className={styles.searchInput}
                  value={baseQuery}
                  onChange={(e) => setBaseQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") fetchBasePreview(0, baseQuery).catch(() => {});
                  }}
                  placeholder="검색어 입력"
                />
                <button className={styles.secondaryBtn} onClick={() => fetchBasePreview(0, baseQuery).catch(() => {})}>
                  검색
                </button>
                <button className={styles.secondaryBtn} onClick={() => fetchBasePreview(baseOffset, baseQuery).catch(() => {})}>
                  새로고침
                </button>
                <button className={styles.primaryBtn} onClick={commitBaseEdits} disabled={loading}>
                  변경 적용
                </button>
                <button className={styles.secondaryBtn} onClick={() => setShowBaseEditor(false)}>
                  닫기
                </button>
              </div>
            </div>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>#</th>
                    {baseColumns.map((c) => (
                      <th key={c}>{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {baseRows.map((row) => (
                    <tr key={row.row_index}>
                      <td>{row.row_index + 1}</td>
                      {row.values.map((v, idx) => (
                        <td key={`${row.row_index}-${idx}`}>
                          <input
                            className={styles.cellInput}
                            value={v ?? ""}
                            onChange={(e) => handleBaseCellChange(row.row_index, idx, e.target.value)}
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
                onClick={() => fetchBasePreview(Math.max(0, baseOffset - baseLimit), baseQuery).catch(() => {})}
                disabled={baseOffset === 0}
              >
                이전
              </button>
              <button
                className={styles.secondaryBtn}
                onClick={() =>
                  fetchBasePreview(Math.min(baseOffset + baseLimit, Math.max(baseTotal - baseLimit, 0)), baseQuery).catch(() => {})
                }
                disabled={baseOffset + baseLimit >= baseTotal}
              >
                다음
              </button>
              <span className={styles.metaLabel}>
                {baseTotal ? `${baseOffset + 1}-${Math.min(baseOffset + baseLimit, baseTotal)} / ${baseTotal}` : "0"}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
