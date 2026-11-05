import sqlite3
import time
import uuid
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api import wonbe_routes


class _FakeResp:
    def __init__(self, obj):
        self._obj = obj

    def json(self):
        return self._obj


class _FakeEzClient:
    """이지어드민 I100 한 페이지를 흉내낸다: {옵션 상품코드: 현재 상품명}."""

    def __init__(self, names):
        self._names = names

    def __call__(self, *a, **k):
        return self

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url, data=None, **kwargs):
        rows = [{"cell": {"key": code, "product_name": f"<b>{name}</b>"}} for code, name in self._names.items()]
        return _FakeResp({"rows": rows, "total": 1})


def _make_client(monkeypatch, tmp_path: Path, ez_names):
    db_path = tmp_path / f"wonbe_{uuid.uuid4().hex}.db"
    monkeypatch.setattr(wonbe_routes, "WONBE_DB_PATH", db_path)
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    wonbe_routes._init_wonbe_table(conn)
    # 대표상품코드 100(검정/A), 200(핑크/B), 300(회색, 이지어드민 목록에 없음)
    for code, rep, color in (("S101", "100", "검정"), ("S201", "200", "핑크"), ("S301", "300", "회색")):
        conn.execute(
            "INSERT INTO wonbe (상품코드, 대표상품코드, 상품명, 색상, 사이즈, 카테고리, 거래처) VALUES (?, ?, '레이스 티', ?, 'free', '상의', '거래처')",
            (code, rep, color),
        )
    conn.execute("CREATE TABLE IF NOT EXISTS wonbe_color_map2 (카테고리 TEXT NOT NULL, 색상 TEXT NOT NULL, letter TEXT NOT NULL, PRIMARY KEY (카테고리, 색상))")
    conn.executemany(
        "INSERT INTO wonbe_color_map2 VALUES ('상의', ?, ?)", [("검정", "A"), ("핑크", "B"), ("회색", "D")]
    )
    # 예전에 올린 기록: 셋 다 "반영됨"으로 기억하고 있다.
    conn.execute("CREATE TABLE IF NOT EXISTS wonbe_name_rename_applied (code TEXT PRIMARY KEY, new_name TEXT, applied_at TEXT)")
    conn.executemany(
        "INSERT INTO wonbe_name_rename_applied VALUES (?, ?, 'old')",
        [("100", "AA 레이스 티"), ("200", "AB 레이스 티"), ("300", "AD 레이스 티")],
    )
    conn.commit()
    conn.close()

    monkeypatch.setattr(wonbe_routes.httpx, "AsyncClient", _FakeEzClient(ez_names))
    app = FastAPI()
    app.include_router(
        wonbe_routes.build_wonbe_router(
            get_current_user=lambda: "tester",
            get_setting=lambda key: "session" if key == "ezadmin_phpsessid" else None,
        )
    )
    return TestClient(app), db_path


def _applied(db_path):
    conn = sqlite3.connect(str(db_path))
    try:
        return {r[0]: r[1] for r in conn.execute("SELECT code, new_name FROM wonbe_name_rename_applied")}
    finally:
        conn.close()


def _wait_done(client):
    for _ in range(100):
        st = client.get("/wonbe/name-rename/recheck/status").json()
        if not st.get("running"):
            return st
        time.sleep(0.05)
    raise AssertionError("재조회가 끝나지 않았습니다")


def test_recheck_compares_with_ezadmin_and_fixes_memory(monkeypatch, tmp_path):
    # 100: 이름이 계획과 같음 / 200: 이지어드민에서 구역 글자가 사라짐 / 300: 목록에 없음
    client, db_path = _make_client(monkeypatch, tmp_path, {"S101": "AA 레이스 티", "S201": "레이스 티"})
    with client:
        started = client.post("/wonbe/name-rename/recheck", json={})
        assert started.json()["ok"] is True
        st = _wait_done(client)

    assert st["error"] == ""
    assert (st["checked"], st["same"], st["diff"], st["unknown"]) == (3, 1, 1, 1)
    assert st["diff_items"] == [{"code": "200", "old": "레이스 티", "new": "AB 레이스 티", "actual": "레이스 티"}]
    applied = _applied(db_path)
    assert applied["100"] == "AA 레이스 티"
    assert "200" not in applied  # 다시 변경 대상이 되도록 기억을 지운다
    assert applied["300"] == "AD 레이스 티"  # 확인 못한 상품은 건드리지 않는다


def test_recheck_without_session_asks_for_it(monkeypatch, tmp_path):
    client, _ = _make_client(monkeypatch, tmp_path, {})
    app = FastAPI()
    app.include_router(wonbe_routes.build_wonbe_router(get_current_user=lambda: "tester", get_setting=lambda key: None))
    res = TestClient(app).post("/wonbe/name-rename/recheck", json={})
    assert res.json() == {"ok": False, "need_session": True}
