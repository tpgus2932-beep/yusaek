from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Body, Depends, HTTPException

_KST = timezone(timedelta(hours=9))
_STALE_HOURS = 6


def _now() -> str:
    return datetime.now(_KST).isoformat()


def build_worklog_router(*, get_current_user, get_db, get_user_display):
    router = APIRouter(prefix="/worklog")

    def _row_to_entry(row) -> dict:
        return {
            "id": row["id"],
            "username": row["username"],
            "displayName": get_user_display(row["username"]) or row["username"],
            "task": row["task"],
            "startedAt": row["started_at"],
            "endedAt": row["ended_at"],
            "notes": row["notes"],
            "status": row["status"],
            "createdAt": row["created_at"],
        }

    def _auto_complete_stale(conn) -> None:
        # started_at is always an ISO string with a fixed +09:00 offset, so
        # lexical comparison against another such string is safe.
        cutoff = (datetime.now(_KST) - timedelta(hours=_STALE_HOURS)).isoformat()
        stale_rows = conn.execute(
            "SELECT id, started_at FROM worklog_entries WHERE status = 'in_progress' AND started_at <= ?",
            (cutoff,),
        ).fetchall()
        for r in stale_rows:
            ended_at = (datetime.fromisoformat(r["started_at"]) + timedelta(hours=_STALE_HOURS)).isoformat()
            conn.execute(
                "UPDATE worklog_entries SET ended_at = ?, status = 'done' WHERE id = ?",
                (ended_at, r["id"]),
            )
        if stale_rows:
            conn.commit()

    @router.get("/entries")
    def list_entries(date: str | None = None, user: str = Depends(get_current_user)):
        conn = get_db()
        _auto_complete_stale(conn)
        if date:
            rows = conn.execute(
                "SELECT * FROM worklog_entries WHERE started_at LIKE ? ORDER BY started_at DESC",
                (f"{date}%",),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM worklog_entries ORDER BY started_at DESC LIMIT 300"
            ).fetchall()
        conn.close()
        return {"ok": True, "entries": [_row_to_entry(r) for r in rows]}

    @router.get("/active")
    def get_active_entries(user: str = Depends(get_current_user)):
        conn = get_db()
        _auto_complete_stale(conn)
        rows = conn.execute(
            "SELECT * FROM worklog_entries WHERE username = ? AND status = 'in_progress' ORDER BY started_at DESC",
            (user,),
        ).fetchall()
        conn.close()
        return {"ok": True, "entries": [_row_to_entry(r) for r in rows]}

    @router.post("/entries")
    def start_entry(payload: dict = Body(...), user: str = Depends(get_current_user)):
        task = (payload.get("task") or "").strip()
        if not task:
            raise HTTPException(status_code=400, detail="할 일을 입력해주세요.")

        conn = get_db()
        _auto_complete_stale(conn)

        now = _now()
        cur = conn.execute(
            """
            INSERT INTO worklog_entries (username, task, started_at, status, created_at)
            VALUES (?, ?, ?, 'in_progress', ?)
            """,
            (user, task, now, now),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM worklog_entries WHERE id = ?", (cur.lastrowid,)).fetchone()
        conn.close()
        return {"ok": True, "entry": _row_to_entry(row)}

    @router.patch("/entries/{entry_id}/complete")
    def complete_entry(entry_id: int, payload: dict = Body(default={}), user: str = Depends(get_current_user)):
        notes = (payload.get("notes") or "").strip()

        conn = get_db()
        row = conn.execute("SELECT * FROM worklog_entries WHERE id = ?", (entry_id,)).fetchone()
        if not row:
            conn.close()
            raise HTTPException(status_code=404, detail="entry not found")
        if row["status"] != "in_progress":
            conn.close()
            raise HTTPException(status_code=400, detail="이미 완료된 작업입니다.")

        now = _now()
        conn.execute(
            "UPDATE worklog_entries SET ended_at = ?, notes = ?, status = 'done' WHERE id = ?",
            (now, notes, entry_id),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM worklog_entries WHERE id = ?", (entry_id,)).fetchone()
        conn.close()
        return {"ok": True, "entry": _row_to_entry(row)}

    return router
