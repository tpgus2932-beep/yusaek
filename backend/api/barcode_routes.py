import tempfile
import traceback
import uuid
from collections import Counter
from datetime import datetime
from pathlib import Path
import re

import xlwt
from fastapi import APIRouter, Body, Depends, File, HTTPException, Response, UploadFile
from openpyxl import load_workbook


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
):
    router = APIRouter()
    defect_base_path = Path(r"C:\Users\ksh29\OneDrive\Desktop\원베\불량베이스.xlsx")
    defect_base_default_headers = ["code", "name", "vendor", "product", "color", "address", "note"]
    defect_base_cache = {"mtime": None, "headers": None, "rows": None, "lookup": None}

    def _csv_escape(value) -> str:
        return '"' + str(value or "").replace('"', '""') + '"'

    def _normalize_defect_base_row(row) -> list[str]:
        cells = list(row[:7]) if row else []
        while len(cells) < 7:
            cells.append("")
        return [str(cell or "").strip() for cell in cells[:7]]

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
            header_cells = _normalize_defect_base_row(
                next(ws.iter_rows(min_row=1, max_row=1, values_only=True), ())
            )
            headers = [header_cells[i] or defect_base_default_headers[i] for i in range(7)]
            rows = []
            for row_idx, row in enumerate(ws.iter_rows(min_row=2, values_only=True), start=2):
                cells = _normalize_defect_base_row(row)
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
                "_detail_lookup": None,
                "_invoice_lookup": None,
            }
        )
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
            header_values = _normalize_defect_base_row(
                next(ws.iter_rows(min_row=1, max_row=1, values_only=True), ())
            )
            if ws.max_row > 1:
                ws.delete_rows(2, ws.max_row - 1)

            for idx, fallback in enumerate(defect_base_default_headers, start=1):
                ws.cell(1, idx, header_values[idx - 1] or fallback)

            write_row = 2
            for row in rows:
                values = row.get("values") if isinstance(row, dict) else row
                cells = _normalize_defect_base_row(values)
                if not any(cells):
                    continue
                for col_idx, value in enumerate(cells, start=1):
                    ws.cell(write_row, col_idx, value)
                write_row += 1

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
