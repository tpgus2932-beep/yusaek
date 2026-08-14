import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.returns_utils import _migrate_return_saved_states_to_snapshots


def _make_conn():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute(
        """CREATE TABLE return_saved_states (
            username TEXT PRIMARY KEY,
            payload TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )"""
    )
    conn.execute(
        """CREATE TABLE return_saved_snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            payload TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )"""
    )
    conn.commit()
    return conn


def test_migrate_copies_old_single_snapshot_into_new_table():
    conn = _make_conn()
    conn.execute(
        "INSERT INTO return_saved_states (username, payload, updated_at) VALUES (?, ?, ?)",
        ("alice", '{"queue_seller": []}', "2026-07-01T00:00:00+00:00"),
    )
    conn.commit()

    _migrate_return_saved_states_to_snapshots(conn)

    rows = conn.execute(
        "SELECT username, payload, updated_at FROM return_saved_snapshots WHERE username = ?",
        ("alice",),
    ).fetchall()
    assert len(rows) == 1
    assert rows[0]["payload"] == '{"queue_seller": []}'
    assert rows[0]["updated_at"] == "2026-07-01T00:00:00+00:00"


def test_migrate_skips_users_who_already_have_a_snapshot():
    conn = _make_conn()
    conn.execute(
        "INSERT INTO return_saved_states (username, payload, updated_at) VALUES (?, ?, ?)",
        ("bob", '{"queue_seller": ["old"]}', "2026-07-01T00:00:00+00:00"),
    )
    conn.execute(
        "INSERT INTO return_saved_snapshots (username, payload, updated_at) VALUES (?, ?, ?)",
        ("bob", '{"queue_seller": ["new"]}', "2026-07-20T00:00:00+00:00"),
    )
    conn.commit()

    _migrate_return_saved_states_to_snapshots(conn)

    rows = conn.execute(
        "SELECT payload FROM return_saved_snapshots WHERE username = ?",
        ("bob",),
    ).fetchall()
    assert len(rows) == 1
    assert rows[0]["payload"] == '{"queue_seller": ["new"]}'


def test_migrate_is_idempotent_across_repeated_calls():
    conn = _make_conn()
    conn.execute(
        "INSERT INTO return_saved_states (username, payload, updated_at) VALUES (?, ?, ?)",
        ("carol", '{"queue_seller": []}', "2026-07-01T00:00:00+00:00"),
    )
    conn.commit()

    _migrate_return_saved_states_to_snapshots(conn)
    _migrate_return_saved_states_to_snapshots(conn)

    rows = conn.execute(
        "SELECT id FROM return_saved_snapshots WHERE username = ?",
        ("carol",),
    ).fetchall()
    assert len(rows) == 1


def test_migrate_handles_empty_old_table():
    conn = _make_conn()
    _migrate_return_saved_states_to_snapshots(conn)
    rows = conn.execute("SELECT id FROM return_saved_snapshots").fetchall()
    assert rows == []
