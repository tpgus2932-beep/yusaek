from __future__ import annotations

import asyncio
import calendar
import re
import uuid
from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException

from services.delivery_anomaly_logic import (
    evaluate_exchange_redelivery_anomaly,
    evaluate_return_anomaly,
    is_invoice_missing,
    latest_movement,
    parse_ably_sent_date,
    parse_llogis_scan_date,
)
from services.exchange_return_anomaly_store import sync_anomalies
from services.ezadmin_stock_log import fetch_ezadmin_stock_logs

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

_EZADMIN_SESSION_KEY = "ezadmin_phpsessid"


def _add_one_month(d: date) -> date:
    """한 달 뒤 같은 날짜 (9/26 -> 10/26, 1/31 -> 2/28)."""
    year, month = (d.year + 1, 1) if d.month == 12 else (d.year, d.month + 1)
    return date(year, month, min(d.day, calendar.monthrange(year, month)[1]))


def _invoice_in_reason(invoice: str, reason: str) -> bool:
    """사유에 원송장번호가 부분문자열로 들어있는지 (대시/공백 표기 차이는 무시)."""
    inv = invoice.strip()
    if not inv:
        return False
    if inv in reason:
        return True
    digits = re.sub(r"\D", "", inv)
    return len(digits) >= 8 and digits in re.sub(r"[\s-]", "", reason)


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
                    "kind": r["kind"],
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
                "kind": "return",
            }

        # 재배송(출고완료, status=5) 건도 같은 검사에 합친다: 재배송 시작일(shipped_at)로부터
        # 주말 제외 3일 이상 지났는데 llogis에서 실제 이동 이력이 안 잡히면 이상현상.
        redelivery_exchanges = await ably.list_exchanges(status=5, start_date=start_date, end_date=end_date)
        for ex in redelivery_exchanges:
            exchange_delivery = ex.get("exchange_delivery") or {}
            inv_no = str(exchange_delivery.get("invoice_number") or "").strip()
            if not inv_no:
                continue

            shipped_date = parse_ably_sent_date(ex.get("shipped_at"))

            items_list = ex.get("exchange_items") or []
            first = items_list[0] if items_list else {}
            order_item = first.get("order_item") or {}
            option_values = (order_item.get("original_goods_option") or {}).get("option_values") or []
            member = ex.get("member") or {}

            try:
                llogis_raw = await llogis.query_raw(inv_no)
            except Exception:
                continue

            reason = evaluate_exchange_redelivery_anomaly(shipped_date, today, llogis_raw)
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
                "received_at": ex.get("shipped_at") or "",
                "return_invoice_no": inv_no,
                "status": status,
                "location": location,
                "scan_date": scan_date,
                "reason": reason,
                "kind": "redelivery",
            }

        conn = get_db()
        sync_anomalies(conn, computed)
        conn.close()
        set_setting(_LAST_RUN_SETTING_KEY, datetime.now(_KST).isoformat())

    @router.post("/run")
    async def run_check(force: bool = False, user: str = Depends(get_current_user)):
        await _run_check_core(force=force)
        return list_anomalies(user=user)

    receipt_jobs: dict[str, dict] = {}

    async def _receipt_check_worker(job: dict, phpsessid: str) -> None:
        """반품 이상현상 건마다 상품코드의 EZAdmin 재고로그(최종스캔일~한 달 뒤, 최대 오늘)를 조회해서
        사유에 원송장번호가 들어있는 로그가 있는 건만 job["result"]에 담는다 (이미 입고처리된 건 찾기)."""
        from api.wonbe_routes import load_wonbe_option_sno_map, load_wonbe_product_codes

        def progress(phase: str, done: int = 0, total: int = 0) -> None:
            job["phase"], job["done"], job["total"] = phase, done, total

        try:
            conn = get_db()
            rows = conn.execute("SELECT * FROM exchange_return_anomalies WHERE kind = 'return'").fetchall()
            conn.close()
            if not rows:
                job["result"] = {"ok": True, "checked": 0, "skipped": [], "matched": []}
                return

            today = datetime.now(_KST).date()
            progress("에이블리 교환건 조회 중")
            ably = AblyClient()
            exchanges = await ably.list_exchanges(
                status=4,
                start_date=(today - timedelta(days=_LOOKBACK_DAYS)).strftime("%Y-%m-%d"),
                end_date=today.strftime("%Y-%m-%d"),
            )
            ex_by_sno = {str(ex.get("exchange_sno") or ex.get("sno") or ""): ex for ex in exchanges}
            product_codes = load_wonbe_product_codes()
            option_sno_map = load_wonbe_option_sno_map()

            async def resolve(row) -> dict:
                """이상현상 1건 -> 상품코드/원송장번호/조회기간 확정. 못 구하면 skip_reason."""
                base = {"id": row["id"], "orderNo": row["order_no"], "productName": row["product_name"],
                        "optionInfo": row["option_info"], "returnInvoiceNo": row["return_invoice_no"],
                        "scanDate": row["scan_date"]}
                scan = parse_llogis_scan_date(row["scan_date"])
                if not scan:
                    return {**base, "skip_reason": "최종스캔일 없음"}
                ex = ex_by_sno.get(str(row["exchange_sno"]))
                if not ex:
                    return {**base, "skip_reason": "에이블리 교환건 조회 실패"}
                first = (ex.get("exchange_items") or [{}])[0]
                order_item = dict(first.get("order_item") or {})
                origin_invoice = str(order_item.get("invoice") or "").strip()
                sync_code = str(order_item.get("option_stock_sync_code") or "").strip()
                order_item_sno = first.get("order_item_sno")
                if (not origin_invoice or not sync_code) and order_item_sno:
                    try:
                        res = await ably.request("GET", f"/seller/order_items/{order_item_sno}/")
                        detail = (res.json().get("order_item") or {}) if res.status_code == 200 else {}
                        origin_invoice = origin_invoice or str(detail.get("invoice") or "").strip()
                        sync_code = sync_code or str(detail.get("option_stock_sync_code") or "").strip()
                    except Exception:
                        pass
                code = product_codes.get(sync_code.upper(), "") if sync_code else ""
                if not code:
                    opt_sno = str((order_item.get("original_goods_option") or {}).get("sno") or "")
                    code = option_sno_map.get(opt_sno, "")
                if not code:
                    return {**base, "originInvoice": origin_invoice, "skip_reason": "상품코드 매칭 실패"}
                if not origin_invoice:
                    return {**base, "productCode": code, "skip_reason": "원송장번호 없음"}
                return {**base, "productCode": code, "originInvoice": origin_invoice,
                        "start": scan, "end": min(today, _add_one_month(scan))}

            resolved = []
            for i, row in enumerate(rows, start=1):
                progress("상품코드·원송장번호 확인 중", i - 1, len(rows))
                resolved.append(await resolve(row))
            progress("상품코드·원송장번호 확인 중", len(rows), len(rows))

            def public(t: dict) -> dict:
                return {k: v for k, v in t.items() if k not in ("start", "end")}

            skipped = [public(r) for r in resolved if r.get("skip_reason")]
            targets = [r for r in resolved if not r.get("skip_reason")]

            # 같은 상품코드/기간이면 한 번만 조회
            unique_keys = list(dict.fromkeys((t["productCode"], t["start"], t["end"]) for t in targets))
            sem = asyncio.Semaphore(4)
            done = 0
            progress("EZAdmin 재고로그 조회 중", 0, len(unique_keys))

            async def fetch_one(key: tuple):
                nonlocal done
                code, start, end = key
                async with sem:
                    try:
                        for attempt in range(2):
                            logs = await fetch_ezadmin_stock_logs(
                                phpsessid, code, start.strftime("%Y-%m-%d"), end.strftime("%Y-%m-%d"))
                            if logs is not None:
                                return logs
                            await asyncio.sleep(1)  # 동시 요청 중 일시적으로 JSON이 아닌 응답이 올 수 있어 한 번 재시도
                        return None
                    finally:
                        done += 1
                        progress("EZAdmin 재고로그 조회 중", done, len(unique_keys))

            fetched = await asyncio.gather(*[fetch_one(k) for k in unique_keys], return_exceptions=True)
            logs_by_key = dict(zip(unique_keys, fetched))
            # 전부 실패해야 세션 만료로 본다 - 일부만 실패하면 그 건만 판단 불가로 돌린다.
            if logs_by_key and all(v is None for v in logs_by_key.values()):
                job["result"] = {"ok": False, "need_session": True}
                return

            matched = []
            for t in targets:
                logs = logs_by_key[(t["productCode"], t["start"], t["end"])]
                if logs is None or isinstance(logs, Exception):
                    skipped.append({**public(t), "skip_reason": "EZAdmin 로그 조회 실패"})
                    continue
                hits = [l for l in logs if _invoice_in_reason(t["originInvoice"], l.get("사유", ""))]
                if hits:
                    matched.append({**public(t), "range": f"{t['start']} ~ {t['end']}", "logs": hits})
            job["result"] = {"ok": True, "checked": len(targets), "skipped": skipped, "matched": matched}
        except Exception as exc:
            job["error"] = f"입고체크 실패: {exc}"
        finally:
            job["finished"] = True

    @router.post("/receipt-check")
    async def receipt_check_start(user: str = Depends(get_current_user)):
        """입고체크를 백그라운드로 시작하고 job_id를 돌려준다 (진행도는 GET /receipt-check/{job_id})."""
        phpsessid = (get_setting(_EZADMIN_SESSION_KEY) or "").strip()
        if not phpsessid:
            return {"ok": False, "need_session": True}
        for old_id in [k for k, v in receipt_jobs.items() if v.get("finished")][:-5]:
            receipt_jobs.pop(old_id, None)
        job_id = uuid.uuid4().hex
        job = {"phase": "시작 중", "done": 0, "total": 0, "finished": False, "result": None, "error": ""}
        receipt_jobs[job_id] = job
        asyncio.create_task(_receipt_check_worker(job, phpsessid))
        return {"ok": True, "job_id": job_id}

    @router.get("/receipt-check/{job_id}")
    def receipt_check_status(job_id: str, user: str = Depends(get_current_user)):
        job = receipt_jobs.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="입고체크 작업을 찾을 수 없습니다.")
        return {"ok": True, **job}

    router.run_scheduled = _run_check_core
    return router
