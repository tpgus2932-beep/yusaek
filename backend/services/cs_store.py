from __future__ import annotations


def init_cs_tables(get_db) -> None:
    conn = get_db()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS cs_rooms (
            sno INTEGER PRIMARY KEY,
            updated_at TEXT NOT NULL DEFAULT '',
            status INTEGER NOT NULL DEFAULT 0,
            member_name TEXT NOT NULL DEFAULT '',
            search_text TEXT NOT NULL DEFAULT '',
            room_json TEXT NOT NULL,
            detail_json TEXT NOT NULL DEFAULT '',
            detail_updated_at TEXT NOT NULL DEFAULT ''
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_cs_rooms_updated ON cs_rooms(updated_at)")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS cs_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL DEFAULT ''
        )
        """
    )
    # 문의 상품 ↔ 원가베이스 수동 연결 (한 번 연결하면 계속 유지)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS cs_product_links (
            goods_sno INTEGER PRIMARY KEY,
            base_name TEXT NOT NULL,
            linked_by TEXT NOT NULL DEFAULT '',
            linked_at TEXT NOT NULL DEFAULT ''
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS cs_option_links (
            goods_sno INTEGER NOT NULL,
            option_key TEXT NOT NULL,
            base_code TEXT NOT NULL,
            linked_by TEXT NOT NULL DEFAULT '',
            linked_at TEXT NOT NULL DEFAULT '',
            PRIMARY KEY (goods_sno, option_key)
        )
        """
    )
    # 상품별 마지막 재고 조회 결과 (다시 열어도 바로 보이도록)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS cs_stock_cache (
            goods_sno INTEGER PRIMARY KEY,
            fetched_at TEXT NOT NULL,
            result_json TEXT NOT NULL
        )
        """
    )
    # 옵션별 입고 일정 (원가베이스 상품코드 기준, 마지막 수정 시각/담당 기록)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS cs_inbound_schedules (
            code TEXT PRIMARY KEY,
            expected_date TEXT NOT NULL DEFAULT '',
            note TEXT NOT NULL DEFAULT '',
            updated_by TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL DEFAULT ''
        )
        """
    )
    # 이지어드민 배송지 변경 이력 (누가 언제 무엇을 바꿨는지)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS cs_address_changes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pack TEXT NOT NULL,
            order_id TEXT NOT NULL DEFAULT '',
            shop_name TEXT NOT NULL DEFAULT '',
            old_address TEXT NOT NULL DEFAULT '',
            old_zip TEXT NOT NULL DEFAULT '',
            new_address TEXT NOT NULL DEFAULT '',
            new_zip TEXT NOT NULL DEFAULT '',
            verified INTEGER NOT NULL DEFAULT 0,
            changed_by TEXT NOT NULL DEFAULT '',
            changed_at TEXT NOT NULL DEFAULT ''
        )
        """
    )
    conn.commit()
    conn.close()


# CS 테이블을 Turso에서 로컬 SQLite로 옮길 때 복사하는 표와 열 (cs_rooms 는 크므로 sno 순으로 나눠서 읽는다).
_MIGRATE_TABLES = (
    ("cs_meta", ("key", "value")),
    ("cs_product_links", ("goods_sno", "base_name", "linked_by", "linked_at")),
    ("cs_option_links", ("goods_sno", "option_key", "base_code", "linked_by", "linked_at")),
    ("cs_stock_cache", ("goods_sno", "fetched_at", "result_json")),
    ("cs_inbound_schedules", ("code", "expected_date", "note", "updated_by", "updated_at")),
    (
        "cs_address_changes",
        ("id", "pack", "order_id", "shop_name", "old_address", "old_zip", "new_address", "new_zip", "verified", "changed_by", "changed_at"),
    ),
)
_ROOM_COLUMNS = ("sno", "updated_at", "status", "member_name", "search_text", "room_json", "detail_json", "detail_updated_at")
_ROOM_PAGE = 200
_MIGRATED_KEY = "migrated_from_turso"


def _insert_sql(table: str, cols: tuple) -> str:
    return f"INSERT OR REPLACE INTO {table} ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})"


def migrate_cs_from_turso(local_get_db, remote_get_db, log=print) -> bool:
    """예전에 Turso에 쌓인 CS 데이터를 로컬 SQLite로 한 번만 복사한다. 이미 옮겼으면 아무것도 하지 않는다.

    끝까지 성공했을 때만 완료 표시(cs_meta)를 남기므로, 중간에 실패하면 다음 시작 때 처음부터 다시 시도한다.
    Turso 쪽 데이터는 지우지 않는다.
    """
    local = local_get_db()
    try:
        if local.execute("SELECT 1 FROM cs_meta WHERE key = ?", (_MIGRATED_KEY,)).fetchone():
            return False
        remote = remote_get_db()
        copied = {}
        last_sno = -1
        total_rooms = 0
        while True:
            rows = remote.execute(
                f"SELECT {', '.join(_ROOM_COLUMNS)} FROM cs_rooms WHERE sno > ? ORDER BY sno LIMIT {_ROOM_PAGE}", (last_sno,)
            ).fetchall()
            if not rows:
                break
            local.executemany(_insert_sql("cs_rooms", _ROOM_COLUMNS), [tuple(r[c] for c in _ROOM_COLUMNS) for r in rows])
            local.commit()
            last_sno = rows[-1]["sno"]
            total_rooms += len(rows)
        copied["cs_rooms"] = total_rooms
        for table, cols in _MIGRATE_TABLES:
            rows = remote.execute(f"SELECT {', '.join(cols)} FROM {table}").fetchall()
            if rows:
                local.executemany(_insert_sql(table, cols), [tuple(r[c] for c in cols) for r in rows])
                local.commit()
            copied[table] = len(rows)
        local.execute(
            "INSERT OR REPLACE INTO cs_meta (key, value) VALUES (?, datetime('now'))", (_MIGRATED_KEY,)
        )
        local.commit()
        log(f"[CS] Turso → 로컬 SQLite 이전 완료: {copied}")
        return True
    finally:
        local.close()
