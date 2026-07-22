from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Body, Depends, HTTPException

from sdk import config as ez_config
from sdk.ably import AblyClient
from sdk.ezadmin import EzAdminClient, EzDeskSessionExpired
from services.client_cancel_soldout_utils import (
    build_soldout_message,
    filter_matching_order_items,
    group_items_by_order_sno,
    search_cost_base_products,
)

_SOLDOUT_TEMPLATE_NAME = "품절 문자"


def build_client_cancel_soldout_router(*, get_current_user, get_setting, get_db, cost_base_path: Path):
    router = APIRouter(prefix="/client-cancel-soldout")

    def _load_soldout_template_msg() -> str | None:
        conn = get_db()
        try:
            row = conn.execute(
                "SELECT msg FROM sms_templates WHERE name = ?", (_SOLDOUT_TEMPLATE_NAME,)
            ).fetchone()
        finally:
            conn.close()
        return row["msg"] if row else None

    @router.get("/cost-base/search")
    def cost_base_search(q: str = "", limit: int = 20, user: str = Depends(get_current_user)):
        if limit <= 0 or limit > 100:
            limit = 20
        items = search_cost_base_products(cost_base_path, q, limit=limit)
        return {"ok": True, "items": items}

    @router.post("/run")
    async def run(payload: dict = Body(...), user: str = Depends(get_current_user)):
        products = payload.get("products") or []
        option_code_to_name: dict[str, str] = {}
        for product in products:
            name = str(product.get("name") or "").strip()
            if not name:
                continue
            for code in product.get("option_codes") or []:
                code = str(code).strip()
                if code:
                    option_code_to_name[code] = name
        if not option_code_to_name:
            raise HTTPException(status_code=400, detail="취소할 상품/옵션이 없습니다.")

        template_msg = _load_soldout_template_msg()
        if not template_msg:
            raise HTTPException(
                status_code=400,
                detail=f"'{_SOLDOUT_TEMPLATE_NAME}' 템플릿이 없습니다. SMS 탭에서 먼저 만들어주세요.",
            )

        ably = AblyClient()
        failed: list[dict] = []
        matched_items: list[dict] = []

        product_names = sorted({str(p.get("name") or "").strip() for p in products if p.get("name")})
        for name in product_names:
            try:
                items = await ably.search_order_items_by_goods_name(name)
            except Exception as exc:
                failed.append({"order_sno": None, "product_name": name, "stage": "search", "reason": str(exc)})
                continue
            matched_items.extend(filter_matching_order_items(items, set(option_code_to_name)))

        order_items_by_sno = group_items_by_order_sno(matched_items)

        cancelled: list[dict] = []
        non_display_snos: set[int] = set()
        soldout_snos: set[int] = set()

        for order_sno, items in order_items_by_sno.items():
            try:
                refund_info = await ably.get_order_refund_info(order_sno)
            except Exception as exc:
                failed.append({"order_sno": order_sno, "stage": "order_lookup", "reason": str(exc)})
                continue

            sno_list = [item["sno"] for item in items]
            try:
                cancel_res = await ably.cancel_order_items(
                    order_sno, sno_list,
                    refund_bank_account_holder=refund_info["refund_bank_account_holder"],
                    refund_bank_account_number=refund_info["refund_bank_account_number"],
                    refund_bank_sno=refund_info["refund_bank_sno"],
                )
            except Exception as exc:
                failed.append({"order_sno": order_sno, "stage": "cancel", "reason": str(exc)})
                continue

            for opt in cancel_res.get("need_to_be_non_display_option_list") or []:
                sno = opt.get("goods_option_sno")
                if sno is not None:
                    non_display_snos.add(sno)
            for goods in cancel_res.get("need_to_be_soldout_goods_list") or []:
                sno = goods.get("goods_sno")
                if sno is not None:
                    soldout_snos.add(sno)

            names = [
                option_code_to_name.get(str(item.get("option_stock_sync_code") or ""), item.get("goods_name", ""))
                for item in items
            ]
            cancelled.append({
                "order_sno": order_sno,
                "buyer_tel": refund_info.get("buyer_tel"),
                "product_names": names,
            })

        if non_display_snos or soldout_snos:
            try:
                await ably.stop_selling(
                    non_display_option_snos=list(non_display_snos),
                    soldout_goods_snos=list(soldout_snos),
                )
            except Exception as exc:
                for order in cancelled:
                    order.setdefault("warnings", []).append(f"미진열 반영 실패: {exc}")

        ez = EzAdminClient(get_setting)
        need_ezdesk_session = False
        for order in cancelled:
            phone = order.get("buyer_tel")
            if not phone:
                order["sms_sent"] = False
                order["sms_error"] = "구매자 연락처 없음"
                continue
            msg = build_soldout_message(template_msg, order["product_names"])
            try:
                await ez.send_sms(phone, ez_config.EZDESK_SMS_SENDER, msg)
                order["sms_sent"] = True
            except EzDeskSessionExpired:
                order["sms_sent"] = False
                need_ezdesk_session = True
            except Exception as exc:
                order["sms_sent"] = False
                order["sms_error"] = str(exc)

        return {
            "ok": True,
            "cancelled_orders": cancelled,
            "failed_orders": failed,
            "non_display_option_count": len(non_display_snos),
            "soldout_goods_count": len(soldout_snos),
            "need_ezdesk_session": need_ezdesk_session,
        }

    return router
