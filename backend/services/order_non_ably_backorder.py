from __future__ import annotations

from services.ezadmin_io30_client import ez_val, fetch_io30_rows, to_int
from services.order_recommendation_store import now_kst_iso

_NON_ABLY_SHOP_CODES = "10080,10031"


def init_non_ably_backorder_table(get_db) -> None:
    conn = get_db()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS order_non_ably_backorder (
            yusas_code TEXT PRIMARY KEY,
            stock_qty INTEGER,
            incoming_qty INTEGER,
            lack_qty INTEGER,
            updated_at TEXT NOT NULL
        )
        """
    )
    conn.commit()
    conn.close()


async def fetch_non_ably_snapshot(get_setting) -> dict[str, dict]:
    rows = await fetch_io30_rows(
        get_setting,
        shop_par_fragment=f"multi_shop_group=&multi_shop={_NON_ABLY_SHOP_CODES}&str_shop_code=0",
    )
    snapshot: dict[str, dict] = {}
    for cell in rows:
        product_id = ez_val(cell.get("product_id")).strip()
        if not product_id:
            continue
        snapshot[product_id] = {
            "stock_qty": to_int(ez_val(cell.get("stock"))),
            "incoming_qty": to_int(ez_val(cell.get("not_yet_deliv"))),
            "lack_qty": to_int(ez_val(cell.get("lack_qty"))),
        }
    return snapshot


def upsert_non_ably_snapshot(conn, snapshot: dict[str, dict]) -> None:
    now = now_kst_iso()
    for yusas_code, values in snapshot.items():
        conn.execute(
            """
            INSERT INTO order_non_ably_backorder (yusas_code, stock_qty, incoming_qty, lack_qty, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(yusas_code) DO UPDATE SET
                stock_qty = excluded.stock_qty,
                incoming_qty = excluded.incoming_qty,
                lack_qty = excluded.lack_qty,
                updated_at = excluded.updated_at
            """,
            (yusas_code, values["stock_qty"], values["incoming_qty"], values["lack_qty"], now),
        )
    conn.commit()


async def collect_non_ably_snapshot(get_db, get_setting) -> int:
    snapshot = await fetch_non_ably_snapshot(get_setting)
    conn = get_db()
    try:
        upsert_non_ably_snapshot(conn, snapshot)
    finally:
        conn.close()
    return len(snapshot)


def list_non_ably_snapshot(conn) -> list:
    return conn.execute("SELECT * FROM order_non_ably_backorder ORDER BY yusas_code").fetchall()
