import asyncio
import tempfile
import traceback
import uuid
from collections import Counter
from datetime import datetime
from pathlib import Path
import json
import re

import httpx
import xlwt
from fastapi import APIRouter, Body, Depends, File, HTTPException, Response, UploadFile
from openpyxl import load_workbook
from api.amood_hapbae import SHARED_COST_BASE_PATH
from services.easyadmin_product import process_easyadmin_product_from_api

_ABLY_BASE     = "https://api.a-bly.com"
_ABLY_EMAIL    = "eostm1997@naver.com"
_ABLY_PASSWORD = "!Glqgkqdldi1126"


def build_barcode_router(
    *,
    get_current_user,
    get_barcode_state,
    to_int,
    process_and_load_any,
    load_excel_any,
    normalize_to_yusas,
    process_easyadmin_product_upload,
    content_disposition,
    get_shared_incoming_counts,
    set_shared_incoming_counts,
    get_shared_defect_counts,
    set_shared_defect_counts,
    set_shared_barcode_data,
    get_setting,
    set_setting,
):
    router = APIRouter()
    defect_base_path = SHARED_COST_BASE_PATH
    defect_base_default_headers = ["상품코드", "상품명", "공급처", "공급처상품명", "색상 사이즈", "주소", "표시형 상품명"]
    defect_base_cache = {"mtime": None, "headers": None, "rows": None, "lookup": None}
    defect_base_columns = {
        "code": 1,
        "name": 2,
        "color": 3,
        "size": 4,
        "vendor": 6,
        "vendor_product": 7,
        "display_name": 9,
        "address": 10,
    }
    hapbae_target_shop = "에이블리(유색)"
    hapbae_checked_rows_key = "test_hapbae_checked_rows"

    def _normalize_text(value) -> str:
        return re.sub(r"\s+", " ", str(value or "")).strip()

    def _normalize_shop_name(value) -> str:
        text = str(value or "")
        text = text.replace("（", "(").replace("）", ")")
        text = re.sub(r"[\s\u00a0\u200b-\u200d\ufeff]+", "", text)
        return text.strip().casefold()

    def _normalize_header(value) -> str:
        return re.sub(r"\s+", "", str(value or "")).strip().casefold()

    def _find_header_col(headers: list, aliases: list[str], fallback: int) -> int:
        normalized_aliases = [_normalize_header(alias) for alias in aliases]
        for idx, header in enumerate(headers, start=1):
            normalized_header = _normalize_header(header)
            if normalized_header and any(alias and alias in normalized_header for alias in normalized_aliases):
                return idx
        return fallback

    def _get_hapbae_checked_rows() -> dict[str, bool]:
        raw = get_setting(hapbae_checked_rows_key) or "{}"
        try:
            parsed = json.loads(raw)
        except Exception:
            parsed = {}
        if not isinstance(parsed, dict):
            return {}
        clean = {}
        for key, value in parsed.items():
            if isinstance(key, str) and key.strip() and value:
                clean[key.strip()] = True
        return clean

    def _set_hapbae_checked_rows(checked_rows: dict[str, bool]):
        clean = {
            key.strip(): True
            for key, value in checked_rows.items()
            if isinstance(key, str) and key.strip() and value
        }
        set_setting(hapbae_checked_rows_key, json.dumps(clean, ensure_ascii=False))
        return clean

    def _clear_hapbae_checked_rows():
        return _set_hapbae_checked_rows({})

    def _extract_hapbae_pre_match_rows(path: Path) -> list[dict]:
        wb, ws = load_excel_any(path)
        try:
            headers = [ws.cell(1, col).value for col in range(1, ws.max_column + 1)]
            code_col = _find_header_col(headers, ["상품코드", "바코드", "barcode", "code", "sku", "품번"], 8)
            name_col = _find_header_col(headers, ["상품명", "품명", "product", "name"], 9)
            option_col = _find_header_col(headers, ["옵션", "option", "옵션명"], 10)
            qty_col = _find_header_col(headers, ["수량", "주문수량", "qty", "quantity", "개수"], 11)
            rows = []
            for row_idx in range(2, ws.max_row + 1):
                raw_code = ws.cell(row_idx, code_col).value
                code = normalize_to_yusas(raw_code)
                duplicate_key = _normalize_text(ws.cell(row_idx, 13).value)
                shop = _normalize_text(ws.cell(row_idx, 4).value)
                if not duplicate_key and not shop and not code:
                    continue
                rows.append({
                    "rowNumber": row_idx,
                    "shop": shop,
                    "duplicateKey": duplicate_key,
                    "code": code,
                    "productName": _normalize_text(ws.cell(row_idx, name_col).value),
                    "optionName": _normalize_text(ws.cell(row_idx, option_col).value),
                    "orderQty": _normalize_text(ws.cell(row_idx, qty_col).value),
                })
            return rows
        finally:
            try:
                wb.close()
            except Exception:
                pass

    def _csv_escape(value) -> str:
        return '"' + str(value or "").replace('"', '""') + '"'

    def _normalize_defect_base_row(row) -> list[str]:
        cells = list(row[:7]) if row else []
        while len(cells) < 7:
            cells.append("")
        return [str(cell or "").strip() for cell in cells[:7]]

    def _ws_text(ws, row_idx: int, col_idx: int) -> str:
        return str(ws.cell(row_idx, col_idx).value or "").strip()

    def _combine_color_size(color: str, size: str) -> str:
        return " ".join(part for part in [str(color or "").strip(), str(size or "").strip()] if part).strip()

    def _split_color_size(value: str) -> tuple[str, str]:
        text = str(value or "").strip()
        if not text:
            return "", ""
        parts = text.split(maxsplit=1)
        if len(parts) == 1:
            return parts[0], ""
        return parts[0], parts[1]

    def _defect_base_virtual_row_from_sheet(ws, row_idx: int) -> list[str]:
        return [
            _ws_text(ws, row_idx, defect_base_columns["code"]),
            _ws_text(ws, row_idx, defect_base_columns["name"]),
            _ws_text(ws, row_idx, defect_base_columns["vendor"]),
            _ws_text(ws, row_idx, defect_base_columns["vendor_product"]),
            _combine_color_size(
                _ws_text(ws, row_idx, defect_base_columns["color"]),
                _ws_text(ws, row_idx, defect_base_columns["size"]),
            ),
            _ws_text(ws, row_idx, defect_base_columns["address"]),
            _ws_text(ws, row_idx, defect_base_columns["display_name"]),
        ]

    def _write_defect_base_virtual_row(ws, row_idx: int, cells: list[str]):
        color, size = _split_color_size(cells[4] if len(cells) > 4 else "")
        ws.cell(row_idx, defect_base_columns["code"], cells[0] if len(cells) > 0 else "")
        ws.cell(row_idx, defect_base_columns["name"], cells[1] if len(cells) > 1 else "")
        ws.cell(row_idx, defect_base_columns["vendor"], cells[2] if len(cells) > 2 else "")
        ws.cell(row_idx, defect_base_columns["vendor_product"], cells[3] if len(cells) > 3 else "")
        ws.cell(row_idx, defect_base_columns["color"], color)
        ws.cell(row_idx, defect_base_columns["size"], size)
        ws.cell(row_idx, defect_base_columns["address"], cells[5] if len(cells) > 5 else "")
        ws.cell(row_idx, defect_base_columns["display_name"], cells[6] if len(cells) > 6 else "")

    def _invalidate_defect_base_cache():
        defect_base_cache["mtime"] = None
        defect_base_cache["headers"] = None
        defect_base_cache["rows"] = None
        defect_base_cache["lookup"] = None

    def _load_defect_base_sheet():
        if not defect_base_path.exists():
            raise HTTPException(status_code=404, detail=f"Defect base file not found: {defect_base_path}")
        wb = load_workbook(defect_base_path)
        ws = wb[wb.sheetnames[0]]
        return wb, ws

    def _read_defect_base_table():
        mtime = defect_base_path.stat().st_mtime if defect_base_path.exists() else None
        if (
            defect_base_cache["rows"] is not None
            and defect_base_cache["headers"] is not None
            and defect_base_cache["mtime"] == mtime
        ):
            return defect_base_cache["headers"], defect_base_cache["rows"]

        wb, ws = _load_defect_base_sheet()
        try:
            headers = defect_base_default_headers[:]
            rows = []
            for row_idx in range(2, ws.max_row + 1):
                cells = _defect_base_virtual_row_from_sheet(ws, row_idx)
                if any(cells):
                    rows.append({"row_index": row_idx, "values": cells})
            defect_base_cache["mtime"] = mtime
            defect_base_cache["headers"] = headers
            defect_base_cache["rows"] = rows
            defect_base_cache["lookup"] = None
            return headers, rows
        finally:
            wb.close()

    def _build_defect_base_lookup():
        if not defect_base_path.exists():
            return {}

        mtime = defect_base_path.stat().st_mtime if defect_base_path.exists() else None
        if defect_base_cache["lookup"] is not None and defect_base_cache["mtime"] == mtime:
            return defect_base_cache["lookup"]

        _, rows = _read_defect_base_table()
        lookup = {}
        for row in rows:
            values = row["values"]
            raw_code = values[0]
            normalized_code = normalize_to_yusas(raw_code) or raw_code.strip()
            if normalized_code:
                lookup[normalized_code] = {
                    "a": values[0],
                    "b": values[1],
                    "c": values[2],
                    "d": values[3],
                    "e": values[4],
                    "f": values[5],
                    "g": values[6],
                }
        defect_base_cache["lookup"] = lookup
        return lookup

    def _get_item_detail_lookup(state) -> dict[str, dict]:
        cached = state.get("_detail_lookup")
        if cached is not None:
            return cached

        lookup = {}
        details = state.get("details") or {}
        for codes in details.values():
            for code, det in codes.items():
                if code not in lookup:
                    lookup[code] = {
                        "name": det.get("name", "") or "",
                        "option": det.get("option", "") or "",
                    }
        state["_detail_lookup"] = lookup
        return lookup

    def _normalize_invoice_value(value: str | None) -> str:
        raw = str(value or "").strip().upper()
        if not raw:
            return ""
        raw = re.sub(r"\s+", "", raw)
        raw = re.sub(r"\.0+$", "", raw)
        if raw.isdigit():
            return raw
        m = re.fullmatch(r"(SB\d+)\.0+", raw)
        if m:
            return m.group(1)
        return raw

    def _get_invoice_lookup(state) -> dict[str, str]:
        cached = state.get("_invoice_lookup")
        if cached is not None:
            return cached

        lookup = {}
        for invoice in (state.get("mapping") or {}).keys():
            normalized = _normalize_invoice_value(invoice)
            if normalized and normalized not in lookup:
                lookup[normalized] = invoice
        state["_invoice_lookup"] = lookup
        return lookup

    def _resolve_invoice_key(state, invoice: str) -> str | None:
        if invoice in (state.get("mapping") or {}):
            return invoice
        normalized = _normalize_invoice_value(invoice)
        if not normalized:
            return None
        return _get_invoice_lookup(state).get(normalized)

    def _get_all_items(state, inv: str):
        mapping = state["mapping"]
        if inv not in mapping:
            return []

        codes = state["invoice_order"].get(inv) if state["invoice_order"] and inv in state["invoice_order"] else None
        if not codes:
            codes = sorted(mapping[inv].keys())

        incoming_counts = get_shared_incoming_counts() or {}
        defect_counts = get_shared_defect_counts()
        details = (state.get("details") or {}).get(inv, {})
        runs = (state.get("runs") or {}).get(inv, {})
        items = []
        for code in codes:
            det = details.get(code, {})
            items.append(
                {
                    "code": code,
                    "name": det.get("name", "") or "",
                    "option": det.get("option", "") or "",
                    "remain": mapping[inv].get(code, 0),
                    "run_len": runs.get(code, 0),
                    "defect": defect_counts.get(code, 0),
                    "incoming": incoming_counts.get(code, 0),
                }
            )
        return items

    def _get_first_remaining_item(state, inv: str | None):
        if not inv:
            return None
        for item in _get_all_items(state, inv):
            if item.get("remain", 0) > 0:
                return item
        return None

    def _get_next_item_preview(state, current_invoice: str | None):
        seq = state.get("invoice_seq") or []
        if not seq:
            return None

        last_code = state.get("last_scanned_code")
        start_idx = seq.index(current_invoice) if current_invoice in seq else -1
        for i in range(start_idx + 1, len(seq)):
            inv = seq[i]
            item = _get_first_remaining_item(state, inv)
            if not item:
                continue
            if item.get("run_len", 0) >= 10:
                continue
            if last_code and item.get("code") == last_code:
                continue
            return {"invoice": inv, **item}
        return None

    def _invoice_has_defect(state, inv: str | None):
        if not inv:
            return False
        mapping = state.get("mapping") or {}
        if inv not in mapping:
            return False
        defect_counts = get_shared_defect_counts()
        return any(defect_counts.get(code, 0) > 0 for code in mapping[inv].keys())

    def _find_item_detail_by_code(state, code: str):
        return _get_item_detail_lookup(state).get(code, {"name": "", "option": ""})

    def _get_defect_list(state):
        defect_counts = get_shared_defect_counts()
        defect_base_lookup = _build_defect_base_lookup()
        rows = []
        for code, count in sorted(defect_counts.items()):
            det = _find_item_detail_by_code(state, code)
            base_row = defect_base_lookup.get(code, {})
            rows.append(
                {
                    "code": code,
                    "count": count,
                    "name": det.get("name", ""),
                    "option": det.get("option", ""),
                    "base_vendor": base_row.get("c", ""),
                    "base_product": base_row.get("d", ""),
                    "base_color": base_row.get("e", ""),
                    "base_addr": base_row.get("f", ""),
                    "base_name": base_row.get("g", ""),
                    "base_option": " " if base_row.get("g", "") else "",
                }
            )
        return rows

    def _build_defect_csv(state) -> str:
        defect_counts = get_shared_defect_counts()
        defect_base_lookup = _build_defect_base_lookup()
        lines = ["vendor,product,color,count,address"]
        for code, count in sorted(defect_counts.items()):
            det = _find_item_detail_by_code(state, code)
            base_row = defect_base_lookup.get(code, {})
            row = [
                base_row.get("c") or det.get("name", "") or "",
                base_row.get("d") or "",
                base_row.get("e") or det.get("option", "") or "",
                str(count),
                base_row.get("f") or "",
            ]
            lines.append(",".join(_csv_escape(value) for value in row))
        return "\n".join(lines) + "\n"

    def _to_s_code(code: str) -> str:
        value = str(code or "").strip()
        return f"S{value[5:]}" if value.startswith("YUSAS") else value

    def _build_defect_xls_bytes() -> bytes:
        defect_counts = get_shared_defect_counts()
        book = xlwt.Workbook()
        sheet = book.add_sheet("defects")
        header_style = xlwt.easyxf("font: bold on; align: horiz center;")
        sheet.write(0, 0, "상품코드", header_style)
        sheet.write(0, 1, "작업수량", header_style)
        sheet.write(0, 2, "메모", header_style)
        for row_idx, (code, count) in enumerate(sorted(defect_counts.items()), start=1):
            sheet.write(row_idx, 0, _to_s_code(code))
            sheet.write(row_idx, 1, int(count or 0))
            sheet.write(row_idx, 2, "불량")
        sheet.col(0).width = 20 * 256
        sheet.col(1).width = 12 * 256
        sheet.col(2).width = 16 * 256
        buf = tempfile.SpooledTemporaryFile()
        book.save(buf)
        buf.seek(0)
        data = buf.read()
        buf.close()
        return data

    @router.post("/barcode/upload")
    async def barcode_upload(file: UploadFile = File(...), user: str = Depends(get_current_user)):
        name = (file.filename or "").lower()
        if not (name.endswith(".xls") or name.endswith(".xlsx")):
            raise HTTPException(status_code=400, detail="Only xls/xlsx files are allowed")

        suffix = ".xlsx" if name.endswith(".xlsx") else ".xls"
        tmp_path = Path(tempfile.gettempdir()) / f"yusaek_upload_{uuid.uuid4().hex}{suffix}"
        data = await file.read()
        tmp_path.write_bytes(data)

        try:
            hapbae_pre_match_rows = _extract_hapbae_pre_match_rows(tmp_path)
            result = process_and_load_any(tmp_path)
            if len(result) == 7:
                processed_path, mapping, details, runs, invoice_order, invoice_seq, code_o_text = result
            elif len(result) == 6:
                mapping, details, runs, invoice_order, invoice_seq, code_o_text = result
                processed_path = None
            else:
                raise RuntimeError(f"unexpected return count: {len(result)}")
        except Exception as exc:
            traceback.print_exc()
            raise HTTPException(status_code=500, detail=f"Barcode upload processing failed: {exc}")

        set_shared_barcode_data(
            {
                "loaded": True,
                "processed_path": str(processed_path) if processed_path else None,
                "mapping": mapping,
                "details": details,
                "runs": runs,
                "invoice_order": invoice_order,
                "invoice_seq": invoice_seq,
                "code_o_text": code_o_text,
                "hapbae_pre_match_rows": hapbae_pre_match_rows,
                "_detail_lookup": None,
                "_invoice_lookup": None,
            }
        )
        _clear_hapbae_checked_rows()
        return {"ok": True, "invoices": len(mapping), "codes_total": sum(len(v) for v in mapping.values())}

    @router.post("/barcode/incoming/upload")
    async def incoming_upload(file: UploadFile = File(...), user: str = Depends(get_current_user)):
        name = (file.filename or "").lower()
        if not (name.endswith(".xls") or name.endswith(".xlsx")):
            raise HTTPException(status_code=400, detail="Only xls/xlsx files are allowed")

        suffix = ".xlsx" if name.endswith(".xlsx") else ".xls"
        tmp_path = Path(tempfile.gettempdir()) / f"yusaek_incoming_{uuid.uuid4().hex}{suffix}"
        data = await file.read()
        tmp_path.write_bytes(data)

        try:
            wb, ws = load_excel_any(tmp_path)
            counts = Counter()
            for r in range(1, ws.max_row + 1):
                code = normalize_to_yusas(ws.cell(r, 1).value)
                qty = to_int(ws.cell(r, 2).value, default=0)
                if code and qty > 0:
                    counts[code] += qty
        except Exception as exc:
            traceback.print_exc()
            raise HTTPException(status_code=500, detail=f"Incoming file load failed: {exc}")

        set_shared_incoming_counts(dict(counts))
        return {"ok": True, "codes": len(counts), "total_qty": sum(counts.values())}

    @router.post("/barcode/product/upload")
    async def easyadmin_product_upload(file: UploadFile = File(...), user: str = Depends(get_current_user)):
        name = (file.filename or "").lower()
        if not (name.endswith(".xls") or name.endswith(".xlsx") or name.endswith(".csv")):
            raise HTTPException(status_code=400, detail="Only xls/xlsx/csv files are allowed")

        suffix = Path(name).suffix or ".xlsx"
        tmp_path = Path(tempfile.gettempdir()) / f"yusaek_easyadmin_{uuid.uuid4().hex}{suffix}"
        data = await file.read()
        tmp_path.write_bytes(data)

        try:
            xls_bytes = process_easyadmin_product_upload(tmp_path)
        except Exception as exc:
            traceback.print_exc()
            raise HTTPException(status_code=500, detail=f"Product upload processing failed: {exc}")

        filename = f"easyadmin_products_{datetime.now().strftime('%Y%m%d_%H%M%S')}.xls"
        headers = {"Content-Disposition": content_disposition(filename)}
        return Response(content=xls_bytes, media_type="application/vnd.ms-excel", headers=headers)

    @router.post("/barcode/product/upload-from-api")
    async def product_upload_from_api(
        payload: dict = Body(default={}),
        user: str = Depends(get_current_user),
    ):
        start_date = payload.get("start_date", "")
        end_date   = payload.get("end_date", "")

        async with httpx.AsyncClient(timeout=15.0) as client:
            res = await client.post(
                f"{_ABLY_BASE}/seller/login/",
                json={"email": _ABLY_EMAIL, "password": _ABLY_PASSWORD},
                headers={
                    "Content-Type": "application/json",
                    "Origin": "https://seller-admin.a-bly.com",
                    "Referer": "https://seller-admin.a-bly.com/",
                    "User-Agent": "Mozilla/5.0",
                },
            )
            if not res.is_success:
                raise HTTPException(status_code=502, detail="에이블리 로그인 실패")
        token = res.json().get("token")
        if not token:
            raise HTTPException(status_code=502, detail="에이블리 로그인 실패: 토큰 없음")

        ably_headers = {
            "Authorization": f"JWT {token}",
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Origin": "https://seller-admin.a-bly.com",
            "Referer": "https://seller-admin.a-bly.com/",
            "User-Agent": "Mozilla/5.0",
        }

        all_goods = []
        page = 1
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                while True:
                    res = await client.post(
                        f"{_ABLY_BASE}/seller/goods/search/",
                        headers=ably_headers,
                        json={"page": page, "per_page": 30},
                    )
                    res.raise_for_status()
                    data = res.json()
                    goods = data.get("goods", [])
                    if not goods:
                        break
                    all_goods.extend(goods)
                    if page >= data.get("max_page_number", 1):
                        break
                    page += 1
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"상품 목록 조회 실패: {exc}")

        if start_date or end_date:
            filtered = []
            for g in all_goods:
                date_str = (g.get("registered_at") or g.get("created_at") or "")[:10]
                if start_date and date_str < start_date:
                    continue
                if end_date and date_str > end_date:
                    continue
                filtered.append(g)
            all_goods = filtered

        # search API returns option_groups=null; fetch per-goods detail to get option names
        if all_goods:
            async def _fetch_detail(client, sno):
                try:
                    r = await client.get(
                        f"{_ABLY_BASE}/seller/goods/{sno}/",
                        headers=ably_headers,
                    )
                    r.raise_for_status()
                    return sno, r.json().get("goods", {})
                except Exception:
                    return sno, {}

            async with httpx.AsyncClient(timeout=30.0) as client:
                results = await asyncio.gather(
                    *[_fetch_detail(client, g["sno"]) for g in all_goods]
                )
            detail_map = {sno: detail for sno, detail in results}
            for i, g in enumerate(all_goods):
                detail = detail_map.get(g["sno"])
                if detail:
                    all_goods[i] = {
                        **g,
                        "option_groups": detail.get("option_groups") or g.get("option_groups"),
                        "options": detail.get("options") or g.get("options"),
                    }

        try:
            xls_bytes = process_easyadmin_product_from_api(all_goods)
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"XLS 생성 실패: {exc}")

        filename = f"easyadmin_products_{datetime.now().strftime('%Y%m%d_%H%M%S')}.xls"
        resp_headers = {"Content-Disposition": content_disposition(filename)}
        return Response(content=xls_bytes, media_type="application/vnd.ms-excel", headers=resp_headers)

    @router.get("/barcode/status")
    def barcode_status(user: str = Depends(get_current_user)):
        state = get_barcode_state(user)
        if not state["loaded"]:
            return {"loaded": False}
        invoice_keys = list((state.get("mapping") or {}).keys())
        return {
            "loaded": True,
            "current_invoice": state["current_invoice"],
            "invoices": len(state["mapping"]),
            "invoice_samples": invoice_keys[:20],
            "invoice_sample_normalized": [
                {"raw": invoice, "normalized": _normalize_invoice_value(invoice)}
                for invoice in invoice_keys[:20]
            ],
            "processed_path": state["processed_path"],
            "items": _get_all_items(state, state["current_invoice"]) if state["current_invoice"] else [],
            "current_next": _get_first_remaining_item(state, state["current_invoice"]),
            "next_preview": _get_next_item_preview(state, state["current_invoice"]),
            "defects": _get_defect_list(state),
            "invoice_has_defect": _invoice_has_defect(state, state["current_invoice"]),
            "incoming_codes": len(get_shared_incoming_counts() or {}),
            "incoming_total": sum((get_shared_incoming_counts() or {}).values()),
        }

    @router.get("/barcode/hapbae-pre-match")
    def hapbae_pre_match(user: str = Depends(get_current_user)):
        state = get_barcode_state(user)
        if not state.get("loaded"):
            return {
                "ok": True,
                "loaded": False,
                "incoming_loaded": bool(get_shared_incoming_counts()),
                "rows": [],
                "stock_rows": [],
                "stats": {"totalRows": 0, "targetRows": 0, "duplicateRows": 0, "incomingRows": 0, "stockRows": 0},
            }

        source_rows = state.get("hapbae_pre_match_rows") or []
        incoming_counts = get_shared_incoming_counts() or {}
        target_shop_key = _normalize_shop_name(hapbae_target_shop)
        target_rows = [row for row in source_rows if _normalize_shop_name(row.get("shop")) == target_shop_key]
        counts_by_key = Counter(
            _normalize_text(row.get("duplicateKey"))
            for row in target_rows
            if _normalize_text(row.get("duplicateKey"))
        )
        duplicate_rows = [
            row
            for row in target_rows
            if _normalize_text(row.get("duplicateKey")) and counts_by_key[_normalize_text(row.get("duplicateKey"))] >= 2
        ]
        result_rows = []
        for row in duplicate_rows:
            code = row.get("code") or ""
            order_qty = to_int(row.get("orderQty"), default=0)
            if order_qty <= 0:
                continue
            result_rows.append({
                "rowNumber": row.get("rowNumber"),
                "duplicateKey": row.get("duplicateKey", ""),
                "code": code,
                "productName": row.get("productName", ""),
                "optionName": row.get("optionName", ""),
                "orderQty": order_qty,
                "incomingQty": int(incoming_counts.get(code, 0) or 0),
            })

        def _group_hapbae_rows(target: list[dict]) -> list[dict]:
            grouped_rows = []
            grouped_lookup = {}
            for row in target:
                incoming_qty = int(row.get("incomingQty") or 0)
                if incoming_qty >= 10:
                    incoming_bucket = "high"
                elif incoming_qty > 0:
                    incoming_bucket = "normal"
                else:
                    incoming_bucket = "none"
                key = (
                    _normalize_text(row.get("productName")),
                    _normalize_text(row.get("optionName")),
                    incoming_bucket,
                )
                qty = to_int(row.get("orderQty"), default=0)
                if key not in grouped_lookup:
                    grouped_lookup[key] = {
                        "productName": row.get("productName", ""),
                        "optionName": row.get("optionName", ""),
                        "orderQty": qty,
                        "incomingQty": incoming_qty,
                    }
                    grouped_rows.append(grouped_lookup[key])
                else:
                    grouped_lookup[key]["orderQty"] += qty
            grouped_rows.sort(
                key=lambda row: (
                    _normalize_text(row.get("productName")),
                    _normalize_text(row.get("optionName")),
                )
            )
            return grouped_rows

        grouped_rows = _group_hapbae_rows(result_rows)
        grouped_stock_rows = []

        return {
            "ok": True,
            "loaded": True,
            "incoming_loaded": bool(incoming_counts),
            "rows": grouped_rows,
            "stock_rows": grouped_stock_rows,
            "stats": {
                "totalRows": len(source_rows),
                "targetRows": len(target_rows),
                "duplicateRows": len(duplicate_rows),
                "incomingRows": len(result_rows),
                "groupedRows": len(grouped_rows),
                "stockRows": 0,
                "groupedStockRows": len(grouped_stock_rows),
            },
        }

    @router.get("/barcode/hapbae-pre-match/checked")
    def get_hapbae_pre_match_checked(user: str = Depends(get_current_user)):
        return {"ok": True, "checked_rows": _get_hapbae_checked_rows()}

    @router.patch("/barcode/hapbae-pre-match/checked")
    def set_hapbae_pre_match_checked(payload: dict = Body(...), user: str = Depends(get_current_user)):
        key = str(payload.get("key") or "").strip()
        if not key:
            raise HTTPException(status_code=400, detail="key required")
        checked = bool(payload.get("checked"))
        checked_rows = _get_hapbae_checked_rows()
        if checked:
            checked_rows[key] = True
        else:
            checked_rows.pop(key, None)
        return {"ok": True, "checked_rows": _set_hapbae_checked_rows(checked_rows)}

    @router.post("/barcode/scan/invoice")
    def scan_invoice(payload: dict = Body(...), user: str = Depends(get_current_user)):
        state = get_barcode_state(user)
        if not state["loaded"]:
            raise HTTPException(status_code=400, detail="Upload barcode data first")

        invoice = (payload.get("invoice") or "").strip()
        if not invoice:
            raise HTTPException(status_code=400, detail="invoice is required")
        resolved_invoice = _resolve_invoice_key(state, invoice)
        if not resolved_invoice:
            return {"ok": False, "type": "invoice", "result": "NOT_FOUND", "invoice": invoice}

        state["current_invoice"] = resolved_invoice
        first_item = _get_first_remaining_item(state, resolved_invoice)
        if first_item:
            state["last_scanned_code"] = first_item.get("code")

        return {
            "ok": True,
            "type": "invoice",
            "result": "SET",
            "invoice": resolved_invoice,
            "items": _get_all_items(state, resolved_invoice),
            "current_next": first_item,
            "next_preview": _get_next_item_preview(state, resolved_invoice),
            "defects": _get_defect_list(state),
            "invoice_has_defect": _invoice_has_defect(state, resolved_invoice),
        }

    @router.post("/barcode/scan/item")
    def scan_item(payload: dict = Body(...), user: str = Depends(get_current_user)):
        state = get_barcode_state(user)
        if not state["loaded"]:
            raise HTTPException(status_code=400, detail="Upload barcode data first")

        inv = state["current_invoice"]
        if not inv:
            return {"ok": False, "type": "item", "result": "NO_INVOICE"}

        raw = (payload.get("code") or "").strip()
        if not raw:
            raise HTTPException(status_code=400, detail="code is required")

        code = normalize_to_yusas(raw) or raw
        if inv not in state["mapping"]:
            return {"ok": False, "type": "item", "result": "BAD_INVOICE", "invoice": inv}

        remain = state["mapping"][inv].get(code, 0)
        det = (state["details"] or {}).get(inv, {}).get(code, {})
        name = det.get("name", "") or ""
        option = det.get("option", "") or ""

        if remain <= 0:
            return {
                "ok": True,
                "type": "item",
                "result": "FALSE",
                "invoice": inv,
                "raw": raw,
                "code": code,
                "name": name,
                "option": option,
                "remain": remain,
                "items": _get_all_items(state, inv),
                "current_next": _get_first_remaining_item(state, inv),
                "next_preview": _get_next_item_preview(state, inv),
                "defects": _get_defect_list(state),
            }

        state["mapping"][inv][code] = remain - 1
        state["last_scanned_code"] = code
        all_done = all(v == 0 for v in state["mapping"][inv].values())
        return {
            "ok": True,
            "type": "item",
            "result": "TRUE",
            "invoice": inv,
            "code": code,
            "name": name,
            "option": option,
            "remain": state["mapping"][inv][code],
            "invoice_done": all_done,
            "items": _get_all_items(state, inv),
            "current_next": _get_first_remaining_item(state, inv),
            "next_preview": _get_next_item_preview(state, inv),
            "defects": _get_defect_list(state),
        }

    @router.post("/barcode/defect/add")
    def add_defect(payload: dict = Body(...), user: str = Depends(get_current_user)):
        state = get_barcode_state(user)
        if not state["loaded"]:
            raise HTTPException(status_code=400, detail="Upload barcode data first")

        raw = (payload.get("code") or "").strip()
        if not raw:
            raise HTTPException(status_code=400, detail="code is required")

        code = normalize_to_yusas(raw) or raw
        defect_counts = dict(get_shared_defect_counts())
        defect_counts[code] = defect_counts.get(code, 0) + 1
        set_shared_defect_counts(defect_counts)

        inv = state.get("current_invoice")
        return {
            "ok": True,
            "code": code,
            "defect_count": defect_counts[code],
            "items": _get_all_items(state, inv) if inv else [],
            "current_next": _get_first_remaining_item(state, inv),
            "next_preview": _get_next_item_preview(state, inv),
            "defects": _get_defect_list(state),
        }

    @router.get("/barcode/defect/list")
    def list_defects(user: str = Depends(get_current_user)):
        state = get_barcode_state(user)
        if not state["loaded"]:
            raise HTTPException(status_code=400, detail="Upload barcode data first")
        return {"ok": True, "defects": _get_defect_list(state)}

    @router.get("/barcode/defect/search")
    def search_defects(q: str = "", user: str = Depends(get_current_user)):
        query = _normalize_text(q).casefold()
        if not query:
            return {"ok": True, "rows": []}
        keywords = [kw for kw in query.split() if kw]

        _, rows = _read_defect_base_table()
        matches = []
        for row in rows:
            values = row.get("values") or []
            code = values[0] if len(values) > 0 else ""
            display_name = values[6] if len(values) > 6 else ""
            if not code or not display_name:
                continue
            normalized = _normalize_text(display_name).casefold()
            if not all(kw in normalized for kw in keywords):
                continue
            matches.append({
                "code": normalize_to_yusas(code) or str(code).strip(),
                "base_code": str(code).strip(),
                "base_name": display_name,
                "base_vendor": values[2] if len(values) > 2 else "",
                "base_product": values[3] if len(values) > 3 else "",
                "base_color": values[4] if len(values) > 4 else "",
                "base_addr": values[5] if len(values) > 5 else "",
            })
            if len(matches) >= 50:
                break
        return {"ok": True, "rows": matches}

    @router.get("/barcode/defect/export")
    def export_defects(user: str = Depends(get_current_user)):
        state = get_barcode_state(user)
        if not state["loaded"]:
            raise HTTPException(status_code=400, detail="Upload barcode data first")
        if not get_shared_defect_counts():
            raise HTTPException(status_code=400, detail="Defect list is empty")

        filename = f"defects_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"
        headers = {"Content-Disposition": content_disposition(filename)}
        return Response(
            content=_build_defect_csv(state).encode("utf-8-sig"),
            media_type="text/csv; charset=utf-8",
            headers=headers,
        )

    @router.get("/barcode/defect/export-xls")
    def export_defects_xls(user: str = Depends(get_current_user)):
        state = get_barcode_state(user)
        if not state["loaded"]:
            raise HTTPException(status_code=400, detail="Upload barcode data first")
        if not get_shared_defect_counts():
            raise HTTPException(status_code=400, detail="Defect list is empty")

        filename = f"defects_work_{datetime.now().strftime('%Y%m%d_%H%M%S')}.xls"
        headers = {"Content-Disposition": content_disposition(filename)}
        return Response(
            content=_build_defect_xls_bytes(),
            media_type="application/vnd.ms-excel",
            headers=headers,
        )

    @router.get("/barcode/defect/base")
    def get_defect_base(user: str = Depends(get_current_user)):
        headers, rows = _read_defect_base_table()
        return {"ok": True, "path": str(defect_base_path), "headers": headers, "rows": rows}

    @router.post("/barcode/defect/base")
    def save_defect_base(payload: dict = Body(...), user: str = Depends(get_current_user)):
        rows = payload.get("rows")
        if not isinstance(rows, list):
            raise HTTPException(status_code=400, detail="rows must be a list")

        wb, ws = _load_defect_base_sheet()
        try:
            write_row = 2
            for row in rows:
                values = row.get("values") if isinstance(row, dict) else row
                cells = _normalize_defect_base_row(values)
                if not any(cells):
                    continue
                _write_defect_base_virtual_row(ws, write_row, cells)
                write_row += 1

            for row_idx in range(write_row, ws.max_row + 1):
                _write_defect_base_virtual_row(ws, row_idx, ["", "", "", "", "", "", ""])

            wb.save(defect_base_path)
        finally:
            wb.close()

        _invalidate_defect_base_cache()
        headers, saved_rows = _read_defect_base_table()
        return {"ok": True, "path": str(defect_base_path), "headers": headers, "rows": saved_rows}

    @router.post("/barcode/defect/dec")
    def decrement_defect(payload: dict = Body(...), user: str = Depends(get_current_user)):
        state = get_barcode_state(user)
        if not state["loaded"]:
            raise HTTPException(status_code=400, detail="Upload barcode data first")

        raw = (payload.get("code") or "").strip()
        if not raw:
            raise HTTPException(status_code=400, detail="code is required")

        code = normalize_to_yusas(raw) or raw
        defect_counts = dict(get_shared_defect_counts())
        if code in defect_counts:
            defect_counts[code] -= 1
            if defect_counts[code] <= 0:
                del defect_counts[code]
        set_shared_defect_counts(defect_counts)

        inv = state.get("current_invoice")
        return {
            "ok": True,
            "defects": _get_defect_list(state),
            "items": _get_all_items(state, inv) if inv else [],
            "current_next": _get_first_remaining_item(state, inv),
            "next_preview": _get_next_item_preview(state, inv),
        }

    @router.post("/barcode/defect/remove")
    def remove_defect(payload: dict = Body(...), user: str = Depends(get_current_user)):
        state = get_barcode_state(user)
        if not state["loaded"]:
            raise HTTPException(status_code=400, detail="Upload barcode data first")

        raw = (payload.get("code") or "").strip()
        if not raw:
            raise HTTPException(status_code=400, detail="code is required")

        code = normalize_to_yusas(raw) or raw
        defect_counts = dict(get_shared_defect_counts())
        defect_counts.pop(code, None)
        set_shared_defect_counts(defect_counts)

        inv = state.get("current_invoice")
        return {
            "ok": True,
            "defects": _get_defect_list(state),
            "items": _get_all_items(state, inv) if inv else [],
            "current_next": _get_first_remaining_item(state, inv),
            "next_preview": _get_next_item_preview(state, inv),
        }

    return router
