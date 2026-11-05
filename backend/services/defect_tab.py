"""바코드 불량/김승일 리스트의 탭(A/B/C) 구분 - 요청 헤더 X-Defect-Tab을 ContextVar에 담아 둔다.

barcode_routes의 get/set_shared_defect_* 콜백은 인자가 없으므로, 호출 시점의 현재 탭을
ContextVar로 읽어 탭별 저장소를 고른다 (엔드포인트 코드는 그대로 두고 탭만 분리)."""
from __future__ import annotations

import json
from contextlib import contextmanager
from contextvars import ContextVar
from urllib.parse import unquote

from fastapi import Header

BASE_DEFECT_TABS = ("A", "B", "C")
DEFAULT_DEFECT_TAB = "A"
MAX_TAB_NAME_LEN = 10
SETTING_KEY = "defect_tabs_config"

# 사용자가 추가한 탭까지 포함한 전체 탭 목록 (제자리 수정 - main.py의 탭별 저장소가 순회한다)
DEFECT_TABS: list[str] = list(BASE_DEFECT_TABS)
RED_TABS: set[str] = set()
# 탭이 삭제될 때 탭별 데이터를 정리하려는 쪽(main.py)이 등록한다.
REMOVE_HOOKS: list = []

_current_tab: ContextVar[str] = ContextVar("defect_tab", default=DEFAULT_DEFECT_TAB)


def clean_tab_name(value: str | None) -> str:
    # 헤더로는 한글을 못 실으므로 프런트가 URL 인코딩해서 보낸다.
    return unquote(str(value or "")).strip().upper()


def normalize_tab(value: str | None) -> str:
    tab = clean_tab_name(value)
    return tab if tab in DEFECT_TABS else DEFAULT_DEFECT_TAB


def tabs_config() -> dict:
    return {"tabs": list(DEFECT_TABS), "red": [t for t in DEFECT_TABS if t in RED_TABS]}


def dump_config() -> str:
    return json.dumps(
        {"extra": [t for t in DEFECT_TABS if t not in BASE_DEFECT_TABS], "red": sorted(RED_TABS)},
        ensure_ascii=False,
    )


def load_config(raw: str | None) -> None:
    try:
        data = json.loads(raw) if raw else {}
    except Exception:
        data = {}
    for name in data.get("extra") or []:
        tab = clean_tab_name(name)
        if tab and tab not in DEFECT_TABS:
            DEFECT_TABS.append(tab)
    RED_TABS.clear()
    RED_TABS.update(t for t in (data.get("red") or []) if t in DEFECT_TABS)


def add_tab(name: str | None) -> str:
    tab = clean_tab_name(name)
    if not tab or len(tab) > MAX_TAB_NAME_LEN:
        raise ValueError(f"탭 이름은 1~{MAX_TAB_NAME_LEN}자로 입력해 주세요.")
    if tab in DEFECT_TABS:
        raise ValueError("이미 있는 탭 이름입니다.")
    DEFECT_TABS.append(tab)
    return tab


def remove_tab(name: str | None) -> str:
    tab = clean_tab_name(name)
    if tab in BASE_DEFECT_TABS:
        raise ValueError("기본 탭(A/B/C)은 삭제할 수 없습니다.")
    if tab not in DEFECT_TABS:
        raise ValueError("없는 탭입니다.")
    DEFECT_TABS.remove(tab)
    RED_TABS.discard(tab)
    for hook in REMOVE_HOOKS:
        hook(tab)
    return tab


def set_tab_red(name: str | None, red: bool) -> str:
    tab = clean_tab_name(name)
    if tab not in DEFECT_TABS:
        raise ValueError("없는 탭입니다.")
    if red:
        RED_TABS.add(tab)
    else:
        RED_TABS.discard(tab)
    return tab


@contextmanager
def use_tab(name: str):
    """블록 안에서만 현재 탭을 name으로 바꾼다(탭별 저장소를 다른 탭 기준으로 읽고 쓸 때)."""
    token = _current_tab.set(normalize_tab(name))
    try:
        yield
    finally:
        _current_tab.reset(token)


def current_tab() -> str:
    return _current_tab.get()


async def bind_defect_tab(x_defect_tab: str | None = Header(default=None)) -> None:
    # async 의존성이라야 같은 요청 컨텍스트에 세팅되고, sync 엔드포인트의 threadpool로 전파된다.
    _current_tab.set(normalize_tab(x_defect_tab))
