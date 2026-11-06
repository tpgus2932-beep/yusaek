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
    # 폰 동기화용 컬럼. 기존 DB에는 ALTER로 추가한다(앱 시작 시 한 번).
    columns = {r["name"] for r in conn.execute("PRAGMA table_info(kakao_contacts)").fetchall()}
    for name, ddl in (
        ("source", "ALTER TABLE kakao_contacts ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'"),
        ("in_phone", "ALTER TABLE kakao_contacts ADD COLUMN in_phone INTEGER NOT NULL DEFAULT 1"),
        ("synced_at", "ALTER TABLE kakao_contacts ADD COLUMN synced_at TEXT NOT NULL DEFAULT ''"),
    ):
        if name not in columns:
            conn.execute(ddl)
    # 폰 대화방에서 가져온 메시지용 컬럼. direction: out=내가 보냄 / in=상대가 보냄,
    # origin: web=이 화면에서 보냄 / phone=폰에서 가져옴, time_known=0이면 분 단위 시각을 모름,
    # sort_no: 가져온 메시지를 '보내려던 메시지' 바로 앞에 끼워 넣기 위한 정렬값(없으면 id)
    mcols = {r["name"] for r in conn.execute("PRAGMA table_info(kakao_messages)").fetchall()}
    for name, ddl in (
        ("direction", "ALTER TABLE kakao_messages ADD COLUMN direction TEXT NOT NULL DEFAULT 'out'"),
        ("origin", "ALTER TABLE kakao_messages ADD COLUMN origin TEXT NOT NULL DEFAULT 'web'"),
        ("time_known", "ALTER TABLE kakao_messages ADD COLUMN time_known INTEGER NOT NULL DEFAULT 1"),
        ("sort_no", "ALTER TABLE kakao_messages ADD COLUMN sort_no REAL"),
        ("kind", "ALTER TABLE kakao_messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'text'"),
        ("media_ids", "ALTER TABLE kakao_messages ADD COLUMN media_ids TEXT NOT NULL DEFAULT ''"),
        ("batch_id", "ALTER TABLE kakao_messages ADD COLUMN batch_id INTEGER"),
    ):
        if name not in mcols:
            conn.execute(ddl)
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_kakao_messages_contact ON kakao_messages(contact_id, id)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_kakao_messages_status ON kakao_messages(status, id)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_kakao_messages_batch ON kakao_messages(batch_id, id)"
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS kakao_lists (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            created_by TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS kakao_list_members (
            list_id INTEGER NOT NULL,
            contact_id INTEGER NOT NULL,
            added_at TEXT NOT NULL,
            PRIMARY KEY (list_id, contact_id)
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_kakao_list_members_contact ON kakao_list_members(contact_id)")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS kakao_batches (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            text TEXT NOT NULL DEFAULT '',
            media_ids TEXT NOT NULL DEFAULT '',
            interval_sec INTEGER NOT NULL DEFAULT 5,
            total INTEGER NOT NULL DEFAULT 0,
            request_id TEXT UNIQUE,
            created_by TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL
        )
        """
    )
    bcols = {r["name"] for r in conn.execute("PRAGMA table_info(kakao_batches)").fetchall()}
    if "list_id" not in bcols:
        conn.execute("ALTER TABLE kakao_batches ADD COLUMN list_id INTEGER")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS kakao_media (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            mime TEXT NOT NULL,
            bytes INTEGER NOT NULL,
            sha256 TEXT NOT NULL,
            path TEXT NOT NULL,
            created_by TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL
        )
        """
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
