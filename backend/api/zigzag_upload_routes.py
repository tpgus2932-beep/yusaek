from __future__ import annotations
import asyncio
import re
import time
from datetime import datetime
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, Body, Depends, HTTPException

from sdk.ably import AblyClient
from sdk.zigzag import ZigzagClient
from services.image_utils import get_image_dimensions

# 법정 표시정보 - 에이블리/지그재그 둘 다 상세페이지 이미지 안에 실제 값이 들어있고
# 구조화된 텍스트로는 제공되지 않아, 실제 캡처된 지그재그 등록 요청과 동일하게
# "상품 상세페이지 참조"로 고정한다 (요청 사항).
_FIXED_ESSENTIALS = [
    {"key": "material", "name": "제품소재", "value": "상품 상세페이지 참조"},
    {"key": "color", "name": "색상", "value": "상품 상세페이지 참조"},
    {"key": "size", "name": "치수/크기", "value": "상품 상세페이지 참조"},
    {"key": "date_of_production", "name": "제조년월", "value": "상품 상세페이지 참조"},
    {"key": "washing_method_precautions", "name": "세탁방법 및 취급시 주의사항", "value": "상품 상세페이지 참조"},
    {"key": "country_of_manufacturer", "name": "제조국", "value": "상품 상세페이지 참조"},
    {"key": "manufacturer", "name": "제조자", "value": "상품 상세페이지 참조"},
    {"key": "importer", "name": "수입자", "value": "상품 상세페이지 참조"},
    {"key": "quality_assurance", "name": "품질보증기준", "value": "상품 상세페이지 참조"},
    {"key": "as_manager", "name": "AS책임자", "value": "상품 상세페이지 참조"},
    {"key": "phone_number", "name": "전화번호", "value": "상품 상세페이지 참조"},
]

# 배송/반품지 주소 ID - 지그재그 파트너센터에 등록된 값 고정 (요청 사항).
_FIXED_ADDRESS = {"return_id": "48093", "shipping_id": "48093"}

# 배송비 정책 - 에이블리 쪽에 대응 필드가 없어 실제 캡처된 요청값으로 고정.
_FIXED_SHIPPING_FEE = {
    "area_fee": {"isolated": 6000, "jeju": 6000},
    "base_fee": 0,
    "exchange_fee": 6000,
    "fee_type": "FREE",
    "return_fee": {"total": 6000, "partial": 6000},
    "payment_type": "ON_ORDER",
}

# 재고 수량 - 에이블리 실재고를 그대로 넣으면 0인 옵션에서 지그재그가
# ITEM_QUANTITY_INVALID(ON_SALE인데 재고 0)로 등록을 거부해서, 실제 캡처된
# 요청값과 동일하게 고정 수량으로 채운다 (요청 사항).
_FIXED_ITEM_QUANTITY = 9999

_IMG_TAG_RE = re.compile(r'<img[^>]*\bsrc=["\']([^"\']+)["\'][^>]*>', re.IGNORECASE)
_STYLE_ATTR_RE = re.compile(r'style=(["\'])(.*?)\1', re.IGNORECASE)
_DETAIL_IMAGE_GAP_PX = 46


def _add_img_margin_top(tag: str, px: int) -> str:
    """<img> 태그에 margin-top 스타일을 추가한다 (기존 style 속성이 있으면 이어붙임)."""
    css = f"margin-top:{px}px"
    m = _STYLE_ATTR_RE.search(tag)
    if m:
        quote = m.group(1)
        existing = m.group(2).strip().rstrip(";")
        new_value = f"{existing};{css}" if existing else css
        return tag[:m.start()] + f"style={quote}{new_value}{quote}" + tag[m.end():]
    insert_at = len(tag) - (2 if tag.rstrip().endswith("/>") else 1)
    return f'{tag[:insert_at].rstrip()} style="{css}"{tag[insert_at:]}'
_EXT_CONTENT_TYPE = {
    "jpeg": "image/jpeg",
    "png": "image/png",
    "webp": "image/webp",
    "gif": "image/gif",
}


def _guess_extension(url: str) -> str:
    path = urlparse(url).path.lower()
    if path.endswith(".png"):
        return "png"
    if path.endswith(".webp"):
        return "webp"
    if path.endswith(".gif"):
        return "gif"
    return "jpeg"


def _category_leaf_list(tree: dict) -> list[dict]:
    root = tree.get("category_list") or {}

    out: list[dict] = []

    def walk(node: dict, path: str):
        children = node.get("children") or []
        name = node.get("name") or ""
        full_path = f"{path}>{name}" if path else name
        if not children:
            out.append({"id": node.get("id"), "name": name, "full_path": full_path})
            return
        for child in children:
            walk(child, full_path)

    for top in root.get("children") or []:
        walk(top, "")
    return out


def build_zigzag_upload_router(*, get_current_user, get_shared_db):
    router = APIRouter()

    _schema_migrated: dict = {"done": False}

    def _init_tables(conn):
        conn.execute("""
            CREATE TABLE IF NOT EXISTS zigzag_category_mapping (
                ably_category_sno INTEGER PRIMARY KEY,
                ably_category_name TEXT NOT NULL DEFAULT '',
                zigzag_category_id TEXT NOT NULL,
                zigzag_category_name TEXT NOT NULL DEFAULT '',
                zigzag_category_path TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_by TEXT NOT NULL DEFAULT ''
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS zigzag_uploaded_products (
                ably_goods_sno INTEGER PRIMARY KEY,
                zigzag_product_id TEXT NOT NULL,
                ably_goods_name TEXT NOT NULL DEFAULT '',
                uploaded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                uploaded_by TEXT NOT NULL DEFAULT ''
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS zigzag_ably_products_cache (
                sno INTEGER PRIMARY KEY,
                name TEXT NOT NULL DEFAULT '',
                image TEXT NOT NULL DEFAULT '',
                custom_code TEXT NOT NULL DEFAULT '',
                price INTEGER NOT NULL DEFAULT 0,
                is_open INTEGER NOT NULL DEFAULT 0,
                is_soldout INTEGER NOT NULL DEFAULT 0,
                category_sno INTEGER,
                category_name TEXT NOT NULL DEFAULT '',
                category_path TEXT NOT NULL DEFAULT '',
                registered_at TEXT NOT NULL DEFAULT '',
                synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        """)
        conn.commit()
        if not _schema_migrated["done"]:
            cols = [r["name"] for r in conn.execute("PRAGMA table_info(zigzag_ably_products_cache)").fetchall()]
            if "registered_at" not in cols:
                conn.execute("ALTER TABLE zigzag_ably_products_cache ADD COLUMN registered_at TEXT NOT NULL DEFAULT ''")
                conn.commit()
            _schema_migrated["done"] = True

    # 캐시 동기화는 Turso(HTTP) upsert 특성상 1990건 기준 약 40~50초가 걸린다.
    # 요청-응답 안에서 그대로 기다리면 리버스 프록시 타임아웃(502)에 걸리므로,
    # 백그라운드 태스크로 돌리고 상태만 폴링하게 한다.
    _sync_status: dict = {"status": "idle", "count": 0, "error": None, "started_at": None, "finished_at": None}

    async def _run_sync_in_background():
        _sync_status.update(status="running", error=None, started_at=time.time())
        try:
            count = await _sync_ably_products_cache()
            _sync_status.update(status="done", count=count, finished_at=time.time())
        except Exception as e:
            _sync_status.update(status="error", error=str(e), finished_at=time.time())

    async def _sync_ably_products_cache() -> int:
        """에이블리 전체 상품을 페이지네이션으로 긁어와 캐시 테이블을 갱신한다.

        상품검색 API(search_goods)가 서버단 키워드 필터를 지원하지 않아, 검색은
        이 캐시 테이블에 대해 SQL LIKE로 수행한다. 더 이상 존재하지 않는 상품은
        이번 동기화에서 갱신되지 않은(synced_at이 다른) 행으로 걸러내 삭제한다.
        """
        conn = get_shared_db()
        try:
            _init_tables(conn)
            sync_started = datetime.utcnow().isoformat()
            ably = AblyClient()
            per_page = 100

            first_page = await ably.search_goods(page=1, per_page=per_page)
            max_page = first_page.get("max_page_number", 1)
            pages = [first_page]

            if max_page > 1:
                # 에이블리 페이지 조회는 서로 독립적이므로 동시에 가져온다
                # (순차로 하면 20페이지 기준 응답 지연이 그대로 누적됨).
                semaphore = asyncio.Semaphore(5)

                async def _fetch(p: int):
                    async with semaphore:
                        return await ably.search_goods(page=p, per_page=per_page)

                pages.extend(await asyncio.gather(*[_fetch(p) for p in range(2, max_page + 1)]))

            all_rows = []
            for data in pages:
                for g in data.get("goods") or []:
                    cat = g.get("standard_category") or {}
                    all_rows.append((
                        g.get("sno"), g.get("name") or "", g.get("image") or "", g.get("custom_code") or "",
                        g.get("price") or 0, 1 if g.get("is_open") else 0, 1 if g.get("is_soldout") else 0,
                        cat.get("sno"), cat.get("name") or "", cat.get("full_path") or "",
                        g.get("registered_at") or "", sync_started,
                    ))

            upsert_sql = """
                INSERT INTO zigzag_ably_products_cache
                    (sno, name, image, custom_code, price, is_open, is_soldout, category_sno, category_name, category_path, registered_at, synced_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(sno) DO UPDATE SET
                    name = excluded.name,
                    image = excluded.image,
                    custom_code = excluded.custom_code,
                    price = excluded.price,
                    is_open = excluded.is_open,
                    is_soldout = excluded.is_soldout,
                    category_sno = excluded.category_sno,
                    category_name = excluded.category_name,
                    category_path = excluded.category_path,
                    registered_at = excluded.registered_at,
                    synced_at = excluded.synced_at
            """
            # 상품 하나씩 execute()하면 Turso(HTTP) 기준 왕복이 수천 번 발생해 타임아웃(502)이
            # 나므로, 덩어리로 묶어 executemany로 보낸다. executemany 자체도 동기(blocking)
            # HTTP 호출이라 이벤트 루프를 그대로 막아 다른 요청(/zigzag/upload 등)이 지연될 수
            # 있어 스레드로 넘기고, 청크 크기도 작게 잡아 한 트랜잭션이 Turso 쪽을 오래
            # 잡아두지 않게 한다 (500건 기준 실측 약 10~12초 걸려 동시 요청이 지연됨을 확인).
            loop = asyncio.get_running_loop()
            chunk_size = 150
            for i in range(0, len(all_rows), chunk_size):
                chunk = all_rows[i:i + chunk_size]
                await loop.run_in_executor(None, conn.executemany, upsert_sql, chunk)

            await loop.run_in_executor(
                None, conn.execute, "DELETE FROM zigzag_ably_products_cache WHERE synced_at != ?", (sync_started,)
            )
            conn.commit()
            return len(all_rows)
        finally:
            conn.close()

    _category_cache: dict = {"items": None, "at": 0.0}

    async def _get_category_list() -> list[dict]:
        now = time.time()
        if _category_cache["items"] is not None and now - _category_cache["at"] < 3600:
            return _category_cache["items"]
        client = ZigzagClient()
        try:
            tree = await client.get_managed_category_tree()
        finally:
            await client.close()
        items = _category_leaf_list(tree)
        _category_cache["items"] = items
        _category_cache["at"] = now
        return items

    @router.get("/zigzag/categories")
    async def zigzag_categories(user: str = Depends(get_current_user)):
        try:
            items = await _get_category_list()
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"지그재그 카테고리 조회 실패: {e}")
        return {"ok": True, "count": len(items), "items": items}

    @router.get("/zigzag/category-mapping")
    def zigzag_category_mapping_list(user: str = Depends(get_current_user)):
        conn = get_shared_db()
        try:
            _init_tables(conn)
            rows = conn.execute(
                "SELECT * FROM zigzag_category_mapping ORDER BY ably_category_name ASC"
            ).fetchall()
            return {"ok": True, "items": [dict(r) for r in rows]}
        finally:
            conn.close()

    @router.post("/zigzag/category-mapping")
    def zigzag_category_mapping_save(payload: dict = Body(...), user: str = Depends(get_current_user)):
        ably_sno = payload.get("ably_category_sno")
        zz_id = str(payload.get("zigzag_category_id") or "").strip()
        if not ably_sno or not zz_id:
            raise HTTPException(status_code=400, detail="ably_category_sno, zigzag_category_id는 필수입니다.")
        ably_name = str(payload.get("ably_category_name") or "").strip()
        zz_name = str(payload.get("zigzag_category_name") or "").strip()
        zz_path = str(payload.get("zigzag_category_path") or "").strip()

        conn = get_shared_db()
        try:
            _init_tables(conn)
            conn.execute("""
                INSERT INTO zigzag_category_mapping
                    (ably_category_sno, ably_category_name, zigzag_category_id, zigzag_category_name, zigzag_category_path, updated_at, updated_by)
                VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)
                ON CONFLICT(ably_category_sno) DO UPDATE SET
                    ably_category_name = excluded.ably_category_name,
                    zigzag_category_id = excluded.zigzag_category_id,
                    zigzag_category_name = excluded.zigzag_category_name,
                    zigzag_category_path = excluded.zigzag_category_path,
                    updated_at = CURRENT_TIMESTAMP,
                    updated_by = excluded.updated_by
            """, (int(ably_sno), ably_name, zz_id, zz_name, zz_path, user))
            conn.commit()
            return {"ok": True}
        finally:
            conn.close()

    @router.delete("/zigzag/category-mapping/{ably_category_sno}")
    def zigzag_category_mapping_delete(ably_category_sno: int, user: str = Depends(get_current_user)):
        conn = get_shared_db()
        try:
            _init_tables(conn)
            conn.execute("DELETE FROM zigzag_category_mapping WHERE ably_category_sno = ?", (ably_category_sno,))
            conn.commit()
            return {"ok": True}
        finally:
            conn.close()

    @router.get("/zigzag/uploaded")
    def zigzag_uploaded_list(user: str = Depends(get_current_user)):
        conn = get_shared_db()
        try:
            _init_tables(conn)
            rows = conn.execute(
                "SELECT * FROM zigzag_uploaded_products ORDER BY uploaded_at DESC"
            ).fetchall()
            return {"ok": True, "items": [dict(r) for r in rows]}
        finally:
            conn.close()

    @router.post("/zigzag/ably-products/sync")
    async def zigzag_ably_products_sync(user: str = Depends(get_current_user)):
        if _sync_status["status"] == "running":
            return {"ok": True, "already_running": True}
        asyncio.create_task(_run_sync_in_background())
        return {"ok": True, "started": True}

    @router.get("/zigzag/ably-products/sync-status")
    async def zigzag_ably_products_sync_status(user: str = Depends(get_current_user)):
        return {"ok": True, **_sync_status}

    @router.get("/zigzag/ably-products")
    async def zigzag_ably_products(
        q: str = "",
        date_from: str = "",
        date_to: str = "",
        page: int = 1,
        per_page: int = 30,
        user: str = Depends(get_current_user),
    ):
        page = max(1, page)
        per_page = min(max(1, per_page), 100)

        conn = get_shared_db()
        try:
            _init_tables(conn)
            cached_count = conn.execute("SELECT COUNT(*) FROM zigzag_ably_products_cache").fetchone()[0]
        finally:
            conn.close()

        if cached_count == 0 and _sync_status["status"] != "running":
            # 최초 진입 시 캐시가 비어있으면 백그라운드로 동기화를 걸어두고
            # 빈 목록 + syncing 플래그로 즉시 응답한다 (요청 안에서 안 기다림).
            asyncio.create_task(_run_sync_in_background())
            return {"ok": True, "page": 1, "max_page": 1, "total_count": 0, "items": [], "synced_at": None, "syncing": True}

        conn = get_shared_db()
        try:
            _init_tables(conn)
            clauses: list[str] = []
            params: list = []
            keyword = q.strip()
            if keyword:
                like = f"%{keyword}%"
                clauses.append("(name LIKE ? OR custom_code LIKE ? OR category_name LIKE ?)")
                params.extend([like, like, like])
            if date_from.strip():
                clauses.append("registered_at >= ?")
                params.append(date_from.strip())
            if date_to.strip():
                clauses.append("registered_at <= ?")
                params.append(f"{date_to.strip()}T23:59:59.999999")
            where = f"WHERE {' AND '.join(clauses)}" if clauses else ""

            total_count = conn.execute(
                f"SELECT COUNT(*) FROM zigzag_ably_products_cache {where}", params
            ).fetchone()[0]
            offset = (page - 1) * per_page
            rows = conn.execute(
                f"SELECT * FROM zigzag_ably_products_cache {where} ORDER BY sno DESC LIMIT ? OFFSET ?",
                [*params, per_page, offset],
            ).fetchall()
            synced_at_row = conn.execute("SELECT MAX(synced_at) AS t FROM zigzag_ably_products_cache").fetchone()

            mapped_snos = {
                r["ably_category_sno"]
                for r in conn.execute("SELECT ably_category_sno FROM zigzag_category_mapping").fetchall()
            }
            uploaded_map = {
                r["ably_goods_sno"]: r["zigzag_product_id"]
                for r in conn.execute("SELECT ably_goods_sno, zigzag_product_id FROM zigzag_uploaded_products").fetchall()
            }
        finally:
            conn.close()

        items = []
        for g in rows:
            items.append({
                "sno": g["sno"],
                "name": g["name"],
                "image": g["image"],
                "custom_code": g["custom_code"],
                "price": g["price"],
                "is_open": bool(g["is_open"]),
                "is_soldout": bool(g["is_soldout"]),
                "registered_at": g["registered_at"],
                "category_sno": g["category_sno"],
                "category_name": g["category_name"],
                "category_path": g["category_path"],
                "category_mapped": g["category_sno"] in mapped_snos,
                "zigzag_product_id": uploaded_map.get(g["sno"]),
            })

        return {
            "ok": True,
            "page": page,
            "max_page": max(1, -(-total_count // per_page)),
            "total_count": total_count,
            "items": items,
            "synced_at": synced_at_row["t"] if synced_at_row else None,
        }

    async def _download_and_reupload(zigzag: ZigzagClient, url: str) -> dict:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.get(url)
        resp.raise_for_status()
        content = resp.content
        ext = _guess_extension(url)
        presigned = await zigzag.get_upload_presigned_url(extension=ext)
        await zigzag.upload_image_bytes(
            presigned["pre_signed_url"], content, content_type=_EXT_CONTENT_TYPE.get(ext, "image/jpeg")
        )
        width, height = get_image_dimensions(content)
        # GetCatalogUploadPreSignedUrl 응답의 key는 디렉터리까지만 오고 파일명이
        # 빠져있어(실제 캡처로 확인 - 예: "original/d/2026/8/10/") 그대로 쓰면
        # CreateCatalogProduct에서 존재하지 않는 파일을 가리켜 이미지가 깨진다.
        # origin_url 경로에서 파일명까지 포함된 실제 key를 다시 뽑아 쓴다.
        real_key = urlparse(presigned["origin_url"]).path.lstrip("/")
        return {"key": real_key, "origin_url": presigned["origin_url"], "width": width, "height": height}

    @router.post("/zigzag/upload")
    async def zigzag_upload(payload: dict = Body(...), user: str = Depends(get_current_user)):
        ably_goods_sno = payload.get("ably_goods_sno")
        if not ably_goods_sno:
            raise HTTPException(status_code=400, detail="ably_goods_sno가 필요합니다.")

        try:
            goods = await AblyClient().get_goods_detail(ably_goods_sno)
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"에이블리 상품 조회 실패: {e}")
        if not goods:
            raise HTTPException(status_code=404, detail="에이블리 상품을 찾을 수 없습니다.")

        std_cat = goods.get("standard_category") or {}
        ably_category_sno = std_cat.get("sno")
        ably_category_name = std_cat.get("full_path") or std_cat.get("name") or ""
        if not ably_category_sno:
            raise HTTPException(status_code=400, detail="에이블리 상품에 카테고리 정보가 없습니다.")

        conn = get_shared_db()
        try:
            _init_tables(conn)
            row = conn.execute(
                "SELECT * FROM zigzag_category_mapping WHERE ably_category_sno = ?", (ably_category_sno,)
            ).fetchone()
            mapping = dict(row) if row else None
        finally:
            conn.close()

        if not mapping:
            return {
                "ok": False,
                "need_mapping": True,
                "ably_category_sno": ably_category_sno,
                "ably_category_name": ably_category_name,
            }

        zigzag = ZigzagClient()
        try:
            covers = goods.get("covers") or ([goods["image"]] if goods.get("image") else [])
            if not covers:
                raise HTTPException(status_code=400, detail="상품 이미지가 없습니다.")

            image_list = []
            for idx, url in enumerate(covers):
                try:
                    uploaded = await _download_and_reupload(zigzag, url)
                except HTTPException:
                    raise
                except Exception as e:
                    raise HTTPException(status_code=502, detail=f"이미지 업로드 실패 ({url}): {e}")
                image_list.append({
                    "origin_url": uploaded["origin_url"],
                    "key": uploaded["key"],
                    "image_type": "MAIN" if idx == 0 else "SUB",
                    "width": uploaded["width"],
                    "height": uploaded["height"],
                })

            description_html = goods.get("description") or ""
            img_urls = list(dict.fromkeys(_IMG_TAG_RE.findall(description_html)))
            url_to_key: dict[str, str] = {}
            for url in img_urls:
                try:
                    uploaded = await _download_and_reupload(zigzag, url)
                    url_to_key[url] = uploaded["key"]
                except Exception:
                    continue  # 상세 이미지 개별 실패는 건너뛰고 본품 등록은 계속 진행

            # 에이블리 상세페이지 사진들을 지그재그로 옮길 때 사진 사이 간격이 없어
            # 다닥다닥 붙어보이는 문제가 있어, 사진마다(첫 장 제외) 46px 간격을 띄워준다 (요청 사항).
            _img_index = [0]

            def _replace_src(match: re.Match) -> str:
                idx = _img_index[0]
                _img_index[0] += 1
                src = match.group(1)
                key = url_to_key.get(src)
                tag = match.group(0)
                if key:
                    tag = tag.replace(src, f"zigzag://{key}")
                if idx > 0:
                    tag = _add_img_margin_top(tag, _DETAIL_IMAGE_GAP_PX)
                return tag

            description_html = _IMG_TAG_RE.sub(_replace_src, description_html)

            option_groups = goods.get("option_groups") or []
            group_name_by_sno = {g.get("sno"): g.get("name") for g in option_groups}
            product_option_list = [
                {
                    "id": None,
                    "order": idx,
                    "name": g.get("name"),
                    "value_list": [
                        {
                            "id": None,
                            "code": None,
                            "value": attr.get("value"),
                            "image_key": None,
                            "image_url": None,
                            "order": vi,
                            "attribute_list": [],
                        }
                        for vi, attr in enumerate(g.get("option_attributes") or [])
                    ],
                    "option_type": "BASIC",
                    "format": "TEXT",
                }
                for idx, g in enumerate(option_groups)
            ]

            item_list = []
            for opt in goods.get("options") or []:
                attrs = opt.get("option_attributes") or []
                item_attribute_list = [
                    {"name": group_name_by_sno.get(a.get("option_group_sno"), ""), "value": a.get("value")}
                    for a in attrs
                ]
                option_prices = opt.get("option_prices") or []
                # sale_price/thumbnail_price는 에이블리 자체 특가(관리자 딜) 반영값이라
                # 지그재그에는 seller_price(= consumer - discount_policy.policy_value,
                # 즉 판매자가 매긴 실제 판매가)를 최종 판매가로 써야 한다 (요청 사항).
                option_price = option_prices[0] if option_prices else {}
                sale_price = option_price.get("seller_price")
                if sale_price is None:
                    sale_price = opt.get("price") or 0
                option_values = opt.get("option_values") or [a.get("value") for a in attrs]
                item_list.append({
                    "id": None,
                    "sales_status": "ON_SALE",
                    "item_code": None,
                    "option_type": "BASIC",
                    "shipping_days": 7,
                    "site_country_list": [
                        {"site_id": 1, "country": "KR", "sales_price": sale_price},
                        {"site_id": 3, "country": "KR", "sales_price": sale_price},
                    ],
                    "name": "/".join(str(v) for v in option_values if v),
                    "item_attribute_list": item_attribute_list,
                    "reservation_shipping_list": [],
                    "item_inventory": {"quantity": _FIXED_ITEM_QUANTITY},
                })

            original_price = goods.get("consumer_origin") or goods.get("price_origin") or 0
            product_input = {
                "product_image_list": image_list,
                "essential_code": "FASHION",
                "essentials": _FIXED_ESSENTIALS,
                "name": goods.get("name") or "",
                "description": description_html,
                "display_status": "VISIBLE",
                "fulfillment_type": "MERCHANT",
                "item_list": item_list,
                "site_country_list": [
                    {"site_id": 1, "country": "KR", "original_price": original_price, "shipping_fee": _FIXED_SHIPPING_FEE},
                    {"site_id": 3, "country": "KR", "original_price": original_price, "shipping_fee": _FIXED_SHIPPING_FEE},
                ],
                "product_option_list": product_option_list,
                "product_attribute_list": [],
                "sales_status": "ON_SALE",
                "category": {"category_id": mapping["zigzag_category_id"]},
                "brand_id": None,
                "parallel_imported": "PARALLEL_IMPORTED" if goods.get("is_parallel_import") else "NOT_PARALLEL_IMPORTED",
                "product_code": goods.get("custom_code") or goods.get("sku_code") or "",
                "size_detail_list": None,
                "search_keyword_list": [],
                "order": {
                    "quantity": {
                        "minimum_per_order": 1,
                        "minimum_per_order_type": "ITEM",
                        "maximum_per_order": None,
                        "maximum_per_customer": None,
                    }
                },
                "models": None,
                "editor_mode": "WYSIWYG",
                "shipping_days": 7,
                "shipping_type": "GENERAL",
                "trait_list": [],
                "relation_list": [],
                "bundle_type": "CONSOLIDATED",
                "address": _FIXED_ADDRESS,
                "tax_type": "TAX",
                "reservation_shipping_list": [],
                "cancellation_fee_specification_list": [],
            }

            try:
                zigzag_product_id = await zigzag.create_catalog_product(product_input)
            except Exception as e:
                raise HTTPException(status_code=502, detail=f"지그재그 상품 등록 실패: {e}")
        finally:
            await zigzag.close()

        conn = get_shared_db()
        try:
            _init_tables(conn)
            conn.execute("""
                INSERT INTO zigzag_uploaded_products (ably_goods_sno, zigzag_product_id, ably_goods_name, uploaded_at, uploaded_by)
                VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?)
                ON CONFLICT(ably_goods_sno) DO UPDATE SET
                    zigzag_product_id = excluded.zigzag_product_id,
                    ably_goods_name = excluded.ably_goods_name,
                    uploaded_at = CURRENT_TIMESTAMP,
                    uploaded_by = excluded.uploaded_by
            """, (int(ably_goods_sno), str(zigzag_product_id), goods.get("name") or "", user))
            conn.commit()
        finally:
            conn.close()

        return {"ok": True, "zigzag_product_id": zigzag_product_id}

    return router
