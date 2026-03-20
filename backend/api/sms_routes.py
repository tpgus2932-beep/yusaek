from __future__ import annotations

import asyncio
import json
import os
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, Body, Depends, HTTPException

ALIGO_BASE = "https://apis.aligo.in"


def build_sms_router(*, get_current_user, get_db):
    router = APIRouter(prefix="/sms")

    def _normalize_receiver(value: str) -> str:
        return "".join(ch for ch in str(value or "") if ch.isdigit())

    def _creds():
        key = os.environ.get("ALIGO_API_KEY", "")
        user_id = os.environ.get("ALIGO_USER_ID", "")
        if not key or not user_id:
            raise HTTPException(
                status_code=500,
                detail="ALIGO_API_KEY / ALIGO_USER_ID 환경변수가 설정되지 않았습니다.",
            )
        return key, user_id

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

    async def _fetch_all_receivers(mid: str) -> list[str]:
        """해당 mid의 전체 수신번호를 페이지네이션으로 모두 가져온다."""
        key, user_id = _creds()
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

    def _save_to_db(item: dict, receivers: list[str]):
        """sms_history 테이블에 저장 (이미 있으면 상태 업데이트)."""
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
                    item.get("sender", os.environ.get("ALIGO_SENDER", "")),
                    int(item.get("sms_count") or 0),
                    int(item.get("fail_count") or 0),
                    item.get("reserve_state"),
                    item.get("reg_date"),
                    json.dumps(receivers, ensure_ascii=False),
                    datetime.now(timezone.utc).isoformat(),
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

    @router.post("/send")
    async def sms_send(payload: dict = Body(...), user: str = Depends(get_current_user)):
        key, user_id = _creds()
        sender = os.environ.get("ALIGO_SENDER", "")
        if not (payload.get("sender") or sender):
            raise HTTPException(status_code=500, detail="ALIGO_SENDER 환경변수가 설정되지 않았습니다.")
        data: dict = {
            "key": key,
            "user_id": user_id,
            "sender": payload.get("sender") or sender,
            "receiver": payload.get("receiver", ""),
            "msg": payload.get("msg", ""),
        }
        for field in ("msg_type", "title", "rdate", "rtime", "testmode_yn"):
            if payload.get(field):
                data[field] = payload[field]

        result = await _post("/send/", data)

        # 발송 성공 시 로컬 DB에 저장
        if result.get("result_code", 0) > 0:
            mid = str(result.get("msg_id", ""))
            receivers = [_normalize_receiver(r) for r in str(payload.get("receiver", "")).split(",") if r.strip()]
            receivers = [r for r in receivers if r]
            if mid:
                _save_to_db(
                    {
                        "mid": mid,
                        "type": payload.get("msg_type", "SMS"),
                        "msg": payload.get("msg", ""),
                        "sender": data["sender"],
                        "sms_count": len(receivers),
                        "fail_count": 0,
                        "reserve_state": "전송중" if not payload.get("rdate") else "예약대기중",
                        "reg_date": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
                    },
                    receivers,
                )

        return result

    @router.post("/remain")
    async def sms_remain(user: str = Depends(get_current_user)):
        key, user_id = _creds()
        return await _post("/remain/", {"key": key, "user_id": user_id})

    @router.post("/list")
    async def sms_list(payload: dict = Body(default={}), user: str = Depends(get_current_user)):
        """로컬 DB에서 전송내역 조회."""
        receiver_query = _normalize_receiver(payload.get("receiver_query", ""))
        page = int(payload.get("page") or 1)
        page_size = int(payload.get("page_size") or 30)
        start_date = payload.get("start_date", "")
        limit_day = int(payload.get("limit_day") or 30)
        offset = (page - 1) * page_size

        conditions = []
        params: list = []

        if start_date:
            conditions.append("reg_date >= ?")
            params.append(start_date)
            # limit_day 적용: start_date 기준 limit_day일 이후까지
            from datetime import datetime as _dt, timedelta
            try:
                end_dt = _dt.strptime(start_date[:10], "%Y-%m-%d") + timedelta(days=limit_day)
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
            total_row = conn.execute(
                f"SELECT COUNT(*) as cnt FROM sms_history {where}", params
            ).fetchone()
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
            items.append({
                "mid": row["mid"],
                "type": row["type"],
                "msg": row["msg"],
                "sms_count": row["sms_count"],
                "fail_count": row["fail_count"],
                "reserve_state": row["reserve_state"],
                "reg_date": row["reg_date"],
                "receiver_preview": _make_receiver_preview(receivers, row["sms_count"] or len(receivers)),
            })

        has_next = (offset + page_size) < total_count
        return {
            "result_code": 1,
            "list": items,
            "next_yn": "Y" if has_next else "N",
            "total_count": total_count,
        }

    @router.post("/detail")
    async def sms_detail(payload: dict = Body(...), user: str = Depends(get_current_user)):
        """로컬 DB의 receivers 우선, 없으면 Aligo에서 가져온다."""
        mid = payload.get("mid")
        page = int(payload.get("page") or 1)
        page_size = int(payload.get("page_size") or 50)

        # 로컬 DB에서 수신번호 확인
        conn = get_db()
        try:
            row = conn.execute("SELECT receivers FROM sms_history WHERE mid = ?", (mid,)).fetchone()
        finally:
            conn.close()

        if row and row["receivers"]:
            receivers = json.loads(row["receivers"])
            offset = (page - 1) * page_size
            page_receivers = receivers[offset:offset + page_size]
            items = [{"receiver": r, "sms_state": "조회완료", "send_date": ""} for r in page_receivers]
            return {
                "result_code": 1,
                "list": items,
                "next_yn": "Y" if (offset + page_size) < len(receivers) else "N",
                "total_count": len(receivers),
            }

        # 로컬에 없으면 Aligo 직접 조회
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
        # 취소 성공 시 로컬 DB 상태 업데이트
        if result.get("result_code", 0) > 0:
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
        """Aligo 전체 내역을 로컬 DB로 마이그레이션한다."""
        key, user_id = _creds()

        # 기간: start_date ~ start_date+limit_day 씩 반복
        # payload: { months_back: 6 } 또는 { start_date: "20240101", end_date: "20241231" }
        from datetime import datetime as _dt, timedelta

        months_back = int(payload.get("months_back") or 3)
        end_dt = _dt.now()
        start_dt = end_dt - timedelta(days=30 * months_back)

        saved = 0
        skipped = 0
        sem = asyncio.Semaphore(5)  # 동시 5개 제한

        async def _fetch_period(period_start: _dt):
            nonlocal saved, skipped
            page = 1
            while True:
                result = await _post("/list/", {
                    "key": key,
                    "user_id": user_id,
                    "start_date": period_start.strftime("%Y%m%d"),
                    "limit_day": 30,
                    "page": page,
                    "page_size": 500,
                })
                items = result.get("list", []) or []
                if not items:
                    break

                async def _process(item):
                    nonlocal saved, skipped
                    mid = item.get("mid")
                    if not mid:
                        return
                    async with sem:
                        receivers = await _fetch_all_receivers(mid)
                    _save_to_db(item, receivers)
                    saved += 1

                await asyncio.gather(*[_process(item) for item in items])

                if result.get("next_yn") != "Y":
                    break
                page += 1

        # 30일씩 나눠서 순서대로 처리
        cursor = start_dt
        while cursor < end_dt:
            await _fetch_period(cursor)
            cursor += timedelta(days=30)

        return {"ok": True, "saved": saved, "skipped": skipped}

    return router
