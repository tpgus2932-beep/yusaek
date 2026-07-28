from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Body, Depends, HTTPException

_KST = timezone(timedelta(hours=9))


def build_return_processing_log_router(
    *,
    get_current_user,
    get_shared_db,
):
    router = APIRouter(prefix="/returns/processing-log")

    @router.post("")
    def add_processing_log(payload: dict = Body(...), user: str = Depends(get_current_user)):
        queue = str(payload.get("queue") or "").strip()
        action = str(payload.get("action") or "").strip()
        action_label = str(payload.get("action_label") or "").strip()
        entries = payload.get("entries") or []
        if not queue or not action or not entries:
            raise HTTPException(status_code=400, detail="queue/action/entries가 필요합니다.")

        now = datetime.now(_KST).isoformat()
        conn = get_shared_db()
        try:
            for entry in entries:
                conn.execute(
                    """
                    INSERT INTO return_processing_log
                        (created_at, username, queue, action, action_label,
                         item_text, qty, type, reason, detail_reason, images, ezadmin_seq, status)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        now,
                        user,
                        queue,
                        action,
                        action_label,
                        str(entry.get("item_text") or ""),
                        str(entry.get("qty") or ""),
                        str(entry.get("type") or ""),
                        str(entry.get("reason") or ""),
                        str(entry.get("detail_reason") or ""),
                        json.dumps(entry.get("images") or [], ensure_ascii=False),
                        str(entry.get("ezadmin_seq") or ""),
                        str(entry.get("status") or ""),
                    ),
                )
            conn.commit()
        finally:
            conn.close()
        return {"ok": True}

    @router.get("")
    def list_processing_log(
        queue: str | None = None,
        action: str | None = None,
        date_from: str | None = None,
        date_to: str | None = None,
        q: str | None = None,
        limit: int = 200,
        user: str = Depends(get_current_user),
    ):
        conditions = []
        params: list = []
        if queue:
            conditions.append("queue = ?")
            params.append(queue)
        if action:
            conditions.append("action = ?")
            params.append(action)
        if date_from:
            conditions.append("created_at >= ?")
            params.append(date_from)
        if date_to:
            conditions.append("created_at <= ?")
            params.append(f"{date_to}T23:59:59")
        if q:
            conditions.append("(item_text LIKE ? OR ezadmin_seq LIKE ?)")
            like = f"%{q}%"
            params.extend([like, like])

        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
        conn = get_shared_db()
        try:
            rows = conn.execute(
                f"SELECT * FROM return_processing_log {where} ORDER BY created_at DESC LIMIT ?",
                (*params, limit),
            ).fetchall()
        finally:
            conn.close()

        items = []
        for row in rows:
            item = dict(row)
            try:
                item["images"] = json.loads(item.get("images") or "[]")
            except (TypeError, ValueError):
                item["images"] = []
            items.append(item)
        return {"items": items}

    return router
