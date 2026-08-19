from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Body, Depends, HTTPException

_KST = timezone(timedelta(hours=9))

_STATUSES = ("unassigned", "assigned", "in_progress", "done")


def _now() -> str:
    return datetime.now(_KST).isoformat()


def build_timebox_router(*, get_current_user, get_db, get_user_display):
    router = APIRouter(prefix="/timebox")

    def _row_to_issue(row) -> dict:
        return {
            "id": row["id"],
            "title": row["title"],
            "description": row["description"],
            "progress": row["progress"],
            "status": row["status"],
            "createdBy": row["created_by"],
            "createdByDisplay": get_user_display(row["created_by"]) or row["created_by"],
            "assignedTo": row["assigned_to"],
            "assignedToDisplay": (get_user_display(row["assigned_to"]) or row["assigned_to"]) if row["assigned_to"] else "",
            "assignedAt": row["assigned_at"],
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
        }

    def _row_to_comment(row) -> dict:
        return {
            "id": row["id"],
            "issueId": row["issue_id"],
            "author": row["author"],
            "authorDisplay": get_user_display(row["author"]) or row["author"],
            "content": row["content"],
            "createdAt": row["created_at"],
        }

    def _get_issue_or_404(conn, issue_id: int):
        row = conn.execute("SELECT * FROM timebox_issues WHERE id = ?", (issue_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="issue not found")
        return row

    @router.get("/members")
    def list_members(user: str = Depends(get_current_user)):
        conn = get_db()
        rows = conn.execute(
            "SELECT username FROM timebox_members ORDER BY added_at ASC"
        ).fetchall()
        conn.close()
        return {
            "ok": True,
            "members": [
                {"username": r["username"], "displayName": get_user_display(r["username"]) or r["username"]}
                for r in rows
            ],
        }

    @router.post("/members")
    def add_member(payload: dict = Body(...), user: str = Depends(get_current_user)):
        username = (payload.get("username") or "").strip()
        if not username:
            raise HTTPException(status_code=400, detail="추가할 사용자를 선택해주세요.")

        conn = get_db()
        existing = conn.execute(
            "SELECT username FROM timebox_members WHERE username = ?", (username,)
        ).fetchone()
        if not existing:
            conn.execute(
                "INSERT INTO timebox_members (username, added_at) VALUES (?, ?)",
                (username, _now()),
            )
            conn.commit()
        conn.close()
        return {"ok": True, "member": {"username": username, "displayName": get_user_display(username) or username}}

    @router.delete("/members/{username}")
    def remove_member(username: str, user: str = Depends(get_current_user)):
        conn = get_db()
        conn.execute("DELETE FROM timebox_members WHERE username = ?", (username,))
        conn.commit()
        conn.close()
        return {"ok": True}

    @router.get("/issues")
    def list_issues(user: str = Depends(get_current_user)):
        conn = get_db()
        rows = conn.execute(
            "SELECT * FROM timebox_issues ORDER BY created_at DESC"
        ).fetchall()
        conn.close()
        return {"ok": True, "issues": [_row_to_issue(r) for r in rows]}

    @router.post("/issues")
    def create_issue(payload: dict = Body(...), user: str = Depends(get_current_user)):
        title = (payload.get("title") or "").strip()
        if not title:
            raise HTTPException(status_code=400, detail="제목을 입력해주세요.")
        description = (payload.get("description") or "").strip()

        now = _now()
        conn = get_db()
        cur = conn.execute(
            """
            INSERT INTO timebox_issues (title, description, status, created_by, created_at, updated_at)
            VALUES (?, ?, 'unassigned', ?, ?, ?)
            """,
            (title, description, user, now, now),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM timebox_issues WHERE id = ?", (cur.lastrowid,)).fetchone()
        conn.close()
        return {"ok": True, "issue": _row_to_issue(row)}

    @router.patch("/issues/{issue_id}/progress")
    def update_issue_progress(issue_id: int, payload: dict = Body(...), user: str = Depends(get_current_user)):
        if "progress" not in payload:
            raise HTTPException(status_code=400, detail="progress가 필요합니다.")
        progress = (payload.get("progress") or "").strip()

        conn = get_db()
        row = _get_issue_or_404(conn, issue_id)
        if not row["assigned_to"] or user != row["assigned_to"]:
            conn.close()
            raise HTTPException(status_code=403, detail="배정된 담당자만 진행상황을 작성할 수 있습니다.")
        now = _now()
        conn.execute(
            "UPDATE timebox_issues SET progress = ?, updated_at = ? WHERE id = ?",
            (progress, now, issue_id),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM timebox_issues WHERE id = ?", (issue_id,)).fetchone()
        conn.close()
        return {"ok": True, "issue": _row_to_issue(row)}

    @router.patch("/issues/{issue_id}/assign")
    def assign_issue(issue_id: int, payload: dict = Body(...), user: str = Depends(get_current_user)):
        assignee = (payload.get("assignee") or "").strip()
        if not assignee:
            raise HTTPException(status_code=400, detail="담당자를 선택해주세요.")

        conn = get_db()
        _get_issue_or_404(conn, issue_id)
        now = _now()
        conn.execute(
            """
            UPDATE timebox_issues
            SET assigned_to = ?, status = 'assigned', assigned_at = ?, updated_at = ?
            WHERE id = ?
            """,
            (assignee, now, now, issue_id),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM timebox_issues WHERE id = ?", (issue_id,)).fetchone()
        conn.close()
        return {"ok": True, "issue": _row_to_issue(row)}

    @router.patch("/issues/{issue_id}/start")
    def start_issue(issue_id: int, user: str = Depends(get_current_user)):
        conn = get_db()
        row = _get_issue_or_404(conn, issue_id)
        if row["assigned_to"] != user:
            conn.close()
            raise HTTPException(status_code=403, detail="배정된 담당자만 진행중으로 전환할 수 있습니다.")
        now = _now()
        conn.execute(
            "UPDATE timebox_issues SET status = 'in_progress', updated_at = ? WHERE id = ?",
            (now, issue_id),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM timebox_issues WHERE id = ?", (issue_id,)).fetchone()
        conn.close()
        return {"ok": True, "issue": _row_to_issue(row)}

    @router.patch("/issues/{issue_id}/complete")
    def complete_issue(issue_id: int, user: str = Depends(get_current_user)):
        conn = get_db()
        row = _get_issue_or_404(conn, issue_id)
        if row["assigned_to"] != user:
            conn.close()
            raise HTTPException(status_code=403, detail="배정된 담당자만 완료 처리할 수 있습니다.")
        now = _now()
        conn.execute(
            "UPDATE timebox_issues SET status = 'done', updated_at = ? WHERE id = ?",
            (now, issue_id),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM timebox_issues WHERE id = ?", (issue_id,)).fetchone()
        conn.close()
        return {"ok": True, "issue": _row_to_issue(row)}

    @router.get("/issues/{issue_id}/comments")
    def list_comments(issue_id: int, user: str = Depends(get_current_user)):
        conn = get_db()
        _get_issue_or_404(conn, issue_id)
        rows = conn.execute(
            "SELECT * FROM timebox_comments WHERE issue_id = ? ORDER BY created_at ASC",
            (issue_id,),
        ).fetchall()
        conn.close()
        return {"ok": True, "comments": [_row_to_comment(r) for r in rows]}

    @router.post("/issues/{issue_id}/comments")
    def add_comment(issue_id: int, payload: dict = Body(...), user: str = Depends(get_current_user)):
        content = (payload.get("content") or "").strip()
        if not content:
            raise HTTPException(status_code=400, detail="코멘트 내용을 입력해주세요.")

        conn = get_db()
        _get_issue_or_404(conn, issue_id)
        now = _now()
        cur = conn.execute(
            "INSERT INTO timebox_comments (issue_id, author, content, created_at) VALUES (?, ?, ?, ?)",
            (issue_id, user, content, now),
        )
        conn.execute("UPDATE timebox_issues SET updated_at = ? WHERE id = ?", (now, issue_id))
        conn.commit()
        row = conn.execute("SELECT * FROM timebox_comments WHERE id = ?", (cur.lastrowid,)).fetchone()
        conn.close()
        return {"ok": True, "comment": _row_to_comment(row)}

    @router.delete("/issues/{issue_id}/comments/{comment_id}")
    def delete_comment(issue_id: int, comment_id: int, user: str = Depends(get_current_user)):
        conn = get_db()
        row = conn.execute(
            "SELECT * FROM timebox_comments WHERE id = ? AND issue_id = ?", (comment_id, issue_id)
        ).fetchone()
        if not row:
            conn.close()
            raise HTTPException(status_code=404, detail="comment not found")
        if row["author"] != user:
            conn.close()
            raise HTTPException(status_code=403, detail="본인 코멘트만 삭제할 수 있습니다.")
        conn.execute("DELETE FROM timebox_comments WHERE id = ?", (comment_id,))
        conn.commit()
        conn.close()
        return {"ok": True}

    return router
