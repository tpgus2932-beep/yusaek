from __future__ import annotations

from datetime import datetime, timezone


def init_equipment_tables(get_db) -> None:
    conn = get_db()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS equipment_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            quantity INTEGER NOT NULL DEFAULT 0,
            min_stock INTEGER NOT NULL DEFAULT 0,
            created_by TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS equipment_processed_vouchers (
            voucher_no TEXT PRIMARY KEY,
            processed_at TEXT NOT NULL,
            processed_by TEXT NOT NULL DEFAULT '',
            matched_count INTEGER NOT NULL DEFAULT 0
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS equipment_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            equipment_id INTEGER NOT NULL,
            equipment_name TEXT NOT NULL DEFAULT '',
            change_type TEXT NOT NULL,
            delta INTEGER NOT NULL,
            before_qty INTEGER NOT NULL,
            after_qty INTEGER NOT NULL,
            voucher_no TEXT NOT NULL DEFAULT '',
            matched_text TEXT NOT NULL DEFAULT '',
            reason TEXT NOT NULL DEFAULT '',
            created_by TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL
        )
        """
    )
    conn.commit()
    conn.close()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def log_change(
    conn,
    *,
    equipment_id: int,
    equipment_name: str,
    change_type: str,
    delta: int,
    before_qty: int,
    after_qty: int,
    created_by: str,
    voucher_no: str = "",
    matched_text: str = "",
    reason: str = "",
) -> None:
    conn.execute(
        """
        INSERT INTO equipment_logs (
            equipment_id, equipment_name, change_type, delta, before_qty, after_qty,
            voucher_no, matched_text, reason, created_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            equipment_id, equipment_name, change_type, delta, before_qty, after_qty,
            voucher_no, matched_text, reason, created_by, now_iso(),
        ),
    )
