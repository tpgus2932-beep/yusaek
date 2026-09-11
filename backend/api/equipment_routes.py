from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Body, Depends, HTTPException

from services.equipment_store import log_change, now_iso
from services.ezadmin_im00_client import fetch_im00_line_items, fetch_im00_vouchers

try:
    from sdk.ezadmin import EzAdminSessionExpired
except ModuleNotFoundError:  # package import in unit tests
    from backend.sdk.ezadmin import EzAdminSessionExpired

_MAX_VOUCHERS_PER_CALL = 8


def build_equipment_router(*, get_current_user, get_db, get_setting, get_user_display=None):
    router = APIRouter(prefix="/equipment")
    _display = get_user_display or (lambda u: u)

    def _row_to_item(row: dict) -> dict:
        return {
            "id": row["id"],
            "name": row["name"],
            "quantity": row["quantity"],
            "min_stock": row["min_stock"],
            "low_stock": row["quantity"] <= row["min_stock"],
            "created_by": row["created_by"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    @router.get("")
    def list_equipment(user: str = Depends(get_current_user)):
        conn = get_db()
        rows = conn.execute(
            "SELECT * FROM equipment_items ORDER BY name COLLATE NOCASE ASC"
        ).fetchall()
        conn.close()
        return {"ok": True, "items": [_row_to_item(r) for r in rows]}

    @router.post("")
    def create_equipment(payload: dict = Body(...), user: str = Depends(get_current_user)):
        name = str(payload.get("name") or "").strip()
        if not name:
            raise HTTPException(status_code=400, detail="비품명을 입력하세요")
        quantity = int(payload.get("quantity") or 0)
        min_stock = int(payload.get("min_stock") or 0)
        now = now_iso()
        conn = get_db()
        cur = conn.execute(
            """
            INSERT INTO equipment_items (name, quantity, min_stock, created_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (name, quantity, min_stock, user, now, now),
        )
        equipment_id = cur.lastrowid
        if quantity:
            log_change(
                conn,
                equipment_id=equipment_id,
                equipment_name=name,
                change_type="create",
                delta=quantity,
                before_qty=0,
                after_qty=quantity,
                created_by=user,
                reason="신규 등록",
            )
        conn.commit()
        conn.close()
        return {"ok": True}

    @router.patch("/{item_id}")
    def update_equipment(item_id: int, payload: dict = Body(...), user: str = Depends(get_current_user)):
        conn = get_db()
        row = conn.execute("SELECT * FROM equipment_items WHERE id = ?", (item_id,)).fetchone()
        if not row:
            conn.close()
            raise HTTPException(status_code=404, detail="비품을 찾을 수 없습니다")
        name = str(payload.get("name", row["name"]) or "").strip() or row["name"]
        min_stock = int(payload.get("min_stock", row["min_stock"]) or 0)
        conn.execute(
            "UPDATE equipment_items SET name = ?, min_stock = ?, updated_at = ? WHERE id = ?",
            (name, min_stock, now_iso(), item_id),
        )
        conn.commit()
        conn.close()
        return {"ok": True}

    @router.delete("/{item_id}")
    def delete_equipment(item_id: int, user: str = Depends(get_current_user)):
        conn = get_db()
        conn.execute("DELETE FROM equipment_items WHERE id = ?", (item_id,))
        conn.commit()
        conn.close()
        return {"ok": True}

    @router.post("/{item_id}/adjust")
    def adjust_equipment(item_id: int, payload: dict = Body(...), user: str = Depends(get_current_user)):
        delta = int(payload.get("delta") or 0)
        reason = str(payload.get("reason") or "").strip()
        if delta == 0:
            raise HTTPException(status_code=400, detail="변경 수량을 입력하세요")
        conn = get_db()
        row = conn.execute("SELECT * FROM equipment_items WHERE id = ?", (item_id,)).fetchone()
        if not row:
            conn.close()
            raise HTTPException(status_code=404, detail="비품을 찾을 수 없습니다")
        before_qty = row["quantity"]
        after_qty = before_qty + delta
        conn.execute(
            "UPDATE equipment_items SET quantity = ?, updated_at = ? WHERE id = ?",
            (after_qty, now_iso(), item_id),
        )
        log_change(
            conn,
            equipment_id=item_id,
            equipment_name=row["name"],
            change_type="manual",
            delta=delta,
            before_qty=before_qty,
            after_qty=after_qty,
            created_by=user,
            reason=reason,
        )
        conn.commit()
        conn.close()
        return {"ok": True, "quantity": after_qty}

    @router.get("/logs")
    def list_logs(limit: int = 50, offset: int = 0, user: str = Depends(get_current_user)):
        conn = get_db()
        rows = conn.execute(
            "SELECT * FROM equipment_logs ORDER BY id DESC LIMIT ? OFFSET ?",
            (limit, offset),
        ).fetchall()
        conn.close()
        return {
            "ok": True,
            "logs": [
                {
                    "id": r["id"],
                    "equipment_id": r["equipment_id"],
                    "equipment_name": r["equipment_name"],
                    "change_type": r["change_type"],
                    "delta": r["delta"],
                    "before_qty": r["before_qty"],
                    "after_qty": r["after_qty"],
                    "voucher_no": r["voucher_no"],
                    "matched_text": r["matched_text"],
                    "reason": r["reason"],
                    "created_by": r["created_by"],
                    "created_by_display": _display(r["created_by"]) if r["created_by"] else "",
                    "created_at": r["created_at"],
                }
                for r in rows
            ],
        }

    @router.get("/vouchers")
    async def list_vouchers(date: str = "", user: str = Depends(get_current_user)):
        date = date or datetime.now().strftime("%Y-%m-%d")
        try:
            vouchers = await fetch_im00_vouchers(get_setting, date=date)
        except EzAdminSessionExpired:
            return {"ok": False, "need_session": True}

        conn = get_db()
        processed_rows = conn.execute(
            "SELECT voucher_no FROM equipment_processed_vouchers"
        ).fetchall()
        conn.close()
        already_processed = {r["voucher_no"] for r in processed_rows}

        return {
            "ok": True,
            "date": date,
            "vouchers": [
                {
                    "sheet": v["sheet"],
                    "cell": v["cell"],
                    "already_processed": v["sheet"] in already_processed,
                }
                for v in vouchers
            ],
        }

    @router.post("/deduct-from-vouchers")
    async def deduct_from_vouchers(payload: dict = Body(...), user: str = Depends(get_current_user)):
        equipment_id = payload.get("equipment_id")
        sheets = [str(s).strip() for s in (payload.get("vouchers") or []) if str(s).strip()]
        date = str(payload.get("date") or datetime.now().strftime("%Y-%m-%d"))
        if not equipment_id:
            raise HTTPException(status_code=400, detail="비품을 선택하세요")
        if not sheets:
            raise HTTPException(status_code=400, detail="전표를 선택하세요")

        conn = get_db()
        row = conn.execute("SELECT * FROM equipment_items WHERE id = ?", (equipment_id,)).fetchone()
        if not row:
            conn.close()
            raise HTTPException(status_code=404, detail="비품을 찾을 수 없습니다")

        processed_rows = conn.execute(
            "SELECT voucher_no FROM equipment_processed_vouchers"
        ).fetchall()
        already_processed = {r["voucher_no"] for r in processed_rows}
        conn.close()

        pending_sheets = [s for s in sheets if s not in already_processed]
        skipped = [s for s in sheets if s in already_processed]
        batch = pending_sheets[:_MAX_VOUCHERS_PER_CALL]
        remaining = len(pending_sheets) - len(batch)

        deductions: list[dict] = []
        failed: list[dict] = []

        conn = get_db()
        try:
            for sheet in batch:
                try:
                    line_items = await fetch_im00_line_items(get_setting, sheet=sheet, date=date)
                except EzAdminSessionExpired:
                    conn.commit()
                    conn.close()
                    return {
                        "ok": False,
                        "need_session": True,
                        "deductions": deductions,
                        "failed": failed,
                        "skipped": skipped,
                    }
                except Exception as exc:
                    failed.append({"voucher_no": sheet, "reason": str(exc)})
                    continue

                total_qty = sum(li["qty"] for li in line_items)
                if total_qty <= 0:
                    conn.execute(
                        "INSERT OR REPLACE INTO equipment_processed_vouchers (voucher_no, processed_at, processed_by, matched_count) "
                        "VALUES (?, ?, ?, 0)",
                        (sheet, now_iso(), user),
                    )
                    failed.append({"voucher_no": sheet, "reason": "품목/수량을 찾지 못했습니다"})
                    continue

                summary = "; ".join(f"{li['name']} x{li['qty']}" for li in line_items[:10])

                current = conn.execute("SELECT * FROM equipment_items WHERE id = ?", (equipment_id,)).fetchone()
                before_qty = current["quantity"]
                after_qty = before_qty - total_qty
                conn.execute(
                    "UPDATE equipment_items SET quantity = ?, updated_at = ? WHERE id = ?",
                    (after_qty, now_iso(), equipment_id),
                )
                log_change(
                    conn,
                    equipment_id=equipment_id,
                    equipment_name=current["name"],
                    change_type="voucher",
                    delta=-total_qty,
                    before_qty=before_qty,
                    after_qty=after_qty,
                    created_by=user,
                    voucher_no=sheet,
                    matched_text=summary,
                )
                conn.execute(
                    "INSERT OR REPLACE INTO equipment_processed_vouchers (voucher_no, processed_at, processed_by, matched_count) "
                    "VALUES (?, ?, ?, 1)",
                    (sheet, now_iso(), user),
                )
                deductions.append({
                    "voucher_no": sheet,
                    "deducted_qty": total_qty,
                    "before_qty": before_qty,
                    "after_qty": after_qty,
                    "summary": summary,
                })

            conn.commit()
        finally:
            conn.close()

        return {
            "ok": True,
            "deductions": deductions,
            "failed": failed,
            "skipped": skipped,
            "remaining": remaining,
        }

    return router
