import sqlite3
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.barcode_routes import build_barcode_router


class _FakeResp:
    def __init__(self, content: bytes):
        self.content = content


class _FakeEzClient:
    """이지어드민 상품 팝업 대신 'myform:<코드>:<현재 상품명>' 형태의 응답을 준다."""

    def __init__(self, names):
        self._names = names

    def __call__(self, *a, **k):
        return self

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def get(self, url, **kwargs):
        code = url.split("id=")[1]
        return _FakeResp(f"myform:{code}:{self._names[code]}".encode("utf-8"))


def _parse_form(html: str):
    _, code, name = html.split(":", 2)
    return [("text", "product_id", f"P-{code}"), ("text", "name", name)]


def _make_client(monkeypatch, ez_names):
    uri = f"file:test_bad_stock_rename_{uuid.uuid4().hex}?mode=memory&cache=shared"
    keep_alive = sqlite3.connect(uri, uri=True)
    keep_alive.row_factory = sqlite3.Row

    def get_shared_db():
        conn = sqlite3.connect(uri, uri=True)
        conn.row_factory = sqlite3.Row
        return conn

    monkeypatch.setattr("api.barcode_routes.httpx.AsyncClient", _FakeEzClient(ez_names))
    monkeypatch.setattr("api.barcode_routes.ez_product_rename.parse_product_form", _parse_form)

    app = FastAPI()
    app.include_router(
        build_barcode_router(
            get_current_user=lambda: "tester",
            get_barcode_state=lambda *a, **k: {"loaded": True},
            to_int=lambda v: int(v or 0),
            process_and_load_any=lambda *a, **k: None,
            load_excel_any=lambda *a, **k: None,
            normalize_code=lambda v: v,
            process_easyadmin_product_upload=lambda *a, **k: None,
            content_disposition=lambda *a, **k: "",
            get_shared_incoming_counts=lambda: {},
            set_shared_incoming_counts=lambda *a, **k: None,
            get_shared_defect_counts=lambda: {},
            set_shared_defect_counts=lambda c: None,
            get_shared_defect_summon_counts=lambda: {},
            set_shared_defect_summon_counts=lambda c: None,
            get_shared_kimsungil_counts=lambda: {},
            set_shared_kimsungil_counts=lambda c: None,
            set_shared_barcode_data=lambda *a, **k: None,
            get_setting=lambda key: "session" if key == "ezadmin_phpsessid" else None,
            set_setting=lambda key, value: None,
            get_user_display=lambda u: u,
            get_shared_db=get_shared_db,
            get_db=get_shared_db,
        )
    )
    client = TestClient(app)
    client.get("/barcode/bad-stock/list")  # 악성재고 테이블을 만든다
    return client, keep_alive


def _add_stock(conn, zone, code, name=""):
    conn.execute(
        "INSERT INTO barcode_bad_stock (zone, code, product_name, created_at, username, qty) VALUES (?, ?, ?, '', 't', 1)",
        (zone, code, name),
    )
    conn.commit()


def _add_record(conn, code, original, renamed, letter):
    conn.execute(
        "INSERT INTO barcode_bad_stock_renamed (product_id, codes, original_name, renamed_name, letter) VALUES (?, ?, ?, ?, ?)",
        (f"P-{code}", code, original, renamed, letter),
    )
    conn.commit()


def _by_code(items):
    return {i["code"]: i for i in items}


def test_custom_letter_tab_gets_its_letter_and_other_custom_tab_is_excluded(monkeypatch):
    client, db = _make_client(monkeypatch, {"S00001": "코봄 플리츠 셔츠"})
    _add_stock(db, "상의F", "S00001", "코봄 플리츠 셔츠")
    _add_stock(db, "상의신상", "S00003", "신상 후드")

    data = client.post("/barcode/bad-stock/rename-products", json={"dry_run": True}).json()

    items = _by_code(data["items"])
    assert items["S00001"]["status"] == "rename"
    assert items["S00001"]["new_name"] == "ZF 코봄 플리츠 셔츠"
    assert [e["code"] for e in data["excluded"]] == ["S00003"]


def test_custom_tab_named_with_gubun_suffix_still_gets_its_letter(monkeypatch):
    client, db = _make_client(monkeypatch, {"S00006": "코봄 플리츠 프릴 카라 셔츠 미니 원피스 블랙 free"})
    _add_stock(db, "상의F구역", "S00006", "코봄 플리츠 프릴 카라 셔츠 미니 원피스 블랙 free")

    data = client.post("/barcode/bad-stock/rename-products", json={"dry_run": True}).json()

    item = _by_code(data["items"])["S00006"]
    assert item["status"] == "rename"
    assert item["new_name"] == "ZF 코봄 플리츠 프릴 카라 셔츠 미니 원피스 블랙 free"
    assert data["excluded"] == []


def test_recorded_name_with_leftover_prefix_is_fixed_not_skipped(monkeypatch):
    client, db = _make_client(monkeypatch, {"S00004": "ZD BC 하트 워크 팬츠"})
    _add_stock(db, "상의D", "S00004")
    _add_record(db, "S00004", "BC 하트 워크 팬츠", "ZD BC 하트 워크 팬츠", "D")

    data = client.post("/barcode/bad-stock/rename-products", json={"dry_run": True}).json()

    item = _by_code(data["items"])["S00004"]
    assert item["status"] == "rename"
    assert item["new_name"] == "ZD 하트 워크 팬츠"


def test_clean_recorded_name_is_still_skipped(monkeypatch):
    client, db = _make_client(monkeypatch, {})
    _add_stock(db, "상의B", "S00005")
    _add_record(db, "S00005", "런던 체크 스커트", "ZB 런던 체크 스커트", "B")

    data = client.post("/barcode/bad-stock/rename-products", json={"dry_run": True}).json()

    item = data["items"][0]
    assert item["status"] == "skip"
    assert item["message"] == "기록됨"
