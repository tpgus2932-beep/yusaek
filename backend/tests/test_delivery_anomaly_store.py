import sqlite3
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.delivery_anomaly_store import init_delivery_anomaly_tables, sync_anomalies


def _make_db_factory():
    """실제 get_db()처럼 호출할 때마다 새 커넥션을 여는 팩토리.

    :memory: DB는 커넥션이 닫히면 사라지므로, 공유 캐시 URI로 여러 커넥션이
    같은 인메모리 DB를 보게 하고 keep_alive 커넥션으로 캐시가 유지되게 한다.
    """
    uri = f"file:test_delivery_anomaly_{uuid.uuid4().hex}?mode=memory&cache=shared"
    keep_alive = sqlite3.connect(uri, uri=True)
    keep_alive.row_factory = sqlite3.Row

    def factory():
        conn = sqlite3.connect(uri, uri=True)
        conn.row_factory = sqlite3.Row
        return conn

    return factory, keep_alive


def _sample(invoice_no):
    return {
        "order_no": f"order-{invoice_no}",
        "product_name": "상품",
        "option_info": "옵션",
        "phone": "01000000000",
        "sent_date": "2026-07-18",
        "status": "-",
        "location": "-",
        "scan_date": "-",
        "reason": "llogis에서 송장을 찾을 수 없음",
    }


def test_init_creates_tables():
    get_db, keep_alive = _make_db_factory()
    init_delivery_anomaly_tables(get_db)
    tables = {
        row["name"]
        for row in keep_alive.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
    }
    assert "delivery_anomalies" in tables
    assert "delivery_anomaly_comments" in tables


def test_sync_inserts_new_anomalies():
    get_db, keep_alive = _make_db_factory()
    init_delivery_anomaly_tables(get_db)

    conn = get_db()
    sync_anomalies(conn, {"111": _sample("111"), "222": _sample("222")})
    conn.close()

    rows = keep_alive.execute("SELECT invoice_no FROM delivery_anomalies ORDER BY invoice_no").fetchall()
    assert [r["invoice_no"] for r in rows] == ["111", "222"]


def test_sync_removes_resolved_and_keeps_still_open():
    get_db, keep_alive = _make_db_factory()
    init_delivery_anomaly_tables(get_db)

    conn = get_db()
    sync_anomalies(conn, {"111": _sample("111"), "222": _sample("222")})
    conn.close()

    # 다음 실행: 111은 해결되어 사라지고 222는 여전히 이상현상, 333은 신규
    conn = get_db()
    sync_anomalies(conn, {"222": _sample("222"), "333": _sample("333")})
    conn.close()

    rows = keep_alive.execute("SELECT invoice_no FROM delivery_anomalies ORDER BY invoice_no").fetchall()
    assert [r["invoice_no"] for r in rows] == ["222", "333"]


def test_sync_deletes_comments_of_resolved_anomaly():
    get_db, keep_alive = _make_db_factory()
    init_delivery_anomaly_tables(get_db)

    conn = get_db()
    sync_anomalies(conn, {"111": _sample("111")})
    conn.close()

    anomaly_id = keep_alive.execute(
        "SELECT id FROM delivery_anomalies WHERE invoice_no = ?", ("111",)
    ).fetchone()["id"]
    keep_alive.execute(
        "INSERT INTO delivery_anomaly_comments (anomaly_id, username, text, created_at) VALUES (?, ?, ?, ?)",
        (anomaly_id, "tester", "확인 중", "2026-07-18T00:00:00"),
    )
    keep_alive.commit()

    conn = get_db()
    sync_anomalies(conn, {})  # 111도 해결됨
    conn.close()

    remaining_comments = keep_alive.execute("SELECT * FROM delivery_anomaly_comments").fetchall()
    assert remaining_comments == []


def test_sync_preserves_comments_when_still_open():
    get_db, keep_alive = _make_db_factory()
    init_delivery_anomaly_tables(get_db)

    conn = get_db()
    sync_anomalies(conn, {"111": _sample("111")})
    conn.close()

    anomaly_id = keep_alive.execute(
        "SELECT id FROM delivery_anomalies WHERE invoice_no = ?", ("111",)
    ).fetchone()["id"]
    keep_alive.execute(
        "INSERT INTO delivery_anomaly_comments (anomaly_id, username, text, created_at) VALUES (?, ?, ?, ?)",
        (anomaly_id, "tester", "확인 중", "2026-07-18T00:00:00"),
    )
    keep_alive.commit()

    conn = get_db()
    sync_anomalies(conn, {"111": _sample("111")})  # 계속 열려있음
    conn.close()

    remaining_comments = keep_alive.execute("SELECT * FROM delivery_anomaly_comments").fetchall()
    assert len(remaining_comments) == 1
