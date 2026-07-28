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
