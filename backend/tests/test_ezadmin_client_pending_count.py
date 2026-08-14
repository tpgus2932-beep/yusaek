import asyncio
import sys
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest

from sdk.ezadmin import EzAdminClient


def _client():
    return EzAdminClient(get_setting=lambda key: "dummy-session")


def test_get_pending_order_count_parses_before_trans_anchor_text():
    client = _client()
    response = {
        "rows": [{
            "id": 0,
            "cell": {
                "product_id": "<a href=javascript:view_product('S13438')>S13438  </a>",
                "before_trans": "<a class=nonzero_color href=\"javascript:orders_detail('S13438',1,0,56)\">56</a>",
            },
        }],
        "page": "1", "total": 1, "records": 1,
    }
    with patch.object(client, "post", new=AsyncMock(return_value=response)) as mock_post:
        count = asyncio.run(client.get_pending_order_count("S13438"))

    assert count == 56
    call_args = mock_post.call_args
    assert call_args.args == ("I100", "search")
    assert call_args.kwargs["time_flag"] is None
    assert "query_type=product_id" in call_args.kwargs["par"]
    assert "query_str=S13438" in call_args.kwargs["par"]


def test_get_pending_order_count_zero_when_before_trans_is_zero():
    client = _client()
    response = {
        "rows": [{"cell": {"before_trans": "<a class=zero_color href=\"javascript:orders_detail('S13438',1,0,0)\">0</a>"}}],
    }
    with patch.object(client, "post", new=AsyncMock(return_value=response)):
        count = asyncio.run(client.get_pending_order_count("S13438"))

    assert count == 0


def test_get_pending_order_count_raises_when_product_not_found():
    client = _client()
    with patch.object(client, "post", new=AsyncMock(return_value={"rows": []})):
        with pytest.raises(ValueError):
            asyncio.run(client.get_pending_order_count("NOTFOUND"))
