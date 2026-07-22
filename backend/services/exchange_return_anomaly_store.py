from __future__ import annotations

from datetime import datetime, timedelta, timezone

_KST = timezone(timedelta(hours=9))


def init_exchange_return_anomaly_tables(get_db) -> None:
    conn = get_db()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS exchange_return_anomalies (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            exchange_sno TEXT NOT NULL UNIQUE,
            order_no TEXT NOT NULL DEFAULT '',
            product_name TEXT NOT NULL DEFAULT '',
            option_info TEXT NOT NULL DEFAULT '',
            phone TEXT NOT NULL DEFAULT '',
            received_at TEXT NOT NULL DEFAULT '',
            return_invoice_no TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT '',
            location TEXT NOT NULL DEFAULT '',
            scan_date TEXT NOT NULL DEFAULT '',
            reason TEXT NOT NULL DEFAULT '',
            detected_at TEXT NOT NULL
        )
        """
    )
    conn.commit()
    conn.close()


def sync_anomalies(conn, computed: dict[str, dict]) -> None:
    """오늘 계산된 이상현상 집합(computed)에 맞춰 exchange_return_anomalies를 갱신.

    computed에 없는 기존 행은 삭제하고, computed에만 있는 신규 항목은 추가한다.
    계속 남아있는 항목은 건드리지 않는다.
    """
    existing_rows = conn.execute("SELECT id, exchange_sno FROM exchange_return_anomalies").fetchall()
    existing_by_sno = {row["exchange_sno"]: row["id"] for row in existing_rows}

    stale_snos = set(existing_by_sno) - set(computed)
    for sno in stale_snos:
        anomaly_id = existing_by_sno[sno]
        conn.execute("DELETE FROM exchange_return_anomalies WHERE id = ?", (anomaly_id,))

    new_snos = set(computed) - set(existing_by_sno)
    detected_at = datetime.now(_KST).isoformat()
    for sno in new_snos:
        data = computed[sno]
        conn.execute(
            """
            INSERT INTO exchange_return_anomalies
                (exchange_sno, order_no, product_name, option_info, phone,
                 received_at, return_invoice_no, status, location, scan_date, reason, detected_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                sno,
                data.get("order_no", ""),
                data.get("product_name", ""),
                data.get("option_info", ""),
                data.get("phone", ""),
                data.get("received_at", ""),
                data.get("return_invoice_no", ""),
                data.get("status", ""),
                data.get("location", ""),
                data.get("scan_date", ""),
                data.get("reason", ""),
                detected_at,
            ),
        )

    conn.commit()
