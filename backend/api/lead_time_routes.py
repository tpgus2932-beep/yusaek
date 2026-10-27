from __future__ import annotations

import json
import re
from datetime import date as date_cls, datetime, timedelta
from zoneinfo import ZoneInfo

import httpx
from fastapi import APIRouter, Body, Depends, HTTPException

from sdk.ezadmin import EzAdminSessionExpired
from services.ezadmin_im00_client import fetch_im00_line_items, fetch_im00_vouchers

_EZADMIN_BASE = "https://ga80.ezadmin.co.kr"
_EZADMIN_SESSION_KEY = "ezadmin_phpsessid"
# S700은 PHPSESSID만으로는 응답하지 않아 로그인 도메인/아이디 쿠키가 같이 필요하다 (shipping_eta_routes와 동일).
_EZ_EXTRA_COOKIES = {"ezdomain": "yusaek", "ezuserid": "yusaek", "ezsave": "on"}
_EZ_TIMEOUT = 300.0
_KST = ZoneInfo("Asia/Seoul")
_NUMBER_TITLE_RE = re.compile(r"\[\s*(\d+)\s*\]\s*\((\d{2}:\d{2}:\d{2})\)\s*개수\s*:\s*(\d+)")
_PRODUCT_RE = re.compile(r"\[([A-Z]\d+)\](.*?)(?:-\[([^\]]*)\])?\s+(\d+)개")
_BULK_RUN_MIN = 10  # 같은 상품코드 단품 주문이 연속 이 개수 이상이면 대량
_DEFAULT_SUPPLIERS = ("케이디지", "리자드스탠다드")
_SLOT_START_MIN = 9 * 60
_SLOT_END_MIN = 22 * 60
_SLOT_STEP = 30


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
    """한 출력차수의 주문을 합포 / 대량 / 개별로 나눈다.

    합포: 한 주문의 상품 수량 합이 2개 이상 (같은 코드 2개도 합포).
    대량: 합포를 뺀 단품 주문을 차수 안 순서대로 볼 때 같은 상품코드가 _BULK_RUN_MIN건 이상 연속.
    개별: 나머지 단품 주문 (상품 파싱이 안 된 주문 포함).
    orders는 주문 건수, pieces는 상품 개수다.
    """
    combo_orders = combo_pieces = 0
    singles: list[str | None] = []
    for order in order_rows:
        cell = order.get("cell", {}) if isinstance(order, dict) else {}
        found = [(m.group(1).strip(), int(m.group(4))) for m in _PRODUCT_RE.finditer(str(cell.get("products", "")))]
        pieces = sum(q for _, q in found)
        if pieces >= 2:
            combo_orders += 1
            combo_pieces += pieces
        else:
            singles.append(found[0][0] if found else None)

    bulk = 0
    i = 0
    while i < len(singles):
        j = i
        while j < len(singles) and singles[j] is not None and singles[j] == singles[i]:
            j += 1
        run = max(j - i, 1)
        if singles[i] is not None and run >= _BULK_RUN_MIN:
            bulk += run
        i += run
    return {
        "bulk": {"orders": bulk, "pieces": bulk},
        "single": {"orders": len(singles) - bulk, "pieces": len(singles) - bulk},
        "combo": {"orders": combo_orders, "pieces": combo_pieces},
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

    # ── 시간대별 인원 ──────────────────────────────────────
    def _scheduled_headcount(conn, work_date: str) -> tuple[dict[str, int], dict[str, int]]:
        """스케줄관리(고정요일·시간 + 날짜별 예외)로 30분 슬롯별 예정 인원을 구한다.

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
            if s is not None and e is not None and e > s:
                ranges.append((s, e))
        shown = {label: sum(1 for s, e in ranges if s <= _to_min(label) <= e) for label in _slot_labels()}
        calc = {label: sum(1 for s, e in ranges if s <= _to_min(label) < e) for label in _slot_labels()}
        return shown, calc

    @router.get("/headcount")
    def get_headcount(date: str, user: str = Depends(get_current_user)):
        work_date = _norm_date(date)
        conn = get_db()
        try:
            scheduled, scheduled_calc = _scheduled_headcount(conn, work_date)
            manual = {r["slot"]: r["headcount"] for r in conn.execute(
                "SELECT slot, headcount FROM lead_time_headcount WHERE work_date = ?", (work_date,)
            ).fetchall()}
        finally:
            conn.close()
        slots = [
            {"slot": s, "scheduled": scheduled[s], "manual": manual.get(s),
             "headcount": manual.get(s, scheduled[s]),
             "calc": manual.get(s, scheduled_calc[s])}
            for s in _slot_labels()
        ]
        return {"ok": True, "date": work_date, "slots": slots}

    @router.put("/headcount")
    def put_headcount(payload: dict = Body(...), user: str = Depends(get_current_user)):
        """slots: {"09:00": 6, "09:30": null}. null이면 수동값을 지우고 스케줄 예정 인원으로 되돌린다."""
        work_date = _norm_date(payload.get("date", ""))
        slots = payload.get("slots") or {}
        valid = set(_slot_labels())
        conn = get_db()
        try:
            for slot, value in slots.items():
                if slot not in valid:
                    raise HTTPException(status_code=400, detail=f"알 수 없는 시간대입니다: {slot}")
                if value is None or value == "":
                    conn.execute("DELETE FROM lead_time_headcount WHERE work_date = ? AND slot = ?", (work_date, slot))
                    continue
                try:
                    n = int(value)
                except (TypeError, ValueError):
                    raise HTTPException(status_code=400, detail="인원은 숫자로 입력해 주세요.")
                if n < 0:
                    raise HTTPException(status_code=400, detail="인원은 0 이상이어야 합니다.")
                conn.execute(
                    "INSERT INTO lead_time_headcount (work_date, slot, headcount) VALUES (?, ?, ?) "
                    "ON CONFLICT(work_date, slot) DO UPDATE SET headcount=excluded.headcount",
                    (work_date, slot, n),
                )
            conn.commit()
        finally:
            conn.close()
        return get_headcount(work_date, user)

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
        }

    @router.put("/pack/assign")
    def pack_assign(payload: dict = Body(...), user: str = Depends(get_current_user)):
        """bulk: 대량으로 지정할 전표(sheet) 목록, check: 미검수 확인할 전표 목록.
        bulk에 없는 전표는 개별로 보고, check에 없는 전표는 미검수를 찾지 않는다."""
        work_date = _norm_date(payload.get("date", ""))
        bulk = {str(s).strip() for s in payload.get("bulk") or [] if str(s).strip()}
        check = {str(s).strip() for s in payload.get("check") or [] if str(s).strip()}
        conn = get_db()
        try:
            for table, sheets in (("lead_time_pack_assign", bulk), ("lead_time_unchecked_check", check)):
                conn.execute(f"DELETE FROM {table} WHERE work_date = ?", (work_date,))
                for s in sheets:
                    conn.execute(f"INSERT INTO {table} (work_date, sheet) VALUES (?, ?)", (work_date, s))
            conn.commit()
            return {"ok": True, "bulk": sorted(bulk), "check": sorted(check)}
        finally:
            conn.close()

    @router.post("/pack/load")
    async def load_pack(payload: dict = Body(...), user: str = Depends(get_current_user)):
        """입고요청 전표를 불러와 대량/개별/미검수로 나눈다.

        대량 = 사용자가 대량으로 지정한 전표, 개별 = 그 외.
        미검수 = 전표 세부목록의 공급처상품명에 등록 거래처 이름이 들어간 품목 (포장 수량에서 빼고 개수만 표기).
        """
        work_date = _norm_date(payload.get("date", ""))
        conn = get_db()
        try:
            suppliers = _suppliers(conn)
            bulk_sheets = _bulk_sheets(conn, work_date)
            check_sheets = _check_sheets(conn, work_date)
        finally:
            conn.close()
        try:
            vouchers = await fetch_im00_vouchers(get_setting, date=work_date)
            rows = []
            for v in vouchers:
                cell = v["cell"]
                name = _voucher_name(v)
                total = int(float(str(cell.get("req_qty") or cell.get("total_product_qty") or 0).replace(",", "") or 0))
                unchecked_by: dict[str, int] = {}
                if suppliers and total > 0 and v["sheet"] in check_sheets:
                    for item in await fetch_im00_line_items(get_setting, sheet=v["sheet"], date=work_date):
                        hit = next((s for s in suppliers if s in item["name"]), None)
                        if hit:
                            unchecked_by[hit] = unchecked_by.get(hit, 0) + item["qty"]
                rows.append({
                    "sheet": v["sheet"], "name": name, "total": total,
                    "kind": "bulk" if v["sheet"] in bulk_sheets else "single",
                    "unchecked": sum(unchecked_by.values()), "unchecked_by": unchecked_by,
                })
        except EzAdminSessionExpired:
            return {"ok": False, "need_session": True}
        except RuntimeError as e:
            raise HTTPException(status_code=502, detail=str(e))

        result: dict = {
            "bulk": {"qty": 0, "vouchers": []}, "single": {"qty": 0, "vouchers": []},
            "unchecked": {"qty": 0, "by_supplier": {}},
        }
        for r in rows:
            group = result[r["kind"]]
            group["qty"] += max(r["total"] - r["unchecked"], 0)
            group["vouchers"].append(r)
            result["unchecked"]["qty"] += r["unchecked"]
            for s, q in r["unchecked_by"].items():
                result["unchecked"]["by_supplier"][s] = result["unchecked"]["by_supplier"].get(s, 0) + q
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
        """그날의 출력차수 전체를 조회해 본송장/재고송장 x 대량/개별/합포로 나눈다."""
        work_date = _norm_date(payload.get("date", ""))
        conn = get_db()
        try:
            assigned = _assignments(conn, work_date)
        finally:
            conn.close()
        if not assigned:
            raise HTTPException(status_code=400, detail="본송장/재고송장으로 지정한 출력차수가 없습니다. 먼저 출력차수를 지정해 저장해 주세요.")

        d = date_cls.fromisoformat(work_date)
        weekday_kr = ["월", "화", "수", "목", "금", "토", "일"][d.weekday()]
        empty = lambda: {"bulk": {"orders": 0, "pieces": 0}, "single": {"orders": 0, "pieces": 0}, "combo": {"orders": 0, "pieces": 0}}
        totals = {"main": empty(), "stock": empty()}
        per_number = []
        sample_keys: list[str] = []
        for num in sorted(assigned, key=int):
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
            rows = result.get("rows", []) if isinstance(result, dict) else []
            if rows and not sample_keys:
                sample_keys = sorted((rows[0].get("cell") or {}).keys())
            kind = assigned[num]
            counts = classify_ship_orders(rows)
            for cat in counts:
                for field in ("orders", "pieces"):
                    totals[kind][cat][field] += counts[cat][field]
            per_number.append({"print_num": num, "kind": kind, "total": len(rows), **counts})

        data = {"totals": totals, "per_number": per_number, "sample_cell_keys": sample_keys}
        conn = get_db()
        try:
            _save_snapshot(conn, work_date, "ship_json", data, user)
            conn.commit()
        finally:
            conn.close()
        return {"ok": True, "date": work_date, "ship": data}

    return router
