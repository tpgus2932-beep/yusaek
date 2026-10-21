import io
import sqlite3
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import openpyxl
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.luna_order_routes import build_luna_order_router


def _make_client():
    uri = f"file:test_luna_order_{uuid.uuid4().hex}?mode=memory&cache=shared"
    keep_alive = sqlite3.connect(uri, uri=True)

    def factory():
        conn = sqlite3.connect(uri, uri=True)
        conn.row_factory = sqlite3.Row
        return conn

    app = FastAPI()
    app.include_router(build_luna_order_router(get_current_user=lambda: "tester", get_shared_db=factory))
    return TestClient(app), keep_alive


def test_unmatched_until_manual_mapping_then_auto_and_sum():
    client, _keep = _make_client()
    rows = client.get("/luna-order/template-rows", params={"q": "LPA4000J111"}).json()["rows"]
    assert len(rows) == 1
    target = rows[0]

    items = [{"yusas_code": "A1", "qty": 2}, {"yusas_code": "A2", "qty": 3}]
    res = client.post("/luna-order/resolve", json={"items": items}).json()
    assert res["matched"] == [] and len(res["unmatched"]) == 2

    for code in ("A1", "A2"):
        client.put("/luna-order/mappings", json={
            "yusas_code": code, "template_code": target["code"],
            "template_name": target["name"], "template_option": target["option"],
        })
    res = client.post("/luna-order/resolve", json={"items": items}).json()
    assert [m["row"] for m in res["matched"]] == [target["row"]] * 2

    resp = client.post("/luna-order/export", json={"items": items})
    assert resp.headers["x-unmatched-count"] == "0"
    ws = openpyxl.load_workbook(io.BytesIO(resp.content)).worksheets[0]
    assert ws.cell(row=target["row"], column=5).value == 5

    client.delete("/luna-order/mappings/A1")
    assert [m["yusas_code"] for m in client.get("/luna-order/mappings").json()["mappings"]] == ["A2"]
