from collections import defaultdict
from datetime import datetime
from pathlib import Path
import io
import os
import re
import shutil
import tempfile
import uuid

import openpyxl
import pandas as pd
import urllib.parse
import xlwt
from fastapi import APIRouter, Body, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response

router = APIRouter()

AMOOD_HAPBAE_ALLOWED_EXCEL = {".xlsx", ".xlsm"}
AMOOD_HAPBAE_ALLOWED_COST_BASE = {".xlsx", ".xls", ".xlsm"}
AMOOD_HAPBAE_COST_BASE_PATH = Path(
    os.environ.get("AMOOD_HAPBAE_COST_BASE_PATH", r"C:\Users\ksh29\OneDrive\Desktop\원베\원가베이스유.xlsx")
)
AMOOD_HAPBAE_COST_BASE_CACHE: dict[str, object] = {"df": None, "mtime": None, "path": None}


def _content_disposition(filename: str) -> str:
    safe_name = (filename or "download").replace('"', "")
    ascii_name = "".join(ch if ord(ch) < 128 else "_" for ch in safe_name)
    ascii_name = re.sub(r"_+", "_", ascii_name).strip("_")
    if not ascii_name:
        ascii_name = "download"
    quoted = urllib.parse.quote(safe_name)
    return f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quoted}"


def _ah_normalize(v) -> str:
    if v is None:
        return ""
    if isinstance(v, str):
        return v.strip()
    return str(v).strip()


def _ah_normalize_match_key(v) -> str:
    return _ah_normalize(v).casefold()


def _ah_remove_leading_bracket_tag(text: str) -> str:
    s = _ah_normalize(text)
    if not s:
        return ""

    lead_patterns = [
        r"^\[[^\]]*\]\s*",
        r"^\([^\)]*\)\s*",
        r"^\{[^}]*\}\s*",
    ]
    tail_patterns = [
        r"\s*\[[^\]]*\]$",
        r"\s*\([^\)]*\)$",
        r"\s*\{[^}]*\}$",
    ]

    changed = True
    while changed:
        changed = False
        for pat in lead_patterns:
            new_s = re.sub(pat, "", s)
            if new_s != s:
                s = new_s.strip()
                changed = True

        for pat in tail_patterns:
            new_s = re.sub(pat, "", s)
            if new_s != s:
                s = new_s.strip()
                changed = True

    return s.strip()


def _ah_merge_j_by_slash(text: str) -> str:
    s = _ah_normalize(text)
    if not s:
        return ""
    parts = [p.strip() for p in s.split("/") if p.strip() != ""]
    parts = ["".join(p.split()) for p in parts]
    return " ".join(parts).strip()


def _ah_get_second_sheet(path: Path):
    wb = openpyxl.load_workbook(path, data_only=True)
    if len(wb.worksheets) < 2:
        raise ValueError("엑셀에 두 번째 시트가 없습니다.")
    return wb.worksheets[1]


def _ah_find_conflicts_xlsx(path: Path, skip_header: bool = True):
    ws = _ah_get_second_sheet(path)
    start_row = 2 if skip_header else 1
    c_to_dset: dict[str, set[str]] = defaultdict(set)
    for r in range(start_row, ws.max_row + 1):
        c_val = _ah_normalize(ws.cell(row=r, column=3).value)
        d_val = _ah_normalize(ws.cell(row=r, column=4).value)
        if c_val == "":
            continue
        c_to_dset[c_val].add(d_val)

    conflicts: list[tuple[str, set[str]]] = []
    for c_val, d_set in c_to_dset.items():
        if len(d_set) >= 2:
            conflicts.append((c_val, d_set))
    conflicts.sort(key=lambda x: str(x[0]))
    return ws.title, conflicts


def _ah_build_output_rows_from_hj(path: Path, skip_header: bool = True):
    ws = _ah_get_second_sheet(path)
    start_row = 2 if skip_header else 1
    c_counts = defaultdict(int)
    for r in range(start_row, ws.max_row + 1):
        c_val = _ah_normalize(ws.cell(row=r, column=3).value)
        if c_val != "":
            c_counts[c_val] += 1

    out: list[tuple[str, object]] = []
    for r in range(start_row, ws.max_row + 1):
        c_val = _ah_normalize(ws.cell(row=r, column=3).value)
        if c_val == "" or c_counts.get(c_val, 0) < 2:
            continue

        h_val = _ah_normalize(ws.cell(row=r, column=8).value)
        j_val = _ah_normalize(ws.cell(row=r, column=10).value)
        k_qty = ws.cell(row=r, column=11).value

        if h_val == "" and j_val == "":
            continue

        h_clean = _ah_remove_leading_bracket_tag(h_val)
        j_clean = _ah_merge_j_by_slash(j_val)

        if h_clean and j_clean:
            result = f"{h_clean} {j_clean}"
        elif h_clean:
            result = h_clean
        else:
            result = j_clean

        result = re.sub(r"\s+", " ", result).strip()
        if result:
            out.append((result, k_qty))

    return ws.title, out


def _ah_load_base_cost_map(path: Path):
    wb = openpyxl.load_workbook(path, data_only=True)
    ws = wb.active
    cost_map: dict[str, object] = {}
    for r in range(1, ws.max_row + 1):
        key = _ah_normalize_match_key(ws.cell(row=r, column=1).value)
        val = ws.cell(row=r, column=2).value
        if key == "":
            continue
        if key not in cost_map:
            cost_map[key] = val
    return cost_map


def _ah_read_cost_base_df(path: Path) -> pd.DataFrame:
    ext = path.suffix.lower()
    if ext in (".xlsx", ".xlsm"):
        return pd.read_excel(path, dtype=str, engine="openpyxl")
    if ext == ".xls":
        try:
            return pd.read_excel(path, dtype=str, engine="xlrd")
        except Exception:
            return pd.read_excel(path, dtype=str)
    return pd.read_excel(path, dtype=str)


def _ah_load_cost_base_df():
    path = AMOOD_HAPBAE_COST_BASE_PATH
    if not path.exists():
        raise FileNotFoundError(f"원가베이스 파일을 찾지 못했습니다: {path}")
    mtime = path.stat().st_mtime
    cached_path = AMOOD_HAPBAE_COST_BASE_CACHE.get("path")
    cached_mtime = AMOOD_HAPBAE_COST_BASE_CACHE.get("mtime")
    if AMOOD_HAPBAE_COST_BASE_CACHE.get("df") is not None and cached_path == str(path) and cached_mtime == mtime:
        return AMOOD_HAPBAE_COST_BASE_CACHE["df"]
    df = _ah_read_cost_base_df(path)
    AMOOD_HAPBAE_COST_BASE_CACHE["df"] = df
    AMOOD_HAPBAE_COST_BASE_CACHE["mtime"] = mtime
    AMOOD_HAPBAE_COST_BASE_CACHE["path"] = str(path)
    return df


def _ah_save_cost_base_df(df: pd.DataFrame):
    path = AMOOD_HAPBAE_COST_BASE_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    with pd.ExcelWriter(path, engine="openpyxl") as writer:
        df.to_excel(writer, index=False)
    AMOOD_HAPBAE_COST_BASE_CACHE["df"] = df
    AMOOD_HAPBAE_COST_BASE_CACHE["mtime"] = path.stat().st_mtime
    AMOOD_HAPBAE_COST_BASE_CACHE["path"] = str(path)


def _ah_cost_base_status() -> dict:
    path = AMOOD_HAPBAE_COST_BASE_PATH
    exists = path.exists()
    mtime = None
    if exists:
        try:
            mtime = datetime.fromtimestamp(path.stat().st_mtime).isoformat()
        except Exception:
            mtime = None
    return {"path": str(path), "exists": exists, "mtime": mtime}


def _ah_pick_header(value: str | None, fallback: str) -> str:
    header = _ah_normalize(value)
    return header if header else fallback


def _ah_find_unmatched_products(path: Path, cost_map: dict[str, object], skip_header: bool = True):
    _, rows = _ah_build_output_rows_from_hj(path, skip_header=skip_header)
    unmatched_rows = 0
    unique_unmatched: list[str] = []
    seen: set[str] = set()
    for val, _ in rows:
        key = _ah_normalize_match_key(val)
        if key in cost_map:
            continue
        unmatched_rows += 1
        if key and key not in seen:
            seen.add(key)
            unique_unmatched.append(val)
    return unique_unmatched, unmatched_rows


def _ah_build_xls_bytes(
    rows: list[tuple[str, object]],
    cost_map: dict[str, object],
    headers: list[str],
    include_cols: list[int],
) -> bytes:
    merged_rows: list[tuple[str, object, object]] = []
    code_index: dict[str, int] = {}

    for val, qty in rows:
        product_code = cost_map.get(_ah_normalize_match_key(val), "")
        code_key = _ah_normalize_match_key(product_code)

        if code_key == "":
            merged_rows.append((val, qty, product_code))
            continue

        if code_key not in code_index:
            code_index[code_key] = len(merged_rows)
            merged_rows.append((val, qty, product_code))
            continue

        idx = code_index[code_key]
        prev_val, prev_qty, prev_code = merged_rows[idx]
        try:
            prev_num = float(prev_qty) if prev_qty is not None and str(prev_qty).strip() != "" else 0.0
        except Exception:
            prev_num = 0.0
        try:
            add_num = float(qty) if qty is not None and str(qty).strip() != "" else 0.0
        except Exception:
            add_num = 0.0
        total = prev_num + add_num
        merged_qty: object = int(total) if total.is_integer() else total
        merged_rows[idx] = (prev_val, merged_qty, prev_code)

    book = xlwt.Workbook()
    sheet = book.add_sheet("결과")

    selected_headers = [headers[idx - 1] for idx in include_cols]
    for idx, header in enumerate(selected_headers):
        sheet.write(0, idx, header)

    for i, row_data in enumerate(merged_rows, start=1):
        val, qty, product_code = row_data
        selected_values: list[object] = []
        for col_no in include_cols:
            if col_no == 1:
                selected_values.append(val)
            elif col_no == 2:
                selected_values.append(product_code)
            elif col_no == 3:
                selected_values.append(qty if qty is not None else "")
            elif col_no == 4:
                selected_values.append("아무드합배")
        for j, cell_val in enumerate(selected_values):
            sheet.write(i, j, cell_val)

    buf = io.BytesIO()
    book.save(buf)
    return buf.getvalue()


@router.get("/amood-hapbae/cost-base/status")
def amood_hapbae_cost_base_status():
    return {"ok": True, "status": _ah_cost_base_status()}


@router.post("/amood-hapbae/cost-base/reload")
def amood_hapbae_cost_base_reload():
    try:
        df = _ah_load_cost_base_df()
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"원가베이스 로드 실패: {e}")
    return {"ok": True, "rows": len(df), "status": _ah_cost_base_status()}


@router.post("/amood-hapbae/cost-base/upload")
async def amood_hapbae_cost_base_upload(file: UploadFile = File(...)):
    ext = Path(file.filename or "").suffix.lower()
    if ext not in AMOOD_HAPBAE_ALLOWED_COST_BASE:
        raise HTTPException(status_code=400, detail="xls/xlsx/xlsm만 업로드 가능")

    AMOOD_HAPBAE_COST_BASE_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = Path(tempfile.gettempdir()) / f"amood_hapbae_cost_base_{uuid.uuid4().hex}{ext}"
    data = await file.read()
    tmp_path.write_bytes(data)

    try:
        df = _ah_read_cost_base_df(tmp_path)
        if df.shape[1] < 2:
            raise HTTPException(status_code=400, detail="원가베이스는 최소 A,B열이 필요합니다.")
        shutil.move(str(tmp_path), str(AMOOD_HAPBAE_COST_BASE_PATH))
        _ah_load_cost_base_df()
    finally:
        try:
            tmp_path.unlink(missing_ok=True)
        except Exception:
            pass

    return {"ok": True, "status": _ah_cost_base_status()}


@router.get("/amood-hapbae/cost-base/download")
def amood_hapbae_cost_base_download():
    path = AMOOD_HAPBAE_COST_BASE_PATH
    if not path.exists():
        raise HTTPException(status_code=404, detail="원가베이스 파일이 없습니다.")
    return FileResponse(path, filename=path.name)


@router.get("/amood-hapbae/cost-base/preview")
def amood_hapbae_cost_base_preview(offset: int = 0, limit: int = 50, q: str | None = None):
    if offset < 0 or limit <= 0 or limit > 200:
        raise HTTPException(status_code=400, detail="offset/limit 값이 올바르지 않습니다.")
    try:
        df = _ah_load_cost_base_df()
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"원가베이스 로드 실패: {e}")

    q_norm = str(q).strip() if q else ""
    if q_norm:
        df_view = df.fillna("").astype(str)
        mask = df_view.apply(lambda row: row.str.contains(q_norm, case=False, na=False)).any(axis=1)
        df_filtered = df[mask].copy()
    else:
        df_filtered = df

    total = len(df_filtered)
    col_names = ["1열", "2열"]
    end = min(offset + limit, total)
    rows = []
    for i in range(offset, end):
        r = df_filtered.iloc[i]
        row = []
        for v in r.iloc[:2].values.tolist():
            if pd.isna(v):
                row.append("")
            else:
                row.append(v)
        rows.append({"row_index": int(r.name), "values": row})
    return {"ok": True, "columns": col_names, "rows": rows, "total": total, "status": _ah_cost_base_status()}


@router.post("/amood-hapbae/cost-base/edit-batch")
def amood_hapbae_cost_base_edit_batch(payload: dict = Body(...)):
    edits = payload.get("edits")
    if not isinstance(edits, list) or not edits:
        raise HTTPException(status_code=400, detail="edits 값이 올바르지 않습니다.")

    try:
        df = _ah_load_cost_base_df()
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"원가베이스 로드 실패: {e}")

    for item in edits:
        row_index = item.get("row_index")
        column = item.get("column")
        value = item.get("value")
        if row_index is None or not isinstance(row_index, int) or row_index < 0:
            continue
        if row_index >= len(df):
            continue
        if isinstance(column, int):
            if column < 0 or column >= len(df.columns):
                continue
            col_name = df.columns[column]
        elif isinstance(column, str) and column in df.columns:
            col_name = column
        else:
            continue
        df.at[row_index, col_name] = "" if value is None else value

    try:
        _ah_save_cost_base_df(df)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"원가베이스 저장 실패: {e}")

    return {"ok": True, "status": _ah_cost_base_status()}


@router.post("/amood-hapbae/conflicts")
async def amood_hapbae_conflicts(
    file: UploadFile = File(...),
    skip_header: bool = Form(True),
):
    name = file.filename or ""
    ext = Path(name).suffix.lower()
    if ext not in AMOOD_HAPBAE_ALLOWED_EXCEL:
        raise HTTPException(status_code=400, detail="xlsx/xlsm 파일만 업로드 가능합니다.")

    tmp_path = Path(tempfile.gettempdir()) / f"amood_hapbae_conflicts_{uuid.uuid4().hex}{ext}"
    data = await file.read()
    tmp_path.write_bytes(data)

    try:
        sheet, conflicts = _ah_find_conflicts_xlsx(tmp_path, skip_header=skip_header)
        unmatched_products: list[str] = []
        unmatched_rows = 0
        cost_base_exists = AMOOD_HAPBAE_COST_BASE_PATH.exists()
        if cost_base_exists:
            try:
                cost_map = _ah_load_base_cost_map(AMOOD_HAPBAE_COST_BASE_PATH)
                unmatched_products, unmatched_rows = _ah_find_unmatched_products(
                    tmp_path,
                    cost_map,
                    skip_header=skip_header,
                )
            except Exception:
                unmatched_products = []
                unmatched_rows = 0

        return {
            "ok": True,
            "sheet": sheet,
            "conflict_count": len(conflicts),
            "cost_base_exists": cost_base_exists,
            "unmatched_product_count": len(unmatched_products),
            "unmatched_row_count": unmatched_rows,
            "unmatched_products": unmatched_products,
            "conflicts": [
                {"c": c_val, "d_values": sorted(list(d_set), key=lambda x: str(x))}
                for c_val, d_set in conflicts
            ],
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
    finally:
        try:
            tmp_path.unlink(missing_ok=True)
        except Exception:
            pass


@router.post("/amood-hapbae/export")
async def amood_hapbae_export(
    file: UploadFile = File(...),
    skip_header: bool = Form(True),
    header_col1: str = Form("상품명"),
    header_col2: str = Form("상품코드"),
    header_col3: str = Form("작업수량"),
    header_col4: str = Form("메모"),
    include_col1: bool = Form(True),
    include_col2: bool = Form(True),
    include_col3: bool = Form(True),
    include_col4: bool = Form(True),
):
    name = file.filename or "amood_hapbae.xlsx"
    ext = Path(name).suffix.lower()
    if ext not in AMOOD_HAPBAE_ALLOWED_EXCEL:
        raise HTTPException(status_code=400, detail="xlsx/xlsm 파일만 업로드 가능합니다.")

    if not AMOOD_HAPBAE_COST_BASE_PATH.exists():
        raise HTTPException(
            status_code=400,
            detail=f"원가베이스 파일을 읽을 수 없습니다: {AMOOD_HAPBAE_COST_BASE_PATH}",
        )

    tmp_path = Path(tempfile.gettempdir()) / f"amood_hapbae_export_{uuid.uuid4().hex}{ext}"
    data = await file.read()
    tmp_path.write_bytes(data)

    try:
        _, rows = _ah_build_output_rows_from_hj(tmp_path, skip_header=skip_header)
        if not rows:
            raise HTTPException(status_code=400, detail="가공할 데이터(H/J)가 없습니다.")

        cost_map = _ah_load_base_cost_map(AMOOD_HAPBAE_COST_BASE_PATH)

        headers = [
            _ah_pick_header(header_col1, "상품명"),
            _ah_pick_header(header_col2, "상품코드"),
            _ah_pick_header(header_col3, "작업수량"),
            _ah_pick_header(header_col4, "메모"),
        ]
        include_cols: list[int] = []
        if include_col1:
            include_cols.append(1)
        if include_col2:
            include_cols.append(2)
        if include_col3:
            include_cols.append(3)
        if include_col4:
            include_cols.append(4)
        if not include_cols:
            raise HTTPException(status_code=400, detail="다운로드할 열을 최소 1개 선택하세요.")

        content = _ah_build_xls_bytes(rows, cost_map, headers, include_cols)
        filename = f"{Path(name).stem}_가공본.xls"
        headers = {"Content-Disposition": _content_disposition(filename)}
        return Response(
            content=content,
            media_type="application/vnd.ms-excel",
            headers=headers,
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
