"""판매자 사유 반품/교환 데이터를 SQLite(공유 DB)에 쌓고 통계를 내는 저장소.

- 판매자 판별은 사이드메뉴 반품(returns_routes.py)과 같은 기준을 쓴다.
  반품: return_delivery_fee 가 음수(고객 부담)가 아니면 판매자.
  교환: reason_code 2(상품 하자), 3(오배송)이면 판매자.
- 같은 건은 key 로 upsert 되므로 상태(41→42→43→44)가 바뀔 때마다 갱신만 된다.
"""
from __future__ import annotations

import re
from collections import Counter
from datetime import datetime, timedelta

SELLER_EXCHANGE_CODES = {2, 3}

CANCEL_REASON_TEXT = {
    30: "단순변심",
    31: "사이즈/색상 불만족",
    32: "상품 하자/오배송",
    1: "셀러 변경",
}
EXCHANGE_REASON_TEXT = {2: "상품 하자", 3: "오배송"}

STATUS_TEXT = {41: "회수신청 전", 42: "회수신청됨", 43: "환불요청", 44: "반품완료"}

_COLUMNS = (
    "key", "kind", "order_sno", "cancel_sno", "item_sno", "invoice", "goods_sno", "goods_name",
    "option_info", "custom_code", "vendor", "qty", "refund_amount", "return_delivery_fee",
    "reason_code", "reason_text", "user_comment", "status", "received_at",
    "confirm_requested_at", "completed_at", "ref_date", "source",
)


def init_seller_return_tables(conn) -> None:
    conn.execute(
        "CREATE TABLE IF NOT EXISTS seller_returns ("
        " key TEXT PRIMARY KEY, kind TEXT NOT NULL, order_sno TEXT, cancel_sno TEXT, item_sno TEXT,"
        " invoice TEXT, goods_sno TEXT, goods_name TEXT, option_info TEXT, custom_code TEXT, vendor TEXT,"
        " qty INTEGER, refund_amount INTEGER, return_delivery_fee INTEGER, reason_code INTEGER,"
        " reason_text TEXT, user_comment TEXT, status INTEGER, received_at TEXT,"
        " confirm_requested_at TEXT, completed_at TEXT, ref_date TEXT, source TEXT,"
        " first_seen_at TEXT NOT NULL, updated_at TEXT NOT NULL)"
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_seller_returns_ref_date ON seller_returns(ref_date)")
    conn.commit()


def is_seller_return_item(item: dict) -> bool:
    fee = item.get("return_delivery_fee")
    return not (fee is not None and fee < 0)


def is_seller_exchange(ex: dict) -> bool:
    return ex.get("reason_code") in SELLER_EXCHANGE_CODES


def _s(v) -> str:
    return "" if v is None else str(v).strip()


def _i(v):
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _vendor(custom_code: str) -> str:
    # 상품관리코드 "케이디지 FJ7351 14000" = 거래처 품번 원가
    parts = custom_code.split()
    return parts[0] if parts else ""


def _day(ts) -> str:
    return _s(ts)[:10]


def return_row(item: dict, cancel_sno=None, source: str = "") -> dict:
    """에이블리 order_cancels 의 order_item 한 건 → 저장용 dict."""
    code = _i(item.get("cancel_reason"))
    custom = _s(item.get("goods_custom_code"))
    received = _s(item.get("cancel_received_at"))
    confirm = _s(item.get("confirm_requested_at"))
    completed = _s(item.get("cancel_completed_at"))
    return {
        "key": f"return:{item.get('sno')}",
        "kind": "return",
        "order_sno": _s(item.get("order_sno")),
        "cancel_sno": _s(cancel_sno or item.get("cancel_sno")),
        "item_sno": _s(item.get("sno")),
        "invoice": _s(item.get("invoice")),
        "goods_sno": _s(item.get("goods_sno")),
        "goods_name": _s(item.get("goods_name")),
        "option_info": _s(item.get("option_info")),
        "custom_code": custom,
        "vendor": _vendor(custom),
        "qty": _i(item.get("ea")) or 1,
        "refund_amount": _i(item.get("refund_amount")) or 0,
        "return_delivery_fee": _i(item.get("return_delivery_fee")) or 0,
        "reason_code": code,
        "reason_text": CANCEL_REASON_TEXT.get(code, f"기타({code})" if code is not None else "미상"),
        "user_comment": _s(item.get("user_comment")),
        "status": _i(item.get("processing_sub_status")),
        "received_at": received,
        "confirm_requested_at": confirm,
        "completed_at": completed,
        "ref_date": _day(completed or confirm or received),
        "source": source,
    }


def exchange_row(ex: dict, source: str = "") -> dict:
    """에이블리 exchanges 한 건 → 저장용 dict (첫 번째 교환상품 기준)."""
    items = ex.get("exchange_items") or []
    first = items[0] if items else {}
    order_item = first.get("order_item") or {}
    sno = ex.get("exchange_sno") or ex.get("sno")
    code = _i(ex.get("reason_code"))
    custom = _s(order_item.get("goods_custom_code"))
    requested = _s(ex.get("requested_at") or ex.get("created_at"))
    return {
        "key": f"exchange:{sno}",
        "kind": "exchange",
        "order_sno": _s(ex.get("order_sno") or order_item.get("order_sno")),
        "cancel_sno": _s(sno),
        "item_sno": _s(first.get("order_item_sno") or ex.get("order_item_sno")),
        "invoice": _s(order_item.get("invoice")),
        "goods_sno": _s(order_item.get("goods_sno")),
        "goods_name": _s(order_item.get("goods_name") or first.get("goods_name") or ex.get("goods_name")),
        "option_info": _s(order_item.get("option_info")),
        "custom_code": custom,
        "vendor": _vendor(custom),
        "qty": sum(_i(i.get("ea")) or 1 for i in items) or 1,
        "refund_amount": 0,
        "return_delivery_fee": 0,
        "reason_code": code,
        "reason_text": EXCHANGE_REASON_TEXT.get(code, f"기타({code})" if code is not None else "미상"),
        "user_comment": _s(ex.get("detail_reason")),
        "status": _i(ex.get("status")),
        "received_at": requested,
        "confirm_requested_at": "",
        "completed_at": "",
        "ref_date": _day(requested) or datetime.now().strftime("%Y-%m-%d"),
        "source": source,
    }


def upsert_rows(conn, rows: list[dict]) -> int:
    """rows 를 저장한다. 새로 들어간 건수가 아니라 처리한 건수를 돌려준다.

    이미 값이 있는 날짜 컬럼은 빈 값으로 덮어쓰지 않는다(상태가 진행되면 채워지기만 함)."""
    if not rows:
        return 0
    init_seller_return_tables(conn)
    now = datetime.now().isoformat(timespec="seconds")
    cols = ", ".join(_COLUMNS)
    marks = ", ".join("?" for _ in _COLUMNS)
    keep = ("goods_name", "option_info", "custom_code", "vendor", "invoice", "user_comment",
            "received_at", "confirm_requested_at", "completed_at")
    updates = ", ".join(
        f"{c}=COALESCE(NULLIF(excluded.{c}, ''), seller_returns.{c})" if c in keep else f"{c}=excluded.{c}"
        for c in _COLUMNS
        if c not in ("key", "source", "ref_date")
    )
    sql = (
        f"INSERT INTO seller_returns ({cols}, first_seen_at, updated_at) VALUES ({marks}, ?, ?) "
        f"ON CONFLICT(key) DO UPDATE SET {updates}, updated_at=excluded.updated_at"
    )
    for row in rows:
        conn.execute(sql, tuple(row[c] for c in _COLUMNS) + (now, now))
    conn.commit()
    # ref_date 는 갱신된 날짜 컬럼 기준으로 다시 계산한다.
    conn.execute(
        "UPDATE seller_returns SET ref_date = SUBSTR(COALESCE(NULLIF(completed_at,''), NULLIF(confirm_requested_at,''),"
        " NULLIF(received_at,''), ref_date), 1, 10) WHERE kind = 'return'"
    )
    conn.commit()
    return len(rows)


def record_safely(get_db, rows: list[dict]) -> int:
    """자동처리 흐름에서 쓰는 저장. 통계 저장 실패가 본 작업을 막으면 안 되므로 예외는 삼킨다."""
    if not rows or get_db is None:
        return 0
    try:
        conn = get_db()
        try:
            return upsert_rows(conn, rows)
        finally:
            conn.close()
    except Exception:
        return 0


_TAG_RE = re.compile(r"\[[^\]]*\]|\([^)]*\)|#\S+")
_SYMBOL_RE = re.compile(r"[^\w\s가-힣\-/.+]", re.UNICODE)


def display_name(name: str) -> str:
    """에이블리 상품명의 [홍보문구], (괄호), #해시태그, 이모지를 걷어낸 표시용 이름."""
    cleaned = _SYMBOL_RE.sub(" ", _TAG_RE.sub(" ", name or ""))
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned or (name or "").strip()


def _sales_by_code(conn, start: str, end: str) -> dict:
    try:
        cur = conn.execute(
            "SELECT yusas_code, SUM(sales_qty) AS q FROM order_recommendation_daily "
            "WHERE date >= ? AND date <= ? AND sales_qty IS NOT NULL GROUP BY yusas_code",
            (start, end),
        )
        return {r["yusas_code"]: int(r["q"] or 0) for r in cur.fetchall()}
    except Exception:
        return {}


def _top(counter: Counter, n: int = 10) -> list[dict]:
    return [{"name": k or "(미상)", "count": v} for k, v in counter.most_common(n)]


def _sales_by_day(conn, start: str, end: str) -> dict:
    """일별 판매(출고 대용) 수량. 주문추천이 모으는 에이블리 판매통계(order_recommendation_daily)를 쓴다.

    판매 수량이 아직 수집되지 않은 날은 합계가 NULL/0이라 빠진다(반품률 계산에서도 제외)."""
    try:
        cur = conn.execute(
            "SELECT date, SUM(sales_qty) AS q FROM order_recommendation_daily "
            "WHERE date >= ? AND date <= ? AND sales_qty IS NOT NULL GROUP BY date",
            (start, end),
        )
        return {r["date"]: int(r["q"] or 0) for r in cur.fetchall() if r["q"]}
    except Exception:
        return {}


def _date_range(start: str, end: str) -> list[str]:
    d0 = datetime.strptime(start, "%Y-%m-%d")
    d1 = datetime.strptime(end, "%Y-%m-%d")
    return [(d0 + timedelta(days=i)).strftime("%Y-%m-%d") for i in range((d1 - d0).days + 1)]


def _pct(num: int, den: int):
    return round(num / den * 100, 2) if den else None


MIN_SALES_FOR_RATE = 20  # 판매가 이보다 적은 상품은 1건만 반품돼도 100%가 되므로 반품률 순위에서 뺀다
RANK_SIZE = 15


def _product_rankings(rows, sales_days: set, sales_by_code: dict, goods_codes: dict, min_sales: int):
    """상품(goods_sno)별 판매자 반품 수량 / 판매 수량. 반품률 순위와 반품 건수 순위를 돌려준다."""
    prods: dict = {}
    for r in rows:
        if r["kind"] != "return" or not r["goods_sno"]:
            continue
        p = prods.setdefault(r["goods_sno"], {"names": Counter(), "count": 0, "qty": 0})
        p["names"][r["goods_name"]] += 1
        p["count"] += 1
        if r["ref_date"] in sales_days:
            p["qty"] += r["qty"] or 1

    out = []
    for gsno, p in prods.items():
        sales = sum(sales_by_code.get(code, 0) for code in goods_codes.get(gsno, ()))
        out.append({
            "goods_sno": gsno,
            "name": display_name(p["names"].most_common(1)[0][0]),
            "count": p["count"],
            "return_qty": p["qty"],
            "sales": sales,
            "rate": _pct(p["qty"], sales),
        })
    by_rate = sorted(
        (p for p in out if p["sales"] >= min_sales and p["rate"] is not None),
        key=lambda p: (-p["rate"], -p["count"]),
    )
    by_count = sorted(out, key=lambda p: (-p["count"], -(p["rate"] or 0)))
    return by_rate[:RANK_SIZE], by_count[:RANK_SIZE]


def _vendor_rankings(rows, sales_days: set, sales_by_code: dict, goods_codes: dict, code_vendor: dict):
    """거래처별 판매자 반품 건수 + 판매 수량/반품률. 거래처는 원가베이스유 기준(없으면 상품관리코드 첫 단어)."""
    goods_vendor: dict = {}
    for gsno, codes in goods_codes.items():
        vs = Counter(code_vendor[c] for c in codes if code_vendor.get(c))
        if vs:
            goods_vendor[gsno] = vs.most_common(1)[0][0]

    stat: dict = {}
    for r in rows:
        name = goods_vendor.get(r["goods_sno"]) or r["vendor"] or "(미상)"
        v = stat.setdefault(name, {"count": 0, "qty": 0})
        v["count"] += 1
        if r["kind"] == "return" and r["ref_date"] in sales_days:
            v["qty"] += r["qty"] or 1

    sales_of: Counter = Counter()
    for code, q in sales_by_code.items():
        if code_vendor.get(code):
            sales_of[code_vendor[code]] += q

    out = []
    for name, v in stat.items():
        sales = sales_of.get(name, 0)
        out.append({"name": name, "count": v["count"], "return_qty": v["qty"], "sales": sales,
                    "rate": _pct(v["qty"], sales)})
    out.sort(key=lambda x: (-x["count"], -(x["rate"] or 0)))
    return out[:10]


def compute_stats(conn, start: str, end: str, goods_codes: dict | None = None,
                  min_sales: int = MIN_SALES_FOR_RATE, code_vendor: dict | None = None) -> dict:
    """ref_date 가 [start, end] 인 판매자 건을 집계한다.

    goods_codes: {에이블리 goods_sno: [상품코드, ...]} - 있으면 상품별 반품률을 계산한다.
    code_vendor: {상품코드: 거래처} - 있으면 거래처별 판매 수량/반품률을 계산한다."""
    init_seller_return_tables(conn)
    cur = conn.execute(
        "SELECT kind, goods_sno, goods_name, vendor, qty, refund_amount, reason_text, status, ref_date, user_comment "
        "FROM seller_returns WHERE ref_date >= ? AND ref_date <= ?",
        (start, end),
    )
    rows = [dict(r) for r in cur.fetchall()]

    by_kind = Counter(r["kind"] for r in rows)
    by_status = Counter(STATUS_TEXT.get(r["status"], str(r["status"] or "-")) for r in rows)
    day_return: Counter = Counter()
    day_exchange: Counter = Counter()
    day_return_qty: Counter = Counter()
    for r in rows:
        if r["kind"] == "return":
            day_return[r["ref_date"]] += 1
            day_return_qty[r["ref_date"]] += r["qty"] or 1
        else:
            day_exchange[r["ref_date"]] += 1

    sales = _sales_by_day(conn, start, end)
    days = _date_range(start, end)
    daily = []
    for i, d in enumerate(days):
        window = days[max(0, i - 6): i + 1]
        w_sales = sum(sales.get(x, 0) for x in window)
        w_ret = sum(day_return_qty.get(x, 0) for x in window if x in sales)
        daily.append({
            "date": d,
            "return": day_return.get(d, 0),
            "exchange": day_exchange.get(d, 0),
            "sales": sales.get(d, 0),
            # 하루치는 들쭉날쭉해서 최근 7일 누적 기준 반품률(%)로 보여준다.
            "rate7": _pct(w_ret, w_sales),
        })

    # 반품률 = 판매 수량이 수집된 날의 판매자 반품 수량 ÷ 그날들의 판매 수량
    sales_total = sum(sales.values())
    rate_return_qty = sum(q for d, q in day_return_qty.items() if d in sales)

    sales_by_code = _sales_by_code(conn, start, end) if goods_codes else {}
    rank_by_rate, rank_by_count = _product_rankings(
        rows, set(sales), sales_by_code, goods_codes or {}, min_sales
    )
    vendor_rank = _vendor_rankings(rows, set(sales), sales_by_code, goods_codes or {}, code_vendor or {})

    return {
        "start": start,
        "end": end,
        "total": len(rows),
        "return_count": by_kind.get("return", 0),
        "exchange_count": by_kind.get("exchange", 0),
        "qty": sum(r["qty"] or 0 for r in rows),
        "refund_amount": sum(r["refund_amount"] or 0 for r in rows),
        "sales_total": sales_total,
        "sales_days": len(sales),
        "return_rate": _pct(rate_return_qty, sales_total),
        "by_vendor": vendor_rank,
        "products_by_rate": rank_by_rate,
        "products_by_count": rank_by_count,
        "min_sales": min_sales,
        "by_status": _top(by_status, 10),
        "daily": daily,
    }
