from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Body, Depends

_KST = timezone(timedelta(hours=9))

# key: 저장된 설정 키(각 액션 라우터가 실행 시 set_setting으로 기록), label: 화면 표시명
CHECKLIST_ITEMS = [
    {"key": "daily_check_new_return_pickup", "label": "신규반품 회수신청"},
    {"key": "daily_check_exchange_pickup", "label": "교환 회수접수"},
    {"key": "daily_check_process_all", "label": "전체처리 (교환반품)"},
    {"key": "daily_check_ship_pending", "label": "상품준비중 송장입력"},
]
_CHECKLIST_KEYS = {entry["key"] for entry in CHECKLIST_ITEMS}

# 이 시간 넘게 running_at이 안 지워지면 죽은 작업(서버 재시작, 클라이언트가
# 새로고침돼 mark-finish를 못 부른 경우 등)으로 보고 "진행 중" 표시를 풀어준다.
_STALE_MINUTES = 30


def _is_running(get_setting, key: str) -> bool:
    running_at = get_setting(f"{key}_running_at")
    if not running_at:
        return False
    try:
        started = datetime.fromisoformat(running_at)
    except ValueError:
        return False
    if started.tzinfo is None:
        started = started.replace(tzinfo=_KST)
    return datetime.now(_KST) - started < timedelta(minutes=_STALE_MINUTES)


def build_daily_checklist_router(*, get_current_user, get_setting, set_setting=None):
    router = APIRouter(prefix="/daily-checklist")

    @router.get("/status")
    async def status(user=Depends(get_current_user)):
        today = datetime.now(_KST).strftime("%Y-%m-%d")
        items = []
        for entry in CHECKLIST_ITEMS:
            last_run_at = get_setting(entry["key"])
            done_today = bool(last_run_at) and str(last_run_at)[:10] == today
            items.append({
                "key": entry["key"],
                "label": entry["label"],
                "last_run_at": last_run_at,
                "done_today": done_today,
                "in_progress": _is_running(get_setting, entry["key"]),
                "last_result": get_setting(f"{entry['key']}_last_result"),
            })
        return {"ok": True, "date": today, "items": items}

    # 프론트에서 직접 EZAdmin/에이블리 호출을 순차 진행하는 "전체처리"처럼
    # 단일 백엔드 엔드포인트로 묶이지 않는 작업을 위한 진행 상태 마킹.
    # (단일 엔드포인트로 끝나는 나머지 3개 항목은 각 라우터가 자체적으로
    # try/finally로 기록하므로 이 엔드포인트에 기대지 않아도 새로고침에 안전하다.)
    @router.post("/{key}/mark-start")
    async def mark_start(key: str, user=Depends(get_current_user)):
        if key not in _CHECKLIST_KEYS:
            return {"ok": False, "error": "unknown key"}
        if set_setting:
            set_setting(f"{key}_running_at", datetime.now(_KST).isoformat())
        return {"ok": True}

    @router.post("/{key}/mark-finish")
    async def mark_finish(key: str, payload: dict = Body(default={}), user=Depends(get_current_user)):
        if key not in _CHECKLIST_KEYS:
            return {"ok": False, "error": "unknown key"}
        if set_setting:
            set_setting(f"{key}_running_at", None)
            message = (payload or {}).get("message")
            if message:
                set_setting(f"{key}_last_result", str(message)[:300])
        return {"ok": True}

    return router
