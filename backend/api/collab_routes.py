import mimetypes
import re
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Body, Depends, File, Header, HTTPException, Form, UploadFile
from fastapi.responses import FileResponse


def build_collab_router(
    *,
    get_current_user,
    require_admin,
    get_current_user_optional,
    is_admin,
    get_db,
    get_user_display,
    is_visible_completed,
    get_request_attachments,
    row_to_request,
    row_to_shared_file,
    get_setting,
    set_setting,
    hash_pin,
    verify_pin,
    upload_base,
    shared_upload_base,
    allowed_request_exts,
    allowed_shared_exts,
    max_request_file_size_bytes=None,
    max_shared_file_size_bytes=None,
):
    router = APIRouter()
    # In-memory completion state for "today todos".
    # This is intentionally reset when the server restarts.
    my_todo_completed: dict[str, set[int]] = {}

    def _get_upload_size(file: UploadFile) -> int:
        current_pos = file.file.tell()
        file.file.seek(0, 2)
        size = int(file.file.tell())
        file.file.seek(current_pos)
        return size

    def _validate_files(files: list[UploadFile], allowed_exts, max_size_bytes: int | None):
        for f in files:
            ext = Path(f.filename or "").suffix.lower()
            if allowed_exts and ext not in allowed_exts:
                raise HTTPException(
                    status_code=400,
                    detail=f"unsupported file type: {ext or 'unknown'}",
                )
            if max_size_bytes and _get_upload_size(f) > max_size_bytes:
                raise HTTPException(
                    status_code=400,
                    detail=f"file too large: {f.filename or 'unknown'}",
                )

    def _create_request_row(
        *,
        requester_username: str,
        requester_display: str,
        assignee: str,
        assignee_display: str,
        text: str,
        files: list[UploadFile],
    ):
        created_at = datetime.now(timezone.utc).isoformat()
        conn = get_db()
        saved_paths: list[Path] = []
        try:
            cursor = conn.execute(
                """
                INSERT INTO requests (
                    requester_username, requester_display,
                    assignee_username, assignee_display,
                    text, status, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (requester_username, requester_display, assignee, assignee_display, text, "open", created_at),
            )
            request_id = cursor.lastrowid

            if files:
                request_dir = upload_base / str(request_id)
                request_dir.mkdir(parents=True, exist_ok=True)
                for f in files:
                    ext = Path(f.filename or "").suffix.lower()
                    stored_name = f"{uuid.uuid4().hex}{ext}"
                    target_path = request_dir / stored_name
                    with target_path.open("wb") as out:
                        shutil.copyfileobj(f.file, out)
                    saved_paths.append(target_path)

                    size = target_path.stat().st_size
                    mime = f.content_type or mimetypes.guess_type(f.filename or "")[0] or "application/octet-stream"
                    conn.execute(
                        """
                        INSERT INTO request_attachments (
                            request_id, original_name, stored_name, mime_type, size, created_at
                        ) VALUES (?, ?, ?, ?, ?, ?)
                        """,
                        (request_id, f.filename or stored_name, stored_name, mime, size, created_at),
                    )

            conn.commit()
        except HTTPException:
            conn.rollback()
            for path in saved_paths:
                try:
                    path.unlink(missing_ok=True)
                except Exception:
                    pass
            raise
        except Exception:
            conn.rollback()
            for path in saved_paths:
                try:
                    path.unlink(missing_ok=True)
                except Exception:
                    pass
            raise HTTPException(status_code=500, detail="failed to create request")
        finally:
            conn.close()

    @router.post("/requests")
    def create_request(
        assignee: str = Form(...),
        text: str = Form(...),
        files: list[UploadFile] | None = File(None),
        user: str = Depends(get_current_user),
    ):
        assignee = (assignee or "").strip()
        text = (text or "").strip()
        if not assignee or not text:
            raise HTTPException(status_code=400, detail="assignee/text required")

        files = files or []
        _validate_files(files, allowed_request_exts, max_request_file_size_bytes)

        requester_display = get_user_display(user)
        assignee_display = get_user_display(assignee)
        _create_request_row(
            requester_username=user,
            requester_display=requester_display,
            assignee=assignee,
            assignee_display=assignee_display,
            text=text,
            files=files,
        )

        return {"ok": True}

    @router.post("/requests/public/kimsungil")
    def create_public_request_for_kimsungil(
        text: str = Form(...),
        files: list[UploadFile] | None = File(None),
    ):
        text = (text or "").strip()
        if not text:
            raise HTTPException(status_code=400, detail="text required")

        files = files or []
        _validate_files(files, allowed_request_exts, max_request_file_size_bytes)

        conn = get_db()
        try:
            row = conn.execute(
                "SELECT username, display_name FROM users WHERE display_name = ? LIMIT 1",
                ("김승일",),
            ).fetchone()
            if not row:
                row = conn.execute(
                    "SELECT username, display_name FROM users WHERE display_name LIKE ? OR username LIKE ? LIMIT 1",
                    ("%김승일%", "%kimsungil%"),
                ).fetchone()
        finally:
            conn.close()

        if not row:
            raise HTTPException(status_code=400, detail="김승일 계정을 찾지 못했습니다.")

        assignee = row["username"]
        assignee_display = (row["display_name"] or "").strip() or "김승일"
        _create_request_row(
            requester_username="anonymous_mobile",
            requester_display="익명",
            assignee=assignee,
            assignee_display=assignee_display,
            text=text,
            files=files,
        )

        return {"ok": True}

    @router.get("/requests/{request_id}/attachments/{attachment_id}")
    def get_request_attachment(
        request_id: int,
        attachment_id: int,
        token: str | None = None,
        authorization: str | None = Header(None),
    ):
        user = get_current_user_optional(authorization, token)
        conn = get_db()
        req_row = conn.execute(
            "SELECT requester_username, assignee_username FROM requests WHERE id = ?",
            (request_id,),
        ).fetchone()
        if not req_row:
            conn.close()
            raise HTTPException(status_code=404, detail="request not found")
        if not (is_admin(user) or user in (req_row["requester_username"], req_row["assignee_username"])):
            conn.close()
            raise HTTPException(status_code=403, detail="forbidden")

        file_row = conn.execute(
            "SELECT * FROM request_attachments WHERE id = ? AND request_id = ?",
            (attachment_id, request_id),
        ).fetchone()
        conn.close()
        if not file_row:
            raise HTTPException(status_code=404, detail="attachment not found")

        file_path = upload_base / str(request_id) / file_row["stored_name"]
        if not file_path.exists():
            raise HTTPException(status_code=404, detail="file missing")

        return FileResponse(
            file_path,
            media_type=file_row["mime_type"],
            filename=file_row["original_name"],
        )

    @router.post("/shared-files")
    def upload_shared_file(
        file: UploadFile = File(...),
        user: str = Depends(get_current_user),
    ):
        try:
            _validate_files([file], allowed_shared_exts, max_shared_file_size_bytes)
        except HTTPException as exc:
            if exc.detail and "unsupported file type" in str(exc.detail):
                raise HTTPException(status_code=400, detail="지원 형식: xlsx, xls, csv") from exc
            raise

        created_at = datetime.now(timezone.utc).isoformat()
        uploader_display = get_user_display(user)
        stored_name = f"{uuid.uuid4().hex}{ext}"
        shared_upload_base.mkdir(parents=True, exist_ok=True)
        target_path = shared_upload_base / stored_name

        try:
            with target_path.open("wb") as out:
                shutil.copyfileobj(file.file, out)
            size = target_path.stat().st_size
            mime = file.content_type or mimetypes.guess_type(file.filename or "")[0] or "application/octet-stream"
            conn = get_db()
            conn.execute(
                """
                INSERT INTO shared_files (
                    original_name, stored_name, mime_type, size,
                    uploader_username, uploader_display, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    file.filename or stored_name,
                    stored_name,
                    mime,
                    size,
                    user,
                    uploader_display,
                    created_at,
                ),
            )
            conn.commit()
            conn.close()
        except Exception:
            try:
                target_path.unlink(missing_ok=True)
            except Exception:
                pass
            raise HTTPException(status_code=500, detail="파일 업로드 실패")

        return {"ok": True}

    @router.get("/shared-todos")
    def list_shared_todos(user: str = Depends(get_current_user)):
        conn = get_db()
        rows = conn.execute(
            """
            SELECT *
            FROM shared_todos
            ORDER BY (status = 'completed') ASC,
                     created_at ASC,
                     id ASC
            """
        ).fetchall()
        conn.close()
        items = []
        for row in rows:
            items.append(
                {
                    "id": row["id"],
                    "text": row["text"],
                    "status": row["status"],
                    "created_by_username": row["created_by_username"],
                    "created_by_display": row["created_by_display"] or "",
                    "created_at": row["created_at"],
                    "completed_by_username": row["completed_by_username"],
                    "completed_by_display": row["completed_by_display"] or "",
                    "completed_at": row["completed_at"],
                    "completed_comment": row["completed_comment"] or "",
                }
            )
        return {"ok": True, "todos": items}

    @router.post("/shared-todos")
    def create_shared_todo(payload: dict = Body(...), user: str = Depends(get_current_user)):
        text = (payload.get("text") or "").strip()
        if not text:
            raise HTTPException(status_code=400, detail="text required")
        now = datetime.now(timezone.utc).isoformat()
        created_by_display = get_user_display(user)
        conn = get_db()
        conn.execute(
            """
            INSERT INTO shared_todos (
                text, status,
                created_by_username, created_by_display, created_at
            ) VALUES (?, 'open', ?, ?, ?)
            """,
            (text, user, created_by_display, now),
        )
        conn.commit()
        conn.close()
        return {"ok": True}

    @router.post("/shared-todos/{todo_id}/complete")
    def complete_shared_todo(todo_id: int, payload: dict = Body(default={}), user: str = Depends(get_current_user)):
        completed_by_display = get_user_display(user)
        completed_comment = (payload.get("comment") or "").strip()
        conn = get_db()
        row = conn.execute("SELECT * FROM shared_todos WHERE id = ?", (todo_id,)).fetchone()
        if not row:
            conn.close()
            raise HTTPException(status_code=404, detail="todo not found")
        if row["status"] != "completed":
            conn.execute(
                """
                UPDATE shared_todos
                SET status = ?, completed_by_username = ?, completed_by_display = ?, completed_at = ?, completed_comment = ?
                WHERE id = ?
                """,
                ("completed", user, completed_by_display, datetime.now(timezone.utc).isoformat(), completed_comment, todo_id),
            )
            conn.commit()
        conn.close()
        return {"ok": True}

    @router.get("/my-todos")
    def list_my_todos(user: str = Depends(get_current_user)):
        conn = get_db()
        rows = conn.execute(
            """
            SELECT *
            FROM my_todos
            WHERE owner_username = ?
            ORDER BY created_at ASC,
                     id ASC
            """,
            (user,),
        ).fetchall()
        conn.close()
        completed_ids = my_todo_completed.get(user, set())
        items = []
        for row in rows:
            is_completed = int(row["id"]) in completed_ids
            items.append(
                {
                    "id": row["id"],
                    "text": row["text"],
                    "status": "completed" if is_completed else "open",
                    "owner_username": row["owner_username"],
                    "owner_display": row["owner_display"] or "",
                    "created_at": row["created_at"],
                    "completed_at": None,
                    "completed_comment": "",
                }
            )
        return {"ok": True, "todos": items}

    @router.post("/my-todos")
    def create_my_todo(payload: dict = Body(...), user: str = Depends(get_current_user)):
        text = (payload.get("text") or "").strip()
        if not text:
            raise HTTPException(status_code=400, detail="text required")
        now = datetime.now(timezone.utc).isoformat()
        owner_display = get_user_display(user)
        conn = get_db()
        conn.execute(
            """
            INSERT INTO my_todos (
                owner_username, owner_display, text, status, created_at
            ) VALUES (?, ?, ?, 'open', ?)
            """,
            (user, owner_display, text, now),
        )
        conn.commit()
        conn.close()
        return {"ok": True}

    @router.post("/my-todos/{todo_id}/complete")
    def complete_my_todo(todo_id: int, user: str = Depends(get_current_user)):
        conn = get_db()
        row = conn.execute(
            "SELECT * FROM my_todos WHERE id = ? AND owner_username = ?",
            (todo_id, user),
        ).fetchone()
        if not row:
            conn.close()
            raise HTTPException(status_code=404, detail="todo not found")
        conn.close()
        my_todo_completed.setdefault(user, set()).add(int(todo_id))
        return {"ok": True}

    @router.post("/my-todos/{todo_id}/uncomplete")
    def uncomplete_my_todo(todo_id: int, user: str = Depends(get_current_user)):
        conn = get_db()
        row = conn.execute(
            "SELECT * FROM my_todos WHERE id = ? AND owner_username = ?",
            (todo_id, user),
        ).fetchone()
        if not row:
            conn.close()
            raise HTTPException(status_code=404, detail="todo not found")
        conn.close()
        completed_ids = my_todo_completed.get(user)
        if completed_ids:
            completed_ids.discard(int(todo_id))
        return {"ok": True}

    @router.delete("/my-todos/{todo_id}")
    def delete_my_todo(todo_id: int, user: str = Depends(get_current_user)):
        conn = get_db()
        row = conn.execute(
            "SELECT id FROM my_todos WHERE id = ? AND owner_username = ?",
            (todo_id, user),
        ).fetchone()
        if not row:
            conn.close()
            raise HTTPException(status_code=404, detail="todo not found")
        conn.execute(
            "DELETE FROM my_todos WHERE id = ? AND owner_username = ?",
            (todo_id, user),
        )
        conn.commit()
        conn.close()
        completed_ids = my_todo_completed.get(user)
        if completed_ids:
            completed_ids.discard(int(todo_id))
        return {"ok": True}

    @router.get("/shared-files")
    def list_shared_files(user: str = Depends(get_current_user)):
        conn = get_db()
        rows = conn.execute(
            "SELECT * FROM shared_files ORDER BY created_at DESC"
        ).fetchall()
        conn.close()
        return {"ok": True, "files": [row_to_shared_file(r) for r in rows]}

    @router.get("/shared-files/{file_id}")
    def download_shared_file(
        file_id: int,
        token: str | None = None,
        authorization: str | None = Header(None),
    ):
        get_current_user_optional(authorization, token)
        conn = get_db()
        row = conn.execute("SELECT * FROM shared_files WHERE id = ?", (file_id,)).fetchone()
        conn.close()
        if not row:
            raise HTTPException(status_code=404, detail="file not found")

        file_path = shared_upload_base / row["stored_name"]
        if not file_path.exists():
            raise HTTPException(status_code=404, detail="file missing")

        return FileResponse(
            file_path,
            media_type=row["mime_type"],
            filename=row["original_name"],
        )

    @router.delete("/shared-files/{file_id}")
    def delete_shared_file(file_id: int, admin: str = Depends(require_admin)):
        conn = get_db()
        row = conn.execute("SELECT * FROM shared_files WHERE id = ?", (file_id,)).fetchone()
        if not row:
            conn.close()
            raise HTTPException(status_code=404, detail="file not found")
        conn.execute("DELETE FROM shared_files WHERE id = ?", (file_id,))
        conn.commit()
        conn.close()

        file_path = shared_upload_base / row["stored_name"]
        try:
            file_path.unlink(missing_ok=True)
        except Exception:
            pass

        return {"ok": True}

    @router.get("/requests/assigned")
    def get_assigned_requests(user: str = Depends(get_current_user)):
        target = user.strip()
        if not target:
            raise HTTPException(status_code=400, detail="assignee required")

        conn = get_db()
        rows = conn.execute(
            "SELECT * FROM requests WHERE assignee_username = ? ORDER BY created_at DESC",
            (target,),
        ).fetchall()
        conn.close()

        visible_rows = [
            row
            for row in rows
            if not (row["status"] == "completed" and not is_visible_completed(row["completed_at"]))
        ]
        attachments_map = get_request_attachments([row["id"] for row in visible_rows])

        items = []
        for row in visible_rows:
            item = row_to_request(row)
            item["can_complete"] = row["status"] == "open" and row["assignee_username"] == user
            item["attachments"] = attachments_map.get(row["id"], [])
            items.append(item)

        return {"ok": True, "assignee": target, "requests": items}

    @router.delete("/requests/assigned/clear")
    def clear_assigned_requests(user: str = Depends(get_current_user)):
        conn = get_db()
        conn.execute(
            "DELETE FROM requests WHERE assignee_username = ? AND status = 'completed'",
            (user,),
        )
        conn.commit()
        conn.close()
        return {"ok": True}

    @router.post("/requests/{request_id}/complete")
    def complete_request(request_id: int, user: str = Depends(get_current_user)):
        conn = get_db()
        row = conn.execute("SELECT * FROM requests WHERE id = ?", (request_id,)).fetchone()
        if not row:
            conn.close()
            raise HTTPException(status_code=404, detail="request not found")
        if row["assignee_username"] != user:
            conn.close()
            raise HTTPException(status_code=403, detail="forbidden")

        if row["status"] != "completed":
            conn.execute(
                "UPDATE requests SET status = ?, completed_at = ? WHERE id = ?",
                ("completed", datetime.now(timezone.utc).isoformat(), request_id),
            )
            conn.commit()
        conn.close()
        return {"ok": True}

    @router.get("/requests/resolved")
    def get_resolved_requests(user: str = Depends(get_current_user)):
        conn = get_db()
        rows = conn.execute(
            """
            SELECT * FROM requests
            WHERE requester_username = ?
            ORDER BY (status = 'completed') DESC,
                     completed_at DESC,
                     created_at DESC
            """,
            (user,),
        ).fetchall()
        conn.close()

        visible_rows = [
            row
            for row in rows
            if not (row["status"] == "completed" and not is_visible_completed(row["completed_at"]))
        ]
        attachments_map = get_request_attachments([row["id"] for row in visible_rows])

        items = []
        for row in visible_rows:
            item = row_to_request(row)
            item["can_ack"] = row["status"] == "completed" and row["acknowledged_at"] is None
            item["attachments"] = attachments_map.get(row["id"], [])
            items.append(item)

        return {"ok": True, "requests": items}

    @router.delete("/requests/sent/clear")
    def clear_sent_requests(user: str = Depends(get_current_user)):
        conn = get_db()
        conn.execute(
            "DELETE FROM requests WHERE requester_username = ? AND status = 'completed'",
            (user,),
        )
        conn.commit()
        conn.close()
        return {"ok": True}

    @router.post("/requests/{request_id}/ack")
    def acknowledge_request(request_id: int, user: str = Depends(get_current_user)):
        conn = get_db()
        row = conn.execute("SELECT * FROM requests WHERE id = ?", (request_id,)).fetchone()
        if not row:
            conn.close()
            raise HTTPException(status_code=404, detail="request not found")
        if row["requester_username"] != user:
            conn.close()
            raise HTTPException(status_code=403, detail="forbidden")

        conn.execute(
            "UPDATE requests SET acknowledged_at = ? WHERE id = ?",
            (datetime.now(timezone.utc).isoformat(), request_id),
        )
        conn.commit()
        conn.close()
        return {"ok": True}

    @router.get("/company-credentials")
    def list_company_credentials(user: str = Depends(get_current_user)):
        admin_flag = is_admin(user)
        conn = get_db()
        rows = conn.execute(
            "SELECT id, label, username, password, updated_at, created_at FROM company_credentials ORDER BY id DESC"
        ).fetchall()
        conn.close()
        items = []
        for row in rows:
            has_credentials = bool((row["username"] or "").strip() or (row["password"] or "").strip())
            item = {
                "id": row["id"],
                "label": row["label"],
                "has_credentials": has_credentials,
                "updated_at": row["updated_at"],
                "created_at": row["created_at"],
            }
            if admin_flag:
                item["username"] = row["username"] or ""
                item["password"] = row["password"] or ""
            items.append(item)
        return {"ok": True, "items": items}

    @router.get("/company-credentials/pin")
    def get_company_pin_status(user: str = Depends(get_current_user)):
        pin_hash = get_setting("company_pin_hash")
        return {"ok": True, "has_pin": bool(pin_hash)}

    @router.post("/company-credentials/pin")
    def set_company_pin(payload: dict = Body(...), admin: str = Depends(require_admin)):
        pin = (payload.get("pin") or "").strip()
        if not re.fullmatch(r"\d{4}", pin or ""):
            raise HTTPException(status_code=400, detail="4자리 PIN이 필요합니다.")
        set_setting("company_pin_hash", hash_pin(pin))
        return {"ok": True}

    @router.post("/company-credentials")
    def upsert_company_credentials(
        payload: dict = Body(...),
        admin: str = Depends(require_admin),
    ):
        label = (payload.get("label") or "").strip()
        username = (payload.get("username") or "").strip()
        password = (payload.get("password") or "").strip()
        cid = payload.get("id")

        if not label:
            raise HTTPException(status_code=400, detail="label이 필요합니다.")
        now = datetime.now(timezone.utc).isoformat()
        conn = get_db()
        if cid:
            row = conn.execute("SELECT id FROM company_credentials WHERE id = ?", (cid,)).fetchone()
            if not row:
                conn.close()
                raise HTTPException(status_code=404, detail="not found")
            conn.execute(
                """
                UPDATE company_credentials
                SET label = ?, username = ?, password = ?, updated_at = ?
                WHERE id = ?
                """,
                (label, username or None, password or None, now, cid),
            )
        else:
            conn.execute(
                """
                INSERT INTO company_credentials (label, username, password, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (label, username or None, password or None, now, now),
            )
        conn.commit()
        conn.close()
        return {"ok": True}

    @router.delete("/company-credentials/{cred_id}")
    def delete_company_credentials(cred_id: int, admin: str = Depends(require_admin)):
        conn = get_db()
        conn.execute("DELETE FROM company_credentials WHERE id = ?", (cred_id,))
        conn.commit()
        conn.close()
        return {"ok": True}

    @router.post("/company-credentials/{cred_id}/view")
    def view_company_credentials(
        cred_id: int,
        payload: dict = Body(...),
        user: str = Depends(get_current_user),
    ):
        pin = (payload.get("pin") or "").strip()
        if not re.fullmatch(r"\d{4}", pin or ""):
            raise HTTPException(status_code=400, detail="4자리 PIN이 필요합니다.")

        pin_hash = get_setting("company_pin_hash")
        if not pin_hash or not verify_pin(pin, pin_hash):
            raise HTTPException(status_code=403, detail="pin mismatch")

        conn = get_db()
        row = conn.execute("SELECT * FROM company_credentials WHERE id = ?", (cred_id,)).fetchone()
        conn.close()
        if not row:
            raise HTTPException(status_code=404, detail="not found")

        return {
            "ok": True,
            "label": row["label"],
            "username": row["username"] or "",
            "password": row["password"] or "",
            "updated_at": row["updated_at"],
        }

    return router
