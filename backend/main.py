from fastapi import FastAPI, UploadFile, File, HTTPException, Body, Header, Depends
from fastapi.middleware.cors import CORSMiddleware
from pathlib import Path
import tempfile
import uuid
import traceback
import os
import sqlite3
from datetime import datetime, timedelta

from barcode_core import process_and_load_any, normalize_to_yusas

import barcode_core

from passlib.context import CryptContext
from jose import jwt, JWTError

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
}

DB_PATH = Path(__file__).with_name("app.db")
JWT_SECRET = os.environ.get("JWT_SECRET", "dev-secret-change-me")
JWT_ALG = "HS256"
TOKEN_EXPIRE_MINUTES = 60 * 24

pwd_context = CryptContext(schemes=["pbkdf2_sha256"], deprecated="auto")


def _get_db():
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


def _get_user_display(username: str) -> str:
    conn = _get_db()
    row = conn.execute("SELECT display_name FROM users WHERE username = ?", (username,)).fetchone()
    conn.close()
    return row["display_name"] if row else ""


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
    return completed_date >= datetime.utcnow().date()


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


def _hash_password(password: str) -> str:
    return pwd_context.hash(password)


def _verify_password(password: str, password_hash: str) -> bool:
    return pwd_context.verify(password, password_hash)


def _create_access_token(username: str) -> str:
    expire = datetime.utcnow() + timedelta(minutes=TOKEN_EXPIRE_MINUTES)
    payload = {"sub": username, "exp": expire}
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALG)


def _get_current_user(authorization: str = Header(None)):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Unauthorized")
    token = authorization.split(" ", 1)[1].strip()
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALG])
        username = payload.get("sub")
        if not username:
            raise HTTPException(status_code=401, detail="Unauthorized")
    except JWTError:
        raise HTTPException(status_code=401, detail="Unauthorized")
    return username


@app.get("/ping")
def ping():
    return {"status": "ok"}


@app.post("/auth/register")
def register(payload: dict = Body(...)):
    username = (payload.get("username") or "").strip()
    password = (payload.get("password") or "").strip()
    display_name = (payload.get("display_name") or "").strip()
    if not username or not password or not display_name:
        raise HTTPException(status_code=400, detail="username/password/display_name required")

    conn = _get_db()
    try:
        conn.execute(
            "INSERT INTO users (username, password_hash, display_name, created_at) VALUES (?, ?, ?, ?)",
            (username, _hash_password(password), display_name, datetime.utcnow().isoformat()),
        )
        conn.commit()
    except sqlite3.IntegrityError:
        raise HTTPException(status_code=400, detail="username already exists")
    finally:
        conn.close()

    return {"ok": True}


@app.options("/auth/register")
def register_options():
    return {}


@app.post("/auth/login")
def login(payload: dict = Body(...)):
    username = (payload.get("username") or "").strip()
    password = (payload.get("password") or "").strip()
    if not username or not password:
        raise HTTPException(status_code=400, detail="username/password required")

    conn = _get_db()
    row = conn.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
    conn.close()
    if not row or not _verify_password(password, row["password_hash"]):
        raise HTTPException(status_code=401, detail="invalid credentials")

    token = _create_access_token(username)
    return {"ok": True, "token": token, "username": username, "display_name": row["display_name"]}


@app.options("/auth/login")
def login_options():
    return {}


@app.get("/auth/me")
def me(user: str = Depends(_get_current_user)):
    conn = _get_db()
    row = conn.execute("SELECT display_name FROM users WHERE username = ?", (user,)).fetchone()
    conn.close()
    display_name = row["display_name"] if row else ""
    return {"ok": True, "username": user, "display_name": display_name}


@app.options("/auth/me")
def me_options():
    return {}


@app.patch("/auth/profile")
def update_profile(payload: dict = Body(...), user: str = Depends(_get_current_user)):
    display_name = (payload.get("display_name") or "").strip()
    if not display_name:
        raise HTTPException(status_code=400, detail="display_name required")
    conn = _get_db()
    conn.execute("UPDATE users SET display_name = ? WHERE username = ?", (display_name, user))
    conn.commit()
    conn.close()
    return {"ok": True, "username": user, "display_name": display_name}


@app.post("/barcode/upload")
async def barcode_upload(file: UploadFile = File(...), user: str = Depends(_get_current_user)):
    name = (file.filename or "").lower()
    if not (name.endswith(".xls") or name.endswith(".xlsx")):
        raise HTTPException(status_code=400, detail="xls/xlsx만 업로드 가능")

    suffix = ".xlsx" if name.endswith(".xlsx") else ".xls"

    # 파일명 충돌 방지
    tmp_path = Path(tempfile.gettempdir()) / f"yusaek_upload_{uuid.uuid4().hex}{suffix}"
    data = await file.read()
    tmp_path.write_bytes(data)

    try:
        result = process_and_load_any(tmp_path)
        print("process_and_load_any return len =", len(result))

        if len(result) == 7:
            processed_path, mapping, details, runs, invoice_order, invoice_seq, code_o_text = result
        elif len(result) == 6:
            mapping, details, runs, invoice_order, invoice_seq, code_o_text = result
            processed_path = None
        else:
            raise Exception(f"unexpected return count: {len(result)}")

    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"가공 실패: {e}")

    STATE.update(
        {
            "loaded": True,
            "processed_path": str(processed_path) if processed_path else None,
            "mapping": mapping,
            "details": details,
            "runs": runs,
            "invoice_order": invoice_order,
            "invoice_seq": invoice_seq,
            "code_o_text": code_o_text,
            "current_invoice": None,
            "last_scanned_code": None,
            "defect_counts": {},
        }
    )

    return {
        "ok": True,
        "invoices": len(mapping),
        "codes_total": sum(len(v) for v in mapping.values()),
    }


@app.get("/barcode/status")
def barcode_status(user: str = Depends(_get_current_user)):
    if not STATE["loaded"]:
        return {"loaded": False}
    return {
        "loaded": True,
        "current_invoice": STATE["current_invoice"],
        "invoices": len(STATE["mapping"]),
        "processed_path": STATE["processed_path"],
        "items": _get_all_items(STATE["current_invoice"]) if STATE["current_invoice"] else [],
        "current_next": _get_first_remaining_item(STATE["current_invoice"]),
        "next_preview": _get_next_item_preview(STATE["current_invoice"]),
        "defects": _get_defect_list(),
        "invoice_has_defect": _invoice_has_defect(STATE["current_invoice"]),
    }


def _get_all_items(inv: str):
    """해당 송장의 모든 상품 목록(남은 수량 포함)"""
    mapping = STATE["mapping"]
    if inv not in mapping:
        return []

    if STATE["invoice_order"] and inv in STATE["invoice_order"]:
        codes = STATE["invoice_order"][inv]
    else:
        codes = sorted(mapping[inv].keys())

    items = []
    for code in codes:
        remain = mapping[inv].get(code, 0)
        run_len = (STATE["runs"] or {}).get(inv, {}).get(code, 0)
        defect_n = (STATE["defect_counts"] or {}).get(code, 0)
        det = (STATE["details"] or {}).get(inv, {}).get(code, {})
        items.append(
            {
                "code": code,
                "name": det.get("name", "") or "",
                "option": det.get("option", "") or "",
                "remain": remain,
                "run_len": run_len,
                "defect": defect_n,
            }
        )
    return items


def _get_first_remaining_item(inv: str | None):
    if not inv:
        return None
    for item in _get_all_items(inv):
        if item.get("remain", 0) > 0:
            return item
    return None


def _get_next_item_preview(current_invoice: str | None):
    seq = STATE.get("invoice_seq") or []
    if not seq:
        return None

    last_code = STATE.get("last_scanned_code")
    start_idx = seq.index(current_invoice) if current_invoice in seq else -1

    for i in range(start_idx + 1, len(seq)):
        inv = seq[i]
        item = _get_first_remaining_item(inv)
        if not item:
            continue
        run_len = item.get("run_len", 0)
        if run_len and run_len >= 10:
            continue
        if last_code and item.get("code") == last_code:
            continue
        return {"invoice": inv, **item}
    return None


def _invoice_has_defect(inv: str | None):
    if not inv:
        return False
    defect_counts = STATE.get("defect_counts") or {}
    mapping = STATE.get("mapping") or {}
    if inv not in mapping:
        return False
    for code in mapping[inv].keys():
        if defect_counts.get(code, 0) > 0:
            return True
    return False


def _find_item_detail_by_code(code: str):
    details = STATE.get("details") or {}
    for _, codes in details.items():
        det = codes.get(code)
        if det:
            return {
                "name": det.get("name", "") or "",
                "option": det.get("option", "") or "",
            }
    return {"name": "", "option": ""}


def _get_defect_list():
    defect_counts = STATE.get("defect_counts") or {}
    rows = []
    for code, n in sorted(defect_counts.items()):
        det = _find_item_detail_by_code(code)
        rows.append(
            {
                "code": code,
                "count": n,
                "name": det.get("name", ""),
                "option": det.get("option", ""),
            }
        )
    return rows


@app.post("/barcode/scan/invoice")
def scan_invoice(payload: dict = Body(...), user: str = Depends(_get_current_user)):
    if not STATE["loaded"]:
        raise HTTPException(status_code=400, detail="먼저 엑셀을 업로드해주세요")

    invoice = (payload.get("invoice") or "").strip()
    if not invoice:
        raise HTTPException(status_code=400, detail="invoice 값이 비어있음")

    if invoice not in STATE["mapping"]:
        return {"ok": False, "type": "invoice", "result": "NOT_FOUND", "invoice": invoice}

    STATE["current_invoice"] = invoice

    first_item = _get_first_remaining_item(invoice)
    if first_item:
        STATE["last_scanned_code"] = first_item.get("code")

    items = _get_all_items(invoice)

    return {
        "ok": True,
        "type": "invoice",
        "result": "SET",
        "invoice": invoice,
        "items": items,
        "current_next": first_item,
        "next_preview": _get_next_item_preview(invoice),
        "defects": _get_defect_list(),
        "invoice_has_defect": _invoice_has_defect(invoice),
    }


@app.post("/barcode/scan/item")
def scan_item(payload: dict = Body(...), user: str = Depends(_get_current_user)):
    if not STATE["loaded"]:
        raise HTTPException(status_code=400, detail="먼저 엑셀을 업로드해주세요")

    inv = STATE["current_invoice"]
    if not inv:
        return {"ok": False, "type": "item", "result": "NO_INVOICE"}

    raw = (payload.get("code") or "").strip()
    if not raw:
        raise HTTPException(status_code=400, detail="code 값이 비어있음")

    code = normalize_to_yusas(raw) or raw

    if inv not in STATE["mapping"]:
        return {"ok": False, "type": "item", "result": "BAD_INVOICE", "invoice": inv}

    remain = STATE["mapping"][inv].get(code, 0)
    det = (STATE["details"] or {}).get(inv, {}).get(code, {})
    name = det.get("name", "") or ""
    opt = det.get("option", "") or ""

    if remain <= 0:
        return {
            "ok": True,
            "type": "item",
            "result": "FALSE",
            "invoice": inv,
            "raw": raw,
            "code": code,
            "name": name,
            "option": opt,
            "remain": remain,
            "items": _get_all_items(inv),
            "current_next": _get_first_remaining_item(inv),
            "next_preview": _get_next_item_preview(inv),
            "defects": _get_defect_list(),
        }

    # TRUE 처리: -1
    STATE["mapping"][inv][code] = remain - 1
    STATE["last_scanned_code"] = code

    all_done = all(v == 0 for v in STATE["mapping"][inv].values())

    return {
        "ok": True,
        "type": "item",
        "result": "TRUE",
        "invoice": inv,
        "code": code,
        "name": name,
        "option": opt,
        "remain": STATE["mapping"][inv][code],
        "invoice_done": all_done,
        "items": _get_all_items(inv),
        "current_next": _get_first_remaining_item(inv),
        "next_preview": _get_next_item_preview(inv),
        "defects": _get_defect_list(),
    }


@app.post("/barcode/defect/add")
def add_defect(payload: dict = Body(...), user: str = Depends(_get_current_user)):
    if not STATE["loaded"]:
        raise HTTPException(status_code=400, detail="먼저 엑셀을 업로드해주세요")

    raw = (payload.get("code") or "").strip()
    if not raw:
        raise HTTPException(status_code=400, detail="code 값이 비어있음")

    code = normalize_to_yusas(raw) or raw
    defect_counts = STATE.get("defect_counts") or {}
    defect_counts[code] = defect_counts.get(code, 0) + 1
    STATE["defect_counts"] = defect_counts

    inv = STATE.get("current_invoice")
    return {
        "ok": True,
        "code": code,
        "defect_count": defect_counts[code],
        "items": _get_all_items(inv) if inv else [],
        "current_next": _get_first_remaining_item(inv),
        "next_preview": _get_next_item_preview(inv),
        "defects": _get_defect_list(),
    }


@app.get("/barcode/defect/list")
def list_defects(user: str = Depends(_get_current_user)):
    if not STATE["loaded"]:
        raise HTTPException(status_code=400, detail="먼저 엑셀을 업로드해주세요")
    return {"ok": True, "defects": _get_defect_list()}


@app.post("/barcode/defect/dec")
def decrement_defect(payload: dict = Body(...), user: str = Depends(_get_current_user)):
    if not STATE["loaded"]:
        raise HTTPException(status_code=400, detail="먼저 엑셀을 업로드해주세요")
    raw = (payload.get("code") or "").strip()
    if not raw:
        raise HTTPException(status_code=400, detail="code 값이 비어있음")
    code = normalize_to_yusas(raw) or raw
    defect_counts = STATE.get("defect_counts") or {}
    if code in defect_counts:
        defect_counts[code] -= 1
        if defect_counts[code] <= 0:
            del defect_counts[code]
    STATE["defect_counts"] = defect_counts
    inv = STATE.get("current_invoice")
    return {
        "ok": True,
        "defects": _get_defect_list(),
        "items": _get_all_items(inv) if inv else [],
        "current_next": _get_first_remaining_item(inv),
        "next_preview": _get_next_item_preview(inv),
    }


@app.post("/barcode/defect/remove")
def remove_defect(payload: dict = Body(...), user: str = Depends(_get_current_user)):
    if not STATE["loaded"]:
        raise HTTPException(status_code=400, detail="먼저 엑셀을 업로드해주세요")
    raw = (payload.get("code") or "").strip()
    if not raw:
        raise HTTPException(status_code=400, detail="code 값이 비어있음")
    code = normalize_to_yusas(raw) or raw
    defect_counts = STATE.get("defect_counts") or {}
    if code in defect_counts:
        del defect_counts[code]
    STATE["defect_counts"] = defect_counts
    inv = STATE.get("current_invoice")
    return {
        "ok": True,
        "defects": _get_defect_list(),
        "items": _get_all_items(inv) if inv else [],
        "current_next": _get_first_remaining_item(inv),
        "next_preview": _get_next_item_preview(inv),
    }


@app.get("/users")
def list_users(user: str = Depends(_get_current_user)):
    conn = _get_db()
    rows = conn.execute("SELECT username, display_name FROM users ORDER BY username ASC").fetchall()
    conn.close()
    return {"ok": True, "users": [{"username": r["username"], "display_name": r["display_name"]} for r in rows]}


@app.post("/requests")
def create_request(payload: dict = Body(...), user: str = Depends(_get_current_user)):
    assignee = (payload.get("assignee") or "").strip()
    text = (payload.get("text") or "").strip()
    if not assignee or not text:
        raise HTTPException(status_code=400, detail="assignee/text required")

    requester_display = _get_user_display(user)
    assignee_display = _get_user_display(assignee)
    created_at = datetime.utcnow().isoformat()

    conn = _get_db()
    conn.execute(
        """
        INSERT INTO requests (
            requester_username, requester_display,
            assignee_username, assignee_display,
            text, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (user, requester_display, assignee, assignee_display, text, "open", created_at),
    )
    conn.commit()
    conn.close()
    return {"ok": True}


@app.get("/requests/assigned")
def get_assigned_requests(user: str = Depends(_get_current_user)):
    target = user.strip()
    if not target:
        raise HTTPException(status_code=400, detail="assignee required")

    conn = _get_db()
    rows = conn.execute(
        "SELECT * FROM requests WHERE assignee_username = ? ORDER BY created_at DESC",
        (target,),
    ).fetchall()
    conn.close()

    items = []
    for row in rows:
        if row["status"] == "completed" and not _is_visible_completed(row["completed_at"]):
            continue
        item = _row_to_request(row)
        item["can_complete"] = row["status"] == "open" and row["assignee_username"] == user
        items.append(item)

    return {"ok": True, "assignee": target, "requests": items}


@app.post("/requests/{request_id}/complete")
def complete_request(request_id: int, user: str = Depends(_get_current_user)):
    conn = _get_db()
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
            ("completed", datetime.utcnow().isoformat(), request_id),
        )
        conn.commit()
    conn.close()
    return {"ok": True}


@app.get("/requests/resolved")
def get_resolved_requests(user: str = Depends(_get_current_user)):
    conn = _get_db()
    rows = conn.execute(
        """
        SELECT * FROM requests
        WHERE requester_username = ?
          AND status = 'completed'
          AND acknowledged_at IS NULL
        ORDER BY completed_at DESC
        """,
        (user,),
    ).fetchall()
    conn.close()

    items = []
    for row in rows:
        if not _is_visible_completed(row["completed_at"]):
            continue
        items.append(_row_to_request(row))

    return {"ok": True, "requests": items}


@app.post("/requests/{request_id}/ack")
def acknowledge_request(request_id: int, user: str = Depends(_get_current_user)):
    conn = _get_db()
    row = conn.execute("SELECT * FROM requests WHERE id = ?", (request_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="request not found")
    if row["requester_username"] != user:
        conn.close()
        raise HTTPException(status_code=403, detail="forbidden")

    conn.execute(
        "UPDATE requests SET acknowledged_at = ? WHERE id = ?",
        (datetime.utcnow().isoformat(), request_id),
    )
    conn.commit()
    conn.close()
    return {"ok": True}
