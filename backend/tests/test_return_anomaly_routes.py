import asyncio
import sqlite3
import sys
import uuid
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from api.return_anomaly_routes import _KST, build_return_anomaly_router
from services.return_anomaly_store import init_return_anomaly_tables


def _make_db_factory():
    uri = f"file:test_return_anomaly_routes_{uuid.uuid4().hex}?mode=memory&cache=shared"
    keep_alive = sqlite3.connect(uri, uri=True)
    keep_alive.row_factory = sqlite3.Row

    def factory():
        conn = sqlite3.connect(uri, uri=True)
        conn.row_factory = sqlite3.Row
        return conn

    return factory, keep_alive


def test_run_scheduled_attribute_skips_when_already_run_today():
    get_db, keep_alive = _make_db_factory()
    init_return_anomaly_tables(get_db)
    today_iso = datetime.now(_KST).isoformat()
    router = build_return_anomaly_router(
        get_current_user=lambda: "tester",
        get_db=get_db,
        get_setting=lambda key: today_iso if key == "return_anomaly_last_run_date" else None,
        set_setting=lambda key, value: None,
    )
    assert hasattr(router, "run_scheduled")
    asyncio.run(router.run_scheduled(force=False))  # 네트워크 호출 없이 즉시 반환돼야 함
