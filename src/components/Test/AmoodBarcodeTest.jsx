import React, { useCallback, useEffect, useRef, useState } from "react";
import * as XLSX from "xlsx";
import JsBarcode from "jsbarcode";
import styles from "./AmoodBarcodeTest.module.css";
import { Upload, Printer, X, AlertCircle, Settings2, Tag } from "lucide-react";
import { COLLAB_API_BASE, LOCAL_API_BASE as API, getAuthHeaders } from "../../lib/api";

// ── 기본값 ────────────────────────────────────────────────────────────────
const DEFAULT_SIZES = {
    titleSize: 7,
    descSize: 6,
    barcodeHeight: 32,
    barcodeWidth: 1.2,
    btextSize: 6,
    cardPaddingV: 2,
    cardPaddingH: 3,
};

const DEFAULT_GAPS = { title: 1, desc: 2, barcode: 1, btext: 0 };

// ── BarcodeItem ───────────────────────────────────────────────────────────
const FIXED_ORDER = ["title", "desc", "barcode", "btext"];

const BarcodeItem = ({ item, sizes, gaps }) => {
    const order = FIXED_ORDER;
    const svgRef = useRef(null);
    const errRef = useRef(null);

    useEffect(() => {
        const svg = svgRef.current;
        const err = errRef.current;
        if (!svg || !err) return;
        if (!item.barcodeText) {
            svg.style.display = "none";
            err.style.display = "flex";
            return;
        }
        try {
            JsBarcode(svg, String(item.barcodeText), {
                format: "CODE128",
                width: sizes.barcodeWidth,
                height: sizes.barcodeHeight,
                displayValue: false,
                margin: 0,
            });
            svg.style.display = "block";
            err.style.display = "none";
        } catch {
            svg.style.display = "none";
            err.style.display = "flex";
        }
    }, [item.barcodeText, sizes.barcodeHeight, sizes.barcodeWidth]);

    const cardStyle = {
        padding: `${sizes.cardPaddingV}px ${sizes.cardPaddingH}px`,
    };

    const renderEl = (key, isLast) => {
        const mb = isLast ? 0 : (gaps[key] ?? 0);
        const style = { marginBottom: mb };
        switch (key) {
            case "title":
                return (
                    <div key="title" className={styles.cardTitle}
                        style={{ fontSize: `${sizes.titleSize}pt`, ...style }} data-title data-key="title">
                        {item.title || "(제목 없음)"}
                    </div>
                );
            case "desc":
                return item.description ? (
                    <div key="desc" className={styles.cardDesc}
                        style={{ fontSize: `${sizes.descSize}pt`, ...style }} data-desc data-key="desc">
                        {item.description}
                    </div>
                ) : null;
            case "barcode":
                return (
                    <div key="barcode" className={styles.barcodeWrap} style={style} data-key="barcode">
                        <svg ref={svgRef} className={styles.barcodeSvg} />
                        <div ref={errRef} className={styles.barcodeError} style={{ display: "none" }}>
                            <AlertCircle size={12} /> 바코드 생성 실패
                        </div>
                    </div>
                );
            case "btext":
                return (
                    <div key="btext" className={styles.barcodeText}
                        style={{ fontSize: `${sizes.btextSize}pt`, ...style }} data-btext data-key="btext">
                        {item.barcodeText || ""}
                    </div>
                );
            default:
                return null;
        }
    };

    return (
        <div className={styles.card} style={cardStyle} data-card>
            {order.map((key, i) => renderEl(key, i === order.length - 1))}
        </div>
    );
};

// ── SizeRow (슬라이더) ─────────────────────────────────────────────────────
const SizeRow = ({ label, name, value, min, max, step = 1, unit, onChange }) => (
    <div className={styles.sizeRow}>
        <span className={styles.sizeLabel}>{label}</span>
        <input type="range" min={min} max={max} step={step} value={value}
            onChange={(e) => onChange(name, Number(e.target.value))}
            className={styles.sizeSlider} />
        <span className={styles.sizeVal}>{value}{unit}</span>
    </div>
);

// ── GapRow (간격 슬라이더) ─────────────────────────────────────────────────
const GapRow = ({ elKey, label, value, onChange }) => (
    <div className={styles.sizeRow}>
        <span className={styles.sizeLabel}>{label}</span>
        <input type="range" min={0} max={32} step={1} value={value}
            onChange={(e) => onChange(elKey, Number(e.target.value))}
            className={styles.sizeSlider} />
        <span className={styles.sizeVal}>{value}px</span>
    </div>
);

// ── 메인 컴포넌트 ─────────────────────────────────────────────────────────
export default function AmoodBarcodeTest() {
    const [items, setItems]       = useState([]);
    const [fileName, setFileName] = useState("");
    const [error, setError]       = useState("");
    const [fileDragging, setFileDragging] = useState(false);
    const [showSizes, setShowSizes]       = useState(false);
    const [sizes, setSizes]               = useState(DEFAULT_SIZES);
    const [gaps, setGaps]                 = useState(DEFAULT_GAPS);
    const [settingsSaved, setSettingsSaved] = useState(false);
    const [hblLoading, setHblLoading] = useState(false);
    const [hblResult, setHblResult]   = useState(null);

    const fileInputRef  = useRef(null);
    const gridRef       = useRef(null);
    const saveTimerRef  = useRef(null);

    useEffect(() => {
        const raw = localStorage.getItem("amoodBarcodePrintItems");
        if (!raw) return;
        try {
            const payload = JSON.parse(raw);
            const transferredItems = Array.isArray(payload?.items) ? payload.items : [];
            const parsed = transferredItems
                .map((item) => ({
                    title: String(item.title ?? "").trim(),
                    description: String(item.description ?? "").trim(),
                    barcodeText: String(item.barcodeText ?? "").trim(),
                }))
                .filter((item) => item.title || item.description || item.barcodeText);
            if (parsed.length) {
                setItems(parsed);
                setFileName(payload.fileName || "선적바코드_인쇄");
                setError("");
            }
        } catch {
            // ignore malformed transfer data
        } finally {
            localStorage.removeItem("amoodBarcodePrintItems");
        }
    }, []);

    // ── 설정 불러오기 (마운트 시 한 번) ───────────────────────────────────
    useEffect(() => {
        fetch(`${COLLAB_API_BASE}/settings/barcode-label`, { headers: getAuthHeaders() })
            .then((r) => r.ok ? r.json() : null)
            .then((data) => {
                if (!data) return;
                if (data.sizes && Object.keys(data.sizes).length)
                    setSizes((prev) => ({ ...prev, ...data.sizes }));
                if (data.gaps && Object.keys(data.gaps).length)
                    setGaps((prev) => ({ ...prev, ...data.gaps }));
            })
            .catch(() => {});
    }, []);

    // ── 설정 저장 (debounce 800ms) ─────────────────────────────────────────
    const scheduleSave = useCallback((nextSizes, nextGaps) => {
        clearTimeout(saveTimerRef.current);
        setSettingsSaved(false);
        saveTimerRef.current = setTimeout(() => {
            fetch(`${COLLAB_API_BASE}/settings/barcode-label`, {
                method: "PATCH",
                headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
                body: JSON.stringify({ sizes: nextSizes, gaps: nextGaps }),
            })
                .then((r) => r.ok && setSettingsSaved(true))
                .catch(() => {});
        }, 800);
    }, []);

    // ── 크기 변경 ─────────────────────────────────────────────────────────
    const handleSizeChange = (name, value) =>
        setSizes((prev) => {
            const next = { ...prev, [name]: value };
            scheduleSave(next, gaps);
            return next;
        });

    const handleGapChange = (key, value) =>
        setGaps((prev) => {
            const next = { ...prev, [key]: value };
            scheduleSave(sizes, next);
            return next;
        });

    // ── 파일 파싱 ─────────────────────────────────────────────────────────
    const parseFile = (file) => {
        setError("");
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const wb = XLSX.read(e.target.result, { type: "binary" });
                const ws = wb.Sheets[wb.SheetNames[0]];
                const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
                let startRow = 0;
                if (rows.length > 0) {
                    const v = String(rows[0][0] || "").trim().toLowerCase();
                    if (v === "title" || v === "제목") startRow = 1;
                }
                const parsed = rows
                    .slice(startRow)
                    .filter((r) => r.some((v) => v !== "" && v !== null))
                    .map((r) => ({
                        title: String(r[0] ?? "").trim(),
                        description: String(r[1] ?? "").trim(),
                        barcodeText: String(r[2] ?? "").trim(),
                    }));
                if (!parsed.length) {
                    setError("데이터 없음. A열(Title)·B열(Description)·C열(Barcode Text) 형식을 확인하세요.");
                    setItems([]);
                } else {
                    setItems(parsed);
                    setFileName(file.name);
                }
            } catch {
                setError("파일 파싱 실패. xlsx/xls 파일인지 확인하세요.");
                setItems([]);
            }
        };
        reader.readAsBinaryString(file);
    };

    const handleFile = (file) => {
        if (!file) return;
        const ext = file.name.split(".").pop().toLowerCase();
        if (!["xlsx", "xls"].includes(ext)) { setError("xlsx 또는 xls 파일만 업로드 가능합니다."); return; }
        parseFile(file);
    };

    // ── 인쇄 — 화면 카드 DOM을 그대로 복제해서 인쇄창에 출력 ──────────────
    const handlePrint = () => {
        if (!gridRef.current) return;
        const cards = Array.from(gridRef.current.querySelectorAll("[data-card]"));
        if (!cards.length) return;

        // 각 카드의 outerHTML을 그대로 사용 (인라인 스타일 포함)
        const cardsHtml = cards.map((c) => c.outerHTML).join("\n");

        const win = window.open("", "_blank", "width=900,height=700");
        win.document.write(`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<title>바코드 인쇄</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }

/* 라벨지 1장 = 40×30mm, 한 장에 카드 1개 */
@page {
  size: 40mm 30mm;
  margin: 0;
}

body {
  background: #fff;
  font-family: sans-serif;
  margin: 0;
  padding: 0;
}

/* 카드 하나가 정확히 한 페이지를 차지 */
[data-card] {
  width: 40mm !important;
  height: 30mm !important;
  background: #fff;
  border: none !important;
  border-radius: 0 !important;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  overflow: hidden;
  /* 카드마다 새 페이지 */
  page-break-after: always;
  break-after: page;
}

/* 마지막 카드는 페이지 넘김 불필요 */
[data-card]:last-child {
  page-break-after: auto;
  break-after: auto;
}

[data-card] * { color: #111 !important; }
[data-card] svg { display: block !important; max-width: 100%; }
[data-card] > div[style*="display: none"] { display: none !important; }
</style>
</head>
<body>
${cardsHtml}
</body>
</html>`);
        win.document.close();
        win.focus();
        setTimeout(() => { win.print(); win.close(); }, 600);
    };

    const clearData = () => {
        setItems([]); setFileName(""); setError("");
        if (fileInputRef.current) fileInputRef.current.value = "";
    };

    const resetAll = () => {
        setSizes(DEFAULT_SIZES);
        setGaps(DEFAULT_GAPS);
        scheduleSave(DEFAULT_SIZES, DEFAULT_GAPS);
    };

    const issueHbl = async () => {
        if (!window.confirm("SHIPPING_READYING 주문의 선적바코드를 일괄 발급합니다.\n(바코드가 없는 주문에만 발급, 중복 충돌 시 삭제 후 재발급)\n\n진행하시겠습니까?")) return;
        setHblLoading(true);
        setHblResult(null);
        try {
            const res = await fetch(`${API}/pastelco/issue-hbl`, {
                method: "POST",
                headers: getAuthHeaders(),
            });
            const data = await res.json().catch(() => ({}));
            setHblResult(data);
        } catch (err) {
            setHblResult({ ok: false, error: err.message });
        } finally {
            setHblLoading(false);
        }
    };

    // ── 렌더 ─────────────────────────────────────────────────────────────
    return (
        <div className={styles.page}>
            {/* 헤더 */}
            <div className={styles.pageHeader}>
                <div>
                    <h1 className={styles.title}>아무드 바코드 테스트</h1>
                    <p className={styles.subtitle}>A열 Title · B열 Description · C열 Barcode Text (Code 128)</p>
                </div>
                <div className={styles.headerBtns}>
                    {items.length > 0 && (
                        <>
                            <button className={`${styles.iconBtn} ${showSizes ? styles.iconBtnActive : ""}`}
                                onClick={() => setShowSizes((v) => !v)}>
                                <Settings2 size={15} /> 레이아웃 설정
                            </button>
                            <button className={styles.clearBtn} onClick={clearData}>
                                <X size={13} /> 초기화
                            </button>
                            <button className={styles.printBtn} onClick={handlePrint}>
                                <Printer size={14} /> 인쇄
                            </button>
                        </>
                    )}
                </div>
            </div>

            {/* 설정 패널 */}
            {showSizes && (
                <div className={styles.sizePanel}>
                    {/* 크기 슬라이더 */}
                    <div className={styles.sizePanelTitle}>
                        크기 조정
                        {settingsSaved && <span className={styles.savedBadge}>✓ 저장됨</span>}
                    </div>
                    <div className={styles.sizeGrid}>
                        <SizeRow label="제목 크기"     name="titleSize"     value={sizes.titleSize}     min={6}   max={24}  unit="px" onChange={handleSizeChange} />
                        <SizeRow label="설명 크기"     name="descSize"      value={sizes.descSize}      min={5}   max={20}  unit="px" onChange={handleSizeChange} />
                        <SizeRow label="바코드 높이"   name="barcodeHeight" value={sizes.barcodeHeight} min={20}  max={120} unit="px" onChange={handleSizeChange} />
                        <SizeRow label="바코드 너비"   name="barcodeWidth"  value={sizes.barcodeWidth}  min={0.5} max={4}   step={0.1} unit="x" onChange={handleSizeChange} />
                        <SizeRow label="바코드 텍스트" name="btextSize"     value={sizes.btextSize}     min={5}   max={18}  unit="px" onChange={handleSizeChange} />
                        <SizeRow label="상하 여백"     name="cardPaddingV"  value={sizes.cardPaddingV}  min={2}   max={24}  unit="px" onChange={handleSizeChange} />
                        <SizeRow label="좌우 여백"     name="cardPaddingH"  value={sizes.cardPaddingH}  min={4}   max={32}  unit="px" onChange={handleSizeChange} />
                    </div>

                    {/* 요소 간격 */}
                    <div className={styles.sizePanelTitle} style={{ marginTop: "0.75rem" }}>요소 간격</div>
                    <div className={styles.sizeGrid}>
                        <GapRow elKey="title"   label="제목 아래"        value={gaps.title}   onChange={handleGapChange} />
                        <GapRow elKey="desc"    label="설명 아래"        value={gaps.desc}    onChange={handleGapChange} />
                        <GapRow elKey="barcode" label="바코드 아래"      value={gaps.barcode} onChange={handleGapChange} />
                        <GapRow elKey="btext"   label="바코드 텍스트 아래" value={gaps.btext}   onChange={handleGapChange} />
                    </div>

                    <button className={styles.resetBtn} onClick={resetAll}>기본값으로 초기화</button>
                </div>
            )}

            {/* 선적바코드 발급 */}
            <div style={{ marginBottom: "0.75rem", display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
                <button
                    className={styles.printBtn}
                    onClick={issueHbl}
                    disabled={hblLoading}
                    type="button"
                    style={{ display: "flex", alignItems: "center", gap: "6px" }}
                >
                    <Tag size={14} />
                    {hblLoading ? "발급 중..." : "선적바코드 발급"}
                </button>
                {hblResult && (
                    <span style={{ fontSize: "0.82rem", color: hblResult.ok ? "#16a34a" : hblResult.issued > 0 ? "#d97706" : "#ef4444" }}>
                        {hblResult.error && !hblResult.issued
                            ? `오류: ${hblResult.error}`
                            : `발급 ${hblResult.issued ?? 0}건 / 스킵 ${hblResult.skipped ?? 0}건 / 삭제 ${hblResult.deleted ?? 0}건`
                        }
                        {hblResult.errors?.length > 0 && (
                            <span style={{ color: "#ef4444", marginLeft: "0.5rem" }}
                                title={hblResult.errors.join("\n")}>
                                (오류 {hblResult.errors.length}건 ⚠)
                            </span>
                        )}
                    </span>
                )}
            </div>

            {/* 업로드 */}
            <div
                className={`${styles.dropZone} ${fileDragging ? styles.dragOver : ""}`}
                onDragOver={(e) => { e.preventDefault(); setFileDragging(true); }}
                onDragLeave={() => setFileDragging(false)}
                onDrop={(e) => { e.preventDefault(); setFileDragging(false); handleFile(e.dataTransfer.files?.[0]); }}
                onClick={() => fileInputRef.current?.click()}
            >
                <input ref={fileInputRef} type="file" accept=".xlsx,.xls" style={{ display: "none" }}
                    onChange={(e) => handleFile(e.target.files?.[0])} />
                <Upload size={26} className={styles.uploadIcon} />
                {fileName
                    ? <span className={styles.uploadedName}>{fileName}</span>
                    : <><span className={styles.dropLabel}>엑셀 파일을 드래그하거나 클릭하여 업로드</span>
                       <span className={styles.dropHint}>.xlsx · .xls</span></>}
            </div>

            {error && (
                <div className={styles.errorMsg}><AlertCircle size={14} /> {error}</div>
            )}

            {/* 미리보기 */}
            {items.length > 0 && (
                <>
                    <div className={styles.countBar}>총 <strong>{items.length}</strong>개 항목</div>
                    <div className={styles.previewList} ref={gridRef}>
                        {items.map((item, i) => (
                            <BarcodeItem key={i} item={item} sizes={sizes} gaps={gaps} />
                        ))}
                    </div>
                </>
            )}
        </div>
    );
}
