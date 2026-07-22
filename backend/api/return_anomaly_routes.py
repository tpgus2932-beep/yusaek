from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter, Depends

from services.delivery_anomaly_logic import evaluate_return_scan_delay, is_invoice_missing, latest_movement, parse_llogis_scan_date
from services.return_anomaly_store import sync_anomalies

try:
    from sdk.ably import AblyClient
    from sdk.llogis import LLogisClient
except ModuleNotFoundError:  # package import in unit tests
    from backend.sdk.ably import AblyClient
    from backend.sdk.llogis import LLogisClient

_KST = timezone(timedelta(hours=9))

_LAST_RUN_SETTING_KEY = "return_anomaly_last_run_date"

# 반품접수 후 오래 방치될 수 있으므로 넉넉하게 60일 범위를 조회한다.
_LOOKBACK_DAYS = 60


def build_return_anomaly_router(*, get_current_user, get_db, get_setting, set_setting):
    router = APIRouter(prefix="/return-anomaly")

    @router.get("/list")
    def list_anomalies(user: str = Depends(get_current_user)):
        conn = get_db()
        rows = conn.execute("SELECT * FROM return_anomalies").fetchall()
        conn.close()
        # 최종스캔일 내림차순 - 스캔일을 알 수 없는 건은 맨 뒤로
        rows = sorted(rows, key=lambda r: parse_llogis_scan_date(r["scan_date"]) or date.min, reverse=True)
        return {
            "lastRunAt": get_setting(_LAST_RUN_SETTING_KEY) or None,
            "items": [
                {
                    "id": r["id"],
                    "returnInvoiceNo": r["return_invoice_no"],
                    "originInvoiceNo": r["origin_invoice_no"],
                    "orderNo": r["order_no"],
                    "productName": r["product_name"],
                    "optionInfo": r["option_info"],
                    "phone": r["phone"],
                    "requestedAt": r["requested_at"],
                    "status": r["status"],
                    "location": r["location"],
                    "scanDate": r["scan_date"],
                    "reason": r["reason"],
                    "detectedAt": r["detected_at"],
                }
                for r in rows
            ]
        }

    async def _run_check_core(force: bool = False) -> None:
        today_str = datetime.now(_KST).strftime("%Y-%m-%d")
        last_run = get_setting(_LAST_RUN_SETTING_KEY)
        if str(last_run or "")[:10] == today_str and not force:
            return  # 오늘 이미 실행됨 - 재조회 없이 종료

        end_date = datetime.now(_KST).strftime("%Y-%m-%d")
        start_date = (datetime.now(_KST) - timedelta(days=_LOOKBACK_DAYS)).strftime("%Y-%m-%d")

        ably = AblyClient()
        cancels = await ably.list_order_cancels(cancel_type="return", start_date=start_date, end_date=end_date)

        llogis = LLogisClient()
        today = datetime.now(_KST).date()
        computed: dict[str, dict] = {}
        seen_origin_invoices: set[str] = set()

        for cancel in cancels:
            for raw in cancel.get("order_items", []):
                origin_inv = str(raw.get("invoice") or "").strip()
                if not origin_inv or origin_inv in seen_origin_invoices:
                    continue
                seen_origin_invoices.add(origin_inv)

                try:
                    origin_raw = await llogis.query_raw(origin_inv)
                except Exception:
                    continue
                if is_invoice_missing(origin_raw):
                    continue  # 원송장 조회 불가 - 판단 불가하므로 제외

                return_relations = [
                    r for r in (origin_raw.get("rltnInvList") or [])
                    if str(r.get("wkSctCd") or "") == "02"
                ]
                if not return_relations:
                    continue  # 아직 반송장이 생성되지 않음 - 제외

                for relation in return_relations:
                    rtn_no = str(relation.get("rltnInvNo") or "").strip()
                    if not rtn_no:
                        continue
                    rtn_no_view = str(relation.get("rltnInvNoView") or rtn_no).strip()

                    try:
                        rtn_raw = await llogis.query_raw(rtn_no)
                    except Exception:
                        continue
                    if is_invoice_missing(rtn_raw):
                        continue  # 반송장 자체 조회 불가 - 제외

                    reason = evaluate_return_scan_delay(today, rtn_raw)
                    if not reason:
                        continue  # 최종스캔 3일 미만 - 정상

                    latest = latest_movement(rtn_raw) or {}
                    computed[rtn_no_view] = {
                        "origin_invoice_no": origin_inv,
                        "order_no": str(raw.get("order_sno") or ""),
                        "product_name": raw.get("goods_name") or "",
                        "option_info": raw.get("option_info") or "",
                        "phone": str(raw.get("buyer_tel") or raw.get("receiver_tel") or ""),
                        "requested_at": raw.get("cancel_received_at") or cancel.get("cancel_received_at") or "",
                        "status": latest.get("paclStatNm") or "-",
                        "location": latest.get("scanBrshNm") or "-",
                        "scan_date": latest.get("rgstYmd") or "-",
                        "reason": reason,
                    }

        conn = get_db()
        sync_anomalies(conn, computed)
        conn.close()
        set_setting(_LAST_RUN_SETTING_KEY, datetime.now(_KST).isoformat())

    @router.post("/run")
    async def run_check(force: bool = False, user: str = Depends(get_current_user)):
        await _run_check_core(force=force)
        return list_anomalies(user=user)

    router.run_scheduled = _run_check_core
    return router
