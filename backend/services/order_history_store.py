from __future__ import annotations


def _init_order_history_table(conn) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS order_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            execution_id TEXT NOT NULL,
            recorded_at TEXT NOT NULL,
            action_type TEXT NOT NULL,
            store_name TEXT NOT NULL DEFAULT '',
            product_code TEXT NOT NULL DEFAULT '',
            product_name TEXT NOT NULL DEFAULT '',
            supply_product_name TEXT NOT NULL DEFAULT '',
            options TEXT NOT NULL DEFAULT '',
            request_qty INTEGER NOT NULL,
            result_status TEXT NOT NULL DEFAULT '',
            result_reason TEXT NOT NULL DEFAULT '',
            recorded_by_username TEXT NOT NULL,
            recorded_by_display_name TEXT NOT NULL DEFAULT ''
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_order_history_recorded_at ON order_history(recorded_at DESC)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_order_history_execution_id ON order_history(execution_id)")
    cols = [r["name"] for r in conn.execute("PRAGMA table_info(order_history)").fetchall()]
    for column in ("stock_qty", "incoming_qty", "lack_qty", "recommended_qty"):
        if column not in cols:
            conn.execute(f"ALTER TABLE order_history ADD COLUMN {column} INTEGER")
    if "client_product_name" not in cols:
        conn.execute("ALTER TABLE order_history ADD COLUMN client_product_name TEXT NOT NULL DEFAULT ''")
    conn.commit()


def init_order_history_table(get_db) -> None:
    conn = get_db()
    try:
        _init_order_history_table(conn)
    finally:
        conn.close()


def _to_int_or_none(value):
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def record_order_history(
    get_db,
    *,
    execution_id: str,
    recorded_at: str,
    action_type: str,
    items: list[dict],
    username: str,
    display_name: str,
    result_by_store: dict[str, dict] | None = None,
) -> None:
    """items(top90 형식)를 발주내역으로 남긴다. action_type='order_execute'면 매장별
    성공/실패(result_by_store)를 같이 붙여서, action_type='tsv_copy'면 결과 없이 기록만 한다."""
    result_by_store = result_by_store or {}
    records = []
    for item in items:
        qty = int(item.get("requestQty") or 0)
        if qty <= 0:
            continue
        supply_product_name = str(item.get("supplyProductName") or "").strip()
        store_name = supply_product_name.split(" ", 1)[0] if supply_product_name else ""
        outcome = result_by_store.get(store_name) or {}
        records.append((
            execution_id,
            recorded_at,
            action_type,
            store_name,
            str(item.get("code") or ""),
            str(item.get("name") or ""),
            supply_product_name,
            str(item.get("options") or ""),
            qty,
            str(outcome.get("result_status") or ""),
            str(outcome.get("reason") or ""),
            username,
            display_name,
            _to_int_or_none(item.get("stock")),
            _to_int_or_none(item.get("notYetDeliv")),
            _to_int_or_none(item.get("lackQty")),
            _to_int_or_none(item.get("recommendedQty")),
            str(item.get("clientProductName") or ""),
        ))
    if not records:
        return

    conn = get_db()
    try:
        _init_order_history_table(conn)
        conn.executemany(
            """INSERT INTO order_history (
                execution_id, recorded_at, action_type, store_name, product_code, product_name,
                supply_product_name, options, request_qty, result_status, result_reason,
                recorded_by_username, recorded_by_display_name,
                stock_qty, incoming_qty, lack_qty, recommended_qty, client_product_name
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            records,
        )
        conn.commit()
    finally:
        conn.close()
