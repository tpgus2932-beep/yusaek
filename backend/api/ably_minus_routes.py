from __future__ import annotations

import httpx
from fastapi import APIRouter, Depends, HTTPException

from services.pastelco_utils import pastelco_login

ABLY_BASE = "https://api.a-bly.com"


def build_ably_minus_router(*, get_current_user):
    router = APIRouter(prefix="/ably-minus")

    def _my_headers(token: str) -> dict:
        return {
            "Authorization": f"JWT {token}",
            "Accept": "application/json",
            "Origin": "https://my.a-bly.com",
            "Referer": "https://my.a-bly.com/",
            "User-Agent": "Mozilla/5.0",
        }

    def _admin_headers(token: str) -> dict:
        return {
            "Authorization": f"JWT {token}",
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Origin": "https://seller-admin.a-bly.com",
            "Referer": "https://seller-admin.a-bly.com/",
            "User-Agent": "Mozilla/5.0",
        }

    async def _fetch_order_items(token: str) -> dict:
        """오출 주문 목록에서 sync_code → 총 ea 맵 반환."""
        sync_map: dict[str, int] = {}
        page = 1
        async with httpx.AsyncClient(timeout=30.0) as client:
            while True:
                res = await client.get(
                    f"{ABLY_BASE}/seller/order_items/",
                    headers=_my_headers(token),
                    params={
                        "processing_status[]": 1,
                        "processing_sub_status[]": 0,
                        "order": "-checked_at",
                        "delivery_type[]": ["standard", "today", "combine", "reserved"],
                        "per_page": 30,
                        "sponsorship_type": -1,
                        "page": page,
                    },
                )
                if res.status_code != 200:
                    break
                data = res.json()
                items = data.get("order_items", [])
                if not items:
                    break
                for item in items:
                    code = item.get("option_stock_sync_code")
                    if not code:
                        continue
                    ea = int(item.get("ea") or 1)
                    sync_map[str(code)] = sync_map.get(str(code), 0) + ea
                max_page = data.get("max_page_number", 1)
                if page >= max_page:
                    break
                page += 1
        return sync_map

    async def _fetch_goods_options(token: str) -> list:
        """오늘배송 상품 옵션 전체 목록 반환."""
        all_opts = []
        page = 1
        async with httpx.AsyncClient(timeout=30.0) as client:
            while True:
                res = await client.get(
                    f"{ABLY_BASE}/seller/today-delivery-goods-options/",
                    headers=_my_headers(token),
                    params={
                        "keyword_type": "goods_name",
                        "current_page": page,
                        "per_page": 50,
                    },
                )
                if res.status_code != 200:
                    break
                data = res.json()
                opts = data.get("data", [])
                if not opts:
                    break
                all_opts.extend(opts)
                max_page = data.get("max_page_number", 1)
                if page >= max_page:
                    break
                page += 1
        return all_opts

    @router.post("/run")
    async def run_minus_stock(user: str = Depends(get_current_user)):
        try:
            token = await pastelco_login()
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"에이블리 로그인 실패: {e}")

        try:
            sync_map = await _fetch_order_items(token)
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"주문 목록 조회 실패: {e}")

        if not sync_map:
            return {"ok": True, "matched": 0, "sync_map_size": 0, "details": [],
                    "message": "오출 주문이 없습니다."}

        try:
            options = await _fetch_goods_options(token)
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"상품 옵션 조회 실패: {e}")

        updates = []
        for opt in options:
            code = opt.get("stock_sync_code")
            if not code or str(code) not in sync_map:
                continue
            ea_total = sync_map[str(code)]
            current_stock = int(opt.get("stock") or 0)
            new_stock = max(0, current_stock - ea_total)
            updates.append({
                "sno": opt["sno"],
                "stock_sync_code": str(code),
                "delivery_type": opt.get("delivery_type", "today"),
                "stock": new_stock,
                "safety_stock": int(opt.get("safety_stock") or 0),
                "use_stock": bool(opt.get("use_stock", False)),
                "is_display": bool(opt.get("is_display", True)),
                "_goods_name": opt.get("goods_name", ""),
                "_option_name": opt.get("option_name", ""),
                "_ea_minus": ea_total,
                "_prev_stock": current_stock,
            })

        if updates:
            patch_payload = [
                {k: v for k, v in u.items() if not k.startswith("_")}
                for u in updates
            ]
            try:
                async with httpx.AsyncClient(timeout=30.0) as client:
                    res = await client.patch(
                        f"{ABLY_BASE}/seller/today-delivery-goods-options/bulk-update/",
                        headers=_admin_headers(token),
                        json={"options": patch_payload},
                    )
                if res.status_code not in (200, 201, 204):
                    raise HTTPException(
                        status_code=502,
                        detail=f"bulk-update 실패 (HTTP {res.status_code}): {res.text[:300]}",
                    )
            except HTTPException:
                raise
            except Exception as e:
                raise HTTPException(status_code=502, detail=f"bulk-update 오류: {e}")

        return {
            "ok": True,
            "matched": len(updates),
            "sync_map_size": len(sync_map),
            "details": updates,
        }

    return router
