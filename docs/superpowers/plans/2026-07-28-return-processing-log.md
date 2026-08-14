# 반품 처리기록(처리 로그) 탭 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a permanent, filterable audit log of "처리성" button clicks on the 반품 페이지의 판매자 대기(seller) / 교환판매자(exchange_seller) 큐, exposed as a new "처리기록" tab.

**Architecture:** A new dedicated backend router (`backend/api/return_processing_log_routes.py`, following the existing `return_regathering_routes.py` pattern) owns a new shared-DB table `return_processing_log` with a POST endpoint (insert one row per processed item) and a GET endpoint (filtered listing). The frontend (`src/components/Barcode/ReturnsPage.jsx`) gets a small logging helper wired into the 7 in-scope action handlers, plus a new "처리기록" tab with a filter bar and table.

**Tech Stack:** FastAPI + sqlite3 (backend), React (frontend), pytest + FastAPI TestClient (backend tests). No frontend automated test suite exists in this repo (per `CLAUDE.md`) — frontend tasks are verified via `npm run lint` / `npm run build` and manual browser checks.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-28-return-processing-log-design.md` — follow it exactly; this plan implements it in full.
- Only log these 7 actions, only from the `seller` / `exchange_seller` queues: `ably_refund`, `reason_change_sms`, `reason_change_no_sms`, `ezadmin_stockin`, `kimsungil_send`, `exchange_change_product`, `delete`. Never log from `customer` / `exchange_customer` / `unmatched` / `all` tabs, and never log "이지어드민 정보 불러오기" or "바코드 출력".
- Logging POST failures must never surface to the user or block the main action (fire-and-forget, swallow errors).
- Follow existing code conventions: shared DB via `_get_shared_db()`, per-router `build_*_router(*, ...)` factory pattern, Korean UI copy matching existing labels exactly (e.g. "선택삭제", "이지어드민 입고처리", "김승일보내기").
- Do not touch unrelated pre-existing uncommitted changes in this working tree (there is WIP from other work already present — only stage files this plan actually creates/modifies).

---

### Task 1: Backend — `return_processing_log` table + router + tests

**Files:**
- Create: `backend/api/return_processing_log_routes.py`
- Modify: `backend/main.py` (add import, table-init function, router registration)
- Test: `backend/tests/test_return_processing_log_routes.py`

**Interfaces:**
- Produces: `build_return_processing_log_router(*, get_current_user, get_shared_db) -> APIRouter` with prefix `/returns/processing-log`, exposing `POST ""` (insert) and `GET ""` (filtered list). Response shapes: POST → `{"ok": true}` or 400 with `detail`; GET → `{"items": [...]}` where each item is the DB row as a dict with `images` already JSON-decoded to a list.
- Consumes: nothing from other tasks (this task is fully self-contained; Task 2/3 will call these two HTTP endpoints from the frontend).

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_return_processing_log_routes.py`:

```python
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import FastAPI
from fastapi.testclient import TestClient

import api.return_processing_log_routes as processing_log_routes


def _make_client(tmp_path):
    db_path = tmp_path / "test_processing_log.db"
    conn = sqlite3.connect(db_path)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS return_processing_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at TEXT NOT NULL,
            username TEXT NOT NULL DEFAULT '',
            queue TEXT NOT NULL,
            action TEXT NOT NULL,
            action_label TEXT NOT NULL,
            item_text TEXT NOT NULL DEFAULT '',
            qty TEXT NOT NULL DEFAULT '',
            type TEXT NOT NULL DEFAULT '',
            reason TEXT NOT NULL DEFAULT '',
            detail_reason TEXT NOT NULL DEFAULT '',
            images TEXT NOT NULL DEFAULT '[]',
            ezadmin_seq TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT ''
        )
        """
    )
    conn.commit()
    conn.close()

    def _get_shared_db():
        c = sqlite3.connect(db_path)
        c.row_factory = sqlite3.Row
        return c

    app = FastAPI()
    app.include_router(
        processing_log_routes.build_return_processing_log_router(
            get_current_user=lambda: "tester",
            get_shared_db=_get_shared_db,
        )
    )
    return TestClient(app)


def test_add_processing_log_inserts_one_row_per_entry(tmp_path):
    client = _make_client(tmp_path)
    res = client.post(
        "/returns/processing-log",
        json={
            "queue": "seller",
            "action": "ably_refund",
            "action_label": "에이블리 환불요청",
            "entries": [
                {"item_text": "상품A", "qty": "2", "type": "판매자", "reason": "단순변심",
                 "detail_reason": "", "images": ["http://img/1.jpg"], "ezadmin_seq": "1001", "status": "완료"},
                {"item_text": "상품B", "qty": "1", "type": "판매자", "reason": "하자",
                 "detail_reason": "찢어짐", "images": [], "ezadmin_seq": "", "status": "실패: 오류"},
            ],
        },
    )
    assert res.status_code == 200
    assert res.json()["ok"] is True

    list_res = client.get("/returns/processing-log")
    assert list_res.status_code == 200
    items = list_res.json()["items"]
    assert len(items) == 2
    texts = {item["item_text"] for item in items}
    assert texts == {"상품A", "상품B"}
    assert all(item["username"] == "tester" for item in items)
    assert all(item["queue"] == "seller" for item in items)
    a = next(item for item in items if item["item_text"] == "상품A")
    assert a["images"] == ["http://img/1.jpg"]


def test_list_filters_by_queue_and_action(tmp_path):
    client = _make_client(tmp_path)
    client.post("/returns/processing-log", json={
        "queue": "seller", "action": "ably_refund", "action_label": "에이블리 환불요청",
        "entries": [{"item_text": "A", "status": "완료"}],
    })
    client.post("/returns/processing-log", json={
        "queue": "exchange_seller", "action": "exchange_change_product", "action_label": "교환처리 실행",
        "entries": [{"item_text": "B", "status": "완료"}],
    })

    res = client.get("/returns/processing-log", params={"queue": "exchange_seller"})
    items = res.json()["items"]
    assert len(items) == 1
    assert items[0]["item_text"] == "B"

    res2 = client.get("/returns/processing-log", params={"action": "ably_refund"})
    items2 = res2.json()["items"]
    assert len(items2) == 1
    assert items2[0]["item_text"] == "A"


def test_list_filters_by_search_text(tmp_path):
    client = _make_client(tmp_path)
    client.post("/returns/processing-log", json={
        "queue": "seller", "action": "delete", "action_label": "선택삭제",
        "entries": [
            {"item_text": "레드 티셔츠", "ezadmin_seq": "SEQ-1", "status": "삭제됨"},
            {"item_text": "블루 팬츠", "ezadmin_seq": "SEQ-2", "status": "삭제됨"},
        ],
    })

    res = client.get("/returns/processing-log", params={"q": "레드"})
    items = res.json()["items"]
    assert len(items) == 1
    assert items[0]["item_text"] == "레드 티셔츠"

    res2 = client.get("/returns/processing-log", params={"q": "SEQ-2"})
    items2 = res2.json()["items"]
    assert len(items2) == 1
    assert items2[0]["item_text"] == "블루 팬츠"


def test_add_processing_log_requires_queue_and_entries(tmp_path):
    client = _make_client(tmp_path)
    res = client.post("/returns/processing-log", json={"queue": "", "action": "delete", "entries": []})
    assert res.status_code == 400
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_return_processing_log_routes.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'api.return_processing_log_routes'`

- [ ] **Step 3: Create the router module**

Create `backend/api/return_processing_log_routes.py`:

```python
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Body, Depends, HTTPException

_KST = timezone(timedelta(hours=9))


def build_return_processing_log_router(
    *,
    get_current_user,
    get_shared_db,
):
    router = APIRouter(prefix="/returns/processing-log")

    @router.post("")
    def add_processing_log(payload: dict = Body(...), user: str = Depends(get_current_user)):
        queue = str(payload.get("queue") or "").strip()
        action = str(payload.get("action") or "").strip()
        action_label = str(payload.get("action_label") or "").strip()
        entries = payload.get("entries") or []
        if not queue or not action or not entries:
            raise HTTPException(status_code=400, detail="queue/action/entries가 필요합니다.")

        now = datetime.now(_KST).isoformat()
        conn = get_shared_db()
        try:
            for entry in entries:
                conn.execute(
                    """
                    INSERT INTO return_processing_log
                        (created_at, username, queue, action, action_label,
                         item_text, qty, type, reason, detail_reason, images, ezadmin_seq, status)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        now,
                        user,
                        queue,
                        action,
                        action_label,
                        str(entry.get("item_text") or ""),
                        str(entry.get("qty") or ""),
                        str(entry.get("type") or ""),
                        str(entry.get("reason") or ""),
                        str(entry.get("detail_reason") or ""),
                        json.dumps(entry.get("images") or [], ensure_ascii=False),
                        str(entry.get("ezadmin_seq") or ""),
                        str(entry.get("status") or ""),
                    ),
                )
            conn.commit()
        finally:
            conn.close()
        return {"ok": True}

    @router.get("")
    def list_processing_log(
        queue: str | None = None,
        action: str | None = None,
        date_from: str | None = None,
        date_to: str | None = None,
        q: str | None = None,
        limit: int = 200,
        user: str = Depends(get_current_user),
    ):
        conditions = []
        params: list = []
        if queue:
            conditions.append("queue = ?")
            params.append(queue)
        if action:
            conditions.append("action = ?")
            params.append(action)
        if date_from:
            conditions.append("created_at >= ?")
            params.append(date_from)
        if date_to:
            conditions.append("created_at <= ?")
            params.append(f"{date_to}T23:59:59")
        if q:
            conditions.append("(item_text LIKE ? OR ezadmin_seq LIKE ?)")
            like = f"%{q}%"
            params.extend([like, like])

        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
        conn = get_shared_db()
        try:
            rows = conn.execute(
                f"SELECT * FROM return_processing_log {where} ORDER BY created_at DESC LIMIT ?",
                (*params, limit),
            ).fetchall()
        finally:
            conn.close()

        items = []
        for row in rows:
            item = dict(row)
            try:
                item["images"] = json.loads(item.get("images") or "[]")
            except (TypeError, ValueError):
                item["images"] = []
            items.append(item)
        return {"items": items}

    return router
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_return_processing_log_routes.py -v`
Expected: 4 passed

- [ ] **Step 5: Wire the router into `backend/main.py`**

Add the import next to the other route-builder imports. Find this line (around line 61):

```python
from api.return_regathering_routes import build_return_regathering_router
```

Add immediately after it:

```python
from api.return_processing_log_routes import build_return_processing_log_router
```

Then find the `_init_return_regathering()` block and its `app.include_router(build_return_regathering_router(...))` call (around line 1618-1650):

```python
def _init_return_regathering():
    conn = _get_shared_db()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS return_regathering (
            ...
        )
        """
    )
    conn.commit()
    conn.close()


_init_return_regathering()

app.include_router(
    build_return_regathering_router(
        get_current_user=_get_current_user,
        get_return_state=_get_return_state,
        get_shared_db=_get_shared_db,
        get_setting=_get_setting,
        return_queue_payload=_return_queue_payload,
    )
)
```

Immediately after that `app.include_router(build_return_regathering_router(...))` block, add:

```python
def _init_return_processing_log():
    conn = _get_shared_db()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS return_processing_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at TEXT NOT NULL,
            username TEXT NOT NULL DEFAULT '',
            queue TEXT NOT NULL,
            action TEXT NOT NULL,
            action_label TEXT NOT NULL,
            item_text TEXT NOT NULL DEFAULT '',
            qty TEXT NOT NULL DEFAULT '',
            type TEXT NOT NULL DEFAULT '',
            reason TEXT NOT NULL DEFAULT '',
            detail_reason TEXT NOT NULL DEFAULT '',
            images TEXT NOT NULL DEFAULT '[]',
            ezadmin_seq TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT ''
        )
        """
    )
    conn.commit()
    conn.close()


_init_return_processing_log()

app.include_router(
    build_return_processing_log_router(
        get_current_user=_get_current_user,
        get_shared_db=_get_shared_db,
    )
)
```

- [ ] **Step 6: Sanity-check the server still boots**

Run: `cd backend && python -c "import main"`
Expected: no exceptions (import-time table creation + router registration succeed).

- [ ] **Step 7: Run the full backend test suite**

Run: `cd backend && python -m pytest -q`
Expected: all tests pass (no regressions from the new import/table/router).

- [ ] **Step 8: Commit**

```bash
git add backend/api/return_processing_log_routes.py backend/tests/test_return_processing_log_routes.py backend/main.py
git commit -m "Add return_processing_log table + router for 반품 처리기록"
```

---

### Task 2: Frontend — wire logging into the 7 in-scope action handlers

**Files:**
- Modify: `src/components/Barcode/ReturnsPage.jsx`

**Interfaces:**
- Consumes: `POST /returns/processing-log` from Task 1 (body `{queue, action, action_label, entries: [...]}` , fire-and-forget).
- Produces: `logProcessingActions(queue, action, actionLabel, entries)` and `buildLogEntry(item, status)` helpers, used by Task 2's own handler edits. `handleEzadminReceiveStock(selectedItems, queue)`, `handleSendToKimsungil(selectedItems, queue)`, `handleDeleteSelected(selectedIds, setSelectedIds, queueKey, items)`, and `renderQueueTab(items, selectedIds, setSelectedIds, extraActions, showSmsAction, queueKey)` all gain a trailing parameter — Task 3 does not depend on these signatures, but do not regress existing call sites (all fixed up in this task).

This task has no automated test suite to drive it (frontend has none, per `CLAUDE.md`). Each step is a precise, verifiable edit; the task's overall deliverable is verified in Step 14 by lint + build + a manual click-through.

- [ ] **Step 1: Add the `PROCESSING_LOG_ACTIONS` constant and logging helpers**

In `src/components/Barcode/ReturnsPage.jsx`, find (near the top, after `EMPTY_QUEUES`/`normalizeQueues`):

```js
const normalizeQueues = (queues) => ({ ...EMPTY_QUEUES, ...(queues || {}) });

const ReturnsPage = () => {
```

Insert a new constant between them:

```js
const normalizeQueues = (queues) => ({ ...EMPTY_QUEUES, ...(queues || {}) });

const PROCESSING_LOG_ACTIONS = [
    ['ably_refund', '에이블리 환불요청'],
    ['reason_change_sms', '일반사유변경(문자)'],
    ['reason_change_no_sms', '일반사유변경(문자없이)'],
    ['ezadmin_stockin', '이지어드민 입고처리'],
    ['kimsungil_send', '김승일보내기'],
    ['exchange_change_product', '교환처리 실행'],
    ['delete', '선택삭제'],
];

const ReturnsPage = () => {
```

Then find `handleAblyRefundSubmit` (around line 393):

```js
    const handleAblyRefundSubmit = async (selectedItems) => {
```

Insert two helper functions immediately before it:

```js
    const buildLogEntry = (item, status) => ({
        item_text: item?.item_text || '',
        qty: item?.qty || '',
        type: item?.type || '',
        reason: item?.reason || '',
        detail_reason: item?.detail_reason || '',
        images: item?.images || [],
        ezadmin_seq: item?.ezadmin_seq || '',
        status,
    });

    const logProcessingActions = async (queue, action, actionLabel, entries) => {
        if (!entries || !entries.length) return;
        try {
            await fetch(`${API}/returns/processing-log`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
                body: JSON.stringify({ queue, action, action_label: actionLabel, entries }),
            });
        } catch {
            // 로깅 실패는 조용히 무시 (사용자 플로우를 막지 않음)
        }
    };

    const handleAblyRefundSubmit = async (selectedItems) => {
```

- [ ] **Step 2: Log after 에이블리 환불요청 succeeds**

Find in `handleAblyRefundSubmit` (around line 407):

```js
            setRefundResults(data.results);
            const ok = data.results.filter((r) => r.ok).length;
            setMessage(`에이블리 반품 넘기기 완료: ${ok}/${data.results.length}건 성공`);
```

Replace with:

```js
            setRefundResults(data.results);
            const logEntries = data.results.map((r) => {
                const src = selectedItems.find((i) => i.id === r.id) || {};
                return buildLogEntry(src, r.ok ? '완료' : `실패: ${r.error || ''}`);
            });
            logProcessingActions('seller', 'ably_refund', '에이블리 환불요청', logEntries);
            const ok = data.results.filter((r) => r.ok).length;
            setMessage(`에이블리 반품 넘기기 완료: ${ok}/${data.results.length}건 성공`);
```

(This handler is only ever called from the 판매자 대기 tab button, so `'seller'` is hardcoded.)

- [ ] **Step 3: Log after 일반사유변경(문자) succeeds**

Find in `handleConfirmReasonChangeWithSms` (around line 469):

```js
            setReasonChangeResults(data.results);
            const reasonOk = data.results.filter((r) => r.ok).length;

            let smsOk = 0;
```

Replace with:

```js
            setReasonChangeResults(data.results);
            const logEntries = data.results.map((r) => {
                const src = items.find((i) => i.id === r.id) || {};
                return buildLogEntry(src, r.ok ? '완료' : `실패: ${r.error || ''}`);
            });
            logProcessingActions('seller', 'reason_change_sms', '일반사유변경(문자)', logEntries);
            const reasonOk = data.results.filter((r) => r.ok).length;

            let smsOk = 0;
```

(`openReasonChangeTemplateModal` is only opened from the 판매자 대기 tab, so `'seller'` is hardcoded.)

- [ ] **Step 4: Log after 일반사유변경(문자없이) succeeds**

Find in `handleReasonChangeWithoutSms` (around line 530):

```js
            setReasonChangeResults(data.results);
            const reasonOk = data.results.filter((r) => r.ok).length;
            setMessage(`일반사유 변경 완료(문자 미발송): ${reasonOk}/${data.results.length}건 성공`);
```

Replace with:

```js
            setReasonChangeResults(data.results);
            const logEntries = data.results.map((r) => {
                const src = items.find((i) => i.id === r.id) || {};
                return buildLogEntry(src, r.ok ? '완료' : `실패: ${r.error || ''}`);
            });
            logProcessingActions('seller', 'reason_change_no_sms', '일반사유변경(문자없이)', logEntries);
            const reasonOk = data.results.filter((r) => r.ok).length;
            setMessage(`일반사유 변경 완료(문자 미발송): ${reasonOk}/${data.results.length}건 성공`);
```

- [ ] **Step 5: Thread a `queue` parameter through `handleEzadminReceiveStock`**

Find (around line 648-683):

```js
    const handleEzadminReceiveStock = async (selectedItems) => {
        if (!selectedItems || !selectedItems.length) return;
        setStockinLoading(true);
        setStockinResults(null);
        setMessage('');
        try {
            const res = await fetch(`${API}/returns/ezadmin-receive-stock`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
                body: JSON.stringify({ items: selectedItems }),
            });
            const data = await res.json().catch(() => ({}));
            if (data?.queues) setQueues(normalizeQueues(data.queues));
            if (data?.need_session) {
                openEzadminModal(() => handleEzadminReceiveStock(selectedItems));
                return;
            }
            if (!res.ok || !data?.ok) throw new Error(data?.detail || '처리 실패');
            setStockinResults(data.results);
            const okResults = data.results.filter((r) => r.ok);
            setMessage(`이지어드민 입고처리 완료: ${okResults.length}/${data.results.length}건 성공`);
```

Replace with:

```js
    const handleEzadminReceiveStock = async (selectedItems, queue) => {
        if (!selectedItems || !selectedItems.length) return;
        setStockinLoading(true);
        setStockinResults(null);
        setMessage('');
        try {
            const res = await fetch(`${API}/returns/ezadmin-receive-stock`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
                body: JSON.stringify({ items: selectedItems }),
            });
            const data = await res.json().catch(() => ({}));
            if (data?.queues) setQueues(normalizeQueues(data.queues));
            if (data?.need_session) {
                openEzadminModal(() => handleEzadminReceiveStock(selectedItems, queue));
                return;
            }
            if (!res.ok || !data?.ok) throw new Error(data?.detail || '처리 실패');
            setStockinResults(data.results);
            if (queue === 'seller' || queue === 'exchange_seller') {
                const logEntries = data.results.map((r) => {
                    const src = selectedItems.find((i) => i.id === r.id) || {};
                    return buildLogEntry(src, r.ok ? `완료 (${r.product_id || ''})` : `실패: ${r.error || ''}`);
                });
                logProcessingActions(queue, 'ezadmin_stockin', '이지어드민 입고처리', logEntries);
            }
            const okResults = data.results.filter((r) => r.ok);
            setMessage(`이지어드민 입고처리 완료: ${okResults.length}/${data.results.length}건 성공`);
```

- [ ] **Step 6: Thread a `queue` parameter through `handleSendToKimsungil`**

Find (around line 725-760):

```js
    const handleSendToKimsungil = async (selectedItems) => {
        if (!selectedItems || !selectedItems.length) return;
        setKimsungilSendLoading(true);
        setMessage('');
        try {
            const codeMap = await resolveProductCodes(selectedItems);
            const entries = Object.entries(codeMap).filter(([, code]) => code);
            if (!entries.length) {
                setMessage('상품코드를 찾지 못해 김승일보내기를 할 수 없습니다.');
                return;
            }
            let sent = 0;
            const flagsById = {};
            for (const [idStr, code] of entries) {
                const id = Number(idStr);
                const res = await fetch(`${API}/barcode/kimsungil/add`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
                    body: JSON.stringify({ code }),
                });
                if (res.ok) {
                    sent += 1;
                    flagsById[id] = { kimsungil_sent: true, kimsungil_error: undefined };
                } else {
                    const data = await res.json().catch(() => ({}));
                    flagsById[id] = { kimsungil_error: data?.detail || '전송 실패' };
                }
            }
            applyItemFlags(flagsById);
            setMessage(`김승일보내기 완료: ${sent}/${entries.length}건`);
        } catch (err) {
            setMessage(err.message || '김승일보내기 실패');
        } finally {
            setKimsungilSendLoading(false);
        }
    };
```

Replace with:

```js
    const handleSendToKimsungil = async (selectedItems, queue) => {
        if (!selectedItems || !selectedItems.length) return;
        setKimsungilSendLoading(true);
        setMessage('');
        try {
            const codeMap = await resolveProductCodes(selectedItems);
            const entries = Object.entries(codeMap).filter(([, code]) => code);
            if (!entries.length) {
                setMessage('상품코드를 찾지 못해 김승일보내기를 할 수 없습니다.');
                return;
            }
            let sent = 0;
            const flagsById = {};
            const logEntries = [];
            for (const [idStr, code] of entries) {
                const id = Number(idStr);
                const src = selectedItems.find((i) => i.id === id) || {};
                const res = await fetch(`${API}/barcode/kimsungil/add`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
                    body: JSON.stringify({ code }),
                });
                if (res.ok) {
                    sent += 1;
                    flagsById[id] = { kimsungil_sent: true, kimsungil_error: undefined };
                    logEntries.push(buildLogEntry(src, '완료'));
                } else {
                    const data = await res.json().catch(() => ({}));
                    const errMsg = data?.detail || '전송 실패';
                    flagsById[id] = { kimsungil_error: errMsg };
                    logEntries.push(buildLogEntry(src, `실패: ${errMsg}`));
                }
            }
            applyItemFlags(flagsById);
            if (queue === 'seller' || queue === 'exchange_seller') {
                logProcessingActions(queue, 'kimsungil_send', '김승일보내기', logEntries);
            }
            setMessage(`김승일보내기 완료: ${sent}/${entries.length}건`);
        } catch (err) {
            setMessage(err.message || '김승일보내기 실패');
        } finally {
            setKimsungilSendLoading(false);
        }
    };
```

- [ ] **Step 7: Log after 교환처리 실행 succeeds (교환판매자 only)**

Find in `handleExecuteExchangeChangeProduct` (around line 948-953):

```js
            if (data?.queues) setQueues(normalizeQueues(data.queues));
            if (!res.ok || !data?.ok) throw new Error(data?.detail || '교환 실행 실패');
            const adv = data.ably_advanced || {};
            let msg = `이지어드민 교환처리 ${data.executed}건 완료 · 에이블리 수거완료 ${adv.received || 0}건, 교환상품준비중 ${adv.prepared || 0}건`;
            if (data.ably_error) msg += ` (${data.ably_error})`;
            setMessage(msg);
```

Replace with:

```js
            if (data?.queues) setQueues(normalizeQueues(data.queues));
            if (!res.ok || !data?.ok) throw new Error(data?.detail || '교환 실행 실패');
            if (queue === 'seller') {
                const updatedItems = data.queues?.exchange_seller || [];
                const logEntries = ids
                    .map((id) => updatedItems.find((i) => i.id === id))
                    .filter(Boolean)
                    .map((item) => buildLogEntry(
                        item,
                        item.change_product_done ? '교환처리완료' : (item.ezadmin_error || '처리 실패')
                    ));
                logProcessingActions('exchange_seller', 'exchange_change_product', '교환처리 실행', logEntries);
            }
            const adv = data.ably_advanced || {};
            let msg = `이지어드민 교환처리 ${data.executed}건 완료 · 에이블리 수거완료 ${adv.received || 0}건, 교환상품준비중 ${adv.prepared || 0}건`;
            if (data.ably_error) msg += ` (${data.ably_error})`;
            setMessage(msg);
```

(Here `queue === 'seller'` refers to the 교환판매자 tab's internal queue naming, per the existing `handleExecuteExchangeChangeProduct('seller', ...)` call at the 교환판매자 tab's "실행" button — logged under the `'exchange_seller'` key to match the rest of the log.)

- [ ] **Step 8: Thread `queueKey`/`items` through `handleDeleteSelected` and log on success**

Find (around line 1074-1088):

```js
    const handleDeleteSelected = async (selectedIds, setSelectedIds) => {
        const ids = Array.from(selectedIds);
        if (ids.length === 0) return;
        if (!window.confirm(`선택한 ${ids.length}개 항목을 삭제할까요?`)) return;
        setDeleteLoading(true);
        try {
            const data = await deleteReturnItems(ids);
            setQueues(normalizeQueues(data.queues));
            setSelectedIds(new Set());
        } catch (err) {
            setMessage(err.message || '삭제 실패');
        } finally {
            setDeleteLoading(false);
        }
    };
```

Replace with:

```js
    const handleDeleteSelected = async (selectedIds, setSelectedIds, queueKey, items) => {
        const ids = Array.from(selectedIds);
        if (ids.length === 0) return;
        if (!window.confirm(`선택한 ${ids.length}개 항목을 삭제할까요?`)) return;
        setDeleteLoading(true);
        try {
            const data = await deleteReturnItems(ids);
            if (queueKey === 'seller' || queueKey === 'exchange_seller') {
                const logEntries = (items || [])
                    .filter((i) => selectedIds.has(i.id))
                    .map((item) => buildLogEntry(item, '삭제됨'));
                logProcessingActions(queueKey, 'delete', '선택삭제', logEntries);
            }
            setQueues(normalizeQueues(data.queues));
            setSelectedIds(new Set());
        } catch (err) {
            setMessage(err.message || '삭제 실패');
        } finally {
            setDeleteLoading(false);
        }
    };
```

- [ ] **Step 9: Thread `queueKey` through `renderQueueTab`**

Find (around line 1587-1617):

```js
    const renderQueueTab = (items, selectedIds, setSelectedIds, extraActions, showSmsAction) => {
        const handleToggleOne = (id) => {
            setSelectedIds((prev) => {
                const next = new Set(prev);
                next.has(id) ? next.delete(id) : next.add(id);
                return next;
            });
        };
        const handleToggleAll = () => {
            const allChecked = items.length > 0 && items.every((item) => selectedIds.has(item.id));
            setSelectedIds(allChecked ? new Set() : new Set(items.map((item) => item.id)));
        };
        return (
            <>
                {items.length > 0 && (
                    <div className={`${pageStyles.uploadRow} ${styles.compactActions}`}>
                        <button
                            type="button"
                            className={pageStyles.secondaryBtn}
                            onClick={() => handleDeleteSelected(selectedIds, setSelectedIds)}
                            disabled={deleteLoading || selectedIds.size === 0}
                        >
                            선택 삭제 ({selectedIds.size})
                        </button>
                        {extraActions}
                    </div>
                )}
                {renderTable(items, selectedIds, handleToggleOne, handleToggleAll, showSmsAction)}
            </>
        );
    };
```

Replace with:

```js
    const renderQueueTab = (items, selectedIds, setSelectedIds, extraActions, showSmsAction, queueKey) => {
        const handleToggleOne = (id) => {
            setSelectedIds((prev) => {
                const next = new Set(prev);
                next.has(id) ? next.delete(id) : next.add(id);
                return next;
            });
        };
        const handleToggleAll = () => {
            const allChecked = items.length > 0 && items.every((item) => selectedIds.has(item.id));
            setSelectedIds(allChecked ? new Set() : new Set(items.map((item) => item.id)));
        };
        return (
            <>
                {items.length > 0 && (
                    <div className={`${pageStyles.uploadRow} ${styles.compactActions}`}>
                        <button
                            type="button"
                            className={pageStyles.secondaryBtn}
                            onClick={() => handleDeleteSelected(selectedIds, setSelectedIds, queueKey, items)}
                            disabled={deleteLoading || selectedIds.size === 0}
                        >
                            선택 삭제 ({selectedIds.size})
                        </button>
                        {extraActions}
                    </div>
                )}
                {renderTable(items, selectedIds, handleToggleOne, handleToggleAll, showSmsAction)}
            </>
        );
    };
```

- [ ] **Step 10: Pass `'seller'` at the 판매자 대기 tab's `renderQueueTab` call**

Find the end of the seller tab's `renderQueueTab` call (around line 1836-1837):

```js
                                </>
                            ), true)}
```

Replace with:

```js
                                </>
                            ), true, 'seller')}
```

- [ ] **Step 11: Pass `'seller'` at the 판매자 대기 tab's `handleEzadminReceiveStock`/`handleSendToKimsungil` calls**

Find (around line 1815 and 1823):

```js
                                        onClick={() => handleEzadminReceiveStock(queues.seller.filter((i) => selectedSeller.has(i.id)))}
```

Replace with:

```js
                                        onClick={() => handleEzadminReceiveStock(queues.seller.filter((i) => selectedSeller.has(i.id)), 'seller')}
```

And find:

```js
                                        onClick={() => handleSendToKimsungil(queues.seller.filter((i) => selectedSeller.has(i.id)))}
```

Replace with:

```js
                                        onClick={() => handleSendToKimsungil(queues.seller.filter((i) => selectedSeller.has(i.id)), 'seller')}
```

- [ ] **Step 12: Pass `'exchange_seller'` at the 교환판매자 tab's `renderQueueTab`/`handleEzadminReceiveStock`/`handleSendToKimsungil` calls**

Find the end of the exchange_seller tab's `renderQueueTab` call (around line 2063-2064):

```js
                                        </>
                                    ))}
```

Replace with:

```js
                                        </>
                                    ), undefined, 'exchange_seller')}
```

Find:

```js
                                                onClick={() => handleEzadminReceiveStock(queues.exchange_seller.filter((i) => selectedExchangeSeller.has(i.id)))}
```

Replace with:

```js
                                                onClick={() => handleEzadminReceiveStock(queues.exchange_seller.filter((i) => selectedExchangeSeller.has(i.id)), 'exchange_seller')}
```

Find:

```js
                                                onClick={() => handleSendToKimsungil(queues.exchange_seller.filter((i) => selectedExchangeSeller.has(i.id)))}
```

Replace with:

```js
                                                onClick={() => handleSendToKimsungil(queues.exchange_seller.filter((i) => selectedExchangeSeller.has(i.id)), 'exchange_seller')}
```

- [ ] **Step 13: Verify all other call sites were left untouched**

Confirm (no edits needed — this is a read-only check):
- `renderQueueTab(queues.all, selectedAll, setSelectedAll)` (all tab) — unchanged, no `queueKey` → no delete logging.
- The 고객 대기 tab's inline delete button still calls `handleDeleteSelected(selectedCustomer, setSelectedCustomer)` with no extra args — unchanged, no logging (out of scope).
- The 고객 대기 tab's `handleEzadminReceiveStock(items.filter(...))` / `handleSendToKimsungil(items.filter(...))` calls — unchanged, no `queue` arg → no logging (out of scope).
- `renderQueueTab(queues.exchange_customer, selectedExchangeCustomer, setSelectedExchangeCustomer)` (교환고객 tab) — unchanged, no `queueKey` → no delete logging.
- `handleExecuteExchangeChangeProduct('customer', ...)` (교환고객 tab's "실행" button) — unchanged; inside the handler, the `queue === 'seller'` check means this call (`queue === 'customer'`) never logs.
- The 미매칭 tab's `renderQueueTab(...)` call — unchanged, no `queueKey` → no delete logging.

- [ ] **Step 14: Lint, build, and manually verify**

Run: `npm run lint`
Expected: no new errors in `ReturnsPage.jsx`.

Run: `npm run build`
Expected: build succeeds.

Then start the dev server (`npm run dev` + backend `uvicorn main:app --reload --host 127.0.0.1 --port 8000` from `backend/`), open the 반품 page, and manually confirm (open browser dev tools Network tab):
- Selecting an item in 판매자 대기 and clicking "에이블리 환불 요청" fires a `POST /returns/processing-log` request after the main request completes.
- The same check for "일반사유로변경", "이지어드민 입고처리", "김승일보내기", "선택 삭제" in 판매자 대기.
- In 교환판매자, "이지어드민 입고처리", "김승일보내기", "실행", "선택 삭제" each fire a log POST.
- In 고객 대기, clicking "이지어드민 입고처리" / "김승일보내기" does **not** fire a `processing-log` POST.

- [ ] **Step 15: Commit**

```bash
git add src/components/Barcode/ReturnsPage.jsx
git commit -m "Log 반품 판매자/교환판매자 처리 액션 to return_processing_log"
```

---

### Task 3: Frontend — "처리기록" tab UI

**Files:**
- Modify: `src/components/Barcode/ReturnsPage.jsx`

**Interfaces:**
- Consumes: `GET /returns/processing-log?queue=&action=&date_from=&date_to=&q=` from Task 1, returning `{"items": [{id, created_at, username, queue, action, action_label, item_text, qty, type, reason, detail_reason, images, ezadmin_seq, status}, ...]}`. Also consumes `PROCESSING_LOG_ACTIONS` (defined in Task 2, Step 1) for the button-type filter dropdown, and the existing `zoomImage`/`setZoomImage` state (already in the component) for the photo lightbox.
- Produces: nothing consumed by other tasks — this is the final task.

This task also has no automated test suite. Verified via lint/build + manual browser check in the final step.

- [ ] **Step 1: Add state for the 처리기록 tab**

Find (around line 93-94):

```js
    const [excelRefundLoading, setExcelRefundLoading] = useState(false);
    const [excelRefundResults, setExcelRefundResults] = useState(null);
```

Insert immediately after:

```js
    const [excelRefundLoading, setExcelRefundLoading] = useState(false);
    const [excelRefundResults, setExcelRefundResults] = useState(null);
    const [processingLog, setProcessingLog] = useState([]);
    const [processingLogLoading, setProcessingLogLoading] = useState(false);
    const [logFilterQueue, setLogFilterQueue] = useState('');
    const [logFilterAction, setLogFilterAction] = useState('');
    const [logFilterDateFrom, setLogFilterDateFrom] = useState('');
    const [logFilterDateTo, setLogFilterDateTo] = useState('');
    const [logFilterSearch, setLogFilterSearch] = useState('');
```

- [ ] **Step 2: Add `fetchProcessingLog` and its activation effect**

Find (around line 207-209):

```js
    useEffect(() => {
        if (activeTab === 'regather') fetchRegatherItems();
    }, [activeTab]);
```

Replace with:

```js
    useEffect(() => {
        if (activeTab === 'regather') fetchRegatherItems();
    }, [activeTab]);

    useEffect(() => {
        if (activeTab === 'processing_log') fetchProcessingLog();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeTab]);

    const fetchProcessingLog = async () => {
        setProcessingLogLoading(true);
        try {
            const params = new URLSearchParams();
            if (logFilterQueue) params.set('queue', logFilterQueue);
            if (logFilterAction) params.set('action', logFilterAction);
            if (logFilterDateFrom) params.set('date_from', logFilterDateFrom);
            if (logFilterDateTo) params.set('date_to', logFilterDateTo);
            if (logFilterSearch) params.set('q', logFilterSearch);
            const res = await fetch(`${API}/returns/processing-log?${params.toString()}`, {
                headers: getAuthHeaders(),
            });
            const data = await res.json().catch(() => ({}));
            setProcessingLog(Array.isArray(data?.items) ? data.items : []);
        } catch {
            setProcessingLog([]);
        } finally {
            setProcessingLogLoading(false);
        }
    };
```

`fetchProcessingLog` is defined as a plain `const` (not wrapped in `useCallback`), same as `fetchRegatherItems` just above it, so referencing it before its declaration inside the effect above is safe (function bodies are only invoked after the whole component body has run once). Because `function`/`const` bodies in the same scope are all hoisted-by-closure at call time in React function components, this matches the existing `fetchRegatherItems`/`handleCompleteRegather` ordering pattern already in the file.

- [ ] **Step 3: Add the "처리기록" tab button**

Find (around line 1753-1774):

```js
                        <div className={`${pageStyles.tabRow} ${styles.tabRow}`}>
                            {[
                                ['all', '전체 대기'],
                                ['seller', '판매자 대기'],
                                ['customer', '고객 대기'],
                                ['exchange_seller', '교환판매자'],
                                ['exchange_customer', '교환고객'],
                                ['unmatched', '미매칭 대기'],
                                ['regather', '오회수'],
                                ['onebe', '원베양식(고객대기)'],
                            ].map(([key, label]) => (
```

Replace with:

```js
                        <div className={`${pageStyles.tabRow} ${styles.tabRow}`}>
                            {[
                                ['all', '전체 대기'],
                                ['seller', '판매자 대기'],
                                ['customer', '고객 대기'],
                                ['exchange_seller', '교환판매자'],
                                ['exchange_customer', '교환고객'],
                                ['unmatched', '미매칭 대기'],
                                ['regather', '오회수'],
                                ['onebe', '원베양식(고객대기)'],
                                ['processing_log', '처리기록'],
                            ].map(([key, label]) => (
```

- [ ] **Step 4: Exclude `processing_log` from the existing queue-tab guard**

Find (around line 1783):

```js
                    {activeTab !== 'onebe' && (
```

Replace with:

```js
                    {activeTab !== 'onebe' && activeTab !== 'processing_log' && (
```

- [ ] **Step 5: Render the 처리기록 tab body**

Find the end of the onebe block (around line 2267-2269):

```js
                            </div>
                        </div>
                    )}
                </section>
```

Replace with:

```js
                            </div>
                        </div>
                    )}

                    {activeTab === 'processing_log' && (
                        <div className={pageStyles.stack}>
                            <div className={`${pageStyles.uploadRow} ${styles.compactActions}`}>
                                <select value={logFilterQueue} onChange={(e) => setLogFilterQueue(e.target.value)}>
                                    <option value="">전체 유형</option>
                                    <option value="seller">판매자 대기</option>
                                    <option value="exchange_seller">교환판매자</option>
                                </select>
                                <select value={logFilterAction} onChange={(e) => setLogFilterAction(e.target.value)}>
                                    <option value="">전체 버튼</option>
                                    {PROCESSING_LOG_ACTIONS.map(([key, label]) => (
                                        <option key={key} value={key}>{label}</option>
                                    ))}
                                </select>
                                <input
                                    type="date"
                                    value={logFilterDateFrom}
                                    onChange={(e) => setLogFilterDateFrom(e.target.value)}
                                />
                                <input
                                    type="date"
                                    value={logFilterDateTo}
                                    onChange={(e) => setLogFilterDateTo(e.target.value)}
                                />
                                <input
                                    className={pageStyles.searchInput}
                                    placeholder="가공데이터/SEQ 검색"
                                    value={logFilterSearch}
                                    onChange={(e) => setLogFilterSearch(e.target.value)}
                                />
                                <button
                                    type="button"
                                    className={pageStyles.secondaryBtn}
                                    onClick={fetchProcessingLog}
                                    disabled={processingLogLoading}
                                >
                                    {processingLogLoading ? '조회 중...' : '조회'}
                                </button>
                            </div>
                            {processingLogLoading ? (
                                <div className={pageStyles.empty}>불러오는 중...</div>
                            ) : processingLog.length === 0 ? (
                                <div className={pageStyles.empty}>처리기록이 없습니다.</div>
                            ) : (
                                <div className={pageStyles.tableWrap}>
                                    <table className={pageStyles.table}>
                                        <thead>
                                            <tr>
                                                <th>일시</th>
                                                <th>유형</th>
                                                <th>버튼</th>
                                                <th>가공데이터</th>
                                                <th>입고수량</th>
                                                <th>분류</th>
                                                <th>사유</th>
                                                <th>상세사유</th>
                                                <th>사진</th>
                                                <th>SEQ</th>
                                                <th>상태</th>
                                                <th>처리자</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {processingLog.map((row) => (
                                                <tr key={row.id}>
                                                    <td>{row.created_at}</td>
                                                    <td>{row.queue === 'seller' ? '판매자 대기' : '교환판매자'}</td>
                                                    <td>{row.action_label}</td>
                                                    <td>{row.item_text}</td>
                                                    <td>{row.qty}</td>
                                                    <td>{row.type}</td>
                                                    <td>{row.reason}</td>
                                                    <td>{row.detail_reason}</td>
                                                    <td>
                                                        {(row.images || []).length === 0 ? '' : (
                                                            <div style={{ display: 'flex', gap: 4 }}>
                                                                {row.images.map((src, i) => (
                                                                    <img
                                                                        key={i}
                                                                        src={src}
                                                                        alt={`사진 ${i + 1}`}
                                                                        style={{ width: 36, height: 36, objectFit: 'cover', borderRadius: 4, cursor: 'zoom-in' }}
                                                                        onClick={() => setZoomImage(src)}
                                                                    />
                                                                ))}
                                                            </div>
                                                        )}
                                                    </td>
                                                    <td>{row.ezadmin_seq}</td>
                                                    <td>{row.status}</td>
                                                    <td>{row.username}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            )}
                        </div>
                    )}
                </section>
```

- [ ] **Step 6: Lint, build, and manually verify**

Run: `npm run lint`
Expected: no new errors.

Run: `npm run build`
Expected: build succeeds.

With both dev servers running, open the 반품 page, click the new "처리기록" tab, and confirm:
- The filter bar renders (유형/버튼/기간 2개/검색어/조회 버튼).
- After performing a few of the Task 2 actions (e.g. 선택삭제 in 판매자 대기), clicking "조회" on the 처리기록 tab shows rows with the correct 가공데이터/입고수량/분류/사유/상세사유/SEQ/상태/처리자 values and 사진 thumbnails (click a thumbnail to confirm the zoom modal opens, reusing the existing `zoomImage` state).
- Filtering by 판매자유형 = 교환판매자 only shows rows logged with `queue: 'exchange_seller'`.
- Filtering by 버튼 = 선택삭제 only shows delete rows.
- 검색어 filters by 가공데이터/SEQ substring.

- [ ] **Step 7: Commit**

```bash
git add src/components/Barcode/ReturnsPage.jsx
git commit -m "Add 처리기록 tab to 반품 page with filter/search"
```
