import json
import sqlite3

from services.code_key_migration import DONE_KEY, migrate_codes_to_s


class _KeepOpen:
    """모듈이 close()해도 같은 메모리 DB를 계속 검사할 수 있게 닫기를 무시한다."""

    def __init__(self):
        self._conn = sqlite3.connect(":memory:", check_same_thread=False)
        self._conn.row_factory = sqlite3.Row

    def close(self):
        pass

    def __getattr__(self, name):
        return getattr(self._conn, name)


def _make_env():
    conn = _KeepOpen()
    conn.execute("CREATE TABLE kimsungil_log (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL)")
    conn.execute(
        "CREATE TABLE barcode_bad_stock (id INTEGER PRIMARY KEY AUTOINCREMENT, zone TEXT, code TEXT, qty INTEGER)"
    )
    conn.execute("CREATE TABLE barcode_bad_stock_renamed (product_id TEXT PRIMARY KEY, codes TEXT)")
    conn.execute("CREATE TABLE inventory_dashboard_stock (code TEXT NOT NULL, stock_qty INTEGER)")
    return conn, {}, None


def _run(conn, settings, keys=("kimsungil_counts", "kimsungil_counts_B")):
    return migrate_codes_to_s(lambda: conn, settings.get, settings.__setitem__, list(keys))


def test_migrates_all_stores_and_keeps_backup():
    conn, settings, _ = _make_env()
    conn.execute("INSERT INTO kimsungil_log (code) VALUES ('YUSAS00123'), ('S00456')")
    conn.execute("INSERT INTO barcode_bad_stock (zone, code, qty) VALUES ('A', 'YUSAS00123', 2), ('A', 'S00123', 1)")
    conn.execute("INSERT INTO barcode_bad_stock (zone, code, qty) VALUES ('B', 'YUSAS00789', 1)")
    conn.execute("INSERT INTO barcode_bad_stock_renamed VALUES ('p1', 'YUSAS00123,S00123,YUSAS00789')")
    conn.execute("INSERT INTO inventory_dashboard_stock VALUES ('YUSAS00123', 5), ('S00999', 1)")
    settings["kimsungil_counts"] = json.dumps({"YUSAS00123": 2, "S00123": 1, "S00456": 4})

    result = _run(conn, settings)

    assert result["kimsungil_settings"] == 1
    assert json.loads(settings["kimsungil_counts"]) == {"S00123": 3, "S00456": 4}
    assert [r["code"] for r in conn.execute("SELECT code FROM kimsungil_log ORDER BY id")] == ["S00123", "S00456"]

    rows = {(r["zone"], r["code"]): r["qty"] for r in conn.execute("SELECT zone, code, qty FROM barcode_bad_stock")}
    assert rows == {("A", "S00123"): 3, ("B", "S00789"): 1}  # 같은 구역·코드는 수량 합산

    assert conn.execute("SELECT codes FROM barcode_bad_stock_renamed").fetchone()["codes"] == "S00123,S00789"
    assert [r["code"] for r in conn.execute("SELECT code FROM inventory_dashboard_stock ORDER BY code")] == [
        "S00123", "S00999",
    ]

    backup = conn.execute("SELECT tbl, old_value FROM code_key_migration_backup").fetchall()
    assert ("kimsungil_log.code", "YUSAS00123") in {(b["tbl"], b["old_value"]) for b in backup}
    assert any(b["tbl"] == "app_settings" and "YUSAS00123" in b["old_value"] for b in backup)
    assert settings[DONE_KEY]


def test_runs_only_once():
    conn, settings, _ = _make_env()
    conn.execute("INSERT INTO kimsungil_log (code) VALUES ('YUSAS00123')")
    _run(conn, settings)
    conn.execute("INSERT INTO kimsungil_log (code) VALUES ('YUSAS00555')")

    assert _run(conn, settings) == {"skipped": True}
    assert conn.execute("SELECT code FROM kimsungil_log WHERE id = 2").fetchone()["code"] == "YUSAS00555"


def test_missing_tables_and_settings_are_ok():
    conn = _KeepOpen()
    settings = {}

    result = migrate_codes_to_s(lambda: conn, settings.get, settings.__setitem__, ["kimsungil_counts"])

    assert result == {
        "kimsungil_settings": 0, "kimsungil_log": 0, "bad_stock": 0,
        "bad_stock_renamed": 0, "inventory_dashboard_stock": 0,
    }
