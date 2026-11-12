from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException

from services import ezauto_ably as ez_ably
from services.ezauto_ably import EzautoError

try:
    from sdk import config as ez_config
    from sdk.ezadmin import EzAdminClient, EzAdminSessionExpired
except ModuleNotFoundError:  # package import in unit tests
    from backend.sdk import config as ez_config
    from backend.sdk.ezadmin import EzAdminClient, EzAdminSessionExpired

_KST = timezone(timedelta(hours=9))
_KINDS = {"auto_order": "자동발주", "invoice": "판매처 송장등록"}
_MAX_STEPS = 60


def _now() -> str:
    return datetime.now(_KST).strftime("%Y-%m-%d %H:%M:%S")


def build_ezauto_router(*, get_current_user, get_setting, set_setting):
    """이지오토의 에이블리 '자동발주'·'판매처 송장등록'을 웹에서 실행한다 (services/ezauto_ably.py 참고).

    버튼을 누르면 백그라운드로 실행하고, 화면은 /status 를 주기적으로 읽어 진행 상황과 결과를 보여준다.
    같은 작업이 이미 실행 중이면 다시 시작하지 않는다.
    """
    router = APIRouter(prefix="/ezauto")
    jobs: dict[str, dict] = {
        kind: {"running": False, "started_at": "", "finished_at": "", "started_by": "", "steps": [],
               "result": None, "error": "", "need_session": False}
        for kind in _KINDS
    }
    tasks: set[asyncio.Task] = set()

    def _persist(kind: str) -> None:
        job = jobs[kind]
        try:
            set_setting(f"ezauto_last_{kind}", json.dumps(
                {k: job[k] for k in ("started_at", "finished_at", "started_by", "result", "error")}, ensure_ascii=False))
        except Exception:
            pass  # 기록 실패가 작업 결과를 가리면 안 된다

    def _restored(kind: str) -> dict:
        try:
            return json.loads(get_setting(f"ezauto_last_{kind}") or "{}")
        except (TypeError, ValueError):
            return {}

    async def _ably_client() -> ez_ably.AblyVendorClient:
        api_key = ez_config.ABLY_VENDOR_API_KEY
        if not api_key:
            raise EzautoError("서버에 ABLY_VENDOR_API_KEY가 설정되어 있지 않습니다 (backend/.env 에 추가 후 서버 재시작)")
        token = ez_config.ABLY_VENDOR_TOKEN or await ez_ably.fetch_shop_token(
            ez_config.EZAUTO_DOMAIN, ez_config.EZAUTO_HOST, ez_config.EZAUTO_ABLY_SHOP_ID, base=ez_config.EZAUTO_BASE)
        return ez_ably.AblyVendorClient(token, api_key, base=ez_config.ABLY_PARTNER_BASE)

    async def _execute(kind: str) -> dict:
        job = jobs[kind]

        def log(message: str) -> None:
            job["steps"].append(f"{datetime.now(_KST):%H:%M:%S} {message}")
            del job["steps"][:-_MAX_STEPS]

        ably = await _ably_client()
        ez = EzAdminClient(get_setting, timeout=180.0)
        today = datetime.now(_KST).date()
        if kind == "auto_order":
            return await ez_ably.run_auto_order(ably, ez, shop_id=ez_config.EZAUTO_ABLY_SHOP_ID, today=today, log=log)
        return await ez_ably.run_invoice_register(ably, ez, today=today, log=log)

    async def _run(kind: str) -> None:
        job = jobs[kind]
        try:
            job["result"] = await _execute(kind)
        except EzAdminSessionExpired:
            job["need_session"] = True
            job["error"] = "이지어드민 세션이 없거나 만료되었습니다. 이지어드민 로그인(세션)을 갱신한 뒤 다시 눌러주세요."
        except EzautoError as exc:
            job["error"] = str(exc)
        except Exception as exc:  # 예상 못 한 오류도 화면에 보여준다
            job["error"] = f"{type(exc).__name__}: {str(exc)[:200]}"
        finally:
            job["running"] = False
            job["finished_at"] = _now()
            _persist(kind)

    def _start(kind: str, user: str) -> dict:
        job = jobs[kind]
        if job["running"]:
            raise HTTPException(status_code=409, detail=f"{_KINDS[kind]}이(가) 이미 실행 중입니다 ({job['started_by']}, {job['started_at']} 시작)")
        job.update(running=True, started_at=_now(), finished_at="", started_by=user, steps=[], result=None, error="", need_session=False)
        task = asyncio.create_task(_run(kind))
        tasks.add(task)
        task.add_done_callback(tasks.discard)
        return {"ok": True, "started": True}

    @router.post("/auto-order")
    async def start_auto_order(user: str = Depends(get_current_user)):
        return _start("auto_order", user)

    @router.post("/register-invoices")
    async def start_register_invoices(user: str = Depends(get_current_user)):
        return _start("invoice", user)

    @router.get("/status")
    async def status(user: str = Depends(get_current_user)):
        out = {}
        for kind, label in _KINDS.items():
            job = jobs[kind]
            if not job["started_at"]:  # 서버 재시작 직후: 마지막 결과를 복원해서 보여준다
                out[kind] = {"label": label, "running": False, "steps": [], "need_session": False, **_restored(kind)}
            else:
                out[kind] = {"label": label, **{k: job[k] for k in
                             ("running", "started_at", "finished_at", "started_by", "steps", "result", "error", "need_session")}}
        return out

    return router
