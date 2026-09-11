from __future__ import annotations

from datetime import datetime, timedelta, timezone

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
    # 반품(수거완료) 이상현상과 재배송(출고완료) 이상현상을 같은 테이블에 합쳐 관리하기
    # 위한 구분 컬럼 - kind='redelivery'인 행은 received_at/return_invoice_no를
    # 각각 재배송시작일/재배송송장번호 의미로 재사용한다 (프론트에서 kind로 라벨 분기).
    _ensure_column(get_db, "exchange_return_anomalies", "kind",
                   "ALTER TABLE exchange_return_anomalies ADD COLUMN kind TEXT NOT NULL DEFAULT 'return'")


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
                 received_at, return_invoice_no, status, location, scan_date, reason, detected_at, kind)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                data.get("kind", "return"),
            ),
        )

    conn.commit()
