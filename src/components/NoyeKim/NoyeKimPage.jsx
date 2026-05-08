import React, { useEffect, useRef, useState } from "react";
import styles from "./NoyeKimPage.module.css";
import { getDownloadFilename } from "../../lib/download";
import {
  ArrowDownToLine, Calendar, Clipboard, FileSpreadsheet,
  Printer, RefreshCw, Shuffle, Table2, X, Zap,
} from "lucide-react";

import { LOCAL_API_BASE as API, getAuthHeaders } from "../../lib/api";

const RECEIPT_FOOTER_LABEL = "전표제목";
const RECEIPT_NOISE_PATTERNS = [
  "항목설정",
  "추가기능",
  "바코드출력",
  "입고수량변경",
  "다운로드",
  "입고요청전표상세",
  "즐겨찾기",
  "재고관리",
  "재고부족",
  "전표명",
  "상태",
  "요청",
  "완료",
  "전표 메모",
  "수정",
  "전표 번호",
];

function formatLocalDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeRawText(text) {
  return String(text || "")
    .replace(/\r\n?/g, "\n")
    .replace(/\t+/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/[ ]+/g, " ")
    .replace(/\n{2,}/g, "\n\n");
}

function parseNumber(value) {
  return Number(String(value || "").replace(/,/g, "").trim()) || 0;
}

function getReceiptLines(text) {
  const rawLines = normalizeRawText(text)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !RECEIPT_NOISE_PATTERNS.some((pattern) => line.includes(pattern)));
  const footerIndex = rawLines.indexOf(RECEIPT_FOOTER_LABEL);
  return footerIndex >= 0 ? rawLines.slice(0, footerIndex) : rawLines;
}

function extractProductName(supplierProductName) {
  const cleaned = String(supplierProductName || "").trim();
  const [head = "", ...rest] = cleaned.split(/\s+/);

  return {
    supplierPrefix: head,
    supplierSuffix: rest.join(" "),
  };
}

function extractOptionParts(optionText) {
  if (!optionText) {
    return { color: "", size: "" };
  }

  const [color = "", ...rest] = String(optionText)
    .trim()
    .split("-")
    .map((part) => part.trim())
    .filter(Boolean);

  return {
    color,
    size: rest.join(" "),
  };
}

function isOptionLine(line) {
  return /\[[^\]]+\]/.test(String(line || ""));
}

function findSupplierProductName(lines, optionIndex) {
  const fixedLine = String(lines[optionIndex - 2] || "").trim();
  if (
    fixedLine &&
    !/^[A-Z]\d+$/i.test(fixedLine) &&
    !/^\d+$/.test(fixedLine) &&
    !/^\d[\d,]*$/.test(fixedLine) &&
    !/^(세현1|yusaek|유색)$/i.test(fixedLine) &&
    !isOptionLine(fixedLine)
  ) {
    return fixedLine;
  }

  for (let index = optionIndex - 1; index >= Math.max(0, optionIndex - 6); index -= 1) {
    const line = String(lines[index] || "").trim();
    if (!line) continue;
    if (/^[A-Z]\d+$/i.test(line)) continue;
    if (/^\d+$/.test(line)) continue;
    if (/^\d[\d,]*$/.test(line)) continue;
    if (/^(세현1|yusaek|유색)$/i.test(line)) continue;
    if (isOptionLine(line)) continue;
    return line;
  }
  return "";
}

function findNextNumericLines(lines, startIndex, count) {
  const values = [];
  for (let index = startIndex; index < lines.length && values.length < count; index += 1) {
    const line = String(lines[index] || "").trim();
    if (/^\d[\d,]*$/.test(line)) {
      values.push(line);
    }
  }
  return values;
}

function extractQuantities(receivedQtyValue, pendingQtyValue) {
  const receivedQty = parseNumber(receivedQtyValue);
  const pendingQty = parseNumber(pendingQtyValue);

  if (pendingQty > 0) {
    return {
      quantity: String(pendingQty),
      remark: "미송",
    };
  }

  return {
    quantity: receivedQty > 0 ? String(receivedQty) : "",
    remark: "ㅇ",
  };
}

function convertSlipTextToRows(text) {
  const date = formatLocalDate();
  const lines = getReceiptLines(text);
  const rows = [];

  for (let index = 0; index < lines.length; index += 1) {
    const optionLine = lines[index] || "";
    if (!isOptionLine(optionLine)) {
      continue;
    }

    const supplierProductName = findSupplierProductName(lines, index);
    const numericValues = findNextNumericLines(lines, index + 1, 7);
    const costValue = numericValues[0] || "";
    const receivedQtyValue = numericValues[4] || "";
    const pendingQtyValue = numericValues[5] || "";

    if (!supplierProductName || numericValues.length < 7 || !/^\d[\d,]*$/.test(costValue)) {
      continue;
    }

    const optionMatch = optionLine.match(/\[([^\]]+)\]/);
    const optionText = optionMatch ? optionMatch[1] : "";
    const { supplierPrefix, supplierSuffix } = extractProductName(supplierProductName);
    const { color, size } = extractOptionParts(optionText);
    const { quantity, remark } = extractQuantities(receivedQtyValue, pendingQtyValue);

    if (!supplierPrefix && !supplierSuffix && !color && !size && !quantity) {
      continue;
    }

    rows.push({
      A: supplierPrefix,
      B: supplierSuffix,
      C: "",
      D: color,
      E: size,
      F: quantity,
      G: date,
      H: remark,
    });
  }

  return rows;
}


function convertCurrentReceiptExcelRows(rawData) {
  const rows = [];
  const dataRows = Array.isArray(rawData) ? rawData.slice(1) : [];
  const date = formatLocalDate();

  for (const row of dataRows) {
    const supplierProductName = String(row?.[0] ?? "").trim();
    const optionCell = String(row?.[1] ?? "").trim();
    const originalQty = String(row?.[2] ?? "").trim();
    const requestQty = parseNumber(row?.[3]);
    const pickupText = String(row?.[4] ?? "").trim();

    if (!supplierProductName && !optionCell && !originalQty && !requestQty && !pickupText) {
      continue;
    }

    const { supplierPrefix, supplierSuffix } = extractProductName(supplierProductName);
    const optionMatch = optionCell.match(/\[([^\]]+)\]/);
    const optionText = optionMatch ? optionMatch[1] : optionCell.replace(/^\[|\]$/g, "");
    const { color, size } = extractOptionParts(optionText);
    const isPickup = pickupText.includes("미송픽업");
    const isMissing = requestQty > 0;

    rows.push({
      A: supplierPrefix,
      B: supplierSuffix,
      C: isPickup
        ? "미송픽업"
        : "=INDEX(Sheet2!E:E,MATCH([@거래처상품명],Sheet2!G:G,0),0)*[@개수]",
      D: color,
      E: size,
      F: isMissing ? String(requestQty) : originalQty,
      G: date,
      H: isPickup ? "미송픽업" : isMissing ? "미송" : "ㅇ",
    });
  }

  if (rows.length > 0) {
    rows.pop();
  }

  return rows;
}

function rowsToTsv(rows) {
  return rows.map((row) => [row.A, row.B, row.C, row.D, row.E, row.F, row.G, row.H].join("\t")).join("\n");
}

function convertCurrentReceiptExcelRowsSplitV2(rawData) {
  const rows = [];
  const dataRows = Array.isArray(rawData) ? rawData.slice(1) : [];
  const date = formatLocalDate();
  const normalCostFormula = "=INDEX(Sheet2!E:E,MATCH([@거래처상품명],Sheet2!G:G,0),0)*[@개수]";
  const pickupLabel = "\uBBF8\uC1A1\uD53D\uC5C5";
  const missingLabel = "\uBBF8\uC1A1";

  for (const row of dataRows) {
    const supplierProductName = String(row?.[0] ?? "").trim();
    const optionCell = String(row?.[1] ?? "").trim();
    const originalQty = parseNumber(row?.[2]);
    const requestQty = parseNumber(row?.[3]);
    const pickupText = String(row?.[4] ?? "").trim();

    if (!supplierProductName && !optionCell && !originalQty && !requestQty && !pickupText) {
      continue;
    }

    const { supplierPrefix, supplierSuffix } = extractProductName(supplierProductName);
    const optionMatch = optionCell.match(/\[([^\]]+)\]/);
    const optionText = optionMatch ? optionMatch[1] : optionCell.replace(/^\[|\]$/g, "");
    const { color, size } = extractOptionParts(optionText);
    const isPickup = pickupText.includes(pickupLabel);

    if (originalQty > 0) {
      rows.push({
        A: supplierPrefix,
        B: supplierSuffix,
        C: normalCostFormula,
        D: color,
        E: size,
        F: String(originalQty),
        G: date,
        H: "ㅇ",
      });
    }

    if (requestQty > 0) {
      rows.push({
        A: supplierPrefix,
        B: supplierSuffix,
        C: isPickup ? pickupLabel : normalCostFormula,
        D: color,
        E: size,
        F: String(requestQty),
        G: date,
        H: isPickup ? pickupLabel : missingLabel,
      });
    }
  }

  if (rows.length > 0) {
    rows.pop();
  }

  return rows;
}

function convertCurrentReceiptExcelRowsSplit(rawData) {
  const rows = [];
  const dataRows = Array.isArray(rawData) ? rawData.slice(1) : [];
  const date = formatLocalDate();
  const normalCostFormula = "=INDEX(Sheet2!E:E,MATCH([@嫄곕옒泥섏긽?덈챸],Sheet2!G:G,0),0)*[@媛쒖닔]";

  for (const row of dataRows) {
    const supplierProductName = String(row?.[0] ?? "").trim();
    const optionCell = String(row?.[1] ?? "").trim();
    const originalQty = parseNumber(row?.[2]);
    const requestQty = parseNumber(row?.[3]);
    const pickupText = String(row?.[4] ?? "").trim();

    if (!supplierProductName && !optionCell && !originalQty && !requestQty && !pickupText) {
      continue;
    }

    const { supplierPrefix, supplierSuffix } = extractProductName(supplierProductName);
    const optionMatch = optionCell.match(/\[([^\]]+)\]/);
    const optionText = optionMatch ? optionMatch[1] : optionCell.replace(/^\[|\]$/g, "");
    const { color, size } = extractOptionParts(optionText);
    const isPickup = pickupText.includes("誘몄넚?쎌뾽");

    if (originalQty > 0) {
      rows.push({
        A: supplierPrefix,
        B: supplierSuffix,
        C: normalCostFormula,
        D: color,
        E: size,
        F: String(originalQty),
        G: date,
        H: "",
      });
    }

    if (requestQty > 0) {
      rows.push({
        A: supplierPrefix,
        B: supplierSuffix,
        C: isPickup ? "誘몄넚?쎌뾽" : normalCostFormula,
        D: color,
        E: size,
        F: String(requestQty),
        G: date,
        H: isPickup ? "誘몄넚?쎌뾽" : "誘몄넚",
      });
    }
  }

  if (rows.length > 0) {
    rows.pop();
  }

  return rows;
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const ta = document.createElement("textarea");
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  ta.remove();
}

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
  const [excelSlipFile, setExcelSlipFile] = useState(null);
  const [excelSlipRows, setExcelSlipRows] = useState([]);
  const [excelSlipOutput, setExcelSlipOutput] = useState("");

  // 불량출력
  const [bulyangFile, setBulyangFile] = useState(null);
  const [bulyangSessionId, setBulyangSessionId] = useState(null);
  const [bulyangGroups, setBulyangGroups] = useState([]);
  const [bulyangIndex, setBulyangIndex] = useState(0);
  const [bulyangImgData, setBulyangImgData] = useState(null); // {src, guides}
  const [bulyangRenderedLayout, setBulyangRenderedLayout] = useState(null);
  const [bulyangLayout, setBulyangLayout] = useState({
    title: "벨류스",
    footer_text: "매입 부탁드립니다!",
    page_w_mm: 126.0, page_h_mm: 103.0,
    top_mm: 4.5, side_mm: 15.0,
    title_size_mm: 14.0, title_gap_mm: 2.5, title_line_thick_mm: 0.5,
    addr_v_size_mm: 7.0, vname_v_size_mm: 7.0,
    addr_wrap_chars: 28, info_gap_below_line_mm: 6.0, info_extra_gap_mm: 0.0,
    show_table_header: false,
    header_size_mm: 8.2, row_size_mm: 4.0, row_h_mm: 6.2,
    row_padding_mm: 6.8, row_line_factor: 0.0, two_row_extra_gap_mm: 0.0,
    col_gap_mm: 3.0, table_top_offset_mm: 19.76,
    name_ratio: 0.62, color_ratio: 0.23, qty_ratio: 0.15,
    bottom_mm: 10.0, footer_size_mm: 5.6,
    footer_show_date: true, footer_date_format: "%Y-%m-%d",
  });
  const bulyangLayoutRef = useRef(bulyangLayout);
  const bulyangSessionRef = useRef({ id: null, index: 0 });
  const bulyangDragRef = useRef(null);
  const bulyangPreviewRef = useRef(null);
  useEffect(() => { bulyangLayoutRef.current = bulyangLayout; }, [bulyangLayout]);
  useEffect(() => { bulyangSessionRef.current = { id: bulyangSessionId, index: bulyangIndex }; }, [bulyangSessionId, bulyangIndex]);

  useEffect(() => {
    const raw = localStorage.getItem("noye-kimsungil-bulyang-handoff");
    if (!raw) return;
    let handoff = null;
    try {
      handoff = JSON.parse(raw);
    } catch {
      localStorage.removeItem("noye-kimsungil-bulyang-handoff");
      return;
    }
    localStorage.removeItem("noye-kimsungil-bulyang-handoff");
    if (!handoff?.session_id) return;

    const applyHandoff = async () => {
      try {
        setActiveTab("bulyang");
        setLoading(true);
        const res = await fetch(`${API}/noye-kimsungil/bulyang/session/${handoff.session_id}`, {
          headers: getAuthHeaders(),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.detail || "불량출력 세션 불러오기 실패");
        setBulyangFile(null);
        setBulyangSessionId(data.session_id);
        setBulyangGroups(data.groups || []);
        setBulyangIndex(0);
        setMessage(`불량출력 데이터 연결 완료: ${data.total}개 거래처`);
        if ((data.total || 0) > 0) {
          await fetchBulyangPreview(data.session_id, 0, bulyangLayoutRef.current);
        }
      } catch (err) {
        setMessage(err.message || "불량출력 세션 불러오기 실패");
      } finally {
        setLoading(false);
      }
    };
    applyHandoff();
  }, []);

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

  const runExcelSlipConvert = () => {
    if (!excelSlipFile) {
      setMessage("가공할 엑셀 파일을 먼저 선택하세요.");
      return;
    }

    setLoading(true);
    setMessage("");
    (async () => {
      try {
        const XLSX = await import("xlsx");
        const arrayBuffer = await excelSlipFile.arrayBuffer();
        const workbook = XLSX.read(arrayBuffer, { type: "array" });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rawData = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
        const rows = convertCurrentReceiptExcelRowsSplitV2(rawData);

        if (!rows.length) {
          setExcelSlipRows([]);
          setExcelSlipOutput("");
          setMessage("변환 가능한 행을 찾지 못했습니다.");
          return;
        }

        setExcelSlipRows(rows);
        setExcelSlipOutput(rowsToTsv(rows));
        setMessage(`엑셀 변환 완료: ${rows.length}건`);
      } catch (err) {
        setMessage(err.message || "엑셀 변환에 실패했습니다.");
      } finally {
        setLoading(false);
      }
    })();
  };

  const copyExcelSlipResult = async () => {
    if (!excelSlipOutput) {
      setMessage("\ubcc0\ud658 \uacb0\uacfc\uac00 \uc5c6\uc2b5\ub2c8\ub2e4.");
      return;
    }

    setLoading(true);
    setMessage("");
    try {
      await copyText(excelSlipOutput);
      setMessage(`\uacb0\uacfc \ubcf5\uc0ac \uc644\ub8cc: ${excelSlipRows.length}\uac74`);
    } catch (err) {
      setMessage(err.message || "\uacb0\uacfc \ubcf5\uc0ac\uc5d0 \uc2e4\ud328\ud588\uc2b5\ub2c8\ub2e4.");
    } finally {
      setLoading(false);
    }
  };

  const setLayout = (key, val) => setBulyangLayout((prev) => ({ ...prev, [key]: val }));

  const fetchBulyangPreview = async (sessionId, index, layout) => {
    try {
      const res = await fetch(
        `${API}/noye-kimsungil/bulyang/image/${sessionId}/${index}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", ...getAuthHeaders() },
          body: JSON.stringify({ ...layout, dpi: 150 }),
        }
      );
      if (!res.ok) throw new Error("이미지 불러오기 실패");
      const data = await res.json();
      setBulyangImgData({ src: `data:image/png;base64,${data.image_b64}`, guides: data.guides });
      setBulyangRenderedLayout({ ...layout });
    } catch (err) {
      setMessage(err.message || "이미지 불러오기 실패");
    }
  };

  const uploadBulyang = async () => {
    if (!bulyangFile) { setMessage("엑셀 파일을 선택하세요."); return; }
    setLoading(true);
    setMessage("");
    try {
      const formData = new FormData();
      formData.append("file", bulyangFile);
      const res = await fetch(`${API}/noye-kimsungil/bulyang/upload`, {
        method: "POST",
        headers: getAuthHeaders(),
        body: formData,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "업로드 실패");
      setBulyangSessionId(data.session_id);
      setBulyangGroups(data.groups || []);
      setBulyangIndex(0);
      setMessage(`업로드 완료: ${data.total}개 거래처`);
      if (data.total > 0) await fetchBulyangPreview(data.session_id, 0, bulyangLayoutRef.current);
    } catch (err) {
      setMessage(err.message || "업로드 실패");
    } finally {
      setLoading(false);
    }
  };

  const moveBulyang = async (nextIndex) => {
    if (!bulyangSessionId || nextIndex < 0 || nextIndex >= bulyangGroups.length) return;
    setBulyangIndex(nextIndex);
    await fetchBulyangPreview(bulyangSessionId, nextIndex, bulyangLayoutRef.current);
  };

  const refreshBulyangPreview = async () => {
    const { id, index } = bulyangSessionRef.current;
    if (!id) return;
    await fetchBulyangPreview(id, index, bulyangLayoutRef.current);
  };

  const downloadBulyangZip = async () => {
    if (!bulyangSessionId) { setMessage("먼저 엑셀을 업로드하세요."); return; }
    setLoading(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/noye-kimsungil/bulyang/export/${bulyangSessionId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify(bulyangLayoutRef.current),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.detail || "ZIP 다운로드 실패");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url; link.download = "거래처라벨.zip";
      document.body.appendChild(link); link.click(); link.remove();
      URL.revokeObjectURL(url);
      setMessage(`ZIP 다운로드 완료 (${bulyangGroups.length}개)`);
    } catch (err) {
      setMessage(err.message || "ZIP 다운로드 실패");
    } finally {
      setLoading(false);
    }
  };

  const openPrintWindow = (images, layout) => {
    const { page_w_mm, page_h_mm } = layout;
    const html = `<!DOCTYPE html><html><head><style>
      @page { size: ${page_w_mm}mm ${page_h_mm}mm; margin: 0; }
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body { background: white; }
      .page { width: ${page_w_mm}mm; height: ${page_h_mm}mm; page-break-after: always; overflow: hidden; }
      .page:last-child { page-break-after: avoid; }
      img { width: 100%; height: 100%; display: block; }
    </style></head><body>
      ${images.map((src) => `<div class="page"><img src="${src}" /></div>`).join("")}
      <script>window.addEventListener("load", () => { window.print(); });<\/script>
    </body></html>`;
    const w = window.open("", "_blank");
    if (!w) { setMessage("팝업이 차단됐습니다. 팝업 허용 후 다시 시도하세요."); return; }
    w.document.open();
    w.document.write(html);
    w.document.close();
  };

  const printCurrentBulyang = () => {
    if (!bulyangImgData) return;
    openPrintWindow([bulyangImgData.src], bulyangLayoutRef.current);
  };

  const printAllBulyang = async () => {
    if (!bulyangSessionId) { setMessage("먼저 엑셀을 업로드하세요."); return; }
    setLoading(true);
    setMessage("전체 인쇄 준비 중...");
    try {
      const layout = bulyangLayoutRef.current;
      const srcs = [];
      for (let i = 0; i < bulyangGroups.length; i++) {
        const res = await fetch(
          `${API}/noye-kimsungil/bulyang/image/${bulyangSessionId}/${i}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", ...getAuthHeaders() },
            body: JSON.stringify({ ...layout, dpi: 150 }),
          }
        );
        if (!res.ok) continue;
        const data = await res.json();
        srcs.push(`data:image/png;base64,${data.image_b64}`);
      }
      if (!srcs.length) { setMessage("인쇄할 이미지가 없습니다."); return; }
      openPrintWindow(srcs, layout);
      setMessage(`인쇄 창 열림 (${srcs.length}장)`);
    } catch (err) {
      setMessage(err.message || "인쇄 준비 실패");
    } finally {
      setLoading(false);
    }
  };

  // 드래그 핸들러 (표 시작 오프셋, 열 비율)
  const onBulyangGuideDown = (e, guideType) => {
    e.preventDefault();
    e.stopPropagation();
    if (!bulyangPreviewRef.current || !bulyangImgData) return;
    const rect = bulyangPreviewRef.current.getBoundingClientRect();
    const scale = rect.width / bulyangImgData.guides.img_w;
    bulyangDragRef.current = {
      type: guideType,
      startX: e.clientX,
      startY: e.clientY,
      scale,
      startLayout: { ...bulyangLayoutRef.current },
    };

    const onMove = (e) => {
      const drag = bulyangDragRef.current;
      if (!drag) return;
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      const dxi = dx / drag.scale;
      const dyi = dy / drag.scale;
      const DPI = 150;
      const mm2px = (mm) => Math.max(1, (mm / 25.4) * DPI);
      const px2mm = (px) => (px * 25.4) / DPI;
      const sl = drag.startLayout;

      if (drag.type === "table_y") {
        const newMm = Math.max(0, sl.table_top_offset_mm + px2mm(dyi));
        setBulyangLayout((prev) => ({ ...prev, table_top_offset_mm: Math.round(newMm * 100) / 100 }));
      } else {
        const W = mm2px(sl.page_w_mm);
        const leftPx = mm2px(sl.side_mm);
        const usableW = W - leftPx * 2;
        const gap = mm2px(sl.col_gap_mm);
        const total = sl.name_ratio + sl.color_ratio + sl.qty_ratio;
        const nameR = sl.name_ratio / total;
        const colorR = sl.color_ratio / total;
        const qtyR = sl.qty_ratio / total;
        const nameW = usableW * nameR;
        const colorW = usableW * colorR;

        if (drag.type === "x_color") {
          const newNameW = Math.max(usableW * 0.05, Math.min(usableW * 0.9, nameW + dxi));
          const newNameR = newNameW / usableW;
          const remain = 1 - newNameR;
          const origRem = colorR + qtyR;
          setBulyangLayout((prev) => ({
            ...prev,
            name_ratio: Math.round(newNameR * 1000) / 1000,
            color_ratio: Math.round((origRem > 0 ? (remain * colorR) / origRem : remain * 0.6) * 1000) / 1000,
            qty_ratio: Math.round((origRem > 0 ? (remain * qtyR) / origRem : remain * 0.4) * 1000) / 1000,
          }));
        } else {
          const newColorW = Math.max(usableW * 0.05, Math.min(usableW * 0.9 - nameW, colorW + dxi));
          const newColorR = newColorW / usableW;
          const newQtyR = Math.max(0.05, 1 - nameR - newColorR);
          setBulyangLayout((prev) => ({
            ...prev,
            color_ratio: Math.round(newColorR * 1000) / 1000,
            qty_ratio: Math.round(newQtyR * 1000) / 1000,
          }));
        }
      }
    };

    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      bulyangDragRef.current = null;
      const { id, index } = bulyangSessionRef.current;
      if (id) fetchBulyangPreview(id, index, bulyangLayoutRef.current);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // 미리보기 위의 SVG 가이드 위치 계산 (이미지 픽셀 좌표, viewBox로 자동 스케일)
  const getBulyangGuides = () => {
    if (!bulyangImgData || !bulyangRenderedLayout) return null;
    const { guides } = bulyangImgData;
    const DPI = 150;
    const mm2px = (mm) => Math.max(1, (mm / 25.4) * DPI);
    const L = bulyangLayoutRef.current;
    const W = mm2px(L.page_w_mm);
    const leftPx = mm2px(L.side_mm);
    const usableW = W - leftPx * 2;
    const gap = mm2px(L.col_gap_mm);
    const total = Math.max(1e-6, L.name_ratio + L.color_ratio + L.qty_ratio);
    const nameW = Math.floor(usableW * (L.name_ratio / total));
    const colorW = Math.floor(usableW * (L.color_ratio / total));
    const xColor = leftPx + nameW + gap;
    const xQty = xColor + colorW + gap;
    // table_y: base + offset delta relative to rendered layout
    const deltaOffsetMm = L.table_top_offset_mm - bulyangRenderedLayout.table_top_offset_mm;
    const tableY = guides.table_y + (deltaOffsetMm / 25.4) * DPI;
    return { xColor, xQty, tableY, imgW: guides.img_w, imgH: guides.img_h };
  };

  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <div className={styles.headerText}>
          <h2 className={styles.title}>노예김승일</h2>
          <p className={styles.subtitle}>케이디지가공2 · 날짜별장끼정리 · 신상 업로드 · 오늘출발 · 입고전표 엑셀전환 · 불량출력</p>
        </div>
      </div>

      <div className={styles.tabRow}>
        {[
          { key: "kdg",           label: "케이디지가공2",           icon: <Shuffle size={13} /> },
          { key: "date-chunk",    label: "날짜별장끼정리",          icon: <Calendar size={13} /> },
          { key: "janggi",        label: "신상 업로드 날짜별 시트2", icon: <Table2 size={13} /> },
          { key: "today",         label: "오늘출발",                icon: <Zap size={13} /> },
          { key: "receipt-excel", label: "입고전표 엑셀전환",        icon: <FileSpreadsheet size={13} /> },
          { key: "bulyang",       label: "불량출력",                icon: <Printer size={13} /> },
        ].map(({ key, label, icon }) => (
          <button
            key={key}
            className={`${styles.tabBtn} ${activeTab === key ? styles.tabActive : ""}`}
            onClick={() => setActiveTab(key)}
          >
            {icon}{label}
          </button>
        ))}
      </div>

      {activeTab === "kdg" && (
        <>
          <section className={styles.card}>
            <div className={styles.cardHeader}>
              <div className={styles.cardTitleRow}>
                <div className={`${styles.cardIcon} ${styles.cardIconBlue}`}><Shuffle size={15} /></div>
                <h3 className={styles.cardTitle}>케이디지가공2</h3>
              </div>
            </div>
            <textarea
              className={styles.scanInput}
              style={{ minHeight: 220 }}
              value={kdgText}
              onChange={(e) => setKdgText(e.target.value)}
              placeholder="원본 텍스트를 그대로 붙여넣으세요"
            />
            <div className={styles.uploadRow}>
              <button className={styles.primaryBtn} onClick={runKdgConvert} disabled={loading}>
                <Shuffle size={14} />변환
              </button>
              <button className={styles.secondaryBtn} onClick={runKdgMatch} disabled={loading}>
                <Zap size={13} />이지어드민 변환(원베 매칭)
              </button>
              <button className={styles.secondaryBtn} onClick={downloadKdgXls} disabled={loading}>
                <ArrowDownToLine size={13} />XLS 저장(A=원베,B=옵션)
              </button>
              <button className={styles.secondaryBtn} onClick={copyKdgDate} disabled={loading}>
                <Clipboard size={13} />날짜별 복사
              </button>
            </div>
            <div className={styles.uploadRow}>
              <label className={styles.fileInput}>
                <input type="file" accept=".xls,.xlsx,.xlsm" onChange={(e) => setBaseFile(e.target.files?.[0] ?? null)} />
                <FileSpreadsheet size={14} />케이디지 원가베이스 선택
              </label>
              <button className={styles.secondaryBtn} onClick={uploadBase} disabled={loading}>
                <ArrowDownToLine size={13} style={{ rotate: "180deg" }} />원가베이스 업로드
              </button>
              <button className={styles.secondaryBtn} onClick={downloadBase} disabled={loading}>
                <ArrowDownToLine size={13} />원가베이스 다운로드
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
              <div className={styles.cardTitleRow}>
                <div className={`${styles.cardIcon} ${styles.cardIconSlate}`}><Table2 size={15} /></div>
                <h3 className={styles.cardTitle}>결과</h3>
              </div>
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
            <div className={styles.cardTitleRow}>
              <div className={`${styles.cardIcon} ${styles.cardIconAmber}`}><Calendar size={15} /></div>
              <h3 className={styles.cardTitle}>날짜별장끼정리</h3>
            </div>
          </div>
          <div className={styles.uploadRow}>
            <label className={styles.fileInput}>
              <input type="file" accept=".xlsx,.xls,.xlsm" onChange={(e) => setChunkFile(e.target.files?.[0] ?? null)} />
              <FileSpreadsheet size={14} />{chunkFile ? chunkFile.name : "가공할 엑셀 선택"}
            </label>
            <button className={styles.primaryBtn} onClick={copyDateChunk} disabled={loading}>
              <Clipboard size={14} />가공 후 복사
            </button>
          </div>
          <div className={styles.statusMsg}>
            <strong>동작:</strong> 재고부족요청 엑셀 넣으면 날짜별장끼정리 시트1 양식으로 가공
          </div>
        </section>
      )}

      {activeTab === "today" && (
        <>
          <section className={styles.card}>
            <div className={styles.cardHeader}>
              <div className={styles.cardTitleRow}>
                <div className={`${styles.cardIcon} ${styles.cardIconGreen}`}><Zap size={15} /></div>
                <h3 className={styles.cardTitle}>오늘출발</h3>
              </div>
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
                <FileSpreadsheet size={14} />{todayFile ? todayFile.name : "XLS 파일 선택"}
              </label>
              <button className={styles.primaryBtn} onClick={processTodayFile} disabled={loading}>
                <Zap size={14} />가공
              </button>
              <button className={styles.secondaryBtn} onClick={downloadTodayFile} disabled={loading || !todayRows.length}>
                <ArrowDownToLine size={13} />다운로드
              </button>
              <button className={styles.secondaryBtn} onClick={copyTodayFile} disabled={loading || !todayRows.length}>
                <Clipboard size={13} />엑셀 복사
              </button>
            </div>
            <div className={styles.statusMsg}>
              <strong>설명:</strong> 이지어드민 현재고조회 다운로드항목4 파일 넣기
            </div>
          </section>

          {todayRows.length > 0 && (
            <section className={styles.card}>
              <div className={styles.cardHeader}>
                <div className={styles.cardTitleRow}>
                  <div className={`${styles.cardIcon} ${styles.cardIconSlate}`}><Table2 size={15} /></div>
                  <h3 className={styles.cardTitle}>가공 결과</h3>
                </div>
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
              <div className={styles.cardTitleRow}>
                <div className={`${styles.cardIcon} ${styles.cardIconPurple}`}><Table2 size={15} /></div>
                <h3 className={styles.cardTitle}>신상 업로드 날짜별 시트2</h3>
              </div>
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
                <FileSpreadsheet size={14} />{janggiFile ? janggiFile.name : "XLS 파일 선택"}
              </label>
              <button className={styles.primaryBtn} onClick={processJanggi} disabled={loading}>
                <Zap size={14} />가공
              </button>
              <button className={styles.secondaryBtn} onClick={downloadJanggi} disabled={loading || !janggiRows.length}>
                <ArrowDownToLine size={13} />다운로드
              </button>
              <button className={styles.secondaryBtn} onClick={copyJanggi} disabled={loading || !janggiRows.length}>
                <Clipboard size={13} />엑셀 복사
              </button>
            </div>
            <div className={styles.statusMsg}>
              <strong>설명:</strong> 현재고조회 다운로드항목4 신상 다운로드 후 버튼 누르면 날짜별 시트2 양식으로 가공
            </div>
          </section>

          {janggiRows.length > 0 && (
            <section className={styles.card}>
              <div className={styles.cardHeader}>
                <div className={styles.cardTitleRow}>
                  <div className={`${styles.cardIcon} ${styles.cardIconSlate}`}><Table2 size={15} /></div>
                  <h3 className={styles.cardTitle}>가공 결과</h3>
                </div>
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

      {activeTab === "receipt-excel" && (
        <>
          <section className={styles.card}>
            <div className={styles.cardHeader}>
              <div className={styles.cardTitleRow}>
                <div className={`${styles.cardIcon} ${styles.cardIconBlue}`}><FileSpreadsheet size={15} /></div>
                <h3 className={styles.cardTitle}>입고전표 엑셀전환</h3>
              </div>
              <span className={styles.pill}>{excelSlipRows.length}건</span>
            </div>
            <div className={styles.statusMsg}>
              원본 엑셀 1행은 헤더로 건너뛰고, A열 공급처 상품명은 첫 띄어쓰기 기준으로 A/B, B열 옵션은 D/E, F열은 원본 C열로 옮깁니다. 원본 D열이 0 초과면 H열에 미송, 원본 E열에 미송픽업이 있으면 C/H열에 미송픽업을 넣습니다.
            </div>
            <div className={styles.uploadRow}>
              <label className={styles.fileInput}>
                <input
                  type="file"
                  accept=".xls,.xlsx,.xlsm"
                  onChange={(e) => {
                    setExcelSlipFile(e.target.files?.[0] ?? null);
                    setExcelSlipRows([]);
                    setExcelSlipOutput("");
                    setMessage("");
                  }}
                />
                <FileSpreadsheet size={14} />{excelSlipFile ? excelSlipFile.name : "입고전표 엑셀 선택"}
              </label>
              <button className={styles.primaryBtn} onClick={runExcelSlipConvert} disabled={loading}>
                <Zap size={14} />엑셀 변환
              </button>
              <button
                className={styles.secondaryBtn}
                onClick={() => {
                  setExcelSlipFile(null);
                  setExcelSlipRows([]);
                  setExcelSlipOutput("");
                  setMessage("");
                }}
                disabled={loading}
              >
                <X size={13} />초기화
              </button>
            </div>
          </section>

          <section className={styles.card}>
            <div className={styles.cardHeader}>
              <div className={styles.cardTitleRow}>
                <div className={`${styles.cardIcon} ${styles.cardIconSlate}`}><Clipboard size={15} /></div>
                <h3 className={styles.cardTitle}>TSV</h3>
              </div>
            </div>
            <textarea
              className={styles.scanInput}
              style={{ minHeight: 220, width: "100%", fontSize: "0.95rem" }}
              value={excelSlipOutput}
              onChange={(e) => setExcelSlipOutput(e.target.value)}
              placeholder="변환 결과가 여기에 표시됩니다."
            />
            <div className={styles.uploadRow}>
              <button className={styles.secondaryBtn} onClick={copyExcelSlipResult} disabled={loading || !excelSlipOutput}>
                <Clipboard size={13} />결과 복사
              </button>
            </div>
          </section>

          {excelSlipRows.length > 0 && (
            <section className={styles.card}>
              <div className={styles.cardHeader}>
                <div className={styles.cardTitleRow}>
                  <div className={`${styles.cardIcon} ${styles.cardIconSlate}`}><Table2 size={15} /></div>
                  <h3 className={styles.cardTitle}>미리보기</h3>
                </div>
              </div>
              <div className={`${styles.tableWrap} ${styles.registeredTableWrap}`}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>A</th>
                      <th>B</th>
                      <th>C</th>
                      <th>D</th>
                      <th>E</th>
                      <th>F</th>
                      <th>G</th>
                      <th>H</th>
                    </tr>
                  </thead>
                  <tbody>
                    {excelSlipRows.map((row, index) => (
                      <tr key={`${row.A}-${row.B}-${index}`}>
                        <td>{row.A}</td>
                        <td>{row.B}</td>
                        <td>{row.C}</td>
                        <td>{row.D}</td>
                        <td>{row.E}</td>
                        <td>{row.F}</td>
                        <td>{row.G}</td>
                        <td>{row.H}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}

      {activeTab === "bulyang" && (() => {
        const guides = getBulyangGuides();
        const iStyle = { padding: "3px 7px", border: "1px solid var(--border-color)", borderRadius: 4, background: "var(--bg-secondary)", color: "var(--text-primary)", fontSize: "0.82rem", width: 80 };
        return (
          <>
            {/* ── 업로드 & 설정 ── */}
            <section className={styles.card}>
              <div className={styles.cardHeader}>
                <div className={styles.cardTitleRow}>
                  <div className={`${styles.cardIcon} ${styles.cardIconBlue}`}><Printer size={15} /></div>
                  <h3 className={styles.cardTitle}>불량출력</h3>
                </div>
                {bulyangGroups.length > 0 && <span className={styles.pill}>{bulyangGroups.length}개 거래처</span>}
              </div>
              <div className={styles.statusMsg}>
                <strong>엑셀:</strong> A=거래처명 &nbsp;B=상품명 &nbsp;C=색상 &nbsp;D=수량 &nbsp;E=주소 &nbsp;(헤더 없음)
              </div>
              <div className={styles.uploadRow}>
                <label className={styles.fileInput}>
                  <input type="file" accept=".xlsx,.xls,.xlsm" onChange={(e) => {
                    setBulyangFile(e.target.files?.[0] ?? null);
                    setBulyangSessionId(null); setBulyangGroups([]); setBulyangIndex(0); setBulyangImgData(null);
                  }} />
                  <FileSpreadsheet size={14} />{bulyangFile ? bulyangFile.name : "엑셀 파일 선택"}
                </label>
                <button className={styles.primaryBtn} onClick={uploadBulyang} disabled={loading}>
                  <ArrowDownToLine size={14} style={{ rotate: "180deg" }} />업로드
                </button>
                <button className={styles.secondaryBtn} onClick={refreshBulyangPreview} disabled={loading || !bulyangSessionId}>
                  <RefreshCw size={13} />미리보기 갱신
                </button>
                <button className={styles.secondaryBtn} onClick={downloadBulyangZip} disabled={loading || !bulyangSessionId}>
                  <ArrowDownToLine size={13} />전체 ZIP 저장
                </button>
                <button className={styles.secondaryBtn} onClick={printCurrentBulyang} disabled={loading || !bulyangImgData}>
                  <Printer size={13} />현재 인쇄
                </button>
                <button className={styles.secondaryBtn} onClick={printAllBulyang} disabled={loading || !bulyangSessionId}>
                  <Printer size={13} />전체 인쇄
                </button>
              </div>

              {/* 설정: 제목·문구·2개 스피너 */}
              <div style={{ display: "flex", flexWrap: "wrap", gap: "0.6rem 1.4rem", alignItems: "flex-end" }}>
                {[
                  { label: "제목", key: "title", type: "text", w: 120 },
                  { label: "하단 우측 문구", key: "footer_text", type: "text", w: 160 },
                ].map(({ label, key, type, w }) => (
                  <label key={key} style={{ fontSize: "0.82rem", display: "flex", flexDirection: "column", gap: 2 }}>
                    <span style={{ fontWeight: 600, color: "var(--text-secondary)" }}>{label}</span>
                    <input type={type} style={{ ...iStyle, width: w }}
                      value={bulyangLayout[key]}
                      onChange={(e) => setLayout(key, e.target.value)} />
                  </label>
                ))}
                <label style={{ fontSize: "0.82rem", display: "flex", flexDirection: "column", gap: 2 }}>
                  <span style={{ fontWeight: 600, color: "var(--text-secondary)" }}>거래처명 글자(mm)</span>
                  <input type="number" step={0.2} min={2} style={iStyle}
                    value={bulyangLayout.vname_v_size_mm}
                    onChange={(e) => setLayout("vname_v_size_mm", Number(e.target.value))} />
                </label>
                <label style={{ fontSize: "0.82rem", display: "flex", flexDirection: "column", gap: 2 }}>
                  <span style={{ fontWeight: 600, color: "var(--text-secondary)" }}>각주 글자(mm)</span>
                  <input type="number" step={0.2} min={2} style={iStyle}
                    value={bulyangLayout.footer_size_mm}
                    onChange={(e) => setLayout("footer_size_mm", Number(e.target.value))} />
                </label>
              </div>
            </section>

            {/* ── 미리보기 + 드래그 가이드 ── */}
            {bulyangSessionId && bulyangGroups.length > 0 && (
              <section className={styles.card}>
                <div className={styles.cardHeader}>
                  <div className={styles.cardTitleRow}>
                    <div className={`${styles.cardIcon} ${styles.cardIconSlate}`}><Printer size={15} /></div>
                    <h3 className={styles.cardTitle}>{bulyangGroups[bulyangIndex]?.vendor || "(거래처명 없음)"}</h3>
                  </div>
                  <span className={styles.pill}>{bulyangIndex + 1} / {bulyangGroups.length}</span>
                </div>

                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <button className={styles.secondaryBtn} onClick={() => moveBulyang(bulyangIndex - 1)} disabled={loading || bulyangIndex === 0}>◀ 이전</button>
                  <select
                    style={{ fontSize: "0.82rem", padding: "4px 7px", flex: 1, maxWidth: 520, border: "1px solid var(--border-color)", borderRadius: 4, background: "var(--bg-secondary)", color: "var(--text-primary)" }}
                    value={bulyangIndex}
                    onChange={(e) => moveBulyang(Number(e.target.value))}
                  >
                    {bulyangGroups.map((g, i) => (
                      <option key={i} value={i}>{i + 1}. {g.vendor || "(거래처명 없음)"} | {(g.addr || "").slice(0, 40)}</option>
                    ))}
                  </select>
                  <button className={styles.secondaryBtn} onClick={() => moveBulyang(bulyangIndex + 1)} disabled={loading || bulyangIndex >= bulyangGroups.length - 1}>다음 ▶</button>
                </div>

                {bulyangImgData && (
                  <div ref={bulyangPreviewRef} style={{ position: "relative", display: "inline-block", width: "min(560px, 100%)", background: "#f5f5f5", borderRadius: 6, padding: 10 }}>
                    <img
                      src={bulyangImgData.src}
                      alt="라벨 미리보기"
                      style={{ display: "block", width: "100%", border: "1px solid #ddd", borderRadius: 4 }}
                    />
                    {guides && (
                      <svg
                        viewBox={`0 0 ${guides.imgW} ${guides.imgH}`}
                        style={{ position: "absolute", inset: 10, width: "calc(100% - 20px)", height: "calc(100% - 20px)", overflow: "visible", pointerEvents: "none" }}
                      >
                        {/* 색상 열 구분선 (녹색) */}
                        <g style={{ pointerEvents: "all", cursor: "ew-resize" }}
                          onMouseDown={(e) => onBulyangGuideDown(e, "x_color")}>
                          <line x1={guides.xColor} y1={0} x2={guides.xColor} y2={guides.imgH} stroke="transparent" strokeWidth={14} />
                          <line x1={guides.xColor} y1={0} x2={guides.xColor} y2={guides.imgH} stroke="#22a" strokeWidth={2} strokeDasharray="6 3" />
                          <text x={guides.xColor + 4} y={20} fill="#22a" fontSize={18} fontFamily="sans-serif">색상 열</text>
                        </g>
                        {/* 수량 열 구분선 (보라) */}
                        <g style={{ pointerEvents: "all", cursor: "ew-resize" }}
                          onMouseDown={(e) => onBulyangGuideDown(e, "x_qty")}>
                          <line x1={guides.xQty} y1={0} x2={guides.xQty} y2={guides.imgH} stroke="transparent" strokeWidth={14} />
                          <line x1={guides.xQty} y1={0} x2={guides.xQty} y2={guides.imgH} stroke="#a27" strokeWidth={2} strokeDasharray="6 3" />
                          <text x={guides.xQty + 4} y={42} fill="#a27" fontSize={18} fontFamily="sans-serif">수량 열</text>
                        </g>
                        {/* 표 시작 가로선 (파랑) */}
                        <g style={{ pointerEvents: "all", cursor: "ns-resize" }}
                          onMouseDown={(e) => onBulyangGuideDown(e, "table_y")}>
                          <line x1={0} y1={guides.tableY} x2={guides.imgW} y2={guides.tableY} stroke="transparent" strokeWidth={14} />
                          <line x1={0} y1={guides.tableY} x2={guides.imgW} y2={guides.tableY} stroke="#27a" strokeWidth={2} strokeDasharray="6 3" />
                          <text x={10} y={guides.tableY - 6} fill="#27a" fontSize={18} fontFamily="sans-serif">표 시작 (offset: {bulyangLayout.table_top_offset_mm}mm)</text>
                        </g>
                      </svg>
                    )}
                  </div>
                )}

                <div className={styles.statusMsg}>
                  <strong>주소:</strong> {bulyangGroups[bulyangIndex]?.addr || "-"} &nbsp;|&nbsp;
                  <strong>상품 수:</strong> {bulyangGroups[bulyangIndex]?.item_count ?? "-"} &nbsp;|&nbsp;
                  <strong>열 비율:</strong> {bulyangLayout.name_ratio.toFixed(2)} / {bulyangLayout.color_ratio.toFixed(2)} / {bulyangLayout.qty_ratio.toFixed(2)}
                </div>
              </section>
            )}
          </>
        );
      })()}

      {message && (
        <div className={`${styles.statusMsg} ${message.includes("실패") || message.includes("없습니다") || message.includes("선택하세요") ? styles.statusMsgError : styles.statusMsgSuccess}`}>
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
                  <RefreshCw size={13} />새로고침
                </button>
                <button className={styles.primaryBtn} onClick={commitBaseEdits} disabled={loading}>
                  변경 적용
                </button>
                <button className={styles.secondaryBtn} onClick={() => setShowBaseEditor(false)}>
                  <X size={13} />닫기
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
