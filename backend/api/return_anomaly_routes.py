from __future__ import annotations

import asyncio
import json
import uuid
from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter, Body, Depends, HTTPException

from services.delivery_anomaly_logic import evaluate_return_scan_delay, is_invoice_missing, latest_movement, parse_llogis_scan_date
from services.return_anomaly_store import sync_anomalies
from services.seller_return_store import is_seller_return_item

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

_EZADMIN_SESSION_KEY = "ezadmin_phpsessid"
# 입고체크에서 직접 지정한 상품코드 저장소 - 교환 이상현상 입고체크와 같은 키를 써서 같은 옵션은 한 번만 매칭하면 된다.
_CODE_OVERRIDES_KEY = "receipt_check_code_overrides"


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
                    "isSeller": bool(r["is_seller"]),
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
                        "is_seller": is_seller_return_item(raw),
                    }

        conn = get_db()
        sync_anomalies(conn, computed)
        conn.close()
        set_setting(_LAST_RUN_SETTING_KEY, datetime.now(_KST).isoformat())

    @router.post("/run")
    async def run_check(force: bool = False, user: str = Depends(get_current_user)):
        await _run_check_core(force=force)
        return list_anomalies(user=user)

    async def _fetch_cancel_items(ably, today: date) -> dict[str, dict]:
        """현재 반품 목록을 원송장번호 기준으로 펼친다: {원송장: {cancel(refund 정보 포함), item}}."""
        cancels = await ably.list_order_cancels(
            cancel_type="return",
            start_date=(today - timedelta(days=_LOOKBACK_DAYS)).strftime("%Y-%m-%d"),
            end_date=today.strftime("%Y-%m-%d"),
        )
        by_origin: dict[str, dict] = {}
        for cancel in cancels:
            for item in cancel.get("order_items", []):
                inv = str(item.get("invoice") or "").strip()
                if inv:
                    by_origin[inv] = {"cancel": cancel, "item": item}
        return by_origin

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
        사유에 원송장번호가 들어있는 로그가 있는 건만 job["result"]["matched"]에 담는다 (이미 입고처리된 건 찾기)."""
        from api.exchange_return_anomaly_routes import _add_one_month, _invoice_in_reason
        from api.wonbe_routes import load_wonbe_option_sno_map, load_wonbe_product_codes
        from services.ezadmin_stock_log import fetch_ezadmin_stock_logs

        def progress(phase: str, done: int = 0, total: int = 0) -> None:
            job["phase"], job["done"], job["total"] = phase, done, total

        try:
            conn = get_db()
            rows = conn.execute("SELECT * FROM return_anomalies").fetchall()
            conn.close()
            if not rows:
                job["result"] = {"ok": True, "checked": 0, "skipped": [], "matched": []}
                return

            today = datetime.now(_KST).date()
            progress("에이블리 반품건 조회 중")
            by_origin = await _fetch_cancel_items(AblyClient(), today)
            product_codes = load_wonbe_product_codes()
            option_sno_map = load_wonbe_option_sno_map()
            overrides = _load_code_overrides()

            targets, skipped = [], []
            for row in rows:
                base = {"id": row["id"], "orderNo": row["order_no"], "productName": row["product_name"],
                        "optionInfo": row["option_info"], "returnInvoiceNo": row["return_invoice_no"],
                        "originInvoice": row["origin_invoice_no"], "scanDate": row["scan_date"]}
                scan = parse_llogis_scan_date(row["scan_date"])
                if not scan:
                    skipped.append({**base, "skip_reason": "최종스캔일 없음"})
                    continue
                found = by_origin.get(str(row["origin_invoice_no"]).strip())
                if not found:
                    # 에이블리 반품 목록에서 항목을 못 찾으면 옵션 정보가 없어 자동 매칭이 불가능하다 -
                    # 원송장 단위로 직접 지정한 상품코드가 있으면 그걸 쓰고, 없으면 직접 매칭할 수 있게 키를 내려준다.
                    match_key = f"return:{str(row['origin_invoice_no']).strip()}"
                    manual_code = str((overrides.get(match_key) or {}).get("code") or "")
                    if manual_code:
                        targets.append({**base, "productCode": manual_code, "start": scan, "end": min(today, _add_one_month(scan))})
                    else:
                        skipped.append({**base, "matchKey": match_key, "skip_reason": "에이블리 반품건 조회 실패"})
                    continue
                item = found["item"]
                sync_code = str(item.get("option_stock_sync_code") or "").strip()
                code = product_codes.get(sync_code.upper(), "") if sync_code else ""
                opt_sno = str((item.get("original_goods_option") or item.get("goods_option") or {}).get("sno") or "")
                if not code and sync_code:
                    code = option_sno_map.get(sync_code, "")  # 재고연동코드가 상품코드가 아니라 옵션번호(숫자)로 내려오는 경우
                if not code:
                    code = option_sno_map.get(opt_sno, "")
                # 직접 매칭해 둔 코드(교환 이상현상 입고체크와 같은 저장소): 옵션(없으면 재고연동코드) 단위로 기억한다.
                match_key = f"opt:{opt_sno}" if opt_sno else (f"sync:{sync_code.upper()}" if sync_code else f"return:{row['origin_invoice_no']}")
                if not code:
                    code = str((overrides.get(match_key) or {}).get("code") or "")
                if not code:
                    skipped.append({**base, "matchKey": match_key, "skip_reason": "상품코드 매칭 실패"})
                    continue
                targets.append({**base, "productCode": code, "start": scan, "end": min(today, _add_one_month(scan))})

            unique_keys = list(dict.fromkeys((t["productCode"], t["start"], t["end"]) for t in targets))
            sem = asyncio.Semaphore(4)
            done = 0
            progress("EZAdmin 재고로그 조회 중", 0, len(unique_keys))

            async def fetch_one(key: tuple):
                nonlocal done
                code, start, end = key
                async with sem:
                    try:
                        for _ in range(2):
                            logs = await fetch_ezadmin_stock_logs(
                                phpsessid, code, start.strftime("%Y-%m-%d"), end.strftime("%Y-%m-%d"))
                            if logs is not None:
                                return logs
                            await asyncio.sleep(1)
                        return None
                    finally:
                        done += 1
                        progress("EZAdmin 재고로그 조회 중", done, len(unique_keys))

            fetched = await asyncio.gather(*[fetch_one(k) for k in unique_keys], return_exceptions=True)
            logs_by_key = dict(zip(unique_keys, fetched))
            if logs_by_key and all(v is None for v in logs_by_key.values()):
                job["result"] = {"ok": False, "need_session": True}
                return

            def public(t: dict) -> dict:
                return {k: v for k, v in t.items() if k not in ("start", "end")}

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

    @router.post("/refund-request")
    async def refund_request(payload: dict = Body(...), user: str = Depends(get_current_user)):
        """입고체크로 잡힌 반품건(이상현상 id 목록)을 반품환불요청으로 넘긴다:
        환불계좌 정보 갱신(update_fields) 후 request_confirm. 건별 결과를 돌려준다."""
        ids = [int(i) for i in (payload.get("ids") or []) if str(i).isdigit()]
        if not ids:
            return {"ok": False, "error": "처리할 건이 없습니다."}
        conn = get_db()
        marks = ",".join("?" * len(ids))
        rows = conn.execute(f"SELECT * FROM return_anomalies WHERE id IN ({marks})", ids).fetchall()
        conn.close()

        ably = AblyClient()
        today = datetime.now(_KST).date()
        by_origin = await _fetch_cancel_items(ably, today)
        results = []
        for row in rows:
            base = {"id": row["id"], "orderNo": row["order_no"], "returnInvoiceNo": row["return_invoice_no"]}
            found = by_origin.get(str(row["origin_invoice_no"]).strip())
            if not found:
                results.append({**base, "ok": False, "error": "에이블리 반품건을 찾을 수 없음 (이미 처리됐을 수 있음)"})
                continue
            cancel, item = found["cancel"], found["item"]
            try:
                cancel_sno = int(cancel.get("sno"))
                item_sno = int(item.get("sno"))
            except (TypeError, ValueError):
                results.append({**base, "ok": False, "error": "반품요청번호/item_sno 없음"})
                continue
            try:
                r1 = await ably.request("PUT", "/seller/order_cancels/update_fields/", origin="my.a-bly.com", json={
                    "data_list": [{
                        "sno_list": [cancel_sno],
                        "update_list": [
                            {"field": "refund_bank_account_holder", "value": str(cancel.get("refund_bank_account_holder") or "")},
                            {"field": "refund_bank_account_number", "value": str(cancel.get("refund_bank_account_number") or "")},
                            {"field": "refund_bank_sno", "value": cancel.get("refund_bank_sno")},
                        ],
                    }]
                })
                r1.raise_for_status()
                r2 = await ably.request("PUT", "/seller/order_items/request_confirm/", origin="my.a-bly.com", json={"sno_list": [item_sno]})
                r2.raise_for_status()
                results.append({**base, "ok": True, "error": None})
            except Exception as exc:
                results.append({**base, "ok": False, "error": str(exc)[:150]})
        success = sum(1 for r in results if r["ok"])
        return {"ok": True, "success": success, "failed": len(results) - success, "results": results}

    router.run_scheduled = _run_check_core
    return router
