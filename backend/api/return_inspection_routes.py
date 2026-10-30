from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Body, Depends, HTTPException

_KST = timezone(timedelta(hours=9))
_MAX_SNAPSHOTS = 50


def init_return_inspection_tables(get_shared_db):
    conn = get_shared_db()
    # 구 테이블(return_inspection_items)은 (날짜, 상품코드) 키라 임시저장본끼리 수량이 섞였다.
    # 기록은 보존해야 하므로 삭제하지 않고, 임시저장본별 키를 가진 새 테이블로 복사만 한다.
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
        CREATE TABLE IF NOT EXISTS return_inspection_snap_items (
            snapshot_id INTEGER NOT NULL,
            product_code TEXT NOT NULL,
            work_date TEXT NOT NULL DEFAULT '',
            item_text TEXT NOT NULL DEFAULT '',
            unresolved INTEGER NOT NULL DEFAULT 0,
            total_qty INTEGER NOT NULL DEFAULT 0,
            scanned_qty INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (snapshot_id, product_code)
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
    log_cols = [r["name"] for r in conn.execute("PRAGMA table_info(return_inspection_log)").fetchall()]
    if "snapshot_id" not in log_cols:
        conn.execute("ALTER TABLE return_inspection_log ADD COLUMN snapshot_id INTEGER")
    conn.execute(
        """
        INSERT OR IGNORE INTO return_inspection_snap_items
            (snapshot_id, product_code, work_date, item_text, unresolved, total_qty, scanned_qty)
        SELECT snapshot_id, product_code, work_date, item_text, unresolved, total_qty, scanned_qty
        FROM return_inspection_items WHERE snapshot_id IS NOT NULL
        """
    )
    # 구 로그는 임시저장본을 알 수 없으므로, 같은 날짜로 이관된 항목의 임시저장본에 귀속시킨다.
    conn.execute(
        """
        UPDATE return_inspection_log SET snapshot_id = (
            SELECT i.snapshot_id FROM return_inspection_items i
            WHERE i.work_date = return_inspection_log.work_date AND i.snapshot_id IS NOT NULL LIMIT 1
        )
        WHERE snapshot_id IS NULL
        """
    )
    conn.commit()
    conn.close()


def _kst_date(iso_text: str) -> str:
    dt = datetime.fromisoformat(str(iso_text).replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(_KST).strftime("%Y-%m-%d")


def _safe_date(iso_text: str) -> str:
    try:
        return _kst_date(iso_text)
    except ValueError:
        return ""


def _to_qty(value) -> int:
    try:
        return max(1, int(float(value or 1)))
    except (TypeError, ValueError):
        return 1


def _snapshot_ids(payload: dict) -> list[int]:
    raw = payload.get("snapshot_ids")
    if raw is None and payload.get("snapshot_id") is not None:
        raw = [payload.get("snapshot_id")]
    try:
        ids = sorted({int(v) for v in (raw or [])})
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="snapshot_ids 형식이 올바르지 않습니다.")
    if not ids:
        raise HTTPException(status_code=400, detail="임시저장본을 하나 이상 선택하세요.")
    if len(ids) > _MAX_SNAPSHOTS:
        raise HTTPException(status_code=400, detail=f"임시저장본은 최대 {_MAX_SNAPSHOTS}개까지 선택할 수 있습니다.")
    return ids


def _marks(values) -> str:
    return ",".join("?" for _ in values)


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

    def _state(conn, ids: list[int]) -> dict:
        rows = conn.execute(
            f"""
            SELECT product_code, MAX(item_text) AS item_text, MAX(unresolved) AS unresolved,
                   SUM(total_qty) AS total_qty, SUM(scanned_qty) AS scanned_qty
            FROM return_inspection_snap_items
            WHERE snapshot_id IN ({_marks(ids)})
            GROUP BY product_code
            """,
            tuple(ids),
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
            f"""
            SELECT id, result, product_code, scanned_raw, created_at
            FROM return_inspection_log
            WHERE snapshot_id IN ({_marks(ids)}) AND undone = 0 AND result IN ('over', 'unknown')
            ORDER BY id DESC LIMIT 30
            """,
            tuple(ids),
        ).fetchall()
        done = sum(1 for i in items if i["total"] > 0 and i["scanned"] >= i["total"])
        return {
            "ok": True,
            "snapshot_ids": ids,
            "items": items,
            "errors": [dict(e) for e in errors],
            "summary": {"done": done, "total": len(items)},
        }

    def _import_snapshot(conn, snapshot_id: int, product_codes, option_sno_map):
        row = conn.execute(
            "SELECT id, payload, updated_at FROM return_saved_snapshots WHERE id = ?", (snapshot_id,)
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail=f"임시저장본 #{snapshot_id}을(를) 찾을 수 없습니다.")
        stored = json.loads(row["payload"])
        work_date = _safe_date(row["updated_at"])

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
            g = groups.setdefault(key, {"item_text": text, "unresolved": 0 if code else 1, "total": 0})
            g["total"] += _to_qty(it.get("qty"))

        # 같은 임시저장본을 다시 읽을 때만 찍은 수량을 유지한다(총수량이 줄었으면 그에 맞춰 보정).
        for key, g in groups.items():
            conn.execute(
                """
                INSERT INTO return_inspection_snap_items
                    (snapshot_id, product_code, work_date, item_text, unresolved, total_qty, scanned_qty)
                VALUES (?, ?, ?, ?, ?, ?, 0)
                ON CONFLICT(snapshot_id, product_code) DO UPDATE SET
                    work_date = excluded.work_date,
                    item_text = excluded.item_text,
                    unresolved = excluded.unresolved,
                    total_qty = excluded.total_qty,
                    scanned_qty = MIN(return_inspection_snap_items.scanned_qty, excluded.total_qty)
                """,
                (snapshot_id, key, work_date, g["item_text"], g["unresolved"], g["total"]),
            )
        if groups:
            conn.execute(
                f"DELETE FROM return_inspection_snap_items WHERE snapshot_id = ? AND scanned_qty = 0 "
                f"AND product_code NOT IN ({_marks(groups)})",
                (snapshot_id, *groups.keys()),
            )

    @router.get("/dates")
    def inspection_dates(user: str = Depends(get_current_user)):
        conn = get_shared_db()
        try:
            snaps = conn.execute(
                "SELECT id, name, updated_at FROM return_saved_snapshots ORDER BY id DESC LIMIT 400"
            ).fetchall()
            started = {
                r["snapshot_id"]
                for r in conn.execute("SELECT DISTINCT snapshot_id FROM return_inspection_snap_items").fetchall()
            }
        finally:
            conn.close()
        by_date: dict[str, list] = {}
        for s in snaps:
            d = _safe_date(s["updated_at"])
            if not d:
                continue
            by_date.setdefault(d, []).append(
                {
                    "id": s["id"],
                    "name": s["name"] or "",
                    "saved_at": s["updated_at"],
                    "started": s["id"] in started,
                }
            )
        dates = [
            {"date": d, "snapshots": by_date[d], "started": any(s["started"] for s in by_date[d])}
            for d in sorted(by_date, reverse=True)
        ]
        return {"ok": True, "dates": dates}

    @router.post("/load")
    def inspection_load(payload: dict = Body(...), user: str = Depends(get_current_user)):
        ids = _snapshot_ids(payload)
        refresh = bool(payload.get("refresh"))

        conn = get_shared_db()
        try:
            product_codes = None
            option_sno_map = None
            for sid in ids:
                exists = conn.execute(
                    "SELECT 1 FROM return_inspection_snap_items WHERE snapshot_id = ? LIMIT 1", (sid,)
                ).fetchone()
                if exists and not refresh:
                    continue
                if product_codes is None:
                    product_codes = load_product_codes()
                    option_sno_map = load_option_sno_map()
                _import_snapshot(conn, sid, product_codes, option_sno_map)
            conn.commit()
            return _state(conn, ids)
        finally:
            conn.close()

    @router.post("/state")
    def inspection_state(payload: dict = Body(...), user: str = Depends(get_current_user)):
        ids = _snapshot_ids(payload)
        conn = get_shared_db()
        try:
            return _state(conn, ids)
        finally:
            conn.close()

    @router.post("/scan")
    def inspection_scan(payload: dict = Body(...), user: str = Depends(get_current_user)):
        ids = _snapshot_ids(payload)
        raw = str(payload.get("code") or "").strip()
        if not raw:
            raise HTTPException(status_code=400, detail="code가 필요합니다.")
        code = _norm(raw)
        now = datetime.now(_KST).isoformat()

        conn = get_shared_db()
        try:
            # 합산 조회에서는 오래된 임시저장본(id 순)부터 수량을 채운다.
            rows = conn.execute(
                f"""
                SELECT snapshot_id, work_date, total_qty, scanned_qty FROM return_inspection_snap_items
                WHERE product_code = ? AND snapshot_id IN ({_marks(ids)})
                ORDER BY snapshot_id ASC
                """,
                (code, *ids),
            ).fetchall()
            target = next((r for r in rows if r["scanned_qty"] < r["total_qty"]), None)
            if not rows:
                result, log_snapshot, log_date = "unknown", ids[0], None
            elif target is None:
                result, log_snapshot, log_date = "over", rows[0]["snapshot_id"], rows[0]["work_date"]
            else:
                scanned = target["scanned_qty"] + 1
                conn.execute(
                    "UPDATE return_inspection_snap_items SET scanned_qty = ? WHERE snapshot_id = ? AND product_code = ?",
                    (scanned, target["snapshot_id"], code),
                )
                result = "done" if scanned >= target["total_qty"] else "next"
                log_snapshot, log_date = target["snapshot_id"], target["work_date"]
            if log_date is None:
                snap = conn.execute(
                    "SELECT updated_at FROM return_saved_snapshots WHERE id = ?", (log_snapshot,)
                ).fetchone()
                log_date = _safe_date(snap["updated_at"]) if snap else ""
            conn.execute(
                """
                INSERT INTO return_inspection_log
                    (work_date, product_code, scanned_raw, result, created_at, username, snapshot_id)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (log_date, code, raw, result, now, user, log_snapshot),
            )
            conn.commit()
            state = _state(conn, ids)
        finally:
            conn.close()
        # 합산 화면에서 "완료"는 해당 상품의 합산 수량 기준으로 판정한다.
        if result in ("next", "done"):
            item = next((i for i in state["items"] if i["code"] == code), None)
            if item:
                result = "done" if item["scanned"] >= item["total"] else "next"
        state["result"] = result
        state["code"] = code
        return state

    @router.post("/undo")
    def inspection_undo(payload: dict = Body(...), user: str = Depends(get_current_user)):
        """마지막 스캔 1건을 취소한다. code가 있으면 해당 상품의 마지막 정상 스캔만 -1."""
        ids = _snapshot_ids(payload)
        code = str(payload.get("code") or "").strip()
        code = _norm(code) if code else ""

        conn = get_shared_db()
        try:
            if code:
                log = conn.execute(
                    f"""
                    SELECT id, product_code, result, snapshot_id FROM return_inspection_log
                    WHERE product_code = ? AND snapshot_id IN ({_marks(ids)})
                      AND undone = 0 AND result IN ('next', 'done')
                    ORDER BY id DESC LIMIT 1
                    """,
                    (code, *ids),
                ).fetchone()
            else:
                log = conn.execute(
                    f"""
                    SELECT id, product_code, result, snapshot_id FROM return_inspection_log
                    WHERE snapshot_id IN ({_marks(ids)}) AND undone = 0 ORDER BY id DESC LIMIT 1
                    """,
                    tuple(ids),
                ).fetchone()
            if log is None:
                raise HTTPException(status_code=404, detail="취소할 스캔 기록이 없습니다.")
            conn.execute("UPDATE return_inspection_log SET undone = 1 WHERE id = ?", (log["id"],))
            if log["result"] in ("next", "done"):
                conn.execute(
                    """
                    UPDATE return_inspection_snap_items SET scanned_qty = MAX(scanned_qty - 1, 0)
                    WHERE snapshot_id = ? AND product_code = ?
                    """,
                    (log["snapshot_id"], log["product_code"]),
                )
            conn.commit()
            state = _state(conn, ids)
        finally:
            conn.close()
        state["undone"] = {"code": log["product_code"], "result": log["result"]}
        return state

    @router.post("/clear-errors")
    def inspection_clear_errors(payload: dict = Body(...), user: str = Depends(get_current_user)):
        ids = _snapshot_ids(payload)
        conn = get_shared_db()
        try:
            conn.execute(
                f"UPDATE return_inspection_log SET undone = 1 "
                f"WHERE snapshot_id IN ({_marks(ids)}) AND result IN ('over', 'unknown')",
                tuple(ids),
            )
            conn.commit()
            return _state(conn, ids)
        finally:
            conn.close()

    return router
