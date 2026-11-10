"""개발용 5175 서버 시작/재시작 API (김승일 계정 전용, Windows 로컬 개발 환경용).

바탕화면의 yusaek_5175_start.bat 를 실행해서 서버를 띄운다.
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

from fastapi import APIRouter, Body, Depends, HTTPException

_ALLOWED_USERS = ("tmddlfnan",)  # 김승일
_FRONTEND_PORT = 5175
_BACKEND_PORT = 8175  # 5175 전용 백엔드 (8000과 분리)
_BAT_NAME = "yusaek_5175_start.bat"
_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent


def _find_bat() -> Path | None:
    profile = Path(os.environ.get("USERPROFILE", str(Path.home())))
    for desktop in (profile / "OneDrive" / "Desktop", profile / "Desktop"):
        candidate = desktop / _BAT_NAME
        if candidate.is_file():
            return candidate
    return None


def build_dev_server_router(*, get_current_user):
    router = APIRouter(prefix="/dev-server")

    @router.post("/restart")
    def restart_dev_server(
        payload: dict = Body(default={}),
        user: str = Depends(get_current_user),
    ):
        if user not in _ALLOWED_USERS:
            raise HTTPException(status_code=403, detail="권한이 없습니다.")
        if os.name != "nt":
            raise HTTPException(status_code=501, detail="Windows 로컬 환경에서만 지원합니다.")

        bat = _find_bat()
        if bat is None:
            raise HTTPException(status_code=500, detail=f"바탕화면에 {_BAT_NAME} 파일이 없습니다.")

        with_backend = bool((payload or {}).get("withBackend"))
        mode = "all" if with_backend else "front"

        # cmd /c start 로 띄우고 cmd 는 바로 종료 -> bat 는 백엔드의 자식 트리에서 분리된다.
        # (백엔드를 종료할 때 bat 자신이 같이 죽는 것을 방지)
        subprocess.Popen(
            [
                "cmd", "/c", "start", "", str(bat),
                mode, str(_PROJECT_ROOT), str(_BACKEND_PORT), sys.executable,
            ],
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            close_fds=True,
        )
        return {
            "ok": True,
            "frontendPort": _FRONTEND_PORT,
            "withBackend": with_backend,
            "backendPort": _BACKEND_PORT if with_backend else None,
        }

    return router
