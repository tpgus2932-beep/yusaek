from __future__ import annotations

import re
from collections import Counter
from datetime import date as date_cls, datetime, timedelta
from zoneinfo import ZoneInfo

import httpx
from fastapi import APIRouter, Body, Depends, HTTPException

_EZADMIN_BASE = "https://ga80.ezadmin.co.kr"
_EZADMIN_SESSION_KEY = "ezadmin_phpsessid"
# get_number_list는 PHPSESSID만으로는 응답하지 않고(ReadTimeout), 로그인 도메인/아이디 쿠키가 같이 있어야 한다.
_EZ_EXTRA_COOKIES = {"ezdomain": "yusaek", "ezuserid": "yusaek", "ezsave": "on"}
# 주문 조회는 건수에 비례해 느리다 (실측: 770건 약 40초, 2005건 약 100초)
_EZ_TIMEOUT = 300.0
_KST = ZoneInfo("Asia/Seoul")
_BULK_MIN_COUNT = 10
_HISTORY_DAYS = 5

# 버튼 순서. 각 이벤트는 앞 단계가 기록돼 있어야 하고 자기 자신은 비어 있어야 한다.
_EVENT_COLUMNS = {
    "pack_start": "bulk_start",
    "bulk_end": "bulk_end",
    "single_start": "single_start",
    "single_end": "single_end",
}
_EVENT_ORDER = ["bulk_start", "bulk_end", "single_start", "single_end"]

_NUMBER_TITLE_RE = re.compile(r"\[\s*(\d+)\s*\]\s*\((\d{2}:\d{2}:\d{2})\)\s*개수\s*:\s*(\d+)")
_PRODUCT_RE = re.compile(r"\[([A-Z]\d+)\](.*?)(?:-\[([^\]]*)\])?\s+(\d+)개")


def init_shipping_eta_table(get_db):
    conn = get_db()
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS shipping_eta_log (
                work_date TEXT PRIMARY KEY,
                bulk_start TEXT NOT NULL DEFAULT '',
                bulk_end TEXT NOT NULL DEFAULT '',
                single_start TEXT NOT NULL DEFAULT '',
                single_end TEXT NOT NULL DEFAULT '',
                bulk_count INTEGER NOT NULL DEFAULT 0,
                single_count INTEGER NOT NULL DEFAULT 0,
                combo_count INTEGER NOT NULL DEFAULT 0,
                updated_by TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL DEFAULT ''
            )
            """
        )
        conn.commit()
    finally:
        conn.close()


def classify_orders(order_rows: list[dict]) -> dict:
    """한 출력차수의 주문들을 합포 / 대량 / 개별로 나눈다.

    합포: 한 주문에 서로 다른 상품코드가 2종 이상.
    대량: 단일 상품 주문 중, 같은 상품 주문이 차수 안에서 _BULK_MIN_COUNT건 이상.
    개별: 나머지.
    """
    combo = 0
    single_code_orders: list[str] = []
    unparsed = 0
    for order in order_rows:
        cell = order.get("cell", {}) if isinstance(order, dict) else {}
        codes = {m.group(1).strip() for m in _PRODUCT_RE.finditer(str(cell.get("products", "")))}
        if len(codes) > 1:
            combo += 1
        elif len(codes) == 1:
            single_code_orders.append(next(iter(codes)))
        else:
            unparsed += 1
    per_code = Counter(single_code_orders)
    bulk = sum(n for n in per_code.values() if n >= _BULK_MIN_COUNT)
    single = (len(single_code_orders) - bulk) + unparsed
    return {"bulk": bulk, "single": single, "combo": combo, "total": len(order_rows)}


def _parse_dt(value: str) -> datetime | None:
    try:
        return datetime.fromisoformat(value) if value else None
    except ValueError:
        return None


def _rate(start: str, end: str, count: int) -> float | None:
    s, e = _parse_dt(start), _parse_dt(end)
    if not s or not e or count <= 0:
        return None
    seconds = (e - s).total_seconds()
    return seconds / count if seconds > 0 else None


def _avg(values: list[float]) -> float | None:
    return sum(values) / len(values) if values else None


def build_shipping_eta_router(*, get_current_user, get_setting, get_db):
    router = APIRouter(prefix="/shipping-eta")

    def _now() -> datetime:
        return datetime.now(_KST).replace(tzinfo=None, microsecond=0)

    def _norm_date(value: str) -> str:
        try:
            return date_cls.fromisoformat(str(value).strip()).isoformat()
        except ValueError:
            raise HTTPException(status_code=400, detail="날짜 형식이 올바르지 않습니다.")

    async def _ez_post(form: dict):
        phpsessid = (get_setting(_EZADMIN_SESSION_KEY) or "").strip()
        if not phpsessid:
            return None
        headers = {
            "Accept": "application/json, text/javascript, */*; q=0.01",
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "Origin": _EZADMIN_BASE,
            "Referer": f"{_EZADMIN_BASE}/template35.htm?template=S700",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
            "X-Requested-With": "XMLHttpRequest",
        }
        try:
            async with httpx.AsyncClient(timeout=_EZ_TIMEOUT, verify=False, follow_redirects=True) as client:
                res = await client.post(
                    f"{_EZADMIN_BASE}/function.htm", headers=headers,
                    cookies={"PHPSESSID": phpsessid, **_EZ_EXTRA_COOKIES}, data=form,
                )
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"이지어드민 응답 오류: {type(e).__name__} {e}".strip())
        try:
            return res.json()
        except Exception:
            return False  # JSON이 아니면 세션 만료로 본다

    def _read_row(conn, work_date: str) -> dict:
        row = conn.execute("SELECT * FROM shipping_eta_log WHERE work_date = ?", (work_date,)).fetchone()
        if row is None:
            return {
                "work_date": work_date, "bulk_start": "", "bulk_end": "", "single_start": "", "single_end": "",
                "bulk_count": 0, "single_count": 0, "combo_count": 0,
            }
        return {k: row[k] for k in row.keys()}

    def _estimate(conn, work_date: str, current: dict) -> dict:
        rows = conn.execute(
            "SELECT * FROM shipping_eta_log WHERE work_date < ? ORDER BY work_date DESC LIMIT 60", (work_date,)
        ).fetchall()
        bulk_rates: list[float] = []
        single_rates: list[float] = []
        for r in rows:
            if len(bulk_rates) < _HISTORY_DAYS:
                v = _rate(r["bulk_start"], r["bulk_end"], r["bulk_count"])
                if v is not None:
                    bulk_rates.append(v)
            if len(single_rates) < _HISTORY_DAYS:
                # 합포는 개별 포장 시간에 포함해서 계산한다
                v = _rate(r["single_start"], r["single_end"], r["single_count"] + r["combo_count"])
                if v is not None:
                    single_rates.append(v)
        bulk_rate, single_rate = _avg(bulk_rates), _avg(single_rates)
        now = _now()

        bulk_end_est = None
        if current["bulk_end"]:
            bulk_end_est = _parse_dt(current["bulk_end"])
        elif bulk_rate is not None and current["bulk_count"] > 0:
            start = _parse_dt(current["bulk_start"]) or now
            bulk_end_est = max(now, start + timedelta(seconds=bulk_rate * current["bulk_count"]))

        single_end_est = None
        single_n = current["single_count"] + current["combo_count"]
        if current["single_end"]:
            single_end_est = _parse_dt(current["single_end"])
        elif single_rate is not None and single_n > 0:
            start = _parse_dt(current["single_start"]) or bulk_end_est or now
            single_end_est = max(now, start + timedelta(seconds=single_rate * single_n))

        eta = single_end_est if single_n > 0 else bulk_end_est
        if eta is not None and (current["bulk_count"] > 0 and bulk_end_est is None):
            eta = None  # 대량 구간 예상을 못 내면 전체 예상도 내지 않는다
        return {
            "bulk_rate_sec": bulk_rate,
            "single_rate_sec": single_rate,
            "history_bulk_days": len(bulk_rates),
            "history_single_days": len(single_rates),
            "bulk_end_est": bulk_end_est.isoformat() if bulk_end_est else "",
            "single_end_est": single_end_est.isoformat() if single_end_est else "",
            "eta": eta.isoformat() if eta else "",
            "now": now.isoformat(),
        }

    def _state(work_date: str) -> dict:
        conn = get_db()
        try:
            current = _read_row(conn, work_date)
            return {"ok": True, "log": current, "estimate": _estimate(conn, work_date, current)}
        finally:
            conn.close()

    @router.get("/number-list")
    async def number_list(date: str, user: str = Depends(get_current_user)):
        work_date = _norm_date(date)
        result = await _ez_post({
            "template": "S700", "action": "get_number_list", "par": f"date1={work_date}",
        })
        if result is None or result is False:
            return {"ok": False, "need_session": True}
        items = result if isinstance(result, list) else next(
            (v for v in result.values() if isinstance(v, list)), []
        ) if isinstance(result, dict) else []
        numbers = []
        for item in items:
            title = str(item.get("title", ""))
            m = _NUMBER_TITLE_RE.search(title)
            numbers.append({
                "print_num": str(item.get("print_num", "")),
                "title": title,
                "time": m.group(2) if m else "",
                "count": int(m.group(3)) if m else 0,
            })
        numbers.sort(key=lambda n: int(n["print_num"]) if n["print_num"].isdigit() else 0)
        return {"ok": True, "numbers": numbers}

    @router.post("/classify")
    async def classify(payload: dict = Body(...), user: str = Depends(get_current_user)):
        work_date = _norm_date(payload.get("date", ""))
        print_nums = [str(n).strip() for n in payload.get("print_nums", []) if str(n).strip().isdigit()]
        if not print_nums:
            raise HTTPException(status_code=400, detail="출력차수를 선택해 주세요.")

        d = date_cls.fromisoformat(work_date)
        weekday_kr = ["월", "화", "수", "목", "금", "토", "일"][d.weekday()]
        totals = {"bulk": 0, "single": 0, "combo": 0, "total": 0}
        per_number = []
        for num in print_nums:
            par = (
                f"orderReserve=0&priorityDeliv=0"
                f"&numberDate={d.year}-{d.month}-{d.day}"
                f"&start_date3={d.year}년 {d.month:02d}월 {d.day:02d}일 {weekday_kr}요일"
                f"&number_no={num}&is_download=0&orderType=2"
                f"&agencyTemplate=20004&check_address=2"
                f"&teamf_transType=tonight&kakaoT_type=0&deliv_today_type=0&hanjin_deliv_type=GN"
            )
            result = await _ez_post({
                "template": "S700", "action": "get_success_order", "_search": "false",
                "nd": str(int(datetime.now().timestamp() * 1000)), "rows": "999999", "page": "1",
                "sidx": "", "sord": "asc", "readonly": "T", "par": par,
            })
            if result is None or result is False:
                return {"ok": False, "need_session": True}
            counts = classify_orders(result.get("rows", []) if isinstance(result, dict) else [])
            per_number.append({"print_num": num, **counts})
            for k in totals:
                totals[k] += counts[k]

        conn = get_db()
        try:
            conn.execute(
                "INSERT INTO shipping_eta_log (work_date, bulk_count, single_count, combo_count, updated_by, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(work_date) DO UPDATE SET bulk_count=excluded.bulk_count, "
                "single_count=excluded.single_count, combo_count=excluded.combo_count, "
                "updated_by=excluded.updated_by, updated_at=excluded.updated_at",
                (work_date, totals["bulk"], totals["single"], totals["combo"], user, _now().isoformat()),
            )
            conn.commit()
        finally:
            conn.close()
        return {"ok": True, "totals": totals, "per_number": per_number, **_state(work_date)}

    @router.get("/state")
    async def state(date: str, user: str = Depends(get_current_user)):
        return _state(_norm_date(date))

    @router.post("/event")
    async def event(payload: dict = Body(...), user: str = Depends(get_current_user)):
        work_date = _norm_date(payload.get("date", ""))
        name = str(payload.get("event", "")).strip()
        conn = get_db()
        try:
            current = _read_row(conn, work_date)
            if name == "undo":
                last = next((c for c in reversed(_EVENT_ORDER) if current[c]), None)
                if last is None:
                    raise HTTPException(status_code=400, detail="취소할 기록이 없습니다.")
                column, value = last, ""
            elif name in _EVENT_COLUMNS:
                column, value = _EVENT_COLUMNS[name], _now().isoformat()
                idx = _EVENT_ORDER.index(column)
                if current[column]:
                    raise HTTPException(status_code=400, detail="이미 기록된 단계입니다.")
                if idx > 0 and not current[_EVENT_ORDER[idx - 1]]:
                    raise HTTPException(status_code=400, detail="이전 단계를 먼저 기록해 주세요.")
            else:
                raise HTTPException(status_code=400, detail="알 수 없는 이벤트입니다.")
            conn.execute(
                f"INSERT INTO shipping_eta_log (work_date, {column}, updated_by, updated_at) VALUES (?, ?, ?, ?) "
                f"ON CONFLICT(work_date) DO UPDATE SET {column}=excluded.{column}, "
                f"updated_by=excluded.updated_by, updated_at=excluded.updated_at",
                (work_date, value, user, _now().isoformat()),
            )
            conn.commit()
        finally:
            conn.close()
        return _state(work_date)

    return router
