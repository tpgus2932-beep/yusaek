import asyncio
import tempfile
import traceback
import uuid
import warnings
warnings.filterwarnings("ignore", message="Unverified HTTPS request")
from collections import Counter
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo
from pathlib import Path
import json
import re
from time import perf_counter

import httpx
import pandas as pd
import xlwt
from fastapi import APIRouter, Body, Depends, File, HTTPException, Response, UploadFile
from openpyxl import load_workbook

from sdk.ably import AblyClient
from services import ezadmin_orders as ezo
from services import ezadmin_product_rename as ez_product_rename
from services.easyadmin_product import process_easyadmin_product_from_api
from services.order_history_store import init_order_history_table
from services.pastelco_utils import pastelco_login

_ABLY_BASE     = "https://api.a-bly.com"
_ABLY_EMAIL    = "eostm1997@naver.com"
_ABLY_PASSWORD = "!Glqgkqdldi1126"

_EZADMIN_BASE        = "https://ga80.ezadmin.co.kr"
_EZADMIN_SESSION_KEY = "ezadmin_phpsessid"
_KST = ZoneInfo("Asia/Seoul")
_INCOMING_VERIFY_EXCLUDED_CLIENTS = {"케이디지", "리자드스탠다드", "리마인드", "계란속노른자", "도매킴"}
_SCHEDULE_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

from services import defect_tab as defect_tab_service
from services.defect_tab import bind_defect_tab
from services.ezadmin_stock_log import fetch_ezadmin_stock_logs
from services import normalization_log
from sdk.ezadmin import EzAdminClient, EzAdminSessionExpired
from api.wonbe_routes import WONBE_DB_PATH, _get_wonbe_db as _get_wonbe_db, record_defect_process_logs
from barcode_core import normalize_to_s5


def build_barcode_router(
    *,
    get_current_user,
    get_barcode_state,
    to_int,
    process_and_load_any,
    load_excel_any,
    normalize_code,
    process_easyadmin_product_upload,
    content_disposition,
    get_shared_incoming_counts,
    set_shared_incoming_counts,
    get_shared_defect_counts,
    set_shared_defect_counts,
    get_shared_defect_summon_counts,
    set_shared_defect_summon_counts,
    get_shared_kimsungil_counts,
    set_shared_kimsungil_counts,
    set_shared_barcode_data,
    get_setting,
    set_setting,
    get_user_display,
    get_shared_db,
    get_db,
    get_all_tabs_defect_summon_counts=None,
    get_all_tabs_defect_counts=None,
    get_normalization_db=None,
    on_ezadmin_orders_loaded=None,
):
    router = APIRouter(dependencies=[Depends(bind_defect_tab)])
    _DEFECT_BASE_HEADERS = ["상품코드", "상품명", "공급처", "공급처상품명", "색상 사이즈", "주소", "표시형 상품명"]
    hapbae_target_shop = "에이블리(유색)"
    hapbae_checked_rows_key = "test_hapbae_checked_rows"
    hapbae_checked_rows_today_key = "test_hapbae_checked_rows_today"
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

    def _get_hapbae_checked_rows_shared() -> dict[str, bool]:
        raw = get_setting(hapbae_checked_rows_key) or "{}"
        try:
            parsed = json.loads(raw)
        except Exception:
            parsed = {}
        if not isinstance(parsed, dict):
            return {}
        clean = {}
        for key, value in parsed.items():
            if isinstance(key, str) and key.strip() and value and not key.strip().startswith("today::"):
                clean[key.strip()] = True
        return clean

    def _set_hapbae_checked_rows_shared(checked_rows: dict[str, bool]):
        clean = {
            key.strip(): True
            for key, value in checked_rows.items()
            if isinstance(key, str) and key.strip() and value and not key.strip().startswith("today::")
        }
        set_setting(hapbae_checked_rows_key, json.dumps(clean, ensure_ascii=False))
        return clean

    # TODAY 대량 섹션은 계정마다 진행 상황이 달라서, 다른 섹션(공용)과 분리해
    # 사용자별로 체크 상태를 저장한다: { username: { "today::...": true } }
    def _get_hapbae_checked_rows_today_all() -> dict[str, dict[str, bool]]:
        raw = get_setting(hapbae_checked_rows_today_key) or "{}"
        try:
            parsed = json.loads(raw)
        except Exception:
            parsed = {}
        if not isinstance(parsed, dict):
            return {}
        clean = {}
        for user_key, rows in parsed.items():
            if not isinstance(user_key, str) or not user_key.strip() or not isinstance(rows, dict):
                continue
            clean_rows = {
                key.strip(): True
                for key, value in rows.items()
                if isinstance(key, str) and key.strip() and value
            }
            if clean_rows:
                clean[user_key.strip()] = clean_rows
        return clean

    def _set_hapbae_checked_rows_today_all(all_rows: dict[str, dict[str, bool]]):
        set_setting(hapbae_checked_rows_today_key, json.dumps(all_rows, ensure_ascii=False))
        return all_rows

    def _get_hapbae_checked_rows(user: str) -> dict[str, bool]:
        merged = _get_hapbae_checked_rows_shared()
        merged.update(_get_hapbae_checked_rows_today_all().get(user, {}))
        return merged

    def _set_hapbae_checked_row(user: str, key: str, checked: bool) -> dict[str, bool]:
        if key.startswith("today::"):
            all_today = _get_hapbae_checked_rows_today_all()
            user_rows = dict(all_today.get(user, {}))
            if checked:
                user_rows[key] = True
            else:
                user_rows.pop(key, None)
            if user_rows:
                all_today[user] = user_rows
            else:
                all_today.pop(user, None)
            _set_hapbae_checked_rows_today_all(all_today)
        else:
            shared = _get_hapbae_checked_rows_shared()
            if checked:
                shared[key] = True
            else:
                shared.pop(key, None)
            _set_hapbae_checked_rows_shared(shared)
        return _get_hapbae_checked_rows(user)

    def _clear_hapbae_checked_rows():
        _set_hapbae_checked_rows_shared({})
        _set_hapbae_checked_rows_today_all({})

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

    def _lookup_wonbe_labels(codes: set[str]) -> dict[str, str]:
        if not codes:
            return {}
        conn = _get_wonbe_db()
        try:
            rows = conn.execute("SELECT 상품코드, 거래처, 상품명합 FROM wonbe").fetchall()
            lookup: dict[str, str] = {}
            for row in rows:
                raw_code = str(row["상품코드"] or "").strip()
                normalized = normalize_code(raw_code) or raw_code
                if normalized in codes and normalized not in lookup:
                    label = " / ".join(
                        p for p in [str(row["거래처"] or "").strip(), str(row["상품명합"] or "").strip()] if p
                    )
                    lookup[normalized] = label
            return lookup
        finally:
            conn.close()

    def _parse_dt_hapbae(v):
        if isinstance(v, datetime):
            return v
        if v is None or str(v).strip() == "":
            return None
        s = str(v).strip()
        try:
            return datetime.fromisoformat(s)
        except Exception:
            try:
                return datetime.strptime(s, "%Y-%m-%d %H:%M:%S")
            except Exception:
                return None

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
                code = normalize_code(raw_code)
                duplicate_key = _normalize_text(ws.cell(row_idx, 13).value)
                shop = _normalize_text(ws.cell(row_idx, 4).value)
                if not duplicate_key and not shop and not code:
                    continue
                raw_trans_date = ws.cell(row_idx, 14).value
                rows.append({
                    "rowNumber": row_idx,
                    "shop": shop,
                    "duplicateKey": duplicate_key,
                    "code": code,
                    "productName": _normalize_text(ws.cell(row_idx, name_col).value),
                    "optionName": _normalize_text(ws.cell(row_idx, option_col).value),
                    "orderQty": _normalize_text(ws.cell(row_idx, qty_col).value),
                    "transDate": _normalize_text(raw_trans_date),
                    "_dt": _parse_dt_hapbae(raw_trans_date),
                    "runLen": 0,
                })

            # 스캔 화면(barcode_core.py process_and_load_any)과 동일한 연속 판정:
            # 시간순 정렬(동률이면 원본 행 순서 유지) 후, 송장번호·상품코드·수량이 모두
            # 유효한 행만 대상으로 바로 앞 유효 행이 같은 코드이거나 같은 코드가 2초 이내에
            # 다시 나오면 하나의 연속으로 간주한다 (날짜 문자열 완전일치 요구 X)
            rows.sort(key=lambda r: r["_dt"] or datetime.max)
            last_time_code: dict[str, datetime] = {}
            cur_run_len_code: dict[str, int] = {}
            cur_run_members: dict[str, list[int]] = {}
            prev_code_row = None

            def _flush_run(code: str):
                length = cur_run_len_code.get(code, 0)
                if length > 1:
                    for idx in cur_run_members.get(code, []):
                        rows[idx]["runLen"] = length
                cur_run_len_code[code] = 0
                cur_run_members[code] = []

            for idx, row in enumerate(rows):
                code = row["code"]
                qty = to_int(row.get("orderQty"), default=0)
                if not (row.get("duplicateKey") and code) or qty <= 0:
                    prev_code_row = code
                    continue
                t = row["_dt"]
                same_run = False
                if prev_code_row == code:
                    same_run = True
                else:
                    lt = last_time_code.get(code)
                    if lt and t and abs((t - lt).total_seconds()) <= 2:
                        same_run = True
                if same_run:
                    cur_run_len_code[code] = cur_run_len_code.get(code, 0) + 1
                    cur_run_members.setdefault(code, []).append(idx)
                else:
                    if cur_run_len_code.get(code, 0) > 0:
                        _flush_run(code)
                    cur_run_len_code[code] = 1
                    cur_run_members[code] = [idx]
                if t:
                    last_time_code[code] = t
                prev_code_row = code

            for code in list(cur_run_len_code.keys()):
                if cur_run_len_code.get(code, 0) > 0:
                    _flush_run(code)

            for row in rows:
                row.pop("_dt", None)
            return rows
        finally:
            try:
                wb.close()
            except Exception:
                pass

    def _build_ezadmin_order_state(ez_rows: list[dict]):
        """Build barcode state directly from the DS00 JSON response.

        This mirrors the former temporary-XLS parsing path without writing or
        reading an intermediate file.
        """
        html_re = re.compile(r"<[^>]+>")

        def clean(value):
            return html_re.sub("", str(value or "")).strip()

        def parse_qty(value):
            try:
                return int(float(clean(value) or "1"))
            except (TypeError, ValueError):
                return 1

        prepared = []
        for index, source_row in enumerate(ez_rows, start=2):
            cell = source_row.get("cell", {}) or {}
            raw_code = clean(cell.get("product_id", ""))
            code = normalize_code(raw_code)
            invoice = clean(cell.get("trans_no", ""))
            trans_date = clean(cell.get("trans_date", "") or cell.get("collect_date", ""))
            prepared.append({
                "rowNumber": index,
                "shop": clean(cell.get("shop_id", "")),
                "duplicateKey": invoice,
                "code": code,
                "productName": clean(cell.get("name", "")),
                "optionName": re.sub(r"^\[|\]$", "", clean(cell.get("p_options", ""))).strip(),
                "orderQty": parse_qty(cell.get("qty", "1")),
                "transDate": trans_date,
                "_dt": _parse_dt_hapbae(trans_date),
            })

        prepared.sort(key=lambda row: row["_dt"] or datetime.max)
        mapping = {}
        details = {}
        invoice_order = {}
        invoice_seq = []
        code_o_text = {}
        seen_invoices = set()

        last_time_code = {}
        current_run_length = {}
        current_run_members = {}
        run_length_by_invoice_code = {}
        prev_code = None

        def flush_run(code):
            length = current_run_length.get(code, 0)
            if length > 1:
                for invoice, product_code in current_run_members.get(code, []):
                    key = (invoice, product_code)
                    run_length_by_invoice_code[key] = max(run_length_by_invoice_code.get(key, 0), length)
            current_run_length[code] = 0
            current_run_members[code] = []

        for row in prepared:
            code = row["code"]
            invoice = row["duplicateKey"]
            qty = row["orderQty"]
            if not (invoice and code) or qty <= 0:
                prev_code = code
                continue

            if invoice not in seen_invoices:
                seen_invoices.add(invoice)
                invoice_seq.append(invoice)
                mapping[invoice] = {}
                details[invoice] = {}
                invoice_order[invoice] = []
            if code not in invoice_order[invoice]:
                invoice_order[invoice].append(code)
            mapping[invoice][code] = mapping[invoice].get(code, 0) + qty
            details[invoice].setdefault(code, {"name": row["productName"], "option": row["optionName"]})

            timestamp = row["_dt"]
            same_run = prev_code == code
            if not same_run:
                last_seen = last_time_code.get(code)
                same_run = bool(last_seen and timestamp and abs((timestamp - last_seen).total_seconds()) <= 2)
            if same_run:
                current_run_length[code] = current_run_length.get(code, 0) + 1
                current_run_members.setdefault(code, []).append((invoice, code))
            else:
                if current_run_length.get(code, 0):
                    flush_run(code)
                current_run_length[code] = 1
                current_run_members[code] = [(invoice, code)]
            if timestamp:
                last_time_code[code] = timestamp
            prev_code = code

        for code in list(current_run_length):
            flush_run(code)

        runs = {}
        for (invoice, code), length in run_length_by_invoice_code.items():
            runs.setdefault(invoice, {})[code] = length

        pre_match_rows = []
        for row in prepared:
            pre_match_rows.append({
                key: value for key, value in row.items() if key != "_dt"
            } | {"runLen": 0})
        for index, row in enumerate(prepared):
            code = row["code"]
            invoice = row["duplicateKey"]
            pre_match_rows[index]["runLen"] = run_length_by_invoice_code.get((invoice, code), 0)

        return mapping, details, runs, invoice_order, invoice_seq, code_o_text, pre_match_rows

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

    _defect_base_cache = {"sig": None, "lookup": None}

    def _wonbe_db_signature():
        # 원가베이스 DB 파일이 바뀌었는지 stat 한 번으로 판별한다. 파일이 없으면 None(캐시 안 씀).
        sig = []
        for suffix in ("", "-wal"):
            try:
                st = Path(str(WONBE_DB_PATH) + suffix).stat()
            except OSError:
                if not suffix:
                    return None
                continue
            sig.append((st.st_mtime_ns, st.st_size))
        return tuple(sig)

    def _build_defect_base_lookup():
        # 스캔마다 호출되므로 원가베이스 전체 SELECT+정규화를 DB 파일이 바뀔 때만 다시 한다.
        sig = _wonbe_db_signature()
        if sig is not None and sig == _defect_base_cache["sig"]:
            return _defect_base_cache["lookup"]
        lookup = _build_defect_base_lookup_uncached()
        _defect_base_cache["sig"] = sig
        _defect_base_cache["lookup"] = lookup
        return lookup

    def _build_defect_base_lookup_uncached():
        conn = _get_wonbe_db()
        try:
            db_rows = conn.execute(
                "SELECT 상품코드, 상품명, 거래처, 거래처상품명, 색상, 사이즈, 거래처주소, 상품명합, 원가 FROM wonbe"
            ).fetchall()
            lookup = {}
            for row in db_rows:
                raw_code = str(row["상품코드"] or "").strip()
                normalized_code = normalize_code(raw_code) or raw_code
                if normalized_code:
                    color_size = _combine_color_size(str(row["색상"] or ""), str(row["사이즈"] or ""))
                    try:
                        cost = int(float(str(row["원가"] or "").replace(",", "").strip()))
                    except ValueError:
                        cost = 0
                    lookup[normalized_code] = {
                        "cost": cost,
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

    def _get_defect_list(state, *, exclude_kimsungil: bool = False):
        defect_counts = get_shared_defect_counts()
        summon_counts = get_shared_defect_summon_counts()
        matched_counts = _summon_matched_counts(summon_counts)
        defect_base_lookup = _build_defect_base_lookup()
        rows = []
        for code, count in sorted(defect_counts.items()):
            summon_qty = summon_counts.get(code, 0)
            if exclude_kimsungil and summon_qty > 0:
                continue
            det = _find_item_detail_by_code(state, code)
            base_row = defect_base_lookup.get(code, {})
            rows.append(
                {
                    "code": code,
                    "count": count,
                    "kimsungil_summon_qty": summon_qty,
                    # 불러온 수량 중 바코드 매칭으로 실물 확인된 수량 (출력·매입관리는 이 수량만 쓴다)
                    "summon_matched_qty": min(matched_counts.get(code, 0), summon_qty),
                    "normal_qty": max(0, count - summon_qty),
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
                    "base_cost": base_row.get("cost", 0),
                    "base_vendor": base_row.get("c", ""),
                    "base_product": base_row.get("d", ""),
                    "base_color": base_row.get("e", ""),
                    "base_addr": base_row.get("f", ""),
                    "base_name": base_row.get("g", ""),
                    "base_option": " " if base_row.get("g", "") else "",
                }
            )
        return rows

    def _kimsungil_display_name(state, code: str) -> str:
        det = _find_item_detail_by_code(state, code)
        base_row = _build_defect_base_lookup().get(code, {})
        return base_row.get("g") or det.get("name") or ""

    def _log_kimsungil_event(*, code: str, name: str, action: str, method: str, count_after: int, user: str):
        now = datetime.now(_KST).isoformat()
        conn = get_shared_db()
        try:
            conn.execute(
                """
                INSERT INTO kimsungil_log
                    (created_at, code, name, action, method, count_after, username, display_name)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (now, code, name, action, method, count_after, user, get_user_display(user)),
            )
            conn.commit()
        finally:
            conn.close()

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

    def _build_defect_xls_bytes(*, exclude_kimsungil: bool = False) -> bytes:
        defect_counts = get_shared_defect_counts()
        if exclude_kimsungil:
            summon_counts = get_shared_defect_summon_counts()
            defect_counts = {c: q for c, q in defect_counts.items() if not summon_counts.get(c)}
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

    def _build_orders_xls_bytes(state) -> tuple[bytes, int]:
        original_mapping = state.get("original_mapping") or {}
        details = state.get("details") or {}
        invoice_order = state.get("invoice_order") or {}
        invoice_seq = state.get("invoice_seq") or list(original_mapping.keys())

        book = xlwt.Workbook()
        sheet = book.add_sheet("orders")
        header_style = xlwt.easyxf("font: bold on; align: horiz center;")
        headers = ["송장번호", "상품코드", "상품명", "옵션", "수량"]
        for col_idx, header in enumerate(headers):
            sheet.write(0, col_idx, header, header_style)

        row_idx = 1
        seen = set()
        invoice_seq_set = set(invoice_seq)
        ordered_invoices = list(invoice_seq) + [
            invoice for invoice in original_mapping.keys() if invoice not in invoice_seq_set
        ]
        for invoice in ordered_invoices:
            if invoice in seen:
                continue
            seen.add(invoice)
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
        return data, len(seen)

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
            request_started = perf_counter()
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
            response_received = perf_counter()
        except Exception as exc:
            return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}

        processing_started = perf_counter()
        try:
            obj = r.json()
        except Exception:
            return {"ok": False, "need_session": True}

        if "rows" not in obj:
            return {"ok": False, "need_session": True}

        ez_rows = obj.get("rows", [])
        if not ez_rows:
            return {"ok": False, "error": f"{today} 조회된 주문이 없습니다."}

        try:
            mapping, details, runs, invoice_order, invoice_seq, code_o_text, hapbae_pre_match_rows = _build_ezadmin_order_state(ez_rows)
        except Exception as exc:
            traceback.print_exc()
            raise HTTPException(status_code=500, detail=f"주문 데이터 처리 실패: {exc}")

        set_shared_barcode_data({
            "loaded": True,
            "processed_path": None,
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
        supplies_result = None
        if on_ezadmin_orders_loaded is not None:
            # 비품관리(겉포장지) 자동 차감. 실패해도 바코드 불러오기는 그대로 성공시킨다.
            try:
                supplies_result = on_ezadmin_orders_loaded(ez_rows, today)
            except Exception:
                traceback.print_exc()
        processing_finished = perf_counter()
        return {
            "ok": True,
            "invoices": len(mapping),
            "codes_total": sum(len(v) for v in mapping.values()),
            "total_rows": len(ez_rows),
            "date": today,
            "supplies": supplies_result,
            "timings": {
                "api_ms": round((response_received - request_started) * 1000),
                "processing_ms": round((processing_finished - processing_started) * 1000),
                "total_ms": round((processing_finished - request_started) * 1000),
            },
        }

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
                code = normalize_code(ws.cell(r, 1).value)
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
        token = res.json().get("access_token") or res.json().get("token")
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
            ably_client = AblyClient()
            ably_client.set_token(token)

            async def _fetch_detail(sno):
                try:
                    return sno, await ably_client.get_goods_detail(sno)
                except Exception:
                    return sno, {}

            results = await asyncio.gather(*[_fetch_detail(g["sno"]) for g in all_goods])
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

    def _save_defect_tabs_config():
        set_setting(defect_tab_service.SETTING_KEY, defect_tab_service.dump_config())

    # 케이디지(원가베이스유 거래처) 상품은 불량 불러오기 때 항상 이 이름의 탭으로 간다.
    _KDG_TAB = "KDG"

    def _is_kdg_vendor(vendor) -> bool:
        return re.sub(r"\s+", "", str(vendor or "")) == "케이디지"

    @router.get("/barcode/defect-tabs")
    def get_defect_tabs(user: str = Depends(get_current_user)):
        return defect_tab_service.tabs_config()

    @router.post("/barcode/defect-tabs/add")
    def add_defect_tab(payload: dict = Body(...), user: str = Depends(get_current_user)):
        try:
            defect_tab_service.add_tab(payload.get("name"))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        _save_defect_tabs_config()
        return defect_tab_service.tabs_config()

    @router.post("/barcode/defect-tabs/remove")
    def remove_defect_tab(payload: dict = Body(...), user: str = Depends(get_current_user)):
        try:
            defect_tab_service.remove_tab(payload.get("name"))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        _save_defect_tabs_config()
        return defect_tab_service.tabs_config()

    @router.post("/barcode/defect-tabs/red")
    def set_defect_tab_red(payload: dict = Body(...), user: str = Depends(get_current_user)):
        try:
            defect_tab_service.set_tab_red(payload.get("name"), bool(payload.get("red")))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        _save_defect_tabs_config()
        return defect_tab_service.tabs_config()

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

    def _ez_time_flag(now: datetime) -> str:
        """I100(set_stock_data)류 템플릿이 쓰는 브라우저 포맷 timeFlag."""
        weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
        months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
        return f"{weekdays[now.weekday()]} {months[now.month - 1]} {now.day:02d} {now.year} {now:%H:%M:%S} GMT+0900 (한국 표준시)"

    def _ez_time_flag_ms(now: datetime) -> str:
        """E900(packlist_json/cancel_trans/delete_trans_no)류 템플릿이 쓰는 epoch-ms timeFlag."""
        return str(int(now.timestamp() * 1000))

    def _looks_like_ez_session_error(resp, body: str) -> bool:
        lowered = (body or "").lower()
        if resp.url and "login" in str(resp.url).lower():
            return True
        if "<html" in lowered or "<!doctype html" in lowered:
            return True
        return any(t in lowered for t in ("phpsessid", "session_error", "로그인이 필요"))

    def _extract_ably_order_items(packlist_data: dict) -> tuple[list[dict], "Counter[str]"]:
        """packlist_json 응답에서 (에이블리 주문상품, 상품코드별 출고수량)을 추출."""
        product_qty: Counter = Counter()
        items: list[dict] = []
        seen_sno: set[int] = set()
        for row in (packlist_data.get("rows") or []):
            cell = row.get("cell") or {}
            product_id = str(cell.get("product_id") or "").strip()
            if product_id:
                product_qty[product_id] += 1

            data_row_raw = cell.get("data_row")
            if not data_row_raw:
                continue
            try:
                data_row = json.loads(data_row_raw)
            except (TypeError, ValueError):
                continue

            order_id_seq = data_row.get("order_id_seq")
            if order_id_seq in (None, ""):
                continue
            try:
                sno = int(order_id_seq)
            except (TypeError, ValueError):
                continue
            if sno in seen_sno:
                continue
            seen_sno.add(sno)
            items.append({"product_id": product_id, "sno": sno})
        return items, product_qty

    def _ez_invoice_headers() -> dict:
        return {
            "User-Agent": "Mozilla/5.0",
            "X-Requested-With": "XMLHttpRequest",
            "Referer": "https://ga80.ezadmin.co.kr/popup25.htm?template=E900",
        }

    @router.post("/barcode/invoice/preview")
    async def barcode_invoice_preview(
        payload: dict = Body(...),
        user: str = Depends(get_current_user),
    ):
        invoice_no = str(payload.get("invoice_no") or "").strip()
        if not invoice_no:
            raise HTTPException(status_code=400, detail="송장번호가 필요합니다.")

        phpsessid = (get_setting(_EZADMIN_SESSION_KEY) or "").strip()
        if not phpsessid:
            return {"ok": False, "need_session": True}

        cookies = {"PHPSESSID": phpsessid}
        ez_headers = _ez_invoice_headers()

        today = datetime.now()
        start_date = (today - timedelta(days=30)).strftime("%Y-%m-%d")
        end_date = today.strftime("%Y-%m-%d")
        search_par = (
            f"pack=&history_seq=&date_type=collect_date"
            f"&start_date={start_date}&end_date={end_date}"
            f"&date_period_sel=0&search_type=0&keyword="
            f"&keyword1=&keyword2=&keyword3=&keyword4=&keyword5="
            f"&super_keyword={invoice_no}&order_status=-1&order_cs=0"
            f"&query_trans_who=0&is_gift=0&work_type=0"
            f"&labels_string=&checkbox_options_string="
        )

        try:
            async with httpx.AsyncClient(timeout=30.0, verify=False, follow_redirects=True) as client:
                # Step 0: 송장번호(super_keyword)로 주문 검색 → 내부 pack 값 추출
                r0 = await client.post(
                    f"{_EZADMIN_BASE}/function.htm",
                    data={
                        "_search": "false", "nd": _ez_time_flag_ms(datetime.now()),
                        "rows": "10", "page": "1", "sidx": "", "sord": "desc",
                        "readonly": "T", "template": "E900", "action": "query_json",
                        "par": search_par,
                    },
                    cookies=cookies, headers=ez_headers,
                )
                body0 = (r0.text or "").strip()
                if _looks_like_ez_session_error(r0, body0):
                    return {"ok": False, "need_session": True}
                try:
                    search_data = r0.json()
                except Exception:
                    return {"ok": False, "need_session": True}

                pack = None
                for row in (search_data.get("rows") or []):
                    cell = row.get("cell") or {}
                    if isinstance(cell, dict) and cell.get("pack"):
                        pack = cell.get("pack")
                        break

                if not pack:
                    return {
                        "ok": True,
                        "invoice_no": invoice_no,
                        "pack": None,
                        "ezadmin_found": False,
                        "ably_found": False,
                        "products": [],
                        "sno_list": [],
                    }

                # Step 1: packlist_json (읽기전용) - 상품코드 + 에이블리 주문상품 sno 추출
                r1 = await client.post(
                    f"{_EZADMIN_BASE}/function.htm",
                    data={
                        "_search": "false", "nd": _ez_time_flag_ms(datetime.now()),
                        "rows": "500", "page": "1", "sidx": "", "sord": "",
                        "readonly": "T", "template": "E900", "action": "packlist_json",
                        "pack": pack, "stock": "0", "is_masking": "0",
                        "timeFlag": _ez_time_flag_ms(datetime.now()),
                    },
                    cookies=cookies, headers=ez_headers,
                )
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"패킹리스트 조회 실패: {exc}")

        body1 = (r1.text or "").strip()
        if _looks_like_ez_session_error(r1, body1):
            return {"ok": False, "need_session": True}
        try:
            packlist_data = r1.json()
        except Exception:
            return {"ok": False, "need_session": True}

        ezadmin_found = bool(packlist_data.get("rows"))
        prd_seqs: list[str] = []
        for row in (packlist_data.get("rows") or []):
            try:
                row_data = json.loads((row.get("cell") or {}).get("data_row") or "{}")
            except (TypeError, ValueError):
                continue
            prd_seq = str(row_data.get("prd_seq") or "").strip()
            if prd_seq and prd_seq not in prd_seqs:
                prd_seqs.append(prd_seq)
        items, product_qty = _extract_ably_order_items(packlist_data)
        sno_list = [item["sno"] for item in items]
        ably_found = bool(sno_list)

        codes = list(product_qty.keys())
        info_map: dict[str, dict] = {}
        if codes:
            conn = _get_wonbe_db()
            try:
                placeholders = ",".join(["?"] * len(codes))
                rows = conn.execute(
                    f"SELECT 상품코드, 상품명, 색상, 사이즈 FROM wonbe WHERE 상품코드 IN ({placeholders})",
                    codes,
                ).fetchall()
                info_map = {r["상품코드"]: dict(r) for r in rows}
            finally:
                conn.close()

        products = [
            {
                "product_id": code,
                "qty": qty,
                "name": info_map.get(code, {}).get("상품명", ""),
                "color": info_map.get(code, {}).get("색상", ""),
                "size": info_map.get(code, {}).get("사이즈", ""),
            }
            for code, qty in product_qty.items()
        ]

        return {
            "ok": True,
            "invoice_no": invoice_no,
            "pack": pack,
            "ezadmin_found": ezadmin_found,
            "ably_found": ably_found,
            "products": products,
            "sno_list": sno_list,
            "prd_seqs": prd_seqs,
        }

    @router.post("/barcode/invoice/cancel-pack")
    async def barcode_invoice_cancel_pack(
        payload: dict = Body(...),
        user: str = Depends(get_current_user),
    ):
        """E900 주문 상품 취소처리 (cancel_pack). 상품 줄(prd_seq)마다 보관위치를 조회한 뒤 취소한다."""
        seq = str(payload.get("pack") or payload.get("seq") or "").strip()
        prd_seqs = [str(p).strip() for p in (payload.get("prd_seqs") or []) if str(p).strip()]
        if not seq or not prd_seqs:
            raise HTTPException(status_code=400, detail="pack과 prd_seqs 값이 필요합니다.")

        phpsessid = (get_setting(_EZADMIN_SESSION_KEY) or "").strip()
        if not phpsessid:
            return {"ok": False, "need_session": True}

        cookies = {"PHPSESSID": phpsessid}
        ez_headers = _ez_invoice_headers()
        today = datetime.now().strftime("%Y-%m-%d")

        results = []
        async with httpx.AsyncClient(timeout=30.0, verify=False, follow_redirects=True) as client:
            for prd_seq in prd_seqs:
                try:
                    loc_res = await client.post(
                        f"{_EZADMIN_BASE}/function.htm",
                        data={
                            "template": "E900", "action": "find_multilocation",
                            "prd_seq": prd_seq, "timeFlag": _ez_time_flag_ms(datetime.now()),
                        },
                        cookies=cookies, headers=ez_headers,
                    )
                    if _looks_like_ez_session_error(loc_res, (loc_res.text or "").strip()):
                        return {"ok": False, "need_session": True}
                    try:
                        loc_data = loc_res.json()
                    except Exception:
                        loc_data = {}
                    location = str(loc_data.get("location") or "")
                    expire_date = str(loc_data.get("expire_date") or today)

                    cancel_res = await client.post(
                        f"{_EZADMIN_BASE}/function.htm",
                        data={
                            "template": "E900", "action": "cancel_pack",
                            "seq": seq, "prdSeq": prd_seq, "cs_reason": "",
                            "restockin": "0", "restockin_ex": "0", "restockin_bad": "0",
                            "return_comp": "0", "site_p": "", "envelop_p": "", "account_p": "",
                            "notget_p": "", "notget_p2": "0", "trans_corp": "30079", "trans_no": "",
                            "memo": "", "trans_price": "", "content": "", "do_complete": "0",
                            "callid": "", "confirm_refund": "0", "send_msg": "0",
                            "multi_location": location, "expire_date": expire_date,
                            "auto_expire_date": "1",
                            "timeFlag": _ez_time_flag_ms(datetime.now()),
                        },
                        cookies=cookies, headers=ez_headers,
                    )
                    body = (cancel_res.text or "").strip()
                    if _looks_like_ez_session_error(cancel_res, body):
                        return {"ok": False, "need_session": True}
                    try:
                        cancel_data = cancel_res.json()
                    except Exception:
                        cancel_data = {}
                    error_code = cancel_data.get("error") if isinstance(cancel_data, dict) else None
                    ok = cancel_res.status_code < 400 and str(error_code) in ("0", "None")
                    results.append({"prd_seq": prd_seq, "ok": ok, "error": None if ok else body[:200]})
                except Exception as exc:
                    results.append({"prd_seq": prd_seq, "ok": False, "error": str(exc)})

        all_ok = all(r["ok"] for r in results)
        detail = None if all_ok else "취소처리 실패: " + ", ".join(
            f"{r['prd_seq']}({r['error']})" for r in results if not r["ok"]
        )
        return {"ok": all_ok, "results": results, "detail": detail}

    @router.post("/barcode/invoice/cancel")
    async def barcode_invoice_cancel(
        payload: dict = Body(...),
        user: str = Depends(get_current_user),
    ):
        seq = str(payload.get("pack") or payload.get("seq") or "").strip()
        if not seq:
            raise HTTPException(status_code=400, detail="pack(seq) 값이 필요합니다.")

        phpsessid = (get_setting(_EZADMIN_SESSION_KEY) or "").strip()
        if not phpsessid:
            return {"ok": False, "need_session": True}

        cookies = {"PHPSESSID": phpsessid}
        ez_headers = _ez_invoice_headers()

        async with httpx.AsyncClient(timeout=30.0, verify=False, follow_redirects=True) as client:
            try:
                r2 = await client.post(
                    f"{_EZADMIN_BASE}/function.htm",
                    data={
                        "template": "E900", "action": "cancel_trans",
                        "seq": seq, "content": "",
                        "timeFlag": _ez_time_flag_ms(datetime.now()),
                    },
                    cookies=cookies, headers=ez_headers,
                )
            except Exception as exc:
                raise HTTPException(status_code=502, detail=f"거래 취소 실패: {exc}")
            if _looks_like_ez_session_error(r2, (r2.text or "").strip()):
                return {"ok": False, "need_session": True}

            try:
                r3 = await client.post(
                    f"{_EZADMIN_BASE}/function.htm",
                    data={
                        "template": "E900", "action": "delete_trans_no",
                        "seq": seq, "content": "",
                        "timeFlag": _ez_time_flag_ms(datetime.now()),
                    },
                    cookies=cookies, headers=ez_headers,
                )
            except Exception as exc:
                raise HTTPException(status_code=502, detail=f"송장번호 삭제 실패: {exc}")
            if _looks_like_ez_session_error(r3, (r3.text or "").strip()):
                return {"ok": False, "need_session": True}

        return {"ok": True, "pack": seq}

    @router.post("/barcode/invoice/stock-out")
    async def barcode_invoice_stock_out(
        payload: dict = Body(...),
        user: str = Depends(get_current_user),
    ):
        products = payload.get("products") or []
        memo = str(payload.get("memo") or "").strip()
        if not products:
            raise HTTPException(status_code=400, detail="출고 처리할 상품이 없습니다.")

        phpsessid = (get_setting(_EZADMIN_SESSION_KEY) or "").strip()
        if not phpsessid:
            return {"ok": False, "need_session": True}

        cookies = {"PHPSESSID": phpsessid}
        ez_headers = _ez_invoice_headers()

        results = []
        async with httpx.AsyncClient(timeout=30.0, verify=False, follow_redirects=True) as client:
            for p in products:
                product_id = str((p or {}).get("product_id") or "").strip()
                try:
                    qty = int((p or {}).get("qty") or 0)
                except (TypeError, ValueError):
                    qty = 0
                if not product_id or qty <= 0:
                    continue
                try:
                    sr = await client.post(
                        f"{_EZADMIN_BASE}/function.htm",
                        data={
                            "template": "I100", "action": "set_stock_data",
                            "product_id": product_id, "bad": "0", "type": "out",
                            "stock_label": "", "move_warehouse": "0",
                            "stock_unit": "stock_unit_ea", "qty": str(qty), "memo": memo,
                            "timeFlag": _ez_time_flag(datetime.now()),
                        },
                        cookies=cookies, headers=ez_headers,
                    )
                    if _looks_like_ez_session_error(sr, (sr.text or "").strip()):
                        return {"ok": False, "need_session": True}
                    results.append({"product_id": product_id, "qty": qty, "ok": sr.status_code < 400})
                except Exception as exc:
                    results.append({"product_id": product_id, "qty": qty, "ok": False, "error": str(exc)})

        normalization_log.record(
            get_normalization_db, user=user, source="invoice_delete", type_="out",
            entries=[
                {"code": r["product_id"], "qty": r["qty"], "ref": str(payload.get("invoice_no") or "")}
                for r in results if r["ok"]
            ],
        )
        return {"ok": all(r["ok"] for r in results), "results": results}

    @router.post("/barcode/invoice/rollback")
    async def barcode_invoice_rollback(
        payload: dict = Body(...),
        user: str = Depends(get_current_user),
    ):
        raw_sno_list = payload.get("sno_list") or []
        sno_list = []
        for s in raw_sno_list:
            try:
                sno_list.append(int(s))
            except (TypeError, ValueError):
                continue
        if not sno_list:
            raise HTTPException(status_code=400, detail="sno_list가 비어 있습니다.")

        async with httpx.AsyncClient(timeout=15.0) as login_client:
            login_res = await login_client.post(
                f"{_ABLY_BASE}/seller/login/",
                json={"email": _ABLY_EMAIL, "password": _ABLY_PASSWORD},
                headers={
                    "Content-Type": "application/json",
                    "Origin": "https://seller-admin.a-bly.com",
                    "Referer": "https://seller-admin.a-bly.com/",
                    "User-Agent": "Mozilla/5.0",
                },
            )
            if not login_res.is_success:
                raise HTTPException(status_code=502, detail="에이블리 로그인 실패")
        token = login_res.json().get("access_token") or login_res.json().get("token")
        if not token:
            raise HTTPException(status_code=502, detail="에이블리 로그인 실패: 토큰 없음")

        try:
            async with httpx.AsyncClient(timeout=20.0) as ably_client:
                rollback_res = await ably_client.put(
                    f"{_ABLY_BASE}/seller/order_items/rollback_to_prepare/",
                    headers={
                        "Authorization": f"JWT {token}",
                        "Accept": "application/json",
                        "Content-Type": "application/json",
                        "Origin": "https://my.a-bly.com",
                        "Referer": "https://my.a-bly.com/",
                        "User-Agent": "Mozilla/5.0",
                    },
                    json={"sno_list": sno_list},
                )
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"에이블리 발송관리 롤백 실패: {exc}")

        rollback_ok = rollback_res.status_code in (200, 201, 204)
        return {
            "ok": rollback_ok,
            "rollback_status": rollback_res.status_code,
            "rollback_detail": None if rollback_ok else rollback_res.text[:200],
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
                "registered_rows": [],
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
        # 코드별 입고 수량을 합포 주문 수량만큼 순서대로 배정하고, 모자란 만큼은 입고없음(incomingQty=0)으로 분리한다.
        incoming_remaining: dict[str, int] = {}
        for row in duplicate_rows:
            code = row.get("code") or ""
            order_qty = to_int(row.get("orderQty"), default=0)
            if order_qty <= 0:
                continue
            incoming_total = int(incoming_counts.get(code, 0) or 0)
            remaining = incoming_remaining.setdefault(code, incoming_total)
            covered_qty = min(order_qty, max(remaining, 0))
            incoming_remaining[code] = remaining - covered_qty
            base_row = {
                "rowNumber": row.get("rowNumber"),
                "duplicateKey": row.get("duplicateKey", ""),
                "code": code,
                "productName": row.get("productName", ""),
                "optionName": row.get("optionName", ""),
            }
            if covered_qty > 0:
                result_rows.append({**base_row, "orderQty": covered_qty, "incomingQty": incoming_total})
            if order_qty - covered_qty > 0:
                result_rows.append({**base_row, "orderQty": order_qty - covered_qty, "incomingQty": 0})

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

        registered_rows = []
        for item in _get_registered_products():
            code = item.get("code") or ""
            if not code:
                continue
            matches = [row for row in source_rows if (row.get("code") or "") == code]
            order_qty = sum(to_int(row.get("orderQty"), default=0) for row in matches)
            incoming_qty = int(incoming_counts.get(code, 0) or 0)
            if order_qty <= 0 or incoming_qty <= 0:
                continue
            sample = matches[0]
            registered_rows.append({
                "code": code,
                "productName": sample.get("productName", ""),
                "optionName": sample.get("optionName", ""),
                "orderQty": min(order_qty, incoming_qty),
                "incomingQty": incoming_qty,
            })

        return {
            "ok": True,
            "loaded": True,
            "incoming_loaded": bool(incoming_counts),
            "rows": grouped_rows,
            "stock_rows": grouped_stock_rows,
            "today_bulk_rows": today_bulk_rows,
            "registered_rows": registered_rows,
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
        return {"ok": True, "checked_rows": _get_hapbae_checked_rows(user)}

    @router.patch("/barcode/hapbae-pre-match/checked")
    def set_hapbae_pre_match_checked(payload: dict = Body(...), user: str = Depends(get_current_user)):
        key = str(payload.get("key") or "").strip()
        if not key:
            raise HTTPException(status_code=400, detail="key required")
        checked = bool(payload.get("checked"))
        return {"ok": True, "checked_rows": _set_hapbae_checked_row(user, key, checked)}

    @router.get("/barcode/hapbae-pre-match/registered")
    def get_hapbae_registered_products(user: str = Depends(get_current_user)):
        return {"ok": True, "registered": _get_registered_products()}

    @router.post("/barcode/hapbae-pre-match/registered")
    def add_hapbae_registered_product(payload: dict = Body(...), user: str = Depends(get_current_user)):
        raw_code = str(payload.get("code") or "").strip()
        if not raw_code:
            raise HTTPException(status_code=400, detail="code required")
        code = normalize_code(raw_code) or raw_code
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

    @router.post("/barcode/hapbae-pre-match/registered/bulk")
    def bulk_add_hapbae_registered_products(payload: dict = Body(...), user: str = Depends(get_current_user)):
        raw_codes = payload.get("codes")
        if not isinstance(raw_codes, list):
            raise HTTPException(status_code=400, detail="codes must be a list")

        normalized_codes = []
        seen = set()
        for raw in raw_codes:
            raw_str = str(raw or "").strip()
            if not raw_str:
                continue
            code = normalize_code(raw_str) or raw_str
            if code in seen:
                continue
            seen.add(code)
            normalized_codes.append(code)
        if not normalized_codes:
            raise HTTPException(status_code=400, detail="no valid codes")

        labels = _lookup_wonbe_labels(set(normalized_codes))
        current = _get_registered_products()
        by_code = {item["code"]: item for item in current}
        added = 0
        for code in normalized_codes:
            label = labels.get(code, code)
            if code in by_code:
                by_code[code] = {"code": code, "label": label}
            else:
                by_code[code] = {"code": code, "label": label}
                added += 1
        return {
            "ok": True,
            "registered": _set_registered_products(list(by_code.values())),
            "added": added,
            "total_input": len(normalized_codes),
        }

    @router.post("/barcode/stock-bulk-fetch")
    async def stock_bulk_fetch(user: str = Depends(get_current_user)):
        phpsessid = (get_setting(_EZADMIN_SESSION_KEY) or "").strip()
        if not phpsessid:
            return {"ok": False, "need_session": True}

        now = datetime.now()
        weekday_kr = ["월", "화", "수", "목", "금", "토", "일"][now.weekday()]
        number_date = f"{now.year}-{now.month}-{now.day}"
        start_date3 = f"{now.year}년 {now.month:02d}월 {now.day:02d}일 {weekday_kr}요일"

        par = (
            f"orderReserve=0&priorityDeliv=0"
            f"&numberDate={number_date}"
            f"&start_date3={start_date3}"
            f"&number_no=1&is_download=0&orderType=2"
            f"&agencyTemplate=20004&check_address=2"
            f"&teamf_transType=tonight&kakaoT_type=0&deliv_today_type=0&hanjin_deliv_type=GN"
        )
        form_data = {
            "template": "S700",
            "action": "get_success_order",
            "_search": "false",
            "nd": str(int(now.timestamp() * 1000)),
            "rows": "999999",
            "page": "1",
            "sidx": "",
            "sord": "asc",
            "readonly": "T",
            "par": par,
        }
        ez_headers = {
            "Accept": "application/json, text/javascript, */*; q=0.01",
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "Origin": _EZADMIN_BASE,
            "Referer": f"{_EZADMIN_BASE}/template35.htm?template=S700",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
            "X-Requested-With": "XMLHttpRequest",
        }
        cookies = {"PHPSESSID": phpsessid}

        try:
            async with httpx.AsyncClient(timeout=60.0, verify=False, follow_redirects=True) as client:
                res = await client.post(f"{_EZADMIN_BASE}/function.htm", headers=ez_headers, cookies=cookies, data=form_data)
            result = res.json()
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"이지어드민 응답 오류: {e}")

        api_rows = result.get("rows", [])
        if not api_rows:
            return {"ok": True, "rows": []}

        _product_re = re.compile(r'\[([A-Z]\d+)\](.*?)(?:-\[([^\]]*)\])?\s+(\d+)개')
        counts: Counter = Counter()
        for order in api_rows:
            cell = order.get("cell", {})
            products_str = str(cell.get("products", ""))
            order_items = []
            for m in _product_re.finditer(products_str):
                code = m.group(1).strip()
                name = m.group(2).strip().rstrip("-").strip()
                option = m.group(3).strip() if m.group(3) else ""
                qty = int(m.group(4))
                order_items.append((code, name, option, qty))

            # 합배송(한 주문에 서로 다른 상품코드가 섞인 경우)은 재고대량 집계에서 제외
            distinct_codes = {item[0] for item in order_items}
            if len(distinct_codes) > 1:
                continue

            for code, name, option, qty in order_items:
                counts[(code, name, option)] += qty

        bulk_rows = [
            {"code": k[0], "productName": k[1], "optionName": k[2], "qty": v}
            for k, v in sorted(counts.items(), key=lambda x: -x[1])
            if v >= 10
        ]
        return {"ok": True, "rows": bulk_rows, "total": len(api_rows)}

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
            "post_shipment_cancelled": _is_post_shipment_cancelled(resolved_invoice),
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

        code = normalize_code(raw) or raw
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

        raw = (payload.get("code") or "").strip()
        if not raw:
            raise HTTPException(status_code=400, detail="code is required")

        code = normalize_code(raw) or raw
        _sync_defect_records()
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
                "code": normalize_code(code) or code,
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

        code = normalize_code(raw) or raw
        kimsungil_counts = dict(get_shared_kimsungil_counts())
        kimsungil_counts[code] = kimsungil_counts.get(code, 0) + 1
        set_shared_kimsungil_counts(kimsungil_counts)
        _log_kimsungil_event(
            code=code,
            name=_kimsungil_display_name(state, code),
            action="add",
            method="검색 추가",
            count_after=kimsungil_counts[code],
            user=user,
        )

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

        code = normalize_code(raw) or raw
        kimsungil_counts = dict(get_shared_kimsungil_counts())
        if code in kimsungil_counts:
            kimsungil_counts[code] -= 1
            if kimsungil_counts[code] <= 0:
                del kimsungil_counts[code]
        set_shared_kimsungil_counts(kimsungil_counts)
        _log_kimsungil_event(
            code=code,
            name=_kimsungil_display_name(state, code),
            action="dec",
            method="수량 차감",
            count_after=kimsungil_counts.get(code, 0),
            user=user,
        )

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

        code = normalize_code(raw) or raw
        kimsungil_counts = dict(get_shared_kimsungil_counts())
        kimsungil_counts.pop(code, None)
        set_shared_kimsungil_counts(kimsungil_counts)
        _log_kimsungil_event(
            code=code,
            name=_kimsungil_display_name(state, code),
            action="remove",
            method="삭제",
            count_after=0,
            user=user,
        )

        inv = state.get("current_invoice")
        return {
            "ok": True,
            "kimsungil": _get_kimsungil_list(state),
            "items": _get_all_items(state, inv) if inv else [],
            "current_next": _get_first_remaining_item(state, inv),
        }

    @router.post("/barcode/kimsungil/summon-to-defect")
    def summon_kimsungil_to_defect(user: str = Depends(get_current_user)):
        state = get_barcode_state(user)
        kimsungil_counts = dict(get_shared_kimsungil_counts())
        incoming_counts = get_shared_incoming_counts() or {}

        # 보통은 입고된(배지가 뜬) 상품만 옮기지만, KDG 탭은 입고 파일이 없어도 목록 전체를 옮긴다.
        if defect_tab_service.current_tab() == _KDG_TAB:
            moved_codes = list(kimsungil_counts)
        else:
            moved_codes = [code for code in kimsungil_counts if int(incoming_counts.get(code, 0) or 0) > 0]
        defect_counts = dict(get_shared_defect_counts())
        summon_counts = dict(get_shared_defect_summon_counts())
        # 케이디지(KDG) 상품은 어느 탭에서 불러오든 KDG 탭의 불량 목록으로 보낸다.
        base_lookup = _build_defect_base_lookup()
        kdg_codes = {c for c in moved_codes if _is_kdg_vendor((base_lookup.get(c) or {}).get("c"))}
        if defect_tab_service.current_tab() == _KDG_TAB:
            kdg_codes = set(moved_codes)  # KDG 탭에서 불러오면 전부 그대로 KDG 탭에 남는다.
        kdg_defect: dict[str, int] = {}
        kdg_summon: dict[str, int] = {}
        if kdg_codes and _KDG_TAB not in defect_tab_service.DEFECT_TABS:
            defect_tab_service.add_tab(_KDG_TAB)
            _save_defect_tabs_config()
        if kdg_codes:
            with defect_tab_service.use_tab(_KDG_TAB):
                kdg_defect = dict(get_shared_defect_counts())
                kdg_summon = dict(get_shared_defect_summon_counts())
        _sync_defect_records()
        with defect_tab_service.use_tab(_KDG_TAB):
            _sync_defect_records()
        moved_total = 0
        moved_items: list[dict] = []  # 이번에 새로 불러온 것만 (탭별 실물 매칭용)
        current_tab = defect_tab_service.current_tab()
        for code in moved_codes:
            qty = kimsungil_counts.pop(code, 0)
            moved_items.append({"code": code, "qty": qty, "tab": _KDG_TAB if code in kdg_codes else current_tab})
            if code in kdg_codes:
                kdg_defect[code] = kdg_defect.get(code, 0) + qty
                kdg_summon[code] = kdg_summon.get(code, 0) + qty
            else:
                defect_counts[code] = defect_counts.get(code, 0) + qty
                summon_counts[code] = summon_counts.get(code, 0) + qty
            moved_total += qty
            _log_kimsungil_event(
                code=code,
                name=_kimsungil_display_name(state, code),
                action="summon",
                method="김승일 소환술(불량 이동)",
                count_after=0,
                user=user,
            )

        set_shared_kimsungil_counts(kimsungil_counts)
        set_shared_defect_counts(defect_counts)
        set_shared_defect_summon_counts(summon_counts)
        if kdg_codes:
            with defect_tab_service.use_tab(_KDG_TAB):
                set_shared_defect_counts(kdg_defect)
                set_shared_defect_summon_counts(kdg_summon)

        return {
            "ok": True,
            "moved_codes": moved_codes,
            "moved_items": moved_items,
            "moved_count": len(moved_codes),
            "moved_total": moved_total,
            "kdg_moved_count": len(kdg_codes),
            "tabs": defect_tab_service.tabs_config(),
            "defects": _get_defect_list(state),
            "kimsungil": _get_kimsungil_list(state),
        }

    @router.post("/barcode/kimsungil/revert-from-defect")
    def revert_summon_to_kimsungil(payload: dict = Body(...), user: str = Depends(get_current_user)):
        """소환술로 불량에 들어온 수량(현재 탭 기준)만 다시 김승일 리스트로 되돌린다.
        직접 찍은 불량 수량은 그대로 둔다."""
        state = get_barcode_state(user)
        raw = (payload.get("code") or "").strip()
        if not raw:
            raise HTTPException(status_code=400, detail="code is required")

        code = normalize_code(raw) or raw
        summon_counts = dict(get_shared_defect_summon_counts())
        qty = int(summon_counts.get(code, 0) or 0)
        if qty <= 0:
            raise HTTPException(status_code=400, detail="소환술로 이동된 수량이 없습니다.")

        defect_counts = dict(get_shared_defect_counts())
        remaining = defect_counts.get(code, 0) - qty
        if remaining > 0:
            defect_counts[code] = remaining
        else:
            defect_counts.pop(code, None)
        summon_counts.pop(code, None)

        kimsungil_counts = dict(get_shared_kimsungil_counts())
        kimsungil_counts[code] = kimsungil_counts.get(code, 0) + qty

        set_shared_defect_counts(defect_counts)
        set_shared_defect_summon_counts(summon_counts)
        set_shared_kimsungil_counts(kimsungil_counts)
        _sync_defect_records()
        _log_kimsungil_event(
            code=code,
            name=_kimsungil_display_name(state, code),
            action="revert",
            method="김승일 되돌리기(불량에서 복귀)",
            count_after=kimsungil_counts[code],
            user=user,
        )

        inv = state.get("current_invoice")
        return {
            "ok": True,
            "reverted_qty": qty,
            "defects": _get_defect_list(state),
            "kimsungil": _get_kimsungil_list(state),
            "items": _get_all_items(state, inv) if inv else [],
        }

    @router.get("/barcode/kimsungil/log")
    def list_kimsungil_log(code: str = "", limit: int = 200, user: str = Depends(get_current_user)):
        conditions = []
        params: list = []
        if code:
            normalized = normalize_code(code) or code
            conditions.append("code = ?")
            params.append(normalized)
        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
        conn = get_shared_db()
        try:
            rows = conn.execute(
                f"SELECT * FROM kimsungil_log {where} ORDER BY created_at DESC, id DESC LIMIT ?",
                (*params, limit),
            ).fetchall()
        finally:
            conn.close()
        return {"ok": True, "items": [dict(row) for row in rows]}

    def _anomaly_conn():
        conn = get_shared_db()
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS barcode_anomalies (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                registered_date TEXT NOT NULL DEFAULT '',
                product_name TEXT NOT NULL DEFAULT '',
                reason TEXT NOT NULL DEFAULT '',
                normalized INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT '',
                username TEXT NOT NULL DEFAULT ''
            )
            """
        )
        # 기존 테이블에는 개수 컬럼이 없으므로 한 번 추가한다(이미 있으면 에러 → 무시).
        for ddl in (
            "ALTER TABLE barcode_anomalies ADD COLUMN qty INTEGER NOT NULL DEFAULT 1",
            "ALTER TABLE barcode_anomalies ADD COLUMN completed INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE barcode_anomalies ADD COLUMN completed_at TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE barcode_anomalies ADD COLUMN completed_memo TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE barcode_anomalies ADD COLUMN completed_by TEXT NOT NULL DEFAULT ''",
        ):
            try:
                conn.execute(ddl)
                conn.commit()
            except Exception:
                pass
        return conn

    def _anomaly_qty(value) -> int:
        try:
            return max(int(value), 0)
        except (TypeError, ValueError):
            return 1

    @router.get("/barcode/anomaly/list")
    def list_anomalies(user: str = Depends(get_current_user)):
        conn = _anomaly_conn()
        try:
            rows = conn.execute(
                "SELECT * FROM barcode_anomalies WHERE completed = 0 ORDER BY registered_date DESC, id DESC"
            ).fetchall()
        finally:
            conn.close()
        return {"ok": True, "items": [dict(row) for row in rows]}

    @router.get("/barcode/anomaly/completed")
    def list_completed_anomalies(user: str = Depends(get_current_user)):
        conn = _anomaly_conn()
        try:
            rows = conn.execute(
                "SELECT * FROM barcode_anomalies WHERE completed = 1 ORDER BY completed_at DESC, id DESC"
            ).fetchall()
        finally:
            conn.close()
        return {"ok": True, "items": [dict(row) for row in rows]}

    @router.post("/barcode/anomaly/complete")
    def complete_anomaly(payload: dict = Body(...), user: str = Depends(get_current_user)):
        try:
            anomaly_id = int(payload.get("id"))
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="id is required")
        memo = str(payload.get("memo") or "").strip()
        conn = _anomaly_conn()
        try:
            conn.execute(
                "UPDATE barcode_anomalies SET completed = 1, completed_at = ?, completed_memo = ?, completed_by = ?"
                " WHERE id = ?",
                (datetime.now(_KST).isoformat(), memo, user, anomaly_id),
            )
            conn.commit()
        finally:
            conn.close()
        return list_anomalies(user)

    @router.post("/barcode/anomaly/add")
    def add_anomaly(payload: dict = Body(...), user: str = Depends(get_current_user)):
        product_name = str(payload.get("product_name") or "").strip()
        if not product_name:
            raise HTTPException(status_code=400, detail="상품명은 필수입니다")
        registered_date = str(payload.get("registered_date") or "").strip() or datetime.now(_KST).strftime("%Y-%m-%d")
        reason = str(payload.get("reason") or "").strip()
        normalized = 1 if payload.get("normalized") else 0
        qty = _anomaly_qty(payload.get("qty", 1))
        conn = _anomaly_conn()
        try:
            conn.execute(
                "INSERT INTO barcode_anomalies (registered_date, product_name, qty, reason, normalized, created_at, username)"
                " VALUES (?, ?, ?, ?, ?, ?, ?)",
                (registered_date, product_name, qty, reason, normalized, datetime.now(_KST).isoformat(), user),
            )
            conn.commit()
        finally:
            conn.close()
        return list_anomalies(user)

    @router.post("/barcode/anomaly/update")
    def update_anomaly(payload: dict = Body(...), user: str = Depends(get_current_user)):
        try:
            anomaly_id = int(payload.get("id"))
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="id is required")
        # 전달된 필드만 수정한다(정상화 체크박스는 normalized 만 보냄).
        sets, params = [], []
        if "normalized" in payload:
            sets.append("normalized = ?")
            params.append(1 if payload.get("normalized") else 0)
        if "qty" in payload:
            sets.append("qty = ?")
            params.append(_anomaly_qty(payload.get("qty")))
        if "reason" in payload:
            sets.append("reason = ?")
            params.append(str(payload.get("reason") or "").strip())
        if "registered_date" in payload:
            sets.append("registered_date = ?")
            params.append(str(payload.get("registered_date") or "").strip())
        if "product_name" in payload:
            product_name = str(payload.get("product_name") or "").strip()
            if not product_name:
                raise HTTPException(status_code=400, detail="상품명은 필수입니다")
            sets.append("product_name = ?")
            params.append(product_name)
        if not sets:
            raise HTTPException(status_code=400, detail="수정할 항목이 없습니다")
        conn = _anomaly_conn()
        try:
            conn.execute(
                f"UPDATE barcode_anomalies SET {', '.join(sets)} WHERE id = ?",
                (*params, anomaly_id),
            )
            conn.commit()
        finally:
            conn.close()
        return list_anomalies(user)

    @router.post("/barcode/anomaly/remove")
    def remove_anomaly(payload: dict = Body(...), user: str = Depends(get_current_user)):
        try:
            anomaly_id = int(payload.get("id"))
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="id is required")
        conn = _anomaly_conn()
        try:
            conn.execute("DELETE FROM barcode_anomalies WHERE id = ?", (anomaly_id,))
            conn.commit()
        finally:
            conn.close()
        return list_anomalies(user)

    # ── 불량 등록 기록(상품명 + 사진 + 사유) — SQLite 저장 ─────────────────────
    _DEFECT_PHOTO_MAX_COUNT = 10
    _DEFECT_PHOTO_MAX_CHARS = 4_000_000  # base64 문자열 길이 상한(클라이언트에서 리사이즈 후 전송)
    _DEFECT_PHOTO_RE = re.compile(r"^data:(image/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\r\n]+)$")

    def _defect_record_conn():
        # 불량 사진·사유는 항상 로컬 SQLite(app.db)에 저장한다. Turso 설정과 무관.
        # (get_normalization_db 는 main.py 에서 _get_automation_db = 항상 로컬 SQLite 로 주입된다.
        #  주입이 없는 환경(테스트 등)에서만 공용 DB 로 대체.)
        conn = (get_normalization_db or get_shared_db)()
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS barcode_defect_records (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                tab TEXT NOT NULL DEFAULT '',
                code TEXT NOT NULL DEFAULT '',
                product_name TEXT NOT NULL DEFAULT '',
                qty INTEGER NOT NULL DEFAULT 1,
                reason TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL DEFAULT '',
                username TEXT NOT NULL DEFAULT ''
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS barcode_defect_record_photos (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                record_id INTEGER NOT NULL,
                mime TEXT NOT NULL DEFAULT 'image/jpeg',
                data TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT ''
            )
            """
        )
        cols = {row[1] for row in conn.execute("PRAGMA table_info(barcode_defect_records)").fetchall()}
        if "closed_at" not in cols:
            # 불량이 목록에서 빠진 뒤에는 '지난 불량'이므로 closed_at 을 채워 현재 불량과 분리한다.
            conn.execute("ALTER TABLE barcode_defect_records ADD COLUMN closed_at TEXT NOT NULL DEFAULT ''")
        photo_cols = {row[1] for row in conn.execute("PRAGMA table_info(barcode_defect_record_photos)").fetchall()}
        if "reason" not in photo_cols:
            # 사진마다 따로 적는 불량 사유
            conn.execute("ALTER TABLE barcode_defect_record_photos ADD COLUMN reason TEXT NOT NULL DEFAULT ''")
            # 예전 기록: 기록 사유를 그 기록의 사진마다 그대로 옮겨 둔다 (사진별로 보이게)
            conn.execute(
                "UPDATE barcode_defect_record_photos SET reason = COALESCE("
                "(SELECT r.reason FROM barcode_defect_records r WHERE r.id = barcode_defect_record_photos.record_id), '')"
            )
        conn.commit()
        return conn

    def _summon_match_conn():
        conn = _defect_record_conn()
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS barcode_defect_summon_matched (
                tab TEXT NOT NULL,
                code TEXT NOT NULL,
                qty INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL DEFAULT '',
                PRIMARY KEY (tab, code)
            )
            """
        )
        conn.commit()
        return conn

    def _summon_matched_counts(summon_counts: dict) -> dict[str, int]:
        """현재 탭의 '불러오기 매칭 완료' 수량. 불러온 수량이 없어진 상품의 기록은 지운다."""
        tab = defect_tab_service.current_tab()
        try:
            conn = _summon_match_conn()
        except Exception:
            return {}
        try:
            rows = conn.execute(
                "SELECT code, qty FROM barcode_defect_summon_matched WHERE tab = ?", (tab,)
            ).fetchall()
            matched: dict[str, int] = {}
            stale: list[str] = []
            for row in rows:
                code = row["code"]
                if int(summon_counts.get(code, 0) or 0) <= 0:
                    stale.append(code)
                else:
                    matched[code] = int(row["qty"] or 0)
            for code in stale:
                conn.execute("DELETE FROM barcode_defect_summon_matched WHERE tab = ? AND code = ?", (tab, code))
            if stale:
                conn.commit()
            return matched
        finally:
            conn.close()

    @router.post("/barcode/defect/summon-match")
    def change_summon_matched(payload: dict = Body(...), user: str = Depends(get_current_user)):
        """불량 불러오기 실물 매칭: 바코드를 찍을 때 +1, 취소할 때 -1 (현재 탭).
        0 ~ 불러온 수량 사이로 맞춘다."""
        raw = str(payload.get("code") or "").strip()
        if not raw:
            raise HTTPException(status_code=400, detail="code is required")
        try:
            delta = int(payload.get("delta") or 0)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="delta 형식이 올바르지 않습니다")
        code = normalize_code(raw) or raw
        tab = defect_tab_service.current_tab()
        summon_qty = int(get_shared_defect_summon_counts().get(code, 0) or 0)
        conn = _summon_match_conn()
        try:
            row = conn.execute(
                "SELECT qty FROM barcode_defect_summon_matched WHERE tab = ? AND code = ?", (tab, code)
            ).fetchone()
            current = min(int(row["qty"] or 0), summon_qty) if row else 0
            new_qty = max(0, min(summon_qty, current + delta))
            conn.execute(
                "INSERT INTO barcode_defect_summon_matched (tab, code, qty, updated_at) VALUES (?, ?, ?, ?)"
                " ON CONFLICT(tab, code) DO UPDATE SET qty = excluded.qty, updated_at = excluded.updated_at",
                (tab, code, new_qty, datetime.now(_KST).isoformat()),
            )
            conn.commit()
        finally:
            conn.close()
        return {"ok": True, "code": code, "matched_qty": new_qty, "summon_qty": summon_qty}

    def _sync_defect_records(conn=None):
        """현재 불량 목록에 없는 상품의 사진·사유 기록을 '지난 불량'으로 닫는다 (지우지는 않음).
        사진·사유는 그 불량을 찍은 그때 한 세트이므로, 불량이 사라지면 같은 상품코드를 다시 찍어도 이어붙지 않는다."""
        own = conn is None
        if own:
            conn = _defect_record_conn()
        try:
            tab = defect_tab_service.current_tab()
            alive = [c for c, q in dict(get_shared_defect_counts()).items() if (q or 0) > 0]
            rows = conn.execute(
                "SELECT DISTINCT code FROM barcode_defect_records WHERE tab = ? AND closed_at = ''", (tab,)
            ).fetchall()
            stale = [r["code"] for r in rows if r["code"] not in set(alive)]
            if stale:
                marks = ",".join("?" for _ in stale)
                conn.execute(
                    f"UPDATE barcode_defect_records SET closed_at = ? WHERE tab = ? AND closed_at = '' AND code IN ({marks})",
                    (datetime.now(_KST).isoformat(), tab, *stale),
                )
                conn.commit()
        finally:
            if own:
                conn.close()

    def _defect_record_qty(value) -> int:
        try:
            return min(max(int(value), 1), 999)
        except (TypeError, ValueError):
            return 1

    def _parse_defect_photos(photos) -> list[tuple[str, str, str]]:
        """사진 목록 → [(mime, base64, 사진별 사유)]. 항목은 data URL 문자열 또는 {data, reason}."""
        if photos is None:
            return []
        if not isinstance(photos, list):
            raise HTTPException(status_code=400, detail="photos 형식이 올바르지 않습니다")
        parsed = []
        for photo in photos:
            photo_reason = ""
            if isinstance(photo, dict):
                photo_reason = str(photo.get("reason") or "").strip()
                photo = photo.get("data")
            text = str(photo or "")
            if len(text) > _DEFECT_PHOTO_MAX_CHARS:
                raise HTTPException(status_code=400, detail="사진 용량이 너무 큽니다")
            match = _DEFECT_PHOTO_RE.match(text)
            if not match:
                raise HTTPException(status_code=400, detail="사진 형식이 올바르지 않습니다")
            parsed.append((match.group(1), match.group(2), photo_reason))
        return parsed

    def _join_photo_reasons(reasons) -> str:
        """사진별 사유를 기록 전체 사유 한 줄로 모은다 (카톡·매입관리 등 기존 화면용). 중복은 한 번만."""
        seen: list[str] = []
        for r in reasons:
            r = str(r or "").strip()
            if r and r not in seen:
                seen.append(r)
        return " / ".join(seen)

    def _refresh_record_reason_from_photos(conn, record_id: int) -> None:
        """사진별 사유가 하나라도 있으면 기록 사유를 그 모음으로 맞춘다."""
        rows = conn.execute(
            "SELECT reason FROM barcode_defect_record_photos WHERE record_id = ? ORDER BY id", (record_id,)
        ).fetchall()
        joined = _join_photo_reasons(row["reason"] for row in rows)
        if joined:
            conn.execute("UPDATE barcode_defect_records SET reason = ? WHERE id = ?", (joined, record_id))

    def _defect_record_product_name(state, code: str) -> str:
        # 원가베이스 표시명 → 현재 송장 상품명 순으로 찾는다 (불량 리스트 표시와 같은 우선순위).
        base_name = (_build_defect_base_lookup().get(code, {}).get("g") or "").strip()
        if base_name:
            return base_name
        det = _find_item_detail_by_code(state, code)
        return f"{det.get('name', '')} {det.get('option', '')}".strip()

    @router.get("/barcode/defect/record/lookup")
    def lookup_defect_product(code: str = "", user: str = Depends(get_current_user)):
        """불량 등록 전 상품 조회. 수량/기록을 전혀 바꾸지 않는다."""
        state = get_barcode_state(user)
        raw = (code or "").strip()
        if not raw:
            raise HTTPException(status_code=400, detail="code is required")
        normalized = normalize_code(raw) or raw
        name = _defect_record_product_name(state, normalized)
        return {"ok": True, "code": normalized, "name": name, "found": bool(name)}

    def _list_defect_records_for_tab(conn, tab: str) -> list[dict]:
        rows = conn.execute(
            "SELECT * FROM barcode_defect_records WHERE tab = ? AND closed_at = '' ORDER BY id DESC",
            (tab,),
        ).fetchall()
        return _with_photo_ids(conn, [dict(row) for row in rows])

    def _with_photo_ids(conn, records: list[dict]) -> list[dict]:
        if not records:
            return records
        ids = [rec["id"] for rec in records]
        marks = ",".join("?" for _ in ids)
        photo_rows = conn.execute(
            f"SELECT id, record_id, reason FROM barcode_defect_record_photos WHERE record_id IN ({marks}) ORDER BY id",
            ids,
        ).fetchall()
        photo_ids: dict[int, list[int]] = {}
        photo_reasons: dict[int, list[str]] = {}
        for row in photo_rows:
            photo_ids.setdefault(row["record_id"], []).append(row["id"])
            photo_reasons.setdefault(row["record_id"], []).append(row["reason"] or "")
        for rec in records:
            rec["photo_ids"] = photo_ids.get(rec["id"], [])
            rec["photo_reasons"] = photo_reasons.get(rec["id"], [])  # photo_ids 와 같은 순서
        return records

    def _defect_records_response(conn) -> dict:
        return {"ok": True, "records": _list_defect_records_for_tab(conn, defect_tab_service.current_tab())}

    @router.get("/barcode/defect/record/list")
    def list_defect_records(user: str = Depends(get_current_user)):
        conn = _defect_record_conn()
        try:
            _sync_defect_records(conn)
            return _defect_records_response(conn)
        finally:
            conn.close()

    @router.get("/barcode/defect/record/search")
    def search_defect_records(
        q: str = "",
        date_from: str = "",
        date_to: str = "",
        limit: int = 200,
        user: str = Depends(get_current_user),
    ):
        """매입관리 등에서 쓰는 조회용: 모든 탭의 사진·사유 기록을 불량 목록에 남아 있는지와 무관하게 DB 에서 찾는다."""
        where, params = [], []
        keyword = (q or "").strip()
        if keyword:
            like = f"%{keyword}%"
            where.append("(product_name LIKE ? OR code LIKE ? OR reason LIKE ?)")
            params.extend([like, like, like])
        if (date_from or "").strip():
            where.append("substr(created_at, 1, 10) >= ?")
            params.append(date_from.strip()[:10])
        if (date_to or "").strip():
            where.append("substr(created_at, 1, 10) <= ?")
            params.append(date_to.strip()[:10])
        clause = f"WHERE {' AND '.join(where)}" if where else ""
        limit = min(max(int(limit or 200), 1), 500)
        conn = _defect_record_conn()
        try:
            rows = conn.execute(
                f"SELECT * FROM barcode_defect_records {clause} ORDER BY id DESC LIMIT ?",
                (*params, limit),
            ).fetchall()
            records = _with_photo_ids(conn, [dict(row) for row in rows])
        finally:
            conn.close()
        return {"ok": True, "records": records}

    @router.get("/barcode/defect/record/photo/{photo_id}")
    def get_defect_record_photo(photo_id: int, user: str = Depends(get_current_user)):
        conn = _defect_record_conn()
        try:
            row = conn.execute(
                "SELECT mime, data FROM barcode_defect_record_photos WHERE id = ?",
                (photo_id,),
            ).fetchone()
        finally:
            conn.close()
        if not row:
            raise HTTPException(status_code=404, detail="사진을 찾을 수 없습니다")
        return {"ok": True, "data_url": f"data:{row['mime']};base64,{row['data']}"}

    # ── 불량 목록 카톡 전송: 거래처 ↔ 카카오톡 친구 매칭 (처음 한 번 수기로 잡으면 이후 계속 같은 친구로 보낸다) ──
    def _kakao_vendor_map_conn():
        conn = _defect_record_conn()
        conn.execute(
            """CREATE TABLE IF NOT EXISTS defect_kakao_vendor_map (
                vendor TEXT PRIMARY KEY, contact_id INTEGER NOT NULL, updated_by TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '')"""
        )
        conn.commit()
        return conn

    @router.get("/barcode/defect/kakao-vendor-map")
    def get_defect_kakao_vendor_map(user: str = Depends(get_current_user)):
        conn = _kakao_vendor_map_conn()
        try:
            rows = conn.execute("SELECT vendor, contact_id FROM defect_kakao_vendor_map").fetchall()
        finally:
            conn.close()
        return {"ok": True, "map": {r["vendor"]: r["contact_id"] for r in rows}}

    @router.post("/barcode/defect/kakao-vendor-map")
    def set_defect_kakao_vendor_map(payload: dict = Body(...), user: str = Depends(get_current_user)):
        """body: {vendor, contact_id}. contact_id가 비어 있으면 매칭을 해제한다."""
        vendor = str(payload.get("vendor") or "").strip()
        if not vendor:
            raise HTTPException(status_code=400, detail="거래처가 없습니다.")
        raw = payload.get("contact_id")
        conn = _kakao_vendor_map_conn()
        try:
            if raw in (None, "", 0):
                conn.execute("DELETE FROM defect_kakao_vendor_map WHERE vendor = ?", (vendor,))
            else:
                try:
                    contact_id = int(raw)
                except (TypeError, ValueError):
                    raise HTTPException(status_code=400, detail="카카오톡 친구를 선택하세요.")
                conn.execute(
                    "INSERT INTO defect_kakao_vendor_map (vendor, contact_id, updated_by, updated_at) VALUES (?, ?, ?, ?) "
                    "ON CONFLICT(vendor) DO UPDATE SET contact_id = excluded.contact_id, updated_by = excluded.updated_by, updated_at = excluded.updated_at",
                    (vendor, contact_id, user, datetime.now(_KST).isoformat()),
                )
            conn.commit()
        finally:
            conn.close()
        return {"ok": True}

    @router.post("/barcode/defect/record/add")
    def add_defect_record(payload: dict = Body(...), user: str = Depends(get_current_user)):
        state = get_barcode_state(user)
        raw = str(payload.get("code") or "").strip()
        if not raw:
            raise HTTPException(status_code=400, detail="code is required")
        code = normalize_code(raw) or raw
        # 등록 방식 3가지
        #  1) 1개            : qty=1 (또는 생략)
        #  2) 여러 개 일괄   : qty=N + reason/photos 한 세트 → 기록 1건(qty=N)에 전체 적용
        #  3) 여러 개 개별   : entries=[{reason, photos}, ...] → 건마다 별도 기록(qty=1)
        specs: list[tuple[int, str, list[tuple[str, str]]]] = []
        entries = payload.get("entries")
        if entries is not None:
            if not isinstance(entries, list) or not entries:
                raise HTTPException(status_code=400, detail="entries 형식이 올바르지 않습니다")
            if len(entries) > 999:
                raise HTTPException(status_code=400, detail="한 번에 등록할 수 있는 수량을 초과했습니다")
            for entry in entries:
                if not isinstance(entry, dict):
                    raise HTTPException(status_code=400, detail="entries 형식이 올바르지 않습니다")
                specs.append((1, str(entry.get("reason") or "").strip(), _parse_defect_photos(entry.get("photos"))))
        else:
            specs.append(
                (
                    _defect_record_qty(payload.get("qty", 1)),
                    str(payload.get("reason") or "").strip(),
                    _parse_defect_photos(payload.get("photos")),
                )
            )
        # 사진·사유가 비어 있어도 등록하려면 사용자가 팝업에서 확인했다는 표시(allow_incomplete)가 있어야 한다.
        allow_incomplete = bool(payload.get("allow_incomplete"))
        for idx, (_qty, reason, photos) in enumerate(specs, start=1):
            if not allow_incomplete:
                if not photos:
                    raise HTTPException(status_code=400, detail=f"{idx}번째 불량: 사진을 1장 이상 첨부해 주세요")
                if not reason and not _join_photo_reasons(p[2] for p in photos):
                    raise HTTPException(status_code=400, detail=f"{idx}번째 불량: 사유를 입력해 주세요")
            if len(photos) > _DEFECT_PHOTO_MAX_COUNT:
                raise HTTPException(status_code=400, detail=f"사진은 최대 {_DEFECT_PHOTO_MAX_COUNT}장까지 가능합니다")

        product_name = _defect_record_product_name(state, code) or code
        now = datetime.now(_KST).isoformat()
        tab = defect_tab_service.current_tab()
        conn = _defect_record_conn()
        record_ids = []
        try:
            _sync_defect_records(conn)  # 같은 코드의 지난 불량 기록이 새 불량에 이어붙지 않게 먼저 닫는다
            for qty, reason, photos in specs:
                cur = conn.execute(
                    "INSERT INTO barcode_defect_records (tab, code, product_name, qty, reason, created_at, updated_at, username)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    (tab, code, product_name, qty, reason, now, now, user),
                )
                record_id = cur.lastrowid
                record_ids.append(record_id)
                for mime, data, photo_reason in photos:
                    conn.execute(
                        "INSERT INTO barcode_defect_record_photos (record_id, mime, data, created_at, reason) VALUES (?, ?, ?, ?, ?)",
                        (record_id, mime, data, now, photo_reason),
                    )
                _refresh_record_reason_from_photos(conn, record_id)
            conn.commit()
            result = _defect_records_response(conn)
        finally:
            conn.close()

        # 사진·사유까지 모두 갖춘 이 시점에만 불량 수량에 반영한다 (스캔/조회 단계에서는 수량을 올리지 않는다).
        # attach_existing: 이미 불량 수량이 잡혀 있는 상품에 사진·사유만 붙이는 경우라 수량은 올리지 않는다.
        total_units = sum(spec[0] for spec in specs)
        defect_counts = dict(get_shared_defect_counts())
        if not payload.get("attach_existing"):
            defect_counts[code] = defect_counts.get(code, 0) + total_units
            set_shared_defect_counts(defect_counts)
        inv = state.get("current_invoice")
        result["record_ids"] = record_ids
        result["code"] = code
        result["defect_count"] = defect_counts.get(code, 0)
        result["defects"] = _get_defect_list(state)
        result["items"] = _get_all_items(state, inv) if inv else []
        return result

    @router.post("/barcode/defect/record/update")
    def update_defect_record(payload: dict = Body(...), user: str = Depends(get_current_user)):
        try:
            record_id = int(payload.get("id"))
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="id is required")
        add_photos = _parse_defect_photos(payload.get("add_photos"))
        # 이미 있는 사진의 사유 수정: {사진id: 사유}
        photo_reason_updates: list[tuple[int, str]] = []
        raw_reasons = payload.get("photo_reasons") or {}
        if not isinstance(raw_reasons, dict):
            raise HTTPException(status_code=400, detail="photo_reasons 형식이 올바르지 않습니다")
        for key, value in raw_reasons.items():
            try:
                photo_reason_updates.append((int(key), str(value or "").strip()))
            except (TypeError, ValueError):
                raise HTTPException(status_code=400, detail="photo_reasons 형식이 올바르지 않습니다")
        remove_ids = []
        for value in payload.get("remove_photo_ids") or []:
            try:
                remove_ids.append(int(value))
            except (TypeError, ValueError):
                raise HTTPException(status_code=400, detail="remove_photo_ids 형식이 올바르지 않습니다")

        conn = _defect_record_conn()
        try:
            exists = conn.execute(
                "SELECT id FROM barcode_defect_records WHERE id = ?", (record_id,)
            ).fetchone()
            if not exists:
                raise HTTPException(status_code=404, detail="기록을 찾을 수 없습니다")
            current_ids = [
                row["id"]
                for row in conn.execute(
                    "SELECT id FROM barcode_defect_record_photos WHERE record_id = ?", (record_id,)
                ).fetchall()
            ]
            remaining = len([pid for pid in current_ids if pid not in remove_ids]) + len(add_photos)
            # 사진 없이 등록된 기록도 사유 등만 고칠 수 있어야 하므로 최소 장수는 강제하지 않는다.
            if remaining > _DEFECT_PHOTO_MAX_COUNT:
                raise HTTPException(status_code=400, detail=f"사진은 최대 {_DEFECT_PHOTO_MAX_COUNT}장까지 가능합니다")

            now = datetime.now(_KST).isoformat()
            sets, params = ["updated_at = ?"], [now]
            if "qty" in payload:
                sets.append("qty = ?")
                params.append(_defect_record_qty(payload.get("qty")))
            if "reason" in payload:
                sets.append("reason = ?")
                params.append(str(payload.get("reason") or "").strip())
            conn.execute(
                f"UPDATE barcode_defect_records SET {', '.join(sets)} WHERE id = ?",
                (*params, record_id),
            )
            for pid in remove_ids:
                conn.execute(
                    "DELETE FROM barcode_defect_record_photos WHERE id = ? AND record_id = ?",
                    (pid, record_id),
                )
            for mime, data, photo_reason in add_photos:
                conn.execute(
                    "INSERT INTO barcode_defect_record_photos (record_id, mime, data, created_at, reason) VALUES (?, ?, ?, ?, ?)",
                    (record_id, mime, data, now, photo_reason),
                )
            for pid, photo_reason in photo_reason_updates:
                conn.execute(
                    "UPDATE barcode_defect_record_photos SET reason = ? WHERE id = ? AND record_id = ?",
                    (photo_reason, pid, record_id),
                )
            _refresh_record_reason_from_photos(conn, record_id)
            conn.commit()
            return _defect_records_response(conn)
        finally:
            conn.close()

    @router.post("/barcode/defect/record/remove")
    def remove_defect_record(payload: dict = Body(...), user: str = Depends(get_current_user)):
        try:
            record_id = int(payload.get("id"))
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="id is required")
        conn = _defect_record_conn()
        try:
            conn.execute("DELETE FROM barcode_defect_record_photos WHERE record_id = ?", (record_id,))
            conn.execute("DELETE FROM barcode_defect_records WHERE id = ?", (record_id,))
            conn.commit()
            return _defect_records_response(conn)
        finally:
            conn.close()

    _BAD_STOCK_CATEGORY_LETTERS = {
        "상의": ("A", "B", "C", "D", "E"),
        "하의": ("A", "B", "C", "D", "E"),
        "아우터": ("A", "B", "C"),
    }
    _BAD_STOCK_CATEGORIES = tuple(_BAD_STOCK_CATEGORY_LETTERS)
    _BAD_STOCK_ZONES = tuple(
        f"{cat}{letter}" for cat, letters in _BAD_STOCK_CATEGORY_LETTERS.items() for letter in letters
    )
    _bad_stock_migrated = [False]
    _BAD_STOCK_LAST_DEDUCT_KEY = "bad_stock_last_deduct"
    _BAD_STOCK_DEDUCT_HISTORY_KEY = "bad_stock_deduct_history"

    def _migrate_bad_stock_zones(conn):
        """기존 단일 문자 구역(A/B/C/D/E)을 상의/하의 구역으로 옮긴다. C는 하의C, 나머지는 상의로 보낸다.
        행을 지우지 않고 zone 값만 바꾸며, 이미 옮겨진 행은 조건에 걸리지 않아 여러 번 실행해도 안전하다."""
        conn.execute("UPDATE barcode_bad_stock SET zone = '하의C' WHERE zone = 'C'")
        conn.execute(
            "UPDATE barcode_bad_stock SET zone = '상의' || zone WHERE zone IN ('A', 'B', 'D', 'E')"
        )
        conn.commit()

    def _bad_stock_conn():
        conn = get_shared_db()
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS barcode_bad_stock (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                zone TEXT NOT NULL DEFAULT '',
                code TEXT NOT NULL DEFAULT '',
                product_name TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT '',
                username TEXT NOT NULL DEFAULT ''
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS barcode_bad_stock_renamed (
                product_id TEXT PRIMARY KEY,
                codes TEXT NOT NULL DEFAULT '',
                original_name TEXT NOT NULL DEFAULT '',
                renamed_name TEXT NOT NULL DEFAULT '',
                letter TEXT NOT NULL DEFAULT '',
                renamed_at TEXT NOT NULL DEFAULT '',
                username TEXT NOT NULL DEFAULT ''
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS barcode_bad_stock_zones (
                name TEXT PRIMARY KEY,
                created_at TEXT NOT NULL DEFAULT '',
                username TEXT NOT NULL DEFAULT ''
            )
            """
        )
        # 기존 테이블에는 수량 컬럼이 없으므로 한 번 추가한다(이미 있으면 에러 → 무시).
        try:
            conn.execute("ALTER TABLE barcode_bad_stock ADD COLUMN qty INTEGER NOT NULL DEFAULT 1")
            conn.commit()
        except Exception:
            pass
        if not _bad_stock_migrated[0]:
            _migrate_bad_stock_zones(conn)
            _bad_stock_migrated[0] = True
        return conn

    @router.get("/barcode/bad-stock/list")
    def list_bad_stock(user: str = Depends(get_current_user)):
        conn = _bad_stock_conn()
        try:
            rows = conn.execute("SELECT * FROM barcode_bad_stock ORDER BY id DESC").fetchall()
            zones = conn.execute("SELECT name FROM barcode_bad_stock_zones ORDER BY created_at, name").fetchall()
        finally:
            conn.close()
        base_lookup = _build_defect_base_lookup()
        items = []
        for row in rows:
            item = dict(row)
            code = str(item.get("code") or "")
            item["base_cost"] = base_lookup.get(normalize_code(code) or code, {}).get("cost", 0)
            items.append(item)
        return {
            "ok": True, "items": items, "custom_zones": [z["name"] for z in zones],
            "last_deduct": _load_last_deduct(),
        }

    def _load_last_deduct():
        """'출고상품삭제'(deduct-shipped)를 마지막으로 실제 실행한 기록. 없으면 None."""
        try:
            data = json.loads(get_setting(_BAD_STOCK_LAST_DEDUCT_KEY) or "null")
        except ValueError:
            return None
        return data if isinstance(data, dict) else None

    def _load_deduct_history():
        try:
            data = json.loads(get_setting(_BAD_STOCK_DEDUCT_HISTORY_KEY) or "[]")
        except ValueError:
            return []
        return data if isinstance(data, list) else []

    @router.get("/barcode/bad-stock/deduct-history")
    def bad_stock_deduct_history(user: str = Depends(get_current_user)):
        return {"ok": True, "history": _load_deduct_history()}

    def _resolve_bad_stock_zone(conn, raw_zone) -> str:
        """기본 구역(상의A 등) 또는 직접 추가한 탭 이름이면 정규화한 구역명을, 아니면 400을 낸다."""
        zone = str(raw_zone or "").strip()
        if zone.upper() in _BAD_STOCK_ZONES:
            return zone.upper()
        if zone and conn.execute("SELECT 1 FROM barcode_bad_stock_zones WHERE name = ?", (zone,)).fetchone():
            return zone
        raise HTTPException(status_code=400, detail="존재하지 않는 구역입니다")

    @router.post("/barcode/bad-stock/zone/add")
    def add_bad_stock_zone(payload: dict = Body(...), user: str = Depends(get_current_user)):
        """상의/하의/아우터 중 한 분류 아래에 탭을 추가한다. 저장되는 구역명은 '분류+이름'(예: 상의F)."""
        category = str(payload.get("category") or "").strip()
        if category not in _BAD_STOCK_CATEGORIES:
            raise HTTPException(status_code=400, detail="분류는 상의/하의/아우터 중 하나여야 합니다")
        suffix = str(payload.get("name") or "").strip()
        if not suffix or len(suffix) > 10:
            raise HTTPException(status_code=400, detail="탭 이름은 1~10자로 입력해주세요")
        name = f"{category}{suffix}"
        if name.upper() in _BAD_STOCK_ZONES:
            raise HTTPException(status_code=400, detail="기본 구역과 같은 이름은 쓸 수 없습니다")
        conn = _bad_stock_conn()
        try:
            if conn.execute("SELECT 1 FROM barcode_bad_stock_zones WHERE name = ?", (name,)).fetchone():
                raise HTTPException(status_code=400, detail="이미 있는 탭 이름입니다")
            conn.execute(
                "INSERT INTO barcode_bad_stock_zones (name, created_at, username) VALUES (?, ?, ?)",
                (name, datetime.now(_KST).isoformat(), user),
            )
            conn.commit()
        finally:
            conn.close()
        return {**list_bad_stock(user), "zone": name}

    @router.post("/barcode/bad-stock/zone/remove")
    def remove_bad_stock_zone(payload: dict = Body(...), user: str = Depends(get_current_user)):
        name = str(payload.get("name") or "").strip()
        conn = _bad_stock_conn()
        try:
            if conn.execute("SELECT 1 FROM barcode_bad_stock WHERE zone = ?", (name,)).fetchone():
                raise HTTPException(status_code=400, detail="상품이 남아 있는 탭은 삭제할 수 없습니다. 다른 구역으로 옮기거나 삭제해주세요")
            conn.execute("DELETE FROM barcode_bad_stock_zones WHERE name = ?", (name,))
            conn.commit()
        finally:
            conn.close()
        return list_bad_stock(user)

    @router.post("/barcode/bad-stock/add")
    def add_bad_stock(payload: dict = Body(...), user: str = Depends(get_current_user)):
        """구역(기본 상의/하의/아우터 또는 직접 추가한 탭)별 악성재고 상품 추가. 바코드(code) 또는 검색 선택(code+product_name) 모두 지원."""
        _zc = _bad_stock_conn()
        try:
            zone = _resolve_bad_stock_zone(_zc, payload.get("zone"))
        finally:
            _zc.close()
        raw = str(payload.get("code") or "").strip()
        if not raw:
            raise HTTPException(status_code=400, detail="code is required")
        code = normalize_code(raw) or raw
        product_name = str(payload.get("product_name") or "").strip()
        if not product_name:
            info = _build_defect_base_lookup().get(code)
            if not info:
                raise HTTPException(status_code=404, detail=f"상품을 찾을 수 없습니다: {raw}")
            product_name = info["g"] or info["b"]
        conn = _bad_stock_conn()
        try:
            # 같은 구역에 같은 상품을 또 입고하면 새 행을 만들지 않고 수량을 1 올린다.
            exists = conn.execute(
                "SELECT id FROM barcode_bad_stock WHERE zone = ? AND code = ?", (zone, code)
            ).fetchone()
            if exists:
                conn.execute("UPDATE barcode_bad_stock SET qty = COALESCE(qty, 1) + 1 WHERE id = ?", (exists["id"],))
            else:
                conn.execute(
                    "INSERT INTO barcode_bad_stock (zone, code, product_name, created_at, username, qty)"
                    " VALUES (?, ?, ?, ?, ?, 1)",
                    (zone, code, product_name, datetime.now(_KST).isoformat(), user),
                )
            conn.commit()
        finally:
            conn.close()
        return {**list_bad_stock(user), "added": {"zone": zone, "code": code, "product_name": product_name}}

    @router.post("/barcode/bad-stock/remove")
    def remove_bad_stock(payload: dict = Body(...), user: str = Depends(get_current_user)):
        try:
            item_id = int(payload.get("id"))
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="id is required")
        # decrement=true면 수량만 1 줄이고(1개 남았으면 삭제), 아니면 행 전체를 삭제한다.
        decrement = bool(payload.get("decrement"))
        conn = _bad_stock_conn()
        try:
            row = conn.execute("SELECT qty FROM barcode_bad_stock WHERE id = ?", (item_id,)).fetchone()
            if decrement and row and (row["qty"] or 1) > 1:
                conn.execute("UPDATE barcode_bad_stock SET qty = qty - 1 WHERE id = ?", (item_id,))
            else:
                conn.execute("DELETE FROM barcode_bad_stock WHERE id = ?", (item_id,))
            conn.commit()
        finally:
            conn.close()
        return list_bad_stock(user)

    @router.post("/barcode/bad-stock/move")
    def move_bad_stock(payload: dict = Body(...), user: str = Depends(get_current_user)):
        """선택한 악성재고 행(ids)을 다른 구역으로 옮긴다. 대상 구역에 같은 상품이 있으면 수량을 합친다."""
        try:
            ids = [int(i) for i in (payload.get("ids") or [])]
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="ids가 올바르지 않습니다")
        if not ids:
            raise HTTPException(status_code=400, detail="옮길 상품을 선택해주세요")
        conn = _bad_stock_conn()
        moved = 0
        try:
            zone = _resolve_bad_stock_zone(conn, payload.get("zone"))
            for item_id in ids:
                row = conn.execute("SELECT * FROM barcode_bad_stock WHERE id = ?", (item_id,)).fetchone()
                if not row or row["zone"] == zone:
                    continue
                target = conn.execute(
                    "SELECT id FROM barcode_bad_stock WHERE zone = ? AND code = ?", (zone, row["code"])
                ).fetchone()
                if target:
                    conn.execute(
                        "UPDATE barcode_bad_stock SET qty = COALESCE(qty, 1) + ? WHERE id = ?",
                        (row["qty"] or 1, target["id"]),
                    )
                    conn.execute("DELETE FROM barcode_bad_stock WHERE id = ?", (item_id,))
                else:
                    conn.execute("UPDATE barcode_bad_stock SET zone = ? WHERE id = ?", (zone, item_id))
                moved += 1
            conn.commit()
        finally:
            conn.close()
        return {**list_bad_stock(user), "moved": moved}

    # ---- 이지어드민 상품명 접두어(ZA/ZB...) 변경 기록 -------------------------------------------------
    def _load_renamed() -> dict:
        conn = _bad_stock_conn()
        try:
            rows = [dict(r) for r in conn.execute("SELECT * FROM barcode_bad_stock_renamed").fetchall()]
        finally:
            conn.close()
        return {r["product_id"]: r for r in rows}

    def _save_renamed(product_id: str, codes, original_name: str, renamed_name: str, letter: str, user: str):
        """기록이 있으면 원래 이름(original_name)은 처음 값을 유지하고 코드 목록·현재 이름·접두어만 갱신한다."""
        conn = _bad_stock_conn()
        try:
            old = conn.execute(
                "SELECT codes, original_name FROM barcode_bad_stock_renamed WHERE product_id = ?", (product_id,)
            ).fetchone()
            merged = set(codes)
            if old:
                merged |= set(filter(None, (old["codes"] or "").split(",")))
            conn.execute(
                "INSERT OR REPLACE INTO barcode_bad_stock_renamed"
                " (product_id, codes, original_name, renamed_name, letter, renamed_at, username)"
                " VALUES (?, ?, ?, ?, ?, ?, ?)",
                (product_id, ",".join(sorted(merged)),
                 _PREFIX_RE.sub("", (old["original_name"] if old else original_name) or ""),  # 옛 기록의 BC 등도 함께 정리
                 renamed_name, letter, datetime.now(_KST).isoformat(), user),
            )
            conn.commit()
        finally:
            conn.close()

    def _delete_renamed(product_id: str):
        conn = _bad_stock_conn()
        try:
            conn.execute("DELETE FROM barcode_bad_stock_renamed WHERE product_id = ?", (product_id,))
            conn.commit()
        finally:
            conn.close()

    async def _ez_read_product(client, cookies, ez_code):
        from urllib.parse import quote

        resp = await client.get(
            f"{_EZADMIN_BASE}/popup35.htm?template=C208&id={quote(ez_code, safe='')}",
            cookies=cookies, headers={"User-Agent": "Mozilla/5.0"},
        )
        html = resp.content.decode("utf-8", errors="replace")
        return ez_product_rename.parse_product_form(html), ("myform" in html)

    async def _ez_save_product_name(client, cookies, product_id: str, parts, new_name: str) -> tuple[bool, str]:
        """상품수정 폼 전체를 다시 보내 상품명만 바꾸고, 다시 읽어 바뀌었는지 확인한다."""
        from urllib.parse import quote

        dup = await client.post(
            f"{_EZADMIN_BASE}/function.htm",
            data={"template": "C200", "action": "check_all", "product_id": product_id, "name": new_name},
            cookies=cookies, headers=_ez_invoice_headers(),
        )
        if dup.json().get("is_dup"):
            return False, "이지어드민에 같은 상품명이 이미 있습니다"
        grid = await client.post(
            f"{_EZADMIN_BASE}/function.htm",
            data={"_search": "false", "rows": "500", "page": "1", "sidx": "", "sord": "asc",
                  "readonly": "T", "template": "C200", "action": "get_option_list",
                  "product_id": "", "options": "", "barcode": "", "id": product_id},
            cookies=cookies, headers=_ez_invoice_headers(),
        )
        option_rows = ez_product_rename.parse_option_rows(grid.json())
        if not option_rows:
            return False, "옵션 정보를 읽지 못했습니다"
        fields = ez_product_rename.build_modify_fields(parts, option_rows, new_name)
        multipart = [(n, ("", b"", "application/octet-stream") if v is None else (None, v)) for n, v in fields]
        save = await client.post(
            f"{_EZADMIN_BASE}/popup35.htm?template=C208&is_reg_new=1&id={quote(option_rows[0]['id'], safe='')}",
            files=multipart, cookies=cookies,
            headers={"User-Agent": "Mozilla/5.0", "Referer": f"{_EZADMIN_BASE}/popup35.htm?template=C208&id={product_id}"},
        )
        # 저장 응답은 화면 HTML 이라 성공 여부를 알 수 없으므로 다시 읽어 상품명으로 확인한다.
        check_parts, _ = await _ez_read_product(client, cookies, option_rows[0]["id"])
        ok = save.status_code < 400 and ez_product_rename.get_form_value(check_parts, "name").strip() == new_name
        return ok, "" if ok else "저장 후 확인에서 상품명이 바뀌지 않았습니다"

    # ZA/ZB 같은 우리 접두어뿐 아니라 BC 등 앞에 붙어 있던 대문자 알파벳 접두어도 떼고 새 접두어를 붙인다.
    # 이미 'ZB BC 이름'처럼 겹쳐 붙은 이름도 모두 벗겨 낸다.
    _PREFIX_RE = re.compile(r"^(?:[A-Z]{1,2}\s+)+")
    _ZONE_LETTER_RE = re.compile(r"^(?:상의|하의|아우터)\s*([A-Za-z])(?:\s*구역)?$")

    def _zone_letter(zone: str) -> str:
        """구역의 접두어 알파벳. 기본 구역(상의A~)과 '상의F', '상의F구역'처럼 알파벳 한 글자(+구역)로 만든 직접 추가 탭이 해당된다."""
        m = _ZONE_LETTER_RE.match(str(zone or "").strip())
        return m.group(1).upper() if m else ""

    def _record_is_clean(rec) -> bool:
        """기록된 변경 이름이 'Z{알파벳} 이름' 한 겹뿐인지(BC 같은 옛 접두어가 남지 않았는지)."""
        renamed = rec["renamed_name"] or ""
        return renamed == f"Z{rec['letter']} {_PREFIX_RE.sub('', renamed)}"
    # 상품명 변경 진행도 (사용자별). 화면이 /barcode/bad-stock/rename-progress로 주기적으로 읽는다.
    _rename_progress: dict[str, dict] = {}

    @router.get("/barcode/bad-stock/rename-progress")
    def rename_bad_stock_progress(user: str = Depends(get_current_user)):
        return {"ok": True, **_rename_progress.get(user, {"phase": "idle", "done": 0, "total": 0})}

    def _zone_rank(zone: str) -> tuple:
        """구역 우선순위: 알파벳(A→E) 먼저, 같은 알파벳이면 상의→하의."""
        letter = _zone_letter(zone)
        if not letter:
            return ("￿", 9)  # 알파벳이 없는 직접 추가 탭은 맨 뒤로 보낸다
        category = zone[:-1]
        return (letter, _BAD_STOCK_CATEGORIES.index(category) if category in _BAD_STOCK_CATEGORIES else 9)

    @router.post("/barcode/bad-stock/returns-stockin")
    def bad_stock_returns_stockin(payload: dict = Body(...), user: str = Depends(get_current_user)):
        """반품 입고처리된 상품코드 중 악성재고에 이미 있는 상품은 그 탭의 수량을 1 올리고, 라벨용 접두어(ZA 등)를 돌려준다.

        같은 상품이 여러 탭에 있으면 구역 우선순위(_zone_rank)가 가장 앞선 탭에 더한다.
        악성재고에 없는 코드는 결과에 넣지 않는다. 같은 코드가 여러 번 오면 번 수만큼 더한다."""
        raw_codes = [str(c or "").strip() for c in (payload.get("codes") or []) if str(c or "").strip()]
        result: dict[str, dict] = {}
        if not raw_codes:
            return {"ok": True, "items": result}
        conn = _bad_stock_conn()
        try:
            for raw in raw_codes:
                code = normalize_code(raw) or raw
                rows = conn.execute("SELECT id, zone FROM barcode_bad_stock WHERE code = ?", (code,)).fetchall()
                if not rows:
                    continue
                target = min(rows, key=lambda r: _zone_rank(r["zone"]))
                conn.execute("UPDATE barcode_bad_stock SET qty = COALESCE(qty, 1) + 1 WHERE id = ?", (target["id"],))
                letter = _zone_letter(target["zone"])
                prev = result.get(raw)
                result[raw] = {
                    "zone": target["zone"],
                    "prefix": f"Z{letter}" if letter else target["zone"],
                    "added": (prev["added"] if prev else 0) + 1,
                }
            conn.commit()
        finally:
            conn.close()
        return {"ok": True, "items": result}

    async def _restore_renamed_products(records: list, dry_run: bool) -> list:
        """악성재고에서 모두 빠진 상품의 이지어드민 상품명을 원래 이름으로 되돌린다. 성공하면 기록을 지운다."""
        results = []
        phpsessid = (get_setting(_EZADMIN_SESSION_KEY) or "").strip()
        for rec in records:
            base = {"product_id": rec["product_id"], "original_name": rec["original_name"], "renamed_name": rec["renamed_name"]}
            if dry_run:
                results.append({**base, "status": "restore"})
                continue
            if not phpsessid:
                results.append({**base, "status": "failed", "message": "이지어드민 세션이 없어 원복하지 못했습니다"})
                continue
            try:
                cookies = {"PHPSESSID": phpsessid}
                async with httpx.AsyncClient(timeout=30.0, verify=False, follow_redirects=True) as client:
                    parts, has_form = await _ez_read_product(client, cookies, rec["product_id"])
                    if not parts:
                        results.append({**base, "status": "failed",
                                        "message": "상품 정보를 읽지 못했습니다" if has_form else "이지어드민 세션이 만료되었습니다"})
                        continue
                    current = ez_product_rename.get_form_value(parts, "name").strip()
                    if not _PREFIX_RE.match(current):
                        # 이미 접두어가 없으면(누가 직접 되돌림) 기록만 정리한다.
                        _delete_renamed(rec["product_id"])
                        results.append({**base, "status": "done", "message": "이미 원래 이름입니다"})
                        continue
                    ok, message = await _ez_save_product_name(client, cookies, rec["product_id"], parts, rec["original_name"])
                if ok:
                    _delete_renamed(rec["product_id"])
                results.append({**base, "status": "done" if ok else "failed", "message": message})
            except Exception as exc:
                results.append({**base, "status": "failed", "message": str(exc)})
        return results

    @router.post("/barcode/bad-stock/deduct-shipped")
    async def deduct_shipped_bad_stock(payload: dict = Body(default={}), user: str = Depends(get_current_user)):
        """확장주문검색(업로드된 주문)에 악성재고 상품이 있으면 주문 수량만큼 악성재고에서 차감한다.
        수량이 0이 되면 행을 삭제하고, 주문 수량이 등록 수량보다 많으면 등록 수량까지만 차감한다.
        같은 상품이 여러 구역에 있으면 앞 구역(A→E, 같은 알파벳은 상의→하의)부터 차감한다. dry_run=true면 계산만 한다.
        악성재고에서 완전히 빠진 상품은 이지어드민 상품명(ZA/ZB 접두어)을 원래 이름으로 되돌린다."""
        state = get_barcode_state(user)
        if not state["loaded"]:
            raise HTTPException(status_code=400, detail="확장주문검색 데이터를 먼저 불러오세요")
        dry_run = bool(payload.get("dry_run"))

        ordered: dict[str, int] = {}
        for code_map in (state.get("original_mapping") or {}).values():
            for raw, qty in code_map.items():
                code = normalize_code(raw) or str(raw or "").strip()
                if code:
                    ordered[code] = ordered.get(code, 0) + int(qty or 0)

        conn = _bad_stock_conn()
        try:
            rows = [dict(r) for r in conn.execute("SELECT * FROM barcode_bad_stock ORDER BY id ASC").fetchall()]
            rows.sort(key=lambda r: (_zone_rank(r["zone"]), r["id"]))
            remaining = dict(ordered)
            changes: dict[str, dict] = {}
            still_in_stock: set = set()
            for row in rows:
                need = remaining.get(row["code"], 0)
                have = int(row["qty"] or 1)
                take = min(have, need) if need > 0 else 0
                remaining[row["code"]] = need - take if need > 0 else need
                if take < have:
                    still_in_stock.add(normalize_to_s5(row["code"]) or str(row["code"] or "").strip())
                if take <= 0:
                    continue
                change = changes.setdefault(
                    row["code"], {"code": row["code"], "product_name": row["product_name"], "deducted": 0, "deleted_rows": 0}
                )
                change["deducted"] += take
                if take >= have:
                    change["deleted_rows"] += 1
                    if not dry_run:
                        conn.execute("DELETE FROM barcode_bad_stock WHERE id = ?", (row["id"],))
                elif not dry_run:
                    conn.execute("UPDATE barcode_bad_stock SET qty = ? WHERE id = ?", (have - take, row["id"]))
            if not dry_run:
                conn.commit()
        finally:
            conn.close()
        items = sorted(changes.values(), key=lambda c: c["code"])
        if not dry_run:
            # 같은 주문으로 또 누르면 이중 차감되므로, 실행했다는 기록을 남겨 화면에 보여준다.
            record = {
                "at": datetime.now(_KST).isoformat(timespec="seconds"),
                "user": user,
                "kinds": len(items),
                "total": sum(c["deducted"] for c in items),
            }
            set_setting(_BAD_STOCK_LAST_DEDUCT_KEY, json.dumps(record, ensure_ascii=False))
            # 이전 실행 이력도 최근 100건까지 보관한다(상세 상품은 건당 200종까지).
            history = _load_deduct_history()
            history.insert(0, {
                **record,
                "items": [
                    {"code": c["code"], "product_name": c["product_name"], "deducted": c["deducted"]}
                    for c in items[:200]
                ],
            })
            set_setting(_BAD_STOCK_DEDUCT_HISTORY_KEY, json.dumps(history[:100], ensure_ascii=False))

        # 차감 결과 악성재고에 하나도 안 남은 상품은 상품명을 원복한다(원복 실패가 차감을 막지는 않는다).
        to_restore = [
            rec for rec in _load_renamed().values()
            if not (set(filter(None, (rec["codes"] or "").split(","))) & still_in_stock)
        ]
        restored = await _restore_renamed_products(to_restore, dry_run)
        return {
            **list_bad_stock(user),
            "dry_run": dry_run,
            "deducted_items": items,
            "deducted_total": sum(c["deducted"] for c in items),
            "restored_items": restored,
        }

    @router.post("/barcode/bad-stock/rename-products")
    async def rename_bad_stock_products(payload: dict = Body(default={}), user: str = Depends(get_current_user)):
        """악성재고 상품의 이지어드민 상품명 앞에 구역 접두어를 붙인다. A구역(상의A/하의A)은 'ZA ', B구역은 'ZB '.
        같은 상품이 서로 다른 알파벳 구역에 걸쳐 있으면 건드리지 않고 충돌로 알린다.
        변경한 상품은 기록해 두었다가 다음 실행에서는 새로 추가된 상품만 이지어드민에서 확인/변경한다.
        dry_run=true면 이지어드민에서 현재 상품명만 읽어 변경 예정 목록을 돌려준다(이미 변경된 상품은 기록만 보정).
        recheck_all=true(전체 재조회)면 기록을 믿지 않고 모든 상품의 현재 상품명을 이지어드민에서 다시 읽어 비교한다
        (기록 이후 이름이 바뀐 상품도 잡아낸다. 시간이 더 걸린다)."""
        phpsessid = (get_setting(_EZADMIN_SESSION_KEY) or "").strip()
        if not phpsessid:
            return {"ok": False, "need_session": True}
        dry_run = bool(payload.get("dry_run"))
        recheck_all = bool(payload.get("recheck_all"))

        conn = _bad_stock_conn()
        try:
            rows = [dict(r) for r in conn.execute("SELECT * FROM barcode_bad_stock").fetchall()]
        finally:
            conn.close()
        letters_by_code: dict[str, set] = {}
        zones_by_code: dict[str, set] = {}
        for r in rows:
            ez_code = normalize_to_s5(r["code"]) or str(r["code"] or "").strip()
            # 알파벳 구역과 '상의F'처럼 알파벳 한 글자로 만든 직접 추가 탭은 그 알파벳을 접두어로 쓴다.
            # 그 외 이름의 직접 추가 탭은 접두어 규칙과 무관하므로 상품명 변경에서 제외한다.
            letter = _zone_letter(r["zone"])
            if ez_code and letter:
                letters_by_code.setdefault(ez_code, set()).add(letter)
                zones_by_code.setdefault(ez_code, set()).add(r["zone"])
        # 화면의 '변경 안 함' 목록용: 접두어 알파벳이 없는 탭에만 있어 상품명 변경 대상이 아닌 상품.
        excluded = []
        seen_excluded = set()
        for r in rows:
            ez_code = normalize_to_s5(r["code"]) or str(r["code"] or "").strip()
            if not ez_code or _zone_letter(r["zone"]) or ez_code in letters_by_code or ez_code in seen_excluded:
                continue
            seen_excluded.add(ez_code)
            excluded.append({"code": ez_code, "name": r["product_name"] or "", "zone": r["zone"]})
        if not letters_by_code:
            return {"ok": True, "items": [], "excluded": excluded, "need_session": False}

        # 기록에 있고 접두어(알파벳)가 그대로인 코드는 이지어드민을 다시 읽지 않는다.
        records = _load_renamed()
        record_by_code = {c: rec for rec in records.values() for c in filter(None, (rec["codes"] or "").split(","))}
        items = []
        known_products: set = set()
        to_fetch = []
        for ez_code in sorted(letters_by_code):
            rec = record_by_code.get(ez_code)
            # 같은 상품의 옵션 코드가 여러 구역에 있으면 앞 알파벳 구역이 기준이다.
            rec_letters = set().union(*(
                letters_by_code.get(c, set()) for c in filter(None, (rec["codes"] or "").split(","))
            )) if rec else set()
            if not recheck_all and rec and rec_letters and min(rec_letters) == rec["letter"] and _record_is_clean(rec):
                if rec["product_id"] not in known_products:
                    known_products.add(rec["product_id"])
                    items.append({"code": rec["codes"], "product_id": rec["product_id"], "old_name": rec["original_name"],
                                  "new_name": rec["renamed_name"], "status": "skip", "message": "기록됨"})
            else:
                to_fetch.append(ez_code)

        cookies = {"PHPSESSID": phpsessid}
        session_lost = False
        progress = {"phase": "read", "done": 0, "total": len(to_fetch)}
        _rename_progress[user] = progress
        try:
            async with httpx.AsyncClient(timeout=30.0, verify=False, follow_redirects=True) as client:
                sem = asyncio.Semaphore(5)

                async def load(ez_code):
                    async with sem:
                        try:
                            return ez_code, await _ez_read_product(client, cookies, ez_code), None
                        except Exception as exc:
                            return ez_code, None, str(exc)
                        finally:
                            progress["done"] += 1

                loaded = await asyncio.gather(*[load(c) for c in to_fetch])

                # 옵션 코드가 아니라 상품(product_id) 단위로 묶어 한 번만 바꾼다.
                products: dict[str, dict] = {}
                for ez_code, result, error in loaded:
                    if error or not result or not result[0]:
                        if result and not result[1]:
                            session_lost = True
                        items.append({"code": ez_code, "status": "error", "message": error or "상품 정보를 읽지 못했습니다"})
                        continue
                    parts = result[0]
                    product_id = ez_product_rename.get_form_value(parts, "product_id")
                    prod = products.setdefault(product_id, {
                        "product_id": product_id, "parts": parts, "codes": [], "letters": set(), "zones": set(),
                        "old_name": ez_product_rename.get_form_value(parts, "name").strip(),
                    })
                    prod["codes"].append(ez_code)
                    prod["letters"] |= letters_by_code[ez_code]
                    prod["zones"] |= zones_by_code[ez_code]

                for prod in products.values():
                    # 기록된 같은 상품의 다른 옵션 코드도 구역 판단에 포함한다.
                    rec = records.get(prod["product_id"])
                    for c in filter(None, ((rec or {}).get("codes") or "").split(",")):
                        if c in letters_by_code and c not in prod["codes"]:
                            prod["letters"] |= letters_by_code[c]
                            prod["zones"] |= zones_by_code[c]
                    base = {"code": ",".join(prod["codes"]), "product_id": prod["product_id"], "old_name": prod["old_name"]}
                    # 여러 구역에 걸쳐 있으면 앞 구역(A가 B보다 앞)의 접두어를 쓴다.
                    letter = min(prod["letters"])
                    if len(prod["letters"]) > 1:
                        zones = sorted(prod["zones"], key=_zone_rank)
                        base["zones"] = zones
                        base["message"] = f"{', '.join(zones)} 구역에 걸쳐 있어 Z{letter} 기준"
                    stripped = _PREFIX_RE.sub("", prod["old_name"])
                    new_name = f"Z{letter} {stripped}"
                    prod["letter"], prod["stripped"], prod["new_name"] = letter, stripped, new_name
                    if prod["old_name"] == new_name:
                        # 이미 바뀐 상품(예: 기록 도입 전에 변경한 것)은 기록만 남긴다.
                        _save_renamed(prod["product_id"], prod["codes"], stripped, new_name, letter, user)
                        items.append({**base, "old_name": stripped, "new_name": new_name, "status": "skip", "message": "이미 변경됨"})
                        continue
                    items.append({**base, "new_name": new_name, "status": "pending", "_prod": prod})

                if not dry_run:
                    progress.update(phase="write", done=0, total=sum(1 for i in items if i.get("_prod")))
                for item in items:
                    prod = item.pop("_prod", None)
                    if prod is None:
                        continue
                    if dry_run:
                        item["status"] = "rename"
                        continue
                    try:
                        ok, message = await _ez_save_product_name(client, cookies, prod["product_id"], prod["parts"], prod["new_name"])
                        if ok:
                            _save_renamed(prod["product_id"], prod["codes"], prod["stripped"], prod["new_name"], prod["letter"], user)
                        item.update(status="done" if ok else "failed", message=message)
                    except Exception as exc:
                        item.update(status="failed", message=str(exc))
                    finally:
                        progress["done"] += 1
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"이지어드민 요청 실패: {exc}")
        finally:
            progress["phase"] = "idle"

        if session_lost and to_fetch and not any(i["status"] not in ("error", "skip") for i in items):
            return {"ok": False, "need_session": True}
        order = {"failed": 0, "error": 1, "conflict": 2, "rename": 3, "done": 4, "skip": 5}
        items.sort(key=lambda i: (order.get(i["status"], 9), i["code"]))
        summary: dict[str, int] = {}
        for i in items:
            summary[i["status"]] = summary.get(i["status"], 0) + 1
        return {"ok": True, "dry_run": dry_run, "items": items, "excluded": excluded, "summary": summary}

    _EZ_TAG_RE = re.compile(r"<[^>]+>")

    def _ez_cell_int(value) -> int:
        text = _EZ_TAG_RE.sub("", str(value or "")).replace(",", "").strip()
        try:
            return int(float(text or 0))
        except ValueError:
            return 0

    async def _compare_bad_stock_with_ezadmin():
        """악성재고에 등록된 상품코드를 이지어드민 재고(I100)에서 일괄 검색해 정상재고와 등록 수량을 비교한다."""
        from urllib.parse import quote

        phpsessid = (get_setting(_EZADMIN_SESSION_KEY) or "").strip()
        if not phpsessid:
            return {"ok": False, "need_session": True}

        conn = _bad_stock_conn()
        try:
            rows = [dict(r) for r in conn.execute("SELECT * FROM barcode_bad_stock").fetchall()]
        finally:
            conn.close()
        if not rows:
            return {"ok": True, "items": [], "summary": {"total": 0, "match": 0, "mismatch": 0, "not_found": 0}}

        # 이지어드민은 S00000 형식이라 코드를 변환하고, 구역이 달라도 같은 상품이면 합산해 비교한다.
        by_code: dict[str, dict] = {}
        for r in rows:
            ez_code = normalize_to_s5(r["code"]) or str(r["code"] or "").strip()
            if not ez_code:
                continue
            item = by_code.setdefault(
                ez_code, {"code": ez_code, "product_name": r["product_name"], "registered": 0, "zones": {}}
            )
            qty = int(r.get("qty") or 1)
            item["registered"] += qty
            item["zones"][r["zone"]] = item["zones"].get(r["zone"], 0) + qty

        today = datetime.now(_KST).strftime("%Y-%m-%d")
        codes = sorted(by_code)
        ez_stock: dict[str, int] = {}
        try:
            async with httpx.AsyncClient(timeout=30.0, verify=False, follow_redirects=True) as client:
                for start in range(0, len(codes), 100):
                    chunk = codes[start:start + 100]
                    par = (
                        "auto_search=&search_all_product=&multi_supply_group=&multi_supply=&str_supply_code=0"
                        "&tags_string=&product_tag_include_type=1&query_type=product_id"
                        f"&query_str={quote(','.join(chunk), safe='')}"
                        "&stock_type=0&stock_start=&stock_end=&notrans_day=&notrans_cnt=&notrans_status=0&stock_status=0"
                        f"&start_date={today}&start_hour=00%3A00%3A00&end_date={today}&end_hour=23%3A59%3A59"
                        "&date_period_sel=1&work_type=stockin&work_start=&work_end=&inout_type=0&product_date="
                        f"&start_date2={today}&end_date2={today}&date_period_sel2=1"
                        "&products_sort=1&category=0&except_soldout=0&temp_soldout=0&location=0"
                    )
                    page, total_pages = 1, 1
                    while page <= total_pages:
                        resp = await client.post(
                            f"{_EZADMIN_BASE}/function.htm",
                            data={
                                "_search": "false", "nd": str(int(datetime.now().timestamp() * 1000)),
                                "rows": "100", "page": str(page), "sidx": "", "sord": "asc",
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
                            obj = resp.json()
                        except Exception:
                            return {"ok": False, "need_session": True}
                        if not isinstance(obj, dict) or "rows" not in obj:
                            return {"ok": False, "need_session": True}
                        for row in obj["rows"]:
                            cell = row.get("cell") or {}
                            key = normalize_to_s5(cell.get("key")) or str(cell.get("key") or "").strip()
                            if key:
                                ez_stock[key] = _ez_cell_int(cell.get("stock"))
                        total_pages = int(obj.get("total") or 1)
                        page += 1
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"이지어드민 조회 실패: {exc}")

        items = []
        summary = {"total": 0, "match": 0, "mismatch": 0, "not_found": 0}
        for code in codes:
            item = by_code[code]
            ez = ez_stock.get(code)
            if ez is None:
                status = "not_found"
            elif ez == item["registered"]:
                status = "match"
            else:
                status = "mismatch"
            summary["total"] += 1
            summary[status] += 1
            items.append({
                "code": code,
                "product_name": item["product_name"],
                "registered": item["registered"],
                "zones": item["zones"],
                "ezadmin_stock": ez,
                "diff": None if ez is None else ez - item["registered"],
                "status": status,
            })
        # 확인이 필요한 것(불일치/미검색)을 위로 올린다.
        order = {"mismatch": 0, "not_found": 1, "match": 2}
        items.sort(key=lambda i: (order[i["status"]], i["code"]))
        return {"ok": True, "items": items, "summary": summary}

    @router.post("/barcode/bad-stock/ezadmin-check")
    async def check_bad_stock_with_ezadmin(user: str = Depends(get_current_user)):
        return await _compare_bad_stock_with_ezadmin()

    @router.post("/barcode/bad-stock/ezadmin-normalize")
    async def normalize_bad_stock_in_ezadmin(payload: dict = Body(default={}), user: str = Depends(get_current_user)):
        """이지어드민 정상재고가 악성재고 등록 수량보다 적은 상품을 부족분만큼 입고처리해 맞춘다.
        codes에 상품코드를 주면 그 상품만, 비우면 부족한 전체를 처리한다. 수량은 클라이언트 값을 믿지 않고
        이 시점에 다시 조회한 값으로 계산하므로 같은 요청이 겹쳐도 필요 이상으로 입고되지 않는다.
        이지어드민 재고가 더 많은 상품은 출고하지 않고 그대로 둔다."""
        phpsessid = (get_setting(_EZADMIN_SESSION_KEY) or "").strip()
        if not phpsessid:
            return {"ok": False, "need_session": True}
        selected = {
            normalize_to_s5(c) or str(c or "").strip() for c in (payload.get("codes") or []) if str(c or "").strip()
        }

        before = await _compare_bad_stock_with_ezadmin()
        if not before.get("ok"):
            return before
        targets = [
            i for i in before["items"]
            if i["status"] == "mismatch" and i["diff"] < 0 and (not selected or i["code"] in selected)
        ]

        results = []
        async with httpx.AsyncClient(timeout=30.0, verify=False, follow_redirects=True) as client:
            for t in targets:
                qty = -t["diff"]
                try:
                    sr = await client.post(
                        f"{_EZADMIN_BASE}/function.htm",
                        data={
                            "template": "I100", "action": "set_stock_data",
                            "product_id": t["code"], "bad": "0", "type": "in",
                            "stock_label": "", "move_warehouse": "0",
                            "stock_unit": "stock_unit_ea", "qty": str(qty), "memo": "악성재고 정상화",
                            "timeFlag": _ez_time_flag(datetime.now()),
                        },
                        cookies={"PHPSESSID": phpsessid}, headers=_ez_invoice_headers(),
                    )
                    if _looks_like_ez_session_error(sr, (sr.text or "").strip()):
                        return {"ok": False, "need_session": True, "results": results}
                    results.append({"code": t["code"], "qty": qty, "ok": sr.status_code < 400})
                except Exception as exc:
                    results.append({"code": t["code"], "qty": qty, "ok": False, "error": str(exc)})

        normalization_log.record(
            get_normalization_db, user=user, source="bad_stock", type_="in",
            entries=[{"code": r["code"], "qty": r["qty"]} for r in results if r["ok"]],
        )
        after = await _compare_bad_stock_with_ezadmin()
        return {
            "ok": all(r["ok"] for r in results),
            "results": results,
            "check": after if after.get("ok") else None,
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

    @router.post("/barcode/defect/purchase-manager-handoff")
    def defect_purchase_manager_handoff(
        payload: dict = Body(default={}),
        user: str = Depends(get_current_user),
    ):
        explicit_counts = payload.get("counts")
        if isinstance(explicit_counts, dict) and explicit_counts:
            # 화면에 보이는 불량리스트의 코드/수량을 그대로 사용
            defect_counts = {}
            for c, q in explicit_counts.items():
                try:
                    q = int(q or 0)
                except (TypeError, ValueError):
                    continue
                if str(c).strip() and q > 0:
                    defect_counts[str(c).strip()] = q
            if not defect_counts:
                raise HTTPException(status_code=400, detail="불량 목록이 비어 있습니다.")
        elif payload.get("summoned_all_tabs") and get_all_tabs_defect_summon_counts:
            # A/B/C 전 탭의 김승일 소환술 수량만 코드별로 합산, 소환술이 없으면 전 탭 불량 전체로 대체
            defect_counts = {c: q for c, q in get_all_tabs_defect_summon_counts().items() if q > 0}
            if not defect_counts and get_all_tabs_defect_counts:
                defect_counts = {c: q for c, q in get_all_tabs_defect_counts().items() if q > 0}
            if not defect_counts:
                raise HTTPException(status_code=400, detail="불량 목록이 비어 있습니다.")
        else:
            defect_counts = get_shared_defect_counts()
            if payload.get("exclude_kimsungil_summon"):
                summon_counts = get_shared_defect_summon_counts()
                defect_counts = {c: q for c, q in defect_counts.items() if not summon_counts.get(c)}
            if not defect_counts:
                raise HTTPException(status_code=400, detail="불량 목록이 비어 있습니다.")

        conn = _get_wonbe_db()
        try:
            base_rows = conn.execute(
                "SELECT 상품코드, 거래처, 거래처상품명, 상품명, 색상, 사이즈, 원가 FROM wonbe"
            ).fetchall()
        finally:
            conn.close()

        wonbe_by_code = {}
        for row in base_rows:
            code = normalize_to_s5(row["상품코드"]) or str(row["상품코드"] or "").strip()
            if code and code not in wonbe_by_code:
                wonbe_by_code[code] = row

        # 거래처 불량 매입 관리에서 사유·사진을 보여줄 수 있도록 코드별 불량 기록을 함께 넘긴다.
        records_by_code: dict[str, list[dict]] = {}
        rec_conn = _defect_record_conn()
        try:
            _sync_defect_records(rec_conn)
            for rec in _list_defect_records_for_tab(rec_conn, defect_tab_service.current_tab()):
                key = normalize_to_s5(rec["code"]) or rec["code"]
                records_by_code.setdefault(key, []).append({
                    "id": rec["id"],
                    "qty": rec["qty"],
                    "reason": rec["reason"],
                    "photo_ids": rec["photo_ids"],
                    "photo_reasons": rec.get("photo_reasons") or [],
                    "created_at": rec["created_at"],
                })
        finally:
            rec_conn.close()

        rows = []
        unmatched_codes = []
        for raw_code, qty in sorted(defect_counts.items()):
            code = normalize_to_s5(raw_code) or raw_code
            matched = wonbe_by_code.get(code)
            if not matched:
                unmatched_codes.append(code or str(raw_code or ""))
                continue
            rows.append({
                "records": records_by_code.get(code, []),
                "code": code,
                "vendor": str(matched["거래처"] or "").strip(),
                "productName": str(matched["거래처상품명"] or "").strip(),
                "ownName": str(matched["상품명"] or "").strip(),
                "color": str(matched["색상"] or "").strip(),
                "size": str(matched["사이즈"] or "").strip(),
                "cost": matched["원가"],
                "qty": int(qty or 0),
            })

        return {"ok": True, "rows": rows, "unmatched_codes": unmatched_codes}

    @router.post("/barcode/defect/export-to-ezadmin")
    async def defect_export_to_ezadmin(
        payload: dict = Body(default={}),
        user: str = Depends(get_current_user),
    ):
        phpsessid = (get_setting(_EZADMIN_SESSION_KEY) or "").strip()
        if not phpsessid:
            return {"ok": False, "need_session": True}

        exclude_kimsungil = bool(payload.get("exclude_kimsungil_summon"))
        defect_counts = get_shared_defect_counts()
        if exclude_kimsungil:
            summon_counts = get_shared_defect_summon_counts()
            defect_counts = {c: q for c, q in defect_counts.items() if not summon_counts.get(c)}
        if not defect_counts:
            return {"ok": False, "error": "불량 목록이 비어 있습니다."}

        defect_rows = _get_defect_list(get_barcode_state(user), exclude_kimsungil=exclude_kimsungil)
        xls_bytes = _build_defect_xls_bytes(exclude_kimsungil=exclude_kimsungil)
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

        execution_id = str(uuid.uuid4())
        record_defect_process_logs(
            execution_id=execution_id,
            processed_at=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            process_type="ezadmin_stock_out",
            rows=defect_rows,
            username=user,
            display_name=get_user_display(user),
        )
        return {"ok": True, "count": len(defect_counts), "execution_id": execution_id}

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

    @router.get("/barcode/orders/export-xls")
    def export_orders_xls(user: str = Depends(get_current_user)):
        state = get_barcode_state(user)
        if not state["loaded"]:
            raise HTTPException(status_code=400, detail="Upload barcode data first")

        content, invoice_count = _build_orders_xls_bytes(state)
        if invoice_count <= 0:
            raise HTTPException(status_code=400, detail="다운로드할 주문 목록이 없습니다")

        filename = f"extended_orders_{datetime.now().strftime('%Y%m%d_%H%M%S')}.xls"
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
                code = normalize_code(cells[0]) or cells[0]
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

        raw = (payload.get("code") or "").strip()
        if not raw:
            raise HTTPException(status_code=400, detail="code is required")

        code = normalize_code(raw) or raw
        defect_counts = dict(get_shared_defect_counts())
        if code in defect_counts:
            defect_counts[code] -= 1
            if defect_counts[code] <= 0:
                del defect_counts[code]
        set_shared_defect_counts(defect_counts)
        _sync_defect_records()

        summon_counts = dict(get_shared_defect_summon_counts())
        if code in summon_counts:
            remaining = defect_counts.get(code, 0)
            if remaining <= 0:
                summon_counts.pop(code, None)
            elif summon_counts[code] > remaining:
                summon_counts[code] = remaining
            set_shared_defect_summon_counts(summon_counts)

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

        raw = (payload.get("code") or "").strip()
        if not raw:
            raise HTTPException(status_code=400, detail="code is required")

        code = normalize_code(raw) or raw
        defect_counts = dict(get_shared_defect_counts())
        defect_counts.pop(code, None)
        set_shared_defect_counts(defect_counts)
        _sync_defect_records()

        summon_counts = dict(get_shared_defect_summon_counts())
        if code in summon_counts:
            summon_counts.pop(code, None)
            set_shared_defect_summon_counts(summon_counts)

        inv = state.get("current_invoice")
        return {
            "ok": True,
            "defects": _get_defect_list(state),
            "items": _get_all_items(state, inv) if inv else [],
            "current_next": _get_first_remaining_item(state, inv),
        }

    @router.post("/barcode/defect/remove-summoned")
    def remove_summoned_defect(payload: dict = Body(...), user: str = Depends(get_current_user)):
        """불량 불러오기 실물 매칭에서 실물이 없는 수량만 현재 탭 불량 목록에서 뺀다.
        직접 찍은 불량 수량은 건드리지 않는다."""
        state = get_barcode_state(user)
        raw = (payload.get("code") or "").strip()
        if not raw:
            raise HTTPException(status_code=400, detail="code is required")
        try:
            qty = int(payload.get("qty") or 0)
        except (TypeError, ValueError):
            qty = 0
        if qty <= 0:
            raise HTTPException(status_code=400, detail="qty must be positive")

        code = normalize_code(raw) or raw
        summon_counts = dict(get_shared_defect_summon_counts())
        qty = min(qty, int(summon_counts.get(code, 0) or 0))
        if qty <= 0:
            raise HTTPException(status_code=400, detail="불러온 불량 수량이 없습니다.")

        defect_counts = dict(get_shared_defect_counts())
        remaining = defect_counts.get(code, 0) - qty
        if remaining > 0:
            defect_counts[code] = remaining
        else:
            defect_counts.pop(code, None)
        left_summon = summon_counts.get(code, 0) - qty
        if left_summon > 0:
            summon_counts[code] = left_summon
        else:
            summon_counts.pop(code, None)
        set_shared_defect_counts(defect_counts)
        set_shared_defect_summon_counts(summon_counts)
        _sync_defect_records()

        inv = state.get("current_invoice")
        return {
            "ok": True,
            "removed_qty": qty,
            "defects": _get_defect_list(state),
            "items": _get_all_items(state, inv) if inv else [],
            "current_next": _get_first_remaining_item(state, inv),
        }

    @router.post("/barcode/defect/ochuul-minus")
    async def defect_ochuul_minus(
        payload: dict = Body(default={}),
        user: str = Depends(get_current_user),
    ):
        """불량 목록 기준으로 Ably 오출 재고 차감."""
        exclude_kimsungil = bool(payload.get("exclude_kimsungil_summon"))
        defect_counts = get_shared_defect_counts()
        if exclude_kimsungil:
            summon_counts = get_shared_defect_summon_counts()
            defect_counts = {c: q for c, q in defect_counts.items() if not summon_counts.get(c)}
        if not defect_counts:
            return {"ok": True, "matched": 0, "details": [], "message": "불량 목록이 없습니다."}

        defect_rows = _get_defect_list(get_barcode_state(user), exclude_kimsungil=exclude_kimsungil)
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
                normalized = normalize_code(a_val) or a_val
                try:
                    code_to_sno[normalized] = int(k_val)
                except (ValueError, TypeError):
                    pass
        finally:
            _wconn.close()

        sno_to_ea: dict[int, int] = {}
        missing_option_codes: list[str] = []
        for code, count in defect_counts.items():
            sno = code_to_sno.get(code)
            if sno and count > 0:
                sno_to_ea[sno] = sno_to_ea.get(sno, 0) + count
            elif count > 0:
                missing_option_codes.append(code)

        if not sno_to_ea:
            execution_id = str(uuid.uuid4())
            early_outcomes = {
                str(row.get("code") or ""): {"applied_qty": 0, "result_status": "missing_option_number"}
                for row in defect_rows
            }
            record_defect_process_logs(
                execution_id=execution_id,
                processed_at=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                process_type="ably_ochuul_minus",
                rows=defect_rows,
                username=user,
                display_name=get_user_display(user),
                outcomes=early_outcomes,
            )
            return {
                "ok": True,
                "matched": 0,
                "details": [],
                "missing_option_codes": missing_option_codes,
                "ably_missing_codes": [],
                "message": "옵션번호가 매칭되지 않았습니다. 원가베이스 K열을 확인하세요.",
            }
            return {"ok": True, "matched": 0, "details": [],
                    "message": "매칭된 옵션이 없습니다. 원가베이스 K열을 확인하세요."}

        try:
            token = await pastelco_login()
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"에이블리 로그인 실패: {e}")

        ably_base = "https://api.a-bly.com"

        def _ably_headers(tok: str) -> tuple[dict, dict]:
            my_h = {
                "Authorization": f"JWT {tok}", "Accept": "application/json",
                "Origin": "https://my.a-bly.com", "Referer": "https://my.a-bly.com/",
                "User-Agent": "Mozilla/5.0",
            }
            admin_h = {
                "Authorization": f"JWT {tok}", "Accept": "application/json",
                "Content-Type": "application/json",
                "Origin": "https://seller-admin.a-bly.com",
                "Referer": "https://seller-admin.a-bly.com/",
                "User-Agent": "Mozilla/5.0",
            }
            return my_h, admin_h

        my_headers, admin_headers = _ably_headers(token)

        all_opts = []
        page = 1
        async with httpx.AsyncClient(timeout=30.0) as client:
            while True:
                res = await client.get(
                    f"{ably_base}/seller/today-delivery-goods-options/",
                    headers=my_headers,
                    params={"keyword_type": "goods_name", "current_page": page, "per_page": 50},
                )
                if res.status_code == 401:
                    token = await pastelco_login(force=True)
                    my_headers, admin_headers = _ably_headers(token)
                    res = await client.get(
                        f"{ably_base}/seller/today-delivery-goods-options/",
                        headers=my_headers,
                        params={"keyword_type": "goods_name", "current_page": page, "per_page": 50},
                    )
                if res.status_code != 200:
                    raise HTTPException(
                        status_code=502,
                        detail=f"에이블리 오늘출발 옵션 목록 조회 실패 (page {page}, HTTP {res.status_code}): {res.text[:300]}",
                    )
                data = res.json()
                opts = data.get("data", [])
                max_page = data.get("max_page_number", 1)
                if not opts and page < max_page:
                    raise HTTPException(
                        status_code=502,
                        detail=f"에이블리 오늘출발 옵션 목록 조회 중 데이터 누락 (page {page}/{max_page})",
                    )
                if not opts:
                    break
                all_opts.extend(opts)
                if page >= max_page:
                    break
                page += 1

        updates = []
        ably_option_snos = set()
        for opt in all_opts:
            sno = opt.get("sno")
            if sno is not None:
                try:
                    ably_option_snos.add(int(sno))
                except (ValueError, TypeError):
                    pass
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
                if res.status_code == 401:
                    token = await pastelco_login(force=True)
                    _, admin_headers = _ably_headers(token)
                    res = await client.patch(
                        f"{ably_base}/seller/today-delivery-goods-options/bulk-update/",
                        headers=admin_headers,
                        json={"options": patch_payload},
                    )
            if res.status_code not in (200, 201, 204):
                raise HTTPException(status_code=502,
                    detail=f"bulk-update 실패 (HTTP {res.status_code}): {res.text[:300]}")

        updates_by_sno = {item["sno"]: item for item in updates}
        ably_missing_codes = [
            code for code, count in defect_counts.items()
            if count > 0 and code_to_sno.get(code) and code_to_sno[code] not in ably_option_snos
        ]
        outcomes = {}
        for row in defect_rows:
            code = str(row.get("code") or "")
            item = updates_by_sno.get(code_to_sno.get(code))
            if item:
                outcomes[code] = {
                    "applied_qty": int(row.get("count") or 0),
                    "result_status": "matched",
                    "option_sno": item["sno"],
                    "stock_before": item["_prev_stock"],
                    "stock_after": item["stock"],
                }
        for row in defect_rows:
            outcomes.setdefault(str(row.get("code") or ""), {"applied_qty": 0, "result_status": "unmatched"})
        for code in missing_option_codes:
            outcomes[code] = {"applied_qty": 0, "result_status": "missing_option_number"}
        for code in ably_missing_codes:
            outcomes[code] = {"applied_qty": 0, "result_status": "not_in_ably_today"}
        execution_id = str(uuid.uuid4())
        record_defect_process_logs(
            execution_id=execution_id,
            processed_at=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            process_type="ably_ochuul_minus",
            rows=defect_rows,
            username=user,
            display_name=get_user_display(user),
            outcomes=outcomes,
        )
        return {
            "ok": True,
            "matched": len(updates),
            "details": updates,
            "missing_option_codes": missing_option_codes,
            "ably_missing_codes": ably_missing_codes,
            "execution_id": execution_id,
        }

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
    async def incoming_ezadmin_voucher_list(date: str | None = None, user: str = Depends(get_current_user)):
        phpsessid = (get_setting(_EZADMIN_SESSION_KEY) or "").strip()
        if not phpsessid:
            return {"ok": False, "need_session": True}
        today = str(date or datetime.now().strftime("%Y-%m-%d"))
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
            # IM00 목록에는 req_qty가 없고 총 수량이 total_product_qty로 온다. 화면들이 req_qty를 읽으므로 맞춰준다.
            if not clean.get("req_qty") and clean.get("total_product_qty"):
                clean["req_qty"] = clean["total_product_qty"]
            vouchers.append({"sheet": sheet_no, "cell": clean})
        return {"ok": True, "date": today, "vouchers": vouchers}

    @router.post("/barcode/stock-log")
    async def barcode_stock_log(
        payload: dict = Body(default={}),
        user: str = Depends(get_current_user),
    ):
        """EZAdmin 재고내역(I100 get_tx_history)을 상품코드로 조회한다."""
        product_id = str(payload.get("product_code") or "").strip()
        if not product_id:
            raise HTTPException(status_code=400, detail="상품코드를 입력하세요.")
        phpsessid = (get_setting(_EZADMIN_SESSION_KEY) or "").strip()
        if not phpsessid:
            return {"ok": False, "need_session": True}

        end_date = str(payload.get("end_date") or "").strip() or datetime.now(_KST).strftime("%Y-%m-%d")
        start_date = str(payload.get("start_date") or "").strip() or (
            datetime.now(_KST) - timedelta(days=30)
        ).strftime("%Y-%m-%d")
        if not _SCHEDULE_DATE_RE.match(start_date) or not _SCHEDULE_DATE_RE.match(end_date):
            raise HTTPException(status_code=400, detail="날짜 형식이 올바르지 않습니다.")

        try:
            logs = await fetch_ezadmin_stock_logs(phpsessid, product_id, start_date, end_date)
        except Exception as exc:
            traceback.print_exc()
            raise HTTPException(status_code=500, detail=f"EZAdmin 재고내역 조회 실패: {exc}")
        if logs is None:
            return {"ok": False, "need_session": True}
        return {"ok": True, "product_code": product_id, "start_date": start_date, "end_date": end_date, "count": len(logs), "logs": logs}

    @router.post("/barcode/stock-count")
    async def barcode_stock_count(
        payload: dict = Body(default={}),
        user: str = Depends(get_current_user),
    ):
        """상품코드 1건의 EZAdmin 현재고(I100)를 조회한다 — 재고(stock_normal)와 접수(출고 전 대기) 수량."""
        product_id = str(payload.get("product_code") or "").strip().upper()
        if not product_id:
            raise HTTPException(status_code=400, detail="상품코드를 입력하세요.")
        if not (get_setting(_EZADMIN_SESSION_KEY) or "").strip():
            return {"ok": False, "need_session": True}
        ez = EzAdminClient(get_setting)
        try:
            info = await ez.get_stock_and_pending(product_id)
        except EzAdminSessionExpired:
            return {"ok": False, "need_session": True}
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc))
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=502, detail=f"EZAdmin 요청 실패: {exc}")
        # 화면에는 상품코드 대신 상품명/옵션명(색상·사이즈)을 보여준다. 원가베이스유에 없으면 이름은 비워 둔다.
        from api.wonbe_routes import load_wonbe_pure_product_name_map, load_wonbe_product_name_map
        pure = load_wonbe_pure_product_name_map().get(product_id) or ""
        full = load_wonbe_product_name_map().get(product_id) or ""
        option = full[len(pure):].strip() if pure and full.startswith(pure) else ("" if pure else full)
        return {
            "ok": True, "product_code": product_id, "product_name": pure or full, "option_name": option,
            "stock": info["stock"], "pending": info["pending"],
        }

    @router.post("/barcode/stock-adjust")
    async def barcode_stock_adjust(
        payload: dict = Body(default={}),
        user: str = Depends(get_current_user),
    ):
        """로그 확인 화면에서 상품 1건을 EZAdmin I200 일괄 입고/출고로 처리한다 (type: in/out)."""
        product_id = str(payload.get("product_code") or "").strip()
        type_ = str(payload.get("type") or "").strip()
        if not product_id:
            raise HTTPException(status_code=400, detail="상품코드를 입력하세요.")
        if type_ not in ("in", "out"):
            raise HTTPException(status_code=400, detail="type은 in(입고) 또는 out(출고)이어야 합니다.")
        try:
            qty = int(float(payload.get("qty") or 0))
        except (TypeError, ValueError):
            qty = 0
        if qty < 1 or qty > 9999:
            raise HTTPException(status_code=400, detail="수량은 1~9999 사이여야 합니다.")
        if not (get_setting(_EZADMIN_SESSION_KEY) or "").strip():
            return {"ok": False, "need_session": True}
        # 원가베이스유에 없는 코드를 EZAdmin에 올리지 않도록 등록 여부를 먼저 확인하고, 등록된 원본 표기를 쓴다.
        from api.wonbe_routes import load_wonbe_product_codes
        registered = load_wonbe_product_codes().get(product_id.upper())
        if not registered:
            raise HTTPException(status_code=400, detail=f"상품코드({product_id})를 원가베이스유에서 찾을 수 없습니다.")
        user_memo = str(payload.get("memo") or "").strip()[:100]
        memo = user_memo or f"로그확인 {'입고' if type_ == 'in' else '출고'}({user})"
        ez = EzAdminClient(get_setting)
        items = [{"product_id": registered, "qty": qty, "memo": memo}]
        try:
            res = await (ez.bulk_receive_stock(items) if type_ == "in" else ez.bulk_ship_stock(items))
        except EzAdminSessionExpired:
            return {"ok": False, "need_session": True}
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=502, detail=f"EZAdmin 요청 실패: {exc}")
        if str(res.get("error")) not in ("0", ""):
            raise HTTPException(status_code=400, detail=res.get("msg") or "EZAdmin 처리 실패")
        normalization_log.record(
            get_normalization_db, user=user, source="log_check", type_=type_,
            entries=[{"code": registered, "qty": qty, "memo": user_memo}],
        )
        return {"ok": True, "product_code": registered, "type": type_, "qty": qty}

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

        requested_sheets = [str(s).strip() for s in (payload.get("sheet_list") or []) if str(s).strip()]

        if requested_sheets:
            sheet_list = requested_sheets
        else:
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

        try:
            try:
                dataframe = pd.read_excel(BytesIO(r.content), header=None, engine="xlrd")
            except Exception:
                try:
                    dataframe = pd.read_html(BytesIO(r.content), header=None)[0]
                except Exception:
                    dataframe = pd.read_csv(BytesIO(r.content), header=None, encoding="utf-8-sig")

            counts = Counter()
            for values in dataframe.itertuples(index=False, name=None):
                if len(values) < 2:
                    continue
                code = normalize_code(values[0])
                qty = to_int(values[1], default=0)
                if code and qty > 0:
                    counts[code] += qty
        except Exception as exc:
            traceback.print_exc()
            raise HTTPException(status_code=500, detail=f"파일 파싱 실패: {exc}")

        set_shared_incoming_counts(dict(counts))
        return {"ok": True, "date": today, "codes": len(counts), "total_qty": sum(counts.values())}

        suffix = ".xls"
        tmp_path = Path(tempfile.gettempdir()) / f"yusaek_ezadmin_incoming_{uuid.uuid4().hex}{suffix}"
        tmp_path.write_bytes(r.content)
        try:
            wb, ws = load_excel_any(tmp_path)
            counts = Counter()
            for row_num in range(1, ws.max_row + 1):
                code = normalize_code(ws.cell(row_num, 1).value)
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
                            "rows": "300", "page": "1", "sidx": "", "sord": "desc",
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
        start = str(payload.get("start_date") or (today - timedelta(days=30)).strftime("%Y-%m-%d"))
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

        rows = [["product_name", "supply_product_name", "", "", "", "options", "request_qty", "", "product_id", "", "", "reserve_qty"]]
        for row in obj.get("rows", []):
            cell = row.get("cell", row)
            rows.append([
                _ez_val(cell.get("product_name")), _ez_val(cell.get("supply_product_name")), "", "", "",
                _ez_val(cell.get("options")), _ez_val(cell.get("request_qty")), "",
                _ez_val(cell.get("product_id")), "", "", _ez_val(cell.get("reserve_qty")),
            ])
        return {"ok": True, "rows": rows, "count": len(rows) - 1}

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

    @router.post("/barcode/client-schedule/export-to-ezadmin")
    async def client_schedule_export_to_ezadmin(
        payload: dict = Body(default={}),
        user: str = Depends(get_current_user),
    ):
        phpsessid = (get_setting(_EZADMIN_SESSION_KEY) or "").strip()
        if not phpsessid:
            return {"ok": False, "need_session": True}

        import io as _io
        today = datetime.now(_KST).date()

        def _classify(note_text: str):
            """Returns (output_note, is_tracked_date)."""
            if _SCHEDULE_DATE_RE.match(note_text):
                parsed = date.fromisoformat(note_text)
                return ("" if parsed <= today else note_text), True
            return note_text, False

        scheduled_rows = []
        for row in payload.get("rows") or []:
            code = str(row.get("productCode", ""))
            output_note, is_tracked = _classify(str(row.get("note", "")))
            scheduled_rows.append({"productCode": code, "note": output_note, "is_tracked": is_tracked})

        current_codes = {row["productCode"] for row in scheduled_rows}

        conn = get_shared_db()
        try:
            stale = conn.execute(
                "SELECT DISTINCT product_code FROM client_schedule_export_log WHERE note_date <= ?",
                (today.isoformat(),),
            ).fetchall()
        finally:
            conn.close()

        cleanup_rows = [
            {"productCode": r["product_code"], "note": "", "is_tracked": True}
            for r in stale
            if r["product_code"] not in current_codes
        ]

        all_rows = scheduled_rows + cleanup_rows
        if not all_rows:
            return {"ok": True, "count": 0}

        wb = xlwt.Workbook()
        ws = wb.add_sheet("Sheet1")
        ws.write(0, 0, "상품코드")
        ws.write(0, 1, "상품메모")
        for ri, row in enumerate(all_rows, 1):
            ws.write(ri, 0, row["productCode"])
            ws.write(ri, 1, row["note"])

        buf = _io.BytesIO()
        wb.save(buf)
        xls_bytes = buf.getvalue()

        c620_url = f"{_EZADMIN_BASE}/template40.htm?template=C620"
        ts_ms = str(int(datetime.now().timestamp() * 1000))
        ez_headers = {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/120.0.0.0 Safari/537.36"
            ),
            "Origin": _EZADMIN_BASE,
            "Referer": c620_url,
        }
        cookies = {"PHPSESSID": phpsessid}

        try:
            async with httpx.AsyncClient(timeout=60.0, verify=False, follow_redirects=True) as client:
                r = await client.post(
                    c620_url,
                    data={"page": "1", "action": "update2", "template": "C620", "total": "0", "status": "6"},
                    files={"_file": (f"client_schedule_{ts_ms}.xls", xls_bytes, "application/vnd.ms-excel")},
                    cookies=cookies,
                    headers=ez_headers,
                )
        except Exception as exc:
            return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}

        html = r.text
        m = re.search(r'alert\("(\d+)\s*개 변경 완료 되었습니다\."\)', html)
        if not m:
            return {"ok": False, "error": "응답에서 변경 완료 문구를 찾지 못했습니다", "raw_snippet": html[:300]}

        now_iso = datetime.now(_KST).isoformat()
        conn = get_shared_db()
        try:
            for row in all_rows:
                if not row["is_tracked"]:
                    continue
                conn.execute(
                    "DELETE FROM client_schedule_export_log WHERE product_code = ?",
                    (row["productCode"],),
                )
                if row["note"]:
                    conn.execute(
                        "INSERT INTO client_schedule_export_log (product_code, note_date, exported_at) "
                        "VALUES (?, ?, ?)",
                        (row["productCode"], row["note"], now_iso),
                    )
            conn.commit()
        finally:
            conn.close()

        return {"ok": True, "count": int(m.group(1))}

    def _post_shipment_cancel_rows() -> list[dict]:
        conn = get_db()
        try:
            rows = conn.execute(
                "SELECT p.id, p.date, p.seq, p.invoice_no, p.shop, p.manager, p.ship_time, p.cancel_time, "
                "p.product_name, p.carrier, p.fetched_at, COALESCE(p.manual, 0) AS manual, "
                "CASE WHEN h.hold_key IS NULL THEN 0 ELSE 1 END AS held "
                "FROM post_shipment_cancel p "
                "LEFT JOIN post_shipment_cancel_hold h ON h.hold_key = COALESCE(NULLIF(p.seq, ''), p.invoice_no) "
                "ORDER BY p.id"
            ).fetchall()
        finally:
            conn.close()
        return [dict(row) for row in rows]

    def _is_post_shipment_cancelled(invoice_no: str) -> bool:
        value = str(invoice_no or "").strip()
        if not value:
            return False
        conn = get_db()
        try:
            row = conn.execute(
                "SELECT 1 FROM post_shipment_cancel WHERE invoice_no = ? LIMIT 1", (value,)
            ).fetchone()
        finally:
            conn.close()
        return row is not None

    @router.get("/barcode/post-shipment-cancel/list")
    def post_shipment_cancel_list(user: str = Depends(get_current_user)):
        """저장된(새로고침으로 불러온) 배송후취소 목록을 로컬 DB에서 그대로 반환.

        EZAdmin을 호출하지 않는다 - 실제 조회는 refresh 엔드포인트에서만 일어난다."""
        rows = _post_shipment_cancel_rows()
        date = rows[0]["date"] if rows else ""
        fetched_at = rows[0]["fetched_at"] if rows else ""
        return {"ok": True, "date": date, "fetched_at": fetched_at, "count": len(rows), "items": rows}

    @router.post("/barcode/post-shipment-cancel/refresh")
    async def post_shipment_cancel_refresh(user: str = Depends(get_current_user)):
        """E807(배송후취소) - 오늘 발송 후 취소된 주문의 송장번호 목록을 EZAdmin에서 다시 조회해 로컬 DB에 저장.

        실캡처(브라우저 요청) 그대로: template=E800으로 grid_E807을 호출하고,
        실제 조회조건(E807/status=8/type=cancel/오늘 날짜)은 par에 담는다."""
        phpsessid = (get_setting(_EZADMIN_SESSION_KEY) or "").strip()
        if not phpsessid:
            return {"ok": False, "need_session": True}

        today = datetime.now(_KST).strftime("%Y-%m-%d")
        par = (
            f"template=E807&action=&start_date={today}&end_date={today}"
            "&date_period_sel=0&multi_shop_group=&multi_shop=&str_shop_code=0"
            "&trans_corp=99&cancel_qty=&qty=&status=8&order_cs=0&type=cancel&view=1"
        )
        headers = {
            "User-Agent": "Mozilla/5.0",
            "X-Requested-With": "XMLHttpRequest",
            "Referer": f"{_EZADMIN_BASE}/template40.htm?winmode=none&template=E807&act=action&view=1",
        }
        try:
            async with httpx.AsyncClient(timeout=20.0, verify=False, follow_redirects=True) as client:
                r = await client.post(
                    f"{_EZADMIN_BASE}/function.htm",
                    data={
                        "_search": "false",
                        "nd": str(int(datetime.now().timestamp() * 1000)),
                        "rows": "9999",
                        "page": "1",
                        "sidx": "",
                        "sord": "asc",
                        "readonly": "T",
                        "template": "E800",
                        "action": "grid_E807",
                        "par": par,
                        "index": "",
                        "sort_order": "",
                    },
                    cookies={"PHPSESSID": phpsessid},
                    headers=headers,
                )
        except Exception:
            return {"ok": False, "need_session": True}
        try:
            obj = r.json()
        except Exception:
            return {"ok": False, "need_session": True}
        if "rows" not in obj:
            # 오늘 배송후취소 건이 0건이면 EZAdmin이 "rows" 키 자체를 안 내려줄 때가 있다 -
            # 이걸 세션 만료로 오판하면 세션이 멀쩡한데도 계속 재입력을 요구하게 된다.
            # 진짜 세션 만료 응답에만 있는 로그인/세션 관련 문구가 있을 때만 need_session 처리.
            body_lower = (r.text or "").lower()
            if any(t in body_lower for t in ("login", "phpsessid", "session", "로그인")):
                return {"ok": False, "need_session": True}
            obj = {"rows": []}

        _html_tag = re.compile(r"<[^>]+>")
        items = []
        for row in obj.get("rows", []):
            cell = row.get("cell") or {}
            invoice_no = str(cell.get("col6") or "").strip()
            if not invoice_no:
                continue
            seq_match = re.search(r"popupcs\(\s*(\d+)", str(cell.get("col3") or ""))
            items.append({
                "seq": seq_match.group(1) if seq_match else None,
                "invoice_no": invoice_no,
                "shop": _html_tag.sub("", str(cell.get("col4") or "")).strip(),
                "manager": _html_tag.sub("", str(cell.get("col18") or "")).strip(),
                "ship_time": str(cell.get("col7") or "").strip(),
                "cancel_time": str(cell.get("col10") or "").strip(),
                "product_name": _html_tag.sub("", str(cell.get("col20") or cell.get("col15") or "")).strip(),
                "carrier": str(cell.get("col21") or "").strip(),
            })

        fetched_at = datetime.now(_KST).isoformat()
        conn = get_db()
        try:
            # 수동 추가분(manual=1)은 새로고침해도 보존한다.
            # 단, 지난 날짜의 수동 추가분은 정리한다.
            conn.execute(
                "DELETE FROM post_shipment_cancel WHERE COALESCE(manual, 0) = 0 OR date <> ?", (today,)
            )
            conn.execute("DELETE FROM post_shipment_cancel_hold WHERE date <> ?", (today,))
            conn.executemany(
                "INSERT INTO post_shipment_cancel "
                "(date, seq, invoice_no, shop, manager, ship_time, cancel_time, product_name, carrier, fetched_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                [
                    (today, item["seq"], item["invoice_no"], item["shop"], item["manager"],
                     item["ship_time"], item["cancel_time"], item["product_name"], item["carrier"], fetched_at)
                    for item in items
                ],
            )
            conn.commit()
        finally:
            conn.close()

        all_rows = _post_shipment_cancel_rows()
        return {"ok": True, "date": today, "fetched_at": fetched_at, "count": len(all_rows), "items": all_rows}

    # ---- 배송후취소 '취소 조회' / '취소진행' / '보류' ----
    # 목록의 seq = 이지어드민 C/S창의 pack(관리번호). 합포장이면 송장번호 하나에 seq가 여러 개라 송장번호는 키로 못 쓴다.
    # pack → 에이블리 주문번호(list_order_id) → 에이블리 취소목록/배송중에서 주문번호 검색.
    _SHIP_CANCEL_LOOKBACK_DAYS = 30

    def _post_shipment_cancel_row(row_id) -> dict | None:
        conn = get_db()
        try:
            row = conn.execute(
                "SELECT id, seq, invoice_no FROM post_shipment_cancel WHERE id = ?", (row_id,)
            ).fetchone()
        finally:
            conn.close()
        return dict(row) if row else None

    async def _ably_state_for_pack(ably: AblyClient, phpsessid: str, seq: str) -> dict:
        pack_items = await ezo.pack_rows(phpsessid, seq)
        order_ids = list(dict.fromkeys(
            oid for oid in (
                str(r["cell"].get("list_order_id") or r["row"].get("order_id") or "").strip() for r in pack_items
            ) if oid
        ))
        if not order_ids:
            return {"ok": False, "message": "이지어드민에서 주문번호를 찾지 못했습니다."}
        now = datetime.now(_KST)
        start = (now - timedelta(days=_SHIP_CANCEL_LOOKBACK_DAYS)).strftime("%Y-%m-%d")
        end = now.strftime("%Y-%m-%d")
        in_cancel = in_shipping = in_refund = False
        cancel_snos: list[str] = []
        for oid in order_ids:
            cancels, shipping = await asyncio.gather(
                ably.search_cancels_by_order_sno(oid, start_date=start, end_date=end),
                ably.search_shipping_items_by_order_sno(oid),
            )
            if not cancels and not shipping:
                # 1차(취소목록/배송중)에서 못 찾으면 취소 환불 요청 내역에서 한 번 더 찾는다.
                cancels = await ably.search_refund_requests_by_order_sno(oid, start_date=start, end_date=end)
                if cancels:
                    in_refund = True
            if cancels:
                in_cancel = True
                cancel_snos += [str(c.get("sno")) for c in cancels if c.get("sno")]
            if shipping:
                in_shipping = True
        return {
            "ok": True, "order_ids": order_ids, "in_cancel": in_cancel, "in_refund": in_refund,
            "in_shipping": in_shipping, "cancel_snos": cancel_snos,
        }

    @router.post("/barcode/post-shipment-cancel/ably-lookup")
    async def post_shipment_cancel_ably_lookup(payload: dict = Body(...), user: str = Depends(get_current_user)):
        """선택한 목록 건을 에이블리 취소목록 / 배송중에서 주문번호로 검색한다 ('취소 조회')."""
        phpsessid = (get_setting(_EZADMIN_SESSION_KEY) or "").strip()
        if not phpsessid:
            return {"ok": False, "need_session": True}
        ids = [i for i in (payload.get("ids") or []) if i is not None][:100]
        ably = AblyClient()
        try:
            await ably.login()
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"에이블리 로그인 실패: {exc}")
        sem = asyncio.Semaphore(4)
        session_expired = False

        async def _one(row_id):
            nonlocal session_expired
            row = _post_shipment_cancel_row(row_id)
            if row is None:
                return {"id": row_id, "ok": False, "message": "목록에서 찾지 못했습니다."}
            seq = str(row.get("seq") or "").strip()
            if not seq:
                return {"id": row_id, "ok": False, "message": "이지어드민 관리번호(seq)가 없는 수동 추가 건입니다."}
            async with sem:
                try:
                    state = await _ably_state_for_pack(ably, phpsessid, seq)
                except ezo.SessionExpired:
                    session_expired = True
                    return {"id": row_id, "ok": False, "message": "이지어드민 세션 만료"}
                except Exception as exc:
                    return {"id": row_id, "ok": False, "message": f"조회 실패: {exc}"}
            return {"id": row_id, **state}

        results = await asyncio.gather(*(_one(i) for i in ids))
        if session_expired:
            return {"ok": False, "need_session": True}
        return {"ok": True, "results": results}

    @router.post("/barcode/post-shipment-cancel/ship-cancel")
    async def post_shipment_cancel_ship_cancel(payload: dict = Body(...), user: str = Depends(get_current_user)):
        """'취소진행' - 이지어드민 C/S창에서 배송취소 → 송장삭제 → 전체취소.

        화면 상태를 믿지 않고, 실행 직전에 에이블리 취소목록에 아직 있는지 다시 확인한다."""
        phpsessid = (get_setting(_EZADMIN_SESSION_KEY) or "").strip()
        if not phpsessid:
            return {"ok": False, "need_session": True}
        row = _post_shipment_cancel_row(payload.get("id"))
        seq = str((row or {}).get("seq") or "").strip()
        if not seq:
            raise HTTPException(status_code=404, detail="이지어드민 관리번호(seq)가 있는 목록 건이 아닙니다.")
        ably = AblyClient()
        try:
            state = await _ably_state_for_pack(ably, phpsessid, seq)
            if not state.get("ok"):
                raise HTTPException(status_code=404, detail=state.get("message") or "주문 확인 실패")
            if not state["in_cancel"]:
                raise HTTPException(status_code=409, detail="에이블리 취소목록에서 더 이상 확인되지 않아 중단했습니다. 다시 조회해 주세요.")
            steps = await ezo.cancel_shipped_pack(phpsessid, seq)
        except ezo.SessionExpired:
            return {"ok": False, "need_session": True}
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=502, detail=str(exc))
        return {"ok": True, "id": row["id"], "order_ids": state["order_ids"], "steps": steps}

    @router.post("/barcode/post-shipment-cancel/hold")
    async def post_shipment_cancel_hold(payload: dict = Body(...), user: str = Depends(get_current_user)):
        """'보류' - 확인했다는 표시. 이후 이 건은 다시 조회하지 않는다 (새로고침해도 유지, 날짜가 바뀌면 정리)."""
        row = _post_shipment_cancel_row(payload.get("id"))
        if row is None:
            raise HTTPException(status_code=404, detail="목록에서 찾지 못했습니다.")
        hold_key = str(row.get("seq") or "").strip() or row["invoice_no"]
        now = datetime.now(_KST)
        conn = get_db()
        try:
            conn.execute(
                "INSERT OR REPLACE INTO post_shipment_cancel_hold (hold_key, date, held_by, held_at) VALUES (?, ?, ?, ?)",
                (hold_key, now.strftime("%Y-%m-%d"), str(user), now.isoformat()),
            )
            conn.commit()
        finally:
            conn.close()
        return {"ok": True, "id": row["id"]}

    @router.post("/barcode/post-shipment-cancel/add")
    async def post_shipment_cancel_add(payload: dict = Body(...), user: str = Depends(get_current_user)):
        """배송후취소 목록에 송장번호를 수동으로 추가한다 (새로고침해도 유지, 당일 한정)."""
        invoice_no = str(payload.get("invoice_no") or "").strip()
        if not invoice_no:
            raise HTTPException(status_code=400, detail="송장번호를 입력해주세요.")
        today = datetime.now(_KST).strftime("%Y-%m-%d")
        now_iso = datetime.now(_KST).isoformat()
        conn = get_db()
        try:
            exists = conn.execute(
                "SELECT 1 FROM post_shipment_cancel WHERE invoice_no = ? LIMIT 1", (invoice_no,)
            ).fetchone()
            if exists:
                raise HTTPException(status_code=409, detail="이미 목록에 있는 송장번호입니다.")
            conn.execute(
                "INSERT INTO post_shipment_cancel "
                "(date, seq, invoice_no, shop, manager, ship_time, cancel_time, product_name, carrier, fetched_at, manual) "
                "VALUES (?, NULL, ?, ?, ?, '', ?, ?, ?, ?, 1)",
                (
                    today, invoice_no,
                    str(payload.get("shop") or "").strip(),
                    str(payload.get("manager") or "").strip() or str(user),
                    now_iso[11:19],
                    str(payload.get("product_name") or "").strip(),
                    str(payload.get("carrier") or "").strip(),
                    now_iso,
                ),
            )
            conn.commit()
        finally:
            conn.close()
        rows = _post_shipment_cancel_rows()
        return {"ok": True, "date": today, "count": len(rows), "items": rows}

    @router.post("/barcode/post-shipment-cancel/delete")
    async def post_shipment_cancel_delete(payload: dict = Body(...), user: str = Depends(get_current_user)):
        """수동 추가한 배송후취소 건만 삭제한다."""
        row_id = payload.get("id")
        conn = get_db()
        try:
            conn.execute("DELETE FROM post_shipment_cancel WHERE id = ? AND COALESCE(manual, 0) = 1", (row_id,))
            conn.commit()
        finally:
            conn.close()
        rows = _post_shipment_cancel_rows()
        return {"ok": True, "count": len(rows), "items": rows}

    @router.post("/barcode/incoming/verify-trans-in")
    async def barcode_incoming_verify_trans_in(user: str = Depends(get_current_user)):
        """바코드탭에서 불러온 입고 파일의 상품코드를, 이지어드민 I100(오늘 입고 거래발생) 목록과
        대조해 이지어드민 쪽에 안 잡히는 상품코드만 골라낸다.

        조회 자체는 이지어드민 실캡처(work_type=trans&work_start=1, 오늘 날짜) 그대로 -
        backend/api/inventory_dashboard_routes.py의 today_stock_check와 같은 I100/search
        호출 형태를 쓰되 par 조건(재고 stockin이 아니라 거래발생 입고)과 결과(일치 대신
        불일치)만 다르다."""
        incoming_counts = get_shared_incoming_counts() or {}
        if not incoming_counts:
            return {"ok": False, "detail": "불러온 입고 파일이 없습니다. 바코드 탭에서 입고 파일을 먼저 불러오세요."}

        phpsessid = (get_setting(_EZADMIN_SESSION_KEY) or "").strip()
        if not phpsessid:
            return {"ok": False, "need_session": True}

        today = datetime.now(_KST).strftime("%Y-%m-%d")
        nd = str(int(datetime.now().timestamp() * 1000))
        par = (
            "auto_search=&search_all_product=&multi_supply_group=&multi_supply=&str_supply_code=0"
            "&tags_string=&product_tag_include_type=1&query_type=name&query_str="
            "&stock_type=0&stock_start=&stock_end=&notrans_day=&notrans_cnt=&notrans_status=0&stock_status=0"
            f"&start_date={today}&start_hour=00%3A00%3A00&end_date={today}&end_hour=23%3A59%3A59"
            "&date_period_sel=1&work_type=trans&work_start=1&work_end=&inout_type=0&product_date="
            f"&start_date2={today}&end_date2={today}&date_period_sel2=1"
            "&products_sort=1&category=0&except_soldout=0&temp_soldout=0&location=0"
        )

        try:
            async with httpx.AsyncClient(timeout=30.0, verify=False, follow_redirects=True) as client:
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
            raise HTTPException(status_code=502, detail=f"이지어드민 연결 실패: {exc}")

        body = (r.text or "").strip()
        if _looks_like_ez_session_error(r, body):
            return {"ok": False, "need_session": True}
        try:
            obj = r.json()
        except Exception:
            return {"ok": False, "need_session": True}
        if not isinstance(obj, dict) or "rows" not in obj:
            return {"ok": False, "unexpected_response": True, "raw": obj}

        found_codes: set[str] = set()
        for row in obj.get("rows", []):
            cell = row.get("cell") or {}
            raw_code = cell.get("key") or cell.get("product_id") or cell.get("code") or ""
            code = normalize_code(raw_code) or str(raw_code).strip()
            if code:
                found_codes.add(code)

        missing_codes = sorted(code for code in incoming_counts if code not in found_codes)

        info_map: dict[str, dict] = {}
        if missing_codes:
            s_code_map = {_to_s_code(code): code for code in missing_codes}
            conn = _get_wonbe_db()
            try:
                placeholders = ",".join(["?"] * len(s_code_map))
                rows = conn.execute(
                    f"SELECT 상품코드, 상품명, 색상, 사이즈 FROM wonbe WHERE 상품코드 IN ({placeholders})",
                    list(s_code_map.keys()),
                ).fetchall()
                info_map = {
                    s_code_map[row["상품코드"]]: dict(row)
                    for row in rows
                    if row["상품코드"] in s_code_map
                }
            finally:
                conn.close()

        missing = [
            {
                "code": code,
                "incomingQty": incoming_counts.get(code, 0),
                "productName": info_map.get(code, {}).get("상품명", ""),
                "color": info_map.get(code, {}).get("색상", ""),
                "size": info_map.get(code, {}).get("사이즈", ""),
            }
            for code in missing_codes
        ]

        return {
            "ok": True,
            "date": today,
            "total_rows": len(obj.get("rows", [])),
            "incoming_codes": len(incoming_counts),
            "missing": missing,
        }

    @router.post("/barcode/incoming/verify-order-history")
    async def barcode_incoming_verify_order_history(user: str = Depends(get_current_user)):
        """바코드탭에서 불러온 입고 파일의 상품코드를, DB관리 > 발주내역의 전날(어제) 등록분과
        대조해 전날 발주내역에 없는 상품코드만 골라낸다 - verify_trans_in과 같은 패턴이지만
        비교 대상이 이지어드민 I100이 아니라 우리 쪽 order_history 테이블.

        incoming_counts의 키는 normalize_code가 만든 "YUSAS00000" 형식인데,
        order_history.product_code/wonbe.상품코드는 top90 발주 형식 그대로인 "S00000"
        형식이라 형식이 다르다 - _to_s_code로 맞춰서 비교해야 한다(안 그러면 형식이
        달라서 전부 미확인으로 잘못 뜬다)."""
        incoming_counts = get_shared_incoming_counts() or {}
        if not incoming_counts:
            return {"ok": False, "detail": "불러온 입고 파일이 없습니다. 바코드 탭에서 입고 파일을 먼저 불러오세요."}

        yesterday = (datetime.now(_KST) - timedelta(days=1)).strftime("%Y-%m-%d")

        init_order_history_table(get_db)
        conn = get_db()
        try:
            rows = conn.execute(
                "SELECT DISTINCT product_code FROM order_history "
                "WHERE recorded_at >= ? AND recorded_at <= ? AND product_code != ''",
                (f"{yesterday} 00:00:00", f"{yesterday} 23:59:59"),
            ).fetchall()
        finally:
            conn.close()
        ordered_codes = {row["product_code"] for row in rows}

        # S코드 기준으로 비교/표시한다 - 여러 YUSAS코드가 같은 S코드로 겹치면 수량은 합산.
        s_incoming_counts: dict[str, int] = {}
        for code, qty in incoming_counts.items():
            s_incoming_counts[_to_s_code(code)] = s_incoming_counts.get(_to_s_code(code), 0) + int(qty or 0)

        candidate_codes = sorted(s_code for s_code in s_incoming_counts if s_code not in ordered_codes)

        info_map: dict[str, dict] = {}
        if candidate_codes:
            wonbe_conn = _get_wonbe_db()
            try:
                placeholders = ",".join(["?"] * len(candidate_codes))
                wrows = wonbe_conn.execute(
                    f"SELECT 상품코드, 상품명, 색상, 사이즈, 거래처 FROM wonbe WHERE 상품코드 IN ({placeholders})",
                    candidate_codes,
                ).fetchall()
                info_map = {row["상품코드"]: dict(row) for row in wrows}
            finally:
                wonbe_conn.close()

        # 케이디지/리자드스탠다드/리마인드/계란속노른자/도매킴 거래처 상품은 조회 대상에서 제외.
        missing_codes = [
            s_code for s_code in candidate_codes
            if info_map.get(s_code, {}).get("거래처", "") not in _INCOMING_VERIFY_EXCLUDED_CLIENTS
        ]

        missing = [
            {
                "code": s_code,
                "incomingQty": s_incoming_counts.get(s_code, 0),
                "productName": info_map.get(s_code, {}).get("상품명", ""),
                "color": info_map.get(s_code, {}).get("색상", ""),
                "size": info_map.get(s_code, {}).get("사이즈", ""),
            }
            for s_code in missing_codes
        ]

        return {
            "ok": True,
            "date": yesterday,
            "incoming_codes": len(incoming_counts),
            "missing": missing,
        }

    return router
