import asyncio
import sys
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import httpx

from sdk.ably import AblyClient


def test_search_order_items_by_goods_name_paginates_until_max_page():
    client = AblyClient()
    page1 = httpx.Response(
        200,
        json={
            "order_items": [{"sno": 1, "order_sno": 100, "option_stock_sync_code": "175252569"}],
            "max_page_number": 2,
        },
        request=httpx.Request("GET", "https://api.a-bly.com/seller/order_items/"),
    )
    page2 = httpx.Response(
        200,
        json={
            "order_items": [{"sno": 2, "order_sno": 200, "option_stock_sync_code": "175252570"}],
            "max_page_number": 2,
        },
        request=httpx.Request("GET", "https://api.a-bly.com/seller/order_items/"),
    )
    with patch.object(client, "request", new=AsyncMock(side_effect=[page1, page2])) as mock_request:
        items = asyncio.run(client.search_order_items_by_goods_name("빈티지 흑청 스커트"))

    assert [item["sno"] for item in items] == [1, 2]
    assert mock_request.call_count == 2
    first_call_kwargs = mock_request.call_args_list[0].kwargs
    assert first_call_kwargs["origin"] == "my.a-bly.com"
    assert first_call_kwargs["params"]["keyword"] == "빈티지 흑청 스커트"
    assert first_call_kwargs["params"]["keyword_type"] == "goods_name"
    assert first_call_kwargs["params"]["processing_status[]"] == 2


def test_search_order_items_by_goods_name_stops_on_empty_page():
    client = AblyClient()
    empty_page = httpx.Response(
        200,
        json={"order_items": [], "max_page_number": 5},
        request=httpx.Request("GET", "https://api.a-bly.com/seller/order_items/"),
    )
    with patch.object(client, "request", new=AsyncMock(return_value=empty_page)) as mock_request:
        items = asyncio.run(client.search_order_items_by_goods_name("없는상품"))

    assert items == []
    assert mock_request.call_count == 1


def test_get_order_refund_info_extracts_fields():
    client = AblyClient()
    response = httpx.Response(
        200,
        json={
            "order": {
                "sno": 1784397062398,
                "refund_bank": {"sno": 23, "name": "토스뱅크"},
                "refund_bank_account_holder": "김도희",
                "refund_bank_account_number": "190869094396",
                "buyer_tel": "010-9895-3722",
                "buyer_name": "김도희",
            },
            "order_items": [],
        },
        request=httpx.Request("GET", "https://api.a-bly.com/seller/orders/1784397062398/items/"),
    )
    with patch.object(client, "request", new=AsyncMock(return_value=response)) as mock_request:
        info = asyncio.run(client.get_order_refund_info(1784397062398))

    assert info == {
        "refund_bank_sno": 23,
        "refund_bank_account_holder": "김도희",
        "refund_bank_account_number": "190869094396",
        "buyer_tel": "010-9895-3722",
        "buyer_name": "김도희",
    }
    call_kwargs = mock_request.call_args.kwargs
    assert call_kwargs["origin"] == "my.a-bly.com"
    assert call_kwargs["params"]["processing_status[]"] == [1, 2]


def test_cancel_order_items_sends_expected_payload_and_returns_response():
    client = AblyClient()
    response = httpx.Response(
        200,
        json={
            "need_to_be_soldout_goods_list": [],
            "need_to_be_non_display_option_list": [
                {"sno": 636699893, "goods_sno": 48480185, "goods_option_sno": 374652350,
                 "order_sno": 1784397062398, "goods_name": "마블 블라우스", "option_info": "베이지/free"}
            ],
        },
        request=httpx.Request("POST", "https://api.a-bly.com/seller/order_items/receive_cancel/"),
    )
    with patch.object(client, "request", new=AsyncMock(return_value=response)) as mock_request:
        result = asyncio.run(client.cancel_order_items(
            1784397062398, [636699893],
            refund_bank_account_holder="김도희",
            refund_bank_account_number="190869094396",
            refund_bank_sno=23,
        ))

    assert result["need_to_be_non_display_option_list"][0]["goods_option_sno"] == 374652350
    call_kwargs = mock_request.call_args.kwargs
    assert call_kwargs["origin"] == "my.a-bly.com"
    assert call_kwargs["json"] == {
        "order_sno": 1784397062398,
        "cancel_reason": 2,
        "cancel_type": "cancel",
        "sno_list": [636699893],
        "refund_bank_account_holder": "김도희",
        "refund_bank_account_number": "190869094396",
        "refund_bank_sno": 23,
    }


def test_stop_selling_sends_expected_payload():
    client = AblyClient()
    response = httpx.Response(
        200, text="",
        request=httpx.Request("POST", "https://api.a-bly.com/seller/goods/stop-selling/"),
    )
    with patch.object(client, "request", new=AsyncMock(return_value=response)) as mock_request:
        asyncio.run(client.stop_selling(non_display_option_snos=[374652350], soldout_goods_snos=[]))

    call_kwargs = mock_request.call_args.kwargs
    assert call_kwargs["origin"] == "my.a-bly.com"
    assert call_kwargs["json"] == {
        "need_to_be_non_display_option_sno_list": [374652350],
        "need_to_be_soldout_goods_sno_list": [],
    }
