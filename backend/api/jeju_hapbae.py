import io
import re
import tempfile
import uuid
from collections import defaultdict
from pathlib import Path

import pandas as pd
import xlwt
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import Response

from api.amood_hapbae import (
    SHARED_COST_BASE_PATH,
    _ah_load_base_cost_map,
    _ah_normalize,
    _content_disposition,
)

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

    buf = io.BytesIO()
    book.save(buf)
    return buf.getvalue()


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
        if SHARED_COST_BASE_PATH.exists():
            try:
                cost_map = _ah_load_base_cost_map(SHARED_COST_BASE_PATH)
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
