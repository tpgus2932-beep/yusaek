from __future__ import annotations

from datetime import datetime, timedelta, timezone

_KST = timezone(timedelta(hours=9))


def _now() -> str:
    return datetime.now(_KST).isoformat()


def _ensure_column(get_db, table: str, column: str, ddl: str) -> None:
    conn = get_db()
    cols = [r["name"] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()]
    if column not in cols:
        conn.execute(ddl)
        conn.commit()
    conn.close()


def init_timebox_tables(get_db) -> None:
    conn = get_db()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS timebox_issues (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'unassigned',
            created_by TEXT NOT NULL,
            assigned_to TEXT NOT NULL DEFAULT '',
            assigned_at TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS timebox_comments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            issue_id INTEGER NOT NULL,
            author TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS timebox_members (
            username TEXT PRIMARY KEY,
            added_at TEXT NOT NULL
        )
        """
    )
    conn.commit()
    conn.close()

    # 담당자가 배정된 후 작성하는 진행상황 - 최초 등록된 문제내용(description)과는 별개 필드
    _ensure_column(get_db, "timebox_issues", "progress",
                   "ALTER TABLE timebox_issues ADD COLUMN progress TEXT NOT NULL DEFAULT ''")
