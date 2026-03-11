import tempfile
import traceback
import uuid
from collections import Counter
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Body, Depends, File, HTTPException, Response, UploadFile


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
):
    router = APIRouter()

    def _get_all_items(state, inv: str):
        mapping = state["mapping"]
        if inv not in mapping:
            return []

        if state["invoice_order"] and inv in state["invoice_order"]:
            codes = state["invoice_order"][inv]
        else:
            codes = sorted(mapping[inv].keys())

        incoming_counts = get_shared_incoming_counts() or {}
        defect_counts = get_shared_defect_counts()
        items = []
        for code in codes:
            remain = mapping[inv].get(code, 0)
            run_len = (state["runs"] or {}).get(inv, {}).get(code, 0)
            defect_n = defect_counts.get(code, 0)
            incoming_n = incoming_counts.get(code, 0)
            det = (state["details"] or {}).get(inv, {}).get(code, {})
            items.append(
                {
                    "code": code,
                    "name": det.get("name", "") or "",
                    "option": det.get("option", "") or "",
                    "remain": remain,
                    "run_len": run_len,
                    "defect": defect_n,
                    "incoming": incoming_n,
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
            run_len = item.get("run_len", 0)
            if run_len and run_len >= 10:
                continue
            if last_code and item.get("code") == last_code:
                continue
            return {"invoice": inv, **item}
        return None

    def _invoice_has_defect(state, inv: str | None):
        if not inv:
            return False
        defect_counts = get_shared_defect_counts()
        mapping = state.get("mapping") or {}
        if inv not in mapping:
            return False
        for code in mapping[inv].keys():
            if defect_counts.get(code, 0) > 0:
                return True
        return False

    def _find_item_detail_by_code(state, code: str):
        details = state.get("details") or {}
        for _, codes in details.items():
            det = codes.get(code)
            if det:
                return {
                    "name": det.get("name", "") or "",
                    "option": det.get("option", "") or "",
                }
        return {"name": "", "option": ""}

    def _get_defect_list(state):
        defect_counts = get_shared_defect_counts()
        rows = []
        for code, n in sorted(defect_counts.items()):
            det = _find_item_detail_by_code(state, code)
            rows.append(
                {
                    "code": code,
                    "count": n,
                    "name": det.get("name", ""),
                    "option": det.get("option", ""),
                }
            )
        return rows

    def _build_defect_csv(state) -> str:
        defect_counts = get_shared_defect_counts()
        code_o_text = state.get("code_o_text") or {}
        lines = ["A열(O왼쪽),B열(O오른쪽),C열(옵션명),D열(불량수량)"]
        for code, n in sorted(defect_counts.items()):
            det = _find_item_detail_by_code(state, code)
            opt = det.get("option", "") or ""
            o_text = (code_o_text.get(code) or "").strip()
            if not o_text:
                name = det.get("name", "") or ""
                o_text = f"{code} {name}".strip()
            o_text = str(o_text).strip().replace(",", " ")
            if " " in o_text:
                left, right = o_text.split(" ", 1)
            else:
                left, right = o_text, ""
            opt_clean = (opt or "").replace(",", " ")
            lines.append(f"{left},{right},{opt_clean},{n}")
        return "\n".join(lines) + "\n"

    @router.post("/barcode/upload")
    async def barcode_upload(file: UploadFile = File(...), user: str = Depends(get_current_user)):
        name = (file.filename or "").lower()
        if not (name.endswith(".xls") or name.endswith(".xlsx")):
            raise HTTPException(status_code=400, detail="xls/xlsx만 업로드 가능")

        suffix = ".xlsx" if name.endswith(".xlsx") else ".xls"
        tmp_path = Path(tempfile.gettempdir()) / f"yusaek_upload_{uuid.uuid4().hex}{suffix}"
        data = await file.read()
        tmp_path.write_bytes(data)

        try:
            result = process_and_load_any(tmp_path)
            print("process_and_load_any return len =", len(result))

            if len(result) == 7:
                processed_path, mapping, details, runs, invoice_order, invoice_seq, code_o_text = result
            elif len(result) == 6:
                mapping, details, runs, invoice_order, invoice_seq, code_o_text = result
                processed_path = None
            else:
                raise Exception(f"unexpected return count: {len(result)}")
        except Exception as e:
            traceback.print_exc()
            raise HTTPException(status_code=500, detail=f"가공 실패: {e}")

        state = get_barcode_state(user)
        state.update(
            {
                "loaded": True,
                "processed_path": str(processed_path) if processed_path else None,
                "mapping": mapping,
                "details": details,
                "runs": runs,
                "invoice_order": invoice_order,
                "invoice_seq": invoice_seq,
                "code_o_text": code_o_text,
                "current_invoice": None,
                "last_scanned_code": None,
            }
        )
        set_shared_defect_counts({})

        return {
            "ok": True,
            "invoices": len(mapping),
            "codes_total": sum(len(v) for v in mapping.values()),
        }

    @router.post("/barcode/incoming/upload")
    async def incoming_upload(file: UploadFile = File(...), user: str = Depends(get_current_user)):
        name = (file.filename or "").lower()
        if not (name.endswith(".xls") or name.endswith(".xlsx")):
            raise HTTPException(status_code=400, detail="xls/xlsx files only")

        suffix = ".xlsx" if name.endswith(".xlsx") else ".xls"
        tmp_path = Path(tempfile.gettempdir()) / f"yusaek_incoming_{uuid.uuid4().hex}{suffix}"
        data = await file.read()
        tmp_path.write_bytes(data)

        try:
            wb, ws = load_excel_any(tmp_path)
            counts = Counter()
            for r in range(1, ws.max_row + 1):
                code_raw = ws.cell(r, 1).value
                qty_raw = ws.cell(r, 2).value
                code = normalize_to_yusas(code_raw)
                if not code:
                    continue
                qty = to_int(qty_raw, default=0)
                if qty > 0:
                    counts[code] += qty
        except Exception as e:
            traceback.print_exc()
            raise HTTPException(status_code=500, detail=f"incoming load failed: {e}")

        set_shared_incoming_counts(dict(counts))
        return {"ok": True, "codes": len(counts), "total_qty": sum(counts.values())}

    @router.post("/barcode/product/upload")
    async def easyadmin_product_upload(file: UploadFile = File(...), user: str = Depends(get_current_user)):
        name = (file.filename or "").lower()
        if not (name.endswith(".xls") or name.endswith(".xlsx") or name.endswith(".csv")):
            raise HTTPException(status_code=400, detail="xls/xlsx/csv만 업로드 가능")

        suffix = Path(name).suffix or ".xlsx"
        tmp_path = Path(tempfile.gettempdir()) / f"yusaek_easyadmin_{uuid.uuid4().hex}{suffix}"
        data = await file.read()
        tmp_path.write_bytes(data)

        try:
            xls_bytes = process_easyadmin_product_upload(tmp_path)
        except Exception as e:
            traceback.print_exc()
            raise HTTPException(status_code=500, detail=f"가공 실패: {e}")

        filename = f"easyadmin_products_{datetime.now().strftime('%Y%m%d_%H%M%S')}.xls"
        headers = {"Content-Disposition": content_disposition(filename)}
        return Response(content=xls_bytes, media_type="application/vnd.ms-excel", headers=headers)

    @router.get("/barcode/status")
    def barcode_status(user: str = Depends(get_current_user)):
        state = get_barcode_state(user)
        if not state["loaded"]:
            return {"loaded": False}
        return {
            "loaded": True,
            "current_invoice": state["current_invoice"],
            "invoices": len(state["mapping"]),
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
            raise HTTPException(status_code=400, detail="먼저 엑셀을 업로드해주세요")

        invoice = (payload.get("invoice") or "").strip()
        if not invoice:
            raise HTTPException(status_code=400, detail="invoice 값이 비어있음")

        if invoice not in state["mapping"]:
            return {"ok": False, "type": "invoice", "result": "NOT_FOUND", "invoice": invoice}

        state["current_invoice"] = invoice
        first_item = _get_first_remaining_item(state, invoice)
        if first_item:
            state["last_scanned_code"] = first_item.get("code")

        items = _get_all_items(state, invoice)
        return {
            "ok": True,
            "type": "invoice",
            "result": "SET",
            "invoice": invoice,
            "items": items,
            "current_next": first_item,
            "next_preview": _get_next_item_preview(state, invoice),
            "defects": _get_defect_list(state),
            "invoice_has_defect": _invoice_has_defect(state, invoice),
        }

    @router.post("/barcode/scan/item")
    def scan_item(payload: dict = Body(...), user: str = Depends(get_current_user)):
        state = get_barcode_state(user)
        if not state["loaded"]:
            raise HTTPException(status_code=400, detail="먼저 엑셀을 업로드해주세요")

        inv = state["current_invoice"]
        if not inv:
            return {"ok": False, "type": "item", "result": "NO_INVOICE"}

        raw = (payload.get("code") or "").strip()
        if not raw:
            raise HTTPException(status_code=400, detail="code 값이 비어있음")

        code = normalize_to_yusas(raw) or raw
        if inv not in state["mapping"]:
            return {"ok": False, "type": "item", "result": "BAD_INVOICE", "invoice": inv}

        remain = state["mapping"][inv].get(code, 0)
        det = (state["details"] or {}).get(inv, {}).get(code, {})
        name = det.get("name", "") or ""
        opt = det.get("option", "") or ""

        if remain <= 0:
            return {
                "ok": True,
                "type": "item",
                "result": "FALSE",
                "invoice": inv,
                "raw": raw,
                "code": code,
                "name": name,
                "option": opt,
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
            "option": opt,
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
            raise HTTPException(status_code=400, detail="먼저 엑셀을 업로드해주세요")

        raw = (payload.get("code") or "").strip()
        if not raw:
            raise HTTPException(status_code=400, detail="code 값이 비어있음")

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
            raise HTTPException(status_code=400, detail="먼저 엑셀을 업로드해주세요")
        return {"ok": True, "defects": _get_defect_list(state)}

    @router.get("/barcode/defect/export")
    def export_defects(user: str = Depends(get_current_user)):
        state = get_barcode_state(user)
        if not state["loaded"]:
            raise HTTPException(status_code=400, detail="먼저 엑셀을 업로드해주세요")
        if not get_shared_defect_counts():
            raise HTTPException(status_code=400, detail="불량 목록이 비어있습니다")
        csv_text = _build_defect_csv(state)
        filename = f"defects_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"
        headers = {"Content-Disposition": content_disposition(filename)}
        csv_bytes = csv_text.encode("utf-8-sig")
        return Response(content=csv_bytes, media_type="text/csv; charset=utf-8", headers=headers)

    @router.post("/barcode/defect/dec")
    def decrement_defect(payload: dict = Body(...), user: str = Depends(get_current_user)):
        state = get_barcode_state(user)
        if not state["loaded"]:
            raise HTTPException(status_code=400, detail="먼저 엑셀을 업로드해주세요")
        raw = (payload.get("code") or "").strip()
        if not raw:
            raise HTTPException(status_code=400, detail="code 값이 비어있음")
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
            raise HTTPException(status_code=400, detail="먼저 엑셀을 업로드해주세요")
        raw = (payload.get("code") or "").strip()
        if not raw:
            raise HTTPException(status_code=400, detail="code 값이 비어있음")
        code = normalize_to_yusas(raw) or raw
        defect_counts = dict(get_shared_defect_counts())
        if code in defect_counts:
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

    return router
