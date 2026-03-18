from __future__ import annotations

import os

import httpx
from fastapi import APIRouter, Body, Depends, HTTPException

ALIGO_BASE = "https://apis.aligo.in"


def build_sms_router(*, get_current_user):
    router = APIRouter(prefix="/sms")

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
        for field in ("page", "page_size", "start_date", "limit_day"):
            if payload.get(field) is not None:
                data[field] = payload[field]
        return await _post("/list/", data)

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
