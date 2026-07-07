import React, { useRef, useState } from "react";
import styles from "../Barcode/BarcodePage.module.css";
import * as XLSX from "xlsx";
import XLSXStyle from "xlsx-js-style";
import { LOCAL_API_BASE as API, getAuthHeaders } from "../../lib/api";
import { useEzadminSession } from "../../lib/EzadminSessionContext";

const stickyThStyle = {
  position: "sticky",
  top: 0,
  background: "var(--bg-secondary)",
  zIndex: 1,
};

export default function OrderPage() {
  const [activeTab, setActiveTab] = useState("standard");
  const [lizardFile, setLizardFile] = useState(null);
  const [lizardMessage, setLizardMessage] = useState("");
  const lizardFileInputRef = useRef(null);

  const { openModal: openEzadminModal } = useEzadminSession();
  const [mainOrderItems, setMainOrderItems] = useState([]);
  const [mainOrderLoading, setMainOrderLoading] = useState(false);
  const [mainOrderMessage, setMainOrderMessage] = useState("");

  const fetchMainOrderList = async () => {
    try {
      setMainOrderLoading(true);
      setMainOrderMessage("");
      const res = await fetch(`${API}/order/main-order/list`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
      });
      const data = await res.json().catch(() => ({}));
      if (data?.need_session) {
        openEzadminModal(fetchMainOrderList);
        return;
      }
      if (!data?.ok) {
        setMainOrderMessage(data?.error || "메인발주 목록 조회 실패");
        return;
      }
      setMainOrderItems(data.items || []);
      setMainOrderMessage(`조회 완료: ${data.count ?? 0}건`);
    } catch (err) {
      setMainOrderMessage(err.message || "메인발주 목록 조회 실패");
    } finally {
      setMainOrderLoading(false);
    }
  };

  const updateMainOrderRequestQty = (code, value) => {
    setMainOrderItems((prev) =>
      prev.map((item) => (item.code === code ? { ...item, requestQty: value } : item))
    );
  };

  const parseKDGFColumn = (fValue) => {
    const cleaned = String(fValue || "").replace(/[[\]]/g, "").trim();
    const parts = cleaned.split("-");
    const SIZE_SET = new Set(["S", "M", "L", "XL", "2XL", "FREE", "F1", "F2"]);
    let size = "";
    let gijang = "";
    for (const part of parts) {
      const trimmed = part.trim();
      const lower = trimmed.toLowerCase();
      if (SIZE_SET.has(trimmed)) {
        size = trimmed;
      } else if (trimmed.includes("롱") || lower.includes("long")) {
        gijang = trimmed;
      } else if (trimmed.includes("숏") || lower.includes("short")) {
        gijang = trimmed;
      } else if (trimmed.includes("기본")) {
        gijang = trimmed;
      } else if (lower.includes("midi")) {
        gijang = trimmed;
      }
    }
    return { size, gijang };
  };

  const parseEggFColumn = (fValue) => {
    const cleaned = String(fValue || "").replace(/[[\]]/g, "").trim();
    const parts = cleaned.split("-");
    const SIZE_SET = new Set(["S", "M", "L", "XL", "2XL", "FREE", "F1", "F2"]);
    const color = parts[0] ? parts[0].trim() : "";
    let size = "";
    let gijang = "";
    for (let i = 1; i < parts.length; i++) {
      const trimmed = parts[i].trim();
      const lower = trimmed.toLowerCase();
      if (SIZE_SET.has(trimmed) || SIZE_SET.has(trimmed.toUpperCase())) {
        size = trimmed.toUpperCase();
      } else if (trimmed.includes("롱") || lower.includes("long")) {
        gijang = trimmed;
      } else if (trimmed.includes("숏") || lower.includes("short")) {
        gijang = trimmed;
      } else if (trimmed.includes("기본")) {
        gijang = trimmed;
      } else if (lower.includes("midi")) {
        gijang = trimmed;
      }
    }
    return { color, gijang, size };
  };

  const readFirstSheetRows = async () => {
    if (!lizardFile) {
      setLizardMessage("가공할 파일을 선택하세요.");
      return null;
    }
    const arrayBuffer = await lizardFile.arrayBuffer();
    const inData = new Uint8Array(arrayBuffer);
    const inWb = XLSX.read(inData, { type: "array" });
    const inSheet = inWb.Sheets[inWb.SheetNames[0]];
    return XLSX.utils.sheet_to_json(inSheet, { header: 1, defval: "" });
  };

  const handleEggYolkOrder = async () => {
    try {
      const rows = await readFirstSheetRows();
      if (!rows) return;

      const filteredRows = rows.filter((row) => {
        const bVal = String(row[1] || "").trim();
        const spaceIdx = bVal.indexOf(" ");
        if (spaceIdx === -1) return false;
        return bVal.substring(0, spaceIdx) === "계란속노른자";
      });

      if (filteredRows.length === 0) {
        setLizardMessage("계란속노른자 데이터가 없습니다.");
        return;
      }

      const ws = {};
      const total = filteredRows.length;
      ws["!ref"] = `A1:G${1 + total}`;

      ws["A1"] = { v: "계란속 노른자", t: "s" };
      ws["B1"] = { v: "품번", t: "s" };
      ws["C1"] = { v: "기장", t: "s" };
      ws["D1"] = { v: "색상", t: "s" };
      ws["E1"] = { v: "사이즈", t: "s" };
      ws["F1"] = { v: "수량", t: "s" };
      ws["G1"] = { v: "비고", t: "s" };

      filteredRows.forEach((row, ri) => {
        const bVal = String(row[1] || "").trim();
        const spaceIdx = bVal.indexOf(" ");
        const pumbun = spaceIdx !== -1 ? bVal.substring(spaceIdx + 1) : "";
        const { color, gijang, size } = parseEggFColumn(row[5]);
        const qty = row[6];
        const numQty = typeof qty === "number" ? qty : Number(qty) || 0;
        const rowNum = 2 + ri;
        ws[`A${rowNum}`] = { v: "유색", t: "s" };
        ws[`B${rowNum}`] = { v: pumbun, t: "s" };
        ws[`C${rowNum}`] = { v: gijang, t: "s" };
        ws[`D${rowNum}`] = { v: color, t: "s" };
        ws[`E${rowNum}`] = { v: size, t: "s" };
        ws[`F${rowNum}`] = { v: numQty, t: "n" };
        ws[`G${rowNum}`] = { v: "", t: "s" };
      });

      const wb = XLSXStyle.utils.book_new();
      XLSXStyle.utils.book_append_sheet(wb, ws, "계란속노른자발주");
      const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      XLSXStyle.writeFile(wb, `계란속노른자_발주_${dateStr}.xlsx`);
      setLizardMessage(`완료: ${total}건 처리`);
    } catch (err) {
      setLizardMessage("파일 처리 실패: " + (err.message || "알 수 없는 오류"));
    }
  };

  const handleRemindOrder = async () => {
    try {
      const rows = await readFirstSheetRows();
      if (!rows) return;

      const filteredRows = rows.filter((row) => {
        const bVal = String(row[1] || "").trim();
        const spaceIdx = bVal.indexOf(" ");
        if (spaceIdx === -1) return false;
        return bVal.substring(0, spaceIdx) === "리마인드";
      });

      if (filteredRows.length === 0) {
        setLizardMessage("리마인드 데이터가 없습니다.");
        return;
      }

      const ws = {};
      const total = filteredRows.length;
      ws["!ref"] = `A1:C${1 + total}`;

      ws["A1"] = { v: "품명", t: "s" };
      ws["B1"] = { v: "색상-기장-사이즈", t: "s" };
      ws["C1"] = { v: "수량", t: "s" };

      filteredRows.forEach((row, ri) => {
        const bVal = String(row[1] || "").trim();
        const spaceIdx = bVal.indexOf(" ");
        const pummyung = spaceIdx !== -1 ? bVal.substring(spaceIdx + 1) : "";
        const color = row[5] || "";
        const qty = row[6];
        const numQty = typeof qty === "number" ? qty : Number(qty) || 0;
        const rowNum = 2 + ri;
        ws[`A${rowNum}`] = { v: pummyung, t: "s" };
        ws[`B${rowNum}`] = { v: String(color), t: "s" };
        ws[`C${rowNum}`] = { v: numQty, t: "n" };
      });

      const wb = XLSXStyle.utils.book_new();
      XLSXStyle.utils.book_append_sheet(wb, ws, "리마인드발주");
      const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      XLSXStyle.writeFile(wb, `리마인드_발주_${dateStr}.xlsx`);
      setLizardMessage(`완료: ${total}건 처리`);
    } catch (err) {
      setLizardMessage("파일 처리 실패: " + (err.message || "알 수 없는 오류"));
    }
  };

  const handleKDGOrder = async () => {
    try {
      const rows = await readFirstSheetRows();
      if (!rows) return;

      const filteredRows = rows.filter((row) => {
        const bVal = String(row[1] || "").trim();
        const spaceIdx = bVal.indexOf(" ");
        if (spaceIdx === -1) return false;
        return bVal.substring(0, spaceIdx) === "케이디지";
      });

      if (filteredRows.length === 0) {
        setLizardMessage("케이디지 데이터가 없습니다.");
        return;
      }

      const cols = ["A", "B", "C", "D", "E", "F", "G"];
      const total = filteredRows.length;
      const ws = {};
      ws["!ref"] = `A1:G${1 + total}`;

      const blueStyle = { font: { bold: true }, fill: { patternType: "solid", fgColor: { rgb: "DDEBF7" } } };
      const redYellowStyle = { font: { bold: true, color: { rgb: "FF0000" } }, fill: { patternType: "solid", fgColor: { rgb: "FFFF00" } } };

      ["품번", "기장", "사이즈", "수량"].forEach((v, i) => {
        ws[`${cols[i]}1`] = { v, t: "s", s: blueStyle };
      });
      ws["E1"] = { v: "", t: "s" };
      ws["F1"] = { v: "총수량", t: "s", s: redYellowStyle };
      ws["G1"] = { t: "n", f: `SUM(D2:D${1 + total})`, s: redYellowStyle };

      filteredRows.forEach((row, ri) => {
        const bVal = String(row[1] || "").trim();
        const spaceIdx = bVal.indexOf(" ");
        const pumbun = spaceIdx !== -1 ? bVal.substring(spaceIdx + 1) : "";
        const { size, gijang } = parseKDGFColumn(row[5]);
        const qty = row[6];
        const numQty = typeof qty === "number" ? qty : Number(qty) || 0;

        const rowNum = 2 + ri;
        ws[`A${rowNum}`] = { v: pumbun, t: "s" };
        ws[`B${rowNum}`] = { v: gijang, t: "s" };
        ws[`C${rowNum}`] = { v: size, t: "s" };
        ws[`D${rowNum}`] = { v: numQty, t: "n" };
        ws[`E${rowNum}`] = { v: "", t: "s" };
        ws[`F${rowNum}`] = { v: "", t: "s" };
        ws[`G${rowNum}`] = { v: "", t: "s" };
      });

      const wb = XLSXStyle.utils.book_new();
      XLSXStyle.utils.book_append_sheet(wb, ws, "케이디지발주");
      const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      XLSXStyle.writeFile(wb, `케이디지_발주_${dateStr}.xlsx`);
      setLizardMessage(`완료: ${total}건 처리`);
    } catch (err) {
      setLizardMessage("파일 처리 실패: " + (err.message || "알 수 없는 오류"));
    }
  };

  const handleDomaeKimOrder = async () => {
    try {
      const rows = await readFirstSheetRows();
      if (!rows) return;

      const filteredRows = rows.filter((row) => {
        const bVal = String(row[1] || "").trim();
        const spaceIdx = bVal.indexOf(" ");
        if (spaceIdx === -1) return false;
        return bVal.substring(0, spaceIdx) === "도매킴";
      });

      if (filteredRows.length === 0) {
        setLizardMessage("도매킴 데이터가 없습니다.");
        return;
      }

      const total = filteredRows.length;
      const FILL_ROWS = 200;
      const ws = {};
      ws["!ref"] = `A1:I${Math.max(1 + total, 1 + FILL_ROWS)}`;

      const thin = { style: "thin", color: { rgb: "CCCCCC" } };
      const border = { top: thin, bottom: thin, left: thin, right: thin };

      const hBlue = {
        font: { name: "맑은 고딕", sz: 11, color: { rgb: "FFFFFF" }, bold: true },
        fill: { patternType: "solid", fgColor: { rgb: "3366CC" } },
        border,
      };
      const hGreen = {
        font: { name: "맑은 고딕", sz: 11, color: { rgb: "FFFFFF" }, bold: true },
        fill: { patternType: "solid", fgColor: { rgb: "339966" } },
        border,
      };
      const dBlue = { fill: { patternType: "solid", fgColor: { rgb: "DFE6F7" } }, border };
      const dGreen = { fill: { patternType: "solid", fgColor: { rgb: "CCF2E3" } }, border };

      const blueCols = ["A", "B", "C", "D"];
      const greenCols = ["E", "F", "G", "H", "I"];
      const headers = ["상품코드", "색상", "사이즈", "주문수량", "고객바코드", "고객상품명", "고객색상", "고객사이즈", "고객정보"];

      blueCols.forEach((col, i) => { ws[`${col}1`] = { v: headers[i], t: "s", s: hBlue }; });
      greenCols.forEach((col, i) => { ws[`${col}1`] = { v: headers[4 + i], t: "s", s: hGreen }; });

      for (let r = 2; r <= 1 + FILL_ROWS; r++) {
        blueCols.forEach((col) => { ws[`${col}${r}`] = { v: "", t: "s", s: dBlue }; });
        greenCols.forEach((col) => { ws[`${col}${r}`] = { v: "", t: "s", s: dGreen }; });
      }

      filteredRows.forEach((row, ri) => {
        const bVal = String(row[1] || "").trim();
        const spaceIdx = bVal.indexOf(" ");
        const productCode = spaceIdx !== -1 ? bVal.substring(spaceIdx + 1) : "";
        const { color, size } = parseEggFColumn(row[5]);
        const qty = row[6];
        const numQty = typeof qty === "number" ? qty : Number(qty) || 0;
        const customerProductName = String(row[0] || "");

        const rowNum = 2 + ri;
        ws[`A${rowNum}`] = { v: productCode, t: "s", s: dBlue };
        ws[`B${rowNum}`] = { v: color, t: "s", s: dBlue };
        ws[`C${rowNum}`] = { v: size, t: "s", s: dBlue };
        ws[`D${rowNum}`] = { v: numQty, t: "n", s: dBlue };
        ws[`E${rowNum}`] = { v: "", t: "s", s: dGreen };
        ws[`F${rowNum}`] = { v: customerProductName, t: "s", s: dGreen };
        ws[`G${rowNum}`] = { v: color, t: "s", s: dGreen };
        ws[`H${rowNum}`] = { v: size, t: "s", s: dGreen };
        ws[`I${rowNum}`] = { v: "유색", t: "s", s: dGreen };
      });

      const wb = XLSXStyle.utils.book_new();
      XLSXStyle.utils.book_append_sheet(wb, ws, "도매킴발주");
      const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      XLSXStyle.writeFile(wb, `도매킴_발주_${dateStr}.xlsx`);
      setLizardMessage(`완료: ${total}건 처리`);
    } catch (err) {
      setLizardMessage("파일 처리 실패: " + (err.message || "알 수 없는 오류"));
    }
  };

  const handleLizardStandardOrder = async () => {
    try {
      const rows = await readFirstSheetRows();
      if (!rows) return;

      const filteredRows = rows.filter((row) => {
        const bVal = String(row[1] || "").trim();
        const spaceIdx = bVal.indexOf(" ");
        if (spaceIdx === -1) return false;
        return bVal.substring(0, spaceIdx) === "리자드스탠다드";
      });

      if (filteredRows.length === 0) {
        setLizardMessage("리자드스탠다드 데이터가 없습니다.");
        return;
      }

      const yellowFill = { patternType: "solid", fgColor: { rgb: "FFFF00" } };
      const headers = ["상호", "건물명", "도매처명", "연락처", "도매처상품명", "옵션", "수량", "비고", "전달사항"];
      const cols = ["A", "B", "C", "D", "E", "F", "G", "H", "I"];

      const ws = {};
      ws["!ref"] = `A1:I${2 + filteredRows.length}`;
      ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 8 } }];

      cols.forEach((col) => {
        ws[`${col}1`] = { v: "", t: "s" };
      });

      headers.forEach((h, i) => {
        ws[`${cols[i]}2`] = { v: h, t: "s", s: { fill: yellowFill } };
      });

      filteredRows.forEach((row, ri) => {
        const bVal = String(row[1] || "").trim();
        const spaceIdx = bVal.indexOf(" ");
        const rightPart = spaceIdx !== -1 ? bVal.substring(spaceIdx + 1) : "";
        const dataRow = [
          "벨류스",
          "★매장 : 디오트 지하2층 N-67,68호 ★샘플반납 : 경기도 용인시 처인구 포곡읍 둔전로59",
          "리자드스탠다드",
          "010-3019-1351",
          rightPart,
          row[5] || "",
          row[6] || "",
          "",
          "",
        ];
        dataRow.forEach((val, ci) => {
          ws[`${cols[ci]}${3 + ri}`] = { v: String(val), t: "s" };
        });
      });

      const wb = XLSXStyle.utils.book_new();
      XLSXStyle.utils.book_append_sheet(wb, ws, "리자드스탠다드발주");
      const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      XLSXStyle.writeFile(wb, `리자드스탠다드_발주_${dateStr}.xlsx`);
      setLizardMessage(`완료: ${filteredRows.length}건 처리`);
    } catch (err) {
      setLizardMessage("파일 처리 실패: " + (err.message || "알 수 없는 오류"));
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <div>
          <h2 className={styles.title}>발주</h2>
          <p className={styles.subtitle}>기성발주 가공 · 메인발주</p>
        </div>
      </div>

      <div className={styles.tabRow}>
        <button
          className={`${styles.tabBtn} ${activeTab === "standard" ? styles.tabActive : ""}`}
          onClick={() => setActiveTab("standard")}
        >
          기성발주 가공
        </button>
        <button
          className={`${styles.tabBtn} ${activeTab === "main-order" ? styles.tabActive : ""}`}
          onClick={() => setActiveTab("main-order")}
        >
          메인발주
        </button>
      </div>

      {activeTab === "standard" && (
        <section className={styles.card}>
          <div className={styles.cardHeader}>
            <h3 className={styles.cardTitle}>기성발주 가공</h3>
          </div>
          <div className={styles.uploadRow}>
            <label className={styles.fileInput}>
              <input
                ref={lizardFileInputRef}
                type="file"
                accept=".xls,.xlsx,.xlsm"
                onChange={(e) => {
                  setLizardFile(e.target.files?.[0] ?? null);
                  setLizardMessage("");
                }}
              />
              {lizardFile ? lizardFile.name : "원본 파일 선택"}
            </label>
            {lizardFile && (
              <button
                className={styles.secondaryBtn}
                onClick={() => {
                  setLizardFile(null);
                  setLizardMessage("");
                  if (lizardFileInputRef.current) lizardFileInputRef.current.value = "";
                }}
              >
                원본파일 초기화
              </button>
            )}
            <button className={styles.primaryBtn} onClick={handleLizardStandardOrder}>
              리자드스탠다드 발주
            </button>
            <button className={styles.secondaryBtn} onClick={handleKDGOrder}>
              케이디지 발주
            </button>
            <button className={styles.secondaryBtn} onClick={handleRemindOrder}>
              리마인드 발주
            </button>
            <button className={styles.secondaryBtn} onClick={handleEggYolkOrder}>
              계란속노른자 발주
            </button>
            <button className={styles.secondaryBtn} onClick={handleDomaeKimOrder}>
              도매킴 발주
            </button>
          </div>
          <div className={styles.statusMsg}>
            <strong>처리 기준:</strong> B열 첫 번째 띄어쓰기 왼쪽 거래처명 기준으로 각 발주 양식을 생성합니다.
          </div>
          {lizardMessage && (
            <div className={styles.statusMsg}>
              <strong>{lizardMessage}</strong>
            </div>
          )}
        </section>
      )}

      {activeTab === "main-order" && (
        <section className={styles.card}>
          <div className={styles.cardHeader}>
            <h3 className={styles.cardTitle}>메인발주 ({mainOrderItems.length}건)</h3>
          </div>
          <div className={styles.uploadRow}>
            <button className={styles.primaryBtn} onClick={fetchMainOrderList} disabled={mainOrderLoading}>
              {mainOrderLoading ? "조회 중..." : "새로고침"}
            </button>
          </div>
          {mainOrderMessage && (
            <div className={styles.statusMsg}>
              <strong>{mainOrderMessage}</strong>
            </div>
          )}
          {mainOrderItems.length === 0 ? (
            <div className={styles.statusMsg}>새로고침을 눌러 미배송/부족 상품 목록을 불러오세요.</div>
          ) : (
            <div className={styles.tableWrap} style={{ maxHeight: "85vh", overflowY: "auto" }}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th style={stickyThStyle}>상품코드</th>
                    <th style={stickyThStyle}>상품명</th>
                    <th style={stickyThStyle}>옵션</th>
                    <th style={stickyThStyle}>공급처상품명</th>
                    <th style={stickyThStyle}>재고</th>
                    <th style={stickyThStyle}>미배송수량</th>
                    <th style={stickyThStyle}>부족수량</th>
                    <th style={stickyThStyle}>요청수량</th>
                  </tr>
                </thead>
                <tbody>
                  {mainOrderItems.map((item) => (
                    <tr key={item.code}>
                      <td>{item.code}</td>
                      <td>{item.name}</td>
                      <td>{item.options}</td>
                      <td>{item.supplyProductName}</td>
                      <td>{item.stock}</td>
                      <td>{item.notYetDeliv}</td>
                      <td>{item.lackQty}</td>
                      <td>
                        <input
                          type="number"
                          value={item.requestQty}
                          onChange={(e) => updateMainOrderRequestQty(item.code, e.target.value)}
                          style={{ width: "70px", padding: "0.3rem 0.4rem" }}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
