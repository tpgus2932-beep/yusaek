from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Body, Header, Depends, Response, Request
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from pathlib import Path
import tempfile
import uuid
import traceback
import os
import sqlite3
try:
    import libsql_experimental as libsql
    _LIBSQL_AVAILABLE = True
except ImportError:
    _LIBSQL_AVAILABLE = False
import io
import re
import shutil
import mimetypes
from collections import Counter
from datetime import datetime, timedelta, timezone

from barcode_core import process_and_load_any, normalize_to_yusas, load_excel_any

import barcode_core
import pandas as pd
import xlwt

from passlib.context import CryptContext
from jose import jwt, JWTError
from api.amood_hapbae import router as amood_hapbae_router, SHARED_COST_BASE_PATH
from api.auth_admin_routes import build_auth_admin_router
from api.collab_routes import build_collab_router
from api.barcode_routes import build_barcode_router
from api.amood_routes import build_amood_router
from api.returns_routes import build_returns_router
from api.order_routes import build_order_router
from api.noye_kimsungil_routes import build_noye_kimsungil_router
from services.easyadmin_product import _content_disposition, _process_easyadmin_product_upload
from services.returns_utils import (
    ReturnState,
    _clean_invoice,
    _clean_product_name,
    _clean_qty,
    _lowercase_size_words,
    _normalize_key,
    _normalize_spaces,
    _option_slash_to_space,
    _read_return_excel,
    _read_return_excel_with_header,
    _reason_type,
    _return_queue_payload,
    _return_rows,
    _return_status,
)
from services.amood_utils import (
    AmoodState,
    AMOOD_COL1_NAME_RAW,
    AMOOD_COL1_SCAN_BARCODE,
    AMOOD_COL1_ORDER_KEY,
    AMOOD_COL1_NUM_B,
    AMOOD_COL1_NUM_C,
    AMOOD_COL2_ORDER_KEY,
    AMOOD_COL2_NAME,
    AMOOD_COL2_OPTION,
    AMOOD_COL2_QTY,
    AMOOD_COL2_BARCODE,
    AMOOD_COL2_OUTPUT,
    _amood_build_output_text,
    _amood_collect_rows_by_value,
    _amood_fill_down_merged_column,
    _amood_load_workbooks,
    _amood_norm_barcode,
    _amood_norm_key,
    _amood_status,
    _amood_strip_any_brackets,
    _amood_to_int_qty,
    _amood_ws_cell,
)

print("### barcode_core file =", barcode_core.__file__)

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

STATE = {
    "loaded": False,
    "mapping": None,
    "details": None,
    "runs": None,
    "invoice_order": None,
    "invoice_seq": None,
    "code_o_text": None,
    "current_invoice": None,
    "last_scanned_code": None,
    "processed_path": None,
    "defect_counts": None,
    "incoming_counts": None,
}

BASE_DIR = Path(__file__).resolve().parent
UPLOAD_BASE = Path(os.environ.get("REQUEST_UPLOAD_BASE") or (BASE_DIR / "uploads" / "requests"))
SHARED_UPLOAD_BASE = Path(os.environ.get("SHARED_UPLOAD_BASE") or (BASE_DIR / "uploads" / "shared_files"))
ALLOWED_REQUEST_EXTS = {
    ".xlsx",
    ".xls",
    ".csv",
    ".jpg",
    ".jpeg",
    ".png",
    ".gif",
    ".webp",
}
ALLOWED_SHARED_EXTS = {".xlsx", ".xls", ".csv"}
RETURN_ALLOWED_EXTS = {".xlsx", ".xls", ".xlsm"}
AMOOD_ALLOWED_EXCEL1 = {".xlsx", ".xlsm"}
AMOOD_ALLOWED_EXCEL2 = {".xlsx", ".xls", ".xlsm", ".htm", ".html"}
RETURN_STATES: dict[str, "ReturnState"] = {}
AMOOD_STATES: dict[str, "AmoodState"] = {}
RETURN_COST_BASE_CACHE: dict[str, object] = {"df": None, "mtime": None, "path": None}
SHARED_INCOMING_COUNTS: dict[str, int] = {}

def _get_return_state(user: str) -> ReturnState:
    state = RETURN_STATES.get(user)
    if not state:
        state = ReturnState(SHARED_COST_BASE_PATH)
        RETURN_STATES[user] = state
    return state


def _get_amood_state(user: str) -> AmoodState:
    state = AMOOD_STATES.get(user)
    if not state:
        state = AmoodState()
        AMOOD_STATES[user] = state
    return state


def _get_shared_incoming_counts() -> dict[str, int]:
    return SHARED_INCOMING_COUNTS


def _set_shared_incoming_counts(counts: dict[str, int] | None):
    SHARED_INCOMING_COUNTS.clear()
    if counts:
        SHARED_INCOMING_COUNTS.update(counts)
    # Keep legacy barcode state key in sync for existing code paths.
    STATE["incoming_counts"] = dict(SHARED_INCOMING_COUNTS)


def _load_return_cost_base(state: ReturnState):
    path = state.cost_base_path
    if not path.exists():
        raise FileNotFoundError(f"원가베이스 파일을 찾지 못했습니다: {path}")
    cost_df = pd.read_excel(path, dtype=str)
    if cost_df.shape[1] < 2:
        raise ValueError("원가베이스는 최소 A,B열이 필요합니다.")
    amap: dict[str, str] = {}
    for _, r in cost_df.iterrows():
        key_raw = r.iloc[0] if len(r) > 0 else ""
        val_raw = r.iloc[1] if len(r) > 1 else ""
        key = _normalize_key("" if pd.isna(key_raw) else str(key_raw))
        val = "" if pd.isna(val_raw) else str(val_raw).strip()
        if key and key not in amap:
            amap[key] = val
    state.cost_map = amap


def _load_cost_base_df():
    path = SHARED_COST_BASE_PATH
    if not path.exists():
        raise FileNotFoundError(f"원가베이스 파일을 찾지 못했습니다: {path}")
    mtime = path.stat().st_mtime
    cached_path = RETURN_COST_BASE_CACHE.get("path")
    cached_mtime = RETURN_COST_BASE_CACHE.get("mtime")
    if RETURN_COST_BASE_CACHE.get("df") is not None and cached_path == str(path) and cached_mtime == mtime:
        return RETURN_COST_BASE_CACHE["df"]
    df = _read_return_excel_with_header(path, header=0)
    if df.shape[0] == 0:
        df_raw = _read_return_excel_with_header(path, header=None)
        if df_raw.shape[0] >= 2:
            new_cols = df_raw.iloc[0].fillna("").astype(str).tolist()
            df_raw = df_raw.iloc[1:].reset_index(drop=True)
            df_raw.columns = new_cols
            df = df_raw
    RETURN_COST_BASE_CACHE["df"] = df
    RETURN_COST_BASE_CACHE["mtime"] = mtime
    RETURN_COST_BASE_CACHE["path"] = str(path)
    return df


def _save_cost_base_df(df: pd.DataFrame):
    path = SHARED_COST_BASE_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    with pd.ExcelWriter(path, engine="openpyxl") as writer:
        df.to_excel(writer, index=False)
    RETURN_COST_BASE_CACHE["df"] = df
    RETURN_COST_BASE_CACHE["mtime"] = path.stat().st_mtime
    RETURN_COST_BASE_CACHE["path"] = str(path)


DB_PATH = Path(os.environ.get("APP_DB_PATH") or BASE_DIR / "app.db")

TURSO_DATABASE_URL = os.environ.get("TURSO_DATABASE_URL", "").strip()
TURSO_AUTH_TOKEN = os.environ.get("TURSO_AUTH_TOKEN", "").strip()
_USE_TURSO = _LIBSQL_AVAILABLE and bool(TURSO_DATABASE_URL) and bool(TURSO_AUTH_TOKEN)


class _Row:
    """sqlite3.Row 호환 래퍼 (libsql tuple row → 컬럼명 접근)."""
    __slots__ = ("_cols", "_vals")

    def __init__(self, description, values):
        self._cols = {description[i][0]: i for i in range(len(description))}
        self._vals = tuple(values)

    def __getitem__(self, key):
        if isinstance(key, int):
            return self._vals[key]
        return self._vals[self._cols[key]]

    def keys(self):
        return list(self._cols.keys())

    def __bool__(self):
        return True


class _Cursor:
    __slots__ = ("_cur",)

    def __init__(self, cur):
        self._cur = cur

    def _wrap(self, row):
        if row is None or self._cur.description is None:
            return None
        return _Row(self._cur.description, row)

    def fetchone(self):
        return self._wrap(self._cur.fetchone())

    def fetchall(self):
        if self._cur.description is None:
            return []
        desc = self._cur.description
        return [_Row(desc, r) for r in self._cur.fetchall()]

    def __iter__(self):
        desc = self._cur.description
        for row in self._cur:
            yield _Row(desc, row)


class _TursoConn:
    __slots__ = ("_conn",)

    def __init__(self, conn):
        self._conn = conn

    def execute(self, sql, params=()):
        return _Cursor(self._conn.execute(sql, list(params) if params else []))

    def commit(self):
        self._conn.commit()

    def close(self):
        self._conn.close()


JWT_SECRET = os.environ.get("JWT_SECRET", "dev-secret-change-me")
JWT_ALG = "HS256"
BOOT_ID = uuid.uuid4().hex
TOKEN_EXPIRE_MINUTES = 60 * 24

pwd_context = CryptContext(schemes=["pbkdf2_sha256"], deprecated="auto")


def _get_db():
    if _USE_TURSO:
        return _TursoConn(libsql.connect(TURSO_DATABASE_URL, auth_token=TURSO_AUTH_TOKEN))
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def _init_db():
    conn = _get_db()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            display_name TEXT NOT NULL DEFAULT '',
            role TEXT NOT NULL DEFAULT 'user',
            created_at TEXT NOT NULL
        )
        """
    )
    conn.commit()
    conn.close()


def _ensure_user_column(column: str, ddl: str):
    conn = _get_db()
    cols = [r["name"] for r in conn.execute("PRAGMA table_info(users)").fetchall()]
    if column not in cols:
        conn.execute(ddl)
        conn.commit()
    conn.close()


_init_db()
_ensure_user_column("display_name", "ALTER TABLE users ADD COLUMN display_name TEXT NOT NULL DEFAULT ''")
_ensure_user_column("role", "ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'")
_ensure_user_column("approval_status", "ALTER TABLE users ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'approved'")
_ensure_user_column("approved_at", "ALTER TABLE users ADD COLUMN approved_at TEXT")
_ensure_user_column("approved_by", "ALTER TABLE users ADD COLUMN approved_by TEXT")


def _backfill_user_defaults():
    conn = _get_db()
    conn.execute("UPDATE users SET approval_status = 'approved' WHERE approval_status IS NULL OR TRIM(approval_status) = ''")
    conn.commit()
    conn.close()


_backfill_user_defaults()


def _init_requests():
    conn = _get_db()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            requester_username TEXT NOT NULL,
            requester_display TEXT NOT NULL DEFAULT '',
            assignee_username TEXT NOT NULL,
            assignee_display TEXT NOT NULL DEFAULT '',
            text TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'open',
            created_at TEXT NOT NULL,
            completed_at TEXT,
            acknowledged_at TEXT
        )
        """
    )
    conn.commit()
    conn.close()


def _ensure_request_column(column: str, ddl: str):
    conn = _get_db()
    cols = [r["name"] for r in conn.execute("PRAGMA table_info(requests)").fetchall()]
    if column not in cols:
        conn.execute(ddl)
        conn.commit()
    conn.close()


_init_requests()
_ensure_request_column(
    "requester_display",
    "ALTER TABLE requests ADD COLUMN requester_display TEXT NOT NULL DEFAULT ''",
)
_ensure_request_column(
    "assignee_display",
    "ALTER TABLE requests ADD COLUMN assignee_display TEXT NOT NULL DEFAULT ''",
)
_ensure_request_column(
    "acknowledged_at",
    "ALTER TABLE requests ADD COLUMN acknowledged_at TEXT",
)


def _init_company_credentials():
    conn = _get_db()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS company_credentials (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            label TEXT NOT NULL,
            username TEXT,
            password TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT
        )
        """
    )
    conn.commit()
    conn.close()


_init_company_credentials()


def _init_app_settings():
    conn = _get_db()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS app_settings (
            key TEXT PRIMARY KEY,
            value TEXT
        )
        """
    )
    conn.commit()
    conn.close()


_init_app_settings()


def _ensure_default_company_pin():
    if not _get_setting("company_pin_hash"):
        _set_setting("company_pin_hash", _hash_pin("0000"))


def _init_request_attachments():
    conn = _get_db()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS request_attachments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            request_id INTEGER NOT NULL,
            original_name TEXT NOT NULL,
            stored_name TEXT NOT NULL,
            mime_type TEXT NOT NULL,
            size INTEGER NOT NULL,
            created_at TEXT NOT NULL
        )
        """
    )
    conn.commit()
    conn.close()


_init_request_attachments()


def _init_shared_files():
    conn = _get_db()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS shared_files (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            original_name TEXT NOT NULL,
            stored_name TEXT NOT NULL,
            mime_type TEXT NOT NULL,
            size INTEGER NOT NULL,
            uploader_username TEXT NOT NULL,
            uploader_display TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL
        )
        """
    )
    conn.commit()
    conn.close()


_init_shared_files()



def _init_shared_todos():
    conn = _get_db()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS shared_todos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            text TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'open',
            created_by_username TEXT NOT NULL,
            created_by_display TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            completed_by_username TEXT,
            completed_by_display TEXT,
            completed_at TEXT,
            completed_comment TEXT
        )
        """
    )
    conn.commit()
    conn.close()


_init_shared_todos()


def _ensure_shared_todo_column(column: str, ddl: str):
    conn = _get_db()
    cols = [r["name"] for r in conn.execute("PRAGMA table_info(shared_todos)").fetchall()]
    if column not in cols:
        conn.execute(ddl)
        conn.commit()
    conn.close()


_ensure_shared_todo_column(
    "completed_comment",
    "ALTER TABLE shared_todos ADD COLUMN completed_comment TEXT",
)


def _init_my_todos():
    conn = _get_db()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS my_todos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            owner_username TEXT NOT NULL,
            owner_display TEXT NOT NULL DEFAULT '',
            text TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'open',
            created_at TEXT NOT NULL,
            completed_at TEXT,
            completed_comment TEXT
        )
        """
    )
    conn.commit()
    conn.close()


_init_my_todos()


def _init_order_registered_codes():
    conn = _get_db()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS order_registered_codes (
            code TEXT PRIMARY KEY,
            qty INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """
    )
    conn.commit()
    conn.close()


_init_order_registered_codes()


def _get_user_display(username: str) -> str:
    conn = _get_db()
    row = conn.execute("SELECT display_name FROM users WHERE username = ?", (username,)).fetchone()
    conn.close()
    return row["display_name"] if row else ""


def _get_user_role(username: str) -> str:
    conn = _get_db()
    row = conn.execute("SELECT role FROM users WHERE username = ?", (username,)).fetchone()
    conn.close()
    return row["role"] if row and row["role"] else "user"


def _get_user_approval_status(username: str) -> str:
    conn = _get_db()
    row = conn.execute("SELECT approval_status FROM users WHERE username = ?", (username,)).fetchone()
    conn.close()
    return row["approval_status"] if row and row["approval_status"] else "approved"


def _is_admin(username: str) -> bool:
    return _get_user_role(username) == "admin"


def _count_admins() -> int:
    conn = _get_db()
    row = conn.execute("SELECT COUNT(*) as cnt FROM users WHERE role = 'admin'").fetchone()
    conn.close()
    return int(row["cnt"]) if row else 0


def _ensure_bootstrap_admin():
    username = (os.environ.get("BOOTSTRAP_ADMIN_USERNAME") or "ksh2932").strip()
    password = (os.environ.get("BOOTSTRAP_ADMIN_PASSWORD") or "").strip()
    display_name = (os.environ.get("BOOTSTRAP_ADMIN_DISPLAY_NAME") or "관리자").strip()
    if not password:
        return
    conn = _get_db()
    row = conn.execute("SELECT username FROM users WHERE username = ?", (username,)).fetchone()
    if row:
        conn.execute(
            "UPDATE users SET role = 'admin', approval_status = 'approved' WHERE username = ?",
            (username,),
        )
        conn.commit()
        conn.close()
        return
    conn.execute(
        """
        INSERT INTO users (
            username, password_hash, display_name, role,
            created_at, approval_status, approved_at, approved_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            username,
            _hash_password(password),
            display_name,
            "admin",
            datetime.now(timezone.utc).isoformat(),
            "approved",
            datetime.now(timezone.utc).isoformat(),
            username,
        ),
    )
    conn.commit()
    conn.close()




def _parse_iso_date(value: str | None):
    if not value:
        return None
    try:
        return datetime.fromisoformat(value).date()
    except ValueError:
        return None


def _is_visible_completed(completed_at: str | None) -> bool:
    if not completed_at:
        return True
    completed_date = _parse_iso_date(completed_at)
    if not completed_date:
        return True
    return completed_date >= datetime.now(timezone.utc).date()


def _row_to_request(row) -> dict:
    return {
        "id": row["id"],
        "requester_username": row["requester_username"],
        "requester_display": row["requester_display"],
        "assignee_username": row["assignee_username"],
        "assignee_display": row["assignee_display"],
        "text": row["text"],
        "status": row["status"],
        "created_at": row["created_at"],
        "completed_at": row["completed_at"],
        "acknowledged_at": row["acknowledged_at"],
    }


def _is_image_mime(mime: str | None) -> bool:
    return bool(mime) and mime.lower().startswith("image/")


def _get_request_attachments(request_ids: list[int]) -> dict[int, list[dict]]:
    if not request_ids:
        return {}
    conn = _get_db()
    placeholders = ",".join(["?"] * len(request_ids))
    rows = conn.execute(
        f"SELECT * FROM request_attachments WHERE request_id IN ({placeholders}) ORDER BY id ASC",
        request_ids,
    ).fetchall()
    conn.close()
    result: dict[int, list[dict]] = {}
    for row in rows:
        item = {
            "id": row["id"],
            "filename": row["original_name"],
            "mime_type": row["mime_type"],
            "size": row["size"],
            "url": f"/requests/{row['request_id']}/attachments/{row['id']}",
            "is_image": _is_image_mime(row["mime_type"]),
        }
        result.setdefault(row["request_id"], []).append(item)
    return result


def _get_current_user_optional(authorization: str | None, token: str | None):
    raw = None
    if authorization and authorization.startswith("Bearer "):
        raw = authorization.split(" ", 1)[1].strip()
    elif token:
        raw = token.strip()
    if not raw:
        raise HTTPException(status_code=401, detail="Unauthorized")
    try:
        payload = jwt.decode(raw, JWT_SECRET, algorithms=[JWT_ALG])
        if payload.get("boot_id") != BOOT_ID:
            raise HTTPException(status_code=401, detail="Unauthorized")
        username = payload.get("sub")
        if not username:
            raise HTTPException(status_code=401, detail="Unauthorized")
    except JWTError:
        raise HTTPException(status_code=401, detail="Unauthorized")
    if _get_user_approval_status(username) != "approved":
        raise HTTPException(status_code=403, detail="Account not approved")
    return username


def _row_to_shared_file(row) -> dict:
    return {
        "id": row["id"],
        "filename": row["original_name"],
        "mime_type": row["mime_type"],
        "size": row["size"],
        "uploader_username": row["uploader_username"],
        "uploader_display": row["uploader_display"],
        "created_at": row["created_at"],
        "url": f"/shared-files/{row['id']}",
    }


def _hash_password(password: str) -> str:
    return pwd_context.hash(password)


def _verify_password(password: str, password_hash: str) -> bool:
    return pwd_context.verify(password, password_hash)


def _hash_pin(pin: str) -> str:
    return pwd_context.hash(pin)


def _verify_pin(pin: str, pin_hash: str) -> bool:
    return pwd_context.verify(pin, pin_hash)


def _get_setting(key: str) -> str | None:
    conn = _get_db()
    row = conn.execute("SELECT value FROM app_settings WHERE key = ?", (key,)).fetchone()
    conn.close()
    return row["value"] if row else None


def _set_setting(key: str, value: str | None):
    conn = _get_db()
    if value is None:
        conn.execute("DELETE FROM app_settings WHERE key = ?", (key,))
    else:
        conn.execute(
            "INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )
    conn.commit()
    conn.close()


_ensure_default_company_pin()


def _to_int(value, default=0):
    try:
        if value is None or (isinstance(value, str) and not value.strip()):
            return default
        return int(float(str(value).strip()))
    except Exception:
        return default


_ensure_bootstrap_admin()


def _create_access_token(username: str) -> str:
    expire = datetime.now(timezone.utc) + timedelta(minutes=TOKEN_EXPIRE_MINUTES)
    payload = {"sub": username, "exp": expire, "boot_id": BOOT_ID}
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALG)


def _get_current_user(authorization: str = Header(None)):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Unauthorized")
    token = authorization.split(" ", 1)[1].strip()
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALG])
        if payload.get("boot_id") != BOOT_ID:
            raise HTTPException(status_code=401, detail="Unauthorized")
        username = payload.get("sub")
        if not username:
            raise HTTPException(status_code=401, detail="Unauthorized")
    except JWTError:
        raise HTTPException(status_code=401, detail="Unauthorized")
    if _get_user_approval_status(username) != "approved":
        raise HTTPException(status_code=403, detail="Account not approved")
    return username


def _require_admin(user: str = Depends(_get_current_user)):
    if not _is_admin(user):
        raise HTTPException(status_code=403, detail="admin required")
    return user


app.include_router(
    amood_hapbae_router,
    dependencies=[Depends(_get_current_user)],
)
app.include_router(
    build_auth_admin_router(
        get_db=_get_db,
        hash_password=_hash_password,
        verify_password=_verify_password,
        create_access_token=_create_access_token,
        get_current_user=_get_current_user,
        require_admin=_require_admin,
        count_admins=_count_admins,
        get_setting=_get_setting,
        set_setting=_set_setting,
    )
)
app.include_router(
    build_barcode_router(
        get_current_user=_get_current_user,
        state=STATE,
        to_int=_to_int,
        process_and_load_any=process_and_load_any,
        load_excel_any=load_excel_any,
        normalize_to_yusas=normalize_to_yusas,
        process_easyadmin_product_upload=_process_easyadmin_product_upload,
        content_disposition=_content_disposition,
        get_shared_incoming_counts=_get_shared_incoming_counts,
        set_shared_incoming_counts=_set_shared_incoming_counts,
    )
)
app.include_router(
    build_collab_router(
        get_current_user=_get_current_user,
        require_admin=_require_admin,
        get_current_user_optional=_get_current_user_optional,
        is_admin=_is_admin,
        get_db=_get_db,
        get_user_display=_get_user_display,
        is_visible_completed=_is_visible_completed,
        get_request_attachments=_get_request_attachments,
        row_to_request=_row_to_request,
        row_to_shared_file=_row_to_shared_file,
        get_setting=_get_setting,
        set_setting=_set_setting,
        hash_pin=_hash_pin,
        verify_pin=_verify_pin,
        upload_base=UPLOAD_BASE,
        shared_upload_base=SHARED_UPLOAD_BASE,
        allowed_request_exts=ALLOWED_REQUEST_EXTS,
        allowed_shared_exts=ALLOWED_SHARED_EXTS,
    )
)
app.include_router(
    build_amood_router(
        get_current_user=_get_current_user,
        get_amood_state=_get_amood_state,
        amood_status=_amood_status,
        amood_load_workbooks=_amood_load_workbooks,
        amood_norm_barcode=_amood_norm_barcode,
        amood_to_int_qty=_amood_to_int_qty,
        amood_ws_cell=_amood_ws_cell,
        amood_strip_any_brackets=_amood_strip_any_brackets,
        amood_fill_down_merged_column=_amood_fill_down_merged_column,
        amood_norm_key=_amood_norm_key,
        amood_build_output_text=_amood_build_output_text,
        amood_collect_rows_by_value=_amood_collect_rows_by_value,
        load_excel_any=load_excel_any,
        content_disposition=_content_disposition,
        amood_allowed_excel1=AMOOD_ALLOWED_EXCEL1,
        amood_allowed_excel2=AMOOD_ALLOWED_EXCEL2,
        AMOOD_COL1_NAME_RAW=AMOOD_COL1_NAME_RAW,
        AMOOD_COL1_SCAN_BARCODE=AMOOD_COL1_SCAN_BARCODE,
        AMOOD_COL1_ORDER_KEY=AMOOD_COL1_ORDER_KEY,
        AMOOD_COL1_NUM_B=AMOOD_COL1_NUM_B,
        AMOOD_COL1_NUM_C=AMOOD_COL1_NUM_C,
        AMOOD_COL2_ORDER_KEY=AMOOD_COL2_ORDER_KEY,
        AMOOD_COL2_NAME=AMOOD_COL2_NAME,
        AMOOD_COL2_OPTION=AMOOD_COL2_OPTION,
        AMOOD_COL2_QTY=AMOOD_COL2_QTY,
        AMOOD_COL2_BARCODE=AMOOD_COL2_BARCODE,
        AMOOD_COL2_OUTPUT=AMOOD_COL2_OUTPUT,
        get_shared_incoming_counts=_get_shared_incoming_counts,
        set_shared_incoming_counts=_set_shared_incoming_counts,
    )
)
app.include_router(
    build_returns_router(
        get_current_user=_get_current_user,
        require_admin=_require_admin,
        get_return_state=_get_return_state,
        return_status=_return_status,
        return_queue_payload=_return_queue_payload,
        return_rows=_return_rows,
        load_return_cost_base=_load_return_cost_base,
        load_cost_base_df=_load_cost_base_df,
        save_cost_base_df=_save_cost_base_df,
        read_return_excel=_read_return_excel,
        clean_invoice=_clean_invoice,
        clean_product_name=_clean_product_name,
        lowercase_size_words=_lowercase_size_words,
        option_slash_to_space=_option_slash_to_space,
        clean_qty=_clean_qty,
        normalize_spaces=_normalize_spaces,
        reason_type=_reason_type,
        normalize_key=_normalize_key,
        content_disposition=_content_disposition,
        return_allowed_exts=RETURN_ALLOWED_EXTS,
        return_cost_base_path=SHARED_COST_BASE_PATH,
    )
)
app.include_router(
    build_order_router(
        require_admin=_require_admin,
        get_db=_get_db,
        order_cost_base_path=SHARED_COST_BASE_PATH,
    )
)
app.include_router(
    build_noye_kimsungil_router(
        get_current_user=_get_current_user,
    )
)


@app.get("/ping")
def ping():
    return {"status": "ok"}

