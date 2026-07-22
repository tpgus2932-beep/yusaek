# 거래처 > 품절취소 탭 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** "거래처 > 품절취소" 탭에서 상품명으로 원가베이스유를 검색해 추가하고 "실행"을 누르면,
해당 옵션(색상/사이즈)의 미발송 주문 전체를 에이블리에서 취소 + 미진열 처리하고, 취소된
주문의 구매자에게 EZDesk로 품절문자를 자동 발송한다.

**Architecture:** 신규 FastAPI 라우터(`backend/api/client_cancel_soldout_routes.py`)가
`AblyClient`(신규 메서드 4개 추가)로 주문 검색→취소→미진열 배치처리를 수행하고,
`EzAdminClient.send_sms`로 EZDesk 품절문자를 발송한다. 원가베이스 엑셀 파싱·매칭 로직은
`backend/services/client_cancel_soldout_utils.py`의 순수 함수로 분리해 단위 테스트한다.
프론트는 `ClientCancelSoldOutPage.jsx`의 기존 placeholder를 실제 UI로 교체한다.

**Tech Stack:** FastAPI, httpx(AblyClient), sqlite3(sms_templates 조회), openpyxl(원가베이스 엑셀),
React(프론트), pytest + TestClient + unittest.mock(AsyncMock)

## Global Constraints

- 신규 에이블리 API 호출은 전부 `origin="my.a-bly.com"` (HAR 캡처로 확인됨)
- 취소 사유는 `cancel_reason: 2` (품절) 고정
- 품절문자는 Aligo 기반 `/sms` 라우터가 아니라 **EZDesk A100** (`EzAdminClient.send_sms`)로 발송
- 품절문자 템플릿은 `sms_templates` 테이블의 `name='품절 문자'` 행, 플레이스홀더는 `{상품}`
  (여러 상품이면 쉼표로 나열, 이번 세션에서 이미 DB에 반영 완료)
- 미진열/품절 반영(`stop-selling`)은 모든 주문 취소가 끝난 뒤 **한 번만** 배치 호출
- 원가베이스유 매칭 기준은 상품명이 아니라 **옵션번호**(엑셀 11번째 열, 0-index 10)이며
  이는 에이블리 `option_stock_sync_code`와 동일한 값
- 부분 실패는 전체 실행을 막지 않는다 (실패 건은 결과에 기록하고 계속 진행)
- 프론트는 `LOCAL_API_BASE` 사용 (`COLLAB_API_BASE` 아님), 인증은 `get_current_user`
  (관리자 전용 아님)

---

## File Structure

- **Create** `backend/services/client_cancel_soldout_utils.py` — 원가베이스 엑셀 검색,
  주문상품 매칭/그룹핑, 문자 메시지 조립 (순수 함수, DB/네트워크 없음)
- **Create** `backend/tests/test_client_cancel_soldout_utils.py`
- **Modify** `backend/sdk/ably.py` — `AblyClient`에 메서드 4개 추가
- **Create** `backend/tests/test_ably_client_cancel_soldout.py`
- **Create** `backend/api/client_cancel_soldout_routes.py` — 라우터(`cost-base/search`, `run`)
- **Create** `backend/tests/test_client_cancel_soldout_routes.py`
- **Modify** `backend/main.py` — 신규 라우터 등록
- **Modify** `src/components/ClientSchedule/ClientCancelSoldOutPage.jsx` — placeholder → 실제 UI
- **Modify** `src/components/ClientSchedule/ClientCancelSoldOutPage.module.css` — 스타일 추가

---

### Task 1: 원가베이스 검색/매칭 유틸 함수

**Files:**
- Create: `backend/services/client_cancel_soldout_utils.py`
- Test: `backend/tests/test_client_cancel_soldout_utils.py`

**Interfaces:**
- Produces:
  - `search_cost_base_products(path: Path, q: str, limit: int = 20) -> list[dict]`
    → `[{"name": str, "option_codes": list[str]}, ...]`
  - `filter_matching_order_items(order_items: list[dict], option_codes: set[str]) -> list[dict]`
  - `group_items_by_order_sno(items: list[dict]) -> dict[int, list[dict]]`
  - `build_soldout_message(template_msg: str, product_names: list[str]) -> str`

- [ ] **Step 1: Write the failing tests**

`backend/tests/test_client_cancel_soldout_utils.py`:

```python
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import openpyxl
import pytest

from services.client_cancel_soldout_utils import (
    build_soldout_message,
    filter_matching_order_items,
    group_items_by_order_sno,
    search_cost_base_products,
)


def _write_cost_base(path: Path):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(["상품코드", "상품명", "색상", "사이즈", "원가", "거래처", "거래처상품명",
               "거래처합", "상품명합", "거래처주소", "옵션번호"])
    ws.append(["S10456", "빈티지 흑청 스커트", "흑청", "S", "10000", "오즈브릿지",
               "273빈티지흑청스커트", "273빈티지흑청스커트 흑청 S",
               "빈티지 흑청 스커트 흑청 S", "디오트 1층 C 9호", "175252569"])
    ws.append(["S10457", "빈티지 흑청 스커트", "흑청", "M", "10000", "오즈브릿지",
               "273빈티지흑청스커트", "273빈티지흑청스커트 흑청 M",
               "빈티지 흑청 스커트 흑청 M", "디오트 1층 C 9호", "175252570"])
    ws.append(["S12369", "노에 린넨 셔츠", "그레이", "free", "10000", "스크램블",
               "라온카라티", "라온카라티 그레이 free",
               "노에 린넨 셔츠 그레이 free", "누존 B1층 621호", "362752600"])
    wb.save(path)


def test_search_cost_base_products_groups_by_name(tmp_path):
    path = tmp_path / "cost_base.xlsx"
    _write_cost_base(path)

    results = search_cost_base_products(path, "빈티지 흑청 스커트")

    assert results == [
        {"name": "빈티지 흑청 스커트", "option_codes": ["175252569", "175252570"]}
    ]


def test_search_cost_base_products_no_match_returns_empty(tmp_path):
    path = tmp_path / "cost_base.xlsx"
    _write_cost_base(path)

    assert search_cost_base_products(path, "존재하지않는상품") == []


def test_search_cost_base_products_missing_file_returns_empty(tmp_path):
    assert search_cost_base_products(tmp_path / "missing.xlsx", "아무거나") == []


def test_search_cost_base_products_respects_limit(tmp_path):
    path = tmp_path / "cost_base.xlsx"
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_client_cancel_soldout_utils.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'services.client_cancel_soldout_utils'`

- [ ] **Step 3: Write the implementation**

`backend/services/client_cancel_soldout_utils.py`:

```python
from __future__ import annotations

from pathlib import Path

from openpyxl import load_workbook

# 원가베이스유.xlsx 열 인덱스 (0-based) — 헤더:
# 상품코드, 상품명, 색상, 사이즈, 원가, 거래처, 거래처상품명, 거래처합, 상품명합, 거래처주소, 옵션번호
_NAME_COL = 1
_OPTION_CODE_COL = 10
_REQUIRED_COLS = _OPTION_CODE_COL + 1


def search_cost_base_products(path: Path, q: str, limit: int = 20) -> list[dict]:
    """원가베이스유 엑셀에서 상품명(1열) 기준으로 검색해 옵션번호(11열)를 묶어 반환.

    같은 상품명의 색상/사이즈별 행들을 하나의 항목으로 묶고, 그 항목의
    option_codes에 모든 옵션번호를 순서대로 모은다.
    """
    if not path.exists():
        return []

    q_norm = (q or "").strip().lower()
    wb = load_workbook(path, data_only=True, read_only=True)
    ws = wb.active

    groups: dict[str, list[str]] = {}
    order: list[str] = []
    for row in ws.iter_rows(min_row=2, values_only=True):
        if len(row) < _REQUIRED_COLS:
            continue
        name = str(row[_NAME_COL] or "").strip()
        option_code = str(row[_OPTION_CODE_COL] or "").strip()
        if not name or not option_code:
            continue
        if q_norm and q_norm not in name.lower():
            continue
        if name not in groups:
            groups[name] = []
            order.append(name)
        if option_code not in groups[name]:
            groups[name].append(option_code)

    return [{"name": name, "option_codes": groups[name]} for name in order[:limit]]


def filter_matching_order_items(order_items: list[dict], option_codes: set[str]) -> list[dict]:
    """order_items 중 option_stock_sync_code가 option_codes에 속하는 것만 남긴다."""
    return [
        item for item in order_items
        if str(item.get("option_stock_sync_code") or "") in option_codes
    ]


def group_items_by_order_sno(items: list[dict]) -> dict[int, list[dict]]:
    """주문상품 리스트를 order_sno 기준으로 그룹핑 (취소 API가 주문당 1회 호출이라 필요)."""
    grouped: dict[int, list[dict]] = {}
    for item in items:
        grouped.setdefault(item["order_sno"], []).append(item)
    return grouped


def build_soldout_message(template_msg: str, product_names: list[str]) -> str:
    """템플릿의 {상품}을 실제 상품명으로 치환. 중복 상품명은 제거하고 쉼표로 나열."""
    unique_names = list(dict.fromkeys(product_names))
    return template_msg.replace("{상품}", ", ".join(unique_names))
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_client_cancel_soldout_utils.py -v`
Expected: PASS (10 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/services/client_cancel_soldout_utils.py backend/tests/test_client_cancel_soldout_utils.py
git commit -m "feat: add cost-base search/matching utils for client cancel-soldout"
```

---

### Task 2: AblyClient 신규 메서드 4개

**Files:**
- Modify: `backend/sdk/ably.py`
- Test: `backend/tests/test_ably_client_cancel_soldout.py`

**Interfaces:**
- Consumes: `AblyClient.request(method, path, *, json=None, params=None, origin=..., timeout=None) -> httpx.Response` (기존 메서드, `backend/sdk/ably.py:26`)
- Produces:
  - `AblyClient.search_order_items_by_goods_name(keyword: str, *, per_page: int = 100) -> list[dict]`
  - `AblyClient.get_order_refund_info(order_sno: int | str) -> dict` →
    `{"refund_bank_sno", "refund_bank_account_holder", "refund_bank_account_number", "buyer_tel"}`
  - `AblyClient.cancel_order_items(order_sno, sno_list, *, refund_bank_account_holder, refund_bank_account_number, refund_bank_sno, cancel_reason=2) -> dict`
  - `AblyClient.stop_selling(*, non_display_option_snos: list[int], soldout_goods_snos: list[int]) -> None`

- [ ] **Step 1: Write the failing tests**

`backend/tests/test_ably_client_cancel_soldout.py`:

```python
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_ably_client_cancel_soldout.py -v`
Expected: FAIL with `AttributeError: 'AblyClient' object has no attribute 'search_order_items_by_goods_name'`

- [ ] **Step 3: Add the four methods to `AblyClient`**

Add to `backend/sdk/ably.py`, after the existing `reject_order_cancel` method (before `def set_token`):

```python
    async def search_order_items_by_goods_name(self, keyword: str, *, per_page: int = 100) -> list[dict]:
        """상품명으로 미발송(processing_status=2) 주문상품 전체 페이지 조회.

        keyword_type을 goods_name으로 고정하면 에이블리가 내부 goods_name
        필드에 대해 부분일치 검색을 해준다 (앞의 태그/이모지 접두사가
        붙어 있어도 매칭됨 - 실제 브라우저 캡처로 확인).
        """
        all_items: list[dict] = []
        page = 1
        while True:
            response = await self.request(
                "GET", "/seller/order_items/",
                params={
                    "order": "-checked_at",
                    "delivery_type[]": ["standard", "today", "combine", "reserved"],
                    "processing_status[]": 2,
                    "processing_sub_status[]": 0,
                    "page": page,
                    "per_page": per_page,
                    "keyword": keyword,
                    "keyword_type": "goods_name",
                },
                origin="my.a-bly.com",
            )
            response.raise_for_status()
            data = response.json()
            items = data.get("order_items") or []
            if not items:
                break
            all_items.extend(items)
            if page >= data.get("max_page_number", 1):
                break
            page += 1
        return all_items

    async def get_order_refund_info(self, order_sno: int | str) -> dict:
        """주문 상세에서 환불계좌 정보와 구매자 연락처를 가져온다.

        receive_cancel 호출에 필요한 refund_bank_account_holder/number/sno와
        품절문자 발송용 buyer_tel을 한 번에 담고 있다 (실제 캡처로 확인).
        """
        response = await self.request(
            "GET", f"/seller/orders/{order_sno}/items/",
            params={"processing_status[]": [1, 2], "processing_sub_status[]": 0},
            origin="my.a-bly.com",
        )
        response.raise_for_status()
        order = response.json().get("order") or {}
        refund_bank = order.get("refund_bank") or {}
        return {
            "refund_bank_sno": refund_bank.get("sno"),
            "refund_bank_account_holder": order.get("refund_bank_account_holder"),
            "refund_bank_account_number": order.get("refund_bank_account_number"),
            "buyer_tel": order.get("buyer_tel"),
        }

    async def cancel_order_items(
        self,
        order_sno: int | str,
        sno_list: list[int],
        *,
        refund_bank_account_holder: str,
        refund_bank_account_number: str,
        refund_bank_sno: int,
        cancel_reason: int = 2,
    ) -> dict:
        """주문상품 취소. cancel_reason=2는 품절 사유 (실제 캡처로 확인).

        성공 시 이후 미진열/품절 처리해야 할 옵션·상품 목록을
        {need_to_be_non_display_option_list, need_to_be_soldout_goods_list}로
        돌려준다 - stop_selling() 호출에 그대로 사용.
        """
        response = await self.request(
            "POST", "/seller/order_items/receive_cancel/",
            json={
                "order_sno": order_sno,
                "cancel_reason": cancel_reason,
                "cancel_type": "cancel",
                "sno_list": sno_list,
                "refund_bank_account_holder": refund_bank_account_holder,
                "refund_bank_account_number": refund_bank_account_number,
                "refund_bank_sno": refund_bank_sno,
            },
            origin="my.a-bly.com",
        )
        response.raise_for_status()
        return response.json()

    async def stop_selling(self, *, non_display_option_snos: list[int], soldout_goods_snos: list[int]) -> None:
        """옵션 단위 미진열/상품 단위 품절을 일괄 반영. 응답 바디는 비어있다(실제 캡처로 확인)."""
        response = await self.request(
            "POST", "/seller/goods/stop-selling/",
            json={
                "need_to_be_non_display_option_sno_list": non_display_option_snos,
                "need_to_be_soldout_goods_sno_list": soldout_goods_snos,
            },
            origin="my.a-bly.com",
        )
        response.raise_for_status()
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_ably_client_cancel_soldout.py -v`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/sdk/ably.py backend/tests/test_ably_client_cancel_soldout.py
git commit -m "feat: add order search/cancel/stop-selling methods to AblyClient"
```

---

### Task 3: 백엔드 라우터 (`client_cancel_soldout_routes.py`)

**Files:**
- Create: `backend/api/client_cancel_soldout_routes.py`
- Test: `backend/tests/test_client_cancel_soldout_routes.py`
- Modify: `backend/main.py`

**Interfaces:**
- Consumes:
  - `search_cost_base_products`, `filter_matching_order_items`, `group_items_by_order_sno`,
    `build_soldout_message` from `services.client_cancel_soldout_utils` (Task 1)
  - `AblyClient.search_order_items_by_goods_name/get_order_refund_info/cancel_order_items/stop_selling`
    from `sdk.ably` (Task 2)
  - `EzAdminClient.send_sms(receiver, sender, msg) -> dict`, `EzDeskSessionExpired` from
    `sdk.ezadmin` (existing, `backend/sdk/ezadmin.py:107,345,98`)
  - `sdk.config.EZDESK_SMS_SENDER` (existing, `"15339827"`)
- Produces:
  - `build_client_cancel_soldout_router(*, get_current_user, get_setting, get_db, cost_base_path: Path) -> APIRouter`
    prefix `/client-cancel-soldout`
  - `GET /client-cancel-soldout/cost-base/search?q=&limit=` → `{"ok": true, "items": [...]}`
  - `POST /client-cancel-soldout/run` body `{"products": [{"name": str, "option_codes": [str]}]}`
    → 응답 형태는 아래 Step 3 참고

- [ ] **Step 1: Write the failing tests**

`backend/tests/test_client_cancel_soldout_routes.py`:

```python
import sqlite3
import sys
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import openpyxl
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.client_cancel_soldout_routes import build_client_cancel_soldout_router
from sdk.ezadmin import EzDeskSessionExpired


def _make_db_factory():
    uri = f"file:test_client_cancel_soldout_{uuid.uuid4().hex}?mode=memory&cache=shared"
    keep_alive = sqlite3.connect(uri, uri=True)
    keep_alive.row_factory = sqlite3.Row
    keep_alive.execute(
        "CREATE TABLE sms_templates (id TEXT PRIMARY KEY, name TEXT, msg TEXT, title TEXT, msg_type TEXT, sort_order INTEGER)"
    )
    keep_alive.commit()

    def factory():
        conn = sqlite3.connect(uri, uri=True)
        conn.row_factory = sqlite3.Row
        return conn

    return factory, keep_alive


def _make_client(cost_base_path: Path):
    get_db, keep_alive = _make_db_factory()
    keep_alive.execute(
        "INSERT INTO sms_templates (id, name, msg, title, msg_type, sort_order) VALUES (?, ?, ?, '', '', 0)",
        ("1", "품절 문자", "주문해주신 '{상품}' 이 품절되었습니다."),
    )
    keep_alive.commit()

    app = FastAPI()
    app.include_router(
        build_client_cancel_soldout_router(
            get_current_user=lambda: "tester",
            get_setting=lambda key: None,
            get_db=get_db,
            cost_base_path=cost_base_path,
        )
    )
    return TestClient(app), get_db, keep_alive


def _write_cost_base(path: Path):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(["상품코드", "상품명", "색상", "사이즈", "원가", "거래처", "거래처상품명",
               "거래처합", "상품명합", "거래처주소", "옵션번호"])
    ws.append(["S10456", "빈티지 흑청 스커트", "흑청", "S", "10000", "오즈브릿지",
               "273빈티지흑청스커트", "273빈티지흑청스커트 흑청 S",
               "빈티지 흑청 스커트 흑청 S", "디오트 1층 C 9호", "175252569"])
    wb.save(path)


def test_cost_base_search_returns_grouped_items(tmp_path):
    cost_base_path = tmp_path / "cost_base.xlsx"
    _write_cost_base(cost_base_path)
    client, _get_db, _keep_alive = _make_client(cost_base_path)

    res = client.get("/client-cancel-soldout/cost-base/search", params={"q": "빈티지"})

    assert res.status_code == 200
    assert res.json() == {
        "ok": True,
        "items": [{"name": "빈티지 흑청 스커트", "option_codes": ["175252569"]}],
    }


def test_run_without_products_returns_400(tmp_path):
    client, _get_db, _keep_alive = _make_client(tmp_path / "missing.xlsx")

    res = client.post("/client-cancel-soldout/run", json={"products": []})

    assert res.status_code == 400


def test_run_missing_template_returns_400(tmp_path):
    get_db, keep_alive = _make_db_factory()  # sms_templates 비어있음
    app = FastAPI()
    app.include_router(
        build_client_cancel_soldout_router(
            get_current_user=lambda: "tester",
            get_setting=lambda key: None,
            get_db=get_db,
            cost_base_path=tmp_path / "missing.xlsx",
        )
    )
    client = TestClient(app)

    res = client.post("/client-cancel-soldout/run", json={
        "products": [{"name": "빈티지 흑청 스커트", "option_codes": ["175252569"]}]
    })

    assert res.status_code == 400
    assert "품절 문자" in res.json()["detail"]


def test_run_cancels_matching_order_and_sends_sms(tmp_path):
    client, _get_db, _keep_alive = _make_client(tmp_path / "missing.xlsx")

    search_result = [{
        "sno": 636699893, "order_sno": 1784397062398,
        "option_stock_sync_code": "175252569", "goods_name": "빈티지 흑청 스커트",
    }]
    refund_info = {
        "refund_bank_sno": 23, "refund_bank_account_holder": "김도희",
        "refund_bank_account_number": "190869094396", "buyer_tel": "010-9895-3722",
    }
    cancel_result = {
        "need_to_be_soldout_goods_list": [],
        "need_to_be_non_display_option_list": [
            {"sno": 636699893, "goods_sno": 48480185, "goods_option_sno": 374652350,
             "order_sno": 1784397062398, "goods_name": "빈티지 흑청 스커트", "option_info": "흑청/S"}
        ],
    }

    with patch(
        "api.client_cancel_soldout_routes.AblyClient.search_order_items_by_goods_name",
        new=AsyncMock(return_value=search_result),
    ), patch(
        "api.client_cancel_soldout_routes.AblyClient.get_order_refund_info",
        new=AsyncMock(return_value=refund_info),
    ), patch(
        "api.client_cancel_soldout_routes.AblyClient.cancel_order_items",
        new=AsyncMock(return_value=cancel_result),
    ), patch(
        "api.client_cancel_soldout_routes.AblyClient.stop_selling",
        new=AsyncMock(return_value=None),
    ) as mock_stop_selling, patch(
        "api.client_cancel_soldout_routes.EzAdminClient.send_sms",
        new=AsyncMock(return_value={"ok": True}),
    ) as mock_send_sms:
        res = client.post("/client-cancel-soldout/run", json={
            "products": [{"name": "빈티지 흑청 스커트", "option_codes": ["175252569"]}]
        })

    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is True
    assert data["cancelled_orders"] == [{
        "order_sno": 1784397062398, "buyer_tel": "010-9895-3722",
        "product_names": ["빈티지 흑청 스커트"], "sms_sent": True,
    }]
    assert data["failed_orders"] == []
    assert data["non_display_option_count"] == 1
    assert data["soldout_goods_count"] == 0
    assert data["need_ezdesk_session"] is False

    mock_stop_selling.assert_awaited_once_with(
        non_display_option_snos=[374652350], soldout_goods_snos=[]
    )
    mock_send_sms.assert_awaited_once_with(
        "010-9895-3722", "15339827", "주문해주신 '빈티지 흑청 스커트' 이 품절되었습니다."
    )


def test_run_records_ezdesk_session_expired_but_keeps_cancel_result(tmp_path):
    client, _get_db, _keep_alive = _make_client(tmp_path / "missing.xlsx")

    search_result = [{
        "sno": 636699893, "order_sno": 1784397062398,
        "option_stock_sync_code": "175252569", "goods_name": "빈티지 흑청 스커트",
    }]
    refund_info = {
        "refund_bank_sno": 23, "refund_bank_account_holder": "김도희",
        "refund_bank_account_number": "190869094396", "buyer_tel": "010-9895-3722",
    }
    cancel_result = {"need_to_be_soldout_goods_list": [], "need_to_be_non_display_option_list": []}

    with patch(
        "api.client_cancel_soldout_routes.AblyClient.search_order_items_by_goods_name",
        new=AsyncMock(return_value=search_result),
    ), patch(
        "api.client_cancel_soldout_routes.AblyClient.get_order_refund_info",
        new=AsyncMock(return_value=refund_info),
    ), patch(
        "api.client_cancel_soldout_routes.AblyClient.cancel_order_items",
        new=AsyncMock(return_value=cancel_result),
    ), patch(
        "api.client_cancel_soldout_routes.EzAdminClient.send_sms",
        new=AsyncMock(side_effect=EzDeskSessionExpired()),
    ):
        res = client.post("/client-cancel-soldout/run", json={
            "products": [{"name": "빈티지 흑청 스커트", "option_codes": ["175252569"]}]
        })

    data = res.json()
    assert data["need_ezdesk_session"] is True
    assert data["cancelled_orders"][0]["sms_sent"] is False


def test_run_records_cancel_failure_and_continues(tmp_path):
    client, _get_db, _keep_alive = _make_client(tmp_path / "missing.xlsx")

    search_result = [{
        "sno": 636699893, "order_sno": 1784397062398,
        "option_stock_sync_code": "175252569", "goods_name": "빈티지 흑청 스커트",
    }]
    refund_info = {
        "refund_bank_sno": 23, "refund_bank_account_holder": "김도희",
        "refund_bank_account_number": "190869094396", "buyer_tel": "010-9895-3722",
    }

    with patch(
        "api.client_cancel_soldout_routes.AblyClient.search_order_items_by_goods_name",
        new=AsyncMock(return_value=search_result),
    ), patch(
        "api.client_cancel_soldout_routes.AblyClient.get_order_refund_info",
        new=AsyncMock(return_value=refund_info),
    ), patch(
        "api.client_cancel_soldout_routes.AblyClient.cancel_order_items",
        new=AsyncMock(side_effect=RuntimeError("cancel failed")),
    ):
        res = client.post("/client-cancel-soldout/run", json={
            "products": [{"name": "빈티지 흑청 스커트", "option_codes": ["175252569"]}]
        })

    data = res.json()
    assert data["cancelled_orders"] == []
    assert data["failed_orders"] == [
        {"order_sno": 1784397062398, "stage": "cancel", "reason": "cancel failed"}
    ]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_client_cancel_soldout_routes.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'api.client_cancel_soldout_routes'`

- [ ] **Step 3: Write the router**

`backend/api/client_cancel_soldout_routes.py`:

```python
from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Body, Depends, HTTPException

from sdk import config as ez_config
from sdk.ably import AblyClient
from sdk.ezadmin import EzAdminClient, EzDeskSessionExpired
from services.client_cancel_soldout_utils import (
    build_soldout_message,
    filter_matching_order_items,
    group_items_by_order_sno,
    search_cost_base_products,
)

_SOLDOUT_TEMPLATE_NAME = "품절 문자"


def build_client_cancel_soldout_router(*, get_current_user, get_setting, get_db, cost_base_path: Path):
    router = APIRouter(prefix="/client-cancel-soldout")

    def _load_soldout_template_msg() -> str | None:
        conn = get_db()
        try:
            row = conn.execute(
                "SELECT msg FROM sms_templates WHERE name = ?", (_SOLDOUT_TEMPLATE_NAME,)
            ).fetchone()
        finally:
            conn.close()
        return row["msg"] if row else None

    @router.get("/cost-base/search")
    def cost_base_search(q: str = "", limit: int = 20, user: str = Depends(get_current_user)):
        if limit <= 0 or limit > 100:
            limit = 20
        items = search_cost_base_products(cost_base_path, q, limit=limit)
        return {"ok": True, "items": items}

    @router.post("/run")
    async def run(payload: dict = Body(...), user: str = Depends(get_current_user)):
        products = payload.get("products") or []
        option_code_to_name: dict[str, str] = {}
        for product in products:
            name = str(product.get("name") or "").strip()
            if not name:
                continue
            for code in product.get("option_codes") or []:
                code = str(code).strip()
                if code:
                    option_code_to_name[code] = name
        if not option_code_to_name:
            raise HTTPException(status_code=400, detail="취소할 상품/옵션이 없습니다.")

        template_msg = _load_soldout_template_msg()
        if not template_msg:
            raise HTTPException(
                status_code=400,
                detail=f"'{_SOLDOUT_TEMPLATE_NAME}' 템플릿이 없습니다. SMS 탭에서 먼저 만들어주세요.",
            )

        ably = AblyClient()
        failed: list[dict] = []
        matched_items: list[dict] = []

        product_names = sorted({str(p.get("name") or "").strip() for p in products if p.get("name")})
        for name in product_names:
            try:
                items = await ably.search_order_items_by_goods_name(name)
            except Exception as exc:
                failed.append({"order_sno": None, "product_name": name, "stage": "search", "reason": str(exc)})
                continue
            matched_items.extend(filter_matching_order_items(items, set(option_code_to_name)))

        order_items_by_sno = group_items_by_order_sno(matched_items)

        cancelled: list[dict] = []
        non_display_snos: set[int] = set()
        soldout_snos: set[int] = set()

        for order_sno, items in order_items_by_sno.items():
            try:
                refund_info = await ably.get_order_refund_info(order_sno)
            except Exception as exc:
                failed.append({"order_sno": order_sno, "stage": "order_lookup", "reason": str(exc)})
                continue

            sno_list = [item["sno"] for item in items]
            try:
                cancel_res = await ably.cancel_order_items(
                    order_sno, sno_list,
                    refund_bank_account_holder=refund_info["refund_bank_account_holder"],
                    refund_bank_account_number=refund_info["refund_bank_account_number"],
                    refund_bank_sno=refund_info["refund_bank_sno"],
                )
            except Exception as exc:
                failed.append({"order_sno": order_sno, "stage": "cancel", "reason": str(exc)})
                continue

            for opt in cancel_res.get("need_to_be_non_display_option_list") or []:
                sno = opt.get("goods_option_sno")
                if sno is not None:
                    non_display_snos.add(sno)
            for goods in cancel_res.get("need_to_be_soldout_goods_list") or []:
                sno = goods.get("goods_sno")
                if sno is not None:
                    soldout_snos.add(sno)

            names = [
                option_code_to_name.get(str(item.get("option_stock_sync_code") or ""), item.get("goods_name", ""))
                for item in items
            ]
            cancelled.append({
                "order_sno": order_sno,
                "buyer_tel": refund_info.get("buyer_tel"),
                "product_names": names,
            })

        if non_display_snos or soldout_snos:
            try:
                await ably.stop_selling(
                    non_display_option_snos=list(non_display_snos),
                    soldout_goods_snos=list(soldout_snos),
                )
            except Exception as exc:
                for order in cancelled:
                    order.setdefault("warnings", []).append(f"미진열 반영 실패: {exc}")

        ez = EzAdminClient(get_setting)
        need_ezdesk_session = False
        for order in cancelled:
            phone = order.get("buyer_tel")
            if not phone:
                order["sms_sent"] = False
                order["sms_error"] = "구매자 연락처 없음"
                continue
            msg = build_soldout_message(template_msg, order["product_names"])
            try:
                await ez.send_sms(phone, ez_config.EZDESK_SMS_SENDER, msg)
                order["sms_sent"] = True
            except EzDeskSessionExpired:
                order["sms_sent"] = False
                need_ezdesk_session = True
            except Exception as exc:
                order["sms_sent"] = False
                order["sms_error"] = str(exc)

        return {
            "ok": True,
            "cancelled_orders": cancelled,
            "failed_orders": failed,
            "non_display_option_count": len(non_display_snos),
            "soldout_goods_count": len(soldout_snos),
            "need_ezdesk_session": need_ezdesk_session,
        }

    return router
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_client_cancel_soldout_routes.py -v`
Expected: PASS (6 tests)

- [ ] **Step 5: Register the router in `main.py`**

Add import near the other `api.*_routes` imports (`backend/main.py:60`, after the
`delivery_anomaly_routes` import):

```python
from api.client_cancel_soldout_routes import build_client_cancel_soldout_router
```

Add registration near the other Ably-touching router registrations
(`backend/main.py`, after the `ably_minus_router` `app.include_router(...)` block):

```python
app.include_router(
    build_client_cancel_soldout_router(
        get_current_user=_get_current_user,
        get_setting=_get_setting,
        get_db=_get_shared_db,
        cost_base_path=SHARED_COST_BASE_PATH,
    )
)
```

- [ ] **Step 6: Run the full backend test suite to check nothing broke**

Run: `cd backend && python -m pytest -q`
Expected: PASS, no failures introduced

- [ ] **Step 7: Start the backend and smoke-test the new endpoint**

Run: `cd backend && uvicorn main:app --reload --host 127.0.0.1 --port 8000` (leave running)

In another terminal:
```bash
curl "http://127.0.0.1:8000/client-cancel-soldout/cost-base/search?q=%EB%B9%88%ED%8B%B0%EC%A7%80" -H "Authorization: Bearer <실제 로그인 토큰>"
```
Expected: `{"ok": true, "items": [...]}` (실제 원가베이스유.xlsx에 해당 상품명이 있으면 결과가 나옴).
Stop the server after confirming.

- [ ] **Step 8: Commit**

```bash
git add backend/api/client_cancel_soldout_routes.py backend/tests/test_client_cancel_soldout_routes.py backend/main.py
git commit -m "feat: add client cancel-soldout router (cancel + stop-selling + soldout sms)"
```

---

### Task 4: 프론트엔드 UI

**Files:**
- Modify: `src/components/ClientSchedule/ClientCancelSoldOutPage.jsx`
- Modify: `src/components/ClientSchedule/ClientCancelSoldOutPage.module.css`

**Interfaces:**
- Consumes:
  - `GET {LOCAL_API_BASE}/client-cancel-soldout/cost-base/search?q=` → `{ok, items: [{name, option_codes}]}`
  - `POST {LOCAL_API_BASE}/client-cancel-soldout/run` body `{products: [{name, option_codes}]}` →
    `{ok, cancelled_orders: [{order_sno, buyer_tel, product_names, sms_sent, sms_error?, warnings?}], failed_orders: [{order_sno, product_name?, stage, reason}], non_display_option_count, soldout_goods_count, need_ezdesk_session}`
  - `LOCAL_API_BASE`, `getAuthHeaders`, `handleUnauthorized` from `../../lib/api` (existing, `src/lib/api.js`)

- [ ] **Step 1: Replace the placeholder component**

`src/components/ClientSchedule/ClientCancelSoldOutPage.jsx`:

```jsx
import React, { useState } from 'react';
import { LOCAL_API_BASE as API, getAuthHeaders, handleUnauthorized } from '../../lib/api';
import styles from './ClientCancelSoldOutPage.module.css';

const ClientCancelSoldOutPage = () => {
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [products, setProducts] = useState([]);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [runError, setRunError] = useState('');

  const handleSearch = async (e) => {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    setSearchError('');
    try {
      const res = await fetch(`${API}/client-cancel-soldout/cost-base/search?q=${encodeURIComponent(q)}`, {
        headers: getAuthHeaders(),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok === false) throw new Error(data?.detail || '검색에 실패했습니다.');
      setSearchResults(Array.isArray(data.items) ? data.items : []);
    } catch (err) {
      setSearchError(err.message || '검색에 실패했습니다.');
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  };

  const addProduct = (item) => {
    setProducts((prev) => {
      if (prev.some((p) => p.name === item.name)) return prev;
      return [...prev, item];
    });
  };

  const removeProduct = (name) => {
    setProducts((prev) => prev.filter((p) => p.name !== name));
  };

  const handleRun = async () => {
    if (products.length === 0) return;
    setRunning(true);
    setRunError('');
    setResult(null);
    try {
      const res = await fetch(`${API}/client-cancel-soldout/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ products }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok === false) throw new Error(data?.detail || '실행에 실패했습니다.');
      setResult(data);
      setProducts([]);
    } catch (err) {
      setRunError(err.message || '실행에 실패했습니다.');
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className={styles.page}>
      <form className={styles.searchRow} onSubmit={handleSearch}>
        <input
          className={styles.searchInput}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="상품명으로 원가베이스유 검색"
        />
        <button className={styles.searchBtn} type="submit" disabled={searching}>
          {searching ? '검색 중...' : '검색'}
        </button>
      </form>
      {searchError && <p className={styles.error}>{searchError}</p>}

      {searchResults.length > 0 && (
        <ul className={styles.resultList}>
          {searchResults.map((item) => (
            <li key={item.name} className={styles.resultItem}>
              <span>{item.name}</span>
              <span className={styles.optionCount}>옵션 {item.option_codes.length}개</span>
              <button type="button" className={styles.addBtn} onClick={() => addProduct(item)}>
                추가
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className={styles.section}>
        <h3 className={styles.sectionTitle}>취소 대상 상품</h3>
        {products.length === 0 ? (
          <p className={styles.placeholder}>추가된 상품이 없습니다.</p>
        ) : (
          <ul className={styles.productList}>
            {products.map((p) => (
              <li key={p.name} className={styles.productItem}>
                <span>{p.name}</span>
                <span className={styles.optionCount}>옵션 {p.option_codes.length}개</span>
                <button type="button" className={styles.removeBtn} onClick={() => removeProduct(p.name)}>
                  삭제
                </button>
              </li>
            ))}
          </ul>
        )}
        <button
          type="button"
          className={styles.runBtn}
          onClick={handleRun}
          disabled={running || products.length === 0}
        >
          {running ? '실행 중...' : '실행'}
        </button>
        {runError && <p className={styles.error}>{runError}</p>}
      </div>

      {result && (
        <div className={styles.section}>
          <h3 className={styles.sectionTitle}>실행 결과</h3>
          <p>
            취소된 주문 {result.cancelled_orders.length}건 / 실패 {result.failed_orders.length}건 /
            미진열 처리 {result.non_display_option_count}개 / 품절 처리 {result.soldout_goods_count}개
          </p>
          {result.need_ezdesk_session && (
            <p className={styles.error}>
              EZDesk 세션이 만료되었습니다. 문자 발송이 안 된 건이 있으니 세션을 다시 붙여넣고 재실행해주세요.
            </p>
          )}
          {result.cancelled_orders.length > 0 && (
            <ul className={styles.resultList}>
              {result.cancelled_orders.map((order) => (
                <li key={order.order_sno} className={styles.resultItem}>
                  <span>주문 {order.order_sno}</span>
                  <span>{order.product_names.join(', ')}</span>
                  <span>{order.sms_sent ? '문자 발송됨' : `문자 발송 실패${order.sms_error ? `: ${order.sms_error}` : ''}`}</span>
                </li>
              ))}
            </ul>
          )}
          {result.failed_orders.length > 0 && (
            <ul className={styles.resultList}>
              {result.failed_orders.map((fail, idx) => (
                <li key={idx} className={styles.resultItem}>
                  <span>{fail.product_name || fail.order_sno}</span>
                  <span>{fail.stage}</span>
                  <span>{fail.reason}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};

export default ClientCancelSoldOutPage;
```

- [ ] **Step 2: Update the stylesheet**

`src/components/ClientSchedule/ClientCancelSoldOutPage.module.css`:

```css
.page {
  padding: 1.5rem 2rem;
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

.searchRow {
  display: flex;
  gap: 0.5rem;
}

.searchInput {
  flex: 1;
  padding: 0.6rem 0.8rem;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-color);
  background: var(--bg-secondary);
  color: var(--text-primary);
  font-size: 0.95rem;
}

.searchBtn,
.addBtn,
.removeBtn,
.runBtn {
  padding: 0.5rem 1rem;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-color);
  background: var(--bg-secondary);
  color: var(--text-primary);
  cursor: pointer;
  font-size: 0.9rem;
}

.runBtn {
  background: var(--accent);
  color: #fff;
  border: none;
  font-weight: 600;
  align-self: flex-start;
}

.runBtn:disabled,
.searchBtn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.resultList,
.productList {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.resultItem,
.productItem {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  background: var(--bg-primary);
  font-size: 0.9rem;
}

.optionCount {
  color: var(--text-secondary);
  font-size: 0.85rem;
}

.section {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.sectionTitle {
  margin: 0;
  font-size: 1rem;
  font-weight: 700;
}

.placeholder {
  color: var(--text-secondary);
  font-size: 0.9rem;
}

.error {
  color: #dc3545;
  font-size: 0.9rem;
}
```

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: no errors in the two changed files

- [ ] **Step 4: Commit**

```bash
git add src/components/ClientSchedule/ClientCancelSoldOutPage.jsx src/components/ClientSchedule/ClientCancelSoldOutPage.module.css
git commit -m "feat: build client cancel-soldout UI (search, add, run, result report)"
```

---

### Task 5: 수동 통합 검증

**Files:** 없음 (검증 전용)

- [ ] **Step 1: 백엔드 + 프론트 동시 기동**

```bash
cd backend && uvicorn main:app --reload --host 127.0.0.1 --port 8000
```
새 터미널에서:
```bash
npm run dev
```

- [ ] **Step 2: 브라우저로 실제 흐름 1건 확인**

1. 사이드바 "거래처" > "품절취소" 탭 진입
2. 실제 미발송 주문이 있는 것으로 알고 있는 상품명으로 검색 → 결과에 옵션 개수가 뜨는지 확인
3. "추가" → 리스트에 상품이 뜨는지 확인
4. "실행" → 결과 리포트가 뜨는지 확인
5. 에이블리 셀러센터(`https://my.a-bly.com`)에서 실제로 해당 주문이 취소됐는지, 해당 옵션이
   미진열(비노출) 처리됐는지 직접 확인
6. 구매자 번호로 실제 품절문자가 발송됐는지 확인 (EZDesk 발신함 또는 수신 확인)

- [ ] **Step 3: 실패 케이스 확인**

EZDesk 세션을 일부러 만료시킨 상태(또는 세션 미설정 상태)에서 같은 흐름을 실행해
`need_ezdesk_session` 안내 문구가 뜨는지, 그리고 그 상태에서도 주문 취소·미진열
처리 자체는 정상적으로 끝나 있는지 (에이블리 셀러센터에서) 확인.

---

## Self-Review Notes

- **Spec coverage:** 설계 문서(`docs/superpowers/specs/2026-07-22-client-cancel-soldout-design.md`)의
  검색→매칭→취소→배치 미진열→문자발송 흐름, `cancel_reason:2`, `{상품}` 쉼표 조인, 부분 실패 허용,
  `need_ezdesk_session` 처리가 모두 Task 1~3에 반영됨. 프론트 `LOCAL_API_BASE`/`get_current_user`
  규칙은 Task 4에 반영됨.
- **알려진 미검증 항목:** `need_to_be_soldout_goods_list`의 항목 키가 `goods_sno`인지는
  HAR 캡처에서 해당 리스트가 항상 빈 배열이라 직접 확인하지 못했다 (문서상 `need_to_be_non_display_option_list`와
  대칭 구조로 추정). Task 3의 코드는 `.get("goods_sno")`로 안전하게 처리해 키가 없거나
  다르면 그냥 건너뛰도록 했으므로 최악의 경우에도 예외 없이 동작하지만, 실제로 "상품 전체
  품절" 케이스(같은 상품의 모든 옵션이 동시에 취소되는 경우)가 발생하면 Task 5 수동 검증
  단계에서 실제 응답을 한 번 로그로 찍어 확인해볼 것.
- **Placeholder scan:** TBD/TODO 없음. 모든 스텝에 실행 가능한 코드 포함.
- **Type consistency:** `search_cost_base_products`가 반환하는 `{"name", "option_codes"}` 형태가
  프론트 `products` 배열, 라우터의 `payload.get("products")` 파싱과 동일하게 사용됨.
  `AblyClient` 메서드 이름(`search_order_items_by_goods_name`, `get_order_refund_info`,
  `cancel_order_items`, `stop_selling`)이 Task 2 정의와 Task 3 라우터 호출부에서 동일하게 사용됨.
