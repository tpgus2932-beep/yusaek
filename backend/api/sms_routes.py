from __future__ import annotations

import asyncio
import json
import os
import threading
import time
import uuid
from datetime import datetime
from zoneinfo import ZoneInfo

import httpx
from fastapi import APIRouter, Body, Depends, Header, HTTPException

KST = ZoneInfo("Asia/Seoul")
ALIGO_BASE = "https://apis.aligo.in"


def build_sms_router(*, get_current_user, get_db, run_local_dispatcher: bool = False):
    router = APIRouter(prefix="/sms")
    dispatcher_stop = threading.Event()
    dispatcher_thread: threading.Thread | None = None

    def _normalize_receiver(value: str) -> str:
        return "".join(ch for ch in str(value or "") if ch.isdigit())

    def _normalize_receivers_csv(value: str) -> str:
        nums = [_normalize_receiver(part) for part in str(value or "").split(",")]
        nums = [num for num in nums if num]
        return ",".join(dict.fromkeys(nums))

    def _receiver_list(value: str) -> list[str]:
        return [part for part in _normalize_receivers_csv(value).split(",") if part]

    def _creds():
        key = os.environ.get("ALIGO_API_KEY", "").strip()
        user_id = os.environ.get("ALIGO_USER_ID", "").strip()
        if not key or not user_id:
            raise HTTPException(status_code=500, detail="ALIGO_API_KEY / ALIGO_USER_ID 환경변수가 설정되지 않았습니다.")
        return key, user_id

    def _sender():
        sender = os.environ.get("ALIGO_SENDER", "").strip()
        if not sender:
            raise HTTPException(status_code=500, detail="ALIGO_SENDER 환경변수가 설정되지 않았습니다.")
        return sender

    def _ensure_tables():
        conn = get_db()
        try:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS sms_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    mid TEXT UNIQUE NOT NULL,
                    type TEXT,
                    msg TEXT,
                    sender TEXT,
                    sms_count INTEGER DEFAULT 0,
                    fail_count INTEGER DEFAULT 0,
                    reserve_state TEXT,
                    reg_date TEXT,
                    receivers TEXT,
                    created_at TEXT NOT NULL
                )
                """
            )
            conn.execute("CREATE INDEX IF NOT EXISTS idx_sms_history_reg_date ON sms_history(reg_date DESC)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_sms_history_mid ON sms_history(mid)")
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS sms_outbox (
                    id TEXT PRIMARY KEY,
                    receiver TEXT NOT NULL,
                    msg TEXT NOT NULL,
                    msg_type TEXT,
                    title TEXT,
                    rdate TEXT,
                    rtime TEXT,
                    testmode_yn TEXT,
                    sender TEXT,
                    created_by TEXT,
                    created_at TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending',
                    sent_at TEXT,
                    error_message TEXT,
                    retry_count INTEGER NOT NULL DEFAULT 0,
                    last_attempted_at TEXT
                )
                """
            )
            conn.execute("CREATE INDEX IF NOT EXISTS idx_sms_outbox_status_created ON sms_outbox(status, created_at)")
            conn.commit()
        finally:
            conn.close()

    async def _post(path: str, data: dict) -> dict:
        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                res = await client.post(f"{ALIGO_BASE}{path}", data=data)
                res.raise_for_status()
        except httpx.HTTPStatusError as exc:
            detail = exc.response.text.strip() or f"Aligo API returned HTTP {exc.response.status_code}"
            raise HTTPException(status_code=502, detail=detail) from exc
        except httpx.RequestError as exc:
            raise HTTPException(status_code=502, detail=f"Aligo API request failed: {exc}") from exc

        try:
            return res.json()
        except ValueError as exc:
            detail = res.text.strip() or "Aligo API returned a non-JSON response"
            raise HTTPException(status_code=502, detail=detail) from exc

    def _save_history(item: dict, receivers: list[str]):
        conn = get_db()
        try:
            conn.execute(
                """
                INSERT INTO sms_history (mid, type, msg, sender, sms_count, fail_count, reserve_state, reg_date, receivers, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(mid) DO UPDATE SET
                    sms_count = excluded.sms_count,
                    fail_count = excluded.fail_count,
                    reserve_state = excluded.reserve_state,
                    receivers = excluded.receivers
                """,
                (
                    item.get("mid"),
                    item.get("type"),
                    item.get("msg"),
                    item.get("sender", _sender()),
                    int(item.get("sms_count") or 0),
                    int(item.get("fail_count") or 0),
                    item.get("reserve_state"),
                    item.get("reg_date"),
                    json.dumps(receivers, ensure_ascii=False),
                    datetime.now(KST).isoformat(),
                ),
            )
            conn.commit()
        finally:
            conn.close()

    def _make_receiver_preview(receivers: list[str], total: int) -> str:
        if not receivers:
            return ""
        extra = max(total - 1, len(receivers) - 1)
        return receivers[0] if extra == 0 else f"{receivers[0]} 외 {extra}명"

    def _enqueue_sms(payload: dict, created_by: str) -> tuple[str, list[str]]:
        receivers_csv = _normalize_receivers_csv(payload.get("receiver", ""))
        receivers = _receiver_list(receivers_csv)
        if not receivers:
            raise HTTPException(status_code=400, detail="receiver required")
        msg = str(payload.get("msg") or "").strip()
        if not msg:
            raise HTTPException(status_code=400, detail="msg required")

        outbox_id = uuid.uuid4().hex
        conn = get_db()
        try:
            conn.execute(
                """
                INSERT INTO sms_outbox (
                    id, receiver, msg, msg_type, title, rdate, rtime, testmode_yn,
                    sender, created_by, created_at, status
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
                """,
                (
                    outbox_id,
                    receivers_csv,
                    msg,
                    str(payload.get("msg_type") or "SMS"),
                    str(payload.get("title") or ""),
                    str(payload.get("rdate") or ""),
                    str(payload.get("rtime") or ""),
                    "Y" if str(payload.get("testmode_yn") or "").upper() == "Y" else "",
                    str(payload.get("sender") or _sender()),
                    created_by,
                    datetime.now(KST).isoformat(),
                ),
            )
            conn.commit()
        finally:
            conn.close()
        return outbox_id, receivers

    async def _dispatch_outbox_once():
        _ensure_tables()
        conn = get_db()
        try:
            rows = conn.execute(
                """
                SELECT id, receiver, msg, msg_type, title, rdate, rtime, testmode_yn, sender
                FROM sms_outbox
                WHERE status = 'pending'
                ORDER BY created_at ASC
                LIMIT 10
                """
            ).fetchall()
        finally:
            conn.close()

        for row in rows:
            outbox_id = row["id"]
            claim_conn = get_db()
            try:
                current = claim_conn.execute("SELECT status FROM sms_outbox WHERE id = ?", (outbox_id,)).fetchone()
                if not current or current["status"] != "pending":
                    continue
                claim_conn.execute(
                    "UPDATE sms_outbox SET status = 'processing', last_attempted_at = ? WHERE id = ?",
                    (datetime.now(KST).isoformat(), outbox_id),
                )
                claim_conn.commit()
            finally:
                claim_conn.close()

            receivers = _receiver_list(row["receiver"])
            try:
                key, user_id = _creds()
                data = {
                    "key": key,
                    "user_id": user_id,
                    "sender": row["sender"] or _sender(),
                    "receiver": row["receiver"],
                    "msg": row["msg"],
                }
                if row["msg_type"]:
                    data["msg_type"] = row["msg_type"]
                if row["title"]:
                    data["title"] = row["title"]
                if row["rdate"]:
                    data["rdate"] = row["rdate"]
                if row["rtime"]:
                    data["rtime"] = row["rtime"]
                if row["testmode_yn"]:
                    data["testmode_yn"] = row["testmode_yn"]

                result = await _post("/send/", data)
                if int(result.get("result_code", 0) or 0) <= 0:
                    raise HTTPException(status_code=502, detail=result.get("message") or "Failed to send SMS")

                mid = str(result.get("msg_id", ""))
                if mid:
                    _save_history(
                        {
                            "mid": mid,
                            "type": row["msg_type"] or "SMS",
                            "msg": row["msg"],
                            "sender": row["sender"] or _sender(),
                            "sms_count": len(receivers),
                            "fail_count": 0,
                            "reserve_state": "예약대기중" if row["rdate"] else "전송중",
                            "reg_date": datetime.now(KST).strftime("%Y-%m-%d %H:%M:%S"),
                        },
                        receivers,
                    )

                done_conn = get_db()
                try:
                    done_conn.execute(
                        "UPDATE sms_outbox SET status = 'sent', sent_at = ?, error_message = NULL WHERE id = ?",
                        (datetime.now(KST).isoformat(), outbox_id),
                    )
                    done_conn.commit()
                finally:
                    done_conn.close()
            except Exception as exc:
                fail_conn = get_db()
                try:
                    fail_conn.execute(
                        """
                        UPDATE sms_outbox
                        SET status = 'failed',
                            retry_count = COALESCE(retry_count, 0) + 1,
                            error_message = ?,
                            last_attempted_at = ?
                        WHERE id = ?
                        """,
                        (str(exc), datetime.now(KST).isoformat(), outbox_id),
                    )
                    fail_conn.commit()
                finally:
                    fail_conn.close()

    def _dispatcher_loop():
        while not dispatcher_stop.is_set():
            try:
                asyncio.run(_dispatch_outbox_once())
            except Exception:
                pass
            dispatcher_stop.wait(3.0)

    @router.on_event("startup")
    def _startup():
        nonlocal dispatcher_thread
        _ensure_tables()
        if not run_local_dispatcher:
            return
        if dispatcher_thread and dispatcher_thread.is_alive():
            return
        dispatcher_stop.clear()
        dispatcher_thread = threading.Thread(target=_dispatcher_loop, daemon=True, name="sms-outbox-dispatcher")
        dispatcher_thread.start()

    @router.on_event("shutdown")
    def _shutdown():
        dispatcher_stop.set()

    @router.post("/send")
    async def sms_send(payload: dict = Body(...), user: str = Depends(get_current_user)):
        outbox_id, receivers = _enqueue_sms(payload, user)
        return {
            "result_code": 1,
            "queued": True,
            "queue_id": outbox_id,
            "success_cnt": len(receivers),
            "error_cnt": 0,
            "msg_type": str(payload.get("msg_type") or "SMS"),
            "message": "queued",
        }

    @router.post("/internal/request-notify")
    async def sms_internal_request_notify(payload: dict = Body(...), x_internal_token: str | None = Header(None)):
        expected_token = (os.environ.get("REQUEST_SMS_WEBHOOK_TOKEN") or "").strip()
        if expected_token and (x_internal_token or "").strip() != expected_token:
            raise HTTPException(status_code=403, detail="invalid internal token")

        receiver = _normalize_receiver(payload.get("receiver") or payload.get("fallback_receiver") or "")
        if not receiver:
            return {"ok": True, "skipped": True, "reason": "receiver missing"}

        requester_display = (payload.get("requester_display") or "").strip() or "익명"
        assignee_display = (payload.get("assignee_display") or "").strip() or "담당자"
        text = " ".join(str(payload.get("text") or "").split())
        if len(text) > 60:
            text = f"{text[:57]}..."

        queue_id, _ = _enqueue_sms(
            {
                "receiver": receiver,
                "msg": f"[요청알림]\n보낸사람: {requester_display}\n담당자: {assignee_display}\n내용: {text}",
                "msg_type": "LMS",
                "title": "새 요청 알림",
            },
            "internal-request-notify",
        )
        return {"ok": True, "queued": True, "queue_id": queue_id}

    @router.post("/remain")
    async def sms_remain(user: str = Depends(get_current_user)):
        key, user_id = _creds()
        return await _post("/remain/", {"key": key, "user_id": user_id})

    @router.post("/list")
    async def sms_list(payload: dict = Body(default={}), user: str = Depends(get_current_user)):
        receiver_query = _normalize_receiver(payload.get("receiver_query", ""))
        page = int(payload.get("page") or 1)
        page_size = int(payload.get("page_size") or 30)
        start_date = payload.get("start_date", "")
        limit_day = int(payload.get("limit_day") or 30)
        offset = (page - 1) * page_size

        conditions = []
        params: list = []

        if start_date:
            from datetime import datetime as _dt, timedelta

            raw = start_date.replace("-", "")
            try:
                dt = _dt.strptime(raw[:8], "%Y%m%d")
                conditions.append("reg_date >= ?")
                params.append(dt.strftime("%Y-%m-%d"))
                end_dt = dt + timedelta(days=limit_day)
                conditions.append("reg_date < ?")
                params.append(end_dt.strftime("%Y-%m-%d"))
            except Exception:
                pass

        if receiver_query:
            conditions.append("receivers LIKE ?")
            params.append(f"%{receiver_query}%")

        where = ("WHERE " + " AND ".join(conditions)) if conditions else ""

        conn = get_db()
        try:
            total_row = conn.execute(f"SELECT COUNT(*) as cnt FROM sms_history {where}", params).fetchone()
            total_count = int(total_row["cnt"]) if total_row else 0
            rows = conn.execute(
                f"SELECT * FROM sms_history {where} ORDER BY reg_date DESC LIMIT ? OFFSET ?",
                params + [page_size, offset],
            ).fetchall()
        finally:
            conn.close()

        items = []
        for row in rows:
            receivers = json.loads(row["receivers"] or "[]")
            items.append(
                {
                    "mid": row["mid"],
                    "type": row["type"],
                    "msg": row["msg"],
                    "sms_count": row["sms_count"],
                    "fail_count": row["fail_count"],
                    "reserve_state": row["reserve_state"],
                    "reg_date": row["reg_date"],
                    "receiver_preview": _make_receiver_preview(receivers, row["sms_count"] or len(receivers)),
                }
            )

        has_next = (offset + page_size) < total_count
        return {"result_code": 1, "list": items, "next_yn": "Y" if has_next else "N", "total_count": total_count}

    @router.post("/detail")
    async def sms_detail(payload: dict = Body(...), user: str = Depends(get_current_user)):
        mid = payload.get("mid")
        page = int(payload.get("page") or 1)
        page_size = int(payload.get("page_size") or 50)

        conn = get_db()
        try:
            row = conn.execute("SELECT receivers FROM sms_history WHERE mid = ?", (mid,)).fetchone()
        finally:
            conn.close()

        if row and row["receivers"]:
            receivers = json.loads(row["receivers"])
            offset = (page - 1) * page_size
            page_receivers = receivers[offset : offset + page_size]
            items = [{"receiver": r, "sms_state": "조회완료", "send_date": ""} for r in page_receivers]
            return {
                "result_code": 1,
                "list": items,
                "next_yn": "Y" if (offset + page_size) < len(receivers) else "N",
                "total_count": len(receivers),
            }

        key, user_id = _creds()
        data: dict = {"key": key, "user_id": user_id, "mid": mid}
        for field in ("page", "page_size"):
            if payload.get(field) is not None:
                data[field] = payload[field]
        return await _post("/sms_list/", data)

    @router.post("/cancel")
    async def sms_cancel(payload: dict = Body(...), user: str = Depends(get_current_user)):
        key, user_id = _creds()
        result = await _post("/cancel/", {"key": key, "user_id": user_id, "mid": payload.get("mid")})
        if int(result.get("result_code", 0) or 0) > 0:
            mid = payload.get("mid")
            conn = get_db()
            try:
                conn.execute("UPDATE sms_history SET reserve_state = '예약취소' WHERE mid = ?", (mid,))
                conn.commit()
            finally:
                conn.close()
        return result

    @router.post("/migrate")
    async def sms_migrate(payload: dict = Body(default={}), user: str = Depends(get_current_user)):
        key, user_id = _creds()
        from datetime import datetime as _dt, timedelta

        months_back = int(payload.get("months_back") or 3)
        end_dt = _dt.now(KST)
        start_dt = end_dt - timedelta(days=30 * months_back)

        saved = 0
        skipped = 0
        sem = asyncio.Semaphore(5)

        async def _fetch_all_receivers(mid: str) -> list[str]:
            all_receivers: list[str] = []
            page = 1
            while True:
                detail = await _post(
                    "/sms_list/",
                    {"key": key, "user_id": user_id, "mid": mid, "page": page, "page_size": 500},
                )
                for item in detail.get("list", []) or []:
                    r = _normalize_receiver(item.get("receiver", ""))
                    if r and r not in all_receivers:
                        all_receivers.append(r)
                if detail.get("next_yn") != "Y":
                    break
                page += 1
            return all_receivers

        async def _fetch_period(period_start: _dt):
            nonlocal saved, skipped
            page = 1
            while True:
                result = await _post(
                    "/list/",
                    {
                        "key": key,
                        "user_id": user_id,
                        "start_date": period_start.strftime("%Y%m%d"),
                        "limit_day": 30,
                        "page": page,
                        "page_size": 500,
                    },
                )
                items = result.get("list", []) or []
                if not items:
                    break

                async def _process(item):
                    nonlocal saved, skipped
                    mid = item.get("mid")
                    if not mid:
                        return
                    try:
                        async with sem:
                            receivers = await _fetch_all_receivers(mid)
                        _save_history(item, receivers)
                        saved += 1
                    except Exception:
                        skipped += 1

                await asyncio.gather(*[_process(item) for item in items], return_exceptions=True)

                if result.get("next_yn") != "Y":
                    break
                page += 1

        cursor = start_dt
        while cursor < end_dt:
            await _fetch_period(cursor)
            cursor += timedelta(days=30)

        return {"ok": True, "saved": saved, "skipped": skipped}

    return router
