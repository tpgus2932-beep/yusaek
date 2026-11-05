from tests.test_bad_stock_rename_products import _add_stock, _make_client


def _qty(db, code):
    return {r["zone"]: r["qty"] for r in db.execute("SELECT zone, qty FROM barcode_bad_stock WHERE code = ?", (code,))}


def test_returns_stockin_adds_qty_to_existing_tab_and_returns_label_prefix(monkeypatch):
    client, db = _make_client(monkeypatch, {})
    _add_stock(db, "상의B", "S00001", "셔츠")

    res = client.post("/barcode/bad-stock/returns-stockin", json={"codes": ["S00001", "S99999"]})

    body = res.json()
    assert body["ok"] is True
    assert body["items"] == {"S00001": {"zone": "상의B", "prefix": "ZB", "added": 1}}  # 악성재고 아닌 코드는 빠진다
    assert _qty(db, "S00001") == {"상의B": 2}


def test_returns_stockin_picks_highest_priority_tab_when_in_several(monkeypatch):
    client, db = _make_client(monkeypatch, {})
    _add_stock(db, "하의C", "S00002")
    _add_stock(db, "상의A", "S00002")

    res = client.post("/barcode/bad-stock/returns-stockin", json={"codes": ["S00002"]})

    assert res.json()["items"]["S00002"]["zone"] == "상의A"
    assert _qty(db, "S00002") == {"하의C": 1, "상의A": 2}


def test_returns_stockin_counts_repeated_codes(monkeypatch):
    client, db = _make_client(monkeypatch, {})
    _add_stock(db, "아우터A", "S00003")

    res = client.post("/barcode/bad-stock/returns-stockin", json={"codes": ["S00003", "S00003"]})

    assert res.json()["items"]["S00003"]["added"] == 2
    assert _qty(db, "S00003") == {"아우터A": 3}
