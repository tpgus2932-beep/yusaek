"""휴대폰(ADB + 접근성 브리지 앱)으로 카카오톡 1:1 메시지를 보내는 어댑터.

- 폰 한 대를 여러 사람이 쓰므로 호출하는 쪽(kakao_routes)이 반드시 한 번에 한 건씩만 부른다.
- 전송 버튼을 누른 뒤의 실패는 SendUncertain으로 올린다. 자동 재시도 금지 — 폰에서 직접 확인해야 한다.
- 계정(account)은 연결 시 한 번만 확인하고, 전송마다는 폰 하드웨어 ID만 다시 본다(화면 이동 없음).
"""
from __future__ import annotations

import os
import pathlib
import re

from services.kakao_adb_bridge import Adb, Blocked

_BACKEND = pathlib.Path(__file__).resolve().parent.parent

# 이 오류가 나면 큐를 멈춘다(다음 건도 같은 이유로 실패하므로).
FATAL_ERRORS = {
    "accessibility_disabled",
    "account_changed",
    "device_identity_mismatch",
    "adb_connection_failed",
    "adb_command_failed",
    "device_not_bound",
}

_MESSAGES = {
    "accessibility_disabled": "휴대폰의 접근성 서비스(YUSAEK TALK 화면 속도 시험)가 꺼져 있습니다.",
    "account_changed": "휴대폰의 카카오 계정이 연결 시점과 다릅니다. 다시 연결(계정 확인)하세요.",
    "device_identity_mismatch": "연결된 휴대폰이 처음 등록한 폰과 다릅니다.",
    "adb_connection_failed": "휴대폰과 연결할 수 없습니다. USB 케이블과 디버깅 허용을 확인하세요.",
    "adb_command_failed": "휴대폰 명령이 실패했습니다. 연결 상태를 확인하세요.",
    "device_not_bound": "먼저 '더보기'에서 휴대폰을 연결(계정 확인)하세요.",
    "device_missing_or_ambiguous": "승인된 휴대폰이 없거나 여러 대입니다. 한 대만 연결하거나 기기번호를 입력하세요.",
    "empty_message": "친구 이름과 메시지를 입력하세요.",
    "PROFILE_NOT_FOUND": "카카오톡 친구 목록에서 정확히 같은 이름을 찾지 못했습니다.",
    "PROFILE_AMBIGUOUS": "같은 이름의 친구가 여러 명이라 보내지 않았습니다.",
    "target_not_found": "카카오톡 친구 목록에서 정확히 같은 이름을 찾지 못했습니다.",
    "target_missing_or_ambiguous": "같은 이름의 친구가 없거나 여러 명입니다.",
    "results_unstable": "검색 결과 화면이 안정되지 않아 보내지 않았습니다.",
    "friend_tab_unavailable": "카카오톡 검색 결과의 '친구' 탭을 찾지 못했습니다.",
    "kakao_main_unavailable": "카카오톡 메인 화면으로 이동하지 못했습니다. 폰 잠금을 풀어 주세요.",
    "search_field_missing": "카카오톡 검색창을 찾지 못했습니다.",
    "search_input_failed": "검색어 입력에 실패했습니다.",
    "chat_open_button_missing": "프로필의 '1:1 채팅' 버튼을 찾지 못했습니다.",
    "chat_open_failed": "'1:1 채팅' 버튼을 누르지 못했습니다.",
    "chat_open_unverified": "채팅방이 열렸는지 확인하지 못했습니다.",
    "not_in_chat_input": "채팅 입력창을 찾지 못했습니다.",
    "input_set_failed": "메시지 입력에 실패했습니다.",
    "send_button_missing": "전송 버튼을 찾지 못해 보내지 않았습니다.",
    "friends_tab_unavailable": "카카오톡 '친구' 탭으로 이동하지 못했습니다. 폰 잠금을 풀어 주세요.",
    "friends_home_unavailable": "카카오톡 친구 화면(상단 '친구' 칩)으로 이동하지 못했습니다. 폰 잠금을 풀어 주세요.",
    "friends_screen_changed": "친구 목록을 읽는 중 화면이 바뀌었습니다. 폰을 만지지 말고 다시 시도하세요.",
    "friends_scan_expired": "친구 목록 읽기가 중단되었습니다. 다시 시도하세요.",
    "history_since_invalid": "동기화할 날짜 형식이 올바르지 않습니다.",
    "history_scan_gap": "대화를 위로 넘기다 일부를 건너뛰어 끝까지 읽지 못했습니다. 다시 시도하세요.",
    "history_scan_limit": "대화가 너무 길어 끝까지 읽지 못했습니다. 날짜를 가깝게 지정하세요.",
    "history_scan_expired": "대화 읽기가 중단되었습니다. 다시 시도하세요.",
    "history_failed": "대화를 읽지 못했습니다.",
    "not_in_room": "카카오톡 채팅방에 들어가지 못했습니다.",
    "friends_sort_unavailable": "친구 목록 정렬(친구추가순)을 바꾸지 못했습니다. 폰을 만지지 말고 다시 시도하세요.",
    "friends_scan_gap": "스크롤이 친구 목록을 건너뛰어 끝까지 읽지 못했습니다. 다시 시도하세요.",
    "friends_scan_limit": "친구 목록이 너무 길어 끝까지 읽지 못했습니다.",
    "friends_top_unavailable": "친구 목록의 맨 위로 이동하지 못했습니다.",
    "friends_window_unavailable": "카카오톡 화면을 읽지 못했습니다. 폰 잠금을 풀어 주세요.",
    "friend_count_changed": "친구 목록을 읽는 도중 친구 수가 바뀌었습니다. 다시 시도하세요.",
    "friend_count_mismatch": "읽은 친구 수가 카카오톡에 표시된 친구 수와 달라 가져오지 않았습니다.",
    "friend_onboarding_incomplete": "친구 목록을 끝까지 읽지 못했습니다.",
    "friend_onboarding_invalid": "친구 목록 형식이 올바르지 않습니다.",
    "executor_busy": "폰이 다른 작업을 처리 중입니다.",
    "executor_no_result": "폰에서 응답이 없습니다.",
    "payload_invalid": "폰으로 보낸 요청이 올바르지 않습니다.",
}


class SendUncertain(Exception):
    """전송 버튼을 누른 뒤 결과를 확인하지 못함 — 중복 발송 위험 때문에 재시도하면 안 된다."""


def adb_path() -> str:
    env = os.environ.get("KAKAO_ADB_PATH", "").strip()
    if env:
        return env
    bundled = _BACKEND / "kakao_tools" / "platform-tools" / ("adb.exe" if os.name == "nt" else "adb")
    return str(bundled) if bundled.is_file() else "adb"


def describe_error(code: str) -> str:
    code = str(code or "")
    head, _, detail = code.partition(":")  # 예: friend_count_mismatch:12/15
    text = _MESSAGES.get(head)
    if text is None:
        return f"전송에 실패했습니다. ({code or 'unknown'})"
    return f"{text} ({detail})" if detail else text


def error_code(exc: Exception) -> str:
    return str(exc) if isinstance(exc, Blocked) else "adb_adapter_failed"


def list_devices() -> list[dict]:
    """`adb devices -l` 결과를 [{serial, state, model}]로."""
    text = Adb({"adb": adb_path()}).global_run("devices", "-l")
    rows = []
    for line in text.splitlines()[1:]:
        fields = line.split()
        if len(fields) < 2:
            continue
        model = next((f.split(":", 1)[1] for f in fields[2:] if f.startswith("model:")), "")
        rows.append({"serial": fields[0], "state": fields[1], "model": model.replace("_", " ")})
    return rows


def bind(serial: str = "") -> dict:
    """폰과 카카오 계정을 확인하고 고정할 값을 돌려준다."""
    serial = (serial or "").strip()
    if not serial:
        ready = [d["serial"] for d in list_devices() if d["state"] == "device"]
        if len(ready) != 1:
            raise Blocked("device_missing_or_ambiguous")
        serial = ready[0]
    device = Adb({"adb": adb_path(), "serial": serial})
    device.connect_transport()
    account = device.account_fast()
    return {"serial": device.serial, "hardware_id": device.verified_hardware, "account": account}


def read_friends(config: dict) -> tuple[list[str], int]:
    """카카오톡 '친구' 탭을 끝까지 스크롤해 (친구 이름 목록, 카카오톡이 표시한 친구 수)를 읽는다.

    폰 앱이 읽은 개수와 화면의 '친구 N' 숫자가 같을 때만 성공으로 돌려준다.
    '추천친구'·'채널' 구역은 읽지 않는다. 같은 이름이 둘 이상이면 목록에도 그대로 중복으로 들어 있다.
    """
    if not config.get("serial") or not config.get("hardware_id") or not config.get("account"):
        raise Blocked("device_not_bound")
    device = Adb({"adb": adb_path(), "serial": config["serial"], "hardware_id": config["hardware_id"], "account": config["account"]})
    device.connect_transport()
    data = device.onboard_fast()
    names = [str(e["name"]).strip() for e in data["entries"] if str(e.get("name") or "").strip()]
    return names, int(data.get("expected_count") or len(names))


def read_recent_friends(config: dict, known: set, stop_after: int = 10) -> tuple[list[str], int, bool]:
    """'친구추가순'으로 바꿔 맨 위(가장 최근에 추가한 친구)부터 읽다가, 이미 아는 이름이
    stop_after개 연속 나오면 멈춘다. 정렬은 끝나면 원래대로 돌려놓는다.

    반환: (읽은 이름들, 카카오톡이 표시한 친구 수, 목록 끝까지 다 읽었는지)
    """
    if not config.get("serial") or not config.get("hardware_id") or not config.get("account"):
        raise Blocked("device_not_bound")
    device = Adb({"adb": adb_path(), "serial": config["serial"], "hardware_id": config["hardware_id"], "account": config["account"]})
    device.connect_transport()
    if not device.accessibility_enabled():
        raise Blocked("accessibility_disabled")
    cursor = ""
    entries: list = []
    expected = 0
    complete = False
    try:
        for _ in range(200):
            payload = {"action": "onboard_friends", "recent": True}
            if cursor:
                payload["cursor"] = cursor
            data = device.fast_broadcast(payload, timeout=25)
            state = data.get("state")
            if state == "verified":
                entries = data.get("entries") or []
                expected = int(data.get("expected_count") or 0)
                complete = True
                break
            if state != "partial" or not isinstance(data.get("cursor"), str) or not data["cursor"]:
                error = data.get("error") or "friend_onboarding_invalid"
                if error == "friend_count_mismatch":
                    error = f"friend_count_mismatch:{data.get('count')}/{data.get('expected_count')}"
                raise Blocked(error)
            cursor = data["cursor"]
            entries = data.get("entries") or entries
            expected = int(data.get("expected_count") or expected)
            names = [str(e.get("name") or "").strip() for e in entries]
            if len(names) >= stop_after and all(n in known for n in names[-stop_after:]):
                break
        else:
            raise Blocked("friend_onboarding_incomplete")
    finally:
        try:
            device.fast_broadcast({"action": "friends_done"}, timeout=90)  # 정렬 복구 + 메인 화면 복귀
        except Exception:
            pass
    names = [str(e.get("name") or "").strip() for e in entries if str(e.get("name") or "").strip()]
    return names, expected, complete


def read_room_history(config: dict, name: str, since: str) -> tuple[list[dict], int]:
    """1:1 채팅방을 위로 스크롤하며 since(YYYY-MM-DD)부터 현재까지의 말풍선을 읽는다(읽기 전용).

    반환: ([{side:'me'|'them', text, date}], 읽은 화면 수). 아무것도 입력·전송하지 않는다.
    """
    if not config.get("serial") or not config.get("hardware_id") or not config.get("account"):
        raise Blocked("device_not_bound")
    device = Adb({"adb": adb_path(), "serial": config["serial"], "hardware_id": config["hardware_id"], "account": config["account"]})
    device.connect_transport()
    if not device.accessibility_enabled():
        raise Blocked("accessibility_disabled")
    cursor = ""
    try:
        for _ in range(120):
            payload = {"action": "room_history", "name": name, "since": since}
            if cursor:
                payload["cursor"] = cursor
            data = device.fast_broadcast(payload, timeout=60)
            state = data.get("state")
            if state == "verified":
                return list(data.get("messages") or []), int(data.get("pages") or 0)
            if state != "partial" or not isinstance(data.get("cursor"), str) or not data["cursor"]:
                raise Blocked(data.get("error") or "history_failed")
            cursor = data["cursor"]
        raise Blocked("history_scan_limit")
    finally:
        try:
            device.fast_broadcast({"action": "finish_send", "hold": True})  # 방에서 나온다(화면은 잠그지 않음)
        except Exception:
            pass
        device.restore_keyboard()


def send(config: dict, name: str, text: str, dry_run: bool = False, tail=None) -> dict:
    """친구 이름으로 1:1 채팅방에 텍스트를 보낸다. config: serial/hardware_id/account."""
    if not config.get("serial") or not config.get("hardware_id") or not config.get("account"):
        raise Blocked("device_not_bound")
    name = (name or "").strip()
    if not name or not (text or "").strip():
        raise Blocked("empty_message")
    device = Adb({"adb": adb_path(), "serial": config["serial"], "hardware_id": config["hardware_id"], "account": config["account"]})
    try:
        device.connect_transport()  # 하드웨어 ID도 함께 확인한다
        # 채팅방 재진입/스크롤 없이 한 번에: 친구 → 1:1 채팅 → 입력 → 전송. 제목은 폰에서 확인한다.
        room = {"name": name, "locator": {"kind": "friend"}}
        # hold=True: 방에서 나오되 화면은 잠그지 않는다.
        return device.send_fast(room, text, dry_run=dry_run, hold=True, tail=tail)
    except Exception as exc:
        if device.send_attempted:
            raise SendUncertain("전송 결과 불확실") from exc
        raise
    finally:
        try:
            device.fast_broadcast({"action": "finish_send", "hold": True})
        except Exception:
            pass
        device.restore_keyboard()


def short_account(value: str) -> str:
    return value[:8] if re.fullmatch(r"[0-9a-f]{64}", value or "") else (value or "")[:8]
