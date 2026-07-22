from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter, Depends

from services.delivery_anomaly_logic import evaluate_return_anomaly, is_invoice_missing, latest_movement, parse_llogis_scan_date
from services.exchange_return_anomaly_store import sync_anomalies

try:
    from sdk.ably import AblyClient
    from sdk.llogis import LLogisClient
except ModuleNotFoundError:  # package import in unit tests
    from backend.sdk.ably import AblyClient
    from backend.sdk.llogis import LLogisClient

_KST = timezone(timedelta(hours=9))

_LAST_RUN_SETTING_KEY = "exchange_return_anomaly_last_run_date"

# 교환건은 status=4(수거완료)로 바뀐 뒤 별도 액션 없이 오래 머물 수 있으므로
# 넉넉하게 60일 범위를 조회한다.
_LOOKBACK_DAYS = 60


def build_exchange_return_anomaly_router(*, get_current_user, get_db, get_setting, set_setting):
    router = APIRouter(prefix="/exchange-return-anomaly")

    @router.get("/list")
    def list_anomalies(user: str = Depends(get_current_user)):
        conn = get_db()
        rows = conn.execute("SELECT * FROM exchange_return_anomalies").fetchall()
        conn.close()
        # 최종스캔일 내림차순 - 스캔일을 알 수 없는 건(송장 자체를 못 찾은 경우)은 맨 뒤로
        rows = sorted(rows, key=lambda r: parse_llogis_scan_date(r["scan_date"]) or date.min, reverse=True)
        return {
            "lastRunAt": get_setting(_LAST_RUN_SETTING_KEY) or None,
            "items": [
                {
                    "id": r["id"],
                    "exchangeSno": r["exchange_sno"],
                    "orderNo": r["order_no"],
                    "productName": r["product_name"],
                    "optionInfo": r["option_info"],
                    "phone": r["phone"],
                    "receivedAt": r["received_at"],
                    "returnInvoiceNo": r["return_invoice_no"],
                    "status": r["status"],
                    "location": r["location"],
                    "scanDate": r["scan_date"],
                    "reason": r["reason"],
                    "detectedAt": r["detected_at"],
                }
                for r in rows
            ]
        }

    @router.post("/run")
    async def run_check(force: bool = False, user: str = Depends(get_current_user)):
        today_str = datetime.now(_KST).strftime("%Y-%m-%d")
        last_run = get_setting(_LAST_RUN_SETTING_KEY)
        if str(last_run or "")[:10] == today_str and not force:
            return list_anomalies(user=user)  # 오늘 이미 실행됨 - 재조회 없이 현재 목록만 반환

        end_date = datetime.now(_KST).strftime("%Y-%m-%d")
        start_date = (datetime.now(_KST) - timedelta(days=_LOOKBACK_DAYS)).strftime("%Y-%m-%d")

        ably = AblyClient()
        exchanges = await ably.list_exchanges(status=4, start_date=start_date, end_date=end_date)

        llogis = LLogisClient()
        today = datetime.now(_KST).date()
        computed: dict[str, dict] = {}
        for ex in exchanges:
            return_delivery = ex.get("return_delivery") or {}
            inv_no = str(return_delivery.get("invoice_number") or "").strip()
            if not inv_no:
                continue

            items_list = ex.get("exchange_items") or []
            first = items_list[0] if items_list else {}
            order_item = first.get("order_item") or {}
            option_values = (order_item.get("original_goods_option") or {}).get("option_values") or []
            member = ex.get("member") or {}

            try:
                llogis_raw = await llogis.query_raw(inv_no)
            except Exception:
                continue

            reason = evaluate_return_anomaly(today, llogis_raw)
            if not reason:
                continue

            if is_invoice_missing(llogis_raw):
                status, location, scan_date = "-", "-", "-"
            else:
                latest = latest_movement(llogis_raw) or {}
                status = latest.get("paclStatNm") or "-"
                location = latest.get("scanBrshNm") or "-"
                scan_date = latest.get("rgstYmd") or "-"

            exchange_sno = str(ex.get("exchange_sno") or ex.get("sno") or "")
            if not exchange_sno:
                continue
            computed[exchange_sno] = {
                "order_no": str(ex.get("order_sno") or ""),
                "product_name": order_item.get("goods_name") or "",
                "option_info": " / ".join(str(v) for v in option_values),
                "phone": member.get("contact") or "",
                "received_at": ex.get("received_at") or "",
                "return_invoice_no": inv_no,
                "status": status,
                "location": location,
                "scan_date": scan_date,
                "reason": reason,
            }

        conn = get_db()
        sync_anomalies(conn, computed)
        conn.close()
        set_setting(_LAST_RUN_SETTING_KEY, datetime.now(_KST).isoformat())

        return list_anomalies(user=user)

    return router
