import asyncio
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import AsyncMock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.anomaly_scheduler import run_anomaly_scheduler_tick

_KST = timezone(timedelta(hours=9))


def _settings_store():
    store: dict[str, str] = {}
    return store, (lambda key: store.get(key)), (lambda key, value: store.__setitem__(key, value))


def test_no_previous_run_runs_job_immediately():
    store, get_setting, set_setting = _settings_store()
    job = AsyncMock()
    now = datetime(2026, 7, 22, 9, 5, tzinfo=_KST)
    asyncio.run(run_anomaly_scheduler_tick([("delivery_anomaly", job)], get_setting, set_setting, now))
    job.assert_awaited_once_with(force=True)
    assert store["anomaly_scheduler_ran_delivery_anomaly"] == now.isoformat()


def test_within_3_hours_of_last_run_skips_job():
    store, get_setting, set_setting = _settings_store()
    set_setting("anomaly_scheduler_ran_delivery_anomaly", datetime(2026, 7, 22, 9, 0, tzinfo=_KST).isoformat())
    job = AsyncMock()
    now = datetime(2026, 7, 22, 11, 59, tzinfo=_KST)
    asyncio.run(run_anomaly_scheduler_tick([("delivery_anomaly", job)], get_setting, set_setting, now))
    job.assert_not_awaited()


def test_3_hours_after_last_run_runs_job_again():
    store, get_setting, set_setting = _settings_store()
    set_setting("anomaly_scheduler_ran_delivery_anomaly", datetime(2026, 7, 22, 9, 0, tzinfo=_KST).isoformat())
    job = AsyncMock()
    now = datetime(2026, 7, 22, 12, 0, tzinfo=_KST)
    asyncio.run(run_anomaly_scheduler_tick([("delivery_anomaly", job)], get_setting, set_setting, now))
    job.assert_awaited_once_with(force=True)
    assert store["anomaly_scheduler_ran_delivery_anomaly"] == now.isoformat()


def test_runs_repeatedly_overnight_every_3_hours():
    store, get_setting, set_setting = _settings_store()
    job = AsyncMock()
    for hour in (0, 3, 6, 9):
        now = datetime(2026, 7, 22, hour, 0, tzinfo=_KST)
        asyncio.run(run_anomaly_scheduler_tick([("delivery_anomaly", job)], get_setting, set_setting, now))
    assert job.await_count == 4


def test_one_job_failing_does_not_block_the_others():
    store, get_setting, set_setting = _settings_store()
    failing_job = AsyncMock(side_effect=RuntimeError("ably down"))
    ok_job = AsyncMock()
    now = datetime(2026, 7, 22, 16, 0, tzinfo=_KST)
    asyncio.run(run_anomaly_scheduler_tick(
        [("return_anomaly", failing_job), ("exchange_return_anomaly", ok_job)],
        get_setting, set_setting, now,
    ))
    failing_job.assert_awaited_once_with(force=True)
    ok_job.assert_awaited_once_with(force=True)
    assert "anomaly_scheduler_ran_return_anomaly" not in store
    assert "anomaly_scheduler_ran_exchange_return_anomaly" in store
