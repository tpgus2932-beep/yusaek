import asyncio
import tempfile
import traceback
import uuid
import warnings
warnings.filterwarnings("ignore", message="Unverified HTTPS request")
from collections import Counter
from datetime import datetime
from pathlib import Path
import json
import re

import httpx
import xlwt
from fastapi import APIRouter, Body, Depends, File, HTTPException, Response, UploadFile
from openpyxl import load_workbook

from services.easyadmin_product import process_easyadmin_product_from_api
from services.pastelco_utils import pastelco_login

_ABLY_BASE     = "https://api.a-bly.com"
_ABLY_EMAIL    = "eostm1997@naver.com"
_ABLY_PASSWORD = "!Glqgkqdldi1126"

_EZADMIN_BASE        = "https://ga80.ezadmin.co.kr"
_EZADMIN_SESSION_KEY = "ezadmin_phpsessid"

from api.wonbe_routes import _get_wonbe_db as _get_wonbe_db


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
    get_shared_kimsungil_counts,
    set_shared_kimsungil_counts,
    set_shared_barcode_data,
    get_setting,
    set_setting,
):
    router = APIRouter()
    _DEFECT_BASE_HEADERS = ["상품코드", "상품명", "공급처", "공급처상품명", "색상 사이즈", "주소", "표시형 상품명"]
    hapbae_target_shop = "에이블리(유색)"
    hapbae_checked_rows_key = "test_hapbae_checked_rows"
    hapbae_registered_products_key = "test_hapbae_registered_products"

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

    def _get_registered_products() -> list[dict]:
        raw = get_setting(hapbae_registered_products_key) or "[]"
        try:
            parsed = json.loads(raw)
        except Exception:
            parsed = []
        if not isinstance(parsed, list):
            return []
        clean = []
        seen_codes = set()
        for item in parsed:
            if not isinstance(item, dict):
                continue
            code = str(item.get("code") or "").strip()
            label = str(item.get("label") or "").strip()
            if not code or code in seen_codes:
                continue
            seen_codes.add(code)
            clean.append({"code": code, "label": label})
        return clean

    def _set_registered_products(items: list[dict]) -> list[dict]:
        clean = []
        seen_codes = set()
        for item in items:
            code = str(item.get("code") or "").strip()
            label = str(item.get("label") or "").strip()
            if not code or code in seen_codes:
                continue
            seen_codes.add(code)
            clean.append({"code": code, "label": label})
        set_setting(hapbae_registered_products_key, json.dumps(clean, ensure_ascii=False))
        return clean

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
                trans_date = _normalize_text(ws.cell(row_idx, 14).value)
                rows.append({
                    "rowNumber": row_idx,
                    "shop": shop,
                    "duplicateKey": duplicate_key,
                    "code": code,
                    "productName": _normalize_text(ws.cell(row_idx, name_col).value),
                    "optionName": _normalize_text(ws.cell(row_idx, option_col).value),
                    "orderQty": _normalize_text(ws.cell(row_idx, qty_col).value),
                    "transDate": trans_date,
                    "runLen": 0,
                })
            # 송장입력일 오름차순 → 같은 날짜 내 바코드 기준 정렬 → runLen 정확도 향상
            rows.sort(key=lambda r: (r["transDate"] or "", r["code"] or ""))
            i = 0
            while i < len(rows):
                j = i
                while j < len(rows) and rows[j]["code"] == rows[i]["code"]:
                    j += 1
                run_len = j - i
                for k in range(i, j):
                    rows[k]["runLen"] = run_len
                i = j
            return rows
        finally:
            try:
                wb.close()
            except Exception:
                pass

    def _csv_escape(value) -> str:
        return '"' + str(value or "").replace('"', '""') + '"'

    def _defect_db_row_to_values(row) -> list[str]:
        color_size = " ".join(p for p in [str(row["색상"] or ""), str(row["사이즈"] or "")] if p.strip())
        return [
            str(row["상품코드"] or ""),
            str(row["상품명"] or ""),
            str(row["거래처"] or ""),
            str(row["거래처상품명"] or ""),
            color_size,
            str(row["거래처주소"] or ""),
            str(row["상품명합"] or ""),
        ]

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

    def _read_defect_base_table():
        conn = _get_wonbe_db()
        try:
            db_rows = conn.execute(
                "SELECT 상품코드, 상품명, 거래처, 거래처상품명, 색상, 사이즈, 거래처주소, 상품명합"
                " FROM wonbe ORDER BY rowid ASC"
            ).fetchall()
            rows = [{"row_index": i, "values": _defect_db_row_to_values(r)} for i, r in enumerate(db_rows)]
            return _DEFECT_BASE_HEADERS, rows
        finally:
            conn.close()

    def _build_defect_base_lookup():
        conn = _get_wonbe_db()
        try:
            db_rows = conn.execute(
                "SELECT 상품코드, 상품명, 거래처, 거래처상품명, 색상, 사이즈, 거래처주소, 상품명합 FROM wonbe"
            ).fetchall()
            lookup = {}
            for row in db_rows:
                raw_code = str(row["상품코드"] or "").strip()
                normalized_code = normalize_to_yusas(raw_code) or raw_code
                if normalized_code:
                    color_size = _combine_color_size(str(row["색상"] or ""), str(row["사이즈"] or ""))
                    lookup[normalized_code] = {
                        "a": raw_code,
                        "b": str(row["상품명"] or ""),
                        "c": str(row["거래처"] or ""),
                        "d": str(row["거래처상품명"] or ""),
                        "e": color_size,
                        "f": str(row["거래처주소"] or ""),
                        "g": str(row["상품명합"] or ""),
                    }
            return lookup
        finally:
            conn.close()

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

        defect_counts = get_shared_defect_counts()
        kimsungil_counts = get_shared_kimsungil_counts()
        incoming_counts = get_shared_incoming_counts() or {}
        hapbae_rows = state.get("hapbae_pre_match_rows") or []
        order_qty_by_code: dict[str, int] = {}
        _target_shop_key = _normalize_shop_name(hapbae_target_shop)
        for _row in hapbae_rows:
            if _normalize_shop_name(_row.get("shop")) != _target_shop_key:
                continue
            _code = _row.get("code") or ""
            _qty = to_int(_row.get("orderQty"), default=0)
            if _code and _qty > 0:
                order_qty_by_code[_code] = order_qty_by_code.get(_code, 0) + _qty
        details = (state.get("details") or {}).get(inv, {})
        runs = (state.get("runs") or {}).get(inv, {})
        items = []
        for code in codes:
            det = details.get(code, {})
            incoming_qty = incoming_counts.get(code, 0)
            order_qty = order_qty_by_code.get(code, 0)
            items.append(
                {
                    "code": code,
                    "name": det.get("name", "") or "",
                    "option": det.get("option", "") or "",
                    "remain": mapping[inv].get(code, 0),
                    "run_len": runs.get(code, 0),
                    "defect": defect_counts.get(code, 0),
                    "incoming": incoming_qty,
                    "stock": max(0, order_qty - incoming_qty) if order_qty > incoming_qty else 0,
                    "kimsungil_incoming": kimsungil_counts.get(code, 0),
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

    def _get_kimsungil_list(state):
        kimsungil_counts = get_shared_kimsungil_counts()
        incoming_counts = get_shared_incoming_counts() or {}
        defect_base_lookup = _build_defect_base_lookup()
        rows = []
        for code, count in sorted(kimsungil_counts.items()):
            det = _find_item_detail_by_code(state, code)
            base_row = defect_base_lookup.get(code, {})
            rows.append(
                {
                    "code": code,
                    "count": count,
                    "incoming_qty": int(incoming_counts.get(code, 0) or 0),
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

    def _copy_original_mapping(mapping) -> dict:
        return {
            invoice: {code: int(qty or 0) for code, qty in codes.items()}
            for invoice, codes in (mapping or {}).items()
        }

    def _is_invoice_completed(state, invoice: str) -> bool:
        codes = (state.get("mapping") or {}).get(invoice) or {}
        return bool(codes) and all(int(remain or 0) == 0 for remain in codes.values())

    def _build_completed_xls_bytes(state) -> tuple[bytes, int]:
        original_mapping = state.get("original_mapping") or {}
        details = state.get("details") or {}
        invoice_order = state.get("invoice_order") or {}
        invoice_seq = state.get("invoice_seq") or list(original_mapping.keys())

        book = xlwt.Workbook()
        sheet = book.add_sheet("completed")
        header_style = xlwt.easyxf("font: bold on; align: horiz center;")
        headers = ["송장번호", "상품코드", "상품명", "옵션", "수량"]
        for col_idx, header in enumerate(headers):
            sheet.write(0, col_idx, header, header_style)

        row_idx = 1
        completed_count = 0
        seen = set()
        invoice_seq_set = set(invoice_seq)
        ordered_invoices = list(invoice_seq) + [
            invoice for invoice in original_mapping.keys() if invoice not in invoice_seq_set
        ]
        for invoice in ordered_invoices:
            if invoice in seen:
                continue
            seen.add(invoice)
            if not _is_invoice_completed(state, invoice):
                continue
            completed_count += 1
            codes = invoice_order.get(invoice) or list((original_mapping.get(invoice) or {}).keys())
            written_codes = set()
            for code in codes:
                if code in written_codes:
                    continue
                written_codes.add(code)
                qty = int((original_mapping.get(invoice) or {}).get(code, 0) or 0)
                if qty <= 0:
                    continue
                det = (details.get(invoice) or {}).get(code, {})
                sheet.write(row_idx, 0, str(invoice))
                sheet.write(row_idx, 1, str(code))
                sheet.write(row_idx, 2, det.get("name", "") or "")
                sheet.write(row_idx, 3, det.get("option", "") or "")
                sheet.write(row_idx, 4, qty)
                row_idx += 1

        sheet.col(0).width = 22 * 256
        sheet.col(1).width = 18 * 256
        sheet.col(2).width = 36 * 256
        sheet.col(3).width = 36 * 256
        sheet.col(4).width = 10 * 256
        buf = tempfile.SpooledTemporaryFile()
        book.save(buf)
        buf.seek(0)
        data = buf.read()
        buf.close()
        return data, completed_count

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
                "original_mapping": _copy_original_mapping(mapping),
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

    @router.post("/barcode/upload-from-ezadmin-orders")
    async def upload_from_ezadmin_orders(
        payload: dict = Body(default={}),
        user: str = Depends(get_current_user),
    ):
        phpsessid = (get_setting(_EZADMIN_SESSION_KEY) or "").strip()
        if not phpsessid:
            return {"ok": False, "need_session": True}

        today = str(payload.get("date") or datetime.now().strftime("%Y-%m-%d"))
        cookies = {"PHPSESSID": phpsessid}
        _kw = {"timeout": 600.0, "verify": False, "follow_redirects": True}

        par = (
            f"template=DS00&action=&search=1&page=1&_sort=&sort_order=&panel_open=true"
            f"&field_change=&bck_search=0&recover_delete=&date_type=trans_date"
            f"&start_date={today}&start_hour=00&end_date={today}&end_hour=23"
            f"&date_period_sel=0&option%5B%5D=seq&query_str%5B%5D="
            f"&multi_supply_group=&multi_supply=&str_supply_code=0"
            f"&status_sel=4&pack_sel=0&check_set_match=0&order_cs_sel=0&work_type=0"
            f"&checkbox_options_string=&trans_corp=99&user_area="
            f"&multi_shop_group=&multi_shop=&str_shop_code=0"
            f"&tags_string=&product_tag_include_type=1&labels_string=&order_label_include_type=1"
            f"&date_type2=0&start_date2={today}&start_hour2=00&end_date2={today}&end_hour2=23"
            f"&date_period_sel2=0&category=0&option%5B%5D=&query_str%5B%5D="
            f"&c_cs=blink&order_copy=0&create_order=0&print_enable=0&product_expect=0"
            f"&return_money_expect_price=&return_money_return_price="
            f"&trans_who=0&cs_reason=&multi_user_cs_type=&user_cs_type=0"
            f"&special_option%5B%5D=%EC%82%AC%EC%9D%80%ED%92%88%EC%84%A0%ED%83%9D"
            f"&select_field=DS00_1&download_field=DS00_file&download_type=0&include_sum=on"
        )

        try:
            async with httpx.AsyncClient(**_kw) as client:
                r = await client.post(
                    f"{_EZADMIN_BASE}/function.htm",
                    data={
                        "_search": "false",
                        "nd": str(int(datetime.now().timestamp() * 1000)),
                        "rows": "5000",
                        "page": "1",
                        "sidx": "",
                        "sord": "asc",
                        "template": "DS00",
                        "action": "grid_DS00",
                        "bck_search": "0",
                        "par": par,
                    },
                    cookies=cookies,
                    headers={
                        "X-Requested-With": "XMLHttpRequest",
                        "Referer": f"{_EZADMIN_BASE}/template40.htm?template=DS00",
                    },
                )
        except Exception as exc:
            return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}

        try:
            obj = r.json()
        except Exception:
            return {"ok": False, "need_session": True}

        if "rows" not in obj:
            return {"ok": False, "need_session": True}

        ez_rows = obj.get("rows", [])
        if not ez_rows:
            return {"ok": False, "error": f"{today} 조회된 주문이 없습니다."}

        _html_re = re.compile(r"<[^>]+>")

        def _strip(val):
            return _html_re.sub("", str(val or "")).strip()

        book = xlwt.Workbook()
        ws_xls = book.add_sheet("Sheet1")
        for ci, h in enumerate([
            "쇼핑몰", "주문번호", "수취인", "쇼핑몰", "", "", "",
            "상품코드", "상품명", "옵션", "수량", "", "송장번호", "주문일시",
        ]):
            ws_xls.write(0, ci, h)

        for ri, row in enumerate(ez_rows, 1):
            cell = row.get("cell", {}) or {}
            shop  = _strip(cell.get("shop_id", ""))
            pid   = _strip(cell.get("product_id", ""))
            name  = _strip(cell.get("name", ""))
            opts  = re.sub(r"^\[|\]$", "", _strip(cell.get("p_options", ""))).strip()
            trans = _strip(cell.get("trans_no", ""))
            tdate = _strip(cell.get("trans_date", "") or cell.get("collect_date", ""))
            try:
                qty_val = int(float(_strip(cell.get("qty", "1")) or "1"))
            except Exception:
                qty_val = 1

            ws_xls.write(ri, 0, shop)
            ws_xls.write(ri, 1, _strip(cell.get("order_id", "")))
            ws_xls.write(ri, 2, _strip(cell.get("recv_name", "")))
            ws_xls.write(ri, 3, shop)    # col 4: 쇼핑몰 (hapbae 고정)
            ws_xls.write(ri, 4, "")
            ws_xls.write(ri, 5, "")
            ws_xls.write(ri, 6, "")
            ws_xls.write(ri, 7, pid)     # col 8: 상품코드
            ws_xls.write(ri, 8, name)    # col 9: 상품명
            ws_xls.write(ri, 9, opts)    # col 10: 옵션
            ws_xls.write(ri, 10, qty_val) # col 11: 수량
            ws_xls.write(ri, 11, "")
            ws_xls.write(ri, 12, trans)  # col 13: 송장번호
            ws_xls.write(ri, 13, tdate)  # col 14: 주문일시

        import io as _io
        buf = _io.BytesIO()
        book.save(buf)
        xls_bytes = buf.getvalue()

        tmp_path = Path(tempfile.gettempdir()) / f"yusaek_ezadmin_orders_{uuid.uuid4().hex}.xls"
        tmp_path.write_bytes(xls_bytes)

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
            raise HTTPException(status_code=500, detail=f"주문 데이터 처리 실패: {exc}")
        finally:
            tmp_path.unlink(missing_ok=True)

        set_shared_barcode_data({
            "loaded": True,
            "processed_path": str(processed_path) if processed_path else None,
            "mapping": mapping,
            "original_mapping": _copy_original_mapping(mapping),
            "details": details,
            "runs": runs,
            "invoice_order": invoice_order,
            "invoice_seq": invoice_seq,
            "code_o_text": code_o_text,
            "hapbae_pre_match_rows": hapbae_pre_match_rows,
            "_detail_lookup": None,
            "_invoice_lookup": None,
        })
        _clear_hapbae_checked_rows()
        return {
            "ok": True,
            "invoices": len(mapping),
            "codes_total": sum(len(v) for v in mapping.values()),
            "total_rows": len(ez_rows),
            "date": today,
        }

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
            "defects": _get_defect_list(state),
            "kimsungil": _get_kimsungil_list(state),
            "invoice_has_defect": _invoice_has_defect(state, state["current_invoice"]),
            "incoming_codes": len(get_shared_incoming_counts() or {}),
            "incoming_total": sum((get_shared_incoming_counts() or {}).values()),
            "kimsungil_codes": len(get_shared_kimsungil_counts() or {}),
            "kimsungil_total": sum((get_shared_kimsungil_counts() or {}).values()),
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

        # TODAY 대량: 송장번호가 딱 1번만 나온 단건 주문 중 같은 상품이 10건 이상인 것
        unique_invoice_rows = [
            row for row in target_rows
            if _normalize_text(row.get("duplicateKey"))
            and counts_by_key[_normalize_text(row.get("duplicateKey"))] == 1
        ]
        today_bulk_lookup: dict[tuple, dict] = {}
        for row in unique_invoice_rows:
            key = (
                _normalize_text(row.get("productName")),
                _normalize_text(row.get("optionName")),
            )
            if key not in today_bulk_lookup:
                today_bulk_lookup[key] = {
                    "productName": row.get("productName", ""),
                    "optionName": row.get("optionName", ""),
                    "orderCount": 0,
                    "orderQty": 0,
                    "_codes": set(),
                    "_max_run_len": 0,
                }
            today_bulk_lookup[key]["orderCount"] += 1
            today_bulk_lookup[key]["orderQty"] += to_int(row.get("orderQty"), default=0)
            if row.get("code"):
                today_bulk_lookup[key]["_codes"].add(row["code"])
            run_len = int(row.get("runLen") or 0)
            if run_len > today_bulk_lookup[key]["_max_run_len"]:
                today_bulk_lookup[key]["_max_run_len"] = run_len
        today_bulk_rows = sorted(
            [
                {
                    **{k: v for k, v in entry.items() if k not in ("_codes", "_max_run_len")},
                    "runLen": entry["_max_run_len"],
                    "incomingQty": sum(int(incoming_counts.get(code, 0) or 0) for code in entry["_codes"]),
                }
                for entry in today_bulk_lookup.values()
                if entry["_max_run_len"] >= 10
                and any(int(incoming_counts.get(code, 0) or 0) >= 10 for code in entry["_codes"])
            ],
            key=lambda r: (-r["orderCount"], _normalize_text(r.get("productName")), _normalize_text(r.get("optionName"))),
        )

        return {
            "ok": True,
            "loaded": True,
            "incoming_loaded": bool(incoming_counts),
            "rows": grouped_rows,
            "stock_rows": grouped_stock_rows,
            "today_bulk_rows": today_bulk_rows,
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

    @router.get("/barcode/hapbae-pre-match/registered")
    def get_hapbae_registered_products(user: str = Depends(get_current_user)):
        return {"ok": True, "registered": _get_registered_products()}

    @router.post("/barcode/hapbae-pre-match/registered")
    def add_hapbae_registered_product(payload: dict = Body(...), user: str = Depends(get_current_user)):
        raw_code = str(payload.get("code") or "").strip()
        if not raw_code:
            raise HTTPException(status_code=400, detail="code required")
        code = normalize_to_yusas(raw_code) or raw_code
        label = str(payload.get("label") or "").strip()
        current = [item for item in _get_registered_products() if item["code"] != code]
        current.append({"code": code, "label": label})
        return {"ok": True, "registered": _set_registered_products(current)}

    @router.delete("/barcode/hapbae-pre-match/registered")
    def remove_hapbae_registered_product(payload: dict = Body(...), user: str = Depends(get_current_user)):
        code = str(payload.get("code") or "").strip()
        if not code:
            raise HTTPException(status_code=400, detail="code required")
        current = [item for item in _get_registered_products() if item["code"] != code]
        return {"ok": True, "registered": _set_registered_products(current)}

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
            "defects": _get_defect_list(state),
            "kimsungil": _get_kimsungil_list(state),
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
                "defects": _get_defect_list(state),
                "kimsungil": _get_kimsungil_list(state),
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
            "defects": _get_defect_list(state),
            "kimsungil": _get_kimsungil_list(state),
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
        conn = _get_wonbe_db()
        try:
            db_rows = conn.execute(
                "SELECT 상품코드, 상품명, 거래처, 거래처상품명, 색상, 사이즈, 거래처주소, 상품명합"
                " FROM wonbe WHERE 상품명합 IS NOT NULL AND 상품명합 != '' ORDER BY rowid ASC"
            ).fetchall()
        finally:
            conn.close()
        matches = []
        for row in db_rows:
            code = str(row["상품코드"] or "").strip()
            display_name = str(row["상품명합"] or "")
            if not code or not display_name:
                continue
            if not all(kw in _normalize_text(display_name).casefold() for kw in keywords):
                continue
            matches.append({
                "code": normalize_to_yusas(code) or code,
                "base_code": code,
                "base_name": display_name,
                "base_vendor": str(row["거래처"] or ""),
                "base_product": str(row["거래처상품명"] or ""),
                "base_color": _combine_color_size(str(row["색상"] or ""), str(row["사이즈"] or "")),
                "base_addr": str(row["거래처주소"] or ""),
            })
            if len(matches) >= 50:
                break
        return {"ok": True, "rows": matches}

    @router.get("/barcode/kimsungil/list")
    def list_kimsungil(user: str = Depends(get_current_user)):
        state = get_barcode_state(user)
        return {"ok": True, "kimsungil": _get_kimsungil_list(state)}

    @router.get("/barcode/kimsungil/search")
    def search_kimsungil(q: str = "", user: str = Depends(get_current_user)):
        return search_defects(q=q, user=user)

    @router.post("/barcode/kimsungil/add")
    def add_kimsungil(payload: dict = Body(...), user: str = Depends(get_current_user)):
        state = get_barcode_state(user)
        raw = (payload.get("code") or "").strip()
        if not raw:
            raise HTTPException(status_code=400, detail="code is required")

        code = normalize_to_yusas(raw) or raw
        kimsungil_counts = dict(get_shared_kimsungil_counts())
        kimsungil_counts[code] = kimsungil_counts.get(code, 0) + 1
        set_shared_kimsungil_counts(kimsungil_counts)

        inv = state.get("current_invoice")
        return {
            "ok": True,
            "code": code,
            "kimsungil_count": kimsungil_counts[code],
            "items": _get_all_items(state, inv) if inv else [],
            "current_next": _get_first_remaining_item(state, inv),
            "kimsungil": _get_kimsungil_list(state),
        }

    @router.post("/barcode/kimsungil/dec")
    def decrement_kimsungil(payload: dict = Body(...), user: str = Depends(get_current_user)):
        state = get_barcode_state(user)
        raw = (payload.get("code") or "").strip()
        if not raw:
            raise HTTPException(status_code=400, detail="code is required")

        code = normalize_to_yusas(raw) or raw
        kimsungil_counts = dict(get_shared_kimsungil_counts())
        if code in kimsungil_counts:
            kimsungil_counts[code] -= 1
            if kimsungil_counts[code] <= 0:
                del kimsungil_counts[code]
        set_shared_kimsungil_counts(kimsungil_counts)

        inv = state.get("current_invoice")
        return {
            "ok": True,
            "kimsungil": _get_kimsungil_list(state),
            "items": _get_all_items(state, inv) if inv else [],
            "current_next": _get_first_remaining_item(state, inv),
        }

    @router.post("/barcode/kimsungil/remove")
    def remove_kimsungil(payload: dict = Body(...), user: str = Depends(get_current_user)):
        state = get_barcode_state(user)
        raw = (payload.get("code") or "").strip()
        if not raw:
            raise HTTPException(status_code=400, detail="code is required")

        code = normalize_to_yusas(raw) or raw
        kimsungil_counts = dict(get_shared_kimsungil_counts())
        kimsungil_counts.pop(code, None)
        set_shared_kimsungil_counts(kimsungil_counts)

        inv = state.get("current_invoice")
        return {
            "ok": True,
            "kimsungil": _get_kimsungil_list(state),
            "items": _get_all_items(state, inv) if inv else [],
            "current_next": _get_first_remaining_item(state, inv),
        }

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

    @router.post("/barcode/defect/export-to-ezadmin")
    async def defect_export_to_ezadmin(
        payload: dict = Body(default={}),
        user: str = Depends(get_current_user),
    ):
        phpsessid = (get_setting(_EZADMIN_SESSION_KEY) or "").strip()
        if not phpsessid:
            return {"ok": False, "need_session": True}

        defect_counts = get_shared_defect_counts()
        if not defect_counts:
            return {"ok": False, "error": "불량 목록이 비어 있습니다."}

        xls_bytes = _build_defect_xls_bytes()
        cookies = {"PHPSESSID": phpsessid}
        ez_headers = {
            "User-Agent": "Mozilla/5.0",
            "Referer": "https://ga80.ezadmin.co.kr/template40.htm?template=I210",
            "X-Requested-With": "XMLHttpRequest",
        }
        base_url = f"{_EZADMIN_BASE}/function.htm"
        ts_ms = str(int(datetime.now().timestamp() * 1000))

        try:
            async with httpx.AsyncClient(timeout=120.0, verify=False, follow_redirects=True) as client:
                # Step 1: XLS 업로드 (응답이 JSON이 아닐 수 있으므로 상태코드만 확인)
                upload_r = await client.post(
                    base_url,
                    data={"template": "I200", "action": "upload_new"},
                    files={"_file": (f"defects_work_{ts_ms}.xls", xls_bytes, "application/vnd.ms-excel")},
                    cookies=cookies,
                    headers=ez_headers,
                )
                if upload_r.status_code >= 400:
                    return {"ok": False, "error": f"업로드 실패 (HTTP {upload_r.status_code})"}

                # Step 2: 미리보기 확인
                preview_r = await client.post(
                    base_url,
                    data={
                        "_search": "false", "nd": ts_ms,
                        "rows": "99999", "page": "1", "sidx": "", "sord": "asc",
                        "template": "I200", "action": "load_template_data_new",
                    },
                    cookies=cookies,
                    headers=ez_headers,
                )
                try:
                    preview_r.json()
                except Exception:
                    return {"ok": False, "need_session": True}

                # Step 3: 출고처리 실행
                time_flag = datetime.now().strftime("%a %b %d %Y %H:%M:%S GMT+0900 (한국 표준시)")
                apply_r = await client.post(
                    base_url,
                    data={
                        "template": "I200", "action": "apply_new",
                        "bad": "0", "type": "out",
                        "move_warehouse": "0", "save_stock": "0",
                        "stock_tag": "", "timeFlag": time_flag,
                    },
                    cookies=cookies,
                    headers=ez_headers,
                )
                try:
                    apply_r.json()
                except Exception:
                    return {"ok": False, "error": "출고처리 응답 파싱 실패"}

        except Exception as exc:
            return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}

        return {"ok": True, "count": len(defect_counts)}

    @router.get("/barcode/completed/export-xls")
    def export_completed_xls(user: str = Depends(get_current_user)):
        state = get_barcode_state(user)
        if not state["loaded"]:
            raise HTTPException(status_code=400, detail="Upload barcode data first")

        content, completed_count = _build_completed_xls_bytes(state)
        if completed_count <= 0:
            raise HTTPException(status_code=400, detail="다운로드할 완료목록이 없습니다")

        filename = f"completed_products_{datetime.now().strftime('%Y%m%d_%H%M%S')}.xls"
        headers = {"Content-Disposition": content_disposition(filename)}
        return Response(content=content, media_type="application/vnd.ms-excel", headers=headers)

    @router.get("/barcode/defect/base")
    def get_defect_base(user: str = Depends(get_current_user)):
        headers, rows = _read_defect_base_table()
        return {"ok": True, "headers": headers, "rows": rows}

    @router.post("/barcode/defect/base")
    def save_defect_base(payload: dict = Body(...), user: str = Depends(get_current_user)):
        rows = payload.get("rows")
        if not isinstance(rows, list):
            raise HTTPException(status_code=400, detail="rows must be a list")

        conn = _get_wonbe_db()
        try:
            for row in rows:
                values = row.get("values") if isinstance(row, dict) else row
                cells = [str(v or "").strip() for v in (values or [])]
                while len(cells) < 7:
                    cells.append("")
                code = normalize_to_yusas(cells[0]) or cells[0]
                if not code:
                    continue
                color, size = _split_color_size(cells[4])
                conn.execute(
                    """UPDATE wonbe SET 상품명=?, 거래처=?, 거래처상품명=?, 색상=?, 사이즈=?,
                       거래처주소=?, 상품명합=? WHERE 상품코드=?""",
                    (cells[1], cells[2], cells[3], color, size, cells[5], cells[6], code),
                )
            conn.commit()
            headers, saved_rows = _read_defect_base_table()
            return {"ok": True, "headers": headers, "rows": saved_rows}
        finally:
            conn.close()

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
        }

    @router.post("/barcode/defect/ochuul-minus")
    async def defect_ochuul_minus(user: str = Depends(get_current_user)):
        """불량 목록 기준으로 Ably 오출 재고 차감."""
        defect_counts = get_shared_defect_counts()
        if not defect_counts:
            return {"ok": True, "matched": 0, "details": [], "message": "불량 목록이 없습니다."}

        code_to_sno: dict[str, int] = {}
        _wconn = _get_wonbe_db()
        try:
            for _row in _wconn.execute(
                "SELECT 상품코드, 옵션번호 FROM wonbe WHERE 옵션번호 IS NOT NULL AND 옵션번호 != ''"
            ).fetchall():
                a_val = str(_row["상품코드"] or "").strip()
                k_val = _row["옵션번호"]
                if not a_val or not k_val:
                    continue
                normalized = normalize_to_yusas(a_val) or a_val
                try:
                    code_to_sno[normalized] = int(k_val)
                except (ValueError, TypeError):
                    pass
        finally:
            _wconn.close()

        sno_to_ea: dict[int, int] = {}
        for code, count in defect_counts.items():
            sno = code_to_sno.get(code)
            if sno and count > 0:
                sno_to_ea[sno] = sno_to_ea.get(sno, 0) + count

        if not sno_to_ea:
            return {"ok": True, "matched": 0, "details": [],
                    "message": "매칭된 옵션이 없습니다. 원가베이스 K열을 확인하세요."}

        try:
            token = await pastelco_login()
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"에이블리 로그인 실패: {e}")

        ably_base = "https://api.a-bly.com"
        my_headers = {
            "Authorization": f"JWT {token}", "Accept": "application/json",
            "Origin": "https://my.a-bly.com", "Referer": "https://my.a-bly.com/",
            "User-Agent": "Mozilla/5.0",
        }
        admin_headers = {
            "Authorization": f"JWT {token}", "Accept": "application/json",
            "Content-Type": "application/json",
            "Origin": "https://seller-admin.a-bly.com",
            "Referer": "https://seller-admin.a-bly.com/",
            "User-Agent": "Mozilla/5.0",
        }

        all_opts = []
        page = 1
        async with httpx.AsyncClient(timeout=30.0) as client:
            while True:
                res = await client.get(
                    f"{ably_base}/seller/today-delivery-goods-options/",
                    headers=my_headers,
                    params={"keyword_type": "goods_name", "current_page": page, "per_page": 50},
                )
                if res.status_code != 200:
                    break
                data = res.json()
                opts = data.get("data", [])
                if not opts:
                    break
                all_opts.extend(opts)
                if page >= data.get("max_page_number", 1):
                    break
                page += 1

        updates = []
        for opt in all_opts:
            sno = opt.get("sno")
            if sno not in sno_to_ea:
                continue
            ea = sno_to_ea[sno]
            current = int(opt.get("stock") or 0)
            new_stock = max(0, current - ea)
            updates.append({
                "sno": sno,
                "stock_sync_code": str(opt.get("stock_sync_code") or ""),
                "delivery_type": opt.get("delivery_type", "today"),
                "stock": new_stock,
                "safety_stock": int(opt.get("safety_stock") or 0),
                "use_stock": bool(opt.get("use_stock", False)),
                "is_display": bool(opt.get("is_display", True)),
                "_goods_name": opt.get("goods_name", ""),
                "_option_name": opt.get("option_name", ""),
                "_ea_minus": ea,
                "_prev_stock": current,
            })

        if updates:
            patch_payload = [{k: v for k, v in u.items() if not k.startswith("_")} for u in updates]
            async with httpx.AsyncClient(timeout=30.0) as client:
                res = await client.patch(
                    f"{ably_base}/seller/today-delivery-goods-options/bulk-update/",
                    headers=admin_headers,
                    json={"options": patch_payload},
                )
            if res.status_code not in (200, 201, 204):
                raise HTTPException(status_code=502,
                    detail=f"bulk-update 실패 (HTTP {res.status_code}): {res.text[:300]}")

        return {"ok": True, "matched": len(updates), "details": updates}

    @router.get("/ezadmin/session")
    def ezadmin_session_status(user: str = Depends(get_current_user)):
        phpsessid = get_setting(_EZADMIN_SESSION_KEY) or ""
        return {"ok": True, "has_session": bool(phpsessid.strip()), "phpsessid": phpsessid}

    @router.post("/ezadmin/session")
    def save_ezadmin_session(payload: dict = Body(...), user: str = Depends(get_current_user)):
        phpsessid = str(payload.get("phpsessid") or "").strip()
        if not phpsessid:
            raise HTTPException(status_code=400, detail="phpsessid is required")
        set_setting(_EZADMIN_SESSION_KEY, phpsessid)
        return {"ok": True}

    @router.get("/barcode/incoming/ezadmin-voucher-list")
    async def incoming_ezadmin_voucher_list(user: str = Depends(get_current_user)):
        phpsessid = (get_setting(_EZADMIN_SESSION_KEY) or "").strip()
        if not phpsessid:
            return {"ok": False, "need_session": True}
        today = datetime.now().strftime("%Y-%m-%d")
        _ez_client_kwargs = {"timeout": 20.0, "verify": False, "follow_redirects": True}
        cookies = {"PHPSESSID": phpsessid}
        try:
            async with httpx.AsyncClient(**_ez_client_kwargs) as client:
                r = await client.post(
                    f"{_EZADMIN_BASE}/function.htm",
                    data={
                        "_search": "false",
                        "nd": str(int(datetime.now().timestamp() * 1000)),
                        "rows": "9999",
                        "page": "1",
                        "sidx": "",
                        "sord": "asc",
                        "template": "IM00",
                        "action": "get_IM00_grid",
                        "par": (
                            "template=IM00&action=&page_code=IM00&search=1"
                            "&_sort=&sort_order=&date_type=crdate"
                            f"&start_date={today}&end_date={today}"
                            "&date_period_sel=0&query_option=title&query_str=&req_status=0"
                        ),
                    },
                    cookies=cookies,
                )
        except Exception:
            return {"ok": False, "need_session": True}
        try:
            obj = r.json()
        except Exception:
            return {"ok": False, "need_session": True}
        if "rows" not in obj:
            return {"ok": False, "need_session": True}
        _html_tag = re.compile(r"<[^>]+>")
        vouchers = []
        for row in obj.get("rows", []):
            cell = row.get("cell", {}) or {}
            raw_sheet = str(cell.get("sheet") or "").strip()
            sheet_no = raw_sheet
            # HTML <a> 태그에서 sheet 번호 추출
            for val in cell.values():
                if not isinstance(val, str) or "<a" not in val:
                    continue
                m = re.search(r"sheet=['\"]?(\w+)['\"]?", val, re.IGNORECASE)
                if m:
                    sheet_no = m.group(1)
                break
            if not sheet_no:
                continue
            # HTML 제거한 cell 필드 정리
            clean = {}
            for k, v in cell.items():
                if isinstance(v, str):
                    stripped = _html_tag.sub("", v).strip()
                    if stripped:
                        clean[k] = stripped
                elif v is not None and v != "":
                    clean[k] = v
            vouchers.append({"sheet": sheet_no, "cell": clean})
        return {"ok": True, "date": today, "vouchers": vouchers}

    @router.post("/barcode/incoming/upload-from-ezadmin")
    async def incoming_upload_from_ezadmin(
        payload: dict = Body(default={}),
        user: str = Depends(get_current_user),
    ):
        from io import BytesIO

        phpsessid = (get_setting(_EZADMIN_SESSION_KEY) or "").strip()
        if not phpsessid:
            return {"ok": False, "need_session": True}

        today = str(payload.get("date") or datetime.now().strftime("%Y-%m-%d"))
        cookies = {"PHPSESSID": phpsessid}

        _ez_client_kwargs = {"timeout": 20.0, "verify": False, "follow_redirects": True}

        # 1) 전표 목록 조회
        try:
            async with httpx.AsyncClient(**_ez_client_kwargs) as client:
                r = await client.post(
                    f"{_EZADMIN_BASE}/function.htm",
                    data={
                        "_search": "false",
                        "nd": str(int(datetime.now().timestamp() * 1000)),
                        "rows": "9999",
                        "page": "1",
                        "sidx": "",
                        "sord": "asc",
                        "template": "IM00",
                        "action": "get_IM00_grid",
                        "par": (
                            "template=IM00&action=&page_code=IM00&search=1"
                            "&_sort=&sort_order=&date_type=crdate"
                            f"&start_date={today}&end_date={today}"
                            "&date_period_sel=0&query_option=title&query_str=&req_status=0"
                        ),
                    },
                    cookies=cookies,
                )
        except Exception as exc:
            traceback.print_exc()
            raise HTTPException(status_code=500, detail=f"EZAdmin 연결 실패: {exc}")

        try:
            obj = r.json()
        except Exception:
            return {"ok": False, "need_session": True}

        if "rows" not in obj:
            return {"ok": False, "need_session": True}

        sheet_list = [
            str(row["cell"]["sheet"])
            for row in obj.get("rows", [])
            if row.get("cell", {}).get("sheet")
        ]
        if not sheet_list:
            return {"ok": False, "need_session": False, "detail": f"{today} 전표가 없습니다."}

        # 2) 다운로드 작업 등록
        par = (
            "template=IM00&action=save_file_IM00&filename=&page_code=IM10_file_2"
            f"&sheet_list={','.join(sheet_list)}&download_type=1&select_code=IM00_file"
            f"&date_type=crdate&start_date={today}&end_date={today}&date_period_sel="
            "&multi_supply_group=undefined&multi_supply=undefined&str_supply_code=undefined"
            "&sub_domain_seq=undefined&req_status=0&query_option=title&query_str=&readonly=T"
        )
        try:
            async with httpx.AsyncClient(**_ez_client_kwargs) as client:
                await client.post(
                    f"{_EZADMIN_BASE}/function.htm",
                    data={
                        "template": "download",
                        "action": "ins_download_worklist",
                        "work_template": "IM00",
                        "work_func": "save_file_IM00",
                        "par": par,
                    },
                    headers={"X-Requested-With": "XMLHttpRequest"},
                    cookies=cookies,
                )
        except Exception as exc:
            traceback.print_exc()
            raise HTTPException(status_code=500, detail=f"다운로드 작업 등록 실패: {exc}")

        # 3) BL30 폴링 (최대 30회 × 2초)
        file_url = None
        for _ in range(30):
            await asyncio.sleep(2)
            try:
                async with httpx.AsyncClient(**_ez_client_kwargs) as client:
                    r = await client.post(
                        f"{_EZADMIN_BASE}/function.htm",
                        data={
                            "_search": "false",
                            "nd": str(int(datetime.now().timestamp() * 1000)),
                            "rows": "300",
                            "page": "1",
                            "sidx": "",
                            "sord": "asc",
                            "template": "BL30",
                            "action": "grid_BL30",
                            "par": (
                                "template=BL30&action=&bck_search="
                                f"&start_date={today}&start_hour=00%3A00%3A00"
                                f"&end_date={today}&end_hour=23%3A59%3A59"
                                "&date_period_sel=0"
                            ),
                        },
                        cookies=cookies,
                    )
                try:
                    bl = r.json()
                except Exception:
                    return {"ok": False, "need_session": True}
                if "rows" not in bl:
                    return {"ok": False, "need_session": True}
                for row in bl.get("rows", []):
                    cell = row.get("cell", {})
                    if cell.get("template") == "입고요청전표2" and cell.get("status") == "완료":
                        file_url = cell.get("file_name")
                        break
                if file_url:
                    break
            except Exception:
                continue

        if not file_url:
            return {"ok": False, "need_session": False, "detail": "완료된 다운로드 파일을 찾지 못했습니다."}

        # 4) 파일 다운로드 & 파싱
        try:
            async with httpx.AsyncClient(timeout=30.0, verify=False, follow_redirects=True) as client:
                r = await client.get(file_url, cookies=cookies)
            r.raise_for_status()
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"파일 다운로드 실패: {exc}")

        suffix = ".xls"
        tmp_path = Path(tempfile.gettempdir()) / f"yusaek_ezadmin_incoming_{uuid.uuid4().hex}{suffix}"
        tmp_path.write_bytes(r.content)
        try:
            wb, ws = load_excel_any(tmp_path)
            counts = Counter()
            for row_num in range(1, ws.max_row + 1):
                code = normalize_to_yusas(ws.cell(row_num, 1).value)
                qty = to_int(ws.cell(row_num, 2).value, default=0)
                if code and qty > 0:
                    counts[code] += qty
        except Exception as exc:
            traceback.print_exc()
            raise HTTPException(status_code=500, detail=f"파일 파싱 실패: {exc}")
        finally:
            tmp_path.unlink(missing_ok=True)

        set_shared_incoming_counts(dict(counts))
        return {"ok": True, "codes": len(counts), "total_qty": sum(counts.values())}

    @router.post("/barcode/incoming/raw-file-from-ezadmin")
    async def incoming_raw_file_from_ezadmin(
        payload: dict = Body(default={}),
        user: str = Depends(get_current_user),
    ):
        phpsessid = (get_setting(_EZADMIN_SESSION_KEY) or "").strip()
        if not phpsessid:
            return {"ok": False, "need_session": True}

        today = str(payload.get("date") or datetime.now().strftime("%Y-%m-%d"))
        cookies = {"PHPSESSID": phpsessid}
        _kw = {"timeout": 20.0, "verify": False, "follow_redirects": True}

        sheet_list_override = [str(s).strip() for s in (payload.get("sheet_list") or []) if str(s).strip()]
        if sheet_list_override:
            sheet_list = sheet_list_override
        else:
            try:
                async with httpx.AsyncClient(**_kw) as client:
                    r = await client.post(
                        f"{_EZADMIN_BASE}/function.htm",
                        data={
                            "_search": "false",
                            "nd": str(int(datetime.now().timestamp() * 1000)),
                            "rows": "9999", "page": "1", "sidx": "", "sord": "asc",
                            "template": "IM00", "action": "get_IM00_grid",
                            "par": (
                                "template=IM00&action=&page_code=IM00&search=1"
                                "&_sort=&sort_order=&date_type=crdate"
                                f"&start_date={today}&end_date={today}"
                                "&date_period_sel=0&query_option=title&query_str=&req_status=0"
                            ),
                        },
                        cookies=cookies,
                    )
            except Exception as exc:
                return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}

            try:
                obj = r.json()
            except Exception:
                return {"ok": False, "need_session": True}

            if "rows" not in obj:
                return {"ok": False, "need_session": True}

            sheet_list = [
                str(row["cell"]["sheet"])
                for row in obj.get("rows", [])
                if row.get("cell", {}).get("sheet")
            ]
            if not sheet_list:
                return {"ok": False, "error": f"{today} 전표가 없습니다."}

        page_code = str(payload.get("page_code") or "IM10_file_2")
        par = (
            f"template=IM00&action=save_file_IM00&filename=&page_code={page_code}"
            f"&sheet_list={','.join(sheet_list)}&download_type=1&select_code=IM00_file"
            f"&date_type=crdate&start_date={today}&end_date={today}&date_period_sel="
            "&multi_supply_group=undefined&multi_supply=undefined&str_supply_code=undefined"
            "&sub_domain_seq=undefined&req_status=0&query_option=title&query_str=&readonly=T"
        )
        try:
            async with httpx.AsyncClient(**_kw) as client:
                await client.post(
                    f"{_EZADMIN_BASE}/function.htm",
                    data={
                        "template": "download", "action": "ins_download_worklist",
                        "work_template": "IM00", "work_func": "save_file_IM00", "par": par,
                    },
                    headers={"X-Requested-With": "XMLHttpRequest"},
                    cookies=cookies,
                )
        except Exception as exc:
            return {"ok": False, "error": f"다운로드 작업 등록 실패: {type(exc).__name__}: {exc}"}

        file_url = None
        for _ in range(30):
            await asyncio.sleep(2)
            try:
                async with httpx.AsyncClient(**_kw) as client:
                    r = await client.post(
                        f"{_EZADMIN_BASE}/function.htm",
                        data={
                            "_search": "false",
                            "nd": str(int(datetime.now().timestamp() * 1000)),
                            "rows": "300", "page": "1", "sidx": "", "sord": "asc",
                            "template": "BL30", "action": "grid_BL30",
                            "par": (
                                "template=BL30&action=&bck_search="
                                f"&start_date={today}&start_hour=00%3A00%3A00"
                                f"&end_date={today}&end_hour=23%3A59%3A59"
                                "&date_period_sel=0"
                            ),
                        },
                        cookies=cookies,
                    )
                try:
                    bl = r.json()
                except Exception:
                    return {"ok": False, "need_session": True}
                if "rows" not in bl:
                    return {"ok": False, "need_session": True}
                for row in bl.get("rows", []):
                    cell = row.get("cell", {})
                    if cell.get("template") == "입고요청전표2" and cell.get("status") == "완료":
                        file_url = cell.get("file_name")
                        break
                if file_url:
                    break
            except Exception:
                continue

        if not file_url:
            return {"ok": False, "error": "완료된 다운로드 파일을 찾지 못했습니다."}

        try:
            async with httpx.AsyncClient(timeout=30.0, verify=False, follow_redirects=True) as client:
                r = await client.get(file_url, cookies=cookies)
            r.raise_for_status()
        except Exception as exc:
            return {"ok": False, "error": f"파일 다운로드 실패: {type(exc).__name__}: {exc}"}

        from fastapi.responses import Response as FastAPIResponse
        return FastAPIResponse(
            content=r.content,
            media_type="application/vnd.ms-excel",
            headers={"Content-Disposition": 'attachment; filename="incoming.xls"'},
        )

    @router.post("/barcode/base-file-from-ezadmin")
    async def base_file_from_ezadmin(
        payload: dict = Body(default={}),
        user: str = Depends(get_current_user),
    ):
        phpsessid = (get_setting(_EZADMIN_SESSION_KEY) or "").strip()
        if not phpsessid:
            return {"ok": False, "need_session": True}

        from datetime import timedelta
        import io as _io
        today = datetime.now()
        start = str(payload.get("start_date") or (today - timedelta(days=90)).strftime("%Y-%m-%d"))
        end = str(payload.get("end_date") or today.strftime("%Y-%m-%d"))
        nd = str(int(today.timestamp() * 1000))

        par = (
            f"template=IO30&action=&page_code=IO00&search=1&now_page=&is_sort=&"
            f"_sort=supply_options&sort_order=1&product_qty_list=&bill_seq=&"
            f"offset_top=&work_no=&location_str=&date_type=collect_date&"
            f"start_date={start}&start_hour=00%3A00%3A00&"
            f"end_date={end}&end_hour=23%3A59%3A59&"
            f"date_period_sel=9&multi_shop_group=&multi_shop=&str_shop_code=0&"
            f"multi_supply_group=&multi_supply=&str_supply_code=0&"
            f"supply_name_search=&brand=&supply_options=&tags_string=&"
            f"product_tag_include_type=1&product_id=&name=&options=&"
            f"search_keyword_type=origin&search_keyword=&enable_stock_type=2&"
            f"order_status=3&except_soldout=1&sel_reserve_qty=none&"
            f"sel_return_qty=none&sel_lack_qty=none&sel_req_qty=none&category=0"
        )

        cookies = {"PHPSESSID": phpsessid}
        _kw = {"timeout": 30.0, "verify": False, "follow_redirects": True}

        try:
            async with httpx.AsyncClient(**_kw) as client:
                r = await client.post(
                    f"{_EZADMIN_BASE}/function.htm",
                    data={
                        "_search": "false", "nd": nd,
                        "rows": "1000", "page": "1", "sidx": "", "sord": "asc",
                        "template": "IO30", "action": "search_IO30", "par": par,
                    },
                    cookies=cookies,
                    headers={
                        "X-Requested-With": "XMLHttpRequest",
                        "Referer": "https://ga80.ezadmin.co.kr/template40.htm?template=IO30",
                    },
                )
        except Exception as exc:
            return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}

        try:
            obj = r.json()
        except Exception:
            return {"ok": False, "need_session": True}

        if "rows" not in obj:
            return {"ok": False, "need_session": True}

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

        wb = xlwt.Workbook()
        ws = wb.add_sheet("Sheet1")
        for ci, h in enumerate(["상품명", "공급처상품명", "옵션추가항목5", "옵션추가항목6", "옵션추가항목7",
                                 "옵션", "요청수량", "입고수량", "상품코드", "옵션추가항목8", "원가", "입고대기"]):
            ws.write(0, ci, h)

        for ri, row in enumerate(obj.get("rows", []), 1):
            cell = row.get("cell", row)
            ws.write(ri, 0, _ez_val(cell.get("product_name")))
            ws.write(ri, 1, _ez_val(cell.get("supply_product_name")))
            ws.write(ri, 2, ""); ws.write(ri, 3, ""); ws.write(ri, 4, "")
            ws.write(ri, 5, _ez_val(cell.get("options")))
            ws.write(ri, 6, _ez_val(cell.get("request_qty")))
            ws.write(ri, 7, "")
            ws.write(ri, 8, _ez_val(cell.get("product_id")))
            ws.write(ri, 9, ""); ws.write(ri, 10, "")
            ws.write(ri, 11, _ez_val(cell.get("reserve_qty")))

        buf = _io.BytesIO()
        wb.save(buf)

        from fastapi.responses import Response as FastAPIResponse
        return FastAPIResponse(
            content=buf.getvalue(),
            media_type="application/vnd.ms-excel",
            headers={"Content-Disposition": 'attachment; filename="base_file.xls"'},
        )

    return router
