"""상품코드 키를 YUSAS00000 -> S00000 형식으로 한 번만 옮기는 마이그레이션.

옮기기 전 값은 code_key_migration_backup 테이블에 남긴다. 완료하면 app_settings에 표시를 해서 다시 돌지 않는다.
"""
import json
import re

from barcode_core import normalize_to_s5

DONE_KEY = "code_key_migration_s_v1"
_YUSAS_RE = re.compile(r"^YUSAS\d{5}$", re.IGNORECASE)


def _to_s(code: str) -> str:
    code = str(code or "").strip()
    return normalize_to_s5(code) if _YUSAS_RE.match(code) else code


def _ensure_backup_table(conn) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS code_key_migration_backup (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tbl TEXT NOT NULL,
            row_key TEXT NOT NULL,
            old_value TEXT NOT NULL,
            migrated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
        """
    )


def _backup(conn, tbl: str, row_key, old_value) -> None:
    conn.execute(
        "INSERT INTO code_key_migration_backup (tbl, row_key, old_value) VALUES (?, ?, ?)",
        (tbl, str(row_key), str(old_value)),
    )


def _table_exists(conn, name: str) -> bool:
    row = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name = ?", (name,)).fetchone()
    return bool(row)


def _migrate_code_column(conn, table: str, id_col: str = "id", code_col: str = "code") -> int:
    if not _table_exists(conn, table):
        return 0
    rows = conn.execute(
        f"SELECT {id_col} AS rid, {code_col} AS code FROM {table} WHERE UPPER({code_col}) LIKE 'YUSAS%'"
    ).fetchall()
    changed = 0
    for r in rows:
        new_code = _to_s(r["code"])
        if new_code == r["code"]:
            continue
        _backup(conn, f"{table}.{code_col}", r["rid"], r["code"])
        conn.execute(f"UPDATE {table} SET {code_col} = ? WHERE {id_col} = ?", (new_code, r["rid"]))
        changed += 1
    return changed


def _migrate_inventory_dashboard(conn) -> int:
    """재고 대시보드는 갱신 때마다 통째로 다시 쓰는 캐시라 백업 없이 한 번에 바꾼다."""
    if not _table_exists(conn, "inventory_dashboard_stock"):
        return 0
    cur = conn.execute(
        "UPDATE inventory_dashboard_stock SET code = 'S' || substr(code, 6) "
        "WHERE code GLOB 'YUSAS[0-9][0-9][0-9][0-9][0-9]'"
    )
    return max(cur.rowcount or 0, 0)


def _migrate_bad_stock(conn) -> int:
    """같은 구역에 S 행이 이미 있으면 수량을 합치고 YUSAS 행을 지운다."""
    if not _table_exists(conn, "barcode_bad_stock"):
        return 0
    rows = conn.execute(
        "SELECT id, zone, code, qty FROM barcode_bad_stock WHERE UPPER(code) LIKE 'YUSAS%'"
    ).fetchall()
    changed = 0
    for r in rows:
        new_code = _to_s(r["code"])
        if new_code == r["code"]:
            continue
        _backup(conn, "barcode_bad_stock.code", r["id"], r["code"])
        target = conn.execute(
            "SELECT id FROM barcode_bad_stock WHERE zone = ? AND code = ? AND id != ?",
            (r["zone"], new_code, r["id"]),
        ).fetchone()
        if target:
            conn.execute(
                "UPDATE barcode_bad_stock SET qty = COALESCE(qty, 1) + ? WHERE id = ?",
                (r["qty"] or 1, target["id"]),
            )
            conn.execute("DELETE FROM barcode_bad_stock WHERE id = ?", (r["id"],))
        else:
            conn.execute("UPDATE barcode_bad_stock SET code = ? WHERE id = ?", (new_code, r["id"]))
        changed += 1
    return changed


def _migrate_renamed_codes(conn) -> int:
    if not _table_exists(conn, "barcode_bad_stock_renamed"):
        return 0
    rows = conn.execute("SELECT product_id, codes FROM barcode_bad_stock_renamed").fetchall()
    changed = 0
    for r in rows:
        old = r["codes"] or ""
        new = ",".join(sorted({_to_s(c) for c in old.split(",") if c}))
        if new == old:
            continue
        _backup(conn, "barcode_bad_stock_renamed.codes", r["product_id"], old)
        conn.execute("UPDATE barcode_bad_stock_renamed SET codes = ? WHERE product_id = ?", (new, r["product_id"]))
        changed += 1
    return changed


def _migrate_kimsungil_settings(conn, get_setting, set_setting, setting_keys) -> int:
    changed = 0
    for key in setting_keys:
        raw = get_setting(key)
        if not raw:
            continue
        try:
            data = json.loads(raw)
        except (TypeError, ValueError):
            continue
        if not isinstance(data, dict):
            continue
        merged: dict[str, int] = {}
        for code, qty in data.items():
            new_code = _to_s(code)
            merged[new_code] = merged.get(new_code, 0) + int(qty)
        if merged == data:
            continue
        _backup(conn, "app_settings", key, raw)
        set_setting(key, json.dumps(merged, ensure_ascii=False))
        changed += 1
    return changed


def migrate_codes_to_s(get_shared_db, get_setting, set_setting, kimsungil_setting_keys) -> dict:
    """서버 시작 시 한 번 호출한다. 이미 끝났으면 {'skipped': True}."""
    if get_setting(DONE_KEY):
        return {"skipped": True}
    conn = get_shared_db()
    try:
        _ensure_backup_table(conn)
        result = {
            "kimsungil_settings": _migrate_kimsungil_settings(conn, get_setting, set_setting, kimsungil_setting_keys),
            "kimsungil_log": _migrate_code_column(conn, "kimsungil_log"),
            "bad_stock": _migrate_bad_stock(conn),
            "bad_stock_renamed": _migrate_renamed_codes(conn),
            "inventory_dashboard_stock": _migrate_inventory_dashboard(conn),
        }
        conn.commit()
    finally:
        conn.close()
    set_setting(DONE_KEY, json.dumps(result, ensure_ascii=False))
    return result
