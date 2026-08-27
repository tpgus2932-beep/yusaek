import sqlite3
import sys
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.barcode_routes import build_barcode_router

_KST = ZoneInfo("Asia/Seoul")


class _FakeWonbeConn:
    """wonbe DB(상품 마스터)는 이 테스트의 관심사가 아니므로 항상 빈 결과를 준다."""

    def execute(self, *a, **k):
        return self

    def fetchall(self):
        return []

    def close(self):
        pass


class _FakeWonbeConnWithRows:
    """상품코드별 거래처를 지정해서 돌려주는 wonbe DB 스텁 - 거래처 제외 필터 테스트용."""

    def __init__(self, rows_by_code: dict[str, dict]):
        self._rows_by_code = rows_by_code
        self._last_result: list[dict] = []

    def execute(self, query, params=None):
        codes = list(params or [])
        self._last_result = [
            {"상품코드": code, **self._rows_by_code[code]}
            for code in codes
            if code in self._rows_by_code
        ]
        return self

    def fetchall(self):
        return self._last_result

    def close(self):
        pass


def _make_db_factory():
    uri = f"file:test_verify_order_history_{uuid.uuid4().hex}?mode=memory&cache=shared"
    keep_alive = sqlite3.connect(uri, uri=True)
    keep_alive.row_factory = sqlite3.Row

    def factory():
        conn = sqlite3.connect(uri, uri=True)
        conn.row_factory = sqlite3.Row
        return conn

    return factory, keep_alive


def _make_client(monkeypatch, incoming_counts, wonbe_conn=None):
    monkeypatch.setattr("api.barcode_routes._get_wonbe_db", lambda: wonbe_conn or _FakeWonbeConn())
    get_db, keep_alive = _make_db_factory()

    app = FastAPI()
    app.include_router(
        build_barcode_router(
            get_current_user=lambda: "tester",
            get_barcode_state=lambda *a, **k: {},
            to_int=lambda v: int(v or 0),
            process_and_load_any=lambda *a, **k: None,
            load_excel_any=lambda *a, **k: None,
            normalize_to_yusas=lambda v: v,
            process_easyadmin_product_upload=lambda *a, **k: None,
            content_disposition=lambda *a, **k: "",
            get_shared_incoming_counts=lambda: incoming_counts,
            set_shared_incoming_counts=lambda *a, **k: None,
            get_shared_defect_counts=lambda: {},
            set_shared_defect_counts=lambda *a, **k: None,
            get_shared_kimsungil_counts=lambda: {},
            set_shared_kimsungil_counts=lambda *a, **k: None,
            set_shared_barcode_data=lambda *a, **k: None,
            get_setting=lambda key: None,
            set_setting=lambda key, value: None,
            get_user_display=lambda u: f"표시:{u}",
            get_shared_db=get_db,
            get_db=get_db,
        )
    )
    return TestClient(app), get_db


def _insert_order_history(get_db, *, recorded_at: str, product_code: str):
    conn = get_db()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS order_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            execution_id TEXT NOT NULL DEFAULT '',
            recorded_at TEXT NOT NULL,
            action_type TEXT NOT NULL DEFAULT '',
            store_name TEXT NOT NULL DEFAULT '',
            product_code TEXT NOT NULL DEFAULT '',
            product_name TEXT NOT NULL DEFAULT '',
            supply_product_name TEXT NOT NULL DEFAULT '',
            options TEXT NOT NULL DEFAULT '',
            request_qty INTEGER NOT NULL DEFAULT 0,
            result_status TEXT NOT NULL DEFAULT '',
            result_reason TEXT NOT NULL DEFAULT '',
            recorded_by_username TEXT NOT NULL DEFAULT '',
            recorded_by_display_name TEXT NOT NULL DEFAULT ''
        )
        """
    )
    conn.execute(
        "INSERT INTO order_history (recorded_at, product_code, request_qty) VALUES (?, ?, 1)",
        (recorded_at, product_code),
    )
    conn.commit()
    conn.close()


def _yesterday() -> str:
    return (datetime.now(_KST) - timedelta(days=1)).strftime("%Y-%m-%d")


def test_verify_order_history_requires_loaded_incoming_file(monkeypatch):
    client, _get_db = _make_client(monkeypatch, incoming_counts={})

    res = client.post("/barcode/incoming/verify-order-history")

    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is False
    assert "입고 파일" in body["detail"]


def test_verify_order_history_flags_codes_missing_from_yesterday(monkeypatch):
    client, get_db = _make_client(monkeypatch, incoming_counts={"S1": 5, "S2": 3})
    _insert_order_history(get_db, recorded_at=f"{_yesterday()} 10:00:00", product_code="S1")

    res = client.post("/barcode/incoming/verify-order-history")

    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is True
    assert body["date"] == _yesterday()
    assert body["incoming_codes"] == 2
    codes = {item["code"] for item in body["missing"]}
    assert codes == {"S2"}
    assert body["missing"][0]["incomingQty"] == 3


def test_verify_order_history_ignores_other_dates(monkeypatch):
    """어제가 아닌 날짜(오늘/그제)에 있는 발주내역은 대조 대상이 아니라서 그대로 미확인으로 남아야 한다."""
    client, get_db = _make_client(monkeypatch, incoming_counts={"S1": 5})
    today = datetime.now(_KST).strftime("%Y-%m-%d")
    two_days_ago = (datetime.now(_KST) - timedelta(days=2)).strftime("%Y-%m-%d")
    _insert_order_history(get_db, recorded_at=f"{today} 10:00:00", product_code="S1")
    _insert_order_history(get_db, recorded_at=f"{two_days_ago} 10:00:00", product_code="S1")

    res = client.post("/barcode/incoming/verify-order-history")

    body = res.json()
    assert [item["code"] for item in body["missing"]] == ["S1"]


def test_verify_order_history_all_confirmed_returns_empty_missing(monkeypatch):
    client, get_db = _make_client(monkeypatch, incoming_counts={"S1": 5})
    _insert_order_history(get_db, recorded_at=f"{_yesterday()} 23:59:00", product_code="S1")

    res = client.post("/barcode/incoming/verify-order-history")

    body = res.json()
    assert body["missing"] == []


def test_verify_order_history_matches_yusas_incoming_code_against_s_code_history(monkeypatch):
    """입고파일 코드는 normalize_to_yusas가 만든 YUSAS00000 형식인데 order_history/wonbe는
    S00000 형식이라, 형식을 맞춰 비교하지 않으면 실제로는 발주된 상품도 전부 미확인으로
    잘못 뜬다 - 그 회귀를 막는 테스트."""
    client, get_db = _make_client(monkeypatch, incoming_counts={"YUSAS00123": 5, "YUSAS00456": 2})
    _insert_order_history(get_db, recorded_at=f"{_yesterday()} 10:00:00", product_code="S00123")

    res = client.post("/barcode/incoming/verify-order-history")

    body = res.json()
    assert body["ok"] is True
    assert [item["code"] for item in body["missing"]] == ["S00456"]
    assert body["missing"][0]["incomingQty"] == 2


def test_verify_order_history_excludes_specific_clients(monkeypatch):
    """케이디지/리자드스탠다드/리마인드/계란속노른자/도매킴 거래처 상품은 미확인 목록에서 빠져야 한다."""
    wonbe_conn = _FakeWonbeConnWithRows({
        "S001": {"상품명": "케이디지상품", "색상": "", "사이즈": "", "거래처": "케이디지"},
        "S002": {"상품명": "일반상품", "색상": "", "사이즈": "", "거래처": "동대문상회"},
        "S003": {"상품명": "도매킴상품", "색상": "", "사이즈": "", "거래처": "도매킴"},
    })
    client, get_db = _make_client(
        monkeypatch, incoming_counts={"S001": 1, "S002": 1, "S003": 1}, wonbe_conn=wonbe_conn
    )

    res = client.post("/barcode/incoming/verify-order-history")

    body = res.json()
    assert [item["code"] for item in body["missing"]] == ["S002"]
