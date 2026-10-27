from __future__ import annotations

import json
import os
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
# 실제 출퇴근 기록은 배포 근태 서버에 쌓인다. 이 앱이 읽는 DB에 오늘 기록이 없을 때 여기서 오늘 기록을 가져온다.
_ATTENDANCE_REMOTE_BASE = (os.environ.get("ATTENDANCE_REMOTE_BASE") or "https://seungilsaiteu.onrender.com").rstrip("/")
_BULK_MIN_COUNT = 10
_LOOKBACK_DAYS = 60  # 과거 약 2개월까지만 찾는다
_MAX_COUNT_DIFF = 0.10  # 오늘 건수 대비 건수 차이가 이 비율 이내인 날만 유사일로 인정한다
_MAX_WORKER_DIFF = 1  # 공정 시작 시점의 근무 인원 차이가 이 값(명) 이내인 날만 유사일로 인정한다
_ATTENDANCE_COLUMNS = {"checkin": "checkin_json", "checkout": "checkout_json"}
_ATTENDANCE_TYPES = {"checkin": "출근", "checkout": "퇴근"}

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
                checkin_json TEXT NOT NULL DEFAULT '',
                checkout_json TEXT NOT NULL DEFAULT '',
                updated_by TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL DEFAULT ''
            )
            """
        )
        existing = {r["name"] for r in conn.execute("PRAGMA table_info(shipping_eta_log)").fetchall()}
        for col in _STAGE_COLUMNS:
            if col not in existing:
                conn.execute(f"ALTER TABLE shipping_eta_log ADD COLUMN {col} TEXT NOT NULL DEFAULT ''")
        for col in _ATTENDANCE_COLUMNS.values():
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


def _load_records(raw: str) -> list[dict]:
    try:
        data = json.loads(raw) if raw else []
    except ValueError:
        return []
    return data if isinstance(data, list) else []


def _headcount(checkins: list[dict], checkouts: list[dict], at: datetime | None) -> int | None:
    """at 시각에 근무 중인 인원 수. 출근 기록이 없으면 알 수 없으므로 None."""
    if not checkins or at is None:
        return None
    first_in: dict[str, datetime] = {}
    for rec in checkins:
        t = _parse_dt(rec.get("time", ""))
        if t and (rec["name"] not in first_in or t < first_in[rec["name"]]):
            first_in[rec["name"]] = t
    last_out: dict[str, datetime] = {}
    for rec in checkouts:
        t = _parse_dt(rec.get("time", ""))
        if t and (rec["name"] not in last_out or t > last_out[rec["name"]]):
            last_out[rec["name"]] = t
    return sum(
        1 for name, t_in in first_in.items()
        if t_in <= at and not (name in last_out and last_out[name] <= at)
    )


def _attendance_timeline(checkins: list[dict], checkouts: list[dict]) -> list[dict]:
    """출근/퇴근 이벤트를 시간순으로 나열하고 각 시점 직후의 근무 인원을 붙인다."""
    events = sorted(
        [(r.get("time", ""), "출근", r["name"]) for r in checkins]
        + [(r.get("time", ""), "퇴근", r["name"]) for r in checkouts]
    )
    present = 0
    timeline = []
    for time, kind, name in events:
        present += 1 if kind == "출근" else -1
        timeline.append({"time": time, "type": kind, "name": name, "present": max(present, 0)})
    return timeline


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
        text_keys = {"work_date", *_STAGE_COLUMNS, *_ATTENDANCE_COLUMNS.values()}
        keys = ["work_date", *_STAGE_COLUMNS, "bulk_count", "single_count", "combo_count", *_ATTENDANCE_COLUMNS.values()]
        if row is None:
            return {k: ("" if k in text_keys else 0) for k in keys} | {"work_date": work_date}
        return {k: row[k] for k in keys}

    def _fetch_attendance(conn, work_date: str, edge: str) -> list[dict]:
        """근태 기록(출근/퇴근)을 KST 시각으로 바꿔 [{name, time}] 로 돌려준다."""
        try:
            rows = conn.execute(
                "SELECT member_name, timestamp FROM attendance_records WHERE date = ? AND type = ? ORDER BY timestamp",
                (work_date, _ATTENDANCE_TYPES[edge]),
            ).fetchall()
        except Exception:
            return []
        records = []
        for r in rows:
            dt = _parse_dt(r["timestamp"])
            if dt is None:
                continue
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=ZoneInfo("UTC"))
            kst = dt.astimezone(_KST).replace(tzinfo=None, microsecond=0)
            records.append({"name": r["member_name"], "time": kst.isoformat()})
        return records

    async def _fetch_remote_attendance(work_date: str, edge: str) -> list[dict]:
        """배포 근태 서버의 /attendance/records/today(공개)에서 오늘 출근/퇴근 기록을 KST [{name, time}]로 가져온다."""
        try:
            # Render 무료 서버는 잠들어 있다 깨어나는 데 오래 걸릴 수 있다
            async with httpx.AsyncClient(timeout=70.0, follow_redirects=True) as client:
                r = await client.get(f"{_ATTENDANCE_REMOTE_BASE}/attendance/records/today")
            rows = r.json() if r.status_code == 200 else []
        except Exception:
            return []
        records = []
        for row in rows if isinstance(rows, list) else []:
            if row.get("type") != _ATTENDANCE_TYPES[edge] or row.get("date") != work_date:
                continue
            dt = _parse_dt(row.get("timestamp"))
            if dt is None:
                continue
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=ZoneInfo("UTC"))
            kst = dt.astimezone(_KST).replace(tzinfo=None, microsecond=0)
            records.append({"name": row.get("name") or "", "time": kst.isoformat()})
        records.sort(key=lambda x: x["time"])
        return records

    async def _load_attendance(conn, work_date: str, edge: str) -> list[dict]:
        records = _fetch_attendance(conn, work_date, edge)
        if records or work_date != _now().date().isoformat():
            return records
        return await _fetch_remote_attendance(work_date, edge)

    def _save_attendance(conn, work_date: str, edge: str, user: str, records: list[dict]) -> None:
        column = _ATTENDANCE_COLUMNS[edge]
        conn.execute(
            f"INSERT INTO shipping_eta_log (work_date, {column}, updated_by, updated_at) VALUES (?, ?, ?, ?) "
            f"ON CONFLICT(work_date) DO UPDATE SET {column}=excluded.{column}, "
            f"updated_by=excluded.updated_by, updated_at=excluded.updated_at",
            (work_date, json.dumps(records, ensure_ascii=False), user, _now().isoformat()),
        )

    def _estimate(conn, work_date: str, current: dict) -> dict:
        since = (date_cls.fromisoformat(work_date) - timedelta(days=_LOOKBACK_DAYS)).isoformat()
        rows = conn.execute(
            "SELECT * FROM shipping_eta_log WHERE work_date >= ? AND work_date < ? ORDER BY work_date DESC",
            (since, work_date),
        ).fetchall()

        today_in = _load_records(current["checkin_json"])
        today_out = _load_records(current["checkout_json"])

        def predict(key: str, kind: str, n: int, begin: datetime):
            """같은 종류(kind) 건수가 오늘(n)과 _MAX_COUNT_DIFF 이내이고, 공정 시작 시점 근무 인원 차이가
            _MAX_WORKER_DIFF 이내인 가장 최근 날 1개의 건당 시간으로 오늘 소요시간(초)을 예측한다.
            오늘 출근 기록이 없으면 인원은 비교하지 않는다. 과거 날에 근태 기록이 없으면 판단 불가라서
            인원이 맞는 날이 없을 때의 마지막 대안으로만 쓴다.
            rows가 최근 날짜순이라 조건에 맞는 첫 날에서 바로 멈춘다."""
            if n <= 0:
                return None, [], None
            today_hc = _headcount(today_in, today_out, begin)
            fallback = None
            for r in rows:
                rate = _rate(r[f"{key}_start"], r[f"{key}_end"], r[f"{kind}_count"])
                if rate is None:
                    continue
                past_n = r[f"{kind}_count"]
                if abs(past_n - n) / n > _MAX_COUNT_DIFF:
                    continue
                basis = {"date": r["work_date"], "count": past_n, "sec": round(rate * past_n), "workers": None}
                if today_hc is None:
                    return rate * n, [basis], None
                past_hc = _headcount(
                    _load_records(r["checkin_json"]), _load_records(r["checkout_json"]), _parse_dt(r[f"{key}_start"])
                )
                if past_hc is None:
                    if fallback is None:
                        fallback = (rate * n, [basis], today_hc)
                    continue
                basis["workers"] = past_hc
                if abs(past_hc - today_hc) <= _MAX_WORKER_DIFF:
                    return rate * n, [basis], today_hc
            return fallback if fallback else (None, [], today_hc)

        now = _now()
        cursor = now
        unknown = False
        stages: dict[str, dict] = {}
        for key, kind in _STAGES:
            n = current[f"{kind}_count"]
            start, end = _parse_dt(current[f"{key}_start"]), _parse_dt(current[f"{key}_end"])
            pred_sec, basis, workers = predict(key, kind, n, start or cursor)
            info = {"pred_sec": pred_sec, "basis": basis, "workers": workers, "start_est": "", "end_est": ""}
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
            checkins = _load_records(current["checkin_json"])
            checkouts = _load_records(current["checkout_json"])
            attendance = {"checkin": checkins, "checkout": checkouts, "timeline": _attendance_timeline(checkins, checkouts)}
            return {"ok": True, "log": current, "estimate": _estimate(conn, work_date, current), "attendance": attendance}
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
            _save_attendance(conn, work_date, "checkin", user, await _load_attendance(conn, work_date, "checkin"))  # 불러온 시점의 출근 인원(몇 시에 몇 명)도 같이 저장
            conn.commit()
        finally:
            conn.close()
        return {"ok": True, "totals": totals, "per_number": per_number, **_state(work_date)}

    @router.post("/attendance-load")
    async def attendance_load(payload: dict = Body(...), user: str = Depends(get_current_user)):
        work_date = _norm_date(payload.get("date", ""))
        edge = str(payload.get("kind", "")).strip()
        if edge not in _ATTENDANCE_COLUMNS:
            raise HTTPException(status_code=400, detail="알 수 없는 근태 종류입니다.")
        conn = get_db()
        try:
            _save_attendance(conn, work_date, edge, user, await _load_attendance(conn, work_date, edge))
            conn.commit()
        finally:
            conn.close()
        return _state(work_date)

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
