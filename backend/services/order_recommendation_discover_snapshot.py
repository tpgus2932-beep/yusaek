from __future__ import annotations

import json

from services.order_recommendation_store import now_kst_iso


def _init_table(conn) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS order_recommendation_discover_snapshot (
            date TEXT PRIMARY KEY,
            days INTEGER NOT NULL,
            result_limit INTEGER NOT NULL,
            candidate_count INTEGER NOT NULL,
            items_json TEXT NOT NULL,
            need_ezadmin_session INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL,
            updated_by TEXT NOT NULL DEFAULT ''
        )
        """
    )
    conn.commit()


def save_discover_snapshot(
    get_shared_db, *, date: str, days: int, limit: int, candidate_count: int,
    items: list[dict], need_ezadmin_session: bool, updated_by: str,
) -> None:
    """그날 마지막으로 조회한 '추가된 상품' 결과를 date 기준으로 덮어쓴다.
    같은 날 다시 조회하면 이전 스냅샷은 사라지고 최신 결과만 남는다."""
    conn = get_shared_db()
    try:
        _init_table(conn)
        conn.execute(
            """
            INSERT INTO order_recommendation_discover_snapshot
                (date, days, result_limit, candidate_count, items_json, need_ezadmin_session, updated_at, updated_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(date) DO UPDATE SET
                days = excluded.days,
                result_limit = excluded.result_limit,
                candidate_count = excluded.candidate_count,
                items_json = excluded.items_json,
                need_ezadmin_session = excluded.need_ezadmin_session,
                updated_at = excluded.updated_at,
                updated_by = excluded.updated_by
            """,
            (
                date, days, limit, candidate_count,
                json.dumps(items, ensure_ascii=False),
                1 if need_ezadmin_session else 0,
                now_kst_iso(), updated_by,
            ),
        )
        conn.commit()
    finally:
        conn.close()


def get_discover_snapshot(get_shared_db, date: str) -> dict | None:
    conn = get_shared_db()
    try:
        _init_table(conn)
        row = conn.execute(
            "SELECT * FROM order_recommendation_discover_snapshot WHERE date = ?", (date,)
        ).fetchone()
    finally:
        conn.close()

    if row is None:
        return None
    try:
        items = json.loads(row["items_json"])
    except (TypeError, json.JSONDecodeError):
        items = []
    return {
        "date": row["date"],
        "days": row["days"],
        "limit": row["result_limit"],
        "candidate_count": row["candidate_count"],
        "items": items,
        "need_ezadmin_session": bool(row["need_ezadmin_session"]),
        "updated_at": row["updated_at"],
        "updated_by": row["updated_by"],
    }
