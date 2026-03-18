import io
import re
import tempfile
import uuid
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
    return " ".join(p for p in [name.strip(), option.strip()] if p).strip()


def _jeju_process(path: Path) -> list[tuple[str, str]]:
    """
    두 번째 시트에서:
      - C열(idx 2) 중복 행만 필터
      - A = clean(G열 idx 6) + clean(I열 idx 8)
      - B = J열(idx 9) raw값
    Returns list of (a_val, b_val)
    """
    ext = path.suffix.lower()
    try:
        if ext == ".xls":
            df = pd.read_excel(path, sheet_name=1, header=None, dtype=object, engine="xlrd")
        else:
            df = pd.read_excel(path, sheet_name=1, header=None, dtype=object, engine="openpyxl")
    except Exception as e:
        raise ValueError(f"두 번째 시트를 읽을 수 없습니다: {e}")

    required_cols = [2, 6, 8, 9]
    if df.shape[1] <= max(required_cols):
        raise ValueError(
            f"입력 파일에 C(3), G(7), I(9), J(10)열이 모두 있어야 합니다. "
            f"(현재 열 수: {df.shape[1]})"
        )

    c_vals = df.iloc[:, 2].map(_jeju_normalize)
    duplicate_mask = c_vals.ne("") & c_vals.duplicated(keep=False)
    filtered = df.loc[duplicate_mask].copy()

    if filtered.empty:
        return []

    rows = []
    for _, row in filtered.iterrows():
        g_clean = _jeju_clean_product_name(row.iloc[6])
        i_clean = _jeju_clean_option(row.iloc[8])
        a_val = _jeju_combine(g_clean, i_clean)
        b_val = _jeju_normalize(row.iloc[9])
        if a_val:
            rows.append((a_val, b_val))

    return rows


def _jeju_build_xls(
    rows: list[tuple[str, str]],
    cost_map: dict,
    headers: list[str],
    include_cols: list[int],
) -> bytes:
    book = xlwt.Workbook()
    sheet = book.add_sheet("결과")

    selected_headers = [headers[i - 1] for i in include_cols]
    for idx, h in enumerate(selected_headers):
        sheet.write(0, idx, h)

    for i, (a_val, b_val) in enumerate(rows, start=1):
        code = cost_map.get(a_val.casefold(), "")
        selected = []
        for col_no in include_cols:
            if col_no == 1:
                selected.append(a_val)
            elif col_no == 2:
                selected.append(code)
            elif col_no == 3:
                selected.append(b_val)
        for j, v in enumerate(selected):
            sheet.write(i, j, v)

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
            raise HTTPException(status_code=400, detail="C열 중복 행이 없거나 가공할 데이터가 없습니다.")

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
