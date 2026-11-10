from __future__ import annotations

from fastapi import APIRouter, Body, Depends, HTTPException

from services import supplies


def build_supplies_router(*, get_current_user, get_db):
    router = APIRouter(prefix="/supplies")

    @router.get("/stock")
    def get_stock(user: str = Depends(get_current_user)):
        return {"ok": True, "items": supplies.get_state(get_db)}

    @router.put("/stock")
    def put_stock(payload: dict = Body(...), user: str = Depends(get_current_user)):
        """stock: {"0": 1000, "1": 500, ...} 종류별 현재 재고를 직접 입력."""
        try:
            supplies.set_stock(get_db, payload.get("stock") or {})
        except ValueError:
            raise HTTPException(status_code=400, detail="수량은 숫자로 입력해 주세요.")
        return {"ok": True, "items": supplies.get_state(get_db)}

    return router
