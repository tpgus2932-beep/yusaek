import base64
import sqlite3
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.barcode_routes import build_barcode_router


class _FakeWonbeConn:
    def execute(self, *a, **k):
        return self

    def fetchall(self):
        return []

    def close(self):
        pass


def _photo(tag: str = "a") -> str:
    return "data:image/jpeg;base64," + base64.b64encode(f"fake-jpeg-{tag}".encode()).decode()


def _make_client(monkeypatch, user="tester", shared_db_override=None):
    monkeypatch.setattr("api.barcode_routes._get_wonbe_db", lambda: _FakeWonbeConn())
    uri = f"file:test_defect_record_{uuid.uuid4().hex}?mode=memory&cache=shared"
    keep_alive = sqlite3.connect(uri, uri=True)
    keep_alive.row_factory = sqlite3.Row

    def get_shared_db():
        conn = sqlite3.connect(uri, uri=True)
        conn.row_factory = sqlite3.Row
        return conn

    defect_store = {"counts": {}}
    app = FastAPI()
    app.include_router(
        build_barcode_router(
            get_current_user=lambda: user,
            get_barcode_state=lambda *a, **k: {"loaded": True},
            to_int=lambda v: int(v or 0),
            process_and_load_any=lambda *a, **k: None,
            load_excel_any=lambda *a, **k: None,
            normalize_code=lambda v: v,
            process_easyadmin_product_upload=lambda *a, **k: None,
            content_disposition=lambda *a, **k: "",
            get_shared_incoming_counts=lambda: {},
            set_shared_incoming_counts=lambda *a, **k: None,
            get_shared_defect_counts=lambda: defect_store["counts"],
            set_shared_defect_counts=lambda c: defect_store.__setitem__("counts", dict(c or {})),
            get_shared_defect_summon_counts=lambda: {},
            set_shared_defect_summon_counts=lambda *a, **k: None,
            get_shared_kimsungil_counts=lambda: {},
            set_shared_kimsungil_counts=lambda *a, **k: None,
            set_shared_barcode_data=lambda *a, **k: None,
            get_setting=lambda key: None,
            set_setting=lambda key, value: None,
            get_user_display=lambda u: u,
            get_shared_db=shared_db_override or get_shared_db,
            get_db=get_shared_db,
            get_normalization_db=get_shared_db,
        )
    )
    return TestClient(app), keep_alive, defect_store


def test_single_defect_is_saved_to_sqlite(monkeypatch):
    client, db, _ = _make_client(monkeypatch)
    res = client.post(
        "/barcode/defect/record/add",
        json={"code": "P1", "qty": 1, "reason": "봉제 불량", "photos": [_photo("1")]},
    )
    assert res.status_code == 200
    # SQLite 에 상품명(없으면 코드) + 사유 + 사진이 들어갔는지 직접 조회
    row = db.execute(
        "SELECT r.code, r.product_name, r.reason, r.qty, p.mime, p.data"
        " FROM barcode_defect_records r JOIN barcode_defect_record_photos p ON p.record_id = r.id"
    ).fetchone()
    assert row["code"] == "P1"
    assert row["product_name"] == "P1"
    assert row["reason"] == "봉제 불량"
    assert row["qty"] == 1
    assert row["mime"] == "image/jpeg"
    assert base64.b64decode(row["data"]) == b"fake-jpeg-1"


def test_batch_applies_one_photo_and_reason_to_all(monkeypatch):
    client, db, store = _make_client(monkeypatch)
    res = client.post(
        "/barcode/defect/record/add",
        json={"code": "P1", "qty": 3, "reason": "기장 다름", "photos": [_photo()]},
    )
    assert res.status_code == 200
    records = res.json()["records"]
    assert len(records) == 1 and records[0]["qty"] == 3
    assert store["counts"]["P1"] == 3


def test_individual_entries_make_separate_records(monkeypatch):
    client, db, store = _make_client(monkeypatch)
    res = client.post(
        "/barcode/defect/record/add",
        json={
            "code": "P1",
            "entries": [
                {"reason": "봉제 불량", "photos": [_photo("x")]},
                {"reason": "오배송", "photos": [_photo("y"), _photo("z")]},
            ],
        },
    )
    assert res.status_code == 200
    records = res.json()["records"]
    assert len(records) == 2
    assert {r["reason"] for r in records} == {"봉제 불량", "오배송"}
    assert sorted(len(r["photo_ids"]) for r in records) == [1, 2]
    assert store["counts"]["P1"] == 2


def test_lookup_does_not_change_count_or_records(monkeypatch):
    client, db, store = _make_client(monkeypatch)
    res = client.get("/barcode/defect/record/lookup", params={"code": "P1"})
    assert res.status_code == 200 and res.json()["code"] == "P1"
    assert store["counts"] == {}
    # 조회는 DB 를 아예 건드리지 않는다 (테이블도 만들어지지 않음)
    tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert "barcode_defect_records" not in tables


def test_photo_and_reason_required_unless_confirmed(monkeypatch):
    client, db, store = _make_client(monkeypatch)
    client.get("/barcode/defect/record/list")  # 테이블 생성
    add = "/barcode/defect/record/add"
    # 사진 없음 / 사유 없음 → 거부 (수량도 오르지 않음)
    assert client.post(add, json={"code": "P1", "reason": "x", "photos": []}).status_code == 400
    assert client.post(add, json={"code": "P1", "reason": "", "photos": [_photo()]}).status_code == 400
    assert client.post(add, json={"code": "P1", "photos": ["not-a-data-url"], "reason": "x"}).status_code == 400
    # 개별 모드에서 한 건이라도 비어 있으면 전체 거부(부분 저장 없음)
    res = client.post(add, json={"code": "P1", "entries": [{"reason": "a", "photos": [_photo()]}, {"reason": "", "photos": []}]})
    assert res.status_code == 400
    assert db.execute("SELECT COUNT(*) FROM barcode_defect_records").fetchone()[0] == 0
    assert store["counts"] == {}

    # 사용자가 팝업에서 '그래도 등록'을 확인한 경우(allow_incomplete)에만 빈 채로 등록된다
    ok = client.post(add, json={"code": "P1", "allow_incomplete": True, "reason": "", "photos": []})
    assert ok.status_code == 200
    rec = ok.json()["records"][0]
    assert rec["reason"] == "" and rec["photo_ids"] == []
    assert store["counts"]["P1"] == 1
    # 잘못된 형식의 사진은 확인 여부와 상관없이 거부
    bad = client.post(add, json={"code": "P1", "allow_incomplete": True, "photos": ["nope"]})
    assert bad.status_code == 400


def test_update_remove_and_photo_fetch(monkeypatch):
    client, db, _ = _make_client(monkeypatch)
    rec = client.post(
        "/barcode/defect/record/add",
        json={"code": "P1", "reason": "a", "photos": [_photo("1")]},
    ).json()["records"][0]
    photo_id = rec["photo_ids"][0]

    got = client.get(f"/barcode/defect/record/photo/{photo_id}").json()
    assert got["data_url"] == _photo("1")

    upd = client.post(
        "/barcode/defect/record/update",
        json={"id": rec["id"], "reason": "b", "add_photos": [_photo("2")]},
    ).json()["records"][0]
    assert upd["reason"] == "b" and len(upd["photo_ids"]) == 2

    # 사진을 모두 지워도 수정 자체는 허용된다 (프런트에서 확인 팝업을 거친다)
    cleared = client.post(
        "/barcode/defect/record/update",
        json={"id": rec["id"], "remove_photo_ids": upd["photo_ids"]},
    )
    assert cleared.status_code == 200 and cleared.json()["records"][0]["photo_ids"] == []

    client.post("/barcode/defect/record/remove", json={"id": rec["id"]})
    assert db.execute("SELECT COUNT(*) FROM barcode_defect_records").fetchone()[0] == 0
    assert db.execute("SELECT COUNT(*) FROM barcode_defect_record_photos").fetchone()[0] == 0


def test_records_go_to_local_sqlite_even_if_shared_db_is_remote(monkeypatch):
    """공용 DB(Turso 등)가 원격이어도 불량 기록은 로컬 SQLite 연결로만 저장된다."""

    def remote_shared_db():
        raise AssertionError("불량 기록이 공용(원격) DB 로 가면 안 된다")

    client, db, _ = _make_client(monkeypatch, shared_db_override=remote_shared_db)
    res = client.post(
        "/barcode/defect/record/add",
        json={"code": "P1", "reason": "봉제 불량", "photos": [_photo()]},
    )
    assert res.status_code == 200
    assert db.execute("SELECT COUNT(*) FROM barcode_defect_records").fetchone()[0] == 1


def test_attach_existing_keeps_count_unchanged(monkeypatch):
    """이미 수량이 잡혀 있는 불량에 사진·사유만 붙일 때는 수량이 다시 오르지 않는다."""
    client, db, store = _make_client(monkeypatch)
    client.post("/barcode/defect/add", json={"code": "P1"})  # 예전 방식으로 쌓인 불량 1개
    assert store["counts"]["P1"] == 1
    res = client.post(
        "/barcode/defect/record/add",
        json={"code": "P1", "qty": 1, "reason": "얼룩", "photos": [_photo()], "attach_existing": True},
    )
    assert res.status_code == 200
    assert store["counts"]["P1"] == 1
    assert res.json()["records"][0]["reason"] == "얼룩"


def test_search_finds_records_across_tabs_even_after_defect_removed(monkeypatch):
    """매입관리 조회용: 탭과 무관하게, 불량 목록에서 빠진 상품의 기록도 DB 에서 찾는다."""
    client, db, store = _make_client(monkeypatch)
    add = "/barcode/defect/record/add"
    client.post(add, json={"code": "P1", "reason": "얼룩", "photos": [_photo("a")]}, headers={"X-Defect-Tab": "A"})
    client.post(add, json={"code": "P2", "reason": "구멍", "photos": [_photo("b")]}, headers={"X-Defect-Tab": "B"})

    # 불량 목록(수량)에서 P1 을 지워도 기록은 DB 에 남아 있다
    client.post("/barcode/defect/remove", json={"code": "P1"}, headers={"X-Defect-Tab": "A"})

    everything = client.get("/barcode/defect/record/search").json()["records"]
    assert {r["code"] for r in everything} == {"P1", "P2"}
    assert {r["tab"] for r in everything} == {"A", "B"}
    assert all(len(r["photo_ids"]) == 1 for r in everything)

    assert [r["code"] for r in client.get("/barcode/defect/record/search", params={"q": "구멍"}).json()["records"]] == ["P2"]
    assert [r["code"] for r in client.get("/barcode/defect/record/search", params={"q": "P1"}).json()["records"]] == ["P1"]
    # 사진 본문은 목록에 싣지 않는다 (가볍게 조회, 클릭 시 한 장씩 로드)
    assert "data" not in everything[0] and "data_url" not in everything[0]
    # 날짜 필터: 오늘 포함 / 과거만이면 제외
    from datetime import datetime
    today = datetime.now().strftime("%Y-%m-%d")
    assert len(client.get("/barcode/defect/record/search", params={"date_from": today, "date_to": today}).json()["records"]) == 2
    assert client.get("/barcode/defect/record/search", params={"date_to": "2000-01-01"}).json()["records"] == []


def test_past_defect_record_does_not_attach_to_new_defect_of_same_code(monkeypatch):
    client, db, store = _make_client(monkeypatch)
    client.post("/barcode/defect/record/add", json={"code": "P1", "qty": 1, "reason": "옛날 사유", "photos": [_photo("old")]})
    assert [r["reason"] for r in client.get("/barcode/defect/record/list").json()["records"]] == ["옛날 사유"]

    # 불량이 목록에서 사라진 뒤(삭제/출고 등) 같은 상품코드를 다시 불량으로 찍는다
    client.post("/barcode/defect/remove", json={"code": "P1"})
    assert client.get("/barcode/defect/record/list").json()["records"] == []
    client.post("/barcode/defect/add", json={"code": "P1"})
    assert client.get("/barcode/defect/record/list").json()["records"] == []  # 옛날 사진·사유가 이어붙지 않는다

    # 이번에 찍은 사진·사유만 붙는다. 조회 화면(search)에는 지난 기록도 이력으로 남아 있다.
    client.post("/barcode/defect/record/add", json={"code": "P1", "qty": 1, "reason": "새 사유", "photos": [_photo("new")], "attach_existing": True})
    assert [r["reason"] for r in client.get("/barcode/defect/record/list").json()["records"]] == ["새 사유"]
    assert len(client.get("/barcode/defect/record/search").json()["records"]) == 2



def test_photo_reasons_per_photo(monkeypatch):
    client, _db, _ = _make_client(monkeypatch)
    rec = client.post(
        "/barcode/defect/record/add",
        json={
            "code": "P1",
            "photos": [{"data": _photo("1"), "reason": "얼룩"}, {"data": _photo("2"), "reason": "구멍"}, {"data": _photo("3"), "reason": "얼룩"}],
        },
    )
    assert rec.status_code == 200  # 사진별 사유가 있으면 기록 사유가 비어도 등록된다
    rec = rec.json()["records"][0]
    assert rec["photo_reasons"] == ["얼룩", "구멍", "얼룩"]
    assert rec["reason"] == "얼룩 / 구멍"

    upd = client.post(
        "/barcode/defect/record/update",
        json={"id": rec["id"], "photo_reasons": {str(rec["photo_ids"][1]): "봉제 불량"}, "add_photos": [{"data": _photo("4"), "reason": "사이즈"}]},
    ).json()["records"][0]
    assert upd["photo_reasons"] == ["얼룩", "봉제 불량", "얼룩", "사이즈"]
    assert upd["reason"] == "얼룩 / 봉제 불량 / 사이즈"
