from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Body, Depends, HTTPException

from sdk import config as ez_config
from sdk.ably import AblyClient
from sdk.ezadmin import EzAdminClient, EzAdminSessionExpired, EzDeskSessionExpired
from services.client_cancel_soldout_utils import (
    build_soldout_message,
    filter_matching_order_items,
    group_items_by_order_sno,
    search_cost_base_products,
)

_SOLDOUT_TEMPLATE_NAME = "품절 문자"


def _parse_products(products: list[dict]) -> tuple[dict[str, str], dict[str, str], dict[str, str]]:
    """products: [{name, options: [{code, product_id, label}]}] →
    (code→name, code→product_id, code→label)."""
    option_code_to_name: dict[str, str] = {}
    option_code_to_product_id: dict[str, str] = {}
    option_code_to_label: dict[str, str] = {}
    for product in products:
        name = str(product.get("name") or "").strip()
        for option in product.get("options") or []:
            code = str(option.get("code") or "").strip()
            if not code:
                continue
            if name:
                option_code_to_name[code] = name
            product_id = str(option.get("product_id") or "").strip()
            if product_id:
                option_code_to_product_id[code] = product_id
            label = str(option.get("label") or "").strip()
            if label:
                option_code_to_label[code] = label
    return option_code_to_name, option_code_to_product_id, option_code_to_label


def _product_summaries(products: list[dict], option_code_to_label: dict[str, str]) -> list[dict]:
    """로그용 상품 요약: [{name, options: [{code, label}]}]."""
    summaries = []
    for product in products:
        name = str(product.get("name") or "").strip()
        if not name:
            continue
        options = [
            {"code": str(o.get("code") or "").strip(), "label": option_code_to_label.get(str(o.get("code") or "").strip(), "")}
            for o in (product.get("options") or [])
            if str(o.get("code") or "").strip()
        ]
        summaries.append({"name": name, "options": options})
    return summaries


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

    def _save_log(username: str, action: str, summary: dict):
        conn = get_db()
        try:
            conn.execute(
                "INSERT INTO client_cancel_soldout_logs (created_at, username, action, summary_json) "
                "VALUES (?, ?, ?, ?)",
                (datetime.now().isoformat(), username, action, json.dumps(summary, ensure_ascii=False)),
            )
            conn.commit()
        finally:
            conn.close()

    @router.get("/cost-base/search")
    def cost_base_search(q: str = "", limit: int = 20, user: str = Depends(get_current_user)):
        if limit <= 0 or limit > 100:
            limit = 20
        items = search_cost_base_products(cost_base_path, q, limit=limit)
        return {"ok": True, "items": items}

    @router.get("/pending-count")
    async def pending_count(product_id: str = "", user: str = Depends(get_current_user)):
        """상품코드 하나로 EZAdmin I100 잔여 접수 수량만 확인 (테스트/단건 조회용)."""
        code = product_id.strip()
        if not code:
            raise HTTPException(status_code=400, detail="product_id가 필요합니다.")

        ez = EzAdminClient(get_setting)
        try:
            remaining = await ez.get_pending_order_count(code)
        except EzAdminSessionExpired:
            raise HTTPException(status_code=409, detail="EZAdmin 세션이 만료되었습니다.")
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc))
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"접수 조회 실패: {exc}")

        return {"ok": True, "product_id": code, "remaining": remaining}

    @router.post("/delist")
    async def delist(payload: dict = Body(...), user: str = Depends(get_current_user)):
        """선택한 옵션만 미진열 처리 (주문 검색/취소, 문자 발송 없이).

        stop-selling은 goods_option_sno(=원가베이스유 옵션번호)만 있으면
        되므로, 대상 주문을 찾을 필요 없이 옵션 코드만으로 바로 처리한다.
        """
        products = payload.get("products") or []
        option_code_to_name, _, option_code_to_label = _parse_products(products)
        if not option_code_to_name:
            raise HTTPException(status_code=400, detail="미진열 처리할 옵션이 없습니다.")

        non_display_snos: list[int] = []
        for code in option_code_to_name:
            try:
                non_display_snos.append(int(code))
            except ValueError:
                continue

        ably = AblyClient()
        try:
            await ably.stop_selling(non_display_option_snos=non_display_snos, soldout_goods_snos=[])
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"미진열 처리 실패: {exc}")

        _save_log(user, "delist", {
            "products": _product_summaries(products, option_code_to_label),
            "non_display_option_count": len(non_display_snos),
        })

        return {"ok": True, "non_display_option_count": len(non_display_snos)}

    @router.post("/run")
    async def run(payload: dict = Body(...), user: str = Depends(get_current_user)):
        products = payload.get("products") or []
        option_code_to_name, option_code_to_product_id, option_code_to_label = _parse_products(products)
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
            item_details = [
                {
                    "name": option_code_to_name.get(str(item.get("option_stock_sync_code") or ""), item.get("goods_name", "")),
                    "option_info": item.get("option_info", ""),
                    "ea": item.get("ea"),
                }
                for item in items
            ]
            cancelled.append({
                "order_sno": order_sno,
                "buyer_name": refund_info.get("buyer_name"),
                "buyer_tel": refund_info.get("buyer_tel"),
                "product_names": names,
                "items": item_details,
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

        pending_counts: list[dict] = []
        need_ezadmin_session = False
        for product_id in sorted(set(option_code_to_product_id.values())):
            try:
                remaining = await ez.get_pending_order_count(product_id)
                pending_counts.append({"product_id": product_id, "remaining": remaining})
            except EzAdminSessionExpired:
                need_ezadmin_session = True
                pending_counts.append({"product_id": product_id, "remaining": None, "error": "EZAdmin 세션 만료"})
            except Exception as exc:
                pending_counts.append({"product_id": product_id, "remaining": None, "error": str(exc)})

        _save_log(user, "run", {
            "products": _product_summaries(products, option_code_to_label),
            "cancelled_orders": cancelled,
            "failed_orders": failed,
            "non_display_option_count": len(non_display_snos),
            "soldout_goods_count": len(soldout_snos),
        })

        return {
            "ok": True,
            "cancelled_orders": cancelled,
            "failed_orders": failed,
            "non_display_option_count": len(non_display_snos),
            "soldout_goods_count": len(soldout_snos),
            "need_ezdesk_session": need_ezdesk_session,
            "need_ezadmin_session": need_ezadmin_session,
            "pending_counts": pending_counts,
        }

    @router.get("/logs")
    def logs(limit: int = 100, user: str = Depends(get_current_user)):
        if limit <= 0 or limit > 500:
            limit = 100
        conn = get_db()
        try:
            rows = conn.execute(
                "SELECT id, created_at, username, action, summary_json "
                "FROM client_cancel_soldout_logs ORDER BY id DESC LIMIT ?",
                (limit,),
            ).fetchall()
        finally:
            conn.close()
        items = [
            {
                "id": row["id"],
                "created_at": row["created_at"],
                "username": row["username"],
                "action": row["action"],
                "summary": json.loads(row["summary_json"]),
            }
            for row in rows
        ]
        return {"ok": True, "items": items}

    return router
