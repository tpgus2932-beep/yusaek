from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Body, Depends, HTTPException

_KST = timezone(timedelta(hours=9))


def init_return_inspection_tables(get_shared_db):
    conn = get_shared_db()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS return_inspection_items (
            work_date TEXT NOT NULL,
            product_code TEXT NOT NULL,
            item_text TEXT NOT NULL DEFAULT '',
            unresolved INTEGER NOT NULL DEFAULT 0,
            total_qty INTEGER NOT NULL DEFAULT 0,
            scanned_qty INTEGER NOT NULL DEFAULT 0,
            snapshot_id INTEGER,
            PRIMARY KEY (work_date, product_code)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS return_inspection_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            work_date TEXT NOT NULL,
            product_code TEXT NOT NULL DEFAULT '',
            scanned_raw TEXT NOT NULL DEFAULT '',
            result TEXT NOT NULL,
            created_at TEXT NOT NULL,
            username TEXT NOT NULL DEFAULT '',
            undone INTEGER NOT NULL DEFAULT 0
        )
        """
    )
    conn.commit()
    conn.close()


def _kst_date(iso_text: str) -> str:
    dt = datetime.fromisoformat(str(iso_text).replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(_KST).strftime("%Y-%m-%d")


def _to_qty(value) -> int:
    try:
        return max(1, int(float(value or 1)))
    except (TypeError, ValueError):
        return 1


def build_return_inspection_router(
    *,
    get_current_user,
    get_shared_db,
    load_product_codes,
    load_option_sno_map,
    normalize_code,
):
    router = APIRouter(prefix="/returns/inspection")

    def _norm(code: str) -> str:
        code = str(code or "").strip()
        return (normalize_code(code) or code).upper()

    def _state(conn, work_date: str) -> dict:
        rows = conn.execute(
            """
            SELECT product_code, item_text, unresolved, total_qty, scanned_qty, snapshot_id
            FROM return_inspection_items WHERE work_date = ?
            """,
            (work_date,),
        ).fetchall()
        items = [
            {
                "code": r["product_code"],
                "name": r["item_text"],
                "unresolved": bool(r["unresolved"]),
                "total": r["total_qty"],
                "scanned": r["scanned_qty"],
            }
            for r in rows
        ]
        errors = conn.execute(
            """
            SELECT id, result, product_code, scanned_raw, created_at
            FROM return_inspection_log
            WHERE work_date = ? AND undone = 0 AND result IN ('over', 'unknown')
            ORDER BY id DESC LIMIT 30
            """,
            (work_date,),
        ).fetchall()
        snapshot_id = rows[0]["snapshot_id"] if rows else None
        done = sum(1 for i in items if i["total"] > 0 and i["scanned"] >= i["total"])
        return {
            "ok": True,
            "date": work_date,
            "snapshot_id": snapshot_id,
            "items": items,
            "errors": [dict(e) for e in errors],
            "summary": {"done": done, "total": len(items)},
        }

    @router.get("/dates")
    def inspection_dates(user: str = Depends(get_current_user)):
        conn = get_shared_db()
        try:
            snaps = conn.execute(
                "SELECT id, name, updated_at FROM return_saved_snapshots ORDER BY id DESC LIMIT 400"
            ).fetchall()
            started = {
                r["work_date"]
                for r in conn.execute("SELECT DISTINCT work_date FROM return_inspection_items").fetchall()
            }
        finally:
            conn.close()
        by_date: dict[str, list] = {}
        for s in snaps:
            try:
                d = _kst_date(s["updated_at"])
            except ValueError:
                continue
            by_date.setdefault(d, []).append(
                {"id": s["id"], "name": s["name"] or "", "saved_at": s["updated_at"]}
            )
        dates = [
            {"date": d, "snapshots": by_date[d], "started": d in started}
            for d in sorted(by_date, reverse=True)
        ]
        return {"ok": True, "dates": dates}

    @router.post("/load")
    def inspection_load(payload: dict = Body(...), user: str = Depends(get_current_user)):
        work_date = str(payload.get("date") or "").strip()
        if not work_date:
            raise HTTPException(status_code=400, detail="date가 필요합니다.")
        snapshot_id = payload.get("snapshot_id")
        refresh = bool(payload.get("refresh"))

        conn = get_shared_db()
        try:
            exists = conn.execute(
                "SELECT 1 FROM return_inspection_items WHERE work_date = ? LIMIT 1", (work_date,)
            ).fetchone()
            if exists and not refresh and snapshot_id is None:
                return _state(conn, work_date)

            if snapshot_id is not None:
                row = conn.execute(
                    "SELECT id, payload FROM return_saved_snapshots WHERE id = ?", (snapshot_id,)
                ).fetchone()
            else:
                candidates = conn.execute(
                    "SELECT id, payload, updated_at FROM return_saved_snapshots ORDER BY id DESC LIMIT 400"
                ).fetchall()
                row = next(
                    (c for c in candidates if _safe_date(c["updated_at"]) == work_date), None
                )
            if not row:
                raise HTTPException(status_code=404, detail="해당 날짜의 임시저장 기록이 없습니다.")

            stored = json.loads(row["payload"])
            product_codes = load_product_codes()
            option_sno_map = load_option_sno_map()

            groups: dict[str, dict] = {}
            sources = list(stored.get("queue_customer") or []) + [
                it
                for it in (stored.get("queue_exchange_customer") or [])
                if it.get("sound_type") == "교환정상"
            ]
            for it in sources:
                option_code = str(it.get("option_code") or "").strip()
                original_sno = str(it.get("original_option_sno") or "").strip()
                code = ""
                if option_code:
                    code = product_codes.get(option_code.upper()) or option_sno_map.get(option_code) or ""
                elif original_sno:
                    code = option_sno_map.get(original_sno) or ""
                text = str(it.get("item_text") or "")
                key = _norm(code) if code else f"?{text}"
                g = groups.setdefault(
                    key, {"item_text": text, "unresolved": 0 if code else 1, "total": 0}
                )
                g["total"] += _to_qty(it.get("qty"))

            for key, g in groups.items():
                conn.execute(
                    """
                    INSERT INTO return_inspection_items
                        (work_date, product_code, item_text, unresolved, total_qty, scanned_qty, snapshot_id)
                    VALUES (?, ?, ?, ?, ?, 0, ?)
                    ON CONFLICT(work_date, product_code) DO UPDATE SET
                        item_text = excluded.item_text,
                        unresolved = excluded.unresolved,
                        total_qty = excluded.total_qty,
                        snapshot_id = excluded.snapshot_id
                    """,
                    (work_date, key, g["item_text"], g["unresolved"], g["total"], row["id"]),
                )
            if groups:
                marks = ",".join("?" for _ in groups)
                conn.execute(
                    f"DELETE FROM return_inspection_items WHERE work_date = ? AND scanned_qty = 0 "
                    f"AND product_code NOT IN ({marks})",
                    (work_date, *groups.keys()),
                )
            conn.commit()
            return _state(conn, work_date)
        finally:
            conn.close()

    @router.get("/state")
    def inspection_state(date: str, user: str = Depends(get_current_user)):
        conn = get_shared_db()
        try:
            return _state(conn, date)
        finally:
            conn.close()

    @router.post("/scan")
    def inspection_scan(payload: dict = Body(...), user: str = Depends(get_current_user)):
        work_date = str(payload.get("date") or "").strip()
        raw = str(payload.get("code") or "").strip()
        if not work_date or not raw:
            raise HTTPException(status_code=400, detail="date/code가 필요합니다.")
        code = _norm(raw)
        now = datetime.now(_KST).isoformat()

        conn = get_shared_db()
        try:
            item = conn.execute(
                """
                SELECT total_qty, scanned_qty, unresolved FROM return_inspection_items
                WHERE work_date = ? AND product_code = ?
                """,
                (work_date, code),
            ).fetchone()
            if item is None:
                result = "unknown"
            elif item["scanned_qty"] >= item["total_qty"]:
                result = "over"
            else:
                scanned = item["scanned_qty"] + 1
                conn.execute(
                    "UPDATE return_inspection_items SET scanned_qty = ? WHERE work_date = ? AND product_code = ?",
                    (scanned, work_date, code),
                )
                result = "done" if scanned >= item["total_qty"] else "next"
            conn.execute(
                """
                INSERT INTO return_inspection_log (work_date, product_code, scanned_raw, result, created_at, username)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (work_date, code, raw, result, now, user),
            )
            conn.commit()
            state = _state(conn, work_date)
        finally:
            conn.close()
        state["result"] = result
        state["code"] = code
        return state

    @router.post("/undo")
    def inspection_undo(payload: dict = Body(...), user: str = Depends(get_current_user)):
        """마지막 스캔 1건을 취소한다. code가 있으면 해당 상품의 마지막 정상 스캔만 -1."""
        work_date = str(payload.get("date") or "").strip()
        code = str(payload.get("code") or "").strip()
        if not work_date:
            raise HTTPException(status_code=400, detail="date가 필요합니다.")
        code = _norm(code) if code else ""

        conn = get_shared_db()
        try:
            if code:
                log = conn.execute(
                    """
                    SELECT id, product_code, result FROM return_inspection_log
                    WHERE work_date = ? AND product_code = ? AND undone = 0 AND result IN ('next', 'done')
                    ORDER BY id DESC LIMIT 1
                    """,
                    (work_date, code),
                ).fetchone()
            else:
                log = conn.execute(
                    """
                    SELECT id, product_code, result FROM return_inspection_log
                    WHERE work_date = ? AND undone = 0 ORDER BY id DESC LIMIT 1
                    """,
                    (work_date,),
                ).fetchone()
            if log is None:
                raise HTTPException(status_code=404, detail="취소할 스캔 기록이 없습니다.")
            conn.execute("UPDATE return_inspection_log SET undone = 1 WHERE id = ?", (log["id"],))
            if log["result"] in ("next", "done"):
                conn.execute(
                    """
                    UPDATE return_inspection_items SET scanned_qty = MAX(scanned_qty - 1, 0)
                    WHERE work_date = ? AND product_code = ?
                    """,
                    (work_date, log["product_code"]),
                )
            conn.commit()
            state = _state(conn, work_date)
        finally:
            conn.close()
        state["undone"] = {"code": log["product_code"], "result": log["result"]}
        return state

    @router.post("/clear-errors")
    def inspection_clear_errors(payload: dict = Body(...), user: str = Depends(get_current_user)):
        work_date = str(payload.get("date") or "").strip()
        conn = get_shared_db()
        try:
            conn.execute(
                "UPDATE return_inspection_log SET undone = 1 WHERE work_date = ? AND result IN ('over', 'unknown')",
                (work_date,),
            )
            conn.commit()
            return _state(conn, work_date)
        finally:
            conn.close()

    return router


def _safe_date(iso_text: str) -> str:
    try:
        return _kst_date(iso_text)
    except ValueError:
        return ""
