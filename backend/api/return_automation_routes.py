from __future__ import annotations

import asyncio
from datetime import date, datetime, timedelta, timezone
import json
import sqlite3
from fastapi import APIRouter, Body, Depends, HTTPException

try:
    from sdk import config
    from sdk.ably import AblyClient
    from sdk.ezadmin import (
        EzAdminClient,
        EzAdminSessionExpired,
        EzDeskSessionExpired,
        extract_sms_rows as _messages,
        first_present as _first,
        normalize_sms_row as _message,
    )
    from sdk.llogis import LLogisClient
except ModuleNotFoundError:  # package import in unit tests
    from backend.sdk import config
    from backend.sdk.ably import AblyClient
    from backend.sdk.ezadmin import (
        EzAdminClient,
        EzAdminSessionExpired,
        EzDeskSessionExpired,
        extract_sms_rows as _messages,
        first_present as _first,
        normalize_sms_row as _message,
    )
    from backend.sdk.llogis import LLogisClient

KST = timezone(timedelta(hours=9))
# Keep this list deliberately small and explicit; update it when a new year starts.
HOLIDAYS = {"01-01", "03-01", "05-05", "06-06", "08-15", "10-03", "10-09", "12-25",
            # 2026 Korean lunar/substitute holidays (extend this set annually).
            "2026-02-16", "2026-02-17", "2026-02-18", "2026-05-24", "2026-08-17",
            "2026-09-24", "2026-09-25", "2026-09-26", "2026-10-05"}

def _workday(d: date) -> bool:
    return d.weekday() < 5 and d.strftime("%m-%d") not in HOLIDAYS and d.isoformat() not in HOLIDAYS

def business_days_since(value: str | None, today: date | None = None) -> int | None:
    if not value: return None
    try: d = datetime.fromisoformat(str(value).replace("Z", "+00:00")).date()
    except ValueError:
        try: d = datetime.strptime(str(value)[:10], "%Y-%m-%d").date()
        except ValueError: return None
    end = today or datetime.now(KST).date(); count = 0; cur = d + timedelta(days=1)
    while cur <= end:
        count += int(_workday(cur)); cur += timedelta(days=1)
    return count

def build_return_automation_router(*, get_current_user, get_shared_db, get_setting, set_setting, get_sms_templates, get_notes_db):
    router = APIRouter(prefix="/return-automation")

    @router.get("/ezdesk-session")
    async def ezdesk_session_status(user=Depends(get_current_user)):
        phpsessid = str(get_setting(config.EZDESK_SESSION_KEY) or "").strip()
        return {"ok": True, "has_session": bool(phpsessid), "phpsessid": phpsessid}

    @router.post("/ezdesk-session")
    async def save_ezdesk_session(payload: dict = Body(...), user=Depends(get_current_user)):
        phpsessid = str(payload.get("phpsessid") or "").strip()
        if not phpsessid:
            raise HTTPException(status_code=400, detail="phpsessid is required")
        set_setting(config.EZDESK_SESSION_KEY, phpsessid)
        return {"ok": True}

    conn = get_shared_db(); conn.execute("""CREATE TABLE IF NOT EXISTS return_automation_runs (
        run_id TEXT PRIMARY KEY, created_at TEXT NOT NULL, user_name TEXT NOT NULL, start_date TEXT, end_date TEXT,
        total_count INTEGER NOT NULL DEFAULT 0, target_count INTEGER NOT NULL DEFAULT 0, success_count INTEGER NOT NULL DEFAULT 0, failure_count INTEGER NOT NULL DEFAULT 0)"""); conn.execute("""CREATE TABLE IF NOT EXISTS return_automation_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, order_no TEXT, invoice_no TEXT, return_invoice_no TEXT,
        return_date TEXT, logis_json TEXT, input_time TEXT, elapsed_status TEXT, last_direction TEXT, received_content TEXT,
        selected_template TEXT, sms_result TEXT, pickup_result TEXT, error TEXT, processed_at TEXT)"""); conn.execute("""CREATE TABLE IF NOT EXISTS return_automation_manual_invoices (
        invoice_no TEXT PRIMARY KEY, reason TEXT NOT NULL DEFAULT '', added_at TEXT NOT NULL, added_by TEXT NOT NULL)""")
    # return_automation_manual_invoices가 reason 컬럼 도입 이전에 이미 생성돼 있던
    # 환경(로컬 app.db 등)에서는 CREATE TABLE IF NOT EXISTS가 no-op이라 컬럼이 영영
    # 추가되지 않는다 - PRAGMA로 확인 후 없으면 ALTER TABLE로 보강한다.
    manual_invoices_cols = [r["name"] for r in conn.execute("PRAGMA table_info(return_automation_manual_invoices)").fetchall()]
    if "reason" not in manual_invoices_cols:
        conn.execute("ALTER TABLE return_automation_manual_invoices ADD COLUMN reason TEXT NOT NULL DEFAULT ''")
    conn.commit(); conn.close()

    # 30일 자동스캔에 걸리지 않는 건(기간 초과, 에이블리 누락 등)을 사용자가
    # 송장번호+사유로 직접 추적 목록에 얹을 수 있게 한다. 실제 상태 조회는
    # _process_manual_invoice가 자동스캔과 같은 파이프라인(LOGIS + EZAdmin CS)으로
    # 매번 다시 한다 - 여기 테이블은 "추적할 송장번호 목록"만 들고 있는다.
    @router.get("/manual-invoices")
    async def list_manual_invoices(user=Depends(get_current_user)):
        conn = get_shared_db()
        rows = [dict(x) for x in conn.execute("SELECT * FROM return_automation_manual_invoices ORDER BY added_at DESC")]
        conn.close()
        return {"ok": True, "invoices": rows}

    @router.post("/manual-invoices")
    async def add_manual_invoice(payload: dict = Body(...), user=Depends(get_current_user)):
        invoice_no = str(payload.get("invoice_no") or "").strip()
        reason = str(payload.get("reason") or "").strip()
        if not invoice_no:
            raise HTTPException(status_code=400, detail="송장번호를 입력하세요.")
        conn = get_shared_db()
        conn.execute(
            "INSERT INTO return_automation_manual_invoices (invoice_no, reason, added_at, added_by) VALUES (?,?,?,?) "
            "ON CONFLICT(invoice_no) DO UPDATE SET reason=excluded.reason",
            (invoice_no, reason, datetime.now(KST).isoformat(), user),
        )
        conn.commit(); conn.close()
        return {"ok": True}

    @router.delete("/manual-invoices/{invoice_no}")
    async def remove_manual_invoice(invoice_no: str, user=Depends(get_current_user)):
        conn = get_shared_db()
        conn.execute("DELETE FROM return_automation_manual_invoices WHERE invoice_no=?", (invoice_no,))
        conn.commit(); conn.close()
        return {"ok": True}

    # 반품 특이사항(return_special_notes)에 등록된 송장번호+내용을 개별 추가
    # 현황 목록으로 가져온다 - 반품 특이사항에 먼저 등록해둔 건을 이 대시보드의
    # 자동추적 파이프라인(LOGIS 반송장 조회 + EZAdmin CS 이력)으로도 상태를
    # 확인하고 싶을 때 쓴다. 이미 개별 추가된 송장이면 사유만 최신 내용으로
    # 갱신한다(add_manual_invoice와 같은 ON CONFLICT 규칙).
    @router.post("/manual-invoices/sync-special-notes")
    async def sync_manual_invoices_special_notes(user=Depends(get_current_user)):
        notes_conn = get_notes_db()
        try:
            notes = [
                dict(x) for x in notes_conn.execute(
                    "SELECT invoice_no, note FROM return_special_notes WHERE TRIM(invoice_no) != ''"
                )
            ]
        finally:
            notes_conn.close()
        if not notes:
            return {"ok": True, "synced_count": 0}
        now = datetime.now(KST).isoformat()
        conn = get_shared_db()
        try:
            for n in notes:
                conn.execute(
                    "INSERT INTO return_automation_manual_invoices (invoice_no, reason, added_at, added_by) VALUES (?,?,?,?) "
                    "ON CONFLICT(invoice_no) DO UPDATE SET reason=excluded.reason",
                    (n["invoice_no"], n["note"], now, user),
                )
            conn.commit()
        finally:
            conn.close()
        return {"ok": True, "synced_count": len(notes)}

    # preview()의 자동스캔 결과와 개별추가 탭의 단독 상태조회가 모두 이 헬퍼를
    # 공유한다 - 자동스캔 items에 합칠 때와, 개별추가 탭에서 30일 스캔 없이
    # 상태만 확인할 때 둘 다 같은 판정 로직(LOGIS 반송장 유무 → EZAdmin CS 이력
    # → PASS/WAIT/... )을 타야 하기 때문이다.
    async def _process_manual_invoice(inv: str, *, logis: LLogisClient, ez: EzAdminClient, now: datetime, end: str):
        stage = "LLOGIS_RETURN_STATUS"
        try:
            logis_data = await logis.query_return_status(inv)
            return_invoice = str(logis_data.get("llogis_return_invoice_no") or "").strip()
            if return_invoice:
                return None  # 이미 반송장 등록됨 - 해결된 건이므로 추적 목록에서 내린다
            item = {
                "manual": True, "order_no": "", "cancel_sno": "", "invoice_no": inv,
                "return_invoice_no": "", "return_date": None,
                "logis": logis_data, "logis_found": bool(logis_data.get("llogis_status") not in (None, "", "-")),
                "has_return_invoice": False, "elapsed_status": "NO_RETURN_INVOICE",
                "last_direction": "", "received_content": "", "messages": [], "input_time": None,
                "phone": "", "sms_sent_count": 0, "sms_sent_history": [],
            }
            stage = "EZADMIN_ORDER_SEARCH"
            search_start = (now - timedelta(days=365)).strftime("%Y-%m-%d")
            found = await ez.find_order_by_invoice(inv, start_date=search_start, end_date=end)
            seq = (found or {}).get("pack")
            item["phone"] = (found or {}).get("phone") or ""
            if seq:
                stage = "EZADMIN_CS_HISTORY"
                history = await ez.get_cs_history(seq)
                cs_msgs = sorted((_message(x) for x in _messages(history)), key=lambda x: str(x.get("input_time") or ""))
                sms_msgs = []
                if item["phone"]:
                    try:
                        sms = await ez.sms_chat_detail(item["phone"], config.EZDESK_SMS_SENDER)
                        sms_msgs = sorted((_message(x) for x in _messages(sms)), key=lambda x: str(x.get("input_time") or ""))
                    except Exception as sms_exc:
                        item["sms_error"] = str(sms_exc)
                item["messages"] = sms_msgs
                sent_msgs = [x for x in sms_msgs if x["direction"] == "sent"]
                item["sms_sent_count"] = len(sent_msgs)
                item["sms_sent_history"] = sent_msgs
                if cs_msgs:
                    cs_last = cs_msgs[-1]
                    sms_last = sms_msgs[-1] if sms_msgs else {}
                    item.update(input_time=cs_last["input_time"], last_direction=sms_last.get("direction", ""), received_content="\n".join(x["content"] for x in sms_msgs if x["direction"] == "received"), elapsed_status="PASS" if (business_days_since(cs_last["input_time"]) or 0) >= 2 else "WAIT")
                else:
                    item["elapsed_status"] = "CS_EMPTY"
            else:
                item["elapsed_status"] = "CS_SEQ_MISSING"
            item["eligible"] = item.get("elapsed_status") == "PASS"
            return item
        except EzAdminSessionExpired:
            raise
        except Exception as item_exc:
            return {
                "manual": True, "order_no": "", "cancel_sno": "", "invoice_no": inv,
                "return_invoice_no": "", "return_date": None,
                "logis": {}, "logis_found": False, "has_return_invoice": False,
                "elapsed_status": "ERROR", "last_direction": "", "received_content": "",
                "messages": [], "eligible": False, "input_time": None,
                "error": str(item_exc), "error_stage": stage, "phone": "",
                "sms_sent_count": 0, "sms_sent_history": [],
            }

    @router.post("/manual-invoices/status")
    async def manual_invoices_status(user=Depends(get_current_user)):
        """개별추가 탭 전용 - 30일 에이블리 스캔 없이 개별추가된 송장번호만 빠르게 상태 확인."""
        now = datetime.now(KST); end = now.strftime("%Y-%m-%d")
        conn = get_shared_db()
        manual_rows = [dict(x) for x in conn.execute("SELECT * FROM return_automation_manual_invoices ORDER BY added_at DESC")]
        conn.close()
        if not manual_rows:
            return {"ok": True, "items": []}
        try:
            logis = LLogisClient(); ez = EzAdminClient(get_setting)
            results = await asyncio.gather(
                *(_process_manual_invoice(str(r["invoice_no"]), logis=logis, ez=ez, now=now, end=end) for r in manual_rows)
            )
        except EzAdminSessionExpired as exc:
            raise HTTPException(status_code=401, detail=f"EZAdmin 세션이 만료되었습니다: {exc}")
        except Exception as exc:
            raise HTTPException(status_code=502, detail=str(exc))
        resolved_invoices = []
        items = []
        for row, result in zip(manual_rows, results):
            inv = str(row["invoice_no"])
            if result is None:
                resolved_invoices.append(inv)
                continue
            result["reason"] = row.get("reason") or ""
            result["added_at"] = row.get("added_at")
            result["added_by"] = row.get("added_by")
            items.append(result)
        if resolved_invoices:
            resolved_conn = get_shared_db()
            resolved_conn.executemany(
                "DELETE FROM return_automation_manual_invoices WHERE invoice_no=?",
                [(inv,) for inv in resolved_invoices],
            )
            resolved_conn.commit(); resolved_conn.close()
        return {"ok": True, "items": items, "resolved_invoices": resolved_invoices}

    @router.post("/preview")
    async def preview(user=Depends(get_current_user)):
        now = datetime.now(KST); start = (now - timedelta(days=30)).strftime("%Y-%m-%d"); end = now.strftime("%Y-%m-%d")
        run_id = f"ra-{now.strftime('%Y%m%d%H%M%S%f')}"
        try:
            ably = AblyClient(); logis = LLogisClient(); ez = EzAdminClient(get_setting)
            token = await ably.login()
            base_params = {"cancel_type":"return", "processing_sub_status[]":["41", "42"], "delivery_type[]":["standard","today","combine","reserved"], "order":"cancel_received_at", "date_type":"cancel_received_at", "per_page":100, "start_date":start, "end_date":end}
            cancels = []
            page = 1
            while True:
                response = await ably.request("GET", "/seller/order_cancels/", params={**base_params, "page": page})
                response.raise_for_status(); data = response.json()
                page_cancels = data.get("order_cancels", [])
                if not page_cancels: break
                cancels.extend(page_cancels)
                max_page = int(data.get("max_page_number") or data.get("total_page") or 1)
                if page >= max_page: break
                page += 1
            items = []
            source_item_count = 0
            excluded_recent_count = 0
            error_count = 0
            seen_invoices = set()
            for cancel in cancels:
                for raw in cancel.get("order_items", []):
                    inv = str(raw.get("invoice") or "").strip()
                    if not inv:
                        continue
                    # Ably sometimes reports the same invoice twice (e.g. a
                    # multi-product package split into separate order_items
                    # that were all shipped under the one invoice/tracking
                    # number). Treating those as two rows made the order_no
                    # grouping in execute() collide with itself - the two
                    # "duplicate" rows would both resolve to the same
                    # invoice_no as both primary and grouped_with, so neither
                    # displayed as successfully executed even though the
                    # single underlying send/pickup call did succeed.
                    if inv in seen_invoices:
                        continue
                    seen_invoices.add(inv)
                    source_item_count += 1
                    return_date = str(cancel.get("cancel_received_at") or raw.get("cancel_received_at") or "")
                    return_days = business_days_since(return_date)
                    if return_days is not None and return_days < 2:
                        excluded_recent_count += 1
                        continue
                    # Each item below makes several sequential external API calls
                    # (LLogis, and conditionally EZAdmin order search + CS/SMS
                    # history). A single flaky call must not discard every other
                    # item already processed in this run, so failures here are
                    # isolated per item instead of aborting the whole preview.
                    # stage tracks which external call was in flight when an
                    # exception hit, so a failed item's error message says *where*
                    # it failed instead of just that it failed.
                    stage = "LLOGIS_RETURN_STATUS"
                    try:
                        logis_data = await logis.query_return_status(inv)
                        # The source of truth is the LOGIS response, not Ably's
                        # optional return-invoice field or a movement-status label.
                        return_invoice = str(logis_data.get("llogis_return_invoice_no") or "").strip()
                        has_return = bool(return_invoice)
                        if has_return:
                            continue
                        phone = str(cancel.get("buyer_tel") or cancel.get("receiver_tel") or raw.get("buyer_tel") or raw.get("receiver_tel") or "").strip()
                        # input_time defaults to None here because it is only ever
                        # populated below when CS history exists (cs_msgs truthy);
                        # CS_EMPTY/CS_SEQ_MISSING/RETURN_WAIT outcomes leave it unset
                        # otherwise, which used to raise a KeyError when this item
                        # was written to SQLite further down and silently aborted
                        # the entire preview for every item in the run.
                        item = {"order_no": str(cancel.get("order_id") or raw.get("order_id") or raw.get("sno") or ""), "cancel_sno": str(cancel.get("sno") or ""), "invoice_no": inv, "return_invoice_no": return_invoice, "return_date": return_date, "logis": logis_data, "logis_found": bool(logis_data.get("llogis_status") not in (None, "", "-")), "has_return_invoice": False, "elapsed_status": "NO_RETURN_INVOICE", "last_direction": "", "received_content": "", "messages": [], "input_time": None, "phone": phone, "sms_sent_count": 0, "sms_sent_history": []}
                        seq = (raw.get("seq") or raw.get("order_seq") or raw.get("pack") or raw.get("pack_seq")
                               or cancel.get("seq") or cancel.get("order_seq") or cancel.get("pack") or cancel.get("pack_seq"))
                        # Ably return payloads often omit EZAdmin's transaction seq.
                        # Resolve it by searching EZAdmin with the original invoice.
                        if not seq:
                            # The return request can be recent while the original
                            # order/collection date is older than 30 days.
                            stage = "EZADMIN_ORDER_SEARCH"
                            search_start = (now - timedelta(days=365)).strftime("%Y-%m-%d")
                            order_rows = await ez.query_orders(inv, start_date=search_start, end_date=end, rows=100)
                            for order_row in order_rows:
                                seq = _first(order_row, ("seq", "order_seq", "pack", "pack_seq"))
                                if seq:
                                    break
                        if seq:
                            stage = "EZADMIN_CS_HISTORY"
                            history = await ez.get_cs_history(seq)
                            cs_msgs = sorted((_message(x) for x in _messages(history)), key=lambda x: str(x.get("input_time") or ""))
                            sms_msgs = []
                            if phone:
                                try:
                                    sms = await ez.sms_chat_detail(phone, config.EZDESK_SMS_SENDER)
                                    sms_msgs = sorted((_message(x) for x in _messages(sms)), key=lambda x: str(x.get("input_time") or ""))
                                except Exception as sms_exc:
                                    item["sms_error"] = str(sms_exc)
                            item["messages"] = sms_msgs
                            # "몇 번 보냈나" - total SMS this customer has been
                            # sent so far, straight from EZDesk's own history
                            # (not a per-run counter), so it stays meaningful
                            # even the very first time this dashboard executes
                            # against them.
                            sent_msgs = [x for x in sms_msgs if x["direction"] == "sent"]
                            item["sms_sent_count"] = len(sent_msgs)
                            item["sms_sent_history"] = sent_msgs
                            if cs_msgs:
                                cs_last = cs_msgs[-1]
                                sms_last = sms_msgs[-1] if sms_msgs else {}
                                item.update(input_time=cs_last["input_time"], last_direction=sms_last.get("direction", ""), received_content="\n".join(x["content"] for x in sms_msgs if x["direction"] == "received"), elapsed_status="PASS" if (business_days_since(cs_last["input_time"]) or 0) >= 2 else "WAIT")
                            else:
                                item["elapsed_status"] = "CS_EMPTY"
                        else:
                            item["elapsed_status"] = "CS_SEQ_MISSING"
                        return_days = business_days_since(item.get("return_date"))
                        item["return_elapsed_days"] = return_days
                        if return_days is None or return_days < 2:
                            item["elapsed_status"] = "RETURN_WAIT"
                            item["eligible"] = False
                        else:
                            item["eligible"] = item.get("elapsed_status") == "PASS"
                        items.append(item)
                    except EzAdminSessionExpired:
                        # The session is invalid for every subsequent EZAdmin call
                        # too, so there's no point isolating this one - surface it
                        # immediately like before.
                        raise
                    except Exception as item_exc:
                        error_count += 1
                        items.append({
                            "order_no": str(cancel.get("order_id") or raw.get("order_id") or raw.get("sno") or ""),
                            "cancel_sno": str(cancel.get("sno") or ""),
                            "invoice_no": inv, "return_invoice_no": "", "return_date": return_date,
                            "logis": {}, "logis_found": False, "has_return_invoice": False,
                            "elapsed_status": "ERROR", "last_direction": "", "received_content": "",
                            "messages": [], "eligible": False, "input_time": None,
                            "error": str(item_exc), "error_stage": stage,
                        })

            # 교환반품(에이블리 교환수거중, status=3) 병합 - 반품과 완전히 동일한
            # 조건/실행으로 처리한다: llogis에 반품송장이 아직 없으면 회수신청+문자가
            # 필요한 대상이고, 이미 있으면 제외한다(에이블리 등록은 교환반품 테스트
            # 탭이 별도로 처리하므로 이 대시보드의 역할이 아니다). execute()도 반품과
            # 동일하게 SMS + register_return_pickup(원송장)만 수행한다.
            exchange_candidates = []
            exchange_page = 1
            while True:
                ex_res = await ably.request("GET", "/seller/exchanges/", params={
                    "page": exchange_page, "per_page": 30,
                    "requested_at_start": f"{start} 00:00:00", "requested_at_end": f"{end} 23:59:59",
                    "status[]": 3,
                })
                ex_res.raise_for_status()
                ex_data = ex_res.json()
                ex_list = ex_data.get("exchanges", [])
                if not ex_list:
                    break
                for ex in ex_list:
                    rd = ex.get("return_delivery") or {}
                    if rd.get("invoice_number"):
                        continue  # 이미 반품송장 등록됨(교환반품 테스트에서 처리 완료)
                    ex_items_list = ex.get("exchange_items") or []
                    if not ex_items_list:
                        continue
                    ex_first = ex_items_list[0]
                    ex_order_item = ex_first.get("order_item") or {}
                    requested_at = ex.get("requested_at")
                    source_item_count += 1
                    request_days = business_days_since(requested_at)
                    if request_days is not None and request_days < 2:
                        excluded_recent_count += 1
                        continue
                    raw_tel = ex_order_item.get("buyer_tel") or ex_order_item.get("receiver_tel") or ""
                    exchange_candidates.append({
                        "exchange_sno": ex.get("exchange_sno") or ex.get("sno"),
                        "order_item_sno": ex_first.get("order_item_sno"),
                        # order_item.order_sno(중첩)는 자주 비어 있어 exchange 객체
                        # 최상위의 order_sno를 쓴다 (exchange_return_routes.py에서
                        # 이미 검증된 신뢰 가능한 필드).
                        "order_no": str(ex.get("order_sno") or ""),
                        "return_date": requested_at,
                        "phone": "".join(ch for ch in str(raw_tel) if ch.isdigit()),
                        "goods_name": ex_order_item.get("goods_name") or ex_first.get("goods_name") or "",
                        "option_info": ex_order_item.get("option_info") or ex_first.get("option_info") or "",
                    })
                if exchange_page >= ex_data.get("max_page_number", 1):
                    break
                exchange_page += 1

            async def _process_exchange_candidate(cand):
                sno = cand.get("order_item_sno")
                if not sno:
                    return None
                res = await ably.request("GET", f"/seller/order_items/{sno}/")
                if res.status_code != 200:
                    return None
                oi = res.json().get("order_item") or {}
                origin_invoice = str(oi.get("invoice") or "").strip()
                if not origin_invoice:
                    return None
                phone = cand.get("phone") or ""
                if not phone:
                    raw_tel = oi.get("buyer_tel") or oi.get("receiver_tel") or ""
                    phone = "".join(ch for ch in str(raw_tel) if ch.isdigit())

                logis_data = await logis.query_return_status(origin_invoice)
                return_invoice = str(logis_data.get("llogis_return_invoice_no") or "").strip()
                if return_invoice:
                    return None  # llogis에 반송장이 이미 있음 - 교환반품 테스트가 처리할 대상, 자동화에선 제외

                item = {
                    "kind": "exchange",
                    "exchange_sno": cand.get("exchange_sno"),
                    "order_no": cand.get("order_no"),
                    "invoice_no": origin_invoice,
                    "return_invoice_no": "", "return_date": cand.get("return_date"),
                    "logis": logis_data,
                    "logis_found": bool(logis_data.get("llogis_status") not in (None, "", "-")),
                    "has_return_invoice": False,
                    "elapsed_status": "NO_RETURN_INVOICE", "last_direction": "", "received_content": "",
                    "messages": [], "input_time": None, "phone": phone,
                    "goods_name": cand.get("goods_name"), "option_info": cand.get("option_info"),
                    "sms_sent_count": 0, "sms_sent_history": [],
                }
                stage = "EZADMIN_ORDER_SEARCH"
                try:
                    seq = None
                    search_start = (now - timedelta(days=365)).strftime("%Y-%m-%d")
                    order_rows = await ez.query_orders(origin_invoice, start_date=search_start, end_date=end, rows=100)
                    for order_row in order_rows:
                        seq = _first(order_row, ("seq", "order_seq", "pack", "pack_seq"))
                        if seq:
                            break
                    if seq:
                        stage = "EZADMIN_CS_HISTORY"
                        history = await ez.get_cs_history(seq)
                        cs_msgs = sorted((_message(x) for x in _messages(history)), key=lambda x: str(x.get("input_time") or ""))
                        sms_msgs = []
                        if phone:
                            try:
                                sms = await ez.sms_chat_detail(phone, config.EZDESK_SMS_SENDER)
                                sms_msgs = sorted((_message(x) for x in _messages(sms)), key=lambda x: str(x.get("input_time") or ""))
                            except Exception as sms_exc:
                                item["sms_error"] = str(sms_exc)
                        item["messages"] = sms_msgs
                        sent_msgs = [x for x in sms_msgs if x["direction"] == "sent"]
                        item["sms_sent_count"] = len(sent_msgs)
                        item["sms_sent_history"] = sent_msgs
                        if cs_msgs:
                            cs_last = cs_msgs[-1]
                            sms_last = sms_msgs[-1] if sms_msgs else {}
                            item.update(
                                input_time=cs_last["input_time"],
                                last_direction=sms_last.get("direction", ""),
                                received_content="\n".join(x["content"] for x in sms_msgs if x["direction"] == "received"),
                                elapsed_status="PASS" if (business_days_since(cs_last["input_time"]) or 0) >= 2 else "WAIT",
                            )
                        else:
                            item["elapsed_status"] = "CS_EMPTY"
                    else:
                        item["elapsed_status"] = "CS_SEQ_MISSING"
                    request_days = business_days_since(item.get("return_date"))
                    item["return_elapsed_days"] = request_days
                    if request_days is None or request_days < 2:
                        item["elapsed_status"] = "REQUEST_WAIT"
                        item["eligible"] = False
                    else:
                        item["eligible"] = item.get("elapsed_status") == "PASS"
                    return item
                except EzAdminSessionExpired:
                    raise
                except Exception as item_exc:
                    return {
                        "kind": "exchange", "exchange_sno": cand.get("exchange_sno"),
                        "order_no": cand.get("order_no"), "invoice_no": origin_invoice,
                        "return_invoice_no": "", "return_date": cand.get("return_date"),
                        "logis": {}, "logis_found": False, "has_return_invoice": False,
                        "elapsed_status": "ERROR", "last_direction": "", "received_content": "",
                        "messages": [], "eligible": False, "input_time": None,
                        "error": str(item_exc), "error_stage": stage, "phone": phone,
                        "sms_sent_count": 0, "sms_sent_history": [],
                    }

            if exchange_candidates:
                exchange_results = await asyncio.gather(
                    *(_process_exchange_candidate(c) for c in exchange_candidates)
                )
                for result in exchange_results:
                    if result is not None:
                        items.append(result)

            # 개별로 추가한 송장번호(자동스캔이 못 잡는 30일 초과/누락 건)도 매
            # 조회마다 같은 파이프라인(LOGIS 반송장 조회 → EZAdmin 주문검색 → CS
            # 이력)으로 상태를 다시 확인해 items에 합친다. 이미 자동스캔에 잡힌
            # 송장이면 중복 처리하지 않는다.
            manual_conn = get_shared_db()
            manual_rows_all = [dict(x) for x in manual_conn.execute("SELECT * FROM return_automation_manual_invoices")]
            manual_conn.close()
            manual_rows = [r for r in manual_rows_all if str(r["invoice_no"]) not in seen_invoices]
            manual_invoices = [str(r["invoice_no"]) for r in manual_rows]

            if manual_invoices:
                manual_results = await asyncio.gather(
                    *(_process_manual_invoice(inv, logis=logis, ez=ez, now=now, end=end) for inv in manual_invoices)
                )
                resolved_invoices = []
                for row, result in zip(manual_rows, manual_results):
                    inv = str(row["invoice_no"])
                    if result is None:
                        resolved_invoices.append(inv)
                        continue
                    result["reason"] = row.get("reason") or ""
                    source_item_count += 1
                    items.append(result)
                if resolved_invoices:
                    resolved_conn = get_shared_db()
                    resolved_conn.executemany(
                        "DELETE FROM return_automation_manual_invoices WHERE invoice_no=?",
                        [(inv,) for inv in resolved_invoices],
                    )
                    resolved_conn.commit(); resolved_conn.close()

            conn = get_shared_db(); conn.execute("INSERT INTO return_automation_runs VALUES (?,?,?,?,?,?,?,?,?)", (run_id, now.isoformat(), user, start, end, len(items), sum(x["elapsed_status"] == "PASS" for x in items), 0, 0))
            for x in items: conn.execute("INSERT INTO return_automation_items (run_id,order_no,invoice_no,return_invoice_no,return_date,logis_json,input_time,elapsed_status,last_direction,received_content) VALUES (?,?,?,?,?,?,?,?,?,?)", (run_id,x.get("order_no"),x.get("invoice_no"),x.get("return_invoice_no"),x.get("return_date"),json.dumps(x.get("logis"),ensure_ascii=False),x.get("input_time"),x.get("elapsed_status"),x.get("last_direction"),x.get("received_content")))
            conn.commit(); conn.close(); return {"ok": True, "run_id": run_id, "start_date": start, "end_date": end, "source_cancel_count": len(cancels), "source_item_count": source_item_count, "excluded_recent_count": excluded_recent_count, "error_count": error_count, "items": items, "templates": get_sms_templates()}
        except EzAdminSessionExpired as exc: raise HTTPException(status_code=401, detail=f"EZAdmin 세션이 만료되었습니다: {exc}")
        except Exception as exc: raise HTTPException(status_code=502, detail=str(exc))

    # Ably 1:1 문의방 카테고리 전체 목록 - seller-admin 문의 화면이 필터 없이 조회할 때
    # 보내는 category[] 값 그대로 고정해 둔다(신규 카테고리 추가 시 함께 갱신 필요).
    CS_CHECK_CATEGORIES = ["2","101","120","3","102","121","4","103","122","5","104","123","9","11","106","125",
        "12","107","126","13","108","127","14","109","128","15","110","129","16","111","130","19","153","172"]

    @router.post("/check-cs")
    async def check_cs(payload: dict = Body(...), user=Depends(get_current_user)):
        items = payload.get("items") or []
        start_date = str(payload.get("start_date") or "")
        end_date = str(payload.get("end_date") or "")
        phones = sorted({str(x.get("phone") or "").strip() for x in items if str(x.get("phone") or "").strip()})
        if not phones:
            return {"ok": True, "results": {}}
        try:
            ably = AblyClient(); results = {}
            for phone in phones:
                response = await ably.request("GET", "/seller/contact_rooms/", params={
                    "start_date": start_date, "end_date": end_date, "order": "-updated_latest_message_at",
                    "category[]": CS_CHECK_CATEGORIES, "status[]": ["1", "2"], "mobile": phone,
                })
                response.raise_for_status(); data = response.json()
                rooms = data.get("contact_rooms") or []
                latest = rooms[0] if rooms else {}
                results[phone] = {
                    "has_contact": bool(rooms), "count": len(rooms),
                    "status_display": latest.get("get_status_display"),
                    "latest_message": (latest.get("latest_message") or {}).get("content"),
                    "latest_message_at": latest.get("updated_latest_message_at"),
                }
            return {"ok": True, "results": results}
        except Exception as exc: raise HTTPException(status_code=502, detail=str(exc))

    def _persist_item(run_id, invoice, template, row_result):
        conn = get_shared_db()
        conn.execute(
            "UPDATE return_automation_items SET selected_template=?,sms_result=?,pickup_result=?,error=?,processed_at=? WHERE run_id=? AND invoice_no=?",
            (json.dumps(template, ensure_ascii=False), json.dumps(row_result.get("sms"), ensure_ascii=False),
             json.dumps(row_result.get("pickup"), ensure_ascii=False), row_result.get("error"),
             datetime.now(KST).isoformat(), run_id, invoice),
        )
        conn.commit(); conn.close()

    @router.post("/execute")
    async def execute(payload: dict = Body(...), user=Depends(get_current_user)):
        run_id = str(payload.get("run_id") or ""); selected = payload.get("items") or []
        if not run_id: raise HTTPException(status_code=400, detail="run_id is required")
        ez = EzAdminClient(get_setting); results=[]
        need_session = False
        need_ezdesk_session = False

        # A return split across multiple invoices under the same order_no is
        # still one customer contact and (per the user) one pickup - group by
        # order_no so only one invoice in the group sends the SMS and
        # registers the pickup; the rest are marked "grouped_with" it instead
        # of duplicating both actions once per invoice.
        groups: dict[str, list[dict]] = {}
        group_order: list[str] = []
        for selected_item in selected:
            order_no = str(selected_item.get("order_no") or "").strip()
            key = order_no or f"__invoice__{selected_item.get('invoice_no')}"
            if key not in groups:
                groups[key] = []
                group_order.append(key)
            groups[key].append(selected_item)

        for key in group_order:
            group_items = groups[key]
            # Prefer an actually-eligible item as the primary so a WAIT/etc.
            # sibling grouped in by order_no doesn't block a PASS sibling.
            primary = next((x for x in group_items if x.get("elapsed_status") == "PASS"), group_items[0])
            siblings = [x for x in group_items if x is not primary]
            invoice = str(primary.get("invoice_no") or ""); row_result={"invoice_no":invoice}
            stop = False
            try:
                if primary.get("elapsed_status") != "PASS":
                    row_result["error"] = "영업일 2일 경과 대상이 아닙니다"
                    results.append(row_result)
                    for sib in siblings:
                        results.append({"invoice_no": str(sib.get("invoice_no") or ""), "error": "영업일 2일 경과 대상이 아닙니다"})
                    continue
                check_conn = get_shared_db(); existing = check_conn.execute("SELECT sms_result, pickup_result FROM return_automation_items WHERE run_id=? AND invoice_no=?", (run_id, invoice)).fetchone(); check_conn.close()
                if existing and existing[1] and existing[1] not in ("", "null", "{}"):
                    row_result["skipped"] = True
                    results.append(row_result)
                    for sib in siblings:
                        results.append({"invoice_no": str(sib.get("invoice_no") or ""), "skipped": True})
                    continue
                # 교환(kind=="exchange")도 반품과 완전히 동일한 액션 - SMS + EZAdmin
                # 회수신청(register_return_pickup). invoice는 이미 원송장으로 채워져
                # 있다(_process_exchange_candidate 참고). 에이블리 반품송장 등록은
                # 이 대시보드가 하지 않고, 교환반품 테스트 탭이 별도로 처리한다.
                template = primary.get("template") or {}; msg = str(template.get("msg") or "")
                receiver = str(primary.get("phone") or "").strip()
                if msg and receiver:
                    row_result["sms"] = await ez.send_sms(receiver, config.EZDESK_SMS_SENDER, msg)
                elif msg:
                    row_result["sms"] = {"error": "고객 전화번호를 찾을 수 없어 문자를 보내지 못했습니다"}
                row_result["pickup"] = await ez.register_return_pickup(invoice)
                if siblings:
                    row_result["grouped_invoices"] = [str(s.get("invoice_no") or "") for s in siblings]
            except EzDeskSessionExpired as exc:
                # ezdesk.ezadmin.co.kr (SMS send) uses a separate login from
                # the main ga80.ezadmin.co.kr session, so it needs its own
                # re-paste-cookie flow instead of the main need_session one.
                row_result["error"] = str(exc)
                need_ezdesk_session = True
                stop = True
            except EzAdminSessionExpired as exc:
                # The stored PHPSESSID is dead - every remaining item would fail
                # the same way, so stop here instead of burning through the rest
                # of the selection with the same error. need_session tells the
                # frontend to prompt for a fresh cookie and retry, same as the
                # other EZAdmin-backed pages do.
                row_result["error"] = str(exc)
                need_session = True
                stop = True
            except Exception as exc:
                row_result["error"] = str(exc)
            _persist_item(run_id, invoice, primary.get("template"), row_result)
            results.append(row_result)
            for sib in siblings:
                sib_invoice = str(sib.get("invoice_no") or "")
                if sib_invoice == invoice:
                    # Exact duplicate row for the same invoice (see the
                    # seen_invoices dedup in preview()) - nothing extra to
                    # report; emitting a second "grouped_with itself" result
                    # for the same invoice_no would just collide with and
                    # overwrite row_result above.
                    continue
                sib_result = {
                    "invoice_no": sib_invoice,
                    "skipped": True,
                    "grouped_with": invoice,
                    "sms": row_result.get("sms"),
                    "pickup": row_result.get("pickup") or {"grouped_with": invoice},
                    "error": row_result.get("error"),
                }
                _persist_item(run_id, sib_invoice, sib.get("template"), sib_result)
                results.append(sib_result)
            if stop:
                break
        conn=get_shared_db(); conn.execute("UPDATE return_automation_runs SET success_count=?,failure_count=? WHERE run_id=?", (sum(1 for x in results if x.get("pickup") and not x.get("error")), sum(1 for x in results if x.get("error")), run_id)); conn.commit(); conn.close()
        return {"ok": not any(x.get("error") for x in results), "run_id": run_id, "results": results, "need_session": need_session, "need_ezdesk_session": need_ezdesk_session}

    REJECT_REASON = "문자 3통 답변 x 물건 회수 x"

    @router.post("/reject")
    async def reject(payload: dict = Body(...), user=Depends(get_current_user)):
        selected = payload.get("items") or []
        if not selected:
            raise HTTPException(status_code=400, detail="선택된 항목이 없습니다.")
        ably = AblyClient(); results = []
        # 같은 반품요청(cancel_sno)에 상품이 여러 개 묶여 여러 invoice로 나온
        # 경우에도 reject_request는 요청 단위 처리라 한 번만 호출하면 된다 -
        # execute()가 order_no로 묶어 SMS/회수를 한 번만 실행하는 것과 같은 이유.
        seen_cancel_sno: set[str] = set()
        for selected_item in selected:
            invoice_no = str(selected_item.get("invoice_no") or "")
            cancel_sno = str(selected_item.get("cancel_sno") or "").strip()
            if not cancel_sno:
                results.append({"invoice_no": invoice_no, "error": "반품요청번호(cancel_sno)가 없어 거부할 수 없습니다"})
                continue
            if cancel_sno in seen_cancel_sno:
                results.append({"invoice_no": invoice_no, "cancel_sno": cancel_sno, "skipped": True, "grouped_with": cancel_sno})
                continue
            seen_cancel_sno.add(cancel_sno)
            try:
                res = await ably.reject_order_cancel(cancel_sno, refuse_cause_comment=REJECT_REASON)
                res.raise_for_status()
                results.append({"invoice_no": invoice_no, "cancel_sno": cancel_sno, "ok": True})
            except Exception as exc:
                results.append({"invoice_no": invoice_no, "cancel_sno": cancel_sno, "error": str(exc)})
        return {"ok": not any(x.get("error") for x in results), "results": results}

    @router.post("/reply-sms")
    async def reply_sms(payload: dict = Body(...), user=Depends(get_current_user)):
        phone = str(payload.get("phone") or "").strip()
        msg = str(payload.get("msg") or "").strip()
        if not phone:
            raise HTTPException(status_code=400, detail="전화번호가 없습니다.")
        if not msg:
            raise HTTPException(status_code=400, detail="내용을 입력하세요.")
        ez = EzAdminClient(get_setting)
        try:
            result = await ez.send_sms(phone, config.EZDESK_SMS_SENDER, msg)
        except EzDeskSessionExpired:
            return {"ok": False, "need_ezdesk_session": True}
        return {"ok": True, "result": result}

    @router.get("/runs")
    async def runs(user=Depends(get_current_user)):
        conn=get_shared_db(); rows=[dict(x) for x in conn.execute("SELECT * FROM return_automation_runs ORDER BY created_at DESC LIMIT 50")]; conn.close(); return {"runs":rows}

    @router.get("/runs/{run_id}")
    async def run_detail(run_id: str, user=Depends(get_current_user)):
        conn=get_shared_db(); run=conn.execute("SELECT * FROM return_automation_runs WHERE run_id=?",(run_id,)).fetchone(); items=[dict(x) for x in conn.execute("SELECT * FROM return_automation_items WHERE run_id=?",(run_id,))]; conn.close()
        if not run: raise HTTPException(status_code=404, detail="run not found")
        return {"run":dict(run),"items":items}
    return router
