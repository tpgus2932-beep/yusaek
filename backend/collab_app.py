import os
import tempfile
import traceback
import uuid
from datetime import datetime
from pathlib import Path

from fastapi import Depends, FastAPI, File, HTTPException, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
os.environ.setdefault("APP_DB_PATH", os.environ.get("COLLAB_DB_PATH", os.path.join(BASE_DIR, "collab_app.db")))
os.environ.setdefault(
    "REQUEST_UPLOAD_BASE",
    os.environ.get("COLLAB_REQUEST_UPLOAD_BASE", os.path.join(BASE_DIR, "uploads", "collab_requests")),
)
os.environ.setdefault(
    "SHARED_UPLOAD_BASE",
    os.environ.get("COLLAB_SHARED_UPLOAD_BASE", os.path.join(BASE_DIR, "uploads", "collab_shared_files")),
)

from api.auth_admin_routes import build_auth_admin_router
from api.collab_routes import build_collab_router
from main import (
    ALLOWED_REQUEST_EXTS,
    ALLOWED_SHARED_EXTS,
    SHARED_UPLOAD_BASE,
    UPLOAD_BASE,
    _count_admins,
    _create_access_token,
    _get_current_user,
    _get_current_user_optional,
    _get_db,
    _get_request_attachments,
    _get_setting,
    _get_user_display,
    _hash_password,
    _hash_pin,
    _is_admin,
    _is_visible_completed,
    _require_admin,
    _row_to_request,
    _row_to_shared_file,
    _set_setting,
    _verify_password,
    _verify_pin,
)
from services.easyadmin_product import _content_disposition, _process_easyadmin_product_upload


def _env_int(name: str, default: int) -> int:
    raw = (os.environ.get(name) or "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _env_origins(name: str) -> list[str]:
    raw = (os.environ.get(name) or "").strip()
    if not raw:
        return ["*"]
    items = [item.strip() for item in raw.split(",")]
    clean = [item for item in items if item]
    return clean or ["*"]


COLLAB_ALLOW_ORIGINS = _env_origins("COLLAB_ALLOW_ORIGINS")
COLLAB_REQUEST_MAX_BYTES = _env_int("COLLAB_REQUEST_MAX_BYTES", 10 * 1024 * 1024)
COLLAB_SHARED_FILE_MAX_BYTES = _env_int("COLLAB_SHARED_FILE_MAX_BYTES", 20 * 1024 * 1024)


app = FastAPI(title="YUSAEK Collab API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=COLLAB_ALLOW_ORIGINS,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
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
        max_request_file_size_bytes=COLLAB_REQUEST_MAX_BYTES,
        max_shared_file_size_bytes=COLLAB_SHARED_FILE_MAX_BYTES,
    )
)


@app.get("/")
def root():
    return {
        "status": "ok",
        "service": "collab",
        "message": "YUSAEK Collab API is running",
    }


@app.post("/barcode/product/upload")
async def product_upload(
    file: UploadFile = File(...),
    user: str = Depends(_get_current_user),
):
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
    headers = {"Content-Disposition": _content_disposition(filename)}
    return Response(content=xls_bytes, media_type="application/vnd.ms-excel", headers=headers)


@app.get("/ping")
def ping():
    return {"status": "ok", "service": "collab"}


@app.get("/healthz")
def healthz():
    return {"status": "ok", "service": "collab"}


@app.get("/collab/ping")
def collab_ping():
    return {"status": "ok", "service": "collab"}
