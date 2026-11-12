import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from api.delivery_anomaly_routes import EzAdminSessionExpired, resolve_ezadmin_invoices


class FakeEz:
    def __init__(self, rows_by_order=None, packlists=None, expire=False):
        self.rows_by_order, self.packlists, self.expire = rows_by_order or {}, packlists or {}, expire

    async def query_orders(self, keyword, *, start_date, end_date, rows=10):
        if self.expire:
            raise EzAdminSessionExpired("expired")
        return self.rows_by_order.get(keyword, [])

    async def packlist_items(self, pack):
        return self.packlists.get(pack, [])


def _item(order_no, sno, invoice):
    return {"order_no": order_no, "sno": sno, "invoice_no": invoice}


def _run(ez, items):
    asyncio.run(resolve_ezadmin_invoices(ez, items, start_date="2026-09-01", end_date="2026-11-12", concurrency=2))


def test_invoice_comes_from_packlist_and_flags_mismatch_with_ably():
    ez = FakeEz({"1000": [{"cell": {"pack": "P1"}}]},
                {"P1": [{"order_id_seq": "100", "trans_no": "411111111111"}, {"order_id_seq": "101", "trans_no": "422222222222"}]})
    items = [_item("1000", "100", "999999999999")]
    _run(ez, items)
    assert items[0]["invoice_no"] == "411111111111"           # sno가 같은 이지어드민 송장으로 교체
    assert "에이블리 999999999999" in items[0]["mismatch_reason"] and "411111111111" in items[0]["mismatch_reason"]


def test_matching_invoice_is_left_alone():
    ez = FakeEz({"1000": [{"cell": {"pack": "P1"}}]}, {"P1": [{"order_id_seq": "100", "trans_no": "411111111111"}]})
    items = [_item("1000", "100", "411111111111")]
    _run(ez, items)
    assert items[0]["invoice_no"] == "411111111111" and "mismatch_reason" not in items[0]


def test_falls_back_to_all_order_invoices_when_sno_not_found():
    ez = FakeEz({"1000": [{"cell": {"pack": "P1"}}]}, {"P1": [{"order_id_seq": "555", "trans_no": "411111111111"}]})
    items = [_item("1000", "100", "411111111111")]
    _run(ez, items)
    assert items[0]["invoice_no"] == "411111111111" and "mismatch_reason" not in items[0]


def test_empty_ably_invoice_uses_ezadmin_without_mismatch_flag():
    ez = FakeEz({"1000": [{"cell": {"pack": "P1"}}]}, {"P1": [{"order_id_seq": "100", "trans_no": "411111111111"}]})
    items = [_item("1000", "100", "")]
    _run(ez, items)
    assert items[0]["invoice_no"] == "411111111111" and "mismatch_reason" not in items[0]


def test_untouched_when_ezadmin_has_nothing_or_session_expired():
    items = [_item("1000", "100", "999999999999"), _item("2000", "200", "888888888888")]
    _run(FakeEz({"1000": [{"cell": {"pack": "P1"}}]}, {"P1": [{"order_id_seq": "100", "trans_no": ""}]}), items)
    assert [i["invoice_no"] for i in items] == ["999999999999", "888888888888"] and not any("mismatch_reason" in i for i in items)
    _run(FakeEz(expire=True), items)
    assert [i["invoice_no"] for i in items] == ["999999999999", "888888888888"]
