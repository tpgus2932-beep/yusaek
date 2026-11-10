from __future__ import annotations

import json
import re
import time
from collections import defaultdict
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Body, Depends, HTTPException

from sdk.ezadmin import EzAdminSessionExpired
from services.ezadmin_im00_client import fetch_im00_detail_rows, fetch_im00_vouchers
from services.order_history_store import init_order_history_table

_KST = ZoneInfo("Asia/Seoul")
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_CACHE_TTL_SEC = 600
_detail_cache: dict[tuple, tuple[float, list[dict]]] = {}

KIND_NORMAL = "normal"          # 일반입고
KIND_MISONG = "misong"          # 미송 (요청수량)
KIND_PICKUP = "misong_pickup"   # 미송픽업
KIND_EXCHANGE = "exchange_pickup"  # 교환픽업 (대조 제외)


def _norm_text(value) -> str:
    return re.sub(r"\s+", "", str(value or "")).strip()


def has_pickup_marker(value) -> bool:
    t = _norm_text(value)
    return "미송픽업" in t or ("미송" in t and "픽업" in t)


def has_exchange_pickup_marker(value) -> bool:
    t = _norm_text(value)
    return "교환픽업" in t or ("교환" in t and "픽업" in t)


def to_s_code(code: str) -> str:
    value = str(code or "").strip()
    return f"S{value[5:]}" if value.upper().startswith("YUSAS") else value


def classify_voucher_row(row: dict) -> list[tuple[str, int]]:
    """전표 상세 한 줄을 [(구분, 수량)]으로 나눈다.

    NoyeKimPage.jsx convertCurrentReceiptExcelRowsSplitV3와 같은 규칙:
    - 입고수량>0: 교환픽업/미송픽업(요청수량이 없는 줄의 메모)이면 해당 구분, 아니면 일반입고
    - 요청수량>0: 교환픽업 > 미송픽업 > 그 외는 미송
    - 입고수량<0은 매입차감이라 무시
    """
    in_qty = int(row.get("in_qty") or 0)
    req_qty = int(row.get("req_qty") or 0)
    memo = row.get("memo") or ""
    exchange = has_exchange_pickup_marker(memo)
    pickup = has_pickup_marker(memo)
    out: list[tuple[str, int]] = []
    if in_qty > 0:
        if exchange:
            out.append((KIND_EXCHANGE, in_qty))
        elif pickup and req_qty <= 0:
            out.append((KIND_PICKUP, in_qty))
        else:
            out.append((KIND_NORMAL, in_qty))
    if req_qty > 0:
        if exchange:
            out.append((KIND_EXCHANGE, req_qty))
        elif pickup:
            out.append((KIND_PICKUP, req_qty))
        else:
            out.append((KIND_MISONG, req_qty))
    return out


def memo_deduction(row: dict) -> int:
    """요청메모가 음수 숫자(예: -50050)면 매입차감 금액(음수)으로 돌려준다. 아니면 0."""
    text = str(row.get("memo") or "").strip().replace(",", "").replace("원", "")
    if not text:
        return 0
    try:
        v = float(text)
    except ValueError:
        return 0
    return int(round(v)) if v < 0 else 0


def _status(ordered: int, received: int, misong: int) -> str:
    """발주 대비 입고 상태. 예) 10개 발주, 5개 입고 -> partial (프론트에서 '5/10' 표시).
    none=발주 없음, full=전량 입고, partial=일부 입고, misong=입고 없이 미송만 잡힘,
    missing=전표에 없음, over=발주보다 많이 입고."""
    if ordered <= 0:
        return "no_order" if (received or misong) else "none"
    if received > ordered:
        return "over"
    if received == ordered:
        return "full"
    if received > 0:
        return "partial"
    return "misong" if misong > 0 else "missing"


def _check_date(value: str) -> str:
    value = str(value or "").strip()
    if not _DATE_RE.match(value):
        raise HTTPException(status_code=400, detail="날짜 형식이 올바르지 않습니다.")
    return value


def receive_date_of(vouchers, order_dates) -> str:
    """매칭 기록이 배정되는 날짜 = 입고요청 전표 날짜 (전표가 여러 날짜면 가장 이른 날). 전표가 없으면 발주일."""
    dates = sorted({str(v.get("date") or "") for v in (vouchers or []) if isinstance(v, dict) and v.get("date")})
    if dates:
        return dates[0]
    return str(order_dates[0]) if order_dates else ""


def build_order_receiving_compare_router(*, require_admin, get_db, get_setting, get_wonbe_db, get_janggi_db=None, get_current_user=None):
    router = APIRouter(prefix="/order-receiving")
    _any_user = get_current_user or require_admin

    def _init_records(conn) -> None:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS order_receiving_records (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                order_date TEXT NOT NULL,
                title TEXT NOT NULL DEFAULT '',
                memo TEXT NOT NULL DEFAULT '',
                vouchers_json TEXT NOT NULL DEFAULT '[]',
                result_json TEXT NOT NULL DEFAULT '{}',
                created_by TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_order_receiving_records_date ON order_receiving_records(order_date)")
        cols = [r["name"] for r in conn.execute("PRAGMA table_info(order_receiving_records)").fetchall()]
        if "order_dates_json" not in cols:
            conn.execute("ALTER TABLE order_receiving_records ADD COLUMN order_dates_json TEXT NOT NULL DEFAULT ''")
        if "receive_date" not in cols:  # 매칭이 배정되는 날짜 = 입고요청 전표 날짜 (order_date 는 발주일)
            conn.execute("ALTER TABLE order_receiving_records ADD COLUMN receive_date TEXT NOT NULL DEFAULT ''")
        # 대시보드(일자별 발주수량 > 입고수량)용 상품 단위 정규화 테이블
        conn.execute("""
            CREATE TABLE IF NOT EXISTS order_receiving_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                record_id INTEGER NOT NULL,
                order_date TEXT NOT NULL,
                client TEXT NOT NULL DEFAULT '',
                product_code TEXT NOT NULL DEFAULT '',
                product_name TEXT NOT NULL DEFAULT '',
                option_name TEXT NOT NULL DEFAULT '',
                ordered INTEGER NOT NULL DEFAULT 0,
                received INTEGER NOT NULL DEFAULT 0,
                misong INTEGER NOT NULL DEFAULT 0,
                ordered_pickup INTEGER NOT NULL DEFAULT 0,
                pickup INTEGER NOT NULL DEFAULT 0,
                exchange INTEGER NOT NULL DEFAULT 0
            )
        """)
        item_cols = [r["name"] for r in conn.execute("PRAGMA table_info(order_receiving_items)").fetchall()]
        for col in ("cost", "amount", "ordered_amount", "vat", "deduct"):
            if col not in item_cols:
                conn.execute(f"ALTER TABLE order_receiving_items ADD COLUMN {col} INTEGER NOT NULL DEFAULT 0")
        if "receive_date" not in item_cols:
            conn.execute("ALTER TABLE order_receiving_items ADD COLUMN receive_date TEXT NOT NULL DEFAULT ''")
        if "vat_override" not in item_cols:  # 부가세를 직접 고친 거래처의 부가세 금액 (NULL = 자동 10%)
            conn.execute("ALTER TABLE order_receiving_items ADD COLUMN vat_override INTEGER")
        for rr in conn.execute("SELECT id, order_date, vouchers_json FROM order_receiving_records WHERE receive_date = ''").fetchall():
            try:
                vs = json.loads(rr["vouchers_json"] or "[]")
            except ValueError:
                vs = []
            conn.execute("UPDATE order_receiving_records SET receive_date = ? WHERE id = ?",
                         (receive_date_of(vs, [rr["order_date"]]), rr["id"]))
        conn.execute(
            "UPDATE order_receiving_items SET receive_date = COALESCE("
            "(SELECT r.receive_date FROM order_receiving_records r WHERE r.id = order_receiving_items.record_id), order_date) "
            "WHERE receive_date = ''"
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_order_receiving_records_recv ON order_receiving_records(receive_date)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_order_receiving_items_recv ON order_receiving_items(receive_date)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_order_receiving_items_record ON order_receiving_items(record_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_order_receiving_items_date ON order_receiving_items(order_date)")
        conn.commit()
        # 매칭 시점의 원가/부가세 대상 여부를 저장분에 고정(스냅샷). 이미 고정된 건은 건드리지 않는다.
        try:
            unfrozen = conn.execute(
                "SELECT id, order_date, result_json FROM order_receiving_records "
                "WHERE result_json NOT LIKE '%\"cost_snapshot\"%'"
            ).fetchall()
            for row in unfrozen:
                res = _attach_costs(json.loads(row["result_json"] or "{}"))
                conn.execute("UPDATE order_receiving_records SET result_json = ? WHERE id = ?",
                             (json.dumps(res, ensure_ascii=False), row["id"]))
                _save_items(conn, row["id"], row["order_date"], res)
            if unfrozen:
                conn.commit()
        except Exception:
            pass  # 원가 DB를 못 열면 다음 기회에 고정 (조회는 계속 동작)
        # 아직 정규화되지 않은 기존 저장분 백필
        missing = conn.execute(
            "SELECT id, order_date, result_json FROM order_receiving_records "
            "WHERE id NOT IN (SELECT DISTINCT record_id FROM order_receiving_items)"
        ).fetchall()
        for row in missing:
            try:
                _save_items(conn, row["id"], row["order_date"], json.loads(row["result_json"] or "{}"))
            except ValueError:
                continue
        if missing:
            conn.commit()

    def _save_items(conn, record_id: int, order_date: str, result: dict) -> None:
        conn.execute("DELETE FROM order_receiving_items WHERE record_id = ?", (record_id,))
        rd = conn.execute("SELECT receive_date FROM order_receiving_records WHERE id = ?", (record_id,)).fetchone()
        receive_date = (rd["receive_date"] if rd and rd["receive_date"] else order_date)
        for c in result.get("clients", []) or []:
            for i in c.get("items", []) or []:
                conn.execute(
                    "INSERT INTO order_receiving_items (record_id, order_date, receive_date, client, product_code, product_name, "
                    "option_name, ordered, received, misong, ordered_pickup, pickup, exchange, "
                    "cost, amount, ordered_amount, vat, deduct, vat_override) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (record_id, order_date, receive_date, c.get("client", ""), i.get("code", ""), i.get("name", ""),
                     i.get("option", ""), int(i.get("ordered") or 0), int(i.get("received") or 0),
                     int(i.get("misong") or 0), int(i.get("ordered_pickup") or 0), int(i.get("pickup") or 0),
                     int(i.get("exchange") or 0), int(i.get("cost") or 0), int(i.get("amount") or 0),
                     int(i.get("ordered_amount") or 0), 1 if c.get("vat") else 0, int(i.get("deduct") or 0),
                     (int(c["vat_override"]) if c.get("vat_override") is not None else None)),
                )

    @router.get("/clients")
    def clients_list(admin: str = Depends(require_admin)):
        """매칭이 저장된 거래처 목록 (거래처 조회 자동완성용)."""
        conn = get_db()
        try:
            _init_records(conn)
            rows = conn.execute(
                "SELECT client, COUNT(DISTINCT receive_date) AS days FROM order_receiving_items "
                "WHERE client != '' GROUP BY client ORDER BY client"
            ).fetchall()
            return {"ok": True, "clients": [{"client": r["client"], "days": r["days"]} for r in rows]}
        finally:
            conn.close()

    @router.get("/client-report")
    def client_report(client: str = "", date_from: str = "", date_to: str = "", split_days: bool = False,
                      admin: str = Depends(require_admin)):
        """기간(입고요청일 기준)의 저장된 매칭을 거래처별로 합산해 매칭 결과와 같은 모양({clients:[{client,totals,items}]})으로
        돌려준다. client를 비우면 모든 거래처, 주면 이름에 그 글자가 들어간 거래처(띄어쓰기·대소문자 무시)만. 같은 입고요청일에 매칭이 여러 번이면 가장 최근 것만 쓰고,
        같은 거래처의 같은 상품은 날짜를 넘어 합산한다. split_days면 합산하지 않고 거래처를 입고요청일별로 나눠 '거래처 · MM-DD' 그룹으로 돌려준다."""
        client = str(client or "").strip()
        today = datetime.now(_KST)
        date_to = _check_date(date_to) if date_to else today.strftime("%Y-%m-%d")
        date_from = _check_date(date_from) if date_from else today.replace(day=1).strftime("%Y-%m-%d")
        conn = get_db()
        try:
            _init_records(conn)
            rows = conn.execute(
                "SELECT i.receive_date, i.client, i.product_code, i.product_name, i.option_name, i.ordered, i.received, "
                "i.misong, i.ordered_pickup, i.pickup, i.exchange, i.cost, i.amount, i.ordered_amount, i.vat, i.deduct, i.vat_override "
                "FROM order_receiving_items i "
                "JOIN (SELECT receive_date, MAX(id) AS mid FROM order_receiving_records GROUP BY receive_date) l "
                "  ON i.record_id = l.mid "
                "WHERE (? = '' OR instr(LOWER(REPLACE(i.client, ' ', '')), ?) > 0) AND i.receive_date >= ? AND i.receive_date <= ? "
                "ORDER BY i.receive_date",
                (client, "".join(client.split()).lower(), date_from, date_to),
            ).fetchall()
        finally:
            conn.close()
        keys = ("ordered", "received", "misong", "ordered_pickup", "pickup", "exchange")
        by_client: dict[str, dict[str, dict]] = {}
        vat_of: dict[str, bool] = {}
        vat_fix: dict[str, int] = {}
        days = set()
        for r in rows:
            days.add(r["receive_date"])
            name = r["client"] or "(거래처 미확인)"
            if split_days:
                name = f"{name} · {r['receive_date'][5:]}"
            p_ = by_client.setdefault(name, {}).setdefault(r["product_code"], {
                "code": r["product_code"], "name": r["product_name"], "option": r["option_name"], "client": name,
                **{k: 0 for k in keys}, "cost": 0, "amount": 0, "ordered_amount": 0, "deduct": 0,
            })
            for k in keys:
                p_[k] += int(r[k] or 0)
            # 금액은 매칭 당시 원가로 계산된 값을 그대로 합산 (이후 원가가 바뀌어도 변하지 않음)
            p_["amount"] += int(r["amount"] or 0)
            p_["ordered_amount"] += int(r["ordered_amount"] or 0)
            p_["deduct"] += int(r["deduct"] or 0)
            p_["cost"] = int(r["cost"] or 0)
            if r["vat_override"] is not None:
                vat_fix[name] = int(r["vat_override"])
            vat_of[name] = bool(r["vat"])  # 날짜순이라 마지막(가장 최근 입고요청일) 값이 남는다
        clients = []
        for name in sorted(by_client):
            items = list(by_client[name].values())
            for it in items:
                it["missing"] = it["ordered"] - it["received"] - it["misong"]
                it["pickup_missing"] = it["ordered_pickup"] - it["pickup"]
                it["status"] = _status(it["ordered"], it["received"], it["misong"])
                it["pickup_status"] = _status(it["ordered_pickup"], it["pickup"], 0)
            clients.append({"client": name, "vat": vat_of.get(name, False), **({"vat_override": vat_fix[name]} if name in vat_fix else {}),
                            "totals": {k: sum(i[k] for i in items) for k in keys}, "items": items})
        result = _attach_costs({"clients": clients})
        return {"ok": True, "client": client, "date_from": date_from, "date_to": date_to,
                "days": sorted(days), "result": result}

    def _client_token(client: str) -> str:
        """거래처 검색어: 띄어쓰기·대소문자를 무시하고 이름에 들어 있으면 일치 (거래처 조회와 같은 규칙)."""
        return "".join(str(client or "").split()).lower()

    def _record_amounts(conn, ids: list, token: str = "") -> dict:
        """저장된 매칭별 합산 금액 = 화면의 '총 합산 금액'과 같은 계산:
        거래처별 (입고+미송 공급가 + 부가세 거래처면 10% − 매입차감(상품금액+부가세를 넘지 않게 잘라냄)).
        반환: {record_id: (입고 합산 금액, 발주 금액)}"""
        out: dict = {}
        if not ids:
            return out
        rows = conn.execute(
            "SELECT record_id, client, amount, ordered_amount, vat, deduct, vat_override FROM order_receiving_items "
            f"WHERE record_id IN ({','.join('?' * len(ids))}) "
            "AND (? = '' OR instr(LOWER(REPLACE(client, ' ', '')), ?) > 0)", [*ids, token, token],
        ).fetchall()
        per: dict = defaultdict(dict)
        for r in rows:
            g = per[r["record_id"]].setdefault(r["client"], {"supply": 0, "ordered": 0, "vat": False, "deduct": 0, "fix": None})
            g["supply"] += int(r["amount"] or 0)
            g["ordered"] += int(r["ordered_amount"] or 0)
            g["vat"] = g["vat"] or bool(r["vat"])
            if r["vat_override"] is not None:
                g["fix"] = int(r["vat_override"])
            g["deduct"] += -int(r["deduct"] or 0)
        for rid, clients in per.items():
            total = ordered_total = 0
            for g in clients.values():
                vat = g["fix"] if g["fix"] is not None else (int(g["supply"] * 0.1 + 0.5) if g["vat"] else 0)
                applied = min(max(g["deduct"], 0), max(0, g["supply"] + vat))
                total += g["supply"] + vat - applied
                ordered_total += g["ordered"] + (int(g["ordered"] * 0.1 + 0.5) if g["vat"] else 0)
            out[rid] = (total, ordered_total)
        return out

    @router.get("/daily-summary")
    def daily_summary(date_from: str = "", date_to: str = "", client: str = "", admin: str = Depends(require_admin)):
        """대시보드용: 입고요청일별 발주수량 > 입고수량 (발주 다음날 실제로 물건이 온 날로 배정). 같은 입고요청일에 매칭이
        여러 번 저장돼 있으면 가장 최근 것만 쓴다. client를 주면 그 거래처(이름에 글자가 들어간 거래처)만 집계한다."""
        token = _client_token(client)
        today = datetime.now(_KST)
        date_to = _check_date(date_to) if date_to else today.strftime("%Y-%m-%d")
        date_from = _check_date(date_from) if date_from else (today - timedelta(days=30)).strftime("%Y-%m-%d")
        conn = get_db()
        try:
            _init_records(conn)
            rows = conn.execute(
                "SELECT r.receive_date AS d, r.id AS record_id, r.updated_at AS updated_at, "
                "COALESCE(SUM(i.ordered),0) AS ordered, COALESCE(SUM(i.received),0) AS received, "
                "COALESCE(SUM(i.misong),0) AS misong, COALESCE(SUM(i.ordered_pickup),0) AS ordered_pickup, "
                "COALESCE(SUM(i.pickup),0) AS pickup, COUNT(i.id) AS n_items "
                "FROM order_receiving_records r "
                "JOIN (SELECT receive_date, MAX(id) AS mid FROM order_receiving_records GROUP BY receive_date) l "
                "  ON r.id = l.mid "
                "LEFT JOIN order_receiving_items i ON i.record_id = r.id "
                "  AND (? = '' OR instr(LOWER(REPLACE(i.client, ' ', '')), ?) > 0) "
                "WHERE r.receive_date >= ? AND r.receive_date <= ? GROUP BY r.id ORDER BY r.receive_date DESC",
                (token, token, date_from, date_to),
            ).fetchall()
            if token:  # 그 거래처가 없는 날은 뺀다
                rows = [r for r in rows if r["n_items"] > 0]
            amounts = _record_amounts(conn, [r["record_id"] for r in rows], token)
            return {"ok": True, "days": [
                {"date": r["d"], "record_id": r["record_id"], "updated_at": r["updated_at"],
                 "ordered": r["ordered"], "received": r["received"], "misong": r["misong"],
                 "ordered_pickup": r["ordered_pickup"], "pickup": r["pickup"],
                 "amount": amounts.get(r["record_id"], (0, 0))[0],
                 "ordered_amount": amounts.get(r["record_id"], (0, 0))[1]} for r in rows
            ]}
        finally:
            conn.close()

    @router.get("/product-ranking")
    def product_ranking(date_from: str = "", date_to: str = "", sort: str = "rate", limit: int = 10, client: str = "",
                        admin: str = Depends(require_admin)):
        """기간(입고요청일 기준) 동안 밀린 수량(발주 − 입고) 대비 입고율이 낮았던 상품 순위.
        같은 입고요청일에 매칭이 여러 번이면 가장 최근 것만 쓰고, 같은 상품은 날짜를 넘어 합산한다.
        sort=rate: 입고율 낮은 순(같으면 밀린 수량 많은 순) / sort=lack: 밀린 수량 많은 순.
        days_short = 그 상품이 발주보다 덜 들어온 날 수."""
        today = datetime.now(_KST)
        date_to = _check_date(date_to) if date_to else today.strftime("%Y-%m-%d")
        date_from = _check_date(date_from) if date_from else (today - timedelta(days=30)).strftime("%Y-%m-%d")
        limit = max(1, min(limit, 50))
        token = _client_token(client)
        conn = get_db()
        try:
            _init_records(conn)
            rows = conn.execute(
                "SELECT i.receive_date, i.client, i.product_code, i.product_name, i.option_name, i.ordered, i.received "
                "FROM order_receiving_items i "
                "JOIN (SELECT receive_date, MAX(id) AS mid FROM order_receiving_records GROUP BY receive_date) l "
                "  ON i.record_id = l.mid "
                "WHERE i.receive_date >= ? AND i.receive_date <= ? "
                "AND i.product_code NOT LIKE 'DEDUCT-%' AND i.product_code NOT LIKE 'FEE-%' "
                "AND (? = '' OR instr(LOWER(REPLACE(i.client, ' ', '')), ?) > 0)",
                (date_from, date_to, token, token),
            ).fetchall()
        finally:
            conn.close()
        agg: dict = {}
        for r in rows:
            key = (r["client"], r["product_code"])
            a = agg.setdefault(key, {"client": r["client"] or "(거래처 미확인)", "code": r["product_code"], "name": r["product_name"],
                                     "option": r["option_name"], "ordered": 0, "received": 0, "days_short": 0})
            o, rc = int(r["ordered"] or 0), int(r["received"] or 0)
            a["ordered"] += o
            a["received"] += rc
            if o > rc:
                a["days_short"] += 1
        items = []
        for a in agg.values():
            if a["ordered"] <= 0:
                continue
            a["lack"] = a["ordered"] - a["received"]
            if a["lack"] <= 0:
                continue  # 밀린 수량이 없는 상품은 순위에 넣지 않는다
            a["rate"] = round(a["received"] / a["ordered"] * 100, 1)
            items.append(a)
        if sort == "lack":
            items.sort(key=lambda x: (-x["lack"], x["rate"]))
        else:
            items.sort(key=lambda x: (x["rate"], -x["lack"]))
        return {"ok": True, "date_from": date_from, "date_to": date_to, "total": len(items), "items": items[:limit]}

    @router.get("/client-ranking")
    def client_ranking(date_from: str = "", date_to: str = "", client: str = "", limit: int = 5, sort: str = "ordered,lack",
                       names: str = "", admin: str = Depends(require_admin)):
        """악성 거래처 순위. 발주가 있고 덜 들어온(미입고>0) 거래처를 sort 기준으로 줄 세우고, 결과 지표로 입고율을 함께 돌려준다.
        sort: 쉼표로 여러 개 — ordered(발주 많은 순) / received(입고량 많은 순) / lack(미입고 많은 순).
          하나면 그 기준 순, 둘 이상이면 각 기준에서의 순위를 더한 값이 작은(= 여러 기준에 두루 부합하는) 거래처가 앞에 온다.
        같은 입고요청일에 매칭이 여러 번이면 가장 최근 것만 쓴다. client를 주면 이름에 그 글자가 들어간 거래처만.
        names("|"로 구분)를 주면 그 거래처들만 골라 보여준다(다 들어온 거래처도 포함, 개수 제한 없음).."""
        picked = {x.strip() for x in str(names or "").split("|") if x.strip()}
        keys = [k for k in dict.fromkeys(str(sort or "").split(",")) if k in ("ordered", "received", "lack")] or ["ordered", "lack"]
        today = datetime.now(_KST)
        date_to = _check_date(date_to) if date_to else today.strftime("%Y-%m-%d")
        date_from = _check_date(date_from) if date_from else (today - timedelta(days=30)).strftime("%Y-%m-%d")
        limit = max(1, min(limit, 30))
        token = _client_token(client)
        conn = get_db()
        try:
            _init_records(conn)
            rows = conn.execute(
                "SELECT i.client, SUM(i.ordered) AS ordered, SUM(i.received) AS received "
                "FROM order_receiving_items i "
                "JOIN (SELECT receive_date, MAX(id) AS mid FROM order_receiving_records GROUP BY receive_date) l "
                "  ON i.record_id = l.mid "
                "WHERE i.receive_date >= ? AND i.receive_date <= ? "
                "AND i.product_code NOT LIKE 'DEDUCT-%' AND i.product_code NOT LIKE 'FEE-%' "
                "AND (? = '' OR instr(LOWER(REPLACE(i.client, ' ', '')), ?) > 0) "
                "GROUP BY i.client",
                (date_from, date_to, token, token),
            ).fetchall()
        finally:
            conn.close()
        items = []
        for r in rows:
            ordered, received = int(r["ordered"] or 0), int(r["received"] or 0)
            if picked:
                if (r["client"] or "(거래처 미확인)") not in picked or ordered <= 0:
                    continue
            elif ordered <= 0 or ordered - received <= 0:
                continue  # 발주가 없거나 발주만큼 다 들어온 거래처는 악성 거래처가 아니다
            items.append({"client": r["client"] or "(거래처 미확인)", "ordered": ordered, "received": received,
                          "lack": ordered - received, "rate": round(received / ordered * 100, 1)})
        score = {x["client"]: 0 for x in items}
        for k in keys:  # 기준별 순위(많은 쪽이 0등)를 더한다
            for pos, x in enumerate(sorted(items, key=lambda v: (-v[k], v["rate"]))):
                score[x["client"]] += pos
        items.sort(key=lambda x: (score[x["client"]], *[-x[k] for k in keys], x["rate"]))
        return {"ok": True, "date_from": date_from, "date_to": date_to, "sort": keys, "total": len(items), "items": items if picked else items[:limit]}

    @router.get("/order-dates")
    def order_dates(date_from: str = "", date_to: str = "", admin: str = Depends(require_admin)):
        """기간 안에서 발주내역이 있는 일자별 건수/수량 (일자별 체크박스용). 기간을 안 주면 오늘~30일 전."""
        today = datetime.now(_KST)
        date_to = _check_date(date_to) if date_to else today.strftime("%Y-%m-%d")
        date_from = _check_date(date_from) if date_from else (today - timedelta(days=30)).strftime("%Y-%m-%d")
        init_order_history_table(get_db)
        conn = get_db()
        try:
            rows = conn.execute(
                "SELECT substr(recorded_at,1,10) AS d, COUNT(*) AS cnt, COALESCE(SUM(request_qty),0) AS qty "
                "FROM order_history WHERE product_code != '' AND recorded_at >= ? AND recorded_at <= ? "
                "GROUP BY d ORDER BY d DESC",
                (f"{date_from} 00:00:00", f"{date_to} 23:59:59"),
            ).fetchall()
            return {"ok": True, "dates": [{"date": r["d"], "rows": r["cnt"], "qty": r["qty"]} for r in rows]}
        finally:
            conn.close()

    @router.get("/vouchers")
    async def vouchers(date: str, admin: str = Depends(require_admin)):
        date = _check_date(date)
        try:
            items = await fetch_im00_vouchers(get_setting, date=date)
        except EzAdminSessionExpired:
            return {"ok": False, "need_session": True}
        out = []
        for v in items:
            cell = v["cell"]
            try:
                qty = int(float(str(cell.get("req_qty") or cell.get("total_product_qty") or 0).replace(",", "") or 0))
            except ValueError:
                qty = 0
            out.append({
                "sheet": v["sheet"],
                "name": str(cell.get("sheet_name") or cell.get("title") or cell.get("supply_name") or v["sheet"]),
                "qty": qty,
            })
        return {"ok": True, "date": date, "vouchers": out}

    async def _load_details(date: str, sheets: list[str], refresh: bool) -> list[dict]:
        key = (date, tuple(sorted(sheets)))
        cached = _detail_cache.get(key)
        if cached and not refresh and time.time() - cached[0] < _CACHE_TTL_SEC:
            return cached[1]
        rows = await fetch_im00_detail_rows(get_setting, sheets=sorted(sheets), date=date)
        _detail_cache[key] = (time.time(), rows)
        return rows

    @router.get("/today-receipts")
    async def today_receipts(date: str = "", refresh: bool = False, user: str = Depends(_any_user)):
        """모바일(/bacode) 입고 확인용: 해당 일자(기본 오늘)의 입고요청 전표 전체를 불러와
        상품(거래처+상품명/옵션/코드)별로 일반입고·미송·미송픽업 수량을 합산해 돌려준다."""
        date = _check_date(date) if date else datetime.now(_KST).strftime("%Y-%m-%d")
        try:
            vs = await fetch_im00_vouchers(get_setting, date=date)
            sheets = [v["sheet"] for v in vs]
            rows = await _load_details(date, sheets, refresh) if sheets else []
        except EzAdminSessionExpired:
            return {"ok": False, "need_session": True}
        except RuntimeError as exc:
            raise HTTPException(status_code=502, detail=str(exc))
        agg: dict[tuple, dict] = {}
        for row in rows:
            code = to_s_code(row["code"])
            key = (row["name"], row["option"], code)
            p = agg.setdefault(key, {"name": row["name"], "option": row["option"], "code": code,
                                     "normal": 0, "misong": 0, "pickup": 0})
            for kind, qty in classify_voucher_row(row):
                if kind == KIND_NORMAL:
                    p["normal"] += qty
                elif kind == KIND_MISONG:
                    p["misong"] += qty
                elif kind == KIND_PICKUP:
                    p["pickup"] += qty
        items = [p for p in agg.values() if p["normal"] or p["misong"] or p["pickup"]]
        infos = _wonbe_infos({p["code"] for p in items})
        for p in items:
            w = infos.get(p["code"])
            p["product_name"] = (w["상품명"] if w else "") or ""
            p["color"] = (w["색상"] if w else "") or ""
            p["size"] = (w["사이즈"] if w else "") or ""
            p["client"] = (w["거래처"] if w else "") or ""
        return {"ok": True, "date": date, "voucher_count": len(sheets), "items": items}

    async def _run_compare(order_dates: list[str], voucher_sel: list[dict], refresh: bool) -> dict:
        order_dates = sorted({_check_date(d) for d in order_dates})
        if not order_dates:
            raise HTTPException(status_code=400, detail="발주일을 선택하세요.")
        if not voucher_sel:
            raise HTTPException(status_code=400, detail="입고요청 전표를 선택하세요.")

        sheets_by_date: dict[str, list[str]] = defaultdict(list)
        for v in voucher_sel:
            sheets_by_date[_check_date(v.get("date"))].append(str(v.get("sheet") or "").strip())

        # 1) 발주내역: 선택일 기준 상품코드(S코드)별 합계. 같은 날 TSV복사/엑셀발주/발주실행으로 중복 기록되므로
        #    (일자, 매장, 상품코드, 미송픽업여부)가 같으면 큰 값 하나만 쓴다.
        init_order_history_table(get_db)
        conn = get_db()
        try:
            placeholders = ",".join("?" * len(order_dates))
            hist = conn.execute(
                f"SELECT substr(recorded_at,1,10) AS d, store_name, product_code, product_name, "
                f"client_product_name, options, request_qty, recommended_qty_source "
                f"FROM order_history WHERE substr(recorded_at,1,10) IN ({placeholders}) "
                f"AND product_code != '' AND request_qty > 0",
                order_dates,
            ).fetchall()
        finally:
            conn.close()

        dedup: dict[tuple, dict] = {}
        for r in hist:
            options = str(r["options"] or "")
            is_pickup = r["recommended_qty_source"] == "misong_pickup" or "미송픽업" in options
            code = to_s_code(r["product_code"])
            k = (r["d"], r["store_name"], code, is_pickup)
            cur = dedup.get(k)
            if cur is None or int(r["request_qty"]) > cur["qty"]:
                dedup[k] = {
                    "qty": int(r["request_qty"]), "pickup": is_pickup, "code": code,
                    "store": r["store_name"] or "", "name": r["product_name"] or r["client_product_name"] or "",
                    "options": options,
                }

        products: dict[str, dict] = {}

        def prod(code: str) -> dict:
            if code not in products:
                products[code] = {
                    "code": code, "name": "", "option": "", "client": "",
                    "ordered": 0, "ordered_pickup": 0,
                    "received": 0, "misong": 0, "pickup": 0, "exchange": 0, "deduct": 0,
                }
            return products[code]

        for item in dedup.values():
            p = prod(item["code"])
            p["name"] = p["name"] or item["name"]
            p["option"] = p["option"] or item["options"].replace("미송픽업", "").strip()
            p["client"] = p["client"] or item["store"]
            p["ordered_pickup" if item["pickup"] else "ordered"] += item["qty"]

        # 2) 입고요청 전표 상세: 날짜별로 한 번에 다운로드해 구분별로 합산
        voucher_rows = 0
        unclassified = []
        try:
            for date, sheets in sorted(sheets_by_date.items()):
                for row in await _load_details(date, sheets, refresh):
                    voucher_rows += 1
                    code = to_s_code(row["code"])
                    if not code:
                        unclassified.append({"name": row["name"], "option": row["option"], "reason": "상품코드 없음",
                                             "deduct": memo_deduction(row)})
                        continue
                    p = prod(code)
                    p["name"] = p["name"] or row["name"]
                    p["option"] = p["option"] or row["option"]
                    p["deduct"] += memo_deduction(row)  # 요청메모의 음수 숫자 = 매입차감 금액
                    for kind, qty in classify_voucher_row(row):
                        if kind == KIND_NORMAL:
                            p["received"] += qty
                        elif kind == KIND_MISONG:
                            p["misong"] += qty
                        elif kind == KIND_PICKUP:
                            p["pickup"] += qty
                        else:
                            p["exchange"] += qty
        except EzAdminSessionExpired:
            return {"ok": False, "need_session": True}
        except RuntimeError as exc:
            raise HTTPException(status_code=502, detail=str(exc))

        # 3) 거래처 (wonbe.상품코드 -> 거래처)
        client_map: dict[str, dict] = {}
        codes = list(products)
        wconn = get_wonbe_db()
        try:
            for i in range(0, len(codes), 500):
                chunk = codes[i:i + 500]
                ph = ",".join("?" * len(chunk))
                for w in wconn.execute(
                    f"SELECT 상품코드, 상품명, 색상, 사이즈, 거래처 FROM wonbe WHERE 상품코드 IN ({ph})", chunk
                ).fetchall():
                    client_map[w["상품코드"]] = dict(w)
        finally:
            wconn.close()

        groups: dict[str, list[dict]] = defaultdict(list)
        for code, p in products.items():
            w = client_map.get(code) or {}
            if w:
                p["name"] = w.get("상품명") or p["name"]
                color, size = w.get("색상") or "", w.get("사이즈") or ""
                if color or size:
                    p["option"] = f"{color}/{size}".strip("/")
            client = (w.get("거래처") or "").strip() or p["client"] or "(거래처 미확인)"
            p["client"] = client
            p["missing"] = p["ordered"] - p["received"] - p["misong"]
            p["pickup_missing"] = p["ordered_pickup"] - p["pickup"]
            p["status"] = _status(p["ordered"], p["received"], p["misong"])
            p["pickup_status"] = _status(p["ordered_pickup"], p["pickup"], 0)
            groups[client].append(p)

        # 요청메모 매입차감은 상품 줄에 붙이지 않고 거래처에 '매입차감' 줄을 따로 만든다 (매입차감 + 금액만, 상품 정보 없음)
        for client, items in groups.items():
            seq = 0
            for p in list(items):
                amount = int(p.get("deduct") or 0)
                if amount >= 0:
                    continue
                p["deduct"] = 0
                if not (p["ordered"] or p["ordered_pickup"] or p["received"] or p["misong"] or p["pickup"] or p["exchange"]):
                    items.remove(p)  # 수량 없이 차감만 있던 줄은 차감 줄로 대체
                seq += 1
                items.append({
                    "code": f"DEDUCT-{seq}", "name": "매입차감", "option": "", "client": client,
                    "ordered": 0, "ordered_pickup": 0, "received": 0, "misong": 0, "pickup": 0, "exchange": 0,
                    "cost": 0, "deduct": amount, "missing": 0, "pickup_missing": 0,
                    "status": _status(0, 0, 0), "pickup_status": _status(0, 0, 0),
                })

        result = []
        for client in sorted(groups):
            items = sorted(groups[client], key=lambda x: x["code"])
            totals = {k: sum(i[k] for i in items) for k in
                      ("ordered", "ordered_pickup", "received", "misong", "pickup", "exchange")}
            result.append({"client": client, "totals": totals, "items": items})

        return _attach_costs({
            "ok": True,
            "order_dates": order_dates,
            "voucher_rows": voucher_rows,
            "unclassified": unclassified,
            "clients": result,
        })

    def _row_dates(r) -> list[str]:
        raw = r["order_dates_json"] if "order_dates_json" in r.keys() else ""
        try:
            dates = json.loads(raw) if raw else []
        except ValueError:
            dates = []
        return dates or [r["order_date"]]

    def _norm_order_dates(payload: dict) -> list[str]:
        raw = payload.get("order_dates")
        if raw is None and payload.get("order_date"):
            raw = [payload.get("order_date")]
        return sorted({_check_date(d) for d in raw or []})

    def _costs_for(codes: list[str]) -> dict[str, int]:
        """원가베이스유(wonbe.원가) 상품코드 → 원가(원). 숫자로 읽히지 않으면 0."""
        out: dict[str, int] = {}
        codes = [c for c in dict.fromkeys(codes) if c]
        if not codes:
            return out
        conn = get_wonbe_db()
        try:
            for i in range(0, len(codes), 500):
                chunk = codes[i:i + 500]
                ph = ",".join("?" * len(chunk))
                for w in conn.execute(f"SELECT 상품코드, 원가 FROM wonbe WHERE 상품코드 IN ({ph})", chunk).fetchall():
                    try:
                        out[w["상품코드"]] = int(float(str(w["원가"] or "0").replace(",", "").strip() or 0))
                    except ValueError:
                        out[w["상품코드"]] = 0
        finally:
            conn.close()
        return out

    def _supplier_names_for(codes: list[str]) -> dict[str, str]:
        """원가베이스유(wonbe.거래처상품명) 상품코드 → 거래처상품명. 항상 최신 값을 읽는다(DB관리에서 고치면 바로 반영)."""
        out: dict[str, str] = {}
        codes = [c for c in dict.fromkeys(codes) if c]
        if not codes:
            return out
        conn = get_wonbe_db()
        try:
            for i in range(0, len(codes), 500):
                chunk = codes[i:i + 500]
                ph = ",".join("?" * len(chunk))
                for w in conn.execute(f"SELECT 상품코드, 거래처상품명 FROM wonbe WHERE 상품코드 IN ({ph})", chunk).fetchall():
                    out[w["상품코드"]] = str(w["거래처상품명"] or "").strip()
        except Exception:
            pass
        finally:
            conn.close()
        return out

    def _attach_costs(result: dict) -> dict:
        """원가/부가세 대상 여부/금액을 결과에 붙인다. 이미 붙어 있는 값(매칭 시점 스냅샷)은 그대로 둔다."""
        clients = result.get("clients", []) or []
        need = [i.get("code", "") for c in clients for i in c.get("items", []) or [] if "cost" not in i]
        costs = _costs_for(need) if need else {}
        sup_names = _supplier_names_for([i.get("code", "") for c in clients for i in c.get("items", []) or []])
        # 노예김승일 > 입고전표엑셀전환의 "부가세 거래처" 목록에 있는 거래처는 vat=True (금액에 10% 추가)
        try:
            vat_set = {str(v).strip() for v in json.loads(get_setting("noye_kimsungil_vat_vendors") or "[]")}
        except Exception:
            vat_set = set()
        for c in clients:
            if "vat" not in c:
                c["vat"] = str(c.get("client", "")).strip() in vat_set
            for i in c.get("items", []) or []:
                i["supplier_name"] = sup_names.get(i.get("code", ""), "")
                if "cost" not in i:
                    i["cost"] = costs.get(i.get("code", ""), 0)
                if "amount" not in i:  # 금액 대상은 일반입고 + 미송 (미송픽업 0원)
                    i["amount"] = (int(i.get("received") or 0) + int(i.get("misong") or 0)) * int(i["cost"])
                if "ordered_amount" not in i:
                    i["ordered_amount"] = int(i.get("ordered") or 0) * int(i["cost"])
        result["cost_snapshot"] = True
        return result

    def _row_to_record(r, with_result: bool) -> dict:
        out = {
            "id": r["id"], "order_date": r["order_date"], "order_dates": _row_dates(r),
            "receive_date": r["receive_date"] if "receive_date" in r.keys() and r["receive_date"] else r["order_date"],
            "title": r["title"], "memo": r["memo"],
            "vouchers": json.loads(r["vouchers_json"] or "[]"),
            "created_by": r["created_by"], "created_at": r["created_at"], "updated_at": r["updated_at"],
        }
        result = json.loads(r["result_json"] or "{}")
        if with_result:
            out["result"] = _attach_costs(result)
        else:
            totals: dict[str, int] = defaultdict(int)
            for c in result.get("clients", []):
                for k, v in c["totals"].items():
                    totals[k] += v
            out["summary"] = {**totals, "clients": len(result.get("clients", []))}
        return out

    def _norm_vouchers(raw) -> list[dict]:
        return [
            {"date": _check_date(v.get("date")), "sheet": str(v.get("sheet") or "").strip(),
             "name": str(v.get("name") or "")}
            for v in raw or [] if str(v.get("sheet") or "").strip()
        ]

    @router.get("/records")
    def list_records(order_date: str = "", receive_date: str = "", admin: str = Depends(require_admin)):
        conn = get_db()
        try:
            _init_records(conn)
            if receive_date:  # 입고요청일(매칭이 배정된 날짜)로 조회
                rows = conn.execute(
                    "SELECT * FROM order_receiving_records WHERE receive_date = ? ORDER BY id DESC",
                    (_check_date(receive_date),),
                ).fetchall()
            elif order_date:  # 발주일로 조회
                rows = conn.execute(
                    "SELECT * FROM order_receiving_records WHERE order_date = ? ORDER BY id DESC",
                    (_check_date(order_date),),
                ).fetchall()
            else:
                rows = conn.execute("SELECT * FROM order_receiving_records ORDER BY id DESC LIMIT 200").fetchall()
            return {"ok": True, "records": [_row_to_record(r, False) for r in rows]}
        finally:
            conn.close()

    @router.get("/records/{record_id}")
    def get_record(record_id: int, admin: str = Depends(require_admin)):
        conn = get_db()
        try:
            _init_records(conn)
            row = conn.execute("SELECT * FROM order_receiving_records WHERE id = ?", (record_id,)).fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="저장된 대조 내역이 없습니다.")
            return {"ok": True, "record": _row_to_record(row, True)}
        finally:
            conn.close()

    @router.post("/records")
    async def create_record(payload: dict = Body(...), admin: str = Depends(require_admin)):
        """발주일(폴더) 하나와 입고요청 전표들을 매칭해 결과를 저장한다.
        body: {order_dates: [...], vouchers: [{date, sheet, name}], title, memo, refresh}"""
        order_dates = _norm_order_dates(payload)
        vouchers = _norm_vouchers(payload.get("vouchers"))
        result = await _run_compare(order_dates, vouchers, bool(payload.get("refresh")))
        if result.get("need_session"):
            return result
        now = datetime.now(_KST).strftime("%Y-%m-%d %H:%M:%S")
        conn = get_db()
        try:
            _init_records(conn)
            cur = conn.execute(
                "INSERT INTO order_receiving_records "
                "(order_date, receive_date, order_dates_json, title, memo, vouchers_json, result_json, created_by, created_at, updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?)",
                (order_dates[0], receive_date_of(vouchers, order_dates), json.dumps(order_dates), str(payload.get("title") or "").strip(), str(payload.get("memo") or "").strip(),
                 json.dumps(vouchers, ensure_ascii=False), json.dumps(result, ensure_ascii=False),
                 str(admin), now, now),
            )
            _save_items(conn, cur.lastrowid, order_dates[0], result)
            conn.commit()
            row = conn.execute("SELECT * FROM order_receiving_records WHERE id = ?", (cur.lastrowid,)).fetchone()
            return {"ok": True, "record": _row_to_record(row, True)}
        finally:
            conn.close()

    @router.put("/records/{record_id}")
    async def update_record(record_id: int, payload: dict = Body(...), admin: str = Depends(require_admin)):
        """제목/메모 수정. vouchers를 보내면 전표 선택을 바꿔 다시 매칭하고 결과를 갱신한다
        (rematch=true 이면 전표 선택 그대로 다시 매칭)."""
        conn = get_db()
        try:
            _init_records(conn)
            row = conn.execute("SELECT * FROM order_receiving_records WHERE id = ?", (record_id,)).fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="저장된 대조 내역이 없습니다.")
        finally:
            conn.close()

        title = str(payload["title"]).strip() if "title" in payload else row["title"]
        memo = str(payload["memo"]).strip() if "memo" in payload else row["memo"]
        vouchers_json, result_json = row["vouchers_json"], row["result_json"]
        order_dates = _norm_order_dates(payload) if ("order_dates" in payload) else _row_dates(row)
        order_dates_json = json.dumps(order_dates)
        if "vouchers" in payload or "order_dates" in payload or payload.get("rematch"):
            vouchers = _norm_vouchers(payload["vouchers"]) if "vouchers" in payload else json.loads(vouchers_json)
            result = await _run_compare(order_dates, vouchers, bool(payload.get("refresh", True)))
            if result.get("need_session"):
                return result
            vouchers_json = json.dumps(vouchers, ensure_ascii=False)
            result_json = json.dumps(result, ensure_ascii=False)

        now = datetime.now(_KST).strftime("%Y-%m-%d %H:%M:%S")
        conn = get_db()
        try:
            conn.execute(
                "UPDATE order_receiving_records SET order_date=?, receive_date=?, order_dates_json=?, title=?, memo=?, "
                "vouchers_json=?, result_json=?, updated_at=? WHERE id=?",
                (order_dates[0], receive_date_of(json.loads(vouchers_json or "[]"), order_dates), order_dates_json, title, memo,
                 vouchers_json, result_json, now, record_id),
            )
            _save_items(conn, record_id, order_dates[0], json.loads(result_json or "{}"))
            conn.commit()
            row = conn.execute("SELECT * FROM order_receiving_records WHERE id = ?", (record_id,)).fetchone()
            return {"ok": True, "record": _row_to_record(row, True)}
        finally:
            conn.close()

    @router.delete("/records/{record_id}")
    def delete_record(record_id: int, admin: str = Depends(require_admin)):
        conn = get_db()
        try:
            _init_records(conn)
            cur = conn.execute("DELETE FROM order_receiving_records WHERE id = ?", (record_id,))
            conn.execute("DELETE FROM order_receiving_items WHERE record_id = ?", (record_id,))
            conn.commit()
            if not cur.rowcount:
                raise HTTPException(status_code=404, detail="저장된 대조 내역이 없습니다.")
            return {"ok": True, "deleted": record_id}
        finally:
            conn.close()

    # ── 저장된 매칭의 세부목록(상품 줄) 수정 / 삭제 ──────────────────────────────────
    # 입고요청 전표에 상품을 잘못 넣은 경우처럼, 저장된 결과를 직접 고친다 (이지어드민 전표 자체는 바꾸지 않는다).
    _NUM_KEYS = ("ordered", "received", "misong", "ordered_pickup", "pickup")
    _ALL_KEYS = ("ordered", "ordered_pickup", "received", "misong", "pickup", "exchange")

    def _recalc_result(result: dict) -> dict:
        clients = []
        for c in result.get("clients", []) or []:
            items = list(c.get("items", []) or [])
            if not items:
                continue
            for i in items:
                for k in _ALL_KEYS:
                    i[k] = int(i.get(k) or 0)
                cost = int(i.get("cost") or 0)
                i["missing"] = i["ordered"] - i["received"] - i["misong"]
                i["pickup_missing"] = i["ordered_pickup"] - i["pickup"]
                i["status"] = _status(i["ordered"], i["received"], i["misong"])
                i["pickup_status"] = _status(i["ordered_pickup"], i["pickup"], 0)
                i["amount"] = (i["received"] + i["misong"]) * cost + int(i.get("fee") or 0)  # 일반입고 + 미송 (미송픽업 0원) + 택배비 등
                i["ordered_amount"] = i["ordered"] * cost
            c["items"] = sorted(items, key=lambda x: x.get("code", ""))
            c["totals"] = {k: sum(i[k] for i in items) for k in _ALL_KEYS}
            clients.append(c)
        result["clients"] = sorted(clients, key=lambda c: c.get("client", ""))
        return result

    def _vat_set() -> set[str]:
        try:
            return {str(v).strip() for v in json.loads(get_setting("noye_kimsungil_vat_vendors") or "[]")}
        except Exception:
            return set()

    def _load_for_edit(conn, record_id: int):
        _init_records(conn)
        row = conn.execute("SELECT * FROM order_receiving_records WHERE id = ?", (record_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="저장된 대조 내역이 없습니다.")
        return row, json.loads(row["result_json"] or "{}")

    def _persist_edit(conn, row, result: dict) -> dict:
        _recalc_result(result)
        now = datetime.now(_KST).strftime("%Y-%m-%d %H:%M:%S")
        conn.execute("UPDATE order_receiving_records SET result_json = ?, updated_at = ? WHERE id = ?",
                     (json.dumps(result, ensure_ascii=False), now, row["id"]))
        _save_items(conn, row["id"], row["order_date"], result)
        conn.commit()
        fresh = conn.execute("SELECT * FROM order_receiving_records WHERE id = ?", (row["id"],)).fetchone()
        return _row_to_record(fresh, True)

    def _find_item(result: dict, client: str, code: str):
        for c in result.get("clients", []) or []:
            if c.get("client") == client:
                for i in c.get("items", []) or []:
                    if i.get("code") == code:
                        return c, i
        raise HTTPException(status_code=404, detail="해당 세부목록(상품)을 찾을 수 없습니다.")

    @router.get("/products/search")
    def search_products(q: str = "", limit: int = 30, admin: str = Depends(require_admin)):
        """원가베이스유(wonbe)에서 상품 검색. 공백으로 나눈 단어가 모두 (상품코드/상품명/색상/사이즈/거래처/거래처상품명)
        어딘가에 들어 있으면 매칭한다. 세부목록의 상품을 바꿀 때 쓴다."""
        tokens = [t for t in str(q or "").strip().split() if t]
        if not tokens:
            return {"ok": True, "products": []}
        limit = min(max(1, limit), 100)
        cols = ["상품코드", "상품명", "색상", "사이즈", "거래처", "거래처상품명"]
        where = " AND ".join("(" + " OR ".join(f"IFNULL({c},'') LIKE ?" for c in cols) + ")" for _ in tokens)
        params: list = []
        for t in tokens:
            params.extend([f"%{t}%"] * len(cols))
        conn = get_wonbe_db()
        try:
            rows = conn.execute(
                f"SELECT 상품코드, 상품명, 색상, 사이즈, 거래처, 원가 FROM wonbe WHERE {where} "
                f"ORDER BY 거래처, 상품명, 색상, 사이즈 LIMIT ?", [*params, limit],
            ).fetchall()
        finally:
            conn.close()
        out = []
        for r in rows:
            try:
                cost = int(float(str(r["원가"] or "0").replace(",", "").strip() or 0))
            except ValueError:
                cost = 0
            out.append({"code": r["상품코드"], "name": r["상품명"] or "", "color": r["색상"] or "",
                        "size": r["사이즈"] or "", "client": r["거래처"] or "", "cost": cost})
        return {"ok": True, "products": out}

    def _qty(payload: dict, key: str) -> int:
        v = payload.get(key)
        if v is None or v == "":
            return 0
        try:
            n = int(v)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail=f"{key} 수량이 숫자가 아닙니다.")
        if n < 0:
            raise HTTPException(status_code=400, detail="수량은 0 이상이어야 합니다.")
        return n

    def _wonbe_infos(codes) -> dict:
        out: dict = {}
        codes = [c for c in codes if c]
        if not codes:
            return out
        wconn = get_wonbe_db()
        try:
            for k in range(0, len(codes), 500):
                chunk = codes[k:k + 500]
                for w in wconn.execute(
                    f"SELECT 상품코드, 상품명, 색상, 사이즈, 거래처 FROM wonbe WHERE 상품코드 IN ({','.join('?' * len(chunk))})", chunk
                ).fetchall():
                    out[w["상품코드"]] = w
        finally:
            wconn.close()
        return out

    def _client_group(result: dict, client: str) -> dict:
        result.setdefault("clients", [])
        dest = next((x for x in result["clients"] if x.get("client") == client), None)
        if dest is None:
            dest = {"client": client, "vat": client in _vat_set(), "items": []}
            result["clients"].append(dest)
        return dest

    def _put_product(result: dict, code: str, info, qtys: dict, edited: bool = True, from_janggi: bool = False) -> str:
        """상품을 결과에 넣는다(같은 상품이 있으면 수량 합산). 반환: 배정된 거래처."""
        target = (info["거래처"] or "").strip() or "(거래처 미확인)"
        color, size = info["색상"] or "", info["사이즈"] or ""
        dest = _client_group(result, target)
        same = next((x for x in dest["items"] if x.get("code") == code), None)
        if same:
            for k, v in qtys.items():
                same[k] = int(same.get(k) or 0) + v
            if edited:
                same["edited"] = True
            if from_janggi:
                same["from_janggi"] = True
        else:
            item = {
                "code": code, "name": info["상품명"] or "", "option": f"{color}/{size}".strip("/"),
                "client": target, **{k: 0 for k in _ALL_KEYS}, **qtys,
                "cost": _costs_for([code]).get(code, 0), "deduct": 0,
            }
            if edited:
                item["edited"] = True
            if from_janggi:
                item["from_janggi"] = True
            dest["items"].append(item)
        return target

    def _put_fee(result: dict, client: str, label: str, amount: int, from_janggi: bool = False) -> None:
        """택배비 같은 추가 금액을 거래처에 넣는다 (상품 금액에 더해지고 부가세 대상). 같은 이름이 있으면 합산."""
        dest = _client_group(result, client)
        same = next((x for x in dest["items"] if str(x.get("code", "")).startswith("FEE-") and x.get("name") == label), None)
        if same:
            same["fee"] = int(same.get("fee") or 0) + amount
            same["from_janggi" if from_janggi else "edited"] = True
            return
        seq = 1 + sum(1 for x in dest["items"] if str(x.get("code", "")).startswith("FEE-"))
        code = f"FEE-{seq}"
        while any(x.get("code") == code for x in dest["items"]):
            seq += 1
            code = f"FEE-{seq}"
        dest["items"].append({
            "code": code, "name": label, "option": "장끼DB" if from_janggi else "", "client": client,
            **{k: 0 for k in _ALL_KEYS}, "cost": 0, "deduct": 0, "fee": amount,
            "from_janggi" if from_janggi else "edited": True,
        })

    def _put_deduct(result: dict, client: str, amount: int, memo: str, from_janggi: bool = False) -> None:
        dest = _client_group(result, client)
        seq = 1 + sum(1 for x in dest["items"] if str(x.get("code", "")).startswith("DEDUCT-"))
        code = f"DEDUCT-{seq}"
        while any(x.get("code") == code for x in dest["items"]):
            seq += 1
            code = f"DEDUCT-{seq}"
        item = {
            "code": code, "name": "매입차감", "option": memo, "client": client,
            **{k: 0 for k in _ALL_KEYS}, "cost": 0, "deduct": -abs(amount),
        }
        if from_janggi:
            item["from_janggi"] = True  # 장끼DB 기준 자동 반영분 (재매칭하면 다시 대조해 채워진다)
        else:
            item["edited"] = True
        dest["items"].append(item)

    @router.post("/records/{record_id}/items")
    def add_record_item(record_id: int, payload: dict = Body(...), admin: str = Depends(require_admin)):
        """세부목록에 상품을 추가한다. body: {code, ordered?, received?, misong?, ordered_pickup?, pickup?}
        원가베이스유에서 상품명/옵션/원가를 채우고, 상품의 거래처로 자동 배정한다(없으면 거래처를 새로 만든다).
        금액·부가세는 저장하지 않고 항상 현재 상품 목록 기준으로 계산되므로, 나중에 추가해도 부가세가 후반영된다."""
        code = to_s_code(str(payload.get("code") or "").strip().upper())
        if not code:
            raise HTTPException(status_code=400, detail="상품코드가 필요합니다.")
        qtys = {k: _qty(payload, k) for k in _NUM_KEYS}
        if not any(qtys.values()):
            raise HTTPException(status_code=400, detail="수량을 하나 이상 입력하세요.")
        info = _wonbe_infos([code]).get(code)
        if not info:
            raise HTTPException(status_code=400, detail=f"원가베이스유에 없는 상품코드입니다: {code}")
        conn = get_db()
        try:
            row, result = _load_for_edit(conn, record_id)
            target = _put_product(result, code, info, qtys)
            return {"ok": True, "client": target, "record": _persist_edit(conn, row, result)}
        finally:
            conn.close()

    @router.post("/records/{record_id}/deductions")
    def add_record_deduction(record_id: int, payload: dict = Body(...), admin: str = Depends(require_admin)):
        """거래처에 매입차감(금액)을 추가한다. body: {client, amount, memo?}. amount는 양수/음수 어느 쪽으로 넣어도 차감(-)으로 저장."""
        client = str(payload.get("client") or "").strip()
        if not client:
            raise HTTPException(status_code=400, detail="거래처를 입력하세요.")
        try:
            amount = int(round(float(str(payload.get("amount") or "").replace(",", "").replace("원", "").strip())))
        except ValueError:
            raise HTTPException(status_code=400, detail="금액을 숫자로 입력하세요.")
        if amount == 0:
            raise HTTPException(status_code=400, detail="금액이 0원입니다.")
        conn = get_db()
        try:
            row, result = _load_for_edit(conn, record_id)
            _put_deduct(result, client, amount, str(payload.get("memo") or "").strip())
            return {"ok": True, "record": _persist_edit(conn, row, result)}
        finally:
            conn.close()

    @router.post("/records/{record_id}/fees")
    def add_record_fee(record_id: int, payload: dict = Body(...), admin: str = Depends(require_admin)):
        """거래처에 택배비 같은 변수 항목(이름 + 금액)을 추가한다. body: {client, label, amount}.
        금액은 상품금액에 더해지고 부가세 거래처면 부가세도 함께 계산된다 (음수는 할인 같은 차감 항목)."""
        client = str(payload.get("client") or "").strip()
        label = str(payload.get("label") or "").strip()
        if not client:
            raise HTTPException(status_code=400, detail="거래처를 입력하세요.")
        if not label:
            raise HTTPException(status_code=400, detail="항목 이름을 입력하세요. (예: 택배비)")
        try:
            amount = int(round(float(str(payload.get("amount") or "").replace(",", "").replace("원", "").strip())))
        except ValueError:
            raise HTTPException(status_code=400, detail="금액을 숫자로 입력하세요.")
        if amount == 0:
            raise HTTPException(status_code=400, detail="금액이 0원입니다.")
        conn = get_db()
        try:
            row, result = _load_for_edit(conn, record_id)
            _put_fee(result, client, label, amount)
            return {"ok": True, "record": _persist_edit(conn, row, result)}
        finally:
            conn.close()

    @router.post("/records/{record_id}/vat")
    def set_record_vat(record_id: int, payload: dict = Body(...), admin: str = Depends(require_admin)):
        """부가세 거래처의 부가세 금액을 직접 고친다. body: {client, amount}. amount를 비우면 자동(공급가 10%)으로 되돌린다."""
        client = str(payload.get("client") or "").strip()
        raw = str(payload.get("amount") if payload.get("amount") is not None else "").replace(",", "").replace("원", "").strip()
        conn = get_db()
        try:
            row, result = _load_for_edit(conn, record_id)
            target = next((c for c in result.get("clients", []) or [] if c.get("client") == client), None)
            if not target:
                raise HTTPException(status_code=404, detail="거래처를 찾을 수 없습니다.")
            if raw == "":
                target.pop("vat_override", None)
            else:
                try:
                    target["vat_override"] = int(round(float(raw)))
                except ValueError:
                    raise HTTPException(status_code=400, detail="부가세를 숫자로 입력하세요.")
            return {"ok": True, "record": _persist_edit(conn, row, result)}
        finally:
            conn.close()

    def _num(v) -> int:
        try:
            return int(round(float(str(v or "0").replace(",", "").replace("원", "").strip() or 0)))
        except ValueError:
            return 0

    def _kinds_text(d: dict) -> str:
        return " · ".join(f"{lb} {d.get(k)}" for k, lb in (("received", "입고"), ("misong", "미송"), ("pickup", "미송픽업")) if d.get(k)) or "0"

    def _janggi_diff(row, result: dict) -> dict:
        """저장된 매칭(result)을 날짜별장끼정리 DB와 대조한다 (전표 날짜 = 장끼 날짜). 차이마다 사유(reason)를 붙인다.
        - empty=True: 장끼DB가 비었거나 읽을 수 없음 (아무것도 하지 않음)
        - deductions: 장끼 매입차감 합계와 SO+ 매입차감이 다른 거래처 (diff>0 이면 SO+에 미반영)
        - products: 장끼에만 있는 상품 (SO+에 없음 → 추가 후보)
        - so_only: SO+에만 있는 상품 (장끼정리에 없음)
        - qty_diffs: 양쪽에 있지만 수량/구분이 다른 상품"""
        dates = sorted({str(v.get("date") or "") for v in json.loads(row["vouchers_json"] or "[]") if v.get("date")})
        empty = {"ok": True, "empty": True, "dates": dates}
        if get_janggi_db is None or not dates:
            return empty
        jconn = None
        try:
            jconn = get_janggi_db()
            ph = ",".join("?" * len(dates))
            jrows = jconn.execute(
                f"SELECT 거래처, 거래처상품명, 가격, 옵션, 사이즈, 개수, 날짜, 미송체크, 상품코드 "
                f"FROM 날짜별장끼정리 WHERE 날짜 IN ({ph})", dates,
            ).fetchall()
        except Exception:
            return empty  # 테이블/파일이 없는 환경
        finally:
            if jconn is not None:
                jconn.close()
        if not jrows:
            return empty

        # SO+ 쪽 집계
        so_deduct: dict[str, int] = defaultdict(int)  # 거래처 -> 매입차감 합(양수)
        so_supply: dict[str, int] = defaultdict(int)  # 거래처 -> 공급가(상품금액 + 택배비 등)
        so_fee: dict[str, dict] = defaultdict(lambda: defaultdict(int))  # 거래처 -> 이름 -> 택배비 등
        so_vat_flag = {c.get("client", ""): bool(c.get("vat")) for c in result.get("clients", []) or []}
        so_vat_fix = {c.get("client", ""): int(c["vat_override"]) for c in result.get("clients", []) or [] if c.get("vat_override") is not None}
        so_items: dict[str, dict] = {}
        for c in result.get("clients", []) or []:
            for i in c.get("items", []) or []:
                so_deduct[c.get("client", "")] += -int(i.get("deduct") or 0)
                so_supply[c.get("client", "")] += int(i.get("amount") or 0)
                if int(i.get("fee") or 0):
                    so_fee[c.get("client", "")][str(i.get("name") or "")] += int(i.get("fee") or 0)
                if not str(i.get("code", "")).startswith("DEDUCT-"):
                    cur = so_items.setdefault(i.get("code", ""), {
                        "code": i.get("code", ""), "name": i.get("name", ""), "option": i.get("option", ""),
                        "client": c.get("client", ""), "received": 0, "misong": 0, "pickup": 0})
                    for k in ("received", "misong", "pickup"):
                        cur[k] += int(i.get(k) or 0)

        # 장끼 쪽 집계
        j_deduct: dict[str, int] = defaultdict(int)
        j_vat: dict[str, int] = defaultdict(int)
        j_fee: dict[str, dict] = defaultdict(lambda: defaultdict(int))
        j_clients: set[str] = set()
        j_total: dict[str, int] = defaultdict(int)  # 장끼 거래처 합산금액 (매입차감은 뺀다)
        j_prod: dict[str, dict] = {}
        for r in jrows:
            client = str(r["거래처"] or "").strip()
            j_clients.add(client)
            mark = str(r["미송체크"] or "")
            price_ = _num(r["가격"])
            j_total[client] += -abs(price_) if "매입차감" in mark else price_
            if "매입차감" in mark:
                j_deduct[client] += abs(_num(r["가격"]))
                continue
            code = to_s_code(str(r["상품코드"] or "").strip().upper())
            if not code:
                # 상품코드 없는 행: 부가세 행 또는 택배비 같은 추가 금액 행
                name = str(r["거래처상품명"] or "").strip()
                opt = str(r["옵션"] or "").strip()
                price = _num(r["가격"])
                if "부가세" in (name, opt) or "부가세" in mark:
                    j_vat[client] += price
                else:
                    label = mark.strip() if any(ch.isalpha() for ch in mark) else name
                    if label and price:
                        j_fee[client][label] += price
                continue
            qty = _num(r["개수"])
            if qty <= 0:
                continue
            kind = "pickup" if has_pickup_marker(mark) else ("misong" if "미송" in _norm_text(mark) else "received")
            p = j_prod.setdefault(code, {"code": code, "name": str(r["거래처상품명"] or ""), "option": f'{r["옵션"] or ""}/{r["사이즈"] or ""}'.strip("/"),
                                         "client": client, "received": 0, "misong": 0, "pickup": 0})
            p[kind] += qty

        # SO+ 매입차감은 전표 요청메모의 전체 금액(raw)이지만 합계에는 상품금액(+부가세)을 넘지 않게 잘라서(applied) 반영된다.
        # 장끼정리에는 잘라낸 값이 적히므로(남은 금액은 메모에 "-5000남음"), applied 와 비교해야 한다.
        def _so_vat(client: str) -> int:
            if client in so_vat_fix:
                return so_vat_fix[client]
            return int(so_supply.get(client, 0) * 0.1 + 0.5) if so_vat_flag.get(client) else 0

        so_applied: dict[str, int] = {}
        so_total: dict[str, int] = {}
        for client in set(so_deduct) | set(so_supply):
            budget = max(0, so_supply.get(client, 0) + _so_vat(client))
            so_applied[client] = min(max(so_deduct.get(client, 0), 0), budget)
            so_total[client] = so_supply.get(client, 0) + _so_vat(client) - so_applied[client]

        deductions = []
        for client in sorted(set(j_deduct) | {k for k, v in so_deduct.items() if v}):
            j, so = j_deduct.get(client, 0), so_applied.get(client, 0)
            if j == so:
                continue
            if j_total.get(client, 0) == 0 and so_total.get(client, 0) == 0:
                continue  # 2차 거름: 장끼 합산 0원 & SO+ 합계 0원이면 (매입금액이 주문금액 이상) 차이로 보지 않는다
            raw_so = so_deduct.get(client, 0)
            over = f" (전표 메모 -{raw_so:,}원 중 상품금액 초과분 {raw_so - so:,}원은 '남음' 처리)" if raw_so > so else ""
            if so == 0:
                reason = f"장끼정리에 매입차감 -{j:,}원이 있으나 SO+에 반영 안 됨"
            elif j == 0:
                reason = f"SO+에만 매입차감 -{so:,}원이 있음 (장끼정리에는 없음){over}"
            elif j > so:
                reason = f"장끼 -{j:,}원 / SO+ 반영 -{so:,}원 → SO+에 -{j - so:,}원 덜 반영됨{over}"
            else:
                reason = f"장끼 -{j:,}원 / SO+ 반영 -{so:,}원 → SO+가 -{so - j:,}원 더 큼 (수동 추가 또는 전표 메모 확인){over}"
            deductions.append({"client": client, "janggi": j, "so": so, "so_raw": raw_so, "diff": j - so, "reason": reason})

        missing_codes = [c for c in j_prod if c not in so_items]
        infos = _wonbe_infos(missing_codes)
        products = []
        for c in sorted(missing_codes):
            p = j_prod[c]
            if c in infos and not p["client"]:
                p["client"] = infos[c]["거래처"] or ""
            parts = []
            if p["misong"]:
                parts.append(f"미송 {p['misong']}개가 잡혀 있으나")
            if p["pickup"]:
                parts.append(f"미송픽업 {p['pickup']}개가 있으나")
            if p["received"]:
                parts.append(f"입고 {p['received']}개가 있으나")
            reason = "장끼정리에 " + " ".join(parts) + " SO+ 매칭(입고요청전표)에 없음"
            if c not in infos:
                reason += " · 원가베이스유에 없어 자동 추가 불가"
            products.append({**p, "in_wonbe": c in infos, "reason": reason})

        so_only = []
        for code, it in so_items.items():
            if code not in j_prod and (it["received"] + it["misong"] + it["pickup"]) > 0:
                so_only.append({**it, "reason": "SO+(입고요청전표)에는 있으나 장끼정리에 없음"})
        so_only.sort(key=lambda x: (x["client"], x["code"]))

        qty_diffs = []
        for code, p in j_prod.items():
            it = so_items.get(code)
            if not it:
                continue
            jq = p["received"] + p["misong"] + p["pickup"]
            sq = it["received"] + it["misong"] + it["pickup"]
            same_kind = all(p[k] == it[k] for k in ("received", "misong", "pickup"))
            if same_kind:
                continue
            if jq == sq:
                reason = f"총 수량은 같으나 구분이 다름 (장끼 {_kinds_text(p)} / SO+ {_kinds_text(it)})"
            else:
                reason = f"장끼 {jq}개 / SO+ {sq}개 → {'SO+가 ' + str(jq - sq) + '개 적음' if jq > sq else 'SO+가 ' + str(sq - jq) + '개 많음'} ({_kinds_text(p)} / {_kinds_text(it)})"
            add = {k: max(0, p[k] - it[k]) for k in ("received", "misong", "pickup")}  # 장끼가 더 많은 구분만 채운다
            qty_diffs.append({"code": code, "name": p["name"], "option": p["option"], "client": it["client"],
                              "janggi": jq, "so": sq, "reason": reason, "add": add,
                              "janggi_kinds": {k: p[k] for k in ("received", "misong", "pickup")},
                              "so_kinds": {k: it[k] for k in ("received", "misong", "pickup")}})
        qty_diffs.sort(key=lambda x: (x["client"], x["code"]))

        fees = []
        for client in sorted(set(j_fee) | set(so_fee)):
            jf, sf = j_fee.get(client, {}), so_fee.get(client, {})
            for label in sorted(set(jf) | set(sf)):
                j_, s_ = jf.get(label, 0), sf.get(label, 0)
                if j_ == s_:
                    continue
                if s_ == 0:
                    reason = f"장끼정리에 {label} {j_:,}원이 있으나 SO+에 없음"
                elif j_ > s_:
                    reason = f"{label}: 장끼 {j_:,}원 / SO+ {s_:,}원 → {j_ - s_:,}원 덜 반영됨"
                else:
                    reason = f"{label}: 장끼 {j_:,}원 / SO+ {s_:,}원 → SO+가 {s_ - j_:,}원 더 큼"
                fees.append({"client": client, "label": label, "janggi": j_, "so": s_, "diff": j_ - s_, "reason": reason})

        pending_fee = {f["client"]: f for f in fees if f["diff"] > 0}
        vats = []
        for client in sorted(j_clients):
            jv = j_vat.get(client, 0)
            sv = _so_vat(client)
            if jv == sv:
                continue
            if sv == 0 and not so_vat_flag.get(client) and client in so_supply:
                reason = f"장끼정리에 부가세 {jv:,}원이 있으나 SO+는 부가세 거래처가 아님 (노예김승일 부가세 거래처 목록 확인)"
            elif jv == 0:
                reason = f"SO+는 부가세 {sv:,}원인데 장끼정리에는 부가세 행이 없음"
            else:
                reason = f"부가세: 장끼 {jv:,}원 / SO+ {sv:,}원 → {abs(jv - sv):,}원 차이"
                pf = pending_fee.get(client)
                if pf:
                    reason += f" · {pf['label']} {pf['diff']:,}원이 SO+에 없어 생긴 차이일 수 있음 (먼저 반영 후 다시 확인)"
            vats.append({"client": client, "janggi": jv, "so": sv, "diff": jv - sv, "reason": reason})
        return {"ok": True, "empty": False, "dates": dates, "janggi_rows": len(jrows),
                "deductions": deductions, "products": products, "so_only": so_only, "qty_diffs": qty_diffs,
                "fees": fees, "vats": vats}

    # ── 장끼 점검 '처리 완료' 기록 ──
    # 반영/삭제/PASS로 처리한 점검 항목 키를 result["janggi_resolved"]에 저장해 두고,
    # 다음 점검부터는 목록에서 뺀다. 키 형식은 프론트와 같다:
    #   d:거래처 / f:거래처:항목명 / v:거래처 / p:코드 / s:코드 / q:코드
    # (재매칭하면 result가 새로 만들어지므로 처리 기록도 초기화된다)
    _DIFF_KEYS = {
        "deductions": lambda x: f"d:{x['client']}",
        "fees": lambda x: f"f:{x['client']}:{x['label']}",
        "vats": lambda x: f"v:{x['client']}",
        "products": lambda x: f"p:{x['code']}",
        "so_only": lambda x: f"s:{x['code']}",
        "qty_diffs": lambda x: f"q:{x['code']}",
    }

    def _mark_resolved(result: dict, keys) -> None:
        cur = list(result.get("janggi_resolved") or [])
        for k in keys:
            if k and k not in cur:
                cur.append(k)
        result["janggi_resolved"] = cur

    def _janggi_diff_open(row, result: dict) -> dict:
        """_janggi_diff에서 이미 처리한 항목을 뺀 결과 (resolved_count = 숨긴 개수)."""
        diff = _janggi_diff(row, result)
        if diff.get("empty"):
            return diff
        resolved = set(result.get("janggi_resolved") or [])
        hidden = 0
        for name, keyf in _DIFF_KEYS.items():
            rows = diff.get(name) or []
            keep = [x for x in rows if keyf(x) not in resolved]
            hidden += len(rows) - len(keep)
            diff[name] = keep
        diff["resolved_count"] = hidden
        return diff

    @router.get("/records/{record_id}/janggi-check")
    def janggi_check(record_id: int, admin: str = Depends(require_admin)):
        """장끼 DB 대조 결과만 돌려준다 (저장된 매칭은 바꾸지 않는다). 처리 완료한 항목은 빠진다."""
        conn = get_db()
        try:
            row, result = _load_for_edit(conn, record_id)
        finally:
            conn.close()
        return _janggi_diff_open(row, result)

    @router.post("/records/{record_id}/janggi-resolve")
    def janggi_resolve(record_id: int, payload: dict = Body(...), admin: str = Depends(require_admin)):
        """PASS 등으로 처리한 점검 항목을 기록한다. body: {keys: [...]} / {reset: true}면 처리 기록을 모두 지운다."""
        conn = get_db()
        try:
            row, result = _load_for_edit(conn, record_id)
            if payload.get("reset"):
                result.pop("janggi_resolved", None)
            else:
                _mark_resolved(result, [str(k) for k in (payload.get("keys") or [])])
            record = _persist_edit(conn, row, result)
            return {"ok": True, "diff": _janggi_diff_open(row, result), "record": record}
        finally:
            conn.close()

    @router.post("/records/{record_id}/janggi-apply")
    def janggi_apply(record_id: int, payload: dict = Body(...), admin: str = Depends(require_admin)):
        """사용자가 고른 항목만 SO+에 반영한다 (나머지는 PASS). body: {deductions: [거래처...], products: [상품코드...]}
        - deductions: 장끼 매입차감이 덜 반영된 거래처 → 부족분만큼 매입차감 추가
        - products: 장끼에만 있는 상품(원가베이스유에 있는 것) → 장끼의 입고/미송/미송픽업 수량 그대로 추가
        - qty_diffs: 이미 SO+에 있는 상품 중 장끼 수량이 더 많은 구분(입고/미송/미송픽업)만 그 차이만큼 추가
        반환: applied(반영한 내역+사유), diff(반영 후 남은 차이), record."""
        pick_clients = {str(x) for x in (payload.get("deductions") or [])}
        pick_codes = {to_s_code(str(x).strip().upper()) for x in (payload.get("products") or [])}
        pick_qty = {to_s_code(str(x).strip().upper()) for x in (payload.get("qty_diffs") or [])}
        pick_fees = {(str(x.get("client") or ""), str(x.get("label") or "")) for x in (payload.get("fees") or []) if isinstance(x, dict)}
        conn = get_db()
        try:
            row, result = _load_for_edit(conn, record_id)
            diff = _janggi_diff(row, result)
            if diff.get("empty"):
                return {"ok": True, "empty": True, "applied": [], "diff": diff, "record": _row_to_record(row, True)}
            applied = []
            for d in diff["deductions"]:
                if d["diff"] > 0 and d["client"] in pick_clients:
                    _put_deduct(result, d["client"], d["diff"], "장끼DB 매입차감", from_janggi=True)
                    applied.append({"kind": "deduction", "client": d["client"], "label": f"매입차감 -{d['diff']:,}원",
                                    "reason": "장끼정리 매입차감이 SO+에 반영 안 되어 추가"})
            infos = _wonbe_infos([p["code"] for p in diff["products"] if p["in_wonbe"]])
            for p in diff["products"]:
                info = infos.get(p["code"])
                if not info or p["code"] not in pick_codes:
                    continue
                qtys = {k: 0 for k in _NUM_KEYS}
                for k in ("received", "misong", "pickup"):
                    qtys[k] = int(p.get(k) or 0)
                target = _put_product(result, p["code"], info, qtys, edited=False, from_janggi=True)
                applied.append({"kind": "product", "client": target, "code": p["code"], "name": p["name"], "option": p["option"],
                                "label": _kinds_text(p), "reason": "장끼정리에는 있으나 SO+ 매칭에 없어 추가"})
            for f in diff["fees"]:
                if f["diff"] > 0 and (f["client"], f["label"]) in pick_fees:
                    _put_fee(result, f["client"], f["label"], f["diff"], from_janggi=True)
                    applied.append({"kind": "fee", "client": f["client"], "label": f"{f['label']} +{f['diff']:,}원",
                                    "reason": "장끼정리 금액이 SO+에 없어 추가 (부가세 거래처면 부가세도 같이 계산)"})
            for q in diff["qty_diffs"]:
                if q["code"] not in pick_qty or not any(q["add"].values()):
                    continue
                for c in result.get("clients", []) or []:
                    it = next((x for x in c.get("items", []) if x.get("code") == q["code"]), None)
                    if it is None:
                        continue
                    for k, v in q["add"].items():
                        it[k] = int(it.get(k) or 0) + v
                    it["from_janggi"] = True
                    applied.append({"kind": "qty", "client": c.get("client", ""), "code": q["code"], "name": q["name"], "option": q["option"],
                                    "label": _kinds_text(q["add"]), "reason": "장끼정리 수량이 SO+보다 많아 부족분 추가"})
                    break
            if applied:
                # 반영한 항목은 처리 완료로 기록 (반영 후에도 차이가 조금 남아도 목록에서 빠진다)
                keys = []
                for a in applied:
                    if a["kind"] == "deduction":
                        keys.append(f"d:{a['client']}")
                    elif a["kind"] == "fee":
                        keys += [f"f:{f['client']}:{f['label']}" for f in diff["fees"] if (f["client"], f["label"]) in pick_fees and f["client"] == a["client"]]
                    elif a["kind"] in ("product", "qty"):
                        keys += [f"p:{a['code']}", f"q:{a['code']}"]
                _mark_resolved(result, keys)
            record = _persist_edit(conn, row, result) if applied else _row_to_record(row, True)
            return {"ok": True, "empty": False, "applied": applied, "diff": _janggi_diff_open(row, result), "record": record}
        finally:
            conn.close()

    @router.post("/records/{record_id}/janggi-remove")
    def janggi_remove(record_id: int, payload: dict = Body(...), admin: str = Depends(require_admin)):
        """장끼 점검 창의 [삭제]: SO+ 세부목록에서 실제로 지운다.
        body: {kind: item|deduct|fee, client, code?, label?}
        - item: 거래처의 해당 상품코드 줄 삭제 (SO+에만 있는 상품 / 수량 상이 상품)
        - deduct: 그 거래처의 매입차감(DEDUCT-*) 줄 전부 삭제
        - fee: 그 거래처의 label 이름 추가금액(FEE-*) 줄 삭제"""
        kind = str(payload.get("kind") or "")
        client = str(payload.get("client") or "").strip()
        conn = get_db()
        try:
            row, result = _load_for_edit(conn, record_id)
            if kind == "item":
                c, i = _find_item(result, client, str(payload.get("code") or ""))
                c["items"].remove(i)
                removed = 1
            elif kind in ("deduct", "fee"):
                c = next((x for x in result.get("clients", []) or [] if x.get("client") == client), None)
                if not c:
                    raise HTTPException(status_code=404, detail="거래처를 찾을 수 없습니다.")
                label = str(payload.get("label") or "")

                def hit(x) -> bool:
                    code = str(x.get("code", ""))
                    if kind == "deduct":
                        return code.startswith("DEDUCT-")
                    return code.startswith("FEE-") and x.get("name") == label

                removed = sum(1 for x in c["items"] if hit(x))
                if not removed:
                    raise HTTPException(status_code=404, detail="삭제할 항목이 SO+ 세부목록에 없습니다.")
                c["items"] = [x for x in c["items"] if not hit(x)]
            else:
                raise HTTPException(status_code=400, detail="잘못된 삭제 종류입니다.")
            # 삭제한 항목은 처리 완료로 기록 (상품은 장끼에만 있는 상품으로 바뀌어 다시 뜨지 않도록 s/q/p 모두)
            code = str(payload.get("code") or "")
            _mark_resolved(result, {
                "item": [f"s:{code}", f"q:{code}", f"p:{code}"],
                "deduct": [f"d:{client}"],
                "fee": [f"f:{client}:{payload.get('label') or ''}"],
            }[kind])
            record = _persist_edit(conn, row, result)
            return {"ok": True, "removed": removed, "diff": _janggi_diff_open(row, result), "record": record}
        finally:
            conn.close()

    @router.delete("/records/{record_id}/items")
    def delete_record_item(record_id: int, client: str, code: str, admin: str = Depends(require_admin)):
        conn = get_db()
        try:
            row, result = _load_for_edit(conn, record_id)
            c, i = _find_item(result, client, code)
            c["items"].remove(i)
            return {"ok": True, "record": _persist_edit(conn, row, result)}
        finally:
            conn.close()

    @router.put("/records/{record_id}/items")
    def update_record_item(record_id: int, payload: dict = Body(...), admin: str = Depends(require_admin)):
        """세부목록 한 줄 수정. body: {client, code, ordered?, received?, misong?, ordered_pickup?, pickup?, new_code?}
        new_code를 주면 상품을 다른 상품으로 바꾼다 (상품명/옵션/거래처/원가를 원가베이스유에서 새로 채움)."""
        client = str(payload.get("client") or "")
        code = str(payload.get("code") or "")
        conn = get_db()
        try:
            row, result = _load_for_edit(conn, record_id)
            c, item = _find_item(result, client, code)
            for k in _NUM_KEYS:
                if k in payload and payload[k] is not None and payload[k] != "":
                    try:
                        v = int(payload[k])
                    except (TypeError, ValueError):
                        raise HTTPException(status_code=400, detail=f"{k} 수량이 숫자가 아닙니다.")
                    if v < 0:
                        raise HTTPException(status_code=400, detail="수량은 0 이상이어야 합니다.")
                    item[k] = v
            item["edited"] = True

            new_code = to_s_code(str(payload.get("new_code") or "").strip().upper())
            if new_code and new_code != code:
                wconn = get_wonbe_db()
                try:
                    info = wconn.execute(
                        "SELECT 상품코드, 상품명, 색상, 사이즈, 거래처 FROM wonbe WHERE 상품코드 = ?", (new_code,)
                    ).fetchone()
                finally:
                    wconn.close()
                if not info:
                    raise HTTPException(status_code=400, detail=f"원가베이스유에 없는 상품코드입니다: {new_code}")
                costs = _costs_for([new_code])
                color, size = info["색상"] or "", info["사이즈"] or ""
                item.update({
                    "code": new_code, "name": info["상품명"] or "", "option": f"{color}/{size}".strip("/"),
                    "cost": costs.get(new_code, 0),
                })
                target = (info["거래처"] or "").strip() or client
                c["items"].remove(item)
                dest = next((x for x in result["clients"] if x.get("client") == target), None)
                if dest is None:
                    dest = {"client": target, "vat": target in _vat_set(), "items": []}
                    result["clients"].append(dest)
                same = next((x for x in dest["items"] if x.get("code") == new_code), None)
                if same:  # 이미 같은 상품이 있으면 수량을 합친다
                    for k in (*_ALL_KEYS, "deduct"):
                        same[k] = int(same.get(k) or 0) + int(item.get(k) or 0)
                    same["edited"] = True
                else:
                    dest["items"].append(item)
            return {"ok": True, "record": _persist_edit(conn, row, result)}
        finally:
            conn.close()

    return router
