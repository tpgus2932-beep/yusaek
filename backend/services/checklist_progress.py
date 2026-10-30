"""일일 체크리스트 작업의 진행도 - 작업을 돌리는 쪽이 기록하고, daily-checklist/status가 화면에 돌려준다.

서버 메모리에만 두는 일시 정보라 재시작하면 사라진다 (작업 자체도 같이 끊기므로 문제없다)."""
from __future__ import annotations

_progress: dict[str, dict] = {}


def set_progress(key: str, phase: str, done: int = 0, total: int = 0) -> None:
    _progress[key] = {"phase": phase, "done": int(done), "total": int(total)}


def get_progress(key: str) -> dict | None:
    return _progress.get(key)


def clear_progress(key: str) -> None:
    _progress.pop(key, None)
