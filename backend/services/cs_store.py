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
