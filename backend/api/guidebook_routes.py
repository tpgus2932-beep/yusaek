import mimetypes
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Body, Depends, File, HTTPException, Response, UploadFile
from fastapi.responses import FileResponse


GUIDEBOOK_IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg"}


def build_guidebook_router(*, get_db, get_current_user, guidebook_upload_base: Path):
    router = APIRouter()

    def _init_tables():
        conn = get_db()
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS guidebook_categories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS guidebook_pages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                category_id INTEGER,
                title TEXT NOT NULL,
                content TEXT NOT NULL DEFAULT '',
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY (category_id) REFERENCES guidebook_categories(id) ON DELETE SET NULL
            )
            """
        )
        conn.commit()
        conn.close()

    _init_tables()
    guidebook_upload_base.mkdir(parents=True, exist_ok=True)

    def _now():
        return datetime.now(timezone.utc).isoformat()

    # ── Categories ──────────────────────────────────────────────────────────

    @router.get("/guidebook/categories")
    def list_categories(user: str = Depends(get_current_user)):
        conn = get_db()
        cats = conn.execute(
            "SELECT * FROM guidebook_categories ORDER BY sort_order ASC, id ASC"
        ).fetchall()
        pages = conn.execute(
            "SELECT id, category_id, title, sort_order FROM guidebook_pages ORDER BY sort_order ASC, id ASC"
        ).fetchall()
        conn.close()

        cat_map = {}
        result = []
        for c in cats:
            row = dict(c)
            row["pages"] = []
            cat_map[c["id"]] = row
            result.append(row)

        # uncategorized bucket
        uncategorized = {"id": None, "title": "미분류", "sort_order": 9999, "pages": []}

        for p in pages:
            entry = {"id": p["id"], "title": p["title"], "sort_order": p["sort_order"]}
            if p["category_id"] and p["category_id"] in cat_map:
                cat_map[p["category_id"]]["pages"].append(entry)
            else:
                uncategorized["pages"].append(entry)

        if uncategorized["pages"]:
            result.append(uncategorized)

        return result

    @router.post("/guidebook/categories")
    def create_category(payload: dict = Body(...), user: str = Depends(get_current_user)):
        title = (payload.get("title") or "").strip()
        if not title:
            raise HTTPException(status_code=400, detail="title required")
        sort_order = int(payload.get("sort_order") or 0)
        now = _now()
        conn = get_db()
        cur = conn.execute(
            "INSERT INTO guidebook_categories (title, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?)",
            (title, sort_order, now, now),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM guidebook_categories WHERE id = ?", (cur.lastrowid,)).fetchone()
        conn.close()
        return dict(row)

    # /reorder는 반드시 /{cat_id} 보다 먼저 정의해야 FastAPI가 정수 변환을 시도하지 않음
    @router.patch("/guidebook/categories/reorder")
    def reorder_categories(payload: dict = Body(...), user: str = Depends(get_current_user)):
        order = payload.get("order") or []
        now = _now()
        conn = get_db()
        for idx, cat_id in enumerate(order):
            conn.execute(
                "UPDATE guidebook_categories SET sort_order = ?, updated_at = ? WHERE id = ?",
                (idx, now, cat_id),
            )
        conn.commit()
        conn.close()
        return {"ok": True}

    @router.patch("/guidebook/categories/{cat_id}")
    def update_category(cat_id: int, payload: dict = Body(...), user: str = Depends(get_current_user)):
        conn = get_db()
        existing = conn.execute("SELECT * FROM guidebook_categories WHERE id = ?", (cat_id,)).fetchone()
        if not existing:
            conn.close()
            raise HTTPException(status_code=404, detail="category not found")
        title = (payload.get("title") or existing["title"]).strip()
        sort_order = int(payload.get("sort_order") if payload.get("sort_order") is not None else existing["sort_order"])
        now = _now()
        conn.execute(
            "UPDATE guidebook_categories SET title = ?, sort_order = ?, updated_at = ? WHERE id = ?",
            (title, sort_order, now, cat_id),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM guidebook_categories WHERE id = ?", (cat_id,)).fetchone()
        conn.close()
        return dict(row)

    @router.delete("/guidebook/categories/{cat_id}")
    def delete_category(cat_id: int, user: str = Depends(get_current_user)):
        conn = get_db()
        existing = conn.execute("SELECT id FROM guidebook_categories WHERE id = ?", (cat_id,)).fetchone()
        if not existing:
            conn.close()
            raise HTTPException(status_code=404, detail="category not found")
        conn.execute("UPDATE guidebook_pages SET category_id = NULL WHERE category_id = ?", (cat_id,))
        conn.execute("DELETE FROM guidebook_categories WHERE id = ?", (cat_id,))
        conn.commit()
        conn.close()
        return {"ok": True}

    # ── Pages ────────────────────────────────────────────────────────────────

    @router.get("/guidebook/pages/{page_id}")
    def get_page(page_id: int, user: str = Depends(get_current_user)):
        conn = get_db()
        row = conn.execute("SELECT * FROM guidebook_pages WHERE id = ?", (page_id,)).fetchone()
        conn.close()
        if not row:
            raise HTTPException(status_code=404, detail="page not found")
        return dict(row)

    @router.post("/guidebook/pages")
    def create_page(payload: dict = Body(...), user: str = Depends(get_current_user)):
        title = (payload.get("title") or "").strip()
        if not title:
            raise HTTPException(status_code=400, detail="title required")
        content = payload.get("content") or ""
        category_id = payload.get("category_id")
        sort_order = int(payload.get("sort_order") or 0)
        now = _now()
        conn = get_db()
        cur = conn.execute(
            "INSERT INTO guidebook_pages (category_id, title, content, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
            (category_id, title, content, sort_order, now, now),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM guidebook_pages WHERE id = ?", (cur.lastrowid,)).fetchone()
        conn.close()
        return dict(row)

    @router.patch("/guidebook/pages/{page_id}")
    def update_page(page_id: int, payload: dict = Body(...), user: str = Depends(get_current_user)):
        conn = get_db()
        existing = conn.execute("SELECT * FROM guidebook_pages WHERE id = ?", (page_id,)).fetchone()
        if not existing:
            conn.close()
            raise HTTPException(status_code=404, detail="page not found")
        title = (payload.get("title") or existing["title"]).strip()
        content = payload.get("content") if payload.get("content") is not None else existing["content"]
        category_id = payload.get("category_id") if "category_id" in payload else existing["category_id"]
        sort_order = int(payload.get("sort_order") if payload.get("sort_order") is not None else existing["sort_order"])
        now = _now()
        conn.execute(
            "UPDATE guidebook_pages SET title = ?, content = ?, category_id = ?, sort_order = ?, updated_at = ? WHERE id = ?",
            (title, content, category_id, sort_order, now, page_id),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM guidebook_pages WHERE id = ?", (page_id,)).fetchone()
        conn.close()
        return dict(row)

    @router.delete("/guidebook/pages/{page_id}")
    def delete_page(page_id: int, user: str = Depends(get_current_user)):
        conn = get_db()
        existing = conn.execute("SELECT id FROM guidebook_pages WHERE id = ?", (page_id,)).fetchone()
        if not existing:
            conn.close()
            raise HTTPException(status_code=404, detail="page not found")
        conn.execute("DELETE FROM guidebook_pages WHERE id = ?", (page_id,))
        conn.commit()
        conn.close()
        return {"ok": True}

    # ── Search ───────────────────────────────────────────────────────────────

    @router.get("/guidebook/search")
    def search_pages(q: str = "", user: str = Depends(get_current_user)):
        q = q.strip()
        if not q:
            return []
        conn = get_db()
        like = f"%{q}%"
        rows = conn.execute(
            """
            SELECT p.id, p.title, p.category_id, p.sort_order,
                   SUBSTR(p.content, 1, 200) AS excerpt,
                   c.title AS category_title
            FROM guidebook_pages p
            LEFT JOIN guidebook_categories c ON p.category_id = c.id
            WHERE p.title LIKE ? OR p.content LIKE ? OR c.title LIKE ?
            ORDER BY p.sort_order ASC, p.id ASC
            LIMIT 50
            """,
            (like, like, like),
        ).fetchall()
        conn.close()
        return [dict(r) for r in rows]

    # ── Image upload / serve ─────────────────────────────────────────────────

    @router.post("/guidebook/images")
    async def upload_image(
        file: UploadFile = File(...),
        user: str = Depends(get_current_user),
    ):
        ext = Path(file.filename or "").suffix.lower()
        if ext not in GUIDEBOOK_IMAGE_EXTS:
            raise HTTPException(status_code=400, detail="jpg/png/gif/webp/svg만 업로드 가능합니다")
        filename = f"{uuid.uuid4().hex}{ext}"
        dest = guidebook_upload_base / filename
        data = await file.read()
        dest.write_bytes(data)
        return {"filename": filename, "url": f"/guidebook/images/{filename}"}

    @router.get("/guidebook/images/{filename}")
    def serve_image(filename: str):
        dest = guidebook_upload_base / filename
        if not dest.exists():
            raise HTTPException(status_code=404, detail="image not found")
        mime = mimetypes.guess_type(filename)[0] or "application/octet-stream"
        return FileResponse(str(dest), media_type=mime)

    return router
