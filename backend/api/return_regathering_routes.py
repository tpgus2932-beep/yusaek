from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Body, Depends, HTTPException

try:
    from sdk import config
    from sdk.ezadmin import EzAdminClient, EzAdminSessionExpired, EzDeskSessionExpired
except ModuleNotFoundError:  # package import in unit tests
    from backend.sdk import config
    from backend.sdk.ezadmin import EzAdminClient, EzAdminSessionExpired, EzDeskSessionExpired

try:
    from api.returns_routes import _remove_return_queue_ids
except ModuleNotFoundError:
    from backend.api.returns_routes import _remove_return_queue_ids

_EZADMIN_SESSION_KEY = "ezadmin_phpsessid"
_TEMPLATE_NAME = "반품 오회수"


def build_return_regathering_router(
    *,
    get_current_user,
    get_return_state,
    get_shared_db,
    get_setting,
    return_queue_payload,
):
    router = APIRouter(prefix="/return-regathering")

    def _clean_phone(raw) -> str:
        return "".join(ch for ch in str(raw or "") if ch.isdigit())

    @router.get("/list")
    def list_regathering(user: str = Depends(get_current_user)):
        conn = get_shared_db()
        try:
            rows = conn.execute(
                "SELECT * FROM return_regathering ORDER BY requested_at DESC"
            ).fetchall()
        finally:
            conn.close()
        return {"items": [dict(r) for r in rows]}

    @router.post("/execute")
    async def execute_regathering(
        payload: dict = Body(...),
        user: str = Depends(get_current_user),
    ):
        items = payload.get("items", [])
        if not items:
            raise HTTPException(status_code=400, detail="선택된 항목이 없습니다.")

        phpsessid = (get_setting(_EZADMIN_SESSION_KEY) or "").strip()
        if not phpsessid:
            return {"ok": False, "need_session": True}

        conn = get_shared_db()
        try:
            tmpl = conn.execute(
                "SELECT msg FROM sms_templates WHERE name = ?", (_TEMPLATE_NAME,)
            ).fetchone()
        finally:
            conn.close()
        if not tmpl or not tmpl["msg"]:
            raise HTTPException(
                status_code=400,
                detail=f'"{_TEMPLATE_NAME}" 템플릿을 찾을 수 없습니다. 사이드메뉴 문자 발송에서 만들어주세요.',
            )
        template_msg = tmpl["msg"]

        state = get_return_state(user)
        ez = EzAdminClient(get_setting)

        results = []
        moved_ids = set()
        session_expired = False
        for item in items:
            if session_expired:
                break
            item_id = item.get("id")
            invoice = str(item.get("match") or "").strip()
            result = {"id": item_id, "invoice": invoice, "ok": False, "error": None}
            phone = _clean_phone(item.get("buyer_tel"))
            try:
                if not invoice:
                    raise ValueError("송장번호(invoice) 없음")
                await ez.register_return_pickup(invoice)

                if not phone:
                    raise ValueError("전화번호 없음")
                await ez.send_sms(phone, config.EZDESK_SMS_SENDER, template_msg)

                conn = get_shared_db()
                try:
                    conn.execute(
                        """INSERT INTO return_regathering
                           (invoice, order_no, item_sno, request_no, buyer_tel, goods_name, option_raw, requested_by, requested_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                        (
                            invoice,
                            str(item.get("order_no") or ""),
                            str(item.get("item_sno") or ""),
                            str(item.get("request_no") or ""),
                            phone,
                            str(item.get("goods_name") or ""),
                            str(item.get("option_raw") or ""),
                            user,
                            datetime.now(timezone.utc).isoformat(),
                        ),
                    )
                    conn.commit()
                finally:
                    conn.close()

                result["ok"] = True
                moved_ids.add(item_id)
            except EzDeskSessionExpired:
                result["error"] = "이지데스크 세션 만료"
                session_expired = True
            except EzAdminSessionExpired as e:
                result["error"] = f"이지어드민 세션 만료: {e}"
            except Exception as e:
                result["error"] = str(e)[:200]
            results.append(result)

        if moved_ids:
            _remove_return_queue_ids(state, moved_ids)

        response = {"ok": True, "results": results, "queues": return_queue_payload(state)}
        if session_expired:
            response["need_ezdesk_session"] = True
        return response

    @router.post("/{regathering_id}/complete")
    def complete_regathering(regathering_id: int, user: str = Depends(get_current_user)):
        conn = get_shared_db()
        try:
            conn.execute("DELETE FROM return_regathering WHERE id = ?", (regathering_id,))
            conn.commit()
        finally:
            conn.close()
        return {"ok": True}

    return router
