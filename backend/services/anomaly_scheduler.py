from __future__ import annotations

import asyncio
import traceback
from datetime import datetime, timedelta, timezone
from typing import Awaitable, Callable

_KST = timezone(timedelta(hours=9))

RUN_INTERVAL = timedelta(hours=3)
POLL_INTERVAL_SECONDS = 300

AnomalyJob = tuple[str, Callable[..., Awaitable[None]]]


def _scheduler_setting_key(name: str) -> str:
    return f"anomaly_scheduler_ran_{name}"


async def run_anomaly_scheduler_tick(
    jobs: list[AnomalyJob],
    get_setting: Callable[[str], str | None],
    set_setting: Callable[[str, str], None],
    now: datetime,
) -> None:
    """서버가 켜져있는 동안, 마지막 실행 이후 RUN_INTERVAL(3시간)이 지난 이상현상
    작업들을 강제로 1회씩 실행한다.

    각 작업(job)은 수동 새로고침용 당일-가드를 자체적으로 갖고 있지만, 그 가드는
    사용자가 이미 새로고침을 눌렀으면 스킵해버린다. 이 스케줄러는 그와 무관하게
    마지막 실행 시각 기준 3시간마다 항상 실행되도록 별도 키로 추적한다.
    """
    for name, job in jobs:
        setting_key = _scheduler_setting_key(name)
        last_run_raw = get_setting(setting_key)
        if last_run_raw:
            try:
                last_run = datetime.fromisoformat(last_run_raw)
            except ValueError:
                last_run = None
            if last_run is not None and now - last_run < RUN_INTERVAL:
                continue
        try:
            await job(force=True)
            set_setting(setting_key, now.isoformat())
        except Exception:
            traceback.print_exc()  # 이 작업만 실패 - 다음 틱(5분 뒤)에 재시도


async def run_anomaly_scheduler_loop(
    jobs: list[AnomalyJob],
    get_setting: Callable[[str], str | None],
    set_setting: Callable[[str, str], None],
) -> None:
    while True:
        try:
            await run_anomaly_scheduler_tick(jobs, get_setting, set_setting, datetime.now(_KST))
        except Exception:
            traceback.print_exc()
        await asyncio.sleep(POLL_INTERVAL_SECONDS)
