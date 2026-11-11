from __future__ import annotations

import asyncio
import re
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

import httpx
from fastapi import APIRouter, Body, Depends, HTTPException

from sdk.ezadmin import EzAdminClient, EzAdminSessionExpired
from services.ezadmin_stock_log import fetch_ezadmin_stock_logs
from services import normalization_log
from api.inventory_dashboard_routes import _input_value, _strip_html, _to_int
from api.wonbe_routes import _get_wonbe_db, load_wonbe_rename_prefix_map

_EZADMIN_BASE = "https://ga80.ezadmin.co.kr"
_EZADMIN_SESSION_KEY = "ezadmin_phpsessid"
_KST = timezone(timedelta(hours=9))
_PAGE_ROWS = 100
_ZONE_RE = re.compile(r"^[A-Z]{2}$")
_OTHER_ZONE = "기타"


def _build_par(today: str, zone: str) -> str:
    # 이지어드민 재고(I100) 검색: 상품명에 zone 포함 + 재고 1개 이상.
    return (
        "auto_search=&search_all_product=&multi_supply_group=&multi_supply=&str_supply_code=0"
        f"&tags_string=&product_tag_include_type=1&query_type=name&query_str={quote(zone)}"
        "&stock_type=0&stock_start=1&stock_end=&notrans_day=&notrans_cnt=&notrans_status=0&stock_status=0"
        f"&start_date={today}&start_hour=00%3A00%3A00&end_date={today}&end_hour=23%3A59%3A59"
        "&date_period_sel=1&work_type=stockin&work_start=&work_end=&inout_type=0&product_date="
        f"&start_date2={today}&end_date2={today}&date_period_sel2=1"
        "&products_sort=1&category=0&except_soldout=0&temp_soldout=0&location=0"
    )


def build_stock_check_router(*, get_current_user, get_setting, normalize_code, get_shared_db, get_local_db=None):
    router = APIRouter(prefix="/stock-check", tags=["stock-check"])
    # 스캔 저장은 Turso가 아니라 로컬 SQLite를 쓴다 (악성재고 조회만 기존처럼 shared DB).
    get_scan_db = get_local_db or get_shared_db

    def _load_bad_stock_codes() -> set[str]:
        """바코드 사이드메뉴 악성재고에 올라있는 상품코드(S00000 형식) 집합."""
        codes: set[str] = set()
        try:
            conn = get_shared_db()
        except Exception:
            return codes
        try:
            for r in conn.execute("SELECT code FROM barcode_bad_stock").fetchall():
                raw = str(r[0] or "").strip()
                code = normalize_code(raw) or raw.upper()
                if code:
                    codes.add(code)
        except Exception:
            pass  # 악성재고 테이블이 아직 없으면 제외할 상품도 없다.
        finally:
            conn.close()
        return codes

    # ── 계정별 스캔 저장 (폰에서 찍은 내용을 PC에서도 볼 수 있게 서버 DB에 저장) ──────────────
    def _ensure_scan_table(conn):
        conn.execute(
            """CREATE TABLE IF NOT EXISTS stock_check_scans (
                username TEXT NOT NULL, zone TEXT NOT NULL, code TEXT NOT NULL,
                qty INTEGER NOT NULL DEFAULT 0, name TEXT DEFAULT '', option TEXT DEFAULT '',
                PRIMARY KEY (username, zone, code))"""
        )

    def _read_state(conn, user: str) -> dict:
        rows = conn.execute(
            "SELECT zone, code, qty, name, option FROM stock_check_scans WHERE username = ? AND qty > 0", (user,)
        ).fetchall()
        scans: dict[str, dict[str, int]] = {}
        info: dict[str, dict] = {}
        for r in rows:
            zone, code, qty, name, option = r[0], r[1], int(r[2] or 0), r[3] or "", r[4] or ""
            scans.setdefault(zone, {})[code] = qty
            info[code] = {"name": name, "option": option}
        return {"scans": scans, "info": info}

    @router.get("/state")
    def get_state(user: str = Depends(get_current_user)):
        conn = get_scan_db()
        try:
            _ensure_scan_table(conn)
            return {"ok": True, **_read_state(conn, user)}
        finally:
            conn.close()

    @router.post("/reset-zone")
    def reset_zone(payload: dict = Body(...), user: str = Depends(get_current_user)):
        zone = str(payload.get("zone") or "").strip()
        if not zone:
            raise HTTPException(status_code=400, detail="구역이 필요합니다.")
        conn = get_scan_db()
        try:
            _ensure_scan_table(conn)
            conn.execute("DELETE FROM stock_check_scans WHERE username = ? AND zone = ?", (user, zone))
            conn.commit()
            return {"ok": True}
        finally:
            conn.close()

    @router.post("/reset-all")
    def reset_all(user: str = Depends(get_current_user)):
        """이 계정의 모든 구역 스캔 기록을 지운다."""
        conn = get_scan_db()
        try:
            _ensure_scan_table(conn)
            conn.execute("DELETE FROM stock_check_scans WHERE username = ?", (user,))
            conn.commit()
            return {"ok": True}
        finally:
            conn.close()

    @router.post("/move")
    def move_scans(payload: dict = Body(...), user: str = Depends(get_current_user)):
        """한 구역의 스캔을 다른 구역으로 옮긴다 (예: 기타 → AD). 도착 구역에 같은 상품이 있으면 수량을 합친다."""
        from_zone = str(payload.get("from_zone") or "").strip()
        to_zone = str(payload.get("to_zone") or "").strip().upper()
        codes = [str(c).strip() for c in (payload.get("codes") or []) if str(c).strip()]
        if not from_zone or not codes:
            raise HTTPException(status_code=400, detail="옮길 구역과 상품을 선택하세요.")
        if not (_ZONE_RE.match(to_zone) or to_zone == _OTHER_ZONE):
            raise HTTPException(status_code=400, detail="이동할 구역은 영문 대문자 2글자(예: AD)여야 합니다.")
        if to_zone == from_zone:
            raise HTTPException(status_code=400, detail="같은 구역으로는 옮길 수 없습니다.")
        conn = get_scan_db()
        try:
            _ensure_scan_table(conn)
            moved = 0
            for code in codes:
                row = conn.execute(
                    "SELECT qty, name, option FROM stock_check_scans WHERE username = ? AND zone = ? AND code = ?", (user, from_zone, code)
                ).fetchone()
                if not row:
                    continue
                conn.execute(
                    "INSERT INTO stock_check_scans (username, zone, code, qty, name, option) VALUES (?, ?, ?, ?, ?, ?) "
                    "ON CONFLICT(username, zone, code) DO UPDATE SET qty = qty + excluded.qty",
                    (user, to_zone, code, int(row[0] or 0), row[1] or "", row[2] or ""),
                )
                conn.execute("DELETE FROM stock_check_scans WHERE username = ? AND zone = ? AND code = ?", (user, from_zone, code))
                moved += 1
            conn.commit()
            return {"ok": True, "moved": moved, **_read_state(conn, user)}
        finally:
            conn.close()

    @router.post("/set-scan")
    def set_scan(payload: dict = Body(...), user: str = Depends(get_current_user)):
        """스캔 정상화: 실물을 다시 확인해 스캔을 놓친 것으로 밝혀진 상품의 스캔 수량을 지정한 값으로 맞춘다.
        이지어드민 재고는 건드리지 않고, 내역은 정상화 이력에 type=scan(스캔보정)으로 남긴다."""
        items = payload.get("items") or []
        if not isinstance(items, list) or not items:
            raise HTTPException(status_code=400, detail="보정할 상품을 선택하세요.")
        conn = get_scan_db()
        try:
            _ensure_scan_table(conn)
            logs = []
            for it in items:
                zone = str(it.get("zone") or "").strip()
                code = str(it.get("code") or "").strip()
                try:
                    qty = int(float(it.get("qty")))
                except (TypeError, ValueError):
                    raise HTTPException(status_code=400, detail=f"{code}: 수량이 올바르지 않습니다.")
                if not zone or not code or qty < 1 or qty > 99999:
                    raise HTTPException(status_code=400, detail=f"{code}: 구역/수량이 올바르지 않습니다.")
                row = conn.execute(
                    "SELECT qty, name, option FROM stock_check_scans WHERE username = ? AND zone = ? AND code = ?", (user, zone, code)
                ).fetchone()
                prev = int(row[0] or 0) if row else 0
                name = str(it.get("name") or "") or (row[1] if row else "") or ""
                option = str(it.get("option") or "") or (row[2] if row else "") or ""
                conn.execute(
                    "INSERT INTO stock_check_scans (username, zone, code, qty, name, option) VALUES (?, ?, ?, ?, ?, ?) "
                    "ON CONFLICT(username, zone, code) DO UPDATE SET qty = excluded.qty, name = excluded.name, option = excluded.option",
                    (user, zone, code, qty, name, option),
                )
                logs.append({"zone": zone, "code": code, "name": name, "option": option, "type": "scan",
                             "qty": qty - prev, "scan_qty": prev, "system_qty": int(it.get("system_qty") or 0)})
            conn.commit()
            state = _read_state(conn, user)
        finally:
            conn.close()
        _log_normalized(user, logs)
        return {"ok": True, "fixed": len(logs), **state}

    @router.post("/last-in")
    async def last_in(payload: dict = Body(...), user: str = Depends(get_current_user)):
        """상품코드별 마지막 입고일. 이지어드민 재고내역에서 구분이 '입고'인 가장 최근 일자를 최근 30일 안에서 찾는다(없으면 빈 값).
        (재고체크 정상화로 넣은 입고는 실제 입고가 아니라서 제외) 결과는 하루 동안 로컬에 캐시한다."""
        codes = [c for c in dict.fromkeys(str(c).strip().upper() for c in (payload.get("codes") or [])) if c][:200]
        if not codes:
            return {"ok": True, "last_in": {}}
        phpsessid = (get_setting(_EZADMIN_SESSION_KEY) or "").strip()
        if not phpsessid:
            return {"ok": False, "need_session": True}
        today = datetime.now(_KST).strftime("%Y-%m-%d")
        start = (datetime.now(_KST) - timedelta(days=30)).strftime("%Y-%m-%d")  # 30일 안에 입고가 없으면 빈칸(= 한 달 이상)
        result: dict[str, str] = {}
        conn = get_scan_db()
        try:
            conn.execute("CREATE TABLE IF NOT EXISTS stock_check_last_in (code TEXT PRIMARY KEY, last_in TEXT, checked_day TEXT)")
            marks = ",".join("?" * len(codes))
            for r in conn.execute(f"SELECT code, last_in FROM stock_check_last_in WHERE checked_day = ? AND code IN ({marks})", (today, *codes)).fetchall():
                result[r[0]] = (r[1] or "") if (r[1] or "") >= start else ""  # 예전 캐시에 30일보다 오래된 날짜가 있으면 빈칸 처리
        finally:
            conn.close()
        missing = [c for c in codes if c not in result]
        no_response: list[str] = []
        sem = asyncio.Semaphore(6)

        async def one(code: str):
            async with sem:
                try:
                    logs = await fetch_ezadmin_stock_logs(phpsessid, code, start, today)
                except Exception:
                    return  # 이 상품만 건너뛰고(빈칸) 나머지는 계속한다
            if logs is None:
                no_response.append(code)  # 세션 만료이거나 재고내역이 없는 상품
                return
            best = ""
            for l in logs:
                if l.get("구분") == "입고" and l.get("상태") == "정상" and not str(l.get("사유") or "").startswith("재고체크 정상화"):
                    best = max(best, str(l.get("일시") or "")[:10])
            result[code] = best

        await asyncio.gather(*(one(c) for c in missing))
        if missing and len(no_response) == len(missing):
            return {"ok": False, "need_session": True}  # 전부 응답이 없으면 세션 만료로 본다
        for c in no_response:
            result[c] = ""  # 일부만 응답이 없으면 그 상품만 빈칸 (캐시하지 않아 다음에 다시 시도)
        fetched = [c for c in missing if c in result and c not in no_response]
        if fetched:
            conn = get_scan_db()
            try:
                for c in fetched:
                    conn.execute(
                        "INSERT INTO stock_check_last_in (code, last_in, checked_day) VALUES (?, ?, ?) "
                        "ON CONFLICT(code) DO UPDATE SET last_in = excluded.last_in, checked_day = excluded.checked_day",
                        (c, result[c], today),
                    )
                conn.commit()
            finally:
                conn.close()
        return {"ok": True, "last_in": result}

    @router.post("/remove-code")
    def remove_code(payload: dict = Body(...), user: str = Depends(get_current_user)):
        zone = str(payload.get("zone") or "").strip()
        code = str(payload.get("code") or "").strip()
        if not zone or not code:
            raise HTTPException(status_code=400, detail="구역과 상품코드가 필요합니다.")
        conn = get_scan_db()
        try:
            _ensure_scan_table(conn)
            conn.execute("DELETE FROM stock_check_scans WHERE username = ? AND zone = ? AND code = ?", (user, zone, code))
            conn.commit()
            return {"ok": True}
        finally:
            conn.close()

    @router.post("/import")
    def import_local(payload: dict = Body(...), user: str = Depends(get_current_user)):
        """이 계정에 저장된 스캔이 없을 때만, 예전에 브라우저(localStorage)에 있던 스캔을 한 번 올린다."""
        scans = payload.get("scans") or {}
        info = payload.get("info") or {}
        conn = get_scan_db()
        try:
            _ensure_scan_table(conn)
            has = conn.execute("SELECT 1 FROM stock_check_scans WHERE username = ? LIMIT 1", (user,)).fetchone()
            if not has and isinstance(scans, dict):
                for zone, codes in scans.items():
                    if not isinstance(codes, dict):
                        continue
                    for code, qty in codes.items():
                        try:
                            q = int(qty)
                        except (TypeError, ValueError):
                            continue
                        if q < 1:
                            continue
                        meta = info.get(code) if isinstance(info, dict) else None
                        meta = meta if isinstance(meta, dict) else {}
                        conn.execute(
                            "INSERT INTO stock_check_scans (username, zone, code, qty, name, option) VALUES (?, ?, ?, ?, ?, ?) "
                            "ON CONFLICT(username, zone, code) DO UPDATE SET qty = excluded.qty",
                            (user, str(zone), str(code), q, str(meta.get("name") or ""), str(meta.get("option") or "")),
                        )
                conn.commit()
            return {"ok": True, **_read_state(conn, user)}
        finally:
            conn.close()

    # ── 일별 스냅샷 / 정상화 이력 (어제 일치 → 오늘 불일치 찾기, 상품 순위, 구역 정확도, 이력 검색) ──────────
    def _ensure_hist_tables(conn):
        conn.execute(
            """CREATE TABLE IF NOT EXISTS stock_check_history (
                day TEXT NOT NULL, code TEXT NOT NULL, zone TEXT NOT NULL,
                scan_qty INTEGER NOT NULL DEFAULT 0, system_qty INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL, name TEXT DEFAULT '', option TEXT DEFAULT '', username TEXT DEFAULT '',
                updated_at TEXT DEFAULT '', PRIMARY KEY (day, code))"""
        )
        conn.execute(
            """CREATE TABLE IF NOT EXISTS stock_check_normalize_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, day TEXT NOT NULL, username TEXT DEFAULT '',
                zone TEXT DEFAULT '', code TEXT NOT NULL, name TEXT DEFAULT '', option TEXT DEFAULT '',
                type TEXT NOT NULL, qty INTEGER NOT NULL, scan_qty INTEGER DEFAULT 0, system_qty INTEGER DEFAULT 0)"""
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_sc_norm_day ON stock_check_normalize_log (day)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_sc_norm_code ON stock_check_normalize_log (code)")

    def _enrich(rows: list[dict]) -> list[dict]:
        """상품명/옵션이 비어 있는 이력 행을 원가베이스유 상품코드로 찾아 채운다."""
        need = {str(r.get("code") or "").strip().upper() for r in rows if not (r.get("name") and r.get("option"))}
        need.discard("")
        if not need:
            return rows
        found: dict[str, tuple[str, str]] = {}
        try:
            wc = _get_wonbe_db()
            try:
                codes = sorted(need)
                for i in range(0, len(codes), 500):
                    chunk = codes[i:i + 500]
                    marks = ",".join("?" * len(chunk))
                    for w in wc.execute(
                        f"SELECT UPPER(TRIM(상품코드)), 상품명, 색상, 사이즈 FROM wonbe WHERE UPPER(TRIM(상품코드)) IN ({marks})", chunk
                    ).fetchall():
                        found[w[0]] = (
                            str(w[1] or "").strip(),
                            " ".join(p for p in [str(w[2] or "").strip(), str(w[3] or "").strip()] if p),
                        )
            finally:
                wc.close()
        except Exception:
            return rows  # 원가베이스유를 못 읽어도 이력 조회는 계속된다.
        for r in rows:
            hit = found.get(str(r.get("code") or "").strip().upper())
            if not hit:
                continue
            if not r.get("name") and hit[0]:
                zone = str(r.get("zone") or "")
                r["name"] = f"{zone} {hit[0]}".strip() if _ZONE_RE.match(zone) else hit[0]
            if not r.get("option"):
                r["option"] = hit[1]
        return rows

    def _today() -> str:
        return datetime.now(_KST).strftime("%Y-%m-%d")

    def _log_normalized(user: str, entries: list[dict]) -> None:
        if not entries:
            return
        now = datetime.now(_KST)
        conn = get_scan_db()
        try:
            _ensure_hist_tables(conn)
            for e in entries:
                conn.execute(
                    "INSERT INTO stock_check_normalize_log (ts, day, username, zone, code, name, option, type, qty, scan_qty, system_qty) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (now.strftime("%Y-%m-%d %H:%M:%S"), now.strftime("%Y-%m-%d"), user, e["zone"], e["code"], e["name"],
                     e["option"], e["type"], e["qty"], e["scan_qty"], e["system_qty"]),
                )
            conn.commit()
        finally:
            conn.close()

    @router.get("/history/scan-log")
    def history_scan_log(q: str = "", status: str = "", date_from: str = "", date_to: str = "", limit: int = 300, user: str = Depends(get_current_user)):
        """스캔 이력 검색: "조회"를 눌렀을 때 저장된 날짜별 스캔 내역(스캔 수량 1개 이상)을 찾는다."""
        limit = max(1, min(int(limit or 300), 2000))
        where, params = ["scan_qty > 0"], []
        for token in q.split():
            like = f"%{token}%"
            where.append("(code LIKE ? OR name LIKE ? OR option LIKE ? OR zone LIKE ? OR username LIKE ?)")
            params.extend([like] * 5)
        if status:
            if status not in ("ok", "more", "less", "none"):
                raise HTTPException(status_code=400, detail="status가 올바르지 않습니다.")
            where.append("status = ?")
            params.append(status)
        for col_sql, val in (("day >= ?", date_from.strip()), ("day <= ?", date_to.strip())):
            if val:
                if not re.match(r"^\d{4}-\d{2}-\d{2}$", val):
                    raise HTTPException(status_code=400, detail="날짜 형식이 올바르지 않습니다.")
                where.append(col_sql)
                params.append(val)
        sql = ("SELECT day, updated_at, username, zone, code, name, option, scan_qty, system_qty, status FROM stock_check_history WHERE "
               + " AND ".join(where) + " ORDER BY day DESC, zone, code LIMIT ?")
        conn = get_scan_db()
        try:
            _ensure_hist_tables(conn)
            rows = conn.execute(sql, (*params, limit)).fetchall()
            return {"ok": True, "rows": _enrich([
                {"day": r[0], "ts": r[1], "username": r[2], "zone": r[3], "code": r[4], "name": r[5], "option": r[6],
                 "scan_qty": r[7], "system_qty": r[8], "status": r[9]} for r in rows
            ])}
        finally:
            conn.close()

    @router.post("/history/save")
    def save_history(payload: dict = Body(...), user: str = Depends(get_current_user)):
        """조회 결과(스캔 vs 이지어드민 재고)를 오늘 날짜로 저장한다. 같은 날 같은 상품은 마지막 조회 결과로 덮어쓴다."""
        rows = payload.get("rows") or []
        if not isinstance(rows, list):
            raise HTTPException(status_code=400, detail="rows가 올바르지 않습니다.")
        day = _today()
        now = datetime.now(_KST).strftime("%Y-%m-%d %H:%M:%S")
        conn = get_scan_db()
        try:
            _ensure_hist_tables(conn)
            saved = 0
            for r in rows:
                status = str(r.get("status") or "")
                code = str(r.get("code") or "").strip()
                if status not in ("ok", "more", "less", "none") or not code:
                    continue
                conn.execute(
                    "INSERT INTO stock_check_history (day, code, zone, scan_qty, system_qty, status, name, option, username, updated_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
                    "ON CONFLICT(day, code) DO UPDATE SET zone = excluded.zone, scan_qty = excluded.scan_qty, "
                    "system_qty = excluded.system_qty, status = excluded.status, name = excluded.name, "
                    "option = excluded.option, username = excluded.username, updated_at = excluded.updated_at",
                    (day, code, str(r.get("zone") or ""), int(r.get("scan_qty") or 0), int(r.get("system_qty") or 0), status,
                     str(r.get("name") or ""), str(r.get("option") or ""), user, now),
                )
                saved += 1
            conn.commit()
            return {"ok": True, "day": day, "saved": saved}
        finally:
            conn.close()

    @router.get("/history/report")
    def history_report(month: str = "", days: int = 30, user: str = Depends(get_current_user)):
        """분석 리포트: 어제 일치→오늘 불일치, 정상화 상품 순위, 이번달 정상화 요약, 구역별 정확도."""
        month = month.strip() or _today()[:7]
        if not re.match(r"^\d{4}-\d{2}$", month):
            raise HTTPException(status_code=400, detail="month는 YYYY-MM 형식이어야 합니다.")
        days = max(1, min(int(days or 30), 365))
        since = (datetime.now(_KST) - timedelta(days=days)).strftime("%Y-%m-%d")
        conn = get_scan_db()
        try:
            _ensure_hist_tables(conn)
            # 1) 직전 조회일 일치 → 최근 조회일 불일치
            latest = conn.execute("SELECT MAX(day) FROM stock_check_history").fetchone()[0]
            prev = conn.execute("SELECT MAX(day) FROM stock_check_history WHERE day < ?", (latest,)).fetchone()[0] if latest else None
            regress = []
            if latest and prev:
                for r in conn.execute(
                    """SELECT t.zone, t.code, t.name, t.option, t.scan_qty, t.system_qty, t.status
                       FROM stock_check_history t JOIN stock_check_history p ON p.code = t.code AND p.day = ?
                       WHERE t.day = ? AND p.status = 'ok' AND t.status != 'ok' ORDER BY t.zone, t.code""",
                    (prev, latest),
                ).fetchall():
                    regress.append({"zone": r[0], "code": r[1], "name": r[2], "option": r[3], "scan_qty": r[4], "system_qty": r[5], "status": r[6]})
                _enrich(regress)
            # 2) 정상화 상품 순위 (최근 N일)
            ranking = [
                {"code": r[0], "name": r[1], "option": r[2], "zone": r[3], "times": r[4], "in_qty": r[5], "out_qty": r[6], "last": r[7]}
                for r in conn.execute(
                    """SELECT code, MAX(name), MAX(option), MAX(zone), COUNT(*),
                              SUM(CASE WHEN type = 'in' THEN qty ELSE 0 END), SUM(CASE WHEN type = 'out' THEN qty ELSE 0 END), MAX(ts)
                       FROM stock_check_normalize_log WHERE day >= ? AND type IN ('in', 'out') GROUP BY code ORDER BY COUNT(*) DESC, SUM(qty) DESC LIMIT 30""",
                    (since,),
                ).fetchall()
            ]
            _enrich(ranking)
            # 3) 이번달 정상화 요약
            m = conn.execute(
                """SELECT COUNT(*), COUNT(DISTINCT code),
                          SUM(CASE WHEN type = 'in' THEN 1 ELSE 0 END), SUM(CASE WHEN type = 'in' THEN qty ELSE 0 END),
                          SUM(CASE WHEN type = 'out' THEN 1 ELSE 0 END), SUM(CASE WHEN type = 'out' THEN qty ELSE 0 END)
                   FROM stock_check_normalize_log WHERE day LIKE ? AND type IN ('in', 'out')""",
                (month + "-%",),
            ).fetchone()
            scan_fix = conn.execute(
                "SELECT COUNT(*), COUNT(DISTINCT code) FROM stock_check_normalize_log WHERE day LIKE ? AND type = 'scan'", (month + "-%",)
            ).fetchone()
            summary = {"scan_fix_count": scan_fix[0] or 0, "scan_fix_products": scan_fix[1] or 0, "entries": m[0] or 0, "products": m[1] or 0, "in_count": m[2] or 0, "in_qty": m[3] or 0, "out_count": m[4] or 0, "out_qty": m[5] or 0}
            # 4) 구역별 정확도 (일치 상품 수 / 조회된 상품 수)
            acc: dict[str, dict] = {}
            for zone, day, ok, total in conn.execute(
                "SELECT zone, day, SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END), COUNT(*) FROM stock_check_history "
                "WHERE day LIKE ? GROUP BY zone, day ORDER BY zone, day",
                (month + "-%",),
            ).fetchall():
                z = acc.setdefault(zone, {"zone": zone, "ok": 0, "total": 0, "days": [], "last_ok": 0, "last_total": 0, "last_day": ""})
                z["ok"] += ok
                z["total"] += total
                z["days"].append({"day": day, "ok": ok, "total": total})
                z["last_ok"], z["last_total"], z["last_day"] = ok, total, day
            return {
                "ok": True, "month": month, "latest_day": latest, "prev_day": prev, "regress": regress,
                "ranking": ranking, "ranking_days": days, "summary": summary, "zones": list(acc.values()),
            }
        finally:
            conn.close()

    @router.get("/normalization/stats")
    def normalization_stats(month: str = "", q: str = "", user: str = Depends(get_current_user)):
        """정상화 통계: 재고체크 정상화 + 로그확인 입고/출고 + 송장삭제 출고를 한데 모아
        월별 입고/출고 합계, 상품별 개수, 계정·일시가 있는 내역을 돌려준다. months로 과거 달을 고를 수 있다."""
        month = month.strip() or _today()[:7]
        if not re.match(r"^\d{4}-\d{2}$", month):
            raise HTTPException(status_code=400, detail="month는 YYYY-MM 형식이어야 합니다.")
        conn = get_scan_db()
        try:
            _ensure_hist_tables(conn)
            normalization_log.ensure_table(conn)
            months = sorted(
                {r[0] for r in conn.execute("SELECT DISTINCT substr(day, 1, 7) FROM stock_check_normalize_log WHERE type IN ('in','out')").fetchall()}
                | {r[0] for r in conn.execute("SELECT DISTINCT substr(day, 1, 7) FROM normalization_log").fetchall()},
                reverse=True,
            )
            if month not in months:
                months.insert(0, month)
            rows: list[dict] = [
                {"ts": r[0], "username": r[1], "source": "stock_check", "type": r[2], "code": r[3], "name": r[4], "option": r[5], "qty": r[6], "ref": "", "memo": ""}
                for r in conn.execute(
                    "SELECT ts, username, type, code, name, option, qty FROM stock_check_normalize_log WHERE day LIKE ? AND type IN ('in','out')",
                    (month + "-%",),
                ).fetchall()
            ] + [
                {"ts": r[0], "username": r[1], "source": r[2], "type": r[3], "code": r[4], "name": r[5], "option": r[6], "qty": r[7], "ref": r[8], "memo": r[9] or ""}
                for r in conn.execute(
                    "SELECT ts, username, source, type, code, name, option, qty, ref, memo FROM normalization_log WHERE day LIKE ?",
                    (month + "-%",),
                ).fetchall()
            ]
        finally:
            conn.close()
        _enrich(rows)
        for r in rows:
            r["source_label"] = normalization_log.SOURCE_LABELS.get(r["source"], r["source"])
        rows.sort(key=lambda r: r["ts"], reverse=True)

        summary = {"in_count": 0, "in_qty": 0, "out_count": 0, "out_qty": 0, "products": len({r["code"] for r in rows})}
        for r in rows:
            k = "in" if r["type"] == "in" else "out"
            summary[f"{k}_count"] += 1
            summary[f"{k}_qty"] += r["qty"]

        # 검색어는 내역과 상품별 집계 모두에 적용한다 (월 합계 summary는 검색과 무관하게 그 달 전체).
        tokens = q.lower().split()
        if tokens:
            rows = [r for r in rows if all(t in f"{r['code']} {r['name']} {r['option']} {r['username']} {r['source_label']} {r['ref']} {r['memo']}".lower() for t in tokens)]

        by_product: dict[str, dict] = {}
        for r in rows:
            k = "in" if r["type"] == "in" else "out"
            p = by_product.setdefault(r["code"], {"code": r["code"], "name": r["name"], "option": r["option"], "in_qty": 0, "out_qty": 0, "times": 0, "by_source": {}})
            p[f"{k}_qty"] += r["qty"]
            p["times"] += 1
            # 정상화 방식(재고체크 / 로그확인 / 악성재고 / 송장삭제)별 입고·출고 수량과 횟수
            b = p["by_source"].setdefault((r["source"], k), {"source": r["source"], "label": r["source_label"], "type": k, "qty": 0, "count": 0})
            b["qty"] += r["qty"]
            b["count"] += 1
        # 처리 순서(입고→출고 / 출고→입고): 시간순으로 연속 중복을 합쳐 흐름 문자열을 만든다.
        flows: dict[str, list[str]] = {}
        for r in sorted(rows, key=lambda r: r["ts"]):
            seq = flows.setdefault(r["code"], [])
            t = "in" if r["type"] == "in" else "out"
            if not seq or seq[-1] != t:
                seq.append(t)
        for code, p in by_product.items():
            p["flow"] = "→".join("입고" if t == "in" else "출고" for t in flows.get(code, []))
            p["both"] = p["in_qty"] > 0 and p["out_qty"] > 0
            p["by_source"] = sorted(p["by_source"].values(), key=lambda b: (b["type"] != "in", -b["qty"]))
        products = sorted(by_product.values(), key=lambda p: (-(p["in_qty"] + p["out_qty"]), p["code"]))
        return {"ok": True, "month": month, "months": months, "summary": summary, "products": products, "rows": rows[:1000], "rows_total": len(rows)}

    @router.get("/history/normalize-log")
    def history_normalize_log(q: str = "", date_from: str = "", date_to: str = "", limit: int = 200, user: str = Depends(get_current_user)):
        """정상화 이력 검색: 상품코드/상품명/구역/처리자 일부로 찾고 기간으로 좁힌다."""
        limit = max(1, min(int(limit or 200), 1000))
        where, params = [], []
        for token in q.split():
            like = f"%{token}%"
            where.append("(code LIKE ? OR name LIKE ? OR option LIKE ? OR zone LIKE ? OR username LIKE ?)")
            params.extend([like] * 5)
        for col_sql, val in (("day >= ?", date_from.strip()), ("day <= ?", date_to.strip())):
            if val:
                if not re.match(r"^\d{4}-\d{2}-\d{2}$", val):
                    raise HTTPException(status_code=400, detail="날짜 형식이 올바르지 않습니다.")
                where.append(col_sql)
                params.append(val)
        sql = "SELECT ts, username, zone, code, name, option, type, qty, scan_qty, system_qty FROM stock_check_normalize_log"
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY id DESC LIMIT ?"
        conn = get_scan_db()
        try:
            _ensure_hist_tables(conn)
            rows = conn.execute(sql, (*params, limit)).fetchall()
            return {"ok": True, "rows": _enrich([
                {"ts": r[0], "username": r[1], "zone": r[2], "code": r[3], "name": r[4], "option": r[5], "type": r[6],
                 "qty": r[7], "scan_qty": r[8], "system_qty": r[9]} for r in rows
            ])}
        finally:
            conn.close()

    @router.post("/normalize")
    async def normalize_stock(payload: dict = Body(...), user: str = Depends(get_current_user)):
        """재고체크 정상화: items=[{code, type: in|out, qty}]를 이지어드민 I200 일괄 입고/출고로 처리한다.
        많음(스캔 > 재고)은 부족분만큼 입고, 적음(0 < 스캔 < 재고)은 모자란 만큼 출고,
        없음(스캔 0, 재고 있음)은 재고만큼 출고."""
        raw_items = payload.get("items") or []
        if not isinstance(raw_items, list) or not raw_items:
            raise HTTPException(status_code=400, detail="정상화할 상품을 선택하세요.")
        if not (get_setting(_EZADMIN_SESSION_KEY) or "").strip():
            return {"ok": False, "need_session": True}
        from api.wonbe_routes import load_wonbe_product_codes
        registered = load_wonbe_product_codes()
        ins: list[dict] = []
        outs: list[dict] = []
        logs: dict[str, list[dict]] = {"in": [], "out": []}
        for it in raw_items:
            code = str(it.get("code") or "").strip()
            type_ = str(it.get("type") or "").strip()
            try:
                qty = int(float(it.get("qty") or 0))
            except (TypeError, ValueError):
                qty = 0
            real = registered.get(code.upper())
            if not real:
                raise HTTPException(status_code=400, detail=f"상품코드({code})를 원가베이스유에서 찾을 수 없습니다.")
            if type_ not in ("in", "out") or qty < 1 or qty > 9999:
                raise HTTPException(status_code=400, detail=f"{code}: 구분/수량이 올바르지 않습니다.")
            (ins if type_ == "in" else outs).append({"product_id": real, "qty": qty, "memo": f"재고체크 정상화({user})"})
            logs[type_].append({
                "zone": str(it.get("zone") or ""), "code": real, "name": str(it.get("name") or ""), "option": str(it.get("option") or ""),
                "type": type_, "qty": qty, "scan_qty": int(it.get("scan_qty") or 0), "system_qty": int(it.get("system_qty") or 0),
            })
        ez = EzAdminClient(get_setting)
        done = {"in": 0, "out": 0}
        try:
            for type_, group, fn in (("in", ins, ez.bulk_receive_stock), ("out", outs, ez.bulk_ship_stock)):
                if not group:
                    continue
                res = await fn(group)
                if str(res.get("error")) not in ("0", ""):
                    detail = res.get("msg") or "EZAdmin 처리 실패"
                    raise HTTPException(status_code=400, detail=f"{'입고' if type_ == 'in' else '출고'}처리 실패: {detail} (이미 처리된 항목: 입고 {done['in']}종, 출고 {done['out']}종)")
                done[type_] = len(group)
                _log_normalized(user, logs[type_])  # 이지어드민 반영이 성공한 묶음만 이력에 남긴다
        except EzAdminSessionExpired:
            return {"ok": False, "need_session": True}
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=502, detail=f"EZAdmin 요청 실패: {exc} (이미 처리된 항목: 입고 {done['in']}종, 출고 {done['out']}종)")
        return {"ok": True, "in_count": done["in"], "out_count": done["out"]}

    @router.post("/resolve")
    def resolve_zone(payload: dict = Body(...), user: str = Depends(get_current_user)):
        """스캔한 상품코드 → 구역(상품명 앞 두 글자: AA, AB ...)."""
        raw = str(payload.get("code") or "").strip()
        code = normalize_code(raw)
        if not code:
            return {"ok": False, "message": f"상품코드 형식이 아닙니다: {raw}"}
        try:
            prefix_map = load_wonbe_rename_prefix_map()
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"원가베이스유 조회 실패: {exc}")
        zone = prefix_map.get(code) or prefix_map.get(code.upper())
        if not zone or not _ZONE_RE.match(zone):
            zone = _OTHER_ZONE  # 구역을 못 찾은 상품은 기타로 모은다.
        try:
            conn = _get_wonbe_db()
            try:
                row = conn.execute(
                    "SELECT 상품명, 색상, 사이즈 FROM wonbe WHERE UPPER(TRIM(상품코드)) = ? LIMIT 1", (code.upper(),)
                ).fetchone()
            finally:
                conn.close()
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"원가베이스유 조회 실패: {exc}")
        if not row:
            return {"ok": False, "code": code, "message": f"{code}: 원가베이스유에 없는 상품코드입니다."}
        base = str(row["상품명"] or "").strip()
        name = base if zone == _OTHER_ZONE else f"{zone} {base}".strip()
        option = " ".join(p for p in [str(row["색상"] or "").strip(), str(row["사이즈"] or "").strip()] if p)
        result = {
            "ok": True, "code": code, "zone": zone, "name": name, "option": option,
            "bad_stock": code in _load_bad_stock_codes(),
        }
        if payload.get("record"):
            # 스캔 1회 = 수량 +1을 이 계정에 저장한다 (UPSERT라 폰/PC에서 동시에 찍어도 합산된다).
            conn = get_scan_db()
            try:
                _ensure_scan_table(conn)
                conn.execute(
                    "INSERT INTO stock_check_scans (username, zone, code, qty, name, option) VALUES (?, ?, ?, 1, ?, ?) "
                    "ON CONFLICT(username, zone, code) DO UPDATE SET qty = qty + 1, name = excluded.name, option = excluded.option",
                    (user, zone, code, name, option),
                )
                conn.commit()
                row = conn.execute(
                    "SELECT qty FROM stock_check_scans WHERE username = ? AND zone = ? AND code = ?", (user, zone, code)
                ).fetchone()
                result["qty"] = int(row[0]) if row else 1
            finally:
                conn.close()
        return result

    @router.post("/query")
    async def query_zones(payload: dict = Body(...), user: str = Depends(get_current_user)):
        """구역별로 이지어드민에서 상품명 '<구역> ' 시작 + 재고 1개 이상 상품을 조회한다."""
        zones = [str(z).strip().upper() for z in (payload.get("zones") or [])]
        zones = [z for z in dict.fromkeys(zones) if _ZONE_RE.match(z)]
        if not zones:
            raise HTTPException(status_code=400, detail="조회할 구역이 없습니다.")
        phpsessid = (get_setting(_EZADMIN_SESSION_KEY) or "").strip()
        if not phpsessid:
            return {"ok": False, "need_session": True}

        today = datetime.now(_KST).strftime("%Y-%m-%d")
        bad_codes = _load_bad_stock_codes()
        result: dict[str, list[dict]] = {}
        try:
            async with httpx.AsyncClient(timeout=30.0, verify=False, follow_redirects=True) as client:
                for zone in zones:
                    par = _build_par(today, zone)
                    items: list[dict] = []
                    page, total_pages = 1, 1
                    while page <= total_pages:
                        r = await client.post(
                            f"{_EZADMIN_BASE}/function.htm",
                            data={
                                "_search": "false", "nd": str(int(datetime.now().timestamp() * 1000)),
                                "rows": str(_PAGE_ROWS), "page": str(page), "sidx": "", "sord": "asc",
                                "template": "I100", "action": "search", "page_code": "I100", "par": par,
                            },
                            cookies={"PHPSESSID": phpsessid},
                            headers={
                                "User-Agent": "Mozilla/5.0",
                                "X-Requested-With": "XMLHttpRequest",
                                "Referer": f"{_EZADMIN_BASE}/template35.htm?template=I100",
                            },
                        )
                        try:
                            obj = r.json()
                        except Exception:
                            return {"ok": False, "need_session": True}
                        if not isinstance(obj, dict) or "rows" not in obj:
                            return {"ok": False, "need_session": True}
                        for row in obj["rows"]:
                            cell = row.get("cell") or {}
                            name = _strip_html(cell.get("product_name"))
                            # '이름 포함' 검색이므로 앞 두 글자가 구역인 상품만 남긴다.
                            if not (name.upper().startswith(zone) and name[2:3] in ("", " ")):
                                continue
                            raw_code = cell.get("key") or _strip_html(cell.get("product_id"))
                            code = normalize_code(raw_code) or str(raw_code).strip()
                            qty = _to_int(_strip_html(cell.get("stock")))
                            if not code or qty < 1 or code in bad_codes:
                                continue  # 악성재고는 비교 대상에서 제외
                            items.append({
                                "code": code,
                                "product_name": name,
                                "options": _strip_html(cell.get("options")),
                                "stock_qty": qty,
                            })
                        total_pages = _to_int(obj.get("total")) or 1
                        page += 1
                    result[zone] = items

                # 구역 검색(상품명이 구역으로 시작)에 안 잡힌 스캔 상품은 상품코드로 직접 찾아 재고를 채운다.
                # (이지어드민 상품명에 아직 구역 접두어가 안 붙은 상품이 "재고 목록에 없음"으로 잘못 보이는 것 방지)
                extra = payload.get("extra") or {}
                if isinstance(extra, dict):
                    for zone in zones:
                        have = {it["code"] for it in result.get(zone, [])}
                        for raw in extra.get(zone) or []:
                            want = normalize_code(str(raw)) or str(raw).strip()
                            if not want or want in have or want in bad_codes:
                                continue
                            par = _build_par(today, zone).replace(
                                f"query_type=name&query_str={quote(zone)}", f"query_type=product_id&query_str={quote(want)}"
                            )
                            r = await client.post(
                                f"{_EZADMIN_BASE}/function.htm",
                                data={
                                    "_search": "false", "nd": str(int(datetime.now().timestamp() * 1000)),
                                    "rows": "20", "page": "1", "sidx": "", "sord": "asc",
                                    "template": "I100", "action": "search", "page_code": "I100", "par": par,
                                },
                                cookies={"PHPSESSID": phpsessid},
                                headers={
                                    "User-Agent": "Mozilla/5.0",
                                    "X-Requested-With": "XMLHttpRequest",
                                    "Referer": f"{_EZADMIN_BASE}/template35.htm?template=I100",
                                },
                            )
                            try:
                                obj = r.json()
                            except Exception:
                                return {"ok": False, "need_session": True}
                            for row in (obj.get("rows") or []) if isinstance(obj, dict) else []:
                                cell = row.get("cell") or {}
                                raw_code = cell.get("key") or _strip_html(cell.get("product_id"))
                                code = normalize_code(raw_code) or str(raw_code).strip()
                                qty = _to_int(_strip_html(cell.get("stock")))
                                if code != want or qty < 1:
                                    continue
                                rep_code = ""
                                try:
                                    wc = _get_wonbe_db()
                                    try:
                                        rr = wc.execute("SELECT 대표상품코드 FROM wonbe WHERE UPPER(TRIM(상품코드)) = ? LIMIT 1", (code.upper(),)).fetchone()
                                    finally:
                                        wc.close()
                                    rep_code = str(rr[0] or "").strip() if rr else ""
                                except Exception:
                                    pass
                                result[zone].append({
                                    "code": code,
                                    "product_name": _strip_html(cell.get("product_name")),
                                    "options": _strip_html(cell.get("options")),
                                    "stock_qty": qty,
                                    "needs_rename": True,  # 이지어드민 상품명에 구역 접두어가 아직 없다
                                    "rep_code": rep_code,
                                })
                                have.add(code)
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"이지어드민 연결 실패: {exc}")
        return {"ok": True, "zones": result, "bad_codes": sorted(bad_codes)}

    return router
