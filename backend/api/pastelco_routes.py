from __future__ import annotations

import asyncio
from collections import defaultdict

import httpx
from fastapi import APIRouter, Depends, HTTPException

from services.pastelco_utils import (
    pastelco_login,
    pastelco_fetch_all_orders,
    _pastelco_headers,
)


def build_pastelco_router(*, get_current_user):
    router = APIRouter(prefix="/pastelco")

    @router.post("/issue-hbl")
    async def issue_hbl(user=Depends(get_current_user)):
        try:
            token = await pastelco_login()
        except Exception as e:
            return {"ok": False, "error": f"로그인 실패: {e}"}

        try:
            items = await pastelco_fetch_all_orders(token)
        except Exception as e:
            return {"ok": False, "error": f"주문 조회 실패: {e}"}

        # 주문번호 기준으로 그룹화
        order_groups: dict[int, list] = defaultdict(list)
        for item in items:
            order_id = (item.get("order") or {}).get("id")
            if order_id:
                order_groups[order_id].append(item)

        needs_issue: list[dict] = []   # {"order_id": ..., "line_item_ids": [...]}
        needs_delete: list[int] = []   # hbl id 목록 (삭제 필요)
        skipped = 0

        for order_id, group in order_groups.items():
            hbl_ids = {
                item["ably_pantos_hbl"]["id"]
                for item in group
                if item.get("ably_pantos_hbl")
            }
            line_item_ids = [item["id"] for item in group]

            if not hbl_ids:
                # 선적바코드 없음 → 발급 필요
                needs_issue.append({"order_id": order_id, "line_item_ids": line_item_ids})
            elif len(hbl_ids) > 1:
                # 같은 주문에 다른 바코드가 섞여 있음 → 삭제 후 재발급
                needs_delete.extend(hbl_ids)
                needs_issue.append({"order_id": order_id, "line_item_ids": line_item_ids})
            else:
                # hbl_ids == 1 이지만 일부 item에 HBL 없는지 확인
                has_unissued = any(not item.get("ably_pantos_hbl") for item in group)
                if has_unissued:
                    # 기존 HBL 삭제 후 전체 line item으로 재발급
                    needs_delete.extend(hbl_ids)
                    needs_issue.append({"order_id": order_id, "line_item_ids": line_item_ids})
                else:
                    # 모든 item이 동일 HBL → 정상, 스킵
                    skipped += 1

        # 충돌 HBL 삭제
        deleted = 0
        delete_errors = []
        async with httpx.AsyncClient(timeout=15.0) as client:
            for hbl_id in needs_delete:
                try:
                    res = await client.delete(
                        f"https://api.pastelco.jp/seller/orders/combined-packages/mapping/",
                        headers=_pastelco_headers(token),
                        params={"hbl_ids": hbl_id},
                    )
                    if res.status_code in (200, 204):
                        deleted += 1
                    else:
                        delete_errors.append(f"hbl_id={hbl_id} 삭제 실패 (HTTP {res.status_code})")
                except Exception as e:
                    delete_errors.append(f"hbl_id={hbl_id} 삭제 오류: {e}")

        # 선적바코드 일괄 발급
        issued = 0
        issue_errors = []
        if needs_issue:
            groups_payload = [
                {"order_line_item_ids": g["line_item_ids"]}
                for g in needs_issue
            ]
            try:
                async with httpx.AsyncClient(timeout=30.0) as client:
                    res = await client.post(
                        f"https://api.pastelco.jp/seller/orders/combined-packages/",
                        headers=_pastelco_headers(token),
                        json={"order_line_item_groups": groups_payload},
                    )
                if res.status_code in (200, 201):
                    issued = len(needs_issue)
                else:
                    issue_errors.append(f"발급 실패 (HTTP {res.status_code}): {res.text[:200]}")
            except Exception as e:
                issue_errors.append(f"발급 오류: {e}")

        errors = delete_errors + issue_errors
        return {
            "ok": not errors,
            "total_orders": len(order_groups),
            "issued": issued,
            "skipped": skipped,
            "deleted": deleted,
            "errors": errors,
        }

    return router
