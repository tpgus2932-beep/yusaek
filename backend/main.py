from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pathlib import Path
from fastapi import Body
import tempfile
import uuid
import traceback

from barcode_core import process_and_load_any, normalize_to_yusas

import barcode_core
print("### barcode_core file =", barcode_core.__file__)


app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

STATE = {
    "loaded": False,
    "mapping": None,
    "details": None,
    "runs": None,
    "invoice_order": None,
    "invoice_seq": None,
    "code_o_text": None,
    "current_invoice": None,
    "last_scanned_code": None,
    "processed_path": None,
}

@app.get("/ping")
def ping():
    return {"status": "ok"}

@app.post("/barcode/upload")
async def barcode_upload(file: UploadFile = File(...)):
    name = (file.filename or "").lower()
    if not (name.endswith(".xls") or name.endswith(".xlsx")):
        raise HTTPException(status_code=400, detail="xls/xlsx만 업로드 가능")

    suffix = ".xlsx" if name.endswith(".xlsx") else ".xls"

    # 파일명 충돌 방지
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
        traceback.print_exc()  # ✅ 터미널에 진짜 에러 전체 출력
        raise HTTPException(status_code=500, detail=f"가공 실패: {e}")

    STATE.update({
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
    })



    return {
        "ok": True,
        "invoices": len(mapping),
        "codes_total": sum(len(v) for v in mapping.values()),
    }

@app.get("/barcode/status")
def barcode_status():
    if not STATE["loaded"]:
        return {"loaded": False}
    return {
        "loaded": True,
        "current_invoice": STATE["current_invoice"],
        "invoices": len(STATE["mapping"]),
        "processed_path": STATE["processed_path"],
    }



def _get_first_remaining_item(inv: str):
    """해당 송장에서 남은 수량>0 인 첫 상품(code)을 찾음"""
    mapping = STATE["mapping"]
    if inv not in mapping:
        return None

    codes = None
    if STATE["invoice_order"] and inv in STATE["invoice_order"]:
        codes = STATE["invoice_order"][inv]
    else:
        codes = sorted(mapping[inv].keys())

    for code in codes:
        if mapping[inv].get(code, 0) > 0:
            det = (STATE["details"] or {}).get(inv, {}).get(code, {})
            return {
                "code": code,
                "name": det.get("name", "") or "",
                "option": det.get("option", "") or "",
                "remain": mapping[inv].get(code, 0),
            }
    return None


@app.post("/barcode/scan/invoice")
def scan_invoice(payload: dict = Body(...)):
    if not STATE["loaded"]:
        raise HTTPException(status_code=400, detail="먼저 엑셀을 업로드하세요")

    invoice = (payload.get("invoice") or "").strip()
    if not invoice:
        raise HTTPException(status_code=400, detail="invoice 값이 비어있음")

    if invoice not in STATE["mapping"]:
        return {"ok": False, "type": "invoice", "result": "NOT_FOUND", "invoice": invoice}

    STATE["current_invoice"] = invoice

    next_item = _get_first_remaining_item(invoice)

    return {
        "ok": True,
        "type": "invoice",
        "result": "SET",
        "invoice": invoice,
        "next_item": next_item,   # 다음 찍을 상품 미리보기(있으면)
    }

@app.post("/barcode/scan/item")
def scan_item(payload: dict = Body(...)):
    if not STATE["loaded"]:
        raise HTTPException(status_code=400, detail="먼저 엑셀을 업로드하세요")

    inv = STATE["current_invoice"]
    if not inv:
        return {"ok": False, "type": "item", "result": "NO_INVOICE"}

    code = (payload.get("code") or "").strip()
    if not code:
        raise HTTPException(status_code=400, detail="code 값이 비어있음")
    raw = (payload.get("code") or "").strip()
    if not raw:
        raise HTTPException(status_code=400, detail="code 값이 비어있음")

    code = normalize_to_yusas(raw) or raw
        
    if inv not in STATE["mapping"]:
        return {"ok": False, "type": "item", "result": "BAD_INVOICE", "invoice": inv}

    remain = STATE["mapping"][inv].get(code, 0)
    det = (STATE["details"] or {}).get(inv, {}).get(code, {})
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
        }

    # TRUE 처리: -1
    STATE["mapping"][inv][code] = remain - 1
    STATE["last_scanned_code"] = code

    all_done = all(v == 0 for v in STATE["mapping"][inv].values())

    return {
        "ok": True,
        "type": "item",
        "result": "TRUE",
        "invoice": inv,
        "code": code,
        "name": name,
        "option": opt,
        "remain": STATE["mapping"][inv][code],
        "invoice_done": all_done,
        "next_item": _get_first_remaining_item(inv),
    }
