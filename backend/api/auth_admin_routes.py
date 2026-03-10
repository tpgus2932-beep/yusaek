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
            "SELECT display_name, role, approval_status FROM users WHERE username = ?",
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
            SELECT username, display_name
            FROM users
            WHERE approval_status = 'approved'
            ORDER BY username ASC
            """
        ).fetchall()
        conn.close()
        return {"ok": True, "users": [{"username": r["username"], "display_name": r["display_name"]} for r in rows]}

    @router.get("/admin/users")
    def admin_list_users(admin: str = Depends(require_admin)):
        conn = get_db()
        rows = conn.execute(
            """
            SELECT username, display_name, role, created_at,
                   approval_status, approved_at, approved_by
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
        row = conn.execute("SELECT username FROM users WHERE username = ?", (target,)).fetchone()
        if not row:
            conn.close()
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
        row = conn.execute("SELECT role FROM users WHERE username = ?", (target,)).fetchone()
        if not row:
            conn.close()
            raise HTTPException(status_code=404, detail="user not found")

        current_role = row["role"] if row["role"] else "user"
        if current_role == "admin" and role != "admin" and count_admins() <= 1:
            conn.close()
            raise HTTPException(status_code=400, detail="cannot remove last admin")

        conn.execute("UPDATE users SET role = ? WHERE username = ?", (role, target))
        conn.commit()
        conn.close()
        return {"ok": True, "username": target, "role": role}

    @router.delete("/admin/users/{target}")
    def admin_delete_user(target: str, admin: str = Depends(require_admin)):
        if target == admin:
            raise HTTPException(status_code=400, detail="cannot delete self")

        conn = get_db()
        row = conn.execute("SELECT role FROM users WHERE username = ?", (target,)).fetchone()
        if not row:
            conn.close()
            raise HTTPException(status_code=404, detail="user not found")

        role = row["role"] if row["role"] else "user"
        if role == "admin" and count_admins() <= 1:
            conn.close()
            raise HTTPException(status_code=400, detail="cannot delete last admin")

        conn.execute(
            "DELETE FROM requests WHERE requester_username = ? OR assignee_username = ?",
            (target, target),
        )
        conn.execute("DELETE FROM users WHERE username = ?", (target,))
        conn.commit()
        conn.close()
        return {"ok": True}

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

    return router
