import sqlite3
import json
from datetime import datetime, timezone

from fastapi import APIRouter, Body, Depends, HTTPException


def build_auth_admin_router(
    *,
    get_db,
    hash_password,
    verify_password,
    create_access_token,
    get_current_user,
    require_admin,
    count_admins,
    get_setting,
    set_setting,
):
    router = APIRouter()

    def _normalize_receiver(value: str) -> str:
        return "".join(ch for ch in str(value or "") if ch.isdigit())

    def _normalize_hhmm(value: str) -> str:
        raw = str(value or "").strip()
        if not raw:
            return ""
        parts = raw.split(":")
        if len(parts) != 2:
            raise HTTPException(status_code=400, detail="time must be in HH:MM format")
        try:
            hour = int(parts[0])
            minute = int(parts[1])
        except Exception:
            raise HTTPException(status_code=400, detail="time must be in HH:MM format")
        if hour < 0 or hour > 23 or minute < 0 or minute > 59:
            raise HTTPException(status_code=400, detail="time must be in HH:MM format")
        return f"{hour:02d}:{minute:02d}"

    @router.post("/auth/register")
    def register(payload: dict = Body(...)):
        username = (payload.get("username") or "").strip()
        password = (payload.get("password") or "").strip()
        display_name = (payload.get("display_name") or "").strip()
        if not username or not password or not display_name:
            raise HTTPException(status_code=400, detail="username/password/display_name required")

        conn = get_db()
        now = datetime.now(timezone.utc).isoformat()
        try:
            conn.execute(
                """
                INSERT INTO users (
                    username, password_hash, display_name, role,
                    created_at, approval_status
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                (username, hash_password(password), display_name, "user", now, "pending"),
            )
            conn.commit()
        except sqlite3.IntegrityError:
            raise HTTPException(status_code=400, detail="username already exists")
        finally:
            conn.close()

        return {"ok": True, "approval_status": "pending"}

    @router.options("/auth/register")
    def register_options():
        return {}

    @router.post("/auth/login")
    def login(payload: dict = Body(...)):
        username = (payload.get("username") or "").strip()
        password = (payload.get("password") or "").strip()
        if not username or not password:
            raise HTTPException(status_code=400, detail="username/password required")

        conn = get_db()
        row = conn.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
        conn.close()
        if not row or not verify_password(password, row["password_hash"]):
            raise HTTPException(status_code=401, detail="invalid credentials")
        approval_status = row["approval_status"] if row["approval_status"] else "approved"
        if approval_status == "pending":
            raise HTTPException(status_code=403, detail="관리자 승인 후 로그인 가능합니다.")
        if approval_status == "rejected":
            raise HTTPException(status_code=403, detail="승인 거절된 계정입니다.")

        token = create_access_token(username)
        role = row["role"] if row["role"] else "user"
        return {
            "ok": True,
            "token": token,
            "username": username,
            "display_name": row["display_name"],
            "phone_number": row["phone_number"] if row["phone_number"] else "",
            "role": role,
            "is_admin": role == "admin",
            "approval_status": approval_status,
        }

    @router.options("/auth/login")
    def login_options():
        return {}

    @router.get("/auth/me")
    def me(user: str = Depends(get_current_user)):
        conn = get_db()
        row = conn.execute(
            "SELECT display_name, role, approval_status, phone_number FROM users WHERE username = ?",
            (user,),
        ).fetchone()
        conn.close()
        display_name = row["display_name"] if row else ""
        role = row["role"] if row and row["role"] else "user"
        approval_status = row["approval_status"] if row and row["approval_status"] else "approved"
        return {
            "ok": True,
            "username": user,
            "display_name": display_name,
            "phone_number": row["phone_number"] if row and row["phone_number"] else "",
            "role": role,
            "is_admin": role == "admin",
            "approval_status": approval_status,
        }

    @router.options("/auth/me")
    def me_options():
        return {}

    @router.patch("/auth/profile")
    def update_profile(payload: dict = Body(...), user: str = Depends(get_current_user)):
        display_name = (payload.get("display_name") or "").strip()
        if not display_name:
            raise HTTPException(status_code=400, detail="display_name required")
        conn = get_db()
        conn.execute("UPDATE users SET display_name = ? WHERE username = ?", (display_name, user))
        conn.commit()
        conn.close()
        return {"ok": True, "username": user, "display_name": display_name}

    @router.get("/users")
    def list_users(user: str = Depends(get_current_user)):
        conn = get_db()
        rows = conn.execute(
            """
            SELECT username, display_name, phone_number
            FROM users
            WHERE approval_status = 'approved'
            ORDER BY username ASC
            """
        ).fetchall()
        conn.close()
        return {
            "ok": True,
            "users": [
                {
                    "username": r["username"],
                    "display_name": r["display_name"],
                    "phone_number": r["phone_number"] if r["phone_number"] else "",
                }
                for r in rows
            ],
        }

    @router.get("/admin/users")
    def admin_list_users(admin: str = Depends(require_admin)):
        conn = get_db()
        rows = conn.execute(
            """
            SELECT username, display_name, role, created_at,
                   approval_status, approved_at, approved_by, phone_number
            FROM users
            ORDER BY
                CASE approval_status
                    WHEN 'pending' THEN 0
                    WHEN 'rejected' THEN 1
                    ELSE 2
                END,
                username ASC
            """
        ).fetchall()
        conn.close()
        return {
            "ok": True,
            "users": [
                {
                    "username": r["username"],
                    "display_name": r["display_name"],
                    "role": r["role"] if r["role"] else "user",
                    "phone_number": r["phone_number"] if r["phone_number"] else "",
                    "created_at": r["created_at"],
                    "approval_status": r["approval_status"] if r["approval_status"] else "approved",
                    "approved_at": r["approved_at"],
                    "approved_by": r["approved_by"],
                }
                for r in rows
            ],
        }

    @router.patch("/admin/users/{target}/approval")
    def admin_set_approval(target: str, payload: dict = Body(...), admin: str = Depends(require_admin)):
        approval_status = (payload.get("approval_status") or "").strip()
        if approval_status not in ("approved", "rejected", "pending"):
            raise HTTPException(status_code=400, detail="invalid approval_status")

        conn = get_db()
        try:
            row = conn.execute("SELECT username FROM users WHERE username = ?", (target,)).fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="user not found")

            now = datetime.now(timezone.utc).isoformat()
            approved_at = now if approval_status == "approved" else None
            approved_by = admin if approval_status == "approved" else None
            conn.execute(
                """
                UPDATE users
                SET approval_status = ?, approved_at = ?, approved_by = ?
                WHERE username = ?
                """,
                (approval_status, approved_at, approved_by, target),
            )
            conn.commit()
        finally:
            conn.close()
        return {
            "ok": True,
            "username": target,
            "approval_status": approval_status,
            "approved_at": approved_at,
            "approved_by": approved_by,
        }

    @router.patch("/admin/users/{target}/role")
    def admin_set_role(target: str, payload: dict = Body(...), admin: str = Depends(require_admin)):
        role = (payload.get("role") or "").strip()
        if role not in ("admin", "user", "viewer"):
            raise HTTPException(status_code=400, detail="invalid role")

        conn = get_db()
        try:
            row = conn.execute("SELECT role FROM users WHERE username = ?", (target,)).fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="user not found")

            current_role = row["role"] if row["role"] else "user"
            if current_role == "admin" and role != "admin" and count_admins() <= 1:
                raise HTTPException(status_code=400, detail="cannot remove last admin")

            conn.execute("UPDATE users SET role = ? WHERE username = ?", (role, target))
            conn.commit()
        finally:
            conn.close()
        return {"ok": True, "username": target, "role": role}

    @router.patch("/admin/users/{target}/phone-number")
    def admin_set_phone_number(target: str, payload: dict = Body(...), admin: str = Depends(require_admin)):
        phone_number = _normalize_receiver(payload.get("phone_number") or "")
        conn = get_db()
        try:
            row = conn.execute("SELECT username FROM users WHERE username = ?", (target,)).fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="user not found")
            conn.execute("UPDATE users SET phone_number = ? WHERE username = ?", (phone_number, target))
            conn.commit()
        finally:
            conn.close()
        return {"ok": True, "username": target, "phone_number": phone_number}

    @router.get("/admin/users/{target}/menu-visibility")
    def admin_get_user_menu_visibility(target: str, admin: str = Depends(require_admin)):
        raw = get_setting(f"menu_hidden_tabs:{target}") or "[]"
        try:
            hidden_tabs = json.loads(raw)
        except Exception:
            hidden_tabs = []
        if not isinstance(hidden_tabs, list):
            hidden_tabs = []
        return {"ok": True, "username": target, "hidden_tabs": hidden_tabs}

    @router.patch("/admin/users/{target}/menu-visibility")
    def admin_set_user_menu_visibility(target: str, payload: dict = Body(...), admin: str = Depends(require_admin)):
        conn = get_db()
        row = conn.execute("SELECT username FROM users WHERE username = ?", (target,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="user not found")

        incoming = payload.get("hidden_tabs")
        if not isinstance(incoming, list):
            raise HTTPException(status_code=400, detail="hidden_tabs must be a list")
        clean = []
        for t in incoming:
            if isinstance(t, str):
                v = t.strip()
                if v and v != "settings" and v not in clean:
                    clean.append(v)
        set_setting(f"menu_hidden_tabs:{target}", json.dumps(clean, ensure_ascii=False))
        return {"ok": True, "username": target, "hidden_tabs": clean}

    @router.delete("/admin/users/{target}")
    def admin_delete_user(target: str, admin: str = Depends(require_admin)):
        if target == admin:
            raise HTTPException(status_code=400, detail="cannot delete self")

        conn = get_db()
        try:
            row = conn.execute("SELECT role FROM users WHERE username = ?", (target,)).fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="user not found")

            role = row["role"] if row["role"] else "user"
            if role == "admin" and count_admins() <= 1:
                raise HTTPException(status_code=400, detail="cannot delete last admin")

            conn.execute(
                "DELETE FROM requests WHERE requester_username = ? OR assignee_username = ?",
                (target, target),
            )
            conn.execute("DELETE FROM users WHERE username = ?", (target,))
            conn.commit()
        finally:
            conn.close()
        return {"ok": True}

    @router.get("/admin/request-sms-settings")
    def admin_get_request_sms_settings(admin: str = Depends(require_admin)):
        enabled_raw = (get_setting("request_sms_enabled") or "").strip().lower()
        receiver = _normalize_receiver(get_setting("request_sms_receiver") or "01095806927")
        start = (get_setting("request_sms_start") or "").strip()
        end = (get_setting("request_sms_end") or "").strip()
        return {
            "ok": True,
            "enabled": enabled_raw not in ("0", "false", "off", "no"),
            "receiver": receiver or "01095806927",
            "start": start,
            "end": end,
        }

    @router.patch("/admin/request-sms-settings")
    def admin_set_request_sms_settings(payload: dict = Body(...), admin: str = Depends(require_admin)):
        enabled = bool(payload.get("enabled", True))
        receiver = _normalize_receiver(payload.get("receiver") or "01095806927")
        start = _normalize_hhmm(payload.get("start") or "")
        end = _normalize_hhmm(payload.get("end") or "")

        if not receiver:
            raise HTTPException(status_code=400, detail="receiver required")
        if bool(start) != bool(end):
            raise HTTPException(status_code=400, detail="start and end must both be set")

        set_setting("request_sms_enabled", "1" if enabled else "0")
        set_setting("request_sms_receiver", receiver)
        set_setting("request_sms_start", start or None)
        set_setting("request_sms_end", end or None)

        return {
            "ok": True,
            "enabled": enabled,
            "receiver": receiver,
            "start": start,
            "end": end,
        }

    @router.get("/settings/menu-visibility")
    def get_menu_visibility(user: str = Depends(get_current_user)):
        raw = get_setting(f"menu_hidden_tabs:{user}") or "[]"
        try:
            hidden_tabs = json.loads(raw)
        except Exception:
            hidden_tabs = []
        if not isinstance(hidden_tabs, list):
            hidden_tabs = []
        clean = []
        for t in hidden_tabs:
            if isinstance(t, str):
                v = t.strip()
                if v and v != "settings" and v not in clean:
                    clean.append(v)
        return {"ok": True, "hidden_tabs": clean}

    @router.patch("/settings/menu-visibility")
    def set_menu_visibility(payload: dict = Body(...), user: str = Depends(get_current_user)):
        incoming = payload.get("hidden_tabs")
        if not isinstance(incoming, list):
            raise HTTPException(status_code=400, detail="hidden_tabs must be a list")
        clean = []
        for t in incoming:
            if isinstance(t, str):
                v = t.strip()
                if v and v != "settings" and v not in clean:
                    clean.append(v)
        set_setting(f"menu_hidden_tabs:{user}", json.dumps(clean, ensure_ascii=False))
        return {"ok": True, "hidden_tabs": clean}

    @router.get("/settings/menu-labels")
    def get_menu_labels(user: str = Depends(get_current_user)):
        raw = get_setting(f"menu_labels:{user}") or "{}"
        try:
            labels = json.loads(raw)
        except Exception:
            labels = {}
        if not isinstance(labels, dict):
            labels = {}
        clean = {}
        for k, v in labels.items():
            if isinstance(k, str) and isinstance(v, str):
                key = k.strip()
                val = v.strip()[:20]
                if key and val:
                    clean[key] = val
        return {"ok": True, "menu_labels": clean}

    @router.patch("/settings/menu-labels")
    def set_menu_labels(payload: dict = Body(...), user: str = Depends(get_current_user)):
        incoming = payload.get("menu_labels")
        if not isinstance(incoming, dict):
            raise HTTPException(status_code=400, detail="menu_labels must be an object")
        clean = {}
        for k, v in incoming.items():
            if isinstance(k, str) and isinstance(v, str):
                key = k.strip()
                val = v.strip()[:20]
                if key and val:
                    clean[key] = val
        set_setting(f"menu_labels:{user}", json.dumps(clean, ensure_ascii=False))
        return {"ok": True, "menu_labels": clean}

    @router.get("/settings/dashboard-layout")
    def get_dashboard_layout(user: str = Depends(get_current_user)):
        raw = get_setting(f"dashboard_layout:{user}") or "{}"
        try:
            layout = json.loads(raw)
        except Exception:
            layout = {}
        if not isinstance(layout, dict):
            layout = {}

        width = layout.get("activity_panel_width")
        if not isinstance(width, int):
            width = None
        elif width < 320 or width > 760:
            width = max(320, min(760, width))

        return {"ok": True, "activity_panel_width": width}

    @router.patch("/settings/dashboard-layout")
    def set_dashboard_layout(payload: dict = Body(...), user: str = Depends(get_current_user)):
        width = payload.get("activity_panel_width")
        if width is None:
            set_setting(f"dashboard_layout:{user}", json.dumps({}, ensure_ascii=False))
            return {"ok": True, "activity_panel_width": None}

        try:
            width = int(width)
        except Exception:
            raise HTTPException(status_code=400, detail="activity_panel_width must be an integer")

        width = max(320, min(760, width))
        set_setting(
            f"dashboard_layout:{user}",
            json.dumps({"activity_panel_width": width}, ensure_ascii=False),
        )
        return {"ok": True, "activity_panel_width": width}

    @router.get("/settings/barcode-label")
    def get_barcode_label_settings(user: str = Depends(get_current_user)):
        raw = get_setting(f"barcode_label:{user}") or "{}"
        try:
            data = json.loads(raw)
        except Exception:
            data = {}
        return {"ok": True, "sizes": data.get("sizes") or {}, "gaps": data.get("gaps") or {}}

    @router.patch("/settings/barcode-label")
    def set_barcode_label_settings(payload: dict = Body(...), user: str = Depends(get_current_user)):
        sizes = payload.get("sizes") or {}
        gaps  = payload.get("gaps")  or {}
        set_setting(
            f"barcode_label:{user}",
            json.dumps({"sizes": sizes, "gaps": gaps}, ensure_ascii=False),
        )
        return {"ok": True}

    return router
