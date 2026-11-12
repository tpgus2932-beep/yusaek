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
    # 불량 모드로 찍은 스캔 표시 (수량은 정상 스캔과 똑같이 채우고, 불량 개수만 따로 센다)
    if "defect" not in log_cols:
        conn.execute("ALTER TABLE return_inspection_log ADD COLUMN defect INTEGER NOT NULL DEFAULT 0")
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
        defect_rows = conn.execute(
            f"""
            SELECT product_code, COUNT(*) AS cnt FROM return_inspection_log
            WHERE snapshot_id IN ({_marks(ids)}) AND undone = 0 AND defect = 1 AND result IN ('next', 'done')
            GROUP BY product_code
            """,
            tuple(ids),
        ).fetchall()
        defects = {r["product_code"]: r["cnt"] for r in defect_rows}
        items = [
            {
                "code": r["product_code"],
                "name": r["item_text"],
                "unresolved": bool(r["unresolved"]),
                "total": r["total_qty"],
                "scanned": r["scanned_qty"],
                "defect": min(defects.get(r["product_code"], 0), r["scanned_qty"]),
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
            "summary": {"done": done, "total": len(items), "defect": sum(i["defect"] for i in items)},
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
        defect = 1 if payload.get("defect") else 0
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
                    (work_date, product_code, scanned_raw, result, created_at, username, snapshot_id, defect)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (log_date, code, raw, result, now, user, log_snapshot, defect),
            )
            conn.commit()
            # 방금 넣은 기록 id (개별 취소·불량 전환에 사용). Turso HTTP 연결도 지원하도록 lastrowid 대신 조회한다.
            new_log = conn.execute(
                """
                SELECT id FROM return_inspection_log
                WHERE created_at = ? AND username = ? AND product_code = ? AND snapshot_id = ?
                ORDER BY id DESC LIMIT 1
                """,
                (now, user, code, log_snapshot),
            ).fetchone()
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
        state["defect"] = bool(defect)
        state["log_id"] = new_log["id"] if new_log else None
        return state

    @router.post("/undo")
    def inspection_undo(payload: dict = Body(...), user: str = Depends(get_current_user)):
        """스캔 1건을 취소한다.
        - log_id: 그 기록 1건만 취소 (방금 찍은 목록·상품별 기록에서 골라 취소)
          count가 2 이상이면 그 기록 + 같은 상품의 최근 수량 스캔을 count개까지 취소
        - code: 해당 상품의 마지막 수량 스캔 -1
        - 없으면 마지막 스캔 (mine=true면 내가 찍은 것 중 마지막)
        """
        ids = _snapshot_ids(payload)
        code = str(payload.get("code") or "").strip()
        code = _norm(code) if code else ""
        log_id = payload.get("log_id")

        conn = get_shared_db()
        try:
            if log_id is not None:
                log = conn.execute(
                    f"""
                    SELECT id, product_code, result, snapshot_id, defect FROM return_inspection_log
                    WHERE id = ? AND snapshot_id IN ({_marks(ids)}) AND undone = 0
                    """,
                    (int(log_id), *ids),
                ).fetchone()
            elif code:
                log = conn.execute(
                    f"""
                    SELECT id, product_code, result, snapshot_id, defect FROM return_inspection_log
                    WHERE product_code = ? AND snapshot_id IN ({_marks(ids)})
                      AND undone = 0 AND result IN ('next', 'done')
                    ORDER BY id DESC LIMIT 1
                    """,
                    (code, *ids),
                ).fetchone()
            else:
                mine = bool(payload.get("mine"))
                log = conn.execute(
                    f"""
                    SELECT id, product_code, result, snapshot_id, defect FROM return_inspection_log
                    WHERE snapshot_id IN ({_marks(ids)}) AND undone = 0 {"AND username = ?" if mine else ""}
                    ORDER BY id DESC LIMIT 1
                    """,
                    (*ids, user) if mine else tuple(ids),
                ).fetchone()
            if log is None:
                raise HTTPException(status_code=404, detail="취소할 스캔 기록이 없습니다. (이미 취소되었을 수 있습니다)")
            def _undo_one(row):
                conn.execute("UPDATE return_inspection_log SET undone = 1 WHERE id = ?", (row["id"],))
                if row["result"] in ("next", "done"):
                    conn.execute(
                        """
                        UPDATE return_inspection_snap_items SET scanned_qty = MAX(scanned_qty - 1, 0)
                        WHERE snapshot_id = ? AND product_code = ?
                        """,
                        (row["snapshot_id"], row["product_code"]),
                    )

            _undo_one(log)
            undone_ids = [log["id"]]
            try:
                count = max(1, min(int(payload.get("count") or 1), 999))
            except (TypeError, ValueError):
                count = 1
            if log_id is not None and count > 1 and log["result"] in ("next", "done"):
                for _ in range(count - 1):
                    extra = conn.execute(
                        f"""
                        SELECT id, product_code, result, snapshot_id, defect FROM return_inspection_log
                        WHERE product_code = ? AND snapshot_id IN ({_marks(ids)})
                          AND undone = 0 AND result IN ('next', 'done')
                        ORDER BY id DESC LIMIT 1
                        """,
                        (log["product_code"], *ids),
                    ).fetchone()
                    if extra is None:
                        break
                    _undo_one(extra)
                    undone_ids.append(extra["id"])
            conn.commit()
            state = _state(conn, ids)
        finally:
            conn.close()
        state["undone"] = {
            "log_id": log["id"], "code": log["product_code"], "result": log["result"], "defect": bool(log["defect"]),
            "log_ids": undone_ids,
        }
        return state

    @router.post("/toggle-defect")
    def inspection_toggle_defect(payload: dict = Body(...), user: str = Depends(get_current_user)):
        """찍힌 스캔 1건을 정상 ↔ 불량으로 바꾼다 (수량은 그대로)."""
        ids = _snapshot_ids(payload)
        try:
            log_id = int(payload.get("log_id"))
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="log_id가 필요합니다.")
        conn = get_shared_db()
        try:
            log = conn.execute(
                f"""
                SELECT id, product_code, defect FROM return_inspection_log
                WHERE id = ? AND snapshot_id IN ({_marks(ids)}) AND undone = 0 AND result IN ('next', 'done')
                """,
                (log_id, *ids),
            ).fetchone()
            if log is None:
                raise HTTPException(status_code=404, detail="바꿀 스캔 기록이 없습니다. (취소되었을 수 있습니다)")
            new_defect = 0 if log["defect"] else 1
            conn.execute("UPDATE return_inspection_log SET defect = ? WHERE id = ?", (new_defect, log_id))
            conn.commit()
            state = _state(conn, ids)
        finally:
            conn.close()
        state["toggled"] = {"log_id": log_id, "code": log["product_code"], "defect": bool(new_defect)}
        return state

    @router.post("/item-logs")
    def inspection_item_logs(payload: dict = Body(...), user: str = Depends(get_current_user)):
        """한 상품의 스캔 기록 (취소 안 된 것, 최신순) — 누가 언제 정상/불량으로 찍었는지."""
        ids = _snapshot_ids(payload)
        code = _norm(str(payload.get("code") or ""))
        if not code:
            raise HTTPException(status_code=400, detail="code가 필요합니다.")
        conn = get_shared_db()
        try:
            rows = conn.execute(
                f"""
                SELECT id, result, defect, created_at, username FROM return_inspection_log
                WHERE product_code = ? AND snapshot_id IN ({_marks(ids)}) AND undone = 0
                ORDER BY id DESC LIMIT 100
                """,
                (code, *ids),
            ).fetchall()
        finally:
            conn.close()
        return {"ok": True, "code": code, "logs": [dict(r) | {"defect": bool(r["defect"])} for r in rows]}

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

    @router.post("/reset")
    def inspection_reset(payload: dict = Body(...), user: str = Depends(get_current_user)):
        """선택한 임시저장본의 검수 진행(스캔 수량·스캔 기록·오류)을 모두 0으로 되돌린다. 상품 리스트(총 수량)는 유지."""
        ids = _snapshot_ids(payload)
        conn = get_shared_db()
        try:
            conn.execute(
                f"UPDATE return_inspection_snap_items SET scanned_qty = 0 WHERE snapshot_id IN ({_marks(ids)})",
                tuple(ids),
            )
            conn.execute(
                f"UPDATE return_inspection_log SET undone = 1 WHERE snapshot_id IN ({_marks(ids)}) AND undone = 0",
                tuple(ids),
            )
            conn.commit()
            return _state(conn, ids)
        finally:
            conn.close()

    return router
