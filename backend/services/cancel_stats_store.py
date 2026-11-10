"""취소통계 — 에이블리 '주문취소(cancel_type=cancel)' 이력과 배송지연 스냅샷을 SQLite에 쌓고 집계한다.

- cancel_items   : 취소 요청 1건(주문상품 단위). key = 주문상품 sno 로 upsert (상태가 바뀌면 갱신만).
- delay_items    : 상품준비중 + 배송지연 주문상품 스냅샷. 지연은 이력이 남지 않으므로 주기적으로 찍어 둔다.
- 집계는 모두 DB 에서만 한다(화면을 열어도 에이블리를 치지 않는다).
"""
from __future__ import annotations

import re
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta

# 취소 사유 코드 — 실제 고객 코멘트로 추정한 이름이다(2=품절만 캡처로 확정). 틀린 코드는 여기만 고치면 된다.
CANCEL_REASON_TEXT = {
    1: "단순변심",
    2: "품절",
    3: "배송지연",
    12: "재주문/주문실수",
    13: "옵션(사이즈·색상) 변경",
    14: "배송지·배송 관련",
    21: "문의/응대 불만",
}

# 경과일(결제일 → 취소요청일) 구간. (이름, 시작, 끝)  끝 None = 이상
ELAPSED_BUCKETS = [
    ("당일", 0, 0),
    ("1~3일", 1, 3),
    ("4~5일", 4, 5),
    ("6~10일", 6, 10),
    ("11일+", 11, None),
]

_PREFIX_RE = re.compile(r"^(\s*\[[^\]]*\]\s*)+")


def normalize_name(name: str) -> str:
    """상품명 앞의 [마케팅 문구] 를 걷어낸다. 걷어내고 비면 원래 이름을 쓴다."""
    s = (name or "").strip()
    out = _PREFIX_RE.sub("", s).strip()
    return out or s


def reason_text(code) -> str:
    if code is None:
        return "미기재"
    return CANCEL_REASON_TEXT.get(code, f"기타({code})")


def _s(v) -> str:
    return "" if v is None else str(v).strip()


def _i(v):
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _vendor(custom_code: str) -> str:
    parts = custom_code.split()
    return parts[0] if parts else ""


def _day(ts) -> str:
    return _s(ts)[:10]


def elapsed_days(paid_at: str, received_at: str):
    try:
        p = date.fromisoformat(_day(paid_at))
        r = date.fromisoformat(_day(received_at))
    except ValueError:
        return None
    return max((r - p).days, 0)


def bucket_name(days) -> str:
    if days is None:
        return "미상"
    for name, lo, hi in ELAPSED_BUCKETS:
        if days >= lo and (hi is None or days <= hi):
            return name
    return "미상"


def init_tables(conn) -> None:
    conn.execute(
        "CREATE TABLE IF NOT EXISTS cancel_items ("
        " key TEXT PRIMARY KEY, cancel_sno TEXT, order_sno TEXT, goods_sno TEXT, goods_name TEXT,"
        " norm_name TEXT, option_info TEXT, custom_code TEXT, vendor TEXT, qty INTEGER,"
        " reason_code INTEGER, reason_text TEXT, status INTEGER, delivery_type TEXT,"
        " paid_at TEXT, received_at TEXT, completed_at TEXT, day TEXT, elapsed_days INTEGER,"
        " updated_at TEXT NOT NULL)"
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_cancel_items_day ON cancel_items(day)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_cancel_items_goods ON cancel_items(goods_sno)")
    conn.execute(
        "CREATE TABLE IF NOT EXISTS delay_items ("
        " snapshot_at TEXT NOT NULL, item_sno TEXT NOT NULL, goods_sno TEXT, goods_name TEXT,"
        " norm_name TEXT, custom_code TEXT, vendor TEXT, qty INTEGER, delay_days INTEGER,"
        " delivery_type TEXT, paid_at TEXT, PRIMARY KEY (snapshot_at, item_sno))"
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_delay_items_snap ON delay_items(snapshot_at)")
    conn.execute("CREATE TABLE IF NOT EXISTS cancel_stats_meta (k TEXT PRIMARY KEY, v TEXT)")
    conn.commit()


def meta_get(conn, key: str, default: str = "") -> str:
    row = conn.execute("SELECT v FROM cancel_stats_meta WHERE k = ?", (key,)).fetchone()
    return row[0] if row else default


def meta_set(conn, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO cancel_stats_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
        (key, value),
    )
    conn.commit()


def cancel_row(item: dict, cancel_sno=None) -> dict:
    """order_cancels[].order_items[] 한 건 → 저장용 dict."""
    custom = _s(item.get("goods_custom_code"))
    code = _i(item.get("cancel_reason"))
    paid = _s(item.get("checked_at") or item.get("ordered_at"))
    received = _s(item.get("cancel_received_at"))
    return {
        "key": _s(item.get("sno")),
        "cancel_sno": _s(cancel_sno or item.get("cancel_sno")),
        "order_sno": _s(item.get("order_sno")),
        "goods_sno": _s(item.get("goods_sno")),
        "goods_name": _s(item.get("goods_name")),
        "norm_name": normalize_name(_s(item.get("goods_name"))),
        "option_info": _s(item.get("option_info")),
        "custom_code": custom,
        "vendor": _vendor(custom),
        "qty": _i(item.get("ea")) or 1,
        "reason_code": code,
        "reason_text": reason_text(code),
        "status": _i(item.get("processing_sub_status")),
        "delivery_type": _s(item.get("delivery_type")),
        "paid_at": paid,
        "received_at": received,
        "completed_at": _s(item.get("cancel_completed_at")),
        "day": _day(received),
        "elapsed_days": elapsed_days(paid, received),
    }


_CANCEL_COLS = (
    "key", "cancel_sno", "order_sno", "goods_sno", "goods_name", "norm_name", "option_info", "custom_code",
    "vendor", "qty", "reason_code", "reason_text", "status", "delivery_type", "paid_at", "received_at",
    "completed_at", "day", "elapsed_days",
)


def upsert_cancels(conn, rows: list[dict]) -> int:
    if not rows:
        return 0
    now = datetime.now().isoformat(timespec="seconds")
    cols = ", ".join(_CANCEL_COLS)
    marks = ", ".join("?" for _ in _CANCEL_COLS)
    updates = ", ".join(f"{c}=excluded.{c}" for c in _CANCEL_COLS if c != "key")
    sql = (
        f"INSERT INTO cancel_items ({cols}, updated_at) VALUES ({marks}, ?) "
        f"ON CONFLICT(key) DO UPDATE SET {updates}, updated_at=excluded.updated_at"
    )
    conn.executemany(sql, [tuple(r[c] for c in _CANCEL_COLS) + (now,) for r in rows])
    conn.commit()
    return len(rows)


def delay_row(item: dict, snapshot_at: str) -> dict:
    custom = _s(item.get("goods_custom_code"))
    return {
        "snapshot_at": snapshot_at,
        "item_sno": _s(item.get("sno")),
        "goods_sno": _s(item.get("goods_sno")),
        "goods_name": _s(item.get("goods_name")),
        "norm_name": normalize_name(_s(item.get("goods_name"))),
        "custom_code": custom,
        "vendor": _vendor(custom),
        "qty": _i(item.get("ea")) or 1,
        "delay_days": _i(item.get("delay_days")) or 0,
        "delivery_type": _s(item.get("delivery_type")),
        "paid_at": _s(item.get("checked_at") or item.get("ordered_at")),
    }


_DELAY_COLS = (
    "snapshot_at", "item_sno", "goods_sno", "goods_name", "norm_name", "custom_code", "vendor", "qty",
    "delay_days", "delivery_type", "paid_at",
)


def save_delay_snapshot(conn, rows: list[dict], keep_days: int = 35) -> int:
    if rows:
        cols = ", ".join(_DELAY_COLS)
        marks = ", ".join("?" for _ in _DELAY_COLS)
        conn.executemany(
            f"INSERT OR REPLACE INTO delay_items ({cols}) VALUES ({marks})",
            [tuple(r[c] for c in _DELAY_COLS) for r in rows],
        )
    cutoff = (datetime.now() - timedelta(days=keep_days)).isoformat(timespec="seconds")
    conn.execute("DELETE FROM delay_items WHERE snapshot_at < ?", (cutoff,))
    conn.commit()
    return len(rows)


# ---------------------------------------------------------------- 집계

def _period_key(day: str, group: str) -> str:
    if group == "day":
        return day
    d = date.fromisoformat(day)
    if group == "week":
        monday = d - timedelta(days=d.weekday())
        return monday.isoformat()  # 주 시작(월요일)
    return day[:7]  # month


def _fill_periods(start: date, end: date, group: str) -> list[str]:
    keys, cur = [], start
    while cur <= end:
        k = _period_key(cur.isoformat(), group)
        if not keys or keys[-1] != k:
            keys.append(k)
        cur += timedelta(days=1)
    return keys


def _load_cancels(conn, start: str, end: str) -> list[dict]:
    rows = conn.execute(
        "SELECT * FROM cancel_items WHERE day >= ? AND day <= ?", (start, end)
    ).fetchall()
    return [dict(r) for r in rows]


def compute_cancel_stats(conn, today: date, days: int, group: str) -> dict:
    start = today - timedelta(days=days - 1)
    rows = _load_cancels(conn, start.isoformat(), today.isoformat())
    # 취소 건수 = 주문상품 건수(qty 합이 아니라 건수). 수량은 별도 표기.
    reasons_total = Counter(r["reason_text"] for r in rows)
    reason_names = [name for name, _ in reasons_total.most_common()]

    periods = _fill_periods(start, today, group)
    series = {p: {"total": 0, "by_reason": Counter()} for p in periods}
    for r in rows:
        k = _period_key(r["day"], group)
        if k in series:
            series[k]["total"] += 1
            series[k]["by_reason"][r["reason_text"]] += 1
    series_out = [
        {"period": p, "total": series[p]["total"], **{n: series[p]["by_reason"].get(n, 0) for n in reason_names}}
        for p in periods
    ]

    bucket_names = [b[0] for b in ELAPSED_BUCKETS] + ["미상"]
    bucket_total = Counter(bucket_name(r["elapsed_days"]) for r in rows)
    bucket_by_reason: dict[str, Counter] = defaultdict(Counter)
    for r in rows:
        bucket_by_reason[bucket_name(r["elapsed_days"])][r["reason_text"]] += 1
    elapsed_out = [
        {"bucket": b, "total": bucket_total.get(b, 0), **{n: bucket_by_reason[b].get(n, 0) for n in reason_names}}
        for b in bucket_names
        if b != "미상" or bucket_total.get("미상")
    ]
    known = [r["elapsed_days"] for r in rows if r["elapsed_days"] is not None]

    # 상품 순위 (goods_sno 기준 — 이름이 바뀌어도 같은 상품으로 묶는다)
    prod: dict[str, dict] = {}
    for r in sorted(rows, key=lambda x: x["received_at"]):
        p = prod.setdefault(r["goods_sno"], {
            "goods_sno": r["goods_sno"], "name": r["norm_name"], "vendor": r["vendor"],
            "count": 0, "qty": 0, "reasons": Counter(),
        })
        p["name"] = r["norm_name"] or p["name"]
        p["vendor"] = r["vendor"] or p["vendor"]
        p["count"] += 1
        p["qty"] += r["qty"] or 1
        p["reasons"][r["reason_text"]] += 1
    top_products = sorted(prod.values(), key=lambda x: x["count"], reverse=True)[:20]
    for p in top_products:
        p["reasons"] = dict(p["reasons"].most_common())

    vend = Counter(r["vendor"] or "미지정" for r in rows)
    delay_reason = reasons_total.get("배송지연", 0)
    return {
        "start": start.isoformat(),
        "end": today.isoformat(),
        "group": group,
        "total": len(rows),
        "qty": sum(r["qty"] or 1 for r in rows),
        "avg_elapsed": round(sum(known) / len(known), 1) if known else None,
        "delay_reason_count": delay_reason,
        "reason_names": reason_names,
        "reasons": [{"name": n, "count": c} for n, c in reasons_total.most_common()],
        "series": series_out,
        "elapsed": elapsed_out,
        "top_products": top_products,
        "top_vendors": [{"vendor": v, "count": c} for v, c in vend.most_common(15)],
    }


def compute_surge(conn, today: date, window: int = 3, min_recent: int = 5, min_ratio: float = 2.0) -> list[dict]:
    """최근 window일 vs 직전 window일 취소 건수 비교. 총량이 적어도 급격히 늘면 잡는다."""
    start = today - timedelta(days=window * 2 - 1)
    rows = _load_cancels(conn, start.isoformat(), today.isoformat())
    recent_start = today - timedelta(days=window - 1)
    trend_days = [(today - timedelta(days=i)).isoformat() for i in range(window * 2 - 1, -1, -1)]
    by_goods: dict[str, dict] = {}
    for r in rows:
        g = by_goods.setdefault(r["goods_sno"], {
            "goods_sno": r["goods_sno"], "name": r["norm_name"], "vendor": r["vendor"],
            "daily": Counter(),
        })
        g["daily"][r["day"]] += 1
    out = []
    for g in by_goods.values():
        daily = [g["daily"].get(d, 0) for d in trend_days]
        prev, recent = sum(daily[:window]), sum(daily[window:])
        if recent < min_recent:
            continue
        ratio = round((recent + 1) / (prev + 1), 1)  # +1 보정: 0 → N 도 비교 가능
        if ratio < min_ratio:
            continue
        out.append({
            "goods_sno": g["goods_sno"], "name": g["name"], "vendor": g["vendor"],
            "recent": recent, "previous": prev, "ratio": ratio,
            "daily": [{"day": d[5:], "count": c} for d, c in zip(trend_days, daily)],
            "since": recent_start.isoformat(),
        })
    out.sort(key=lambda x: (x["ratio"], x["recent"]), reverse=True)
    return out[:30]


def compute_delay(conn, today: date) -> dict:
    snaps = [r[0] for r in conn.execute(
        "SELECT DISTINCT snapshot_at FROM delay_items ORDER BY snapshot_at DESC LIMIT 1"
    )]
    if not snaps:
        return {"snapshot_at": "", "total": 0, "products": [], "vendors": [], "days_dist": [], "trend": [], "risk": []}
    snap = snaps[0]
    rows = [dict(r) for r in conn.execute("SELECT * FROM delay_items WHERE snapshot_at = ?", (snap,))]

    # 최근 7일 같은 상품 취소 중 '배송지연' 사유 / 전체 사유
    since = (today - timedelta(days=6)).isoformat()
    cancel_recent = defaultdict(lambda: [0, 0])  # goods_sno → [전체, 배송지연사유]
    for r in conn.execute("SELECT goods_sno, reason_code FROM cancel_items WHERE day >= ?", (since,)):
        c = cancel_recent[r["goods_sno"]]
        c[0] += 1
        if r["reason_code"] == 3:
            c[1] += 1

    prod: dict[str, dict] = {}
    for r in rows:
        p = prod.setdefault(r["goods_sno"], {
            "goods_sno": r["goods_sno"], "name": r["norm_name"], "vendor": r["vendor"],
            "items": 0, "qty": 0, "max_days": 0, "sum_days": 0, "types": Counter(),
        })
        p["items"] += 1
        p["qty"] += r["qty"] or 1
        p["max_days"] = max(p["max_days"], r["delay_days"] or 0)
        p["sum_days"] += r["delay_days"] or 0
        p["types"][r["delivery_type"]] += 1
    products = []
    for p in prod.values():
        c_all, c_delay = cancel_recent.get(p["goods_sno"], [0, 0])
        # 위험도: 지연 건수·지연일수가 크고, 이미 지연 사유 취소가 나오고 있으면 가중
        score = p["items"] * (1 + p["max_days"] / 3) + c_delay * 3
        level = "높음" if (p["max_days"] >= 5 or c_delay >= 3) else "주의" if (p["max_days"] >= 3 or c_delay >= 1) else "관찰"
        products.append({
            "goods_sno": p["goods_sno"], "name": p["name"], "vendor": p["vendor"],
            "items": p["items"], "qty": p["qty"], "max_days": p["max_days"],
            "avg_days": round(p["sum_days"] / p["items"], 1),
            "types": dict(p["types"]),
            "cancel_7d": c_all, "delay_cancel_7d": c_delay,
            "score": round(score, 1), "level": level,
        })
    products.sort(key=lambda x: (x["max_days"], x["items"]), reverse=True)
    risk = sorted(products, key=lambda x: x["score"], reverse=True)[:30]

    vend: dict[str, dict] = {}
    for p in products:
        v = vend.setdefault(p["vendor"] or "미지정", {"vendor": p["vendor"] or "미지정", "items": 0, "products": 0, "max_days": 0})
        v["items"] += p["items"]
        v["products"] += 1
        v["max_days"] = max(v["max_days"], p["max_days"])
    vendors = sorted(vend.values(), key=lambda x: x["items"], reverse=True)[:20]

    dist = Counter()
    for r in rows:
        d = r["delay_days"] or 0
        dist["1~3일" if d <= 3 else "4~7일" if d <= 7 else "8~14일" if d <= 14 else "15일+"] += 1
    days_dist = [{"bucket": b, "count": dist.get(b, 0)} for b in ("1~3일", "4~7일", "8~14일", "15일+")]

    # 스냅샷별 전체 지연 건수 추이 (하루 마지막 스냅샷만)
    trend_rows = conn.execute(
        "SELECT snapshot_at, COUNT(*) AS n FROM delay_items GROUP BY snapshot_at ORDER BY snapshot_at"
    ).fetchall()
    by_day: dict[str, int] = {}
    for r in trend_rows:
        by_day[r["snapshot_at"][:10]] = r["n"]
    trend = [{"day": d[5:], "count": n} for d, n in sorted(by_day.items())][-14:]

    return {
        "snapshot_at": snap, "total": len(rows), "products": products[:30], "vendors": vendors,
        "days_dist": days_dist, "trend": trend, "risk": risk,
    }


def compute_products(conn, today: date, days: int, surge_window: int = 3, min_recent: int = 5, min_ratio: float = 2.0) -> dict:
    """상품 하나당 한 줄: 기간 취소·주요 사유·최근 추이·급증 여부·현재 지연/위험을 합쳐 돌려준다."""
    start = today - timedelta(days=days - 1)
    rows = _load_cancels(conn, start.isoformat(), today.isoformat())
    spark_days = [(today - timedelta(days=i)).isoformat() for i in range(13, -1, -1)]
    trend_days = [(today - timedelta(days=i)).isoformat() for i in range(surge_window * 2 - 1, -1, -1)]

    prods: dict[str, dict] = {}

    def ensure(gs, name, vendor):
        return prods.setdefault(gs, {
            "goods_sno": gs, "name": name, "vendor": vendor, "cancel": 0, "qty": 0,
            "reasons": Counter(), "daily": Counter(), "delay_items": 0, "delay_max": 0, "delay_avg": 0.0,
        })

    for r in rows:
        p = ensure(r["goods_sno"], r["norm_name"], r["vendor"])
        p["name"] = r["norm_name"] or p["name"]
        p["vendor"] = r["vendor"] or p["vendor"]
        p["cancel"] += 1
        p["qty"] += r["qty"] or 1
        p["reasons"][r["reason_text"]] += 1
        p["daily"][r["day"]] += 1

    snap = conn.execute("SELECT MAX(snapshot_at) FROM delay_items").fetchone()[0]
    delay_cancel_7d: dict[str, int] = {}
    since7 = (today - timedelta(days=6)).isoformat()
    for r in conn.execute("SELECT goods_sno, COUNT(*) AS n FROM cancel_items WHERE day >= ? AND reason_code = 3 GROUP BY goods_sno", (since7,)):
        delay_cancel_7d[r["goods_sno"]] = r["n"]
    if snap:
        agg: dict[str, list] = {}
        for r in conn.execute("SELECT * FROM delay_items WHERE snapshot_at = ?", (snap,)):
            p = ensure(r["goods_sno"], r["norm_name"], r["vendor"])
            a = agg.setdefault(r["goods_sno"], [0, 0, 0])
            a[0] += 1
            a[1] = max(a[1], r["delay_days"] or 0)
            a[2] += r["delay_days"] or 0
        for gs, (n, mx, sm) in agg.items():
            prods[gs]["delay_items"], prods[gs]["delay_max"], prods[gs]["delay_avg"] = n, mx, round(sm / n, 1)

    out = []
    for p in prods.values():
        dl = [p["daily"].get(d, 0) for d in trend_days]
        prev, recent = sum(dl[:surge_window]), sum(dl[surge_window:])
        ratio = round((recent + 1) / (prev + 1), 1)
        surging = recent >= min_recent and ratio >= min_ratio
        c_delay = delay_cancel_7d.get(p["goods_sno"], 0)
        level = ""
        if p["delay_items"]:
            level = "높음" if (p["delay_max"] >= 5 or c_delay >= 3) else "주의" if (p["delay_max"] >= 3 or c_delay >= 1) else "관찰"
        top_reason, top_n = (p["reasons"].most_common(1) or [("", 0)])[0]
        out.append({
            "goods_sno": p["goods_sno"], "name": p["name"], "vendor": p["vendor"],
            "cancel": p["cancel"], "qty": p["qty"],
            "top_reason": top_reason, "top_reason_pct": round(top_n / p["cancel"] * 100) if p["cancel"] else 0,
            "reasons": dict(p["reasons"].most_common()),
            "spark": [p["daily"].get(d, 0) for d in spark_days],
            "prev": prev, "recent": recent, "ratio": ratio, "surging": surging,
            "delay_items": p["delay_items"], "delay_max": p["delay_max"], "delay_avg": p["delay_avg"],
            "delay_cancel_7d": c_delay, "level": level,
        })
    out.sort(key=lambda x: (x["cancel"], x["delay_items"]), reverse=True)
    return {
        "start": start.isoformat(), "end": today.isoformat(), "snapshot_at": snap or "",
        "total_products": len(out), "items": out[:300],
    }
