import io
import sqlite3
import sys
import uuid
from datetime import datetime as _real_datetime
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


def _frozen_datetime(iso_string):
    frozen = _real_datetime.fromisoformat(iso_string)

    class _Frozen(_real_datetime):
        @classmethod
        def now(cls, tz=None):
            return frozen.astimezone(tz) if tz else frozen

    return _Frozen


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
