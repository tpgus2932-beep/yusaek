from __future__ import annotations

import difflib
import hashlib
import json
import pathlib
import re
import threading
import time
import uuid
from datetime import datetime, timedelta

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request
from fastapi.responses import FileResponse

from services import kakao_phone
from services.kakao_store import get_setting, init_kakao_tables, now_iso, set_settings

_MAX_TEXT = 2000
_MAX_NAME = 60

# 상태: queued(대기) → sending(전송 중) → sent(보냄) | failed(보내기 전 실패, 재전송 가능)
#       | needs_check(전송 버튼을 누른 뒤 불확실 — 사람이 폰에서 확인) | tested(전송 없이 테스트 성공)


_MEDIA_DIR = pathlib.Path(__file__).resolve().parent.parent / "kakao_media"
_MAX_IMAGE_BYTES = 20 * 1024 * 1024
_MAX_IMAGES = 10
_MAX_BULK_RECIPIENTS = 500
_MAX_LIST_NAME = 30
_QUEUE_ORDER = "CASE WHEN batch_id IS NULL THEN 0 ELSE 1 END, id"  # 일반 메시지가 일괄 전송보다 먼저 나간다
_BATCH_GRACE_SEC = 0.0  # 같은 사람에게 연달아 오는 요청이 한 묶음이 되도록 큐가 잠깐 기다리는 시간


def _sniff_image(data: bytes):
    """내용으로 이미지 종류를 판별한다(확장자·클라이언트가 준 형식은 믿지 않는다). (mime, 확장자) 또는 None."""
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg", "jpg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png", "png"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif", "gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp", "webp"
    return None


def _safe_name(raw: str, ext: str) -> str:
    stem = re.sub(r"[\\/\x00-\x1f]", "_", (raw or "").strip())[:100]
    stem = re.sub(r"\.[A-Za-z0-9]{1,5}$", "", stem).strip(". ") or "image"
    return f"{stem}.{ext}"


def _key(text: str) -> str:
    """메시지 비교 키: 공백을 하나로 줄이고 앞 40자(UTF-16 단위)만 쓴다.
    긴 말풍선은 폰에서 잘려 보이므로 앞부분만 비교한다. 폰 앱의 msgKey()와 같아야 한다."""
    collapsed = re.sub(r"\s+", " ", (text or "").strip())
    return collapsed.encode("utf-16-le")[:80].decode("utf-16-le", errors="ignore")


def build_kakao_router(*, get_current_user, get_db, get_user_display):
    router = APIRouter(prefix="/kakao")
    init_kakao_tables(get_db)

    state = {"paused": False, "pause_reason": "", "busy": False, "thread": None, "syncing": False}
    sync = {"running": False, "startedAt": "", "finishedAt": "", "result": None, "error": ""}
    room_sync = {"running": False, "contactId": 0, "since": "", "startedAt": "", "finishedAt": "", "result": None, "error": ""}
    add_friend = {"running": False, "name": "", "startedAt": "", "finishedAt": "", "result": None, "error": ""}
    resynced: set = set()  # 대화를 가져온 뒤 다시 보내는 작업 — 같은 작업은 한 번만 재확인한다
    wake = threading.Event()
    start_lock = threading.Lock()
    phone_lock = threading.Lock()  # 폰은 한 번에 하나의 작업만

    # 서버가 전송 도중 꺼졌다면 결과를 알 수 없다 — 자동으로 다시 보내지 않고 사람이 확인하게 한다.
    conn = get_db()
    conn.execute(
        "UPDATE kakao_messages SET status = 'needs_check', updated_at = ?, "
        "error = '서버가 다시 시작되어 전송 결과를 알 수 없습니다. 폰에서 확인하세요.' WHERE status = 'sending'",
        (now_iso(),),
    )
    conn.commit()
    conn.close()

    # ---- helpers -----------------------------------------------------
    def _device_config() -> dict:
        return {
            "serial": get_setting(get_db, "serial"),
            "hardware_id": get_setting(get_db, "hardware_id"),
            "account": get_setting(get_db, "account"),
        }

    def _row_to_message(row) -> dict:
        return {
            "id": row["id"],
            "contactId": row["contact_id"],
            "text": row["text"],
            "status": row["status"],
            "error": row["error"],
            "dryRun": bool(row["dry_run"]),
            "direction": row["direction"],
            "origin": row["origin"],
            "timeKnown": bool(row["time_known"]),
            "kind": row["kind"],
            "batchId": row["batch_id"],
            "mediaIds": [m for m in (row["media_ids"] or "").split(",") if m],
            "requestedBy": row["requested_by"],
            "requestedByDisplay": get_user_display(row["requested_by"]) or row["requested_by"],
            "createdAt": row["created_at"],
            "sentAt": row["sent_at"],
        }

    def _set_status(message_id: int, status: str, error: str = "", sent: bool = False) -> None:
        conn = get_db()
        conn.execute(
            "UPDATE kakao_messages SET status = ?, error = ?, updated_at = ?, sent_at = CASE WHEN ? THEN ? ELSE sent_at END WHERE id = ?",
            (status, error, now_iso(), 1 if sent else 0, now_iso(), message_id),
        )
        conn.commit()
        conn.close()

    def _claim_next():
        conn = get_db()
        row = conn.execute(
            "SELECT m.id, m.contact_id, m.created_at, m.text, m.dry_run, m.kind, m.media_ids, m.batch_id, b.interval_sec, c.name "
            "FROM kakao_messages m JOIN kakao_contacts c ON c.id = m.contact_id LEFT JOIN kakao_batches b ON b.id = m.batch_id "
            "WHERE m.status = 'queued' ORDER BY CASE WHEN m.batch_id IS NULL THEN 0 ELSE 1 END, m.id ASC LIMIT 1"
        ).fetchone()
        if not row:
            conn.close()
            return None
        cur = conn.execute(
            "UPDATE kakao_messages SET status = 'sending', updated_at = ? WHERE id = ? AND status = 'queued'",
            (now_iso(), row["id"]),
        )
        conn.commit()
        conn.close()
        return dict(row) if cur.rowcount else None

    def _pause(reason: str) -> None:
        state["paused"] = True
        state["pause_reason"] = reason

    def _tail_entries(conn, cid: int, exclude_id: int, limit: int = 20) -> list:
        """웹 대화의 끝부분(전송 완료·수신) — 오래된 것부터 [(side, text)]."""
        rows = conn.execute(
            "SELECT direction, text FROM kakao_messages WHERE contact_id = ? AND dry_run = 0 AND id <> ? "
            "AND status IN ('sent', 'received') ORDER BY COALESCE(sort_no, id) DESC LIMIT ?",
            (cid, exclude_id, limit),
        ).fetchall()
        return [("me" if r["direction"] == "out" else "them", r["text"]) for r in reversed(rows)]

    def _db_tail_payload(job: dict):
        """폰에 보낼 비교용 끝부분. 연락처를 못 찾으면 None(비교 생략)."""
        conn = get_db()
        try:
            contact = conn.execute("SELECT id FROM kakao_contacts WHERE name = ?", (job["name"],)).fetchone()
            if not contact:
                return None
            return [{"side": side, "key": _key(text)} for side, text in _tail_entries(conn, contact["id"], job["id"])]
        finally:
            conn.close()

    def _sync_recent(job: dict, recent) -> int:
        """폰 대화방에서 읽은 최근 말풍선(최대 3개)을 웹 대화와 맞춘다. 가져온 개수를 돌려준다.

        폰의 말풍선이 웹 끝부분 안에 그대로 들어 있으면 이미 맞은 것이다. 아니면 웹 끝부분과 이어지는
        최대 길이만큼은 같은 대화로 보고 그 뒤의 것만 넣는다. 폰은 분 단위 시각을 알려주지 않으므로
        time_known=0으로 저장한다.
        """
        items = []
        for entry in recent or []:
            side = entry.get("side")
            text = str(entry.get("text") or "").strip()[:_MAX_TEXT]
            if side in ("me", "them") and text:
                items.append({"side": side, "text": text, "date": str(entry.get("date") or "")})
        if not items:
            return 0
        conn = get_db()
        try:
            contact = conn.execute("SELECT id FROM kakao_contacts WHERE name = ?", (job["name"],)).fetchone()
            if not contact:
                return 0
            cid = contact["id"]
            tail = [(side, _key(text)) for side, text in _tail_entries(conn, cid, job["id"])]
            phone = [(i["side"], _key(i["text"])) for i in items]
            n = len(phone)
            if any(tail[i:i + n] == phone for i in range(0, len(tail) - n + 1)):
                return 0  # 이미 맞음
            overlap = 0
            for k in range(min(n, len(tail)), 0, -1):
                if phone[:k] == tail[-k:]:
                    overlap = k
                    break
            return _insert_phone_messages(conn, cid, items[overlap:], before_key=job["id"] - 0.5, spread=0.01)
        finally:
            conn.close()

    def _insert_phone_messages(conn, cid: int, items: list, *, before_key: float, spread: float) -> int:
        """폰에서 가져온 메시지를 저장한다. before_key부터 spread 간격으로 정렬값을 줘서 원하는 자리에 끼운다."""
        added = 0
        stamp = now_iso()
        for index, item in enumerate(items):
            if item["side"] == "me":
                # 불확실하게 끝났던 내 메시지가 폰에 보이면 '보냄'으로 확정한다
                cur = conn.execute(
                    "UPDATE kakao_messages SET status = 'sent', error = '', updated_at = ?, sent_at = ? WHERE id = ("
                    "SELECT id FROM kakao_messages WHERE contact_id = ? AND text = ? AND status = 'needs_check' ORDER BY id DESC LIMIT 1)",
                    (stamp, stamp, cid, item["text"]),
                )
                if cur.rowcount:
                    continue
            day = item["date"]
            created = f"{day}T00:00:00+09:00" if day else stamp
            conn.execute(
                "INSERT INTO kakao_messages (contact_id, text, status, dry_run, requested_by, created_at, updated_at, sent_at, "
                "direction, origin, time_known, sort_no) VALUES (?, ?, ?, 0, '', ?, ?, ?, ?, 'phone', 0, ?)",
                (
                    cid, item["text"], "sent" if item["side"] == "me" else "received", created, stamp,
                    created if item["side"] == "me" else "", "out" if item["side"] == "me" else "in",
                    before_key + spread * index,
                ),
            )
            added += 1
        conn.commit()
        return added

    def _next_is_same_contact(job: dict) -> bool:
        """다음 대기 건이 같은 사람에게 가는 것이면 방을 열어 둔 채로 이어서 보낸다."""
        conn = get_db()
        try:
            row = conn.execute(
                f"SELECT contact_id, dry_run FROM kakao_messages WHERE status = 'queued' AND id <> ? ORDER BY {_QUEUE_ORDER} LIMIT 1",
                (job["id"],),
            ).fetchone()
        finally:
            conn.close()
        return bool(row) and row["contact_id"] == job["contact_id"] and not row["dry_run"]

    def _process(job: dict) -> None:
        config = _device_config()
        # 앱은 실제 전송 뒤에 항상 방을 유지한다. 나올지는 전송이 끝난 뒤에 정한다(아래) — 전송하는 동안
        # 들어온 같은 사람의 다음 메시지까지 한 묶음으로 잡기 위해서다.
        keep = not job["dry_run"]
        try:
            # 대화방에 들어가 최근 대화를 읽은 뒤, 웹과 다르면 입력하기 전에 멈추고(sync_needed) 가져와서 다시 보낸다.
            tail = None if job["id"] in resynced else _db_tail_payload(job)
            with phone_lock:
                if job.get("kind") == "image":
                    files = _load_media(job.get("media_ids") or "")
                    result = kakao_phone.send_images(config, job["name"], files, tail=tail, keep_room=keep) or {}
                else:
                    result = kakao_phone.send(config, job["name"], job["text"], dry_run=bool(job["dry_run"]), tail=tail, keep_room=keep) or {}
            if result.get("state") == "sync_needed":
                imported = 0
                try:
                    imported = _sync_recent(job, result.get("recent"))
                except Exception:  # noqa: BLE001
                    pass
                resynced.add(job["id"])
                _set_status(job["id"], "queued", f"폰 대화방의 새 대화 {imported}개를 가져왔습니다. 곧 다시 전송합니다.")
                return
            try:
                _sync_recent(job, result.get("recent"))
            except Exception:  # noqa: BLE001 — 대화 맞추기가 실패해도 전송 결과는 그대로 기록한다
                pass
            resynced.discard(job["id"])
            if not job["dry_run"] and not _next_is_same_contact(job):
                kakao_phone.leave_room(config)   # 묶음의 마지막: 방에서 나온다
            _set_status(job["id"], "tested" if job["dry_run"] else "sent", sent=not job["dry_run"])
        except kakao_phone.SendUncertain:
            _set_status(job["id"], "needs_check", "전송 버튼을 누른 뒤 결과를 확인하지 못했습니다. 폰에서 확인하세요. 자동으로 다시 보내지 않습니다.")
            _pause("전송 결과가 불확실한 메시지가 있어 큐를 멈췄습니다. 폰에서 확인한 뒤 처리하고 재개하세요.")
        except Exception as exc:  # noqa: BLE001
            code = kakao_phone.error_code(exc)
            _set_status(job["id"], "failed", kakao_phone.describe_error(code))
            if code in kakao_phone.FATAL_ERRORS:
                _pause(kakao_phone.describe_error(code))

    def _bulk_pause(job: dict) -> None:
        """일괄 전송의 사람 사이 간격. 일반 메시지가 기다리거나 큐가 멈추면 바로 끝낸다."""
        if not job.get("batch_id"):
            return
        wait = float(job.get("interval_sec") or 0)
        end = time.time() + wait
        while time.time() < end and not state["paused"]:
            conn = get_db()
            try:
                more = conn.execute("SELECT 1 FROM kakao_messages WHERE status = 'queued' LIMIT 1").fetchone()
                normal = conn.execute("SELECT 1 FROM kakao_messages WHERE status = 'queued' AND batch_id IS NULL LIMIT 1").fetchone()
            finally:
                conn.close()
            if not more or normal:
                return
            time.sleep(0.25)

    def _worker() -> None:
        while True:
            wake.wait(timeout=3)
            wake.clear()
            while not state["paused"] and not state["syncing"]:
                job = _claim_next()
                if not job:
                    break
                state["busy"] = True
                try:
                    # 사진 → 글처럼 몇 백 ms 간격으로 들어오는 요청이 한 묶음이 되도록 잠깐 모일 시간을 준다.
                    try:
                        age = (datetime.now().astimezone() - datetime.fromisoformat(job["created_at"])).total_seconds()
                    except (TypeError, ValueError):
                        age = 99
                    if 0 <= age < _BATCH_GRACE_SEC:
                        time.sleep(_BATCH_GRACE_SEC - age)
                    _process(job)
                    _bulk_pause(job)
                finally:
                    state["busy"] = False

    def _ensure_worker() -> None:
        with start_lock:
            thread = state["thread"]
            if thread is None or not thread.is_alive():
                thread = threading.Thread(target=_worker, name="kakao-queue-worker", daemon=True)
                state["thread"] = thread
                thread.start()
        wake.set()

    def _contact_or_404(conn, contact_id: int):
        row = conn.execute("SELECT * FROM kakao_contacts WHERE id = ?", (contact_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="친구를 찾을 수 없습니다.")
        return row

    # ---- status / device --------------------------------------------
    @router.get("/status")
    def get_status(user: str = Depends(get_current_user)):
        _ensure_worker()
        config = _device_config()
        conn = get_db()
        counts = {
            r["status"]: r["n"]
            for r in conn.execute("SELECT status, COUNT(*) AS n FROM kakao_messages WHERE status IN ('queued','sending','needs_check') GROUP BY status")
        }
        conn.close()
        return {
            "ok": True,
            "bound": bool(config["serial"] and config["hardware_id"] and config["account"]),
            "serial": config["serial"],
            "account": kakao_phone.short_account(config["account"]),
            "paused": state["paused"],
            "pauseReason": state["pause_reason"],
            "busy": state["busy"],
            "sync": dict(sync),
            "roomSync": dict(room_sync),
            "addFriend": dict(add_friend),
            "queued": counts.get("queued", 0),
            "sending": counts.get("sending", 0),
            "needsCheck": counts.get("needs_check", 0),
        }

    @router.get("/devices")
    def get_devices(user: str = Depends(get_current_user)):
        try:
            return {"ok": True, "devices": kakao_phone.list_devices()}
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=502, detail=kakao_phone.describe_error(kakao_phone.error_code(exc)))

    @router.post("/device/bind")
    def bind_device(payload: dict = Body(default={}), user: str = Depends(get_current_user)):
        serial = str((payload or {}).get("serial") or "").strip()
        if not phone_lock.acquire(blocking=False):
            raise HTTPException(status_code=409, detail="폰이 다른 작업을 처리 중입니다. 잠시 후 다시 시도하세요.")
        try:
            result = kakao_phone.bind(serial)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=400, detail=kakao_phone.describe_error(kakao_phone.error_code(exc)))
        finally:
            phone_lock.release()
        set_settings(get_db, result)
        state["paused"] = False
        state["pause_reason"] = ""
        wake.set()
        return {"ok": True, "serial": result["serial"], "account": kakao_phone.short_account(result["account"])}

    @router.post("/queue")
    def set_queue(payload: dict = Body(...), user: str = Depends(get_current_user)):
        if payload.get("paused"):
            _pause("관리자가 큐를 멈췄습니다.")
        else:
            state["paused"] = False
            state["pause_reason"] = ""
            _ensure_worker()
        return {"ok": True, "paused": state["paused"]}

    # ---- contacts ----------------------------------------------------
    @router.get("/contacts")
    def list_contacts(user: str = Depends(get_current_user)):
        conn = get_db()
        rows = conn.execute(
            """
            SELECT c.*,
              (SELECT text FROM kakao_messages m WHERE m.contact_id = c.id AND m.dry_run = 0 AND m.status <> 'cancelled' ORDER BY COALESCE(m.sort_no, m.id) DESC LIMIT 1) AS last_text,
              (SELECT created_at FROM kakao_messages m WHERE m.contact_id = c.id AND m.dry_run = 0 AND m.status <> 'cancelled' ORDER BY COALESCE(m.sort_no, m.id) DESC LIMIT 1) AS last_at,
              (SELECT status FROM kakao_messages m WHERE m.contact_id = c.id AND m.dry_run = 0 AND m.status <> 'cancelled' ORDER BY COALESCE(m.sort_no, m.id) DESC LIMIT 1) AS last_status,
              (SELECT COUNT(*) FROM kakao_messages m WHERE m.contact_id = c.id AND m.status IN ('failed','needs_check')) AS problem_count
            FROM kakao_contacts c ORDER BY c.name COLLATE NOCASE ASC
            """
        ).fetchall()
        conn.close()
        return {
            "ok": True,
            "contacts": [
                {
                    "id": r["id"],
                    "name": r["name"],
                    "memo": r["memo"],
                    "source": r["source"],
                    "inPhone": bool(r["in_phone"]),
                    "lastText": r["last_text"] or "",
                    "lastAt": r["last_at"] or "",
                    "lastStatus": r["last_status"] or "",
                    "problemCount": r["problem_count"],
                }
                for r in rows
            ],
        }

    @router.post("/contacts")
    def add_contact(payload: dict = Body(...), user: str = Depends(get_current_user)):
        name = str(payload.get("name") or "").strip()
        memo = str(payload.get("memo") or "").strip()[:200]
        if not name or len(name) > _MAX_NAME:
            raise HTTPException(status_code=400, detail="카카오톡 친구 이름을 입력하세요.")
        conn = get_db()
        try:
            if conn.execute("SELECT 1 FROM kakao_contacts WHERE name = ?", (name,)).fetchone():
                raise HTTPException(status_code=409, detail="이미 추가된 친구입니다.")
            cur = conn.execute(
                "INSERT INTO kakao_contacts (name, memo, created_by, created_at) VALUES (?, ?, ?, ?)",
                (name, memo, user, now_iso()),
            )
            conn.commit()
            return {"ok": True, "id": cur.lastrowid}
        finally:
            conn.close()

    def _stored_names() -> set:
        conn = get_db()
        names = {r["name"] for r in conn.execute("SELECT name FROM kakao_contacts").fetchall()}
        conn.close()
        return names

    def _count_names(names: list[str]) -> dict:
        counts: dict[str, int] = {}
        for name in names:
            counts[name] = counts.get(name, 0) + 1
        return counts

    def _insert_new(conn, counts: dict, existing: dict) -> list[str]:
        """아직 없는 이름만 추가한다(출처=sync). 동명이인은 메모에 표시한다."""
        added = []
        stamp = now_iso()
        for name, n in counts.items():
            note = f"동명이인 {n}명 · 전송 불가" if n > 1 else ""
            row = existing.get(name)
            if row is None:
                conn.execute(
                    "INSERT INTO kakao_contacts (name, memo, created_by, created_at, source, in_phone, synced_at) "
                    "VALUES (?, ?, 'sync', ?, 'sync', 1, ?)",
                    (name[:_MAX_NAME], note, stamp, stamp),
                )
                added.append(name)
            elif note and not row["memo"]:
                conn.execute("UPDATE kakao_contacts SET memo = ? WHERE id = ?", (note, row["id"]))
        return added

    def _apply_full(names: list[str], expected: int) -> dict:
        """폰 전체 목록을 반영한다. 새 친구는 추가, 폰에 없는 친구는 '폰에 없음'으로 표시만 한다(삭제 안 함)."""
        counts = _count_names(names)
        conn = get_db()
        try:
            existing = {r["name"]: r for r in conn.execute("SELECT id, name, memo FROM kakao_contacts").fetchall()}
            added = _insert_new(conn, counts, existing)
            stamp = now_iso()
            conn.execute("UPDATE kakao_contacts SET in_phone = 0")
            for name in counts:
                conn.execute("UPDATE kakao_contacts SET in_phone = 1, synced_at = ? WHERE name = ?", (stamp, name))
            missing = sorted(n for n in existing if n not in counts)
            conn.commit()
        finally:
            conn.close()
        set_settings(get_db, {"phone_friend_count": expected})
        return {
            "mode": "full",
            "total": len(names),
            "expected": expected,
            "added": len(added),
            "addedNames": added[:10],
            "duplicates": sorted(n for n, c in counts.items() if c > 1),
            "missing": missing[:20],
            "missingCount": len(missing),
        }

    def _apply_additions(names: list[str], expected: int, scanned: int) -> dict:
        """최근 추가된 친구만 반영한다. 기존 친구 상태는 건드리지 않는다."""
        counts = _count_names(names)
        conn = get_db()
        try:
            existing = {r["name"]: r for r in conn.execute("SELECT id, name, memo FROM kakao_contacts").fetchall()}
            added = _insert_new(conn, counts, existing)
            conn.commit()
        finally:
            conn.close()
        set_settings(get_db, {"phone_friend_count": expected})
        return {
            "mode": "incremental",
            "total": scanned,
            "expected": expected,
            "added": len(added),
            "addedNames": added[:10],
            "duplicates": sorted(n for n, c in counts.items() if c > 1),
            "missing": [],
            "missingCount": 0,
        }

    def _run_sync(force_full: bool) -> None:
        try:
            # 전송 중인 작업이 끝날 때까지 기다린 뒤, 동기화 중에는 새 전송을 시작하지 않는다.
            if not phone_lock.acquire(timeout=180):
                raise RuntimeError("busy")
            try:
                config = _device_config()
                result = None
                known = _stored_names()
                try:
                    previous = int(get_setting(get_db, "phone_friend_count", "0") or 0)
                except ValueError:
                    previous = 0
                if not force_full and previous > 0 and known:
                    # 증분: 최근 추가순으로 위에서부터 읽다가 아는 이름이 이어지면 멈춘다.
                    names, expected, complete = kakao_phone.read_recent_friends(config, known)
                    fresh = [n for n in names if n not in known]
                    if complete:
                        result = _apply_full(names, expected)  # 끝까지 읽었으면 전체 반영과 같다
                    elif expected == previous + len(fresh):
                        result = _apply_additions(fresh, expected, scanned=len(names))
                    # 그 외(친구가 삭제·차단·이름 변경되었거나 순서 가정이 어긋남)는 전체를 다시 읽는다
                if result is None:
                    names, expected = kakao_phone.read_friends(config)
                    result = _apply_full(names, expected)
                    if not force_full and previous > 0:
                        result["fallback"] = True
            finally:
                phone_lock.release()
            sync["result"] = result
            sync["error"] = ""
        except RuntimeError:
            sync["result"] = None
            sync["error"] = "폰이 다른 작업을 처리 중입니다. 잠시 후 다시 시도하세요."
        except Exception as exc:  # noqa: BLE001
            sync["result"] = None
            sync["error"] = kakao_phone.describe_error(kakao_phone.error_code(exc))
        finally:
            sync["running"] = False
            sync["finishedAt"] = now_iso()
            state["syncing"] = False
            wake.set()

    @router.post("/contacts/sync")
    def sync_contacts(payload: dict = Body(default={}), user: str = Depends(get_current_user)):
        """기본은 바뀐 것만(증분). {"mode": "full"}이면 전체를 다시 읽는다."""
        config = _device_config()
        if not (config["serial"] and config["hardware_id"] and config["account"]):
            raise HTTPException(status_code=400, detail=kakao_phone.describe_error("device_not_bound"))
        force_full = str((payload or {}).get("mode") or "") == "full"
        with start_lock:
            if sync["running"] or room_sync["running"] or add_friend["running"]:
                raise HTTPException(status_code=409, detail="이미 동기화가 진행 중입니다.")
            sync.update(running=True, startedAt=now_iso(), finishedAt="", result=None, error="")
            state["syncing"] = True
        threading.Thread(target=_run_sync, args=(force_full,), name="kakao-friend-sync", daemon=True).start()
        return {"ok": True, "started": True, "mode": "full" if force_full else "auto"}

    def _import_history(cid: int, messages: list, since: str) -> dict:
        """폰에서 읽은 since 이후의 대화를 웹 대화와 맞춘다. 이미 있는 것은 건드리지 않고 없는 것만 제 위치에 끼운다."""
        phone_items = []
        for m in messages:
            text = str(m.get("text") or "").strip()[:_MAX_TEXT]
            if m.get("side") in ("me", "them") and text:
                phone_items.append({"side": m["side"], "text": text, "date": str(m.get("date") or "")})
        conn = get_db()
        try:
            floor = (datetime.strptime(since, "%Y-%m-%d") - timedelta(days=1)).strftime("%Y-%m-%d")
            rows = conn.execute(
                "SELECT id, direction, text, status, COALESCE(sort_no, id) AS k FROM kakao_messages "
                "WHERE contact_id = ? AND dry_run = 0 AND substr(created_at, 1, 10) >= ? ORDER BY COALESCE(sort_no, id)",
                (cid, floor),
            ).fetchall()
            done = [r for r in rows if r["status"] in ("sent", "received")]
            db_keys = [("me" if r["direction"] == "out" else "them", _key(r["text"])) for r in done]
            ph_keys = [(i["side"], _key(i["text"])) for i in phone_items]
            matcher = difflib.SequenceMatcher(None, db_keys, ph_keys, autojunk=False)
            everything = conn.execute(
                "SELECT COALESCE(sort_no, id) AS k, status FROM kakao_messages WHERE contact_id = ? ORDER BY k", (cid,)
            ).fetchall()
            keys = [r["k"] for r in everything]
            pending_keys = [r["k"] for r in everything if r["status"] in ("queued", "sending")]
            settled_max = max([r["k"] for r in everything if r["status"] not in ("queued", "sending")], default=0.0)
            added = 0
            for tag, i1, i2, j1, j2 in matcher.get_opcodes():
                if tag not in ("insert", "replace") or j1 == j2:
                    continue
                new_items = phone_items[j1:j2]
                if i1 > 0:                      # 맞는 웹 메시지 바로 뒤
                    low = done[i1 - 1]["k"]
                    later = [k for k in keys if k > low]
                    high = later[0] if later else low + 1.0
                elif i1 < len(done):            # 범위 안 첫 웹 메시지 바로 앞 (그 앞 메시지 뒤)
                    high = done[i1]["k"]
                    before = [k for k in keys if k < high]
                    low = before[-1] if before else high - 1.0
                else:                           # 웹에 이 범위 기록이 전혀 없음: 확정된 마지막 메시지 뒤, 대기 중인 것 앞
                    low = settled_max
                    later = [k for k in pending_keys if k > low]
                    high = later[0] if later else low + 1.0
                gap = (high - low) / (len(new_items) + 1)
                added += _insert_phone_messages(conn, cid, new_items, before_key=low + gap, spread=gap)
            return {"read": len(phone_items), "added": added}
        finally:
            conn.close()

    def _run_room_sync(contact_id: int, name: str, since: str) -> None:
        try:
            if not phone_lock.acquire(timeout=180):
                raise RuntimeError("busy")
            try:
                messages, pages = kakao_phone.read_room_history(_device_config(), name, since)
            finally:
                phone_lock.release()
            stats = _import_history(contact_id, messages, since)
            room_sync["result"] = {**stats, "since": since, "pages": pages}
            room_sync["error"] = ""
        except RuntimeError:
            room_sync["result"] = None
            room_sync["error"] = "폰이 다른 작업을 처리 중입니다. 잠시 후 다시 시도하세요."
        except Exception as exc:  # noqa: BLE001
            room_sync["result"] = None
            room_sync["error"] = kakao_phone.describe_error(kakao_phone.error_code(exc))
        finally:
            room_sync["running"] = False
            room_sync["finishedAt"] = now_iso()
            state["syncing"] = False
            wake.set()

    @router.post("/contacts/{contact_id}/sync-room")
    def sync_room(contact_id: int, payload: dict = Body(default={}), user: str = Depends(get_current_user)):
        """이 친구와의 폰 대화방을 위로 읽어 since(YYYY-MM-DD)부터 현재까지 웹 대화와 맞춘다."""
        since = str((payload or {}).get("since") or "").strip()
        try:
            day = datetime.strptime(since, "%Y-%m-%d")
        except ValueError:
            raise HTTPException(status_code=400, detail="동기화할 날짜를 선택하세요.")
        if day > datetime.now() + timedelta(days=1):
            raise HTTPException(status_code=400, detail="오늘 이후 날짜는 선택할 수 없습니다.")
        config = _device_config()
        if not (config["serial"] and config["hardware_id"] and config["account"]):
            raise HTTPException(status_code=400, detail=kakao_phone.describe_error("device_not_bound"))
        conn = get_db()
        try:
            name = _contact_or_404(conn, contact_id)["name"]
        finally:
            conn.close()
        with start_lock:
            if sync["running"] or room_sync["running"] or add_friend["running"]:
                raise HTTPException(status_code=409, detail="이미 동기화가 진행 중입니다.")
            room_sync.update(running=True, contactId=contact_id, since=since, startedAt=now_iso(), finishedAt="", result=None, error="")
            state["syncing"] = True
        threading.Thread(target=_run_room_sync, args=(contact_id, name, since), name="kakao-room-sync", daemon=True).start()
        return {"ok": True, "started": True}

    def _record_added_friend(name: str, newly_added: bool) -> None:
        """폰에서 친구가 확인됐을 때 목록에 넣고, 새로 추가된 경우 저장한 친구 수를 1 늘린다."""
        conn = get_db()
        try:
            row = conn.execute("SELECT id FROM kakao_contacts WHERE name = ?", (name,)).fetchone()
            stamp = now_iso()
            if row:
                conn.execute("UPDATE kakao_contacts SET in_phone = 1, synced_at = ? WHERE id = ?", (stamp, row["id"]))
            else:
                conn.execute(
                    "INSERT INTO kakao_contacts (name, memo, created_by, created_at, source, in_phone, synced_at) "
                    "VALUES (?, '', 'add', ?, 'sync', 1, ?)",
                    (name[:_MAX_NAME], stamp, stamp),
                )
            conn.commit()
        finally:
            conn.close()
        if newly_added:
            try:
                previous = int(get_setting(get_db, "phone_friend_count", "0") or 0)
            except ValueError:
                previous = 0
            if previous > 0:
                set_settings(get_db, {"phone_friend_count": previous + 1})

    def _run_add_friend(kind: str, name: str, value: str, dry_run: bool = False) -> None:
        """kind: 'phone'(이름+전화번호) | 'id'(카카오톡 ID). 전화번호·ID는 저장하지 않는다."""
        try:
            if not phone_lock.acquire(timeout=180):
                raise RuntimeError("busy")
            try:
                if kind == "id":
                    found = kakao_phone.add_friend_by_id(_device_config(), value, dry_run=dry_run)
                else:
                    kakao_phone.add_friend(_device_config(), name, value)
                    found = {"name": name, "already_friend": False, "state": "verified"}
            finally:
                phone_lock.release()
            result = {"name": found["name"], "already": bool(found.get("already_friend")), "preview": found["state"] == "ready"}
            if found["state"] == "verified":
                _record_added_friend(found["name"], newly_added=not result["already"])
            add_friend["result"] = result
            add_friend["error"] = ""
        except RuntimeError:
            add_friend["result"] = None
            add_friend["error"] = "폰이 다른 작업을 처리 중입니다. 잠시 후 다시 시도하세요."
        except Exception as exc:  # noqa: BLE001
            add_friend["result"] = None
            add_friend["error"] = kakao_phone.describe_error(kakao_phone.error_code(exc))
        finally:
            add_friend["running"] = False
            add_friend["finishedAt"] = now_iso()
            state["syncing"] = False
            wake.set()

    @router.post("/friends/add")
    def add_phone_friend(payload: dict = Body(...), user: str = Depends(get_current_user)):
        """폰의 카카오톡에 친구를 추가한다. {name, phone} 또는 {kakao_id}. 전화번호·ID는 저장하지 않는다.
        kakao_id에 dry_run=true면 검색까지만 해서 누구인지 보여준다(추가하지 않음)."""
        kakao_id = str(payload.get("kakao_id") or "").strip()
        if kakao_id:
            value = kakao_phone.normalize_kakao_id(kakao_id)
            if not value:
                raise HTTPException(status_code=400, detail="카카오톡 ID는 영문·숫자·. _ - 만 1~20자로 입력하세요.")
            kind, name, dry_run = "id", "", bool(payload.get("dry_run"))
        else:
            name = str(payload.get("name") or "").strip()
            value = kakao_phone.normalize_phone(str(payload.get("phone") or ""))
            if not name or len(name) > 20:
                raise HTTPException(status_code=400, detail="친구 이름을 20자 이내로 입력하세요.")
            if not value:
                raise HTTPException(status_code=400, detail="전화번호를 올바르게 입력하세요. (예: 010-1234-5678)")
            kind, dry_run = "phone", False
        config = _device_config()
        if not (config["serial"] and config["hardware_id"] and config["account"]):
            raise HTTPException(status_code=400, detail=kakao_phone.describe_error("device_not_bound"))
        with start_lock:
            if sync["running"] or room_sync["running"] or add_friend["running"]:
                raise HTTPException(status_code=409, detail="이미 동기화 또는 친구 추가가 진행 중입니다.")
            add_friend.update(running=True, name=name or kakao_id, startedAt=now_iso(), finishedAt="", result=None, error="")
            state["syncing"] = True
        threading.Thread(target=_run_add_friend, args=(kind, name, value, dry_run), name="kakao-add-friend", daemon=True).start()
        return {"ok": True, "started": True}

    def _load_media(media_ids: str) -> list:
        ids = [m for m in (media_ids or "").split(",") if m]
        conn = get_db()
        try:
            files = []
            for mid in ids:
                row = conn.execute("SELECT * FROM kakao_media WHERE id = ?", (mid,)).fetchone()
                if not row:
                    raise kakao_phone.Blocked("media_file_missing")
                files.append({"id": row["id"], "name": row["name"], "mime": row["mime"], "bytes": row["bytes"], "sha256": row["sha256"], "path": row["path"]})
            return files
        finally:
            conn.close()

    @router.post("/media")
    async def upload_media(request: Request, name: str = Query(""), user: str = Depends(get_current_user)):
        """사진 한 장을 원본 바이트로 올린다(Content-Type 무관). 내용으로 종류를 검사한다."""
        data = await request.body()
        if not data:
            raise HTTPException(status_code=400, detail="빈 파일입니다.")
        if len(data) > _MAX_IMAGE_BYTES:
            raise HTTPException(status_code=413, detail="사진은 한 장에 20MB까지 보낼 수 있습니다.")
        kind = _sniff_image(data)
        if not kind:
            raise HTTPException(status_code=400, detail="JPG, PNG, GIF, WEBP 사진만 보낼 수 있습니다.")
        mime, ext = kind
        media_id = str(uuid.uuid4())
        _MEDIA_DIR.mkdir(parents=True, exist_ok=True)
        path = _MEDIA_DIR / f"{media_id}.{ext}"
        path.write_bytes(data)
        display = _safe_name(name, ext)
        conn = get_db()
        try:
            conn.execute(
                "INSERT INTO kakao_media (id, name, mime, bytes, sha256, path, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (media_id, display, mime, len(data), hashlib.sha256(data).hexdigest(), str(path), user, now_iso()),
            )
            conn.commit()
        finally:
            conn.close()
        return {"ok": True, "id": media_id, "name": display, "mime": mime, "bytes": len(data)}

    @router.get("/media/{media_id}")
    def get_media(media_id: str, user: str = Depends(get_current_user)):
        if not re.fullmatch(r"[a-f0-9-]{36}", media_id):
            raise HTTPException(status_code=404, detail="not found")
        conn = get_db()
        try:
            row = conn.execute("SELECT path, mime FROM kakao_media WHERE id = ?", (media_id,)).fetchone()
        finally:
            conn.close()
        if not row or not pathlib.Path(row["path"]).is_file():
            raise HTTPException(status_code=404, detail="not found")
        return FileResponse(row["path"], media_type=row["mime"], headers={"Cache-Control": "private, max-age=86400"})

    @router.post("/send-images")
    def send_images(payload: dict = Body(...), user: str = Depends(get_current_user)):
        """업로드한 사진(1~10장)을 한 메시지로 큐에 넣는다. 한 번에 한 말풍선(앨범)으로 나간다."""
        try:
            contact_id = int(payload.get("contact_id"))
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="친구를 선택하세요.")
        ids = [str(m) for m in (payload.get("media_ids") or [])]
        if not 1 <= len(ids) <= _MAX_IMAGES or len(set(ids)) != len(ids) or not all(re.fullmatch(r"[a-f0-9-]{36}", m) for m in ids):
            raise HTTPException(status_code=400, detail=f"사진은 한 번에 1~{_MAX_IMAGES}장까지 보낼 수 있습니다.")
        request_id = str(payload.get("request_id") or "").strip()[:64] or None
        caption = str(payload.get("text") or "").replace("\r\n", "\n").strip("\n")
        if len(caption) > _MAX_TEXT:
            raise HTTPException(status_code=400, detail=f"메시지는 {_MAX_TEXT}자까지 보낼 수 있습니다.")
        conn = get_db()
        try:
            _contact_or_404(conn, contact_id)
            for mid in ids:
                if not conn.execute("SELECT 1 FROM kakao_media WHERE id = ?", (mid,)).fetchone():
                    raise HTTPException(status_code=400, detail="업로드되지 않은 사진이 있습니다. 다시 선택하세요.")
            if request_id:
                existing = conn.execute("SELECT * FROM kakao_messages WHERE request_id = ?", (request_id,)).fetchone()
                if existing:
                    return {"ok": True, "message": _row_to_message(existing), "duplicate": True}
            stamp = now_iso()
            cur = conn.execute(
                "INSERT INTO kakao_messages (contact_id, text, status, dry_run, request_id, requested_by, created_at, updated_at, kind, media_ids) "
                "VALUES (?, '(사진)', 'queued', 0, ?, ?, ?, ?, 'image', ?)",
                (contact_id, request_id, user, stamp, stamp, ",".join(ids)),
            )
            image_id = cur.lastrowid
            if caption.strip():  # 사진 바로 뒤에 붙는 글: 같은 요청으로 함께 등록해 한 묶음(방 유지)으로 나간다
                conn.execute(
                    "INSERT INTO kakao_messages (contact_id, text, status, dry_run, requested_by, created_at, updated_at) "
                    "VALUES (?, ?, 'queued', 0, ?, ?, ?)",
                    (contact_id, caption, user, stamp, stamp),
                )
            conn.commit()
            row = conn.execute("SELECT * FROM kakao_messages WHERE id = ?", (image_id,)).fetchone()
            message = _row_to_message(row)
        finally:
            conn.close()
        _ensure_worker()
        return {"ok": True, "message": message}

    def _run_rename(contact_id: int, old: str, new: str) -> None:
        try:
            if not phone_lock.acquire(timeout=180):
                raise RuntimeError("busy")
            try:
                kakao_phone.rename_friend(_device_config(), old, new)
            finally:
                phone_lock.release()
            conn = get_db()
            try:
                conn.execute("UPDATE kakao_contacts SET name = ?, in_phone = 1, synced_at = ? WHERE id = ?", (new, now_iso(), contact_id))
                conn.commit()
            finally:
                conn.close()
            add_friend["result"] = {"name": new, "renamedFrom": old, "already": False, "preview": False}
            add_friend["error"] = ""
        except RuntimeError:
            add_friend["result"] = None
            add_friend["error"] = "폰이 다른 작업을 처리 중입니다. 잠시 후 다시 시도하세요."
        except Exception as exc:  # noqa: BLE001
            add_friend["result"] = None
            add_friend["error"] = kakao_phone.describe_error(kakao_phone.error_code(exc))
        finally:
            add_friend["running"] = False
            add_friend["finishedAt"] = now_iso()
            state["syncing"] = False
            wake.set()

    @router.post("/contacts/{contact_id}/rename")
    def rename_contact(contact_id: int, payload: dict = Body(...), user: str = Depends(get_current_user)):
        """폰의 카카오톡 친구 이름을 바꾸고 목록 이름도 같이 바꾼다. 대화 기록은 그대로 따라간다."""
        new = str((payload or {}).get("new_name") or "").strip()
        if not new or len(new) > 20:
            raise HTTPException(status_code=400, detail="새 이름을 20자 이내로 입력하세요.")
        config = _device_config()
        if not (config["serial"] and config["hardware_id"] and config["account"]):
            raise HTTPException(status_code=400, detail=kakao_phone.describe_error("device_not_bound"))
        conn = get_db()
        try:
            old = _contact_or_404(conn, contact_id)["name"]
            if new == old:
                raise HTTPException(status_code=400, detail="현재 이름과 같습니다.")
            if conn.execute("SELECT 1 FROM kakao_contacts WHERE name = ? AND id <> ?", (new, contact_id)).fetchone():
                raise HTTPException(status_code=409, detail="이미 같은 이름의 친구가 목록에 있습니다.")
            pending = conn.execute(
                "SELECT COUNT(*) AS n FROM kakao_messages WHERE contact_id = ? AND status IN ('queued','sending','needs_check')", (contact_id,)
            ).fetchone()["n"]
            if pending:
                raise HTTPException(status_code=409, detail="대기 중이거나 확인이 필요한 메시지가 있어 이름을 바꿀 수 없습니다.")
        finally:
            conn.close()
        with start_lock:
            if sync["running"] or room_sync["running"] or add_friend["running"]:
                raise HTTPException(status_code=409, detail="이미 동기화 또는 폰 작업이 진행 중입니다.")
            add_friend.update(running=True, name=new, startedAt=now_iso(), finishedAt="", result=None, error="")
            state["syncing"] = True
        threading.Thread(target=_run_rename, args=(contact_id, old, new), name="kakao-rename", daemon=True).start()
        return {"ok": True, "started": True}

    @router.post("/bulk")
    def create_bulk(payload: dict = Body(...), user: str = Depends(get_current_user)):
        """여러 친구에게 같은 메시지(와 사진)를 차례로 보낸다. 사람마다 메시지 하나씩 큐에 쌓는다.
        글에 {이름}이 있으면 받는 사람 이름으로 바뀐다."""
        raw_ids = payload.get("contact_ids") or []
        ids, seen = [], set()
        for value in raw_ids:
            try:
                cid = int(value)
            except (TypeError, ValueError):
                continue
            if cid not in seen:
                seen.add(cid)
                ids.append(cid)
        if not ids:
            raise HTTPException(status_code=400, detail="받는 사람을 선택하세요.")
        if len(ids) > _MAX_BULK_RECIPIENTS:
            raise HTTPException(status_code=400, detail=f"한 번에 {_MAX_BULK_RECIPIENTS}명까지 보낼 수 있습니다.")
        text = str(payload.get("text") or "").replace("\r\n", "\n").strip("\n")
        if len(text) > _MAX_TEXT:
            raise HTTPException(status_code=400, detail=f"메시지는 {_MAX_TEXT}자까지 보낼 수 있습니다.")
        media_ids = [str(m) for m in (payload.get("media_ids") or [])]
        if len(media_ids) > _MAX_IMAGES or len(set(media_ids)) != len(media_ids) or not all(re.fullmatch(r"[a-f0-9-]{36}", m) for m in media_ids):
            raise HTTPException(status_code=400, detail=f"사진은 한 번에 1~{_MAX_IMAGES}장까지 보낼 수 있습니다.")
        if not text.strip() and not media_ids:
            raise HTTPException(status_code=400, detail="보낼 메시지나 사진을 입력하세요.")
        try:
            interval = max(0, min(120, int(payload.get("interval_sec", 5))))
        except (TypeError, ValueError):
            interval = 5
        request_id = str(payload.get("request_id") or "").strip()[:64] or None
        list_name = re.sub(r"\s+", " ", str(payload.get("list_name") or "")).strip()
        if len(list_name) > _MAX_LIST_NAME:
            raise HTTPException(status_code=400, detail=f"리스트 이름은 {_MAX_LIST_NAME}자까지 입력할 수 있습니다.")
        conn = get_db()
        try:
            for mid in media_ids:
                if not conn.execute("SELECT 1 FROM kakao_media WHERE id = ?", (mid,)).fetchone():
                    raise HTTPException(status_code=400, detail="업로드되지 않은 사진이 있습니다. 다시 선택하세요.")
            if request_id:
                existing = conn.execute("SELECT id, total FROM kakao_batches WHERE request_id = ?", (request_id,)).fetchone()
                if existing:
                    return {"ok": True, "batchId": existing["id"], "recipients": existing["total"], "duplicate": True}
            found = {}
            for start in range(0, len(ids), 200):
                chunk = ids[start:start + 200]
                marks = ",".join("?" * len(chunk))
                for r in conn.execute(f"SELECT id, name FROM kakao_contacts WHERE id IN ({marks})", chunk).fetchall():
                    found[r["id"]] = r["name"]
            targets = [(cid, found[cid]) for cid in ids if cid in found]
            if not targets:
                raise HTTPException(status_code=400, detail="선택한 친구를 찾을 수 없습니다.")
            stamp = now_iso()
            list_id = None
            list_created = False
            if list_name:
                row = conn.execute("SELECT id FROM kakao_lists WHERE name = ?", (list_name,)).fetchone()
                if row:
                    list_id = row["id"]
                else:
                    list_id = conn.execute("INSERT INTO kakao_lists (name, created_by, created_at) VALUES (?, ?, ?)", (list_name, user, stamp)).lastrowid
                    list_created = True
                for cid, _name in targets:
                    conn.execute("INSERT OR IGNORE INTO kakao_list_members (list_id, contact_id, added_at) VALUES (?, ?, ?)", (list_id, cid, stamp))
            cur = conn.execute(
                "INSERT INTO kakao_batches (text, media_ids, interval_sec, total, request_id, created_by, created_at, list_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (text, ",".join(media_ids), interval, len(targets), request_id, user, stamp, list_id),
            )
            batch_id = cur.lastrowid
            messages = 0
            for cid, name in targets:
                if media_ids:
                    conn.execute(
                        "INSERT INTO kakao_messages (contact_id, text, status, dry_run, requested_by, created_at, updated_at, kind, media_ids, batch_id) "
                        "VALUES (?, '(사진)', 'queued', 0, ?, ?, ?, 'image', ?, ?)",
                        (cid, user, stamp, stamp, ",".join(media_ids), batch_id),
                    )
                    messages += 1
                if text.strip():
                    conn.execute(
                        "INSERT INTO kakao_messages (contact_id, text, status, dry_run, requested_by, created_at, updated_at, batch_id) "
                        "VALUES (?, ?, 'queued', 0, ?, ?, ?, ?)",
                        (cid, text.replace("{이름}", name), user, stamp, stamp, batch_id),
                    )
                    messages += 1
            conn.commit()
        finally:
            conn.close()
        _ensure_worker()
        return {
            "ok": True, "batchId": batch_id, "recipients": len(targets), "messages": messages, "skipped": len(ids) - len(targets),
            "listId": list_id, "listName": list_name, "listCreated": list_created,
        }

    def _batch_counts(conn, batch_ids: list) -> dict:
        counts: dict = {b: {} for b in batch_ids}
        if not batch_ids:
            return counts
        marks = ",".join("?" * len(batch_ids))
        for r in conn.execute(
            f"SELECT batch_id, status, COUNT(*) AS n FROM kakao_messages WHERE batch_id IN ({marks}) GROUP BY batch_id, status", batch_ids
        ).fetchall():
            counts[r["batch_id"]][r["status"]] = r["n"]
        return counts

    @router.get("/bulk")
    def list_bulk(user: str = Depends(get_current_user)):
        conn = get_db()
        try:
            rows = conn.execute(
                "SELECT b.*, l.name AS list_name FROM kakao_batches b LEFT JOIN kakao_lists l ON l.id = b.list_id ORDER BY b.id DESC LIMIT 20"
            ).fetchall()
            counts = _batch_counts(conn, [r["id"] for r in rows])
        finally:
            conn.close()
        return {
            "ok": True,
            "batches": [
                {
                    "id": r["id"],
                    "text": r["text"],
                    "photos": len([m for m in r["media_ids"].split(",") if m]),
                    "recipients": r["total"],
                    "listId": r["list_id"],
                    "listName": r["list_name"] or "",
                    "intervalSec": r["interval_sec"],
                    "createdBy": r["created_by"],
                    "createdByDisplay": get_user_display(r["created_by"]) or r["created_by"],
                    "createdAt": r["created_at"],
                    "counts": counts.get(r["id"], {}),
                }
                for r in rows
            ],
        }

    @router.get("/bulk/{batch_id}")
    def get_bulk(batch_id: int, user: str = Depends(get_current_user)):
        conn = get_db()
        try:
            batch = conn.execute("SELECT * FROM kakao_batches WHERE id = ?", (batch_id,)).fetchone()
            if not batch:
                raise HTTPException(status_code=404, detail="일괄 전송을 찾을 수 없습니다.")
            items = conn.execute(
                "SELECT m.id, m.contact_id, c.name, m.kind, m.status, m.error FROM kakao_messages m "
                "JOIN kakao_contacts c ON c.id = m.contact_id WHERE m.batch_id = ? ORDER BY m.id",
                (batch_id,),
            ).fetchall()
        finally:
            conn.close()
        return {
            "ok": True,
            "id": batch["id"],
            "items": [
                {"messageId": r["id"], "contactId": r["contact_id"], "name": r["name"], "kind": r["kind"], "status": r["status"], "error": r["error"]}
                for r in items
            ],
        }

    # ---- 리스트: 일괄 전송 때 묶어 둔 받는 사람 모음 ------------------------------
    @router.get("/lists")
    def list_lists(user: str = Depends(get_current_user)):
        conn = get_db()
        try:
            rows = conn.execute(
                "SELECT l.id, l.name, l.created_at, "
                "(SELECT COUNT(*) FROM kakao_list_members m WHERE m.list_id = l.id) AS n "
                "FROM kakao_lists l ORDER BY l.id DESC"
            ).fetchall()
        finally:
            conn.close()
        return {"ok": True, "lists": [{"id": r["id"], "name": r["name"], "count": r["n"], "createdAt": r["created_at"]} for r in rows]}

    @router.get("/lists/{list_id}")
    def get_list(list_id: int, user: str = Depends(get_current_user)):
        conn = get_db()
        try:
            row = conn.execute("SELECT id, name FROM kakao_lists WHERE id = ?", (list_id,)).fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="리스트를 찾을 수 없습니다.")
            members = [r["contact_id"] for r in conn.execute(
                "SELECT m.contact_id FROM kakao_list_members m JOIN kakao_contacts c ON c.id = m.contact_id WHERE m.list_id = ? ORDER BY c.name COLLATE NOCASE",
                (list_id,),
            ).fetchall()]
        finally:
            conn.close()
        return {"ok": True, "id": row["id"], "name": row["name"], "contactIds": members}

    @router.delete("/lists/{list_id}")
    def delete_list(list_id: int, user: str = Depends(get_current_user)):
        """리스트만 지운다. 친구와 대화 기록은 그대로다."""
        conn = get_db()
        try:
            conn.execute("DELETE FROM kakao_list_members WHERE list_id = ?", (list_id,))
            conn.execute("UPDATE kakao_batches SET list_id = NULL WHERE list_id = ?", (list_id,))
            cur = conn.execute("DELETE FROM kakao_lists WHERE id = ?", (list_id,))
            conn.commit()
            if not cur.rowcount:
                raise HTTPException(status_code=404, detail="리스트를 찾을 수 없습니다.")
        finally:
            conn.close()
        return {"ok": True}

    @router.post("/bulk/{batch_id}/cancel")
    def cancel_bulk(batch_id: int, user: str = Depends(get_current_user)):
        """아직 시작하지 않은(대기 중) 메시지만 취소한다. 이미 나갔거나 전송 중인 것은 그대로다."""
        conn = get_db()
        try:
            cur = conn.execute(
                "UPDATE kakao_messages SET status = 'cancelled', error = '일괄 전송이 취소되었습니다.', updated_at = ? "
                "WHERE batch_id = ? AND status = 'queued'",
                (now_iso(), batch_id),
            )
            conn.commit()
            return {"ok": True, "cancelled": cur.rowcount}
        finally:
            conn.close()

    @router.post("/bulk/{batch_id}/retry-failed")
    def retry_failed_bulk(batch_id: int, user: str = Depends(get_current_user)):
        """보내기 전에 실패한 것만 다시 큐에 넣는다. 확인 필요(needs_check)는 포함하지 않는다(중복 발송 위험)."""
        conn = get_db()
        try:
            cur = conn.execute(
                "UPDATE kakao_messages SET status = 'queued', error = '', updated_at = ? WHERE batch_id = ? AND status = 'failed'",
                (now_iso(), batch_id),
            )
            conn.commit()
            retried = cur.rowcount
        finally:
            conn.close()
        if retried:
            _ensure_worker()
        return {"ok": True, "retried": retried}

    @router.delete("/contacts/{contact_id}")
    def delete_contact(contact_id: int, user: str = Depends(get_current_user)):
        conn = get_db()
        try:
            _contact_or_404(conn, contact_id)
            pending = conn.execute(
                "SELECT COUNT(*) AS n FROM kakao_messages WHERE contact_id = ? AND status IN ('queued','sending','needs_check')",
                (contact_id,),
            ).fetchone()["n"]
            if pending:
                raise HTTPException(status_code=409, detail="대기 중이거나 확인이 필요한 메시지가 있어 삭제할 수 없습니다.")
            conn.execute("DELETE FROM kakao_messages WHERE contact_id = ?", (contact_id,))
            conn.execute("DELETE FROM kakao_list_members WHERE contact_id = ?", (contact_id,))
            conn.execute("DELETE FROM kakao_contacts WHERE id = ?", (contact_id,))
            conn.commit()
            return {"ok": True}
        finally:
            conn.close()

    # ---- messages ----------------------------------------------------
    @router.get("/messages")
    def list_messages(contact_id: int = Query(...), limit: int = Query(300, ge=1, le=1000), user: str = Depends(get_current_user)):
        conn = get_db()
        _contact_or_404(conn, contact_id)
        rows = conn.execute(
            "SELECT * FROM (SELECT * FROM kakao_messages WHERE contact_id = ? ORDER BY COALESCE(sort_no, id) DESC LIMIT ?) ORDER BY COALESCE(sort_no, id) ASC",
            (contact_id, limit),
        ).fetchall()
        ahead = {
            r["id"]: i
            for i, r in enumerate(conn.execute(f"SELECT id FROM kakao_messages WHERE status = 'queued' ORDER BY {_QUEUE_ORDER}").fetchall())
        }
        conn.close()
        out = []
        for r in rows:
            item = _row_to_message(r)
            if r["status"] == "queued":
                item["queuePosition"] = ahead.get(r["id"], 0)
            out.append(item)
        return {"ok": True, "messages": out}

    @router.post("/send")
    def send_message(payload: dict = Body(...), user: str = Depends(get_current_user)):
        text = str(payload.get("text") or "").replace("\r\n", "\n").strip("\n")
        if not text.strip():
            raise HTTPException(status_code=400, detail="메시지를 입력하세요.")
        if len(text) > _MAX_TEXT:
            raise HTTPException(status_code=400, detail=f"메시지는 {_MAX_TEXT}자까지 보낼 수 있습니다.")
        try:
            contact_id = int(payload.get("contact_id"))
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="친구를 선택하세요.")
        request_id = str(payload.get("request_id") or "").strip()[:64] or None
        dry_run = bool(payload.get("dry_run"))
        conn = get_db()
        try:
            _contact_or_404(conn, contact_id)
            if request_id:  # 같은 요청이 다시 오면(버튼 두 번 클릭 등) 새로 만들지 않는다
                existing = conn.execute("SELECT * FROM kakao_messages WHERE request_id = ?", (request_id,)).fetchone()
                if existing:
                    return {"ok": True, "message": _row_to_message(existing), "duplicate": True}
            stamp = now_iso()
            cur = conn.execute(
                "INSERT INTO kakao_messages (contact_id, text, status, dry_run, request_id, requested_by, created_at, updated_at) "
                "VALUES (?, ?, 'queued', ?, ?, ?, ?, ?)",
                (contact_id, text, 1 if dry_run else 0, request_id, user, stamp, stamp),
            )
            conn.commit()
            row = conn.execute("SELECT * FROM kakao_messages WHERE id = ?", (cur.lastrowid,)).fetchone()
            message = _row_to_message(row)
        finally:
            conn.close()
        _ensure_worker()
        return {"ok": True, "message": message}

    @router.post("/messages/{message_id}/retry")
    def retry_message(message_id: int, user: str = Depends(get_current_user)):
        # 'failed'는 전송 버튼을 누르기 전에 실패한 경우뿐이므로 다시 큐에 넣어도 중복 발송이 없다.
        conn = get_db()
        try:
            cur = conn.execute(
                "UPDATE kakao_messages SET status = 'queued', error = '', updated_at = ? WHERE id = ? AND status = 'failed'",
                (now_iso(), message_id),
            )
            conn.commit()
            if not cur.rowcount:
                raise HTTPException(status_code=409, detail="다시 보낼 수 없는 상태입니다.")
        finally:
            conn.close()
        _ensure_worker()
        return {"ok": True}

    @router.post("/messages/{message_id}/resolve")
    def resolve_message(message_id: int, payload: dict = Body(...), user: str = Depends(get_current_user)):
        # 사람이 폰에서 직접 확인한 결과를 기록한다. (보냈다 / 안 보냈다)
        decision = str(payload.get("status") or "")
        if decision not in ("sent", "failed"):
            raise HTTPException(status_code=400, detail="status는 sent 또는 failed여야 합니다.")
        note = "" if decision == "sent" else "확인 결과 전송되지 않았습니다."
        conn = get_db()
        try:
            cur = conn.execute(
                "UPDATE kakao_messages SET status = ?, error = ?, updated_at = ?, sent_at = CASE WHEN ? = 'sent' THEN ? ELSE sent_at END "
                "WHERE id = ? AND status = 'needs_check'",
                (decision, note, now_iso(), decision, now_iso(), message_id),
            )
            conn.commit()
            if not cur.rowcount:
                raise HTTPException(status_code=409, detail="확인이 필요한 메시지가 아닙니다.")
        finally:
            conn.close()
        return {"ok": True}

    return router
