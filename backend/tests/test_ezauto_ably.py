import asyncio
import io
import sys
import time
from datetime import date
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import xlrd
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api import ezauto_routes
from sdk.ezadmin import EzAdminSessionExpired
from services import ezauto_ably as svc

TODAY = date(2026, 11, 12)


def _item(sno, order_sno, **over):
    base = {
        "sno": sno, "order_sno": order_sno, "ea": 1, "status": "상품 준비중", "option_info": "블랙/FREE",
        "checked_at": "2026-11-12 09:30", "buyer_name": "구매자", "buyer_tel": "010-1111-2222", "goods_sno": 111,
        "goods_custom_code": "자체 코드 1", "goods_name": "[브랜드🖤/매장] 니트 가디건", "receiver_name": "수취인",
        "receiver_tel": "010-3333-4444", "receiver_addr": "서울시 어딘가 1", "receiver_postcode": "06000",
        "memo": "", "price": 19900, "delivery_type": "standard", "delivery_type_kor": "일반배송",
        "is_today_combine_delivery": False, "option_stock_sync_code": "S12345",
    }
    base.update(over)
    return base


# ---------------------------------------------------------------- 엑셀 변환
def test_order_row_follows_captured_format():
    row = svc.order_row(_item(672124380, 1794437932191))
    assert len(row) == len(svc.ORDER_HEADERS) == 23
    r = dict(zip(svc.ORDER_HEADERS, row))
    assert r["상품주문번호"] == "672124380" and r["주문번호"] == "1794437932191"
    assert r["수량"] == "1" and r["상품 판매가"] == "19900"          # 전부 문자열
    assert r["택배사"] == "" and r["개인통관고유부호"] == ""
    assert r["배송타입"] == "일반배송" and r["오늘 출발 상품 합배송 여부"] == "False"
    assert r["솔루션사 고유코드"] == "S12345"


def test_today_delivery_label_and_combine_flag():
    r = dict(zip(svc.ORDER_HEADERS, svc.order_row(_item(
        1, 2, delivery_type="today", delivery_type_kor="오늘출발(합배송)", is_today_combine_delivery=True))))
    assert r["배송타입"] == "오늘출발"            # 괄호 설명 제거
    assert r["배송구분"] == "오늘출발(합배송)"    # 원문 유지
    assert r["오늘 출발 상품 합배송 여부"] == "True"


def test_product_name_removes_only_listed_emoji():
    clean = svc.clean_product_name
    assert clean("[브랜드🖤/매장] 니트") == "[브랜드/매장] 니트"
    assert clean("눈꽃❄️원피스") == "눈꽃원피스"          # ❄ 뒤 변형 선택자도 함께 제거
    assert clean("불🔥 하늘💙 반짝✨ 사랑💗") == "불 하늘 반짝 사랑"
    assert clean("[브랜드🎀/매장] 🤍 🦢 ☃️") == "[브랜드🎀/매장] 🤍 🦢 ☃️"   # 나머지 이모지는 유지


def test_build_xls_round_trips_with_text_cells():
    xls = svc.build_order_xls([_item(1, 10), _item(2, 11, memo="문 앞에 놓아주세요")])
    sheet = xlrd.open_workbook(file_contents=xls).sheet_by_index(0)
    assert (sheet.nrows, sheet.ncols) == (3, 23)
    assert [sheet.cell_value(0, c) for c in range(23)] == svc.ORDER_HEADERS
    assert sheet.cell_value(2, 16) == "문 앞에 놓아주세요"
    assert sheet.cell_value(1, 10) == "[브랜드/매장] 니트 가디건"
    assert all(sheet.cell_type(r, c) == xlrd.XL_CELL_TEXT for r in range(3) for c in range(23))  # 빈 칸도 문자열 셀


def test_upload_filename_matches_original_program():
    assert svc.upload_filename("10028", date(2026, 10, 27), date(2026, 11, 12)) == "10028_download_20261027_20261112.xls"


# ---------------------------------------------------------------- 송장 매칭
def _cell(pack, status="8"):
    return {"cell": {"pack": pack, "status": status}}


def _pl(sno, invoice, corp="30079", status="8"):
    return {"order_id_seq": sno, "trans_no": invoice, "trans_corp_id": corp, "status": status}


def test_collect_shipped_invoices_only_shipped_and_matching_sno():
    rows = [_cell("P1"), _cell("P2", status="1")]
    packlists = {"P1": [_pl("100", "111111111111"), _pl("999", "222222222222"), _pl("101", "")],
                 "P2": [_pl("102", "333333333333")]}
    got = svc.collect_shipped_invoices("55", {"100", "101", "102"}, rows, packlists)
    assert got == {"100": {"invoice": "111111111111", "corp": "30079"}}   # 미출고(status 1)·번호없음·다른 sno 제외


# ---------------------------------------------------------------- 실행 흐름(가짜 에이블리/이지어드민)
class FakeAbly:
    def __init__(self, new=(), preparing=(), delivery_sno=5, send_fail=()):
        self.new, self.preparing, self.delivery_sno, self.send_fail = list(new), list(preparing), delivery_sno, set(send_fail)
        self.prepared, self.sent = [], []

    async def list_items(self, status, start, end):
        assert (end - start).days == svc.LOOKBACK_DAYS
        return (self.new if status == 1 else self.preparing), self.delivery_sno

    async def prepare(self, snos):
        self.prepared.extend(snos)

    async def send_invoices(self, data_list):
        self.sent.extend(data_list)
        ok = [d["sno"] for d in data_list if d["sno"] not in self.send_fail]
        return {"success_snos": ok, "errors": {}}


class FakeEz:
    def __init__(self, orders=None, packlists=None, post_response=None):
        self.orders, self.packlists = orders or {}, packlists or {}
        self.post_response = post_response or {"success": True, "cnt_total": 3, "cnt_new": 2, "cnt_balju": "5"}
        self.posts = []

    async def post(self, template, action, **kwargs):
        self.posts.append((template, action, kwargs))
        return self.post_response

    async def query_orders(self, keyword, *, start_date, end_date, rows=10):
        return self.orders.get(keyword, [])

    async def packlist_items(self, pack):
        return self.packlists.get(pack, [])


def test_auto_order_confirms_new_orders_then_uploads_all_preparing():
    ably = FakeAbly(new=[_item(1, 10), _item(2, 11)], preparing=[_item(1, 10), _item(2, 11), _item(3, 12)])
    ez = FakeEz()
    logs = []
    result = asyncio.run(svc.run_auto_order(ably, ez, shop_id="10028", today=TODAY, log=logs.append))
    assert ably.prepared == [1, 2]                       # 신규 주문만 주문확인
    (template, action, kwargs), = ez.posts
    assert (template, action) == ("DC00", "reg_orders_manual")
    assert kwargs["data"] == {"shop_id": "10028", "mode": "1", "is_auto": "1", "version": svc.UPLOAD_VERSION}
    assert kwargs["time_flag"] is None
    name, content, _ctype = kwargs["files"]["_file"]
    assert name == "10028_download_20261027_20261112.xls"
    assert xlrd.open_workbook(file_contents=content).sheet_by_index(0).nrows == 4   # 머리글 + 상품준비중 3건 전부
    assert result["confirmed"] == 2 and result["items"] == 3 and result["ez_new"] == 2


def test_auto_order_skips_upload_when_nothing_to_register():
    ez = FakeEz()
    result = asyncio.run(svc.run_auto_order(FakeAbly(), ez, shop_id="10028", today=TODAY, log=lambda m: None))
    assert result["uploaded"] is False and ez.posts == []


def test_auto_order_raises_when_ezadmin_rejects():
    ez = FakeEz(post_response={"success": False, "msg": "bad"})
    ably = FakeAbly(preparing=[_item(1, 10)])
    try:
        asyncio.run(svc.run_auto_order(ably, ez, shop_id="10028", today=TODAY, log=lambda m: None))
        raise AssertionError("expected EzautoError")
    except svc.EzautoError as exc:
        assert "발주 입력 실패" in str(exc)


def test_invoice_register_sends_only_shipped_lotte_orders():
    preparing = [_item(100, 1000), _item(200, 2000), _item(300, 3000), _item(400, 4000)]
    ez = FakeEz(
        orders={"1000": [_cell("P1")], "2000": [_cell("P2")], "3000": [_cell("P3", status="1")], "4000": []},
        packlists={"P1": [_pl("100", "411111111111")],
                   "P2": [_pl("200", "422222222222", corp="99999")],     # 다른 택배사 -> 건너뜀
                   "P3": [_pl("300", "433333333333")]},                 # 미출고 -> 조회도 안 함
    )
    ably = FakeAbly(preparing=preparing)
    result = asyncio.run(svc.run_invoice_register(ably, ez, today=TODAY, log=lambda m: None))
    assert ably.sent == [{"delivery_sno": 5, "invoice": "411111111111", "sno": 100}]
    assert result == {"checked": 4, "shipped": 2, "sent": 1, "failed": 0, "skipped_corp": 1, "errors": {}}


def test_invoice_register_counts_failures_and_handles_nothing_shipped():
    ez = FakeEz(orders={"1000": [_cell("P1")]}, packlists={"P1": [_pl("100", "411111111111")]})
    ably = FakeAbly(preparing=[_item(100, 1000)], send_fail=[100])
    result = asyncio.run(svc.run_invoice_register(ably, ez, today=TODAY, log=lambda m: None))
    assert result["sent"] == 0 and result["failed"] == 1

    none = asyncio.run(svc.run_invoice_register(FakeAbly(preparing=[_item(1, 10)]), FakeEz(), today=TODAY, log=lambda m: None))
    assert none["sent"] == 0 and none["shipped"] == 0


# ---------------------------------------------------------------- API (백그라운드 실행 + 상태)
def _make_client():
    store = {}
    app = FastAPI()
    app.include_router(ezauto_routes.build_ezauto_router(
        get_current_user=lambda: "tester", get_setting=lambda k, d="": store.get(k, d),
        set_setting=lambda k, v: store.__setitem__(k, v)))
    return TestClient(app), store


def _wait_done(client, kind, timeout=5.0):
    end = time.time() + timeout
    while time.time() < end:
        job = client.get("/ezauto/status").json()[kind]
        if not job["running"] and job["finished_at"]:
            return job
        time.sleep(0.05)
    raise AssertionError("job did not finish")


def test_api_reports_missing_api_key():
    client, _ = _make_client()
    with client, patch.object(ezauto_routes.ez_config, "ABLY_VENDOR_API_KEY", ""):
        assert client.post("/ezauto/auto-order").json() == {"ok": True, "started": True}
        job = _wait_done(client, "auto_order")
    assert "ABLY_VENDOR_API_KEY" in job["error"] and job["result"] is None


def test_api_runs_auto_order_and_keeps_last_result():
    client, store = _make_client()
    fake_ably = FakeAbly(new=[_item(1, 10)], preparing=[_item(1, 10)])
    fake_ez = FakeEz()
    with client, patch.object(ezauto_routes.ez_config, "ABLY_VENDOR_API_KEY", "k"), \
            patch.object(ezauto_routes.ez_config, "ABLY_VENDOR_TOKEN", "t"), \
            patch.object(ezauto_routes.ez_ably, "AblyVendorClient", lambda token, key, base="": fake_ably), \
            patch.object(ezauto_routes, "EzAdminClient", lambda get_setting, timeout=30.0: fake_ez):
        client.post("/ezauto/auto-order")
        job = _wait_done(client, "auto_order")
    assert job["error"] == "" and job["result"]["uploaded"] is True and job["started_by"] == "tester"
    assert any("주문확인" in s for s in job["steps"])
    assert "ezauto_last_auto_order" in store          # 서버 재시작 후에도 마지막 결과를 보여주기 위해 저장


def test_api_reports_session_expired_and_blocks_double_start():
    client, _ = _make_client()

    class ExpiredEz(FakeEz):
        async def post(self, *a, **k):
            await asyncio.sleep(0.2)
            raise EzAdminSessionExpired("expired")

    with client, patch.object(ezauto_routes.ez_config, "ABLY_VENDOR_API_KEY", "k"), \
            patch.object(ezauto_routes.ez_config, "ABLY_VENDOR_TOKEN", "t"), \
            patch.object(ezauto_routes.ez_ably, "AblyVendorClient", lambda token, key, base="": FakeAbly(preparing=[_item(1, 10)])), \
            patch.object(ezauto_routes, "EzAdminClient", lambda get_setting, timeout=30.0: ExpiredEz()):
        assert client.post("/ezauto/auto-order").status_code == 200
        assert client.post("/ezauto/auto-order").status_code == 409     # 실행 중에는 다시 시작 불가
        job = _wait_done(client, "auto_order")
    assert job["need_session"] is True and "세션" in job["error"]
