import React, { useEffect, useState } from "react";
import styles from "../Barcode/BarcodePage.module.css";
import { getDownloadFilename } from "../../lib/download";

import { LOCAL_API_BASE as API, getAuthHeaders } from "../../lib/api";

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

  const [janggiFile, setJanggiFile] = useState(null);
  const [janggiRows, setJanggiRows] = useState([]);

  const [todayFile, setTodayFile] = useState(null);
  const [todayRows, setTodayRows] = useState([]);

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
    if (kdgRows.length === 0 && !kdgText.trim()) {
      setMessage("원본 텍스트를 먼저 입력하세요.");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      const body = kdgRows.length > 0 ? { rows: kdgRows } : { text: kdgText, with_match: true };
      const res = await fetch(`${API}/noye-kimsungil/kdg/export-xls`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify(body),
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
    if (kdgRows.length === 0 && !kdgText.trim()) {
      setMessage("원본 텍스트를 먼저 입력하세요.");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      const body = kdgRows.length > 0 ? { rows: kdgRows } : { text: kdgText };
      const res = await fetch(`${API}/noye-kimsungil/kdg/date-copy-text`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify(body),
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

  const processTodayFile = async () => {
    if (!todayFile) {
      setMessage("가공할 XLS 파일을 선택하세요.");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      const XLSX = await import("xlsx");
      const arrayBuffer = await todayFile.arrayBuffer();
      const workbook = XLSX.read(arrayBuffer, { type: "array" });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rawData = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });

      const rows = rawData.slice(1);
      const processed = rows
        .filter((row) => String(row[6] ?? "").trim() !== "")
        .map((row) => ({
          A: String(row[6] ?? ""),
          B: String(Math.max(0, Number(row[4] ?? 0))),
        }));

      setTodayRows(processed);
      setMessage(`가공 완료: ${processed.length}행 (빈 G열 제거됨)`);
    } catch (err) {
      setMessage(err.message || "가공 실패");
    } finally {
      setLoading(false);
    }
  };

  const downloadTodayFile = async () => {
    if (!todayRows.length) {
      setMessage("먼저 가공 버튼을 눌러주세요.");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      const XLSX = await import("xlsx");
      const wsData = [
        ["에이블리 옵션 번호", "재고 수량"],
        ...todayRows.map((r) => [r.A, r.B]),
      ];
      const ws = XLSX.utils.aoa_to_sheet(wsData);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
      XLSX.writeFile(wb, "오늘출발.xlsx");
      setMessage("다운로드 완료");
    } catch (err) {
      setMessage(err.message || "다운로드 실패");
    } finally {
      setLoading(false);
    }
  };

  const copyTodayFile = async () => {
    if (!todayRows.length) {
      setMessage("먼저 가공 버튼을 눌러주세요.");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      const header = "에이블리 옵션 번호\t재고 수량";
      const body = todayRows.map((r) => `${r.A}\t${r.B}`).join("\n");
      const tsv = `${header}\n${body}`;
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
      setMessage(`엑셀 복사 완료: ${todayRows.length}행`);
    } catch (err) {
      setMessage(err.message || "엑셀 복사 실패");
    } finally {
      setLoading(false);
    }
  };

  const processJanggi = async () => {
    if (!janggiFile) {
      setMessage("가공할 XLS 파일을 선택하세요.");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      const XLSX = await import("xlsx");
      const arrayBuffer = await janggiFile.arrayBuffer();
      const workbook = XLSX.read(arrayBuffer, { type: "array" });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rawData = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });

      const rows = rawData.slice(1);
      const processed = rows
        .map((row) => {
          const colB = row[1] ?? "";
          const colC = row[2] ?? "";
          const colD = row[3] ?? "";
          const colH = row[7] ?? "";
          const colJ = row[9] ?? "";

          // C열: [그레이-free] 또는 [7560블랙-롱-m] → 첫 번째 토큰=색상, 나머지=사이즈
          let parsedC = "";
          let parsedD = "";
          const bracketMatch = String(colC).match(/\[([^\]]+)\]/);
          if (bracketMatch) {
            const parts = bracketMatch[1].split("-");
            parsedC = parts[0] || "";
            parsedD = parts.slice(1).join(" ");
          } else {
            parsedC = String(colC);
          }

          // D열: "에스빈 생지백비죠포인트와이드팬츠" → 첫 단어=브랜드, 나머지=상품명
          const dStr = String(colD).trim();
          const spaceIdx = dStr.indexOf(" ");
          const parsedF = spaceIdx > -1 ? dStr.slice(0, spaceIdx) : dStr;
          const parsedG = spaceIdx > -1 ? dStr.slice(spaceIdx + 1) : "";

          return {
            A: String(colJ),
            B: String(colB),
            C: parsedC,
            D: parsedD,
            E: String(colH),
            F: parsedF,
            G: parsedG,
          };
        })
        .filter((r) => r.A || r.B || r.C || r.D || r.E || r.F || r.G);

      setJanggiRows(processed);
      setMessage(`가공 완료: ${processed.length}행`);
    } catch (err) {
      setMessage(err.message || "가공 실패");
    } finally {
      setLoading(false);
    }
  };

  const downloadJanggi = async () => {
    if (!janggiRows.length) {
      setMessage("먼저 가공 버튼을 눌러주세요.");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      const XLSX = await import("xlsx");
      const wsData = [
        ["A", "B", "C", "D", "E", "F", "G"],
        ...janggiRows.map((r) => [r.A, r.B, r.C, r.D, r.E, r.F, r.G]),
      ];
      const ws = XLSX.utils.aoa_to_sheet(wsData);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
      XLSX.writeFile(wb, "가공결과.xlsx");
      setMessage("다운로드 완료");
    } catch (err) {
      setMessage(err.message || "다운로드 실패");
    } finally {
      setLoading(false);
    }
  };

  const copyJanggi = async () => {
    if (!janggiRows.length) {
      setMessage("먼저 가공 버튼을 눌러주세요.");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      const tsv = janggiRows.map((r) => [r.A, r.B, r.C, r.D, r.E, r.F, r.G].join("\t")).join("\n");
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
      setMessage(`엑셀 복사 완료: ${janggiRows.length}행`);
    } catch (err) {
      setMessage(err.message || "엑셀 복사 실패");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <div>
          <h2 className={styles.title}>노예김승일</h2>
          <p className={styles.subtitle}>케이디지가공2 / 날짜별장끼정리 / 장끼가공 / 오늘출발</p>
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
        <button
          className={`${styles.tabBtn} ${activeTab === "janggi" ? styles.tabActive : ""}`}
          onClick={() => setActiveTab("janggi")}
        >
          장끼가공
        </button>
        <button
          className={`${styles.tabBtn} ${activeTab === "today" ? styles.tabActive : ""}`}
          onClick={() => setActiveTab("today")}
        >
          오늘출발
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

      {activeTab === "today" && (
        <>
          <section className={styles.card}>
            <div className={styles.cardHeader}>
              <h3 className={styles.cardTitle}>오늘출발</h3>
            </div>
            <div className={styles.uploadRow}>
              <label className={styles.fileInput}>
                <input
                  type="file"
                  accept=".xls,.xlsx,.xlsm"
                  onChange={(e) => {
                    setTodayFile(e.target.files?.[0] ?? null);
                    setTodayRows([]);
                  }}
                />
                {todayFile ? todayFile.name : "XLS 파일 선택"}
              </label>
              <button className={styles.primaryBtn} onClick={processTodayFile} disabled={loading}>
                가공
              </button>
              <button className={styles.secondaryBtn} onClick={downloadTodayFile} disabled={loading || !todayRows.length}>
                다운로드
              </button>
              <button className={styles.secondaryBtn} onClick={copyTodayFile} disabled={loading || !todayRows.length}>
                엑셀 복사
              </button>
            </div>
            <div className={styles.statusMsg}>
              <strong>동작:</strong> G열 빈 행 제거 → A열(에이블리 옵션 번호)=G열 / B열(재고 수량)=E열
            </div>
          </section>

          {todayRows.length > 0 && (
            <section className={styles.card}>
              <div className={styles.cardHeader}>
                <h3 className={styles.cardTitle}>가공 결과</h3>
                <span className={styles.pill}>{todayRows.length}행</span>
              </div>
              <div className={`${styles.tableWrap} ${styles.registeredTableWrap}`}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>에이블리 옵션 번호 (G열)</th>
                      <th>재고 수량 (E열)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {todayRows.map((r, i) => (
                      <tr key={i}>
                        <td>{r.A}</td>
                        <td>{r.B}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}

      {activeTab === "janggi" && (
        <>
          <section className={styles.card}>
            <div className={styles.cardHeader}>
              <h3 className={styles.cardTitle}>장끼가공</h3>
            </div>
            <div className={styles.uploadRow}>
              <label className={styles.fileInput}>
                <input
                  type="file"
                  accept=".xls,.xlsx,.xlsm"
                  onChange={(e) => {
                    setJanggiFile(e.target.files?.[0] ?? null);
                    setJanggiRows([]);
                  }}
                />
                {janggiFile ? janggiFile.name : "XLS 파일 선택"}
              </label>
              <button className={styles.primaryBtn} onClick={processJanggi} disabled={loading}>
                가공
              </button>
              <button className={styles.secondaryBtn} onClick={downloadJanggi} disabled={loading || !janggiRows.length}>
                다운로드
              </button>
              <button className={styles.secondaryBtn} onClick={copyJanggi} disabled={loading || !janggiRows.length}>
                엑셀 복사
              </button>
            </div>
            <div className={styles.statusMsg}>
              <strong>매핑:</strong> J열→A / B열→B / C열([색상-사이즈] 파싱)→C,D / H열→E / D열(브랜드 상품명)→F,G
            </div>
          </section>

          {janggiRows.length > 0 && (
            <section className={styles.card}>
              <div className={styles.cardHeader}>
                <h3 className={styles.cardTitle}>가공 결과</h3>
                <span className={styles.pill}>{janggiRows.length}행</span>
              </div>
              <div className={`${styles.tableWrap} ${styles.registeredTableWrap}`}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>A (J열)</th>
                      <th>B (B열)</th>
                      <th>C (색상)</th>
                      <th>D (사이즈)</th>
                      <th>E (H열)</th>
                      <th>F (브랜드)</th>
                      <th>G (상품명)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {janggiRows.map((r, i) => (
                      <tr key={i}>
                        <td>{r.A}</td>
                        <td>{r.B}</td>
                        <td>{r.C}</td>
                        <td>{r.D}</td>
                        <td>{r.E}</td>
                        <td>{r.F}</td>
                        <td>{r.G}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
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
