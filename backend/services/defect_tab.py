"""바코드 불량/김승일 리스트의 탭(A/B/C) 구분 - 요청 헤더 X-Defect-Tab을 ContextVar에 담아 둔다.

barcode_routes의 get/set_shared_defect_* 콜백은 인자가 없으므로, 호출 시점의 현재 탭을
ContextVar로 읽어 탭별 저장소를 고른다 (엔드포인트 코드는 그대로 두고 탭만 분리)."""
from __future__ import annotations

from contextvars import ContextVar

from fastapi import Header

DEFECT_TABS = ("A", "B", "C")
DEFAULT_DEFECT_TAB = "A"

_current_tab: ContextVar[str] = ContextVar("defect_tab", default=DEFAULT_DEFECT_TAB)


def normalize_tab(value: str | None) -> str:
    tab = str(value or "").strip().upper()
    return tab if tab in DEFECT_TABS else DEFAULT_DEFECT_TAB


def current_tab() -> str:
    return _current_tab.get()


async def bind_defect_tab(x_defect_tab: str | None = Header(default=None)) -> None:
    # async 의존성이라야 같은 요청 컨텍스트에 세팅되고, sync 엔드포인트의 threadpool로 전파된다.
    _current_tab.set(normalize_tab(x_defect_tab))
