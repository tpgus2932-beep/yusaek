import csv
import io
import re
from pathlib import Path
from urllib.parse import quote

import pandas as pd
from fastapi import APIRouter, Body, Depends, HTTPException, Response

DEFAULT_ACCOUNT_PATH = Path(r"C:\Users\ksh29\OneDrive\Desktop\원베\거래처계좌데이터.xlsx")
SHARED_PASTE_KEY = "collaboration_tools:purchase_deduction:shared_paste"
SHARED_PASTE_UPDATED_BY_KEY = "collaboration_tools:purchase_deduction:shared_paste:updated_by"


def build_collaboration_tools_router(*, get_current_user, get_setting, set_setting):
    router = APIRouter(prefix="/collaboration-tools")

    def _normalize_text(value) -> str:
        return " ".join(str(value or "").split()).strip()

    def _parse_amount(value) -> float:
        if value is None:
            return 0.0
        if isinstance(value, (int, float)):
            return float(value)
        raw = str(value).strip()
        if not raw:
            return 0.0
        normalized = raw.replace(",", "").replace("원", "").strip()
        if re.fullmatch(r"[+-]?\d+(?:\.\d+)?", normalized):
            try:
                return float(normalized)
            except Exception:
                return 0.0
        match = re.search(r"[+-]?\d+(?:\.\d+)?", normalized)
        if not match:
            return 0.0
        try:
            return float(match.group(0))
        except Exception:
            return 0.0

    def _resolve_account_path(payload: dict | None = None) -> Path:
        raw = str((payload or {}).get("account_path") or "").strip()
        return Path(raw) if raw else DEFAULT_ACCOUNT_PATH

    def _parse_pasted_rows(pasted_text: str, *, required: bool = True) -> list[list[str]]:
        text = str(pasted_text or "").replace("\r\n", "\n").replace("\r", "\n").strip("\n")
        if not text.strip():
            if required:
                raise HTTPException(status_code=400, detail="입력 데이터를 붙여넣으세요.")
            return []
        reader = csv.reader(io.StringIO(text), delimiter="\t")
        return [list(row) for row in reader if any(_normalize_text(cell) for cell in row)]

    def _read_account_rows(path: Path) -> list[list[object]]:
        if not path.exists():
            raise HTTPException(status_code=400, detail=f"거래처 계좌 파일을 찾을 수 없습니다: {path}")
        try:
            df = pd.read_excel(path, header=None, dtype=object)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"거래처 계좌 파일을 읽지 못했습니다: {exc}") from exc
        return df.fillna("").values.tolist()

    def _write_account_rows(path: Path, rows: list[list[object]]):
        path.parent.mkdir(parents=True, exist_ok=True)
        normalized_rows = [list(row[:6]) + [""] * max(0, 6 - len(row[:6])) for row in rows]
        df = pd.DataFrame(normalized_rows)
        with pd.ExcelWriter(path, engine="openpyxl") as writer:
            df.to_excel(writer, index=False, header=False, sheet_name="Sheet1")

    def _account_rows_to_items(rows: list[list[object]]) -> list[dict]:
        items = []
        for idx, row in enumerate(rows):
            padded = list(row[:6]) + [""] * max(0, 6 - len(row[:6]))
            items.append(
                {
                    "row_index": idx,
                    "A": _normalize_text(padded[0]),
                    "B": _normalize_text(padded[1]),
                    "C": _normalize_text(padded[2]),
                    "D": _normalize_text(padded[3]),
                    "E": _normalize_text(padded[4]),
                    "F": _normalize_text(padded[5]),
                }
            )
        return items

    def _build_purchase_deduction_result(pasted_rows, account_rows, skip_source_header: bool, skip_account_header: bool):
        source_body = pasted_rows[1:] if skip_source_header else pasted_rows
        account_body = account_rows[1:] if skip_account_header else account_rows

        supplier_totals: dict[str, float] = {}
        for row in source_body:
            supplier = _normalize_text(row[0] if len(row) > 0 else "")
            if not supplier:
                continue
            amount = _parse_amount(row[2] if len(row) > 2 else "")
            supplier_totals[supplier] = supplier_totals.get(supplier, 0.0) + amount

        account_map: dict[str, list[object]] = {}
        for row in account_body:
            supplier = _normalize_text(row[0] if len(row) > 0 else "")
            if supplier and supplier not in account_map:
                account_map[supplier] = row

        result_rows = []
        unmatched = []
        for supplier in sorted(supplier_totals.keys()):
            total_amount = supplier_totals[supplier]
            account_row = account_map.get(supplier)
            if not account_row:
                result_rows.append(
                    {
                        "A": "",
                        "B": "",
                        "C": total_amount,
                        "D": supplier,
                        "E": "",
                        "F": "",
                        "G": "",
                        "H": "",
                        "status": "미등록",
                    }
                )
                unmatched.append({"supplier": supplier, "total_amount": total_amount, "status": "미등록"})
                continue

            result_rows.append(
                {
                    "A": _normalize_text(account_row[1] if len(account_row) > 1 else ""),  # 기존 C → A
                    "B": _normalize_text(account_row[2] if len(account_row) > 2 else ""),
                    "C": total_amount,                                                       # 기존 D → C
                    "D": _normalize_text(account_row[0] if len(account_row) > 0 else ""),  # 기존 A → D
                    "E": _normalize_text(account_row[3] if len(account_row) > 3 else ""),
                    "F": _normalize_text(account_row[4] if len(account_row) > 4 else ""),
                    "G": "",
                    "H": _normalize_text(account_row[5] if len(account_row) > 5 else ""),
                    "status": "매칭",
                }
            )

        return {
            "matched": result_rows,
            "unmatched": unmatched,
            "summary": {
                "supplier_count": len(supplier_totals),
                "matched_count": len(result_rows) - len(unmatched),
                "unmatched_count": len(unmatched),
                "total_amount": sum(supplier_totals.values()),
            },
        }

    def _content_disposition(filename: str) -> str:
        ascii_name = filename.encode("ascii", "ignore").decode() or "download.xlsx"
        return f'attachment; filename="{ascii_name}"; filename*=UTF-8\'\'{quote(filename)}'

    @router.get("/account-data")
    def get_account_data(_: str = Depends(get_current_user)):
        rows = _read_account_rows(DEFAULT_ACCOUNT_PATH)
        return {
            "ok": True,
            "account_path": str(DEFAULT_ACCOUNT_PATH),
            "rows": _account_rows_to_items(rows),
        }

    @router.post("/account-data/save")
    def save_account_data(payload: dict = Body(...), _: str = Depends(get_current_user)):
        raw_rows = payload.get("rows")
        if not isinstance(raw_rows, list):
            raise HTTPException(status_code=400, detail="rows 형식이 올바르지 않습니다.")
        rows = []
        for row in raw_rows:
            if not isinstance(row, dict):
                continue
            rows.append(
                [
                    _normalize_text(row.get("A")),
                    _normalize_text(row.get("B")),
                    _normalize_text(row.get("C")),
                    _normalize_text(row.get("D")),
                    _normalize_text(row.get("E")),
                    _normalize_text(row.get("F")),
                ]
            )
        _write_account_rows(DEFAULT_ACCOUNT_PATH, rows)
        return {"ok": True, "saved_count": len(rows), "account_path": str(DEFAULT_ACCOUNT_PATH)}

    @router.post("/account-data/append-paste")
    def append_account_data(payload: dict = Body(...), _: str = Depends(get_current_user)):
        pasted_rows = _parse_pasted_rows(payload.get("pasted_text", ""))
        skip_header = bool(payload.get("skip_header", False))
        source_rows = pasted_rows[1:] if skip_header else pasted_rows
        current_rows = _read_account_rows(DEFAULT_ACCOUNT_PATH)

        appended_rows = []
        for row in source_rows:
            mapped = [
                _normalize_text(row[3] if len(row) > 3 else ""),  # D -> A
                _normalize_text(row[0] if len(row) > 0 else ""),  # A -> B
                _normalize_text(row[1] if len(row) > 1 else ""),  # B -> C
                _normalize_text(row[4] if len(row) > 4 else ""),  # E -> D
                _normalize_text(row[5] if len(row) > 5 else ""),  # F -> E
                _normalize_text(row[7] if len(row) > 7 else ""),  # H -> F
            ]
            if any(mapped):
                appended_rows.append(mapped)

        next_rows = current_rows + appended_rows
        _write_account_rows(DEFAULT_ACCOUNT_PATH, next_rows)
        return {
            "ok": True,
            "added_count": len(appended_rows),
            "account_path": str(DEFAULT_ACCOUNT_PATH),
            "rows": _account_rows_to_items(next_rows),
        }

    @router.post("/purchase-deduction/preview")
    def preview_purchase_deduction(payload: dict = Body(...), _: str = Depends(get_current_user)):
        account_path = _resolve_account_path(payload)
        pasted_rows = _parse_pasted_rows(payload.get("pasted_text", ""))
        account_rows = _read_account_rows(account_path)
        result = _build_purchase_deduction_result(
            pasted_rows,
            account_rows,
            bool(payload.get("skip_source_header", False)),
            bool(payload.get("skip_account_header", True)),
        )
        result["summary"]["account_path"] = str(account_path)
        return {"ok": True, **result}

    @router.get("/purchase-deduction/shared-paste")
    def get_purchase_deduction_shared_paste(user: str = Depends(get_current_user)):
        return {
            "ok": True,
            "pasted_text": get_setting(SHARED_PASTE_KEY) or "",
            "updated_by": get_setting(SHARED_PASTE_UPDATED_BY_KEY) or "",
            "viewer": user,
        }

    @router.put("/purchase-deduction/shared-paste")
    def set_purchase_deduction_shared_paste(payload: dict = Body(...), user: str = Depends(get_current_user)):
        pasted_text = str(payload.get("pasted_text") or "")
        set_setting(SHARED_PASTE_KEY, pasted_text)
        set_setting(SHARED_PASTE_UPDATED_BY_KEY, user)
        return {
            "ok": True,
            "pasted_text": pasted_text,
            "updated_by": user,
        }

    @router.post("/purchase-deduction/export")
    def export_purchase_deduction(payload: dict = Body(...), _: str = Depends(get_current_user)):
        account_path = _resolve_account_path(payload)
        pasted_rows = _parse_pasted_rows(payload.get("pasted_text", ""))
        account_rows = _read_account_rows(account_path)
        result = _build_purchase_deduction_result(
            pasted_rows,
            account_rows,
            bool(payload.get("skip_source_header", False)),
            bool(payload.get("skip_account_header", True)),
        )

        matched_df = pd.DataFrame(
            [
                {
                    "A": str(row["A"]),
                    "B": str(row["B"]),
                    "C": row["C"],
                    "D": str(row["D"]),
                    "E": str(row["E"]),
                    "F": str(row["F"]),
                    "G": str(row["G"]),
                    "H": str(row["H"]),
                    "상태": row["status"],
                }
                for row in result["matched"]
            ]
        )
        unmatched_df = pd.DataFrame(
            [
                {
                    "공급처": row["supplier"],
                    "합계금액": row["total_amount"],
                    "상태": row["status"],
                }
                for row in result["unmatched"]
            ]
        )

        buf = io.BytesIO()
        with pd.ExcelWriter(buf, engine="openpyxl") as writer:
            matched_df.to_excel(writer, index=False, sheet_name="결과")
            unmatched_df.to_excel(writer, index=False, sheet_name="미등록")
            result_ws = writer.book["결과"]
            for cell in result_ws["A"]:
                cell.number_format = "@"
                if cell.row > 1 and cell.value is not None:
                    cell.value = str(cell.value)
            for cell in result_ws["B"]:
                cell.number_format = "@"
                if cell.row > 1 and cell.value is not None:
                    cell.value = str(cell.value)
        buf.seek(0)
        return Response(
            content=buf.getvalue(),
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": _content_disposition("매입차감_결과.xlsx")},
        )

    return router
