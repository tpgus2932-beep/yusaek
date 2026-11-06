"""휴대폰(ADB + 접근성 브리지 앱)으로 카카오톡 1:1 메시지를 보내는 어댑터.

- 폰 한 대를 여러 사람이 쓰므로 호출하는 쪽(kakao_routes)이 반드시 한 번에 한 건씩만 부른다.
- 전송 버튼을 누른 뒤의 실패는 SendUncertain으로 올린다. 자동 재시도 금지 — 폰에서 직접 확인해야 한다.
- 계정(account)은 연결 시 한 번만 확인하고, 전송마다는 폰 하드웨어 ID만 다시 본다(화면 이동 없음).
"""
from __future__ import annotations

import os
import pathlib
import re
import time

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
    "kakao_id_not_found": "해당 카카오톡 ID를 찾지 못했습니다. ID가 없거나 ID 검색을 허용하지 않은 계정입니다.",
    "share_sheet_unavailable": "카카오톡 공유 화면을 열지 못했습니다. 폰 잠금을 풀고 카카오톡이 로그인된 상태인지 확인하세요.",
    "share_target_not_found": "공유 화면에서 정확히 같은 이름의 친구를 찾지 못해 사진을 보내지 않았습니다.",
    "share_target_ambiguous": "공유 화면에 같은 이름의 친구가 여러 명이라 사진을 보내지 않았습니다.",
    "share_select_failed": "공유 화면에서 받는 사람을 선택하지 못했습니다.",
    "share_select_unverified": "받는 사람이 선택됐는지 확인하지 못해 사진을 보내지 않았습니다.",
    "share_recipient_mismatch": "공유 화면에서 선택된 받는 사람이 다릅니다. 사진을 보내지 않았습니다.",
    "share_submit_unavailable": "공유 화면의 '1 보내기' 버튼을 찾지 못해 사진을 보내지 않았습니다.",
    "media_count_invalid": "사진은 한 번에 1~10장까지 보낼 수 있습니다.",
    "media_file_missing": "서버에 저장된 사진 파일을 찾지 못했습니다. 다시 업로드하세요.",
    "media_transfer_integrity_failed": "폰으로 사진을 옮기는 중 파일이 깨져서 보내지 않았습니다.",
    "media_share_helper_required": "폰의 브리지 앱이 최신이 아닙니다. 다시 설치하세요.",
    "send_result_unverified": "사진을 보냈는지 확인하지 못했습니다. 폰의 대화방을 확인하세요.",
    "rename_input_invalid": "새 이름은 현재 이름과 달라야 하고 20자 이내여야 합니다.",
    "rename_menu_unavailable": "카카오톡의 '친구 설정' 화면으로 이동하지 못했습니다. 폰 잠금을 풀고 다시 시도하세요.",
    "rename_wrong_friend": "폰에 보이는 친구 이름이 다릅니다. 이름을 바꾸지 않았습니다.",
    "rename_input_failed": "새 이름 입력을 확인하지 못해 저장하지 않았습니다.",
    "rename_save_unavailable": "이름 저장('확인') 버튼을 누르지 못했습니다. 이름을 바꾸지 않았습니다.",
    "rename_unverified": "저장했지만 새 이름으로 친구를 찾지 못했습니다. 폰에서 이름이 바뀌었는지 확인한 뒤 '폰에서 동기화'를 누르세요.",
    "contact_input_invalid": "이름(20자 이내)과 전화번호(예: 010-1234-5678) 또는 카카오톡 ID(영문·숫자·._-)를 확인하세요.",
    "contact_add_entry_unavailable": "카카오톡의 '친구 추가' 버튼을 찾지 못했습니다. 폰 잠금을 풀어 주세요.",
    "contact_permission_needed": "폰에 권한 팝업(연락처 접근 등)이 떠 있습니다. 폰에서 허용한 뒤 다시 시도하세요.",
    "contact_add_form_unavailable": "카카오톡의 '연락처로 추가' 화면을 열지 못했습니다.",
    "contact_input_unverified": "이름·전화번호 입력을 확인하지 못했습니다.",
    "contact_submit_unavailable": "추가 화면의 '확인' 버튼을 찾지 못했습니다.",
    "contact_add_unverified": "추가했지만 친구로 확인하지 못했습니다. 카카오톡 가입자가 아닌 번호이거나 확인에 실패한 것입니다. 폰의 친구 목록을 확인하세요.",
    "korean_input_helper_required": "폰에 한글 입력 도우미(YUSAEK ADB Input 키보드)가 설치되어 있지 않습니다. 브리지 앱을 다시 설치하세요.",
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


def normalize_phone(raw: str) -> str:
    """숫자만 남긴다. +82 10… → 8210…, 010-1234-5678 → 01012345678. 올바르지 않으면 빈 문자열."""
    digits = re.sub(r"\D", "", raw or "")
    return digits if re.fullmatch(r"(?:0[0-9]{8,10}|82[0-9]{8,10})", digits) else ""


def add_friend(config: dict, name: str, phone: str) -> dict:
    """폰의 카카오톡에 (이름, 전화번호)로 친구를 추가한다: 친구 탭 → 친구 추가 → 연락처 → 입력 → 확인.

    추가 후 친구 프로필이 열리면 verified. 확인 버튼을 누른 뒤 프로필을 확인하지 못하면
    contact_add_unverified — 폰에서 직접 확인해야 하며 자동으로 다시 시도하지 않는다.
    전화번호는 폰으로 넘기기만 하고 어디에도 저장·기록하지 않는다.
    """
    if not config.get("serial") or not config.get("hardware_id") or not config.get("account"):
        raise Blocked("device_not_bound")
    name = (name or "").strip()
    number = normalize_phone(phone)
    if not name or len(name) > 20 or not number:
        raise Blocked("contact_input_invalid")
    device = Adb({"adb": adb_path(), "serial": config["serial"], "hardware_id": config["hardware_id"], "account": config["account"]})
    try:
        device.connect_transport()
        return device.add_contact_fast(name, number)
    finally:
        device.restore_keyboard()


def normalize_kakao_id(raw: str) -> str:
    """카카오톡 ID(영문·숫자·._-, 1~20자). 올바르지 않으면 빈 문자열."""
    value = (raw or "").strip()
    return value if re.fullmatch(r"[A-Za-z0-9._-]{1,20}", value) else ""


def add_friend_by_id(config: dict, kakao_id: str, dry_run: bool = False) -> dict:
    """카카오톡 ID로 친구를 추가한다: 친구 추가 → 카카오톡 ID → 입력 → 확인(검색) → '친구 추가'.

    반환: {state:'verified'|'ready', name:<프로필 닉네임>, already_friend:bool}.
    dry_run이면 검색까지만 하고 추가하지 않는다(ready). 차단 버튼은 절대 누르지 않는다.
    """
    if not config.get("serial") or not config.get("hardware_id") or not config.get("account"):
        raise Blocked("device_not_bound")
    value = normalize_kakao_id(kakao_id)
    if not value:
        raise Blocked("contact_input_invalid")
    device = Adb({"adb": adb_path(), "serial": config["serial"], "hardware_id": config["hardware_id"], "account": config["account"]})
    try:
        device.connect_transport()
        return device.add_by_id_fast(value, dry_run=dry_run)
    finally:
        device.restore_keyboard()


def rename_friend(config: dict, old: str, new: str, dry_run: bool = False) -> dict:
    """폰의 카카오톡에서 친구 이름을 바꾼다: 프로필 → ⋮ → 친구 설정 → 이름 → 입력 → 확인.

    카카오톡의 '친구 설정' 이름은 내 폰에서만 보이는 이름이다(상대 계정은 바뀌지 않는다).
    저장 후 새 이름으로 친구를 찾을 수 있어야 verified. 저장 뒤 확인 실패는 rename_unverified —
    바뀌었는지 모르므로 폰에서 확인해야 하며 자동으로 다시 시도하지 않는다.
    """
    if not config.get("serial") or not config.get("hardware_id") or not config.get("account"):
        raise Blocked("device_not_bound")
    old, new = (old or "").strip(), (new or "").strip()
    if not old or not new or len(new) > 20 or old == new:
        raise Blocked("rename_input_invalid")
    device = Adb({"adb": adb_path(), "serial": config["serial"], "hardware_id": config["hardware_id"], "account": config["account"]})
    device.connect_transport()
    return device.rename_friend_fast(old, new, dry_run=dry_run)


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


MAX_IMAGES = 10  # 카카오톡은 사진 여러 장을 한 말풍선(앨범)으로 묶는다. 10장을 넘기면 말풍선이 나뉜다.


def _peek_key(items) -> list:
    return [(i.get("side"), i.get("text")) for i in items or []]


def send_images(config: dict, name: str, files: list, tail=None, keep_room: bool = False) -> dict:
    """사진 1~10장을 카카오톡 '공유'로 1:1 친구에게 보낸다.

    files: [{id(uuid), name, mime, bytes, sha256, path}]. 순서:
      ① 채팅방에 들어가 최근 말풍선을 읽고 웹 대화와 비교(다르면 sync_needed로 멈춤)
      ② 사진을 폰에 올리고(해시 검증) 카카오톡 공유 화면을 연다
      ③ 공유 화면에서 정확히 같은 이름의 1:1 친구 한 명만 골라 '1 보내기'
      ④ 다시 채팅방을 읽어 내 사진 말풍선이 새로 생겼는지 확인
    '보내기'를 누른 뒤의 실패·불확실은 SendUncertain — 자동 재시도 금지.
    """
    if not config.get("serial") or not config.get("hardware_id") or not config.get("account"):
        raise Blocked("device_not_bound")
    if not 1 <= len(files) <= MAX_IMAGES:
        raise Blocked("media_count_invalid")
    device = Adb({"adb": adb_path(), "serial": config["serial"], "hardware_id": config["hardware_id"], "account": config["account"]})
    staged: list = []
    completed = False
    root = "/sdcard/Android/data/com.yusaek.talkbridge/files/outgoing/"
    try:
        device.connect_transport()
        if not device.accessibility_enabled():
            raise Blocked("accessibility_disabled")
        peek_payload = {"action": "room_peek", "name": name}
        if tail is not None:
            peek_payload["tail"] = tail
        peek = device.fast_broadcast(peek_payload, timeout=60)
        if peek.get("state") == "sync_needed":
            return {"state": "sync_needed", "recent": peek.get("recent")}
        if peek.get("state") != "verified":
            raise Blocked(peek.get("error") or "not_in_room")
        before = peek.get("recent") or []
        for f in files:
            import pathlib
            path = pathlib.Path(f["path"])
            if not path.is_file():
                raise Blocked("media_file_missing")
            folder = root + f["id"]
            device.run("shell", "mkdir", "-p", folder)
            device.run("push", str(path), folder + "/data", timeout=90)
            staged.append(folder)
            remote = device.run("shell", "sha256sum", folder + "/data").split()
            if not remote or remote[0] != f["sha256"]:
                raise Blocked("media_transfer_integrity_failed")
        items = [{k: f[k] for k in ("id", "name", "mime", "bytes", "sha256")} for f in files]
        import base64, json
        encoded = base64.b64encode(json.dumps(items, ensure_ascii=False).encode()).decode()
        key, value = ("item", base64.b64encode(json.dumps(items[0], ensure_ascii=False).encode()).decode()) if len(items) == 1 else ("items", encoded)
        reply = device.run("shell", "am", "start", "-n", "com.yusaek.talkbridge/.ShareActivity", "--es", key, value)
        if "Error" in reply:
            raise Blocked("media_share_helper_required")
        time.sleep(0.6)
        res = device.fast_broadcast({"action": "share_pick", "name": name}, timeout=80)
        if res.get("send_attempted"):
            device.send_attempted = True
        if res.get("state") != "verified":
            raise Blocked(res.get("error") or "send_result_unverified")
        # ④ 확인: 방을 다시 읽어 내 사진 말풍선이 새로 생겼는지
        after = (device.fast_broadcast({"action": "room_peek", "name": name}, timeout=60).get("recent")) or []
        newest = after[-1] if after else {}
        if not (newest.get("side") == "me" and newest.get("text") == "(사진)" and _peek_key(after) != _peek_key(before)):
            raise Blocked("send_result_unverified")
        completed = True
        return {"state": "verified", "recent": before}
    except Exception as exc:
        if device.send_attempted:
            raise SendUncertain("전송 결과 불확실") from exc
        raise
    finally:
        for folder in staged:
            try:
                device.run("shell", "rm", "-rf", folder)
            except Exception:
                pass
        if not (keep_room and completed):  # 묶음의 마지막이거나 실패했으면 방을 나온다
            try:
                device.fast_broadcast({"action": "finish_send", "hold": True})
            except Exception:
                pass


def send(config: dict, name: str, text: str, dry_run: bool = False, tail=None, keep_room: bool = False) -> dict:
    """친구 이름으로 1:1 채팅방에 텍스트를 보낸다. config: serial/hardware_id/account."""
    if not config.get("serial") or not config.get("hardware_id") or not config.get("account"):
        raise Blocked("device_not_bound")
    name = (name or "").strip()
    if not name or not (text or "").strip():
        raise Blocked("empty_message")
    device = Adb({"adb": adb_path(), "serial": config["serial"], "hardware_id": config["hardware_id"], "account": config["account"]})
    done = False
    try:
        device.connect_transport()  # 하드웨어 ID도 함께 확인한다
        # 채팅방 재진입/스크롤 없이 한 번에: 친구 → 1:1 채팅 → 입력 → 전송. 제목은 폰에서 확인한다.
        room = {"name": name, "locator": {"kind": "friend"}}
        # hold=True: 화면은 잠그지 않는다. keep_room=True: 다음 메시지가 같은 사람이면 방도 나오지 않는다.
        result = device.send_fast(room, text, dry_run=dry_run, hold=True, tail=tail, keep_room=keep_room and not dry_run)
        done = result.get("state") == "verified"
        return result
    except Exception as exc:
        if device.send_attempted:
            raise SendUncertain("전송 결과 불확실") from exc
        raise
    finally:
        if not (keep_room and done):  # 묶음의 마지막이거나 실패했으면 방을 나온다
            try:
                device.fast_broadcast({"action": "finish_send", "hold": True})
            except Exception:
                pass
        device.restore_keyboard()

def short_account(value: str) -> str:
    return value[:8] if re.fullmatch(r"[0-9a-f]{64}", value or "") else (value or "")[:8]
