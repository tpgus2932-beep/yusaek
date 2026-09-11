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
    if "recommended_qty_source" not in cols:
        conn.execute("ALTER TABLE order_history ADD COLUMN recommended_qty_source TEXT")
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
    성공/실패(result_by_store)를 같이 붙여서, action_type='tsv_copy'/'excel_order'면 결과 없이 기록만 한다.
    같은 날짜(recorded_at 날짜부분) + action_type + 상품코드 + 매장명 + 미송픽업 여부 조합이 이미 있으면
    새 행을 추가하지 않고 기존 행을 최신 값으로 갱신한다 - 같은 날 두 번 다운로드해도 중복이 쌓이지 않게.
    미송픽업 여부를 키에 포함하는 이유: 같은 상품코드로 일반 발주와 미송픽업 발주가 같은 날 같은 매장에
    둘 다 잡히면, 미송픽업 여부가 없을 때 둘이 같은 행으로 취급되어 나중 기록이 먼저 기록을 덮어써
    한쪽이 사라지는 문제가 있었다."""
    result_by_store = result_by_store or {}
    records = []
    for item in items:
        qty = int(item.get("requestQty") or 0)
        if qty <= 0:
            continue
        supply_product_name = str(item.get("supplyProductName") or "").strip()
        store_name = supply_product_name.split(" ", 1)[0] if supply_product_name else ""
        outcome = result_by_store.get(store_name) or {}
        records.append({
            "store_name": store_name,
            "product_code": str(item.get("code") or ""),
            "product_name": str(item.get("name") or ""),
            "supply_product_name": supply_product_name,
            "options": str(item.get("options") or ""),
            "request_qty": qty,
            "result_status": str(outcome.get("result_status") or ""),
            "result_reason": str(outcome.get("reason") or ""),
            "stock_qty": _to_int_or_none(item.get("stock")),
            "incoming_qty": _to_int_or_none(item.get("notYetDeliv")),
            "lack_qty": _to_int_or_none(item.get("lackQty")),
            "recommended_qty": _to_int_or_none(item.get("recommendedQty")),
            "client_product_name": str(item.get("clientProductName") or ""),
            "recommended_qty_source": (
                str(item.get("recommendedQtySource")) if item.get("recommendedQtySource") else None
            ),
        })
    if not records:
        return

    recorded_date = recorded_at[:10]
    conn = get_db()
    try:
        _init_order_history_table(conn)
        for rec in records:
            is_misong_pickup = 1 if (
                rec["recommended_qty_source"] == "misong_pickup" or "미송픽업" in rec["options"]
            ) else 0
            existing = conn.execute(
                """SELECT id FROM order_history
                   WHERE substr(recorded_at, 1, 10) = ? AND action_type = ?
                     AND product_code = ? AND store_name = ?
                     AND (CASE WHEN recommended_qty_source = 'misong_pickup' OR options LIKE '%미송픽업%'
                               THEN 1 ELSE 0 END) = ?""",
                (recorded_date, action_type, rec["product_code"], rec["store_name"], is_misong_pickup),
            ).fetchone()
            if existing:
                conn.execute(
                    """UPDATE order_history SET
                        execution_id = ?, recorded_at = ?, product_name = ?, supply_product_name = ?,
                        options = ?, request_qty = ?, result_status = ?, result_reason = ?,
                        recorded_by_username = ?, recorded_by_display_name = ?,
                        stock_qty = ?, incoming_qty = ?, lack_qty = ?, recommended_qty = ?,
                        client_product_name = ?, recommended_qty_source = ?
                       WHERE id = ?""",
                    (
                        execution_id,
                        recorded_at,
                        rec["product_name"],
                        rec["supply_product_name"],
                        rec["options"],
                        rec["request_qty"],
                        rec["result_status"],
                        rec["result_reason"],
                        username,
                        display_name,
                        rec["stock_qty"],
                        rec["incoming_qty"],
                        rec["lack_qty"],
                        rec["recommended_qty"],
                        rec["client_product_name"],
                        rec["recommended_qty_source"],
                        existing["id"],
                    ),
                )
            else:
                conn.execute(
                    """INSERT INTO order_history (
                        execution_id, recorded_at, action_type, store_name, product_code, product_name,
                        supply_product_name, options, request_qty, result_status, result_reason,
                        recorded_by_username, recorded_by_display_name,
                        stock_qty, incoming_qty, lack_qty, recommended_qty, client_product_name, recommended_qty_source
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        execution_id,
                        recorded_at,
                        action_type,
                        rec["store_name"],
                        rec["product_code"],
                        rec["product_name"],
                        rec["supply_product_name"],
                        rec["options"],
                        rec["request_qty"],
                        rec["result_status"],
                        rec["result_reason"],
                        username,
                        display_name,
                        rec["stock_qty"],
                        rec["incoming_qty"],
                        rec["lack_qty"],
                        rec["recommended_qty"],
                        rec["client_product_name"],
                        rec["recommended_qty_source"],
                    ),
                )
        conn.commit()
    finally:
        conn.close()
