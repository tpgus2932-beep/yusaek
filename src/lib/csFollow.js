// SO+ 가 C/S 메뉴에 떠 있는 정보를 따라 읽는다.
// 원칙: SO+ 에서 C/S 의 할 일(문의 최신화·에이블리 API 호출)은 하지 않는다. C/S 메뉴가 이미 가진 정보만 읽는다.
//  - 상품별 문의: C/S 상품별 탭이 쓰는 것과 같은 /cs/dashboard (서버에 저장된 문의를 읽을 뿐, 에이블리를 호출하지 않는다)
//  - 악성지연: C/S 악성지연 탭이 불러온 결과를 그 탭이 남겨 둔 스냅샷으로 읽는다 (SO+ 가 직접 부르지 않는다)
import { LOCAL_API_BASE, getAuthHeaders } from "./api";

const KEY = "soPlusCsMalignantSnapshot";
const EVENT = "cs-malignant-snapshot";

// 백엔드 to_s_code 와 같은 규칙: YUSAS코드는 S코드로 본다
export const normCode = (code) => {
  const v = String(code || "").trim();
  return /^yusas/i.test(v) ? `S${v.slice(5)}` : v;
};

const minIso = (a, b) => (!a ? (b || "") : !b ? a : (a < b ? a : b));

let memory = null;

// ── 악성지연: C/S 악성지연 탭이 목록을 받을 때마다 호출 ───────────────────────────
export function saveMalignantSnapshot(items, fetchedAt) {
  const byCode = {};
  let unmatched = 0;
  (items || []).forEach((it) => {
    const code = normCode(it.code);
    if (!code) { unmatched += 1; return; }
    const a = byCode[code] || (byCode[code] = { orders: 0, qty: 0, oldest: "", list: [] });
    a.orders += 1;
    if (a.list.length < 30) {
      a.list.push({ order_sno: it.order_sno, buyer: it.buyer_name || "", option: it.option_info || "", delay: it.delay_days ?? null, ordered_at: it.ordered_at || "" });
    }
    a.qty += Number(it.ea) || 0;
    a.oldest = minIso(a.oldest, it.ordered_at || "");
  });
  memory = { fetchedAt: fetchedAt || new Date().toISOString(), byCode, total: (items || []).length, unmatched };
  try { sessionStorage.setItem(KEY, JSON.stringify(memory)); } catch { /* 저장 못 해도 메모리 값은 쓴다 */ }
  try { window.dispatchEvent(new CustomEvent(EVENT)); } catch { /* noop */ }
}

export function getMalignantSnapshot() {
  if (memory) return memory;
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw) memory = JSON.parse(raw);
  } catch { memory = null; }
  return memory;
}

export function onMalignantSnapshot(cb) {
  window.addEventListener(EVENT, cb);
  return () => window.removeEventListener(EVENT, cb);
}

// ── 상품별 문의: 진행 중인 문의를 원가베이스 상품코드(옵션 단위)별로 센다 ──────────────
export async function loadInquiryStats() {
  const res = await fetch(`${LOCAL_API_BASE}/cs/dashboard?product_limit=300&room_limit=200&with_match=true`, { headers: getAuthHeaders() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.detail || "C/S 상품별 정보를 읽지 못했습니다.");
  const inq = {};
  let matched = 0;
  let unmatched = 0;
  (data.by_product || []).forEach((prod) => {
    (prod.rooms || []).forEach((r) => {
      const code = normCode(r.option_match?.code);
      if (!code) { unmatched += 1; return; }
      matched += 1;
      const a = inq[code] || (inq[code] = { count: 0, waiting: 0, oldest: "", rooms: [] });
      a.count += 1;
      a.rooms.push({
        sno: r.sno,
        name: r.member?.name || "",
        category: r.child_category_display || r.parent_category_display || "",
        waiting: !!r.waiting,
        preview: r.latest_message?.content || "",
        at: r.updated_latest_message_at || "",
      });
      if (r.waiting) a.waiting += 1;
      a.oldest = minIso(a.oldest, r.updated_latest_message_at || "");
    });
  });
  // 미답변 먼저, 그 안에서는 오래 기다린 순
  Object.values(inq).forEach((a) => a.rooms.sort((x, y) => Number(y.waiting) - Number(x.waiting) || (x.at < y.at ? -1 : 1)));
  return { inq, inqAt: new Date().toISOString(), inqMatched: matched, inqUnmatched: unmatched, baseAvailable: data.base_available ?? null, inqError: "" };
}
