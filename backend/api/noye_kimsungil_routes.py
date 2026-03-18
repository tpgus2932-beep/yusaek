from __future__ import annotations

from datetime import date
from pathlib import Path
import io
import os
import re
import shutil
import tempfile
import urllib.parse
import uuid

import pandas as pd
from fastapi import APIRouter, Body, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
import xlwt


def build_noye_kimsungil_router(*, get_current_user):
    router = APIRouter(prefix="/noye-kimsungil")

    KDG_BASE_FILENAME = "케이디지원가베이스.xlsx"
    KDG_BASE_PATH = Path(
        os.environ.get("KDG_BASE_PATH", r"C:\Users\ksh29\OneDrive\Desktop\원베\케이디지원가베이스.xlsx")
    )
    KDG_ALLOWED_BASE = {".xlsx", ".xls", ".xlsm"}

    NUM_LINE_RE = re.compile(r"^\s*([\d,]+)\s+([\d,]+)\s+([\d,]+)\s*$")
    ITEM_RE = re.compile(r"^\s*(?:[A-Za-z]\.)*([A-Za-z])\.(\d+)-(\d+)(SH|LO)?/([^/]+)/([^/\s]+)\s*$")

    def _content_disposition(filename: str) -> str:
        safe_name = (filename or "download").replace('"', "")
        ascii_name = "".join(ch if ord(ch) < 128 else "_" for ch in safe_name)
        ascii_name = re.sub(r"_+", "_", ascii_name).strip("_") or "download"
        quoted = urllib.parse.quote(safe_name)
        return f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quoted}"

    def _safe_str(v) -> str:
        if v is None:
            return ""
        if pd.isna(v):
            return ""
        return str(v).strip()

    def _suffix_to_kor(sfx: str | None) -> str:
        if sfx == "SH":
            return "숏"
        if sfx == "LO":
            return "롱"
        return "기본"

    def _parse_kdg_text(raw: str) -> list[dict]:
        lines = [ln.rstrip() for ln in (raw or "").splitlines() if ln.strip()]
        rows = []
        i = 0
        while i < len(lines):
            ln = lines[i].strip()
            if ln.startswith("품명"):
                i += 1
                continue

            m_item = ITEM_RE.match(ln)
            if not m_item:
                i += 1
                continue

            _, model_no, _opt_no, sfx, color, size = m_item.groups()
            suffix = _suffix_to_kor(sfx)
            a_value = f"{model_no} {color} {size} {suffix}"
            qty = ""
            amount = ""
            if i + 1 < len(lines):
                m_num = NUM_LINE_RE.match(lines[i + 1].strip())
                if m_num:
                    _unit_price, qty, amount = m_num.groups()
                    qty = qty.replace(",", "")
                    amount = amount.replace(",", "")
                    i += 2
                else:
                    i += 1
            else:
                i += 1

            rows.append(
                {
                    "A(변환품명)": a_value,
                    "B(옵션번호)": qty,
                    "원본품명": ln,
                    "모델번호": model_no,
                    "색상": color,
                    "사이즈": size,
                    "기장": suffix,
                    "수량": int(qty) if _safe_str(qty) else 0,
                    "금액": int(amount) if _safe_str(amount) else 0,
                    "원베_B": "",
                }
            )

        if not rows:
            raise ValueError("변환할 품명 라인을 찾지 못했음.")
        return rows

    def _read_base_df(path: Path) -> pd.DataFrame:
        ext = path.suffix.lower()
        if ext in (".xlsx", ".xlsm"):
            return pd.read_excel(path, dtype=str, engine="openpyxl")
        if ext == ".xls":
            try:
                return pd.read_excel(path, dtype=str, engine="xlrd")
            except Exception:
                return pd.read_excel(path, dtype=str)
        return pd.read_excel(path, dtype=str)

    def _load_kdg_base_map(path: Path) -> dict[str, str]:
        if not path.exists():
            raise FileNotFoundError(f"파일이 없음: {path}")
        df = _read_base_df(path)
        if df.shape[1] < 2:
            raise ValueError("원가베이스는 최소 A,B열이 필요합니다.")
        out: dict[str, str] = {}
        for _, r in df.iterrows():
            key = _safe_str(r.iloc[0] if len(r) > 0 else "")
            val = _safe_str(r.iloc[1] if len(r) > 1 else "")
            if key:
                out[key] = val
        return out

    def _save_base_df(df: pd.DataFrame):
        KDG_BASE_PATH.parent.mkdir(parents=True, exist_ok=True)
        with pd.ExcelWriter(KDG_BASE_PATH, engine="openpyxl") as writer:
            df.to_excel(writer, index=False)

    def _match_kdg_rows(rows: list[dict], base_map: dict[str, str]) -> tuple[list[dict], int]:
        out = []
        missing = 0
        for row in rows:
            key = _safe_str(row.get("A(변환품명)"))
            code = base_map.get(key, "")
            merged = {**row, "원베_B": code}
            if _safe_str(code) == "":
                missing += 1
            out.append(merged)
        return out, missing

    def _read_excel_any(path: Path) -> pd.DataFrame:
        ext = path.suffix.lower()
        if ext in (".xlsx", ".xlsm"):
            try:
                return pd.read_excel(path, engine="openpyxl")
            except Exception:
                return pd.read_excel(path)
        if ext == ".xls":
            try:
                return pd.read_excel(path, engine="xlrd")
            except Exception:
                return pd.read_excel(path)
        return pd.read_excel(path)

    def _left_first_word(text: str) -> str:
        s = _safe_str(text)
        return s.split(" ", 1)[0].strip() if s else ""

    def _mid_after_first_space(text: str) -> str:
        s = _safe_str(text)
        if not s:
            return ""
        parts = s.split(" ", 1)
        return parts[1].strip() if len(parts) == 2 else ""

    def _extract_bracket_inside(text: str) -> str | None:
        s = _safe_str(text)
        m = re.search(r"\[([^\]]+)\]", s)
        return m.group(1).strip() if m else None

    def _d_from_f(f_text: str) -> str:
        inside = _extract_bracket_inside(f_text)
        if not inside:
            return ""
        return inside.split("-", 1)[0].strip() if "-" in inside else inside.strip()

    def _e_from_f(f_text: str) -> str:
        inside = _extract_bracket_inside(f_text)
        if not inside:
            return "free"
        parts = [p.strip() for p in inside.split("-")]
        if len(parts) <= 1:
            return "free"
        merged = " ".join([p for p in parts[1:] if p]).strip()
        return merged if merged else "free"

    def _ensure_min_columns(df: pd.DataFrame, min_cols: int) -> pd.DataFrame:
        if df.shape[1] >= min_cols:
            return df
        for _ in range(min_cols - df.shape[1]):
            df[f"__EMPTY_{df.shape[1] + 1}__"] = ""
        return df

    def _build_date_chunk_output_df(path: Path) -> pd.DataFrame:
        df = _read_excel_any(path)
        df = _ensure_min_columns(df, 7)
        col_a = df.columns[0]
        col_b = df.columns[1]
        col_d = df.columns[3]
        col_e = df.columns[4]
        col_f = df.columns[5]
        col_g = df.columns[6]

        b_src = df[col_b]
        e_src = df[col_e]
        f_src = df[col_f]
        g_src = df[col_g]

        today_str = date.today().strftime("%Y-%m-%d")
        df[col_a] = b_src.map(_left_first_word)
        df[col_b] = b_src.map(_mid_after_first_space)
        df[col_d] = f_src.map(_d_from_f)
        df[col_e] = f_src.map(_e_from_f)
        df[col_f] = pd.to_numeric(g_src, errors="coerce")
        df[col_g] = today_str

        df_out = df.iloc[:, :7].copy()
        if len(df_out) > 0:
            df_out = df_out.iloc[:-1]
        return df_out

    @router.get("/kdg/base/status")
    def kdg_base_status(user: str = Depends(get_current_user)):
        exists = KDG_BASE_PATH.exists()
        return {"ok": True, "exists": exists, "path": str(KDG_BASE_PATH), "filename": KDG_BASE_FILENAME}

    @router.get("/kdg/base/preview")
    def kdg_base_preview(
        offset: int = 0,
        limit: int = 50,
        q: str | None = None,
        user: str = Depends(get_current_user),
    ):
        if offset < 0 or limit <= 0 or limit > 200:
            raise HTTPException(status_code=400, detail="offset/limit 값이 올바르지 않습니다.")
        if not KDG_BASE_PATH.exists():
            raise HTTPException(status_code=404, detail="케이디지 원가베이스 파일이 없습니다.")

        try:
            df = _read_base_df(KDG_BASE_PATH)
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"원가베이스 로드 실패: {e}")

        q_norm = _safe_str(q)
        if q_norm:
            df_view = df.fillna("").astype(str)
            mask = df_view.apply(lambda row: row.str.contains(q_norm, case=False, na=False)).any(axis=1)
            df_filtered = df[mask].copy()
        else:
            df_filtered = df

        total = len(df_filtered)
        end = min(offset + limit, total)
        rows = []
        for i in range(offset, end):
            r = df_filtered.iloc[i]
            values = []
            for v in r.iloc[:2].values.tolist():
                values.append("" if pd.isna(v) else v)
            rows.append({"row_index": int(r.name), "values": values})
        return {"ok": True, "columns": ["1열", "2열"], "rows": rows, "total": total}

    @router.post("/kdg/base/upload")
    async def kdg_base_upload(file: UploadFile = File(...), user: str = Depends(get_current_user)):
        ext = Path(file.filename or "").suffix.lower()
        if ext not in KDG_ALLOWED_BASE:
            raise HTTPException(status_code=400, detail="xls/xlsx/xlsm만 업로드 가능합니다.")
        data = await file.read()
        if not data:
            raise HTTPException(status_code=400, detail="업로드 파일이 비어 있습니다.")
        KDG_BASE_PATH.parent.mkdir(parents=True, exist_ok=True)
        tmp = Path(tempfile.gettempdir()) / f"kdg_base_{uuid.uuid4().hex}{ext}"
        tmp.write_bytes(data)
        try:
            _read_base_df(tmp)
            shutil.move(str(tmp), str(KDG_BASE_PATH))
        finally:
            try:
                tmp.unlink(missing_ok=True)
            except Exception:
                pass
        return {"ok": True, "path": str(KDG_BASE_PATH)}

    @router.post("/kdg/base/edit-batch")
    def kdg_base_edit_batch(payload: dict = Body(...), user: str = Depends(get_current_user)):
        edits = payload.get("edits")
        if not isinstance(edits, list) or not edits:
            raise HTTPException(status_code=400, detail="edits 값이 올바르지 않습니다.")
        if not KDG_BASE_PATH.exists():
            raise HTTPException(status_code=404, detail="케이디지 원가베이스 파일이 없습니다.")

        try:
            df = _read_base_df(KDG_BASE_PATH)
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
            _save_base_df(df)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"원가베이스 저장 실패: {e}")

        return {"ok": True, "path": str(KDG_BASE_PATH)}

    @router.get("/kdg/base/download")
    def kdg_base_download(user: str = Depends(get_current_user)):
        if not KDG_BASE_PATH.exists():
            raise HTTPException(status_code=404, detail="케이디지 원가베이스 파일이 없습니다.")
        return FileResponse(KDG_BASE_PATH, filename=KDG_BASE_PATH.name)

    @router.post("/kdg/convert")
    def kdg_convert(payload: dict = Body(...), user: str = Depends(get_current_user)):
        raw = _safe_str(payload.get("text"))
        rows = _parse_kdg_text(raw)
        return {"ok": True, "count": len(rows), "rows": rows}

    @router.post("/kdg/match")
    def kdg_match(payload: dict = Body(...), user: str = Depends(get_current_user)):
        raw = _safe_str(payload.get("text"))
        rows = _parse_kdg_text(raw)
        base_map = _load_kdg_base_map(KDG_BASE_PATH)
        matched, missing = _match_kdg_rows(rows, base_map)
        return {"ok": True, "count": len(matched), "missing": missing, "rows": matched}

    @router.post("/kdg/export-xls")
    def kdg_export_xls(payload: dict = Body(...), user: str = Depends(get_current_user)):
        raw = _safe_str(payload.get("text"))
        rows = _parse_kdg_text(raw)
        if bool(payload.get("with_match", True)):
            base_map = _load_kdg_base_map(KDG_BASE_PATH)
            rows, _ = _match_kdg_rows(rows, base_map)

        book = xlwt.Workbook()
        sheet = book.add_sheet("입고업로드")
        headers_row = ["상품코드", "요청수량", "입고수량"]
        for idx, h in enumerate(headers_row):
            sheet.write(0, idx, h)
        for i, row in enumerate(rows, start=1):
            sheet.write(i, 0, _safe_str(row.get("원베_B")))
            sheet.write(i, 1, "0")
            sheet.write(i, 2, _safe_str(row.get("B(옵션번호)")))

        buf = io.BytesIO()
        book.save(buf)
        headers = {"Content-Disposition": _content_disposition("입고업로드.xls")}
        return Response(
            content=buf.getvalue(),
            media_type="application/vnd.ms-excel",
            headers=headers,
        )

    @router.post("/kdg/export-date")
    def kdg_export_date(payload: dict = Body(...), user: str = Depends(get_current_user)):
        raw = _safe_str(payload.get("text"))
        rows = _parse_kdg_text(raw)
        df = pd.DataFrame(rows)
        g = (
            df.groupby(["모델번호", "색상", "사이즈", "기장"], as_index=False)[["수량", "금액"]]
            .sum()
        )
        out = pd.DataFrame(
            {
                "A": ["케이디지"] * len(g),
                "B": g["모델번호"].astype(str),
                "C": g["금액"].astype(int).astype(str),
                "D": g["색상"].astype(str),
                "E": (g["사이즈"].astype(str) + " " + g["기장"].astype(str)),
                "F": g["수량"].astype(int).astype(str),
            }
        )

        buf = io.BytesIO()
        with pd.ExcelWriter(buf, engine="openpyxl") as writer:
            out.to_excel(writer, index=False, header=False, sheet_name="결과")
        buf.seek(0)
        headers = {"Content-Disposition": _content_disposition("날짜별_복사_데이터.xlsx")}
        return Response(
            content=buf.getvalue(),
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers=headers,
        )

    @router.post("/kdg/date-copy-text")
    def kdg_date_copy_text(payload: dict = Body(...), user: str = Depends(get_current_user)):
        pre_rows = payload.get("rows")
        if pre_rows and isinstance(pre_rows, list):
            rows = pre_rows
        else:
            raw = _safe_str(payload.get("text"))
            rows = _parse_kdg_text(raw)
        df = pd.DataFrame(rows)
        g = (
            df.groupby(["모델번호", "색상", "사이즈", "기장"], as_index=False)[["수량", "금액"]]
            .sum()
        )
        out = pd.DataFrame(
            {
                "A": ["케이디지"] * len(g),
                "B": g["모델번호"].astype(str),
                "C": g["금액"].astype(int).astype(str),
                "D": g["색상"].astype(str),
                "E": (g["사이즈"].astype(str) + " " + g["기장"].astype(str)),
                "F": g["수량"].astype(int).astype(str),
            }
        )
        # Keep a trailing newline so repeated copy/paste blocks append cleanly.
        tsv = out.to_csv(sep="\t", index=False, header=False, lineterminator="\n")
        return {"ok": True, "count": len(out), "text": tsv}

    @router.post("/date-chunk/process")
    async def date_chunk_process(file: UploadFile = File(...), user: str = Depends(get_current_user)):
        ext = Path(file.filename or "").suffix.lower()
        if ext not in {".xlsx", ".xls", ".xlsm"}:
            raise HTTPException(status_code=400, detail="xlsx/xls/xlsm만 업로드 가능합니다.")
        raw = await file.read()
        if not raw:
            raise HTTPException(status_code=400, detail="업로드 파일이 비어 있습니다.")

        tmp = Path(tempfile.gettempdir()) / f"date_chunk_{uuid.uuid4().hex}{ext}"
        tmp.write_bytes(raw)
        try:
            df_out = _build_date_chunk_output_df(tmp)
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"엑셀 읽기 실패: {e}")
        finally:
            try:
                tmp.unlink(missing_ok=True)
            except Exception:
                pass

        buf = io.BytesIO()
        with pd.ExcelWriter(buf, engine="openpyxl") as writer:
            df_out.to_excel(writer, sheet_name="Sheet1", index=False)
        buf.seek(0)
        stem = Path(file.filename or "가공대상").stem
        headers = {"Content-Disposition": _content_disposition(f"{stem}_가공.xlsx")}
        return Response(
            content=buf.getvalue(),
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers=headers,
        )

    @router.post("/date-chunk/copy")
    async def date_chunk_copy(file: UploadFile = File(...), user: str = Depends(get_current_user)):
        ext = Path(file.filename or "").suffix.lower()
        if ext not in {".xlsx", ".xls", ".xlsm"}:
            raise HTTPException(status_code=400, detail="xlsx/xls/xlsm만 업로드 가능합니다.")
        raw = await file.read()
        if not raw:
            raise HTTPException(status_code=400, detail="업로드 파일이 비어 있습니다.")

        tmp = Path(tempfile.gettempdir()) / f"date_chunk_copy_{uuid.uuid4().hex}{ext}"
        tmp.write_bytes(raw)
        try:
            df_out = _build_date_chunk_output_df(tmp)
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"엑셀 읽기 실패: {e}")
        finally:
            try:
                tmp.unlink(missing_ok=True)
            except Exception:
                pass

        tsv = df_out.to_csv(sep="\t", index=False, header=False, lineterminator="\n").rstrip("\n")
        return {"ok": True, "rows": len(df_out), "text": tsv}

    return router
