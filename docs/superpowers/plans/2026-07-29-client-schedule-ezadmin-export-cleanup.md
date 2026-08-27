# 거래처 일정 EZAdmin 내보내기 만료 자동 정리 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When "EZAdmin 날짜 내보내기" is clicked on 거래처 일정 페이지, automatically blank out (in EZAdmin's product note) any date that is today-or-past, and automatically clean up notes for products that have completely dropped off the current schedule but were previously exported with a now-past date.

**Architecture:** A new shared-DB table `client_schedule_export_log` (unique on `product_code`, since the handler always deletes-then-reinserts per product code — at most one pending row per product code at any time) tracks which product codes were last exported with which future date. `POST /barcode/client-schedule/export-to-ezadmin` (`backend/api/barcode_routes.py`) is rewritten to: (1) blank any submitted date that is today-or-past, (2) look up log entries for product codes that are *not* in the current submission and whose date is today-or-past, append them as blank cleanup rows, (3) after a successful EZAdmin upload, delete/replace log rows to reflect what was actually sent. The frontend (`ClientSchedulePage.jsx`) only loses its "0 rows → don't call the backend" short-circuit, since a pure cleanup run can have zero current-schedule rows.

**Tech Stack:** FastAPI + sqlite3 (backend), pytest + FastAPI TestClient + `unittest.mock.patch` (backend tests, mocking `httpx.AsyncClient` since the handler talks to EZAdmin directly with no SDK wrapper). React (frontend) — no automated frontend tests exist in this repo (per `CLAUDE.md`); frontend change is verified via `npm run lint` / `npm run build` and manual check.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-29-client-schedule-ezadmin-export-cleanup-design.md` — follow it exactly; this plan implements it in full.
- Only `YYYY-MM-DD`-formatted `note` values are ever tracked in `client_schedule_export_log` or eligible for the today-or-past blanking rule. Any other text (e.g. `이번주중`) passes through untouched and must never touch the log table.
- A product code present anywhere in the current submission (`payload["rows"]`) is always excluded from the stale-cleanup lookup, regardless of what its own note value is — this prevents sending two conflicting rows for the same product code in one upload.
- Log rows are deleted immediately once resolved (blanked or superseded by a new future date) — no "cleared" status flag, no audit trail.
- The EZAdmin log-table write only happens after a **successful** EZAdmin response (the existing `count`-regex match). A failed/errored response must leave the log table untouched.
- Do not touch unrelated pre-existing uncommitted changes in this working tree (there is WIP from other work already present — only stage files this plan actually creates/modifies).

---

### Task 1: Backend — `client_schedule_export_log` table + rewritten export handler + tests

**Files:**
- Modify: `backend/api/barcode_routes.py` (imports near line 8, `build_barcode_router` signature at line 34-54, `client_schedule_export_to_ezadmin` handler at lines 3106-3159)
- Modify: `backend/main.py` (table init function near `_init_client_schedule_db` at line 1040-1062, `build_barcode_router(...)` call at line 1369-1388)
- Test: `backend/tests/test_barcode_client_schedule_export.py`

**Interfaces:**
- Produces: `build_barcode_router(..., get_shared_db)` — new required keyword parameter. `POST /barcode/client-schedule/export-to-ezadmin` keeps its existing request/response shape (`{"rows": [{"productCode": str, "note": str}, ...]}` → `{"ok": true, "count": int}` / `{"ok": false, "error": str}` / `{"ok": false, "need_session": true}`), only its internal behavior changes.
- Consumes: nothing from other tasks. Task 2 (frontend) depends on this endpoint's behavior but not on any new symbol.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_barcode_client_schedule_export.py`:

```python
import io
import sqlite3
import sys
import uuid
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pandas as pd
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.barcode_routes import build_barcode_router


class _FakeEzResponse:
    def __init__(self, text):
        self.text = text


class _FakeAsyncClient:
    """Stand-in for httpx.AsyncClient — records calls, returns a canned HTML response."""

    def __init__(self, response_text):
        self._response_text = response_text
        self.calls = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def post(self, url, **kwargs):
        self.calls.append((url, kwargs))
        return _FakeEzResponse(self._response_text)


def _success_html(count):
    return f'<script>alert("{count}개 변경 완료 되었습니다.")</script>'


def _make_db_factory():
    uri = f"file:test_client_schedule_export_{uuid.uuid4().hex}?mode=memory&cache=shared"
    keep_alive = sqlite3.connect(uri, uri=True)
    keep_alive.row_factory = sqlite3.Row
    keep_alive.execute(
        """
        CREATE TABLE client_schedule_export_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product_code TEXT NOT NULL,
            note_date TEXT NOT NULL,
            exported_at TEXT NOT NULL,
            UNIQUE(product_code, note_date)
        )
        """
    )
    keep_alive.commit()

    def factory():
        conn = sqlite3.connect(uri, uri=True)
        conn.row_factory = sqlite3.Row
        return conn

    return factory, keep_alive


def _make_client(phpsessid="SESSIDVALUE"):
    get_shared_db, keep_alive = _make_db_factory()
    settings = {"ezadmin_phpsessid": phpsessid} if phpsessid else {}

    app = FastAPI()
    app.include_router(
        build_barcode_router(
            get_current_user=lambda: "tester",
            get_barcode_state=lambda *a, **k: {},
            to_int=lambda v: int(v or 0),
            process_and_load_any=lambda *a, **k: None,
            load_excel_any=lambda *a, **k: None,
            normalize_to_yusas=lambda *a, **k: None,
            process_easyadmin_product_upload=lambda *a, **k: None,
            content_disposition=lambda *a, **k: "",
            get_shared_incoming_counts=lambda: {},
            set_shared_incoming_counts=lambda *a, **k: None,
            get_shared_defect_counts=lambda: {},
            set_shared_defect_counts=lambda *a, **k: None,
            get_shared_kimsungil_counts=lambda: {},
            set_shared_kimsungil_counts=lambda *a, **k: None,
            set_shared_barcode_data=lambda *a, **k: None,
            get_setting=lambda key: settings.get(key),
            set_setting=lambda key, value: settings.__setitem__(key, value),
            get_user_display=lambda u: u,
            get_shared_db=get_shared_db,
        )
    )
    return TestClient(app), get_shared_db, keep_alive


def _log_rows(keep_alive):
    rows = keep_alive.execute(
        "SELECT product_code, note_date FROM client_schedule_export_log ORDER BY product_code"
    ).fetchall()
    return [(r["product_code"], r["note_date"]) for r in rows]


def _uploaded_rows(fake_client):
    """Parse the xls bytes that were uploaded to EZAdmin back into (code, note) pairs."""
    _, kwargs = fake_client.calls[0]
    filename, xls_bytes, _content_type = kwargs["files"]["_file"]
    df = pd.read_excel(io.BytesIO(xls_bytes), engine="xlrd", header=None)
    return [(str(row[0]), "" if pd.isna(row[1]) else str(row[1])) for _, row in df.iloc[1:].iterrows()]


def test_export_without_session_returns_need_session():
    client, _get_db, _keep_alive = _make_client(phpsessid=None)

    res = client.post("/barcode/client-schedule/export-to-ezadmin", json={"rows": []})

    assert res.status_code == 200
    assert res.json() == {"ok": False, "need_session": True}


def test_future_date_is_sent_as_is_and_logged(monkeypatch):
    monkeypatch.setattr(
        "api.barcode_routes.datetime",
        _frozen_datetime("2026-07-29T10:00:00+09:00"),
    )
    client, _get_db, keep_alive = _make_client()
    fake = _FakeAsyncClient(_success_html(1))

    with patch("api.barcode_routes.httpx.AsyncClient", return_value=fake):
        res = client.post(
            "/barcode/client-schedule/export-to-ezadmin",
            json={"rows": [{"productCode": "S10001", "note": "2026-08-01"}]},
        )

    assert res.status_code == 200
    assert res.json() == {"ok": True, "count": 1}
    assert _uploaded_rows(fake) == [("S10001", "2026-08-01")]
    assert _log_rows(keep_alive) == [("S10001", "2026-08-01")]


def test_today_date_is_blanked_and_not_logged(monkeypatch):
    monkeypatch.setattr(
        "api.barcode_routes.datetime",
        _frozen_datetime("2026-07-29T10:00:00+09:00"),
    )
    client, _get_db, keep_alive = _make_client()
    fake = _FakeAsyncClient(_success_html(1))

    with patch("api.barcode_routes.httpx.AsyncClient", return_value=fake):
        res = client.post(
            "/barcode/client-schedule/export-to-ezadmin",
            json={"rows": [{"productCode": "S10002", "note": "2026-07-29"}]},
        )

    assert res.status_code == 200
    assert _uploaded_rows(fake) == [("S10002", "")]
    assert _log_rows(keep_alive) == []


def test_non_date_text_passes_through_and_is_never_logged(monkeypatch):
    monkeypatch.setattr(
        "api.barcode_routes.datetime",
        _frozen_datetime("2026-07-29T10:00:00+09:00"),
    )
    client, _get_db, keep_alive = _make_client()
    fake = _FakeAsyncClient(_success_html(1))

    with patch("api.barcode_routes.httpx.AsyncClient", return_value=fake):
        res = client.post(
            "/barcode/client-schedule/export-to-ezadmin",
            json={"rows": [{"productCode": "S10003", "note": "이번주중"}]},
        )

    assert res.status_code == 200
    assert _uploaded_rows(fake) == [("S10003", "이번주중")]
    assert _log_rows(keep_alive) == []


def test_stale_log_entry_for_dropped_product_is_sent_blank_and_deleted(monkeypatch):
    monkeypatch.setattr(
        "api.barcode_routes.datetime",
        _frozen_datetime("2026-07-29T10:00:00+09:00"),
    )
    client, _get_db, keep_alive = _make_client()
    keep_alive.execute(
        "INSERT INTO client_schedule_export_log (product_code, note_date, exported_at) VALUES (?, ?, ?)",
        ("S20001", "2026-07-25", "2026-07-25T10:00:00+09:00"),
    )
    keep_alive.commit()
    fake = _FakeAsyncClient(_success_html(1))

    # S20001 no longer appears anywhere in the current schedule submission.
    with patch("api.barcode_routes.httpx.AsyncClient", return_value=fake):
        res = client.post(
            "/barcode/client-schedule/export-to-ezadmin",
            json={"rows": [{"productCode": "S99999", "note": "2026-08-05"}]},
        )

    assert res.status_code == 200
    uploaded = dict(_uploaded_rows(fake))
    assert uploaded["S20001"] == ""
    assert uploaded["S99999"] == "2026-08-05"
    assert _log_rows(keep_alive) == [("S99999", "2026-08-05")]


def test_stale_log_entry_is_skipped_when_product_is_in_current_submission(monkeypatch):
    monkeypatch.setattr(
        "api.barcode_routes.datetime",
        _frozen_datetime("2026-07-29T10:00:00+09:00"),
    )
    client, _get_db, keep_alive = _make_client()
    keep_alive.execute(
        "INSERT INTO client_schedule_export_log (product_code, note_date, exported_at) VALUES (?, ?, ?)",
        ("S30001", "2026-07-01", "2026-07-01T10:00:00+09:00"),
    )
    keep_alive.commit()
    fake = _FakeAsyncClient(_success_html(1))

    # S30001 IS in the current submission (with a new future date) — no separate blank row for it.
    with patch("api.barcode_routes.httpx.AsyncClient", return_value=fake):
        res = client.post(
            "/barcode/client-schedule/export-to-ezadmin",
            json={"rows": [{"productCode": "S30001", "note": "2026-08-02"}]},
        )

    assert res.status_code == 200
    assert _uploaded_rows(fake) == [("S30001", "2026-08-02")]
    assert _log_rows(keep_alive) == [("S30001", "2026-08-02")]


def test_empty_current_schedule_still_runs_cleanup(monkeypatch):
    monkeypatch.setattr(
        "api.barcode_routes.datetime",
        _frozen_datetime("2026-07-29T10:00:00+09:00"),
    )
    client, _get_db, keep_alive = _make_client()
    keep_alive.execute(
        "INSERT INTO client_schedule_export_log (product_code, note_date, exported_at) VALUES (?, ?, ?)",
        ("S50001", "2026-07-20", "2026-07-20T10:00:00+09:00"),
    )
    keep_alive.commit()
    fake = _FakeAsyncClient(_success_html(1))

    # No current schedule rows at all (the frontend's Task 2 change means this call still
    # happens even when the on-screen schedule is empty) — cleanup should still run.
    with patch("api.barcode_routes.httpx.AsyncClient", return_value=fake):
        res = client.post("/barcode/client-schedule/export-to-ezadmin", json={"rows": []})

    assert res.status_code == 200
    assert res.json() == {"ok": True, "count": 1}
    assert _uploaded_rows(fake) == [("S50001", "")]
    assert _log_rows(keep_alive) == []


def test_no_rows_and_no_cleanup_skips_ezadmin_call():
    client, _get_db, keep_alive = _make_client()

    with patch("api.barcode_routes.httpx.AsyncClient") as mock_cls:
        res = client.post("/barcode/client-schedule/export-to-ezadmin", json={"rows": []})

    assert res.status_code == 200
    assert res.json() == {"ok": True, "count": 0}
    mock_cls.assert_not_called()


def test_failed_ezadmin_response_does_not_touch_log(monkeypatch):
    monkeypatch.setattr(
        "api.barcode_routes.datetime",
        _frozen_datetime("2026-07-29T10:00:00+09:00"),
    )
    client, _get_db, keep_alive = _make_client()
    fake = _FakeAsyncClient("<html>no match here</html>")

    with patch("api.barcode_routes.httpx.AsyncClient", return_value=fake):
        res = client.post(
            "/barcode/client-schedule/export-to-ezadmin",
            json={"rows": [{"productCode": "S40001", "note": "2026-08-10"}]},
        )

    assert res.status_code == 200
    assert res.json()["ok"] is False
    assert _log_rows(keep_alive) == []
```

This test file needs one more helper, `_frozen_datetime`, so `datetime.now(KST)` inside the handler resolves to a fixed instant instead of the real clock. Add it near the top of the file, right after the `_FakeAsyncClient` class:

```python
from datetime import datetime as _real_datetime


def _frozen_datetime(iso_string):
    frozen = _real_datetime.fromisoformat(iso_string)

    class _Frozen(_real_datetime):
        @classmethod
        def now(cls, tz=None):
            return frozen.astimezone(tz) if tz else frozen

    return _Frozen
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_barcode_client_schedule_export.py -v`
Expected: FAIL — `TypeError: build_barcode_router() missing 1 required keyword-only argument: 'get_shared_db'` (and/or table-not-found errors, since `client_schedule_export_log` handling doesn't exist yet).

- [ ] **Step 3: Add imports and the date-tracking constant**

In `backend/api/barcode_routes.py`, find (line 8):

```python
from datetime import datetime, timedelta
```

Replace with:

```python
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo
```

Find (lines 28-29):

```python
_EZADMIN_BASE        = "https://ga80.ezadmin.co.kr"
_EZADMIN_SESSION_KEY = "ezadmin_phpsessid"
```

Replace with:

```python
_EZADMIN_BASE        = "https://ga80.ezadmin.co.kr"
_EZADMIN_SESSION_KEY = "ezadmin_phpsessid"
_KST = ZoneInfo("Asia/Seoul")
_SCHEDULE_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
```

- [ ] **Step 4: Add `get_shared_db` to `build_barcode_router`'s signature**

Find (lines 34-54):

```python
def build_barcode_router(
    *,
    get_current_user,
    get_barcode_state,
    to_int,
    process_and_load_any,
    load_excel_any,
    normalize_to_yusas,
    process_easyadmin_product_upload,
    content_disposition,
    get_shared_incoming_counts,
    set_shared_incoming_counts,
    get_shared_defect_counts,
    set_shared_defect_counts,
    get_shared_kimsungil_counts,
    set_shared_kimsungil_counts,
    set_shared_barcode_data,
    get_setting,
    set_setting,
    get_user_display,
):
```

Replace with:

```python
def build_barcode_router(
    *,
    get_current_user,
    get_barcode_state,
    to_int,
    process_and_load_any,
    load_excel_any,
    normalize_to_yusas,
    process_easyadmin_product_upload,
    content_disposition,
    get_shared_incoming_counts,
    set_shared_incoming_counts,
    get_shared_defect_counts,
    set_shared_defect_counts,
    get_shared_kimsungil_counts,
    set_shared_kimsungil_counts,
    set_shared_barcode_data,
    get_setting,
    set_setting,
    get_user_display,
    get_shared_db,
):
```

- [ ] **Step 5: Rewrite the `client_schedule_export_to_ezadmin` handler**

Find the entire handler (lines 3106-3159):

```python
    @router.post("/barcode/client-schedule/export-to-ezadmin")
    async def client_schedule_export_to_ezadmin(
        payload: dict = Body(default={}),
        user: str = Depends(get_current_user),
    ):
        phpsessid = (get_setting(_EZADMIN_SESSION_KEY) or "").strip()
        if not phpsessid:
            return {"ok": False, "need_session": True}

        import io as _io
        rows = payload.get("rows") or []

        wb = xlwt.Workbook()
        ws = wb.add_sheet("Sheet1")
        ws.write(0, 0, "상품코드")
        ws.write(0, 1, "상품메모")
        for ri, row in enumerate(rows, 1):
            ws.write(ri, 0, str(row.get("productCode", "")))
            ws.write(ri, 1, str(row.get("note", "")))

        buf = _io.BytesIO()
        wb.save(buf)
        xls_bytes = buf.getvalue()

        c620_url = f"{_EZADMIN_BASE}/template40.htm?template=C620"
        ts_ms = str(int(datetime.now().timestamp() * 1000))
        ez_headers = {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/120.0.0.0 Safari/537.36"
            ),
            "Origin": _EZADMIN_BASE,
            "Referer": c620_url,
        }
        cookies = {"PHPSESSID": phpsessid}

        try:
            async with httpx.AsyncClient(timeout=60.0, verify=False, follow_redirects=True) as client:
                r = await client.post(
                    c620_url,
                    data={"page": "1", "action": "update2", "template": "C620", "total": "0", "status": "6"},
                    files={"_file": (f"client_schedule_{ts_ms}.xls", xls_bytes, "application/vnd.ms-excel")},
                    cookies=cookies,
                    headers=ez_headers,
                )
        except Exception as exc:
            return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}

        html = r.text
        m = re.search(r'alert\("(\d+)\s*개 변경 완료 되었습니다\."\)', html)
        if not m:
            return {"ok": False, "error": "응답에서 변경 완료 문구를 찾지 못했습니다", "raw_snippet": html[:300]}
        return {"ok": True, "count": int(m.group(1))}

    return router
```

Replace with:

```python
    @router.post("/barcode/client-schedule/export-to-ezadmin")
    async def client_schedule_export_to_ezadmin(
        payload: dict = Body(default={}),
        user: str = Depends(get_current_user),
    ):
        phpsessid = (get_setting(_EZADMIN_SESSION_KEY) or "").strip()
        if not phpsessid:
            return {"ok": False, "need_session": True}

        import io as _io
        today = datetime.now(_KST).date()

        def _classify(note_text: str):
            """Returns (output_note, is_tracked_date)."""
            if _SCHEDULE_DATE_RE.match(note_text):
                parsed = date.fromisoformat(note_text)
                return ("" if parsed <= today else note_text), True
            return note_text, False

        scheduled_rows = []
        for row in payload.get("rows") or []:
            code = str(row.get("productCode", ""))
            output_note, is_tracked = _classify(str(row.get("note", "")))
            scheduled_rows.append({"productCode": code, "note": output_note, "is_tracked": is_tracked})

        current_codes = {row["productCode"] for row in scheduled_rows}

        conn = get_shared_db()
        try:
            stale = conn.execute(
                "SELECT DISTINCT product_code FROM client_schedule_export_log WHERE note_date <= ?",
                (today.isoformat(),),
            ).fetchall()
        finally:
            conn.close()

        cleanup_rows = [
            {"productCode": r["product_code"], "note": "", "is_tracked": True}
            for r in stale
            if r["product_code"] not in current_codes
        ]

        all_rows = scheduled_rows + cleanup_rows
        if not all_rows:
            return {"ok": True, "count": 0}

        wb = xlwt.Workbook()
        ws = wb.add_sheet("Sheet1")
        ws.write(0, 0, "상품코드")
        ws.write(0, 1, "상품메모")
        for ri, row in enumerate(all_rows, 1):
            ws.write(ri, 0, row["productCode"])
            ws.write(ri, 1, row["note"])

        buf = _io.BytesIO()
        wb.save(buf)
        xls_bytes = buf.getvalue()

        c620_url = f"{_EZADMIN_BASE}/template40.htm?template=C620"
        ts_ms = str(int(datetime.now().timestamp() * 1000))
        ez_headers = {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/120.0.0.0 Safari/537.36"
            ),
            "Origin": _EZADMIN_BASE,
            "Referer": c620_url,
        }
        cookies = {"PHPSESSID": phpsessid}

        try:
            async with httpx.AsyncClient(timeout=60.0, verify=False, follow_redirects=True) as client:
                r = await client.post(
                    c620_url,
                    data={"page": "1", "action": "update2", "template": "C620", "total": "0", "status": "6"},
                    files={"_file": (f"client_schedule_{ts_ms}.xls", xls_bytes, "application/vnd.ms-excel")},
                    cookies=cookies,
                    headers=ez_headers,
                )
        except Exception as exc:
            return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}

        html = r.text
        m = re.search(r'alert\("(\d+)\s*개 변경 완료 되었습니다\."\)', html)
        if not m:
            return {"ok": False, "error": "응답에서 변경 완료 문구를 찾지 못했습니다", "raw_snippet": html[:300]}

        now_iso = datetime.now(_KST).isoformat()
        conn = get_shared_db()
        try:
            for row in all_rows:
                if not row["is_tracked"]:
                    continue
                conn.execute(
                    "DELETE FROM client_schedule_export_log WHERE product_code = ?",
                    (row["productCode"],),
                )
                if row["note"]:
                    conn.execute(
                        "INSERT INTO client_schedule_export_log (product_code, note_date, exported_at) "
                        "VALUES (?, ?, ?)",
                        (row["productCode"], row["note"], now_iso),
                    )
            conn.commit()
        finally:
            conn.close()

        return {"ok": True, "count": int(m.group(1))}

    return router
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_barcode_client_schedule_export.py -v`
Expected: 9 passed

- [ ] **Step 7: Wire the table init + `get_shared_db` into `backend/main.py`**

Find (`main.py:1040-1062`):

```python
def _init_client_schedule_db():
    conn = _get_shared_db()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS client_schedule_db (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            row_a TEXT NOT NULL DEFAULT '',
            row_b TEXT NOT NULL DEFAULT '',
            row_c TEXT NOT NULL DEFAULT '',
            row_d TEXT NOT NULL DEFAULT '',
            row_e TEXT NOT NULL DEFAULT '',
            row_f TEXT NOT NULL DEFAULT '',
            row_g TEXT NOT NULL DEFAULT '',
            row_h TEXT NOT NULL DEFAULT '',
            saved_at TEXT NOT NULL
        )
        """
    )
    conn.commit()
    conn.close()


_init_client_schedule_db()
```

Replace with:

```python
def _init_client_schedule_db():
    conn = _get_shared_db()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS client_schedule_db (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            row_a TEXT NOT NULL DEFAULT '',
            row_b TEXT NOT NULL DEFAULT '',
            row_c TEXT NOT NULL DEFAULT '',
            row_d TEXT NOT NULL DEFAULT '',
            row_e TEXT NOT NULL DEFAULT '',
            row_f TEXT NOT NULL DEFAULT '',
            row_g TEXT NOT NULL DEFAULT '',
            row_h TEXT NOT NULL DEFAULT '',
            saved_at TEXT NOT NULL
        )
        """
    )
    conn.commit()
    conn.close()


_init_client_schedule_db()


def _init_client_schedule_export_log():
    conn = _get_shared_db()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS client_schedule_export_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product_code TEXT NOT NULL,
            note_date TEXT NOT NULL,
            exported_at TEXT NOT NULL,
            UNIQUE(product_code, note_date)
        )
        """
    )
    conn.commit()
    conn.close()


_init_client_schedule_export_log()
```

Then find the `build_barcode_router(...)` call (`main.py:1369-1388`):

```python
    build_barcode_router(
        get_current_user=_get_current_user,
        get_barcode_state=_get_barcode_state,
        to_int=_to_int,
        process_and_load_any=process_and_load_any,
        load_excel_any=load_excel_any,
        normalize_to_yusas=normalize_to_yusas,
        process_easyadmin_product_upload=_process_easyadmin_product_upload,
        content_disposition=_content_disposition,
        get_shared_incoming_counts=_get_shared_incoming_counts,
        set_shared_incoming_counts=_set_shared_incoming_counts,
        get_shared_defect_counts=_get_shared_defect_counts,
        set_shared_defect_counts=_set_shared_defect_counts,
        get_shared_kimsungil_counts=_get_shared_kimsungil_counts,
        set_shared_kimsungil_counts=_set_shared_kimsungil_counts,
        set_shared_barcode_data=_set_shared_barcode_data,
        get_setting=_get_setting,
        set_setting=_set_setting,
        get_user_display=_get_user_display,
    )
)
```

Replace with:

```python
    build_barcode_router(
        get_current_user=_get_current_user,
        get_barcode_state=_get_barcode_state,
        to_int=_to_int,
        process_and_load_any=process_and_load_any,
        load_excel_any=load_excel_any,
        normalize_to_yusas=normalize_to_yusas,
        process_easyadmin_product_upload=_process_easyadmin_product_upload,
        content_disposition=_content_disposition,
        get_shared_incoming_counts=_get_shared_incoming_counts,
        set_shared_incoming_counts=_set_shared_incoming_counts,
        get_shared_defect_counts=_get_shared_defect_counts,
        set_shared_defect_counts=_set_shared_defect_counts,
        get_shared_kimsungil_counts=_get_shared_kimsungil_counts,
        set_shared_kimsungil_counts=_set_shared_kimsungil_counts,
        set_shared_barcode_data=_set_shared_barcode_data,
        get_setting=_get_setting,
        set_setting=_set_setting,
        get_user_display=_get_user_display,
        get_shared_db=_get_shared_db,
    )
)
```

- [ ] **Step 8: Sanity-check the server still boots**

Run: `cd backend && python -c "import main"`
Expected: no exceptions (import-time table creation + router registration succeed).

- [ ] **Step 9: Run the full backend test suite**

Run: `cd backend && python -m pytest -q`
Expected: all tests pass (no regressions from the new import/table/router/signature change).

- [ ] **Step 10: Commit**

```bash
git add backend/api/barcode_routes.py backend/main.py backend/tests/test_barcode_client_schedule_export.py
git commit -m "Auto-clear expired EZAdmin schedule notes on client-schedule export"
```

---

### Task 2: Frontend — allow cleanup-only exports when the current schedule is empty

**Files:**
- Modify: `src/components/ClientSchedule/ClientSchedulePage.jsx:725-730`

**Interfaces:**
- Consumes: `POST /barcode/client-schedule/export-to-ezadmin` from Task 1 (same request/response shape as before — no client-side change needed beyond removing the early return).
- Produces: nothing consumed by other tasks — this is the final task.

This task has no automated test suite to drive it (frontend has none, per `CLAUDE.md`). Verified via lint/build + a manual check in the final step.

- [ ] **Step 1: Remove the "no scheduled rows → don't call the backend" guard**

Find (`ClientSchedulePage.jsx:725-730`):

```js
  const handleExportScheduleToEzadmin = async () => {
    const scheduled = sheet2Rows.filter((row) => toDisplayText(row.D));
    if (scheduled.length === 0) {
      setStatus('내보낼 일정이 없습니다.');
      return;
    }

    const missingCode = scheduled.filter((row) => !toDisplayText(row.productCode));
```

Replace with:

```js
  const handleExportScheduleToEzadmin = async () => {
    const scheduled = sheet2Rows.filter((row) => toDisplayText(row.D));

    const missingCode = scheduled.filter((row) => !toDisplayText(row.productCode));
```

`scheduled` can now be an empty array here — the backend will still be called so it can run its own expired-note cleanup pass (Task 1) even when there's nothing new to schedule. `missingCode` on an empty array is itself empty, so the next block (the "상품코드가 없어 내보낼 수 없습니다" check) is unaffected and simply passes through.

- [ ] **Step 2: Lint and build**

Run: `npm run lint`
Expected: no new errors in `ClientSchedulePage.jsx`.

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 3: Manual verification**

Start both dev servers (`npm run dev`, and from `backend/`: `uvicorn main:app --reload --host 127.0.0.1 --port 8000`), open 거래처 → 일정, and confirm:
- With every D열 cell empty, clicking "EZAdmin 날짜 내보내기" now shows the `confirm("0건을 EZAdmin에 반영합니다. 계속할까요?")` dialog (instead of immediately showing "내보낼 일정이 없습니다") and, after confirming, the request actually reaches the backend (check the Network tab for a `POST /barcode/client-schedule/export-to-ezadmin` call).
- With at least one D열 filled in with a future date, export still behaves exactly as before (status shows `EZAdmin 날짜 내보내기 완료 (N건 변경)`).

- [ ] **Step 4: Commit**

```bash
git add src/components/ClientSchedule/ClientSchedulePage.jsx
git commit -m "Allow cleanup-only EZAdmin schedule exports when nothing is currently scheduled"
```
