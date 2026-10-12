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
_LOOKBACK_DAYS = 60  # 과거 약 2개월까지만 찾는다
_MAX_COUNT_DIFF = 0.10  # 오늘 건수 대비 건수 차이가 이 비율 이내인 날만 유사일로 인정한다

# 6단계: 종류(대량/개별/합배) x 공정(포장/출고). 예상 시간 계산은 이 순서대로 이어서 진행한다고 가정한다.
# 칸마다 시작/종료를 따로 기록하며 기록 순서는 강제하지 않는다.
_STAGES = [
    ("bulk_pack", "bulk"), ("bulk_ship", "bulk"),
    ("single_pack", "single"), ("single_ship", "single"),
    ("combo_pack", "combo"), ("combo_ship", "combo"),
]
_STAGE_KEYS = [k for k, _ in _STAGES]
_STAGE_COLUMNS = [f"{k}_{edge}" for k in _STAGE_KEYS for edge in ("start", "end")]
# 이전 버전(4칸)에서 쌓인 기록을 새 칼럼으로 옮기기 위한 매핑
_LEGACY_COLUMNS = {
    "bulk_start": "bulk_pack_start", "bulk_end": "bulk_pack_end",
    "single_start": "single_pack_start", "single_end": "single_pack_end",
}

_NUMBER_TITLE_RE = re.compile(r"\[\s*(\d+)\s*\]\s*\((\d{2}:\d{2}:\d{2})\)\s*개수\s*:\s*(\d+)")
_PRODUCT_RE = re.compile(r"\[([A-Z]\d+)\](.*?)(?:-\[([^\]]*)\])?\s+(\d+)개")


def init_shipping_eta_table(get_db):
    conn = get_db()
    try:
        stage_ddl = ",\n".join(f"                {c} TEXT NOT NULL DEFAULT ''" for c in _STAGE_COLUMNS)
        conn.execute(
            f"""
            CREATE TABLE IF NOT EXISTS shipping_eta_log (
                work_date TEXT PRIMARY KEY,
{stage_ddl},
                bulk_count INTEGER NOT NULL DEFAULT 0,
                single_count INTEGER NOT NULL DEFAULT 0,
                combo_count INTEGER NOT NULL DEFAULT 0,
                updated_by TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL DEFAULT ''
            )
            """
        )
        existing = {r["name"] for r in conn.execute("PRAGMA table_info(shipping_eta_log)").fetchall()}
        for col in _STAGE_COLUMNS:
            if col not in existing:
                conn.execute(f"ALTER TABLE shipping_eta_log ADD COLUMN {col} TEXT NOT NULL DEFAULT ''")
        for old, new in _LEGACY_COLUMNS.items():
            if old in existing:
                conn.execute(f"UPDATE shipping_eta_log SET {new} = {old} WHERE {new} = '' AND {old} != ''")
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
        keys = ["work_date", *_STAGE_COLUMNS, "bulk_count", "single_count", "combo_count"]
        if row is None:
            return {k: ("" if k in _STAGE_COLUMNS or k == "work_date" else 0) for k in keys} | {"work_date": work_date}
        return {k: row[k] for k in keys}

    def _estimate(conn, work_date: str, current: dict) -> dict:
        since = (date_cls.fromisoformat(work_date) - timedelta(days=_LOOKBACK_DAYS)).isoformat()
        rows = conn.execute(
            "SELECT * FROM shipping_eta_log WHERE work_date >= ? AND work_date < ? ORDER BY work_date DESC",
            (since, work_date),
        ).fetchall()

        def predict(key: str, kind: str, n: int):
            """같은 종류(kind) 건수가 오늘(n)과 _MAX_COUNT_DIFF 이내인 가장 최근 날 1개의 건당 시간으로 오늘 소요시간(초)을 예측한다.
            rows가 최근 날짜순이라 처음 조건에 맞는 날에서 바로 멈춘다."""
            if n <= 0:
                return None, []
            for r in rows:
                rate = _rate(r[f"{key}_start"], r[f"{key}_end"], r[f"{kind}_count"])
                if rate is None:
                    continue
                past_n = r[f"{kind}_count"]
                if abs(past_n - n) / n <= _MAX_COUNT_DIFF:
                    return rate * n, [{"date": r["work_date"], "count": past_n, "sec": round(rate * past_n)}]
            return None, []

        now = _now()
        cursor = now
        unknown = False
        stages: dict[str, dict] = {}
        for key, kind in _STAGES:
            n = current[f"{kind}_count"]
            start, end = _parse_dt(current[f"{key}_start"]), _parse_dt(current[f"{key}_end"])
            pred_sec, basis = predict(key, kind, n)
            info = {"pred_sec": pred_sec, "basis": basis, "start_est": "", "end_est": ""}
            if end:
                info["end_est"] = end.isoformat()
                cursor = max(cursor, end)
            elif n <= 0:
                stages[key] = info
                continue
            elif pred_sec is None:
                unknown = True
            else:
                begin = start or cursor
                info["start_est"] = begin.isoformat()
                est = max(now, begin + timedelta(seconds=pred_sec))
                info["end_est"] = est.isoformat()
                cursor = max(cursor, est)
            stages[key] = info
        has_work = any(current[f"{kind}_count"] > 0 for _, kind in _STAGES)
        return {
            "stages": stages,
            "eta": cursor.isoformat() if has_work and not unknown else "",
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
        stage = str(payload.get("stage", "")).strip()
        action = str(payload.get("action", "")).strip()
        if stage not in _STAGE_KEYS:
            raise HTTPException(status_code=400, detail="알 수 없는 단계입니다.")
        start_col, end_col = f"{stage}_start", f"{stage}_end"
        conn = get_db()
        try:
            current = _read_row(conn, work_date)
            if action == "start":
                if current[start_col]:
                    raise HTTPException(status_code=400, detail="이미 시작한 단계입니다.")
                column, value = start_col, _now().isoformat()
            elif action == "end":
                if not current[start_col]:
                    raise HTTPException(status_code=400, detail="먼저 시작을 기록해 주세요.")
                if current[end_col]:
                    raise HTTPException(status_code=400, detail="이미 종료한 단계입니다.")
                column, value = end_col, _now().isoformat()
            elif action == "undo":
                column = end_col if current[end_col] else start_col
                if not current[column]:
                    raise HTTPException(status_code=400, detail="취소할 기록이 없습니다.")
                value = ""
            else:
                raise HTTPException(status_code=400, detail="알 수 없는 동작입니다.")
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
