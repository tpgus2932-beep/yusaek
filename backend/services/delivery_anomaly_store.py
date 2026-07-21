from __future__ import annotations

from datetime import datetime, timedelta, timezone

_KST = timezone(timedelta(hours=9))


def _ensure_column(get_db, table: str, column: str, ddl: str) -> None:
    conn = get_db()
    cols = [r["name"] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()]
    if column not in cols:
        conn.execute(ddl)
        conn.commit()
    conn.close()


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
    conn.commit()
    conn.close()
    # 수령여부확인 문자 발송/답장 추적 (기존 배포된 테이블에는 ALTER TABLE로 추가)
    _ensure_column(get_db, "delivery_anomalies", "confirm_sent_at",
                   "ALTER TABLE delivery_anomalies ADD COLUMN confirm_sent_at TEXT NOT NULL DEFAULT ''")
    _ensure_column(get_db, "delivery_anomalies", "confirm_reply",
                   "ALTER TABLE delivery_anomalies ADD COLUMN confirm_reply TEXT NOT NULL DEFAULT ''")
    _ensure_column(get_db, "delivery_anomalies", "confirm_reply_at",
                   "ALTER TABLE delivery_anomalies ADD COLUMN confirm_reply_at TEXT NOT NULL DEFAULT ''")
    # 답장에 대한 응대(미수령 안내 또는 직접 답변) 발송 여부 — 한 번 응대하면
    # 이후 새 답장이 와도 응대 버튼을 다시 띄우지 않기 위한 플래그
    _ensure_column(get_db, "delivery_anomalies", "response_sent_at",
                   "ALTER TABLE delivery_anomalies ADD COLUMN response_sent_at TEXT NOT NULL DEFAULT ''")
    _ensure_column(get_db, "delivery_anomalies", "response_text",
                   "ALTER TABLE delivery_anomalies ADD COLUMN response_text TEXT NOT NULL DEFAULT ''")


def sync_anomalies(conn, computed: dict[str, dict]) -> None:
    """오늘 계산된 이상현상 집합(computed)에 맞춰 delivery_anomalies를 갱신.

    computed에 없는 기존 행은 삭제하고, computed에만 있는 신규 항목은 추가한다.
    계속 남아있는 항목은 건드리지 않는다.
    """
    existing_rows = conn.execute("SELECT id, invoice_no FROM delivery_anomalies").fetchall()
    existing_by_invoice = {row["invoice_no"]: row["id"] for row in existing_rows}

    stale_invoices = set(existing_by_invoice) - set(computed)
    for inv in stale_invoices:
        anomaly_id = existing_by_invoice[inv]
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
