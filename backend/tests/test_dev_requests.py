import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.collab_routes import build_collab_router

_SCHEMA = """
CREATE TABLE requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    requester_username TEXT NOT NULL, requester_display TEXT NOT NULL DEFAULT '',
    assignee_username TEXT NOT NULL, assignee_display TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL,
    completed_at TEXT, acknowledged_at TEXT
);
CREATE TABLE request_attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT, request_id INTEGER, original_name TEXT,
    stored_name TEXT, mime_type TEXT, size INTEGER, created_at TEXT
);
"""


def _make(tmp_path):
    db_path = tmp_path / "t.db"
    boot = sqlite3.connect(db_path)
    boot.executescript(_SCHEMA)
    boot.commit()
    boot.close()

    def get_db():
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        return conn

    state = {"user": "worker"}
    router = build_collab_router(
        get_current_user=lambda: state["user"],
        require_admin=lambda: state["user"],
        get_current_user_optional=lambda: state["user"],
        is_admin=lambda u: u == "boss",
        get_db=get_db,
        get_user_display=lambda u: u.upper(),
        is_visible_completed=lambda _v: True,
        get_request_attachments=lambda ids: {},
        row_to_request=lambda r: {k: r[k] for k in r.keys()},
        row_to_shared_file=lambda r: dict(r),
        get_setting=lambda k: None,
        set_setting=lambda k, v: None,
        hash_pin=lambda p: p,
        verify_pin=lambda p, h: True,
        upload_base=tmp_path / "up",
        shared_upload_base=tmp_path / "sh",
        allowed_request_exts=None,
        allowed_shared_exts=None,
    )
    app = FastAPI()
    app.include_router(router)
    return TestClient(app), state


def _assigned_texts(client):
    return [r["text"] for r in client.get("/requests/assigned").json()["requests"]]


def test_complete_sends_notice_to_requester(tmp_path):
    client, state = _make(tmp_path)
    assert client.post("/dev-requests", json={"text": "버튼 추가해주세요"}).json()["ok"]
    dev_id = client.get("/dev-requests").json()["requests"][0]["id"]

    state["user"] = "worker"
    assert client.post(f"/dev-requests/{dev_id}/complete").status_code == 403

    state["user"] = "boss"
    res = client.post(f"/dev-requests/{dev_id}/complete")
    assert res.json() == {"ok": True, "notified": True}

    state["user"] = "worker"
    assert any("[개발요청 완료] 버튼 추가해주세요" in t for t in _assigned_texts(client))


def test_self_complete_still_shows_in_received_requests(tmp_path):
    client, state = _make(tmp_path)
    state["user"] = "boss"
    client.post("/dev-requests", json={"text": "내가 올린 요청"})
    dev_id = client.get("/dev-requests").json()["requests"][0]["id"]
    assert client.post(f"/dev-requests/{dev_id}/complete").json()["notified"] is True
    assert any("[개발요청 완료] 내가 올린 요청" in t for t in _assigned_texts(client))
