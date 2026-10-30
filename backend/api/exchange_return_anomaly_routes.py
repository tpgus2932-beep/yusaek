from __future__ import annotations

import asyncio
import calendar
import json
import re
import uuid
from datetime import date, datetime, timedelta, timezone

import httpx
from fastapi import APIRouter, Body, Depends, HTTPException

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
# 입고체크에서 자동 매칭이 안 돼 사람이 직접 지정한 상품코드: {매칭키: {"code", "name", "option"}}
_CODE_OVERRIDES_KEY = "receipt_check_code_overrides"


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


def build_exchange_return_anomaly_router(*, get_current_user, get_db, get_setting, set_setting, run_ship_pending=None):
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

    def _load_code_overrides() -> dict:
        try:
            data = json.loads(get_setting(_CODE_OVERRIDES_KEY) or "{}")
            return data if isinstance(data, dict) else {}
        except Exception:
            return {}

    @router.post("/receipt-check/match")
    def receipt_check_save_match(payload: dict = Body(...), user: str = Depends(get_current_user)):
        """상품코드 매칭 실패 건을 직접 매칭한 결과를 저장한다 - 다음 입고체크부터 같은 옵션은 자동으로 이 코드를 쓴다."""
        key = str(payload.get("key") or "").strip()
        code = str(payload.get("code") or "").strip()
        if not key or not code:
            raise HTTPException(status_code=400, detail="매칭할 건과 상품코드가 필요합니다.")
        overrides = _load_code_overrides()
        overrides[key] = {
            "code": code,
            "name": str(payload.get("name") or "")[:200],
            "option": str(payload.get("option") or "")[:100],
        }
        set_setting(_CODE_OVERRIDES_KEY, json.dumps(overrides, ensure_ascii=False))
        return {"ok": True, "key": key, "code": code}

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
            overrides = _load_code_overrides()

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
                opt_sno = str((order_item.get("original_goods_option") or {}).get("sno") or "")
                if not code:
                    code = option_sno_map.get(opt_sno, "")
                # 직접 매칭해 둔 코드: 옵션(없으면 재고연동코드) 단위로 기억한다.
                match_key = f"opt:{opt_sno}" if opt_sno else (f"sync:{sync_code.upper()}" if sync_code else f"exchange:{row['exchange_sno']}")
                if not code:
                    code = str((overrides.get(match_key) or {}).get("code") or "")
                if not code:
                    return {**base, "originInvoice": origin_invoice, "matchKey": match_key, "skip_reason": "상품코드 매칭 실패"}
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

    advance_jobs: dict[str, dict] = {}

    async def _advance_worker(job: dict, phpsessid: str, snos: list[int]) -> None:
        """교환상품준비중(prepare) -> EZAdmin 송장 조회 -> 교환재배송중(ship). 건수가 많으면 오래 걸려서
        요청 하나로 기다리지 않고 job으로 돌리며 진행도를 채운다."""
        def progress(phase: str, done: int = 0, total: int = 0) -> None:
            job["phase"], job["done"], job["total"] = phase, done, total

        try:
            progress("교환상품준비중 처리 중", 0, len(snos))
            ably = AblyClient()
            # 건수가 많으면 에이블리가 한참 걸리므로 넉넉하게 기다린다 (기본 15초면 ReadTimeout).
            prepare_timeout = False
            try:
                res = await ably.request("POST", "/seller/exchanges/prepare/", json={"exchange_snos": snos}, timeout=180.0)
            except httpx.TimeoutException:
                # 응답만 늦고 에이블리에서는 이미 준비중으로 바뀌었을 수 있다 - 멈추지 말고 배송처리 단계에서 상태 9인 건만 이어서 처리한다.
                prepare_timeout = True
            else:
                if res.status_code not in (200, 201, 204):
                    job["error"] = f"교환상품준비중 처리 실패 (HTTP {res.status_code}): {res.text[:150]}"
                    return
            progress("송장 조회·교환재배송중 처리 중", 0, len(snos))
            ship = await run_ship_pending(
                phpsessid, None, None, only_exchange_snos=snos,
                on_progress=lambda done, total: progress("송장 조회·교환재배송중 처리 중", done, total),
            )
            if ship.get("need_session"):
                job["result"] = {"ok": False, "need_session": True, "prepared": len(snos)}
                return
            job["result"] = {"ok": True, "prepared": len(snos), "prepare_timeout": prepare_timeout, "ship": ship}
        except httpx.TimeoutException:
            job["error"] = "에이블리 응답 시간이 초과됐습니다. 에이블리에서 처리 상태를 확인한 뒤 다시 시도해주세요."
        except Exception as exc:
            job["error"] = f"교환재배송 처리 실패: {exc}"
        finally:
            job["finished"] = True

    @router.post("/receipt-check/advance")
    async def receipt_check_advance(payload: dict = Body(...), user: str = Depends(get_current_user)):
        """입고체크로 잡힌 건(이상현상 id 목록): 수거완료(4) -> 교환상품준비중(9) -> EZAdmin C주문번호
        송장으로 교환재배송중(5) 배송처리. 백그라운드로 시작하고 job_id를 돌려준다
        (진행도는 GET /receipt-check/advance/{job_id})."""
        if not run_ship_pending:
            raise HTTPException(status_code=500, detail="배송처리 기능이 연결되지 않았습니다.")
        ids = [int(i) for i in (payload.get("ids") or []) if str(i).isdigit()]
        if not ids:
            return {"ok": False, "error": "처리할 건이 없습니다."}
        phpsessid = (get_setting(_EZADMIN_SESSION_KEY) or "").strip()
        if not phpsessid:
            return {"ok": False, "need_session": True}

        conn = get_db()
        marks = ",".join("?" * len(ids))
        rows = conn.execute(
            f"SELECT exchange_sno FROM exchange_return_anomalies WHERE kind = 'return' AND id IN ({marks})", ids
        ).fetchall()
        conn.close()
        snos = [int(r["exchange_sno"]) for r in rows if str(r["exchange_sno"] or "").isdigit()]
        if not snos:
            return {"ok": False, "error": "에이블리 교환번호를 찾을 수 없습니다."}

        for old_id in [k for k, v in advance_jobs.items() if v.get("finished")][:-5]:
            advance_jobs.pop(old_id, None)
        job_id = uuid.uuid4().hex
        job = {"phase": "시작 중", "done": 0, "total": len(snos), "finished": False, "result": None, "error": ""}
        advance_jobs[job_id] = job
        asyncio.create_task(_advance_worker(job, phpsessid, snos))
        return {"ok": True, "job_id": job_id}

    @router.get("/receipt-check/advance/{job_id}")
    def receipt_check_advance_status(job_id: str, user: str = Depends(get_current_user)):
        job = advance_jobs.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="교환재배송 처리 작업을 찾을 수 없습니다.")
        return {"ok": True, **job}

    router.run_scheduled = _run_check_core
    return router
