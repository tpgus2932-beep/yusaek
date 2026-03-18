from __future__ import annotations

import os

import httpx
from fastapi import APIRouter, Body, Depends, HTTPException

ALIGO_BASE = "https://apis.aligo.in"


def build_sms_router(*, get_current_user):
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

    async def _history_matches_receiver(mid: str | None, receiver_query: str) -> bool:
        if not mid:
            return False
        normalized_query = _normalize_receiver(receiver_query)
        if not normalized_query:
            return True

        page = 1
        while page <= 20:
            key, user_id = _creds()
            detail = await _post(
                "/sms_list/",
                {"key": key, "user_id": user_id, "mid": mid, "page": page, "page_size": 500},
            )
            for item in detail.get("list", []) or []:
                receiver = _normalize_receiver(item.get("receiver", ""))
                if normalized_query in receiver:
                    return True
            if detail.get("next_yn") != "Y":
                break
            page += 1
        return False

    async def _history_receiver_preview(mid: str | None) -> str:
        if not mid:
            return ""
        key, user_id = _creds()
        detail = await _post(
            "/sms_list/",
            {"key": key, "user_id": user_id, "mid": mid, "page": 1, "page_size": 10},
        )
        receivers: list[str] = []
        for item in detail.get("list", []) or []:
            receiver = _normalize_receiver(item.get("receiver", ""))
            if receiver and receiver not in receivers:
                receivers.append(receiver)
        if not receivers:
            return ""
        if len(receivers) == 1:
            return receivers[0]
        extra = max(int(detail.get("total_count", 0) or 0) - 1, len(receivers) - 1)
        return f"{receivers[0]} 외 {extra}명"

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
        return await _post("/send/", data)

    @router.post("/remain")
    async def sms_remain(user: str = Depends(get_current_user)):
        key, user_id = _creds()
        return await _post("/remain/", {"key": key, "user_id": user_id})

    @router.post("/list")
    async def sms_list(payload: dict = Body(default={}), user: str = Depends(get_current_user)):
        key, user_id = _creds()
        data: dict = {"key": key, "user_id": user_id}
        receiver_query = payload.get("receiver_query", "")
        for field in ("page", "page_size", "start_date", "limit_day"):
            if payload.get(field) is not None:
                data[field] = payload[field]
        result = await _post("/list/", data)
        for item in result.get("list", []) or []:
            item["receiver_preview"] = await _history_receiver_preview(item.get("mid"))

        normalized_query = _normalize_receiver(receiver_query)
        if not normalized_query:
            return result

        filtered = []
        for item in result.get("list", []) or []:
            if await _history_matches_receiver(item.get("mid"), normalized_query):
                filtered.append(item)
        result["list"] = filtered
        result["next_yn"] = "N"
        return result

    @router.post("/detail")
    async def sms_detail(payload: dict = Body(...), user: str = Depends(get_current_user)):
        key, user_id = _creds()
        data: dict = {"key": key, "user_id": user_id, "mid": payload.get("mid")}
        for field in ("page", "page_size"):
            if payload.get(field) is not None:
                data[field] = payload[field]
        return await _post("/sms_list/", data)

    @router.post("/cancel")
    async def sms_cancel(payload: dict = Body(...), user: str = Depends(get_current_user)):
        key, user_id = _creds()
        return await _post("/cancel/", {"key": key, "user_id": user_id, "mid": payload.get("mid")})

    return router
