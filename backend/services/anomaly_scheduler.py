from __future__ import annotations

import asyncio
import traceback
from datetime import datetime, timedelta, timezone
from typing import Awaitable, Callable

_KST = timezone(timedelta(hours=9))

RUN_HOUR_KST = 16
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
    """오후 4시(KST) 이후, 오늘 아직 못 돌린 이상현상 작업들을 강제로 1회씩 실행한다.

    각 작업(job)은 수동 새로고침용 당일-가드를 자체적으로 갖고 있지만, 그 가드는
    사용자가 4시 이전에 이미 새로고침을 눌렀으면 스킵해버린다. 이 스케줄러는 그와
    무관하게 4시 이후 하루 1회는 항상 실행되도록 별도 키로 추적한다.
    """
    if now.hour < RUN_HOUR_KST:
        return

    today_str = now.strftime("%Y-%m-%d")
    for name, job in jobs:
        setting_key = _scheduler_setting_key(name)
        if str(get_setting(setting_key) or "")[:10] == today_str:
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
