from __future__ import annotations

import json
from datetime import datetime, timedelta

from fastapi import APIRouter, Body, Depends, HTTPException

from sdk import config as ez_config
from sdk.ably import AblyClient
from sdk.ezadmin import (
    EzAdminClient,
    EzAdminSessionExpired,
    EzDeskSessionExpired,
    extract_sms_rows,
    normalize_sms_row,
)
from services.delivery_anomaly_logic import latest_reply_after, parse_ezdesk_time

_TEMPLATE_NAME = "배송후취소 확인문자"
_LOOKBACK_DAYS = 30


def _build_message(template_msg: str, product_names: list[str]) -> str:
    unique_names = sorted(dict.fromkeys(n for n in product_names if n))
    return template_msg.replace("{상품}", ", ".join(unique_names))


def build_post_shipment_cancel_stock_sms_router(*, get_current_user, get_setting, get_db):
    router = APIRouter(prefix="/post-shipment-cancel-stock-sms")

    def _load_template_msg() -> str | None:
        conn = get_db()
        try:
            row = conn.execute(
                "SELECT msg FROM sms_templates WHERE name = ?", (_TEMPLATE_NAME,)
            ).fetchone()
        finally:
            conn.close()
        return row["msg"] if row else None

    def _already_reviewed_snos() -> set[str]:
        conn = get_db()
        try:
            rows = conn.execute("SELECT cancel_sno FROM post_shipment_cancel_stock_review").fetchall()
        finally:
            conn.close()
        return {row["cancel_sno"] for row in rows}

    def _save_review(username: str, cancel_sno: str, order_sno: str, buyer_tel: str,
                      product_names: list[str], action: str, error: str | None = None):
        conn = get_db()
        try:
            conn.execute(
                "INSERT OR IGNORE INTO post_shipment_cancel_stock_review "
                "(created_at, username, cancel_sno, order_sno, buyer_tel, product_names, action, error) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    datetime.now().isoformat(), username, cancel_sno, order_sno, buyer_tel,
                    json.dumps(product_names, ensure_ascii=False), action, error,
                ),
            )
            conn.commit()
        finally:
            conn.close()

    @router.post("/check")
    async def check(user: str = Depends(get_current_user)):
        template_msg = _load_template_msg()
        if not template_msg:
            raise HTTPException(
                status_code=400,
                detail=f"'{_TEMPLATE_NAME}' 템플릿이 없습니다. SMS 탭에서 먼저 만들어주세요.",
            )

        end_date = datetime.now().strftime("%Y-%m-%d")
        start_date = (datetime.now() - timedelta(days=_LOOKBACK_DAYS)).strftime("%Y-%m-%d")

        ably = AblyClient()
        try:
            cancels = await ably.list_order_cancels(
                cancel_type="cancel", processing_sub_status=["41", "42"],
                start_date=start_date, end_date=end_date,
            )
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"에이블리 배송후취소 목록 조회 실패: {exc}")

        reviewed = _already_reviewed_snos()
        pending: list[dict] = []
        for cancel in cancels:
            cancel_sno = str(cancel.get("sno") or "")
            if not cancel_sno or cancel_sno in reviewed:
                continue
            items = cancel.get("order_items") or []
            codes = sorted({
                str(it.get("option_stock_sync_code") or "").strip()
                for it in items if str(it.get("option_stock_sync_code") or "").strip()
            })
            if not codes:
                continue
            buyer_tel = ""
            for it in items:
                buyer_tel = str(it.get("buyer_tel") or it.get("receiver_tel") or "").strip()
                if buyer_tel:
                    break
            product_names = sorted({
                f"{name}({option})" if (option := str(it.get("option_info") or "").strip()) else name
                for it in items
                if (name := str(it.get("goods_name") or "").strip())
            })
            order_sno = str((items[0].get("order_sno") if items else "") or "")
            item_snos = [it.get("sno") for it in items if it.get("sno")]
            pending.append({
                "cancel_sno": cancel_sno,
                "order_sno": order_sno,
                "buyer_tel": buyer_tel,
                "product_names": product_names,
                "codes": codes,
                "item_snos": item_snos,
            })

        if not pending:
            return {"ok": True, "with_stock": [], "no_stock": [], "checked_orders": 0}

        all_codes = sorted({code for p in pending for code in p["codes"]})
        ez = EzAdminClient(get_setting)
        try:
            stock_by_code = await ez.get_stock_for_codes(all_codes)
        except EzAdminSessionExpired:
            return {"ok": False, "need_ezadmin_session": True}
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"이지어드민 재고 조회 실패: {exc}")

        with_stock: list[dict] = []
        no_stock: list[dict] = []
        for p in pending:
            has_stock = any(stock_by_code.get(code, 0) > 0 for code in p["codes"])
            del p["codes"]
            if has_stock:
                p["message"] = _build_message(template_msg, p["product_names"])
                with_stock.append(p)
            else:
                no_stock.append(p)

        return {
            "ok": True,
            "with_stock": with_stock,
            "no_stock": no_stock,
            "checked_orders": len(pending),
        }

    @router.post("/send")
    async def send(payload: dict = Body(...), user: str = Depends(get_current_user)):
        with_stock = payload.get("with_stock") or []
        no_stock = payload.get("no_stock") or []

        template_msg = _load_template_msg()
        if not template_msg:
            raise HTTPException(
                status_code=400,
                detail=f"'{_TEMPLATE_NAME}' 템플릿이 없습니다. SMS 탭에서 먼저 만들어주세요.",
            )

        reviewed = _already_reviewed_snos()
        ez = EzAdminClient(get_setting)
        ably = AblyClient()

        sms_sent: list[dict] = []
        completed: list[dict] = []
        failed: list[dict] = []
        need_ezdesk_session = False

        for p in with_stock:
            cancel_sno = str(p.get("cancel_sno") or "")
            if not cancel_sno or cancel_sno in reviewed:
                continue
            order_sno = str(p.get("order_sno") or "")
            buyer_tel = str(p.get("buyer_tel") or "")
            product_names = p.get("product_names") or []
            row = {"cancel_sno": cancel_sno, "order_sno": order_sno, "buyer_tel": buyer_tel, "product_names": product_names}

            if not buyer_tel:
                failed.append({**row, "reason": "구매자 연락처 없음"})
                continue

            msg = _build_message(template_msg, product_names)
            try:
                await ez.send_sms(buyer_tel, ez_config.EZDESK_SMS_SENDER, msg)
            except EzDeskSessionExpired:
                need_ezdesk_session = True
                failed.append({**row, "reason": "EZDesk 세션 만료"})
                continue
            except Exception as exc:
                failed.append({**row, "reason": str(exc)})
                continue

            _save_review(user, cancel_sno, order_sno, buyer_tel, product_names, "sms_sent")
            sms_sent.append(row)

        for p in no_stock:
            cancel_sno = str(p.get("cancel_sno") or "")
            if not cancel_sno or cancel_sno in reviewed:
                continue
            order_sno = str(p.get("order_sno") or "")
            buyer_tel = str(p.get("buyer_tel") or "")
            product_names = p.get("product_names") or []
            item_snos = [s for s in (p.get("item_snos") or []) if s]
            row = {"cancel_sno": cancel_sno, "order_sno": order_sno, "buyer_tel": buyer_tel, "product_names": product_names}

            if not item_snos:
                failed.append({**row, "reason": "승인할 주문상품 정보 없음"})
                continue

            try:
                await ably.confirm_order_items(item_snos)
            except Exception as exc:
                failed.append({**row, "reason": f"에이블리 취소 승인 실패: {exc}"})
                continue

            _save_review(user, cancel_sno, order_sno, buyer_tel, product_names, "completed")
            completed.append(row)

        return {
            "ok": True,
            "sms_sent": sms_sent,
            "completed": completed,
            "failed": failed,
            "need_ezdesk_session": need_ezdesk_session,
        }

    @router.get("/logs")
    def logs(limit: int = 200, user: str = Depends(get_current_user)):
        if limit <= 0 or limit > 1000:
            limit = 200
        conn = get_db()
        try:
            rows = conn.execute(
                "SELECT id, created_at, username, cancel_sno, order_sno, buyer_tel, product_names, "
                "action, error, reply_content, reply_at, closed_at "
                "FROM post_shipment_cancel_stock_review ORDER BY id DESC LIMIT ?",
                (limit,),
            ).fetchall()
        finally:
            conn.close()
        items = []
        for row in rows:
            item = dict(row)
            try:
                item["product_names"] = json.loads(item.get("product_names") or "[]")
            except (TypeError, ValueError):
                item["product_names"] = []
            items.append(item)
        return {"ok": True, "items": items}

    @router.post("/check-replies")
    async def check_replies(user: str = Depends(get_current_user)):
        conn = get_db()
        try:
            rows = conn.execute(
                "SELECT cancel_sno, buyer_tel, created_at FROM post_shipment_cancel_stock_review "
                "WHERE action = 'sms_sent' AND closed_at = '' ORDER BY id DESC"
            ).fetchall()
        finally:
            conn.close()
        if not rows:
            return {"ok": True, "updated": [], "checked": 0, "need_ezdesk_session": False}

        ez = EzAdminClient(get_setting)
        updated: list[dict] = []
        need_ezdesk_session = False
        conn = get_db()
        try:
            for row in rows:
                phone = str(row["buyer_tel"] or "").strip()
                since = parse_ezdesk_time(row["created_at"])
                if not phone or since is None:
                    continue
                try:
                    chat = await ez.sms_chat_detail(phone, ez_config.EZDESK_SMS_SENDER)
                except EzDeskSessionExpired:
                    need_ezdesk_session = True
                    break
                except Exception:
                    continue
                normalized = [normalize_sms_row(r) for r in extract_sms_rows(chat)]
                reply = latest_reply_after(normalized, since)
                if not reply:
                    continue
                conn.execute(
                    "UPDATE post_shipment_cancel_stock_review SET reply_content = ?, reply_at = ? "
                    "WHERE cancel_sno = ?",
                    (reply["content"], reply["input_time"], row["cancel_sno"]),
                )
                updated.append({
                    "cancel_sno": row["cancel_sno"],
                    "reply_content": reply["content"],
                    "reply_at": reply["input_time"],
                })
            conn.commit()
        finally:
            conn.close()

        return {
            "ok": True,
            "updated": updated,
            "checked": len(rows),
            "need_ezdesk_session": need_ezdesk_session,
        }

    @router.post("/close")
    def close(payload: dict = Body(...), user: str = Depends(get_current_user)):
        cancel_sno = str(payload.get("cancel_sno") or "").strip()
        if not cancel_sno:
            raise HTTPException(status_code=400, detail="cancel_sno is required")
        conn = get_db()
        try:
            conn.execute(
                "UPDATE post_shipment_cancel_stock_review SET closed_at = ? WHERE cancel_sno = ?",
                (datetime.now().isoformat(), cancel_sno),
            )
            conn.commit()
        finally:
            conn.close()
        return {"ok": True, "cancel_sno": cancel_sno}

    return router
