import csv
import io
import re
from urllib.parse import quote

import pandas as pd
from fastapi import APIRouter, Body, Depends, HTTPException, Query, Response

SHARED_PASTE_KEY = "collaboration_tools:purchase_deduction:shared_paste"
SHARED_PASTE_UPDATED_BY_KEY = "collaboration_tools:purchase_deduction:shared_paste:updated_by"
SHARED_PASTE_SLOT_COUNT = 5

_ACCOUNT_TABLE_DDL = """
    CREATE TABLE IF NOT EXISTS 거래처계좌데이터 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        A TEXT NOT NULL DEFAULT '',
        B TEXT NOT NULL DEFAULT '',
        C TEXT NOT NULL DEFAULT '',
        D TEXT NOT NULL DEFAULT '',
        E TEXT NOT NULL DEFAULT '',
        F TEXT NOT NULL DEFAULT ''
    )
"""


def build_collaboration_tools_router(*, get_current_user, get_setting, set_setting, get_janggi_db=None):
    router = APIRouter(prefix="/collaboration-tools")

    # ── 슬롯 헬퍼 ────────────────────────────────────────────────

    def _normalize_shared_paste_slot(slot: int) -> int:
        try:
            slot_no = int(slot)
        except Exception:
            slot_no = 1
        if slot_no < 1 or slot_no > SHARED_PASTE_SLOT_COUNT:
            raise HTTPException(status_code=400, detail=f"슬롯은 1~{SHARED_PASTE_SLOT_COUNT}번만 사용 가능합니다.")
        return slot_no

    def _shared_paste_key(slot: int) -> str:
        slot_no = _normalize_shared_paste_slot(slot)
        return SHARED_PASTE_KEY if slot_no == 1 else f"{SHARED_PASTE_KEY}:{slot_no}"

    def _shared_paste_updated_by_key(slot: int) -> str:
        slot_no = _normalize_shared_paste_slot(slot)
        return SHARED_PASTE_UPDATED_BY_KEY if slot_no == 1 else f"{SHARED_PASTE_UPDATED_BY_KEY}:{slot_no}"

    # ── 공통 헬퍼 ────────────────────────────────────────────────

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

    def _parse_pasted_rows(pasted_text: str, *, required: bool = True) -> list[list[str]]:
        text = str(pasted_text or "").replace("\r\n", "\n").replace("\r", "\n").strip("\n")
        if not text.strip():
            if required:
                raise HTTPException(status_code=400, detail="입력 데이터를 붙여넣으세요.")
            return []
        reader = csv.reader(io.StringIO(text), delimiter="\t")
        return [list(row) for row in reader if any(_normalize_text(cell) for cell in row)]

    def _content_disposition(filename: str) -> str:
        ascii_name = filename.encode("ascii", "ignore").decode() or "download.xlsx"
        return f'attachment; filename="{ascii_name}"; filename*=UTF-8\'\'{quote(filename)}'

    # ── DB 계좌 데이터 읽기/쓰기 ─────────────────────────────────

    def _get_account_dicts() -> list[dict]:
        if get_janggi_db is None:
            return []
        conn = get_janggi_db()
        try:
            conn.execute(_ACCOUNT_TABLE_DDL)
            conn.commit()
            rows = conn.execute("SELECT * FROM 거래처계좌데이터 ORDER BY id").fetchall()
            return [dict(r) for r in rows]
        finally:
            conn.close()

    def _save_account_dicts(rows_data: list[dict]) -> int:
        if get_janggi_db is None:
            raise HTTPException(status_code=500, detail="DB 연결이 설정되지 않았습니다.")
        conn = get_janggi_db()
        try:
            conn.execute(_ACCOUNT_TABLE_DDL)
            conn.execute("DELETE FROM 거래처계좌데이터")
            data = [
                tuple(str(r.get(c) or "").strip() for c in ["A", "B", "C", "D", "E", "F"])
                for r in rows_data if isinstance(r, dict)
            ]
            if data:
                conn.executemany(
                    "INSERT INTO 거래처계좌데이터 (A, B, C, D, E, F) VALUES (?, ?, ?, ?, ?, ?)",
                    data,
                )
            conn.commit()
            return len(data)
        finally:
            conn.close()

    def _append_account_rows(rows_to_add: list[tuple]) -> list[dict]:
        if get_janggi_db is None:
            raise HTTPException(status_code=500, detail="DB 연결이 설정되지 않았습니다.")
        conn = get_janggi_db()
        try:
            conn.execute(_ACCOUNT_TABLE_DDL)
            conn.commit()
            if rows_to_add:
                conn.executemany(
                    "INSERT INTO 거래처계좌데이터 (A, B, C, D, E, F) VALUES (?, ?, ?, ?, ?, ?)",
                    rows_to_add,
                )
                conn.commit()
            rows = conn.execute("SELECT * FROM 거래처계좌데이터 ORDER BY id").fetchall()
            return [dict(r) for r in rows]
        finally:
            conn.close()

    # ── 매입차감 가공 로직 ────────────────────────────────────────

    def _build_purchase_deduction_result(pasted_rows, account_dicts, skip_source_header: bool):
        source_body = pasted_rows[1:] if skip_source_header else pasted_rows

        supplier_totals: dict[str, float] = {}
        for row in source_body:
            supplier = _normalize_text(row[0] if len(row) > 0 else "")
            if not supplier:
                continue
            amount = _parse_amount(row[2] if len(row) > 2 else "")
            supplier_totals[supplier] = supplier_totals.get(supplier, 0.0) + amount

        account_map: dict[str, dict] = {}
        for ar in account_dicts:
            key = _normalize_text(ar.get("A", ""))
            if key and key not in account_map:
                account_map[key] = ar

        result_rows = []
        unmatched = []
        for supplier in sorted(supplier_totals.keys()):
            total_amount = supplier_totals[supplier]
            ar = account_map.get(supplier)
            if not ar:
                result_rows.append({
                    "A": "", "B": "", "C": total_amount, "D": supplier,
                    "E": "", "F": "", "G": "", "H": "", "status": "미등록",
                })
                unmatched.append({"supplier": supplier, "total_amount": total_amount, "status": "미등록"})
                continue
            result_rows.append({
                "A": _normalize_text(ar.get("D", "") or ar.get("B", "")),
                "B": _normalize_text(ar.get("C", "")),
                "C": total_amount,
                "D": _normalize_text(ar.get("A", "")),
                "E": _normalize_text(ar.get("E", "") or ar.get("D", "")),
                "F": "",
                "G": "",
                "H": _normalize_text(ar.get("F", "")),
                "status": "매칭",
            })

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

    # ── 거래처계좌데이터 엔드포인트 ──────────────────────────────

    @router.get("/account-data")
    def get_account_data(_: str = Depends(get_current_user)):
        rows = _get_account_dicts()
        return {"ok": True, "rows": rows}

    @router.post("/account-data/save")
    def save_account_data(payload: dict = Body(...), _: str = Depends(get_current_user)):
        raw_rows = payload.get("rows")
        if not isinstance(raw_rows, list):
            raise HTTPException(status_code=400, detail="rows 형식이 올바르지 않습니다.")
        count = _save_account_dicts(raw_rows)
        return {"ok": True, "saved_count": count}

    @router.post("/account-data/append-paste")
    def append_account_data(payload: dict = Body(...), _: str = Depends(get_current_user)):
        pasted_rows = _parse_pasted_rows(payload.get("pasted_text", ""))
        skip_header = bool(payload.get("skip_header", False))
        source_rows = pasted_rows[1:] if skip_header else pasted_rows

        rows_to_add = []
        for row in source_rows:
            mapped = (
                _normalize_text(row[3] if len(row) > 3 else ""),  # D → A
                _normalize_text(row[0] if len(row) > 0 else ""),  # A → B
                _normalize_text(row[1] if len(row) > 1 else ""),  # B → C
                _normalize_text(row[4] if len(row) > 4 else ""),  # E → D
                _normalize_text(row[5] if len(row) > 5 else ""),  # F → E
                _normalize_text(row[7] if len(row) > 7 else ""),  # H → F
            )
            if any(mapped):
                rows_to_add.append(mapped)

        all_rows = _append_account_rows(rows_to_add)
        return {"ok": True, "added_count": len(rows_to_add), "rows": all_rows}

    # ── 매입차감 엔드포인트 ───────────────────────────────────────

    @router.post("/purchase-deduction/preview")
    def preview_purchase_deduction(payload: dict = Body(...), _: str = Depends(get_current_user)):
        pasted_rows = _parse_pasted_rows(payload.get("pasted_text", ""))
        account_dicts = _get_account_dicts()
        result = _build_purchase_deduction_result(
            pasted_rows,
            account_dicts,
            bool(payload.get("skip_source_header", False)),
        )
        return {"ok": True, **result}

    @router.post("/purchase-deduction/export")
    def export_purchase_deduction(payload: dict = Body(...), _: str = Depends(get_current_user)):
        pasted_rows = _parse_pasted_rows(payload.get("pasted_text", ""))
        account_dicts = _get_account_dicts()
        result = _build_purchase_deduction_result(
            pasted_rows,
            account_dicts,
            bool(payload.get("skip_source_header", False)),
        )

        matched_df = pd.DataFrame([
            {
                "A": str(row["A"]), "B": str(row["B"]), "C": row["C"],
                "D": str(row["D"]), "E": str(row["E"]), "F": str(row["F"]),
                "G": str(row["G"]), "H": str(row["H"]), "상태": row["status"],
            }
            for row in result["matched"]
        ])
        unmatched_df = pd.DataFrame([
            {"공급처": row["supplier"], "합계금액": row["total_amount"], "상태": row["status"]}
            for row in result["unmatched"]
        ])

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

    # ── 공용 복붙 저장 ────────────────────────────────────────────

    @router.get("/purchase-deduction/shared-paste")
    def get_purchase_deduction_shared_paste(
        slot: int = Query(1, ge=1, le=SHARED_PASTE_SLOT_COUNT),
        user: str = Depends(get_current_user),
    ):
        slot_no = _normalize_shared_paste_slot(slot)
        return {
            "ok": True,
            "slot": slot_no,
            "pasted_text": get_setting(_shared_paste_key(slot_no)) or "",
            "updated_by": get_setting(_shared_paste_updated_by_key(slot_no)) or "",
            "viewer": user,
        }

    @router.put("/purchase-deduction/shared-paste")
    def set_purchase_deduction_shared_paste(
        payload: dict = Body(...),
        slot: int = Query(1, ge=1, le=SHARED_PASTE_SLOT_COUNT),
        user: str = Depends(get_current_user),
    ):
        slot_no = _normalize_shared_paste_slot(slot)
        pasted_text = str(payload.get("pasted_text") or "")
        set_setting(_shared_paste_key(slot_no), pasted_text)
        set_setting(_shared_paste_updated_by_key(slot_no), user)
        return {"ok": True, "slot": slot_no, "pasted_text": pasted_text, "updated_by": user}

    return router
