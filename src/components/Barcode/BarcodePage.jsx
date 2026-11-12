import { useCallback, useEffect, useRef, useState } from "react";
import { useEzadminSession } from "../../lib/EzadminSessionContext";
import styles from "./BarcodePage.module.css";
import LabelReprintPage from "./LabelReprintPage";
import StockLogModal from "./StockLogModal";
import DefectRecordSheet from "./DefectRecordSheet";
import DefectRecordDetailModal from "./DefectRecordDetailModal";
import DefectMatchModal from "./DefectMatchModal";
import DefectKakaoModal from "./DefectKakaoModal";
import { getDownloadFilename } from "../../lib/download";
import { LOCAL_API_BASE as API, getAuthHeaders, handleUnauthorized } from "../../lib/api";

const BASE_DEFECT_TABS = ["A", "B", "C"];
const DEFECT_MATCH_STORAGE_KEY = "defectMatchSession";
const KDG_TAB = "KDG"; // 케이디지 상품은 불량 불러오기 때 항상 이 탭으로 간다 (서버와 같은 이름)
const DEFECT_TAB_STORAGE_KEY = "barcodeDefectTab";
const loadDefectTab = () => {
  try {
    const saved = localStorage.getItem(DEFECT_TAB_STORAGE_KEY);
    return saved || "A";
  } catch { return "A"; }
};

const HANGUL_BASE = 0xac00;
const HANGUL_LAST = 0xd7a3;
const HANGUL_L = ["r","R","s","e","E","f","a","q","Q","t","T","d","w","W","c","z","x","v","g"];
const HANGUL_V = ["k","o","i","O","j","p","u","P","h","hk","ho","hl","y","n","nj","np","nl","b","m","ml","l"];
const HANGUL_T = ["","r","R","rt","s","sw","sg","e","f","fr","fa","fq","ft","fx","fv","fg","a","q","qt","t","T","d","w","c","z","x","v","g"];
const HANGUL_COMPAT = {
  ㄱ:"r",ㄲ:"R",ㄴ:"s",ㄷ:"e",ㄸ:"E",ㄹ:"f",ㅁ:"a",ㅂ:"q",ㅃ:"Q",ㅅ:"t",ㅆ:"T",
  ㅇ:"d",ㅈ:"w",ㅉ:"W",ㅊ:"c",ㅋ:"z",ㅌ:"x",ㅍ:"v",ㅎ:"g",
  ㅏ:"k",ㅐ:"o",ㅑ:"i",ㅒ:"O",ㅓ:"j",ㅔ:"p",ㅕ:"u",ㅖ:"P",ㅗ:"h",ㅘ:"hk",ㅙ:"ho",
  ㅚ:"hl",ㅛ:"y",ㅜ:"n",ㅝ:"nj",ㅞ:"np",ㅟ:"nl",ㅠ:"b",ㅡ:"m",ㅢ:"ml",ㅣ:"l",
};

export const toEnglishKey = (text) => {
  if (!text) return text;
  let out = "";
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code >= HANGUL_BASE && code <= HANGUL_LAST) {
      const sIndex = code - HANGUL_BASE;
      const lIndex = Math.floor(sIndex / 588);
      const vIndex = Math.floor((sIndex % 588) / 28);
      const tIndex = sIndex % 28;
      out += `${HANGUL_L[lIndex]}${HANGUL_V[vIndex]}${HANGUL_T[tIndex]}`;
      continue;
    }
    if (HANGUL_COMPAT[ch]) { out += HANGUL_COMPAT[ch]; continue; }
    out += ch;
  }
  return out.toUpperCase();
};

const BAD_STOCK_CATEGORY_LETTERS = {
  상의: ["A", "B", "C", "D", "E"],
  하의: ["A", "B", "C", "D", "E"],
  아우터: ["A", "B", "C"],
};
const BAD_STOCK_CATEGORIES = Object.keys(BAD_STOCK_CATEGORY_LETTERS);
const BAD_STOCK_BASE_ZONES = new Set(
  Object.entries(BAD_STOCK_CATEGORY_LETTERS).flatMap(([cat, letters]) => letters.map((l) => `${cat}${l}`))
);
// 직접 추가한 탭은 '분류 이름'(예: 상의 F)으로 보여준다.
const badStockZoneLabel = (zone) => {
  if (BAD_STOCK_BASE_ZONES.has(zone)) return `${zone.slice(0, -1)} ${zone.slice(-1)}구역`;
  const cat = BAD_STOCK_CATEGORIES.find((c) => zone.startsWith(c));
  return cat ? `${cat} ${zone.slice(cat.length)}` : zone;
};

// mobileLite: 모바일 전용 화면(/bacode)에서 확장주문검색·입고 파일 카드와 송장삭제·로그 확인·라벨 재출력·불량관리·이상현상·악성재고 버튼을 숨긴다.
export default function BarcodePage({ title = "Barcode", headerExtra = null, mobileLite = false }) {
  const [file, setFile] = useState(null);
  const [uploadMsg, setUploadMsg] = useState("");
  const [count, setCount] = useState(null);
  const [codesTotal, setCodesTotal] = useState(null);
  const [loadingUpload, setLoadingUpload] = useState(false);
  const [incomingFile, setIncomingFile] = useState(null);
  const [incomingMsg, setIncomingMsg] = useState("");
  const [incomingCodes, setIncomingCodes] = useState(null);
  const [incomingTotal, setIncomingTotal] = useState(null);
  const [loadingIncoming, setLoadingIncoming] = useState(false);
  const [scanText, setScanText] = useState("");
  const scanRef = useRef(null);
  const [currentInvoice, setCurrentInvoice] = useState(null);
  const [invoiceDone, setInvoiceDone] = useState(false);
  const [, setLog] = useState([]);
  const [items, setItems] = useState([]);
  // 불량 리스트/김승일 리스트는 탭(A/B/C)마다 따로 쌓인다 - 서버에는 X-Defect-Tab 헤더로 알린다.
  const [defectTab, setDefectTab] = useState(loadDefectTab);
  const defectTabRef = useRef(defectTab);
  // 탭 목록/빨강 표시는 서버에 저장 (모든 사용자 공통). 불러오기 전에는 기본 A·B·C만 보인다.
  const [defectTabs, setDefectTabs] = useState(BASE_DEFECT_TABS);
  const [redTabs, setRedTabs] = useState([]);
  const [summonedByTab, setSummonedByTab] = useState([]);
  // 불량관리 모달에서 A·B·C 전체 원가 합계를 보여주기 위해 탭별로 따로 받아둔다 ({ A: { count, cost, noCost } }).
  const [tabStats, setTabStats] = useState({});
  const tabHeaders = () => ({ ...getAuthHeaders(), "X-Defect-Tab": encodeURIComponent(defectTabRef.current) });
  const [defectMode, setDefectMode] = useState(false);
  const [productCheckMode, setProductCheckMode] = useState(false); // 제품확인 모드: 상품코드 스캔 → 에이블리 상품 페이지로 이동
  const [productCheckResult, setProductCheckResult] = useState(null); // { code, name, url, error }
  const [showDefectList, setShowDefectList] = useState(false);
  const [showDefectKakao, setShowDefectKakao] = useState(false); // 거래처 카톡 불량 전송 창
  const [defectList, setDefectList] = useState([]);
  const [defectSearchQuery, setDefectSearchQuery] = useState("");
  const [defectSearchRows, setDefectSearchRows] = useState([]);
  const [defectSearchLoading, setDefectSearchLoading] = useState(false);
  const [defectSearchMessage, setDefectSearchMessage] = useState("");
  const [defectRecentCodes, setDefectRecentCodes] = useState([]);
  const [defectSheet, setDefectSheet] = useState(null); // 스캔 직후 사진·사유 등록 시트 { code, label }
  const [defectRecords, setDefectRecords] = useState([]); // 현재 탭의 사진·사유 기록 (SQLite)
  const [defectMatchOpen, setDefectMatchOpen] = useState(false); // 불량 불러오기 실물 매칭 창
  // 실물 매칭 진행 상태 { tabs, rowsByTab, scanned, doneTabs, activeTab } — 창을 닫아도 이 기기에 저장돼, 그 탭을 누르면 이어서 연다.
  const [defectMatchSession, setDefectMatchSession] = useState(() => {
    try { return JSON.parse(localStorage.getItem(DEFECT_MATCH_STORAGE_KEY) || "null"); } catch { return null; }
  });
  const saveDefectMatchSession = useCallback((session) => {
    setDefectMatchSession(session);
    try {
      if (session) localStorage.setItem(DEFECT_MATCH_STORAGE_KEY, JSON.stringify(session));
      else localStorage.removeItem(DEFECT_MATCH_STORAGE_KEY);
    } catch { /* 저장 못 해도 매칭은 계속 가능 */ }
  }, []);
  // 이 탭에 아직 완료 처리 안 한 매칭이 남아 있는지
  const hasPendingMatch = (tab) => Boolean(defectMatchSession?.rowsByTab?.[tab] && !defectMatchSession?.doneTabs?.[tab]);
  const pendingMatchText = (tab) => {
    const list = defectMatchSession?.rowsByTab?.[tab] ?? [];
    const sc = defectMatchSession?.scanned ?? {};
    const total = list.reduce((sum, r) => sum + r.total, 0);
    const got = list.reduce((sum, r) => sum + Math.min(r.total, sc[r.key] || 0), 0);
    return `매칭 중 ${got}/${total}`;
  };
  // 탭을 누르면 그 탭 매칭을 이어서 연다.
  const resumeDefectMatch = (tab) => {
    if (!hasPendingMatch(tab)) return false;
    saveDefectMatchSession({ ...defectMatchSession, activeTab: tab });
    setDefectMatchOpen(true);
    return true;
  };
  const [showKimsungilList, setShowKimsungilList] = useState(false);
  const [kimsungilNameSort, setKimsungilNameSort] = useState(""); // ""(기본: 입고 우선) | "desc" | "asc"
  const [kimsungilList, setKimsungilList] = useState([]);
  const [kimsungilSearchQuery, setKimsungilSearchQuery] = useState("");
  const [kimsungilSearchRows, setKimsungilSearchRows] = useState([]);
  const [kimsungilSearchLoading, setKimsungilSearchLoading] = useState(false);
  const [kimsungilSearchMessage, setKimsungilSearchMessage] = useState("");
  const [kimsungilSummonLoading, setKimsungilSummonLoading] = useState(false);
  const [purchaseModePicker, setPurchaseModePicker] = useState(false); // 매입관리 보내기 범위 선택 창
  const [purchaseScope, setPurchaseScope] = useState("all"); // normal | summon | all
  const [purchaseSelected, setPurchaseSelected] = useState({}); // 코드 → 선택 여부
  const [purchaseSending, setPurchaseSending] = useState(false);
  const [defectPhotoCode, setDefectPhotoCode] = useState(null); // 📷 버튼으로 연 사진·사유 팝업의 상품코드
  const [purchaseSent, setPurchaseSent] = useState({}); // 이미 매입관리로 보낸 수량: 코드 → {normal, summon}
  const [purchaseResult, setPurchaseResult] = useState(null); // 보내기 결과 팝업
  const [kimsungilSummonPicker, setKimsungilSummonPicker] = useState(null); // { tabs, counts: { 탭: {kinds,total}|null|"?" } }
  const [unifiedQuery, setUnifiedQuery] = useState("");
  const [unifiedRows, setUnifiedRows] = useState(null); // null = 아직 검색 안 함
  const [unifiedLoading, setUnifiedLoading] = useState(false);
  const [showKimsungilLog, setShowKimsungilLog] = useState(false);
  const [kimsungilLogCode, setKimsungilLogCode] = useState("");
  const [kimsungilLogRows, setKimsungilLogRows] = useState([]);
  const [kimsungilLogLoading, setKimsungilLogLoading] = useState(false);
  const [kimsungilLogMessage, setKimsungilLogMessage] = useState("");
  const [defectBaseHeaders, setDefectBaseHeaders] = useState(["상품코드", "상품명", "공급처", "공급처상품명", "색상 사이즈", "주소", "표시형 상품명"]);
  const [defectBaseRows, setDefectBaseRows] = useState([]);
  const [defectBasePath, setDefectBasePath] = useState("");
  const [defectBaseQuery, setDefectBaseQuery] = useState("");
  const [defectBaseLoading, setDefectBaseLoading] = useState(false);
  const [defectBaseSaving, setDefectBaseSaving] = useState(false);
  const [defectBaseMessage, setDefectBaseMessage] = useState("");
  const [showDefectBaseEditor, setShowDefectBaseEditor] = useState(false);
  const [showAnomalyModal, setShowAnomalyModal] = useState(false);
  const [anomalyList, setAnomalyList] = useState([]);
  const [showBadStockModal, setShowBadStockModal] = useState(false);
  const [badStockZone, setBadStockZone] = useState("상의A");
  const [badStockList, setBadStockList] = useState([]);
  const [badStockCustomZones, setBadStockCustomZones] = useState([]);
  const [badStockLastDeduct, setBadStockLastDeduct] = useState(null); // 출고상품삭제 마지막 실행 {at, user, kinds, total}
  const [badStockMoveIds, setBadStockMoveIds] = useState([]);
  const [badStockMoveTarget, setBadStockMoveTarget] = useState("");
  const [badStockScan, setBadStockScan] = useState("");
  const [badStockQuery, setBadStockQuery] = useState("");
  const [badStockRows, setBadStockRows] = useState([]);
  const [badStockSearching, setBadStockSearching] = useState(false);
  const [badStockMessage, setBadStockMessage] = useState("");
  const [badStockChecking, setBadStockChecking] = useState(false);
  const [badStockCheck, setBadStockCheck] = useState(null);
  const [badStockSelected, setBadStockSelected] = useState([]);
  const [badStockFind, setBadStockFind] = useState("");
  const [badStockNormalizing, setBadStockNormalizing] = useState(false);
  const [badStockRenaming, setBadStockRenaming] = useState(false);
  const [renameConfirm, setRenameConfirm] = useState(null); // { preview, canProceed, resolve }
  const [renameConfirmTab, setRenameConfirmTab] = useState("rename");
  const [anomalySearchQuery, setAnomalySearchQuery] = useState("");
  const [anomalySearchRows, setAnomalySearchRows] = useState([]);
  const [anomalySearchLoading, setAnomalySearchLoading] = useState(false);
  const [anomalyMessage, setAnomalyMessage] = useState("");
  const [anomalyForm, setAnomalyForm] = useState({
    registered_date: new Date().toLocaleDateString("sv-SE"),
    product_name: "",
    qty: 1,
    reason: "",
    normalized: false,
  });
  const [anomalyEdit, setAnomalyEdit] = useState(null);
  const [anomalyComplete, setAnomalyComplete] = useState(null); // { id, memo }
  const [showAnomalyDone, setShowAnomalyDone] = useState(false);
  const [anomalyDoneList, setAnomalyDoneList] = useState([]);
  const [ochuulLoading, setOchuulLoading] = useState(false);
  const [ochuulResult, setOchuulResult] = useState(null);
  const [ezadminLoading, setEzadminLoading] = useState(false);
  const [ezadminMsg, setEzadminMsg] = useState("");
  const [incomingEzDate, setIncomingEzDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [incomingVoucherLoading, setIncomingVoucherLoading] = useState(false);
  const [incomingVoucherList, setIncomingVoucherList] = useState([]);
  const [showIncomingVoucherModal, setShowIncomingVoucherModal] = useState(false);
  const [selectedIncomingSheets, setSelectedIncomingSheets] = useState([]);
  const [ezadminOrdersLoading, setEzadminOrdersLoading] = useState(false);
  const [ezadminOrdersMsg, setEzadminOrdersMsg] = useState("");
  const [ezadminOrdersTiming, setEzadminOrdersTiming] = useState(null);
  const [ezadminOrdersDate, setEzadminOrdersDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [defectEzadminLoading, setDefectEzadminLoading] = useState(false);
  const [defectOchuulDoneAt, setDefectOchuulDoneAt] = useState(() => {
    try {
      const v = localStorage.getItem("defectExportOchuulDoneAt");
      return v && v.slice(0, 10) === new Date().toLocaleDateString("sv-SE") ? v : "";
    } catch { return ""; }
  });
  const [defectEzadminMsg, setDefectEzadminMsg] = useState("");
  const { openModal: openEzadminModal } = useEzadminSession();
  const soundsRef = useRef(null);

  const [showInvoiceModal, setShowInvoiceModal] = useState(false);
  const [showLabelReprint, setShowLabelReprint] = useState(false);
  const [showStockLog, setShowStockLog] = useState(false);

  // 불량 목록/불량관리 모달이 떠 있는 동안 뒤의 페이지가 같이 스크롤되지 않게 잠근다.
  useEffect(() => {
    if (!showDefectList && !showKimsungilList) return undefined;
    const prevBody = document.body.style.overflow;
    const prevHtml = document.documentElement.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevBody;
      document.documentElement.style.overflow = prevHtml;
    };
  }, [showDefectList, showKimsungilList]);
  const [invoiceBulkMode, setInvoiceBulkMode] = useState(false);
  const [invoiceStockOutEnabled, setInvoiceStockOutEnabled] = useState(true);
  const [invoiceStockOutMemo, setInvoiceStockOutMemo] = useState("");
  const [invoiceCancelProcessEnabled, setInvoiceCancelProcessEnabled] = useState(false);
  const [invoiceNoInput, setInvoiceNoInput] = useState("");
  const [invoicePreview, setInvoicePreview] = useState(null);
  const [invoicePreviewLoading, setInvoicePreviewLoading] = useState(false);
  const [invoicePreviewError, setInvoicePreviewError] = useState("");
  const [invoiceSteps, setInvoiceSteps] = useState([]);
  const [invoiceExecuting, setInvoiceExecuting] = useState(false);
  const [invoiceBulkInput, setInvoiceBulkInput] = useState("");
  const [invoiceBulkResults, setInvoiceBulkResults] = useState([]);
  const [invoiceBulkRunning, setInvoiceBulkRunning] = useState(false);
  const getInvoiceStepLabels = (includeStockOut, includeCancelProcess) => [
    "거래취소 · 송장번호 삭제",
    ...(includeCancelProcess ? ["주문 취소처리"] : []),
    ...(includeStockOut ? ["재고 출고처리"] : []),
    "에이블리 발송관리 롤백",
  ];

  const pushLog = (msg) => setLog((prev) => [msg, ...prev]);

  const refreshStatus = useCallback(async () => {
    try {
      const tab = defectTabRef.current;
      const res = await fetch(`${API}/barcode/status`, { headers: tabHeaders() });
      if (handleUnauthorized(res)) return;
      const data = await res.json();
      if (tab !== defectTabRef.current) return; // 응답이 오는 사이 탭이 바뀌었으면 버린다
      if (data?.incoming_codes !== undefined) {
        setIncomingCodes(data.incoming_codes);
        setIncomingTotal(data.incoming_total ?? 0);
      }
      if (data.loaded) {
        setCurrentInvoice(data.current_invoice ?? null);
        setInvoiceDone(false);
        if (data.current_invoice) setItems(data.items ?? []);
        else if (Array.isArray(data.items) && data.items.length > 0) setItems(data.items);
        setDefectList(data.defects ?? []);
        setKimsungilList(data.kimsungil ?? []);
      } else {
        setCurrentInvoice(null); setInvoiceDone(false);
             }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { refreshStatus(); setTimeout(() => scanRef.current?.focus(), 50); }, [refreshStatus]);

  // 불량 목록은 서버에 공유되는데 화면은 열 때 한 번만 읽어서, 모바일(/bacode)과 웹 바코드 화면이 서로 바뀐 걸 못 봤다.
  // 화면이 보이는 동안 주기적으로, 그리고 다시 보이는 순간 서버 목록으로 맞춘다.
  useEffect(() => {
    const sync = () => { if (document.visibilityState === "visible") fetchDefectList(); };
    const timer = setInterval(sync, 4000);
    document.addEventListener("visibilitychange", sync);
    window.addEventListener("focus", sync);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("focus", sync);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const switchDefectTab = (tab) => {
    if (tab === defectTabRef.current) return;
    defectTabRef.current = tab;
    setDefectTab(tab);
    try { localStorage.setItem(DEFECT_TAB_STORAGE_KEY, tab); } catch { /* ignore */ }
    setDefectRecentCodes([]);
    // 이전 탭 목록이 남아 보이지 않게 비우고, 바코드 파일 로드 여부와 무관하게 새 탭 목록을 직접 가져온다
    setDefectList([]);
    setKimsungilList([]);
    refreshStatus();
    fetchDefectList();
    fetchKimsungilList();
    setDefectRecords([]);
    fetchDefectRecords();
  };

  const applyTabsConfig = (cfg) => {
    if (!cfg?.tabs?.length) return;
    setDefectTabs(cfg.tabs);
    setRedTabs(cfg.red ?? []);
    if (!cfg.tabs.includes(defectTabRef.current)) switchDefectTab("A");
  };

  const callDefectTabsApi = async (path, payload) => {
    try {
      const res = await fetch(`${API}/barcode/defect-tabs${path}`, {
        method: payload ? "POST" : "GET",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: payload ? JSON.stringify(payload) : undefined,
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { alert(data?.detail || "탭 처리 실패"); return; }
      applyTabsConfig(data);
      return data;
    } catch { /* ignore */ }
  };

  useEffect(() => { callDefectTabsApi(""); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const addDefectTab = async () => {
    const name = (window.prompt("추가할 탭 이름을 입력하세요 (10자 이내)") || "").trim();
    if (!name) return;
    const data = await callDefectTabsApi("/add", { name });
    if (data) switchDefectTab(name.toUpperCase());
  };

  const removeDefectTab = async (tab) => {
    if (!window.confirm(`'${tab}' 탭을 삭제하시겠습니까? 이 탭에 쌓인 불량/김승일 리스트도 함께 사라집니다.`)) return;
    await callDefectTabsApi("/remove", { name: tab });
  };

  const toggleRedTab = (tab) => callDefectTabsApi("/red", { name: tab, red: !redTabs.includes(tab) });

  const renderDefectTabs = (showCost = false) => (
    <div className={styles.tabRow} style={{ marginBottom: "0.75rem" }}>
      {defectTabs.map((tab) => (
        <span key={tab} style={{ display: "inline-flex", alignItems: "center" }}>
          <button
            className={`${styles.tabBtn} ${defectTab === tab ? styles.tabActive : ""} ${redTabs.includes(tab) ? styles.tabTextRed : ""}`}
            onClick={() => { switchDefectTab(tab); resumeDefectMatch(tab); }}
          >
            {tab}
            {showCost && getTabStat(tab) && ` · ${getTabStat(tab).cost.toLocaleString()}원`}
            {hasPendingMatch(tab) && ` · ${pendingMatchText(tab)}`}
          </button>
          {showCost && defectTab === tab && (
            <>
              <button
                className={styles.ghostBtn}
                title={redTabs.includes(tab) ? "글씨 빨강 해제" : "글씨 빨강으로 표시"}
                style={{ color: "#dc2626", fontWeight: redTabs.includes(tab) ? 800 : 400 }}
                onClick={() => toggleRedTab(tab)}
              >
                {redTabs.includes(tab) ? "●" : "○"}
              </button>
              {!BASE_DEFECT_TABS.includes(tab) && (
                <button className={styles.ghostBtn} title="탭 삭제" onClick={() => removeDefectTab(tab)}>×</button>
              )}
            </>
          )}
        </span>
      ))}
      {showCost && <button className={styles.secondaryBtn} title="탭 추가" onClick={addDefectTab}>+</button>}
    </div>
  );

  useEffect(() => {
    const makeAudio = (src) => {
      const a = new Audio(src);
      a.preload = "auto";
      return a;
    };
    soundsRef.current = {
      invoiceDone: makeAudio("/sounds/zz.wav"),
      itemDone: makeAudio("/sounds/xx.wav"),
      bad: makeAudio("/sounds/dd.wav"),
      invoiceDefect: makeAudio("/sounds/bb.wav"),
      postShipmentCancel: makeAudio("/sounds/ice.wav"),
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (e) => { if (e.key === "F2") { e.preventDefault(); setDefectMode((v) => !v); } };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const handleUpload = async () => {
    if (!file) { alert("송장 파일을 선택해 주세요."); return; }
    const formData = new FormData();
    formData.append("file", file);
    try {
      setLoadingUpload(true); setUploadMsg(""); setCount(null); setCodesTotal(null);
      const res = await fetch(`${API}/barcode/upload`, { method: "POST", headers: tabHeaders(), body: formData });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "업로드 실패");
      setUploadMsg("업로드 완료");
      setCount(data.invoices ?? null); setCodesTotal(data.codes_total ?? null);
      pushLog(`업로드 완료 (송장 ${data.invoices ?? "-"} / 코드 ${data.codes_total ?? "-"})`);
      setCurrentInvoice(null); setInvoiceDone(false);
      setItems([]); setDefectRecentCodes([]); setScanText("");
      setTimeout(() => scanRef.current?.focus(), 50);
    } catch (err) {
      setUploadMsg(`업로드 실패: ${err.message || ""}`.trim());
      pushLog(`업로드 실패: ${err.message || ""}`.trim());
    } finally { setLoadingUpload(false); }
  };

  const handleIncomingUpload = async () => {
    if (!incomingFile) { alert("입고 파일을 선택해 주세요."); return; }
    const formData = new FormData();
    formData.append("file", incomingFile);
    try {
      setLoadingIncoming(true); setIncomingMsg(""); setIncomingCodes(null); setIncomingTotal(null);
      const res = await fetch(`${API}/barcode/incoming/upload`, { method: "POST", headers: tabHeaders(), body: formData });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "입고 파일 업로드 실패");
      setIncomingMsg("입고 파일 로드 완료");
      setIncomingCodes(data.codes ?? null); setIncomingTotal(data.total_qty ?? null);
      pushLog(`입고 파일 로드 완료 (코드 ${data.codes ?? "-"} / 수량 ${data.total_qty ?? "-"})`);
      await refreshStatus();
    } catch (err) {
      setIncomingMsg(`입고 파일 업로드 실패: ${err.message || ""}`.trim());
      pushLog(`입고 파일 업로드 실패: ${err.message || ""}`.trim());
    } finally { setLoadingIncoming(false); }
  };

  const handleIncomingFromEzadmin = async (sheetList) => {
    const sheets = Array.isArray(sheetList) ? sheetList.filter(Boolean) : [];
    try {
      setEzadminLoading(true);
      setEzadminMsg(`EZAdmin에서 불러오는 중... (${incomingEzDate}${sheets.length ? `, 전표 ${sheets.length}건` : ""}, 최대 60초)`);
      setIncomingMsg(""); setIncomingCodes(null); setIncomingTotal(null);
      const res = await fetch(`${API}/barcode/incoming/upload-from-ezadmin`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...tabHeaders() },
        body: JSON.stringify({ date: incomingEzDate, ...(sheets.length ? { sheet_list: sheets } : {}) }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (data?.need_session) {
        setEzadminMsg("");
        openEzadminModal(() => handleIncomingFromEzadmin(sheets));
        return;
      }
      if (!res.ok || !data?.ok) {
        const msg = data?.detail || "EZAdmin 불러오기 실패";
        setIncomingMsg(msg); pushLog(msg);
        return;
      }
      setIncomingMsg(`EZAdmin 입고 데이터 로드 완료 (${data.date ?? incomingEzDate})`);
      setIncomingCodes(data.codes ?? null); setIncomingTotal(data.total_qty ?? null);
      pushLog(`EZAdmin 입고 로드 완료 (${data.date ?? incomingEzDate} · 코드 ${data.codes ?? "-"} / 수량 ${data.total_qty ?? "-"})`);
      await refreshStatus();
    } catch (err) {
      const msg = `EZAdmin 불러오기 실패: ${err.message || ""}`.trim();
      setIncomingMsg(msg); pushLog(msg);
    } finally { setEzadminLoading(false); setEzadminMsg(""); }
  };

  const handleOpenIncomingVoucherPicker = async () => {
    setIncomingVoucherLoading(true);
    setIncomingMsg("");
    try {
      const res = await fetch(`${API}/barcode/incoming/ezadmin-voucher-list?date=${encodeURIComponent(incomingEzDate)}`, { headers: tabHeaders() });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (data?.need_session) {
        openEzadminModal(handleOpenIncomingVoucherPicker);
        return;
      }
      if (!res.ok || !data?.ok) throw new Error(data?.detail || data?.error || "입고전표 목록 조회 실패");
      if (!data.vouchers?.length) {
        setIncomingMsg(`${incomingEzDate} 입고전표가 없습니다.`);
        return;
      }
      setIncomingVoucherList(data.vouchers);
      setSelectedIncomingSheets(data.vouchers.map((v) => String(v.sheet)));
      setShowIncomingVoucherModal(true);
    } catch (err) {
      setIncomingMsg(err.message || "입고전표 목록 조회 실패");
    } finally {
      setIncomingVoucherLoading(false);
    }
  };

  const handleIncomingVoucherConfirm = async () => {
    if (!selectedIncomingSheets.length) return;
    setShowIncomingVoucherModal(false);
    await handleIncomingFromEzadmin(selectedIncomingSheets);
  };

  const handleUploadFromEzadminOrders = async () => {
    const startedAt = performance.now();
    try {
      setEzadminOrdersLoading(true); setEzadminOrdersMsg(`EZAdmin에서 주문 불러오는 중... (${ezadminOrdersDate})`);
      setEzadminOrdersTiming(null);
      setUploadMsg(""); setCount(null); setCodesTotal(null);
      const res = await fetch(`${API}/barcode/upload-from-ezadmin-orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...tabHeaders() },
        body: JSON.stringify({ date: ezadminOrdersDate }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (data?.need_session) {
        setEzadminOrdersMsg("");
        openEzadminModal(handleUploadFromEzadminOrders);
        return;
      }
      if (!res.ok || !data?.ok) {
        const msg = data?.error || data?.detail || "EZAdmin 주문 불러오기 실패";
        setEzadminOrdersMsg(msg);
        return;
      }
      const timing = data.timings || {
        total_ms: Math.round(performance.now() - startedAt),
        fallback: true,
      };
      const timingText = timing.fallback
        ? `전체 요청 ${(timing.total_ms / 1000).toFixed(2)}초`
        : `응답 ${(timing.api_ms / 1000).toFixed(2)}초 · 가공 ${(timing.processing_ms / 1000).toFixed(2)}초 · 총 ${(timing.total_ms / 1000).toFixed(2)}초`;
      setEzadminOrdersMsg(`완료 (${data.date} · 송장 ${data.invoices} · 코드 ${data.codes_total}) · ${timingText}`);
      setEzadminOrdersTiming(timing);
      setCount(data.invoices ?? null); setCodesTotal(data.codes_total ?? null);
      setCurrentInvoice(null); setInvoiceDone(false);
      setItems([]); setDefectRecentCodes([]); setScanText("");
      setTimeout(() => scanRef.current?.focus(), 50);
    } catch (err) {
      setEzadminOrdersMsg(`실패: ${err.message || ""}`.trim());
    } finally { setEzadminOrdersLoading(false); }
  };

  const isProbablyInvoice = (s) => /^\d{10,}$/.test((s || "").trim());

  // 상품코드로 상품을 조회해 사진·사유 등록 시트를 연다. 이 단계에서는 불량 수량이 전혀 바뀌지 않고,
  // 시트에서 사진+사유를 갖춰 '확인'을 눌러야만 등록된다.
  const openDefectSheetFor = async (rawCode) => {
    const res = await fetch(`${API}/barcode/defect/record/lookup?code=${encodeURIComponent(rawCode)}`, { headers: tabHeaders() });
    if (handleUnauthorized(res)) return;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.detail || "상품 조회 실패");
    setDefectSheet({ code: data.code, label: data.name || "", found: Boolean(data.found) });
  };

  const handleDefectAdd = async () => {
    const value = toEnglishKey(scanText.trim());
    if (!value) return;
    try {
      await openDefectSheetFor(value);
    } catch (err) { pushLog(`불량 조회 실패: ${err.message || ""}`.trim()); }
    finally { setScanText(""); }
  };

  const fetchDefectRecords = async () => {
    try {
      const tab = defectTabRef.current;
      const res = await fetch(`${API}/barcode/defect/record/list`, { headers: tabHeaders() });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "불량 기록 조회 실패");
      if (tab !== defectTabRef.current) return; // 응답이 오는 사이 탭이 바뀌었으면 버린다
      setDefectRecords(data.records ?? []);
    } catch { /* ignore */ }
  };

  const handleDefectRecordSaved = (data) => {
    setDefectRecords(data.records ?? []);
    if (data.defects) setDefectList(data.defects);
    if (data.items) setItems(data.items);
    if (data.code) setDefectRecentCodes((prev) => [data.code, ...prev.filter((code) => code !== data.code)]);
    if (defectSheet?.reopenPhoto && data.code) setDefectPhotoCode(data.code); // 📷 창에서 추가했으면 다시 그 창으로
    setDefectSheet(null);
    pushLog(`불량 등록: ${data.code || ""} (누적 ${data.defect_count ?? ""}) — 사진·사유 포함`.trim());
    setTimeout(() => scanRef.current?.focus(), 0);
  };

  const searchDefectBaseByName = async () => {
    const query = defectSearchQuery.trim();
    if (!query) {
      setDefectSearchRows([]);
      setDefectSearchMessage("검색어를 입력하세요.");
      return;
    }
    try {
      setDefectSearchLoading(true);
      setDefectSearchMessage("");
      const res = await fetch(`${API}/barcode/defect/search?q=${encodeURIComponent(query)}`, { headers: tabHeaders() });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "불량 검색 실패");
      setDefectSearchRows(data.rows || []);
      setDefectSearchMessage((data.rows || []).length ? `${data.rows.length}건 검색됨` : "검색 결과가 없습니다.");
    } catch (err) {
      setDefectSearchRows([]);
      setDefectSearchMessage(err.message || "불량 검색 실패");
    } finally {
      setDefectSearchLoading(false);
    }
  };

  const todayStr = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };

  const fetchAnomalies = async () => {
    try {
      const res = await fetch(`${API}/barcode/anomaly/list`, { headers: tabHeaders() });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "이상현상 불러오기 실패");
      setAnomalyList(data.items ?? []);
    } catch (err) {
      setAnomalyMessage(err.message || "이상현상 불러오기 실패");
    }
  };

  const fetchCompletedAnomalies = async () => {
    try {
      const res = await fetch(`${API}/barcode/anomaly/completed`, { headers: tabHeaders() });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "완료 내역 불러오기 실패");
      setAnomalyDoneList(data.items ?? []);
    } catch (err) {
      setAnomalyMessage(err.message || "완료 내역 불러오기 실패");
    }
  };

  const toggleAnomalyDone = () => {
    const next = !showAnomalyDone;
    setShowAnomalyDone(next);
    setAnomalyComplete(null);
    if (next) fetchCompletedAnomalies();
  };

  const saveAnomalyComplete = async () => {
    if (!anomalyComplete) return;
    if (await callAnomalyApi("complete", { id: anomalyComplete.id, memo: anomalyComplete.memo })) {
      setAnomalyComplete(null);
      setAnomalyMessage("완료 처리했습니다. (완료 내역에서 확인)");
    }
  };

  const fetchBadStock = async () => {
    try {
      const res = await fetch(`${API}/barcode/bad-stock/list`, { headers: tabHeaders() });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "악성재고 불러오기 실패");
      setBadStockList(data.items ?? []);
      setBadStockCustomZones(data.custom_zones ?? []);
      setBadStockLastDeduct(data.last_deduct ?? null);
    } catch (err) {
      setBadStockMessage(err.message || "악성재고 불러오기 실패");
    }
  };

  // 원가베이스 원가 × 수량. zone을 주면 그 구역만, 안 주면 전체 구역 합계. 원가 없는 상품은 합계에서 빠진다.
  const getBadStockCost = (zone) =>
    badStockList
      .filter((i) => !zone || i.zone === zone)
      .reduce((sum, i) => sum + (Number(i.base_cost) || 0) * (Number(i.qty) || 1), 0);
  const getBadStockNoCostCount = () =>
    badStockList.filter((i) => !(Number(i.base_cost) > 0)).length;

  const openBadStockModal = () => {
    setShowBadStockModal(true);
    setBadStockMessage("");
    fetchBadStock();
  };

  const callBadStockApi = async (path, body) => {
    try {
      const res = await fetch(`${API}/barcode/bad-stock/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...tabHeaders() },
        body: JSON.stringify(body),
      });
      if (handleUnauthorized(res)) return null;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "악성재고 처리 실패");
      setBadStockList(data.items ?? []);
      if (data.custom_zones) setBadStockCustomZones(data.custom_zones);
      if ("last_deduct" in data) setBadStockLastDeduct(data.last_deduct ?? null);
      return data;
    } catch (err) {
      setBadStockMessage(err.message || "악성재고 처리 실패");
      return null;
    }
  };

  const addBadStock = async (code, productName) => {
    const data = await callBadStockApi("add", { zone: badStockZone, code, product_name: productName });
    if (data) setBadStockMessage(`${badStockZoneLabel(badStockZone)} 추가: ${data.added?.product_name || code}`);
    return !!data;
  };

  const addBadStockZone = async (category) => {
    const suffix = (window.prompt(`${category}에 추가할 탭 이름을 입력하세요 (10자 이내)`) || "").trim();
    if (!suffix) return;
    const data = await callBadStockApi("zone/add", { category, name: suffix });
    if (data) {
      setBadStockZone(data.zone);
      setBadStockRows([]);
      setBadStockMoveIds([]);
      setBadStockMessage(`'${badStockZoneLabel(data.zone)}' 탭을 추가했습니다.`);
    }
  };

  const removeBadStockZone = async (name) => {
    if (!window.confirm(`'${badStockZoneLabel(name)}' 탭을 삭제하시겠습니까?`)) return;
    const data = await callBadStockApi("zone/remove", { name });
    if (data) {
      if (badStockZone === name) setBadStockZone("상의A");
      setBadStockMessage(`'${badStockZoneLabel(name)}' 탭을 삭제했습니다.`);
    }
  };

  const moveBadStock = async () => {
    if (!badStockMoveIds.length || !badStockMoveTarget) return;
    const data = await callBadStockApi("move", { ids: badStockMoveIds, zone: badStockMoveTarget });
    if (data) {
      setBadStockMessage(`${data.moved ?? 0}종을 ${badStockZoneLabel(badStockMoveTarget)}(으)로 옮겼습니다.`);
      setBadStockMoveIds([]);
    }
  };

  const checkBadStockWithEzadmin = async () => {
    setBadStockChecking(true);
    setBadStockMessage("");
    try {
      const res = await fetch(`${API}/barcode/bad-stock/ezadmin-check`, {
        method: "POST",
        headers: tabHeaders(),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "이지어드민 재고 확인 실패");
      if (data.need_session) {
        setBadStockCheck(null);
        setBadStockMessage("이지어드민 세션이 만료되었거나 없습니다. PHPSESSID를 다시 등록해주세요.");
        return;
      }
      setBadStockCheck(data);
      setBadStockSelected([]);
    } catch (err) {
      setBadStockMessage(err.message || "이지어드민 재고 확인 실패");
    } finally {
      setBadStockChecking(false);
    }
  };

  // 이지어드민 정상재고가 등록 수량보다 적은 상품(부족분)만 입고처리 대상이다.
  const badStockShortItems = (badStockCheck?.items ?? []).filter((i) => i.status === "mismatch" && i.diff < 0);

  const normalizeBadStock = async (codes) => {
    const targets = codes.length ? badStockShortItems.filter((i) => codes.includes(i.code)) : badStockShortItems;
    if (!targets.length) {
      setBadStockMessage("정상화할 부족 상품이 없습니다.");
      return;
    }
    const totalQty = targets.reduce((s, i) => s + (-i.diff), 0);
    if (!window.confirm(`${targets.length}종, 합계 ${totalQty}개를 이지어드민에 입고처리하여 악성재고 등록 수량에 맞춥니다.\n\n진행하시겠습니까?`)) return;
    setBadStockNormalizing(true);
    setBadStockMessage("");
    try {
      const res = await fetch(`${API}/barcode/bad-stock/ezadmin-normalize`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...tabHeaders() },
        body: JSON.stringify({ codes: targets.map((i) => i.code) }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "재고 정상화 실패");
      if (data.need_session) {
        setBadStockMessage("이지어드민 세션이 만료되었거나 없습니다. PHPSESSID를 다시 등록해주세요.");
        return;
      }
      if (data.check) setBadStockCheck(data.check);
      setBadStockSelected([]);
      const failed = (data.results ?? []).filter((r) => !r.ok);
      setBadStockMessage(
        failed.length
          ? `정상화 ${data.results.length - failed.length}건 완료, 실패 ${failed.length}건: ${failed.map((r) => r.code).join(", ")}`
          : `정상화 완료: ${data.results?.length ?? 0}종 입고처리`
      );
    } catch (err) {
      setBadStockMessage(err.message || "재고 정상화 실패");
    } finally {
      setBadStockNormalizing(false);
    }
  };

  // 출고상품삭제 마지막 실행 표시: 오늘이면 "오늘 14:32", 아니면 "10/29 14:32".
  const describeLastDeduct = (last) => {
    if (!last?.at) return null;
    const [day, time] = String(last.at).split("T");
    const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" });
    const isToday = day === today;
    const when = `${isToday ? "오늘" : day.slice(5).replace("-", "/")} ${(time || "").slice(0, 5)}`;
    return { isToday, text: `${when} ${last.user || ""} · ${last.kinds ?? 0}종 ${last.total ?? 0}개 차감`.replace(/\s+/g, " ") };
  };

  // 출고상품삭제 실행 이력 모달
  const [showDeductHistory, setShowDeductHistory] = useState(false);
  const [deductHistory, setDeductHistory] = useState([]);
  const [deductHistoryOpenIdx, setDeductHistoryOpenIdx] = useState(null);
  const openDeductHistory = async () => {
    setShowDeductHistory(true);
    setDeductHistoryOpenIdx(null);
    try {
      const res = await fetch(`${API}/barcode/bad-stock/deduct-history`, { headers: tabHeaders() });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      setDeductHistory(Array.isArray(data.history) ? data.history : []);
    } catch {
      setDeductHistory([]);
    }
  };

  // 확장주문검색에 올라온 주문에 악성재고 상품이 있으면 주문 수량만큼 악성재고에서 차감/삭제한다.
  const deductShippedBadStock = async () => {
    setBadStockMessage("");
    const preview = await callBadStockApi("deduct-shipped", { dry_run: true });
    if (!preview) return;
    if (!preview.deducted_items?.length) {
      setBadStockMessage("확장주문검색 주문에 해당하는 악성재고 상품이 없습니다.");
      return;
    }
    const lines = preview.deducted_items.slice(0, 15).map((i) => `${i.product_name || i.code} : -${i.deducted}`).join("\n");
    const more = preview.deducted_items.length > 15 ? `\n... 외 ${preview.deducted_items.length - 15}종` : "";
    const restoreList = preview.restored_items ?? [];
    const restoreText = restoreList.length
      ? `\n\n[이지어드민 상품명 원복 ${restoreList.length}종]\n${restoreList.slice(0, 8).map((r) => `${r.renamed_name} → ${r.original_name}`).join("\n")}${restoreList.length > 8 ? `\n... 외 ${restoreList.length - 8}종` : ""}`
      : "";
    const prev = describeLastDeduct(preview.last_deduct);
    const prevText = prev?.isToday ? `⚠ 오늘 이미 실행했습니다 (${prev.text}). 같은 주문으로 또 누르면 이중 차감될 수 있습니다.\n\n` : "";
    if (!window.confirm(`${prevText}${preview.deducted_items.length}종, 합계 ${preview.deducted_total}개를 악성재고에서 차감합니다. (0이 되면 삭제)\n\n${lines}${more}${restoreText}\n\n진행하시겠습니까?`)) return;
    const data = await callBadStockApi("deduct-shipped", {});
    if (!data) return;
    const restored = (data.restored_items ?? []).filter((r) => r.status === "done");
    const restoreFailed = (data.restored_items ?? []).filter((r) => r.status === "failed");
    setBadStockMessage(
      `출고상품 차감 완료: ${data.deducted_items.length}종 ${data.deducted_total}개`
      + (restored.length ? `, 상품명 원복 ${restored.length}종` : "")
      + (restoreFailed.length ? `, 원복 실패 ${restoreFailed.length}종: ${restoreFailed.slice(0, 3).map((r) => `${r.renamed_name}(${r.message})`).join(", ")}` : "")
    );
  };

  // 악성재고 상품의 이지어드민 상품명 앞에 구역 접두어(A구역 ZA, B구역 ZB ...)를 붙인다.
  // recheckAll(전체 재조회)이면 "이미 바꾼 기록"을 믿지 않고 모든 악성재고 상품의 현재 이름을 이지어드민에서 다시 읽어 비교한다.
  const renameBadStockProducts = async (recheckAll = false) => {
    const call = async (dryRun) => {
      // 요청이 끝날 때까지 서버의 진행도(읽은 수/변경한 수)를 주기적으로 읽어 메시지에 보여준다.
      let polling = true;
      const poll = async () => {
        try {
          const res = await fetch(`${API}/barcode/bad-stock/rename-progress`, { headers: tabHeaders() });
          const p = await res.json().catch(() => ({}));
          if (!polling || !p?.total) return;
          if (p.phase === "read") setBadStockMessage(`이지어드민에서 상품명 확인 중... (${p.done}/${p.total}종)`);
          else if (p.phase === "write") setBadStockMessage(`상품명 변경 중... (${p.done}/${p.total}종)`);
        } catch { /* 진행도는 보조 정보라 실패해도 무시한다 */ }
      };
      const timer = setInterval(poll, 700);
      try {
        const res = await fetch(`${API}/barcode/bad-stock/rename-products`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...tabHeaders() },
          body: JSON.stringify({ dry_run: dryRun, recheck_all: recheckAll }),
        });
        if (handleUnauthorized(res)) return null;
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.detail || "상품명 변경 실패");
        if (data.need_session) throw new Error("이지어드민 세션이 만료되었거나 없습니다. PHPSESSID를 다시 등록해주세요.");
        return data;
      } finally {
        polling = false;
        clearInterval(timer);
      }
    };
    setBadStockRenaming(true);
    setBadStockMessage(recheckAll ? "전체 재조회: 이지어드민에서 모든 악성재고 상품명을 다시 읽는 중... (시간이 걸립니다)" : "이지어드민에서 상품명 확인 중...");
    try {
      const preview = await call(true);
      if (!preview) return;
      const targets = preview.items.filter((i) => i.status === "rename");
      const conflictItems = preview.items.filter((i) => i.status === "conflict");
      const conflictText = (list) => list.slice(0, 8).map((i) => `${i.old_name || i.code} [${(i.zones ?? []).map(badStockZoneLabel).join(", ")}]`).join("\n")
        + (list.length > 8 ? `\n... 외 ${list.length - 8}종` : "");
      // 변경 예정·변경 안 함(이미 변경/오류/충돌/제외) 목록을 탭으로 보여주고 진행 여부를 묻는다.
      const askConfirm = (canProceed) => new Promise((resolve) => {
        setRenameConfirmTab(canProceed ? "rename" : (preview.items.some((i) => i.status === "skip") ? "skip" : "excluded"));
        setRenameConfirm({ preview, canProceed, resolve });
      });
      if (!targets.length) {
        await askConfirm(false);
        setBadStockMessage(
          `변경할 상품이 없습니다. (이미 변경 ${preview.summary?.skip ?? 0} / 충돌 ${conflictItems.length} / 오류 ${preview.summary?.error ?? 0})`
          + (conflictItems.length ? ` 구역 충돌: ${conflictText(conflictItems).replace(/\n/g, " / ")}` : "")
        );
        return;
      }
      if (!(await askConfirm(true))) {
        setBadStockMessage("");
        return;
      }
      setBadStockMessage(`상품명 변경 중... (${targets.length}종)`);
      const data = await call(false);
      if (!data) return;
      const failed = data.items.filter((i) => i.status === "failed" || i.status === "error");
      const conflicts = data.items.filter((i) => i.status === "conflict");
      setBadStockMessage(
        `상품명 변경 완료 ${data.summary?.done ?? 0}종`
        + (failed.length ? `, 실패 ${failed.length}종: ${failed.slice(0, 5).map((i) => `${i.code}(${i.message})`).join(", ")}` : "")
        + (conflicts.length ? `, 구역 충돌로 제외 ${conflicts.length}종: ${conflicts.slice(0, 5).map((i) => `${i.old_name || i.code} [${(i.zones ?? []).map(badStockZoneLabel).join(", ")}]`).join(" / ")}` : "")
      );
    } catch (err) {
      setBadStockMessage(err.message || "상품명 변경 실패");
    } finally {
      setBadStockRenaming(false);
    }
  };

  const handleBadStockScan = async () => {
    const code = badStockScan.trim();
    if (!code) return;
    await addBadStock(code, "");
    setBadStockScan("");
  };

  const searchBadStock = async () => {
    const query = badStockQuery.trim();
    if (!query) {
      setBadStockRows([]);
      setBadStockMessage("검색어를 입력하세요.");
      return;
    }
    try {
      setBadStockSearching(true);
      setBadStockMessage("");
      const res = await fetch(`${API}/barcode/defect/search?q=${encodeURIComponent(query)}`, { headers: tabHeaders() });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "상품 검색 실패");
      setBadStockRows(data.rows || []);
      setBadStockMessage((data.rows || []).length ? `${data.rows.length}건 검색됨` : "검색 결과가 없습니다.");
    } catch (err) {
      setBadStockRows([]);
      setBadStockMessage(err.message || "상품 검색 실패");
    } finally {
      setBadStockSearching(false);
    }
  };

  const openAnomalyModal = () => {
    setShowAnomalyModal(true);
    setAnomalyMessage("");
    setInvoiceCancelProcessEnabled(false);
    setInvoiceStockOutEnabled(true);
    setInvoiceStockOutMemo("");
    setInvoiceNoInput("");
    setInvoicePreview(null);
    setInvoicePreviewError("");
    setInvoiceSteps([]);
    setShowAnomalyDone(false);
    setAnomalyComplete(null);
    fetchAnomalies();
  };

  // 조회된 송장의 첫 상품을 이상현상 등록 폼에 채운다 (송장삭제 후 바로 등록 가능)
  const fillAnomalyFormFromInvoice = () => {
    const products = invoicePreview?.products || [];
    if (!products.length) return;
    const p = products[0];
    const option = [p.color, p.size].filter(Boolean).join(" ");
    setAnomalyForm((prev) => ({
      ...prev,
      product_name: [p.name || p.product_id, option].filter(Boolean).join(" "),
      qty: products.reduce((sum, x) => sum + (Number(x.qty) || 0), 0) || 1,
    }));
  };

  const searchAnomalyProducts = async () => {
    const query = anomalySearchQuery.trim();
    if (!query) {
      setAnomalySearchRows([]);
      setAnomalyMessage("검색어를 입력하세요.");
      return;
    }
    try {
      setAnomalySearchLoading(true);
      setAnomalyMessage("");
      const res = await fetch(`${API}/barcode/defect/search?q=${encodeURIComponent(query)}`, { headers: tabHeaders() });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "상품 검색 실패");
      setAnomalySearchRows(data.rows || []);
      setAnomalyMessage((data.rows || []).length ? `${data.rows.length}건 검색됨` : "검색 결과가 없습니다.");
    } catch (err) {
      setAnomalySearchRows([]);
      setAnomalyMessage(err.message || "상품 검색 실패");
    } finally {
      setAnomalySearchLoading(false);
    }
  };

  const pickAnomalyProduct = (row) => {
    const name = String(row.base_name || "");
    const option = String(row.base_color || "");
    setAnomalyForm((prev) => ({
      ...prev,
      product_name: option && !name.includes(option) ? `${name} ${option}` : name,
    }));
    setAnomalySearchRows([]);
  };

  const callAnomalyApi = async (path, body) => {
    try {
      const res = await fetch(`${API}/barcode/anomaly/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...tabHeaders() },
        body: JSON.stringify(body),
      });
      if (handleUnauthorized(res)) return false;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "이상현상 처리 실패");
      setAnomalyList(data.items ?? []);
      return true;
    } catch (err) {
      setAnomalyMessage(err.message || "이상현상 처리 실패");
      return false;
    }
  };

  const addAnomaly = async () => {
    if (!anomalyForm.product_name.trim()) {
      setAnomalyMessage("상품을 검색해서 선택하세요.");
      return;
    }
    if (await callAnomalyApi("add", anomalyForm)) {
      setAnomalyForm({ registered_date: todayStr(), product_name: "", qty: 1, reason: "", normalized: false });
      setAnomalyMessage("이상현상을 등록했습니다.");
    }
  };

  const saveAnomalyEdit = async () => {
    if (!anomalyEdit) return;
    if (!anomalyEdit.product_name.trim()) {
      setAnomalyMessage("상품명은 필수입니다.");
      return;
    }
    const { id, registered_date, product_name, qty, reason } = anomalyEdit;
    if (await callAnomalyApi("update", { id, registered_date, product_name, qty, reason })) {
      setAnomalyEdit(null);
      setAnomalyMessage("수정했습니다.");
    }
  };

  const addDefectFromSearch = async (row) => {
    const code = row?.code || row?.base_code;
    if (!code) return;
    try {
      // 검색에서 고른 상품도 사진·사유를 입력해야 등록된다 (시트에서 확인할 때 수량이 반영됨).
      await openDefectSheetFor(code);
      setDefectSearchMessage(`사진·사유를 입력하면 등록됩니다: ${row.base_name || code}`);
    } catch (err) {
      setDefectSearchMessage(err.message || "불량 추가 실패");
    }
  };

  const fetchKimsungilList = async () => {
    try {
      const tab = defectTabRef.current;
      const res = await fetch(`${API}/barcode/kimsungil/list`, { headers: tabHeaders() });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "김승일 목록 조회 실패");
      if (tab !== defectTabRef.current) return; // 응답이 오는 사이 탭이 바뀌었으면 버린다
      setKimsungilList(data.kimsungil ?? []);
    } catch { /* ignore */ }
  };

  // A·B·C 탭에 등록된 불량관리 상품을 한 번에 검색한다 (상품명/옵션/코드, 공백은 AND).
  const searchUnified = async () => {
    const keywords = unifiedQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!keywords.length) { setUnifiedRows(null); return; }
    setUnifiedLoading(true);
    try {
      const lists = await Promise.all(defectTabs.map(async (tab) => {
        try {
          const res = await fetch(`${API}/barcode/kimsungil/list`, { headers: { ...getAuthHeaders(), "X-Defect-Tab": encodeURIComponent(tab) } });
          const data = await res.json().catch(() => ({}));
          return (data.kimsungil ?? []).map((item) => ({ ...item, tab }));
        } catch { return []; }
      }));
      setUnifiedRows(lists.flat().filter((item) => {
        const text = `${renderDefectLabel(item)} ${item.code || ""}`.toLowerCase();
        return keywords.every((kw) => text.includes(kw));
      }));
    } finally {
      setUnifiedLoading(false);
    }
  };

  // 잘못 들어간 항목을 다른 탭으로 옮긴다: 대상 탭에 수량만큼 추가한 뒤 원래 탭에서 제거.
  const moveUnifiedItem = async (item, toTab) => {
    const qty = Number(item.count) || 0;
    if (!item.code || qty <= 0 || toTab === item.tab) return;
    if (!window.confirm(`${renderDefectLabel(item)}\n${item.tab}탭 ${qty}개 → ${toTab}탭으로 옮길까요?`)) return;
    const post = (path, tab) => fetch(`${API}/barcode/kimsungil/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...getAuthHeaders(), "X-Defect-Tab": encodeURIComponent(tab) },
      body: JSON.stringify({ code: item.code }),
    });
    try {
      for (let i = 0; i < qty; i += 1) {
        const res = await post("add", toTab);
        if (!res.ok) throw new Error("대상 탭 추가 실패");
      }
      const res = await post("remove", item.tab);
      if (!res.ok) throw new Error("원래 탭 제거 실패 (대상 탭에는 이미 추가됨)");
      setKimsungilSearchMessage(`${item.tab}탭 → ${toTab}탭 이동 완료 (${qty}개)`);
    } catch (err) {
      setKimsungilSearchMessage(err.message || "탭 이동 실패");
    }
    await searchUnified();
    fetchKimsungilList();
  };

  const fetchKimsungilLog = async (code) => {
    try {
      setKimsungilLogLoading(true);
      setKimsungilLogMessage("");
      const qs = code ? `?code=${encodeURIComponent(code)}` : "";
      const res = await fetch(`${API}/barcode/kimsungil/log${qs}`, { headers: tabHeaders() });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "김승일 로그 조회 실패");
      setKimsungilLogRows(data.items ?? []);
      if (!(data.items ?? []).length) setKimsungilLogMessage("기록이 없습니다.");
    } catch (err) {
      setKimsungilLogRows([]);
      setKimsungilLogMessage(err.message || "김승일 로그 조회 실패");
    } finally {
      setKimsungilLogLoading(false);
    }
  };

  const openKimsungilLog = (code) => {
    setKimsungilLogCode(code);
    setShowKimsungilLog(true);
    fetchKimsungilLog(code);
  };

  const searchKimsungilByName = async () => {
    const query = kimsungilSearchQuery.trim();
    if (!query) {
      setKimsungilSearchRows([]);
      setKimsungilSearchMessage("검색어를 입력하세요.");
      return;
    }
    try {
      setKimsungilSearchLoading(true);
      setKimsungilSearchMessage("");
      const res = await fetch(`${API}/barcode/kimsungil/search?q=${encodeURIComponent(query)}`, { headers: tabHeaders() });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "김승일 검색 실패");
      setKimsungilSearchRows(data.rows || []);
      setKimsungilSearchMessage((data.rows || []).length ? `${data.rows.length}건 검색됨` : "검색 결과가 없습니다.");
    } catch (err) {
      setKimsungilSearchRows([]);
      setKimsungilSearchMessage(err.message || "김승일 검색 실패");
    } finally {
      setKimsungilSearchLoading(false);
    }
  };

  const addKimsungilFromSearch = async (row) => {
    const code = row?.code || row?.base_code;
    if (!code) return;
    try {
      const res = await fetch(`${API}/barcode/kimsungil/add`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...tabHeaders() },
        body: JSON.stringify({ code }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "김승일 추가 실패");
      setItems(data.items ?? items);
           setKimsungilList(data.kimsungil ?? kimsungilList);
      setKimsungilSearchMessage(`김승일 추가 완료: ${row.base_name || data.code}`);
      pushLog(`김승일 검색 추가: ${data.code} ${row.base_name || ""}`.trim());
    } catch (err) {
      setKimsungilSearchMessage(err.message || "김승일 추가 실패");
    }
  };

  // 제품확인 모드: 스캔한 상품코드를 원가베이스유에서 찾아 에이블리상품번호로 모바일 에이블리 상품 페이지를 연다.
  const handleProductCheck = async (value) => {
    const code = value.replace(/\s+/g, "").toUpperCase();
    try {
      const res = await fetch(`${API}/wonbe/search?${new URLSearchParams({ q: code, limit: "20" })}`, { headers: tabHeaders() });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "상품 조회 실패");
      const rows = (data.rows || []).filter((r) => String(r["상품코드"] || "").trim().toUpperCase() === code);
      if (rows.length === 0) { setProductCheckResult({ code, error: "원가베이스유에서 상품코드를 찾을 수 없습니다." }); playSound("bad"); return; }
      const row = rows.find((r) => String(r["에이블리상품번호"] || "").trim()) || rows[0];
      const goodsNo = String(row["에이블리상품번호"] || "").trim();
      const name = [row["상품명"], row["색상"], row["사이즈"]].filter(Boolean).join(" ");
      if (!goodsNo) { setProductCheckResult({ code, name, error: "에이블리 상품번호가 등록되어 있지 않습니다." }); playSound("bad"); return; }
      const url = `https://mobile.a-bly.com/goods/${encodeURIComponent(goodsNo)}`;
      setProductCheckResult({ code, name, url });
      window.open(url, "_blank", "noopener");
    } catch (err) {
      setProductCheckResult({ code, error: err.message || "상품 조회 실패" });
    }
  };

  const handleScan = async () => {
    const raw = scanText.trim();
    const value = toEnglishKey(raw);
    if (!value) return;
    if (productCheckMode) {
      setScanText("");
      await handleProductCheck(value);
      setTimeout(() => scanRef.current?.focus(), 0);
      return;
    }
    if (defectMode) { await handleDefectAdd(); return; }

    const toInvoice = !currentInvoice || isProbablyInvoice(value);
    const url = toInvoice ? `${API}/barcode/scan/invoice` : `${API}/barcode/scan/item`;
    const key = toInvoice ? "invoice" : "code";

    try {
      const res = await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json", ...tabHeaders() },
        body: JSON.stringify({ [key]: value }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "처리 실패");

      if (toInvoice) {
        if (data.ok === false && data.result === "NOT_FOUND") {
          pushLog(`송장 없음: ${value}`);
          setCurrentInvoice(null); setInvoiceDone(false); setItems([]);        } else {
          setCurrentInvoice(data.invoice); setInvoiceDone(false);
          setItems(data.items ?? []);          setDefectList(data.defects ?? defectList);
          setKimsungilList(data.kimsungil ?? kimsungilList);
          if (data.invoice_has_defect) playSound("invoiceDefect");
          if (data.post_shipment_cancelled) { playSound("postShipmentCancel"); pushLog(`⚠ 배송후취소 송장: ${data.invoice}`); }
          pushLog(`송장 SET: ${data.invoice}`);
        }
      } else {
        if (data.ok === false && data.result === "NO_INVOICE") {
          pushLog("송장이 먼저 필요합니다.");
          setCurrentInvoice(null); setInvoiceDone(false); setItems([]);        } else if (data.result === "TRUE") {
          pushLog(`TRUE  ${data.code} (잔여 ${data.remain}) ${data.name || ""} ${data.option || ""}`.trim());
          setItems(data.items ?? []); setDefectList(data.defects ?? defectList);
          setKimsungilList(data.kimsungil ?? kimsungilList);
          if (data.invoice_done) { playSound("invoiceDone"); pushLog(`송장 완료: ${data.invoice}`); setInvoiceDone(true); }
          else playSound("itemDone");
        } else {
          pushLog(`FALSE ${data.code} (잔여 ${data.remain}) ${data.name || ""} ${data.option || ""}`.trim());
          setDefectList(data.defects ?? defectList); setKimsungilList(data.kimsungil ?? kimsungilList); playSound("bad");
        }
      }
    } catch (err) { pushLog(`오류: ${err.message || ""}`.trim()); }
    finally { setScanText(""); setTimeout(() => scanRef.current?.focus(), 0); }
  };

  const renderItemLabel = (item) =>
    [item.name, item.option].filter(Boolean).join(" ").trim() || "(상품명 없음)";

  const renderDefectLabel = (item) =>
    [item.base_name || item.name, item.base_option || item.option].filter(Boolean).join(" ").trim()
    || item.code
    || "(상품명 없음)";

  const getDefectPreviewList = () => {
    const orderMap = new Map(defectRecentCodes.map((code, index) => [code, index]));
    return [...defectList].sort((a, b) => {
      const aOrder = orderMap.has(a.code) ? orderMap.get(a.code) : Number.MAX_SAFE_INTEGER;
      const bOrder = orderMap.has(b.code) ? orderMap.get(b.code) : Number.MAX_SAFE_INTEGER;
      if (aOrder !== bOrder) return aOrder - bOrder;
      return String(a.code || "").localeCompare(String(b.code || ""));
    });
  };

  const getDefectTotalCount = () =>
    defectList.reduce((sum, item) => sum + (Number(item.count) || 0), 0);

  // 불량 목록 중 "김승일 소환술"로 넘어온 항목이 있으면, 출고/오출/불량출력 등을
  // 실행하기 전에 그 항목까지 포함할지 물어본다. 소환술 항목이 없으면 물어볼 필요가
  // 없으니 그냥 포함(exclude=false)한다.
  const askExcludeKimsungil = () => {
    const summonedCount = defectList.filter((item) => (item.kimsungil_summon_qty || 0) > 0).length;
    if (summonedCount === 0) return false;
    return window.confirm(`불량 목록 중 김승일 소환술로 추가된 ${summonedCount}종은 이번 작업에서 제외할까요? (확인=제외, 취소=포함)`);
  };

  const getKimsungilTotalCount = () =>
    kimsungilList.reduce((sum, item) => sum + (Number(item.count) || 0), 0);

  // 원가베이스유 원가 × 수량. 원가를 못 찾은 상품은 합계에서 빠지므로 건수를 따로 센다.
  const getKimsungilTotalCost = () =>
    kimsungilList.reduce((sum, item) => sum + (Number(item.base_cost) || 0) * (Number(item.count) || 0), 0);
  const getKimsungilNoCostCount = () =>
    kimsungilList.filter((item) => !(Number(item.base_cost) > 0)).length;

  const calcTabStat = (list) => ({
    count: list.reduce((sum, item) => sum + (Number(item.count) || 0), 0),
    cost: list.reduce((sum, item) => sum + (Number(item.base_cost) || 0) * (Number(item.count) || 0), 0),
    noCost: list.filter((item) => !(Number(item.base_cost) > 0)).length,
  });

  // 현재 탭은 화면에 떠 있는 목록으로 바로 계산하고(수정 즉시 반영), 나머지 탭은 모달을 열 때 받아둔 값을 쓴다.
  const getTabStat = (tab) => (tab === defectTab ? calcTabStat(kimsungilList) : tabStats[tab] || null);
  const getAllTabsTotalCost = () =>
    defectTabs.reduce((sum, tab) => sum + (getTabStat(tab)?.cost || 0), 0);
  const getAllTabsNoCostCount = () =>
    defectTabs.reduce((sum, tab) => sum + (getTabStat(tab)?.noCost || 0), 0);

  const fetchAllTabStats = async () => {
    const entries = await Promise.all(defectTabs.map(async (tab) => {
      try {
        const res = await fetch(`${API}/barcode/kimsungil/list`, { headers: { ...getAuthHeaders(), "X-Defect-Tab": encodeURIComponent(tab) } });
        const data = await res.json().catch(() => ({}));
        return [tab, res.ok ? calcTabStat(data.kimsungil ?? []) : null];
      } catch { return [tab, null]; }
    }));
    setTabStats(Object.fromEntries(entries.filter(([, stat]) => stat)));
  };

  const fetchDefectList = async () => {
    try {
      const tab = defectTabRef.current;
      const res = await fetch(`${API}/barcode/defect/list`, { headers: tabHeaders() });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "불량 리스트 조회 실패");
      if (tab !== defectTabRef.current) return; // 응답이 오는 사이 탭이 바뀌었으면 버린다
      setDefectList(data.defects ?? []);
    } catch { /* ignore */ }
  };

  const handleDefectDec = async (code) => {
    try {
      const res = await fetch(`${API}/barcode/defect/dec`, {
        method: "POST", headers: { "Content-Type": "application/json", ...tabHeaders() },
        body: JSON.stringify({ code }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "불량 감소 실패");
      setDefectList(data.defects ?? []); setItems(data.items ?? items);    } catch (err) { pushLog(`불량 감소 실패: ${err.message || ""}`.trim()); }
  };

  const handleDefectRemove = async (code) => {
    const target = defectList.find((i) => i.code === code);
    const sentNote = target && purchaseStateOf(target) !== "none" ? "\n(이미 매입관리로 이동된 항목입니다. 매입관리 쪽 기록은 그대로 남습니다.)" : "";
    if (!window.confirm(`"${target ? renderDefectLabel(target) : code}" 불량을 목록에서 삭제할까요?${sentNote}`)) return;
    try {
      const res = await fetch(`${API}/barcode/defect/remove`, {
        method: "POST", headers: { "Content-Type": "application/json", ...tabHeaders() },
        body: JSON.stringify({ code }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "불량 삭제 실패");
      setDefectList(data.defects ?? []); setItems(data.items ?? items);    } catch (err) { pushLog(`불량 삭제 실패: ${err.message || ""}`.trim()); }
  };

  const handleKimsungilDec = async (code) => {
    try {
      const res = await fetch(`${API}/barcode/kimsungil/dec`, {
        method: "POST", headers: { "Content-Type": "application/json", ...tabHeaders() },
        body: JSON.stringify({ code }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "김승일 감소 실패");
      setKimsungilList(data.kimsungil ?? []); setItems(data.items ?? items);    } catch (err) { pushLog(`김승일 감소 실패: ${err.message || ""}`.trim()); }
  };

  const handleKimsungilRemove = async (code) => {
    try {
      const res = await fetch(`${API}/barcode/kimsungil/remove`, {
        method: "POST", headers: { "Content-Type": "application/json", ...tabHeaders() },
        body: JSON.stringify({ code }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "김승일 삭제 실패");
      setKimsungilList(data.kimsungil ?? []); setItems(data.items ?? items);    } catch (err) { pushLog(`김승일 삭제 실패: ${err.message || ""}`.trim()); }
  };

  // 소환술로 불량에 들어온 항목을 A/B/C 탭 전체에서 모아 탭별·코드 오름차순으로 보여준다.
  const fetchSummonedAllTabs = async () => {
    try {
      const results = await Promise.all(defectTabs.map(async (tab) => {
        const res = await fetch(`${API}/barcode/defect/list`, { headers: { ...getAuthHeaders(), "X-Defect-Tab": encodeURIComponent(tab) } });
        if (handleUnauthorized(res)) return { tab, rows: [] };
        const data = await res.json().catch(() => ({}));
        const rows = (data.defects ?? [])
          .filter((d) => (d.kimsungil_summon_qty || 0) > 0)
          .sort((a, b) => String(a.code || "").localeCompare(String(b.code || "")));
        return { tab, rows };
      }));
      setSummonedByTab(results);
    } catch { /* ignore */ }
  };

  useEffect(() => {
    if (showDefectList) fetchSummonedAllTabs();
  }, [showDefectList, defectList]);

  // 불량 리스트를 열 때(탭 전환 포함) 매입관리 이동 상태를 읽어 표시한다 (조회만, 기록은 건드리지 않음).
  useEffect(() => {
    if (showDefectList) refreshPurchaseSent(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showDefectList, defectTab, defectList]);

  const handleKimsungilRevert = async (tab, code) => {
    if (!window.confirm(`${tab}탭 ${code} 소환 수량을 김승일 리스트로 되돌릴까요?`)) return;
    try {
      const res = await fetch(`${API}/barcode/kimsungil/revert-from-defect`, {
        method: "POST", headers: { "Content-Type": "application/json", ...getAuthHeaders(), "X-Defect-Tab": encodeURIComponent(tab) },
        body: JSON.stringify({ code }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "김승일 되돌리기 실패");
      if (tab === defectTabRef.current) {
        setDefectList(data.defects ?? []);
        setKimsungilList(data.kimsungil ?? []);
      }
      pushLog(`김승일 되돌리기(${tab}탭): ${code} ${data.reverted_qty}개`);
      fetchSummonedAllTabs();
    } catch (err) {
      alert(err.message || "김승일 되돌리기 실패");
    }
  };

  // "불량 불러오기": 어느 탭의 김승일 리스트를 불러올지 고른다. 탭별로 불러올 수 있는(입고된) 종/개수를 함께 보여준다.
  const openKimsungilSummonPicker = async () => {
    const tabs = defectTabs;
    setKimsungilSummonPicker({ tabs, counts: Object.fromEntries(tabs.map((t) => [t, null])) });
    const counts = Object.fromEntries(tabs.map((t) => [t, null]));
    await Promise.all(tabs.map(async (tab) => {
      try {
        const res = await fetch(`${API}/barcode/kimsungil/list`, { headers: { ...getAuthHeaders(), "X-Defect-Tab": encodeURIComponent(tab) } });
        const data = await res.json().catch(() => ({}));
        // KDG 탭은 입고 파일 없이도 목록 전체를 불러올 수 있다 (서버와 같은 규칙).
        const ready = (data.kimsungil ?? []).filter((i) => tab === KDG_TAB || (i.incoming_qty || 0) > 0);
        counts[tab] = { kinds: ready.length, total: ready.reduce((s, i) => s + (Number(i.count) || 0), 0) };
      } catch {
        counts[tab] = "?";
      }
      setKimsungilSummonPicker((prev) => (prev ? { ...prev, counts: { ...counts } } : prev));
    }));
  };

  // 한 탭의 김승일 리스트를 불량으로 소환한다. 케이디지(KDG) 상품은 서버가 알아서 KDG 탭으로 보낸다. 실패하면 throw.
  // 탭별 "불러온 불량 수량" 스냅샷 { code: qty }. 불러오기 전/후를 비교해 이번에 들어온 것만 골라낸다.
  const fetchSummonQtyMap = async (tab) => {
    try {
      const res = await fetch(`${API}/barcode/defect/list`, { headers: { ...getAuthHeaders(), "X-Defect-Tab": encodeURIComponent(tab) } });
      const data = await res.json().catch(() => ({}));
      return Object.fromEntries((data.defects ?? []).map((d) => [d.code, Number(d.kimsungil_summon_qty) || 0]));
    } catch {
      return {};
    }
  };

  const summonOneTab = async (tab) => {
    const watchTabs = [...new Set([tab, KDG_TAB])];
    const before = Object.fromEntries(await Promise.all(watchTabs.map(async (t) => [t, await fetchSummonQtyMap(t)])));
    const res = await fetch(`${API}/barcode/kimsungil/summon-to-defect`, {
      method: "POST", headers: { ...getAuthHeaders(), "X-Defect-Tab": encodeURIComponent(tab) },
    });
    if (handleUnauthorized(res)) throw new Error("로그인이 필요합니다.");
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.detail || "김승일 소환술 실패");
    if (data.tabs) applyTabsConfig(data.tabs); // KDG 탭이 새로 생겼으면 탭 목록에 반영
    pushLog(`김승일 소환술(${tab}탭): ${data.moved_count}종 ${data.moved_total}개 불량 이동${data.kdg_moved_count ? ` (KDG 탭 ${data.kdg_moved_count}종)` : ""}`);
    // 서버가 이번 이동분(moved_items)을 안 주면(예전 서버) 전/후 수량 차이로 직접 계산한다.
    if (!Array.isArray(data.moved_items) && (data.moved_count || 0) > 0) {
      const movedItems = [];
      for (const t of watchTabs) {
        const after = await fetchSummonQtyMap(t);
        for (const [code, qty] of Object.entries(after)) {
          const diff = qty - (before[t]?.[code] || 0);
          if (diff > 0) movedItems.push({ code, qty: diff, tab: t });
        }
      }
      data.moved_items = movedItems;
    }
    return data;
  };

  // 이번에 불러온(소환된) 불량만 탭별로 모아 실물 이중체크 모달에 넘긴다.
  // 예전에 불러온 다른 탭(A) 목록이 다음 탭(B) 매칭에 섞이지 않도록 서버가 돌려준 "이번 이동분"만 쓴다.
  const openDefectMatch = async (movedItems) => {
    const byTab = new Map();
    for (const item of movedItems || []) {
      const qty = Number(item?.qty) || 0;
      if (!item?.code || qty <= 0) continue;
      const tab = item.tab || KDG_TAB;
      if (!byTab.has(tab)) byTab.set(tab, new Map());
      const codes = byTab.get(tab);
      codes.set(item.code, (codes.get(item.code) || 0) + qty);
    }
    if (byTab.size === 0) return;
    const groups = await Promise.all([...byTab.entries()].map(async ([tab, codes]) => {
      let lookup = {};
      try {
        const res = await fetch(`${API}/barcode/defect/list`, { headers: { ...getAuthHeaders(), "X-Defect-Tab": encodeURIComponent(tab) } });
        const data = await res.json().catch(() => ({}));
        lookup = Object.fromEntries((data.defects ?? []).map((d) => [d.code, d]));
      } catch { /* 이름을 못 가져와도 코드로 매칭은 가능 */ }
      const rows = [...codes.entries()]
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
        .map(([code, total]) => ({ code, label: lookup[code] ? renderDefectLabel(lookup[code]) : code, total }));
      return { tab, rows };
    }));
    // 저장된(아직 안 끝난) 매칭이 있으면 거기에 이어 붙인다. 이미 찍은 기록은 그대로 둔다.
    const prev = defectMatchSession;
    const rowsByTab = { ...(prev?.rowsByTab ?? {}) };
    const doneTabs = { ...(prev?.doneTabs ?? {}) };
    for (const g of groups) {
      const list = [...(rowsByTab[g.tab] ?? [])];
      for (const row of g.rows) {
        const idx = list.findIndex((r) => r.code === row.code);
        if (idx >= 0) list[idx] = { ...list[idx], total: list[idx].total + row.total };
        else list.push({ key: `${g.tab}|${row.code}`, tab: g.tab, code: row.code, label: row.label, total: row.total });
      }
      rowsByTab[g.tab] = list;
      delete doneTabs[g.tab]; // 새로 불러온 게 생긴 탭은 다시 매칭해야 한다
    }
    const order = [...defectTabs, KDG_TAB];
    const rank = (t) => (order.indexOf(t) + 1 || 999);
    const tabs = Object.keys(rowsByTab).sort((a, b) => rank(a) - rank(b));
    const firstNew = tabs.find((t) => groups.some((g) => g.tab === t));
    saveDefectMatchSession({
      tabs,
      rowsByTab,
      scanned: prev?.scanned ?? {},
      doneTabs,
      activeTab: firstNew || tabs[0],
    });
    setDefectMatchOpen(true);
  };

  // 매칭 모달에서 실물이 없는 불량을 지우면 해당 탭 불량 목록에서도 그 수량만큼 뺀다.
  const removeUnmatchedDefect = async (tab, code, qty) => {
    const res = await fetch(`${API}/barcode/defect/remove-summoned`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...getAuthHeaders(), "X-Defect-Tab": encodeURIComponent(tab) },
      body: JSON.stringify({ code, qty }),
    });
    if (handleUnauthorized(res)) throw new Error("로그인이 필요합니다.");
    if (res.status === 404) throw new Error("서버가 아직 예전 버전이라 삭제할 수 없습니다.\n서버(백엔드)를 다시 켠 뒤 시도해 주세요.");
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.detail || "불량 삭제 실패");
    pushLog(`불량 불러오기 미매칭 삭제(${tab}탭): ${code} ${data.removed_qty ?? qty}개`);
    fetchDefectList();
    fetchSummonedAllTabs();
    return data;
  };

  const refreshAfterSummon = (movedItems = []) => {
    fetchDefectList();
    fetchKimsungilList();
    fetchSummonedAllTabs();
    setKimsungilSummonPicker(null);
    if (movedItems.length > 0) openDefectMatch(movedItems).catch(() => {});
  };

  const handleKimsungilSummon = async (tab) => {
    const info = kimsungilSummonPicker?.counts?.[tab];
    if (!info || info === "?" || info.kinds === 0) { alert(tab === KDG_TAB ? "KDG 탭 김승일 리스트가 비어 있습니다." : `${tab}탭에는 입고된(배지가 뜬) 김승일 상품이 없습니다.`); return; }
    if (!window.confirm(`${tab}탭 김승일 ${info.kinds}종 ${info.total}개를 ${tab}탭 불량 목록으로 소환하겠습니까?\n(케이디지 상품은 KDG 탭으로 갑니다)`)) return;
    try {
      setKimsungilSummonLoading(true);
      const summoned = await summonOneTab(tab);
      refreshAfterSummon(summoned?.moved_items ?? []);
    } catch (err) {
      alert(err.message || "김승일 소환술 실패");
      pushLog(`김승일 소환술 실패: ${err.message || ""}`.trim());
    } finally {
      setKimsungilSummonLoading(false);
    }
  };

  // 전체 선택: 불러올 상품이 있는 모든 탭을 차례로 소환한다 (공유 저장소라 동시에 보내지 않고 하나씩).
  const handleKimsungilSummonAll = async () => {
    const counts = kimsungilSummonPicker?.counts ?? {};
    const targets = (kimsungilSummonPicker?.tabs ?? []).filter((t) => counts[t] && counts[t] !== "?" && counts[t].kinds > 0);
    if (targets.length === 0) { alert("입고된(배지가 뜬) 김승일 상품이 없습니다."); return; }
    const kinds = targets.reduce((s, t) => s + counts[t].kinds, 0);
    const total = targets.reduce((s, t) => s + counts[t].total, 0);
    if (!window.confirm(`${targets.join(", ")}탭 김승일 ${kinds}종 ${total}개를 각 탭 불량 목록으로 소환하겠습니까?\n(케이디지 상품은 KDG 탭으로 갑니다)`)) return;
    setKimsungilSummonLoading(true);
    let done = 0;
    const movedItems = [];
    try {
      for (const tab of targets) {
        const summoned = await summonOneTab(tab);
        movedItems.push(...(summoned?.moved_items ?? []));
        done += 1;
      }
    } catch (err) {
      alert(`${err.message || "김승일 소환술 실패"}${done ? ` (${done}/${targets.length}개 탭은 이미 불러옴)` : ""}`);
      pushLog(`김승일 소환술 전체 실패: ${err.message || ""}`.trim());
    } finally {
      setKimsungilSummonLoading(false);
      refreshAfterSummon(movedItems);
    }
  };

  const handleDefectExport = async () => {
    if (defectList.length === 0) { alert("내보낼 불량 목록이 없습니다."); return; }
    try {
      const res = await fetch(`${API}/barcode/defect/export`, { headers: tabHeaders() });
      if (handleUnauthorized(res)) return;
      if (!res.ok) {
        let message = "불량 목록 내보내기 실패";
        try { const data = await res.json(); message = data?.detail || message; }
        catch { const text = await res.text(); if (text) message = text; }
        throw new Error(message);
      }
      const blob = await res.blob();
      const fallback = `defects_${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "")}.csv`;
      const filename = getDownloadFilename(res, fallback);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url; link.download = filename;
      document.body.appendChild(link); link.click(); link.remove();
      URL.revokeObjectURL(url);
      pushLog(`불량 목록 내보내기 완료: ${filename}`);
    } catch (err) {
      alert(err.message || "불량 목록 내보내기 실패");
      pushLog(`불량 목록 내보내기 실패: ${err.message || ""}`.trim());
    }
  };

  const fetchDefectBase = useCallback(async () => {
    try {
      setDefectBaseLoading(true);
      setDefectBaseMessage("");
      const res = await fetch(`${API}/barcode/defect/base`, { headers: tabHeaders() });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "불량베이스 불러오기 실패");
      setDefectBaseHeaders(data.headers ?? ["상품코드", "상품명", "공급처", "공급처상품명", "색상 사이즈", "주소", "표시형 상품명"]);
      setDefectBaseRows(data.rows ?? []);
      setDefectBasePath(data.path ?? "");
      setDefectBaseMessage(`불량베이스 ${data.rows?.length ?? 0}건 로드 완료`);
    } catch (err) {
      setDefectBaseMessage(err.message || "불량베이스 불러오기 실패");
    } finally {
      setDefectBaseLoading(false);
    }
  }, []);

  const updateDefectBaseCell = (rowIndex, colIndex, value) => {
    setDefectBaseRows((prev) =>
      prev.map((row, idx) => {
        if (idx !== rowIndex) return row;
        const nextValues = Array.isArray(row.values) ? [...row.values] : ["", "", "", "", "", "", ""];
        while (nextValues.length < 7) nextValues.push("");
        nextValues[colIndex] = value;
        return { ...row, values: nextValues };
      })
    );
  };

  const addDefectBaseRow = () => {
    setDefectBaseRows((prev) => [...prev, { row_index: null, values: ["", "", "", "", "", "", ""] }]);
    setDefectBaseMessage("새 행을 추가했습니다.");
  };

  const removeDefectBaseRow = (rowIndex) => {
    setDefectBaseRows((prev) => prev.filter((_, idx) => idx !== rowIndex));
  };

  const saveDefectBase = async () => {
    try {
      setDefectBaseSaving(true);
      setDefectBaseMessage("");
      const res = await fetch(`${API}/barcode/defect/base`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...tabHeaders() },
        body: JSON.stringify({
          rows: defectBaseRows.map((row) => ({
            values: Array.isArray(row.values) ? row.values.slice(0, 7) : ["", "", "", "", "", "", ""],
          })),
        }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "불량베이스 저장 실패");
      setDefectBaseHeaders(data.headers ?? defectBaseHeaders);
      setDefectBaseRows(data.rows ?? []);
      setDefectBasePath(data.path ?? defectBasePath);
      setDefectBaseMessage(`불량베이스 저장 완료 (${data.rows?.length ?? 0}건)`);
    } catch (err) {
      setDefectBaseMessage(err.message || "불량베이스 저장 실패");
    } finally {
      setDefectBaseSaving(false);
    }
  };

  const handleOrdersXlsDownload = async () => {
    try {
      const res = await fetch(`${API}/barcode/orders/export-xls`, { headers: tabHeaders() });
      if (handleUnauthorized(res)) return;
      if (!res.ok) {
        let message = "주문 목록 다운로드 실패";
        try { const data = await res.json(); message = data?.detail || message; }
        catch { const text = await res.text(); if (text) message = text; }
        throw new Error(message);
      }
      const blob = await res.blob();
      const fallback = `extended_orders_${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "")}.xls`;
      const filename = getDownloadFilename(res, fallback);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      pushLog(`확장주문검색 목록 다운로드 완료: ${filename}`);
    } catch (err) {
      alert(err.message || "주문 목록 다운로드 실패");
      pushLog(`확장주문검색 목록 다운로드 실패: ${err.message || ""}`.trim());
    }
  };

  const handleDefectPrint = async () => {
    try {
      // KDG 탭에서 누르면 KDG 탭 것만, 그 외 탭에서 누르면 KDG를 뺀 나머지 탭 전체를 코드별로 합쳐 출력한다.
      const printTabs = defectTabRef.current === KDG_TAB
        ? [KDG_TAB]
        : defectTabs.filter((tab) => tab !== KDG_TAB);
      const perTab = await Promise.all(printTabs.map(async (tab) => {
        const res = await fetch(`${API}/barcode/defect/list`, { headers: { ...getAuthHeaders(), "X-Defect-Tab": encodeURIComponent(tab) } });
        if (handleUnauthorized(res)) return null;
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.detail || "불량 리스트 조회 실패");
        return data.defects ?? [];
      }));
      if (perTab.some((list) => list === null)) return;
      // 소환술 항목이 있으면 포함할지 먼저 묻는다. count = 일반 불량 + 소환술 수량이라
      // 포함하면 count를, 제외하면 일반 불량(normal_qty)만 모든 탭에 걸쳐 코드별로 합산한다.
      const allItems = perTab.flat();
      const summonedCount = new Set(
        allItems.filter((item) => (Number(item.kimsungil_summon_qty) || 0) > 0).map((item) => item.code)
      ).size;
      const includeSummon = summonedCount === 0
        || window.confirm(`불량관리 목록 ${summonedCount}종이 있습니다. 불량출력에 포함할까요? (확인=포함, 취소=제외)`);
      const merged = new Map();
      allItems.forEach((item) => {
        const qty = includeSummon
          ? Number(item.count) || 0
          : Number(item.normal_qty ?? item.count) || 0;
        if (qty <= 0) return;
        const prev = merged.get(item.code);
        if (prev) prev.count += qty;
        else merged.set(item.code, { ...item, count: qty });
      });
      const sourceList = [...merged.values()];
      if (sourceList.length === 0) {
        alert("보낼 불량 항목이 없습니다.");
        return;
      }
      const rows = sourceList
        .map((item) => {
          // 상품명 앞 접두어(첫 단어)를 괄호로 묶어 거래처상품명 앞에 붙인다. 예: (휘민)코에셔츠
          const product = String(item.base_product || "").trim();
          const prefix = String(item.base_name || "").trim().split(/\s+/)[0] || "";
          return { item, product, prefix };
        })
        .map(({ item, product, prefix }) => ({
          vendor: String(item.base_vendor || "").trim(),
          name: product && prefix ? `(${prefix})${product}` : product,
          color: String(item.base_color || "").trim(),
          qty: Number(item.count || 0),
          addr: String(item.base_addr || "").trim(),
        }))
        .filter((row) => row.vendor || row.addr || row.name);

      if (!rows.length) {
        throw new Error("불량출력으로 보낼 유효한 데이터가 없습니다.");
      }

      const res = await fetch(`${API}/noye-kimsungil/bulyang/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...tabHeaders() },
        body: JSON.stringify({ rows }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "불량출력 전송 실패");

      localStorage.setItem("activeTab", "noye-kimsungil");
      localStorage.setItem(
        "noye-kimsungil-bulyang-handoff",
        JSON.stringify({
          session_id: data.session_id,
          groups: data.groups || [],
          total: data.total || 0,
          created_at: Date.now(),
        })
      );
      window.location.reload();
    } catch (err) {
      alert(err.message || "불량출력 전송 실패");
      pushLog(`불량출력 전송 실패: ${err.message || ""}`.trim());
    }
  };

  // 매입관리로 넘길 수량: normal=직접 찍은 불량만, summon=김승일 소환술로 들어온 것만, all=둘 다(count).
  const purchaseQty = (item, mode) => {
    if (mode === "normal") return Number(item.normal_qty ?? item.count) || 0;
    if (mode === "summon") return Number(item.kimsungil_summon_qty) || 0;
    return Number(item.count) || 0;
  };

  // 현재 불량 목록의 종류별(직접 찍은 불량 / 소환술) 수량
  const purchaseParts = (item) => ({
    normal: Number(item.normal_qty ?? item.count) || 0,
    summon: Number(item.kimsungil_summon_qty) || 0,
  });
  const allPurchaseParts = () => {
    const parts = {};
    defectList.forEach((item) => { parts[String(item.code || "").trim()] = purchaseParts(item); });
    return parts;
  };
  // 선택 범위에서 아직 매입관리로 안 보낸 신규 수량 (이미 보낸 수량은 제외)
  const purchaseNewQty = (item, scope, sent = purchaseSent) => {
    const gross = purchaseParts(item);
    const done = sent[String(item.code || "").trim()] || {};
    const kinds = scope === "normal" ? ["normal"] : scope === "summon" ? ["summon"] : ["normal", "summon"];
    return kinds.reduce((sum, k) => sum + Math.max(gross[k] - (Number(done[k]) || 0), 0), 0);
  };
  const selectAllNew = (scope, sent) => {
    const selected = {};
    defectList.forEach((item) => { if (purchaseNewQty(item, scope, sent) > 0) selected[item.code] = true; });
    setPurchaseSelected(selected);
  };

  // 서버에 기록된 "이미 매입관리로 보낸 수량"을 현재 불량 목록과 맞춰 가져온다.
  const refreshPurchaseSent = async (reconcile = true) => {
    let sent = {};
    try {
      const res = await fetch(`${API}/noye-kimsungil/defect-purchase/sent-state`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ tab: defectTabRef.current, parts: allPurchaseParts(), reconcile }),
      });
      if (handleUnauthorized(res)) return null;
      const data = await res.json().catch(() => ({}));
      if (res.ok) sent = data.sent || {};
    } catch {
      sent = {};
    }
    setPurchaseSent(sent);
    return sent;
  };

  const openPurchasePicker = async () => {
    setPurchaseScope("all");
    setPurchaseSelected({});
    setPurchaseModePicker(true);
    const sent = await refreshPurchaseSent();
    if (sent) selectAllNew("all", sent);
  };

  // 불량 리스트 항목의 매입관리 이동 상태: none | partial | done (직접 찍은 불량 기준)
  const purchaseStateOf = (item) => {
    const gross = Number(item.normal_qty ?? item.count) || 0;
    const done = Number((purchaseSent[String(item.code || "").trim()] || {}).normal) || 0;
    if (gross > 0 && done >= gross) return "done";
    if (done > 0) return "partial";
    return "none";
  };

  // 선택한 범위·항목만 거래처 불량 매입 관리에 등록하고, 항목별 결과를 팝업으로 보여준다.
  const handleDefectPurchaseManager = async () => {
    if (purchaseSending) return;
    const targets = defectList.filter((item) => purchaseSelected[item.code] && purchaseNewQty(item, purchaseScope) > 0);
    if (targets.length === 0) { alert("보낼 항목을 선택해 주세요."); return; }
    setPurchaseSending(true);
    try {
      const counts = {};
      const labelByCode = {};
      const partsToSend = {};
      targets.forEach((item) => {
        const code = String(item.code || "").trim();
        counts[code] = (counts[code] || 0) + purchaseNewQty(item, purchaseScope);
        labelByCode[code] = renderDefectLabel(item);
        const gross = purchaseParts(item);
        partsToSend[code] = {
          normal: purchaseScope === "summon" ? 0 : gross.normal,
          summon: purchaseScope === "normal" ? 0 : gross.summon,
        };
      });
      const res = await fetch(`${API}/barcode/defect/purchase-manager-handoff`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...tabHeaders() },
        body: JSON.stringify({ counts }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "매입관리 데이터 변환에 실패했습니다.");
      const rows = data.rows || [];
      const unmatched = new Set((data.unmatched_codes || []).map((c) => String(c)));

      const statusByCode = {};
      let addError = "";
      if (rows.length > 0) {
        try {
          const addRes = await fetch(`${API}/noye-kimsungil/defect-purchase/add`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...getAuthHeaders() },
            body: JSON.stringify({ rows, tab: defectTabRef.current, parts: partsToSend }),
          });
          if (handleUnauthorized(addRes)) return;
          const addData = await addRes.json().catch(() => ({}));
          if (!addRes.ok) throw new Error(addData?.detail || "등록 실패");
          (addData.results || []).forEach((r) => { statusByCode[r.code] = r; });
        } catch (err) {
          addError = err.message || "등록 실패";
        }
      }

      const items = Object.keys(counts).map((code) => {
        const label = labelByCode[code] || code;
        const qty = counts[code];
        if (unmatched.has(code)) return { code, label, qty, state: "fail", note: "원가베이스에 없는 상품코드" };
        if (addError) return { code, label, qty, state: "fail", note: addError };
        const st = statusByCode[code];
        if (st?.status === "added") {
          const partial = st.already > 0 ? ` (신규 ${st.qty}개만 · 기존 ${st.already}개는 이미 이동됨)` : "";
          return { code, label, qty: st.qty ?? qty, state: "ok", note: `${st.vendor || ""} · ${Math.round(st.amount || 0).toLocaleString("ko-KR")}원${partial}` };
        }
        if (st?.status === "skipped") return { code, label, qty, state: "skip", note: "이미 매입관리로 이동됨 (신규 수량 없음)" };
        return { code, label, qty, state: "fail", note: "등록되지 않음" };
      });
      setPurchaseModePicker(false);
      setPurchaseResult({ items });
      refreshPurchaseSent(false);
      items.filter((i) => i.state === "fail").forEach((i) => pushLog(`매입관리 전송 실패: ${i.label} (${i.note})`));
    } catch (err) {
      alert(err.message || "매입관리 전송에 실패했습니다.");
      pushLog(`매입관리 전송 실패: ${err.message || ""}`.trim());
    } finally {
      setPurchaseSending(false);
    }
  };

  const openDefectPurchaseMenu = () => {
    localStorage.setItem("topMode", "home");
    localStorage.setItem("activeTab", "noye-kimsungil");
    localStorage.setItem("noye-kimsungil-active-tab", "defect-purchase");
    // 모바일 전용 화면(/bacode)은 메인 앱이 아니라서 reload 만 하면 노예김승일 탭으로 못 간다 → 루트로 이동.
    const onMobileOnlyRoute = ["/bacode", "/barcode"].includes((window.location.pathname || "").replace(/\/+$/, "").toLowerCase());
    if (onMobileOnlyRoute) window.location.assign("/");
    else window.location.reload();
  };

  const handleDefectExportAndOchuul = async (excludeKimsungilOverride) => {
    if (defectList.length === 0) { alert("불량 목록이 없습니다."); return; }
    const total = getDefectTotalCount();
    if (!window.confirm(`불량 목록 ${defectList.length}종 합계 ${total}개를 출고처리 후 오출 차감하겠습니까?`)) return;
    const excludeKimsungil = excludeKimsungilOverride ?? askExcludeKimsungil();

    try {
      setDefectEzadminLoading(true); setDefectEzadminMsg("EZAdmin 출고처리 중...");
      const res = await fetch(`${API}/barcode/defect/export-to-ezadmin`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...tabHeaders() },
        body: JSON.stringify({ exclude_kimsungil_summon: excludeKimsungil }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (data?.need_session) {
        setDefectEzadminMsg("");
        openEzadminModal(() => handleDefectExportAndOchuul(excludeKimsungil));
        return;
      }
      if (!data?.ok) {
        setDefectEzadminMsg(data?.error || "출고처리 실패");
        return;
      }
      setDefectEzadminMsg(`출고처리 완료 (${data.count ?? 0}건)`);
    } catch (err) {
      setDefectEzadminMsg(`출고처리 실패: ${err.message || ""}`);
      return;
    } finally {
      setDefectEzadminLoading(false);
    }

    try {
      setOchuulLoading(true);
      setOchuulResult(null);
      const res = await fetch(`${API}/barcode/defect/ochuul-minus`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...tabHeaders() },
        body: JSON.stringify({ exclude_kimsungil_summon: excludeKimsungil }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "오출내리기 실패");
      setOchuulResult(data);
      pushLog(`오출내리기 완료: ${data.matched}건 차감`);
      const doneAt = new Date().toLocaleString("sv-SE").slice(0, 16);
      setDefectOchuulDoneAt(doneAt);
      try { localStorage.setItem("defectExportOchuulDoneAt", doneAt); } catch { /* ignore */ }
    } catch (err) {
      alert(err.message || "오출내리기 실패");
      pushLog(`오출내리기 실패: ${err.message || ""}`.trim());
    } finally {
      setOchuulLoading(false);
    }
  };

  const invoicePostJson = async (url, body) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...tabHeaders() },
      body: JSON.stringify(body),
    });
    if (handleUnauthorized(res)) throw Object.assign(new Error("인증 만료"), { silent: true });
    const data = await res.json().catch(() => ({}));
    if (data?.need_session) throw Object.assign(new Error("이지어드민 세션 필요"), { needSession: true });
    if (!res.ok || data?.ok === false) throw new Error(data?.detail || "요청 실패");
    return data;
  };

  const fetchInvoicePreview = async (invoiceNo) => {
    const data = await invoicePostJson(`${API}/barcode/invoice/preview`, { invoice_no: invoiceNo });
    if (!data.ezadmin_found || !data.pack) throw new Error("이지어드민 주문을 찾지 못했습니다.");
    if (!data.ably_found || !(data.products || []).length) throw new Error("에이블리 주문상품 정보를 찾지 못했습니다.");
    return data;
  };

  // 조회(preview) 이후: 거래취소·송장삭제 → (선택) 재고출고 → 에이블리 롤백
  const runInvoicePipeline = async (preview, includeStockOut, stockOutMemo, includeCancelProcess, onStep) => {
    onStep?.(0, "running");
    await invoicePostJson(`${API}/barcode/invoice/cancel`, { pack: preview.pack });
    onStep?.(0, "done");

    let idx = 1;
    if (includeCancelProcess) {
      onStep?.(idx, "running");
      await invoicePostJson(`${API}/barcode/invoice/cancel-pack`, {
        pack: preview.pack,
        prd_seqs: preview.prd_seqs || [],
      });
      onStep?.(idx, "done");
      idx += 1;
    }
    if (includeStockOut) {
      onStep?.(idx, "running");
      const stockData = await invoicePostJson(`${API}/barcode/invoice/stock-out`, {
        products: preview.products,
        invoice_no: preview.invoice_no,
        memo: stockOutMemo,
      });
      const stockOk = stockData.results?.every((r) => r.ok) ?? true;
      onStep?.(idx, stockOk ? "done" : "error", stockOk ? undefined : "일부 상품 출고 실패");
      if (!stockOk) throw new Error("일부 상품 재고 출고처리에 실패했습니다.");
      idx += 1;
    }

    onStep?.(idx, "running");
    await invoicePostJson(`${API}/barcode/invoice/rollback`, { sno_list: preview.sno_list });
    onStep?.(idx, "done");
  };

  const openInvoiceDeleteModal = () => {
    setInvoiceBulkMode(false);
    setInvoiceStockOutEnabled(true);
    setInvoiceStockOutMemo("");
    setInvoiceCancelProcessEnabled(false);
    setInvoiceNoInput("");
    setInvoicePreview(null);
    setInvoicePreviewError("");
    setInvoiceSteps([]);
    setInvoiceExecuting(false);
    setInvoiceBulkInput("");
    setInvoiceBulkResults([]);
    setInvoiceBulkRunning(false);
    setShowInvoiceModal(true);
  };

  const handleInvoicePreview = async () => {
    const invoiceNo = invoiceNoInput.trim();
    if (!invoiceNo) { setInvoicePreviewError("송장번호를 입력하세요."); return; }
    setInvoicePreviewLoading(true);
    setInvoicePreviewError("");
    setInvoicePreview(null);
    setInvoiceSteps([]);
    try {
      const res = await fetch(`${API}/barcode/invoice/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...tabHeaders() },
        body: JSON.stringify({ invoice_no: invoiceNo }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (data?.need_session) { openEzadminModal(handleInvoicePreview); return; }
      if (!res.ok || !data.ok) throw new Error(data?.detail || "조회 실패");
      setInvoicePreview(data);
    } catch (err) {
      setInvoicePreviewError(err.message || "조회 실패");
    } finally {
      setInvoicePreviewLoading(false);
    }
  };

  const handleInvoiceExecute = async () => {
    if (!invoicePreview) return;
    if (!window.confirm(
      `송장번호 ${invoicePreview.invoice_no}를 삭제${invoiceCancelProcessEnabled ? "하고 주문을 취소처리" : ""}${invoiceStockOutEnabled ? "하고 재고를 출고처리" : ""}한 뒤 발송상태를 되돌리겠습니까?`
    )) return;

    setInvoiceExecuting(true);
    const labels = getInvoiceStepLabels(invoiceStockOutEnabled, invoiceCancelProcessEnabled);
    setInvoiceSteps(labels.map((label) => ({ label, status: "pending" })));

    const setStepStatus = (idx, status, detail) => {
      setInvoiceSteps((prev) => prev.map((s, i) => (i === idx ? { ...s, status, detail } : s)));
    };

    let failedIdx = -1;
    try {
      await runInvoicePipeline(invoicePreview, invoiceStockOutEnabled, invoiceStockOutMemo, invoiceCancelProcessEnabled, (idx, status, detail) => {
        failedIdx = idx;
        setStepStatus(idx, status, detail);
      });
      pushLog(`송장삭제 완료: ${invoicePreview.invoice_no}`);
    } catch (err) {
      if (err.needSession) {
        openEzadminModal(handleInvoiceExecute);
      } else if (!err.silent) {
        alert(err.message || "송장삭제 처리 중 오류가 발생했습니다.");
        pushLog(`송장삭제 실패 (${invoicePreview.invoice_no}): ${err.message || ""}`.trim());
      }
      if (failedIdx >= 0) setStepStatus(failedIdx, "error", err.message);
    } finally {
      setInvoiceExecuting(false);
    }
  };

  const parseBulkInvoiceNos = (text) => {
    const seen = new Set();
    return String(text || "")
      .split(/[\s,]+/)
      .map((v) => v.trim())
      .filter((v) => v && !seen.has(v) && seen.add(v));
  };

  const handleInvoiceBulkExecute = async () => {
    const invoiceNos = parseBulkInvoiceNos(invoiceBulkInput);
    if (!invoiceNos.length) { setInvoicePreviewError("송장번호를 한 줄에 하나씩(또는 쉼표로 구분) 입력하세요."); return; }
    if (!window.confirm(
      `송장번호 ${invoiceNos.length}건을 일괄 삭제${invoiceStockOutEnabled ? "(재고 출고처리 포함)" : "(재고 출고처리 제외)"}${invoiceCancelProcessEnabled ? "(취소처리 포함)" : ""}하시겠습니까?`
    )) return;

    setInvoicePreviewError("");
    setInvoiceBulkRunning(true);
    const labels = getInvoiceStepLabels(invoiceStockOutEnabled, invoiceCancelProcessEnabled);
    const localResults = invoiceNos.map((no) => ({
      invoice_no: no,
      status: "pending",
      steps: labels.map((label) => ({ label, status: "pending" })),
    }));
    setInvoiceBulkResults(localResults);

    const setResult = (invoiceNo, status, detail) => {
      const target = localResults.find((r) => r.invoice_no === invoiceNo);
      if (target) { target.status = status; target.detail = detail; }
      setInvoiceBulkResults([...localResults]);
    };

    const setStepResult = (invoiceNo, idx, status, detail) => {
      const target = localResults.find((r) => r.invoice_no === invoiceNo);
      if (target?.steps?.[idx]) { target.steps[idx] = { ...target.steps[idx], status, detail }; }
      setInvoiceBulkResults([...localResults]);
    };

    for (const invoiceNo of invoiceNos) {
      setResult(invoiceNo, "running");
      try {
        const preview = await fetchInvoicePreview(invoiceNo);
        await runInvoicePipeline(preview, invoiceStockOutEnabled, invoiceStockOutMemo, invoiceCancelProcessEnabled, (idx, status, detail) => {
          setStepResult(invoiceNo, idx, status, detail);
        });
        setResult(invoiceNo, "done");
      } catch (err) {
        if (err.needSession) {
          setResult(invoiceNo, "error", "이지어드민 세션 필요");
          openEzadminModal(null);
          break;
        }
        setResult(invoiceNo, "error", err.message);
      }
    }

    const doneCount = localResults.filter((r) => r.status === "done").length;
    pushLog(`송장 일괄삭제 완료: ${doneCount}/${invoiceNos.length}건 성공`);
    setInvoiceBulkRunning(false);
  };

  const defectBaseRowsToShow = defectBaseRows
    .filter((row) => {
      const query = defectBaseQuery.trim().toLowerCase();
      if (!query) return true;
      return (row.values ?? []).some((value) => String(value || "").toLowerCase().includes(query));
    })
    .slice(0, 300);

  const playSound = (key) => {
    const audio = soundsRef.current?.[key];
    if (!audio) return;
    audio.currentTime = 0; audio.play().catch(() => {});
  };

  return (
    <div className={styles.page}>
      {/* 헤더 */}
      <div className={styles.pageHeader}>
        <div>
          <h2 className={styles.title}>{title}</h2>
          <p className={styles.subtitle}>송장 업로드 후 바코드 스캔 · F2 불량 모드 전환</p>
        </div>
        {headerExtra}
      </div>

      <div className={styles.stack}>
        {/* 파일 업로드 - 2열 그리드 */}
        {!mobileLite && (
        <div className={styles.dualGrid}>
          {/* 송장 파일 */}
          <section className={`${styles.card} ${styles.dualCard}`}>
            <div className={styles.cardHeader}>
              <h3 className={styles.cardTitle}>확장주문검색</h3>
              {(loadingUpload || ezadminOrdersLoading) && <span className={styles.pill}>불러오는 중</span>}
              {count !== null && !loadingUpload && !ezadminOrdersLoading && (
                <span className={styles.pill}>송장 {count} · 코드 {codesTotal}</span>
              )}
            </div>
            <div className={styles.uploadRow}>
              <label className={styles.fileInput} style={{ flex: 1, justifyContent: 'flex-start' }}>
                <input type="file" accept=".xls,.xlsx" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setUploadMsg(""); setEzadminOrdersMsg(""); setEzadminOrdersTiming(null); }} />
                {file ? file.name : "파일 선택"}
              </label>
              <button className={styles.primaryBtn} onClick={handleUpload} disabled={loadingUpload || ezadminOrdersLoading || !file}>
                업로드
              </button>
            </div>
            <div className={styles.uploadRow}>
              <input
                type="date"
                className={styles.dateInput}
                value={ezadminOrdersDate}
                onChange={(e) => setEzadminOrdersDate(e.target.value)}
                disabled={loadingUpload || ezadminOrdersLoading}
              />
              <button className={styles.secondaryBtn} style={{ flex: 1 }} onClick={handleUploadFromEzadminOrders} disabled={loadingUpload || ezadminOrdersLoading}>
                {ezadminOrdersLoading ? "EZAdmin 불러오는 중..." : "EZAdmin에서 불러오기"}
              </button>
              <button className={styles.secondaryBtn} onClick={handleOrdersXlsDownload} disabled={loadingUpload || ezadminOrdersLoading || count === null}>
                다운로드
              </button>
            </div>
            {ezadminOrdersMsg && (
              <div className={styles.statusMsg}
                style={{ borderColor: ezadminOrdersMsg.includes("실패") ? "rgba(220,53,69,0.4)" : "rgba(59,130,246,0.4)", backgroundColor: ezadminOrdersMsg.includes("실패") ? "rgba(220,53,69,0.07)" : "rgba(59,130,246,0.07)" }}>
                <strong>{ezadminOrdersMsg}</strong>
              </div>
            )}
            {uploadMsg && (
              <div className={styles.statusMsg}
                style={{ borderColor: uploadMsg.includes("실패") ? "rgba(220,53,69,0.4)" : "rgba(34,197,94,0.4)", backgroundColor: uploadMsg.includes("실패") ? "rgba(220,53,69,0.07)" : "rgba(34,197,94,0.07)" }}>
                <strong>{uploadMsg}</strong>
              </div>
            )}
          </section>

          {/* 입고 파일 */}
          <section className={`${styles.card} ${styles.dualCard}`}>
            <div className={styles.cardHeader}>
              <h3 className={styles.cardTitle}>입고 파일</h3>
              {(loadingIncoming || ezadminLoading) && <span className={styles.pill}>불러오는 중</span>}
              {incomingCodes !== null && !loadingIncoming && !ezadminLoading && (
                <span className={styles.pill}>코드 {incomingCodes} · 수량 {incomingTotal}</span>
              )}
            </div>
            <div className={styles.uploadRow}>
              <label className={styles.fileInput} style={{ flex: 1, justifyContent: 'flex-start' }}>
                <input type="file" accept=".xls,.xlsx" onChange={(e) => { setIncomingFile(e.target.files?.[0] ?? null); setIncomingMsg(""); }} />
                {incomingFile ? incomingFile.name : "파일 선택"}
              </label>
              <button className={styles.primaryBtn} onClick={handleIncomingUpload} disabled={loadingIncoming || ezadminLoading || !incomingFile}>
                업로드
              </button>
            </div>
            <div className={styles.uploadRow}>
              <input
                type="date"
                className={styles.dateInput}
                value={incomingEzDate}
                onChange={(e) => setIncomingEzDate(e.target.value)}
                disabled={loadingIncoming || ezadminLoading || incomingVoucherLoading}
              />
              <button
                className={styles.secondaryBtn}
                style={{ flex: 1 }}
                onClick={handleOpenIncomingVoucherPicker}
                disabled={loadingIncoming || ezadminLoading || incomingVoucherLoading}
              >
                {ezadminLoading ? "EZAdmin 불러오는 중..." : incomingVoucherLoading ? "전표 조회 중..." : "EZAdmin에서 불러오기"}
              </button>
            </div>
            {ezadminMsg && (
              <div className={styles.statusMsg}
                style={{ borderColor: "rgba(59,130,246,0.4)", backgroundColor: "rgba(59,130,246,0.07)" }}>
                <strong>{ezadminMsg}</strong>
              </div>
            )}
            {incomingMsg && (
              <div className={styles.statusMsg}
                style={{ borderColor: incomingMsg.includes("실패") ? "rgba(220,53,69,0.4)" : "rgba(34,197,94,0.4)", backgroundColor: incomingMsg.includes("실패") ? "rgba(220,53,69,0.07)" : "rgba(34,197,94,0.07)" }}>
                <strong>{incomingMsg}</strong>
              </div>
            )}
          </section>
        </div>
        )}

        {/* 스캔 - 전체 폭 */}
        <section className={styles.card}
          style={defectMode ? { borderColor: "rgba(220,53,69,0.5)", boxShadow: "0 0 0 2px rgba(220,53,69,0.15)" } : {}}>
          <div className={styles.cardHeader}>
            <h3 className={styles.cardTitle}>스캔</h3>
            <div className={styles.headerActions}>
              {!mobileLite && (
                <>
                  <button className={styles.secondaryBtn} onClick={openInvoiceDeleteModal}>송장삭제</button>
                  <button className={styles.secondaryBtn} onClick={() => setShowStockLog(true)}>로그 확인</button>
                  <button className={styles.secondaryBtn} onClick={() => setShowLabelReprint(true)}>라벨 재출력</button>
                </>
              )}
              {mobileLite && (
                <button
                  className={`${styles.toggleBtn} ${productCheckMode ? styles.toggleOn : ""}`}
                  onClick={() => { setProductCheckMode((v) => !v); setProductCheckResult(null); setTimeout(() => scanRef.current?.focus(), 0); }}
                >
                  {productCheckMode ? "🔍 제품확인 모드" : "제품확인 모드"}
                </button>
              )}
              <button
                className={`${styles.toggleBtn} ${defectMode ? styles.toggleOn : ""}`}
                onClick={() => setDefectMode((v) => !v)}
                style={defectMode ? { background: "rgba(220,53,69,0.9)", borderColor: "rgba(220,53,69,0.9)" } : {}}
              >
                {defectMode ? "🚨 불량 모드" : "불량 모드"}
              </button>
              <button className={styles.secondaryBtn} onClick={() => { setShowDefectList(true); fetchDefectList(); fetchKimsungilList(); fetchDefectRecords(); }}>
                불량 목록
                {defectList.length > 0 && (
                  <span className={styles.inlineTagDanger} style={{ marginLeft: "0.35rem" }}>{defectList.length}</span>
                )}
              </button>
              {!mobileLite && (
              <>
              <button className={styles.secondaryBtn} onClick={() => { setShowKimsungilList(true); fetchKimsungilList(); fetchAllTabStats(); }}>
                불량관리
                {kimsungilList.filter(i => (i.incoming_qty || 0) > 0).length > 0 && (
                  <span className={styles.inlineTagIncoming} style={{ marginLeft: "0.35rem" }}>{kimsungilList.filter(i => (i.incoming_qty || 0) > 0).length}</span>
                )}
              </button>
              <button className={styles.secondaryBtn} onClick={openAnomalyModal}>
                이상현상
              </button>
              <button className={styles.secondaryBtn} onClick={openBadStockModal}>
                악성재고
              </button>
              </>
              )}
            </div>
          </div>

          <div className={styles.scanRowInline}>
            <input
              ref={scanRef}
              value={scanText}
              onChange={(e) => {
                if (e.nativeEvent?.isComposing) { setScanText(e.target.value); return; }
                setScanText(toEnglishKey(e.target.value));
              }}
              onCompositionEnd={(e) => setScanText(toEnglishKey(e.currentTarget.value))}
              onKeyDown={(e) => { if (e.key === "Enter") handleScan(); }}
              placeholder={productCheckMode ? "상품코드 스캔 후 Enter (에이블리 상품 페이지로 이동)" : defectMode ? "불량 바코드 스캔 후 Enter" : "송장 또는 상품 바코드 스캔 후 Enter"}
              className={styles.scanInput}
              style={defectMode ? { borderColor: "rgba(220,53,69,0.6)", background: "rgba(220,53,69,0.04)" } : {}}
            />
            <button className={`${styles.primaryBtn} ${styles.scanBtn}`} onClick={handleScan}
              style={defectMode ? { background: "rgba(220,53,69,0.9)" } : {}}>
              {defectMode ? "불량 추가" : "스캔 처리"}
            </button>
          </div>
          {productCheckMode && productCheckResult && (
            <div style={{ marginTop: "0.6rem", fontSize: "0.95em" }}>
              <strong>{productCheckResult.code}</strong>{productCheckResult.name ? ` · ${productCheckResult.name}` : ""}
              {productCheckResult.error ? (
                <div style={{ color: "#dc2626" }}>{productCheckResult.error}</div>
              ) : (
                <div><a href={productCheckResult.url} target="_blank" rel="noopener noreferrer">{productCheckResult.url}</a></div>
              )}
            </div>
          )}

        </section>

        {/* 프리뷰 - 전체 폭, 2열 내부 */}
        <section className={styles.card} style={{ background: "var(--bg-secondary)" }}>
          <div className={styles.cardHeader}>
            <h3 className={styles.cardTitle}>프리뷰</h3>
            {currentInvoice && (
              <span className={styles.pill} style={invoiceDone ? { background: "rgba(34,197,94,0.15)", color: "#15803d", border: "1px solid rgba(34,197,94,0.3)" } : {}}>
                {invoiceDone ? "✓ 완료됨" : `송장 ${currentInvoice}`}
              </span>
            )}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            {defectMode && (
              <div style={{
                borderRadius: "var(--radius-md)",
                border: "1px solid rgba(220,53,69,0.35)",
                background: "rgba(220,53,69,0.06)",
                padding: "1rem 1.25rem",
                display: "flex",
                flexDirection: "column",
                gap: "0.6rem",
              }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: "0.45rem", flexWrap: "wrap" }}>
                  <span className={styles.infoLabel}>불량 등록 카드</span>
                  <span className={styles.inlineTagDanger}>합계 {getDefectTotalCount()}</span>
                </span>
                {defectList.length > 0 ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: "0.55rem" }}>
                    {getDefectPreviewList().map((item, idx) => (
                      <span
                        key={`${item.code}-preview-defect-${idx}`}
                        style={{ display: "inline-flex", alignItems: "center", gap: "0.45rem", flexWrap: "wrap" }}
                      >
                        <span style={{ fontWeight: 800, fontSize: "1.05rem", overflowWrap: "anywhere" }}>
                          {renderDefectLabel(item)}
                        </span>
                        <span className={styles.inlineTagDanger}>불량 {item.count}</span>
                        {item.kimsungil_summon_qty > 0 && (
                          <span className={styles.inlineTagIncoming}>불량관리 {item.kimsungil_summon_qty}</span>
                        )}
                        {item.code && <span className={styles.inlineMeta}>{item.code}</span>}
                      </span>
                    ))}
                  </div>
                ) : (
                  <span style={{ color: "var(--text-muted)", fontSize: "0.95rem" }}>등록된 불량이 없습니다.</span>
                )}
              </div>
            )}

            {/* 현재 상품 */}
            <div style={{
              borderRadius: "var(--radius-md)",
              border: "1px solid var(--border-color)",
              background: "var(--bg-primary)",
              padding: "1.25rem 1.5rem",
              display: "flex",
              flexDirection: "column",
              gap: "0.75rem",
            }}>
              <span className={styles.infoLabel}>현재 상품</span>
              {items.length > 0 ? (
                <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
                  {items.map((item, idx) => (
                    <div key={`${item.code}-${idx}`}
                      style={{
                        paddingBottom: idx < items.length - 1 ? "0.75rem" : 0,
                        borderBottom: idx < items.length - 1 ? "1px dashed var(--border-color)" : "none",
                        opacity: item.remain === 0 ? 0.4 : 1,
                      }}>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem", flexWrap: "wrap" }}>
                        <span style={{ fontWeight: 700, fontSize: "1.2rem", overflowWrap: "anywhere" }}>
                          {renderItemLabel(item)}
                        </span>
                        {item.run_len > 1 && <span className={styles.inlineTagRun}>연속 {item.run_len}</span>}
                        {item.incoming > 0 && <span className={styles.inlineTagIncoming}>입고 {item.incoming}</span>}
                        {item.stock > 0 && <span className={styles.inlineTagStock}>재고 {item.stock}</span>}
                        {item.remain >= 2 && <span className={styles.inlineMeta}>잔여 {item.remain}</span>}
                        {item.defect > 0 && <span className={styles.inlineTagDanger}>불량 {item.defect}</span>}
                        {item.remain === 0 && <span className={styles.doneBadge}>완료</span>}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <span style={{ color: "var(--text-muted)", fontSize: "1rem" }}>
                  {currentInvoice ? "상품 없음" : "송장을 먼저 스캔하세요"}
                </span>
              )}
            </div>

          </div>
        </section>

      </div>



      {showLabelReprint && <LabelReprintPage onClose={() => setShowLabelReprint(false)} />}

      <StockLogModal open={showStockLog} onClose={() => setShowStockLog(false)} />

      {/* 불량 리스트 모달 */}
      {showInvoiceModal && (
        <div className={styles.modalOverlay} onClick={() => { if (!invoiceExecuting && !invoiceBulkRunning) setShowInvoiceModal(false); }}>
          <div className={styles.modal} style={{ width: "min(520px, 96vw)" }} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <h4 className={styles.modalTitle}>송장삭제</h4>
              <div className={styles.modalActions}>
                <button className={styles.secondaryBtn} onClick={() => setShowInvoiceModal(false)} disabled={invoiceExecuting || invoiceBulkRunning}>닫기</button>
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: "1rem", marginBottom: "0.6rem", fontSize: "0.85rem" }}>
              <label style={{ display: "flex", alignItems: "center", gap: "0.3rem", cursor: "pointer" }}>
                <input
                  type="radio"
                  checked={!invoiceBulkMode}
                  onChange={() => setInvoiceBulkMode(false)}
                  disabled={invoiceExecuting || invoiceBulkRunning}
                />
                단일
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: "0.3rem", cursor: "pointer" }}>
                <input
                  type="radio"
                  checked={invoiceBulkMode}
                  onChange={() => setInvoiceBulkMode(true)}
                  disabled={invoiceExecuting || invoiceBulkRunning}
                />
                일괄삭제
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: "0.3rem", cursor: "pointer", marginLeft: "auto" }}>
                <input
                  type="checkbox"
                  checked={invoiceStockOutEnabled}
                  onChange={(e) => setInvoiceStockOutEnabled(e.target.checked)}
                  disabled={invoiceExecuting || invoiceBulkRunning}
                />
                재고 출고처리 포함
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: "0.3rem", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={invoiceCancelProcessEnabled}
                  onChange={(e) => setInvoiceCancelProcessEnabled(e.target.checked)}
                  disabled={invoiceExecuting || invoiceBulkRunning}
                />
                취소처리
              </label>
            </div>

            {invoiceStockOutEnabled && (
              <input
                value={invoiceStockOutMemo}
                onChange={(e) => setInvoiceStockOutMemo(e.target.value)}
                placeholder="재고 출고 메모 (선택)"
                className={styles.searchInput}
                disabled={invoiceExecuting || invoiceBulkRunning}
                style={{ width: "100%", marginBottom: "0.6rem", boxSizing: "border-box" }}
              />
            )}
            {ezadminOrdersTiming && (
              <div className={styles.statusMsg} style={{ borderColor: "rgba(100,116,139,0.3)", backgroundColor: "rgba(100,116,139,0.06)", fontSize: "0.8rem" }}>
                {ezadminOrdersTiming.fallback
                  ? `전체 요청 ${(ezadminOrdersTiming.total_ms / 1000).toFixed(2)}초 (서버 세부 측정값 없음)`
                  : `요청 응답 ${(ezadminOrdersTiming.api_ms / 1000).toFixed(2)}초 · 내부 가공 ${(ezadminOrdersTiming.processing_ms / 1000).toFixed(2)}초 · 총 ${(ezadminOrdersTiming.total_ms / 1000).toFixed(2)}초`}
              </div>
            )}

            {!invoiceBulkMode ? (
              <>
                <div className={styles.uploadRow}>
                  <input
                    value={invoiceNoInput}
                    onChange={(e) => setInvoiceNoInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") handleInvoicePreview(); }}
                    placeholder="송장번호 입력"
                    className={styles.searchInput}
                    disabled={invoicePreviewLoading || invoiceExecuting}
                  />
                  <button className={styles.primaryBtn} onClick={handleInvoicePreview} disabled={invoicePreviewLoading || invoiceExecuting}>
                    {invoicePreviewLoading ? "조회 중..." : "조회"}
                  </button>
                </div>

                {invoicePreviewError && (
                  <div className={styles.statusMsg} style={{ color: "#dc3545" }}>{invoicePreviewError}</div>
                )}

                {invoicePreview && (
                  <div style={{ marginTop: "0.75rem", fontSize: "0.85rem" }}>
                    <div style={{ marginBottom: "0.5rem" }}>송장번호 : <strong>{invoicePreview.invoice_no}</strong></div>
                    <div>{invoicePreview.ably_found ? "✔" : "✘"} 에이블리 주문 발견</div>
                    <div>{invoicePreview.ezadmin_found ? "✔" : "✘"} 이지어드민 주문 발견</div>

                    <div style={{ marginTop: "0.75rem", fontWeight: 600 }}>상품</div>
                    {(invoicePreview.products || []).length === 0 ? (
                      <div style={{ color: "#888" }}>상품 정보를 찾지 못했습니다.</div>
                    ) : (
                      invoicePreview.products.map((p) => (
                        <div key={p.product_id} style={{ padding: "0.35rem 0", borderBottom: "1px solid rgba(0,0,0,0.08)" }}>
                          <div>- {p.product_id}{p.name ? ` (${p.name})` : ""}</div>
                          <div style={{ color: "#666" }}>
                            {[p.color, p.size].filter(Boolean).join(" / ") || "옵션 정보 없음"} · 수량 {p.qty}
                          </div>
                        </div>
                      ))
                    )}

                    {invoiceSteps.length > 0 && (
                      <div style={{ marginTop: "0.75rem" }}>
                        <div style={{ fontWeight: 600, marginBottom: "0.25rem" }}>진행 상태</div>
                        {invoiceSteps.map((s) => (
                          <div key={s.label} style={{ display: "flex", alignItems: "center", gap: "0.35rem", padding: "0.15rem 0" }}>
                            <span>
                              {s.status === "done" ? "✔" : s.status === "error" ? "✘" : s.status === "running" ? "⏳" : "▫"}
                            </span>
                            <span>{s.label}</span>
                            {s.status === "error" && s.detail && (
                              <span style={{ color: "#dc3545", fontSize: "0.78rem" }}>({s.detail})</span>
                            )}
                          </div>
                        ))}
                      </div>
                    )}

                    <div className={styles.modalActions} style={{ marginTop: "1rem" }}>
                      <button className={styles.secondaryBtn} onClick={() => setShowInvoiceModal(false)} disabled={invoiceExecuting}>
                        취소
                      </button>
                      <button
                        className={styles.primaryBtn}
                        onClick={handleInvoiceExecute}
                        disabled={invoiceExecuting || !invoicePreview.ably_found || !(invoicePreview.products || []).length}
                      >
                        {invoiceExecuting ? "처리 중..." : "실행"}
                      </button>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <>
                <textarea
                  value={invoiceBulkInput}
                  onChange={(e) => setInvoiceBulkInput(e.target.value)}
                  placeholder={"송장번호를 한 줄에 하나씩(또는 쉼표로 구분) 입력"}
                  rows={6}
                  style={{ width: "100%", fontSize: "0.85rem", padding: "0.5rem", boxSizing: "border-box" }}
                  disabled={invoiceBulkRunning}
                />

                {invoicePreviewError && (
                  <div className={styles.statusMsg} style={{ color: "#dc3545" }}>{invoicePreviewError}</div>
                )}

                {invoiceBulkResults.length > 0 && (
                  <div style={{ marginTop: "0.75rem", fontSize: "0.85rem", maxHeight: "320px", overflowY: "auto" }}>
                    {invoiceBulkResults.map((r) => (
                      <div key={r.invoice_no} style={{ padding: "0.25rem 0", borderBottom: "1px solid rgba(0,0,0,0.06)" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>
                          <span>
                            {r.status === "done" ? "✔" : r.status === "error" ? "✘" : r.status === "running" ? "⏳" : "▫"}
                          </span>
                          <span>{r.invoice_no}</span>
                          {r.status === "error" && r.detail && (
                            <span style={{ color: "#dc3545", fontSize: "0.78rem" }}>({r.detail})</span>
                          )}
                        </div>
                        {r.status !== "pending" && (r.steps || []).length > 0 && (
                          <div style={{ marginLeft: "1.3rem", marginTop: "0.15rem" }}>
                            {r.steps.map((s) => (
                              <div key={s.label} style={{ display: "flex", alignItems: "center", gap: "0.3rem", fontSize: "0.78rem", color: "#666", padding: "0.05rem 0" }}>
                                <span>
                                  {s.status === "done" ? "✔" : s.status === "error" ? "✘" : s.status === "running" ? "⏳" : "▫"}
                                </span>
                                <span>{s.label}</span>
                                {s.status === "error" && s.detail && (
                                  <span style={{ color: "#dc3545" }}>({s.detail})</span>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                <div className={styles.modalActions} style={{ marginTop: "1rem" }}>
                  <button className={styles.secondaryBtn} onClick={() => setShowInvoiceModal(false)} disabled={invoiceBulkRunning}>
                    취소
                  </button>
                  <button
                    className={styles.primaryBtn}
                    onClick={handleInvoiceBulkExecute}
                    disabled={invoiceBulkRunning || !parseBulkInvoiceNos(invoiceBulkInput).length}
                  >
                    {invoiceBulkRunning ? "처리 중..." : "일괄실행"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {renameConfirm && (() => {
        const { preview, canProceed, resolve } = renameConfirm;
        const items = preview.items ?? [];
        const tabs = [
          { key: "rename", label: "변경 예정", rows: items.filter((i) => i.status === "rename") },
          { key: "skip", label: "이미 변경됨", rows: items.filter((i) => i.status === "skip") },
          { key: "conflict", label: "구역 충돌", rows: items.filter((i) => i.status === "conflict") },
          { key: "error", label: "오류", rows: items.filter((i) => i.status === "error" || i.status === "failed") },
          { key: "excluded", label: "제외(알파벳 아닌 직접 추가 탭)", rows: preview.excluded ?? [] },
        ].filter((t) => t.key === "rename" || t.rows.length > 0);
        const active = tabs.find((t) => t.key === renameConfirmTab) ?? tabs[0];
        const close = (proceed) => { setRenameConfirm(null); resolve(proceed); };
        const rowText = (row) => {
          if (active.key === "rename") return `${row.old_name}  →  ${row.new_name}${row.message ? `  (${row.message})` : ""}`;
          if (active.key === "skip") return `${row.new_name || row.old_name}${row.message ? `  (${row.message})` : ""}`;
          if (active.key === "conflict") return `${row.old_name || row.code}  [${(row.zones ?? []).map(badStockZoneLabel).join(", ")}]`;
          if (active.key === "error") return `${row.old_name || row.code}  (${row.message || "오류"})`;
          return `${row.name || row.code}  [${badStockZoneLabel(row.zone)}]`;
        };
        return (
          <div className={styles.modalOverlay} style={{ zIndex: 60 }} onClick={() => close(false)}>
            <div className={`${styles.modal} ${styles.modalWide}`} onClick={(e) => e.stopPropagation()}>
              <div className={styles.modalHeader}>
                <h4 className={styles.modalTitle}>
                  {canProceed ? `이지어드민 상품명 ${tabs[0].rows.length}종을 변경합니다` : "변경할 상품이 없습니다"}
                </h4>
                <div className={styles.modalActions}>
                  {canProceed && <button className={styles.primaryBtn} onClick={() => close(true)}>진행</button>}
                  <button className={styles.secondaryBtn} onClick={() => close(false)}>{canProceed ? "취소" : "닫기"}</button>
                </div>
              </div>
              <div className={styles.tabRow} style={{ marginBottom: "0.5rem" }}>
                {tabs.map((t) => (
                  <button
                    key={t.key}
                    className={`${styles.tabBtn} ${active.key === t.key ? styles.tabActive : ""}`}
                    onClick={() => setRenameConfirmTab(t.key)}
                  >
                    {t.label} ({t.rows.length})
                  </button>
                ))}
              </div>
              <div className={styles.modalBody} style={{ maxHeight: "60vh", overflowY: "auto" }}>
                {active.rows.length === 0 ? (
                  <div style={{ padding: "0.75rem", opacity: 0.7 }}>해당하는 상품이 없습니다.</div>
                ) : (
                  active.rows.map((row, idx) => (
                    <div key={`${row.code ?? idx}-${idx}`} style={{ padding: "0.35rem 0.5rem", borderBottom: "1px solid rgba(128,128,128,0.2)", wordBreak: "break-all" }}>
                      {rowText(row)}
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        );
      })()}
      {showDeductHistory && (
        <div className={styles.modalOverlay} style={{ zIndex: 70 }} onClick={() => setShowDeductHistory(false)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()} style={{ maxHeight: "80vh", overflowY: "auto" }}>
            <div className={styles.modalHeader}>
              <h4 className={styles.modalTitle}>출고상품삭제 이력</h4>
              <div className={styles.modalActions}>
                <button className={styles.secondaryBtn} onClick={() => setShowDeductHistory(false)}>닫기</button>
              </div>
            </div>
            {deductHistory.length === 0 ? (
              <p>저장된 이력이 없습니다. (이 기능 추가 이후 실행분부터 기록됩니다)</p>
            ) : (
              deductHistory.map((h, idx) => {
                const d = describeLastDeduct(h);
                const open = deductHistoryOpenIdx === idx;
                return (
                  <div key={`${h.at}-${idx}`} style={{ borderBottom: "1px solid #e5e7eb", padding: "0.4rem 0" }}>
                    <div style={{ cursor: "pointer" }} onClick={() => setDeductHistoryOpenIdx(open ? null : idx)}>
                      {open ? "▼" : "▶"} {String(h.at || "").replace("T", " ")} · {h.user || ""} · {h.kinds ?? 0}종 {h.total ?? 0}개{d?.isToday ? " (오늘)" : ""}
                    </div>
                    {open && (
                      <ul style={{ margin: "0.3rem 0 0 1.2rem", fontSize: "0.9em" }}>
                        {(h.items || []).map((it, i) => (
                          <li key={`${it.code}-${i}`}>{it.product_name || it.code} : -{it.deducted}</li>
                        ))}
                        {!(h.items || []).length && <li>상세 내역 없음</li>}
                      </ul>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
      {showBadStockModal && (
        <div className={styles.modalOverlay} onClick={() => setShowBadStockModal(false)}>
          <div className={`${styles.modal} ${styles.modalWide}`} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <h4 className={styles.modalTitle}>악성재고</h4>
              <div className={styles.modalActions}>
                <span className={styles.pill} title={getBadStockNoCostCount() > 0 ? `원가를 찾지 못한 상품 ${getBadStockNoCostCount()}종은 제외됨` : "전체 구역 원가 × 수량"}>
                  전체 원가 {getBadStockCost().toLocaleString()}원{getBadStockNoCostCount() > 0 ? ` (원가없음 ${getBadStockNoCostCount()}종 제외)` : ""}
                </span>
                <button className={styles.secondaryBtn} onClick={checkBadStockWithEzadmin} disabled={badStockChecking}>
                  {badStockChecking ? "확인 중..." : "이지어드민 재고 비교"}
                </button>
                <button className={styles.secondaryBtn} onClick={deductShippedBadStock}>출고상품삭제</button>
                {(() => {
                  const last = describeLastDeduct(badStockLastDeduct);
                  return (
                    <button
                      type="button"
                      className={styles.pill}
                      style={{ cursor: "pointer", border: "none", ...(last?.isToday ? { background: "#16a34a", color: "#fff" } : {}) }}
                      onClick={openDeductHistory}
                      title="클릭하면 출고상품삭제 이력을 볼 수 있습니다"
                    >
                      {last ? `${last.isToday ? "✔ " : ""}${last.text}` : "출고상품삭제 기록 없음"}
                    </button>
                  );
                })()}
                <button className={styles.secondaryBtn} onClick={() => renameBadStockProducts(false)} disabled={badStockRenaming}>
                  {badStockRenaming ? "처리 중..." : "악성재고 상품명 변경"}
                </button>
                <button
                  className={styles.secondaryBtn}
                  onClick={() => renameBadStockProducts(true)}
                  disabled={badStockRenaming}
                  title="이미 바꿨다고 기록된 상품도 포함해, 모든 악성재고 상품의 현재 이지어드민 상품명을 다시 읽어 확인합니다"
                >
                  전체 재조회
                </button>
                <button className={styles.secondaryBtn} onClick={() => setShowBadStockModal(false)}>닫기</button>
              </div>
            </div>
            {BAD_STOCK_CATEGORIES.map((cat) => (
              <div key={cat} className={styles.tabRow} style={{ marginBottom: "0.5rem" }}>
                {BAD_STOCK_CATEGORY_LETTERS[cat].map((letter) => {
                  const zone = `${cat}${letter}`;
                  return (
                    <button
                      key={zone}
                      className={`${styles.tabBtn} ${badStockZone === zone ? styles.tabActive : ""}`}
                      onClick={() => { setBadStockZone(zone); setBadStockRows([]); setBadStockMessage(""); setBadStockMoveIds([]); }}
                    >
                      {badStockZoneLabel(zone)} ({badStockList.filter((i) => i.zone === zone).reduce((s, i) => s + (Number(i.qty) || 1), 0)} · {getBadStockCost(zone).toLocaleString()}원)
                    </button>
                  );
                })}
                {badStockCustomZones.filter((zone) => zone.startsWith(cat)).map((zone) => (
                  <span key={zone} style={{ display: "inline-flex", alignItems: "center" }}>
                    <button
                      className={`${styles.tabBtn} ${badStockZone === zone ? styles.tabActive : ""}`}
                      onClick={() => { setBadStockZone(zone); setBadStockRows([]); setBadStockMessage(""); setBadStockMoveIds([]); }}
                    >
                      {badStockZoneLabel(zone)} ({badStockList.filter((i) => i.zone === zone).reduce((s, i) => s + (Number(i.qty) || 1), 0)} · {getBadStockCost(zone).toLocaleString()}원)
                    </button>
                    <button className={styles.ghostBtn} title="탭 삭제" onClick={() => removeBadStockZone(zone)}>×</button>
                  </span>
                ))}
                <button className={styles.secondaryBtn} title={`${cat} 탭 추가`} onClick={() => addBadStockZone(cat)}>+</button>
              </div>
            ))}
            <div className={styles.uploadRow} style={{ marginBottom: "0.5rem" }}>
              <input
                value={badStockFind}
                onChange={(e) => setBadStockFind(e.target.value)}
                placeholder="전체 구역에서 등록된 재고 찾기 (상품명 / 상품코드)"
                className={styles.searchInput}
              />
              {badStockFind && (
                <button className={styles.ghostBtn} onClick={() => setBadStockFind("")}>지우기</button>
              )}
            </div>
            {badStockFind.trim() && (() => {
              const keyword = badStockFind.trim().toLowerCase();
              const found = badStockList.filter((i) =>
                `${i.code} ${i.product_name}`.toLowerCase().includes(keyword)
              );
              return (
                <div style={{ marginBottom: "0.5rem" }}>
                  {found.length === 0 ? (
                    <div className={styles.empty}>전체 구역에 일치하는 등록 재고가 없습니다.</div>
                  ) : (
                    <table className={styles.table}>
                      <thead>
                        <tr>
                          <th>구역</th>
                          <th>상품코드</th>
                          <th>상품명</th>
                          <th>수량</th>
                          <th></th>
                        </tr>
                      </thead>
                      <tbody>
                        {found.map((item) => (
                          <tr key={`badstock-find-${item.id}`}>
                            <td style={{ fontWeight: 700 }}>{badStockZoneLabel(item.zone)}</td>
                            <td>{item.code}</td>
                            <td>{item.product_name}</td>
                            <td style={{ fontWeight: 700 }}>{item.qty ?? 1}</td>
                            <td>
                              <button
                                className={styles.ghostBtn}
                                onClick={() => { setBadStockZone(item.zone); setBadStockRows([]); setBadStockMessage(""); }}
                              >
                                해당 구역 열기
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              );
            })()}
            <div className={styles.uploadRow} style={{ marginBottom: "0.5rem" }}>
              <input
                value={badStockScan}
                onChange={(e) => setBadStockScan(toEnglishKey(e.target.value))}
                onKeyDown={(e) => { if (e.key === "Enter") handleBadStockScan(); }}
                placeholder={`${badStockZoneLabel(badStockZone)} 상품 바코드 스캔 후 Enter`}
                className={styles.searchInput}
                autoFocus
              />
              <button className={styles.primaryBtn} onClick={handleBadStockScan}>바코드 추가</button>
            </div>
            <div className={styles.uploadRow}>
              <input
                value={badStockQuery}
                onChange={(e) => setBadStockQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") searchBadStock(); }}
                placeholder="상품명 검색"
                className={styles.searchInput}
              />
              <button className={styles.secondaryBtn} onClick={searchBadStock} disabled={badStockSearching}>
                {badStockSearching ? "검색 중..." : "상품 검색"}
              </button>
            </div>
            <div className={styles.modalBody}>
              {badStockMessage && (
                <div className={styles.statusMsg}><strong>{badStockMessage}</strong></div>
              )}
              {badStockCheck && (
                <div style={{ marginBottom: "0.75rem" }}>
                  <div className={styles.statusMsg}>
                    <strong>
                      이지어드민 비교: 전체 {badStockCheck.summary.total}종 / 일치 {badStockCheck.summary.match} / 불일치 {badStockCheck.summary.mismatch} / 미검색 {badStockCheck.summary.not_found}
                    </strong>
                    <button
                      className={styles.primaryBtn}
                      style={{ marginLeft: "0.75rem" }}
                      disabled={badStockNormalizing || badStockSelected.length === 0}
                      onClick={() => normalizeBadStock(badStockSelected)}
                    >
                      {badStockNormalizing ? "처리 중..." : `선택 정상화 (${badStockSelected.length})`}
                    </button>
                    <button
                      className={styles.secondaryBtn}
                      style={{ marginLeft: "0.4rem" }}
                      disabled={badStockNormalizing || badStockShortItems.length === 0}
                      onClick={() => normalizeBadStock([])}
                    >
                      전체 정상화 ({badStockShortItems.length}종)
                    </button>
                    <button className={styles.ghostBtn} style={{ marginLeft: "0.5rem" }} onClick={() => setBadStockCheck(null)}>닫기</button>
                  </div>
                  <div className={styles.inlineMeta} style={{ margin: "0.3rem 0" }}>
                    정상화는 이지어드민 정상재고가 등록 수량보다 적은 상품(차이가 음수)을 부족분만큼 입고처리합니다. 이지어드민 재고가 더 많거나 미검색인 상품은 건드리지 않습니다.
                  </div>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th style={{ width: "2rem" }}>
                          <input
                            type="checkbox"
                            checked={badStockShortItems.length > 0 && badStockSelected.length === badStockShortItems.length}
                            disabled={badStockShortItems.length === 0}
                            onChange={(e) => setBadStockSelected(e.target.checked ? badStockShortItems.map((i) => i.code) : [])}
                          />
                        </th>
                        <th>상품코드</th>
                        <th>상품명</th>
                        <th>구역별 등록</th>
                        <th>등록 합계</th>
                        <th>이지어드민 정상재고</th>
                        <th>차이</th>
                        <th>결과</th>
                      </tr>
                    </thead>
                    <tbody>
                      {badStockCheck.items.map((item) => (
                        <tr key={`badstock-check-${item.code}`} style={item.status === "match" ? undefined : { background: "rgba(255, 90, 90, 0.12)" }}>
                          <td>
                            {item.status === "mismatch" && item.diff < 0 && (
                              <input
                                type="checkbox"
                                checked={badStockSelected.includes(item.code)}
                                onChange={(e) => setBadStockSelected((prev) => (
                                  e.target.checked ? [...prev, item.code] : prev.filter((c) => c !== item.code)
                                ))}
                              />
                            )}
                          </td>
                          <td>{item.code}</td>
                          <td>{item.product_name}</td>
                          <td>{Object.entries(item.zones).map(([z, q]) => `${badStockZoneLabel(z)} ${q}`).join(", ")}</td>
                          <td style={{ fontWeight: 700 }}>{item.registered}</td>
                          <td style={{ fontWeight: 700 }}>{item.ezadmin_stock ?? "-"}</td>
                          <td>{item.diff == null ? "-" : item.diff > 0 ? `+${item.diff}` : item.diff}</td>
                          <td>{item.status === "match" ? "일치" : item.status === "mismatch" ? "불일치" : "미검색"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {badStockRows.length > 0 && (
                <div className={styles.defectList} style={{ marginBottom: "0.75rem" }}>
                  {badStockRows.map((row, idx) => (
                    <div key={`${row.code}-badstock-${idx}`} className={styles.defectLine}>
                      <span className={styles.defectText}>
                        {row.base_name}
                        {row.base_code && <span className={styles.inlineMeta} style={{ marginLeft: "0.4rem" }}>{row.base_code}</span>}
                      </span>
                      <button className={styles.ghostBtn} onClick={() => addBadStock(row.code, row.base_name)}>
                        {badStockZoneLabel(badStockZone)}에 추가
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {badStockList.filter((i) => i.zone === badStockZone).length === 0 ? (
                <div className={styles.empty}>{badStockZoneLabel(badStockZone)}에 등록된 상품이 없습니다.</div>
              ) : (
                <>
                <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginBottom: "0.5rem" }}>
                  <span>선택 {badStockMoveIds.length}종 →</span>
                  <select value={badStockMoveTarget} onChange={(e) => setBadStockMoveTarget(e.target.value)}>
                    <option value="">이동할 구역</option>
                    {[...BAD_STOCK_BASE_ZONES, ...badStockCustomZones]
                      .filter((z) => z !== badStockZone)
                      .map((z) => <option key={z} value={z}>{badStockZoneLabel(z)}</option>)}
                  </select>
                  <button
                    className={styles.secondaryBtn}
                    disabled={!badStockMoveIds.length || !badStockMoveTarget}
                    onClick={moveBadStock}
                  >
                    구역 이동
                  </button>
                </div>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>
                        <input
                          type="checkbox"
                          checked={badStockList.filter((i) => i.zone === badStockZone).length > 0
                            && badStockList.filter((i) => i.zone === badStockZone).every((i) => badStockMoveIds.includes(i.id))}
                          onChange={(e) => setBadStockMoveIds(e.target.checked ? badStockList.filter((i) => i.zone === badStockZone).map((i) => i.id) : [])}
                        />
                      </th>
                      <th>상품코드</th>
                      <th>상품명</th>
                      <th>수량</th>
                      <th>원가</th>
                      <th>등록일</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {badStockList.filter((i) => i.zone === badStockZone).map((item) => (
                      <tr key={`badstock-${item.id}`}>
                        <td>
                          <input
                            type="checkbox"
                            checked={badStockMoveIds.includes(item.id)}
                            onChange={(e) => setBadStockMoveIds((prev) => e.target.checked ? [...prev, item.id] : prev.filter((x) => x !== item.id))}
                          />
                        </td>
                        <td>{item.code}</td>
                        <td>{item.product_name}</td>
                        <td style={{ fontWeight: 700 }}>{item.qty ?? 1}</td>
                        <td>{Number(item.base_cost) > 0 ? `${(item.base_cost * (Number(item.qty) || 1)).toLocaleString()}원` : "-"}</td>
                        <td>{String(item.created_at || "").slice(0, 10)}</td>
                        <td>
                          {(item.qty ?? 1) > 1 && (
                            <button
                              className={styles.ghostBtn}
                              style={{ marginRight: "0.3rem" }}
                              onClick={() => callBadStockApi("remove", { id: item.id, decrement: true })}
                            >
                              -1
                            </button>
                          )}
                          <button
                            className={styles.ghostBtn}
                            onClick={() => { if (window.confirm("삭제하시겠습니까?")) callBadStockApi("remove", { id: item.id }); }}
                          >
                            삭제
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={3} style={{ fontWeight: 700 }}>{badStockZoneLabel(badStockZone)} 합계</td>
                      <td style={{ fontWeight: 700 }}>
                        {badStockList.filter((i) => i.zone === badStockZone).reduce((s, i) => s + (Number(i.qty) || 1), 0)}
                      </td>
                      <td style={{ fontWeight: 700 }}>
                        {getBadStockCost(badStockZone).toLocaleString()}원
                      </td>
                      <td colSpan={2}>
                        ({badStockList.filter((i) => i.zone === badStockZone).length}종)
                      </td>
                    </tr>
                  </tfoot>
                </table>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {showAnomalyModal && (
        <div className={styles.modalOverlay} onClick={() => setShowAnomalyModal(false)}>
          <div className={styles.modal} style={{ width: "min(1100px, 96vw)" }} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <h4 className={styles.modalTitle}>이상현상</h4>
              <div className={styles.modalActions}>
                <button className={styles.secondaryBtn} onClick={toggleAnomalyDone}>
                  {showAnomalyDone ? "진행중 목록" : "완료 내역"}
                </button>
                <button className={styles.secondaryBtn} onClick={() => setShowAnomalyModal(false)}>닫기</button>
              </div>
            </div>
            <div className={styles.uploadRow}>
              <input
                value={invoiceNoInput}
                onChange={(e) => setInvoiceNoInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleInvoicePreview(); }}
                placeholder="송장번호 입력 (송장삭제)"
                className={styles.searchInput}
                disabled={invoicePreviewLoading || invoiceExecuting}
              />
              <button className={styles.primaryBtn} onClick={handleInvoicePreview} disabled={invoicePreviewLoading || invoiceExecuting}>
                {invoicePreviewLoading ? "조회 중..." : "송장 조회"}
              </button>
              <label style={{ display: "flex", alignItems: "center", gap: "0.3rem", fontSize: "0.85rem", whiteSpace: "nowrap" }}>
                <input
                  type="checkbox"
                  checked={invoiceStockOutEnabled}
                  onChange={(e) => setInvoiceStockOutEnabled(e.target.checked)}
                  disabled={invoiceExecuting}
                />
                재고 출고처리 포함
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: "0.3rem", fontSize: "0.85rem", whiteSpace: "nowrap" }}>
                <input
                  type="checkbox"
                  checked={invoiceCancelProcessEnabled}
                  onChange={(e) => setInvoiceCancelProcessEnabled(e.target.checked)}
                  disabled={invoiceExecuting}
                />
                취소처리
              </label>
            </div>
            {invoiceStockOutEnabled && (
              <input
                value={invoiceStockOutMemo}
                onChange={(e) => setInvoiceStockOutMemo(e.target.value)}
                placeholder="재고 출고 메모 (선택)"
                className={styles.searchInput}
                disabled={invoiceExecuting}
                style={{ width: "100%", margin: "0.5rem 0", boxSizing: "border-box" }}
              />
            )}
            {invoicePreviewError && (
              <div className={styles.statusMsg} style={{ color: "#dc3545" }}>{invoicePreviewError}</div>
            )}
            {invoicePreview && (
              <div style={{ margin: "0.5rem 0 0.75rem", fontSize: "0.85rem" }}>
                <div>
                  송장번호 <strong>{invoicePreview.invoice_no}</strong>
                  {" · "}{invoicePreview.ably_found ? "✔" : "✘"} 에이블리
                  {" · "}{invoicePreview.ezadmin_found ? "✔" : "✘"} 이지어드민
                </div>
                {(invoicePreview.products || []).map((p) => (
                  <div key={p.product_id} style={{ color: "#666" }}>
                    - {p.product_id}{p.name ? ` (${p.name})` : ""} · {[p.color, p.size].filter(Boolean).join(" / ") || "옵션 없음"} · 수량 {p.qty}
                  </div>
                ))}
                {invoiceSteps.map((s) => (
                  <div key={s.label}>
                    {s.status === "done" ? "✔" : s.status === "error" ? "✘" : s.status === "running" ? "⏳" : "▫"} {s.label}
                    {s.status === "error" && s.detail && <span style={{ color: "#dc3545" }}> ({s.detail})</span>}
                  </div>
                ))}
                <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.4rem" }}>
                  <button className={styles.secondaryBtn} onClick={fillAnomalyFormFromInvoice} disabled={invoiceExecuting}>
                    등록 폼에 채우기
                  </button>
                  <button className={styles.primaryBtn} onClick={handleInvoiceExecute} disabled={invoiceExecuting}>
                    {invoiceExecuting ? "처리 중..." : "송장삭제 실행"}
                  </button>
                </div>
              </div>
            )}
            <div className={styles.uploadRow}>
              <input
                value={anomalySearchQuery}
                onChange={(e) => setAnomalySearchQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") searchAnomalyProducts(); }}
                placeholder="G열 상품명 검색"
                className={styles.searchInput}
              />
              <button className={styles.secondaryBtn} onClick={searchAnomalyProducts} disabled={anomalySearchLoading}>
                {anomalySearchLoading ? "검색 중..." : "상품 검색"}
              </button>
            </div>
            <div className={styles.modalBody}>
              {anomalyMessage && (
                <div className={styles.statusMsg}><strong>{anomalyMessage}</strong></div>
              )}
              {anomalySearchRows.length > 0 && (
                <div className={styles.defectList} style={{ marginBottom: "0.75rem" }}>
                  {anomalySearchRows.map((row, idx) => (
                    <div key={`${row.code}-anomaly-${idx}`} className={styles.defectLine}>
                      <span className={styles.defectText}>
                        {row.base_name}
                        {row.base_color && <span className={styles.inlineMeta} style={{ marginLeft: "0.4rem" }}>{row.base_color}</span>}
                        {row.base_code && <span className={styles.inlineMeta} style={{ marginLeft: "0.4rem" }}>{row.base_code}</span>}
                      </span>
                      <button className={styles.ghostBtn} onClick={() => pickAnomalyProduct(row)}>선택</button>
                    </div>
                  ))}
                </div>
              )}
              <div className={styles.uploadRow} style={{ flexWrap: "wrap", marginBottom: "0.75rem" }}>
                <input
                  type="date"
                  value={anomalyForm.registered_date}
                  onChange={(e) => setAnomalyForm((p) => ({ ...p, registered_date: e.target.value }))}
                  className={styles.searchInput}
                  style={{ flex: "0 0 auto" }}
                />
                <input
                  value={anomalyForm.product_name}
                  onChange={(e) => setAnomalyForm((p) => ({ ...p, product_name: e.target.value }))}
                  placeholder="상품명 + 옵션 (검색 후 선택)"
                  className={styles.searchInput}
                  style={{ flex: 2 }}
                />
                <input
                  type="number"
                  min="0"
                  value={anomalyForm.qty}
                  onChange={(e) => setAnomalyForm((p) => ({ ...p, qty: e.target.value }))}
                  placeholder="개수"
                  className={styles.searchInput}
                  style={{ flex: "0 0 5rem" }}
                />
                <input
                  value={anomalyForm.reason}
                  onChange={(e) => setAnomalyForm((p) => ({ ...p, reason: e.target.value }))}
                  onKeyDown={(e) => { if (e.key === "Enter") addAnomaly(); }}
                  placeholder="사유"
                  className={styles.searchInput}
                  style={{ flex: 2 }}
                />
                <label style={{ display: "flex", alignItems: "center", gap: "0.3rem" }}>
                  <input
                    type="checkbox"
                    checked={anomalyForm.normalized}
                    onChange={(e) => setAnomalyForm((p) => ({ ...p, normalized: e.target.checked }))}
                  />
                  정상화
                </label>
                <button className={styles.primaryBtn} onClick={addAnomaly}>등록</button>
              </div>
              {showAnomalyDone ? (
                anomalyDoneList.length === 0 ? (
                  <div className={styles.empty}>완료된 이상현상이 없습니다.</div>
                ) : (
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th>등록날짜</th>
                        <th>상품명 + 옵션</th>
                        <th>개수</th>
                        <th>사유</th>
                        <th>완료메모</th>
                        <th>완료일시</th>
                        <th>처리자</th>
                      </tr>
                    </thead>
                    <tbody>
                      {anomalyDoneList.map((item) => (
                        <tr key={`anomaly-done-${item.id}`}>
                          <td>{item.registered_date}</td>
                          <td>{item.product_name}</td>
                          <td>{item.qty ?? 1}</td>
                          <td>{item.reason}</td>
                          <td>{item.completed_memo}</td>
                          <td>{String(item.completed_at || "").replace("T", " ").slice(0, 16)}</td>
                          <td>{item.completed_by}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )
              ) : anomalyList.length === 0 ? (
                <div className={styles.empty}>등록된 이상현상이 없습니다.</div>
              ) : (
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>등록날짜</th>
                      <th>상품명 + 옵션</th>
                      <th>개수</th>
                      <th>사유</th>
                      <th>정상화</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {anomalyList.map((item) => {
                      const editing = anomalyEdit?.id === item.id;
                      const setEdit = (key) => (e) => setAnomalyEdit((p) => ({ ...p, [key]: e.target.value }));
                      return (
                      <tr key={`anomaly-${item.id}`}>
                        <td>
                          {editing ? (
                            <input type="date" value={anomalyEdit.registered_date} onChange={setEdit("registered_date")} className={styles.searchInput} />
                          ) : item.registered_date}
                        </td>
                        <td>
                          {editing ? (
                            <input value={anomalyEdit.product_name} onChange={setEdit("product_name")} className={styles.searchInput} />
                          ) : item.product_name}
                        </td>
                        <td>
                          {editing ? (
                            <input type="number" min="0" value={anomalyEdit.qty} onChange={setEdit("qty")} className={styles.searchInput} style={{ width: "4.5rem" }} />
                          ) : (item.qty ?? 1)}
                        </td>
                        <td>
                          {editing ? (
                            <input
                              value={anomalyEdit.reason}
                              onChange={setEdit("reason")}
                              onKeyDown={(e) => { if (e.key === "Enter") saveAnomalyEdit(); }}
                              className={styles.searchInput}
                            />
                          ) : item.reason}
                        </td>
                        <td>
                          <input
                            type="checkbox"
                            checked={!!item.normalized}
                            onChange={(e) => callAnomalyApi("update", { id: item.id, normalized: e.target.checked })}
                          />
                        </td>
                        <td>
                          {editing ? (
                            <>
                              <button className={styles.primaryBtn} onClick={saveAnomalyEdit}>저장</button>
                              <button className={styles.ghostBtn} onClick={() => setAnomalyEdit(null)}>취소</button>
                            </>
                          ) : anomalyComplete?.id === item.id ? (
                            <>
                              <input
                                autoFocus
                                value={anomalyComplete.memo}
                                onChange={(e) => setAnomalyComplete((p) => ({ ...p, memo: e.target.value }))}
                                onKeyDown={(e) => { if (e.key === "Enter") saveAnomalyComplete(); }}
                                placeholder="완료 메모"
                                className={styles.searchInput}
                              />
                              <button className={styles.primaryBtn} onClick={saveAnomalyComplete}>확인</button>
                              <button className={styles.ghostBtn} onClick={() => setAnomalyComplete(null)}>취소</button>
                            </>
                          ) : (
                            <>
                              <button
                                className={styles.ghostBtn}
                                onClick={() => setAnomalyEdit({
                                  id: item.id,
                                  registered_date: item.registered_date,
                                  product_name: item.product_name,
                                  qty: item.qty ?? 1,
                                  reason: item.reason,
                                })}
                              >
                                수정
                              </button>
                              <button
                                className={styles.ghostBtn}
                                onClick={() => { if (window.confirm("삭제하시겠습니까?")) callAnomalyApi("remove", { id: item.id }); }}
                              >
                                삭제
                              </button>
                              <button
                                className={styles.ghostBtn}
                                onClick={() => setAnomalyComplete({ id: item.id, memo: "" })}
                              >
                                완료
                              </button>
                            </>
                          )}
                        </td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}

      {defectPhotoCode && (
        <DefectRecordDetailModal
          title={(() => {
            const it = defectList.find((i) => i.code === defectPhotoCode);
            return `📷 ${it ? renderDefectLabel(it) : defectPhotoCode} · 사진·사유`;
          })()}
          records={defectRecords.filter((r) => r.code === defectPhotoCode)}
          tabHeaders={tabHeaders}
          onChanged={setDefectRecords}
          onClose={() => setDefectPhotoCode(null)}
          onAddDefect={() => {
            const it = defectList.find((i) => i.code === defectPhotoCode);
            setDefectSheet({ code: defectPhotoCode, label: it ? renderDefectLabel(it) : "", qty: 1, reopenPhoto: true });
            setDefectPhotoCode(null);
          }}
        />
      )}

      {purchaseModePicker && (
        <div className={styles.modalOverlay} style={{ zIndex: 1100 }} onClick={() => setPurchaseModePicker(false)}>
          <div className={styles.modal} style={{ maxWidth: 480 }} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <h4 className={styles.modalTitle}>매입관리로 보낼 항목 ({defectTab}탭)</h4>
              <div className={styles.modalActions}>
                <button className={styles.secondaryBtn} onClick={() => setPurchaseModePicker(false)}>닫기</button>
              </div>
            </div>
            <div style={{ display: "flex", gap: "0.4rem", marginBottom: "0.6rem" }}>
              {[["all", "둘 다"], ["normal", "불량만"], ["summon", "소환술만"]].map(([mode, label]) => (
                <button
                  key={mode}
                  className={purchaseScope === mode ? styles.primaryBtn : styles.secondaryBtn}
                  style={{ flex: 1, padding: "10px 4px", fontWeight: 700 }}
                  onClick={() => {
                    setPurchaseScope(mode);
                    selectAllNew(mode, purchaseSent);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            {(() => {
              // 해당 범위에 수량이 있는 항목 중 신규가 있는 것을 먼저, 이미 이동된 것은 아래에 흐리게 표시
              const inScope = defectList.filter((i) => purchaseQty(i, purchaseScope) > 0);
              const rows = [...inScope.filter((i) => purchaseNewQty(i, purchaseScope) > 0), ...inScope.filter((i) => purchaseNewQty(i, purchaseScope) <= 0)];
              const sentRows = rows.filter((i) => purchaseNewQty(i, purchaseScope) <= 0);
              const selectable = rows.filter((i) => purchaseNewQty(i, purchaseScope) > 0);
              const checked = selectable.filter((i) => purchaseSelected[i.code]);
              const total = checked.reduce((s, i) => s + purchaseNewQty(i, purchaseScope), 0);
              const allOn = selectable.length > 0 && checked.length === selectable.length;
              return (
                <>
                  <label style={{ display: "flex", gap: "0.5rem", alignItems: "center", padding: "6px 2px", fontWeight: 700 }}>
                    <input
                      type="checkbox"
                      checked={allOn}
                      onChange={() => {
                        const selected = {};
                        if (!allOn) selectable.forEach((i) => { selected[i.code] = true; });
                        setPurchaseSelected(selected);
                      }}
                    />
                    전체 선택 ({checked.length}/{selectable.length}종){sentRows.length > 0 ? ` · 이미 이동 ${sentRows.length}종` : ""}
                  </label>
                  <div style={{ maxHeight: "42vh", overflowY: "auto", borderTop: "1px solid #e5e7eb" }}>
                    {rows.length === 0 && <div className={styles.hint} style={{ padding: "12px 4px" }}>해당 범위에 보낼 항목이 없습니다.</div>}
                    {rows.map((item) => {
                      const newQty = purchaseNewQty(item, purchaseScope);
                      const gross = purchaseQty(item, purchaseScope);
                      const done = newQty <= 0;
                      return (
                        <label key={item.code} style={{ display: "flex", gap: "0.5rem", alignItems: "center", padding: "10px 2px", borderBottom: "1px solid #f1f5f9", opacity: done ? 0.5 : 1 }}>
                          <input
                            type="checkbox"
                            disabled={done}
                            checked={!done && !!purchaseSelected[item.code]}
                            onChange={() => setPurchaseSelected((prev) => ({ ...prev, [item.code]: !prev[item.code] }))}
                          />
                          <span style={{ flex: 1, wordBreak: "break-all" }}>{renderDefectLabel(item)}</span>
                          {done ? (
                            <span className={styles.inlineTagDanger} style={{ background: "#e5e7eb", color: "#374151" }}>이동됨</span>
                          ) : (
                            <span className={styles.inlineTagDanger}>{newQty === gross ? `${newQty}개` : `신규 ${newQty}개`}</span>
                          )}
                        </label>
                      );
                    })}
                  </div>
                  <button
                    className={styles.primaryBtn}
                    style={{ width: "100%", padding: "14px 8px", fontWeight: 700, marginTop: "0.7rem", opacity: checked.length === 0 ? 0.5 : 1 }}
                    disabled={checked.length === 0 || purchaseSending}
                    onClick={handleDefectPurchaseManager}
                  >
                    {purchaseSending ? "보내는 중..." : `보내기 (${checked.length}종 ${total}개)`}
                  </button>
                </>
              );
            })()}
          </div>
        </div>
      )}

      {purchaseResult && (
        <div className={styles.modalOverlay} style={{ zIndex: 1200 }}>
          <div className={styles.modal} style={{ maxWidth: 480 }} onClick={(e) => e.stopPropagation()}>
            {(() => {
              const items = purchaseResult.items;
              const ok = items.filter((i) => i.state === "ok").length;
              const skip = items.filter((i) => i.state === "skip").length;
              const fail = items.filter((i) => i.state === "fail").length;
              const icon = { ok: "✅ 이동됨", skip: "⚠️ 이미 등록", fail: "❌ 이동 안 됨" };
              return (
                <>
                  <h4 className={styles.modalTitle}>매입관리 전송 결과</h4>
                  <p className={styles.subtitle} style={{ margin: "0.4rem 0 0.6rem" }}>
                    이동 {ok}종{skip ? ` · 이미 등록 ${skip}종` : ""}{fail ? ` · 실패 ${fail}종` : ""}
                  </p>
                  <div style={{ maxHeight: "48vh", overflowY: "auto" }}>
                    {items.map((i) => (
                      <div key={i.code} style={{ padding: "8px 2px", borderBottom: "1px solid #f1f5f9" }}>
                        <div style={{ fontWeight: 600, wordBreak: "break-all" }}>{i.label} · {i.qty}개</div>
                        <div className={styles.hint} style={{ color: i.state === "fail" ? "#dc2626" : undefined }}>{icon[i.state]} — {i.note}</div>
                      </div>
                    ))}
                  </div>
                  <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.7rem" }}>
                    <button className={styles.secondaryBtn} style={{ flex: 1, padding: "12px 4px" }} onClick={() => setPurchaseResult(null)}>닫기</button>
                    <button className={styles.primaryBtn} style={{ flex: 2, padding: "12px 4px", fontWeight: 700 }} onClick={openDefectPurchaseMenu}>거래처 불량 매입 관리 열기</button>
                  </div>
                </>
              );
            })()}
          </div>
        </div>
      )}

      {kimsungilSummonPicker && (
        <div className={styles.modalOverlay} style={{ zIndex: 1100 }} onClick={() => setKimsungilSummonPicker(null)}>
          <div className={styles.modal} style={{ maxWidth: 480 }} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <h4 className={styles.modalTitle}>불러올 탭 선택</h4>
              <div className={styles.modalActions}>
                <button className={styles.secondaryBtn} onClick={() => setKimsungilSummonPicker(null)}>닫기</button>
              </div>
            </div>
            <p className={styles.subtitle} style={{ marginBottom: "0.75rem" }}>선택한 탭의 김승일 리스트 중 입고된 상품을 그 탭의 불량 목록으로 불러옵니다. 케이디지(KDG) 상품은 어느 탭에서 불러와도 KDG 탭으로 가고, KDG 탭은 입고 여부와 관계없이 전부 불러옵니다.</p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
              {(() => {
                const counts = kimsungilSummonPicker.counts;
                const loaded = kimsungilSummonPicker.tabs.every((t) => counts[t] !== null);
                const ready = kimsungilSummonPicker.tabs.filter((t) => counts[t] && counts[t] !== "?" && counts[t].kinds > 0);
                return (
                  <button
                    className={styles.primaryBtn}
                    style={{ flex: "1 1 100%", padding: "12px 8px", fontWeight: 700 }}
                    disabled={kimsungilSummonLoading || !loaded || ready.length === 0}
                    onClick={handleKimsungilSummonAll}
                  >
                    전체 선택
                    <div style={{ fontSize: "0.8rem", fontWeight: 500 }}>
                      {!loaded ? "조회 중..." : ready.length === 0 ? "불러올 상품 없음" : `${ready.length}개 탭 · ${ready.reduce((s, t) => s + counts[t].kinds, 0)}종 ${ready.reduce((s, t) => s + counts[t].total, 0)}개`}
                    </div>
                  </button>
                );
              })()}
              {kimsungilSummonPicker.tabs.map((tab) => {
                const info = kimsungilSummonPicker.counts[tab];
                const none = info && info !== "?" && info.kinds === 0;
                const pending = hasPendingMatch(tab);
                return (
                  <button
                    key={tab}
                    className={styles.secondaryBtn}
                    style={{ flex: "1 1 90px", padding: "14px 8px", fontWeight: 700, opacity: none ? 0.5 : 1, color: redTabs.includes(tab) ? "#ef4444" : undefined }}
                    disabled={kimsungilSummonLoading || ((info === null || none) && !pending)}
                    onClick={() => {
                      // 새로 불러올 게 없고 매칭 중이던 탭이면 바로 이어서 매칭
                      if (pending && (none || info === null || info === "?")) { setKimsungilSummonPicker(null); resumeDefectMatch(tab); return; }
                      handleKimsungilSummon(tab);
                    }}
                  >
                    {tab}탭
                    <div style={{ fontSize: "0.8rem", fontWeight: 500 }}>
                      {info === null ? "조회 중..." : info === "?" ? "?" : none ? "불러올 상품 없음" : `${info.kinds}종 ${info.total}개`}
                    </div>
                    {pending && <div style={{ fontSize: "0.8rem", fontWeight: 700, color: "#2563eb" }}>{pendingMatchText(tab)} · 눌러서 이어하기</div>}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {defectSheet && (
        <DefectRecordSheet
          code={defectSheet.code}
          label={defectSheet.label}
          initialQty={defectSheet.qty ?? 1}
          attachExisting={Boolean(defectSheet.attachExisting)}
          tabHeaders={tabHeaders}
          onSaved={handleDefectRecordSaved}
          onClose={() => { setDefectSheet(null); setTimeout(() => scanRef.current?.focus(), 0); }}
        />
      )}

      {defectMatchOpen && defectMatchSession && (
        <DefectMatchModal
          session={defectMatchSession}
          onChange={saveDefectMatchSession}
          toKey={toEnglishKey}
          onRemove={removeUnmatchedDefect}
          onClose={() => { setDefectMatchOpen(false); setTimeout(() => scanRef.current?.focus(), 0); }}
        />
      )}

      {showDefectList && (
        <div className={styles.modalOverlay} onClick={() => setShowDefectList(false)}>
          <div className={`${styles.modal} ${styles.mobileCompactModal}`} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <h4 className={styles.modalTitle}>불량 리스트 ({defectTab})</h4>
              <div className={styles.modalActions}>
                <button className={styles.secondaryBtn} onClick={handleDefectExport}>내보내기</button>
                <button className={styles.secondaryBtn} onClick={handleDefectPrint}>불량출력</button>
                <button className={styles.secondaryBtn} onClick={openPurchasePicker} disabled={defectList.length === 0}>매입관리</button>
                <button className={styles.secondaryBtn} onClick={() => setShowDefectKakao(true)} disabled={defectList.length === 0}>카톡 전송</button>
                <button
                  className={styles.secondaryBtn}
                  onClick={openKimsungilSummonPicker}
                  disabled={kimsungilSummonLoading}
                >
                  {kimsungilSummonLoading ? "불러오는 중..." : "불량 불러오기"}
                </button>
                <button className={styles.secondaryBtn} onClick={() => handleDefectExportAndOchuul()} disabled={defectEzadminLoading || ochuulLoading || defectList.length === 0}>
                  {defectEzadminLoading ? "출고 중..." : ochuulLoading ? "오출 중..." : defectOchuulDoneAt && defectOchuulDoneAt.slice(0, 10) === new Date().toLocaleDateString("sv-SE") ? `출고+오출 완료 (${defectOchuulDoneAt})` : "출고+오출"}
                </button>
                <button className={styles.secondaryBtn} onClick={() => { setShowDefectList(false); setOchuulResult(null); }}>닫기</button>
              </div>
            </div>
            {renderDefectTabs()}
            {defectEzadminMsg && (
              <div className={styles.statusMsg}>{defectEzadminMsg}</div>
            )}
            {ochuulResult && (
              <div className={styles.statusMsg}
                style={{ borderColor: ochuulResult.matched > 0 ? "rgba(34,197,94,0.4)" : "rgba(234,179,8,0.4)", backgroundColor: ochuulResult.matched > 0 ? "rgba(34,197,94,0.07)" : "rgba(234,179,8,0.07)" }}>
                <strong>
                  오출내리기 완료: {ochuulResult.matched}건 차감
                  {ochuulResult.message ? ` — ${ochuulResult.message}` : ""}
                </strong>
                {ochuulResult.missing_option_codes?.length > 0 && (
                  <div style={{ marginTop: "0.5rem", color: "#b45309", fontSize: "0.85rem" }}>
                    <strong>원가베이스 옵션번호(K열) 없음 {ochuulResult.missing_option_codes.length}건</strong>
                    <div>{ochuulResult.missing_option_codes.join(", ")}</div>
                  </div>
                )}
                {ochuulResult.ably_missing_codes?.length > 0 && (
                  <div style={{ marginTop: "0.5rem", color: "#b45309", fontSize: "0.85rem" }}>
                    <strong>에이블리 오늘출발 옵션 목록에 없음 {ochuulResult.ably_missing_codes.length}건</strong>
                    <div>{ochuulResult.ably_missing_codes.join(", ")}</div>
                  </div>
                )}
                {ochuulResult.details?.length > 0 && (
                  <ul style={{ margin: "0.5rem 0 0", paddingLeft: "1rem", fontSize: "0.85rem" }}>
                    {ochuulResult.details.map((d, i) => (
                      <li key={i}>{d._goods_name} {d._option_name} — {d._prev_stock} → {d.stock} ({-d._ea_minus})</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            <div className={`${styles.uploadRow} ${styles.mobileInlineRow}`}>
              <input
                value={defectSearchQuery}
                onChange={(e) => setDefectSearchQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") searchDefectBaseByName(); }}
                placeholder="G열 상품명 검색"
                className={styles.searchInput}
              />
              <button className={styles.secondaryBtn} onClick={searchDefectBaseByName} disabled={defectSearchLoading}>
                {defectSearchLoading ? "검색 중..." : "불량 검색"}
              </button>
            </div>
            <div className={styles.modalBody}>
            {defectSearchMessage && (
              <div className={styles.statusMsg}>
                <strong>{defectSearchMessage}</strong>
              </div>
            )}
            {defectSearchRows.length > 0 && (
              <div className={styles.defectList} style={{ marginBottom: "0.75rem" }}>
                {defectSearchRows.map((row, idx) => (
                  <div key={`${row.code}-${idx}`} className={styles.defectLine}>
                    <span className={styles.defectText}>
                      {row.base_name}
                      {row.base_color && <span className={styles.inlineMeta} style={{ marginLeft: "0.4rem" }}>{row.base_color}</span>}
                      {row.base_code && <span className={styles.inlineMeta} style={{ marginLeft: "0.4rem" }}>{row.base_code}</span>}
                    </span>
                    <button className={styles.ghostBtn} onClick={() => addDefectFromSearch(row)}>추가</button>
                  </div>
                ))}
              </div>
            )}
            {defectList.length === 0 ? (
              <div className={styles.empty}>등록된 불량이 없습니다.</div>
            ) : (
              <div className={styles.defectList}>
                {defectList.filter((item) => (item.normal_qty ?? item.count) > 0).map((item, idx) => (
                  <div key={`${item.code}-defect-${idx}`} className={styles.defectLine}>
                    <span className={styles.defectText}>{renderDefectLabel(item)}</span>
                    {(() => {
                      const st = purchaseStateOf(item);
                      return (
                        <>
                          <span
                            className={styles.inlineTagDanger}
                            style={st === "done" ? { background: "#e5e7eb", color: "#6b7280", borderColor: "#d1d5db" } : undefined}
                          >
                            불량 {item.normal_qty ?? item.count}
                          </span>
                          {st === "done" && <span className={styles.inlineTagDanger} style={{ background: "#dcfce7", color: "#166534", borderColor: "#86efac" }}>✅ 매입관리 이동완료</span>}
                          {st === "partial" && <span className={styles.inlineTagDanger} style={{ background: "#fef9c3", color: "#854d0e", borderColor: "#fde047" }}>일부 이동됨</span>}
                        </>
                      );
                    })()}
                    <div className={styles.defectActions}>
                      <button className={styles.ghostBtn} onClick={() => handleDefectDec(item.code)}>-1</button>
                      <button className={styles.ghostBtn} onClick={() => handleDefectRemove(item.code)}>삭제</button>
                      {(() => {
                        const recs = defectRecords.filter((r) => r.code === item.code);
                        const recCount = recs.length;
                        const photoCount = recs.reduce((s, r) => s + (r.photo_ids?.length || 0), 0);
                        return (
                          <button
                            className={styles.ghostBtn}
                            title="사진·사유 보기 / 사진 추가 / 불량 추가"
                            disabled={recCount === 0}
                            onClick={() => setDefectPhotoCode(item.code)}
                          >
                            📷{recCount > 0 ? ` ${photoCount}장${recCount > 1 ? ` · ${recCount}건` : ""}` : ""}
                          </button>
                        );
                      })()}
                    </div>
                    {(() => {
                      // 불량 수량 중 아직 사진·사유 기록이 없는 개수 (기존 등록분 / 기록 없이 쌓인 불량)
                      const recs = defectRecords.filter((r) => r.code === item.code);
                      const unrecorded = (item.normal_qty ?? item.count) - recs.reduce((s, r) => s + (Number(r.qty) || 0), 0);
                      return unrecorded > 0 ? (
                        <button
                          className={styles.ghostBtn}
                          onClick={() => setDefectSheet({ code: item.code, label: renderDefectLabel(item), attachExisting: true, qty: unrecorded })}
                        >
                          {recs.length > 0 ? `사진·사유 추가 (${unrecorded}개)` : "사진·사유 등록"}
                        </button>
                      ) : null;
                    })()}
                  </div>
                ))}
              </div>
            )}
            {summonedByTab.some((g) => g.rows.length > 0) && (
              <div style={{ marginTop: "1rem", borderTop: "2px solid var(--border-color)", paddingTop: "0.75rem" }}>
                <h4 className={styles.modalTitle} style={{ marginBottom: "0.5rem" }}>불량관리 목록</h4>
                {summonedByTab.filter((g) => g.rows.length > 0).map((g) => (
                  <div key={`summon-group-${g.tab}`} style={{ marginBottom: "0.75rem" }}>
                    <div style={{ fontWeight: 700, marginBottom: "0.3rem" }}>
                      <span className={styles.pill}>{g.tab}탭</span>
                    </div>
                    <div className={styles.defectList}>
                      {g.rows.map((item) => (
                        <div key={`${g.tab}-${item.code}-summon`} className={styles.defectLine}>
                          <span className={styles.defectText}>{renderDefectLabel(item)}</span>
                          <span className={styles.inlineTagIncoming}>불량관리 {item.kimsungil_summon_qty}</span>
                          <span className={styles.inlineMeta}>{g.tab}탭</span>
                          <div className={styles.defectActions}>
                            <button className={styles.ghostBtn} onClick={() => handleKimsungilRevert(g.tab, item.code)}>불량관리로 되돌리기</button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
            </div>
          </div>
        </div>
      )}

      <DefectKakaoModal
        open={showDefectKakao}
        onClose={() => setShowDefectKakao(false)}
        tabHeaders={tabHeaders}
        counts={Object.fromEntries(
          defectList
            .filter((item) => (Number(item.count) || 0) > 0)
            .map((item) => [String(item.code || "").trim(), Number(item.count) || 0])
        )}
      />

      {/* 김승일 리스트 모달 */}
      {showKimsungilList && (
        <div className={styles.modalOverlay} onClick={() => setShowKimsungilList(false)}>
          <div className={`${styles.modal} ${styles.mobileCompactModal}`} style={{ width: "min(1100px, 96vw)" }} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <h4 className={styles.modalTitle}>불량관리 리스트 ({defectTab})</h4>
              <div className={styles.modalActions}>
                <span className={styles.pill}>합계 {getKimsungilTotalCount()}</span>
                <span className={styles.pill} title={getKimsungilNoCostCount() > 0 ? `원가를 찾지 못한 상품 ${getKimsungilNoCostCount()}종은 제외됨` : "원가베이스유 원가 × 수량"}>
                  {defectTab}탭 원가 {getKimsungilTotalCost().toLocaleString()}원{getKimsungilNoCostCount() > 0 ? ` (원가없음 ${getKimsungilNoCostCount()}종 제외)` : ""}
                </span>
                <span className={styles.pill} title={getAllTabsNoCostCount() > 0 ? `원가를 찾지 못한 상품 ${getAllTabsNoCostCount()}종은 제외됨` : "A·B·C 탭 원가 합계"}>
                  전체 원가 {getAllTabsTotalCost().toLocaleString()}원
                </span>
                <button className={styles.secondaryBtn} onClick={() => setShowKimsungilList(false)}>닫기</button>
              </div>
            </div>
            <div className={`${styles.uploadRow} ${styles.mobileInlineRow}`}>
              <input
                value={unifiedQuery}
                onChange={(e) => setUnifiedQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") searchUnified(); }}
                placeholder="A·B·C 통합검색 (등록된 상품명/코드)"
                className={styles.searchInput}
              />
              <button className={styles.secondaryBtn} onClick={searchUnified} disabled={unifiedLoading}>
                {unifiedLoading ? "검색 중..." : "통합검색"}
              </button>
            </div>
            {unifiedRows && (
              <div className={styles.defectList} style={{ marginBottom: "0.75rem" }}>
                {unifiedRows.length === 0 ? (
                  <div className={styles.empty}>통합검색 결과가 없습니다.</div>
                ) : unifiedRows.map((item, idx) => (
                  <div key={`${item.tab}-${item.code}-${idx}`} className={styles.defectLine}>
                    <span className={styles.inlineTagDanger}>{item.tab}탭</span>
                    <span className={styles.defectText}>{renderDefectLabel(item)}</span>
                    <span style={{ fontSize:"0.75rem", fontWeight:700 }}>추가 {item.count}</span>
                    {defectTabs.filter((t) => t !== item.tab).map((t) => (
                      <button key={t} className={styles.ghostBtn} onClick={() => moveUnifiedItem(item, t)}>→{t}탭</button>
                    ))}
                    <button className={styles.ghostBtn} onClick={() => switchDefectTab(item.tab)}>{item.tab}탭 보기</button>
                  </div>
                ))}
              </div>
            )}
            {renderDefectTabs(true)}
            <div className={`${styles.uploadRow} ${styles.mobileInlineRow}`}>
              <input
                value={kimsungilSearchQuery}
                onChange={(e) => setKimsungilSearchQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") searchKimsungilByName(); }}
                placeholder="G열 상품명 검색"
                className={styles.searchInput}
              />
              <button className={styles.secondaryBtn} onClick={searchKimsungilByName} disabled={kimsungilSearchLoading}>
                {kimsungilSearchLoading ? "검색 중..." : "김승일 검색"}
              </button>
            </div>
            <div className={styles.modalBody}>
            {kimsungilSearchMessage && (
              <div className={styles.statusMsg}>
                <strong>{kimsungilSearchMessage}</strong>
              </div>
            )}
            {kimsungilSearchRows.length > 0 && (
              <div className={styles.defectList} style={{ marginBottom: "0.75rem" }}>
                {kimsungilSearchRows.map((row, idx) => (
                  <div key={`${row.code}-${idx}`} className={styles.defectLine}>
                    <span className={styles.defectText}>
                      {row.base_name}
                      {row.base_color && <span className={styles.inlineMeta} style={{ marginLeft: "0.4rem" }}>{row.base_color}</span>}
                      {row.base_code && <span className={styles.inlineMeta} style={{ marginLeft: "0.4rem" }}>{row.base_code}</span>}
                    </span>
                    <button className={styles.ghostBtn} onClick={() => addKimsungilFromSearch(row)}>추가</button>
                  </div>
                ))}
              </div>
            )}
            {kimsungilList.length === 0 ? (
              <div className={styles.empty}>등록된 김승일 상품이 없습니다.</div>
            ) : (
              <div className={styles.defectList}>
                <div style={{ marginBottom: "0.4rem" }}>
                  <button
                    className={styles.secondaryBtn}
                    onClick={() => setKimsungilNameSort((v) => (v === "desc" ? "asc" : v === "asc" ? "" : "desc"))}
                  >
                    상품명 {kimsungilNameSort === "desc" ? "내림차순 ▼" : kimsungilNameSort === "asc" ? "오름차순 ▲" : "정렬"}
                  </button>
                </div>
                {[...kimsungilList].sort((a, b) => {
                  if (kimsungilNameSort) {
                    const cmp = String(a.base_name || "").localeCompare(String(b.base_name || ""), "ko");
                    return kimsungilNameSort === "desc" ? -cmp : cmp;
                  }
                  return ((b.incoming_qty || 0) > 0 ? 1 : 0) - ((a.incoming_qty || 0) > 0 ? 1 : 0);
                }).map((item, idx) => (
                  <div key={`${item.code}-kimsungil-${idx}`} className={styles.defectLine}>
                    <span className={styles.defectText}>{renderDefectLabel(item)}</span>
                    <span style={{ fontSize:"0.75rem", fontWeight:700, padding:"0.2rem 0.5rem", borderRadius:"999px", backgroundColor:"rgba(56,182,255,0.15)", color:"#0a6fa8", border:"1px solid rgba(56,182,255,0.3)" }}>추가 {item.count}</span>
                    {(item.incoming_qty || 0) > 0 && <span className={styles.inlineTagIncoming}>입고 {item.incoming_qty}</span>}
                    {item.base_cost > 0 && (
                      <span className={styles.inlineMeta}>{(item.base_cost * item.count).toLocaleString()}원</span>
                    )}
                    <div className={styles.defectActions}>
                      <button className={styles.ghostBtn} onClick={() => openKimsungilLog(item.code)}>로그</button>
                      <button className={styles.ghostBtn} onClick={() => handleKimsungilDec(item.code)}>-1</button>
                      <button className={styles.ghostBtn} onClick={() => handleKimsungilRemove(item.code)}>삭제</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            </div>
          </div>
        </div>
      )}

      {/* 김승일 로그 모달 */}
      {showKimsungilLog && (
        <div className={styles.modalOverlay} onClick={() => setShowKimsungilLog(false)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <h4 className={styles.modalTitle}>김승일 로그 — {kimsungilLogCode}</h4>
              <div className={styles.modalActions}>
                <button className={styles.secondaryBtn} onClick={() => fetchKimsungilLog(kimsungilLogCode)} disabled={kimsungilLogLoading}>
                  {kimsungilLogLoading ? "불러오는 중..." : "새로고침"}
                </button>
                <button className={styles.secondaryBtn} onClick={() => setShowKimsungilLog(false)}>닫기</button>
              </div>
            </div>
            <div className={styles.modalBody}>
              {kimsungilLogMessage && (
                <div className={styles.statusMsg}>
                  <strong>{kimsungilLogMessage}</strong>
                </div>
              )}
              {kimsungilLogRows.length > 0 && (
                <div className={styles.tableWrap}>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th>시간</th>
                        <th>방식</th>
                        <th>상품명</th>
                        <th>처리자</th>
                      </tr>
                    </thead>
                    <tbody>
                      {kimsungilLogRows.map((row) => (
                        <tr key={row.id}>
                          <td>{row.created_at}</td>
                          <td>{row.method}</td>
                          <td>{row.name}</td>
                          <td>{row.display_name || row.username}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {showDefectBaseEditor && (
        <div className={styles.modalOverlay} onClick={() => setShowDefectBaseEditor(false)}>
          <div className={styles.modal} style={{ width: "min(1100px, 96vw)" }} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <div>
                <h4 className={styles.modalTitle}>불량베이스 편집</h4>
                <p className={styles.subtitle} style={{ marginTop: "0.25rem" }}>
                  필요할 때만 불러와서 수정합니다.
                </p>
              </div>
              <div className={styles.modalActions}>
                <button className={styles.secondaryBtn} onClick={fetchDefectBase} disabled={defectBaseLoading}>
                  {defectBaseLoading ? "불러오는 중..." : "새로고침"}
                </button>
                <button className={styles.secondaryBtn} onClick={addDefectBaseRow}>
                  행 추가
                </button>
                <button className={styles.primaryBtn} onClick={saveDefectBase} disabled={defectBaseSaving}>
                  {defectBaseSaving ? "저장 중..." : "저장"}
                </button>
                <button className={styles.secondaryBtn} onClick={() => setShowDefectBaseEditor(false)}>
                  닫기
                </button>
              </div>
            </div>

            {defectBasePath && (
              <div className={styles.statusMsg}>
                <strong>{defectBasePath}</strong>
              </div>
            )}

            <div className={styles.uploadRow}>
              <input
                value={defectBaseQuery}
                onChange={(e) => setDefectBaseQuery(e.target.value)}
                placeholder="상품코드, 상품명, 옵션 검색"
                className={styles.searchInput}
              />
              <span className={styles.pill}>전체 {defectBaseRows.length}건</span>
              <span className={styles.pill}>표시 {defectBaseRowsToShow.length}건</span>
            </div>

            {defectBaseMessage && (
              <div className={styles.statusMsg}>
                <strong>{defectBaseMessage}</strong>
              </div>
            )}

            <div className={`${styles.tableWrap} ${styles.registeredTableWrap}`}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>#</th>
                    {defectBaseHeaders.map((header, idx) => (
                      <th key={`defect-base-header-${idx}`}>{header || `${idx + 1}열`}</th>
                    ))}
                    <th>관리</th>
                  </tr>
                </thead>
                <tbody>
                  {defectBaseRowsToShow.length === 0 ? (
                    <tr>
                      <td colSpan={9} className={styles.empty}>표시할 불량베이스 데이터가 없습니다.</td>
                    </tr>
                  ) : (
                    defectBaseRowsToShow.map((row) => {
                      const actualIndex = defectBaseRows.indexOf(row);
                      const values = Array.isArray(row.values) ? row.values : ["", "", "", "", "", "", ""];
                      return (
                        <tr key={`defect-base-row-${row.row_index ?? "new"}-${actualIndex}`}>
                          <td>{row.row_index ?? "신규"}</td>
                          {Array.from({ length: 7 }).map((_, colIndex) => (
                            <td key={`defect-base-cell-${actualIndex}-${colIndex}`}>
                              <input
                                value={values[colIndex] ?? ""}
                                onChange={(e) => updateDefectBaseCell(actualIndex, colIndex, e.target.value)}
                                className={styles.cellInput}
                              />
                            </td>
                          ))}
                          <td>
                            <button className={styles.ghostBtn} onClick={() => removeDefectBaseRow(actualIndex)}>
                              삭제
                            </button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {showIncomingVoucherModal && (
        <div className={styles.modalOverlay} onClick={() => setShowIncomingVoucherModal(false)}>
          <div className={styles.modal} style={{ width: "min(480px, 92vw)" }} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <span className={styles.modalTitle}>입고전표 선택 ({incomingEzDate})</span>
              <button type="button" className={styles.secondaryBtn} onClick={() => setShowIncomingVoucherModal(false)}>
                닫기
              </button>
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontWeight: 600, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={selectedIncomingSheets.length === incomingVoucherList.length && incomingVoucherList.length > 0}
                onChange={(e) =>
                  setSelectedIncomingSheets(e.target.checked ? incomingVoucherList.map((v) => String(v.sheet)) : [])
                }
              />
              전체 선택 ({selectedIncomingSheets.length}/{incomingVoucherList.length})
            </label>
            <div
              style={{
                display: "flex", flexDirection: "column", gap: "0.1rem", maxHeight: 340, overflowY: "auto",
                border: "1px solid var(--border-color)", borderRadius: "var(--radius-sm)", padding: "0.25rem",
              }}
            >
              {incomingVoucherList.map((v) => {
                const sheet = String(v.sheet);
                const checked = selectedIncomingSheets.includes(sheet);
                const c = v.cell || {};
                const displayName = c.sheet_name || c.title || c.supply_name || "";
                const subInfo = [c.crdate, c.req_qty ? `${c.req_qty}개` : null].filter(Boolean).join(" · ");
                return (
                  <label
                    key={sheet}
                    style={{ display: "flex", alignItems: "center", gap: "0.5rem", padding: "0.35rem 0.6rem", borderRadius: "var(--radius-sm)", cursor: "pointer" }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() =>
                        setSelectedIncomingSheets((prev) => (checked ? prev.filter((s) => s !== sheet) : [...prev, sheet]))
                      }
                    />
                    <span style={{ fontFamily: "monospace", fontSize: "0.82rem", color: "var(--text-muted)", minWidth: "4.5rem", flexShrink: 0 }}>
                      {sheet}
                    </span>
                    <span style={{ fontSize: "0.9rem", flex: 1 }}>{displayName}</span>
                    {subInfo && <span style={{ fontSize: "0.8rem", color: "var(--text-muted)", flexShrink: 0 }}>{subInfo}</span>}
                  </label>
                );
              })}
            </div>
            <button
              type="button"
              className={styles.primaryBtn}
              onClick={handleIncomingVoucherConfirm}
              disabled={!selectedIncomingSheets.length}
            >
              {selectedIncomingSheets.length}건 불러오기
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
