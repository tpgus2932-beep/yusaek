import mimetypes
import os
import re
import shutil
import threading
import time
import uuid
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import httpx
from fastapi import APIRouter, Body, Depends, File, Header, HTTPException, Form, Request, UploadFile
from fastapi.responses import FileResponse

KST = ZoneInfo("Asia/Seoul")


def build_collab_router(
    *,
    get_current_user,
    require_admin,
    get_current_user_optional,
    is_admin,
    get_db,
    get_local_db=None,  # my_todos 전용 로컬 DB (없으면 get_db 사용)
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
    enqueue_sms=None,  # SMS 큐에 직접 넣는 함수 (sms_routes._enqueue_sms)
):
    router = APIRouter()
    # In-memory completion state for "today todos".
    # This is intentionally reset when the server restarts.
    my_todo_completed: dict[str, set[int]] = {}
    # 공개 엔드포인트 레이트 리밋 (IP당 분당 최대 5회)
    _public_rate_store: dict[str, list[float]] = defaultdict(list)
    _PUBLIC_RATE_MAX = 5
    _PUBLIC_RATE_WINDOW = 60.0

    def _check_public_rate_limit(client_ip: str) -> None:
        now = time.time()
        recent = [t for t in _public_rate_store[client_ip] if now - t < _PUBLIC_RATE_WINDOW]
        if len(recent) >= _PUBLIC_RATE_MAX:
            raise HTTPException(status_code=429, detail="요청이 너무 많습니다. 잠시 후 다시 시도해주세요.")
        recent.append(now)
        _public_rate_store[client_ip] = recent
    # my_todos는 개인 데이터 → 로컬 DB 우선
    _local_db = get_local_db if get_local_db is not None else get_db

    def _normalize_receiver(value: str) -> str:
        return "".join(ch for ch in str(value or "") if ch.isdigit())

    def _parse_hhmm(raw: str) -> tuple[int, int] | None:
        value = str(raw or "").strip()
        if not value:
            return None
        match = re.fullmatch(r"(\d{1,2}):(\d{2})", value)
        if not match:
            return None
        hour = int(match.group(1))
        minute = int(match.group(2))
        if hour < 0 or hour > 23 or minute < 0 or minute > 59:
            return None
        return hour, minute

    def _is_request_sms_time_allowed() -> bool:
        enabled_raw = (get_setting("request_sms_enabled") or os.environ.get("REQUEST_SMS_ENABLED", "1")).strip().lower()
        if enabled_raw in ("0", "false", "off", "no"):
            return False

        start = _parse_hhmm(get_setting("request_sms_start") or os.environ.get("REQUEST_SMS_START", ""))
        end = _parse_hhmm(get_setting("request_sms_end") or os.environ.get("REQUEST_SMS_END", ""))
        if not start or not end:
            return True

        now = datetime.now(KST)
        now_minutes = now.hour * 60 + now.minute
        start_minutes = start[0] * 60 + start[1]
        end_minutes = end[0] * 60 + end[1]

        if start_minutes == end_minutes:
            return True
        if start_minutes < end_minutes:
            return start_minutes <= now_minutes < end_minutes
        return now_minutes >= start_minutes or now_minutes < end_minutes

    def _build_request_sms_message(
        *,
        requester_display: str,
        assignee_display: str,
        text: str,
    ) -> str:
        preview = " ".join((text or "").split())
        if len(preview) > 60:
            preview = f"{preview[:57]}..."
        return f"[요청알림]\n보낸사람: {requester_display}\n담당자: {assignee_display}\n내용: {preview}"

    async def _post_request_sms_webhook_async(
        *,
        receiver: str,
        fallback_receiver: str,
        requester_display: str,
        assignee_display: str,
        text: str,
    ) -> None:
        webhook_url = (os.environ.get("REQUEST_SMS_WEBHOOK_URL") or "").strip()
        if not webhook_url:
            return
        headers = {}
        token = (os.environ.get("REQUEST_SMS_WEBHOOK_TOKEN") or "").strip()
        if token:
            headers["X-Internal-Token"] = token
        async with httpx.AsyncClient(timeout=15.0) as client:
            await client.post(
                webhook_url,
                json={
                    "receiver": receiver,
                    "fallback_receiver": fallback_receiver,
                    "requester_display": requester_display,
                    "assignee_display": assignee_display,
                    "text": text,
                },
                headers=headers,
            )

    async def _send_request_sms_direct_async(
        *,
        receiver: str,
        requester_display: str,
        assignee_display: str,
        text: str,
    ) -> None:
        key = os.environ.get("ALIGO_API_KEY", "").strip()
        user_id = os.environ.get("ALIGO_USER_ID", "").strip()
        sender = os.environ.get("ALIGO_SENDER", "").strip()
        if not key or not user_id or not sender:
            return
        async with httpx.AsyncClient(timeout=15.0) as client:
            await client.post(
                "https://apis.aligo.in/send/",
                data={
                    "key": key,
                    "user_id": user_id,
                    "sender": sender,
                    "receiver": receiver,
                    "msg": _build_request_sms_message(
                        requester_display=requester_display,
                        assignee_display=assignee_display,
                        text=text,
                    ),
                    "msg_type": "LMS",
                    "title": "새 요청 알림",
                },
            )

    def _send_request_sms_best_effort(
        *,
        receiver: str,
        fallback_receiver: str,
        requester_display: str,
        assignee_display: str,
        text: str,
    ) -> None:
        receiver = _normalize_receiver(receiver)
        fallback_receiver = _normalize_receiver(fallback_receiver)
        if not (receiver or fallback_receiver) or not _is_request_sms_time_allowed():
            return
        def _runner() -> None:
            try:
                target_receiver = receiver or fallback_receiver
                if not target_receiver:
                    return
                msg = _build_request_sms_message(
                    requester_display=requester_display,
                    assignee_display=assignee_display,
                    text=text,
                )
                if enqueue_sms:
                    # sms_outbox 큐에 직접 등록 → 로컬 디스패처가 Aligo로 발송
                    enqueue_sms(
                        {
                            "receiver": target_receiver,
                            "msg": msg,
                            "msg_type": "LMS",
                            "title": "새 요청 알림",
                        },
                        "request-notify",
                    )
                    return
                import asyncio
                asyncio.run(
                    _send_request_sms_direct_async(
                        receiver=target_receiver,
                        requester_display=requester_display,
                        assignee_display=assignee_display,
                        text=text,
                    )
                )
            except Exception:
                # Keep request creation successful even if SMS delivery fails.
                return

        threading.Thread(target=_runner, daemon=True).start()

    def _get_user_phone_number(username: str) -> str:
        conn = get_db()
        try:
            row = conn.execute("SELECT phone_number FROM users WHERE username = ?", (username,)).fetchone()
            return _normalize_receiver(row["phone_number"]) if row and row["phone_number"] else ""
        finally:
            conn.close()

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
            row = conn.execute("SELECT * FROM requests WHERE id = ?", (request_id,)).fetchone()
            attachments = get_request_attachments([request_id]).get(request_id, [])
            item = row_to_request(row) if row else {"id": request_id}
            item["attachments"] = attachments
            item["can_complete"] = item.get("status") == "open" and assignee == requester_username
            item["can_ack"] = False
            return item
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
        item = _create_request_row(
            requester_username=user,
            requester_display=requester_display,
            assignee=assignee,
            assignee_display=assignee_display,
            text=text,
            files=files,
        )
        _send_request_sms_best_effort(
            receiver=_get_user_phone_number(assignee),
            fallback_receiver=str(get_setting("request_sms_receiver") or ""),
            requester_display=requester_display,
            assignee_display=assignee_display,
            text=text,
        )

        return {"ok": True, "request": item}

    @router.post("/requests/public/kimsungil")
    def create_public_request_for_kimsungil(
        request: Request,
        text: str = Form(...),
        files: list[UploadFile] | None = File(None),
    ):
        _check_public_rate_limit(request.client.host if request.client else "unknown")
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
        item = _create_request_row(
            requester_username="anonymous_mobile",
            requester_display="익명",
            assignee=assignee,
            assignee_display=assignee_display,
            text=text,
            files=files,
        )
        _send_request_sms_best_effort(
            receiver=_get_user_phone_number(assignee),
            fallback_receiver=str(get_setting("request_sms_receiver") or ""),
            requester_display="익명",
            assignee_display=assignee_display,
            text=text,
        )

        return {"ok": True, "request": item}

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
        ext = Path(file.filename or "").suffix.lower()
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
        conn = _local_db()
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
        conn = _local_db()
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
        conn = _local_db()
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
        conn = _local_db()
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
        conn = _local_db()
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

    @router.patch("/requests/{request_id}")
    def edit_request(request_id: int, payload: dict = Body(...), user: str = Depends(get_current_user)):
        text = (payload.get("text") or "").strip()
        if not text:
            raise HTTPException(status_code=400, detail="text required")
        conn = get_db()
        try:
            row = conn.execute("SELECT * FROM requests WHERE id = ?", (request_id,)).fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="request not found")
            if row["requester_username"] != user:
                raise HTTPException(status_code=403, detail="forbidden")
            if row["status"] != "open":
                raise HTTPException(status_code=400, detail="완료된 요청은 수정할 수 없습니다")
            conn.execute("UPDATE requests SET text = ? WHERE id = ?", (text, request_id))
            conn.commit()
        finally:
            conn.close()
        return {"ok": True}

    @router.delete("/requests/{request_id}")
    def delete_request(request_id: int, user: str = Depends(get_current_user)):
        conn = get_db()
        try:
            row = conn.execute("SELECT * FROM requests WHERE id = ?", (request_id,)).fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="request not found")
            if row["requester_username"] != user:
                raise HTTPException(status_code=403, detail="forbidden")
            if row["status"] != "open":
                raise HTTPException(status_code=400, detail="완료된 요청은 삭제할 수 없습니다")
            conn.execute("DELETE FROM request_attachments WHERE request_id = ?", (request_id,))
            conn.execute("DELETE FROM requests WHERE id = ?", (request_id,))
            conn.commit()
        finally:
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

    @router.patch("/requests/{request_id}/comment")
    def update_request_comment(request_id: int, payload: dict = Body(...), user: str = Depends(get_current_user)):
        comment = str(payload.get("comment") or "").strip()
        conn = get_db()
        try:
            row = conn.execute("SELECT id FROM requests WHERE id = ?", (request_id,)).fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="request not found")
            conn.execute("UPDATE requests SET comment = ? WHERE id = ?", (comment, request_id))
            conn.commit()
        finally:
            conn.close()
        return {"ok": True, "comment": comment}

    @router.get("/client-schedule/db")
    def get_client_schedule_db(user: str = Depends(get_current_user)):
        conn = get_db()
        try:
            rows = conn.execute(
                "SELECT row_a,row_b,row_c,row_d,row_e,row_f,row_g,row_h,saved_at FROM client_schedule_db ORDER BY id"
            ).fetchall()
        finally:
            conn.close()
        items = [
            {"A": r["row_a"], "B": r["row_b"], "C": r["row_c"],
             "D": r["row_d"], "E": r["row_e"], "F": r["row_f"],
             "G": r["row_g"], "H": r["row_h"]}
            for r in rows
        ]
        saved_at = rows[-1]["saved_at"] if rows else None
        return {"ok": True, "rows": items, "saved_at": saved_at, "count": len(items)}

    @router.put("/client-schedule/db")
    def save_client_schedule_db(payload: dict = Body(...), user: str = Depends(get_current_user)):
        rows = payload.get("rows") or []
        now = datetime.now(timezone.utc).isoformat()
        conn = get_db()
        try:
            conn.execute("DELETE FROM client_schedule_db")
            for row in rows:
                conn.execute(
                    "INSERT INTO client_schedule_db (row_a,row_b,row_c,row_d,row_e,row_f,row_g,row_h,saved_at) VALUES (?,?,?,?,?,?,?,?,?)",
                    (str(row.get("A","")), str(row.get("B","")), str(row.get("C","")),
                     str(row.get("D","")), str(row.get("E","")), str(row.get("F","")),
                     str(row.get("G","")), str(row.get("H","")), now),
                )
            conn.commit()
        finally:
            conn.close()
        return {"ok": True, "saved_at": now, "count": len(rows)}

    @router.delete("/client-schedule/db")
    def clear_client_schedule_db(user: str = Depends(get_current_user)):
        conn = get_db()
        try:
            conn.execute("DELETE FROM client_schedule_db")
            conn.commit()
        finally:
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
