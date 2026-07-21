from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends

_KST = timezone(timedelta(hours=9))

# key: 저장된 설정 키(각 액션 라우터가 실행 시 set_setting으로 기록), label: 화면 표시명
CHECKLIST_ITEMS = [
    {"key": "daily_check_new_return_pickup", "label": "신규반품 회수신청"},
    {"key": "daily_check_exchange_pickup", "label": "교환 회수접수"},
    {"key": "daily_check_process_all", "label": "전체처리 (교환반품)"},
    {"key": "daily_check_ship_pending", "label": "상품준비중 송장입력"},
]


def build_daily_checklist_router(*, get_current_user, get_setting):
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
            })
        return {"ok": True, "date": today, "items": items}

    return router
