from __future__ import annotations

from datetime import datetime, timedelta, timezone

_KST = timezone(timedelta(hours=9))


def init_delivery_anomaly_tables(get_db) -> None:
    conn = get_db()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS delivery_anomalies (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            invoice_no TEXT NOT NULL UNIQUE,
            order_no TEXT NOT NULL DEFAULT '',
            product_name TEXT NOT NULL DEFAULT '',
            option_info TEXT NOT NULL DEFAULT '',
            phone TEXT NOT NULL DEFAULT '',
            sent_date TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT '',
            location TEXT NOT NULL DEFAULT '',
            scan_date TEXT NOT NULL DEFAULT '',
            reason TEXT NOT NULL DEFAULT '',
            detected_at TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS delivery_anomaly_comments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            anomaly_id INTEGER NOT NULL,
            username TEXT NOT NULL,
            text TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
        """
    )
    conn.commit()
    conn.close()


def sync_anomalies(conn, computed: dict[str, dict]) -> None:
    """오늘 계산된 이상현상 집합(computed)에 맞춰 delivery_anomalies를 갱신.

    computed에 없는 기존 행은 삭제(댓글도 함께 삭제)하고,
    computed에만 있는 신규 항목은 추가한다. 계속 남아있는 항목은 건드리지 않는다
    (댓글 보존을 위해).
    """
    existing_rows = conn.execute("SELECT id, invoice_no FROM delivery_anomalies").fetchall()
    existing_by_invoice = {row["invoice_no"]: row["id"] for row in existing_rows}

    stale_invoices = set(existing_by_invoice) - set(computed)
    for inv in stale_invoices:
        anomaly_id = existing_by_invoice[inv]
        conn.execute("DELETE FROM delivery_anomaly_comments WHERE anomaly_id = ?", (anomaly_id,))
        conn.execute("DELETE FROM delivery_anomalies WHERE id = ?", (anomaly_id,))

    new_invoices = set(computed) - set(existing_by_invoice)
    detected_at = datetime.now(_KST).isoformat()
    for inv in new_invoices:
        data = computed[inv]
        conn.execute(
            """
            INSERT INTO delivery_anomalies
                (invoice_no, order_no, product_name, option_info, phone,
                 sent_date, status, location, scan_date, reason, detected_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                inv,
                data.get("order_no", ""),
                data.get("product_name", ""),
                data.get("option_info", ""),
                data.get("phone", ""),
                data.get("sent_date", ""),
                data.get("status", ""),
                data.get("location", ""),
                data.get("scan_date", ""),
                data.get("reason", ""),
                detected_at,
            ),
        )

    conn.commit()
