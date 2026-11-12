from __future__ import annotations

import json
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date as date_cls, datetime, timedelta
from zoneinfo import ZoneInfo

import httpx
from fastapi import APIRouter, Body, Depends, HTTPException

from sdk.ezadmin import EzAdminSessionExpired
from services.ezadmin_im00_client import fetch_im00_line_items, fetch_im00_vouchers, fetch_im10_product_rows

_EZADMIN_BASE = "https://ga80.ezadmin.co.kr"
_EZADMIN_SESSION_KEY = "ezadmin_phpsessid"
# S700은 PHPSESSID만으로는 응답하지 않아 로그인 도메인/아이디 쿠키가 같이 필요하다 (shipping_eta_routes와 동일).
_EZ_EXTRA_COOKIES = {"ezdomain": "yusaek", "ezuserid": "yusaek", "ezsave": "on"}
_EZ_TIMEOUT = 300.0
_SHIP_CLASSIFY_VERSION = 5  # classify_ship_orders 결과 모양이 바뀌면 올린다 (저장된 차수 결과를 다시 읽게 함)
_KST = ZoneInfo("Asia/Seoul")
_NUMBER_TITLE_RE = re.compile(r"\[\s*(\d+)\s*\]\s*\((\d{2}:\d{2}:\d{2})\)\s*개수\s*:\s*(\d+)")
_PRODUCT_RE = re.compile(r"\[([A-Z]\d+)\](.*?)(?:-\[([^\]]*)\])?\s+(\d+)개")
_BULK_RUN_MIN = 10  # 같은 상품코드 단품 주문이 연속 이 개수 이상이면 대량
_DEFAULT_SUPPLIERS = ("케이디지", "리자드스탠다드")
_SLOT_START_MIN = 9 * 60
_SLOT_END_MIN = 22 * 60
_SLOT_STEP = 30
_HEAD_KINDS = ("pack", "ship_bulk", "ship_single")  # 시간대별 근무 인원: 포장 / 대량출고 / 개별출고
_RATE_KINDS = ("pack", "pack_big", "ship_bulk", "ship_single", "ship_big", "ship", "invoice_main", "invoice_stock",
               "match_stock", "match_krl", "match_combo")  # match_*: 매칭작업 (재고매칭 / KRL매칭 / 합포빼기)  # 1인 1분 처리 개수 ("ship"은 예전에 합쳐 저장하던 값, invoice_*는 송장붙이기 본송장/재고송장, pack_big·ship_big은 대형 포장·출고)
_QTY_KINDS = ("pack", "ship", "invoice", "match")  # 직접 입력한 포장/출고/송장/매칭작업 개수
# 비우면(null) 해제되는 인원 설정: 합류 인원 / 대량출고 인원 / 개별출고 인원 / 송장붙이기 본송장·재고송장 인원
_COUNT_OPTIONS = ("join_count", "bulk_head", "single_head", "invoice_main_head", "invoice_stock_head",
                  "match_stock_head", "match_krl_head", "match_combo_head",  # match_*_head: 매칭작업 항목별 인원
                  # 상세 항목 소요 시간 직접 지정(분). 비우면 인원·처리 개수로 자동 계산
                  "pack_bulk_dur", "pack_single_dur", "pack_big_dur", "ship_bulk_dur", "ship_single_dur",
                  "invoice_main_dur", "invoice_stock_dur", "match_stock_dur", "match_krl_dur", "match_combo_dur")
# 시작 시각 직접 지정("HH:MM", 비우면 자동): 포장 / 출고 / 송장붙이기
_TIME_OPTIONS = ("pack_start", "ship_start", "invoice_start", "match_start",
                 # 상세 항목별 시작 시각 (비우면 자동)
                 "pack_bulk_start", "pack_single_start", "pack_big_start", "ship_bulk_start", "ship_single_start",
                 "invoice_main_start", "invoice_stock_start", "match_stock_start", "match_krl_start", "match_combo_start")
_TIME_RE = re.compile(r"^\d{1,2}:\d{2}$")
# 대형 상품: 이지어드민 '상품명' 칸(공급처상품명 아님)이 "2 쿠로 하이넥 ..."처럼 숫자+띄어쓰기로 시작한다.
# ("2way", "1+1", "L 1 ..."은 대형 아님)
_BIG_NAME_RE = re.compile(r"^\d{1,2}\s+\S")
# 매칭작업 K/R/L: 입고요청 품목의 '상품명'이 "K 노다 ...", "R 루세 ...", "L 1 브루 ..."처럼 K/R/L+띄어쓰기로 시작한다.
_KRL_NAME_RE = re.compile(r"^([KRL])\s+\S")

# 시간대별 근무 인원은 관리페이지(별도 서버) 근무표를 그대로 읽어 계산한다.
# PIN은 backend/.env 의 GWANRI_ATTENDANCE_PIN 에 넣는다 (코드/채팅에 적지 않는다).
_GWANRI_API_BASE = os.environ.get("GWANRI_API_BASE", "https://seungilsaiteu.onrender.com").rstrip("/")
_GWANRI_TIMEOUT = 60.0  # Render 무료 서버는 잠들어 있으면 깨어나는 데 수십 초 걸린다
_GWANRI_CACHE_SEC = 30
_AFTERNOON_START_MIN = 12 * 60  # 12시 이후 출근은 오후 인원이라 리드타임 인원에서 뺀다
# 관리페이지 근무표와 같은 공휴일 목록 (공휴일엔 고정 근무가 휴무, 주간 알바도 빠진다)
_GWANRI_HOLIDAYS = frozenset({
    "2026-01-01", "2026-02-16", "2026-02-17", "2026-02-18", "2026-03-02", "2026-05-05", "2026-05-25",
    "2026-06-03", "2026-08-17", "2026-09-24", "2026-09-25", "2026-10-05", "2026-10-09", "2026-12-25",
    "2027-01-01", "2027-02-05", "2027-02-08", "2027-03-01", "2027-05-05", "2027-05-13", "2027-08-16",
    "2027-09-14", "2027-09-15", "2027-09-16", "2027-10-04", "2027-10-11", "2027-12-27", "2028-01-25",
    "2028-01-26", "2028-01-27", "2028-03-01", "2028-05-02", "2028-05-05", "2028-06-06", "2028-08-15",
    "2028-10-02", "2028-10-03", "2028-10-04", "2028-10-05", "2028-10-09", "2028-12-25", "2029-01-01",
    "2029-02-12", "2029-02-13", "2029-02-14", "2029-03-01", "2029-05-07", "2029-05-21", "2029-06-06",
    "2029-08-15", "2029-09-21", "2029-09-24", "2029-10-03", "2029-10-09", "2029-12-25", "2030-01-01",
    "2030-02-04", "2030-02-05", "2030-02-06", "2030-03-01", "2030-05-06", "2030-05-09", "2030-06-06",
    "2030-08-15", "2030-09-11", "2030-09-12", "2030-09-13", "2030-10-03", "2030-10-09", "2030-12-25",
})


def init_lead_time_tables(get_db):
    conn = get_db()
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS lead_time_headcount (
                work_date TEXT NOT NULL,
                slot TEXT NOT NULL,
                headcount INTEGER NOT NULL,
                PRIMARY KEY (work_date, slot)
            )
            """
        )
        # 포장/출고 따로 입력한 시간대별 인원. 위 lead_time_headcount는 구분 없이 저장하던 예전 값(포장·출고 둘 다에 적용).
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS lead_time_headcount_kind (
                work_date TEXT NOT NULL,
                slot TEXT NOT NULL,
                kind TEXT NOT NULL,
                headcount INTEGER NOT NULL,
                PRIMARY KEY (work_date, slot, kind)
            )
            """
        )
        # 1인 1분 처리 개수(rates, 모든 날짜 공통)와 직접 입력한 포장/출고 개수(qty, 날짜별). key는 날짜 또는 "_rates".
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS lead_time_settings (
                key TEXT PRIMARY KEY,
                data TEXT NOT NULL DEFAULT '{}'
            )
            """
        )
        conn.execute("CREATE TABLE IF NOT EXISTS lead_time_unchecked_suppliers (name TEXT PRIMARY KEY)")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS lead_time_snapshot (
                work_date TEXT PRIMARY KEY,
                pack_json TEXT NOT NULL DEFAULT '',
                ship_json TEXT NOT NULL DEFAULT '',
                updated_by TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL DEFAULT ''
            )
            """
        )
        # 출력차수별 분류 결과. 출력이 끝난 차수는 바뀌지 않으므로 한 번 읽으면 다시 이지어드민에 묻지 않는다.
        # version이 _SHIP_CLASSIFY_VERSION과 다르면(분류 규칙이 바뀌면) 다시 읽는다.
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS lead_time_ship_cache (
                work_date TEXT NOT NULL,
                print_num TEXT NOT NULL,
                version INTEGER NOT NULL DEFAULT 0,
                total INTEGER NOT NULL DEFAULT 0,
                counts_json TEXT NOT NULL DEFAULT '{}',
                updated_at TEXT NOT NULL DEFAULT '',
                PRIMARY KEY (work_date, print_num)
            )
            """
        )
        # 지난 날짜의 관리페이지 근무표(이름·시작·종료분만). 지난 날은 안 바뀌므로 저장해 두고 바로 쓴다.
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS lead_time_gwanri_cache (
                work_date TEXT PRIMARY KEY,
                ranges_json TEXT NOT NULL DEFAULT '[]',
                updated_at TEXT NOT NULL DEFAULT ''
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS lead_time_ship_assign (
                work_date TEXT NOT NULL,
                print_num TEXT NOT NULL,
                kind TEXT NOT NULL,
                PRIMARY KEY (work_date, print_num)
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS lead_time_pack_assign (
                work_date TEXT NOT NULL,
                sheet TEXT NOT NULL,
                PRIMARY KEY (work_date, sheet)
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS lead_time_unchecked_check (
                work_date TEXT NOT NULL,
                sheet TEXT NOT NULL,
                PRIMARY KEY (work_date, sheet)
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS lead_time_pack_exclude (
                work_date TEXT NOT NULL,
                sheet TEXT NOT NULL,
                PRIMARY KEY (work_date, sheet)
            )
            """
        )
        # 최초 1회만 기본 거래처를 넣는다 (사용자가 지운 뒤 다시 살아나지 않도록 테이블이 비어 있을 때만).
        if conn.execute("SELECT COUNT(*) AS n FROM lead_time_unchecked_suppliers").fetchone()["n"] == 0:
            for name in _DEFAULT_SUPPLIERS:
                conn.execute("INSERT OR IGNORE INTO lead_time_unchecked_suppliers (name) VALUES (?)", (name,))
        conn.commit()
    finally:
        conn.close()


def _slot_labels() -> list[str]:
    return [f"{m // 60:02d}:{m % 60:02d}" for m in range(_SLOT_START_MIN, _SLOT_END_MIN, _SLOT_STEP)]


def _to_min(value: str) -> int | None:
    try:
        h, m = (int(x) for x in str(value).split(":")[:2])
        return h * 60 + m
    except ValueError:
        return None


def classify_ship_orders(order_rows: list[dict]) -> dict:
    """한 출력차수의 주문을 합포 / 대량 / 개별로 나누고, 각 구분 안의 대형 상품 개수를 따로 센다.

    합포: 한 주문의 상품 수량 합이 2개 이상 (같은 코드 2개도 합포).
    대량: 합포를 뺀 단품 주문을 차수 안 순서대로 볼 때 같은 상품코드가 _BULK_RUN_MIN건 이상 연속.
    개별: 나머지 단품 주문 (상품 파싱이 안 된 주문 포함).
    대형: 상품명이 숫자로 시작하는 상품(_BIG_NAME_RE). 별도 구분이 아니라 대량/개별/합포 안에 그대로 들어가고,
          각 구분의 big_pieces(그중 대형 상품 개수)로 따로 표시한다 → 시간 계산에서 대형 처리 개수를 쓴다.
          "big"은 세 구분의 대형을 모은 합계(표시용)라 다른 구분과 겹친다.
    orders는 주문 건수, pieces는 상품 개수다.
    """
    combo_orders = combo_pieces = combo_big = combo_big_orders = big_orders = 0
    # 매칭작업 KRL: 상품명이 K·R·L로 시작하는 상품이 든 송장 수 (한 송장에 여러 글자가 있으면 글자별로는 각각, 합계는 1번만)
    krl = {"orders": 0, "K": 0, "R": 0, "L": 0}
    singles: list[tuple[str | None, bool, bool]] = []  # (상품코드, 대형 여부, K·R·L 상품 여부)
    for order in order_rows:
        cell = order.get("cell", {}) if isinstance(order, dict) else {}
        found = [
            (m.group(1).strip(), int(m.group(4)), bool(_BIG_NAME_RE.match(m.group(2).strip())))
            for m in _PRODUCT_RE.finditer(str(cell.get("products", "")))
        ]
        pieces = sum(q for _, q, _ in found)
        if any(big for _, _, big in found):
            big_orders += 1
        letters = {m.group(1) for m in (_KRL_NAME_RE.match(pm.group(2).strip()) for pm in _PRODUCT_RE.finditer(str(cell.get("products", "")))) if m}
        if letters:
            krl["orders"] += 1
            for c in letters:
                krl[c] += 1
        if pieces >= 2:
            combo_orders += 1
            combo_pieces += pieces
            combo_big += sum(q for _, q, big in found if big)
            combo_big_orders += 1 if any(big for _, _, big in found) else 0
        else:
            singles.append((found[0][0], found[0][2], bool(letters)) if found else (None, False, False))

    bulk = bulk_big = bulk_krl = 0
    i = 0
    while i < len(singles):
        j = i
        while j < len(singles) and singles[j][0] is not None and singles[j][0] == singles[i][0]:
            j += 1
        run = max(j - i, 1)
        if singles[i][0] is not None and run >= _BULK_RUN_MIN:
            bulk += run
            bulk_big += sum(1 for _, big, _ in singles[i:i + run] if big)
            bulk_krl += sum(1 for _, _, k in singles[i:i + run] if k)
        i += run
    single = len(singles) - bulk
    single_big = sum(1 for _, big, _ in singles if big) - bulk_big
    # K·R·L 상품 송장을 대량/개별 안에서 따로 센 값 (표시용, 대량·개별 개수에 그대로 포함)
    single_krl = sum(1 for _, _, k in singles if k) - bulk_krl
    return {
        "bulk": {"orders": bulk, "pieces": bulk, "big_pieces": bulk_big, "big_orders": bulk_big},
        "single": {"orders": single, "pieces": single, "big_pieces": single_big, "big_orders": single_big},
        "combo": {"orders": combo_orders, "pieces": combo_pieces, "big_pieces": combo_big, "big_orders": combo_big_orders},
        "big": {"orders": big_orders, "pieces": bulk_big + single_big + combo_big},
        "krl": krl,
        "krl_bulk": {"orders": bulk_krl, "pieces": bulk_krl},
        "krl_single": {"orders": single_krl, "pieces": single_krl},
    }


def build_lead_time_router(*, get_current_user, get_setting, get_db):
    router = APIRouter(prefix="/lead-time")

    def _now() -> datetime:
        return datetime.now(_KST).replace(tzinfo=None, microsecond=0)

    def _norm_date(value: str) -> str:
        try:
            return date_cls.fromisoformat(str(value).strip()).isoformat()
        except ValueError:
            raise HTTPException(status_code=400, detail="날짜 형식이 올바르지 않습니다.")

    async def _ez_post(form: dict, client: httpx.AsyncClient | None = None):
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
            cookies = {"PHPSESSID": phpsessid, **_EZ_EXTRA_COOKIES}
            if client is not None:
                res = await client.post(f"{_EZADMIN_BASE}/function.htm", headers=headers, cookies=cookies, data=form)
            else:
                async with httpx.AsyncClient(timeout=_EZ_TIMEOUT, verify=False, follow_redirects=True) as own:
                    res = await own.post(f"{_EZADMIN_BASE}/function.htm", headers=headers, cookies=cookies, data=form)
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"이지어드민 응답 오류: {type(e).__name__} {e}".strip())
        try:
            return res.json()
        except Exception:
            return False  # JSON이 아니면 세션 만료로 본다

    # ── 시간대별 인원 ──────────────────────────────────────
    _gwanri_cache: dict[str, tuple[float, list[tuple[str, int, int]]]] = {}

    def _gwanri_ranges(work_date: str, fresh: bool = False) -> list[tuple[str, int, int]]:
        """관리페이지 근무표(백)에서 그날 출근하는 사람들의 (이름, 시작분, 종료분) 목록을 가져온다.

        근무표 화면과 같은 규칙: 직원(고정요일 + 날짜별 수정, 공휴일은 휴무) + 그 주 주간 알바
        + 근무표에 이름이 없는 일일알바. 실패하면 예외를 던진다.
        """
        hit = _gwanri_cache.get(work_date)
        if hit and not fresh and time.monotonic() - hit[0] < _GWANRI_CACHE_SEC:
            return hit[1]
        is_past = work_date < datetime.now(_KST).date().isoformat()
        if is_past and not fresh:
            conn = get_db()
            try:
                row = conn.execute("SELECT ranges_json FROM lead_time_gwanri_cache WHERE work_date = ?", (work_date,)).fetchone()
            finally:
                conn.close()
            if row:
                ranges = [tuple(r) for r in json.loads(row["ranges_json"] or "[]")]
                _gwanri_cache[work_date] = (time.monotonic(), ranges)
                return ranges
        pin = os.environ.get("GWANRI_ATTENDANCE_PIN", "").strip()
        if not pin:
            raise RuntimeError("관리페이지 PIN이 설정되지 않았습니다")
        day = date_cls.fromisoformat(work_date)
        weekday = day.isoweekday()  # 근무표와 같은 1(월)~7(일)
        monday = (day - timedelta(days=weekday - 1)).isoformat()
        holiday = work_date in _GWANRI_HOLIDAYS
        try:
            with httpx.Client(timeout=_GWANRI_TIMEOUT, follow_redirects=True) as client:
                def _get(path: str, params: dict | None = None):
                    res = client.get(f"{_GWANRI_API_BASE}{path}", params=params)
                    res.raise_for_status()
                    return res.json()
                # 세 가지를 동시에 받는다 (차례로 받으면 약 5초, 동시에 받으면 약 2초).
                # 일일알바 응답엔 계좌 등 개인정보도 섞여 오지만 이름·시간만 쓰고 그 외는 저장하지 않는다.
                with ThreadPoolExecutor(max_workers=3) as pool:
                    f_members = pool.submit(_get, "/attendance/members")
                    f_schedule = pool.submit(_get, "/attendance/schedule", {"pin": pin, "date_from": monday, "date_to": work_date})
                    f_daily = pool.submit(_get, "/attendance/daily-workers", {"pin": pin, "date_from": work_date, "date_to": work_date})
                    members, schedule, daily = f_members.result(), f_schedule.result(), f_daily.result()
        except httpx.HTTPStatusError as e:
            raise RuntimeError(f"관리페이지 응답 오류 {e.response.status_code}") from e
        except httpx.HTTPError as e:
            raise RuntimeError(f"관리페이지 연결 실패 ({type(e).__name__})") from e

        best: dict[int, dict] = {}
        for r in schedule.get("fixedRules") or []:
            if r.get("weekday") != weekday or str(r.get("effectiveFrom") or "") > work_date:
                continue
            cur = best.get(r["memberId"])
            if cur is None or (r["effectiveFrom"], r["id"]) > (cur["effectiveFrom"], cur["id"]):
                best[r["memberId"]] = r
        overrides = {o["memberId"]: o for o in schedule.get("overrides") or [] if o.get("date") == work_date}

        shifts: list[tuple[str, str, str]] = []  # (이름, 시작, 종료)
        for m in members:
            if not m.get("includeInSchedule") or m.get("resigned") or (m.get("workArea") or "back") != "back":
                continue
            ov = overrides.get(m["id"])
            if ov is not None:
                shift = ov if ov.get("status") == "scheduled" else None
            else:
                rule = best.get(m["id"])
                shift = rule if rule is not None and rule.get("status") == "scheduled" and not holiday else None
            if shift:
                shifts.append((str(m.get("name") or "").strip(), shift["startTime"], shift["endTime"]))
        if not holiday:
            for w in schedule.get("tempWorkers") or []:
                if w.get("weekStart") == monday and w.get("workArea") == "back" and weekday in (w.get("weekdays") or []):
                    shifts.append((str(w.get("name") or "").strip(), w["startTime"], w["endTime"]))

        listed = {name for name, _, _ in shifts}
        for d in daily if isinstance(daily, list) else []:
            name = str(d.get("name") or "").strip()
            if d.get("date") != work_date or name in listed:
                continue  # 근무표에 이미 있는 사람은 중복으로 세지 않는다 (근무표 합계와 같은 규칙)
            start = d.get("startTime")
            ts = d.get("checkInTimestamp")
            if ts:  # 오전/오후는 실제 출근 시각 기준 (근무표 하단 일일알바 칸과 같은 기준)
                try:
                    start_hour = datetime.fromisoformat(str(ts).replace("Z", "+00:00")).astimezone(_KST).hour
                except ValueError:
                    start_hour = None
                if start_hour is not None and start_hour >= _AFTERNOON_START_MIN // 60:
                    continue
            shifts.append((name, start, d.get("endTime")))

        ranges: list[tuple[str, int, int]] = []
        for name, start, end in shifts:
            s, e = _to_min(start or ""), _to_min(end or "")
            if s is not None and e is not None and e > s and s < _AFTERNOON_START_MIN:
                ranges.append((name, s, e))
        _gwanri_cache[work_date] = (time.monotonic(), ranges)
        if is_past:  # 지난 날짜는 저장해 두고 다음부터 바로 쓴다 (이름·시작·종료분만 저장)
            conn = get_db()
            try:
                conn.execute(
                    "INSERT OR REPLACE INTO lead_time_gwanri_cache (work_date, ranges_json, updated_at) VALUES (?, ?, ?)",
                    (work_date, json.dumps(ranges, ensure_ascii=False), _now().isoformat()),
                )
                conn.commit()
            finally:
                conn.close()
        return ranges

    def _count_slots(ranges: list[tuple[str, int, int]]) -> tuple[dict[str, int], dict[str, int], dict[str, list[str]]]:
        """(표시용 인원, 계산용 인원, 시간대별 이름). 이름은 표시용 인원과 같은 기준(종료 시각 슬롯 포함)이다."""
        names = {label: [n for n, s, e in ranges if s <= _to_min(label) <= e] for label in _slot_labels()}
        shown = {label: len(v) for label, v in names.items()}
        calc = {label: sum(1 for _, s, e in ranges if s <= _to_min(label) < e) for label in _slot_labels()}
        return shown, calc, names

    def _scheduled_headcount(conn, work_date: str) -> tuple[dict[str, int], dict[str, int]]:
        """예전 방식: 이 서버에 남아 있는 근무표 복사본으로 계산한다. 관리페이지에 연결이 안 될 때만 쓴다.

        (표시용, 계산용)을 돌려준다. 표시용은 종료 시각 슬롯까지 포함하고(14:00까지 근무면 14:00 슬롯에도 표기),
        계산용은 종료 시각 슬롯을 뺀다 (14:00 이후 30분은 일하지 않으므로).
        """
        weekday = date_cls.fromisoformat(work_date).isoweekday()  # 스케줄관리와 같은 1(월)~7(일)
        try:
            members = [r["id"] for r in conn.execute(
                "SELECT id FROM attendance_members WHERE include_in_schedule = 1"
            ).fetchall()]
            fixed = conn.execute(
                "SELECT id, member_id, start_time, end_time, effective_from, status "
                "FROM attendance_schedule_fixed_rules WHERE weekday = ? AND effective_from <= ?",
                (weekday, work_date),
            ).fetchall()
            overrides = {r["member_id"]: r for r in conn.execute(
                "SELECT member_id, start_time, end_time, status FROM attendance_schedule_overrides WHERE date = ?",
                (work_date,),
            ).fetchall()}
        except Exception:
            zero = {s: 0 for s in _slot_labels()}
            return zero, dict(zero)

        best: dict[int, dict] = {}
        for r in fixed:
            cur = best.get(r["member_id"])
            if cur is None or (r["effective_from"], r["id"]) > (cur["effective_from"], cur["id"]):
                best[r["member_id"]] = r

        ranges: list[tuple[int, int]] = []
        for member_id in members:
            ov = overrides.get(member_id)
            if ov is not None:
                shift = ov if ov["status"] == "scheduled" else None
            else:
                rule = best.get(member_id)
                shift = rule if rule is not None and rule["status"] == "scheduled" else None
            if shift is None:
                continue
            s, e = _to_min(shift["start_time"]), _to_min(shift["end_time"])
            if s is not None and e is not None and e > s and s < _AFTERNOON_START_MIN:
                ranges.append(("", s, e))  # 예전 복사본은 이름을 보여주지 않는다
        return _count_slots(ranges)

    @router.get("/headcount")
    def get_headcount(date: str, fresh: bool = False, user: str = Depends(get_current_user)):
        work_date = _norm_date(date)
        schedule_error = None
        try:
            remote = _count_slots(_gwanri_ranges(work_date, fresh))
        except Exception as e:
            remote = None
            schedule_error = str(e) or type(e).__name__
        conn = get_db()
        try:
            scheduled, scheduled_calc, slot_names = remote if remote is not None else _scheduled_headcount(conn, work_date)
            legacy = {r["slot"]: r["headcount"] for r in conn.execute(
                "SELECT slot, headcount FROM lead_time_headcount WHERE work_date = ?", (work_date,)
            ).fetchall()}
            manual: dict[str, dict[str, int]] = {k: {} for k in _HEAD_KINDS}
            for r in conn.execute(
                "SELECT slot, kind, headcount FROM lead_time_headcount_kind WHERE work_date = ?", (work_date,)
            ).fetchall():
                if r["kind"] in manual:
                    manual[r["kind"]][r["slot"]] = r["headcount"]
        finally:
            conn.close()

        def _kind_cell(kind: str, s: str) -> dict:
            # 포장/출고 따로 입력한 값 > 예전(구분 없는) 입력값 > 스케줄 예정 인원. 처음엔 둘이 같은 값이다.
            m = manual[kind].get(s, legacy.get(s))
            return {"manual": m, "headcount": scheduled[s] if m is None else m,
                    "calc": scheduled_calc[s] if m is None else m}

        slots = [
            {"slot": s, "scheduled": scheduled[s], "names": [n for n in slot_names[s] if n],
             **{kind: _kind_cell(kind, s) for kind in _HEAD_KINDS}}
            for s in _slot_labels()
        ]
        return {"ok": True, "date": work_date, "slots": slots, "scheduleError": schedule_error}

    @router.put("/headcount")
    def put_headcount(payload: dict = Body(...), user: str = Depends(get_current_user)):
        """kind: "pack" | "ship". slots: {"09:00": 6, "09:30": null}. null이면 그 구분의 수동값을 지우고 스케줄 예정 인원으로 되돌린다."""
        work_date = _norm_date(payload.get("date", ""))
        kind = payload.get("kind")
        if kind not in _HEAD_KINDS:
            raise HTTPException(status_code=400, detail="포장/출고 구분이 필요합니다.")
        slots = payload.get("slots") or {}
        valid = set(_slot_labels())
        conn = get_db()
        try:
            for slot, value in slots.items():
                if slot not in valid:
                    raise HTTPException(status_code=400, detail=f"알 수 없는 시간대입니다: {slot}")
                n = None
                if value is not None and value != "":
                    try:
                        n = int(value)
                    except (TypeError, ValueError):
                        raise HTTPException(status_code=400, detail="인원은 숫자로 입력해 주세요.")
                    if n < 0:
                        raise HTTPException(status_code=400, detail="인원은 0 이상이어야 합니다.")
                # 구분 없이 저장돼 있던 예전 값은 포장·출고 양쪽으로 옮겨 두고, 지금 바꾸는 쪽만 덮어쓴다.
                legacy = conn.execute(
                    "SELECT headcount FROM lead_time_headcount WHERE work_date = ? AND slot = ?", (work_date, slot)
                ).fetchone()
                if legacy is not None:
                    for k in _HEAD_KINDS:
                        conn.execute(
                            "INSERT OR IGNORE INTO lead_time_headcount_kind (work_date, slot, kind, headcount) VALUES (?, ?, ?, ?)",
                            (work_date, slot, k, legacy["headcount"]),
                        )
                    conn.execute("DELETE FROM lead_time_headcount WHERE work_date = ? AND slot = ?", (work_date, slot))
                if n is None:
                    conn.execute(
                        "DELETE FROM lead_time_headcount_kind WHERE work_date = ? AND slot = ? AND kind = ?",
                        (work_date, slot, kind),
                    )
                    continue
                conn.execute(
                    "INSERT INTO lead_time_headcount_kind (work_date, slot, kind, headcount) VALUES (?, ?, ?, ?) "
                    "ON CONFLICT(work_date, slot, kind) DO UPDATE SET headcount=excluded.headcount",
                    (work_date, slot, kind, n),
                )
            conn.commit()
        finally:
            conn.close()
        return get_headcount(work_date, user)

    # ── 직접 입력한 처리량/개수 저장 ───────────────────────
    def _load_setting(conn, key: str) -> dict:
        row = conn.execute("SELECT data FROM lead_time_settings WHERE key = ?", (key,)).fetchone()
        try:
            data = json.loads(row["data"]) if row else {}
        except ValueError:
            data = {}
        return data if isinstance(data, dict) else {}

    def _save_setting(conn, key: str, data: dict) -> None:
        conn.execute(
            "INSERT INTO lead_time_settings (key, data) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET data=excluded.data",
            (key, json.dumps(data, ensure_ascii=False)),
        )

    def _settings_response(conn, work_date: str) -> dict:
        rates = _load_setting(conn, "_rates")
        qty = _load_setting(conn, work_date)
        return {
            "ok": True, "date": work_date,
            "rates": {k: rates.get(k) for k in _RATE_KINDS},
            "qty": {k: qty.get(k) for k in _QTY_KINDS},
            "options": {
                "join_bulk": bool(rates.get("join_bulk")),
                **{k: rates.get(k) for k in _COUNT_OPTIONS},
                **{k: rates.get(k) for k in _TIME_OPTIONS},
            },
        }

    @router.get("/settings")
    def get_settings(date: str, user: str = Depends(get_current_user)):
        work_date = _norm_date(date)
        conn = get_db()
        try:
            return _settings_response(conn, work_date)
        finally:
            conn.close()

    @router.put("/settings")
    def put_settings(payload: dict = Body(...), user: str = Depends(get_current_user)):
        """rates: {"pack": 2, "ship": 3} 1인 1분 처리 개수(공통). qty: {"pack": 500, "ship": null} 직접 입력한 개수(날짜별, null이면 불러온 수량으로 복귀).
        보낸 항목만 바꾼다."""
        work_date = _norm_date(payload.get("date", ""))
        rates_in = payload.get("rates") or {}
        qty_in = payload.get("qty") or {}
        options_in = payload.get("options") or {}
        conn = get_db()
        try:
            if rates_in or "join_bulk" in options_in or any(k in options_in for k in _COUNT_OPTIONS + _TIME_OPTIONS):
                rates = _load_setting(conn, "_rates")
                if "join_bulk" in options_in:  # 개별출고가 먼저 끝나면 그 인원이 대량출고에 합류할지 (공통 설정)
                    rates["join_bulk"] = bool(options_in["join_bulk"])
                for opt in _TIME_OPTIONS:  # 시작 시각 직접 지정. 비우면(null) 자동 시작
                    if opt not in options_in:
                        continue
                    value = options_in[opt]
                    if value is None or value == "":
                        rates.pop(opt, None)
                    elif isinstance(value, str) and _TIME_RE.match(value) and _to_min(value) is not None:
                        rates[opt] = value
                    else:
                        raise HTTPException(status_code=400, detail="시작 시각은 HH:MM 형식으로 입력해 주세요.")
                for opt in _COUNT_OPTIONS:  # 인원/분 설정. 비우면(null) 해제
                    if opt not in options_in:
                        continue
                    value = options_in[opt]
                    if value is None or value == "":
                        rates.pop(opt, None)
                        continue
                    try:
                        count = int(value)
                    except (TypeError, ValueError):
                        raise HTTPException(status_code=400, detail="인원은 숫자로 입력해 주세요.")
                    if count < 0:
                        raise HTTPException(status_code=400, detail="인원은 0 이상이어야 합니다.")
                    rates[opt] = count
                for k, v in rates_in.items():
                    if k not in _RATE_KINDS:
                        continue
                    try:
                        n = float(v)
                    except (TypeError, ValueError):
                        raise HTTPException(status_code=400, detail="처리 개수는 숫자로 입력해 주세요.")
                    if n <= 0:
                        raise HTTPException(status_code=400, detail="처리 개수는 0보다 커야 합니다.")
                    rates[k] = n
                _save_setting(conn, "_rates", rates)
            if qty_in:
                qty = _load_setting(conn, work_date)
                for k, v in qty_in.items():
                    if k not in _QTY_KINDS:
                        continue
                    if v is None or v == "":
                        qty.pop(k, None)
                        continue
                    try:
                        n = int(v)
                    except (TypeError, ValueError):
                        raise HTTPException(status_code=400, detail="개수는 숫자로 입력해 주세요.")
                    if n < 0:
                        raise HTTPException(status_code=400, detail="개수는 0 이상이어야 합니다.")
                    qty[k] = n
                _save_setting(conn, work_date, qty)
            conn.commit()
            return _settings_response(conn, work_date)
        finally:
            conn.close()

    # ── 미검수 거래처 ─────────────────────────────────────
    def _suppliers(conn) -> list[str]:
        return [r["name"] for r in conn.execute("SELECT name FROM lead_time_unchecked_suppliers ORDER BY name").fetchall()]

    @router.get("/suppliers")
    def list_suppliers(user: str = Depends(get_current_user)):
        conn = get_db()
        try:
            return {"ok": True, "suppliers": _suppliers(conn)}
        finally:
            conn.close()

    @router.post("/suppliers")
    def add_supplier(payload: dict = Body(...), user: str = Depends(get_current_user)):
        name = str(payload.get("name", "")).strip()
        if not name:
            raise HTTPException(status_code=400, detail="거래처 이름을 입력해 주세요.")
        conn = get_db()
        try:
            conn.execute("INSERT OR IGNORE INTO lead_time_unchecked_suppliers (name) VALUES (?)", (name,))
            conn.commit()
            return {"ok": True, "suppliers": _suppliers(conn)}
        finally:
            conn.close()

    @router.delete("/suppliers")
    def delete_supplier(name: str, user: str = Depends(get_current_user)):
        conn = get_db()
        try:
            conn.execute("DELETE FROM lead_time_unchecked_suppliers WHERE name = ?", (name.strip(),))
            conn.commit()
            return {"ok": True, "suppliers": _suppliers(conn)}
        finally:
            conn.close()

    # ── 저장된 스냅샷 ─────────────────────────────────────
    def _loads(raw: str):
        try:
            return json.loads(raw) if raw else None
        except ValueError:
            return None

    def _save_snapshot(conn, work_date: str, column: str, data: dict, user: str) -> None:
        conn.execute(
            f"INSERT INTO lead_time_snapshot (work_date, {column}, updated_by, updated_at) VALUES (?, ?, ?, ?) "
            f"ON CONFLICT(work_date) DO UPDATE SET {column}=excluded.{column}, "
            f"updated_by=excluded.updated_by, updated_at=excluded.updated_at",
            (work_date, json.dumps(data, ensure_ascii=False), user, _now().isoformat()),
        )

    @router.get("/snapshot")
    def get_snapshot(date: str, user: str = Depends(get_current_user)):
        work_date = _norm_date(date)
        conn = get_db()
        try:
            row = conn.execute("SELECT * FROM lead_time_snapshot WHERE work_date = ?", (work_date,)).fetchone()
        finally:
            conn.close()
        return {
            "ok": True, "date": work_date,
            "pack": _loads(row["pack_json"]) if row else None,
            "ship": _loads(row["ship_json"]) if row else None,
            "updated_at": row["updated_at"] if row else "",
        }

    # ── 포장: 입고요청 ────────────────────────────────────
    def _bulk_sheets(conn, work_date: str) -> set[str]:
        return {r["sheet"] for r in conn.execute(
            "SELECT sheet FROM lead_time_pack_assign WHERE work_date = ?", (work_date,)
        ).fetchall()}

    def _exclude_sheets(conn, work_date: str) -> set[str]:
        return {r["sheet"] for r in conn.execute(
            "SELECT sheet FROM lead_time_pack_exclude WHERE work_date = ?", (work_date,)
        ).fetchall()}

    def _check_sheets(conn, work_date: str) -> set[str]:
        return {r["sheet"] for r in conn.execute(
            "SELECT sheet FROM lead_time_unchecked_check WHERE work_date = ?", (work_date,)
        ).fetchall()}

    def _voucher_name(v: dict) -> str:
        cell = v["cell"]
        return str(cell.get("sheet_name") or cell.get("title") or cell.get("supply_name") or v["sheet"])

    @router.get("/pack/vouchers")
    async def pack_vouchers(date: str, user: str = Depends(get_current_user)):
        """그날의 입고요청 전표 목록과, 대량으로 지정해 둔 전표를 돌려준다."""
        work_date = _norm_date(date)
        try:
            vouchers = await fetch_im00_vouchers(get_setting, date=work_date)
        except EzAdminSessionExpired:
            return {"ok": False, "need_session": True}
        conn = get_db()
        try:
            bulk = _bulk_sheets(conn, work_date)
            check = _check_sheets(conn, work_date)
            exclude = _exclude_sheets(conn, work_date)
        finally:
            conn.close()
        return {
            "ok": True,
            "vouchers": [
                {"sheet": v["sheet"], "name": _voucher_name(v),
                 "qty": int(float(str(v["cell"].get("total_product_qty") or 0).replace(",", "") or 0))}
                for v in vouchers
            ],
            "bulk": sorted(bulk),
            "check": sorted(check),
            "exclude": sorted(exclude),
        }

    @router.put("/pack/assign")
    def pack_assign(payload: dict = Body(...), user: str = Depends(get_current_user)):
        """bulk: 대량으로 지정할 전표(sheet) 목록, check: 미검수 확인할 전표 목록, exclude: 불러오기에서 뺄 전표 목록.
        bulk에 없는 전표는 개별로 보고, check에 없는 전표는 미검수를 찾지 않는다."""
        work_date = _norm_date(payload.get("date", ""))
        bulk = {str(s).strip() for s in payload.get("bulk") or [] if str(s).strip()}
        check = {str(s).strip() for s in payload.get("check") or [] if str(s).strip()}
        exclude = {str(s).strip() for s in payload.get("exclude") or [] if str(s).strip()}
        conn = get_db()
        try:
            for table, sheets in (
                ("lead_time_pack_assign", bulk), ("lead_time_unchecked_check", check), ("lead_time_pack_exclude", exclude),
            ):
                conn.execute(f"DELETE FROM {table} WHERE work_date = ?", (work_date,))
                for s in sheets:
                    conn.execute(f"INSERT INTO {table} (work_date, sheet) VALUES (?, ?)", (work_date, s))
            conn.commit()
            return {"ok": True, "bulk": sorted(bulk), "check": sorted(check), "exclude": sorted(exclude)}
        finally:
            conn.close()

    @router.post("/pack/load")
    async def load_pack(payload: dict = Body(...), user: str = Depends(get_current_user)):
        """입고요청 전표를 불러와 대량/개별/대형/미검수로 나눈다.

        대량 = 사용자가 대량으로 지정한 전표, 개별 = 그 외.
        대형 = 대량·개별 전표 안에서 상품명이 숫자로 시작하는 품목. 대량/개별 수량에서 빼서 따로 센다 (겹치지 않음).
        미검수 = 전표 세부목록의 공급처상품명에 등록 거래처 이름이 들어간 품목 (포장 수량에서 빼고 개수만 표기).
        """
        work_date = _norm_date(payload.get("date", ""))
        conn = get_db()
        try:
            suppliers = _suppliers(conn)
            bulk_sheets = _bulk_sheets(conn, work_date)
            check_sheets = _check_sheets(conn, work_date)
            exclude_sheets = _exclude_sheets(conn, work_date)
        finally:
            conn.close()
        try:
            vouchers = [v for v in await fetch_im00_vouchers(get_setting, date=work_date) if v["sheet"] not in exclude_sheets]
            rows = []
            for v in vouchers:
                cell = v["cell"]
                name = _voucher_name(v)
                total = int(float(str(cell.get("req_qty") or cell.get("total_product_qty") or 0).replace(",", "") or 0))
                unchecked_by: dict[str, int] = {}
                if suppliers and total > 0 and v["sheet"] in check_sheets:
                    for item in await fetch_im00_line_items(get_setting, sheet=v["sheet"], date=work_date):
                        # 대소문자·공백 차이("KDG" vs "kdg ", "케이 디지")로 놓치지 않게 정규화해서 비교
                        norm_name = "".join(item["name"].split()).lower()
                        hit = next((s for s in suppliers if "".join(s.split()).lower() in norm_name), None)
                        if hit:
                            unchecked_by[hit] = unchecked_by.get(hit, 0) + item["qty"]
                # '미검수 확인'을 체크한 전표는 통째로 미검수로 본다 (대량/개별에는 포함하지 않음).
                is_checked = v["sheet"] in check_sheets
                if is_checked:
                    rest = total - sum(unchecked_by.values())
                    if rest > 0:
                        unchecked_by["기타"] = rest
                rows.append({
                    "sheet": v["sheet"], "name": name, "total": total,
                    "kind": "bulk" if v["sheet"] in bulk_sheets else "single",
                    "checked": is_checked,
                    "unchecked": sum(unchecked_by.values()), "unchecked_by": unchecked_by,
                })
            # 대형: 대량·개별 전표의 상세 화면에서 '상품명'이 숫자로 시작하는 상품을 골라낸다.
            # (다운로드 파일에는 상품명 칸이 없어 상세 화면을 전표마다 읽는다)
            big_by_kind = {"bulk": 0, "single": 0}
            big_items: dict[tuple[str, str], int] = {}
            for r in rows:
                if r["checked"] or r["total"] <= 0:
                    continue
                for item in await fetch_im10_product_rows(get_setting, sheet=r["sheet"]):
                    qty = item["req_qty"] if item["req_qty"] > 0 else item["in_qty"]
                    if qty <= 0 or not _BIG_NAME_RE.match(item["product_name"]):
                        continue
                    big_by_kind[r["kind"]] += qty
                    key = (item["product_name"], item["option"])
                    big_items[key] = big_items.get(key, 0) + qty
        except EzAdminSessionExpired:
            return {"ok": False, "need_session": True}
        except RuntimeError as e:
            raise HTTPException(status_code=502, detail=str(e))

        result: dict = {
            "bulk": {"qty": 0, "vouchers": []}, "single": {"qty": 0, "vouchers": []},
            "big": {"qty": 0, "items": [], "from_bulk": big_by_kind["bulk"], "from_single": big_by_kind["single"]},
            "unchecked": {"qty": 0, "by_supplier": {}},
        }
        for r in rows:
            if r["checked"]:
                result["unchecked"].setdefault("vouchers", []).append(r)
            else:
                group = result[r["kind"]]
                group["qty"] += max(r["total"] - r["unchecked"], 0)
                group["vouchers"].append(r)
            result["unchecked"]["qty"] += r["unchecked"]
            for s, q in r["unchecked_by"].items():
                result["unchecked"]["by_supplier"][s] = result["unchecked"]["by_supplier"].get(s, 0) + q
        for kind in ("bulk", "single"):
            moved = min(big_by_kind[kind], result[kind]["qty"])
            result[kind]["qty"] -= moved
            result["big"]["qty"] += moved
        result["big"]["items"] = [
            {"name": n, "option": o, "qty": q}
            for (n, o), q in sorted(big_items.items(), key=lambda kv: -kv[1])
        ]
        result["suppliers"] = suppliers

        conn = get_db()
        try:
            _save_snapshot(conn, work_date, "pack_json", result, user)
            conn.commit()
        finally:
            conn.close()
        return {"ok": True, "date": work_date, "pack": result}

    # ── 출고: 출력차수 ────────────────────────────────────
    def _assignments(conn, work_date: str) -> dict[str, str]:
        return {r["print_num"]: r["kind"] for r in conn.execute(
            "SELECT print_num, kind FROM lead_time_ship_assign WHERE work_date = ?", (work_date,)
        ).fetchall()}

    @router.get("/ship/numbers")
    async def ship_numbers(date: str, user: str = Depends(get_current_user)):
        """그날의 출력차수 목록과, 저장해 둔 본송장/재고송장 지정을 함께 돌려준다."""
        work_date = _norm_date(date)
        listing = await _ez_post({"template": "S700", "action": "get_number_list", "par": f"date1={work_date}"})
        if listing is None or listing is False:
            return {"ok": False, "need_session": True}
        items = listing if isinstance(listing, list) else next(
            (v for v in listing.values() if isinstance(v, list)), []
        ) if isinstance(listing, dict) else []
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
        conn = get_db()
        try:
            assigned = _assignments(conn, work_date)
        finally:
            conn.close()
        return {"ok": True, "numbers": numbers, "assigned": assigned}

    @router.put("/ship/assign")
    def ship_assign(payload: dict = Body(...), user: str = Depends(get_current_user)):
        """main / stock: 각각 출력차수 번호 목록. 두 목록에 없는 차수는 지정 해제된다."""
        work_date = _norm_date(payload.get("date", ""))
        rows = []
        for kind in ("main", "stock"):
            for n in payload.get(kind) or []:
                n = str(n).strip()
                if n.isdigit():
                    rows.append((n, kind))
        if len({n for n, _ in rows}) != len(rows):
            raise HTTPException(status_code=400, detail="같은 출력차수를 본송장과 재고송장에 동시에 지정할 수 없습니다.")
        conn = get_db()
        try:
            conn.execute("DELETE FROM lead_time_ship_assign WHERE work_date = ?", (work_date,))
            for n, kind in rows:
                conn.execute(
                    "INSERT INTO lead_time_ship_assign (work_date, print_num, kind) VALUES (?, ?, ?)",
                    (work_date, n, kind),
                )
            conn.commit()
            return {"ok": True, "assigned": _assignments(conn, work_date)}
        finally:
            conn.close()

    @router.post("/ship/load")
    async def load_ship(payload: dict = Body(...), user: str = Depends(get_current_user)):
        """그날의 출력차수 전체를 조회해 본송장/재고송장 x 대량/개별/합포로 나눈다.

        이미 읽어 둔 차수는 저장된 결과를 쓰고, 새 차수만 이지어드민에서 읽는다 (차수당 약 25초).
        payload.fresh가 참이면 저장된 결과를 무시하고 전부 다시 읽는다.
        """
        work_date = _norm_date(payload.get("date", ""))
        fresh = bool(payload.get("fresh"))
        conn = get_db()
        try:
            assigned = _assignments(conn, work_date)
            cached = {} if fresh else {
                r["print_num"]: (int(r["total"]), json.loads(r["counts_json"] or "{}"))
                for r in conn.execute(
                    "SELECT print_num, total, counts_json FROM lead_time_ship_cache WHERE work_date = ? AND version = ?",
                    (work_date, _SHIP_CLASSIFY_VERSION),
                ).fetchall()
            }
        finally:
            conn.close()
        if not assigned:
            raise HTTPException(status_code=400, detail="본송장/재고송장으로 지정한 출력차수가 없습니다. 먼저 출력차수를 지정해 저장해 주세요.")

        d = date_cls.fromisoformat(work_date)
        weekday_kr = ["월", "화", "수", "목", "금", "토", "일"][d.weekday()]
        empty = lambda: {k: {} for k in ("bulk", "single", "combo", "big", "krl")}
        totals = {"main": empty(), "stock": empty()}
        per_number = []
        sample_keys: list[str] = []
        nums = sorted(assigned, key=int)
        # 이지어드민은 한 세션의 요청을 하나씩 처리하므로(동시에 보내도 차례로 처리됨) 차수마다 차례로 읽고,
        # 읽자마자 저장한다 → 중간에 세션이 끊겨도 이미 읽은 차수는 다음에 다시 읽지 않는다.
        to_fetch = [n for n in nums if n not in cached]
        fetched_counts: dict[str, tuple[int, dict]] = {}
        if to_fetch:
            async with httpx.AsyncClient(timeout=_EZ_TIMEOUT, verify=False, follow_redirects=True) as client:
                for num in to_fetch:
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
                    }, client)
                    if result is None or result is False:
                        return {"ok": False, "need_session": True}
                    rows = result.get("rows", []) if isinstance(result, dict) else []
                    if rows and not sample_keys:
                        sample_keys = sorted((rows[0].get("cell") or {}).keys())
                    total, counts = len(rows), classify_ship_orders(rows)
                    fetched_counts[num] = (total, counts)
                    conn = get_db()
                    try:
                        conn.execute(
                            "INSERT OR REPLACE INTO lead_time_ship_cache (work_date, print_num, version, total, counts_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
                            (work_date, num, _SHIP_CLASSIFY_VERSION, total, json.dumps(counts), _now().isoformat()),
                        )
                        conn.commit()
                    finally:
                        conn.close()

        for num in nums:
            total, counts = fetched_counts.get(num) or cached[num]
            kind = assigned[num]
            for cat, fields in counts.items():
                for field, n in fields.items():
                    totals[kind].setdefault(cat, {})[field] = totals[kind].get(cat, {}).get(field, 0) + n
            per_number.append({"print_num": num, "kind": kind, "total": total, **counts})

        data = {"totals": totals, "per_number": per_number, "sample_cell_keys": sample_keys,
                "fetched": to_fetch, "reused": [n for n in nums if n not in fetched_counts]}
        conn = get_db()
        try:
            _save_snapshot(conn, work_date, "ship_json", data, user)
            conn.commit()
        finally:
            conn.close()
        return {"ok": True, "date": work_date, "ship": data}

    return router
