import sqlite3
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.noye_kimsungil_routes import build_noye_kimsungil_router


def _client():
    uri = f"file:test_defect_purchase_{uuid.uuid4().hex}?mode=memory&cache=shared"
    keep = sqlite3.connect(uri, uri=True)

    def get_db():
        conn = sqlite3.connect(uri, uri=True)
        conn.row_factory = sqlite3.Row
        return conn

    app = FastAPI()
    app.include_router(
        build_noye_kimsungil_router(
            get_current_user=lambda: "tester",
            get_setting=lambda k: None,
            set_setting=lambda k, v: None,
            get_db=get_db,
        )
    )
    return TestClient(app), keep


ROW = {
    "code": "P1", "vendor": "A상사", "productName": "셔츠", "ownName": "자사셔츠", "color": "블랙", "size": "M", "cost": 1000, "qty": 3,
    "records": [{"id": 7, "qty": 3, "reason": "구멍", "photo_ids": [1, 2], "created_at": "2026-11-08T10:00:00+09:00"}],
}


def test_add_dedup_deduct_restore_and_logs():
    client, _keep = _client()
    base = "/noye-kimsungil/defect-purchase"
    assert client.post(f"{base}/add", json={"rows": [ROW]}).json()["added"] == 1
    assert client.post(f"{base}/add", json={"rows": [ROW]}).json()["skipped"] == 1

    vendors = client.get(f"{base}/list").json()["vendors"]
    assert vendors[0]["held_amount"] == 3000
    item = vendors[0]["items"][0]
    assert item["records"][0]["reason"] == "구멍"

    client.post(f"{base}/status", json={"item_ids": [item["id"]], "status": "deducted"})
    assert client.get(f"{base}/list").json()["vendors"][0]["held_amount"] == 0
    client.post(f"{base}/status", json={"item_ids": [item["id"]], "status": "held"})

    logs = client.get(f"{base}/logs").json()["logs"]
    assert [(l["kind"], l["delta"]) for l in logs] == [("restore", 3000), ("deduct", -3000), ("add", 3000)]
    assert logs[1]["vendor_balance_after"] == 0
    assert logs[0]["own_name"] == "자사셔츠" and logs[0]["records"][0]["reason"] == "구멍"
    assert client.get(f"{base}/logs", params={"vendor": "없음"}).json()["logs"] == []


def test_double_send_guard_only_new_qty_moves():
    client, _keep = _client()
    base = "/noye-kimsungil/defect-purchase"

    def send(normal, summon=0, qty=None):
        row = dict(ROW, qty=qty if qty is not None else normal + summon, records=[])
        body = {"tab": "A", "rows": [row], "parts": {"P1": {"normal": normal, "summon": summon}}}
        return client.post(f"{base}/add", json=body).json()

    assert send(3)["results"][0]["status"] == "added"
    again = send(3)
    assert again["added"] == 0 and again["results"][0]["status"] == "skipped"
    more = send(5)  # 불량이 2개 늘어남 → 신규 2개만 이동
    assert more["results"][0]["status"] == "added" and more["results"][0]["qty"] == 2
    summon = send(5, 1)  # 소환술은 별도 종류라 1개가 신규
    assert summon["results"][0]["qty"] == 1

    state = client.post(f"{base}/sent-state", json={"tab": "A", "parts": {"P1": {"normal": 5, "summon": 1}}}).json()["sent"]
    assert state["P1"] == {"normal": 5, "summon": 1}
    # 수량이 줄면 낮추고, 목록에서 사라지면 기록 삭제 → 다시 불량이 생기면 신규로 이동 가능
    lowered = client.post(f"{base}/sent-state", json={"tab": "A", "parts": {"P1": {"normal": 2, "summon": 0}}}).json()["sent"]
    assert lowered["P1"] == {"normal": 2, "summon": 0}
    client.post(f"{base}/sent-state", json={"tab": "A", "parts": {}})
    assert send(1)["results"][0]["status"] == "added"


def test_manual_entry_and_manual_product_add_bypass_guard():
    client, _keep = _client()
    base = "/noye-kimsungil/defect-purchase"
    assert client.post(f"{base}/manual", json={"vendor": "필앤마조", "amount": "-23,000", "memo": "오이체로 인한 매입잡음"}).status_code == 200
    assert client.post(f"{base}/manual", json={"vendor": "", "amount": 1}).status_code == 400
    assert client.post(f"{base}/manual", json={"vendor": "필앤마조", "amount": 0}).status_code == 400
    vendor = client.get(f"{base}/list").json()["vendors"][0]
    assert vendor["held_amount"] == -23000 and vendor["items"][0]["source"] == "manual"
    log = client.get(f"{base}/logs", params={"vendor": "필앤마조"}).json()["logs"][0]
    assert log["kind"] == "manual" and log["delta"] == -23000 and log["memo"] == "오이체로 인한 매입잡음"

    row = dict(ROW, records=[])
    body = {"rows": [row], "manual": True}
    assert client.post(f"{base}/add", json=body).json()["added"] == 1
    assert client.post(f"{base}/add", json=body).json()["added"] == 1  # 직접 추가는 중복 방지 장치 대상이 아님


def test_delete_item_restores_balance_and_allows_resend():
    client, _keep = _client()
    base = "/noye-kimsungil/defect-purchase"
    row = dict(ROW, records=[])
    body = {"tab": "A", "rows": [row], "parts": {"P1": {"normal": 3, "summon": 0}}}
    assert client.post(f"{base}/add", json=body).json()["added"] == 1
    item = client.get(f"{base}/list").json()["vendors"][0]["items"][0]
    assert client.post(f"{base}/delete", json={"item_id": item["id"]}).json()["vendor_balance"] == 0
    assert client.get(f"{base}/list").json()["vendors"] == []
    assert client.post(f"{base}/delete", json={"item_id": item["id"]}).status_code == 404
    logs = client.get(f"{base}/logs", params={"vendor": "A상사"}).json()["logs"]
    assert (logs[0]["kind"], logs[0]["delta"]) == ("delete", -3000)
    # 삭제하면 '이미 보낸 수량'도 되돌아가 바코드에서 다시 보낼 수 있다
    assert client.post(f"{base}/add", json=body).json()["added"] == 1


def test_log_vendors_include_vendors_missing_from_list():
    client, _keep = _client()
    base = "/noye-kimsungil/defect-purchase"
    client.post(f"{base}/add", json={"rows": [dict(ROW, records=[])]})
    item = client.get(f"{base}/list").json()["vendors"][0]["items"][0]
    client.post(f"{base}/delete", json={"item_id": item["id"]})
    assert client.get(f"{base}/list").json()["vendors"] == []
    lv = client.get(f"{base}/log-vendors").json()["vendors"]
    assert lv[0]["vendor"] == "A상사" and lv[0]["log_count"] == 2 and lv[0]["held_amount"] == 0
