import sqlite3
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.order_recommendation_discover_snapshot import get_discover_snapshot, save_discover_snapshot


def _make_db_factory():
    uri = f"file:test_discover_snapshot_{uuid.uuid4().hex}?mode=memory&cache=shared"
    keep_alive = sqlite3.connect(uri, uri=True)
    keep_alive.row_factory = sqlite3.Row

    def factory():
        conn = sqlite3.connect(uri, uri=True)
        conn.row_factory = sqlite3.Row
        return conn

    return factory, keep_alive


def test_get_returns_none_when_nothing_saved():
    get_shared_db, _keep_alive = _make_db_factory()
    assert get_discover_snapshot(get_shared_db, "2026-08-04") is None


def test_save_then_get_roundtrip():
    get_shared_db, _keep_alive = _make_db_factory()
    items = [{"yusas_code": "S1", "confirmed_qty": 6}]

    save_discover_snapshot(
        get_shared_db, date="2026-08-04", days=3, limit=150, candidate_count=1,
        items=items, need_ezadmin_session=False, updated_by="tester",
    )

    snapshot = get_discover_snapshot(get_shared_db, "2026-08-04")
    assert snapshot["date"] == "2026-08-04"
    assert snapshot["days"] == 3
    assert snapshot["limit"] == 150
    assert snapshot["candidate_count"] == 1
    assert snapshot["items"] == items
    assert snapshot["need_ezadmin_session"] is False
    assert snapshot["updated_by"] == "tester"
    assert snapshot["updated_at"] is not None


def test_saving_again_same_date_overwrites_previous_snapshot():
    get_shared_db, _keep_alive = _make_db_factory()

    save_discover_snapshot(
        get_shared_db, date="2026-08-04", days=3, limit=150, candidate_count=1,
        items=[{"yusas_code": "OLD"}], need_ezadmin_session=False, updated_by="a",
    )
    save_discover_snapshot(
        get_shared_db, date="2026-08-04", days=5, limit=150, candidate_count=2,
        items=[{"yusas_code": "NEW1"}, {"yusas_code": "NEW2"}], need_ezadmin_session=True, updated_by="b",
    )

    snapshot = get_discover_snapshot(get_shared_db, "2026-08-04")
    assert snapshot["days"] == 5
    assert snapshot["candidate_count"] == 2
    assert snapshot["items"] == [{"yusas_code": "NEW1"}, {"yusas_code": "NEW2"}]
    assert snapshot["need_ezadmin_session"] is True
    assert snapshot["updated_by"] == "b"


def test_different_dates_do_not_overwrite_each_other():
    get_shared_db, _keep_alive = _make_db_factory()

    save_discover_snapshot(
        get_shared_db, date="2026-08-03", days=3, limit=150, candidate_count=1,
        items=[{"yusas_code": "YESTERDAY"}], need_ezadmin_session=False, updated_by="a",
    )
    save_discover_snapshot(
        get_shared_db, date="2026-08-04", days=3, limit=150, candidate_count=1,
        items=[{"yusas_code": "TODAY"}], need_ezadmin_session=False, updated_by="a",
    )

    assert get_discover_snapshot(get_shared_db, "2026-08-03")["items"] == [{"yusas_code": "YESTERDAY"}]
    assert get_discover_snapshot(get_shared_db, "2026-08-04")["items"] == [{"yusas_code": "TODAY"}]
