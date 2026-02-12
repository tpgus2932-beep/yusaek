from collections import defaultdict
from pathlib import Path
import io
import os
import re
import tempfile
import uuid

import openpyxl
import urllib.parse
import xlwt
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import Response

router = APIRouter()

AMOOD_HAPBAE_ALLOWED_EXCEL = {".xlsx", ".xlsm"}
AMOOD_HAPBAE_COST_BASE_PATH = Path(
    os.environ.get("AMOOD_HAPBAE_COST_BASE_PATH", r"C:\Users\ksh29\OneDrive\Desktop\원베\원가베이스유.xlsx")
)


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


def _ah_pick_header(value: str | None, fallback: str) -> str:
    header = _ah_normalize(value)
    return header if header else fallback


def _ah_build_xls_bytes(
    rows: list[tuple[str, object]],
    cost_map: dict[str, object],
    headers: list[str],
    include_cols: list[int],
) -> bytes:
    book = xlwt.Workbook()
    sheet = book.add_sheet("결과")

    selected_headers = [headers[idx - 1] for idx in include_cols]
    for idx, header in enumerate(selected_headers):
        sheet.write(0, idx, header)

    for i, row_data in enumerate(rows, start=1):
        val, qty = row_data
        selected_values: list[object] = []
        for col_no in include_cols:
            if col_no == 1:
                selected_values.append(val)
            elif col_no == 2:
                selected_values.append(cost_map.get(_ah_normalize_match_key(val), ""))
            elif col_no == 3:
                selected_values.append(qty if qty is not None else "")
        for j, cell_val in enumerate(selected_values):
            sheet.write(i, j, cell_val)

    buf = io.BytesIO()
    book.save(buf)
    return buf.getvalue()


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
        return {
            "ok": True,
            "sheet": sheet,
            "conflict_count": len(conflicts),
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
    header_col1: str = Form("가공결과"),
    header_col2: str = Form("원가베이스유_B"),
    header_col3: str = Form("수량(K)"),
    include_col1: bool = Form(True),
    include_col2: bool = Form(True),
    include_col3: bool = Form(True),
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
            _ah_pick_header(header_col1, "가공결과"),
            _ah_pick_header(header_col2, "원가베이스유_B"),
            _ah_pick_header(header_col3, "수량(K)"),
        ]
        include_cols: list[int] = []
        if include_col1:
            include_cols.append(1)
        if include_col2:
            include_cols.append(2)
        if include_col3:
            include_cols.append(3)
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
