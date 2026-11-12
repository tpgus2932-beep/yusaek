from __future__ import annotations

import asyncio
import json
import re
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
from services import ezadmin_orders as ezo
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
                      product_names: list[str], action: str, item_snos: list | None = None,
                      error: str | None = None):
        conn = get_db()
        try:
            conn.execute(
                "INSERT OR IGNORE INTO post_shipment_cancel_stock_review "
                "(created_at, username, cancel_sno, order_sno, buyer_tel, product_names, action, item_snos, error) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    datetime.now().isoformat(), username, cancel_sno, order_sno, buyer_tel,
                    json.dumps(product_names, ensure_ascii=False), action,
                    json.dumps(item_snos or [], ensure_ascii=False), error,
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
            item_snos = [s for s in (p.get("item_snos") or []) if s]
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

            _save_review(user, cancel_sno, order_sno, buyer_tel, product_names, "sms_sent", item_snos)
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
                "action, error, reply_content, reply_at, closed_at, sent_reply_content, sent_reply_at "
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
    async def close(payload: dict = Body(...), user: str = Depends(get_current_user)):
        """완료 버튼 - 고객 답장을 확인한 뒤, 실제 에이블리 취소 승인까지 처리하고 목록에서 내린다."""
        cancel_sno = str(payload.get("cancel_sno") or "").strip()
        if not cancel_sno:
            raise HTTPException(status_code=400, detail="cancel_sno is required")

        conn = get_db()
        try:
            row = conn.execute(
                "SELECT item_snos FROM post_shipment_cancel_stock_review WHERE cancel_sno = ?",
                (cancel_sno,),
            ).fetchone()
        finally:
            conn.close()
        if row is None:
            raise HTTPException(status_code=404, detail="발송내역을 찾을 수 없습니다")

        try:
            item_snos = [s for s in json.loads(row["item_snos"] or "[]") if s]
        except (TypeError, ValueError):
            item_snos = []
        if not item_snos:
            raise HTTPException(
                status_code=400,
                detail="승인할 주문상품 정보가 없습니다. 에이블리에서 직접 취소 승인해주세요.",
            )

        ably = AblyClient()
        try:
            await ably.confirm_order_items(item_snos)
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"에이블리 취소 승인 실패: {exc}")

        conn = get_db()
        try:
            conn.execute(
                "UPDATE post_shipment_cancel_stock_review SET action = 'completed', closed_at = ? "
                "WHERE cancel_sno = ?",
                (datetime.now().isoformat(), cancel_sno),
            )
            conn.commit()
        finally:
            conn.close()
        return {"ok": True, "cancel_sno": cancel_sno}

    def _ezadmin_keyword(phone: str) -> str:
        """이지어드민에는 휴대폰 번호가 하이픈 형태(010-1234-5678)로 저장돼 있다."""
        digits = re.sub(r"\D", "", phone or "")
        if not re.fullmatch(r"01\d{8,9}", digits):
            raise HTTPException(status_code=400, detail="휴대폰 번호를 정확히 입력해 주세요. (예: 010-1234-5678)")
        return f"{digits[:3]}-{digits[3:-4]}-{digits[-4:]}"

    def _load_pending_row(cancel_sno: str):
        conn = get_db()
        try:
            row = conn.execute(
                "SELECT buyer_tel, order_sno, action, closed_at, stock_items FROM post_shipment_cancel_stock_review WHERE cancel_sno = ?",
                (cancel_sno,),
            ).fetchone()
        finally:
            conn.close()
        if row is None:
            raise HTTPException(status_code=404, detail="발송내역을 찾을 수 없습니다")
        if row["closed_at"]:
            raise HTTPException(status_code=409, detail="이미 처리 완료된 건입니다")
        return row

    @router.post("/withdraw/candidates")
    async def withdraw_candidates(payload: dict = Body(...), user: str = Depends(get_current_user)):
        """취소철회 대상 고르기 - 구매자 전화번호로 이지어드민 C/S 주문(합포) 목록을 불러온다.
        한 고객이 여러 주문을 했을 수 있어, 어떤 주문을 철회할지는 화면에서 사용자가 고른다."""
        cancel_sno = str(payload.get("cancel_sno") or "").strip()
        if not cancel_sno:
            raise HTTPException(status_code=400, detail="cancel_sno is required")
        row = _load_pending_row(cancel_sno)
        keyword = _ezadmin_keyword(str(payload.get("phone") or row["buyer_tel"] or ""))
        phpsessid = (get_setting("ezadmin_phpsessid") or "").strip()
        if not phpsessid:
            return {"ok": False, "need_ezadmin_session": True}
        try:
            cells = (await ezo.search_packs(phpsessid, keyword, days=30, rows=20, search_type="6"))[:10]
            details = await asyncio.gather(*(ezo.pack_rows(phpsessid, c["pack"]) for c in cells))
        except ezo.SessionExpired:
            return {"ok": False, "need_ezadmin_session": True}
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"이지어드민 조회 실패: {exc}")
        packs = [ezo.describe_pack(c["pack"], c, rows, "") for c, rows in zip(cells, details)]
        packs.sort(key=lambda p: p["collect_date"], reverse=True)
        return {"ok": True, "phone": keyword, "packs": packs}

    @router.post("/withdraw")
    async def withdraw(payload: dict = Body(...), user: str = Depends(get_current_user)):
        """취소철회 및 송장출력 - 에이블리 취소철회 → 이지어드민 보류해제·전체정상복귀 → 송장출력 → 배송확인.
        이지어드민 주문(pack)은 /withdraw/candidates 목록에서 사용자가 고른 것만 처리한다.
        에이블리 철회는 되돌릴 수 없으므로 맨 앞에서 한 번만 하고, 이후 단계가 실패하면 같은 버튼으로
        이어서 재시도한다(이미 철회된 건은 에이블리 단계를 건너뜀)."""
        cancel_sno = str(payload.get("cancel_sno") or "").strip()
        if not cancel_sno:
            raise HTTPException(status_code=400, detail="cancel_sno is required")
        pack = str(payload.get("pack") or "").strip()
        if not re.fullmatch(r"\d{1,12}", pack):
            raise HTTPException(status_code=400, detail="철회할 이지어드민 주문을 선택해 주세요")
        row = _load_pending_row(cancel_sno)
        keyword = _ezadmin_keyword(str(payload.get("phone") or row["buyer_tel"] or ""))

        phpsessid = (get_setting("ezadmin_phpsessid") or "").strip()
        if not phpsessid:
            return {"ok": False, "need_ezadmin_session": True}

        # 에이블리를 건드리기 전에, 고른 pack이 이 전화번호의 실제 주문인지 이지어드민에서 다시 확인한다.
        try:
            cell = next(
                (c for c in await ezo.search_packs(phpsessid, keyword, days=30, rows=20, search_type="6")
                 if str(c.get("pack")) == pack),
                None,
            )
        except ezo.SessionExpired:
            return {"ok": False, "need_ezadmin_session": True}
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"이지어드민 조회 실패: {exc}")
        if cell is None:
            raise HTTPException(status_code=404, detail="선택한 주문을 이지어드민에서 찾지 못했습니다. 목록을 다시 불러와 주세요.")

        ably = AblyClient()  # 한 요청 안에서 재사용해 로그인을 한 번만 한다

        # 오늘출발 재고 차감용 (옵션코드, 수량). 철회하면 취소 목록에서 사라지므로 철회 전에 한 번 읽어 저장해 둔다.
        try:
            stock_items = json.loads(row["stock_items"] or "[]")
        except (TypeError, ValueError):
            stock_items = []
        if not stock_items and row["action"] != "withdrawn":
            try:
                end = datetime.now().strftime("%Y-%m-%d")
                start = (datetime.now() - timedelta(days=_LOOKBACK_DAYS)).strftime("%Y-%m-%d")
                cancels = await ably.list_order_cancels(
                    cancel_type="cancel", processing_sub_status=["41", "42"], start_date=start, end_date=end,
                )
            except Exception as exc:
                raise HTTPException(status_code=502, detail=f"에이블리 취소 상품 조회 실패: {exc}")
            cancel = next((c for c in cancels if str(c.get("sno")) == cancel_sno), None)
            if cancel is None:
                # 취소를 철회했다가 다시 접수되면 취소 접수번호가 새로 생긴다. 같은 주문의 진행 중 취소가
                # 정확히 한 건일 때만 그 번호로 이어서 처리한다.
                order_sno = str(row["order_sno"] or "").strip()

                def _order_ids(c: dict) -> set[str]:
                    return {
                        str(v) for it in (c.get("order_items") or [])
                        for v in (it.get("order_sno"), it.get("order_id")) if v
                    }

                same_order = [c for c in cancels if order_sno and order_sno in _order_ids(c)]
                if len(same_order) != 1:
                    raise HTTPException(
                        status_code=404,
                        detail="에이블리 취소 목록에서 이 건을 찾지 못했습니다. 에이블리에서 이미 처리됐는지 확인해주세요.",
                    )
                cancel = same_order[0]
                new_sno = str(cancel.get("sno") or "")
                conn = get_db()
                try:
                    exists = conn.execute(
                        "SELECT 1 FROM post_shipment_cancel_stock_review WHERE cancel_sno = ?", (new_sno,)
                    ).fetchone()
                    if exists:
                        raise HTTPException(status_code=409, detail=f"취소 접수번호 {new_sno}는 이미 다른 발송내역에 있습니다.")
                    conn.execute(
                        "UPDATE post_shipment_cancel_stock_review SET cancel_sno = ? WHERE cancel_sno = ?",
                        (new_sno, cancel_sno),
                    )
                    conn.commit()
                finally:
                    conn.close()
                cancel_sno = new_sno
            qty_by_code: dict[str, int] = {}
            for it in cancel.get("order_items") or []:
                code = str(it.get("option_stock_sync_code") or "").strip()
                if code:
                    qty_by_code[code] = qty_by_code.get(code, 0) + int(it.get("ea") or it.get("quantity") or 1)
            stock_items = [{"code": c, "ea": n} for c, n in qty_by_code.items()]
            conn = get_db()
            try:
                conn.execute(
                    "UPDATE post_shipment_cancel_stock_review SET stock_items = ? WHERE cancel_sno = ?",
                    (json.dumps(stock_items, ensure_ascii=False), cancel_sno),
                )
                conn.commit()
            finally:
                conn.close()

        steps: list[str] = []
        if row["action"] != "withdrawn":
            try:
                await ably.withdraw_order_cancel(cancel_sno)
            except NotImplementedError as exc:
                raise HTTPException(status_code=501, detail=str(exc))
            except Exception as exc:
                raise HTTPException(status_code=502, detail=f"에이블리 취소철회 실패: {exc}")
            conn = get_db()
            try:
                conn.execute(
                    "UPDATE post_shipment_cancel_stock_review SET action = 'withdrawn' WHERE cancel_sno = ?",
                    (cancel_sno,),
                )
                conn.commit()
            finally:
                conn.close()
            steps.append("에이블리 취소철회")

        def ez_ok(result) -> bool:
            return isinstance(result, dict) and str(result.get("error", "")) in ("0", "")

        def fail(stage: str, detail: str):
            raise HTTPException(
                status_code=502,
                detail=f"{stage} 실패: {detail} (완료된 단계: {', '.join(steps) or '없음'}) - 같은 버튼으로 이어서 재시도할 수 있습니다.",
            )

        try:
            if str(cell.get("hold", "") or "0") != "0":
                result = await ezo.release_hold(phpsessid, pack)
                if not ez_ok(result):
                    fail("보류해제", str(result))
                steps.append("보류해제")
            if str(cell.get("order_cs", "") or "0").split(",")[0] != "0":
                result = await ezo.normal_pack(phpsessid, pack)
                if not ez_ok(result):
                    fail("전체정상복귀", str(result))
                steps.append("전체정상복귀")

            printed = await ezo.print_invoice(phpsessid, pack)
            html = await ezo.fetch_print_html(phpsessid, printed["url"])
            steps.append("송장출력")
            result = await ezo.confirm_trans(phpsessid, pack)
            if not ez_ok(result):
                fail("배송확인", str(result))
            steps.append("배송확인")
        except ezo.SessionExpired:
            return {"ok": False, "need_ezadmin_session": True}
        except HTTPException:
            raise
        except Exception as exc:
            fail("이지어드민 처리", str(exc))

        conn = get_db()
        try:
            conn.execute(
                "UPDATE post_shipment_cancel_stock_review SET action = 'completed', closed_at = ? WHERE cancel_sno = ?",
                (datetime.now().isoformat(), cancel_sno),
            )
            conn.commit()
        finally:
            conn.close()
        # 오늘출발 재고 차감 - 철회·출력·배송확인이 끝난 뒤에 하고, 실패해도 위 처리는 되돌리지 않는다.
        stock_minus: list[dict] = []
        stock_minus_error = ""
        stock_skipped: list[dict] = []
        if stock_items:
            try:
                changed = await ably.decrease_today_delivery_stock({i["code"]: int(i["ea"]) for i in stock_items})
                stock_minus = [
                    {"code": u["stock_sync_code"], "ea": u["_ea_minus"], "prev": u["_prev_stock"], "stock": u["stock"]}
                    for u in changed
                ]
                if changed:
                    steps.append("오늘출발 재고 차감")
                done = {u["stock_sync_code"] for u in changed}
                for i in stock_items:
                    if i["code"] not in done:
                        stock_skipped.append({"code": i["code"], "ea": int(i["ea"]), "reason": "오늘출발 옵션 목록에 없음 (오늘출발 상품이 아니거나 재고연동코드 불일치)"})
                for u in changed:
                    if u["_prev_stock"] <= 0:
                        stock_skipped.append({"code": u["stock_sync_code"], "ea": u["_ea_minus"], "reason": "오늘출발 재고가 이미 0 (더 내릴 재고 없음)"})
            except Exception as exc:
                stock_minus_error = str(exc)
        else:
            stock_skipped.append({"code": "", "ea": 0, "reason": "주문상품에 재고연동코드(옵션코드)가 없어 차감 대상을 찾지 못함"})
        return {
            "ok": True, "cancel_sno": cancel_sno, "pack": pack, "steps": steps, "html": html,
            "trans_corp": printed["trans_corp"], "trans_no": printed["trans_no"],
            "stock_minus": stock_minus, "stock_minus_error": stock_minus_error,
            "stock_skipped": stock_skipped,
        }

    @router.post("/reply")
    async def reply(payload: dict = Body(...), user: str = Depends(get_current_user)):
        """발송내역 목록에서 고객에게 바로 답장 문자를 보낸다."""
        cancel_sno = str(payload.get("cancel_sno") or "").strip()
        message = str(payload.get("message") or "").strip()
        if not cancel_sno:
            raise HTTPException(status_code=400, detail="cancel_sno is required")
        if not message:
            raise HTTPException(status_code=400, detail="메시지를 입력하세요")

        conn = get_db()
        try:
            row = conn.execute(
                "SELECT buyer_tel FROM post_shipment_cancel_stock_review WHERE cancel_sno = ?",
                (cancel_sno,),
            ).fetchone()
        finally:
            conn.close()
        if row is None:
            raise HTTPException(status_code=404, detail="발송내역을 찾을 수 없습니다")
        buyer_tel = str(row["buyer_tel"] or "").strip()
        if not buyer_tel:
            raise HTTPException(status_code=400, detail="구매자 연락처가 없습니다")

        ez = EzAdminClient(get_setting)
        try:
            await ez.send_sms(buyer_tel, ez_config.EZDESK_SMS_SENDER, message)
        except EzDeskSessionExpired:
            return {"ok": False, "need_ezdesk_session": True}
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"답장 발송 실패: {exc}")

        # 보낸 답장을 저장해 목록에 표시한다 (가장 최근에 보낸 답장 기준).
        sent_at = datetime.now().isoformat(timespec="seconds")
        conn = get_db()
        try:
            conn.execute(
                "UPDATE post_shipment_cancel_stock_review SET sent_reply_content = ?, sent_reply_at = ? "
                "WHERE cancel_sno = ?",
                (message, sent_at, cancel_sno),
            )
            conn.commit()
        finally:
            conn.close()

        return {"ok": True, "cancel_sno": cancel_sno, "sent_reply_content": message, "sent_reply_at": sent_at}

    @router.post("/delete")
    def delete(payload: dict = Body(...), user: str = Depends(get_current_user)):
        """웹 화면 밖에서(에이블리 등에서 직접) 이미 처리한 건을 발송내역 목록에서만 지운다
        (실제 에이블리 취소 승인은 여기서 하지 않음)."""
        cancel_sno = str(payload.get("cancel_sno") or "").strip()
        if not cancel_sno:
            raise HTTPException(status_code=400, detail="cancel_sno is required")
        conn = get_db()
        try:
            conn.execute("DELETE FROM post_shipment_cancel_stock_review WHERE cancel_sno = ?", (cancel_sno,))
            conn.commit()
        finally:
            conn.close()
        return {"ok": True, "cancel_sno": cancel_sno}

    return router
