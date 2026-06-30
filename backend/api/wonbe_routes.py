from __future__ import annotations

import io
import re
import sqlite3
import urllib.parse
from datetime import datetime
from pathlib import Path

import httpx
import openpyxl
import xlwt
from fastapi import APIRouter, Body, Depends, File, HTTPException, UploadFile
from fastapi.responses import Response

try:
    from bs4 import BeautifulSoup as _BS4
    _BS4_OK = True
except ImportError:
    _BS4_OK = False

_EZADMIN_BASE = "https://ga80.ezadmin.co.kr"
_EZADMIN_SESSION_KEY = "ezadmin_phpsessid"

_TOP90_BASE = "https://top90.sosolution.net"
_TOP90_EMAIL = "values0208@naver.com"
_TOP90_PASSWORD = "!Glqgkqdldi1126"

WONBE_DB_PATH = Path(r"C:\Users\ksh29\OneDrive\Desktop\원베\원가베이스유.db")
WONBE_XLSX_PATH = Path(r"C:\Users\ksh29\OneDrive\Desktop\원베\원가베이스유.xlsx")
JANGGI_DB_PATH = Path(r"C:\Users\ksh29\OneDrive\Desktop\원베\날짜별장끼정리.db")

COLUMNS = ["상품코드", "상품명", "색상", "사이즈", "원가", "거래처", "거래처상품명", "거래처합", "상품명합", "거래처주소", "옵션번호"]
EDITABLE = {"상품명합", "거래처합", "원가", "거래처주소"}

JANGGI_COLUMNS = ["거래처", "거래처상품명", "가격", "옵션", "사이즈", "개수", "날짜", "미송체크", "상품코드", "메모", "거래처합산"]


def _get_wonbe_db() -> sqlite3.Connection:
    WONBE_DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(WONBE_DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn


def _init_wonbe_table(conn: sqlite3.Connection):
    conn.execute("""
        CREATE TABLE IF NOT EXISTS wonbe (
            상품코드  TEXT PRIMARY KEY,
            상품명    TEXT,
            색상      TEXT,
            사이즈    TEXT,
            원가      TEXT,
            거래처    TEXT,
            거래처상품명 TEXT,
            거래처합  TEXT,
            상품명합  TEXT,
            거래처주소 TEXT,
            옵션번호  TEXT
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS wonbe_meta (
            key   TEXT PRIMARY KEY,
            value TEXT
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_wonbe_상품명합 ON wonbe(상품명합)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_wonbe_거래처합 ON wonbe(거래처합)")
    conn.commit()


def _init_kdg_table(conn: sqlite3.Connection):
    conn.execute("""
        CREATE TABLE IF NOT EXISTS 케이디지원가베이스 (
            상품명합  TEXT,
            상품코드  TEXT PRIMARY KEY
        )
    """)
    conn.commit()


def _get_janggi_db() -> sqlite3.Connection:
    JANGGI_DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(JANGGI_DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn


def _init_janggi_table(conn: sqlite3.Connection):
    conn.execute("""
        CREATE TABLE IF NOT EXISTS 날짜별장끼정리 (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            거래처      TEXT,
            거래처상품명 TEXT,
            가격        TEXT,
            옵션        TEXT,
            사이즈      TEXT,
            개수        TEXT,
            날짜        TEXT,
            미송체크    TEXT,
            상품코드    TEXT,
            메모        TEXT,
            거래처합산  TEXT
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_janggi_날짜 ON 날짜별장끼정리(날짜)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_janggi_거래처 ON 날짜별장끼정리(거래처)")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS janggi_aliases (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
    """)
    conn.commit()


def _content_disposition(filename: str) -> str:
    ascii_name = "".join(ch if ord(ch) < 128 else "_" for ch in filename).strip("_") or "download"
    quoted = urllib.parse.quote(filename)
    return f'attachment; filename="{ascii_name}"; filename*=UTF-8\'\'{quoted}'


def _parse_options(options_str: str) -> tuple[str, str]:
    """'[크림-FREE-SHORT]' → ('크림', 'FREE SHORT')"""
    s = str(options_str or "").strip().lstrip("[").rstrip("]")
    parts = [p.strip() for p in s.split("-")]
    color = parts[0] if parts else ""
    size = " ".join(parts[1:]) if len(parts) > 1 else ""
    return color, size


def _strip_html(html_str: str) -> str:
    return re.sub(r"<[^>]+>", "", str(html_str or "")).strip()


def build_wonbe_router(*, get_current_user, get_setting=None):
    router = APIRouter(prefix="/wonbe")

    @router.post("/import")
    async def wonbe_import(
        file: UploadFile = File(...),
        user: str = Depends(get_current_user),
    ):
        content = await file.read()
        try:
            wb = openpyxl.load_workbook(io.BytesIO(content), read_only=True, data_only=True)
            ws = wb.active
            rows_iter = ws.iter_rows(values_only=True)
            header_row = next(rows_iter, None)
            if header_row is None:
                raise HTTPException(status_code=400, detail="빈 파일입니다.")

            data_rows = []
            for row in rows_iter:
                vals = [str(v).strip() if v is not None else "" for v in row]
                while len(vals) < len(COLUMNS):
                    vals.append("")
                vals = vals[:len(COLUMNS)]
                if not any(vals):
                    continue
                data_rows.append(vals)
            wb.close()
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"엑셀 파싱 오류: {e}")

        data_rows.reverse()  # 엑셀 맨 아래 행이 rowid 1 → 목록 맨 위에 표시

        conn = _get_wonbe_db()
        try:
            _init_wonbe_table(conn)
            conn.execute("DELETE FROM wonbe")
            conn.executemany(
                f"INSERT OR REPLACE INTO wonbe ({', '.join(COLUMNS)}) VALUES ({', '.join(['?']*len(COLUMNS))})",
                data_rows,
            )
            conn.commit()
            return {"ok": True, "count": len(data_rows)}
        finally:
            conn.close()

    @router.post("/init-from-default")
    def wonbe_init_from_default(user: str = Depends(get_current_user)):
        if not WONBE_XLSX_PATH.exists():
            raise HTTPException(status_code=404, detail=f"파일 없음: {WONBE_XLSX_PATH}")
        try:
            wb = openpyxl.load_workbook(str(WONBE_XLSX_PATH), read_only=True, data_only=True)
            ws = wb.active
            rows_iter = ws.iter_rows(values_only=True)
            next(rows_iter, None)
            data_rows = []
            for row in rows_iter:
                vals = [str(v).strip() if v is not None else "" for v in row]
                while len(vals) < len(COLUMNS):
                    vals.append("")
                vals = vals[:len(COLUMNS)]
                if not any(vals):
                    continue
                data_rows.append(vals)
            wb.close()
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"파일 읽기 오류: {e}")

        data_rows.reverse()  # 엑셀 맨 아래 행이 rowid 1 → 목록 맨 위에 표시

        conn = _get_wonbe_db()
        try:
            _init_wonbe_table(conn)
            conn.execute("DELETE FROM wonbe")
            conn.executemany(
                f"INSERT OR REPLACE INTO wonbe ({', '.join(COLUMNS)}) VALUES ({', '.join(['?']*len(COLUMNS))})",
                data_rows,
            )
            conn.commit()
            return {"ok": True, "count": len(data_rows)}
        finally:
            conn.close()

    @router.get("/search")
    def wonbe_search(
        q: str = "",
        offset: int = 0,
        limit: int = 50,
        user: str = Depends(get_current_user),
    ):
        conn = _get_wonbe_db()
        try:
            _init_wonbe_table(conn)
            q = q.strip()
            if not q:
                rows = conn.execute(
                    "SELECT * FROM wonbe ORDER BY rowid ASC LIMIT ? OFFSET ?",
                    (limit, offset),
                ).fetchall()
                total = conn.execute("SELECT COUNT(*) FROM wonbe").fetchone()[0]
            else:
                like = f"%{q}%"
                rows = conn.execute(
                    """SELECT * FROM wonbe
                       WHERE 상품코드 LIKE ? OR 상품명합 LIKE ? OR 거래처합 LIKE ?
                       ORDER BY CASE WHEN 상품코드 = ? THEN 0
                                     WHEN 상품코드 LIKE ? THEN 1 ELSE 2 END, 상품코드
                       LIMIT ? OFFSET ?""",
                    (like, like, like, q, f"{q}%", limit, offset),
                ).fetchall()
                total = conn.execute(
                    "SELECT COUNT(*) FROM wonbe WHERE 상품코드 LIKE ? OR 상품명합 LIKE ? OR 거래처합 LIKE ?",
                    (like, like, like),
                ).fetchone()[0]
            return {
                "ok": True,
                "rows": [dict(r) for r in rows],
                "total": total,
                "offset": offset,
                "limit": limit,
            }
        finally:
            conn.close()

    @router.patch("/row")
    def wonbe_update_row(
        payload: dict = Body(...),
        user: str = Depends(get_current_user),
    ):
        code = str(payload.get("상품코드") or "").strip()
        if not code:
            raise HTTPException(status_code=400, detail="상품코드 필요")

        updates = {k: str(v).strip() for k, v in payload.items() if k in EDITABLE}
        if not updates:
            raise HTTPException(status_code=400, detail="수정할 필드 없음")

        set_clause = ", ".join(f"{col} = ?" for col in updates)
        values = list(updates.values()) + [code]

        conn = _get_wonbe_db()
        try:
            _init_wonbe_table(conn)
            cur = conn.execute(f"UPDATE wonbe SET {set_clause} WHERE 상품코드 = ?", values)
            conn.commit()
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="해당 상품코드 없음")
            row = conn.execute("SELECT * FROM wonbe WHERE 상품코드 = ?", (code,)).fetchone()
            return {"ok": True, "row": dict(row)}
        finally:
            conn.close()

    @router.post("/bulk-update-cost")
    def wonbe_bulk_update_cost(
        payload: dict = Body(...),
        user: str = Depends(get_current_user),
    ):
        q = str(payload.get("q") or "").strip()
        cost = str(payload.get("원가") or "").strip()

        conn = _get_wonbe_db()
        try:
            _init_wonbe_table(conn)
            if q:
                like = f"%{q}%"
                cur = conn.execute(
                    "UPDATE wonbe SET 원가 = ? WHERE 상품코드 LIKE ? OR 상품명합 LIKE ? OR 거래처합 LIKE ?",
                    (cost, like, like, like),
                )
            else:
                cur = conn.execute("UPDATE wonbe SET 원가 = ?", (cost,))
            conn.commit()
            return {"ok": True, "count": cur.rowcount}
        finally:
            conn.close()

    @router.get("/export")
    def wonbe_export(user: str = Depends(get_current_user)):
        conn = _get_wonbe_db()
        try:
            _init_wonbe_table(conn)
            rows = conn.execute("SELECT * FROM wonbe ORDER BY 상품코드").fetchall()
        finally:
            conn.close()

        book = xlwt.Workbook()
        sheet = book.add_sheet("Sheet1")
        for ci, h in enumerate(COLUMNS):
            sheet.write(0, ci, h)
        for ri, row in enumerate(rows, start=1):
            for ci, col in enumerate(COLUMNS):
                sheet.write(ri, ci, row[col] or "")

        buf = io.BytesIO()
        book.save(buf)
        return Response(
            content=buf.getvalue(),
            media_type="application/vnd.ms-excel",
            headers={"Content-Disposition": _content_disposition("원가베이스유.xls")},
        )

    @router.post("/sync-from-ezadmin")
    async def wonbe_sync_ezadmin(
        payload: dict = Body(default={}),
        user: str = Depends(get_current_user),
    ):
        if not get_setting:
            raise HTTPException(status_code=500, detail="get_setting 미설정")
        phpsessid = (get_setting(_EZADMIN_SESSION_KEY) or "").strip()
        if not phpsessid:
            return {"ok": False, "need_session": True}

        today_str = datetime.now().strftime("%Y-%m-%d")
        start_date2 = str(payload.get("start_date") or today_str)
        end_date2 = str(payload.get("end_date") or today_str)

        nd = str(int(datetime.now().timestamp() * 1000))
        par = (
            f"auto_search=&search_all_product=&multi_supply_group=&multi_supply="
            f"&str_supply_code=0&tags_string=&product_tag_include_type=1"
            f"&query_type=name&query_str=&stock_type=0&stock_start=&stock_end="
            f"&notrans_day=&notrans_cnt=&notrans_status=0&stock_status=0"
            f"&start_date={today_str}&start_hour=00%3A00%3A00"
            f"&end_date={today_str}&end_hour=23%3A59%3A59&date_period_sel=0"
            f"&work_type=stockin&work_start=&work_end=&inout_type=0&product_date=reg_date"
            f"&start_date2={start_date2}&end_date2={end_date2}&date_period_sel2=0"
            f"&products_sort=1&category=0&except_soldout=0&temp_soldout=0&location=0"
        )
        try:
            async with httpx.AsyncClient(timeout=120.0, verify=False, follow_redirects=True) as client:
                r = await client.post(
                    f"{_EZADMIN_BASE}/function.htm",
                    data={
                        "_search": "false", "nd": nd,
                        "rows": "9999", "page": "1", "sidx": "", "sord": "asc",
                        "template": "I100", "action": "search", "page_code": "I100",
                        "par": par,
                    },
                    cookies={"PHPSESSID": phpsessid},
                    headers={
                        "User-Agent": "Mozilla/5.0",
                        "X-Requested-With": "XMLHttpRequest",
                        "Referer": f"{_EZADMIN_BASE}/template40.htm?template=I100",
                    },
                )
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"EZAdmin 요청 실패: {exc}")

        try:
            obj = r.json()
        except Exception:
            return {"ok": False, "need_session": True}

        if "rows" not in obj:
            return {"ok": False, "need_session": True}

        data_rows = []
        for row in obj.get("rows", []):
            c = row.get("cell", {})
            code = str(c.get("key") or "").strip()
            if not code:
                continue
            product_name = str(c.get("product_name") or "").strip()
            color, size = _parse_options(str(c.get("options") or ""))
            org_price = str(c.get("org_price") or "").strip()
            brand_raw = str(c.get("brand") or "").strip()
            brand_parts = brand_raw.split(" ", 1)
            supplier = brand_parts[0] if brand_parts else ""
            supplier_product = brand_parts[1] if len(brand_parts) > 1 else ""
            option_no = str(c.get("option_extra_column1") or "").strip()
            supplier_combined = " ".join(p for p in [supplier_product, color, size] if p)
            name_combined = " ".join(p for p in [product_name, color, size] if p)
            data_rows.append((code, product_name, color, size, org_price, supplier, supplier_product, supplier_combined, name_combined, option_no))

        conn = _get_wonbe_db()
        try:
            _init_wonbe_table(conn)

            # 기존 거래처 → 거래처주소 매핑
            addr_rows = conn.execute(
                "SELECT 거래처, 거래처주소 FROM wonbe WHERE 거래처주소 IS NOT NULL AND 거래처주소 != ''"
            ).fetchall()
            addr_map = {r["거래처"]: r["거래처주소"] for r in addr_rows}

            # 거래처주소 채운 최종 튜플
            final_rows = [
                (code, pname, color, size, price, sup, sup_prod, sup_comb, name_comb, addr_map.get(sup, ""), opt)
                for code, pname, color, size, price, sup, sup_prod, sup_comb, name_comb, opt in data_rows
            ]

            before = conn.execute("SELECT COUNT(*) FROM wonbe").fetchone()[0]
            conn.executemany(
                """INSERT OR IGNORE INTO wonbe
                   (상품코드, 상품명, 색상, 사이즈, 원가, 거래처, 거래처상품명, 거래처합, 상품명합, 거래처주소, 옵션번호)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                final_rows,
            )
            after = conn.execute("SELECT COUNT(*) FROM wonbe").fetchone()[0]
            inserted = after - before

            # 거래처가 케이디지인 행을 케이디지원가베이스 테이블에도 추가
            _init_kdg_table(conn)
            kdg_rows = [
                (row[8], row[0])  # (상품명합, 상품코드)
                for row in final_rows
                if row[5] == "케이디지"
            ]
            if kdg_rows:
                conn.executemany(
                    """INSERT OR IGNORE INTO 케이디지원가베이스 (상품명합, 상품코드) VALUES (?, ?)""",
                    kdg_rows,
                )
            synced_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            conn.execute(
                "INSERT OR REPLACE INTO wonbe_meta (key, value) VALUES ('last_sync_at', ?)",
                (synced_at,),
            )
            conn.execute(
                "INSERT OR REPLACE INTO wonbe_meta (key, value) VALUES ('last_sync_count', ?)",
                (str(inserted),),
            )
            conn.execute(
                "INSERT OR REPLACE INTO wonbe_meta (key, value) VALUES ('last_sync_fetched', ?)",
                (str(len(data_rows)),),
            )
            conn.commit()
            return {"ok": True, "fetched": len(data_rows), "inserted": inserted, "synced_at": synced_at}
        finally:
            conn.close()

    @router.post("/lookup-prices")
    def wonbe_lookup_prices(
        payload: dict = Body(...),
        user: str = Depends(get_current_user),
    ):
        codes = [str(c).strip() for c in (payload.get("codes") or []) if str(c).strip()]
        if not codes:
            return {"ok": True, "prices": {}}
        conn = _get_wonbe_db()
        try:
            _init_wonbe_table(conn)
            placeholders = ",".join(["?"] * len(codes))
            rows = conn.execute(
                f"SELECT 상품코드, 원가 FROM wonbe WHERE 상품코드 IN ({placeholders})",
                codes,
            ).fetchall()
            prices = {r["상품코드"]: r["원가"] for r in rows}
            return {"ok": True, "prices": prices}
        finally:
            conn.close()

    @router.get("/stats")
    def wonbe_stats(user: str = Depends(get_current_user)):
        conn = _get_wonbe_db()
        try:
            _init_wonbe_table(conn)
            total = conn.execute("SELECT COUNT(*) FROM wonbe").fetchone()[0]
            db_exists = WONBE_DB_PATH.exists()
            meta_rows = conn.execute("SELECT key, value FROM wonbe_meta").fetchall()
            meta = {r["key"]: r["value"] for r in meta_rows}
            return {
                "ok": True,
                "total": total,
                "db_exists": db_exists,
                "last_sync_at": meta.get("last_sync_at"),
                "last_sync_count": meta.get("last_sync_count"),
                "last_sync_fetched": meta.get("last_sync_fetched"),
            }
        finally:
            conn.close()

    @router.post("/janggi/save")
    def janggi_save(
        payload: dict = Body(...),
        user: str = Depends(get_current_user),
    ):
        rows = payload.get("rows") or []
        if not rows:
            raise HTTPException(status_code=400, detail="저장할 데이터가 없습니다.")
        conn = _get_janggi_db()
        try:
            _init_janggi_table(conn)
            data_rows = [
                (
                    str(r.get("거래처") or ""),
                    str(r.get("거래처상품명") or ""),
                    str(r.get("가격") or ""),
                    str(r.get("옵션") or ""),
                    str(r.get("사이즈") or ""),
                    str(r.get("개수") or ""),
                    str(r.get("날짜") or ""),
                    str(r.get("미송체크") or ""),
                    str(r.get("상품코드") or ""),
                    str(r.get("메모") or ""),
                    str(r.get("거래처합산") or ""),
                )
                for r in rows
            ]
            conn.executemany(
                f"INSERT INTO 날짜별장끼정리 ({', '.join(JANGGI_COLUMNS)}) VALUES ({', '.join(['?'] * len(JANGGI_COLUMNS))})",
                data_rows,
            )
            conn.commit()
            return {"ok": True, "saved": len(data_rows)}
        finally:
            conn.close()

    @router.get("/janggi/search")
    def janggi_search(
        q: str = "",
        date: str = "",
        offset: int = 0,
        limit: int = 50,
        user: str = Depends(get_current_user),
    ):
        conn = _get_janggi_db()
        try:
            _init_janggi_table(conn)
            q = q.strip()
            date = date.strip()
            order = "ORDER BY 날짜 DESC, 거래처 DESC"

            conditions = []
            params: list = []
            if date:
                conditions.append("날짜 = ?")
                params.append(date)
            if q:
                like = f"%{q}%"
                conditions.append("(거래처 LIKE ? OR 거래처상품명 LIKE ? OR 상품코드 LIKE ?)")
                params.extend([like, like, like])

            where = f"WHERE {' AND '.join(conditions)}" if conditions else ""

            rows = conn.execute(
                f"SELECT * FROM 날짜별장끼정리 {where} {order} LIMIT ? OFFSET ?",
                params + [limit, offset],
            ).fetchall()
            total = conn.execute(
                f"SELECT COUNT(*) FROM 날짜별장끼정리 {where}",
                params,
            ).fetchone()[0]

            return {
                "ok": True,
                "rows": [dict(r) for r in rows],
                "total": total,
                "offset": offset,
                "limit": limit,
            }
        finally:
            conn.close()

    @router.patch("/janggi/row")
    def janggi_update_row(
        payload: dict = Body(...),
        user: str = Depends(get_current_user),
    ):
        row_id = payload.get("id")
        col = str(payload.get("column") or "").strip()
        value = str(payload.get("value") or "").strip()
        if row_id is None or col not in JANGGI_COLUMNS:
            raise HTTPException(status_code=400, detail="id와 유효한 column이 필요합니다.")
        conn = _get_janggi_db()
        try:
            _init_janggi_table(conn)
            cur = conn.execute(
                f"UPDATE 날짜별장끼정리 SET {col} = ? WHERE id = ?",
                (value, row_id),
            )
            conn.commit()
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="해당 id 없음")
            row = conn.execute("SELECT * FROM 날짜별장끼정리 WHERE id = ?", (row_id,)).fetchone()
            return {"ok": True, "row": dict(row)}
        finally:
            conn.close()

    @router.post("/janggi/row")
    def janggi_add_row(
        payload: dict = Body(default={}),
        user: str = Depends(get_current_user),
    ):
        conn = _get_janggi_db()
        try:
            _init_janggi_table(conn)
            values = tuple(str(payload.get(col) or "") for col in JANGGI_COLUMNS)
            cur = conn.execute(
                f"INSERT INTO 날짜별장끼정리 ({', '.join(JANGGI_COLUMNS)}) VALUES ({', '.join(['?'] * len(JANGGI_COLUMNS))})",
                values,
            )
            conn.commit()
            row = conn.execute("SELECT * FROM 날짜별장끼정리 WHERE id = ?", (cur.lastrowid,)).fetchone()
            return {"ok": True, "row": dict(row)}
        finally:
            conn.close()

    @router.delete("/janggi/row")
    def janggi_delete_row(
        payload: dict = Body(...),
        user: str = Depends(get_current_user),
    ):
        row_id = payload.get("id")
        if row_id is None:
            raise HTTPException(status_code=400, detail="id 필요")
        conn = _get_janggi_db()
        try:
            _init_janggi_table(conn)
            cur = conn.execute("DELETE FROM 날짜별장끼정리 WHERE id = ?", (row_id,))
            conn.commit()
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="해당 id 없음")
            return {"ok": True, "deleted": cur.rowcount}
        finally:
            conn.close()

    @router.delete("/janggi/by-date")
    def janggi_delete_by_date(
        payload: dict = Body(...),
        user: str = Depends(get_current_user),
    ):
        date_str = str(payload.get("날짜") or "").strip()
        if not date_str:
            raise HTTPException(status_code=400, detail="날짜 필요")
        conn = _get_janggi_db()
        try:
            _init_janggi_table(conn)
            cur = conn.execute("DELETE FROM 날짜별장끼정리 WHERE 날짜 = ?", (date_str,))
            conn.commit()
            return {"ok": True, "deleted": cur.rowcount}
        finally:
            conn.close()

    @router.get("/janggi/aliases")
    def janggi_get_aliases(user: str = Depends(get_current_user)):
        conn = _get_janggi_db()
        try:
            _init_janggi_table(conn)
            rows = conn.execute("SELECT key, value FROM janggi_aliases").fetchall()
            return {"ok": True, "aliases": {r["key"]: r["value"] for r in rows}}
        finally:
            conn.close()

    @router.put("/janggi/aliases")
    def janggi_save_aliases(
        payload: dict = Body(...),
        user: str = Depends(get_current_user),
    ):
        aliases = payload.get("aliases") or {}
        conn = _get_janggi_db()
        try:
            _init_janggi_table(conn)
            conn.execute("DELETE FROM janggi_aliases")
            if aliases:
                conn.executemany(
                    "INSERT INTO janggi_aliases (key, value) VALUES (?, ?)",
                    [(str(k), str(v)) for k, v in aliases.items() if k and v],
                )
            conn.commit()
            return {"ok": True, "count": len(aliases)}
        finally:
            conn.close()

    @router.get("/janggi/recent-summary")
    def janggi_recent_summary(user: str = Depends(get_current_user)):
        conn = _get_janggi_db()
        try:
            _init_janggi_table(conn)
            latest = conn.execute(
                "SELECT MAX(날짜) AS d FROM 날짜별장끼정리"
            ).fetchone()["d"]
            if not latest:
                return {"ok": True, "date": None, "rows": []}
            rows = conn.execute(
                """SELECT 거래처,
                          SUM(CASE WHEN CAST(가격 AS REAL) > 0 THEN CAST(가격 AS REAL) ELSE 0 END) AS 합산
                   FROM 날짜별장끼정리
                   WHERE 날짜 = ? AND 거래처 != ''
                   GROUP BY 거래처
                   ORDER BY 거래처 DESC""",
                (latest,),
            ).fetchall()
            return {
                "ok": True,
                "date": latest,
                "rows": [{"거래처": r["거래처"], "합산": r["합산"]} for r in rows],
            }
        finally:
            conn.close()

    @router.get("/janggi/top-shops")
    async def janggi_top_shops(user: str = Depends(get_current_user)):
        if not _BS4_OK:
            raise HTTPException(status_code=500, detail="beautifulsoup4가 설치되지 않았습니다.")
        today = datetime.now().strftime("%Y-%m-%d")
        try:
            async with httpx.AsyncClient(timeout=60.0, follow_redirects=True) as client:
                await client.get(f"{_TOP90_BASE}/login",
                                 headers={"User-Agent": "Mozilla/5.0"})
                await client.post(
                    f"{_TOP90_BASE}/login/auth",
                    data={
                        "login_email": _TOP90_EMAIL,
                        "login_password": _TOP90_PASSWORD,
                        "login_remember": "on",
                    },
                    headers={"User-Agent": "Mozilla/5.0"},
                )
                search_res = await client.post(
                    f"{_TOP90_BASE}/inquiry/done_search",
                    data={"obj[start]": today, "obj[end]": today},
                    headers={
                        "X-Requested-With": "XMLHttpRequest",
                        "Referer": f"{_TOP90_BASE}/inquiry/done/",
                        "User-Agent": "Mozilla/5.0",
                    },
                )
                try:
                    items = search_res.json()
                except Exception:
                    raise HTTPException(status_code=502, detail="TOP90 응답 파싱 실패 (로그인 확인)")

                today_items = [
                    it for it in (items if isinstance(items, list) else [])
                    if str(it.get("l_timestamp", "")).startswith(today)
                ]

                seen: set[str] = set()
                shops: list[str] = []
                for it in today_items:
                    detail_res = await client.get(
                        f"{_TOP90_BASE}/inquiry/done_detail/{it['c_idx']}/{it['l_idx']}",
                        headers={"Referer": f"{_TOP90_BASE}/inquiry/done/",
                                 "User-Agent": "Mozilla/5.0"},
                    )
                    soup = _BS4(detail_res.text, "html.parser")
                    for tr in soup.select("table tbody tr"):
                        state_td = tr.select_one("td.i-type")
                        if not state_td or "완료" not in state_td.get_text(" ", strip=True):
                            continue
                        shop_tag = tr.select_one("h2.shopname")
                        if shop_tag:
                            name = shop_tag.get_text(strip=True)
                            if name and name not in seen:
                                seen.add(name)
                                shops.append(name)

                return {"ok": True, "date": today, "shops": shops}
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"TOP90 조회 실패: {exc}")

    return router
