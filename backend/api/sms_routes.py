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

    async def _fetch_receivers(mid: str | None) -> tuple[list[str], int]:
        """해당 mid의 수신번호 목록과 총 건수를 반환한다 (첫 페이지 50건)."""
        if not mid:
            return [], 0
        key, user_id = _creds()
        detail = await _post(
            "/sms_list/",
            {"key": key, "user_id": user_id, "mid": mid, "page": 1, "page_size": 50},
        )
        receivers: list[str] = []
        for item in detail.get("list", []) or []:
            r = _normalize_receiver(item.get("receiver", ""))
            if r and r not in receivers:
                receivers.append(r)
        total = int(detail.get("total_count") or 0)
        return receivers, total

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
        normalized_query = _normalize_receiver(receiver_query)

        filtered = []
        for item in result.get("list", []) or []:
            receivers, total = await _fetch_receivers(item.get("mid"))

            # receiver_preview 설정
            if receivers:
                extra = max(total - 1, len(receivers) - 1)
                item["receiver_preview"] = receivers[0] if extra == 0 else f"{receivers[0]} 외 {extra}명"
            else:
                item["receiver_preview"] = ""

            # 수신번호 필터링 (같은 데이터로 판단)
            if normalized_query:
                if any(normalized_query in r for r in receivers):
                    filtered.append(item)
            else:
                filtered.append(item)

        if normalized_query:
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
