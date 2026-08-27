from __future__ import annotations

from datetime import datetime, timedelta, timezone

from services.delivery_anomaly_logic import LOST_PACKAGE_MESSAGE

_KST = timezone(timedelta(hours=9))


def _ensure_column(get_db, table: str, column: str, ddl: str) -> bool:
    """column을 추가한다. 이번 호출에서 실제로 새로 추가했으면 True를 반환한다."""
    conn = get_db()
    cols = [r["name"] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()]
    added = column not in cols
    if added:
        conn.execute(ddl)
        conn.commit()
    conn.close()
    return added


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
    # 미수령 응대 후 EZAdmin CS창에서 주문복사(재출고용)를 실행했는지 여부
    _ensure_column(get_db, "delivery_anomalies", "order_copied_at",
                   "ALTER TABLE delivery_anomalies ADD COLUMN order_copied_at TEXT NOT NULL DEFAULT ''")
    # 미수령 응대를 한 번이라도 보냈는지 여부 - response_text/response_sent_at은
    # 새 답장이 오면 응대 버튼을 다시 띄우기 위해 초기화되지만, 그와 별개로
    # 주문복사 버튼은 한 번 활성화되면 주문복사가 완료될 때까지 계속 보여야 하므로
    # 초기화되지 않는 별도 플래그로 추적한다
    just_added_ever_lost = _ensure_column(
        get_db, "delivery_anomalies", "ever_lost_response",
        "ALTER TABLE delivery_anomalies ADD COLUMN ever_lost_response INTEGER NOT NULL DEFAULT 0",
    )
    if just_added_ever_lost:
        # 이미 미수령 응대를 보내둔 기존 행은 새 플래그가 없어 주문복사 버튼이
        # 갑자기 사라지지 않도록, 배포 시점에 한 번만 소급 적용한다
        conn = get_db()
        conn.execute(
            "UPDATE delivery_anomalies SET ever_lost_response = 1 WHERE response_text = ?",
            (LOST_PACKAGE_MESSAGE,),
        )
        conn.commit()
        conn.close()


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
