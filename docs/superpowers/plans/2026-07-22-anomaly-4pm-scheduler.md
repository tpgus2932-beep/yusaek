# 이상현상 오후 4시 서버 자동 실행 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 배송이상/반품 이상현상/교환반품 이상현상 세 카드의 실제 재조회가, 대시보드 페이지를 아무도 열지 않아도 백엔드 서버만 켜져 있으면 매일 KST 오후 4시 이후 자동으로 1회씩 실행되게 한다.

**Architecture:** 세 라우터(`delivery_anomaly_routes.py`, `return_anomaly_routes.py`, `exchange_return_anomaly_routes.py`)의 기존 `POST /run` 핸들러 내부 로직을 `user` FastAPI 의존성과 분리된 순수 함수로 추출해 `router.run_scheduled`로 노출한다. `main.py`는 FastAPI startup 이벤트에서, 새로 만든 `backend/services/anomaly_scheduler.py`의 5분 주기 백그라운드 루프를 하나 띄운다. 이 루프는 KST 16시 이후 각 작업이 그날 아직 안 돌았으면(스케줄러 전용 설정 키로 추적, 라우터 자체의 당일-가드와는 별개) `run_scheduled(force=True)`로 강제 실행한다.

**Tech Stack:** FastAPI, Python asyncio (표준 라이브러리만 사용, 새 의존성 없음), pytest, sqlite3(테스트용 in-memory).

## Global Constraints

- 스펙 문서: `docs/superpowers/specs/2026-07-22-anomaly-4pm-scheduler-design.md`
- 폴링 주기는 5분(300초)으로 하드코딩한다 (설정 가능하게 만들지 않음 - 스펙 "비범위" 참고).
- 자동 스케줄 실행은 각 라우터의 기존 `_LAST_RUN_SETTING_KEY`(수동 새로고침용 당일-가드)를 건드리지 않는다. 대신 `anomaly_scheduler_ran_{name}` 형태의 별도 키로 "오늘 4시 자동 실행을 이미 했는지"를 추적한다.
- 기존 `POST /run` 엔드포인트(수동 새로고침 버튼)의 동작/응답은 리팩터링 전후로 완전히 동일해야 한다.
- 프론트엔드는 변경하지 않는다.
- 새 외부 패키지(APScheduler 등)를 추가하지 않는다 - 표준 라이브러리 `asyncio`만 사용한다.
- 모든 시간 비교는 KST(`timezone(timedelta(hours=9))`) 기준이다. UTC 등 다른 타임존과 섞어 쓰지 않는다.

---

### Task 1: `anomaly_scheduler` 서비스 모듈 (스케줄링 핵심 로직)

**Files:**
- Create: `backend/services/anomaly_scheduler.py`
- Test: `backend/tests/test_anomaly_scheduler.py`

**Interfaces:**
- Produces:
  - `AnomalyJob = tuple[str, Callable[..., Awaitable[None]]]` - `(작업 이름, force 키워드 인자를 받는 async 콜러블)` 타입 별칭
  - `async def run_anomaly_scheduler_tick(jobs: list[AnomalyJob], get_setting: Callable[[str], str | None], set_setting: Callable[[str, str], None], now: datetime) -> None` - 순수 함수, 실제 sleep 없이 "지금 시각 기준으로 한 번 훑기"만 수행
  - `async def run_anomaly_scheduler_loop(jobs: list[AnomalyJob], get_setting, set_setting) -> None` - 무한 루프. `run_anomaly_scheduler_tick`을 5분 간격으로 호출
  - `RUN_HOUR_KST = 16`, `POLL_INTERVAL_SECONDS = 300` 모듈 상수
- Consumes: 없음 (다른 태스크에 의존하지 않는 순수 모듈)

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_anomaly_scheduler.py` 파일을 새로 만든다:

```python
import asyncio
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import AsyncMock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.anomaly_scheduler import run_anomaly_scheduler_tick

_KST = timezone(timedelta(hours=9))


def _settings_store():
    store: dict[str, str] = {}
    return store, (lambda key: store.get(key)), (lambda key, value: store.__setitem__(key, value))


def test_before_4pm_does_not_run_jobs():
    store, get_setting, set_setting = _settings_store()
    job = AsyncMock()
    now = datetime(2026, 7, 22, 15, 59, tzinfo=_KST)
    asyncio.run(run_anomaly_scheduler_tick([("delivery_anomaly", job)], get_setting, set_setting, now))
    job.assert_not_awaited()


def test_after_4pm_runs_job_with_force_and_records_setting():
    store, get_setting, set_setting = _settings_store()
    job = AsyncMock()
    now = datetime(2026, 7, 22, 16, 0, tzinfo=_KST)
    asyncio.run(run_anomaly_scheduler_tick([("delivery_anomaly", job)], get_setting, set_setting, now))
    job.assert_awaited_once_with(force=True)
    assert store["anomaly_scheduler_ran_delivery_anomaly"] == now.isoformat()


def test_after_4pm_skips_job_already_run_today():
    store, get_setting, set_setting = _settings_store()
    set_setting("anomaly_scheduler_ran_delivery_anomaly", datetime(2026, 7, 22, 16, 0, tzinfo=_KST).isoformat())
    job = AsyncMock()
    now = datetime(2026, 7, 22, 17, 30, tzinfo=_KST)
    asyncio.run(run_anomaly_scheduler_tick([("delivery_anomaly", job)], get_setting, set_setting, now))
    job.assert_not_awaited()


def test_after_4pm_runs_job_again_next_day_even_if_ran_yesterday():
    store, get_setting, set_setting = _settings_store()
    set_setting("anomaly_scheduler_ran_delivery_anomaly", datetime(2026, 7, 21, 16, 0, tzinfo=_KST).isoformat())
    job = AsyncMock()
    now = datetime(2026, 7, 22, 16, 0, tzinfo=_KST)
    asyncio.run(run_anomaly_scheduler_tick([("delivery_anomaly", job)], get_setting, set_setting, now))
    job.assert_awaited_once_with(force=True)


def test_one_job_failing_does_not_block_the_others():
    store, get_setting, set_setting = _settings_store()
    failing_job = AsyncMock(side_effect=RuntimeError("ably down"))
    ok_job = AsyncMock()
    now = datetime(2026, 7, 22, 16, 0, tzinfo=_KST)
    asyncio.run(run_anomaly_scheduler_tick(
        [("return_anomaly", failing_job), ("exchange_return_anomaly", ok_job)],
        get_setting, set_setting, now,
    ))
    failing_job.assert_awaited_once_with(force=True)
    ok_job.assert_awaited_once_with(force=True)
    assert "anomaly_scheduler_ran_return_anomaly" not in store
    assert "anomaly_scheduler_ran_exchange_return_anomaly" in store
```

- [ ] **Step 2: 테스트 실행해서 실패 확인**

Run: `cd backend && python -m pytest tests/test_anomaly_scheduler.py -v`
Expected: FAIL - `ModuleNotFoundError: No module named 'services.anomaly_scheduler'`

- [ ] **Step 3: 최소 구현 작성**

`backend/services/anomaly_scheduler.py` 파일을 새로 만든다:

```python
from __future__ import annotations

import asyncio
import traceback
from datetime import datetime, timedelta, timezone
from typing import Awaitable, Callable

_KST = timezone(timedelta(hours=9))

RUN_HOUR_KST = 16
POLL_INTERVAL_SECONDS = 300

AnomalyJob = tuple[str, Callable[..., Awaitable[None]]]


def _scheduler_setting_key(name: str) -> str:
    return f"anomaly_scheduler_ran_{name}"


async def run_anomaly_scheduler_tick(
    jobs: list[AnomalyJob],
    get_setting: Callable[[str], str | None],
    set_setting: Callable[[str, str], None],
    now: datetime,
) -> None:
    """오후 4시(KST) 이후, 오늘 아직 못 돌린 이상현상 작업들을 강제로 1회씩 실행한다.

    각 작업(job)은 수동 새로고침용 당일-가드를 자체적으로 갖고 있지만, 그 가드는
    사용자가 4시 이전에 이미 새로고침을 눌렀으면 스킵해버린다. 이 스케줄러는 그와
    무관하게 4시 이후 하루 1회는 항상 실행되도록 별도 키로 추적한다.
    """
    if now.hour < RUN_HOUR_KST:
        return

    today_str = now.strftime("%Y-%m-%d")
    for name, job in jobs:
        setting_key = _scheduler_setting_key(name)
        if str(get_setting(setting_key) or "")[:10] == today_str:
            continue
        try:
            await job(force=True)
            set_setting(setting_key, now.isoformat())
        except Exception:
            traceback.print_exc()  # 이 작업만 실패 - 다음 틱(5분 뒤)에 재시도


async def run_anomaly_scheduler_loop(
    jobs: list[AnomalyJob],
    get_setting: Callable[[str], str | None],
    set_setting: Callable[[str, str], None],
) -> None:
    while True:
        try:
            await run_anomaly_scheduler_tick(jobs, get_setting, set_setting, datetime.now(_KST))
        except Exception:
            traceback.print_exc()
        await asyncio.sleep(POLL_INTERVAL_SECONDS)
```

- [ ] **Step 4: 테스트 실행해서 통과 확인**

Run: `cd backend && python -m pytest tests/test_anomaly_scheduler.py -v`
Expected: PASS (5 tests)

- [ ] **Step 5: 커밋**

```bash
git add backend/services/anomaly_scheduler.py backend/tests/test_anomaly_scheduler.py
git commit -m "feat: add anomaly_scheduler service for 4pm KST scheduled runs"
```

---

### Task 2: `delivery_anomaly_routes.py` - `run_scheduled` 노출

**Files:**
- Modify: `backend/api/delivery_anomaly_routes.py:419-474`
- Modify: `backend/tests/test_delivery_anomaly_routes.py`

**Interfaces:**
- Consumes: 없음 (Task 1과 무관하게 독립적으로 진행 가능)
- Produces: `build_delivery_anomaly_router(...)`가 반환하는 `router` 객체에 `router.run_scheduled: Callable[[bool], Awaitable[None]]` 속성 추가 (`async def run_scheduled(force: bool = False) -> None`와 동일 시그니처). `main.py`(Task 5)가 이 속성을 사용한다.

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_delivery_anomaly_routes.py`의 import 블록을 아래로 교체한다 (기존 `_KST` import 없음 → 추가, `asyncio`/`datetime` 추가):

```python
import asyncio
import sqlite3
import sys
import uuid
from datetime import datetime
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.delivery_anomaly_routes import (
    EzAdminSessionExpired,
    EzDeskSessionExpired,
    _KST,
    build_delivery_anomaly_router,
)
from services.delivery_anomaly_store import init_delivery_anomaly_tables, sync_anomalies
```

파일 맨 끝에 아래 테스트를 추가한다:

```python
def test_run_scheduled_attribute_skips_when_already_run_today():
    get_db, keep_alive = _make_db_factory()
    init_delivery_anomaly_tables(get_db)
    today_iso = datetime.now(_KST).isoformat()
    router = build_delivery_anomaly_router(
        get_current_user=lambda: "tester",
        get_db=get_db,
        get_setting=lambda key: today_iso if key == "delivery_anomaly_last_run_date" else None,
        set_setting=lambda key, value: None,
    )
    assert hasattr(router, "run_scheduled")
    asyncio.run(router.run_scheduled(force=False))  # 네트워크 호출 없이 즉시 반환돼야 함
```

- [ ] **Step 2: 테스트 실행해서 실패 확인**

Run: `cd backend && python -m pytest tests/test_delivery_anomaly_routes.py::test_run_scheduled_attribute_skips_when_already_run_today -v`
Expected: FAIL - `AttributeError: 'APIRouter' object has no attribute 'run_scheduled'`

- [ ] **Step 3: `delivery_anomaly_routes.py` 리팩터링**

`backend/api/delivery_anomaly_routes.py`의 419번째 줄부터 파일 끝(474번째 줄)까지를 아래로 교체한다:

```python
    async def _run_check_core(force: bool = False) -> None:
        today_str = datetime.now(_KST).strftime("%Y-%m-%d")
        last_run = get_setting(_LAST_RUN_SETTING_KEY)
        if str(last_run or "")[:10] == today_str and not force:
            return  # 오늘 이미 실행됨 - 재조회 없이 종료

        ably_token = await _ably_login()
        ably_items = await _fetch_ably_shipping_items(ably_token)

        llogis_token = await _llogis_login()
        computed: dict[str, dict] = {}
        today = datetime.now(_KST).date()
        for item in ably_items:
            inv_no = item["invoice_no"]
            if not inv_no:
                continue
            sent_date = parse_ably_sent_date(item["sent_date"])
            try:
                llogis_raw = await _llogis_query(inv_no, llogis_token)
            except Exception:
                continue
            reason = evaluate_anomaly(sent_date, today, llogis_raw)
            if not reason:
                continue
            if is_invoice_missing(llogis_raw):
                status, location, scan_date = "-", "-", "-"
            else:
                latest = latest_movement(llogis_raw) or {}
                status = latest.get("paclStatNm") or "-"
                location = latest.get("scanBrshNm") or "-"
                scan_date = latest.get("rgstYmd") or "-"
            computed[inv_no] = {
                "order_no": item["order_no"],
                "product_name": item["product_name"],
                "option_info": item["option_info"],
                "phone": item["phone"],
                "sent_date": item["sent_date"],
                "status": status,
                "location": location,
                "scan_date": scan_date,
                "reason": reason,
            }

        conn = get_db()
        sync_anomalies(conn, computed)
        try:
            await _check_confirm_replies(conn)
        except Exception:
            pass  # 답장 확인 실패는 이상현상 갱신 자체를 막지 않는다
        conn.close()
        set_setting(_LAST_RUN_SETTING_KEY, datetime.now(_KST).isoformat())

    @router.post("/run")
    async def run_check(force: bool = False, user: str = Depends(get_current_user)):
        await _run_check_core(force=force)
        return list_anomalies(user=user)

    router.run_scheduled = _run_check_core
    return router
```

- [ ] **Step 4: 전체 테스트 실행해서 통과 확인**

Run: `cd backend && python -m pytest tests/test_delivery_anomaly_routes.py -v`
Expected: PASS (기존 테스트 전부 + 새 테스트 1개, 총 23개)

- [ ] **Step 5: 커밋**

```bash
git add backend/api/delivery_anomaly_routes.py backend/tests/test_delivery_anomaly_routes.py
git commit -m "refactor: expose run_scheduled on delivery anomaly router"
```

---

### Task 3: `return_anomaly_routes.py` - `run_scheduled` 노출

**Files:**
- Modify: `backend/api/return_anomaly_routes.py:57-134`
- Create: `backend/tests/test_return_anomaly_routes.py`

**Interfaces:**
- Consumes: 없음 (Task 2와 동일 패턴, 독립적)
- Produces: `build_return_anomaly_router(...)`가 반환하는 `router`에 `router.run_scheduled` 속성 추가 (Task 2와 동일 시그니처)

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_return_anomaly_routes.py` 파일을 새로 만든다:

```python
import asyncio
import sqlite3
import sys
import uuid
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from api.return_anomaly_routes import _KST, build_return_anomaly_router
from services.return_anomaly_store import init_return_anomaly_tables


def _make_db_factory():
    uri = f"file:test_return_anomaly_routes_{uuid.uuid4().hex}?mode=memory&cache=shared"
    keep_alive = sqlite3.connect(uri, uri=True)
    keep_alive.row_factory = sqlite3.Row

    def factory():
        conn = sqlite3.connect(uri, uri=True)
        conn.row_factory = sqlite3.Row
        return conn

    return factory, keep_alive


def test_run_scheduled_attribute_skips_when_already_run_today():
    get_db, keep_alive = _make_db_factory()
    init_return_anomaly_tables(get_db)
    today_iso = datetime.now(_KST).isoformat()
    router = build_return_anomaly_router(
        get_current_user=lambda: "tester",
        get_db=get_db,
        get_setting=lambda key: today_iso if key == "return_anomaly_last_run_date" else None,
        set_setting=lambda key, value: None,
    )
    assert hasattr(router, "run_scheduled")
    asyncio.run(router.run_scheduled(force=False))  # 네트워크 호출 없이 즉시 반환돼야 함
```

- [ ] **Step 2: 테스트 실행해서 실패 확인**

Run: `cd backend && python -m pytest tests/test_return_anomaly_routes.py -v`
Expected: FAIL - `AttributeError: 'APIRouter' object has no attribute 'run_scheduled'`

- [ ] **Step 3: `return_anomaly_routes.py` 리팩터링**

`backend/api/return_anomaly_routes.py`의 57번째 줄부터 파일 끝(134번째 줄)까지를 아래로 교체한다:

```python
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
```

- [ ] **Step 4: 테스트 실행해서 통과 확인**

Run: `cd backend && python -m pytest tests/test_return_anomaly_routes.py -v`
Expected: PASS (1 test)

- [ ] **Step 5: 커밋**

```bash
git add backend/api/return_anomaly_routes.py backend/tests/test_return_anomaly_routes.py
git commit -m "refactor: expose run_scheduled on return anomaly router"
```

---

### Task 4: `exchange_return_anomaly_routes.py` - `run_scheduled` 노출

**Files:**
- Modify: `backend/api/exchange_return_anomaly_routes.py:58-126`
- Create: `backend/tests/test_exchange_return_anomaly_routes.py`

**Interfaces:**
- Consumes: 없음 (Task 2/3과 동일 패턴, 독립적)
- Produces: `build_exchange_return_anomaly_router(...)`가 반환하는 `router`에 `router.run_scheduled` 속성 추가 (Task 2와 동일 시그니처)

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_exchange_return_anomaly_routes.py` 파일을 새로 만든다:

```python
import asyncio
import sqlite3
import sys
import uuid
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from api.exchange_return_anomaly_routes import _KST, build_exchange_return_anomaly_router
from services.exchange_return_anomaly_store import init_exchange_return_anomaly_tables


def _make_db_factory():
    uri = f"file:test_exchange_return_anomaly_routes_{uuid.uuid4().hex}?mode=memory&cache=shared"
    keep_alive = sqlite3.connect(uri, uri=True)
    keep_alive.row_factory = sqlite3.Row

    def factory():
        conn = sqlite3.connect(uri, uri=True)
        conn.row_factory = sqlite3.Row
        return conn

    return factory, keep_alive


def test_run_scheduled_attribute_skips_when_already_run_today():
    get_db, keep_alive = _make_db_factory()
    init_exchange_return_anomaly_tables(get_db)
    today_iso = datetime.now(_KST).isoformat()
    router = build_exchange_return_anomaly_router(
        get_current_user=lambda: "tester",
        get_db=get_db,
        get_setting=lambda key: today_iso if key == "exchange_return_anomaly_last_run_date" else None,
        set_setting=lambda key, value: None,
    )
    assert hasattr(router, "run_scheduled")
    asyncio.run(router.run_scheduled(force=False))  # 네트워크 호출 없이 즉시 반환돼야 함
```

- [ ] **Step 2: 테스트 실행해서 실패 확인**

Run: `cd backend && python -m pytest tests/test_exchange_return_anomaly_routes.py -v`
Expected: FAIL - `AttributeError: 'APIRouter' object has no attribute 'run_scheduled'`

- [ ] **Step 3: `exchange_return_anomaly_routes.py` 리팩터링**

`backend/api/exchange_return_anomaly_routes.py`의 58번째 줄부터 파일 끝(126번째 줄)까지를 아래로 교체한다:

```python
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
```

- [ ] **Step 4: 테스트 실행해서 통과 확인**

Run: `cd backend && python -m pytest tests/test_exchange_return_anomaly_routes.py -v`
Expected: PASS (1 test)

- [ ] **Step 5: 커밋**

```bash
git add backend/api/exchange_return_anomaly_routes.py backend/tests/test_exchange_return_anomaly_routes.py
git commit -m "refactor: expose run_scheduled on exchange return anomaly router"
```

---

### Task 5: `main.py` - 백그라운드 스케줄러 기동

**Files:**
- Modify: `backend/main.py:1-3` (import 추가)
- Modify: `backend/main.py:65-67` (import 추가)
- Modify: `backend/main.py:1553-1584` (라우터 등록 + 스케줄러 wiring)

**Interfaces:**
- Consumes:
  - Task 1의 `services.anomaly_scheduler.run_anomaly_scheduler_loop(jobs, get_setting, set_setting)`
  - Task 2/3/4에서 각 라우터에 추가된 `.run_scheduled(force: bool = False) -> Awaitable[None]`
- Produces: 없음 (최종 배선 - main.py는 다른 태스크가 의존하지 않는 진입점)

이 태스크는 main.py 전체를 부팅하는 배선(wiring) 작업이라 격리된 pytest 유닛 테스트 대상이 아니다(기존 코드베이스에도 `main.py`를 직접 import해서 테스트하는 파일이 없음 - 대신 각 라우터를 개별 서비스/라우트 테스트로 검증한다). 이 태스크는 "실제로 import/부팅이 되는지"를 수동 스모크 테스트로 확인하고, 마지막에 전체 테스트 스위트를 돌려 회귀가 없는지 확인한다.

- [ ] **Step 1: `import asyncio` 추가**

`backend/main.py` 최상단을 찾는다:

```python
from dotenv import load_dotenv
load_dotenv()
import json
```

아래로 교체한다:

```python
from dotenv import load_dotenv
load_dotenv()
import asyncio
import json
```

- [ ] **Step 2: `anomaly_scheduler` import 추가**

`backend/main.py`에서 아래 줄을 찾는다:

```python
from services.delivery_anomaly_store import init_delivery_anomaly_tables
from services.exchange_return_anomaly_store import init_exchange_return_anomaly_tables
from services.return_anomaly_store import init_return_anomaly_tables
```

아래로 교체한다:

```python
from services.delivery_anomaly_store import init_delivery_anomaly_tables
from services.exchange_return_anomaly_store import init_exchange_return_anomaly_tables
from services.return_anomaly_store import init_return_anomaly_tables
from services.anomaly_scheduler import run_anomaly_scheduler_loop
```

- [ ] **Step 3: 라우터 등록부를 변수 캡처 + 스케줄러 wiring으로 교체**

`backend/main.py`에서 아래 블록(원래 1553~1584번째 줄, 세 이상현상 라우터를 등록하는 부분)을 찾는다:

```python
init_delivery_anomaly_tables(_get_shared_db)

app.include_router(
    build_delivery_anomaly_router(
        get_current_user=_get_current_user,
        get_db=_get_shared_db,
        get_setting=_get_setting,
        set_setting=_set_setting,
    )
)

init_exchange_return_anomaly_tables(_get_shared_db)

app.include_router(
    build_exchange_return_anomaly_router(
        get_current_user=_get_current_user,
        get_db=_get_shared_db,
        get_setting=_get_setting,
        set_setting=_set_setting,
    )
)

init_return_anomaly_tables(_get_shared_db)

app.include_router(
    build_return_anomaly_router(
        get_current_user=_get_current_user,
        get_db=_get_shared_db,
        get_setting=_get_setting,
        set_setting=_set_setting,
    )
)
```

아래로 교체한다:

```python
init_delivery_anomaly_tables(_get_shared_db)

_delivery_anomaly_router = build_delivery_anomaly_router(
    get_current_user=_get_current_user,
    get_db=_get_shared_db,
    get_setting=_get_setting,
    set_setting=_set_setting,
)
app.include_router(_delivery_anomaly_router)

init_exchange_return_anomaly_tables(_get_shared_db)

_exchange_return_anomaly_router = build_exchange_return_anomaly_router(
    get_current_user=_get_current_user,
    get_db=_get_shared_db,
    get_setting=_get_setting,
    set_setting=_set_setting,
)
app.include_router(_exchange_return_anomaly_router)

init_return_anomaly_tables(_get_shared_db)

_return_anomaly_router = build_return_anomaly_router(
    get_current_user=_get_current_user,
    get_db=_get_shared_db,
    get_setting=_get_setting,
    set_setting=_set_setting,
)
app.include_router(_return_anomaly_router)

_ANOMALY_SCHEDULER_JOBS = [
    ("delivery_anomaly", _delivery_anomaly_router.run_scheduled),
    ("return_anomaly", _return_anomaly_router.run_scheduled),
    ("exchange_return_anomaly", _exchange_return_anomaly_router.run_scheduled),
]


@app.on_event("startup")
async def _start_anomaly_scheduler():
    asyncio.create_task(
        run_anomaly_scheduler_loop(_ANOMALY_SCHEDULER_JOBS, _get_setting, _set_setting)
    )
```

- [ ] **Step 4: import 스모크 테스트**

Run: `cd backend && python -c "import main; print('jobs:', [name for name, _ in main._ANOMALY_SCHEDULER_JOBS])"`
Expected: 에러 없이 종료하고 `jobs: ['delivery_anomaly', 'return_anomaly', 'exchange_return_anomaly']` 출력

- [ ] **Step 5: 전체 백엔드 테스트 스위트 실행해서 회귀 없는지 확인**

Run: `cd backend && python -m pytest -q`
Expected: PASS, 이전 97개 + 이번에 추가된 테스트(스케줄러 5개 + 라우터별 1개씩 3개 = 8개) 총 105개 모두 통과, 실패 0개

- [ ] **Step 6: 커밋**

```bash
git add backend/main.py
git commit -m "feat: start 4pm KST anomaly scheduler on app startup"
```

---

## Post-Implementation Verification (수동, 선택)

로컬에서 실제로 동작을 눈으로 확인하고 싶다면:

1. `backend/main.py`의 `RUN_HOUR_KST`를 잠깐 `services/anomaly_scheduler.py`에서 낮은 값(예: 현재 시각보다 이전 시)으로 바꾸거나, `POLL_INTERVAL_SECONDS`를 짧게(예: 10) 바꿔서 로컬 서버(`uvicorn main:app --reload`)를 띄운 뒤, 콘솔에 스케줄러가 각 작업을 시도하는지(에러가 나도 `traceback.print_exc()` 출력으로 확인 가능) 지켜본다.
2. 확인이 끝나면 두 상수를 원래 값(16, 300)으로 반드시 되돌린다 - 이 변경은 커밋하지 않는다.
