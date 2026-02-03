from fastapi import FastAPI, UploadFile, File, HTTPException, Body, Header, Depends, Response
from fastapi.middleware.cors import CORSMiddleware
from pathlib import Path
import tempfile
import uuid
import traceback
import os
import sqlite3
import io
import re
from collections import Counter
from datetime import datetime, timedelta

from barcode_core import process_and_load_any, normalize_to_yusas, load_excel_any

import barcode_core
import pandas as pd
import xlwt

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
    "incoming_counts": None,
}

# ---------- EasyAdmin product upload helpers ----------
HEADER_LIST = [
    "상품명","공급처코드 / 공급처명","공급처 상품명","공급처 옵션","원산지","택배비","중량",
    "원가","공급가","판매가","시중가","옵션1","옵션2","옵션3","옵션관리","바코드",
    "대표 이미지","설명 이미지1","설명 이미지2","설명 이미지3","설명 이미지4","설명 이미지5",
    "비고 이미지","상품설명","상품설명2","재고경고수량","재고위험수량","합포불가",
    "동일상품 합포가능 수량","로케이션","메모","제조사","사은품","담당MD","관리자(정)",
    "관리자(부)","무료배송","카테고리","배송타입","매장간이동","판매시작일","입고대기",
    "판매처코드 / 판매처명","상품태그","상품추가항목1","상품추가항목2","상품추가항목3",
    "상품추가항목4","상품추가항목5","상품추가항목6","상품추가항목7","상품추가항목8",
    "상품추가항목9","상품추가항목10","소진시 품절","입고시 품절해제","소진시 일시품절",
    "입고시 일시품절해제","옵션추가항목1","옵션추가항목2","옵션추가항목3","옵션추가항목4",
    "옵션추가항목5","옵션추가금액(원가)","옵션추가금액(판매가)","매칭시 자동취소",
    "유통기한 경고 설정","판매상태","원가메모","재고단위1","재고단위2","재고단위3","재고단위4","재고단위5"
]

_FRONT_BRACKETS = re.compile(r'^(\s*\[[^\]]*\]\s*)+')
_BACK_BRACKETS = re.compile(r'(\s*\[[^\]]*\]\s*)+$')


def _strip_edge_brackets(text):
    if pd.isna(text):
        return text
    s = str(text)
    s = re.sub(_FRONT_BRACKETS, '', s)
    s = re.sub(_BACK_BRACKETS, '', s)
    return s.strip()


def _split_b_to_c_and_h(value):
    if pd.isna(value):
        return pd.NA, pd.NA
    s = str(value).strip()
    if not s:
        return pd.NA, pd.NA
    parts = s.split()
    if len(parts) <= 2:
        return " ".join(parts), pd.NA
    if len(parts) == 3:
        c_part = " ".join(parts[:2])
        try:
            h_part = int(parts[2])
        except ValueError:
            h_part = pd.NA
        return c_part, h_part
    return " ".join(parts), pd.NA


def _split_l_values(value):
    if pd.isna(value):
        return pd.NA, pd.NA, pd.NA
    tokens = [t.strip() for t in str(value).split(',') if t.strip()]
    tokens = [f":{t}" for t in tokens[:3]]
    while len(tokens) < 3:
        tokens.append(pd.NA)
    return tokens[0], tokens[1], tokens[2]


def _col_to_num(col: str) -> int:
    n = 0
    for ch in col:
        n = n * 26 + (ord(ch) - 64)
    return n


def _pos0(col: str) -> int:
    return _col_to_num(col) - 1


def _save_as_xls_bytes(df: pd.DataFrame) -> bytes:
    book = xlwt.Workbook()
    sheet = book.add_sheet("Sheet1")
    for j, col in enumerate(df.columns):
        sheet.write(0, j, col)
    for i, row in df.iterrows():
        for j, val in enumerate(row):
            if pd.isna(val):
                sheet.write(i + 1, j, "")
            else:
                sheet.write(i + 1, j, val)
    buf = io.BytesIO()
    book.save(buf)
    return buf.getvalue()


def _process_easyadmin_product_upload(path: Path) -> bytes:
    ext = path.suffix.lower()
    if ext == ".xlsx":
        df = pd.read_excel(path, engine="openpyxl")
    elif ext == ".xls":
        df = pd.read_excel(path)
    elif ext == ".csv":
        try:
            df = pd.read_csv(path, encoding="utf-8")
        except UnicodeDecodeError:
            df = pd.read_csv(path, encoding="cp949")
    else:
        raise ValueError("지원 형식: xlsx, xls, csv")

    if df.shape[1] < 12:
        raise ValueError("원본 파일에 최소 12열(C, H, L 포함)이 필요합니다.")

    series_b = df.iloc[:, 1]
    series_c = df.iloc[:, 2]
    series_h = df.iloc[:, 7]
    series_l = df.iloc[:, 11]

    col_a = series_c.apply(_strip_edge_brackets)
    col_b = pd.Series(["유색"] * len(df), index=df.index)
    ch_df = series_b.apply(lambda v: pd.Series(_split_b_to_c_and_h(v)))
    lmn_df = series_l.apply(lambda v: pd.Series(_split_l_values(v)))

    out = pd.DataFrame("", index=df.index, columns=HEADER_LIST)
    out.iloc[:, _pos0('A')] = col_a
    out.iloc[:, _pos0('B')] = col_b
    out.iloc[:, _pos0('C')] = ch_df.iloc[:, 0]
    out.iloc[:, _pos0('H')] = ch_df.iloc[:, 1]
    out.iloc[:, _pos0('L')] = lmn_df.iloc[:, 0]
    out.iloc[:, _pos0('M')] = lmn_df.iloc[:, 1]
    out.iloc[:, _pos0('N')] = lmn_df.iloc[:, 2]
    out.iloc[:, _pos0('O')] = 1
    out.iloc[:, _pos0('BG')] = series_h

    return _save_as_xls_bytes(out)

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


def _get_user_role(username: str) -> str:
    conn = _get_db()
    row = conn.execute("SELECT role FROM users WHERE username = ?", (username,)).fetchone()
    conn.close()
    return row["role"] if row and row["role"] else "user"


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
        conn.execute("UPDATE users SET role = 'admin' WHERE username = ?", (username,))
        conn.commit()
        conn.close()
        return
    conn.execute(
        "INSERT INTO users (username, password_hash, display_name, role, created_at) VALUES (?, ?, ?, ?, ?)",
        (username, _hash_password(password), display_name, "admin", datetime.utcnow().isoformat()),
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


def _to_int(value, default=0):
    try:
        if value is None or (isinstance(value, str) and not value.strip()):
            return default
        return int(float(str(value).strip()))
    except Exception:
        return default


_ensure_bootstrap_admin()


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


def _require_admin(user: str = Depends(_get_current_user)):
    if not _is_admin(user):
        raise HTTPException(status_code=403, detail="admin required")
    return user


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
            "INSERT INTO users (username, password_hash, display_name, role, created_at) VALUES (?, ?, ?, ?, ?)",
            (username, _hash_password(password), display_name, "user", datetime.utcnow().isoformat()),
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
    role = row["role"] if row["role"] else "user"
    return {
        "ok": True,
        "token": token,
        "username": username,
        "display_name": row["display_name"],
        "role": role,
        "is_admin": role == "admin",
    }


@app.options("/auth/login")
def login_options():
    return {}


@app.get("/auth/me")
def me(user: str = Depends(_get_current_user)):
    conn = _get_db()
    row = conn.execute("SELECT display_name, role FROM users WHERE username = ?", (user,)).fetchone()
    conn.close()
    display_name = row["display_name"] if row else ""
    role = row["role"] if row and row["role"] else "user"
    return {"ok": True, "username": user, "display_name": display_name, "role": role, "is_admin": role == "admin"}


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


@app.post("/barcode/incoming/upload")
async def incoming_upload(file: UploadFile = File(...), user: str = Depends(_get_current_user)):
    name = (file.filename or "").lower()
    if not (name.endswith(".xls") or name.endswith(".xlsx")):
        raise HTTPException(status_code=400, detail="xls/xlsx files only")

    suffix = ".xlsx" if name.endswith(".xlsx") else ".xls"
    tmp_path = Path(tempfile.gettempdir()) / f"yusaek_incoming_{uuid.uuid4().hex}{suffix}"
    data = await file.read()
    tmp_path.write_bytes(data)

    try:
        wb, ws = load_excel_any(tmp_path)
        counts = Counter()
        for r in range(1, ws.max_row + 1):
            code_raw = ws.cell(r, 1).value
            qty_raw = ws.cell(r, 2).value
            code = normalize_to_yusas(code_raw)
            if not code:
                continue
            qty = _to_int(qty_raw, default=0)
            if qty > 0:
                counts[code] += qty
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"incoming load failed: {e}")

    STATE["incoming_counts"] = dict(counts)
    return {"ok": True, "codes": len(counts), "total_qty": sum(counts.values())}


@app.post("/barcode/product/upload")
async def easyadmin_product_upload(file: UploadFile = File(...), user: str = Depends(_get_current_user)):
    name = (file.filename or "").lower()
    if not (name.endswith(".xls") or name.endswith(".xlsx") or name.endswith(".csv")):
        raise HTTPException(status_code=400, detail="xls/xlsx/csv만 업로드 가능")

    suffix = Path(name).suffix or ".xlsx"
    tmp_path = Path(tempfile.gettempdir()) / f"yusaek_easyadmin_{uuid.uuid4().hex}{suffix}"
    data = await file.read()
    tmp_path.write_bytes(data)

    try:
        xls_bytes = _process_easyadmin_product_upload(tmp_path)
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"가공 실패: {e}")

    filename = f"easyadmin_products_{datetime.now().strftime('%Y%m%d_%H%M%S')}.xls"
    headers = {"Content-Disposition": f'attachment; filename="{filename}"'}
    return Response(content=xls_bytes, media_type="application/vnd.ms-excel", headers=headers)


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

    incoming_counts = STATE.get("incoming_counts") or {}
    items = []
    for code in codes:
        remain = mapping[inv].get(code, 0)
        run_len = (STATE["runs"] or {}).get(inv, {}).get(code, 0)
        defect_n = (STATE["defect_counts"] or {}).get(code, 0)
        incoming_n = incoming_counts.get(code, 0)
        det = (STATE["details"] or {}).get(inv, {}).get(code, {})
        items.append(
            {
                "code": code,
                "name": det.get("name", "") or "",
                "option": det.get("option", "") or "",
                "remain": remain,
                "run_len": run_len,
                "defect": defect_n,
                "incoming": incoming_n,
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


def _build_defect_csv() -> str:
    defect_counts = STATE.get("defect_counts") or {}
    code_o_text = STATE.get("code_o_text") or {}
    lines = ["A열(O왼쪽),B열(O오른쪽),C열(옵션명),D열(불량수량)"]
    for code, n in sorted(defect_counts.items()):
        det = _find_item_detail_by_code(code)
        opt = det.get("option", "") or ""
        o_text = (code_o_text.get(code) or "").strip()
        if not o_text:
            name = det.get("name", "") or ""
            o_text = f"{code} {name}".strip()
        o_text = str(o_text).strip().replace(",", " ")
        if " " in o_text:
            left, right = o_text.split(" ", 1)
        else:
            left, right = o_text, ""
        opt_clean = (opt or "").replace(",", " ")
        lines.append(f"{left},{right},{opt_clean},{n}")
    return "\n".join(lines) + "\n"


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


@app.get("/barcode/defect/export")
def export_defects(user: str = Depends(_get_current_user)):
    if not STATE["loaded"]:
        raise HTTPException(status_code=400, detail="먼저 엑셀을 업로드해주세요")
    if not (STATE.get("defect_counts") or {}):
        raise HTTPException(status_code=400, detail="불량 목록이 비어있습니다")
    csv_text = _build_defect_csv()
    filename = f"defects_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"
    headers = {"Content-Disposition": f'attachment; filename=\"{filename}\"'}
    csv_bytes = csv_text.encode("utf-8-sig")
    return Response(content=csv_bytes, media_type="text/csv; charset=utf-8", headers=headers)


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


@app.get("/admin/users")
def admin_list_users(admin: str = Depends(_require_admin)):
    conn = _get_db()
    rows = conn.execute(
        "SELECT username, display_name, role, created_at FROM users ORDER BY username ASC"
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
            }
            for r in rows
        ],
    }


@app.patch("/admin/users/{target}/role")
def admin_set_role(target: str, payload: dict = Body(...), admin: str = Depends(_require_admin)):
    role = (payload.get("role") or "").strip()
    if role not in ("admin", "user"):
        raise HTTPException(status_code=400, detail="invalid role")

    conn = _get_db()
    row = conn.execute("SELECT role FROM users WHERE username = ?", (target,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="user not found")

    current_role = row["role"] if row["role"] else "user"
    if current_role == "admin" and role != "admin" and _count_admins() <= 1:
        conn.close()
        raise HTTPException(status_code=400, detail="cannot remove last admin")

    conn.execute("UPDATE users SET role = ? WHERE username = ?", (role, target))
    conn.commit()
    conn.close()
    return {"ok": True, "username": target, "role": role}


@app.delete("/admin/users/{target}")
def admin_delete_user(target: str, admin: str = Depends(_require_admin)):
    if target == admin:
        raise HTTPException(status_code=400, detail="cannot delete self")

    conn = _get_db()
    row = conn.execute("SELECT role FROM users WHERE username = ?", (target,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="user not found")

    role = row["role"] if row["role"] else "user"
    if role == "admin" and _count_admins() <= 1:
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


@app.delete("/requests/assigned/clear")
def clear_assigned_requests(user: str = Depends(_get_current_user)):
    conn = _get_db()
    conn.execute(
        "DELETE FROM requests WHERE assignee_username = ? AND status = 'completed'",
        (user,),
    )
    conn.commit()
    conn.close()
    return {"ok": True}


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
        ORDER BY (status = 'completed') DESC,
                 completed_at DESC,
                 created_at DESC
        """,
        (user,),
    ).fetchall()
    conn.close()

    items = []
    for row in rows:
        if row["status"] == "completed" and not _is_visible_completed(row["completed_at"]):
            continue
        item = _row_to_request(row)
        item["can_ack"] = row["status"] == "completed" and row["acknowledged_at"] is None
        items.append(item)

    return {"ok": True, "requests": items}


@app.delete("/requests/sent/clear")
def clear_sent_requests(user: str = Depends(_get_current_user)):
    conn = _get_db()
    conn.execute(
        "DELETE FROM requests WHERE requester_username = ? AND status = 'completed'",
        (user,),
    )
    conn.commit()
    conn.close()
    return {"ok": True}


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
