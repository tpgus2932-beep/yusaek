import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest

from services.client_cancel_soldout_utils import (
    build_soldout_message,
    filter_matching_order_items,
    group_items_by_order_sno,
    search_cost_base_products,
)


def _write_cost_base(path: Path):
    conn = sqlite3.connect(str(path))
    conn.execute(
        "CREATE TABLE wonbe (상품코드 TEXT, 상품명 TEXT, 색상 TEXT, 사이즈 TEXT, 거래처 TEXT, "
        "거래처상품명 TEXT, 옵션번호 TEXT)"
    )
    conn.executemany(
        "INSERT INTO wonbe (상품코드, 상품명, 색상, 사이즈, 거래처, 거래처상품명, 옵션번호) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
            ("S10456", "빈티지 흑청 스커트", "흑청", "S", "오즈브릿지", "273빈티지흑청스커트", "175252569"),
            ("S10457", "빈티지 흑청 스커트", "흑청", "M", "오즈브릿지", "273빈티지흑청스커트", "175252570"),
            ("S12369", "노에 린넨 셔츠", "그레이", "free", "스크램블", "라온카라티", "362752600"),
        ],
    )
    conn.commit()
    conn.close()


def test_search_cost_base_products_groups_by_name(tmp_path):
    path = tmp_path / "cost_base.db"
    _write_cost_base(path)

    results = search_cost_base_products(path, "빈티지 흑청 스커트")

    assert results == [
        {
            "name": "빈티지 흑청 스커트",
            "options": [
                {"code": "175252569", "label": "흑청/S", "product_id": "S10456"},
                {"code": "175252570", "label": "흑청/M", "product_id": "S10457"},
            ],
        }
    ]


def test_search_cost_base_products_matches_supplier_name(tmp_path):
    path = tmp_path / "cost_base.db"
    _write_cost_base(path)

    results = search_cost_base_products(path, "273빈티지흑청스커트")

    assert results == [
        {
            "name": "빈티지 흑청 스커트",
            "options": [
                {"code": "175252569", "label": "흑청/S", "product_id": "S10456"},
                {"code": "175252570", "label": "흑청/M", "product_id": "S10457"},
            ],
        }
    ]


def test_search_cost_base_products_no_match_returns_empty(tmp_path):
    path = tmp_path / "cost_base.db"
    _write_cost_base(path)

    assert search_cost_base_products(path, "존재하지않는상품") == []


def test_search_cost_base_products_missing_file_returns_empty(tmp_path):
    assert search_cost_base_products(tmp_path / "missing.db", "아무거나") == []


def test_search_cost_base_products_respects_limit(tmp_path):
    path = tmp_path / "cost_base.db"
    _write_cost_base(path)

    results = search_cost_base_products(path, "", limit=1)

    assert len(results) == 1


def test_filter_matching_order_items_keeps_only_matching_option_codes():
    items = [
        {"sno": 1, "option_stock_sync_code": "175252569"},
        {"sno": 2, "option_stock_sync_code": "999999999"},
        {"sno": 3, "option_stock_sync_code": "175252570"},
    ]

    matched = filter_matching_order_items(items, {"175252569", "175252570"})

    assert [item["sno"] for item in matched] == [1, 3]


def test_filter_matching_order_items_ignores_missing_code():
    items = [{"sno": 1}]

    assert filter_matching_order_items(items, {"175252569"}) == []


def test_group_items_by_order_sno_groups_correctly():
    items = [
        {"sno": 1, "order_sno": 100},
        {"sno": 2, "order_sno": 100},
        {"sno": 3, "order_sno": 200},
    ]

    grouped = group_items_by_order_sno(items)

    assert grouped == {
        100: [{"sno": 1, "order_sno": 100}, {"sno": 2, "order_sno": 100}],
        200: [{"sno": 3, "order_sno": 200}],
    }


def test_build_soldout_message_replaces_single_product():
    msg = build_soldout_message("주문해주신 '{상품}' 이 품절되었습니다.", ["빈티지 흑청 스커트 흑청 S"])

    assert msg == "주문해주신 '빈티지 흑청 스커트 흑청 S' 이 품절되었습니다."


def test_build_soldout_message_joins_multiple_products_with_comma():
    msg = build_soldout_message("주문해주신 '{상품}' 이 품절되었습니다.",
                                 ["상품A", "상품B", "상품A"])

    assert msg == "주문해주신 '상품A, 상품B' 이 품절되었습니다."
