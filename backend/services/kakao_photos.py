"""카카오톡 대화방의 사진을 폰에서 가져온다 (사진 뷰어를 넘기며 '저장' → 파일 가져오기).

사진 뷰어는 사진마다 정확한 시각("대화보기, 2026년 11월 11일 오후 5:11")과 보낸 사람 이름을 접근성으로 보여 준다.
뷰어에서 '저장'을 누르면 /sdcard/Pictures/KakaoTalk/<밀리초>.jpg 가 새로 생기므로, 새 파일을 가져오면 그 사진 하나다.
가져온 뒤에는 폰 갤러리가 어지러워지지 않게 우리가 만든 그 파일을 지운다.

안전 원칙: 누르는 것은 '저장' 버튼(id=btn_save)과 사진 말풍선, 뒤로가기뿐이다. 삭제·공유·편집 버튼은 절대 누르지 않는다.
"""
from __future__ import annotations

import hashlib
import pathlib
import re
import tempfile
import time

from services.kakao_phone import Adb, Blocked, _connect, adb_path

_PICTURES = "/sdcard/Pictures/KakaoTalk"
_TS = re.compile(r"(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일\s*(오전|오후)\s*(\d{1,2}):(\d{2})")
MAX_PHOTOS = 60          # 한 번에 가져올 최대 사진 수 (너무 오래 걸리지 않게)
MAX_SECONDS = 420        # 전체 제한 시간


def _parse_ts(text: str):
    m = _TS.search(text or "")
    if not m:
        return None
    y, mo, d, ap, h, mi = int(m[1]), int(m[2]), int(m[3]), m[4], int(m[5]), int(m[6])
    if ap == "오후" and h < 12:
        h += 12
    if ap == "오전" and h == 12:
        h = 0
    return f"{y:04d}-{mo:02d}-{d:02d} {h:02d}:{mi:02d}"


def _center(bounds: str):
    l, t, r, b = [int(x) for x in bounds.split(",")]
    return (l + r) // 2, (t + b) // 2


def _nodes(dev: Adb) -> list[dict]:
    return dev.fast_broadcast({"action": "dump_tree"}, timeout=40).get("nodes") or []


def _by_id(nodes, suffix):
    return [n for n in nodes if str(n.get("id", "")).endswith(suffix)]


def _viewer_state(nodes):
    """뷰어가 열려 있으면 (시각, 보낸 사람, 저장 버튼 중심) 을, 아니면 None 을 돌려준다."""
    save = [n for n in _by_id(nodes, "btn_save") if n.get("desc") == "저장" and n.get("b")]
    sub = _by_id(nodes, "toolbar_sub_title_text")
    if not save or not sub:
        return None
    title = _by_id(nodes, "toolbar_default_title_text")
    return {
        "ts": _parse_ts(sub[0].get("desc") or sub[0].get("text") or ""),
        "sender": ((title[0].get("text") or title[0].get("desc")) if title else "") or "",
        "save": _center(save[0]["b"]),
    }


def _ls(dev: Adb) -> set[str]:
    return {x.strip() for x in dev.run("shell", "ls", _PICTURES).splitlines() if x.strip()}


def _save_current(dev: Adb, state: dict, out_dir: pathlib.Path):
    """뷰어의 '저장'을 눌러 새로 생긴 파일을 가져온다. 반환: 로컬 경로 또는 None."""
    before = _ls(dev)
    x, y = state["save"]
    dev.run("shell", "input", "tap", str(x), str(y))
    deadline = time.time() + 8
    new = None
    while time.time() < deadline:
        time.sleep(0.5)
        gone = _ls(dev) - before
        if gone:
            new = sorted(gone)[-1]
            break
    if not new:
        return None
    time.sleep(0.4)  # 파일 쓰기가 끝나길 잠깐 기다린다
    local = out_dir / new
    dev.run("pull", f"{_PICTURES}/{new}", str(local), timeout=60)
    try:
        dev.run("shell", "rm", f"{_PICTURES}/{new}")   # 우리가 만든 파일만 지운다 (갤러리 정리)
    except Exception:
        pass
    return local if local.is_file() and local.stat().st_size > 0 else None


def import_room_photos(config: dict, name: str, since: str, group: bool = False, limit: int = MAX_PHOTOS):
    """방의 사진을 최신 → 과거 순으로 since(YYYY-MM-DD) 까지 가져온다.

    반환: [{ts: 'YYYY-MM-DD HH:MM', sender, path, sha256, bytes}] (오래된 것부터 정렬)
    사진을 못 찾으면 빈 목록. 중간에 막히면 거기까지 가져온 것만 돌려준다.
    """
    if not config.get("serial") or not config.get("hardware_id") or not config.get("account"):
        raise Blocked("device_not_bound")
    dev = Adb({"adb": adb_path(), "serial": config["serial"], "hardware_id": config["hardware_id"], "account": config["account"]})
    _connect(dev, config["serial"])
    if not dev.accessibility_enabled():
        raise Blocked("accessibility_disabled")
    out_dir = pathlib.Path(tempfile.mkdtemp(prefix="kakao_photos_"))
    started = time.time()
    results: list[dict] = []
    try:
        peek = {"action": "room_peek", "name": name}
        if group:
            peek["group"] = True
        res = dev.fast_broadcast(peek, timeout=60)
        if res.get("state") != "verified":
            raise Blocked(res.get("error") or "not_in_room")

        # 1) 가장 아래쪽(최신) 사진 말풍선을 찾는다. 공지 이미지(맨 위)와 작은 이미지는 제외한다.
        opened = False
        for _ in range(8):
            nodes = _nodes(dev)
            pics = []
            for n in _by_id(nodes, ":id/image"):
                if n.get("desc") != "사진" or not n.get("b"):
                    continue
                l, t, r, b = [int(v) for v in n["b"].split(",")]
                if t >= 420 and (r - l) >= 200:
                    pics.append((b, n))
            if pics:
                x, y = _center(sorted(pics, key=lambda p: p[0])[-1][1]["b"])
                dev.run("shell", "input", "tap", str(x), str(y))
                time.sleep(1.8)
                if _viewer_state(_nodes(dev)):
                    opened = True
                break
            dev.run("shell", "input", "swipe", "540", "900", "540", "1700", "300")   # 위로 스크롤(더 오래된 대화)
            time.sleep(0.8)
        if not opened:
            return []

        # 2) 가장 최신 사진까지 왼쪽으로 넘긴다 (더 이상 안 바뀔 때까지)
        last = None
        for _ in range(60):
            st = _viewer_state(_nodes(dev))
            if not st:
                raise Blocked("viewer_lost")
            key = (st["ts"], st["sender"])
            if key == last:
                break
            last = key
            dev.run("shell", "input", "swipe", "900", "1200", "250", "1200", "250")
            time.sleep(0.9)

        # 3) 최신 → 과거로 저장하며 넘어간다
        prev_hash = None
        while len(results) < limit and time.time() - started < MAX_SECONDS:
            st = _viewer_state(_nodes(dev))
            if not st or not st["ts"]:
                break
            if st["ts"][:10] < since:
                break
            path = _save_current(dev, st, out_dir)
            if not path:
                break
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            if digest == prev_hash:
                break               # 더 이상 넘어가지 않았다 (맨 처음 사진까지 읽음)
            prev_hash = digest
            results.append({"ts": st["ts"], "sender": st["sender"], "path": str(path), "sha256": digest, "bytes": path.stat().st_size})
            dev.run("shell", "input", "swipe", "250", "1200", "900", "1200", "250")
            time.sleep(1.0)
        results.reverse()   # 오래된 것부터
        return results
    finally:
        try:
            dev.run("shell", "input", "keyevent", "KEYCODE_BACK")     # 뷰어 닫기
            time.sleep(0.6)
            dev.fast_broadcast({"action": "finish_send", "hold": True})   # 방에서 나온다
        except Exception:
            pass
