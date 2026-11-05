from __future__ import annotations

from datetime import datetime, timedelta, timezone

_KST = timezone(timedelta(hours=9))


def init_return_anomaly_tables(get_db) -> None:
    conn = get_db()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS return_anomalies (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            return_invoice_no TEXT NOT NULL UNIQUE,
            origin_invoice_no TEXT NOT NULL DEFAULT '',
            order_no TEXT NOT NULL DEFAULT '',
            product_name TEXT NOT NULL DEFAULT '',
            option_info TEXT NOT NULL DEFAULT '',
            phone TEXT NOT NULL DEFAULT '',
            requested_at TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT '',
            location TEXT NOT NULL DEFAULT '',
            scan_date TEXT NOT NULL DEFAULT '',
            reason TEXT NOT NULL DEFAULT '',
            detected_at TEXT NOT NULL
        )
        """
    )
    cols = [r[1] for r in conn.execute("PRAGMA table_info(return_anomalies)").fetchall()]
    if "is_seller" not in cols:
        # 판매자 귀책 건 표시용 - 다음 이상현상 점검 때 기존 행도 갱신된다.
        conn.execute("ALTER TABLE return_anomalies ADD COLUMN is_seller INTEGER NOT NULL DEFAULT 0")
    conn.commit()
    conn.close()


def sync_anomalies(conn, computed: dict[str, dict]) -> None:
    """오늘 계산된 이상현상 집합(computed)에 맞춰 return_anomalies를 갱신.

    computed에 없는 기존 행은 삭제하고, computed에만 있는 신규 항목은 추가한다.
    계속 남아있는 항목은 건드리지 않는다.
    """
    existing_rows = conn.execute("SELECT id, return_invoice_no FROM return_anomalies").fetchall()
    existing_by_invoice = {row["return_invoice_no"]: row["id"] for row in existing_rows}

    stale_invoices = set(existing_by_invoice) - set(computed)
    for inv in stale_invoices:
        anomaly_id = existing_by_invoice[inv]
        conn.execute("DELETE FROM return_anomalies WHERE id = ?", (anomaly_id,))

    for inv in set(computed) & set(existing_by_invoice):
        conn.execute(
            "UPDATE return_anomalies SET is_seller = ? WHERE id = ?",
            (1 if computed[inv].get("is_seller") else 0, existing_by_invoice[inv]),
        )

    new_invoices = set(computed) - set(existing_by_invoice)
    detected_at = datetime.now(_KST).isoformat()
    for inv in new_invoices:
        data = computed[inv]
        conn.execute(
            """
            INSERT INTO return_anomalies
                (return_invoice_no, origin_invoice_no, order_no, product_name, option_info,
                 phone, requested_at, status, location, scan_date, reason, detected_at, is_seller)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                inv,
                data.get("origin_invoice_no", ""),
                data.get("order_no", ""),
                data.get("product_name", ""),
                data.get("option_info", ""),
                data.get("phone", ""),
                data.get("requested_at", ""),
                data.get("status", ""),
                data.get("location", ""),
                data.get("scan_date", ""),
                data.get("reason", ""),
                detected_at,
                1 if data.get("is_seller") else 0,
            ),
        )

    conn.commit()
