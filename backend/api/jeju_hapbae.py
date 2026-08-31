import asyncio
import io
import json
import os
import re
import sqlite3
import tempfile
import uuid
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from urllib.parse import quote

import httpx
import pandas as pd
import xlwt
from fastapi import APIRouter, Body, File, Form, HTTPException, UploadFile
from fastapi.responses import Response

from api.amood_hapbae import (
    _ah_load_base_cost_map,
    _ah_normalize,
    _content_disposition,
)
from api.wonbe_routes import WONBE_DB_PATH
from services.pastelco_utils import pastelco_login

_ABLY_ORDER_ITEMS_URL = "https://api.a-bly.com/seller/order_items/"
_ABLY_ORDER_DETAIL_URL = "https://api.a-bly.com/seller/orders"
_EZADMIN_BASE = "https://ga80.ezadmin.co.kr"
_EZADMIN_SESSION_KEY = "ezadmin_phpsessid"
_JEJU_ABLY_PREVIEW_KEY = "jeju_hapbae_ably_preview"
_DB_PATH = Path(os.environ.get("APP_DB_PATH") or Path(__file__).resolve().parent.parent / "app.db")


_jeju_ezadmin_log: list[dict] = []

_JEJU_LAST_FILE_DIR = Path(os.environ.get("JEJU_HAPBAE_LAST_FILE_DIR") or Path(__file__).resolve().parent.parent / "uploads" / "jeju_hapbae")
_JEJU_LAST_FILE_PATH = _JEJU_LAST_FILE_DIR / "last_upload.xlsx"
_JEJU_LAST_META_PATH = _JEJU_LAST_FILE_DIR / "last_upload_meta.json"


def _jeju_save_last_file(data: bytes, filename: str) -> None:
    _JEJU_LAST_FILE_DIR.mkdir(parents=True, exist_ok=True)
    _JEJU_LAST_FILE_PATH.write_bytes(data)
    _JEJU_LAST_META_PATH.write_text(
        json.dumps({"filename": filename, "uploaded_at": datetime.now().isoformat()}, ensure_ascii=False),
        encoding="utf-8",
    )


def _jeju_load_last_file() -> tuple[bytes | None, str | None]:
    if not _JEJU_LAST_FILE_PATH.exists() or not _JEJU_LAST_META_PATH.exists():
        return None, None
    try:
        meta = json.loads(_JEJU_LAST_META_PATH.read_text(encoding="utf-8"))
        return _JEJU_LAST_FILE_PATH.read_bytes(), meta.get("filename")
    except Exception:
        return None, None


def _get_ezadmin_phpsessid() -> str:
    try:
        conn = sqlite3.connect(str(_DB_PATH))
        row = conn.execute("SELECT value FROM app_settings WHERE key = ?", (_EZADMIN_SESSION_KEY,)).fetchone()
        conn.close()
        return (row[0] if row else "") or ""
    except Exception:
        return ""


def _jeju_get_setting(key: str) -> str | None:
    try:
        conn = sqlite3.connect(str(_DB_PATH))
        row = conn.execute("SELECT value FROM app_settings WHERE key = ?", (key,)).fetchone()
        conn.close()
        return row[0] if row else None
    except Exception:
        return None


def _jeju_set_setting(key: str, value: str | None):
    conn = sqlite3.connect(str(_DB_PATH))
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS app_settings (
                key TEXT PRIMARY KEY,
                value TEXT
            )
            """
        )
        if value is None:
            conn.execute("DELETE FROM app_settings WHERE key = ?", (key,))
        else:
            conn.execute(
                "INSERT INTO app_settings (key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, value),
            )
        conn.commit()
    finally:
        conn.close()


def _jeju_saved_ably_preview_payload() -> dict:
    raw = _jeju_get_setting(_JEJU_ABLY_PREVIEW_KEY)
    if not raw:
        return {"ok": True, "has_data": False}
    try:
        payload = json.loads(raw)
    except Exception:
        return {"ok": True, "has_data": False}
    if not isinstance(payload, dict):
        return {"ok": True, "has_data": False}
    return {"ok": True, "has_data": True, **payload}

router = APIRouter()

JEJU_ALLOWED_EXCEL = {".xlsx", ".xlsm", ".xls"}
_BRACKET_PREFIX_RE = re.compile(r"^\s*(?:\[[^\]]*\]\s*)+")
_PAREN_RE = re.compile(r"\([^)]*\)")
_MULTISPACE_RE = re.compile(r"\s+")


def _jeju_normalize(value) -> str:
    if value is None:
        return ""
    try:
        if pd.isna(value):
            return ""
    except (TypeError, ValueError):
        pass
    text = str(value).strip()
    if not text or text.lower() == "nan":
        return ""
    return text


def _jeju_clean_product_name(value) -> str:
    text = _jeju_normalize(value)
    if not text:
        return ""
    text = _BRACKET_PREFIX_RE.sub("", text)
    text = _PAREN_RE.sub(" ", text)
    text = _MULTISPACE_RE.sub(" ", text).strip()
    return text


def _jeju_clean_option(value) -> str:
    text = _jeju_normalize(value)
    if not text:
        return ""
    text = text.replace("/", " ")
    text = _MULTISPACE_RE.sub(" ", text).strip()
    return text


def _jeju_combine(name: str, option: str) -> str:
    return " ".join(part for part in [name.strip(), option.strip()] if part).strip()


def _jeju_parse_qty(value) -> float:
    text = _jeju_normalize(value)
    if not text:
        return 1.0
    compact = text.replace(",", "")
    try:
        return float(compact)
    except Exception:
        return 1.0


def _jeju_display_qty(value) -> object:
    qty = _jeju_parse_qty(value)
    return int(qty) if float(qty).is_integer() else qty


def _jeju_process(path: Path) -> list[tuple[str, str]]:
    ext = path.suffix.lower()
    try:
        if ext == ".xls":
            df = pd.read_excel(path, sheet_name=1, header=None, dtype=object, engine="xlrd")
        else:
            df = pd.read_excel(path, sheet_name=1, header=None, dtype=object, engine="openpyxl")
    except Exception as e:
        raise ValueError(f"2번택 시트를 읽을 수 없습니다: {e}")

    required_cols = [2, 6, 8, 9, 16]
    if df.shape[1] <= max(required_cols):
        raise ValueError(
            f"입력 파일에 C(3), G(7), I(9), J(10), Q(17)열이 모두 있어야 합니다. "
            f"(현재 열 수: {df.shape[1]})"
        )

    c_vals = df.iloc[:, 2].map(_jeju_normalize)
    q_vals = df.iloc[:, 16].map(_jeju_normalize)
    duplicate_mask = c_vals.ne("") & c_vals.duplicated(keep=False)
    jeju_mask = q_vals.str.contains("제주", na=False)
    filtered = df.loc[duplicate_mask & jeju_mask].copy()

    if filtered.empty:
        return []

    rows: list[tuple[str, str]] = []
    for _, row in filtered.iterrows():
        g_clean = _jeju_clean_product_name(row.iloc[6])
        i_clean = _jeju_clean_option(row.iloc[8])
        product_name = _jeju_combine(g_clean, i_clean)
        qty = _jeju_normalize(row.iloc[9])
        if product_name:
            rows.append((product_name, qty))

    return rows


def _jeju_merge_rows(
    rows: list[tuple[str, str]],
    cost_map: dict,
) -> list[tuple[str, object, object]]:
    merged_rows: list[tuple[str, object, object]] = []
    code_totals: dict[str, float] = defaultdict(float)
    code_first_index: dict[str, int] = {}

    for product_name, raw_qty in rows:
        product_code = cost_map.get(product_name.casefold(), "")
        code_key = _ah_normalize(product_code)

        if not code_key:
            merged_rows.append((product_name, _jeju_display_qty(raw_qty), product_code))
            continue

        code_totals[code_key] += _jeju_parse_qty(raw_qty)
        if code_key not in code_first_index:
            code_first_index[code_key] = len(merged_rows)
            merged_rows.append((product_name, 0, product_code))

        row_index = code_first_index[code_key]
        first_name, _, first_code = merged_rows[row_index]
        total = code_totals[code_key]
        merged_qty: object = int(total) if float(total).is_integer() else total
        merged_rows[row_index] = (first_name, merged_qty, first_code)

    return merged_rows


def _jeju_build_xls(
    rows: list[tuple[str, str]],
    cost_map: dict,
    headers: list[str],
    include_cols: list[int],
) -> bytes:
    book = xlwt.Workbook()
    sheet = book.add_sheet("결과")
    merged_rows = _jeju_merge_rows(rows, cost_map)

    selected_headers = [headers[idx - 1] for idx in include_cols]
    for idx, header in enumerate(selected_headers):
        sheet.write(0, idx, header)
    sheet.write(0, len(selected_headers), "메모")

    for row_idx, (product_name, qty, product_code) in enumerate(merged_rows, start=1):
        selected_values: list[object] = []
        for col_no in include_cols:
            if col_no == 1:
                selected_values.append(product_name)
            elif col_no == 2:
                selected_values.append(product_code)
            elif col_no == 3:
                selected_values.append(qty)
        for col_idx, cell_value in enumerate(selected_values):
            sheet.write(row_idx, col_idx, cell_value)
        sheet.write(row_idx, len(selected_values), "제주도합배")

    buf = io.BytesIO()
    book.save(buf)
    return buf.getvalue()


def _jeju_build_preview_rows(
    rows: list[tuple[str, str]],
    cost_map: dict,
    headers: list[str],
    include_cols: list[int],
) -> tuple[list[str], list[list[object]]]:
    merged_rows = _jeju_merge_rows(rows, cost_map)
    columns = [headers[idx - 1] for idx in include_cols] + ["메모"]
    preview_rows: list[list[object]] = []
    for product_name, qty, product_code in merged_rows:
        values: list[object] = []
        for col_no in include_cols:
            if col_no == 1:
                values.append(product_name)
            elif col_no == 2:
                values.append(product_code)
            elif col_no == 3:
                values.append(qty)
        values.append("제주도합배")
        preview_rows.append(values)
    return columns, preview_rows


def _jeju_find_unmatched(rows: list[tuple[str, str]], cost_map: dict) -> list[str]:
    seen: set[str] = set()
    unmatched: list[str] = []
    for product_name, _ in rows:
        key = product_name.casefold()
        if cost_map.get(key, "") == "" and key not in seen:
            seen.add(key)
            unmatched.append(product_name)
    return unmatched


@router.post("/jeju-hapbae/unmatched")
async def jeju_hapbae_unmatched(file: UploadFile = File(...)):
    name = file.filename or "jeju_hapbae.xlsx"
    ext = Path(name).suffix.lower()
    if ext not in JEJU_ALLOWED_EXCEL:
        raise HTTPException(status_code=400, detail="xlsx / xlsm / xls 파일만 업로드 가능합니다.")

    tmp_path = Path(tempfile.gettempdir()) / f"jeju_hapbae_unmatched_{uuid.uuid4().hex}{ext}"
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="업로드 파일이 비어 있습니다.")
    tmp_path.write_bytes(data)

    try:
        rows = _jeju_process(tmp_path)
        cost_map: dict = {}
        if WONBE_DB_PATH.exists():
            try:
                cost_map = _ah_load_base_cost_map()
            except Exception:
                cost_map = {}
        unmatched = _jeju_find_unmatched(rows, cost_map)
        return {"ok": True, "unmatched": unmatched, "cost_base_exists": WONBE_DB_PATH.exists()}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
    finally:
        try:
            tmp_path.unlink(missing_ok=True)
        except Exception:
            pass


@router.post("/jeju-hapbae/export")
async def jeju_hapbae_export(
    file: UploadFile = File(...),
    header_col1: str = Form("상품명"),
    header_col2: str = Form("상품코드"),
    header_col3: str = Form("수량"),
    include_col1: bool = Form(True),
    include_col2: bool = Form(True),
    include_col3: bool = Form(True),
):
    name = file.filename or "jeju_hapbae.xlsx"
    ext = Path(name).suffix.lower()
    if ext not in JEJU_ALLOWED_EXCEL:
        raise HTTPException(status_code=400, detail="xlsx / xlsm / xls 파일만 업로드 가능합니다.")

    include_cols: list[int] = []
    if include_col1:
        include_cols.append(1)
    if include_col2:
        include_cols.append(2)
    if include_col3:
        include_cols.append(3)
    if not include_cols:
        raise HTTPException(status_code=400, detail="다운로드할 열을 최소 1개 선택하세요.")

    tmp_path = Path(tempfile.gettempdir()) / f"jeju_hapbae_{uuid.uuid4().hex}{ext}"
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="업로드 파일이 비어 있습니다.")
    tmp_path.write_bytes(data)

    try:
        rows = _jeju_process(tmp_path)
        if not rows:
            raise HTTPException(status_code=400, detail="C열 중복이면서 Q열에 '제주'가 포함된 데이터가 없어 가공할 항목이 없습니다.")

        cost_map: dict = {}
        if WONBE_DB_PATH.exists():
            try:
                cost_map = _ah_load_base_cost_map()
            except Exception:
                cost_map = {}

        col_headers = [
            header_col1 or "상품명",
            header_col2 or "상품코드",
            header_col3 or "수량",
        ]
        content = _jeju_build_xls(rows, cost_map, col_headers, include_cols)
        filename = f"{Path(name).stem}_가공본.xls"
        return Response(
            content=content,
            media_type="application/vnd.ms-excel",
            headers={"Content-Disposition": _content_disposition(filename)},
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
    finally:
        try:
            tmp_path.unlink(missing_ok=True)
        except Exception:
            pass


async def _jeju_fetch_all_ably_items(token: str) -> tuple[list, dict]:
    headers = {
        "Authorization": f"JWT {token}",
        "Accept": "application/json",
        "Origin": "https://my.a-bly.com",
        "Referer": "https://my.a-bly.com/",
        "User-Agent": "Mozilla/5.0",
    }
    all_items: list = []
    page = 1
    per_page = 100
    prev_first_sno = None
    async with httpx.AsyncClient(timeout=30.0) as client:
        while True:
            res = await client.get(
                _ABLY_ORDER_ITEMS_URL,
                headers=headers,
                params={
                    "processing_status[]": 2,
                    "processing_sub_status[]": 0,
                    "order": "-checked_at",
                    "delivery_type[]": ["standard", "today", "combine", "reserved"],
                    "per_page": per_page,
                    "page": page,
                },
            )
            if res.status_code != 200:
                raise RuntimeError(f"에이블리 {page}페이지 조회 실패 (HTTP {res.status_code})")
            try:
                data = res.json()
            except Exception as e:
                raise RuntimeError(f"에이블리 {page}페이지 응답 파싱 실패: {e}")
            items = data.get("order_items", [])
            if not items:
                break
            # 이 API는 마지막 페이지를 넘어가도 빈 배열이 아니라 마지막 페이지를
            # 그대로 반복 응답한다 (실제 캡처로 확인). 응답에 신뢰 가능한
            # 총 페이지 수 필드도 없으므로, 이전 페이지와 첫 항목 sno가 같으면
            # 반복 응답으로 보고 중복 추가 없이 종료한다.
            first_sno = items[0].get("sno")
            if prev_first_sno is not None and first_sno == prev_first_sno:
                break
            all_items.extend(items)
            prev_first_sno = first_sno
            if len(items) < per_page:
                break
            page += 1
    return all_items, {
        "pages": page,
        "total_items": len(all_items),
    }


async def _jeju_fetch_duplicate_order_addrs(token: str, order_snos: list[str]) -> dict[str, str]:
    """중복 주문(합배송 후보) order_sno들의 배송지 주소를 상세 API로 조회.

    /seller/order_items/ 목록 응답에는 receiver_addr 필드가 아예 없어서
    (실제 캡처로 확인), 제주 여부 판별을 위해 /seller/orders/{sno}/items/
    상세 API를 대상 주문에 한해서만 추가 조회한다.
    """
    if not order_snos:
        return {}
    headers = {
        "Authorization": f"JWT {token}",
        "Accept": "application/json",
        "Origin": "https://my.a-bly.com",
        "Referer": "https://my.a-bly.com/",
        "User-Agent": "Mozilla/5.0",
    }
    addrs: dict[str, str] = {}
    sem = asyncio.Semaphore(8)

    async def fetch_one(client: httpx.AsyncClient, sno: str):
        async with sem:
            try:
                res = await client.get(
                    f"{_ABLY_ORDER_DETAIL_URL}/{sno}/items/",
                    headers=headers,
                    params={"processing_status[]": [1, 2], "processing_sub_status[]": 0},
                )
                if res.status_code != 200:
                    return
                data = res.json()
            except Exception:
                return
            for it in data.get("order_items") or []:
                addr = it.get("receiver_addr")
                if addr:
                    addrs[sno] = str(addr)
                    return

    async with httpx.AsyncClient(timeout=30.0) as client:
        await asyncio.gather(*(fetch_one(client, sno) for sno in order_snos))
    return addrs


async def _jeju_process_from_ably(token: str, items: list) -> tuple[list[tuple[str, str]], dict]:
    order_counts: dict[str, int] = defaultdict(int)
    for item in items:
        sno = str(item.get("order_sno") or "").strip()
        if sno:
            order_counts[sno] += 1

    duplicate_snos = [sno for sno, count in order_counts.items() if count >= 2]
    addr_map = await _jeju_fetch_duplicate_order_addrs(token, duplicate_snos)

    rows: list[tuple[str, str]] = []
    selected_order_snos: set[str] = set()
    duplicate_item_count = 0
    for item in items:
        sno = str(item.get("order_sno") or "").strip()
        is_duplicate_order = order_counts.get(sno, 0) >= 2
        if is_duplicate_order:
            duplicate_item_count += 1
        addr = addr_map.get(sno, "")
        if not is_duplicate_order or "제주" not in addr:
            continue
        g_clean = _jeju_clean_product_name(item.get("goods_name") or "")
        i_clean = _jeju_clean_option(item.get("option_info") or "")
        product_name = _jeju_combine(g_clean, i_clean)
        qty = str(item.get("ea") or 1)
        if product_name:
            rows.append((product_name, qty))
            if sno:
                selected_order_snos.add(sno)

    stats = {
        "duplicate_order_count": len(duplicate_snos),
        "duplicate_item_count": duplicate_item_count,
        "jeju_duplicate_order_count": len(selected_order_snos),
        "jeju_duplicate_item_count": len(rows),
        "jeju_duplicate_qty_total": sum(_jeju_parse_qty(qty) for _, qty in rows),
    }
    return rows, stats


@router.post("/jeju-hapbae/export-from-ably")
async def jeju_hapbae_export_from_ably(payload: dict = Body(default={})):
    header_col1 = str(payload.get("header_col1") or "상품명")
    header_col2 = str(payload.get("header_col2") or "상품코드")
    header_col3 = str(payload.get("header_col3") or "수량")
    include_col1 = bool(payload.get("include_col1", True))
    include_col2 = bool(payload.get("include_col2", True))
    include_col3 = bool(payload.get("include_col3", True))
    preview_only = bool(payload.get("preview_only", False))

    include_cols: list[int] = []
    if include_col1:
        include_cols.append(1)
    if include_col2:
        include_cols.append(2)
    if include_col3:
        include_cols.append(3)
    if not include_cols:
        raise HTTPException(status_code=400, detail="다운로드할 열을 최소 1개 선택하세요.")

    try:
        token = await pastelco_login()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"에이블리 로그인 실패: {e}")

    try:
        items, fetch_stats = await _jeju_fetch_all_ably_items(token)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"에이블리 주문 조회 실패: {e}")

    rows, process_stats = await _jeju_process_from_ably(token, items)
    if not rows:
        raise HTTPException(status_code=400, detail="합배송 건 중 제주 주소가 없습니다.")

    cost_map: dict = {}
    if WONBE_DB_PATH.exists():
        try:
            cost_map = _ah_load_base_cost_map()
        except Exception:
            cost_map = {}

    col_headers = [header_col1, header_col2, header_col3]
    unmatched = _jeju_find_unmatched(rows, cost_map)

    if preview_only:
        columns, preview_rows = _jeju_build_preview_rows(rows, cost_map, col_headers, include_cols)
        stats = {
            **fetch_stats,
            **process_stats,
            "merged_row_count": len(preview_rows),
        }
        source_rows = [{"product_name": name, "qty": qty} for name, qty in rows]
        result = {
            "ok": True,
            "columns": columns,
            "rows": preview_rows,
            "source_rows": source_rows,
            "count": len(preview_rows),
            "unmatched": unmatched,
            "unmatched_count": len(unmatched),
            "stats": stats,
            "saved_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        }
        _jeju_set_setting(_JEJU_ABLY_PREVIEW_KEY, json.dumps(result, ensure_ascii=False))
        return result

    content = _jeju_build_xls(rows, cost_map, col_headers, include_cols)

    return Response(
        content=content,
        media_type="application/vnd.ms-excel",
        headers={
            "Content-Disposition": _content_disposition("제주합배_에이블리.xls"),
            "X-Unmatched-Count": str(len(unmatched)),
            "X-Unmatched-Products": quote(json.dumps(unmatched, ensure_ascii=False)),
        },
    )


@router.get("/jeju-hapbae/ezadmin-log")
def jeju_ezadmin_log():
    return {"log": list(reversed(_jeju_ezadmin_log))}


@router.get("/jeju-hapbae/ably-preview")
def jeju_hapbae_ably_preview():
    return _jeju_saved_ably_preview_payload()


def _jeju_build_ezadmin_xls(rows: list[tuple[str, str]], cost_map: dict) -> bytes:
    merged = _jeju_merge_rows(rows, cost_map)
    book = xlwt.Workbook()
    sheet = book.add_sheet("작업")
    sheet.write(0, 0, "상품코드")
    sheet.write(0, 1, "작업수량")
    sheet.write(0, 2, "메모")
    row_idx = 1
    for _, qty, product_code in merged:
        if not _ah_normalize(str(product_code or "")):
            continue
        sheet.write(row_idx, 0, str(product_code))
        sheet.write(row_idx, 1, qty if isinstance(qty, (int, float)) else _jeju_parse_qty(str(qty)))
        sheet.write(row_idx, 2, "제주도합배")
        row_idx += 1
    buf = io.BytesIO()
    book.save(buf)
    return buf.getvalue()


async def _jeju_send_to_ezadmin_impl(xls_bytes: bytes, direction: str, phpsessid: str) -> dict:
    cookies = {"PHPSESSID": phpsessid}
    ez_headers = {
        "User-Agent": "Mozilla/5.0",
        "Referer": f"{_EZADMIN_BASE}/template40.htm?template=I210",
        "X-Requested-With": "XMLHttpRequest",
    }
    base_url = f"{_EZADMIN_BASE}/function.htm"
    ts_ms = str(int(datetime.now().timestamp() * 1000))

    async with httpx.AsyncClient(timeout=120.0, verify=False, follow_redirects=True) as client:
        # 템플릿 페이지 먼저 방문 — EZAdmin 서버 사이드 세션 변수 초기화
        await client.get(
            f"{_EZADMIN_BASE}/template40.htm",
            params={"template": "I210"},
            cookies=cookies,
            headers={"User-Agent": "Mozilla/5.0"},
        )

        upload_r = await client.post(
            base_url,
            data={"template": "I200", "action": "upload_new"},
            files={"_file": (f"jeju_hapbae_{ts_ms}.xls", xls_bytes, "application/vnd.ms-excel")},
            cookies=cookies,
            headers=ez_headers,
        )
        if upload_r.status_code >= 400:
            return {"ok": False, "error": f"업로드 실패 (HTTP {upload_r.status_code})"}

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

        time_flag = datetime.now().strftime("%a %b %d %Y %H:%M:%S GMT+0900 (한국 표준시)")
        apply_r = await client.post(
            base_url,
            data={
                "template": "I200", "action": "apply_new",
                "bad": "0", "type": direction,
                "move_warehouse": "0", "save_stock": "0",
                "stock_tag": "", "timeFlag": time_flag,
            },
            cookies=cookies,
            headers=ez_headers,
        )
        try:
            apply_r.json()
        except Exception:
            label = "출고" if direction == "out" else "입고"
            return {"ok": False, "error": f"{label}처리 응답 파싱 실패"}

    return {"ok": True}


async def _jeju_send_rows_to_ezadmin(rows: list[tuple[str, str]], direction: str, phpsessid: str) -> dict:
    if direction not in ("out", "in"):
        raise HTTPException(status_code=400, detail="direction은 out 또는 in만 가능합니다.")
    if not rows:
        raise HTTPException(status_code=400, detail="처리할 제주합배 데이터가 없습니다.")

    cost_map: dict = {}
    if WONBE_DB_PATH.exists():
        try:
            cost_map = _ah_load_base_cost_map()
        except Exception:
            pass

    xls_bytes = _jeju_build_ezadmin_xls(rows, cost_map)
    result = await _jeju_send_to_ezadmin_impl(xls_bytes, direction, phpsessid)
    count = sum(1 for _, _, code in _jeju_merge_rows(rows, cost_map) if _ah_normalize(str(code or "")))
    if result.get("ok"):
        result["count"] = count

    label = "출고" if direction == "out" else "입고"
    _jeju_ezadmin_log.append({
        "time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "label": label,
        "ok": bool(result.get("ok")),
        "count": count if result.get("ok") else 0,
        "error": result.get("error") or "",
    })
    return result


@router.get("/jeju-hapbae/last-file/info")
def jeju_last_file_info():
    if not _JEJU_LAST_META_PATH.exists():
        return {"ok": True, "file": None}
    try:
        meta = json.loads(_JEJU_LAST_META_PATH.read_text(encoding="utf-8"))
        return {"ok": True, "file": meta}
    except Exception:
        return {"ok": True, "file": None}


@router.post("/jeju-hapbae/send-to-ezadmin")
async def jeju_send_to_ezadmin(
    file: UploadFile | None = File(None),
    direction: str = Form("out"),
):
    phpsessid = _get_ezadmin_phpsessid()
    if not phpsessid:
        return {"ok": False, "need_session": True}

    if file is not None:
        name = file.filename or "jeju.xlsx"
        ext = Path(name).suffix.lower()
        if ext not in JEJU_ALLOWED_EXCEL:
            raise HTTPException(status_code=400, detail="xlsx / xlsm / xls 파일만 가능합니다.")
        data = await file.read()
        if not data:
            raise HTTPException(status_code=400, detail="파일이 비어 있습니다.")
        _jeju_save_last_file(data, name)
    else:
        data, saved_name = _jeju_load_last_file()
        if data is None:
            raise HTTPException(status_code=400, detail="파일을 선택하거나 이전에 업로드된 파일이 있어야 합니다.")
        name = saved_name or "jeju.xlsx"
        ext = Path(name).suffix.lower()

    tmp_path = Path(tempfile.gettempdir()) / f"jeju_ez_{uuid.uuid4().hex}{ext}"
    tmp_path.write_bytes(data)

    try:
        rows = _jeju_process(tmp_path)
        return await _jeju_send_rows_to_ezadmin(rows, direction, phpsessid)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
    finally:
        try:
            tmp_path.unlink(missing_ok=True)
        except Exception:
            pass


@router.post("/jeju-hapbae/send-preview-to-ezadmin")
async def jeju_send_preview_to_ezadmin(payload: dict = Body(default={})):
    phpsessid = _get_ezadmin_phpsessid()
    if not phpsessid:
        return {"ok": False, "need_session": True}

    direction = str(payload.get("direction") or "out").strip()
    source_rows = payload.get("rows") or []
    if not source_rows:
        saved = _jeju_saved_ably_preview_payload()
        source_rows = saved.get("source_rows") or []
    rows: list[tuple[str, str]] = []
    if not isinstance(source_rows, list):
        raise HTTPException(status_code=400, detail="rows 형식이 올바르지 않습니다.")

    for item in source_rows:
        if isinstance(item, dict):
            product_name = _ah_normalize(item.get("product_name") or item.get("name") or "")
            qty = _ah_normalize(item.get("qty") or item.get("quantity") or "")
        elif isinstance(item, (list, tuple)) and len(item) >= 2:
            product_name = _ah_normalize(item[0])
            qty = _ah_normalize(item[1])
        else:
            continue
        if product_name:
            rows.append((product_name, qty or "1"))

    try:
        return await _jeju_send_rows_to_ezadmin(rows, direction, phpsessid)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


