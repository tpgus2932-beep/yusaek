from pathlib import Path
from datetime import datetime, timedelta
import tempfile
import io
import re
import urllib.parse
import uuid

import httpx
import pandas as pd
from fastapi import APIRouter, Body, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from zipfile import BadZipFile
from openpyxl import load_workbook, Workbook
import xlwt

_EZADMIN_BASE = "https://ga80.ezadmin.co.kr"
_EZADMIN_SESSION_KEY = "ezadmin_phpsessid"


def build_order_router(
    *,
    require_admin,
    get_db,
    order_cost_base_path: Path,
    get_setting,
):
    router = APIRouter()
    COST_BASE_CODE_COL = 0
    COST_BASE_MATCH_COL = 8
    COST_BASE_REQUIRED_COLS = COST_BASE_MATCH_COL + 1

    def _safe_str(x):
        if pd.isna(x):
            return ""
        return str(x).strip()

    def _norm_code(v: str) -> str:
        return _safe_str(v).upper()

    def _to_int(x, default=0):
        try:
            if pd.isna(x):
                return default
            return int(float(x))
        except Exception:
            return default

    def _ez_val(html_str):
        s = str(html_str or "")
        # <input ... value='X' ...> → X
        m = re.search(r"<input[^>]+\bvalue=['\"]([^'\"]*)['\"]", s, re.IGNORECASE)
        if m:
            return m.group(1)
        # <a ...>TEXT</a> → TEXT
        m = re.search(r">([^<]+)</a>", s)
        if m:
            return m.group(1).strip()
        # 태그 없으면 그대로
        return re.sub(r"<[^>]+>", "", s).strip()

    def _content_disposition(filename: str) -> str:
        safe_name = (filename or "download.xlsx").replace('"', "")
        ascii_name = "".join(ch if ord(ch) < 128 else "_" for ch in safe_name)
        quoted = urllib.parse.quote(safe_name)
        return f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quoted}"

    def _clean_product_name(v) -> str:
        if v is None:
            return ""
        s = str(v).strip()
        while True:
            ns = re.sub(r"^\s*(\[[^\]]*\]|\([^)]*\)|\{[^}]*\})\s*", "", s)
            if ns == s:
                break
            s = ns.strip()
        while True:
            ns = re.sub(r"\s*\([^)]*\)\s*$", "", s)
            if ns == s:
                break
            s = ns.strip()
        return re.sub(r"\s+", " ", s).strip()

    def _clean_option_text(v) -> str:
        if v is None:
            return ""
        s = str(v).strip()
        parts = [p.strip() for p in s.split("-") if p.strip()]
        return " ".join(parts).strip()

    def _normalize_daily_sales(v) -> str:
        s = _clean_product_name(v)
        s = s.replace("-", " ")
        s = re.sub(r"\s+", " ", s).strip()
        return s.lower()

    def _build_daily_sales_cost_map(path: Path) -> dict[str, object]:
        if not path.exists():
            raise FileNotFoundError(f"원가베이스 파일이 없습니다: {path}")
        wb = load_workbook(path, data_only=True)
        ws = wb.active
        out: dict[str, object] = {}
        for row in ws.iter_rows(min_row=1, values_only=True):
            code = row[COST_BASE_CODE_COL] if len(row) > COST_BASE_CODE_COL else None
            match_name = row[COST_BASE_MATCH_COL] if len(row) > COST_BASE_MATCH_COL else None
            if match_name is None:
                continue
            key = _normalize_daily_sales(match_name)
            if key:
                out[key] = code
        return out

    def _build_daily_sales_rows(ws, skip_header: bool = True) -> list[dict]:
        start_row = 2 if skip_header else 1
        rows: list[dict] = []
        for r in range(start_row, ws.max_row + 1):
            raw_a = ws.cell(row=r, column=1).value
            raw_b = ws.cell(row=r, column=2).value
            raw_d = ws.cell(row=r, column=4).value

            prod = _clean_product_name(raw_a)
            opt = _clean_option_text(raw_b)
            out_a = (f"{prod} {opt}").strip() if opt else prod
            rows.append({"name": out_a, "qty": raw_d})
        return rows

    def _pick_header(value: str | None, fallback: str) -> str:
        v = _safe_str(value)
        return v if v else fallback

    def _build_daily_sales_xls_bytes(
        rows: list[dict],
        headers: list[str],
        include_cols: list[int],
    ) -> bytes:
        book = xlwt.Workbook()
        sheet = book.add_sheet("결과")
        selected_headers = [headers[idx - 1] for idx in include_cols]
        for idx, header in enumerate(selected_headers):
            sheet.write(0, idx, header)

        for i, row in enumerate(rows, start=1):
            selected_values: list[object] = []
            for col_no in include_cols:
                if col_no == 1:
                    selected_values.append(row.get("name", ""))
                elif col_no == 2:
                    selected_values.append(row.get("code", ""))
                elif col_no == 3:
                    selected_values.append(row.get("qty", ""))
            for j, cell_val in enumerate(selected_values):
                sheet.write(i, j, cell_val if cell_val is not None else "")

        buf = io.BytesIO()
        book.save(buf)
        return buf.getvalue()

    def _find_registered_code_variants(conn, normalized_code: str) -> list[dict]:
        rows = conn.execute(
            "SELECT code, qty, created_at, updated_at FROM order_registered_codes"
        ).fetchall()
        out = []
        for r in rows:
            raw_code = _safe_str(r["code"])
            if _norm_code(raw_code) == normalized_code:
                out.append(
                    {
                        "code": raw_code,
                        "qty": int(r["qty"]) if r["qty"] is not None else 0,
                        "created_at": r["created_at"],
                        "updated_at": r["updated_at"],
                    }
                )
        return out

    def _read_cost_base_df(path: Path) -> pd.DataFrame:
        ext = path.suffix.lower()
        if ext in (".xlsx", ".xlsm"):
            return pd.read_excel(path, dtype=str, engine="openpyxl")
        if ext == ".xls":
            try:
                return pd.read_excel(path, dtype=str, engine="xlrd")
            except Exception:
                return pd.read_excel(path, dtype=str)
        return pd.read_excel(path, dtype=str)

    def _read_order_excel_df(path: Path) -> pd.DataFrame:
        ext = path.suffix.lower()
        last_error = None
        if ext in (".xlsx", ".xlsm"):
            # Some files are mislabeled .xlsx but actually old .xls.
            try:
                return pd.read_excel(path, engine="openpyxl")
            except Exception as e:
                last_error = e
                try:
                    return pd.read_excel(path, engine="xlrd")
                except Exception as e2:
                    last_error = e2
        if ext == ".xls":
            try:
                return pd.read_excel(path, engine="xlrd")
            except Exception as e:
                last_error = e
                try:
                    return pd.read_excel(path, engine="openpyxl")
                except Exception as e2:
                    last_error = e2
        else:
            try:
                return pd.read_excel(path)
            except Exception as e:
                last_error = e

        # Legacy case: files saved as .xls but actual content is HTML table.
        try:
            html_tables = pd.read_html(path)
            if html_tables:
                return html_tables[0]
        except Exception as e:
            last_error = e

        raise ValueError(f"엑셀 형식을 읽을 수 없습니다. 파일 형식 또는 손상 여부를 확인하세요. ({last_error})")

    def _load_cost_base_items(path: Path) -> list[dict]:
        if not path.exists():
            return []
        df = _read_cost_base_df(path)
        if df.shape[1] < COST_BASE_REQUIRED_COLS:
            return []
        codes = df.iloc[:, COST_BASE_CODE_COL].map(_safe_str).tolist()
        names = df.iloc[:, COST_BASE_MATCH_COL].map(_safe_str).tolist()
        out = []
        for code, name in zip(codes, names):
            if not code:
                continue
            out.append({"name": name, "code": code})
        return out

    def _load_cost_base_name_map(path: Path) -> dict[str, str]:
        items = _load_cost_base_items(path)
        m: dict[str, str] = {}
        for it in items:
            code = _norm_code(it.get("code", ""))
            name = it.get("name", "")
            if code and code not in m:
                m[code] = name
        return m

    @router.get("/order/status")
    def order_status(admin: str = Depends(require_admin)):
        conn = get_db()
        count_row = conn.execute("SELECT COUNT(*) AS cnt FROM order_registered_codes").fetchone()
        conn.close()
        return {
            "ok": True,
            "registered_count": int(count_row["cnt"]) if count_row else 0,
            "cost_base_path": str(order_cost_base_path),
            "cost_base_exists": order_cost_base_path.exists(),
        }

    @router.get("/order/cost-base/search")
    def order_cost_base_search(
        q: str = "",
        limit: int = 20,
        admin: str = Depends(require_admin),
    ):
        q_norm = (q or "").strip().lower()
        if limit <= 0 or limit > 100:
            limit = 20
        items = _load_cost_base_items(order_cost_base_path)
        if q_norm:
            items = [
                it
                for it in items
                if q_norm in (it.get("name", "").lower()) or q_norm in (it.get("code", "").lower())
            ]
        # code 기준 dedupe
        seen = set()
        out = []
        for it in items:
            code = it.get("code", "")
            if not code or code in seen:
                continue
            seen.add(code)
            out.append(it)
            if len(out) >= limit:
                break
        return {"ok": True, "items": out}

    @router.get("/order/registered/list")
    def order_registered_list(admin: str = Depends(require_admin)):
        name_map = _load_cost_base_name_map(order_cost_base_path)
        conn = get_db()
        rows = conn.execute(
            "SELECT code, qty, created_at, updated_at FROM order_registered_codes ORDER BY code ASC"
        ).fetchall()
        conn.close()
        merged: dict[str, dict] = {}
        for r in rows:
            code = _norm_code(r["code"])
            if not code:
                continue
            item = {
                "code": code,
                "name": name_map.get(code, ""),
                "qty": int(r["qty"]) if r["qty"] is not None else 0,
                "created_at": r["created_at"],
                "updated_at": r["updated_at"],
            }
            prev = merged.get(code)
            if not prev:
                merged[code] = item
                continue
            prev_updated = _safe_str(prev.get("updated_at"))
            cur_updated = _safe_str(item.get("updated_at"))
            if cur_updated >= prev_updated:
                merged[code] = item
        items = [merged[k] for k in sorted(merged.keys())]
        return {"ok": True, "items": items}

    @router.post("/order/registered/upsert")
    def order_registered_upsert(payload: dict = Body(...), admin: str = Depends(require_admin)):
        code = _norm_code(payload.get("code") or "")
        qty = payload.get("qty")
        if not code:
            raise HTTPException(status_code=400, detail="code가 필요합니다.")
        try:
            qty_i = int(float(str(qty).strip()))
        except Exception:
            raise HTTPException(status_code=400, detail="qty는 숫자여야 합니다.")
        if qty_i < 0:
            raise HTTPException(status_code=400, detail="qty는 0 이상이어야 합니다.")

        now = pd.Timestamp.utcnow().isoformat()
        conn = get_db()
        variants = _find_registered_code_variants(conn, code)
        created_at = now
        if variants:
            created_at_candidates = [_safe_str(v.get("created_at")) for v in variants if _safe_str(v.get("created_at"))]
            if created_at_candidates:
                created_at = min(created_at_candidates)
            for v in variants:
                conn.execute("DELETE FROM order_registered_codes WHERE code = ?", (_safe_str(v["code"]),))
        conn.execute(
            """
            INSERT INTO order_registered_codes (code, qty, created_at, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(code) DO UPDATE SET
                qty = excluded.qty,
                updated_at = excluded.updated_at
            """,
            (code, qty_i, created_at, now),
        )
        conn.commit()
        conn.close()
        return {"ok": True, "code": code, "qty": qty_i}

    @router.post("/order/registered/add")
    def order_registered_add(payload: dict = Body(...), admin: str = Depends(require_admin)):
        code = _norm_code(payload.get("code") or "")
        qty = payload.get("qty")
        if not code:
            raise HTTPException(status_code=400, detail="code가 필요합니다.")
        try:
            qty_i = int(float(str(qty).strip()))
        except Exception:
            raise HTTPException(status_code=400, detail="qty는 숫자여야 합니다.")
        if qty_i < 0:
            raise HTTPException(status_code=400, detail="qty는 0 이상이어야 합니다.")

        now = pd.Timestamp.utcnow().isoformat()
        conn = get_db()
        variants = _find_registered_code_variants(conn, code)
        if variants:
            conn.close()
            raise HTTPException(status_code=409, detail="이미 등록된 코드입니다.")

        conn.execute(
            "INSERT INTO order_registered_codes (code, qty, created_at, updated_at) VALUES (?, ?, ?, ?)",
            (code, qty_i, now, now),
        )
        conn.commit()
        conn.close()
        return {"ok": True, "code": code, "qty": qty_i}

    @router.delete("/order/registered/{code}")
    def order_registered_delete(code: str, admin: str = Depends(require_admin)):
        code = _norm_code(code or "")
        if not code:
            raise HTTPException(status_code=400, detail="code가 비어있음")
        conn = get_db()
        variants = _find_registered_code_variants(conn, code)
        if variants:
            for v in variants:
                conn.execute("DELETE FROM order_registered_codes WHERE code = ?", (_safe_str(v["code"]),))
        else:
            conn.execute("DELETE FROM order_registered_codes WHERE code = ?", (code,))
        conn.commit()
        conn.close()
        return {"ok": True}

    @router.delete("/order/registered")
    def order_registered_delete_query(code: str = "", admin: str = Depends(require_admin)):
        code = _norm_code(code or "")
        if not code:
            raise HTTPException(status_code=400, detail="code가 비어있음")
        conn = get_db()
        variants = _find_registered_code_variants(conn, code)
        if variants:
            for v in variants:
                conn.execute("DELETE FROM order_registered_codes WHERE code = ?", (_safe_str(v["code"]),))
        else:
            conn.execute("DELETE FROM order_registered_codes WHERE code = ?", (code,))
        conn.commit()
        conn.close()
        return {"ok": True}

    @router.post("/order/check")
    async def order_check(file: UploadFile = File(...), admin: str = Depends(require_admin)):
        ext = Path(file.filename or "").suffix.lower()
        if ext not in {".xlsx", ".xls", ".xlsm"}:
            raise HTTPException(status_code=400, detail="xls/xlsx/xlsm만 업로드 가능합니다.")

        data = await file.read()
        if not data:
            raise HTTPException(status_code=400, detail="업로드 파일이 비어 있습니다.")
        tmp = Path(tempfile.gettempdir()) / f"__order_check_{uuid.uuid4().hex}.xlsx"
        tmp.write_bytes(data)
        try:
            try:
                df = _read_order_excel_df(tmp)
            except Exception as e:
                raise HTTPException(status_code=400, detail=str(e))
        finally:
            try:
                tmp.unlink(missing_ok=True)
            except Exception:
                pass

        if df.shape[1] < 10:
            raise HTTPException(status_code=400, detail="업로드 엑셀에 J열까지(최소 10개 컬럼) 필요합니다.")

        conn = get_db()
        rows = conn.execute("SELECT code, qty FROM order_registered_codes").fetchall()
        conn.close()
        reg = {_norm_code(r["code"]): int(r["qty"]) for r in rows if _norm_code(r["code"])}

        col_b = df.iloc[:, 1]
        col_c = df.iloc[:, 2]
        col_e = df.iloc[:, 4]
        col_f = df.iloc[:, 5]
        col_j = df.iloc[:, 9]

        results = []
        for i in range(len(df)):
            code = _norm_code(col_j.iloc[i])
            if not code:
                continue
            if code not in reg:
                continue

            actual_qty = _to_int(col_e.iloc[i], 0)
            received_qty = _to_int(col_f.iloc[i], 0)
            need_qty = int(reg[code])
            shortage = (received_qty - actual_qty) + need_qty
            if shortage == 0 and actual_qty < need_qty:
                name = f"{_safe_str(col_b.iloc[i])} {_safe_str(col_c.iloc[i])}".strip()
                results.append(
                    {
                        "code": code,
                        "name": name,
                        "received_qty": received_qty,
                        "need_qty": need_qty,
                        "actual_qty": actual_qty,
                        "shortage": shortage,
                        "text": f"{name} {shortage}  (부족)",
                    }
                )

        return {"ok": True, "count": len(results), "results": results}

    @router.post("/order/daily-sales/preview")
    async def order_daily_sales_preview(
        file: UploadFile = File(...),
        skip_header: bool = Form(True),
        admin: str = Depends(require_admin),
    ):
        ext = Path(file.filename or "").suffix.lower()
        if ext not in {".xlsx", ".xlsm"}:
            raise HTTPException(status_code=400, detail="xlsx/xlsm만 업로드 가능합니다.")
        if not order_cost_base_path.exists():
            raise HTTPException(status_code=400, detail=f"원가베이스 파일이 없습니다: {order_cost_base_path}")

        raw = await file.read()
        if not raw:
            raise HTTPException(status_code=400, detail="업로드 파일이 비어 있습니다.")

        tmp = Path(tempfile.gettempdir()) / f"__order_daily_sales_{uuid.uuid4().hex}{ext}"
        tmp.write_bytes(raw)
        try:
            try:
                in_wb = load_workbook(tmp, data_only=True)
            except Exception as e:
                raise HTTPException(status_code=400, detail=f"입력 파일 로드 실패: {e}")
        finally:
            try:
                tmp.unlink(missing_ok=True)
            except Exception:
                pass

        in_ws = in_wb.active
        cost_map = _build_daily_sales_cost_map(order_cost_base_path)
        base_rows = _build_daily_sales_rows(in_ws, skip_header=skip_header)

        rows: list[dict] = []
        unmatched_products: list[str] = []
        unmatched_rows = 0
        seen_unmatched: set[str] = set()
        for row in base_rows:
            code = cost_map.get(_normalize_daily_sales(row.get("name", "")), "")
            code_text = _safe_str(code)
            enriched = {"name": row.get("name", ""), "code": code_text, "qty": row.get("qty")}
            rows.append(enriched)
            if code_text:
                continue
            unmatched_rows += 1
            name = _safe_str(row.get("name"))
            if name and name not in seen_unmatched:
                seen_unmatched.add(name)
                unmatched_products.append(name)

        return {
            "ok": True,
            "count": len(rows),
            "unmatched_row_count": unmatched_rows,
            "unmatched_product_count": len(unmatched_products),
            "unmatched_products": unmatched_products,
            "rows": rows,
        }

    @router.post("/order/daily-sales/export")
    async def order_daily_sales_export(
        file: UploadFile = File(...),
        skip_header: bool = Form(True),
        header_col1: str = Form("상품명"),
        header_col2: str = Form("상품코드"),
        header_col3: str = Form("옵션추가항목8"),
        include_col1: bool = Form(True),
        include_col2: bool = Form(True),
        include_col3: bool = Form(True),
        admin: str = Depends(require_admin),
    ):
        ext = Path(file.filename or "").suffix.lower()
        if ext not in {".xlsx", ".xlsm"}:
            raise HTTPException(status_code=400, detail="xlsx/xlsm만 업로드 가능합니다.")
        if not order_cost_base_path.exists():
            raise HTTPException(status_code=400, detail=f"원가베이스 파일이 없습니다: {order_cost_base_path}")

        raw = await file.read()
        if not raw:
            raise HTTPException(status_code=400, detail="업로드 파일이 비어 있습니다.")

        tmp = Path(tempfile.gettempdir()) / f"__order_daily_sales_export_{uuid.uuid4().hex}{ext}"
        tmp.write_bytes(raw)
        try:
            try:
                in_wb = load_workbook(tmp, data_only=True)
            except Exception as e:
                raise HTTPException(status_code=400, detail=f"입력 파일 로드 실패: {e}")
        finally:
            try:
                tmp.unlink(missing_ok=True)
            except Exception:
                pass

        in_ws = in_wb.active
        cost_map = _build_daily_sales_cost_map(order_cost_base_path)
        base_rows = _build_daily_sales_rows(in_ws, skip_header=skip_header)
        rows: list[dict] = []
        for row in base_rows:
            code = cost_map.get(_normalize_daily_sales(row.get("name", "")), "")
            rows.append(
                {
                    "name": row.get("name", ""),
                    "code": _safe_str(code),
                    "qty": row.get("qty"),
                }
            )

        headers = [
            _pick_header(header_col1, "상품명"),
            _pick_header(header_col2, "상품코드"),
            _pick_header(header_col3, "옵션추가항목8"),
        ]
        include_cols: list[int] = []
        if include_col1:
            include_cols.append(1)
        if include_col2:
            include_cols.append(2)
        if include_col3:
            include_cols.append(3)
        if not include_cols:
            raise HTTPException(status_code=400, detail="다운로드할 열을 최소 1개 선택하세요.")

        content = _build_daily_sales_xls_bytes(rows, headers, include_cols)
        src_name = Path(file.filename or "daily_sales.xlsx").stem
        filename = f"{src_name}_일일판매량_가공본.xls"
        headers_resp = {"Content-Disposition": _content_disposition(filename)}
        return Response(
            content=content,
            media_type="application/vnd.ms-excel",
            headers=headers_resp,
        )

    @router.post("/order/daily-sales/process")
    async def order_daily_sales_process(
        file: UploadFile = File(...),
        skip_header: bool = Form(True),
        admin: str = Depends(require_admin),
    ):
        return await order_daily_sales_export(
            file=file,
            skip_header=skip_header,
            header_col1="상품명",
            header_col2="상품코드",
            header_col3="옵션추가항목8",
            include_col1=True,
            include_col2=True,
            include_col3=True,
            admin=admin,
        )

    # ── 메인발주 목록 (EZAdmin IO30 미출고/부족 상품 조회) ───────────────────────
    @router.post("/order/main-order/list")
    async def main_order_list(admin: str = Depends(require_admin)):
        phpsessid = (get_setting(_EZADMIN_SESSION_KEY) or "").strip()
        if not phpsessid:
            return {"ok": False, "need_session": True}

        today = datetime.now()
        start = (today - timedelta(days=90)).strftime("%Y-%m-%d")
        end = today.strftime("%Y-%m-%d")

        par = (
            "template=IO30&action=&page_code=IO00&search=1&now_page=&is_sort=&"
            "_sort=supply_options&sort_order=1&product_qty_list=&bill_seq=&"
            "offset_top=&work_no=&location_str=&date_type=collect_date&"
            f"start_date={start}&start_hour=00%3A00%3A00&"
            f"end_date={end}&end_hour=23%3A59%3A59&"
            "date_period_sel=9&multi_shop_group=&multi_shop=&str_shop_code=0&"
            "multi_supply_group=&multi_supply=&str_supply_code=0&"
            "supply_name_search=&brand=&supply_options=&tags_string=&"
            "product_tag_include_type=1&product_id=&name=&options=&"
            "search_keyword_type=origin&search_keyword=&enable_stock_type=2&"
            "order_status=3&except_soldout=1&sel_reserve_qty=none&"
            "sel_return_qty=none&sel_lack_qty=none&sel_req_qty=none&category=0"
        )

        cookies = {"PHPSESSID": phpsessid}
        ez_headers = {
            "X-Requested-With": "XMLHttpRequest",
            "Referer": "https://ga80.ezadmin.co.kr/template40.htm?template=IO30",
        }
        base_url = f"{_EZADMIN_BASE}/function.htm"

        items = []
        try:
            async with httpx.AsyncClient(timeout=60.0, verify=False, follow_redirects=True) as client:
                page = 1
                while True:
                    nd = str(int(datetime.now().timestamp() * 1000))
                    resp = await client.post(
                        base_url,
                        data={
                            "_search": "false", "nd": nd, "rows": "1000", "page": str(page),
                            "sidx": "", "sord": "asc", "template": "IO30", "action": "search_IO30",
                            "par": par,
                        },
                        cookies=cookies, headers=ez_headers,
                    )
                    if resp.status_code >= 400:
                        return {"ok": False, "error": f"EZAdmin 조회 실패 (HTTP {resp.status_code})"}
                    try:
                        data = resp.json()
                    except Exception:
                        return {"ok": False, "need_session": True}
                    if "rows" not in data:
                        return {"ok": False, "need_session": True}

                    for row in data.get("rows") or []:
                        cell = row.get("cell", row)
                        items.append({
                            "code": _ez_val(cell.get("product_id")),
                            "name": _ez_val(cell.get("product_name")),
                            "options": _ez_val(cell.get("options")),
                            "supplyProductName": _ez_val(cell.get("supply_product_name")),
                            "stock": _to_int(_ez_val(cell.get("stock"))),
                            "notYetDeliv": _to_int(_ez_val(cell.get("not_yet_deliv"))),
                            "lackQty": _to_int(_ez_val(cell.get("lack_qty"))),
                            "requestQty": _to_int(_ez_val(cell.get("request_qty"))),
                        })

                    total_pages = int(data.get("total") or 1)
                    if page >= total_pages or page >= 20:
                        break
                    page += 1
        except Exception as exc:
            return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}

        return {"ok": True, "count": len(items), "items": items}

    return router
