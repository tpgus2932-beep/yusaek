from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Body, Depends, HTTPException


def build_return_special_notes_router(*, get_current_user, get_db, clean_invoice):
    router = APIRouter(prefix="/return-special-notes")

    def _list_payload() -> dict:
        conn = get_db()
        try:
            rows = conn.execute(
                "SELECT * FROM return_special_notes ORDER BY created_at DESC"
            ).fetchall()
        finally:
            conn.close()
        return {
            "items": [
                {
                    "id": r["id"],
                    "invoiceNo": r["invoice_no"],
                    "note": r["note"],
                    "createdBy": r["created_by"],
                    "createdAt": r["created_at"],
                }
                for r in rows
            ]
        }

    @router.get("/list")
    def list_special_notes(user: str = Depends(get_current_user)):
        return _list_payload()

    @router.post("/add")
    def add_special_note(payload: dict = Body(...), user: str = Depends(get_current_user)):
        invoice_no = clean_invoice(payload.get("invoice_no"))
        note = str(payload.get("note") or "").strip()
        if not invoice_no:
            raise HTTPException(status_code=400, detail="원송장번호를 입력하세요.")
        if not note:
            raise HTTPException(status_code=400, detail="특이사항 내용을 입력하세요.")

        conn = get_db()
        try:
            conn.execute(
                """
                INSERT INTO return_special_notes (invoice_no, note, created_by, created_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(invoice_no) DO UPDATE SET
                    note = excluded.note,
                    created_by = excluded.created_by,
                    created_at = excluded.created_at
                """,
                (invoice_no, note, user, datetime.now(timezone.utc).isoformat()),
            )
            conn.commit()
        finally:
            conn.close()
        return _list_payload()

    @router.delete("/{note_id}")
    def delete_special_note(note_id: int, user: str = Depends(get_current_user)):
        conn = get_db()
        try:
            conn.execute("DELETE FROM return_special_notes WHERE id = ?", (note_id,))
            conn.commit()
        finally:
            conn.close()
        return {"ok": True}

    return router
