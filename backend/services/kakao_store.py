from __future__ import annotations

from datetime import datetime, timedelta, timezone

_KST = timezone(timedelta(hours=9))


def now_iso() -> str:
    return datetime.now(_KST).isoformat(timespec="seconds")


def init_kakao_tables(get_db) -> None:
    conn = get_db()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS kakao_contacts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            memo TEXT NOT NULL DEFAULT '',
            created_by TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS kakao_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            contact_id INTEGER NOT NULL,
            text TEXT NOT NULL,
            status TEXT NOT NULL,
            error TEXT NOT NULL DEFAULT '',
            dry_run INTEGER NOT NULL DEFAULT 0,
            request_id TEXT UNIQUE,
            requested_by TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            sent_at TEXT NOT NULL DEFAULT ''
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_kakao_messages_contact ON kakao_messages(contact_id, id)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_kakao_messages_status ON kakao_messages(status, id)"
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS kakao_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL DEFAULT ''
        )
        """
    )
    conn.commit()
    conn.close()


def get_setting(get_db, key: str, default: str = "") -> str:
    conn = get_db()
    row = conn.execute("SELECT value FROM kakao_settings WHERE key = ?", (key,)).fetchone()
    conn.close()
    return row["value"] if row else default


def set_settings(get_db, values: dict) -> None:
    conn = get_db()
    for key, value in values.items():
        conn.execute(
            "INSERT INTO kakao_settings (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, str(value)),
        )
    conn.commit()
    conn.close()
