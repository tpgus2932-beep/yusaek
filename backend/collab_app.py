import asyncio
import os
import tempfile
import traceback
import uuid
from datetime import datetime
from pathlib import Path

import httpx
from fastapi import Body, Depends, FastAPI, File, HTTPException, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware

_ABLY_BASE     = "https://api.a-bly.com"
_ABLY_EMAIL    = "eostm1997@naver.com"
_ABLY_PASSWORD = "!Glqgkqdldi1126"

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
from api.sms_routes import build_sms_router
from api.attendance_routes import build_attendance_router
from api.guidebook_routes import build_guidebook_router
from api.amood_settlement_routes import build_amood_settlement_router
from api.ably_settlement_routes import build_ably_settlement_router
from api.misong_routes import build_misong_router
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
    _get_shared_db,
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
from sdk.ably import AblyClient
from services.easyadmin_product import (
    _content_disposition,
    _process_easyadmin_product_upload,
    process_easyadmin_product_from_api,
)


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

_sms_router, _enqueue_sms_fn = build_sms_router(
    get_current_user=_get_current_user,
    get_db=_get_db,
    get_setting=_get_setting,
    set_setting=_set_setting,
    run_local_dispatcher=not os.environ.get("RENDER", ""),  # Render에서는 끔
)
app.include_router(_sms_router)

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
        enqueue_sms=_enqueue_sms_fn,
    )
)


app.include_router(
    build_attendance_router(
        get_db=_get_db,
        get_setting=_get_setting,
        set_setting=_set_setting,
        hash_pin=_hash_pin,
        verify_pin=_verify_pin,
    )
)

_GUIDEBOOK_UPLOAD_BASE = Path(os.environ.get("GUIDEBOOK_UPLOAD_BASE") or os.path.join(BASE_DIR, "uploads", "guidebook_images"))

app.include_router(
    build_guidebook_router(
        get_db=_get_db,
        get_current_user=_get_current_user,
        guidebook_upload_base=_GUIDEBOOK_UPLOAD_BASE,
    )
)

app.include_router(
    build_misong_router(
        get_current_user=_get_current_user,
        get_db=_get_shared_db,
        get_setting=_get_setting,
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


@app.post("/barcode/product/upload-from-api")
async def product_upload_from_api(
    payload: dict = Body(default={}),
    user: str = Depends(_get_current_user),
):
    start_date = payload.get("start_date", "")
    end_date   = payload.get("end_date", "")

    async with httpx.AsyncClient(timeout=15.0) as client:
        res = await client.post(
            f"{_ABLY_BASE}/seller/login/",
            json={"email": _ABLY_EMAIL, "password": _ABLY_PASSWORD},
            headers={
                "Content-Type": "application/json",
                "Origin": "https://seller-admin.a-bly.com",
                "Referer": "https://seller-admin.a-bly.com/",
                "User-Agent": "Mozilla/5.0",
            },
        )
        if not res.is_success:
            raise HTTPException(status_code=502, detail="에이블리 로그인 실패")
    token = res.json().get("token")
    if not token:
        raise HTTPException(status_code=502, detail="에이블리 로그인 실패: 토큰 없음")

    ably_headers = {
        "Authorization": f"JWT {token}",
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Origin": "https://seller-admin.a-bly.com",
        "Referer": "https://seller-admin.a-bly.com/",
        "User-Agent": "Mozilla/5.0",
    }

    all_goods = []
    page = 1
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            while True:
                res = await client.post(
                    f"{_ABLY_BASE}/seller/goods/search/",
                    headers=ably_headers,
                    json={"page": page, "per_page": 30},
                )
                res.raise_for_status()
                data = res.json()
                goods = data.get("goods", [])
                if not goods:
                    break
                all_goods.extend(goods)
                if page >= data.get("max_page_number", 1):
                    break
                page += 1
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"상품 목록 조회 실패: {exc}")

    if start_date or end_date:
        filtered = []
        for g in all_goods:
            date_str = (g.get("registered_at") or g.get("created_at") or "")[:10]
            if start_date and date_str < start_date:
                continue
            if end_date and date_str > end_date:
                continue
            filtered.append(g)
        all_goods = filtered

    if all_goods:
        ably_client = AblyClient()
        ably_client.set_token(token)

        async def _fetch_detail(sno):
            try:
                return sno, await ably_client.get_goods_detail(sno)
            except Exception:
                return sno, {}

        results = await asyncio.gather(*[_fetch_detail(g["sno"]) for g in all_goods])
        detail_map = {sno: detail for sno, detail in results}
        for i, g in enumerate(all_goods):
            detail = detail_map.get(g["sno"])
            if detail:
                all_goods[i] = {
                    **g,
                    "option_groups": detail.get("option_groups") or g.get("option_groups"),
                    "options": detail.get("options") or g.get("options"),
                }

    try:
        xls_bytes = process_easyadmin_product_from_api(all_goods)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"XLS 생성 실패: {exc}")

    filename = f"easyadmin_products_{datetime.now().strftime('%Y%m%d_%H%M%S')}.xls"
    resp_headers = {"Content-Disposition": _content_disposition(filename)}
    return Response(content=xls_bytes, media_type="application/vnd.ms-excel", headers=resp_headers)


app.include_router(
    build_amood_settlement_router(
        get_current_user=_get_current_user,
        get_db=_get_db,
    )
)

app.include_router(
    build_ably_settlement_router(
        get_current_user=_get_current_user,
        get_db=_get_db,
    )
)


@app.get("/ping")
def ping():
    return {"status": "ok", "service": "collab"}


@app.get("/healthz")
def healthz():
    return {"status": "ok", "service": "collab"}


@app.get("/collab/ping")
def collab_ping():
    return {"status": "ok", "service": "collab"}
